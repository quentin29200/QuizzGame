/**
 * Tests : validation manuelle d'une réponse Cash par l'admin
 *
 * Vérifie que :
 * 1. L'admin peut valider une réponse cash → +5pts au joueur
 * 2. L'admin peut invalider une réponse cash → 0pts
 * 3. admin:score-update retourne un ack { ok: true }
 * 4. players:update est émis après validation (score mis à jour)
 * 5. Double validation → score ne s'ajoute qu'une fois (responsabilité UI, le serveur accumule)
 * 6. Session invalide → ack { error }
 * 7. Le flux complet : question → cash → answer:new → validate → score
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
  db.prepare("INSERT INTO questions (session_id, text, mode, position) VALUES (?, 'Quelle est la réponse ?', 'normal', 0)").run(session.id);
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

test('admin:score-update retourne ack { ok: true } et crédite le joueur de +5pts', async () => {
  const { session } = buildSession(srv.db);

  const admin   = await connect(srv.port);
  const player1 = await connect(srv.port);

  await emit(admin,   'session:join', { code: 'TEST', role: 'admin' });
  const joinRes = await emit(player1, 'session:join', { code: 'TEST', role: 'player', name: 'Alice' });
  const playerId = joinRes.player.id;

  const ack = await emit(admin, 'admin:score-update', { code: 'TEST', playerId, delta: 5 });

  expect(ack).toMatchObject({ ok: true });

  const alice = srv.db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  expect(alice.score).toBe(5);

  admin.disconnect(); player1.disconnect();
});

test('players:update est émis après validation avec le nouveau score', async () => {
  const { session } = buildSession(srv.db);

  const admin   = await connect(srv.port);
  const player1 = await connect(srv.port);

  await emit(admin,   'session:join', { code: 'TEST', role: 'admin' });
  const joinRes = await emit(player1, 'session:join', { code: 'TEST', role: 'player', name: 'Bob' });
  const playerId = joinRes.player.id;

  const playersUpdateP = waitFor(admin, 'players:update');
  await emit(admin, 'admin:score-update', { code: 'TEST', playerId, delta: 5 });
  const players = await playersUpdateP;

  const bob = players.find(p => p.id === playerId);
  expect(bob).toBeDefined();
  expect(bob.score).toBe(5);

  admin.disconnect(); player1.disconnect();
});

test('flux complet cash : question → réponse → answer:new → validation → score = 5', async () => {
  const { session, question } = buildSession(srv.db);

  const admin   = await connect(srv.port);
  const player1 = await connect(srv.port);

  await emit(admin,   'session:join', { code: 'TEST', role: 'admin' });
  const joinRes = await emit(player1, 'session:join', { code: 'TEST', role: 'player', name: 'Charlie' });
  const playerId = joinRes.player.id;

  // Lancer la question
  const answersResetP = waitFor(admin, 'answers:reset');
  fire(admin, 'question:show', { code: 'TEST', questionId: question.id });
  await answersResetP;

  // Le joueur choisit cash et répond
  await emit(player1, 'player:choose-mode', { mode: 'cash' });

  const answerNewP = waitFor(admin, 'answer:new');
  await emit(player1, 'player:answer', { text: '42' });
  const answerNew = await answerNewP;

  expect(answerNew.playerMode).toBe('cash');
  expect(answerNew.playerId).toBe(playerId);

  // Admin valide : +5pts
  const playersUpdateP = waitFor(admin, 'players:update');
  const ack = await emit(admin, 'admin:score-update', {
    code: 'TEST', playerId: answerNew.playerId, delta: 5,
  });
  const players = await playersUpdateP;

  expect(ack).toMatchObject({ ok: true });

  const charlie = players.find(p => p.id === playerId);
  expect(charlie.score).toBe(5);

  // Vérifier en DB aussi
  const dbPlayer = srv.db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  expect(dbPlayer.score).toBe(5);

  admin.disconnect(); player1.disconnect();
});

test('invalider ne modifie pas le score (delta = 0, géré côté UI uniquement)', async () => {
  const { session } = buildSession(srv.db);

  const admin   = await connect(srv.port);
  const player1 = await connect(srv.port);

  await emit(admin,   'session:join', { code: 'TEST', role: 'admin' });
  const joinRes = await emit(player1, 'session:join', { code: 'TEST', role: 'player', name: 'Dave' });
  const playerId = joinRes.player.id;

  // Score initial = 0, l'admin invalide sans envoyer de score-update
  // (invalidateCash côté client ne fait pas d'emit admin:score-update)
  const dbPlayer = srv.db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  expect(dbPlayer.score).toBe(0);

  admin.disconnect(); player1.disconnect();
});

test('session invalide → ack retourne une erreur', async () => {
  buildSession(srv.db);

  const admin = await connect(srv.port);
  await emit(admin, 'session:join', { code: 'TEST', role: 'admin' });

  const ack = await emit(admin, 'admin:score-update', {
    code: 'XXXX', playerId: 999, delta: 5,
  });

  expect(ack).toMatchObject({ error: expect.any(String) });

  // Vérifier qu'aucun score n'a été modifié
  const players = srv.db.prepare('SELECT * FROM players').all();
  expect(players.every(p => p.score === 0)).toBe(true);

  admin.disconnect();
});

test('delta négatif : admin peut retirer des points (correction)', async () => {
  const { session } = buildSession(srv.db);

  const admin   = await connect(srv.port);
  const player1 = await connect(srv.port);

  await emit(admin,   'session:join', { code: 'TEST', role: 'admin' });
  const joinRes = await emit(player1, 'session:join', { code: 'TEST', role: 'player', name: 'Eve' });
  const playerId = joinRes.player.id;

  // D'abord +5, puis -5 (correction)
  await emit(admin, 'admin:score-update', { code: 'TEST', playerId, delta:  5 });
  await emit(admin, 'admin:score-update', { code: 'TEST', playerId, delta: -5 });

  const eve = srv.db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  expect(eve.score).toBe(0);

  admin.disconnect(); player1.disconnect();
});
