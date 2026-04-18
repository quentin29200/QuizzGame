/**
 * Tests : révélation de la réponse
 *
 * Vérifie que :
 * 1. question:answer-revealed est émis à l'admin avec correctChoiceIds + allChoices
 * 2. Les scores sont mis à jour pour duo/carré (pas pour cash)
 * 3. La bannière admin recevrait les bonnes données
 * 4. Le flux complet : show → vote → reveal
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
function waitFor(socket, event, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout: "${event}"`)), timeout);
    socket.once(event, d => { clearTimeout(t); resolve(d); });
  });
}

function buildSession(db) {
  db.prepare("INSERT INTO sessions (code, state) VALUES ('TEST', 'lobby')").run();
  const session = db.prepare("SELECT * FROM sessions WHERE code = 'TEST'").get();
  db.prepare("INSERT INTO questions (session_id, text, mode, position) VALUES (?, 'Quelle est la capitale ?', 'normal', 0)").run(session.id);
  const question = db.prepare("SELECT * FROM questions WHERE session_id = ?").get(session.id);
  // Choix : Paris = correct, le reste = wrong
  db.prepare("INSERT INTO choices (question_id, label, is_correct, position) VALUES (?, 'Paris', 1, 0)").run(question.id);
  db.prepare("INSERT INTO choices (question_id, label, is_correct, position) VALUES (?, 'Lyon', 0, 1)").run(question.id);
  db.prepare("INSERT INTO choices (question_id, label, is_correct, position) VALUES (?, 'Marseille', 0, 2)").run(question.id);
  db.prepare("INSERT INTO choices (question_id, label, is_correct, position) VALUES (?, 'Bordeaux', 0, 3)").run(question.id);
  return { session, question };
}

beforeEach(async () => { srv = await createTestServer(); });
afterEach(async ()  => { await srv.close(); });

// ─────────────────────────────────────────────────────────────────────────────

test('question:answer-revealed est reçu par l\'admin après révélation', async () => {
  const { session, question } = buildSession(srv.db);
  const correctChoice = srv.db.prepare("SELECT * FROM choices WHERE question_id = ? AND is_correct = 1").get(question.id);

  const admin   = await connect(srv.port);
  const player1 = await connect(srv.port);

  await emit(admin,   'session:join', { code: 'TEST', role: 'admin' });
  await emit(player1, 'session:join', { code: 'TEST', role: 'player', name: 'Alice' });

  const answersResetP = waitFor(admin, 'answers:reset');
  fire(admin, 'question:show', { code: 'TEST', questionId: question.id });
  await answersResetP;

  const revealedP = waitFor(admin, 'question:answer-revealed');
  fire(admin, 'question:reveal-answer', { code: 'TEST' });
  const revealed = await revealedP;

  expect(revealed.correctChoiceIds).toContain(correctChoice.id);
  expect(revealed.allChoices).toHaveLength(4);
  expect(revealed.allChoices.every(c => 'id' in c && 'label' in c)).toBe(true);

  admin.disconnect();
  player1.disconnect();
});

test('correctChoiceIds identifie bien Paris et non les autres', async () => {
  const { session, question } = buildSession(srv.db);
  const allChoices = srv.db.prepare("SELECT * FROM choices WHERE question_id = ? ORDER BY position").all(question.id);
  const wrongIds   = allChoices.filter(c => c.is_correct === 0).map(c => c.id);

  const admin = await connect(srv.port);
  await emit(admin, 'session:join', { code: 'TEST', role: 'admin' });

  const answersResetP = waitFor(admin, 'answers:reset');
  fire(admin, 'question:show', { code: 'TEST', questionId: question.id });
  await answersResetP;

  const revealedP = waitFor(admin, 'question:answer-revealed');
  fire(admin, 'question:reveal-answer', { code: 'TEST' });
  const { correctChoiceIds } = await revealedP;

  // Aucun id "wrong" ne doit être dans correctChoiceIds
  wrongIds.forEach(id => expect(correctChoiceIds).not.toContain(id));
  expect(correctChoiceIds).toHaveLength(1);

  admin.disconnect();
});

test('les scores sont attribués après révélation (carré correct = +3pts)', async () => {
  const { session, question } = buildSession(srv.db);
  const correctChoice = srv.db.prepare("SELECT * FROM choices WHERE question_id = ? AND is_correct = 1").get(question.id);

  const admin   = await connect(srv.port);
  const player1 = await connect(srv.port);

  await emit(admin,   'session:join', { code: 'TEST', role: 'admin' });
  const joinRes = await emit(player1, 'session:join', { code: 'TEST', role: 'player', name: 'Alice' });
  const playerId = joinRes.player.id;

  const answersResetP = waitFor(admin, 'answers:reset');
  fire(admin, 'question:show', { code: 'TEST', questionId: question.id });
  await answersResetP;

  // Alice vote carré pour la bonne réponse
  await emit(player1, 'player:choose-mode', { mode: 'carre' });
  await emit(player1, 'player:vote', { choiceId: correctChoice.id });

  // Révélation
  const playersUpdateP = waitFor(admin, 'players:update');
  fire(admin, 'question:reveal-answer', { code: 'TEST' });
  const players = await playersUpdateP;

  const alice = players.find(p => p.id === playerId);
  expect(alice).toBeDefined();
  expect(alice.score).toBe(3); // carré correct = 3 pts

  admin.disconnect();
  player1.disconnect();
});

test('le score n\'est pas attribué pour une mauvaise réponse', async () => {
  const { session, question } = buildSession(srv.db);
  const wrongChoice = srv.db.prepare("SELECT * FROM choices WHERE question_id = ? AND is_correct = 0").get(question.id);

  const admin   = await connect(srv.port);
  const player1 = await connect(srv.port);

  await emit(admin,   'session:join', { code: 'TEST', role: 'admin' });
  const joinRes = await emit(player1, 'session:join', { code: 'TEST', role: 'player', name: 'Bob' });
  const playerId = joinRes.player.id;

  const answersResetP = waitFor(admin, 'answers:reset');
  fire(admin, 'question:show', { code: 'TEST', questionId: question.id });
  await answersResetP;

  await emit(player1, 'player:choose-mode', { mode: 'duo' });
  await emit(player1, 'player:vote', { choiceId: wrongChoice.id });

  const playersUpdateP = waitFor(admin, 'players:update');
  fire(admin, 'question:reveal-answer', { code: 'TEST' });
  const players = await playersUpdateP;

  const bob = players.find(p => p.id === playerId);
  expect(bob.score).toBe(0);

  admin.disconnect();
  player1.disconnect();
});

test('cash : le score n\'est PAS attribué automatiquement à la révélation', async () => {
  const { session, question } = buildSession(srv.db);

  const admin   = await connect(srv.port);
  const player1 = await connect(srv.port);

  await emit(admin,   'session:join', { code: 'TEST', role: 'admin' });
  const joinRes = await emit(player1, 'session:join', { code: 'TEST', role: 'player', name: 'Charlie' });
  const playerId = joinRes.player.id;

  const answersResetP = waitFor(admin, 'answers:reset');
  fire(admin, 'question:show', { code: 'TEST', questionId: question.id });
  await answersResetP;

  await emit(player1, 'player:choose-mode', { mode: 'cash' });
  await emit(player1, 'player:answer', { text: 'Paris' });

  const playersUpdateP = waitFor(admin, 'players:update');
  fire(admin, 'question:reveal-answer', { code: 'TEST' });
  const players = await playersUpdateP;

  const charlie = players.find(p => p.id === playerId);
  expect(charlie.score).toBe(0); // cash = validation manuelle, pas auto

  admin.disconnect();
  player1.disconnect();
});
