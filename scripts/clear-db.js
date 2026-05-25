/**
 * Vide toutes les questions, choix, joueurs, réponses et sessions de la base.
 * Usage : node scripts/clear-db.js
 */

const { getDb } = require('../src/db/schema.js');

const db = getDb();

const counts = {
  buzz_events: db.prepare('SELECT COUNT(*) as n FROM buzz_events').get().n,
  answers:     db.prepare('SELECT COUNT(*) as n FROM answers').get().n,
  players:     db.prepare('SELECT COUNT(*) as n FROM players').get().n,
  choices:     db.prepare('SELECT COUNT(*) as n FROM choices').get().n,
  questions:   db.prepare('SELECT COUNT(*) as n FROM questions').get().n,
  sessions:    db.prepare('SELECT COUNT(*) as n FROM sessions').get().n,
};

console.log('Avant suppression :');
Object.entries(counts).forEach(([t, n]) => console.log(` - ${t}: ${n}`));

const clear = db.transaction(() => {
  db.prepare('DELETE FROM buzz_events').run();
  db.prepare('DELETE FROM answers').run();
  db.prepare('DELETE FROM players').run();
  db.prepare('DELETE FROM choices').run();
  db.prepare('DELETE FROM questions').run();
  db.prepare('DELETE FROM sessions').run();
});

clear();

console.log('\nBase vidée avec succès ✓');
