const socket = io();

const LETTERS      = ['A', 'B', 'C', 'D'];
const COLOR_CLASSES = ['ca', 'cb', 'cc', 'cd'];

let sessionCode   = null;
let players       = [];
let currentChoices = [];
let playerCount   = 0;
let timerInterval  = null;

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
  generateSessionQR(code);
}

function generateSessionQR(code) {
  const wrap = document.getElementById('qr-wrap');
  const container = document.getElementById('qr-code');
  if (!wrap || !container) return;

  // Construit l'URL à partir de l'origine courante
  const base = window.location.origin;
  const url  = `${base}/play?code=${code}`;

  // Vide le conteneur si un QR précédent existe
  container.innerHTML = '';

  new QRCode(container, {
    text:         url,
    width:        160,
    height:       160,
    colorDark:    '#000000',
    colorLight:   '#ffffff',
    correctLevel: QRCode.CorrectLevel.M
  });

  wrap.classList.remove('hidden');
}

socket.on('connect', () => { if (sessionCode) connectToSession(sessionCode); });

// ─── Screens ──────────────────────────────────────────────────────────────────

function show(id) {
  ['lobby', 'game-layout', 'buzzer-screen', 'final-screen'].forEach(s =>
    document.getElementById(s).classList.toggle('hidden', s !== id)
  );
}

function renderFinalLeaderboard(list) {
  const podium = document.getElementById('final-podium');
  const rest   = document.getElementById('final-rest');

  const top3   = list.slice(0, 3);
  const others = list.slice(3);

  // Podium order: 2nd left, 1st center, 3rd right
  const order  = [top3[1], top3[0], top3[2]].filter(Boolean);
  const medals = { 0: '🥇', 1: '🥈', 2: '🥉' };
  const ranks  = [1, 0, 2]; // index in top3 for left, center, right

  podium.innerHTML = order.map((p, i) => {
    const rank  = list.indexOf(p);
    const isFirst = rank === 0;
    return `
      <div class="podium-slot ${isFirst ? 'podium-first' : ''}">
        <div class="podium-medal">${medals[rank] ?? ''}</div>
        <div class="podium-name">${p.name}</div>
        <div class="podium-score">${p.score} pts</div>
        <div class="podium-bar podium-bar-${rank + 1}"></div>
      </div>
    `;
  }).join('');

  rest.innerHTML = others.map((p, i) => `
    <div class="final-row">
      <span class="final-rank">${i + 4}</span>
      <span class="final-name">${p.name}</span>
      <span class="final-score">${p.score} pts</span>
    </div>
  `).join('');
}

// ─── Timer ─────────────────────────────────────────────────────────────────────

function startDisplayTimer(duration, startedAt, isBuzzer) {
  console.log('[display] startDisplayTimer appelé', { duration, startedAt, isBuzzer });
  clearInterval(timerInterval);
  const ids = isBuzzer
    ? { wrap: 'display-timer-buzz', ring: 'timer-ring-buzz', num: 'timer-num-buzz' }
    : { wrap: 'display-timer',      ring: 'timer-ring',      num: 'timer-num'      };

  // Hide both timers first
  document.getElementById('display-timer').classList.add('hidden');
  document.getElementById('display-timer-buzz').classList.add('hidden');

  if (!duration) return;
  const wrap = document.getElementById(ids.wrap);
  const ring = document.getElementById(ids.ring);
  const num  = document.getElementById(ids.num);
  wrap.classList.remove('hidden');

  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  let remaining = Math.max(0, duration - elapsed);

  const update = () => {
    const pct    = Math.max(0, remaining / duration);
    const offset = 100 * (1 - pct);
    // Use setAttribute for reliable SVG property setting
    ring.setAttribute('stroke-dashoffset', offset);
    num.textContent = remaining;
    const color = pct > .5 ? '#06b489' : pct > .25 ? '#f5a623' : '#e94560';
    ring.setAttribute('stroke', color);
    num.style.color = color;
  };
  update();
  if (remaining <= 0) return;
  timerInterval = setInterval(() => {
    remaining = Math.max(0, remaining - 1);
    update();
    if (remaining <= 0) clearInterval(timerInterval);
  }, 1000);
}

function stopDisplayTimer() {
  clearInterval(timerInterval);
  document.getElementById('display-timer').classList.add('hidden');
  document.getElementById('display-timer-buzz').classList.add('hidden');
}

// ─── Question show ─────────────────────────────────────────────────────────────

socket.on('question:show', ({ text, mode, playerCount: pc, timerDuration, timerStartedAt }) => {
  console.log('[display] question:show reçu', { mode, timerDuration, timerStartedAt });
  playerCount    = pc || players.length;
  currentChoices = [];

  if (mode === 'buzzer') {
    document.getElementById('buzz-question-text').textContent = text;
    document.getElementById('buzz-label').textContent = 'Mode Buzzer';
    document.getElementById('winner-display').classList.add('hidden');
    document.getElementById('buzzer-answer-reveal').classList.add('hidden');
    document.getElementById('buzz-waiting').classList.remove('hidden');
    show('buzzer-screen');
    startDisplayTimer(timerDuration, timerStartedAt, true);
    return;
  }

  document.getElementById('question-text').textContent   = text;
  document.getElementById('q-mode-label').textContent    = 'Question';
  document.getElementById('choices-grid').innerHTML      = '';
  document.getElementById('vote-count').textContent      = '0';
  document.getElementById('vote-total').textContent      = playerCount;
  show('game-layout');
  startDisplayTimer(timerDuration, timerStartedAt, false);
});

// ─── Answer revealed (with all choices) ───────────────────────────────────────

socket.on('question:answer-revealed', ({ correctChoiceIds, allChoices, perChoice }) => {
  stopDisplayTimer();
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

socket.on('buzzer:validated', ({ answer }) => {
  document.getElementById('buzz-label').textContent = '✓ Bonne réponse !';
  const el = document.getElementById('buzzer-answer-reveal');
  if (answer) {
    el.textContent = answer;
    el.classList.remove('hidden');
  }
});

socket.on('buzzer:reset', () => {
  document.getElementById('winner-display').classList.add('hidden');
  document.getElementById('buzz-label').textContent  = 'Mode Buzzer';
  document.getElementById('buzz-waiting').classList.remove('hidden');
  document.getElementById('buzzer-answer-reveal').classList.add('hidden');
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
  stopDisplayTimer();
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
  renderFinalLeaderboard(players);
  show('final-screen');
  localStorage.removeItem('displayCode');
});
