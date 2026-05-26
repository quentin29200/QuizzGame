const socket = io();

const LETTERS      = ['A', 'B', 'C', 'D'];
const COLOR_CLASSES = ['ca', 'cb', 'cc', 'cd'];

let sessionCode        = null;
let sessionType        = 'quiz';
let selectedMode       = 'normal';
let selectedQuestionId = null;
let editingQuestionId  = null;
let questions          = [];
let players            = [];
let choiceCount        = 0;
let currentChoices     = [];
let allAnswers         = [];
let answersRevealed    = false;
let timerDuration      = 0;
let timerInterval      = null;

// Blind Test state
let songs              = [];
let selectedSongId     = null;
let editingSongId      = null;
let btWinnerId         = null;

// -- Tabs ----------------------------------------------------------------------

function switchTab(tab) {
  ['questions', 'songs', 'game'].forEach(t => {
    document.getElementById('tab-' + t)?.classList.toggle('hidden', t !== tab);
  });
  document.getElementById('tab-btn-questions')?.classList.toggle('active', tab === 'questions');
  document.getElementById('tab-btn-songs')?.classList.toggle('active',     tab === 'songs');
  document.getElementById('tab-btn-game')?.classList.toggle('active',      tab === 'game');
}

// -- Session -------------------------------------------------------------------

async function joinExisting() {
  const input = document.getElementById('join-code-input');
  const code  = input.value.trim().toUpperCase();
  if (code.length !== 4) return toast('Code a 4 lettres requis', true);
  const res = await fetch('/api/sessions/' + code);
  if (!res.ok) return toast('Session introuvable', true);
  const data = await res.json();
  sessionCode = code;
  sessionType = data.type || 'quiz';
  document.getElementById('session-code').textContent = code;
  localStorage.setItem('adminCode', code);
  input.value = '';
  applySessionType();
  connectSocket();
  toast('Session ' + code + ' chargee (' + (sessionType === 'blindtest' ? 'Blind Test' : 'Quizz') + ')');
}

function switchMode(mode) {
  if (mode === sessionType && sessionCode) return;
  sessionType = mode;
  sessionCode = null;
  questions   = [];
  songs       = [];
  players     = [];
  document.getElementById('session-code').textContent = '——';
  document.getElementById('session-code').className   = mode === 'blindtest' ? 'header-code bt' : 'header-code';
  localStorage.removeItem('adminCode');
  document.getElementById('mode-quiz-btn').classList.toggle('active', mode === 'quiz');
  document.getElementById('mode-bt-btn').classList.toggle('active',   mode === 'blindtest');
  applySessionType();
  renderQuestions();
  renderSongs();
  ['q', 'g', 'bt'].forEach(function(s) {
    const el = document.getElementById('player-list-' + s);
    if (el) el.innerHTML = '<div style="color:var(--muted);font-size:.83rem">En attente...</div>';
    const ct = document.getElementById('player-count-' + s);
    if (ct) ct.textContent = '0';
  });
}

async function newSessionForMode() {
  const url  = sessionType === 'blindtest' ? '/api/sessions/blindtest' : '/api/sessions';
  const res  = await fetch(url, { method: 'POST' });
  const data = await res.json();
  sessionCode = data.code;
  document.getElementById('session-code').textContent = sessionCode;
  document.getElementById('session-code').className   = sessionType === 'blindtest' ? 'header-code bt' : 'header-code';
  localStorage.setItem('adminCode', sessionCode);
  applySessionType();
  connectSocket();
  const label = sessionType === 'blindtest' ? ('Blind Test ' + sessionCode + ' cree') : ('Session ' + sessionCode + ' creee');
  toast(label);
}

function applySessionType() {
  const isBT = sessionType === 'blindtest';
  document.getElementById('mode-quiz-btn')?.classList.toggle('active', !isBT);
  document.getElementById('mode-bt-btn')?.classList.toggle('active',    isBT);
  document.getElementById('tab-btn-questions')?.classList.toggle('hidden',  isBT);
  document.getElementById('tab-btn-songs')?.classList.toggle('hidden',     !isBT);
  document.getElementById('quiz-nav-section')?.classList.toggle('hidden',     isBT);
  document.getElementById('bt-nav-section')?.classList.toggle('hidden',      !isBT);
  document.getElementById('quiz-actions-section')?.classList.toggle('hidden',  isBT);
  document.getElementById('bt-actions-section')?.classList.toggle('hidden',   !isBT);
  document.getElementById('quiz-right-col')?.classList.toggle('hidden',  isBT);
  document.getElementById('bt-right-col')?.classList.toggle('hidden',   !isBT);
  document.getElementById('session-code').className = isBT ? 'header-code bt' : 'header-code';
  document.getElementById('current-q-mode').textContent = '—';
  document.getElementById('current-q-text').textContent = isBT
    ? 'Selectionnez une chanson.'
    : 'Selectionnez une question.';
  switchTab(isBT ? 'songs' : 'questions');
}

function connectSocket() {
  socket.emit('session:join', { code: sessionCode, role: 'admin' }, function(res) {
    if (res?.error) return toast(res.error, true);
    if (sessionType === 'blindtest') {
      socket.emit('bt:get-songs', { code: sessionCode });
    } else {
      socket.emit('admin:get-questions', { code: sessionCode });
    }
  });
}

window.addEventListener('DOMContentLoaded', async function() {
  const saved = localStorage.getItem('adminCode');
  if (saved) {
    const res = await fetch('/api/sessions/' + saved);
    if (res.ok) {
      const data = await res.json();
      sessionCode = saved;
      sessionType = data.type || 'quiz';
      document.getElementById('session-code').textContent = sessionCode;
      applySessionType();
      if (socket.connected) connectSocket();
    }
  }
  initChoicesGrid();
  const savedTimer = parseInt(localStorage.getItem('timerDuration')) || 0;
  timerDuration = savedTimer;
  document.getElementById('timer-input').value = savedTimer;
});

socket.on('connect', function() {
  document.getElementById('dot').classList.add('on');
  if (sessionCode) connectSocket();
});
socket.on('disconnect', function() { document.getElementById('dot').classList.remove('on'); });
setInterval(function() { if (sessionCode) localStorage.setItem('adminCode', sessionCode); }, 3000);

// -- Mode pills ----------------------------------------------------------------

document.querySelectorAll('.mode-pill').forEach(function(btn) {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.mode-pill').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
    selectedMode = btn.dataset.mode;
    document.getElementById('choices-section').classList.toggle('hidden', selectedMode === 'buzzer');
    document.getElementById('buzzer-answer-section').classList.toggle('hidden', selectedMode !== 'buzzer');
  });
});

// -- Choices form --------------------------------------------------------------

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
  row.innerHTML = '<input type="checkbox" id="correct-' + i + '" title="Correcte"><input type="text" id="choice-' + i + '" placeholder="Proposition ' + (i + 1) + '">';
  grid.appendChild(row);
}

function getChoices() {
  return Array.from(document.querySelectorAll('#choices-grid .choice-row'))
    .map(function(row) {
      return {
        label: row.querySelector('input[type="text"]').value.trim(),
        isCorrect: row.querySelector('input[type="checkbox"]').checked,
      };
    })
    .filter(function(c) { return c.label; });
}

// -- Save / Edit question ------------------------------------------------------

function saveQuestion() {
  if (!sessionCode) return toast('Rejoignez ou creez une session', true);
  const text = document.getElementById('q-text').value.trim();
  if (!text) return toast('Texte de question requis', true);
  const choices = selectedMode === 'buzzer' ? [] : getChoices();
  const answer  = selectedMode === 'buzzer' ? document.getElementById('buzzer-answer').value.trim() : undefined;
  if (selectedMode === 'normal' && choices.length < 2) return toast('Ajoutez au moins 2 propositions', true);
  if (selectedMode === 'normal' && !choices.some(function(c) { return c.isCorrect; })) return toast('Cochez la bonne reponse', true);

  if (editingQuestionId) {
    socket.emit('admin:edit-question', { code: sessionCode, questionId: editingQuestionId, text: text, mode: selectedMode, choices: choices, answer: answer }, function(res) {
      if (res?.error) return toast(res.error, true);
      toast('Question mise a jour');
      cancelEdit();
    });
  } else {
    socket.emit('admin:create-question', { code: sessionCode, text: text, mode: selectedMode, choices: choices, answer: answer }, function(res) {
      if (res?.error) return toast(res.error, true);
      toast('Question enregistree');
      document.getElementById('q-text').value = '';
      document.getElementById('buzzer-answer').value = '';
      initChoicesGrid();
      socket.emit('admin:get-questions', { code: sessionCode });
    });
  }
}

function editQuestion(id) {
  const q = questions.find(function(q) { return q.id === id; });
  if (!q) return;

  editingQuestionId = id;
  document.getElementById('q-text').value = q.text;
  selectedMode = q.mode;
  document.querySelectorAll('.mode-pill').forEach(function(b) {
    b.classList.toggle('active', b.dataset.mode === q.mode);
  });
  document.getElementById('choices-section').classList.toggle('hidden', q.mode === 'buzzer');
  document.getElementById('buzzer-answer-section').classList.toggle('hidden', q.mode !== 'buzzer');

  if (q.mode === 'buzzer') {
    const buzzerAnswer = q.choices?.find(function(c) { return c.is_correct === 1 || c.is_correct === true; });
    document.getElementById('buzzer-answer').value = buzzerAnswer?.label || '';
  } else if (q.choices?.length) {
    const grid = document.getElementById('choices-grid');
    grid.innerHTML = '';
    choiceCount = 0;
    q.choices.forEach(function(c, i) {
      addChoice(i);
      document.getElementById('choice-' + i).value = c.label;
      document.getElementById('correct-' + i).checked = c.is_correct === 1 || c.is_correct === true;
    });
    for (let i = q.choices.length; i < 4; i++) addChoice(i);
  } else {
    initChoicesGrid();
  }

  document.getElementById('edit-mode-banner').classList.remove('hidden');
  document.getElementById('edit-mode-label').textContent = 'Edition de la question #' + (questions.findIndex(function(x) { return x.id === id; }) + 1);
  document.getElementById('form-section-label').textContent = 'Modifier la question';
  document.getElementById('save-btn').textContent = 'Mettre a jour';
  renderQuestions();
  document.getElementById('q-text').focus();
}

function cancelEdit() {
  editingQuestionId = null;
  document.getElementById('q-text').value = '';
  selectedMode = 'normal';
  document.querySelectorAll('.mode-pill').forEach(function(b, i) { b.classList.toggle('active', i === 0); });
  document.getElementById('choices-section').classList.remove('hidden');
  document.getElementById('buzzer-answer-section').classList.add('hidden');
  document.getElementById('buzzer-answer').value = '';
  initChoicesGrid();
  document.getElementById('edit-mode-banner').classList.add('hidden');
  document.getElementById('form-section-label').textContent = 'Nouvelle question';
  document.getElementById('save-btn').textContent = 'Enregistrer la question';
  renderQuestions();
}

// -- Questions list ------------------------------------------------------------

socket.on('questions:list', function(list) {
  questions = list;
  renderQuestions();
});

function renderQuestions() {
  document.getElementById('q-count').textContent = questions.length;

  const render = function(elId, clickable, editable) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!questions.length) { el.innerHTML = '<div style="color:var(--muted);font-size:.83rem">Aucune question.</div>'; return; }
    el.innerHTML = questions.map(function(q, i) {
      return '<div class="q-item ' + (q.id === selectedQuestionId ? 'active' : '') + ' ' + (q.id === editingQuestionId ? 'active' : '') + '"' +
        (clickable ? ' onclick="selectQuestion(' + q.id + ')"' : '') + '>' +
        '<div class="q-dot ' + q.mode + '"></div>' +
        '<span class="q-text">' + q.text + '</span>' +
        '<span class="q-num">#' + (i + 1) + '</span>' +
        (editable ? '<button class="q-edit-btn" onclick="event.stopPropagation();editQuestion(' + q.id + ')">edit</button>' : '') +
        '</div>';
    }).join('');
  };

  render('q-list',      false, true);
  render('q-list-game', true,  false);
}

function selectQuestion(id) {
  selectedQuestionId = id;
  answersRevealed    = false;
  renderQuestions();

  const q = questions.find(function(q) { return q.id === id; });
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

function renderAdminAnswerHint() {
  const hint  = document.getElementById('admin-answer-hint');
  const chips = document.getElementById('admin-answer-chips');
  const q = questions.find(function(q) { return q.id === selectedQuestionId; });

  if (!q || q.mode === 'buzzer' || !currentChoices.length) {
    hint.classList.add('hidden');
    chips.innerHTML = '';
    return;
  }

  const correct = currentChoices.filter(function(c) { return c.is_correct === 1 || c.is_correct === true; });
  if (!correct.length) { hint.classList.add('hidden'); return; }

  hint.classList.remove('hidden');
  chips.innerHTML = correct.map(function(c) {
    const idx    = currentChoices.findIndex(function(x) { return x.id === c.id; });
    const letter = LETTERS[idx] ?? '?';
    return '<span class="admin-answer-chip">' + letter + ' — ' + c.label + '</span>';
  }).join('');
}

// -- Controls ------------------------------------------------------------------

function saveTimerSetting() {
  timerDuration = parseInt(document.getElementById('timer-input').value) || 0;
  localStorage.setItem('timerDuration', timerDuration);
}

// -- Timer admin ---------------------------------------------------------------

function startAdminTimer(duration, startedAt) {
  clearInterval(timerInterval);
  const wrap = document.getElementById('admin-timer');
  const bar  = document.getElementById('admin-timer-bar');
  const txt  = document.getElementById('admin-timer-text');
  if (!duration) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');

  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  let remaining = Math.max(0, duration - elapsed);

  const update = function() {
    const pct = Math.max(0, remaining / duration * 100);
    bar.style.width = pct + '%';
    const color = pct > 50 ? 'var(--green)' : pct > 25 ? 'var(--yellow)' : 'var(--red)';
    bar.style.background = color;
    txt.style.color = color;
    txt.textContent = remaining + 's';
  };
  update();
  if (remaining <= 0) return;
  timerInterval = setInterval(function() {
    remaining = Math.max(0, remaining - 1);
    update();
    if (remaining <= 0) clearInterval(timerInterval);
  }, 1000);
}

function stopAdminTimer() {
  clearInterval(timerInterval);
  document.getElementById('admin-timer').classList.add('hidden');
}

function showQuestion() {
  if (!selectedQuestionId || !sessionCode) return;
  const q = questions.find(function(q) { return q.id === selectedQuestionId; });

  socket.emit('question:show', { code: sessionCode, questionId: selectedQuestionId, timerDuration: timerDuration });

  document.getElementById('btn-answer').disabled = false;
  document.getElementById('buzzer-winner-card').classList.add('hidden');
  answersRevealed = false;

  const hasChoices = q?.mode === 'normal';
  document.getElementById('vote-bar-generic').classList.toggle('hidden', hasChoices);
  document.getElementById('vote-bars-detail').classList.toggle('hidden', !hasChoices);
  if (hasChoices) renderChoiceBars(currentChoices);

  resetVoteDisplay();
  startAdminTimer(timerDuration, Date.now());
  toast('Question affichee');
}

function revealAnswer() {
  if (!sessionCode) return;
  stopAdminTimer();
  socket.emit('question:reveal-answer', { code: sessionCode });
}

function nextQuestion() {
  if (!questions.length) return;
  const idx  = questions.findIndex(function(q) { return q.id === selectedQuestionId; });
  const next = questions[idx + 1] || questions[0];
  selectQuestion(next.id);
  setTimeout(showQuestion, 50);
}

let buzzerWinnerId = null;

function validateBuzzer() {
  if (!buzzerWinnerId) return;
  socket.emit('admin:buzzer-result', { code: sessionCode, playerId: buzzerWinnerId, valid: true }, function(res) {
    if (res?.error) return toast(res.error, true);
    document.getElementById('buzzer-winner-card').classList.add('hidden');
    buzzerWinnerId = null;
  });
}

function invalidateBuzzer() {
  if (!buzzerWinnerId) return;
  socket.emit('admin:buzzer-result', { code: sessionCode, playerId: buzzerWinnerId, valid: false }, function(res) {
    if (res?.error) return toast(res.error, true);
    document.getElementById('buzzer-winner-card').classList.add('hidden');
    buzzerWinnerId = null;
    toast('Buzzer reinitialise — a vos buzzers !');
  });
}

function resetGame() {
  if (!confirm('Reinitialiser la partie ? Les scores seront remis a zero.')) return;
  socket.emit('admin:reset-game', { code: sessionCode }, function(res) {
    if (res?.error) return toast(res.error, true);
    toast('Partie reinitialisee');
  });
}

async function importFromJson(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { return toast('Fichier JSON invalide', true); }
  if (sessionType === 'blindtest') {
    await importBTFromJson(data, file.name);
  } else {
    await importQuizFromJson(data, file.name);
  }
}

async function importQuizFromJson(data, fileName) {
  if (!Array.isArray(data.questions) || !data.questions.length)
    return toast('JSON invalide : "questions" manquant ou vide', true);
  const label = data.title ? ('"' + data.title + '"') : fileName;
  if (!confirm('Importer ' + data.questions.length + ' question(s) depuis ' + label + ' dans une nouvelle session ?')) return;
  try {
    const res = await fetch('/api/sessions/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questions: data.questions }),
    });
    const result = await res.json();
    if (!res.ok) return toast(result.error || 'Erreur import', true);
    sessionCode = result.code;
    sessionType = 'quiz';
    document.getElementById('session-code').textContent = sessionCode;
    document.getElementById('session-code').className   = 'header-code';
    localStorage.setItem('adminCode', sessionCode);
    socket.emit('session:join', { code: sessionCode, role: 'admin' }, function(joinRes) {
      if (joinRes?.error) return toast(joinRes.error, true);
      socket.emit('admin:get-questions', { code: sessionCode });
      toast('Session ' + sessionCode + ' creee — ' + result.questionCount + ' question(s) importee(s)');
    });
  } catch { toast("Erreur reseau lors de l'import", true); }
}

async function importBTFromJson(data, fileName) {
  if (!Array.isArray(data.songs) || !data.songs.length)
    return toast('JSON invalide : "songs" manquant ou vide', true);
  const label = data.title ? ('"' + data.title + '"') : fileName;
  if (!confirm('Importer ' + data.songs.length + ' chanson(s) depuis ' + label + ' dans une nouvelle session Blind Test ?')) return;
  try {
    const res = await fetch('/api/sessions/blindtest/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ songs: data.songs }),
    });
    const result = await res.json();
    if (!res.ok) return toast(result.error || 'Erreur import', true);
    sessionCode = result.code;
    sessionType = 'blindtest';
    document.getElementById('session-code').textContent = sessionCode;
    document.getElementById('session-code').className   = 'header-code bt';
    localStorage.setItem('adminCode', sessionCode);
    applySessionType();
    socket.emit('session:join', { code: sessionCode, role: 'admin' }, function(joinRes) {
      if (joinRes?.error) return toast(joinRes.error, true);
      socket.emit('bt:get-songs', { code: sessionCode });
      toast('Session ' + sessionCode + ' creee — ' + result.songCount + ' chanson(s) importee(s)');
    });
  } catch { toast("Erreur reseau lors de l'import", true); }
}

async function duplicateForMode() {
  if (sessionType === 'blindtest') {
    await duplicateBTSession();
  } else {
    await duplicateQuizSession();
  }
}

async function duplicateQuizSession() {
  if (!sessionCode) return toast('Rejoignez ou creez une session', true);
  if (!questions.length) return toast('Aucune question a dupliquer', true);
  if (!confirm('Dupliquer les ' + questions.length + ' question(s) vers une nouvelle session ?')) return;

  const fromCode = sessionCode;
  try {
    const res = await fetch('/api/sessions', { method: 'POST' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    sessionCode = data.code;
    document.getElementById('session-code').textContent = sessionCode;
    localStorage.setItem('adminCode', sessionCode);
    socket.emit('session:join', { code: sessionCode, role: 'admin' }, function(joinRes) {
      if (joinRes?.error) return toast(joinRes.error, true);
      socket.emit('admin:duplicate-questions', { fromCode: fromCode, toCode: sessionCode }, function(ack) {
        if (ack?.error) return toast(ack.error, true);
        socket.emit('admin:get-questions', { code: sessionCode });
        toast('Session ' + sessionCode + ' creee — ' + ack.questionCount + ' question(s) dupliquee(s)');
      });
    });
  } catch (e) {
    toast('Erreur lors de la duplication', true);
  }
}

async function duplicateBTSession() {
  if (!sessionCode) return toast('Rejoignez ou creez une session Blind Test', true);
  if (!songs.length) return toast('Aucune chanson a dupliquer', true);
  if (!confirm('Dupliquer les ' + songs.length + ' chanson(s) vers une nouvelle session Blind Test ?')) return;

  const fromCode = sessionCode;
  try {
    const res = await fetch('/api/sessions/blindtest', { method: 'POST' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    sessionCode = data.code;
    document.getElementById('session-code').textContent = sessionCode;
    document.getElementById('session-code').className   = 'header-code bt';
    localStorage.setItem('adminCode', sessionCode);
    socket.emit('session:join', { code: sessionCode, role: 'admin' }, function(joinRes) {
      if (joinRes?.error) return toast(joinRes.error, true);
      socket.emit('bt:duplicate-songs', { fromCode: fromCode, toCode: sessionCode }, function(ack) {
        if (ack?.error) return toast(ack.error, true);
        socket.emit('bt:get-songs', { code: sessionCode });
        toast('Session ' + sessionCode + ' creee — ' + ack.songCount + ' chanson(s) dupliquee(s)');
      });
    });
  } catch (e) {
    toast('Erreur lors de la duplication', true);
  }
}

function endSession() {
  if (!confirm('Terminer la session ?')) return;
  socket.emit('session:end', { code: sessionCode });
  localStorage.removeItem('adminCode');
}

socket.on('game:reset', function(data) {
  selectedQuestionId = null;
  answersRevealed    = false;
  allAnswers         = [];
  currentChoices     = [];
  stopAdminTimer();

  document.getElementById('current-q-mode').textContent = '—';
  document.getElementById('current-q-text').textContent = 'Selectionnez une question.';
  document.getElementById('admin-answer-hint').classList.add('hidden');
  document.getElementById('btn-show').disabled   = true;
  document.getElementById('btn-next').disabled   = true;
  document.getElementById('btn-answer').disabled = true;
  document.getElementById('buzzer-winner-card').classList.add('hidden');

  resetAnswersPanel();
  resetVoteDisplay();
  renderQuestions();
});

// -- Answers panel -------------------------------------------------------------

function resetAnswersPanel() {
  allAnswers = [];
  document.getElementById('all-answers-list').innerHTML =
    '<div data-placeholder style="color:var(--muted);font-size:.83rem">En attente des reponses...</div>';
  document.getElementById('answers-count').textContent = '0';
  document.getElementById('cash-answers-section').classList.add('hidden');
  document.getElementById('cash-answers-list').innerHTML = '';
  document.getElementById('correct-answer-banner').classList.add('hidden');
  document.getElementById('correct-answer-display').innerHTML = '';
}

socket.on('answers:reset', function(data) {
  currentChoices = data.choices;
  resetAnswersPanel();
  renderAdminAnswerHint();
  const q = questions.find(function(q) { return q.id === selectedQuestionId; });
  if (q?.mode !== 'buzzer') {
    document.getElementById('cash-answers-section').classList.remove('hidden');
  }
});

socket.on('answer:new', function(data) {
  const { playerName, playerId, choiceId, choiceLabel, playerMode, text } = data;
  if (allAnswers.find(function(a) { return a.playerId === playerId; })) return;
  allAnswers.push({ playerName: playerName, playerId: playerId, choiceId: choiceId, choiceLabel: choiceLabel, playerMode: playerMode, text: text });

  const list = document.getElementById('all-answers-list');
  const placeholder = list.querySelector('[data-placeholder]');
  if (placeholder) placeholder.remove();

  document.getElementById('answers-count').textContent = allAnswers.length;

  const modeLabel = { duo: 'Duo', carre: 'Carre', cash: 'Cash' }[playerMode] || playerMode;
  const answerText = playerMode === 'cash' ? (text || '—') : (choiceLabel || '—');
  const pendingMark = playerMode === 'cash' ? '...' : '';

  const row = document.createElement('div');
  row.className = 'answer-row';
  row.id = 'ar-' + playerId;
  row.innerHTML =
    '<span class="ar-name">' + playerName + '</span>' +
    '<span class="ar-mode ' + playerMode + '">' + modeLabel + '</span>' +
    '<span class="ar-answer">' + answerText + '</span>' +
    '<span class="ar-result" id="ar-result-' + playerId + '">' + pendingMark + '</span>';
  list.appendChild(row);

  if (playerMode === 'cash') {
    const cashList = document.getElementById('cash-answers-list');
    const rowId = 'cash-' + playerId;
    if (!document.getElementById(rowId)) {
      const cashRow = document.createElement('div');
      cashRow.className = 'cash-row';
      cashRow.id = rowId;
      cashRow.innerHTML =
        '<span class="cash-player">' + playerName + '</span>' +
        '<span class="cash-text">' + text + '</span>' +
        '<div class="cash-btns">' +
        '<button class="btn btn-green" onclick="validateCash(' + playerId + ', \'' + rowId + '\')">+5pts</button>' +
        '<button class="btn btn-outline" onclick="invalidateCash(\'' + rowId + '\', ' + playerId + ')">X</button>' +
        '</div>';
      cashList.appendChild(cashRow);
    }
  }
});

socket.on('question:answer-revealed', function(data) {
  const { correctChoiceIds, allChoices } = data;
  answersRevealed = true;
  toast('Reponse revelee — scores mis a jour');

  const correctChoices = allChoices.filter(function(c) { return correctChoiceIds.includes(c.id); });
  const banner = document.getElementById('correct-answer-banner');
  const display = document.getElementById('correct-answer-display');
  banner.classList.remove('hidden');
  display.innerHTML = correctChoices.map(function(c) {
    const letter = LETTERS[allChoices.findIndex(function(x) { return x.id === c.id; })] || '?';
    return '<div class="correct-choice-chip"><span class="chip-letter">' + letter + '</span>' + c.label + '</div>';
  }).join('');

  allAnswers.forEach(function(ans) {
    if (ans.playerMode === 'cash') return;
    const resultEl = document.getElementById('ar-result-' + ans.playerId);
    const rowEl    = document.getElementById('ar-' + ans.playerId);
    const isCorrect = correctChoiceIds.includes(ans.choiceId);
    if (resultEl) resultEl.textContent = isCorrect ? 'OK' : 'X';
    if (rowEl)    rowEl.classList.add(isCorrect ? 'correct' : 'wrong');
  });
});

function validateCash(playerId, rowId) {
  socket.emit('admin:cash-result', { code: sessionCode, playerId: playerId, valid: true }, function(res) {
    if (res?.error) return toast(res.error, true);
    const row = document.getElementById(rowId);
    if (row) {
      row.classList.add('validated');
      const btns = row.querySelector('.cash-btns');
      if (btns) btns.innerHTML = '<span style="color:var(--green);font-size:.75rem;font-weight:700">+5pts</span>';
    }
    const ar    = document.getElementById('ar-result-' + playerId);
    const arRow = document.getElementById('ar-' + playerId);
    if (ar)    ar.textContent = 'OK';
    if (arRow) arRow.classList.add('correct');
  });
}

function invalidateCash(rowId, playerId) {
  socket.emit('admin:cash-result', { code: sessionCode, playerId: playerId, valid: false }, function(res) {
    if (res?.error) return toast(res.error, true);
    const row = document.getElementById(rowId);
    if (row) {
      row.classList.add('invalidated');
      const btns = row.querySelector('.cash-btns');
      if (btns) btns.innerHTML = '<span style="color:var(--muted);font-size:.75rem">X</span>';
    }
    const ar    = document.getElementById('ar-result-' + playerId);
    const arRow = document.getElementById('ar-' + playerId);
    if (ar)    ar.textContent = 'X';
    if (arRow) arRow.classList.add('wrong');
  });
}

// -- Vote display --------------------------------------------------------------

function resetVoteDisplay() {
  document.getElementById('vote-count').textContent       = '0';
  document.getElementById('vote-total-label').textContent = players.length;
  document.getElementById('votes-fill-generic').style.width = '0%';
  document.querySelectorAll('.vbar-fill').forEach(function(b) { b.style.width = '0%'; });
  document.querySelectorAll('.vbar-count').forEach(function(n) { n.textContent = '0'; });
}

socket.on('votes:update', function(data) {
  const { count, total, perChoice } = data;
  document.getElementById('vote-count').textContent       = count;
  document.getElementById('vote-total-label').textContent = total;
  const pct = total ? Math.min(100, Math.round(count / total * 100)) : 0;
  document.getElementById('votes-fill-generic').style.width = pct + '%';

  if (perChoice) {
    for (const [id, cnt] of Object.entries(perChoice)) {
      const bar = document.getElementById('vbar-' + id);
      const num = document.getElementById('vnum-' + id);
      if (bar) bar.style.width = count ? Math.round(cnt / count * 100) + '%' : '0%';
      if (num) num.textContent = cnt;
    }
  }
});

function renderChoiceBars(choices) {
  const el = document.getElementById('vote-bars-detail');
  el.innerHTML = choices.map(function(c, i) {
    return '<div class="vote-row">' +
      '<div class="vote-letter ' + COLOR_CLASSES[i] + '">' + LETTERS[i] + '</div>' +
      '<div class="vbar-wrap"><div class="vbar-fill ' + COLOR_CLASSES[i] + '" id="vbar-' + c.id + '" style="width:0%"></div></div>' +
      '<div class="vbar-count" id="vnum-' + c.id + '">0</div>' +
      '</div>';
  }).join('');
}

// -- Buzzer --------------------------------------------------------------------

socket.on('buzzer:winner', function(data) {
  buzzerWinnerId = data.playerId;
  document.getElementById('buzzer-winner-name').textContent = data.playerName;
  document.getElementById('buzzer-winner-card').classList.remove('hidden');
});

// -- Players -------------------------------------------------------------------

socket.on('players:update', function(list) {
  players = list;

  ['q', 'g', 'bt'].forEach(function(suffix) {
    const countEl = document.getElementById('player-count-' + suffix);
    if (countEl) countEl.textContent = list.length;
    const el = document.getElementById('player-list-' + suffix);
    if (!el) return;
    el.innerHTML = !list.length
      ? '<div style="color:var(--muted);font-size:.83rem">En attente...</div>'
      : list.map(function(p, i) {
          return '<div class="player-row">' +
            '<span class="player-rank">' + (i + 1) + '</span>' +
            '<span class="player-name">' + p.name + '</span>' +
            '<span class="player-score">' + p.score + '</span>' +
            '<div class="score-btns">' +
            '<button class="plus" onclick="scoreUpdate(' + p.id + ', 1)">+</button>' +
            '<button class="minus" onclick="scoreUpdate(' + p.id + ', -1)">-</button>' +
            '</div></div>';
        }).join('');
  });

  document.getElementById('vote-total-label').textContent = list.length;
});

function scoreUpdate(playerId, delta) {
  socket.emit('admin:score-update', { code: sessionCode, playerId: playerId, delta: delta });
}

socket.on('session:end', function() { toast('Session terminee'); });

// -- Blind Test: Songs CRUD ----------------------------------------------------

socket.on('bt:songs-list', function(list) {
  songs = list;
  renderSongs();
});

function renderSongs() {
  document.getElementById('song-count').textContent = songs.length;

  const renderList = function(elId, clickable) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!songs.length) {
      el.innerHTML = '<div style="color:var(--muted);font-size:.83rem">Aucune chanson.</div>';
      return;
    }
    el.innerHTML = songs.map(function(s, i) {
      return '<div class="song-item ' + (s.id === selectedSongId ? 'active' : '') + ' ' + (s.id === editingSongId ? 'active' : '') + '"' +
        (clickable ? ' onclick="btSelectSong(' + s.id + ')"' : '') + '>' +
        '<div class="song-dot"></div>' +
        '<div class="song-meta">' +
        '<div class="song-title-text">' + s.title + '</div>' +
        '<div class="song-artist-text">' + s.artist + '</div>' +
        '</div>' +
        '<span class="song-num">#' + (i + 1) + '</span>' +
        (!clickable ?
          '<button class="song-action-btn" onclick="event.stopPropagation();editSong(' + s.id + ')">edit</button>' +
          '<button class="song-action-btn del" onclick="event.stopPropagation();deleteSongItem(' + s.id + ')">del</button>'
          : '') +
        '</div>';
    }).join('');
  };

  renderList('song-list',      false);
  renderList('song-list-game', true);
}

function saveSong() {
  if (!sessionCode) return toast('Rejoignez ou creez une session Blind Test', true);
  const title  = document.getElementById('bt-title').value.trim();
  const artist = document.getElementById('bt-artist').value.trim();
  const yt     = document.getElementById('bt-youtube').value.trim();
  if (!title)  return toast('Titre requis', true);
  if (!artist) return toast('Artiste requis', true);

  if (editingSongId) {
    socket.emit('bt:update-song', { code: sessionCode, songId: editingSongId, title: title, artist: artist, youtubeUrl: yt }, function(res) {
      if (res?.error) return toast(res.error, true);
      toast('Chanson mise a jour');
      cancelEditSong();
    });
  } else {
    socket.emit('bt:add-song', { code: sessionCode, title: title, artist: artist, youtubeUrl: yt }, function(res) {
      if (res?.error) return toast(res.error, true);
      toast('Chanson enregistree');
      document.getElementById('bt-title').value   = '';
      document.getElementById('bt-artist').value  = '';
      document.getElementById('bt-youtube').value = '';
    });
  }
}

function editSong(id) {
  const s = songs.find(function(s) { return s.id === id; });
  if (!s) return;
  editingSongId = id;
  document.getElementById('bt-title').value   = s.title;
  document.getElementById('bt-artist').value  = s.artist;
  document.getElementById('bt-youtube').value = s.youtube_url || '';
  document.getElementById('bt-edit-banner').classList.remove('hidden');
  document.getElementById('bt-edit-label').textContent = 'Edition : ' + s.title;
  document.getElementById('bt-form-label').textContent = 'Modifier la chanson';
  document.getElementById('bt-save-btn').textContent   = 'Mettre a jour';
  renderSongs();
  document.getElementById('bt-title').focus();
}

function cancelEditSong() {
  editingSongId = null;
  document.getElementById('bt-title').value   = '';
  document.getElementById('bt-artist').value  = '';
  document.getElementById('bt-youtube').value = '';
  document.getElementById('bt-edit-banner').classList.add('hidden');
  document.getElementById('bt-form-label').textContent = 'Nouvelle chanson';
  document.getElementById('bt-save-btn').textContent   = 'Enregistrer la chanson';
  renderSongs();
}

function deleteSongItem(id) {
  const s = songs.find(function(s) { return s.id === id; });
  if (!confirm('Supprimer "' + s?.title + '" ?')) return;
  socket.emit('bt:delete-song', { code: sessionCode, songId: id }, function(res) {
    if (res?.error) return toast(res.error, true);
    toast('Chanson supprimee');
    if (editingSongId === id) cancelEditSong();
    if (selectedSongId === id) { selectedSongId = null; btResetGameUI(); }
  });
}

// -- Blind Test: Game controls -------------------------------------------------

function btSelectSong(id) {
  selectedSongId = id;
  renderSongs();
  const s = songs.find(function(s) { return s.id === id; });
  if (s) {
    document.getElementById('current-q-mode').textContent = 'Blind Test';
    document.getElementById('current-q-text').textContent = s.title + ' — ' + s.artist;
  }
  document.getElementById('bt-btn-show').disabled = false;
  document.getElementById('bt-btn-next').disabled = false;
  btResetGameUI();
}

function btShowSong() {
  if (!selectedSongId || !sessionCode) return;
  const s = songs.find(function(s) { return s.id === selectedSongId; });
  socket.emit('bt:song-show', { code: sessionCode, songId: selectedSongId });

  btLoadYoutube(s?.youtube_url);

  document.getElementById('bt-winner-card').classList.add('hidden');
  document.getElementById('bt-reveal-banner').classList.add('hidden');
  btWinnerId = null;
  toast('Chanson affichee');
}

function btNextSong() {
  if (!songs.length) return;
  const idx  = songs.findIndex(function(s) { return s.id === selectedSongId; });
  const next = songs[idx + 1] || songs[0];
  btSelectSong(next.id);
  setTimeout(btShowSong, 50);
}

function btValidate(valid) {
  if (!btWinnerId) return;
  socket.emit('bt:validate', { code: sessionCode, playerId: btWinnerId, valid: valid }, function(res) {
    if (res?.error) return toast(res.error, true);
    document.getElementById('bt-winner-card').classList.add('hidden');
    btWinnerId = null;
    if (!valid) toast('Buzzer reinitialise — a vos buzzers !');
  });
}

function btResetGameUI() {
  document.getElementById('bt-winner-card').classList.add('hidden');
  document.getElementById('bt-reveal-banner').classList.add('hidden');
  btWinnerId = null;
}

function btLoadYoutube(url) {
  const wrap  = document.getElementById('bt-yt-wrap');
  const frame = document.getElementById('bt-yt-iframe');
  const ph    = document.getElementById('bt-yt-placeholder');
  if (!url) {
    wrap.classList.add('hidden');
    ph.classList.remove('hidden');
    frame.src = '';
    return;
  }
  const vidMatch = url.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  const vid      = vidMatch ? vidMatch[1] : null;
  if (!vid) {
    wrap.classList.add('hidden');
    ph.classList.remove('hidden');
    return;
  }
  // Extract start time from ?start=, &start=, ?t=, &t=, or #t=
  // Supports plain seconds (938) or hms format (1h23m45s)
  const startMatch = url.match(/[?&#](?:start|t)=([0-9hms]+)/);
  let startSeconds = 0;
  if (startMatch) {
    const raw = startMatch[1];
    if (/^\d+$/.test(raw)) {
      startSeconds = parseInt(raw, 10);
    } else {
      const h = (raw.match(/(\d+)h/) || [0, 0])[1];
      const m = (raw.match(/(\d+)m/) || [0, 0])[1];
      const s = (raw.match(/(\d+)s/) || [0, 0])[1];
      startSeconds = parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s);
    }
  }
  const startParam = startSeconds > 0 ? ('&start=' + startSeconds) : '';
  frame.src = 'https://www.youtube.com/embed/' + vid + '?autoplay=1' + startParam;
  wrap.classList.remove('hidden');
  ph.classList.add('hidden');
}

socket.on('bt:winner', function(data) {
  btWinnerId = data.playerId;
  document.getElementById('bt-winner-name').textContent = data.playerName;
  document.getElementById('bt-winner-card').classList.remove('hidden');
});

socket.on('bt:validated', function(data) {
  document.getElementById('bt-reveal-title-text').textContent  = data.title;
  document.getElementById('bt-reveal-artist-text').textContent = data.artist;
  document.getElementById('bt-reveal-banner').classList.remove('hidden');
  toast('Revele : ' + data.title + ' — ' + data.artist);
});

socket.on('bt:reset', function() {
  document.getElementById('bt-winner-card').classList.add('hidden');
  btWinnerId = null;
});

// -- Toast ---------------------------------------------------------------------

function toast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = isError ? 'error' : '';
  clearTimeout(el._t);
  el._t = setTimeout(function() { el.classList.add('hidden'); }, 2500);
}
