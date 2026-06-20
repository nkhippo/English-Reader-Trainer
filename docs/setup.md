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
| GAS Web App | `https://script.google.com/macros/s/AKfycby_PkB3dPlyt3QVuj3OGLWg3lcGU9u4L79-7-TAP7Ibl_LdLUpvR0too8Ag5n-iDyN4/exec` |
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
  /shared/       ← cefr_words.json, cefr_chunks.json ✅ uploaded
```

## Phase 2: CEFR import & translations

### 1. Upload CEFR JSON (done)

Place in Drive `/EnglishReaderTrainer/shared/`:

- `cefr_words.json`
- `cefr_chunks.json`

### 2. Update GAS code & redeploy

1. Copy latest `gas/Code.gs` into your Apps Script project.
2. Add Script Property: `ANTHROPIC_API_KEY` (Claude API key).
3. **Deploy** → Manage deployments → Edit → **New version** → Deploy.

### 3. Run import (Apps Script editor)

```
importChunksFromCefr()
```

Imports ~7,100 entries (words + chunks) into `chunks_master`.

### 4. Run Japanese translation batch

```
enrichAllTranslations(10)
```

Run repeatedly until log shows `remaining: 0`.

Or single batch: `enrichTranslationsBatch()`

Check coverage anytime:

```
auditTranslationCoverage()
```

Returns `{ total, covered, remaining, percent }`.

### 5. Verify

- GET the Web App URL → `{ "phase": 2, "chunks_master_count": 7100+ }`
- App header: tap level pill → switch A1+A2 / B1 / B2
- Marginalia shows `ja_translation` from sheet after enrich

## Phase 3: SRS engine

After redeploying GAS with Phase 3 code:

- **Got it** / **Still hard** updates `user_progress` (stage, `next_due_at`, status)
- Header stats show real **reviewing** / **graduated** counts from `user_progress`
- Marginalia shows live **encounters** and **stage** dots

If `encounter_log` has rows but `user_progress` is empty, run **`rebuildUserProgressFromEncounters()`** once in the Apps Script editor.

SRS rules (§4.2): got_it → stage+1, still_hard → stage−1, passive → +1 day, graduated at 5 encounters × 3 passages.

## Phase 4: Dynamic passage generation

1. Copy latest `gas/Code.gs` and redeploy Web App.
2. Add Script Property: `USE_DYNAMIC_PASSAGES` = `true` (omit or `false` for template rotation only).
3. `ANTHROPIC_API_KEY` must be set (same key as translation batch).
4. Generated passages are saved to Drive `passages/` and registered in `passages_meta`.

Without the flag, the app rotates fixed templates indefinitely (no session end). With the flag, `/generate_passage` and `/session` call Claude using `due_chunks` selection.

## Local Development

```bash
npm install
npm run dev
```

## Deployment

Pushes to `main` automatically deploy to GitHub Pages via `.github/workflows/deploy.yml`.

Live URL: https://nkhippo.github.io/English-Reader-Trainer/
