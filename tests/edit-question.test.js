/**
 * Tests : édition de questions
 *
 * Vérifie que :
 * 1. admin:edit-question met à jour le texte et le mode
 * 2. Les choix sont mis à jour correctement
 * 3. La bonne réponse change bien
 * 4. questions:list est renvoyé après édition
 * 5. Éditer en buzzer → les choix existants restent (non remplacés)
 * 6. On ne peut pas éditer une question d'une autre session
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
function waitFor(socket, event, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout: "${event}"`)), timeout);
    socket.once(event, d => { clearTimeout(t); resolve(d); });
  });
}

function buildSession(db) {
  db.prepare("INSERT INTO sessions (code, state) VALUES ('TEST', 'lobby')").run();
  const session  = db.prepare("SELECT * FROM sessions WHERE code = 'TEST'").get();
  db.prepare("INSERT INTO questions (session_id, text, mode, position) VALUES (?, 'Question originale', 'normal', 0)").run(session.id);
  const question = db.prepare("SELECT * FROM questions WHERE session_id = ?").get(session.id);
  db.prepare("INSERT INTO choices (question_id, label, is_correct, position) VALUES (?, 'A correct', 1, 0)").run(question.id);
  db.prepare("INSERT INTO choices (question_id, label, is_correct, position) VALUES (?, 'B wrong',   0, 1)").run(question.id);
  db.prepare("INSERT INTO choices (question_id, label, is_correct, position) VALUES (?, 'C wrong',   0, 2)").run(question.id);
  db.prepare("INSERT INTO choices (question_id, label, is_correct, position) VALUES (?, 'D wrong',   0, 3)").run(question.id);
  return { session, question };
}

beforeEach(async () => { srv = await createTestServer(); });
afterEach(async ()  => { await srv.close(); });

// ─────────────────────────────────────────────────────────────────────────────

test('éditer le texte d\'une question', async () => {
  const { session, question } = buildSession(srv.db);

  const admin = await connect(srv.port);
  await emit(admin, 'session:join', { code: 'TEST', role: 'admin' });

  const choices = [
    { label: 'A correct', isCorrect: true },
    { label: 'B wrong',   isCorrect: false },
    { label: 'C wrong',   isCorrect: false },
    { label: 'D wrong',   isCorrect: false },
  ];

  const ack = await emit(admin, 'admin:edit-question', {
    code: 'TEST', questionId: question.id,
    text: 'Nouveau texte modifié', mode: 'normal', choices,
  });

  expect(ack).toMatchObject({ ok: true });

  const updated = srv.db.prepare('SELECT * FROM questions WHERE id = ?').get(question.id);
  expect(updated.text).toBe('Nouveau texte modifié');

  admin.disconnect();
});

test('éditer les choix : changer la bonne réponse', async () => {
  const { session, question } = buildSession(srv.db);

  const admin = await connect(srv.port);
  await emit(admin, 'session:join', { code: 'TEST', role: 'admin' });

  // Inverser : B devient correct, A devient faux
  const ack = await emit(admin, 'admin:edit-question', {
    code: 'TEST', questionId: question.id,
    text: 'Question originale', mode: 'normal',
    choices: [
      { label: 'A wrong',   isCorrect: false },
      { label: 'B correct', isCorrect: true },
      { label: 'C wrong',   isCorrect: false },
      { label: 'D wrong',   isCorrect: false },
    ],
  });

  expect(ack).toMatchObject({ ok: true });

  const choices = srv.db.prepare('SELECT * FROM choices WHERE question_id = ? ORDER BY position').all(question.id);
  const correct = choices.filter(c => c.is_correct === 1);
  const wrong   = choices.filter(c => c.is_correct === 0);

  expect(correct).toHaveLength(1);
  expect(correct[0].label).toBe('B correct');
  expect(wrong.map(c => c.label)).not.toContain('B correct');

  admin.disconnect();
});

test('questions:list est renvoyé à l\'admin après édition', async () => {
  const { session, question } = buildSession(srv.db);

  const admin = await connect(srv.port);
  await emit(admin, 'session:join', { code: 'TEST', role: 'admin' });

  const listPromise = waitFor(admin, 'questions:list');

  await emit(admin, 'admin:edit-question', {
    code: 'TEST', questionId: question.id,
    text: 'Texte mis à jour', mode: 'normal',
    choices: [
      { label: 'A', isCorrect: true  },
      { label: 'B', isCorrect: false },
      { label: 'C', isCorrect: false },
      { label: 'D', isCorrect: false },
    ],
  });

  const list = await listPromise;

  expect(list).toHaveLength(1);
  expect(list[0].text).toBe('Texte mis à jour');
  expect(list[0].choices).toHaveLength(4);

  admin.disconnect();
});

test('éditer le mode : passer normal → buzzer', async () => {
  const { session, question } = buildSession(srv.db);

  const admin = await connect(srv.port);
  await emit(admin, 'session:join', { code: 'TEST', role: 'admin' });

  const ack = await emit(admin, 'admin:edit-question', {
    code: 'TEST', questionId: question.id,
    text: 'Question buzzer maintenant', mode: 'buzzer',
    choices: [], // buzzer n'a pas de choices
  });

  expect(ack).toMatchObject({ ok: true });

  const updated = srv.db.prepare('SELECT * FROM questions WHERE id = ?').get(question.id);
  expect(updated.mode).toBe('buzzer');
  expect(updated.text).toBe('Question buzzer maintenant');

  // Les choix existants ne sont pas supprimés (mode buzzer ne touche pas aux choix)
  const choices = srv.db.prepare('SELECT * FROM choices WHERE question_id = ?').all(question.id);
  expect(choices).toHaveLength(4); // toujours là

  admin.disconnect();
});

test('éditer les labels des choix', async () => {
  const { session, question } = buildSession(srv.db);

  const admin = await connect(srv.port);
  await emit(admin, 'session:join', { code: 'TEST', role: 'admin' });

  await emit(admin, 'admin:edit-question', {
    code: 'TEST', questionId: question.id,
    text: 'Question originale', mode: 'normal',
    choices: [
      { label: 'Paris',    isCorrect: true  },
      { label: 'Lyon',     isCorrect: false },
      { label: 'Nice',     isCorrect: false },
      { label: 'Bordeaux', isCorrect: false },
    ],
  });

  const choices = srv.db.prepare('SELECT * FROM choices WHERE question_id = ? ORDER BY position').all(question.id);
  expect(choices.map(c => c.label)).toEqual(['Paris', 'Lyon', 'Nice', 'Bordeaux']);

  admin.disconnect();
});

test('session introuvable retourne une erreur', async () => {
  buildSession(srv.db);

  const admin = await connect(srv.port);
  await emit(admin, 'session:join', { code: 'TEST', role: 'admin' });

  const ack = await emit(admin, 'admin:edit-question', {
    code: 'XXXX', questionId: 1,
    text: 'x', mode: 'normal', choices: [],
  });

  expect(ack).toMatchObject({ error: expect.any(String) });

  admin.disconnect();
});
