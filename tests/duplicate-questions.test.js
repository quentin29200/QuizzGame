/**
 * Tests : duplication des questions vers une nouvelle session
 *
 * Protocole : le client crée d'abord la session destination (via REST ou DB),
 * puis émet admin:duplicate-questions { fromCode, toCode }.
 *
 * Vérifie que :
 * 1. L'ack retourne { ok, questionCount }
 * 2. Toutes les questions de la session source sont copiées
 * 3. Tous les choix sont copiés avec is_correct préservé
 * 4. La session source reste inchangée
 * 5. Deux duplications successives fonctionnent (sessions distinctes)
 * 6. Session source invalide → ack { error }
 * 7. Session destination invalide → ack { error }
 * 8. Session source sans questions → questionCount = 0
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

/** Crée la session source TEST avec 2 questions (1 normal + 1 buzzer). */
function buildSourceSession(db) {
  db.prepare("INSERT INTO sessions (code, state) VALUES ('TEST', 'lobby')").run();
  const session = db.prepare("SELECT * FROM sessions WHERE code = 'TEST'").get();

  db.prepare("INSERT INTO questions (session_id, text, mode, position) VALUES (?, 'Capitale de France ?', 'normal', 0)").run(session.id);
  const q1 = db.prepare("SELECT * FROM questions WHERE session_id = ? AND position = 0").get(session.id);
  db.prepare("INSERT INTO choices (question_id, label, is_correct, position) VALUES (?, 'Paris', 1, 0)").run(q1.id);
  db.prepare("INSERT INTO choices (question_id, label, is_correct, position) VALUES (?, 'Lyon', 0, 1)").run(q1.id);
  db.prepare("INSERT INTO choices (question_id, label, is_correct, position) VALUES (?, 'Marseille', 0, 2)").run(q1.id);
  db.prepare("INSERT INTO choices (question_id, label, is_correct, position) VALUES (?, 'Bordeaux', 0, 3)").run(q1.id);

  db.prepare("INSERT INTO questions (session_id, text, mode, position) VALUES (?, ?, 'buzzer', 1)").run(session.id, "Question buzzer");

  return session;
}

/** Crée une session destination vide avec un code donné. */
function buildDestSession(db, code) {
  db.prepare("INSERT INTO sessions (code, state) VALUES (?, 'lobby')").run(code);
  return db.prepare('SELECT * FROM sessions WHERE code = ?').get(code);
}

beforeEach(async () => { srv = await createTestServer(); });
afterEach(async ()  => { await srv.close(); });

// ─────────────────────────────────────────────────────────────────────────────

test('ack retourne { ok, questionCount }', async () => {
  buildSourceSession(srv.db);
  buildDestSession(srv.db, 'DEST');

  const admin = await connect(srv.port);
  await emit(admin, 'session:join', { code: 'TEST', role: 'admin' });

  const ack = await emit(admin, 'admin:duplicate-questions', { fromCode: 'TEST', toCode: 'DEST' });
  expect(ack).toMatchObject({ ok: true, questionCount: 2 });

  admin.disconnect();
});

test('les questions sont copiées dans la session destination', async () => {
  buildSourceSession(srv.db);
  buildDestSession(srv.db, 'DEST');

  const admin = await connect(srv.port);
  await emit(admin, 'session:join', { code: 'TEST', role: 'admin' });
  await emit(admin, 'admin:duplicate-questions', { fromCode: 'TEST', toCode: 'DEST' });

  const destSession   = srv.db.prepare("SELECT * FROM sessions WHERE code = 'DEST'").get();
  const destQuestions = srv.db.prepare('SELECT * FROM questions WHERE session_id = ? ORDER BY position').all(destSession.id);

  expect(destQuestions).toHaveLength(2);
  expect(destQuestions[0].text).toBe('Capitale de France ?');
  expect(destQuestions[0].mode).toBe('normal');
  expect(destQuestions[1].mode).toBe('buzzer');

  admin.disconnect();
});

test('les choix sont copiés avec is_correct préservé', async () => {
  buildSourceSession(srv.db);
  buildDestSession(srv.db, 'DEST');

  const admin = await connect(srv.port);
  await emit(admin, 'session:join', { code: 'TEST', role: 'admin' });
  await emit(admin, 'admin:duplicate-questions', { fromCode: 'TEST', toCode: 'DEST' });

  const destSession   = srv.db.prepare("SELECT * FROM sessions WHERE code = 'DEST'").get();
  const destQ1        = srv.db.prepare('SELECT * FROM questions WHERE session_id = ? AND position = 0').get(destSession.id);
  const destChoices   = srv.db.prepare('SELECT * FROM choices WHERE question_id = ? ORDER BY position').all(destQ1.id);

  expect(destChoices).toHaveLength(4);
  expect(destChoices[0].label).toBe('Paris');
  expect(destChoices[0].is_correct).toBe(1);
  expect(destChoices[1].is_correct).toBe(0);

  admin.disconnect();
});

test('la session source reste inchangée après duplication', async () => {
  buildSourceSession(srv.db);
  buildDestSession(srv.db, 'DEST');

  const admin = await connect(srv.port);
  await emit(admin, 'session:join', { code: 'TEST', role: 'admin' });
  await emit(admin, 'admin:duplicate-questions', { fromCode: 'TEST', toCode: 'DEST' });

  const srcSession   = srv.db.prepare("SELECT * FROM sessions WHERE code = 'TEST'").get();
  const srcQuestions = srv.db.prepare('SELECT * FROM questions WHERE session_id = ?').all(srcSession.id);
  expect(srcQuestions).toHaveLength(2);

  admin.disconnect();
});

test('deux duplications vers deux destinations distinctes fonctionnent', async () => {
  buildSourceSession(srv.db);
  buildDestSession(srv.db, 'DST1');
  buildDestSession(srv.db, 'DST2');

  const admin = await connect(srv.port);
  await emit(admin, 'session:join', { code: 'TEST', role: 'admin' });

  const ack1 = await emit(admin, 'admin:duplicate-questions', { fromCode: 'TEST', toCode: 'DST1' });
  const ack2 = await emit(admin, 'admin:duplicate-questions', { fromCode: 'TEST', toCode: 'DST2' });

  expect(ack1).toMatchObject({ ok: true, questionCount: 2 });
  expect(ack2).toMatchObject({ ok: true, questionCount: 2 });

  admin.disconnect();
});

test('session source invalide → ack { error }', async () => {
  buildDestSession(srv.db, 'DEST');

  const admin = await connect(srv.port);
  // On rejoint DEST pour avoir un socket valide
  await emit(admin, 'session:join', { code: 'DEST', role: 'admin' });

  const ack = await emit(admin, 'admin:duplicate-questions', { fromCode: 'XXXX', toCode: 'DEST' });
  expect(ack).toMatchObject({ error: expect.any(String) });

  admin.disconnect();
});

test('session destination invalide → ack { error }', async () => {
  buildSourceSession(srv.db);

  const admin = await connect(srv.port);
  await emit(admin, 'session:join', { code: 'TEST', role: 'admin' });

  const ack = await emit(admin, 'admin:duplicate-questions', { fromCode: 'TEST', toCode: 'XXXX' });
  expect(ack).toMatchObject({ error: expect.any(String) });

  admin.disconnect();
});

test('session source sans questions → questionCount = 0', async () => {
  buildDestSession(srv.db, 'EMPT');
  buildDestSession(srv.db, 'DEST');

  const admin = await connect(srv.port);
  await emit(admin, 'session:join', { code: 'EMPT', role: 'admin' });

  const ack = await emit(admin, 'admin:duplicate-questions', { fromCode: 'EMPT', toCode: 'DEST' });
  expect(ack).toMatchObject({ ok: true, questionCount: 0 });

  admin.disconnect();
});
