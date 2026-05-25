const socket = io();

const LETTERS = ['A', 'B', 'C', 'D'];
const COLOR_CLASSES = ['ca', 'cb', 'cc', 'cd'];

let sessionCode   = null;
let playerName    = null;
let playerId      = null;
let currentMode   = null;   // question mode: 'normal' | 'buzzer'
let playerMode    = null;   // chosen mode: 'duo' | 'carre' | 'cash'
let currentText   = '';
let hasAnswered   = false;
let buzzerLocked  = false;
let myChoiceId    = null;   // choiceId voted for this question
let timerInterval = null;

// ─── Screens ──────────────────────────────────────────────────────────────────

const SCREENS = ['join-screen','lobby-screen','waiting-screen','mode-screen','vote-screen','cash-screen','buzzer-screen','end-screen'];
function show(id) {
  SCREENS.forEach(s => document.getElementById(s).classList.toggle('hidden', s !== id));
  // Bouton quitter : visible sur tous les écrans sauf la saisie de code
  document.getElementById('leave-btn').classList.toggle('hidden', id === 'join-screen');
}

// ─── Timer joueur ─────────────────────────────────────────────────────────────

function startPlayTimer(duration, startedAt) {
  console.log('[timer:play] startPlayTimer appelé', { duration, startedAt });
  clearInterval(timerInterval);
  const bar  = document.getElementById('play-timer-bar');
  const fill = document.getElementById('play-timer-fill');
  if (!duration) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');

  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  let remaining = Math.max(0, duration - elapsed);

  const update = () => {
    const pct = Math.max(0, remaining / duration * 100);
    fill.style.width = pct + '%';
    fill.style.background = pct > 50 ? 'var(--green)' : pct > 25 ? '#f5a623' : 'var(--accent)';
  };
  update();
  if (remaining <= 0) return;
  timerInterval = setInterval(() => {
    remaining = Math.max(0, remaining - 1);
    update();
    if (remaining <= 0) clearInterval(timerInterval);
  }, 1000);
}

function stopPlayTimer() {
  clearInterval(timerInterval);
  document.getElementById('play-timer-bar').classList.add('hidden');
}

// ─── Quitter la session ────────────────────────────────────────────────────────

function leaveSession() {
  stopPlayTimer();
  localStorage.removeItem('playerSession');
  sessionCode  = null;
  playerName   = null;
  playerId     = null;
  currentMode  = null;
  playerMode   = null;
  hasAnswered  = false;
  buzzerLocked = false;
  myChoiceId   = null;
  currentText  = '';
  show('join-screen');
}

// ─── Resynchronisation après reconnexion ──────────────────────────────────────

function syncToGameState(gs) {
  if (!gs) { show('lobby-screen'); return; }

  if (gs.sessionState === 'ended') { show('end-screen'); return; }

  if (!gs.question) { show('lobby-screen'); return; }

  currentText  = gs.question.text;
  currentMode  = gs.question.mode;
  hasAnswered  = gs.hasAnswered || false;
  playerMode   = gs.playerMode  || null;

  // ── Buzzer ──
  if (gs.question.mode === 'buzzer') {
    document.getElementById('buzz-question').textContent = gs.question.text;
    document.getElementById('buzz-status').textContent   = '';
    document.getElementById('buzz-status').className     = '';
    if (gs.buzzerLocked) {
      buzzerLocked = true;
      document.getElementById('buzz-btn').disabled = true;
      document.getElementById('buzz-ring').style.animationPlayState = 'paused';
      document.getElementById('buzz-status').textContent = 'Buzzer verrouillé';
      document.getElementById('buzz-status').className   = 'locked';
    } else {
      buzzerLocked = false;
      document.getElementById('buzz-btn').disabled = false;
      document.getElementById('buzz-ring').style.animationPlayState = 'running';
    }
    show('buzzer-screen');
    return;
  }

  // ── Normal ──
  if (gs.hasAnswered) {
    if (gs.playerMode === 'cash' && gs.sessionState === 'question') {
      // A répondu en cash, en attente de validation admin
      document.getElementById('cash-question-text').textContent = gs.question.text;
      document.getElementById('cash-input').disabled = true;
      document.getElementById('cash-send-btn').disabled = true;
      const sent = document.getElementById('cash-sent');
      sent.textContent = 'Réponse envoyée ✓';
      sent.style.color = '';
      sent.classList.remove('hidden');
      show('cash-screen');
    } else if (gs.playerMode === 'cash' && gs.sessionState === 'reveal') {
      document.getElementById('cash-question-text').textContent = gs.question.text;
      document.getElementById('cash-input').disabled = true;
      document.getElementById('cash-send-btn').disabled = true;
      const sent = document.getElementById('cash-sent');
      sent.textContent = '⏳ En attente de validation par l\'admin…';
      sent.style.color = '';
      sent.classList.remove('hidden');
      show('cash-screen');
    } else {
      // A déjà voté en duo/carré, attente de la prochaine question
      show('waiting-screen');
    }
  } else {
    // Pas encore répondu : afficher le choix de mode
    document.getElementById('mode-question-text').textContent = gs.question.text;
    show('mode-screen');
  }
}

// ─── Join ──────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
  const saved = JSON.parse(localStorage.getItem('playerSession') || 'null');
  if (saved?.code && saved?.name) {
    document.getElementById('code-input').value = saved.code;
    document.getElementById('name-input').value = saved.name;
  }
  document.getElementById('code-input').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase();
  });
});

function joinSession() {
  const code = document.getElementById('code-input').value.trim().toUpperCase();
  const name = document.getElementById('name-input').value.trim();
  if (code.length !== 4) return toast('Code à 4 lettres requis', true);
  if (!name) return toast('Pseudo requis', true);

  socket.emit('session:join', { code, role: 'player', name }, (res) => {
    if (res?.error) return toast(res.error, true);
    sessionCode = code;
    playerName  = name;
    playerId    = res.player?.id;
    localStorage.setItem('playerSession', JSON.stringify({ code, name }));
    document.getElementById('lobby-name').textContent = name;
    document.getElementById('lobby-code').textContent = code;
    if (res.gameState) {
      syncToGameState(res.gameState);
    } else {
      show('lobby-screen');
    }
  });
}

socket.on('connect', () => {
  if (sessionCode && playerName) {
    socket.emit('session:join', { code: sessionCode, role: 'player', name: playerName }, (res) => {
      if (!res?.player) return;
      playerId = res.player.id;
      if (res.gameState) syncToGameState(res.gameState);
    });
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !document.getElementById('join-screen').classList.contains('hidden')) joinSession();
});

// ─── Question show ─────────────────────────────────────────────────────────────

socket.on('question:show', ({ text, mode, timerDuration, timerStartedAt }) => {
  console.log('[play] question:show reçu', { mode, timerDuration, timerStartedAt });
  currentMode  = mode;
  playerMode   = null;
  hasAnswered  = false;
  buzzerLocked = false;
  currentText  = text;
  myChoiceId   = null;

  startPlayTimer(timerDuration, timerStartedAt);

  if (mode === 'buzzer') {
    document.getElementById('buzz-question').textContent = text;
    document.getElementById('buzz-btn').disabled = false;
    document.getElementById('buzz-ring').style.animationPlayState = 'running';
    document.getElementById('buzz-status').textContent = '';
    document.getElementById('buzz-status').className = '';
    show('buzzer-screen');
    return;
  }

  // normal → show mode selection
  document.getElementById('mode-question-text').textContent = text;
  show('mode-screen');
});

// ─── Mode selection ────────────────────────────────────────────────────────────

function chooseMode(mode) {
  if (hasAnswered) return;
  playerMode = mode;

  socket.emit('player:choose-mode', { mode }, (res) => {
    if (res?.error) return toast(res.error, true);

    if (mode === 'cash') {
      document.getElementById('cash-question-text').textContent = currentText;
      document.getElementById('cash-input').value = '';
      document.getElementById('cash-input').disabled = false;
      document.getElementById('cash-send-btn').disabled = false;
      const sent = document.getElementById('cash-sent');
      sent.textContent = '';
      sent.style.color = '';
      sent.classList.add('hidden');
      show('cash-screen');
      return;
    }

    // duo or carre
    const badge = document.getElementById('vote-mode-badge');
    badge.textContent = mode === 'duo' ? 'Duo' : 'Carré';
    badge.className = `vote-mode-badge ${mode}`;
    document.getElementById('vote-question-text').textContent = currentText;
    document.getElementById('voted-msg').classList.add('hidden');

    const list = document.getElementById('choices-list');
    list.innerHTML = (res.choices || []).map((c, i) => `
      <button class="choice-btn ${COLOR_CLASSES[i]}" id="cbtn-${c.id}" onclick="submitVote(${c.id}, this)">
        <span class="cl">${LETTERS[i]}</span>
        ${c.label}
      </button>
    `).join('');

    show('vote-screen');
  });
}

// ─── Submit vote ───────────────────────────────────────────────────────────────

function submitVote(choiceId, btn) {
  if (hasAnswered) return;
  myChoiceId = choiceId;
  socket.emit('player:vote', { choiceId }, (res) => {
    if (res?.error) return toast(res.error, true);
    hasAnswered = true;
    document.querySelectorAll('.choice-btn').forEach(b => {
      b.disabled = true;
      if (b === btn) b.classList.add('selected');
    });
    const msg = document.getElementById('voted-msg');
    msg.textContent = 'Réponse envoyée ✓';
    msg.style.color = '';
    msg.classList.remove('hidden');
  });
}

// ─── Submit cash ───────────────────────────────────────────────────────────────

function submitCash() {
  if (hasAnswered) return;
  const text = document.getElementById('cash-input').value.trim();
  if (!text) return toast('Réponse vide', true);

  socket.emit('player:answer', { text }, (res) => {
    if (res?.error) return toast(res.error, true);
    hasAnswered = true;
    document.getElementById('cash-input').disabled = true;
    document.getElementById('cash-send-btn').disabled = true;
    const sent = document.getElementById('cash-sent');
    sent.textContent = 'Réponse envoyée ✓';
    sent.style.color = '';
    sent.classList.remove('hidden');
  });
}

// ─── Buzzer ────────────────────────────────────────────────────────────────────

function doBuzz() {
  if (buzzerLocked) return;
  socket.emit('player:buzz', {}, (res) => {
    if (res?.locked) { lockBuzzer('Trop tard…'); return; }
    if (res?.winner) {
      document.getElementById('buzz-btn').disabled = true;
      document.getElementById('buzz-ring').style.animationPlayState = 'paused';
      document.getElementById('buzz-status').textContent = '🎉 Vous avez buzzé en premier !';
      document.getElementById('buzz-status').className = 'winner';
    }
  });
}

function lockBuzzer(msg) {
  buzzerLocked = true;
  document.getElementById('buzz-btn').disabled = true;
  document.getElementById('buzz-ring').style.animationPlayState = 'paused';
  document.getElementById('buzz-status').textContent = msg;
  document.getElementById('buzz-status').className = 'locked';
}

// ─── Réponse révélée ──────────────────────────────────────────────────────────

socket.on('question:answer-revealed', ({ correctChoiceIds, allChoices }) => {
  stopPlayTimer();
  if (playerMode === 'cash') {
    // Cash: l'admin valide manuellement, juste afficher un message d'attente
    const sent = document.getElementById('cash-sent');
    sent.textContent = '⏳ En attente de validation par l\'admin…';
    sent.style.color = '';
    sent.classList.remove('hidden');
    return;
  }

  if (!hasAnswered) return; // le joueur n'a pas répondu

  const isCorrect = myChoiceId !== null && correctChoiceIds.includes(myChoiceId);
  const pts = isCorrect ? (playerMode === 'duo' ? 2 : 3) : 0;

  // Trouver la bonne réponse pour l'afficher
  const correctLabels = allChoices.filter(c => correctChoiceIds.includes(c.id)).map(c => c.label);

  // Marquer visuellement les boutons
  document.querySelectorAll('.choice-btn').forEach(btn => {
    const id = parseInt(btn.id.replace('cbtn-', ''));
    if (correctChoiceIds.includes(id)) {
      btn.style.borderColor = '#06b489';
      btn.style.background  = '#edfaf5';
    } else if (btn.classList.contains('selected') && !isCorrect) {
      btn.style.borderColor = '#e94560';
      btn.style.background  = '#fde8ec';
    }
  });

  // Mettre à jour le message
  const msg = document.getElementById('voted-msg');
  if (isCorrect) {
    msg.textContent = `✓ Bonne réponse ! +${pts} pts`;
    msg.style.color = '#06b489';
  } else {
    msg.textContent = `✗ Mauvaise réponse — Bonne réponse : ${correctLabels.join(', ')}`;
    msg.style.color = '#e94560';
  }
  msg.classList.remove('hidden');
});

socket.on('buzzer:lock',   ({ winnerName }) => { if (!document.getElementById('buzz-btn').disabled) lockBuzzer(`${winnerName} a la main`); });
socket.on('buzzer:winner', ({ playerName: w }) => { if (w !== playerName) lockBuzzer(`${w} a la main`); });
socket.on('buzzer:reset',  () => {
  buzzerLocked = false;
  document.getElementById('buzz-btn').disabled = false;
  document.getElementById('buzz-ring').style.animationPlayState = 'running';
  document.getElementById('buzz-status').textContent = '';
  document.getElementById('buzz-status').className   = '';
});

// ─── Résultat Cash (notification individuelle de l'admin) ─────────────────────

socket.on('cash:result', ({ valid }) => {
  const sent = document.getElementById('cash-sent');
  if (!sent) return;
  if (valid) {
    sent.textContent = '✓ Bonne réponse validée ! +5 pts';
    sent.style.color = '#06b489';
  } else {
    sent.textContent = '✗ Réponse non retenue.';
    sent.style.color = '#e94560';
  }
  sent.classList.remove('hidden');
});

// ─── Reset game ────────────────────────────────────────────────────────────────

socket.on('game:reset', () => {
  // Réinitialiser l'état local du joueur
  stopPlayTimer();
  currentMode   = null;
  playerMode    = null;
  hasAnswered   = false;
  buzzerLocked  = false;
  myChoiceId    = null;
  currentText   = '';
  show('lobby-screen');
});

// ─── Session end ───────────────────────────────────────────────────────────────

socket.on('session:end', () => {
  localStorage.removeItem('playerSession');
  show('end-screen');
});

// ─── Toast ────────────────────────────────────────────────────────────────────

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = isError ? 'error' : '';
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 2800);
}
