const {
  getSessionByCode, updateSessionState, generateCode,
  upsertPlayer, getPlayersBySession, updatePlayerScore, resetPlayerScores,
  insertQuestion, insertChoice, getQuestionsBySession, getChoicesByQuestion,
  updateQuestion, replaceChoices, duplicateQuestions,
  insertAnswer, getAnswersByQuestion,
  insertBuzz, setWinner,
  createSession,
} = require('../db/queries');

const MODE_POINTS = { duo: 2, carre: 3, cash: 5 };

const sessionState = new Map();

function getState(code) {
  if (!sessionState.has(code)) {
    sessionState.set(code, {
      currentQuestionId: null,
      currentChoices: [],      // [{ id, label, is_correct }]
      buzzerLocked: false,
      choiceVotes: {},         // { choiceId: count }
      cashAnswers: [],
      playerModes: {},         // { playerId: mode }
    });
  }
  return sessionState.get(code);
}

module.exports = function registerSocketHandlers(io) {
  io.on('connection', (socket) => {

    // ── Join ────────────────────────────────────────────────────────────────

    socket.on('session:join', ({ code, role, name }, ack) => {
      const session = getSessionByCode(code?.toUpperCase());
      if (!session) return ack?.({ error: 'Session introuvable' });

      socket.join(code);
      socket.data.code = code;
      socket.data.role = role;

      if (role === 'admin') {
        socket.join(`${code}:admin`);
        ack?.({ ok: true });
      } else if (role === 'player' && name) {
        const player = upsertPlayer(session.id, socket.id, name.trim());
        socket.data.playerId = player.id;
        socket.data.playerName = player.name;
        // Room privée pour notifier ce joueur spécifiquement
        socket.join(`${code}:player:${player.id}`);
        io.to(code).emit('players:update', getPlayersBySession(session.id));
        ack?.({ ok: true, player });
      } else if (role === 'display') {
        // Envoyer l'état courant au display qui vient de rejoindre
        const players = getPlayersBySession(session.id);
        socket.emit('players:update', players);

        const state = getState(code);
        if (state.currentQuestionId) {
          const q = getQuestionsBySession(session.id).find(q => q.id === state.currentQuestionId);
          if (q) {
            const count = Object.values(state.choiceVotes).reduce((a, b) => a + b, 0) + state.cashAnswers.length;
            socket.emit('question:show', { questionId: q.id, text: q.text, mode: q.mode, playerCount: players.length });
            socket.emit('votes:update', { count, total: players.length, perChoice: { ...state.choiceVotes } });

            // Si la réponse est déjà révélée, envoyer aussi l'état révélé
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

    // ── Admin: questions ────────────────────────────────────────────────────

    socket.on('admin:create-question', ({ code, text, mode, choices, answer }, ack) => {
      const session = getSessionByCode(code);
      if (!session) return ack?.({ error: 'Session introuvable' });
      const questions = getQuestionsBySession(session.id);
      const qId = insertQuestion(session.id, text, mode, questions.length);
      if (mode === 'buzzer') {
        if (answer?.trim()) insertChoice(qId, answer.trim(), true, 0);
      } else {
        (choices || []).forEach((c, i) => insertChoice(qId, c.label, c.isCorrect ?? false, i));
      }
      ack?.({ ok: true, questionId: qId });
    });

    socket.on('admin:get-questions', ({ code }) => {
      const session = getSessionByCode(code);
      if (!session) return;
      socket.emit('questions:list', getQuestionsBySession(session.id).map(q => ({
        ...q, choices: getChoicesByQuestion(q.id),
      })));
    });

    socket.on('admin:edit-question', ({ code, questionId, text, mode, choices }, ack) => {
      const session = getSessionByCode(code);
      if (!session) return ack?.({ error: 'Session introuvable' });
      if (!questionId) return ack?.({ error: 'questionId requis' });

      updateQuestion(questionId, text, mode);
      if (mode === 'buzzer') {
        replaceChoices(questionId, answer?.trim() ? [{ label: answer.trim(), isCorrect: true }] : []);
      } else {
        replaceChoices(questionId, choices || []);
      }

      // Rafraîchir la liste pour tous les admins de la session
      const updated = getQuestionsBySession(session.id).map(q => ({
        ...q, choices: getChoicesByQuestion(q.id),
      }));
      io.to(`${code}:admin`).emit('questions:list', updated);

      ack?.({ ok: true, questionId });
    });

    // ── Admin: show question ────────────────────────────────────────────────

    socket.on('question:show', ({ code, questionId }) => {
      const session = getSessionByCode(code);
      if (!session) return;

      const state = getState(code);
      state.currentQuestionId = questionId;
      state.buzzerLocked = false;
      state.choiceVotes = {};
      state.cashAnswers = [];
      state.playerModes = {};
      state.currentChoices = getChoicesByQuestion(questionId);

      const q = getQuestionsBySession(session.id).find(q => q.id === questionId);
      if (!q) return;

      updateSessionState(code, 'question');
      const playerCount = getPlayersBySession(session.id).length;

      io.to(code).emit('question:show', { questionId: q.id, text: q.text, mode: q.mode, playerCount });
      io.to(code).emit('votes:update', { count: 0, total: playerCount, perChoice: {} });

      // Reset admin answers list
      io.to(`${code}:admin`).emit('answers:reset', {
        choices: state.currentChoices.map(c => ({ id: c.id, label: c.label, is_correct: c.is_correct })),
      });
    });

    // ── Player: choose mode ─────────────────────────────────────────────────

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
          .sort(() => Math.random() - 0.5)
          .map(c => ({ id: c.id, label: c.label }));
        return ack?.({ ok: true, mode: 'duo', choices: duoChoices });
      }

      // carre
      return ack?.({ ok: true, mode: 'carre', choices: choices.map(c => ({ id: c.id, label: c.label })) });
    });

    // ── Player: vote ────────────────────────────────────────────────────────

    socket.on('player:vote', ({ choiceId }, ack) => {
      const { code, playerId, playerName } = socket.data;
      if (!code || !playerId) return ack?.({ error: 'Non connecté' });

      const session = getSessionByCode(code);
      const state   = getState(code);
      if (!state.currentQuestionId) return ack?.({ error: 'Pas de question active' });

      const playerMode  = state.playerModes[playerId] || 'carre';
      const choiceLabel = state.currentChoices.find(c => c.id === choiceId)?.label || '';

      const ok = insertAnswer({ sessionId: session.id, questionId: state.currentQuestionId, playerId, choiceId, playerMode });
      ack?.({ ok });

      if (ok) {
        state.choiceVotes[choiceId] = (state.choiceVotes[choiceId] || 0) + 1;
        // Notify admin with individual answer detail
        io.to(`${code}:admin`).emit('answer:new', { playerName, playerId, choiceId, choiceLabel, playerMode });
      }

      const total = getPlayersBySession(session.id).length;
      const count = Object.values(state.choiceVotes).reduce((a, b) => a + b, 0) + state.cashAnswers.length;
      io.to(code).emit('votes:update', { count, total, perChoice: { ...state.choiceVotes } });
    });

    // ── Player: cash answer ─────────────────────────────────────────────────

    socket.on('player:answer', ({ text }, ack) => {
      const { code, playerId, playerName } = socket.data;
      if (!code || !playerId) return ack?.({ error: 'Non connecté' });

      const session = getSessionByCode(code);
      const state   = getState(code);
      if (!state.currentQuestionId) return ack?.({ error: 'Pas de question active' });

      const ok = insertAnswer({ sessionId: session.id, questionId: state.currentQuestionId, playerId, textAnswer: text?.trim(), playerMode: 'cash' });
      ack?.({ ok });

      if (ok) {
        state.cashAnswers.push({ playerName, playerId, text: text?.trim() });
        // answer:new covers cash too (with choiceId=null)
        io.to(`${code}:admin`).emit('answer:new', { playerName, playerId, choiceId: null, choiceLabel: null, playerMode: 'cash', text: text?.trim() });
      }

      const total = getPlayersBySession(session.id).length;
      const count = Object.values(state.choiceVotes).reduce((a, b) => a + b, 0) + state.cashAnswers.length;
      io.to(code).emit('votes:update', { count, total, perChoice: { ...state.choiceVotes } });
    });

    // ── Admin: reveal answer ────────────────────────────────────────────────

    socket.on('question:reveal-answer', ({ code }) => {
      const session = getSessionByCode(code);
      if (!session) return;
      const state = getState(code);
      if (!state.currentQuestionId) return;

      const choices    = state.currentChoices;
      const correctIds = new Set(choices.filter(c => c.is_correct === 1).map(c => c.id));
      const allChoices = choices.map(c => ({ id: c.id, label: c.label, position: c.position }));

      // Auto-score duo + carré
      const answers = getAnswersByQuestion(state.currentQuestionId);
      for (const ans of answers) {
        if (ans.player_mode === 'cash') continue;
        if (ans.choice_id && correctIds.has(ans.choice_id)) {
          updatePlayerScore(ans.player_id, MODE_POINTS[ans.player_mode] ?? 2);
        }
      }

      updateSessionState(code, 'reveal');

      io.to(code).emit('question:answer-revealed', {
        correctChoiceIds: [...correctIds],
        allChoices,
        perChoice: { ...state.choiceVotes },
      });
      io.to(code).emit('players:update', getPlayersBySession(session.id));
    });

    // ── Buzzer ──────────────────────────────────────────────────────────────

    socket.on('player:buzz', (_, ack) => {
      const { code, playerId, playerName } = socket.data;
      if (!code || !playerId) return ack?.({ error: 'Non connecté' });

      const state = getState(code);
      if (state.buzzerLocked) return ack?.({ ok: false, locked: true });
      if (!state.currentQuestionId) return ack?.({ error: 'Pas de question active' });

      const session = getSessionByCode(code);
      const buzzId  = insertBuzz(session.id, state.currentQuestionId, playerId, Date.now());
      if (!buzzId) return ack?.({ ok: false, locked: true });

      state.buzzerLocked = true;
      setWinner(buzzId);
      io.to(code).emit('buzzer:winner', { playerId, playerName });
      io.to(code).emit('buzzer:lock', { winnerName: playerName });
      ack?.({ ok: true, winner: true });
    });

    socket.on('buzzer:reset', ({ code }) => {
      getState(code).buzzerLocked = false;
      io.to(code).emit('buzzer:reset');
    });

    socket.on('admin:buzzer-result', ({ code, playerId, valid }, ack) => {
      const session = getSessionByCode(code);
      if (!session) return ack?.({ error: 'Session introuvable' });

      const state = getState(code);

      if (valid) {
        updatePlayerScore(playerId, 5);
        const answer = state.currentChoices.find(c => c.is_correct === 1)?.label ?? null;
        io.to(code).emit('players:update', getPlayersBySession(session.id));
        io.to(code).emit('buzzer:validated', { answer });
      } else {
        state.buzzerLocked = false;
        io.to(code).emit('buzzer:reset');
      }
      ack?.({ ok: true });
    });

    // ── Admin: score update ─────────────────────────────────────────────────

    socket.on('admin:score-update', ({ code, playerId, delta }, ack) => {
      const session = getSessionByCode(code);
      if (!session) return ack?.({ error: 'Session introuvable' });
      updatePlayerScore(playerId, delta);
      io.to(code).emit('players:update', getPlayersBySession(session.id));
      ack?.({ ok: true });
    });

    // Validation/invalidation d'une réponse cash : met à jour le score
    // ET notifie le joueur concerné via sa room privée
    socket.on('admin:cash-result', ({ code, playerId, valid }, ack) => {
      const session = getSessionByCode(code);
      if (!session) return ack?.({ error: 'Session introuvable' });
      if (valid) updatePlayerScore(playerId, 5);
      io.to(code).emit('players:update', getPlayersBySession(session.id));
      io.to(`${code}:player:${playerId}`).emit('cash:result', { valid });
      ack?.({ ok: true });
    });

    // ── Reset game ──────────────────────────────────────────────────────────

    socket.on('admin:reset-game', ({ code }, ack) => {
      const session = getSessionByCode(code);
      if (!session) return ack?.({ error: 'Session introuvable' });

      // Vider l'état en mémoire
      const state = getState(code);
      state.currentQuestionId = null;
      state.currentChoices    = [];
      state.buzzerLocked      = false;
      state.choiceVotes       = {};
      state.cashAnswers       = [];
      state.playerModes       = {};

      // Remettre les scores à 0 en DB
      resetPlayerScores(session.id);
      updateSessionState(code, 'lobby');

      // Notifier tout le monde
      io.to(code).emit('game:reset', { players: getPlayersBySession(session.id) });
      ack?.({ ok: true });
    });

    // ── Duplicate questions to a new session ────────────────────────────────

    socket.on('admin:duplicate-questions', ({ fromCode, toCode }, ack) => {
      try {
        const fromSession = getSessionByCode(fromCode?.toUpperCase());
        if (!fromSession) return ack?.({ error: 'Session source introuvable' });
        const toSession = getSessionByCode(toCode?.toUpperCase());
        if (!toSession) return ack?.({ error: 'Session destination introuvable' });

        const count = duplicateQuestions(fromSession.id, toSession.id);
        ack?.({ ok: true, questionCount: count });
      } catch (e) {
        console.error('[duplicate-questions] erreur :', e);
        ack?.({ error: e.message || 'Erreur serveur' });
      }
    });

    // ── Session end ─────────────────────────────────────────────────────────

    socket.on('session:end', ({ code }) => {
      updateSessionState(code, 'ended');
      io.to(code).emit('session:end');
    });

    // ── Disconnect ──────────────────────────────────────────────────────────

    socket.on('disconnect', () => {
      const { code, role } = socket.data;
      if (code && role === 'player') {
        const session = getSessionByCode(code);
        if (session) io.to(code).emit('players:update', getPlayersBySession(session.id));
      }
    });
  });
};
