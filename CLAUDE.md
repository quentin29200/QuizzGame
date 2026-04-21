# QuizzGame — CLAUDE.md

## Overview

QuizzGame is a real-time multiplayer quiz application. Three browser interfaces communicate via Socket.io:

- **`/admin`** — Create questions, launch the game, validate answers, adjust scores
- **`/play`** — Players join with a 4-letter code and answer questions
- **`/display`** — Projector view with live vote bars and rankings

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express 5 |
| Real-time | Socket.io 4 |
| Database | SQLite via better-sqlite3 |
| Frontend | Vanilla JS + HTML/CSS (no framework) |

## Project Structure

```
QuizzGame/
├── src/
│   ├── server.js                # Express + Socket.io entry point (port 3000)
│   ├── db/
│   │   ├── schema.js            # SQLite schema init (getDb singleton)
│   │   └── queries.js           # All DB operations (prepared statements)
│   └── socket/
│       └── handlers.js          # All Socket.io event handlers
├── public/
│   ├── admin/                   # Admin interface
│   ├── play/                    # Player interface
│   ├── display/                 # Display/projector interface
│   └── style.css
├── scripts/
│   └── seed-questions.js        # Dev seed: node scripts/seed-questions.js <CODE>
├── tests/                       # Jest test suite
└── sample-questions.json        # Example import file
```

## Database Schema

- **sessions** — `id, code (4 chars unique), state (lobby|question|reveal|ended), mode, created_at`
- **questions** — `id, session_id, text, mode (normal|buzzer), position, created_at`
- **choices** — `id, question_id, label, is_correct, position`
- **players** — `id, session_id, socket_id, name, score, joined_at`
- **answers** — `id, session_id, question_id, player_id, choice_id, text_answer, player_mode (duo|carre|cash), submitted_at`
- **buzz_events** — `id, session_id, question_id, player_id, buzz_ts, is_winner`

## Game Modes (per question)

- **Normal** — 4 multiple-choice options; players pick Duo (2 choices, 2pts), Carré (4 choices, 3pts), or Cash (free text, 5pts if admin validates)
- **Buzzer** — Players buzz in; admin picks the winner manually

## Session State (in-memory, `handlers.js`)

Per active session, `sessionState` Map holds:
```js
{ currentQuestionId, currentChoices, buzzerLocked, choiceVotes, cashAnswers, playerModes }
```

## REST API

| Method | Path | Description |
|---|---|---|
| POST | `/api/sessions` | Create new session → `{ id, code }` |
| GET | `/api/sessions/:code` | Get session by code |
| POST | `/api/sessions/import` | Create session from JSON → `{ id, code, questionCount }` |

## JSON Import Format

Use `POST /api/sessions/import` or the admin UI button "Importer JSON" to create a new session from a file.

```json
{
  "title": "Mon quiz",
  "questions": [
    {
      "text": "Question texte",
      "mode": "normal",
      "choices": [
        { "label": "Bonne réponse", "isCorrect": true },
        { "label": "Mauvaise A",    "isCorrect": false },
        { "label": "Mauvaise B",    "isCorrect": false },
        { "label": "Mauvaise C",    "isCorrect": false }
      ]
    },
    {
      "text": "Question buzzer",
      "mode": "buzzer"
    }
  ]
}
```

Rules:
- `mode` must be `"normal"` or `"buzzer"`
- Normal questions must have at least 2 choices and exactly 1 `isCorrect: true`
- Buzzer questions ignore the `choices` field
- Max 4 choices per question

## Development

```bash
npm run dev    # nodemon
npm test       # Jest
```

DB file: `data/quizzgame.db` (created on first run).

## Key Patterns

- All DB queries use **prepared statements** (SQL-injection safe)
- Socket callbacks use `ack?.({ ok, error })` pattern
- Admin joins room `${code}:admin`, players join `${code}:player:${playerId}` for private notifications
- `replaceChoices()` soft-deletes choices that have linked answers (marks as `[supprimé]`)
