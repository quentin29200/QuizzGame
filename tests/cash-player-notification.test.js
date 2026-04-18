/**
 * Tests : notification du joueur après validation/invalidation cash
 *
 * Vérifie que :
 * 1. Validation   → le joueur reçoit cash:result { valid: true }
 * 2. Invalidation → le joueur reçoit cash:result { valid: false }
 * 3. Seul le joueur concerné reçoit cash:result (pas les autres joueurs)
 * 4. La validation crédite bien +5pts au joueur
 * 5. L'invalidation ne modifie pas le score
 * 6. Flux complet : question → cash → answer:new → admin:cash-result → cash:result joueur
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
  db.prepare("INSERT INTO questions (session_id, text, mode, position) VALUES (?, 'Q ?', 'normal', 0)").run(session.id);
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

test('le joueur reçoit cash:result { valid: true } quand l\'admin valide', async () => {
  const { session } = buildSession(srv.db);

  const admin   = await connect(srv.port);
  const player1 = await connect(srv.port);

  await emit(admin,   'session:join', { code: 'TEST', role: 'admin' });
  const joinRes  = await emit(player1, 'session:join', { code: 'TEST', role: 'player', name: 'Alice' });
  const playerId = joinRes.player.id;

  const cashResultP = waitFor(player1, 'cash:result');
  await emit(admin, 'admin:cash-result', { code: 'TEST', playerId, valid: true });
  const result = await cashResultP;

  expect(result.valid).toBe(true);

  admin.disconnect(); player1.disconnect();
});

test('le joueur reçoit cash:result { valid: false } quand l\'admin invalide', async () => {
  const { session } = buildSession(srv.db);

  const admin   = await connect(srv.port);
  const player1 = await connect(srv.port);

  await emit(admin,   'session:join', { code: 'TEST', role: 'admin' });
  const joinRes  = await emit(player1, 'session:join', { code: 'TEST', role: 'player', name: 'Bob' });
  const playerId = joinRes.player.id;

  const cashResultP = waitFor(player1, 'cash:result');
  await emit(admin, 'admin:cash-result', { code: 'TEST', playerId, valid: false });
  const result = await cashResultP;

  expect(result.valid).toBe(false);

  admin.disconnect(); player1.disconnect();
});

test('seul le joueur concerné reçoit cash:result (pas les autres)', async () => {
  const { session } = buildSession(srv.db);

  const admin   = await connect(srv.port);
  const player1 = await connect(srv.port);
  const player2 = await connect(srv.port);

  await emit(admin,   'session:join', { code: 'TEST', role: 'admin' });
  const join1 = await emit(player1, 'session:join', { code: 'TEST', role: 'player', name: 'Alice' });
  await emit(player2, 'session:join', { code: 'TEST', role: 'player', name: 'Bob' });

  let player2GotCashResult = false;
  player2.on('cash:result', () => { player2GotCashResult = true; });

  // Valider Alice seulement
  const cashResultP = waitFor(player1, 'cash:result');
  await emit(admin, 'admin:cash-result', { code: 'TEST', playerId: join1.player.id, valid: true });
  await cashResultP;

  // Laisser un délai pour éventuelle réception par player2
  await new Promise(r => setTimeout(r, 80));

  expect(player2GotCashResult).toBe(false);

  admin.disconnect(); player1.disconnect(); player2.disconnect();
});

test('validation crédite +5pts et invalide ne change pas le score', async () => {
  const { session } = buildSession(srv.db);

  const admin   = await connect(srv.port);
  const player1 = await connect(srv.port);
  const player2 = await connect(srv.port);

  await emit(admin,   'session:join', { code: 'TEST', role: 'admin' });
  const join1 = await emit(player1, 'session:join', { code: 'TEST', role: 'player', name: 'Alice' });
  const join2 = await emit(player2, 'session:join', { code: 'TEST', role: 'player', name: 'Bob' });

  // Alice validée, Bob invalidé
  await emit(admin, 'admin:cash-result', { code: 'TEST', playerId: join1.player.id, valid: true  });
  await emit(admin, 'admin:cash-result', { code: 'TEST', playerId: join2.player.id, valid: false });

  const alice = srv.db.prepare('SELECT * FROM players WHERE id = ?').get(join1.player.id);
  const bob   = srv.db.prepare('SELECT * FROM players WHERE id = ?').get(join2.player.id);

  expect(alice.score).toBe(5);
  expect(bob.score).toBe(0);

  admin.disconnect(); player1.disconnect(); player2.disconnect();
});

test('flux complet : question cash → answer:new → admin:cash-result → joueur notifié', async () => {
  const { session, question } = buildSession(srv.db);

  const admin   = await connect(srv.port);
  const player1 = await connect(srv.port);

  await emit(admin,   'session:join', { code: 'TEST', role: 'admin' });
  const joinRes  = await emit(player1, 'session:join', { code: 'TEST', role: 'player', name: 'Charlie' });
  const playerId = joinRes.player.id;

  // Lancer la question
  const answersResetP = waitFor(admin, 'answers:reset');
  fire(admin, 'question:show', { code: 'TEST', questionId: question.id });
  await answersResetP;

  // Joueur répond en cash
  await emit(player1, 'player:choose-mode', { mode: 'cash' });
  const answerNewP = waitFor(admin, 'answer:new');
  await emit(player1, 'player:answer', { text: 'Ma réponse cash' });
  const { playerId: receivedId } = await answerNewP;

  // Admin valide → joueur doit recevoir cash:result
  const cashResultP = waitFor(player1, 'cash:result');
  const ack = await emit(admin, 'admin:cash-result', {
    code: 'TEST', playerId: receivedId, valid: true,
  });

  expect(ack).toMatchObject({ ok: true });

  const result = await cashResultP;
  expect(result.valid).toBe(true);

  // Score en DB
  const charlie = srv.db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  expect(charlie.score).toBe(5);

  admin.disconnect(); player1.disconnect();
});
