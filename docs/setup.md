# Setup Guide — English Reader Trainer

> **最終更新:** 2026-06-22  
> **対象:** GAS / Sheets / Drive / フロントの初回セットアップと運用

## Deployed resources

| Resource | URL / ID |
|----------|----------|
| GAS Web App | `https://script.google.com/macros/s/AKfycbydfzsGuLKFKHNVjnZhEDd-hLSYe0tJTDYv0EcovHRMRGZRJIPJzZxEa2mD4jGSKUv8/exec` |
| Spreadsheet | [English Reader Trainer](https://docs.google.com/spreadsheets/d/1708RNGs-IbGAPvgxAlmc2_u9QEy_Ffaajrm0ka7mhIw/edit) — ID: `1708RNGs-IbGAPvgxAlmc2_u9QEy_Ffaajrm0ka7mhIw` |
| Drive root | [EnglishReaderTrainer](https://drive.google.com/drive/folders/1fo9A48ddmjeHk0aSm6ymG_HWPmnCOYsI) — ID: `1fo9A48ddmjeHk0aSm6ymG_HWPmnCOYsI` |
| GitHub Pages | https://nkhippo.github.io/English-Reader-Trainer/ |

## Setup checklist

| Step | Status |
|------|--------|
| Google Sheets tabs | `chunks_master`, `user_progress`, `passages_meta`, `encounter_log`, `token_usage` |
| Drive subfolders | `passages/`, `audio/`, `manifest/`, `shared/` |
| GAS deployed (Web App) | Execute as: Me / Access: Anyone |
| Script Properties | `SPREADSHEET_ID`, `DRIVE_ROOT_ID`, `ANTHROPIC_API_KEY`, `USE_DYNAMIC_PASSAGES=hybrid` |
| Frontend `DEFAULT_GAS_URL` | `src/lib/config.js` |

**動作確認:** アプリでチャンクをタップ → marginalia で「✓ OK」→ `encounter_log` に `got_it`（単一 `chunk_id`）が記録されること。「次へ」で同一 `passage_id` の全チャンクに `exposure` が記録されること。

---

## 1. Backend (Google Apps Script)

### 1.1 初回セットアップ

1. [script.google.com](https://script.google.com) でプロジェクト作成、または **clasp push**（推奨）で `gas/Code.gs` + `gas/appsscript.json` を同期。
2. **Script Properties** を設定:
   - `SPREADSHEET_ID`
   - `DRIVE_ROOT_ID`
   - `ANTHROPIC_API_KEY`
   - `USE_DYNAMIC_PASSAGES` = `hybrid`（推奨）
3. `setupSheets()` を 1 回実行（シート・Drive サブフォルダ作成）。
4. **Deploy** → Web app → New version → `/exec` URL を `src/lib/config.js` に反映。

### 1.2 コード同期（clasp）

```bash
cd gas
cp .clasp.json.example .clasp.json   # scriptId を記入
npx @google/clasp@2.4.2 login
npx @google/clasp@2.4.2 push
```

貼り付けが 3000 行超で失敗する場合は clasp を使う。

### 1.3 計測用（任意）

Script Property `TOKEN_USAGE_SINCE_ISO`（例: `2026-06-22T20:30:00+09:00`）を設定後、GAS で `reportTokenUsageSinceDeploy()` を実行。

---

## 2. Sheet schema

| Tab | Purpose |
|-----|---------|
| `chunks_master` | CEFR チャンク語彙（7,125 件）+ ja/en 訳 + `enrich_version` |
| `user_progress` | ユーザー × チャンクの SRS 状態 |
| `passages_meta` | 生成パッセージ索引 + critique スコア |
| `encounter_log` | 遭遇イベント（`got_it` / `still_hard` / `exposure` 等） |
| `token_usage` | Claude API トークン計測ログ |

### `user_progress` 列

`user_id`, `chunk_id`, `encounter_count`, `distinct_passages_count`, `last_encountered_at`, `next_due_at`, `srs_stage`, `status`, `got_it_count`, `still_hard_count`

### `encounter_log` 列

`event_id`, `user_id`, `chunk_id`, `passage_id`, `read_at`, `signal`, `time_on_page_ms`

**signal 一覧（現行）**

| signal | 送信元 | progress 更新 |
|--------|--------|--------------|
| `got_it` | marginalia「✓ OK」（単一チャンク） | `got_it_count++`, stage+1, `encounter_count++` |
| `still_hard` | marginalia「△ 保留」（単一チャンク） | `still_hard_count++`, stage−1, `encounter_count++` |
| `exposure` | Footer「次へ」（パッセージ内全チャンク） | `distinct_passages_count` と `last_encountered_at` のみ |
| `passive` | （フロントからは送信しない） | ログのみ、progress 更新なし |
| `skipped` | レガシー | ログのみ |

---

## 3. Drive structure

```
/EnglishReaderTrainer/
  passages/     ← Sonnet 生成 JSON
  audio/        ← TTS キャッシュ（将来）
  manifest/     ← audio_manifest.json（将来）
  shared/       ← cefr_*.json, passage-templates.json
```

---

## 4. CEFR import & enrich

### 4.1 初回

1. Drive `shared/` に `cefr_words.json`, `cefr_chunks.json` を配置。
2. `importChunksFromCefr()` — `chunks_master` に約 7,125 行投入。
3. 既存シートなら一度だけ:
   - `migrateChunksAddEnTranslationColumn()`
   - `migrateChunksAddEnrichVersionColumn()`

### 4.2 翻訳バッチ（手動・バックグラウンド）

| 関数 | 内容 |
|------|------|
| `enrichAllTranslations()` | ja + example_sentence（**150 件/回**、6 分制限内で自動継続） |
| `enrichAllEnglishGlosses()` | en グロス（同上） |
| `stopEnrichAllTranslations()` / `stopEnrichAllEnglishGlosses()` | 継続トリガー停止 |
| `auditTranslationCoverage()` / `auditEnglishGlossCoverage()` | カバレッジ確認 |

**差分 enrich:** `ENRICH_PROMPT_VERSION`（`Code.gs` 定数）と `chunks_master.enrich_version` で、プロンプト変更時のみ未更新行を再 enrich。`preparePromptRenewalRefresh()` は翻訳全消去せず、パッセージキャッシュのみクリア。

---

## 5. Passage mode (`USE_DYNAMIC_PASSAGES`)

| 値 | 挙動 |
|----|------|
| `hybrid`（**推奨・デフォルト**） | キャッシュ → スーパーセットキャッシュ → テンプレ → 条件付き Sonnet |
| `true` | 常に Sonnet 優先 |
| `false` / `template` | テンプレのみ |

Sonnet が走る条件（`needsNewPassageContext_`）: 選定チャンクのいずれかが new / stage 0 / `distinct_passages_count < 3`。

---

## 6. フロントエンド

### 6.1 定数（`src/lib/config.js`）

| 定数 | 値 | 意味 |
|------|-----|------|
| `READING_TIME_LIMIT_SEC` | 60 | 読了目安タイマー（**記録なし**） |
| `PREFETCH_QUEUE_SIZE` | 1 | 先読みパッセージ数 |
| `CLOZE_PROBABILITY` | 0.3 | Cloze 空白の確率 |
| `ADVANCE_GAS_TIMEOUT_MS` | 3500 | GAS 待ちタイムアウト |

### 6.2 読書 UX（現行）

- **marginalia:** チャンクタップ → 解説 + 「✓ OK」「△ 保留」（個別評価、任意）
- **Footer:** 「次へ →」でパッセージ遷移 + 全チャンク `exposure` 送信
- **中断:** セッション一時停止（評価の still_hard とは別）
- **先読み:** 読書中に次 1 本をバックグラウンド生成（キューは「次へ」で消さない）

### 6.3 ローカル開発・デプロイ

```bash
npm install
npm run dev          # ローカル
npm run build        # dist/
```

`main` への push で GitHub Pages 自動デプロイ（`.github/workflows/deploy.yml`）。

---

## 7. 運用メンテナンス

| タスク | 関数 / 手順 |
|--------|------------|
| GAS 更新 | `clasp push` → Deploy → New version → `config.js` URL 更新 |
| progress 再構築 | `rebuildUserProgressFromEncounters()`（`exposure` / `got_it` / `still_hard` を正しく反映） |
| 夜間 warmup | `setupNightlyWarmupTrigger()`（1 回） |
| トークン確認 | `reportTokenUsageLastHour()` / `reportTokenUsageSinceDeploy()` |
| パッセージ診断 | `debugPassageValidationSample('B1')` |

---

## 8. 関連ドキュメント

| ファイル | 内容 |
|---------|------|
| [product-overview.md](./product-overview.md) | 思想・全体仕様 |
| [chunk-lifecycle-design.md](./chunk-lifecycle-design.md) | チャンク選定・遭遇・卒業の設計 |
| [claude-api.md](./claude-api.md) | Claude モデル・プロンプト・検証 |
| [claude-api-token-usage.md](./claude-api-token-usage.md) | トークン計測・コスト |
