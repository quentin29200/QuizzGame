const socket = io();

const LETTERS      = ['A', 'B', 'C', 'D'];
const COLOR_CLASSES = ['ca', 'cb', 'cc', 'cd'];

let sessionCode        = null;
let selectedMode       = 'normal';
let selectedQuestionId = null;
let editingQuestionId  = null;     // null = création, id = édition
let questions          = [];
let players            = [];
let choiceCount        = 0;
let currentChoices     = [];       // [{ id, label, is_correct }]
let allAnswers         = [];       // answers received this question
let answersRevealed    = false;

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function switchTab(tab) {
  document.getElementById('tab-questions').classList.toggle('hidden', tab !== 'questions');
  document.getElementById('tab-game').classList.toggle('hidden',      tab !== 'game');
  document.querySelectorAll('.tab-btn').forEach((b, i) => {
    b.classList.toggle('active', (i === 0 && tab === 'questions') || (i === 1 && tab === 'game'));
  });
}

// ─── Session ──────────────────────────────────────────────────────────────────

async function joinExisting() {
  const input = document.getElementById('join-code-input');
  const code  = input.value.trim().toUpperCase();
  if (code.length !== 4) return toast('Code à 4 lettres requis', true);
  const res = await fetch(`/api/sessions/${code}`);
  if (!res.ok) return toast('Session introuvable', true);
  sessionCode = code;
  document.getElementById('session-code').textContent = code;
  localStorage.setItem('adminCode', code);
  input.value = '';
  connectSocket();
  toast(`Session ${code} chargée`);
}

async function newSession() {
  const res  = await fetch('/api/sessions', { method: 'POST' });
  const data = await res.json();
  sessionCode = data.code;
  document.getElementById('session-code').textContent = sessionCode;
  localStorage.setItem('adminCode', sessionCode);
  connectSocket();
  toast(`Session ${sessionCode} créée`);
}

function connectSocket() {
  socket.emit('session:join', { code: sessionCode, role: 'admin' }, (res) => {
    if (res?.error) return toast(res.error, true);
    socket.emit('admin:get-questions', { code: sessionCode });
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  const saved = localStorage.getItem('adminCode');
  if (saved) {
    const res = await fetch(`/api/sessions/${saved}`);
    if (res.ok) {
      sessionCode = saved;
      document.getElementById('session-code').textContent = sessionCode;
      // Si le socket est déjà connecté (race condition), rejoindre maintenant
      if (socket.connected) connectSocket();
    }
  }
  initChoicesGrid();
});

socket.on('connect', () => {
  document.getElementById('dot').classList.add('on');
  if (sessionCode) connectSocket();
});
socket.on('disconnect', () => document.getElementById('dot').classList.remove('on'));
setInterval(() => { if (sessionCode) localStorage.setItem('adminCode', sessionCode); }, 3000);

// ─── Mode pills ───────────────────────────────────────────────────────────────

document.querySelectorAll('.mode-pill').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedMode = btn.dataset.mode;
    document.getElementById('choices-section').classList.toggle('hidden', selectedMode === 'buzzer');
    document.getElementById('buzzer-answer-section').classList.toggle('hidden', selectedMode !== 'buzzer');
  });
});

// ─── Choices form ─────────────────────────────────────────────────────────────

function initChoicesGrid() {
  document.getElementById('choices-grid').innerHTML = '';
  choiceCount = 0;
  for (let i = 0; i < 4; i++) addChoice(i);
}

function addChoice(idx) {
  const grid = document.getElementById('choices-grid');
  const i = idx ?? choiceCount;
  choiceCount = Math.max(choiceCount, i + 1);
  const row = document.createElement('div');
  row.className = 'choice-row';
  row.innerHTML = `
    <input type="checkbox" id="correct-${i}" title="Correcte">
    <input type="text" id="choice-${i}" placeholder="Proposition ${i + 1}">
  `;
  grid.appendChild(row);
}

function getChoices() {
  return Array.from(document.querySelectorAll('#choices-grid .choice-row'))
    .map(row => ({
      label: row.querySelector('input[type="text"]').value.trim(),
      isCorrect: row.querySelector('input[type="checkbox"]').checked,
    }))
    .filter(c => c.label);
}

// ─── Save / Edit question ─────────────────────────────────────────────────────

function saveQuestion() {
  if (!sessionCode) return toast('Rejoignez ou créez une session', true);
  const text = document.getElementById('q-text').value.trim();
  if (!text) return toast('Texte de question requis', true);
  const choices = selectedMode === 'buzzer' ? [] : getChoices();
  const answer  = selectedMode === 'buzzer' ? document.getElementById('buzzer-answer').value.trim() : undefined;
  if (selectedMode === 'normal' && choices.length < 2) return toast('Ajoutez au moins 2 propositions', true);
  if (selectedMode === 'normal' && !choices.some(c => c.isCorrect)) return toast('Cochez la bonne réponse', true);

  if (editingQuestionId) {
    socket.emit('admin:edit-question', { code: sessionCode, questionId: editingQuestionId, text, mode: selectedMode, choices, answer }, (res) => {
      if (res?.error) return toast(res.error, true);
      toast('Question mise à jour ✓');
      cancelEdit();
    });
  } else {
    socket.emit('admin:create-question', { code: sessionCode, text, mode: selectedMode, choices, answer }, (res) => {
      if (res?.error) return toast(res.error, true);
      toast('Question enregistrée ✓');
      document.getElementById('q-text').value = '';
      document.getElementById('buzzer-answer').value = '';
      initChoicesGrid();
      socket.emit('admin:get-questions', { code: sessionCode });
    });
  }
}

function editQuestion(id) {
  const q = questions.find(q => q.id === id);
  if (!q) return;

  editingQuestionId = id;

  // Remplir le formulaire
  document.getElementById('q-text').value = q.text;

  // Mode pill
  selectedMode = q.mode;
  document.querySelectorAll('.mode-pill').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === q.mode);
  });
  document.getElementById('choices-section').classList.toggle('hidden', q.mode === 'buzzer');
  document.getElementById('buzzer-answer-section').classList.toggle('hidden', q.mode !== 'buzzer');

  // Remplir les choix
  if (q.mode === 'buzzer') {
    const buzzerAnswer = q.choices?.find(c => c.is_correct === 1 || c.is_correct === true);
    document.getElementById('buzzer-answer').value = buzzerAnswer?.label || '';
  } else if (q.choices?.length) {
    const grid = document.getElementById('choices-grid');
    grid.innerHTML = '';
    choiceCount = 0;
    q.choices.forEach((c, i) => {
      addChoice(i);
      document.getElementById(`choice-${i}`).value = c.label;
      document.getElementById(`correct-${i}`).checked = c.is_correct === 1 || c.is_correct === true;
    });
    // Compléter jusqu'à 4 si besoin
    for (let i = q.choices.length; i < 4; i++) addChoice(i);
  } else {
    initChoicesGrid();
  }

  // Afficher le bandeau édition
  document.getElementById('edit-mode-banner').classList.remove('hidden');
  document.getElementById('edit-mode-label').textContent = `✏️ Édition de la question #${questions.findIndex(x => x.id === id) + 1}`;
  document.getElementById('form-section-label').textContent = 'Modifier la question';
  document.getElementById('save-btn').textContent = 'Mettre à jour';

  renderQuestions(); // mettre en surbrillance la question éditée
  document.getElementById('q-text').focus();
}

function cancelEdit() {
  editingQuestionId = null;

  // Réinitialiser le formulaire
  document.getElementById('q-text').value = '';
  selectedMode = 'normal';
  document.querySelectorAll('.mode-pill').forEach((b, i) => b.classList.toggle('active', i === 0));
  document.getElementById('choices-section').classList.remove('hidden');
  document.getElementById('buzzer-answer-section').classList.add('hidden');
  document.getElementById('buzzer-answer').value = '';
  initChoicesGrid();

  // Masquer le bandeau
  document.getElementById('edit-mode-banner').classList.add('hidden');
  document.getElementById('form-section-label').textContent = 'Nouvelle question';
  document.getElementById('save-btn').textContent = 'Enregistrer la question';

  renderQuestions();
}

// ─── Questions list ───────────────────────────────────────────────────────────

socket.on('questions:list', (list) => {
  questions = list;
  renderQuestions();
});

function renderQuestions() {
  document.getElementById('q-count').textContent = questions.length;

  const render = (elId, clickable, editable) => {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!questions.length) { el.innerHTML = '<div style="color:var(--muted);font-size:.83rem">Aucune question.</div>'; return; }
    el.innerHTML = questions.map((q, i) => `
      <div class="q-item ${q.id === selectedQuestionId ? 'active' : ''} ${q.id === editingQuestionId ? 'active' : ''}"
           ${clickable ? `onclick="selectQuestion(${q.id})"` : ''}>
        <div class="q-dot ${q.mode}"></div>
        <span class="q-text">${q.text}</span>
        <span class="q-num">#${i + 1}</span>
        ${editable ? `<button class="q-edit-btn" onclick="event.stopPropagation();editQuestion(${q.id})">✏️</button>` : ''}
      </div>
    `).join('');
  };

  render('q-list',      false, true);
  render('q-list-game', true,  false);
}

function selectQuestion(id) {
  selectedQuestionId = id;
  answersRevealed    = false;
  renderQuestions();

  const q = questions.find(q => q.id === id);
  if (q) {
    document.getElementById('current-q-mode').textContent = q.mode === 'buzzer' ? 'Buzzer' : 'Normal';
    document.getElementById('current-q-text').textContent = q.text;
    currentChoices = q.choices || [];
  }
  document.getElementById('btn-show').disabled   = false;
  document.getElementById('btn-next').disabled   = false;
  document.getElementById('btn-answer').disabled = true;
  renderAdminAnswerHint();
  resetAnswersPanel();
  resetVoteDisplay();
}

// Affiche la bonne réponse dans la carte question (visible uniquement admin)
function renderAdminAnswerHint() {
  const hint  = document.getElementById('admin-answer-hint');
  const chips = document.getElementById('admin-answer-chips');
  const q = questions.find(q => q.id === selectedQuestionId);

  if (!q || q.mode === 'buzzer' || !currentChoices.length) {
    hint.classList.add('hidden');
    chips.innerHTML = '';
    return;
  }

  const correct = currentChoices.filter(c => c.is_correct === 1 || c.is_correct === true);
  if (!correct.length) {
    hint.classList.add('hidden');
    return;
  }

  hint.classList.remove('hidden');
  chips.innerHTML = correct.map(c => {
    const idx    = currentChoices.findIndex(x => x.id === c.id);
    const letter = LETTERS[idx] ?? '?';
    return `<span class="admin-answer-chip">${letter} — ${c.label}</span>`;
  }).join('');
}

// ─── Controls ─────────────────────────────────────────────────────────────────

function showQuestion() {
  if (!selectedQuestionId || !sessionCode) return;
  const q = questions.find(q => q.id === selectedQuestionId);

  socket.emit('question:show', { code: sessionCode, questionId: selectedQuestionId });

  document.getElementById('btn-answer').disabled = false;
  document.getElementById('buzzer-winner-card').classList.add('hidden');
  answersRevealed = false;

  // Vote bars
  const hasChoices = q?.mode === 'normal';
  document.getElementById('vote-bar-generic').classList.toggle('hidden', hasChoices);
  document.getElementById('vote-bars-detail').classList.toggle('hidden', !hasChoices);
  if (hasChoices) renderChoiceBars(currentChoices);

  resetVoteDisplay();
  toast('Question affichée ▶');
}

function revealAnswer() {
  if (!sessionCode) return;
  socket.emit('question:reveal-answer', { code: sessionCode });
}

function nextQuestion() {
  if (!questions.length) return;
  const idx  = questions.findIndex(q => q.id === selectedQuestionId);
  const next = questions[idx + 1] || questions[0];
  selectQuestion(next.id);
  setTimeout(showQuestion, 50);
}

let buzzerWinnerId = null;

function validateBuzzer() {
  if (!buzzerWinnerId) return;
  socket.emit('admin:buzzer-result', { code: sessionCode, playerId: buzzerWinnerId, valid: true }, (res) => {
    if (res?.error) return toast(res.error, true);
    document.getElementById('buzzer-winner-card').classList.add('hidden');
    buzzerWinnerId = null;
  });
}

function invalidateBuzzer() {
  if (!buzzerWinnerId) return;
  socket.emit('admin:buzzer-result', { code: sessionCode, playerId: buzzerWinnerId, valid: false }, (res) => {
    if (res?.error) return toast(res.error, true);
    document.getElementById('buzzer-winner-card').classList.add('hidden');
    buzzerWinnerId = null;
    toast('Buzzer réinitialisé — à vos buzzers !');
  });
}

function resetGame() {
  if (!confirm('Réinitialiser la partie ? Les scores seront remis à zéro.')) return;
  socket.emit('admin:reset-game', { code: sessionCode }, (res) => {
    if (res?.error) return toast(res.error, true);
    toast('Partie réinitialisée ✓');
  });
}

async function importFromJson(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return toast('Fichier JSON invalide', true);
  }

  if (!Array.isArray(data.questions) || !data.questions.length) {
    return toast('JSON invalide : "questions" manquant ou vide', true);
  }

  const label = data.title ? `"${data.title}"` : file.name;
  if (!confirm(`Importer ${data.questions.length} question(s) depuis ${label} dans une nouvelle session ?`)) return;

  try {
    const res = await fetch('/api/sessions/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questions: data.questions }),
    });
    const result = await res.json();
    if (!res.ok) return toast(result.error || 'Erreur import', true);

    sessionCode = result.code;
    document.getElementById('session-code').textContent = sessionCode;
    localStorage.setItem('adminCode', sessionCode);

    socket.emit('session:join', { code: sessionCode, role: 'admin' }, (joinRes) => {
      if (joinRes?.error) return toast(joinRes.error, true);
      socket.emit('admin:get-questions', { code: sessionCode });
      toast(`✓ Session ${sessionCode} créée — ${result.questionCount} question(s) importée(s)`);
    });
  } catch {
    toast('Erreur réseau lors de l\'import', true);
  }
}

async function duplicateSession() {
  if (!sessionCode) return toast('Rejoignez ou créez une session', true);
  if (!questions.length) return toast('Aucune question à dupliquer', true);
  if (!confirm(`Dupliquer les ${questions.length} question(s) vers une nouvelle session ?`)) return;

  const fromCode = sessionCode;

  try {
    // 1. Créer la nouvelle session via REST (comme newSession())
    const res = await fetch('/api/sessions', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const newCode = data.code;
    console.log('[duplicate] nouvelle session créée :', newCode);

    // 2. Basculer IMMÉDIATEMENT (exactement comme newSession())
    sessionCode = newCode;
    document.getElementById('session-code').textContent = sessionCode;
    localStorage.setItem('adminCode', sessionCode);

    // 3. Rejoindre la nouvelle session via socket, puis copier les questions
    socket.emit('session:join', { code: sessionCode, role: 'admin' }, (joinRes) => {
      console.log('[duplicate] session:join ack :', joinRes);
      if (joinRes?.error) return toast(joinRes.error, true);

      socket.emit('admin:duplicate-questions', { fromCode, toCode: sessionCode }, (ack) => {
        console.log('[duplicate] admin:duplicate-questions ack :', ack);
        if (ack?.error) return toast(ack.error, true);

        // 4. Recharger la liste de questions maintenant copiées
        socket.emit('admin:get-questions', { code: sessionCode });
        toast(`✓ Session ${sessionCode} créée — ${ack.questionCount} question(s) dupliquée(s)`);
      });
    });
  } catch (e) {
    console.error('[duplicate] erreur :', e);
    toast('Erreur lors de la duplication', true);
  }
}

function endSession() {
  if (!confirm('Terminer la session ?')) return;
  socket.emit('session:end', { code: sessionCode });
  localStorage.removeItem('adminCode');
}

socket.on('game:reset', ({ players }) => {
  // Remettre l'UI admin dans l'état initial
  selectedQuestionId = null;
  answersRevealed    = false;
  allAnswers         = [];
  currentChoices     = [];

  document.getElementById('current-q-mode').textContent = '—';
  document.getElementById('current-q-text').textContent = 'Sélectionnez une question.';
  document.getElementById('admin-answer-hint').classList.add('hidden');
  document.getElementById('btn-show').disabled   = true;
  document.getElementById('btn-next').disabled   = true;
  document.getElementById('btn-answer').disabled = true;
  document.getElementById('buzzer-winner-card').classList.add('hidden');

  resetAnswersPanel();
  resetVoteDisplay();
  renderQuestions();

  // Mettre à jour le classement avec scores à 0
  players = players; // déjà géré par players:update émis depuis game:reset → players:update
});

// ─── Answers panel ────────────────────────────────────────────────────────────

function resetAnswersPanel() {
  allAnswers = [];
  document.getElementById('all-answers-list').innerHTML =
    '<div data-placeholder style="color:var(--muted);font-size:.83rem">En attente des réponses…</div>';
  document.getElementById('answers-count').textContent = '0';
  document.getElementById('cash-answers-section').classList.add('hidden');
  document.getElementById('cash-answers-list').innerHTML = '';
  document.getElementById('correct-answer-banner').classList.add('hidden');
  document.getElementById('correct-answer-display').innerHTML = '';
}

// Reset triggered by server when new question starts
socket.on('answers:reset', ({ choices }) => {
  currentChoices = choices;
  resetAnswersPanel();
  renderAdminAnswerHint(); // rafraîchir avec les choices serveur (is_correct fiable)
  // Show cash section for normal questions
  const q = questions.find(q => q.id === selectedQuestionId);
  if (q?.mode !== 'buzzer') {
    document.getElementById('cash-answers-section').classList.remove('hidden');
  }
});

// Toutes les réponses arrivent via answer:new (duo, carré ET cash)
socket.on('answer:new', ({ playerName, playerId, choiceId, choiceLabel, playerMode, text }) => {
  // Éviter les doublons
  if (allAnswers.find(a => a.playerId === playerId)) return;
  allAnswers.push({ playerName, playerId, choiceId, choiceLabel, playerMode, text });

  // Retirer le placeholder
  const list = document.getElementById('all-answers-list');
  const placeholder = list.querySelector('[data-placeholder]');
  if (placeholder) placeholder.remove();

  document.getElementById('answers-count').textContent = allAnswers.length;

  // Ligne dans le panneau principal (tous modes)
  const modeLabel = { duo: 'Duo', carre: 'Carré', cash: 'Cash' }[playerMode] || playerMode;
  const answerText = playerMode === 'cash' ? (text || '—') : (choiceLabel || '—');
  const pendingMark = playerMode === 'cash' ? '⏳' : '';

  const row = document.createElement('div');
  row.className = 'answer-row';
  row.id = `ar-${playerId}`;
  row.innerHTML = `
    <span class="ar-name">${playerName}</span>
    <span class="ar-mode ${playerMode}">${modeLabel}</span>
    <span class="ar-answer">${answerText}</span>
    <span class="ar-result" id="ar-result-${playerId}">${pendingMark}</span>
  `;
  list.appendChild(row);

  // Panneau de validation Cash
  if (playerMode === 'cash') {
    const cashList = document.getElementById('cash-answers-list');
    const rowId = `cash-${playerId}`;
    if (!document.getElementById(rowId)) {
      const cashRow = document.createElement('div');
      cashRow.className = 'cash-row';
      cashRow.id = rowId;
      cashRow.innerHTML = `
        <span class="cash-player">${playerName}</span>
        <span class="cash-text">${text}</span>
        <div class="cash-btns">
          <button class="btn btn-green" onclick="validateCash(${playerId}, '${rowId}')">✓ +5pts</button>
          <button class="btn btn-outline" onclick="invalidateCash('${rowId}', ${playerId})">✗</button>
        </div>
      `;
      cashList.appendChild(cashRow);
    }
  }
});

// Answer revealed — update rows + show correct answer
socket.on('question:answer-revealed', ({ correctChoiceIds, allChoices }) => {
  answersRevealed = true;
  toast('✓ Réponse révélée — scores mis à jour');

  // Show correct answer banner
  const correctChoices = allChoices.filter(c => correctChoiceIds.includes(c.id));
  const banner = document.getElementById('correct-answer-banner');
  const display = document.getElementById('correct-answer-display');
  banner.classList.remove('hidden');
  display.innerHTML = correctChoices.map((c, i) => {
    const letter = LETTERS[allChoices.findIndex(x => x.id === c.id)] || '?';
    return `
      <div class="correct-choice-chip">
        <span class="chip-letter">${letter}</span>
        ${c.label}
      </div>
    `;
  }).join('');

  // Mark each answer row as correct/wrong
  allAnswers.forEach(ans => {
    if (ans.playerMode === 'cash') return;
    const resultEl = document.getElementById(`ar-result-${ans.playerId}`);
    const rowEl    = document.getElementById(`ar-${ans.playerId}`);
    const isCorrect = correctChoiceIds.includes(ans.choiceId);
    if (resultEl) resultEl.textContent = isCorrect ? '✓' : '✗';
    if (rowEl)    rowEl.classList.add(isCorrect ? 'correct' : 'wrong');
  });
});

function validateCash(playerId, rowId) {
  socket.emit('admin:cash-result', { code: sessionCode, playerId, valid: true }, (res) => {
    if (res?.error) return toast(res.error, true);

    const row = document.getElementById(rowId);
    if (row) {
      row.classList.add('validated');
      const btns = row.querySelector('.cash-btns');
      if (btns) btns.innerHTML = '<span style="color:var(--green);font-size:.75rem;font-weight:700">✓ +5pts</span>';
    }
    const ar    = document.getElementById(`ar-result-${playerId}`);
    const arRow = document.getElementById(`ar-${playerId}`);
    if (ar)    ar.textContent = '✓';
    if (arRow) arRow.classList.add('correct');
  });
}

function invalidateCash(rowId, playerId) {
  socket.emit('admin:cash-result', { code: sessionCode, playerId, valid: false }, (res) => {
    if (res?.error) return toast(res.error, true);

    const row = document.getElementById(rowId);
    if (row) {
      row.classList.add('invalidated');
      const btns = row.querySelector('.cash-btns');
      if (btns) btns.innerHTML = '<span style="color:var(--muted);font-size:.75rem">✗</span>';
    }
    const ar    = document.getElementById(`ar-result-${playerId}`);
    const arRow = document.getElementById(`ar-${playerId}`);
    if (ar)    ar.textContent = '✗';
    if (arRow) arRow.classList.add('wrong');
  });
}

// ─── Vote display ─────────────────────────────────────────────────────────────

function resetVoteDisplay() {
  document.getElementById('vote-count').textContent       = '0';
  document.getElementById('vote-total-label').textContent = players.length;
  document.getElementById('votes-fill-generic').style.width = '0%';
  document.querySelectorAll('.vbar-fill').forEach(b => b.style.width = '0%');
  document.querySelectorAll('.vbar-count').forEach(n => n.textContent = '0');
}

socket.on('votes:update', ({ count, total, perChoice }) => {
  document.getElementById('vote-count').textContent       = count;
  document.getElementById('vote-total-label').textContent = total;
  const pct = total ? Math.min(100, Math.round(count / total * 100)) : 0;
  document.getElementById('votes-fill-generic').style.width = pct + '%';

  if (perChoice) {
    for (const [id, cnt] of Object.entries(perChoice)) {
      const bar = document.getElementById(`vbar-${id}`);
      const num = document.getElementById(`vnum-${id}`);
      if (bar) bar.style.width = count ? Math.round(cnt / count * 100) + '%' : '0%';
      if (num) num.textContent = cnt;
    }
  }
});

function renderChoiceBars(choices) {
  const el = document.getElementById('vote-bars-detail');
  el.innerHTML = choices.map((c, i) => `
    <div class="vote-row">
      <div class="vote-letter ${COLOR_CLASSES[i]}">${LETTERS[i]}</div>
      <div class="vbar-wrap"><div class="vbar-fill ${COLOR_CLASSES[i]}" id="vbar-${c.id}" style="width:0%"></div></div>
      <div class="vbar-count" id="vnum-${c.id}">0</div>
    </div>
  `).join('');
}

// ─── Buzzer ───────────────────────────────────────────────────────────────────

socket.on('buzzer:winner', ({ playerName, playerId }) => {
  buzzerWinnerId = playerId;
  document.getElementById('buzzer-winner-name').textContent = playerName;
  document.getElementById('buzzer-winner-card').classList.remove('hidden');
});

// ─── Players ──────────────────────────────────────────────────────────────────

socket.on('players:update', (list) => {
  players = list;

  ['q', 'g'].forEach(suffix => {
    const countEl = document.getElementById(`player-count-${suffix}`);
    if (countEl) countEl.textContent = list.length;
    const el = document.getElementById(`player-list-${suffix}`);
    if (!el) return;
    el.innerHTML = !list.length
      ? '<div style="color:var(--muted);font-size:.83rem">En attente…</div>'
      : list.map((p, i) => `
          <div class="player-row">
            <span class="player-rank">${i + 1}</span>
            <span class="player-name">${p.name}</span>
            <span class="player-score">${p.score}</span>
            <div class="score-btns">
              <button class="plus"  onclick="scoreUpdate(${p.id},  1)">+</button>
              <button class="minus" onclick="scoreUpdate(${p.id}, -1)">−</button>
            </div>
          </div>
        `).join('');
  });

  document.getElementById('vote-total-label').textContent = list.length;
});

function scoreUpdate(playerId, delta) {
  socket.emit('admin:score-update', { code: sessionCode, playerId, delta });
}

socket.on('session:end', () => toast('Session terminée'));

// ─── Toast ────────────────────────────────────────────────────────────────────

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = isError ? 'error' : '';
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 2500);
}
