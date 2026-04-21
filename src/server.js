const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { getDb } = require('./db/schema');
const { createSession, getSessionByCode, importQuestions } = require('./db/queries');
const registerSocketHandlers = require('./socket/handlers');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Init DB on startup
getDb();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── HTML routes ───────────────────────────────────────────────────────────────
app.get('/admin', (_, res) => res.sendFile(path.join(__dirname, '../public/admin/index.html')));
app.get('/display', (_, res) => res.sendFile(path.join(__dirname, '../public/display/index.html')));
app.get('/play', (_, res) => res.sendFile(path.join(__dirname, '../public/play/index.html')));

// ── REST helpers ──────────────────────────────────────────────────────────────

// Generate unique 4-letter session code
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (getSessionByCode(code));
  return code;
}

app.post('/api/sessions', (req, res) => {
  const code = generateCode();
  const id = createSession(code);
  res.json({ id, code });
});

app.get('/api/sessions/:code', (req, res) => {
  const session = getSessionByCode(req.params.code.toUpperCase());
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

app.post('/api/sessions/import', (req, res) => {
  const { questions } = req.body;
  if (!Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'questions[] requis et non vide' });
  }

  for (const [i, q] of questions.entries()) {
    if (!q.text?.trim()) return res.status(400).json({ error: `Question ${i + 1} : text manquant` });
    const mode = q.mode === 'buzzer' ? 'buzzer' : 'normal';
    if (mode === 'normal') {
      if (!Array.isArray(q.choices) || q.choices.length < 2) {
        return res.status(400).json({ error: `Question ${i + 1} : au moins 2 choix requis` });
      }
      if (!q.choices.some(c => c.isCorrect)) {
        return res.status(400).json({ error: `Question ${i + 1} : aucune bonne réponse cochée` });
      }
    }
  }

  const code = generateCode();
  const id = createSession(code);
  const questionCount = importQuestions(id, questions);
  res.json({ id, code, questionCount });
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
registerSocketHandlers(io);

server.listen(PORT, () => {
  console.log(`QuizzGame running on http://localhost:${PORT}`);
  console.log(`  Admin   → http://localhost:${PORT}/admin`);
  console.log(`  Display → http://localhost:${PORT}/display`);
  console.log(`  Play    → http://localhost:${PORT}/play`);
});
