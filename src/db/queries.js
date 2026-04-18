const { getDb } = require('./schema');

// ── Sessions ──────────────────────────────────────────────────────────────────

function createSession(code) {
  const info = getDb().prepare('INSERT INTO sessions (code) VALUES (?)').run(code);
  return info.lastInsertRowid;
}

function getSessionByCode(code) {
  return getDb().prepare('SELECT * FROM sessions WHERE code = ?').get(code);
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (getSessionByCode(code));
  return code;
}

/**
 * Copie toutes les questions + choices d'une session vers une autre.
 * Retourne le nombre de questions copiées.
 */
function duplicateQuestions(fromSessionId, toSessionId) {
  const db        = getDb();
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
}

function updateSessionState(code, state) {
  getDb().prepare('UPDATE sessions SET state = ? WHERE code = ?').run(state, code);
}

// ── Players ───────────────────────────────────────────────────────────────────

function upsertPlayer(sessionId, socketId, name) {
  const db = getDb();
  db.prepare(`
    INSERT INTO players (session_id, socket_id, name) VALUES (?, ?, ?)
    ON CONFLICT(session_id, name) DO UPDATE SET socket_id = excluded.socket_id
  `).run(sessionId, socketId, name);
  return db.prepare('SELECT * FROM players WHERE session_id = ? AND name = ?').get(sessionId, name);
}

function getPlayersBySession(sessionId) {
  return getDb().prepare('SELECT * FROM players WHERE session_id = ? ORDER BY score DESC, name').all(sessionId);
}

function updatePlayerScore(playerId, delta) {
  getDb().prepare('UPDATE players SET score = score + ? WHERE id = ?').run(delta, playerId);
}

function resetPlayerScores(sessionId) {
  getDb().prepare('UPDATE players SET score = 0 WHERE session_id = ?').run(sessionId);
}

// ── Questions ─────────────────────────────────────────────────────────────────

function insertQuestion(sessionId, text, mode, position) {
  const info = getDb().prepare(
    'INSERT INTO questions (session_id, text, mode, position) VALUES (?, ?, ?, ?)'
  ).run(sessionId, text, mode, position);
  return info.lastInsertRowid;
}

function insertChoice(questionId, label, isCorrect, position) {
  getDb().prepare(
    'INSERT INTO choices (question_id, label, is_correct, position) VALUES (?, ?, ?, ?)'
  ).run(questionId, label, isCorrect ? 1 : 0, position);
}

function getQuestionsBySession(sessionId) {
  return getDb().prepare('SELECT * FROM questions WHERE session_id = ? ORDER BY position').all(sessionId);
}

function getChoicesByQuestion(questionId) {
  return getDb().prepare('SELECT * FROM choices WHERE question_id = ? ORDER BY position').all(questionId);
}

function updateQuestion(questionId, text, mode) {
  getDb().prepare('UPDATE questions SET text = ?, mode = ? WHERE id = ?').run(text, mode, questionId);
}

/**
 * Met à jour les choix d'une question.
 * - Met à jour les choix existants par position
 * - Insère les nouveaux s'il y en a plus qu'avant
 * - Tente de supprimer les choix en trop ; si FK violation (réponses liées),
 *   les marque comme "[supprimé]" pour ne pas casser l'historique
 */
function replaceChoices(questionId, newChoices) {
  const db       = getDb();
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

  // Supprimer les choix excédentaires (si passage de 4 à moins de choix)
  if (existing.length > newChoices.length) {
    existing.slice(newChoices.length).forEach(c => {
      try {
        db.prepare('DELETE FROM choices WHERE id = ?').run(c.id);
      } catch {
        // Des réponses pointent vers ce choix : on le garde mais on le neutralise
        db.prepare("UPDATE choices SET label = '[supprimé]', is_correct = 0 WHERE id = ?").run(c.id);
      }
    });
  }
}

// ── Answers ───────────────────────────────────────────────────────────────────

function insertAnswer({ sessionId, questionId, playerId, choiceId, textAnswer, playerMode }) {
  try {
    getDb().prepare(`
      INSERT INTO answers (session_id, question_id, player_id, choice_id, text_answer, player_mode)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sessionId, questionId, playerId, choiceId ?? null, textAnswer ?? null, playerMode ?? null);
    return true;
  } catch {
    return false;
  }
}

function getAnswersByQuestion(questionId) {
  return getDb().prepare(`
    SELECT a.*, p.name as player_name, c.label as choice_label, c.is_correct
    FROM answers a
    JOIN players p ON p.id = a.player_id
    LEFT JOIN choices c ON c.id = a.choice_id
    WHERE a.question_id = ?
  `).all(questionId);
}

// ── Buzz events ───────────────────────────────────────────────────────────────

function insertBuzz(sessionId, questionId, playerId, buzzTs) {
  try {
    const info = getDb().prepare(
      'INSERT INTO buzz_events (session_id, question_id, player_id, buzz_ts) VALUES (?, ?, ?, ?)'
    ).run(sessionId, questionId, playerId, buzzTs);
    return info.lastInsertRowid;
  } catch { return null; }
}

function setWinner(buzzId) {
  getDb().prepare('UPDATE buzz_events SET is_winner = 1 WHERE id = ?').run(buzzId);
}

module.exports = {
  createSession, getSessionByCode, updateSessionState, generateCode,
  upsertPlayer, getPlayersBySession, updatePlayerScore, resetPlayerScores,
  insertQuestion, insertChoice, getQuestionsBySession, getChoicesByQuestion,
  updateQuestion, replaceChoices, duplicateQuestions,
  insertAnswer, getAnswersByQuestion,
  insertBuzz, setWinner,
};
