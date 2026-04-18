/**
 * Tests : flux des réponses Cash
 *
 * On vérifie que :
 * 1. player:answer (cash) → le serveur émet answer:new avec playerMode:'cash' à l'admin
 * 2. answer:new contient bien le texte de la réponse
 * 3. Un joueur ne peut pas répondre deux fois à la même question
 * 4. Le compteur votes:update s'incrémente pour les réponses cash
 * 5. answer:new n'est PAS reçu par les autres joueurs (room admin uniquement)
 */

const { createTestServer } = require('./helpers/createTestServer');
const { io: ioClient }     = require('socket.io-client');

let srv;

// ── Helpers ──────────────────────────────────────────────────────────────────

function connect(port, opts = {}) {
  return new Promise((resolve, reject) => {
    const s = ioClient(`http://localhost:${port}`, { forceNew: true, ...opts });
    s.once('connect',       () => resolve(s));
    s.once('connect_error', reject);
  });
}

/** Émet un event avec ack et retourne la réponse. */
function emit(socket, event, data) {
  return new Promise((resolve) => socket.emit(event, data, resolve));
}

/** Émet un event sans ack (fire-and-forget). */
function fire(socket, event, data) {
  socket.emit(event, data);
}

/** Attend le prochain event sur le socket. */
function waitFor(socket, event, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeout);
    socket.once(event, (data) => { clearTimeout(t); resolve(data); });
  });
}

/** Attend un event puis renvoie sa valeur (plus lisible dans les tests). */
async function nextEvent(socket, event) {
  return waitFor(socket, event);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function buildSession(db) {
  db.prepare("INSERT INTO sessions (code, state) VALUES ('TEST', 'lobby')").run();
  const session = db.prepare("SELECT * FROM sessions WHERE code = 'TEST'").get();

  db.prepare("INSERT INTO questions (session_id, text, mode, position) VALUES (?, 'Combien font 2+2 ?', 'normal', 0)")
    .run(session.id);
  const question = db.prepare("SELECT * FROM questions WHERE session_id = ?").get(session.id);

  db.prepare("INSERT INTO choices (question_id, label, is_correct, position) VALUES (?, '4', 1, 0)").run(question.id);
  db.prepare("INSERT INTO choices (question_id, label, is_correct, position) VALUES (?, '5', 0, 1)").run(question.id);
  db.prepare("INSERT INTO choices (question_id, label, is_correct, position) VALUES (?, '6', 0, 2)").run(question.id);
  db.prepare("INSERT INTO choices (question_id, label, is_correct, position) VALUES (?, '7', 0, 3)").run(question.id);

  return { session, question };
}

// ── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(async () => { srv = await createTestServer(); });
afterEach(async ()  => { await srv.close(); });

// ── Tests ─────────────────────────────────────────────────────────────────────

test('answer:new est émis à l\'admin avec playerMode cash', async () => {
  const { session, question } = buildSession(srv.db);

  const admin   = await connect(srv.port);
  const player1 = await connect(srv.port);

  await emit(admin,   'session:join', { code: 'TEST', role: 'admin' });
  await emit(player1, 'session:join', { code: 'TEST', role: 'player', name: 'Alice' });

  // Lancer la question (pas d'ack → fire-and-forget, on attend answers:reset côté admin)
  const answersResetPromise = waitFor(admin, 'answers:reset');
  fire(admin, 'question:show', { code: 'TEST', questionId: question.id });
  await answersResetPromise;

  // Choisir le mode cash
  await emit(player1, 'player:choose-mode', { mode: 'cash' });

  // Attendre answer:new avant d'envoyer la réponse
  const answerNewPromise = waitFor(admin, 'answer:new');
  const ack = await emit(player1, 'player:answer', { text: 'Quatre' });

  expect(ack).toMatchObject({ ok: true });

  const received = await answerNewPromise;

  expect(received.playerMode).toBe('cash');
  expect(received.text).toBe('Quatre');
  expect(received.playerName).toBe('Alice');
  expect(received.choiceId).toBeNull();
  expect(received.choiceLabel).toBeNull();

  admin.disconnect();
  player1.disconnect();
});

test('votes:update s\'incrémente lors d\'une réponse cash', async () => {
  const { session, question } = buildSession(srv.db);

  const admin   = await connect(srv.port);
  const player1 = await connect(srv.port);

  await emit(admin,   'session:join', { code: 'TEST', role: 'admin' });
  await emit(player1, 'session:join', { code: 'TEST', role: 'player', name: 'Alice' });

  const answersResetPromise = waitFor(admin, 'answers:reset');
  fire(admin, 'question:show', { code: 'TEST', questionId: question.id });
  await answersResetPromise;

  await emit(player1, 'player:choose-mode', { mode: 'cash' });

  // Préparer la promesse avant d'émettre
  const votesUpdatePromise = waitFor(player1, 'votes:update');
  await emit(player1, 'player:answer', { text: 'Quatre' });

  const update = await votesUpdatePromise;

  expect(update.count).toBe(1);
  expect(update.total).toBeGreaterThanOrEqual(1);

  admin.disconnect();
  player1.disconnect();
});

test('un joueur ne peut pas soumettre deux réponses cash pour la même question', async () => {
  const { session, question } = buildSession(srv.db);

  const admin   = await connect(srv.port);
  const player1 = await connect(srv.port);

  await emit(admin,   'session:join', { code: 'TEST', role: 'admin' });
  await emit(player1, 'session:join', { code: 'TEST', role: 'player', name: 'Alice' });

  const answersResetPromise = waitFor(admin, 'answers:reset');
  fire(admin, 'question:show', { code: 'TEST', questionId: question.id });
  await answersResetPromise;

  await emit(player1, 'player:choose-mode', { mode: 'cash' });

  const ack1 = await emit(player1, 'player:answer', { text: 'Première réponse' });
  const ack2 = await emit(player1, 'player:answer', { text: 'Deuxième réponse' });

  expect(ack1).toMatchObject({ ok: true });
  // Deuxième tentative refusée (UNIQUE constraint question_id + player_id)
  expect(ack2.ok).toBeFalsy();

  admin.disconnect();
  player1.disconnect();
});

test('answer:new N\'EST PAS reçu par les autres joueurs', async () => {
  const { session, question } = buildSession(srv.db);

  const admin   = await connect(srv.port);
  const player1 = await connect(srv.port);
  const player2 = await connect(srv.port);

  await emit(admin,   'session:join', { code: 'TEST', role: 'admin' });
  await emit(player1, 'session:join', { code: 'TEST', role: 'player', name: 'Alice' });
  await emit(player2, 'session:join', { code: 'TEST', role: 'player', name: 'Bob' });

  const answersResetPromise = waitFor(admin, 'answers:reset');
  fire(admin, 'question:show', { code: 'TEST', questionId: question.id });
  await answersResetPromise;

  await emit(player1, 'player:choose-mode', { mode: 'cash' });

  let player2ReceivedAnswerNew = false;
  player2.on('answer:new', () => { player2ReceivedAnswerNew = true; });

  // Attendre que admin reçoive answer:new pour s'assurer que l'event a bien été émis
  const answerNewPromise = waitFor(admin, 'answer:new');
  await emit(player1, 'player:answer', { text: 'Quatre' });
  await answerNewPromise;

  // Petit délai pour laisser le temps à player2 de recevoir un éventuel event
  await new Promise(r => setTimeout(r, 100));

  expect(player2ReceivedAnswerNew).toBe(false);

  admin.disconnect();
  player1.disconnect();
  player2.disconnect();
});

test('plusieurs joueurs cash : chaque réponse crée un answer:new distinct', async () => {
  const { session, question } = buildSession(srv.db);

  const admin   = await connect(srv.port);
  const player1 = await connect(srv.port);
  const player2 = await connect(srv.port);

  await emit(admin,   'session:join', { code: 'TEST', role: 'admin' });
  await emit(player1, 'session:join', { code: 'TEST', role: 'player', name: 'Alice' });
  await emit(player2, 'session:join', { code: 'TEST', role: 'player', name: 'Bob' });

  const answersResetPromise = waitFor(admin, 'answers:reset');
  fire(admin, 'question:show', { code: 'TEST', questionId: question.id });
  await answersResetPromise;

  await emit(player1, 'player:choose-mode', { mode: 'cash' });
  await emit(player2, 'player:choose-mode', { mode: 'cash' });

  const receivedAnswers = [];
  admin.on('answer:new', (data) => receivedAnswers.push(data));

  await emit(player1, 'player:answer', { text: 'Réponse Alice' });
  await emit(player2, 'player:answer', { text: 'Réponse Bob' });

  // Attendre que les 2 réponses arrivent
  await new Promise(r => setTimeout(r, 150));

  expect(receivedAnswers).toHaveLength(2);
  expect(receivedAnswers.map(a => a.text)).toContain('Réponse Alice');
  expect(receivedAnswers.map(a => a.text)).toContain('Réponse Bob');
  expect(receivedAnswers.every(a => a.playerMode === 'cash')).toBe(true);

  admin.disconnect();
  player1.disconnect();
  player2.disconnect();
});
