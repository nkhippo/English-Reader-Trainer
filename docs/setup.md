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
| GAS Web App | `https://script.google.com/macros/s/AKfycbwycydsjQeVlOBD-33-0g7XGs0TDdPofNDtIQOL0T0m46ttritIMq84UxxZD41P3FDW/exec` |
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
| `passages_meta` | Generated passage metadata (Phase 4) + critique scores |
| `encounter_log` | Event log (Phase 1+) |

## Drive Structure

```
/EnglishReaderTrainer/
  /passages/     ← generated passage JSON (Phase 4)
  /audio/        ← TTS mp3 cache (Phase 5)
  /manifest/     ← audio_manifest.json (shared with Listening Trainer)
  /shared/       ← cefr_words.json, cefr_chunks.json, passage-templates.json ✅
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
enrichAllTranslations()
```

Runs batches of **625 items** per Claude call until `remaining: 0`. If the 6-minute execution limit is reached, it **automatically schedules the next run** (~30 seconds later) and continues until complete. No manual re-runs needed.

To cancel a queued continuation:

```
stopEnrichAllTranslations()
```

Single batch only: `enrichTranslationsBatch()`

Check coverage anytime:

```
auditTranslationCoverage()
```

Returns `{ total, covered, remaining, percent }`.

### 5. Add English gloss column (existing spreadsheets)

On spreadsheets created before `en_translation` was added, run once:

```
migrateChunksAddEnTranslationColumn()
```

### 6. Run English gloss batch

```
enrichAllEnglishGlosses()
```

Runs batches of **625 items** per Claude call until `en_translation` `remaining: 0` (auto-continues like the Japanese batch).

To cancel:

```
stopEnrichAllEnglishGlosses()
```

Single batch only: `enrichEnglishGlossesBatch()`

Check coverage:

```
auditEnglishGlossCoverage()
```

### 7. Verify

- GET the Web App URL → `{ "phase": 2, "chunks_master_count": 7100+ }`
- App header: tap level pill → switch A1+A2 / B1 / B2
- Marginalia shows `ja_translation` from sheet after enrich
- Switch UI to EN — marginalia shows `en_translation` after English gloss batch

## Phase 3: SRS engine

After redeploying GAS with Phase 3 code:

- **Got it** / **Still hard** updates `user_progress` (stage, `next_due_at`, status)
- Header stats show real **reviewing** / **graduated** counts from `user_progress`
- Marginalia shows live **encounters** and **stage** dots

If `encounter_log` has rows but `user_progress` is empty, run **`rebuildUserProgressFromEncounters()`** once in the Apps Script editor.

SRS rules (§4.2): got_it → stage+1, still_hard → stage−1, passive → +1 day. Graduated at got_it ≥ 6 × distinct passages ≥ 5 × span ≥ 3 days. Non-due chunks are not reshown until next_due_at.

## Phase 4: Passage generation (template / hybrid / dynamic)

### Passage modes (`USE_DYNAMIC_PASSAGES`)

| Value | Behavior |
|-------|----------|
| *(omit or `false`)* | **Template only** — rotate fixed templates |
| `hybrid` | **Recommended** — cache → template covering due chunks → Claude only when a chunk needs new context |
| `true` | **Dynamic only** — always try Claude first (falls back to template on error) |

Set in Apps Script → Project Settings → Script properties.

### 1. Upload passage templates (recommended)

Place `shared/passage-templates.json` in Drive `/EnglishReaderTrainer/shared/` (15 templates per band: A1A2, B1, B2).

The frontend bundles the same JSON for **instant local fallback** when you tap **Got it** / **Still hard**. GAS loads it from Drive when serving `/session` and `/generate_passage`; if missing, inline fallback (3 per band) is used.

### 2. Redeploy GAS

1. Copy latest `gas/Code.gs` into your Apps Script project.
2. **Deploy** → Manage deployments → Edit → **New version** → Deploy.

### 3. Enable hybrid (recommended)

```
USE_DYNAMIC_PASSAGES = hybrid
```

`ANTHROPIC_API_KEY` must be set. Hybrid calls Claude only when due chunks are **new** or have appeared in **fewer than 3 distinct passages** — otherwise it serves cached or template passages (fast, no API cost).

### 4. Frontend behavior (no GAS wait on advance)

- Prefetches **3** passages in the background while you read.
- On **Got it** / **Still hard**: shows next passage from prefetch queue, else a local template (~instant), then refills the queue via GAS in the background.
- Processing overlay lasts only the ~200ms page transition, not the GAS round-trip.

Generated passages are saved to Drive `passages/` and registered in `passages_meta`.

## Phase 4b: Prompt renewal (2026-06)

プロンプト・モデル全面見直し後、**翻訳と動的パッセージキャッシュを作り直す**手順。詳細: [claude-api-prompt-renewal-work-request.md](./claude-api-prompt-renewal-work-request.md)

### 1. GAS を更新・再デプロイ

最新 `gas/Code.gs` を貼り付け → **New version** でデプロイ。

### 2. スプレッドシート / Drive をリフレッシュ（1 回だけ）

Apps Script エディタで **1 回** 実行:

```
preparePromptRenewalRefresh()
```

| 対象 | 処理 |
|------|------|
| `chunks_master.ja_translation` | **全行クリア** |
| `chunks_master.en_translation` | **全行クリア** |
| `chunks_master.example_sentence` | **全行クリア** |
| `passages_meta` | データ行を削除（ヘッダー残す） |
| Drive `passages/` | 既存 JSON をゴミ箱へ |
| `passages_meta` | `critique_total` / `critique_verdict` 列を追加（未設定時） |

**触らないもの:** `user_progress`, `encounter_log`（SRS 履歴は保持）

### 3. 翻訳バッチを再実行

```
enrichAllTranslations()        # remaining: 0 まで
enrichAllEnglishGlosses()      # remaining: 0 まで
```

新プロンプト（コア意味・L2-L2 グロス）で 7,125 件を再生成。

### 4. テンプレサンプル生成（レビュー用）

```
generateTemplateBatch_("A1A2", 1)
generateTemplateBatch_("B1", 1)
generateTemplateBatch_("B2", 1)
```

Drive `shared/template-batch-*.json` に出力。合格品をレビュー後 `passage-templates.json` にマージ。

### 5. バックグラウンド warmup（任意）

```
warmupPassagesForBand_("B1", 3)
```

critique 合格パッセージのみ `passages_meta` に `critique_verdict=pass` で保存。

## Local Development

```bash
npm install
npm run dev
```

## Deployment

Pushes to `main` automatically deploy to GitHub Pages via `.github/workflows/deploy.yml`.

Live URL: https://nkhippo.github.io/English-Reader-Trainer/
