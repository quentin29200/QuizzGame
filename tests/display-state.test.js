/**
 * Tests : synchronisation d'état pour la page display
 *
 * Vérifie que quand un display rejoint une session en cours,
 * il reçoit immédiatement l'état courant sans attendre
 * le prochain événement.
 */

const { createTestServer } = require('./helpers/createTestServer');
const { io: ioClient }     = require('socket.io-client');

let srv;

function connect(port) {
  return new Promise((resolve, reject) => {
    const s = ioClient(`http://localhost:${port}`, { forceNew: true });
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
}
function emit(socket, event, data) {
  return new Promise(resolve => socket.emit(event, data, resolve));
}
function fire(socket, event, data) { socket.emit(event, data); }
function waitFor(socket, event, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout: "${event}"`)), timeout);
    socket.once(event, d => { clearTimeout(t); resolve(d); });
  });
}

function buildSession(db) {
  db.prepare("INSERT INTO sessions (code, state) VALUES ('TEST', 'lobby')").run();
  const session  = db.prepare("SELECT * FROM sessions WHERE code = 'TEST'").get();
  db.prepare("INSERT INTO questions (session_id, text, mode, position) VALUES (?, 'Capitale de la France ?', 'normal', 0)").run(session.id);
  const question = db.prepare("SELECT * FROM questions WHERE session_id = ?").get(session.id);
  db.prepare("INSERT INTO choices (question_id, label, is_correct, position) VALUES (?, 'Paris', 1, 0)").run(question.id);
  db.prepare("INSERT INTO choices (question_id, label, is_correct, position) VALUES (?, 'Lyon',   0, 1)").run(question.id);
  db.prepare("INSERT INTO choices (question_id, label, is_correct, position) VALUES (?, 'Nice',   0, 2)").run(question.id);
  db.prepare("INSERT INTO choices (question_id, label, is_correct, position) VALUES (?, 'Nantes', 0, 3)").run(question.id);
  return { session, question };
}

beforeEach(async () => { srv = await createTestServer(); });
afterEach(async ()  => { await srv.close(); });

// ─────────────────────────────────────────────────────────────────────────────

test('display reçoit players:update immédiatement à la connexion (lobby)', async () => {
  const { session } = buildSession(srv.db);

  const admin   = await connect(srv.port);
  const player1 = await connect(srv.port);

  await emit(admin,   'session:join', { code: 'TEST', role: 'admin' });
  await emit(player1, 'session:join', { code: 'TEST', role: 'player', name: 'Alice' });
  await emit(player1, 'session:join', { code: 'TEST', role: 'player', name: 'Alice' }); // idempotent

  // Display rejoint APRÈS les joueurs
  const display = await connect(srv.port);
  const playersUpdateP = waitFor(display, 'players:update');
  await emit(display, 'session:join', { code: 'TEST', role: 'display' });
  const list = await playersUpdateP;

  expect(list).toHaveLength(1);
  expect(list[0].name).toBe('Alice');

  admin.disconnect(); player1.disconnect(); display.disconnect();
});

test('display reçoit la question en cours s\'il rejoint pendant une question active', async () => {
  const { session, question } = buildSession(srv.db);

  const admin   = await connect(srv.port);
  const player1 = await connect(srv.port);

  await emit(admin,   'session:join', { code: 'TEST', role: 'admin' });
  await emit(player1, 'session:join', { code: 'TEST', role: 'player', name: 'Alice' });

  // Admin lance la question
  const answersResetP = waitFor(admin, 'answers:reset');
  fire(admin, 'question:show', { code: 'TEST', questionId: question.id });
  await answersResetP;

  // Display rejoint APRÈS le lancement de la question
  const display     = await connect(srv.port);
  const questionShowP = waitFor(display, 'question:show');
  await emit(display, 'session:join', { code: 'TEST', role: 'display' });
  const q = await questionShowP;

  expect(q.text).toBe('Capitale de la France ?');
  expect(q.mode).toBe('normal');

  admin.disconnect(); player1.disconnect(); display.disconnect();
});

test('display reçoit votes:update à jour lors de la connexion en cours de question', async () => {
  const { session, question } = buildSession(srv.db);
  const correctChoice = srv.db.prepare("SELECT * FROM choices WHERE question_id = ? AND is_correct = 1").get(question.id);

  const admin   = await connect(srv.port);
  const player1 = await connect(srv.port);
  const player2 = await connect(srv.port);

  await emit(admin,   'session:join', { code: 'TEST', role: 'admin' });
  await emit(player1, 'session:join', { code: 'TEST', role: 'player', name: 'Alice' });
  await emit(player2, 'session:join', { code: 'TEST', role: 'player', name: 'Bob' });

  const answersResetP = waitFor(admin, 'answers:reset');
  fire(admin, 'question:show', { code: 'TEST', questionId: question.id });
  await answersResetP;

  // Alice vote avant que le display arrive
  await emit(player1, 'player:choose-mode', { mode: 'carre' });
  await emit(player1, 'player:vote', { choiceId: correctChoice.id });

  // Display se connecte maintenant : doit voir 1 réponse sur 2 joueurs
  const display      = await connect(srv.port);
  const votesUpdateP = waitFor(display, 'votes:update');
  await emit(display, 'session:join', { code: 'TEST', role: 'display' });
  const votes = await votesUpdateP;

  expect(votes.count).toBe(1);
  expect(votes.total).toBe(2);

  admin.disconnect(); player1.disconnect(); player2.disconnect(); display.disconnect();
});

test('display reçoit question:answer-revealed s\'il rejoint après révélation', async () => {
  const { session, question } = buildSession(srv.db);

  const admin   = await connect(srv.port);
  const player1 = await connect(srv.port);

  await emit(admin,   'session:join', { code: 'TEST', role: 'admin' });
  await emit(player1, 'session:join', { code: 'TEST', role: 'player', name: 'Alice' });

  const answersResetP = waitFor(admin, 'answers:reset');
  fire(admin, 'question:show', { code: 'TEST', questionId: question.id });
  await answersResetP;

  // Admin révèle la réponse
  const revealedP = waitFor(admin, 'question:answer-revealed');
  fire(admin, 'question:reveal-answer', { code: 'TEST' });
  await revealedP;

  // Display rejoint APRÈS la révélation
  const display = await connect(srv.port);
  const receivedReveal = waitFor(display, 'question:answer-revealed');
  await emit(display, 'session:join', { code: 'TEST', role: 'display' });
  const revealed = await receivedReveal;

  expect(revealed.correctChoiceIds).toHaveLength(1);
  expect(revealed.allChoices).toHaveLength(4);

  admin.disconnect(); player1.disconnect(); display.disconnect();
});

test('display en lobby vide reçoit players:update avec liste vide', async () => {
  buildSession(srv.db);

  const display      = await connect(srv.port);
  const playersUpdateP = waitFor(display, 'players:update');
  await emit(display, 'session:join', { code: 'TEST', role: 'display' });
  const list = await playersUpdateP;

  expect(list).toEqual([]);

  display.disconnect();
});
