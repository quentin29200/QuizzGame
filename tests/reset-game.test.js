/**
 * Tests : réinitialisation de la partie
 *
 * Vérifie que :
 * 1. admin:reset-game remet tous les scores à 0
 * 2. L'état en mémoire (question en cours) est vidé
 * 3. game:reset est émis à tous les clients de la session
 * 4. game:reset contient la liste des joueurs avec score = 0
 * 5. La session state repasse à 'lobby'
 * 6. Un joueur peut rejouer normalement après le reset
 * 7. Session invalide → ack { error }
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
  db.prepare("INSERT INTO questions (session_id, text, mode, position) VALUES (?, 'Q1 ?', 'normal', 0)").run(session.id);
  const question = db.prepare("SELECT * FROM questions WHERE session_id = ?").get(session.id);
  db.prepare("INSERT INTO choices (question_id, label, is_correct, position) VALUES (?, 'A', 1, 0)").run(question.id);
  db.prepare("INSERT INTO choices (question_id, label, is_correct, position) VALUES (?, 'B', 0, 1)").run(question.id);
  db.prepare("INSERT INTO choices (question_id, label, is_correct, position) VALUES (?, 'C', 0, 2)").run(question.id);
  db.prepare("INSERT INTO choices (question_id, label, is_correct, position) VALUES (?, 'D', 0, 3)").run(question.id);
  return { session, question };
}

beforeEach(async () => { srv = await createTestServer(); });
afterEach(async ()  => { await srv.close(); });

// ─────────────────────────────────────────────────────────────────────────────

test('admin:reset-game remet tous les scores à 0', async () => {
  const { session, question } = buildSession(srv.db);
  const correctChoice = srv.db.prepare("SELECT * FROM choices WHERE question_id = ? AND is_correct = 1").get(question.id);

  const admin   = await connect(srv.port);
  const player1 = await connect(srv.port);
  const player2 = await connect(srv.port);

  await emit(admin,   'session:join', { code: 'TEST', role: 'admin' });
  const join1 = await emit(player1, 'session:join', { code: 'TEST', role: 'player', name: 'Alice' });
  const join2 = await emit(player2, 'session:join', { code: 'TEST', role: 'player', name: 'Bob' });

  // Faire marquer des points aux joueurs
  const answersResetP = waitFor(admin, 'answers:reset');
  fire(admin, 'question:show', { code: 'TEST', questionId: question.id });
  await answersResetP;

  await emit(player1, 'player:choose-mode', { mode: 'carre' });
  await emit(player1, 'player:vote', { choiceId: correctChoice.id });
  fire(admin, 'question:reveal-answer', { code: 'TEST' });
  await waitFor(admin, 'question:answer-revealed');

  // Vérifier que Alice a des points
  const aliceBefore = srv.db.prepare('SELECT score FROM players WHERE id = ?').get(join1.player.id);
  expect(aliceBefore.score).toBe(3);

  // Reset
  const ack = await emit(admin, 'admin:reset-game', { code: 'TEST' });
  expect(ack).toMatchObject({ ok: true });

  const aliceAfter = srv.db.prepare('SELECT score FROM players WHERE id = ?').get(join1.player.id);
  const bobAfter   = srv.db.prepare('SELECT score FROM players WHERE id = ?').get(join2.player.id);
  expect(aliceAfter.score).toBe(0);
  expect(bobAfter.score).toBe(0);

  admin.disconnect(); player1.disconnect(); player2.disconnect();
});

test('game:reset est émis à tous les clients avec scores = 0', async () => {
  const { session } = buildSession(srv.db);

  const admin   = await connect(srv.port);
  const player1 = await connect(srv.port);
  const display = await connect(srv.port);

  await emit(admin,   'session:join', { code: 'TEST', role: 'admin' });
  await emit(player1, 'session:join', { code: 'TEST', role: 'player', name: 'Alice' });
  await emit(display, 'session:join', { code: 'TEST', role: 'display' });

  const adminResetP   = waitFor(admin,   'game:reset');
  const playerResetP  = waitFor(player1, 'game:reset');
  const displayResetP = waitFor(display, 'game:reset');

  await emit(admin, 'admin:reset-game', { code: 'TEST' });

  const [adminReset, playerReset, displayReset] = await Promise.all([
    adminResetP, playerResetP, displayResetP,
  ]);

  // Tous reçoivent l'event avec les joueurs à score 0
  [adminReset, playerReset, displayReset].forEach(reset => {
    expect(reset.players).toBeDefined();
    expect(reset.players.every(p => p.score === 0)).toBe(true);
  });

  admin.disconnect(); player1.disconnect(); display.disconnect();
});

test('la session repasse en état lobby après reset', async () => {
  const { session, question } = buildSession(srv.db);

  const admin = await connect(srv.port);
  await emit(admin, 'session:join', { code: 'TEST', role: 'admin' });

  // Lancer une question (state → 'question')
  const answersResetP = waitFor(admin, 'answers:reset');
  fire(admin, 'question:show', { code: 'TEST', questionId: question.id });
  await answersResetP;

  const stateBefore = srv.db.prepare("SELECT state FROM sessions WHERE code = 'TEST'").get();
  expect(stateBefore.state).toBe('question');

  await emit(admin, 'admin:reset-game', { code: 'TEST' });

  const stateAfter = srv.db.prepare("SELECT state FROM sessions WHERE code = 'TEST'").get();
  expect(stateAfter.state).toBe('lobby');

  admin.disconnect();
});

test('l\'état en mémoire est vidé : plus de question en cours après reset', async () => {
  const { session, question } = buildSession(srv.db);

  const admin   = await connect(srv.port);
  const player1 = await connect(srv.port);

  await emit(admin,   'session:join', { code: 'TEST', role: 'admin' });
  await emit(player1, 'session:join', { code: 'TEST', role: 'player', name: 'Alice' });

  // Lancer une question
  const answersResetP = waitFor(admin, 'answers:reset');
  fire(admin, 'question:show', { code: 'TEST', questionId: question.id });
  await answersResetP;

  // Reset
  await emit(admin, 'admin:reset-game', { code: 'TEST' });

  // Tenter de voter après reset → doit échouer (pas de question active)
  await emit(player1, 'player:choose-mode', { mode: 'carre' });
  const ack = await emit(player1, 'player:vote', { choiceId: 999 });
  expect(ack).toMatchObject({ error: expect.any(String) });

  admin.disconnect(); player1.disconnect();
});

test('on peut relancer une question après reset', async () => {
  const { session, question } = buildSession(srv.db);

  const admin   = await connect(srv.port);
  const player1 = await connect(srv.port);

  await emit(admin,   'session:join', { code: 'TEST', role: 'admin' });
  await emit(player1, 'session:join', { code: 'TEST', role: 'player', name: 'Alice' });

  // Reset d'abord
  await emit(admin, 'admin:reset-game', { code: 'TEST' });

  // Relancer la question → doit fonctionner
  const answersResetP = waitFor(admin, 'answers:reset');
  fire(admin, 'question:show', { code: 'TEST', questionId: question.id });
  await expect(answersResetP).resolves.toBeDefined();

  admin.disconnect(); player1.disconnect();
});

test('session invalide → ack retourne une erreur', async () => {
  buildSession(srv.db);
  const admin = await connect(srv.port);
  await emit(admin, 'session:join', { code: 'TEST', role: 'admin' });

  const ack = await emit(admin, 'admin:reset-game', { code: 'XXXX' });
  expect(ack).toMatchObject({ error: expect.any(String) });

  admin.disconnect();
});
