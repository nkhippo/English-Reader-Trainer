# Claude API — モデル・プロンプト・検証（現行仕様）

> **最終更新:** 2026-06-22  
> **ソース:** `gas/Code.gs`（コミット `5750e20` 以降）

**GAS Web App:** `https://script.google.com/macros/s/AKfycbydfzsGuLKFKHNVjnZhEDd-hLSYe0tJTDYv0EcovHRMRGZRJIPJzZxEa2mD4jGSKUv8/exec`

---

## 0. Claude レビュー依頼

1. **パッセージ生成プロンプト** — 最大 5 チャンク / 4–7 文 / i+1 補強文は妥当か
2. **prior_contexts 注入** — 「異なる文脈で再会」を担保できているか
3. **リアルタイム検証** — regex + self_check + span 補正（`findChunkSpanInPassage_`）の十分性
4. **フェーズ適応選定** — new 最大 3 と Sonnet 生成の関係
5. **critique rubric** — オフライン経路の閾値（合計 ≥ 13、単項 0 不可）
6. **enrich 150 件/回** — GAS 6 分制限下の妥当性

---

## 1. コンテンツと Claude の関係

| コンテンツ | 関数 | モデル | タイミング |
|-----------|------|--------|-----------|
| 動的パッセージ | `callClaudeGeneratePassage_()` | Sonnet 4.6 | hybrid: `needsNewPassageContext_` |
| critique | `callClaudeCritiquePassage_()` | Haiku 4.5 | warmup / batch のみ |
| ja + example | `callClaudeEnrich_()` | Haiku 4.5 | 手動バッチ |
| en グロス | `callClaudeEnrichEnglish_()` | Haiku 4.5 | 手動バッチ |
| 固定テンプレ 45 本 | 手書き（`generateTemplateBatch_` で差し替え可） | — | オフライン |

フロントエンドから Claude API を直接呼ばない。すべて GAS 経由。

---

## 2. モデル定数

```javascript
const MODEL_PASSAGE  = 'claude-sonnet-4-6';
const MODEL_CRITIQUE = 'claude-haiku-4-5-20251001';
const MODEL_ENRICH   = 'claude-haiku-4-5-20251001';

const ENRICH_BATCH_SIZE = 150;
const ENRICH_JA_MAX_TOKENS = 64000;
const ENRICH_EN_MAX_TOKENS = 64000;
const ENRICH_PROMPT_VERSION = 1;

const PASSAGE_GENERATION_MAX_ATTEMPTS = 2;  // 初回 + 1 リトライ
```

| 用途 | max_tokens | 1 回あたり |
|------|------------|-----------|
| パッセージ生成 | 4,096 | 1 パッセージ |
| critique | 2,048 | 1 パッセージ |
| ja enrich | 64,000 | 150 チャンク |
| en enrich | 64,000 | 150 チャンク |

**API ヘッダー**

- `anthropic-version: 2023-06-01`
- `anthropic-beta: prompt-caching-2024-07-31`（passage system / critique 固定部に `cache_control: ephemeral`）

認証: Script Property `ANTHROPIC_API_KEY`

---

## 3. パッセージ生成プロンプト

### 3.1 system (`PASSAGE_SYSTEM_PROMPT_`)

要点:

1. **COMPREHENSIBLE INPUT (i+1)** — 周囲語彙は CEFR 帯以下。ターゲットチャンクのみ +1。複数チャンクが隣接する場合は接続文を既知語で単純にし、互いに推測可能に保つ。
2. **INFERABILITY** — 文脈から意味を推測可能に。
3. **NATURAL USE** — 典型共起・自然な文法枠。
4. **CONCRETE** — 具体シーン（抽象 filler 禁止）。
5. **CONTEXTUAL VARIETY** — `prior_contexts` と異なるシナリオ。
6. **REGISTER AND LINGUISTIC VARIETY BY CEFR BAND** — 時制・人称・接続詞の帯別分布。

**チャンク形のルール:** ターゲットチャンク自体は改変しないが、先頭語の活用（`have` → `had` 等）は自然なら可。

**出力 JSON:** `text`, `ja_translation`, `target_chunks[]`（`chunk_id`, `text`, `char_start`, `char_end`）, `self_check`（5 フラグ + `notes`）

### 3.2 user (`buildPassageUserPrompt_`)

```
CEFR band: {A1/A2 | B1 | B2}
Length: 4 to 7 sentences, 70 to 150 words total.

Target chunks (embed ALL of them, each at least once):
- "{chunk text}"  (chunk_id: {id})
    intended meaning: {ja or en gloss}
    previously appeared as: …（最大 3 件）または FIRST encounter 指示
```

`getChunkPriorContexts_(chunkId, index, 3)` — `passages_meta` → Drive JSON から抽出。

---

## 4. critique（オフライン専用）

`callClaudeCritiquePassage_()` — Haiku 4.5

**基準（各 0–2 点）:** naturalness, comprehensibility, inferability, chunk_integrity, variety, linguistic_variety, concreteness, translation_fidelity

**合格:** `critiquePasses_()` — 全基準 > 0、合計 ≥ 13、`verdict !== 'revise'`

リアルタイム読書経路では critique を呼ばない。

---

## 5. enrich プロンプト

### 5.1 日本語 (`callClaudeEnrich_`)

- `ja_translation`: コア意味 1 語義、自然な日本語
- `example_sentence`: 8–18 語の具体例文
- 出力: JSON 配列 `[{chunk_id, ja_translation, example_sentence}]`

### 5.2 英語グロス (`callClaudeEnrichEnglish_`)

- `en_translation`: 6–15 語、L2-L2、循環定義禁止、headword より易しい語のみ
- 出力: JSON 配列 `[{chunk_id, en_translation}]`

### 5.3 差分 enrich

- `chunks_master.enrich_version` 列
- `ENRICH_PROMPT_VERSION` 不一致行のみ再実行
- `preparePromptRenewalRefresh()` は翻訳全消去しない（パッセージキャッシュのみクリア）

---

## 6. 検証アーキテクチャ

### 6.1 リアルタイム（ユーザー待ち）

```
generateDynamicPassageClaude_()
  loop attempt < PASSAGE_GENERATION_MAX_ATTEMPTS (2):
    callClaudeGeneratePassage_()
    repairPassageTargetChunkSpans_()      … char_start/end 補正
    validatePassageChunks_()              … findChunkSpanInPassage_（活用形許容）
    describePassageQualityFailure_()      … 文数・語数・span・self_check
```

| 検証 | 閾値 |
|------|------|
| 文数 | 4–7 |
| 語数 | 60–160 |
| チャンク含有 | 全文に各ターゲットが存在（活用形マッチ可） |
| span | 補正後 slice === `tc.text` |
| self_check | 5 フラグいずれも `false` でない |

**span 補正 (`findChunkSpanInPassage_`):**

1. 完全一致（case-insensitive）
2. 複数語チャンク: 先頭語の活用を許容する正規表現（例: `have an opinion on` → `had an opinion on`）

### 6.2 バックグラウンド

`generatePassageWithCritique_()` — 生成 → 上記検証 → critique → revise なら `revision_hint` 付き再試行（最大 2 試行）

### 6.3 キャッシュ

| 関数 | 挙動 |
|------|------|
| `findCachedPassage_()` | チャンク集合完全一致。`critique_verdict=revise` 除外、`pass` 優先 |
| `findCachedPassageContainingChunks_()` | 要求チャンクのスーパーセット |

---

## 7. チャンク選定と Sonnet 呼び出し

`selectChunksForPassage_()` — フェーズ適応（[chunk-lifecycle-design.md](./chunk-lifecycle-design.md) §4）

`needsNewPassageContext_()` — 選定チャンクのいずれかが new / stage 0 / distinct < 3 → Sonnet

**コスト削減レイヤー**

1. Drive キャッシュ（完全一致）
2. スーパーセットキャッシュ
3. 固定テンプレ 45 本
4. 先読み 1 本のみ（フロント）
5. 夜間 warmup（`runNightlyWarmup_`）
6. prompt caching（`cache_read_input_tokens` 計測あり）

---

## 8. トークン計測

`token_usage` シート — 全 Claude 呼び出しで `recordAnthropicUsage_()`

| 列 | 内容 |
|----|------|
| ts, model, purpose | |
| input_tokens, output_tokens | |
| cache_creation_input_tokens, cache_read_input_tokens | |
| retry_index | 同一生成ループ内の試行番号（0 = 初回） |

GAS 関数: `reportTokenUsage()`, `reportTokenUsageLastHour()`, `reportTokenUsageSinceDeploy()`

詳細: [claude-api-token-usage.md](./claude-api-token-usage.md)

---

## 9. GAS 手動関数

| 関数 | 用途 |
|------|------|
| `enrichAllTranslations()` / `enrichAllEnglishGlosses()` | 差分 enrich バッチ |
| `preparePromptRenewalRefresh()` | パッセージキャッシュクリア + enrich バージョン案内 |
| `migrateChunksAddEnrichVersionColumn()` | 既存シート移行 |
| `generateTemplateBatch_(band, count)` | テンプレ候補（最大 5/回） |
| `setupNightlyWarmupTrigger()` | 夜間 warmup トリガー |
| `debugPassageValidationSample(band)` | span 補正前後の診断 |
| `rebuildUserProgressFromEncounters()` | encounter_log から progress 再構築 |

---

## 10. 関連ファイル

| ファイル | 役割 |
|---------|------|
| `gas/Code.gs` | 全 API 呼び出し・検証・選定 |
| `docs/chunk-lifecycle-design.md` | 遭遇・卒業・選定の設計 |
| `docs/claude-api-token-usage.md` | コスト分析 |
| `shared/passage-templates.json` | 固定テンプレ |

---

*最終更新: 2026-06-22 — 5 チャンク・span 補正・2 リトライ・prompt caching・token_usage*
