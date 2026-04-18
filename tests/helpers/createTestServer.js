/**
 * Crée un serveur de test isolé avec une DB en mémoire.
 * Chaque appel retourne un serveur frais + io + les queries.
 */
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');

function buildFreshDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL DEFAULT 'lobby', mode TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      socket_id TEXT NOT NULL, name TEXT NOT NULL, score INTEGER NOT NULL DEFAULT 0,
      joined_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(session_id, name)
    );
    CREATE TABLE questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      text TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'normal',
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE choices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      label TEXT NOT NULL, is_correct INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      choice_id INTEGER REFERENCES choices(id), text_answer TEXT, player_mode TEXT,
      submitted_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(question_id, player_id)
    );
    CREATE TABLE buzz_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      buzz_ts INTEGER NOT NULL, is_winner INTEGER NOT NULL DEFAULT 0
    );
  `);

  return db;
}

/**
 * Construit les fonctions queries qui utilisent une DB fournie.
 * Reprend la logique de src/db/queries.js mais injecte le db au lieu du singleton.
 */
function buildQueries(db) {
  return {
    getSessionByCode: (code) => db.prepare('SELECT * FROM sessions WHERE code = ?').get(code),
    updateSessionState: (code, state) => db.prepare('UPDATE sessions SET state = ? WHERE code = ?').run(state, code),
    upsertPlayer: (sessionId, socketId, name) => {
      db.prepare(`INSERT INTO players (session_id, socket_id, name) VALUES (?, ?, ?)
        ON CONFLICT(session_id, name) DO UPDATE SET socket_id = excluded.socket_id`).run(sessionId, socketId, name);
      return db.prepare('SELECT * FROM players WHERE session_id = ? AND name = ?').get(sessionId, name);
    },
    getPlayersBySession: (sessionId) =>
      db.prepare('SELECT * FROM players WHERE session_id = ? ORDER BY score DESC, name').all(sessionId),
    updatePlayerScore: (playerId, delta) =>
      db.prepare('UPDATE players SET score = score + ? WHERE id = ?').run(delta, playerId),
    resetPlayerScores: (sessionId) =>
      db.prepare('UPDATE players SET score = 0 WHERE session_id = ?').run(sessionId),
    insertQuestion: (sessionId, text, mode, position) =>
      db.prepare('INSERT INTO questions (session_id, text, mode, position) VALUES (?, ?, ?, ?)').run(sessionId, text, mode, position).lastInsertRowid,
    insertChoice: (questionId, label, isCorrect, position) =>
      db.prepare('INSERT INTO choices (question_id, label, is_correct, position) VALUES (?, ?, ?, ?)').run(questionId, label, isCorrect ? 1 : 0, position),
    getQuestionsBySession: (sessionId) =>
      db.prepare('SELECT * FROM questions WHERE session_id = ? ORDER BY position').all(sessionId),
    getChoicesByQuestion: (questionId) =>
      db.prepare('SELECT * FROM choices WHERE question_id = ? ORDER BY position').all(questionId),
    updateQuestion: (questionId, text, mode) =>
      db.prepare('UPDATE questions SET text = ?, mode = ? WHERE id = ?').run(text, mode, questionId),
    replaceChoices: (questionId, newChoices) => {
      const existing = db.prepare('SELECT * FROM choices WHERE question_id = ? ORDER BY position').all(questionId);
      newChoices.forEach((c, i) => {
        if (existing[i]) {
          db.prepare('UPDATE choices SET label = ?, is_correct = ? WHERE id = ?')
            .run(c.label, c.isCorrect ? 1 : 0, existing[i].id);
        } else {
          db.prepare('INSERT INTO choices (question_id, label, is_correct, position) VALUES (?, ?, ?, ?)')
            .run(questionId, c.label, c.isCorrect ? 1 : 0, i);
        }
      });
      if (existing.length > newChoices.length) {
        existing.slice(newChoices.length).forEach(c => {
          try { db.prepare('DELETE FROM choices WHERE id = ?').run(c.id); }
          catch { db.prepare("UPDATE choices SET label = '[supprimé]', is_correct = 0 WHERE id = ?").run(c.id); }
        });
      }
    },
    insertAnswer: ({ sessionId, questionId, playerId, choiceId, textAnswer, playerMode }) => {
      try {
        db.prepare(`INSERT INTO answers (session_id, question_id, player_id, choice_id, text_answer, player_mode)
          VALUES (?, ?, ?, ?, ?, ?)`).run(sessionId, questionId, playerId, choiceId ?? null, textAnswer ?? null, playerMode ?? null);
        return true;
      } catch { return false; }
    },
    getAnswersByQuestion: (questionId) =>
      db.prepare(`SELECT a.*, p.name as player_name, c.label as choice_label, c.is_correct
        FROM answers a JOIN players p ON p.id = a.player_id
        LEFT JOIN choices c ON c.id = a.choice_id WHERE a.question_id = ?`).all(questionId),
    insertBuzz: (sessionId, questionId, playerId, buzzTs) => {
      try {
        return db.prepare('INSERT INTO buzz_events (session_id, question_id, player_id, buzz_ts) VALUES (?, ?, ?, ?)').run(sessionId, questionId, playerId, buzzTs).lastInsertRowid;
      } catch { return null; }
    },
    setWinner: (buzzId) => db.prepare('UPDATE buzz_events SET is_winner = 1 WHERE id = ?').run(buzzId),
    createSession: (code) => db.prepare("INSERT INTO sessions (code) VALUES (?)").run(code).lastInsertRowid,
    generateCode: () => {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
      let code;
      do {
        code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
      } while (db.prepare('SELECT id FROM sessions WHERE code = ?').get(code));
      return code;
    },
    duplicateQuestions: (fromSessionId, toSessionId) => {
      const questions = db.prepare('SELECT * FROM questions WHERE session_id = ? ORDER BY position').all(fromSessionId);
      for (const q of questions) {
        const newQId = db.prepare(
          'INSERT INTO questions (session_id, text, mode, position) VALUES (?, ?, ?, ?)'
        ).run(toSessionId, q.text, q.mode, q.position).lastInsertRowid;
        const choices = db.prepare('SELECT * FROM choices WHERE question_id = ? ORDER BY position').all(q.id);
        for (const c of choices) {
          db.prepare('INSERT INTO choices (question_id, label, is_correct, position) VALUES (?, ?, ?, ?)')
            .run(newQId, c.label, c.is_correct, c.position);
        }
      }
      return questions.length;
    },
  };
}

/**
 * Crée le module handlers avec injection de dépendances.
 * On duplique la logique de handlers.js en injectant nos propres queries.
 */
function buildHandlers(queries) {
  const MODE_POINTS = { duo: 2, carre: 3, cash: 5 };
  const sessionState = new Map();

  function getState(code) {
    if (!sessionState.has(code)) {
      sessionState.set(code, {
        currentQuestionId: null, currentChoices: [], buzzerLocked: false,
        choiceVotes: {}, cashAnswers: [], playerModes: {},
      });
    }
    return sessionState.get(code);
  }

  return function registerSocketHandlers(io) {
    io.on('connection', (socket) => {

      socket.on('session:join', ({ code, role, name }, ack) => {
        const session = queries.getSessionByCode(code?.toUpperCase());
        if (!session) return ack?.({ error: 'Session introuvable' });
        socket.join(code);
        socket.data.code = code;
        socket.data.role = role;
        if (role === 'admin') {
          socket.join(`${code}:admin`);
          ack?.({ ok: true });
        } else if (role === 'player' && name) {
          const player = queries.upsertPlayer(session.id, socket.id, name.trim());
          socket.data.playerId = player.id;
          socket.data.playerName = player.name;
          socket.join(`${code}:player:${player.id}`);
          io.to(code).emit('players:update', queries.getPlayersBySession(session.id));
          ack?.({ ok: true, player });
        } else if (role === 'display') {
          const players = queries.getPlayersBySession(session.id);
          socket.emit('players:update', players);

          const state = getState(code);
          if (state.currentQuestionId) {
            const q = queries.getQuestionsBySession(session.id).find(q => q.id === state.currentQuestionId);
            if (q) {
              const count = Object.values(state.choiceVotes).reduce((a, b) => a + b, 0) + state.cashAnswers.length;
              socket.emit('question:show', { questionId: q.id, text: q.text, mode: q.mode, playerCount: players.length });
              socket.emit('votes:update', { count, total: players.length, perChoice: { ...state.choiceVotes } });

              if (session.state === 'reveal') {
                const correctIds = new Set(state.currentChoices.filter(c => c.is_correct === 1).map(c => c.id));
                const allChoices = state.currentChoices.map(c => ({ id: c.id, label: c.label, position: c.position }));
                socket.emit('question:answer-revealed', {
                  correctChoiceIds: [...correctIds],
                  allChoices,
                  perChoice: { ...state.choiceVotes },
                });
              }
            }
          }
          ack?.({ ok: true });
        } else {
          ack?.({ ok: true });
        }
      });

      socket.on('question:show', ({ code, questionId }) => {
        const session = queries.getSessionByCode(code);
        if (!session) return;
        const state = getState(code);
        state.currentQuestionId = questionId;
        state.buzzerLocked = false;
        state.choiceVotes = {};
        state.cashAnswers = [];
        state.playerModes = {};
        state.currentChoices = queries.getChoicesByQuestion(questionId);
        const q = queries.getQuestionsBySession(session.id).find(q => q.id === questionId);
        if (!q) return;
        queries.updateSessionState(code, 'question');
        const playerCount = queries.getPlayersBySession(session.id).length;
        io.to(code).emit('question:show', { questionId: q.id, text: q.text, mode: q.mode, playerCount });
        io.to(code).emit('votes:update', { count: 0, total: playerCount, perChoice: {} });
        io.to(`${code}:admin`).emit('answers:reset', {
          choices: state.currentChoices.map(c => ({ id: c.id, label: c.label, is_correct: c.is_correct })),
        });
      });

      socket.on('player:choose-mode', ({ mode }, ack) => {
        const { code, playerId } = socket.data;
        if (!code || !playerId) return ack?.({ error: 'Non connecté' });
        const state = getState(code);
        if (!state.currentQuestionId) return ack?.({ error: 'Pas de question active' });
        state.playerModes[playerId] = mode;
        if (mode === 'cash') return ack?.({ ok: true, mode: 'cash' });
        const choices = state.currentChoices;
        if (mode === 'duo') {
          const correct = choices.find(c => c.is_correct === 1);
          const wrongs  = choices.filter(c => c.is_correct === 0);
          if (!correct || !wrongs.length) return ack?.({ error: 'Pas de bonne réponse définie' });
          const duoChoices = [correct, wrongs[Math.floor(Math.random() * wrongs.length)]]
            .sort(() => Math.random() - 0.5).map(c => ({ id: c.id, label: c.label }));
          return ack?.({ ok: true, mode: 'duo', choices: duoChoices });
        }
        return ack?.({ ok: true, mode: 'carre', choices: choices.map(c => ({ id: c.id, label: c.label })) });
      });

      socket.on('player:answer', ({ text }, ack) => {
        const { code, playerId, playerName } = socket.data;
        if (!code || !playerId) return ack?.({ error: 'Non connecté' });
        const session = queries.getSessionByCode(code);
        const state   = getState(code);
        if (!state.currentQuestionId) return ack?.({ error: 'Pas de question active' });
        const ok = queries.insertAnswer({
          sessionId: session.id, questionId: state.currentQuestionId,
          playerId, textAnswer: text?.trim(), playerMode: 'cash',
        });
        ack?.({ ok });
        if (ok) {
          state.cashAnswers.push({ playerName, playerId, text: text?.trim() });
          io.to(`${code}:admin`).emit('answer:new', {
            playerName, playerId, choiceId: null, choiceLabel: null,
            playerMode: 'cash', text: text?.trim(),
          });
        }
        const total = queries.getPlayersBySession(session.id).length;
        const count = Object.values(state.choiceVotes).reduce((a, b) => a + b, 0) + state.cashAnswers.length;
        io.to(code).emit('votes:update', { count, total, perChoice: { ...state.choiceVotes } });
      });

      socket.on('player:vote', ({ choiceId }, ack) => {
        const { code, playerId, playerName } = socket.data;
        if (!code || !playerId) return ack?.({ error: 'Non connecté' });
        const session = queries.getSessionByCode(code);
        const state   = getState(code);
        if (!state.currentQuestionId) return ack?.({ error: 'Pas de question active' });
        const playerMode  = state.playerModes[playerId] || 'carre';
        const choiceLabel = state.currentChoices.find(c => c.id === choiceId)?.label || '';
        const ok = queries.insertAnswer({
          sessionId: session.id, questionId: state.currentQuestionId,
          playerId, choiceId, playerMode,
        });
        ack?.({ ok });
        if (ok) {
          state.choiceVotes[choiceId] = (state.choiceVotes[choiceId] || 0) + 1;
          io.to(`${code}:admin`).emit('answer:new', { playerName, playerId, choiceId, choiceLabel, playerMode });
        }
        const total = queries.getPlayersBySession(session.id).length;
        const count = Object.values(state.choiceVotes).reduce((a, b) => a + b, 0) + state.cashAnswers.length;
        io.to(code).emit('votes:update', { count, total, perChoice: { ...state.choiceVotes } });
      });

      socket.on('question:reveal-answer', ({ code }) => {
        const session = queries.getSessionByCode(code);
        if (!session) return;
        const state = getState(code);
        if (!state.currentQuestionId) return;
        const choices    = state.currentChoices;
        const correctIds = new Set(choices.filter(c => c.is_correct === 1).map(c => c.id));
        const allChoices = choices.map(c => ({ id: c.id, label: c.label, position: c.position }));
        const answers = queries.getAnswersByQuestion(state.currentQuestionId);
        for (const ans of answers) {
          if (ans.player_mode === 'cash') continue;
          if (ans.choice_id && correctIds.has(ans.choice_id)) {
            queries.updatePlayerScore(ans.player_id, MODE_POINTS[ans.player_mode] ?? 2);
          }
        }
        queries.updateSessionState(code, 'reveal');
        io.to(code).emit('question:answer-revealed', {
          correctChoiceIds: [...correctIds], allChoices, perChoice: { ...state.choiceVotes },
        });
        io.to(code).emit('players:update', queries.getPlayersBySession(session.id));
      });

      socket.on('admin:cash-result', ({ code, playerId, valid }, ack) => {
        const session = queries.getSessionByCode(code);
        if (!session) return ack?.({ error: 'Session introuvable' });
        if (valid) queries.updatePlayerScore(playerId, 5);
        io.to(code).emit('players:update', queries.getPlayersBySession(session.id));
        io.to(`${code}:player:${playerId}`).emit('cash:result', { valid });
        ack?.({ ok: true });
      });

      socket.on('admin:edit-question', ({ code, questionId, text, mode, choices }, ack) => {
        const session = queries.getSessionByCode(code);
        if (!session) return ack?.({ error: 'Session introuvable' });
        if (!questionId) return ack?.({ error: 'questionId requis' });
        queries.updateQuestion(questionId, text, mode);
        if (mode !== 'buzzer') queries.replaceChoices(questionId, choices || []);
        const updated = queries.getQuestionsBySession(session.id).map(q => ({
          ...q, choices: queries.getChoicesByQuestion(q.id),
        }));
        io.to(`${code}:admin`).emit('questions:list', updated);
        ack?.({ ok: true, questionId });
      });

      socket.on('admin:score-update', ({ code, playerId, delta }, ack) => {
        const session = queries.getSessionByCode(code);
        if (!session) return ack?.({ error: 'Session introuvable' });
        queries.updatePlayerScore(playerId, delta);
        io.to(code).emit('players:update', queries.getPlayersBySession(session.id));
        ack?.({ ok: true });
      });

      socket.on('admin:reset-game', ({ code }, ack) => {
        const session = queries.getSessionByCode(code);
        if (!session) return ack?.({ error: 'Session introuvable' });
        const state = getState(code);
        state.currentQuestionId = null;
        state.currentChoices    = [];
        state.buzzerLocked      = false;
        state.choiceVotes       = {};
        state.cashAnswers       = [];
        state.playerModes       = {};
        queries.resetPlayerScores(session.id);
        queries.updateSessionState(code, 'lobby');
        io.to(code).emit('game:reset', { players: queries.getPlayersBySession(session.id) });
        ack?.({ ok: true });
      });

      socket.on('admin:duplicate-questions', ({ fromCode, toCode }, ack) => {
        const fromSession = queries.getSessionByCode(fromCode);
        if (!fromSession) return ack?.({ error: 'Session source introuvable' });
        const toSession = queries.getSessionByCode(toCode);
        if (!toSession) return ack?.({ error: 'Session destination introuvable' });
        const count = queries.duplicateQuestions(fromSession.id, toSession.id);
        ack?.({ ok: true, questionCount: count });
      });

      socket.on('session:end', ({ code }) => {
        queries.updateSessionState(code, 'ended');
        io.to(code).emit('session:end');
      });

      socket.on('disconnect', () => {
        const { code, role } = socket.data;
        if (code && role === 'player') {
          const session = queries.getSessionByCode(code);
          if (session) io.to(code).emit('players:update', queries.getPlayersBySession(session.id));
        }
      });
    });
  };
}

async function createTestServer() {
  const db      = buildFreshDb();
  const queries = buildQueries(db);
  const registerHandlers = buildHandlers(queries);

  const app    = express();
  const server = http.createServer(app);
  const io     = new Server(server, { cors: { origin: '*' } });

  registerHandlers(io);

  await new Promise((resolve) => server.listen(0, resolve));

  return {
    port: server.address().port,
    db,
    queries,
    close: () => new Promise((resolve, reject) =>
      server.close((err) => err ? reject(err) : resolve())
    ),
  };
}

module.exports = { createTestServer };
