const { getDb } = require('../src/db/schema');
const { getSessionByCode, insertQuestion, insertChoice } = require('../src/db/queries');

const CODE = process.argv[2];
if (!CODE) { console.error('Usage: node scripts/seed-questions.js <CODE>'); process.exit(1); }

const session = getSessionByCode(CODE.toUpperCase());
if (!session) { console.error(`Session "${CODE}" introuvable.`); process.exit(1); }

const questions = [
  {
    mode: 'normal',
    text: 'Quelle est la capitale de l\'Australie ?',
    choices: [
      { label: 'Sydney',    isCorrect: false },
      { label: 'Melbourne', isCorrect: false },
      { label: 'Canberra',  isCorrect: true  },
      { label: 'Brisbane',  isCorrect: false },
    ],
  },
  {
    mode: 'normal',
    text: 'Combien de planètes composent notre système solaire ?',
    choices: [
      { label: '7',  isCorrect: false },
      { label: '8',  isCorrect: true  },
      { label: '9',  isCorrect: false },
      { label: '10', isCorrect: false },
    ],
  },
  {
    mode: 'normal',
    text: 'Quel pays a remporté la Coupe du Monde de football 2018 ?',
    choices: [
      { label: 'Brésil',    isCorrect: false },
      { label: 'Allemagne', isCorrect: false },
      { label: 'France',    isCorrect: true  },
      { label: 'Croatie',   isCorrect: false },
    ],
  },
  {
    mode: 'normal',
    text: 'À quelle température l\'eau bout-elle au niveau de la mer ?',
    choices: [
      { label: '90°C',  isCorrect: false },
      { label: '95°C',  isCorrect: false },
      { label: '100°C', isCorrect: true  },
      { label: '110°C', isCorrect: false },
    ],
  },
  {
    mode: 'normal',
    text: 'Qui a peint la Joconde ?',
    choices: [
      { label: 'Michel-Ange',      isCorrect: false },
      { label: 'Raphaël',          isCorrect: false },
      { label: 'Léonard de Vinci', isCorrect: true  },
      { label: 'Botticelli',       isCorrect: false },
    ],
  },
  {
    mode: 'buzzer',
    text: 'Quel est le plus grand océan du monde ?',
  },
  {
    mode: 'normal',
    text: 'Quelle est la langue officielle du Brésil ?',
    choices: [
      { label: 'Espagnol',  isCorrect: false },
      { label: 'Portugais', isCorrect: true  },
      { label: 'Français',  isCorrect: false },
      { label: 'Anglais',   isCorrect: false },
    ],
  },
  {
    mode: 'normal',
    text: 'Combien de cordes a une guitare classique ?',
    choices: [
      { label: '4', isCorrect: false },
      { label: '5', isCorrect: false },
      { label: '6', isCorrect: true  },
      { label: '7', isCorrect: false },
    ],
  },
  {
    mode: 'normal',
    text: 'En quelle année a eu lieu la Révolution française ?',
    choices: [
      { label: '1776', isCorrect: false },
      { label: '1789', isCorrect: true  },
      { label: '1804', isCorrect: false },
      { label: '1815', isCorrect: false },
    ],
  },
  {
    mode: 'normal',
    text: 'Qui a formulé la théorie de la relativité générale ?',
    choices: [
      { label: 'Isaac Newton',   isCorrect: false },
      { label: 'Niels Bohr',    isCorrect: false },
      { label: 'Albert Einstein',isCorrect: true  },
      { label: 'Max Planck',    isCorrect: false },
    ],
  },
  {
    mode: 'normal',
    text: 'Sur quel continent se trouve le mont Everest ?',
    choices: [
      { label: 'Afrique',   isCorrect: false },
      { label: 'Asie',      isCorrect: true  },
      { label: 'Amérique',  isCorrect: false },
      { label: 'Océanie',   isCorrect: false },
    ],
  },
  {
    mode: 'buzzer',
    text: 'Quelle est la formule chimique de l\'eau ?',
  },
];

questions.forEach((q, i) => {
  const qId = insertQuestion(session.id, q.text, q.mode, i);
  (q.choices || []).forEach((c, j) => insertChoice(qId, c.label, c.isCorrect, j));
  console.log(`[${String(i + 1).padStart(2, '0')}/12] [${q.mode.toUpperCase().padEnd(6)}] ${q.text}`);
});

console.log(`\n✓ 12 questions ajoutées à la session ${CODE.toUpperCase()}`);
