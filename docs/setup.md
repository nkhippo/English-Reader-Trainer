# Setup Guide — English Reader Trainer

## Phase 1: Backend (Google Apps Script)

### 1. Google Sheets

1. Create a new Google Spreadsheet (e.g. "English Reader Trainer").
2. Copy the Spreadsheet ID from the URL.

### 2. Google Drive

1. Create a folder `/EnglishReaderTrainer/` in Drive.
2. Copy the folder ID from the URL.

### 3. Apps Script

1. Open [script.google.com](https://script.google.com) → New project.
2. Paste `gas/Code.gs` and `gas/appsscript.json`.
3. **Script Properties** (Project Settings → Script properties):
   - `SPREADSHEET_ID` — your Sheets ID
   - `DRIVE_ROOT_ID` — your Drive folder ID
4. Run `setupSheets()` once (authorize when prompted).
   - Creates 4 tabs: `chunks_master`, `user_progress`, `passages_meta`, `encounter_log`
   - Creates Drive subfolders: `passages/`, `audio/`, `manifest/`, `shared/`
5. **Deploy** → New deployment → Web app:
   - Execute as: Me
   - Who has access: Anyone
6. Copy the `/exec` URL.

### 4. Frontend

1. Open the app → click ⚙ (Settings).
2. Paste the GAS Web App URL and Save.
3. "Got it" / "Still hard" will now append rows to `encounter_log`.

Alternatively, set `VITE_GAS_URL` in `.env.local` for local development.

## Sheet Schema

See the work-request document (§3.1) for full column definitions.

| Tab | Purpose |
|-----|---------|
| `chunks_master` | CEFR chunk vocabulary (Phase 2) |
| `user_progress` | SRS state per chunk (Phase 3) |
| `passages_meta` | Generated passage metadata (Phase 4) |
| `encounter_log` | Event log (Phase 1+) |

## Drive Structure

```
/EnglishReaderTrainer/
  /passages/     ← generated passage JSON (Phase 4)
  /audio/        ← TTS mp3 cache (Phase 5)
  /manifest/     ← audio_manifest.json (shared with Listening Trainer)
  /shared/       ← cefr_words.json, cefr_chunks.json (Phase 2)
```

## Local Development

```bash
npm install
npm run dev
```

## Deployment

Pushes to `main` automatically deploy to GitHub Pages via `.github/workflows/deploy.yml`.

Live URL: https://nkhippo.github.io/English-Reader-Trainer/
