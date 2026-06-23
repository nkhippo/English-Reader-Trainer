# Claude API トークン利用量 — 現行仕様と計測

> **最終更新:** 2026-06-22  
> **目的:** トークン消費の事実整理・対策経緯・現状を Claude レビュー用に記述  
> **ソース:** `gas/Code.gs`, `token_usage` シート, Anthropic コンソール

**GAS Web App:** `https://script.google.com/macros/s/AKfycbwXld2V3mkwok107wvmMP9LwCUkggE1YuZurpQnUna3w1oIBfzVEsGBxPk7rj3h04zP/exec`

---

## 0. レビュー依頼

1. **改修後の想定コスト** — 先読み 1 本 + 2 リトライ + span 補正後の読書セッションあたり Sonnet 呼び出し回数は妥当か
2. **残リトライ** — 9 回中 1 回の retry_1 が残る原因と対策
3. **prompt caching** — さらに cache ヒット率を上げる余地
4. **enrich 150 件/回** — バッチサイズと max_tokens の最適化
5. **Sonnet 4.6 維持** — パッセージ品質に対する ROI

---

## 1. 観測値（問題提起時 — Anthropic コンソール）

| 時刻 (UTC) | モデル | トークン |
|-----------|--------|---------|
| 2026-06-22 02:00 | Sonnet 4.6 | 368,849 |
| 2026-06-22 02:00 | Haiku 4.5 | 99,185 |
| **合計 / 1h** | | **468,034** |

- Sonnet **約 79%**
- コンソールは API + Claude.ai 利用を含む可能性あり

**主因（調査結果）**

1. **Sonnet パッセージ生成の 3×リトライ** — `char_start`/`char_end` 誤報告で検証失敗 → 毎回 3 API 呼び出し（`retry_0/1/2` が同数）
2. **prefetch 3 本** — 読まないパッセージも生成
3. **hybrid** — `distinct_passages < 3` のチャンクで Sonnet 頻発
4. **enrich バッチ** — 手動実行時の Haiku 大量消費（読書 UX からは呼ばれない）

---

## 2. 実装した対策

### 2.1 計測基盤（Phase 1）

- `token_usage` シート + `logTokenUsage_()` / `recordAnthropicUsage_()`
- 列: `ts`, `model`, `purpose`, `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `retry_index`
- `reportTokenUsage*` 系 GAS 関数
- Script Property `TOKEN_USAGE_SINCE_ISO` でデプロイ以降を集計

### 2.2 コスト削減（Phase 2）

| 対策 | 内容 |
|------|------|
| Prompt caching | `cache_control: ephemeral` on passage system + critique 固定部 |
| スーパーセットキャッシュ | `findCachedPassageContainingChunks_()` |
| 夜間 warmup | `setupNightlyWarmupTrigger()` |
| **span 補正** | `repairPassageTargetChunkSpans_()` + `findChunkSpanInPassage_()` |
| リトライ上限 | **3 → 2**（`PASSAGE_GENERATION_MAX_ATTEMPTS`） |
| **先読み** | **3 → 1**、`clearPrefetch` on advance 撤廃 |
| 差分 enrich | `enrich_version` + `ENRICH_PROMPT_VERSION` |

### 2.3 UX 改修（2026-06-22 — 間接的コスト影響）

- 個別評価 + exposure 分離（passive 廃止 → 誤った progress 更新なし）
- フェーズ適応選定（導入期に new 3 → 多様なチャンク遭遇）

---

## 3. 計測結果（改修後）

`TOKEN_USAGE_SINCE_ISO = 2026-06-22T20:30:00+09:00` 以降の例:

| 時期 | retry_0 | retry_1 | retry_2 | 解釈 |
|------|---------|---------|---------|------|
| 修正前 | 36 | 36 | 36 | 毎生成 3× API |
| 修正直後 | 5 | 2 | 3 | 改善傾向 |
| **最新** | **9** | **1** | **0** | 9 生成のうち余分 API は 1 回 |

- `retry_index=0`: 別 `generate_passage` リクエストごとにリセット（本番 + prefetch）
- **retry_2=0** — 3 回目まで失敗は解消
- prompt caching 観測: 多くの passage で `cache_read_input_tokens ≈ 1154`

---

## 4. API 呼び出し経路（現行）

### 4.1 リアルタイム（読書）

```
フロント → generate_passage → buildPassageForUser_()
  → キャッシュ / テンプレ / Sonnet（条件付き）
  → 最大 PASSAGE_GENERATION_MAX_ATTEMPTS (2) 回
```

**prefetch:** `PREFETCH_QUEUE_SIZE=1` — 読書中に次 1 本のみバックグラウンド生成。

**encounter API はトークン消費なし**（Sheets のみ）。

### 4.2 手動バッチ

| 関数 | モデル | 頻度 |
|------|--------|------|
| `enrichAllTranslations()` | Haiku | 手動・差分のみ |
| `enrichAllEnglishGlosses()` | Haiku | 手動・差分のみ |
| `runNightlyWarmup_()` | Sonnet + critique | 夜間トリガー |
| `generateTemplateBatch_()` | Sonnet + Haiku | 手動 |

### 4.3 enrich 規模

- **150 件/回**, max_tokens 64,000
- 全件（7,125 × 2）理論最小: 約 96 API 回 / 約 200 万トークン（リトライなし）
- 差分 enrich によりプロンプト変更時のみ再実行

---

## 5. モデル定数（現行）

```javascript
const MODEL_PASSAGE  = 'claude-sonnet-4-6';
const MODEL_CRITIQUE = 'claude-haiku-4-5-20251001';
const MODEL_ENRICH   = 'claude-haiku-4-5-20251001';
const ENRICH_BATCH_SIZE = 150;
const PASSAGE_GENERATION_MAX_ATTEMPTS = 2;
```

パッセージ 1 回あたり概算: 入力 2,000–3,500 + 出力 800–2,000（cache read で入力削減）

---

## 6. コスト要因チェックリスト（現状）

| # | 要因 | 状態 |
|---|------|------|
| 1 | Sonnet 3×リトライ | **解消**（span 補正 + 2 上限） |
| 2 | prefetch 過剰 | **1 本に削減** |
| 3 | prompt caching なし | **導入済み** |
| 4 | enrich 全件再実行 | **差分方式** |
| 5 | token 未記録 | **token_usage あり** |
| 6 | hybrid Sonnet 頻発 | 設計どおり（要監視） |
| 7 | GAS 4 秒タイムアウト | ローカル fallback（トークン節約、UX トレードオフ） |

---

## 7. 計測手順

1. Script Property `TOKEN_USAGE_SINCE_ISO` をデプロイ時刻に設定
2. `reportTokenUsageSinceDeploy()` — ベースライン
3. 読書 2–3 パッセージ
4. 再実行 — `retry_1`/`retry_2` が 0 に近いか確認

代替: `reportTokenUsageLastHour()`（設定不要）

診断: `debugPassageValidationSample('B1')` — span 補正前後

---

## 8. `token_usage` スキーマ

| purpose 例 | 説明 |
|-----------|------|
| `passage` | リアルタイム / warmup の Sonnet 生成 |
| `warmup` | 夜間 warmup（passage 同系） |
| `critique` | Haiku 品質採点 |
| `enrich_ja` / `enrich_en` | Haiku enrich |

`retry_index`: 同一 `generateDynamicPassageClaude_` ループ内の試行番号（0=初回）。

---

## 9. 関連ファイル

| ファイル | 内容 |
|---------|------|
| `gas/Code.gs` | API 呼び出し・計測・span 補正 |
| `src/lib/config.js` | `PREFETCH_QUEUE_SIZE=1` |
| `docs/claude-api.md` | プロンプト・検証詳細 |

---

*最終更新: 2026-06-22 — 個別評価改修・先読み 1 本・計測結果反映*
