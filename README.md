# English Reader Trainer

Spaced re-encounter reading app for English chunks and collocations. Chunks appear in new contexts over time — no flashcards, no translation-first reading.

**Live app:** https://nkhippo.github.io/English-Reader-Trainer/

## What it does

- Presents 3–6 sentence passages with target chunks highlighted
- Marginalia panel shows chunk notes (tap a highlight)
- Swipe or arrow keys to move between passages
- "Got it" / "Still hard" records encounters via Google Apps Script → Sheets

## Development

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # output to dist/
```

## Project structure

```
src/           React frontend (Vite)
gas/           Google Apps Script backend
docs/          Setup guide
```

## Phase status

| Phase | Status | Description |
|-------|--------|-------------|
| 1 | ✅ | React UI + GAS + encounter logging |
| 2 | ✅ | CEFR import, ja_translation batch, level switcher UI |
| 3 | ✅ | SRS engine (due_chunks, update_progress, graduation) |
| 4 | — | Claude passage generation |
| 5 | — | TTS audio |
| 6 | — | Progress dashboard |

See `docs/setup.md` for GAS/Sheets configuration.

## Design

Paper-toned reading experience with marginalia notes in the right margin (bottom sheet on mobile). Based on the prototype in `english-reader-trainer-base.html`.

## Related apps

- [English Listening Trainer](https://github.com/nkhippo/English-Listening-Trainer) — audio-focused sister app
- Shares CEFR data and Drive audio cache (future phases)
