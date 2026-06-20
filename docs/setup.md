# Setup Guide — English Reader Trainer

## Setup status

| Step | Status |
|------|--------|
| Google Sheets (4 tabs) | ✅ Done |
| Drive folder + subfolders | ✅ Done |
| GAS deployed (Web App) | ✅ Done |
| Script Properties set | ✅ Done |
| Frontend GAS URL configured | ✅ Done |

After setup, press **Got it** or **Still hard** and confirm rows appear in the `encounter_log` tab.

## Deployed resources

| Resource | URL / ID |
|----------|----------|
| GAS Web App | `https://script.google.com/macros/s/AKfycbzeCoDzWxDyGBhpDtKeZ5mUehChQsvTPewQ0Sb_x6U2KQaZdoSDePRr3pAnJPGe8lS4/exec` |
| Spreadsheet | [English Reader Trainer](https://docs.google.com/spreadsheets/d/1708RNGs-IbGAPvgxAlmc2_u9QEy_Ffaajrm0ka7mhIw/edit) — ID: `1708RNGs-IbGAPvgxAlmc2_u9QEy_Ffaajrm0ka7mhIw` |
| Drive root | [EnglishReaderTrainer](https://drive.google.com/drive/folders/1fo9A48ddmjeHk0aSm6ymG_HWPmnCOYsI) — ID: `1fo9A48ddmjeHk0aSm6ymG_HWPmnCOYsI` |

## Phase 1: Backend (Google Apps Script)

### 1. Google Sheets

Spreadsheet ID: `1708RNGs-IbGAPvgxAlmc2_u9QEy_Ffaajrm0ka7mhIw`

### 2. Google Drive

Drive root folder ID: `1fo9A48ddmjeHk0aSm6ymG_HWPmnCOYsI`

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

The GAS URL is set in `src/lib/config.js` as `DEFAULT_GAS_URL`. Encounter logging works automatically.

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
