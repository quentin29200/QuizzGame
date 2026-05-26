const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/quizzgame.db');
let db;

function getDb() {
  if (!db) {
    if (DB_PATH !== ':memory:') {
      const fs = require('fs');
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    }
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
    migrate();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      code       TEXT    NOT NULL UNIQUE,
      state      TEXT    NOT NULL DEFAULT 'lobby',
      mode       TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS players (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      socket_id  TEXT    NOT NULL,
      name       TEXT    NOT NULL,
      score      INTEGER NOT NULL DEFAULT 0,
      joined_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(session_id, name)
    );
    CREATE TABLE IF NOT EXISTS questions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      text       TEXT    NOT NULL,
      mode       TEXT    NOT NULL DEFAULT 'normal',
      position   INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS choices (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      label       TEXT    NOT NULL,
      is_correct  INTEGER NOT NULL DEFAULT 0,
      position    INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS answers (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   INTEGER NOT NULL REFERENCES sessions(id)  ON DELETE CASCADE,
      question_id  INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      player_id    INTEGER NOT NULL REFERENCES players(id)   ON DELETE CASCADE,
      choice_id    INTEGER REFERENCES choices(id),
      text_answer  TEXT,
      player_mode  TEXT,
      submitted_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(question_id, player_id)
    );
    CREATE TABLE IF NOT EXISTS buzz_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  INTEGER NOT NULL REFERENCES sessions(id)   ON DELETE CASCADE,
      question_id INTEGER NOT NULL REFERENCES questions(id)  ON DELETE CASCADE,
      player_id   INTEGER NOT NULL REFERENCES players(id)    ON DELETE CASCADE,
      buzz_ts     INTEGER NOT NULL,
      is_winner   INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS songs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      title       TEXT    NOT NULL,
      artist      TEXT    NOT NULL,
      youtube_url TEXT,
      position    INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS bt_buzz_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      song_id    INTEGER NOT NULL REFERENCES songs(id)    ON DELETE CASCADE,
      player_id  INTEGER NOT NULL REFERENCES players(id)  ON DELETE CASCADE,
      buzz_ts    INTEGER NOT NULL,
      is_winner  INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function migrate() {
  try { db.exec('ALTER TABLE answers ADD COLUMN player_mode TEXT'); } catch(e) {}
  try { db.exec("UPDATE questions SET mode = 'normal' WHERE mode IN ('duo','carre','cash')"); } catch(e) {}
  try { db.exec("ALTER TABLE sessions ADD COLUMN type TEXT NOT NULL DEFAULT 'quiz'"); } catch(e) {}
}

module.exports = { getDb };
