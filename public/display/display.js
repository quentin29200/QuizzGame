const socket = io();

const LETTERS      = ['A', 'B', 'C', 'D'];
const COLOR_CLASSES = ['ca', 'cb', 'cc', 'cd'];

let sessionCode   = null;
let players       = [];
let currentChoices = [];
let playerCount   = 0;

// ─── Init ──────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const code = params.get('code') || localStorage.getItem('displayCode');
  if (code) connectToSession(code.toUpperCase());
});

function connectToSession(code) {
  sessionCode = code;
  localStorage.setItem('displayCode', code);
  document.getElementById('display-code').textContent = code;
  document.getElementById('code-corner').textContent  = code;
  socket.emit('session:join', { code, role: 'display' }, (res) => {
    if (res?.error) console.error(res.error);
  });
}

socket.on('connect', () => { if (sessionCode) connectToSession(sessionCode); });

// ─── Screens ──────────────────────────────────────────────────────────────────

function show(id) {
  ['lobby', 'game-layout', 'buzzer-screen'].forEach(s =>
    document.getElementById(s).classList.toggle('hidden', s !== id)
  );
}

// ─── Question show ─────────────────────────────────────────────────────────────

socket.on('question:show', ({ text, mode, playerCount: pc }) => {
  playerCount    = pc || players.length;
  currentChoices = [];

  if (mode === 'buzzer') {
    document.getElementById('buzz-question-text').textContent = text;
    document.getElementById('buzz-label').textContent = 'Mode Buzzer';
    document.getElementById('winner-display').classList.add('hidden');
    document.getElementById('buzz-waiting').classList.remove('hidden');
    show('buzzer-screen');
    return;
  }

  document.getElementById('question-text').textContent   = text;
  document.getElementById('q-mode-label').textContent    = 'Question';
  document.getElementById('choices-grid').innerHTML      = '';
  document.getElementById('vote-count').textContent      = '0';
  document.getElementById('vote-total').textContent      = playerCount;
  show('game-layout');
});

// ─── Answer revealed (with all choices) ───────────────────────────────────────

socket.on('question:answer-revealed', ({ correctChoiceIds, allChoices, perChoice }) => {
  currentChoices = allChoices;
  const total = Object.values(perChoice || {}).reduce((a, b) => a + b, 0);

  const grid = document.getElementById('choices-grid');
  grid.innerHTML = allChoices.map((c, i) => {
    const isCorrect = correctChoiceIds.includes(c.id);
    const votes     = perChoice?.[c.id] || 0;
    const pct       = total > 0 ? Math.round(votes / total * 100) : 0;
    return `
      <div class="choice-card ${COLOR_CLASSES[i]} ${isCorrect ? 'correct' : 'wrong'} fade-in"
           style="animation-delay:${i * .08}s">
        <div class="choice-letter"><span>${LETTERS[i]}</span></div>
        <div class="choice-content">
          <div class="choice-label">${c.label}</div>
          <div class="vbar-wrap"><div class="vbar-fill" style="width:${pct}%"></div></div>
        </div>
      </div>
    `;
  }).join('');
});

// ─── Votes update ──────────────────────────────────────────────────────────────

socket.on('votes:update', ({ count, total }) => {
  document.getElementById('vote-count').textContent = count;
  if (total) document.getElementById('vote-total').textContent = total;
});

// ─── Buzzer ────────────────────────────────────────────────────────────────────

socket.on('buzzer:winner', ({ playerName }) => {
  document.getElementById('buzz-waiting').classList.add('hidden');
  document.getElementById('buzz-label').textContent = '🏆 Buzzer !';
  const w = document.getElementById('winner-display');
  w.textContent = playerName;
  w.classList.remove('hidden');
});

socket.on('buzzer:reset', () => {
  document.getElementById('winner-display').classList.add('hidden');
  document.getElementById('buzz-label').textContent  = 'Mode Buzzer';
  document.getElementById('buzz-waiting').classList.remove('hidden');
});

// ─── Players + leaderboard ─────────────────────────────────────────────────────

socket.on('players:update', (list) => {
  players     = list;
  playerCount = list.length;

  // Lobby counter
  const counter = document.getElementById('lobby-status');
  if (counter) counter.textContent = list.length === 0
    ? 'Aucun joueur connecté'
    : `${list.length} joueur${list.length > 1 ? 's' : ''} connecté${list.length > 1 ? 's' : ''}`;

  // Players bar
  document.getElementById('players-bar').innerHTML = list.map(p => `
    <div class="p-chip">
      <span>${p.name}</span>
      <span class="p-chip-score">${p.score}</span>
    </div>
  `).join('');

  // Leaderboard (sorted by score, already from server)
  renderLeaderboard(list);
});

function renderLeaderboard(list) {
  const el = document.getElementById('lb-list');
  if (!list.length) {
    el.innerHTML = '<div class="lb-empty">En attente de joueurs…</div>';
    return;
  }
  el.innerHTML = list.map((p, i) => `
    <div class="lb-row ${i < 3 ? `lb-${i + 1}` : ''}">
      <span class="lb-rank">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}</span>
      <span class="lb-name">${p.name}</span>
      <span class="lb-score">${p.score}</span>
    </div>
  `).join('');
}

// ─── Reset game ────────────────────────────────────────────────────────────────

socket.on('game:reset', ({ players: list }) => {
  currentChoices = [];
  playerCount    = list.length;
  players        = list;
  renderLeaderboard(list);
  document.getElementById('players-bar').innerHTML = list.map(p => `
    <div class="p-chip"><span>${p.name}</span><span class="p-chip-score">${p.score}</span></div>
  `).join('');
  show('lobby');
});

// ─── Session end ───────────────────────────────────────────────────────────────

socket.on('session:end', () => {
  show('lobby');
  document.getElementById('display-code').textContent = '——';
  localStorage.removeItem('displayCode');
});
