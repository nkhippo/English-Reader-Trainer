# Claude API トークン利用量 — 相談用サマリー

> **初版:** 2026-06-22  
> **最終更新:** 2026-06-22（本チャットでの計測・修正反映）  
> **目的:** Anthropic コンソールで想定より多いトークン消費が観測された問題について、事実整理・対応経緯・現状を Claude と相談するためのドキュメント  
> **ソース:** `gas/Code.gs`（現行実装）、`token_usage` シート、`reportTokenUsage*` 実行ログ、Anthropic コンソール観測値

**現行 GAS Web App:**  
`https://script.google.com/macros/s/AKfycbwF-TlzAlKx4syPKfrzUmPKlvxhDiAHbM2YKQ0DGkcMqSXUnvGwyU0Y5V9xGhNNwboV/exec`

---

## 0. 相談したいこと（更新版）

### 当初（問題提起時）

1. **観測された利用量は、このアプリの想定運用として妥当か**
2. **コストを下げる余地があるか**（モデル選択・バッチサイズ・プロンプト短縮・キャッシュ優先の強化など）
3. **2026-06-21 のプロンプトリニューアル後の一括ジョブ**（enrich 再実行・テンプレ再生成）が、一時的なスパイクの主因かどうかの見立て

### 今後（対応後に相談したいこと）

4. **Sonnet 3×リトライ問題はほぼ解消したが、残り 1 回のリトライをさらに減らす余地はあるか**（検証ルール緩和 vs プロンプト改善 vs モデル変更）
5. **prefetch（先読み 3 本）が `retry_0` を増やす構造** — 読書体験とコストのバランス（`PREFETCH_QUEUE_SIZE=3`、`clearPrefetch` on advance）
6. **プロンプトキャッシュは効いている**（`cache_read_input_tokens` 観測）— さらにキャッシュヒット率を上げる設計は？
7. **差分 enrich（`enrich_version`）導入後** — 全件再 enrich を避けた運用で十分か
8. **読書時の GAS 応答 4 秒超** — タイムアウトフォールバックは UX 上許容か、Sonnet 生成をさらに避けるべきか
9. **長期的なモデル戦略** — パッセージ生成を Sonnet 4.6 のまま維持する ROI（Haiku + 強 critique との比較）

---

## 1. 観測された利用量（Anthropic コンソール — 問題提起時点）

| 時刻 (UTC) | モデル | トークン数 |
|-----------|--------|-----------|
| 2026-06-22 02:00 | `claude-sonnet-4-6` | 368,849 |
| 2026-06-22 02:00 | `claude-haiku-4-5-20251001` | 99,185 |
| **合計（1時間バケット）** | | **468,034** |

- コンソール注記: 「APIとConsoleの両方の使用量を含みます」
- Sonnet が全体の **約 79%** を占める
- Haiku は 02:00 前後から顕著（12:00 UTC 台ではほぼ Sonnet のみ）

**このアプリは上記2モデルを直接使用している**（`gas/Code.gs` でハードコード）。フロントエンド（React）から API を直接呼ぶ経路はない。

---

## 2. アプリ概要（トークンに関わる部分）

| 項目 | 値 |
|------|-----|
| アプリ名 | English Reader Trainer |
| バックエンド | Google Apps Script (GAS) Web App |
| API キー | Script Property `ANTHROPIC_API_KEY` |
| エンドポイント | `https://api.anthropic.com/v1/messages` |
| API バージョン | `anthropic-version: 2023-06-01` |
| Prompt caching | `anthropic-beta: prompt-caching-2024-07-31`（2026-06-22 導入） |
| チャンク総数 | **7,125 件**（`chunks_master`） |
| 固定テンプレ | 45 本（手書き。Sonnet 再生成予定） |
| トークン計測 | **`token_usage` シート + `logTokenUsage_()`**（2026-06-22 導入。以前は未記録） |

**計測用 Script Property:** `TOKEN_USAGE_SINCE_ISO`（例: `2026-06-22T20:30:00+09:00`）  
**計測用 GAS 関数:** `reportTokenUsage()` / `reportTokenUsageLastHour()` / `reportTokenUsageSinceDeploy()` / `reportTokenUsageDetail(iso)`

---

## 3. モデル定数と max_tokens

```javascript
// gas/Code.gs
const MODEL_PASSAGE  = 'claude-sonnet-4-6';
const MODEL_CRITIQUE = 'claude-haiku-4-5-20251001';
const MODEL_ENRICH   = 'claude-haiku-4-5-20251001';

const ENRICH_BATCH_SIZE      = 150;
const ENRICH_JA_MAX_TOKENS   = 64000;
const ENRICH_EN_MAX_TOKENS   = 64000;
const ENRICH_PROMPT_VERSION  = 1;  // 差分 enrich 用（2026-06-22）
```

| 用途 | 関数 | モデル | max_tokens（出力上限） | 1回あたりの件数 |
|------|------|--------|----------------------|----------------|
| 動的パッセージ生成 | `callClaudeGeneratePassage_()` | Sonnet 4.6 | **4,096** | 1 パッセージ |
| 品質 critique | `callClaudeCritiquePassage_()` | Haiku 4.5 | **2,048** | 1 パッセージ |
| 日本語訳 + 例文 enrich | `callClaudeEnrich_()` | Haiku 4.5 | **64,000** | **150 チャンク** |
| 英語グロス enrich | `callClaudeEnrichEnglish_()` | Haiku 4.5 | **64,000** | **150 チャンク** |

> **注意:** `docs/claude-api.md` には enrich バッチサイズ **625 件/回** と記載されているが、**現行コードは 150 件/回**（GAS 6 分制限対策）。

---

## 4. API 呼び出し経路一覧

### 4.1 リアルタイム（ユーザー読書時）

**トリガー:** フロント → GAS `doPost` → `buildPassageForUser_()`

**モード:** Script Property `USE_DYNAMIC_PASSAGES` = **`hybrid`**（運用中）

**hybrid で Sonnet が呼ばれる条件**（`needsNewPassageContext_()`）:

```
キャッシュに該当なし
  AND テンプレでカバーできない
  AND 選択チャンクのいずれかが:
    - progress 未登録（new）
    - srs_stage === 0
    - distinct_passages_count < 3
```

**フロントの prefetch（コストに影響）:**

| 定数 | 値 | 影響 |
|------|-----|------|
| `PREFETCH_QUEUE_SIZE` | 3 | 読書中にバックグラウンドで最大 3 本 `generate_passage` |
| `ADVANCE_GAS_TIMEOUT_MS` | 3500 | 先読みが間に合わないとリモート生成が 4 秒でタイムアウト |
| `onBeforeAdvance` | `clearPrefetch()` | 「理解した」ごとに先読みキューをクリア → 再 prefetch |

→ **`retry_0` の多くは本番 1 回 + prefetch 並列** の合算になりうる。

**1回のパッセージ要求で Sonnet が呼ばれた場合（修正後）:**

| ステップ | API 呼び出し | 最大回数 |
|---------|-------------|---------|
| 生成 | `callClaudeGeneratePassage_()` (Sonnet) | **3 回**（検証失敗でリトライ） |
| critique | なし（リアルタイム経路では呼ばない） | 0 |

**入力プロンプトの規模（概算）:**

| 要素 | 概算トークン |
|------|-------------|
| `PASSAGE_SYSTEM_PROMPT_`（キャッシュ対象） | ~1,500–2,000 |
| user: CEFR・チャンク 2–4 個 | ~200–500 |
| user: `getChunkPriorContexts_()` | ~100–600 |
| **入力合計（1回）** | **~2,000–3,500** |
| **出力（1回）** | **~800–2,000**（max 4,096） |

**修正前の最悪ケース:** 検証失敗のたびに Sonnet ×3 が **ほぼ毎回** 発生（後述 §12）。

---

### 4.2 バックグラウンド（手動 GAS 関数）

| 関数 | Sonnet 呼び出し | Haiku 呼び出し | 備考 |
|------|----------------|---------------|------|
| `enrichAllTranslations()` | 0 | 1回/150件、自動継続 | ja + example_sentence |
| `enrichAllEnglishGlosses()` | 0 | 1回/150件、自動継続 | en グロス |
| `generateTemplateBatch_(band, count)` | count 回 | count 回（critique） | count 最大 5 |
| `runNightlyWarmup_()` | 最大 3×count 回 | なし（リアルタイム同様） | 夜間トリガー（2026-06-22 追加） |
| `generatePassageWithCritique_(...)` | 最大 3 回/パッセージ | 最大 3 回/パッセージ | テンプレ/warmup 用 |

---

### 4.3 enrich バッチの詳細（Haiku 大量消費の主因候補）

**全件 enrich の API 呼び出し回数（理論最小）:**

| ジョブ | 件数 | バッチサイズ | 最小 API 呼び出し数 |
|--------|------|-------------|-------------------|
| ja enrich | 7,125 | 150 | **48 回** |
| en enrich | 7,125 | 150 | **48 回** |
| **合計** | | | **96 回**（リトライ・分割なしの場合） |

**全 ja+en enrich 理論最小（リトライなし）:** 合計 **~200 万トークン**（初回フル実行時）

**2026-06-22 以降:** `enrich_version` 列 + `ENRICH_PROMPT_VERSION` により、**プロンプト変更時のみ差分 re-enrich**（`preparePromptRenewalRefresh()` は全件クリアしない）。

---

### 4.4 パッセージ生成 + critique（Sonnet + Haiku ペア）

オフライン（テンプレバッチ・warmup）のみ。リアルタイム読書では critique なし。

---

## 5. API を呼ばない / コスト削減経路

| 経路 | 条件 | 導入時期 |
|------|------|---------|
| Drive キャッシュ（完全一致） | `findCachedPassage_()` | 既存 |
| Drive キャッシュ（スーパーセット） | `findCachedPassageContainingChunks_()` | 2026-06-22 |
| 固定テンプレ 45 本 | `pickTemplatePassage_()` 等 | 既存 |
| ローカルテンプレ（フロント） | `passage-templates.json` | 既存 |
| プロンプトキャッシュ | `cache_control: ephemeral` on system blocks | 2026-06-22 |
| ローカル検証 | `validatePassageChunks_` 等（API なし） | 既存 |

---

## 6. 2026-06 プロンプトリニューアル後の運用状態

| ステップ | 状態（2026-06-22 時点） | トークン影響 |
|---------|----------------------|-------------|
| `preparePromptRenewalRefresh()` | ✅ 完了（差分 enrich 方式に変更） | 全件クリアしない |
| `migrateChunksAddEnrichVersionColumn()` | ✅ 実行済み | — |
| `enrichAllTranslations()` | 手動のみ（読書 UX からは呼ばれない） | Haiku（差分のみ） |
| `enrichAllEnglishGlosses()` | 同上 | Haiku（差分のみ） |
| `setupNightlyWarmupTrigger()` | 設定可能 | Sonnet（夜間キャッシュ温め） |
| 固定テンプレ 45 本 Sonnet 差し替え | ⬜ 未実施 | 将来の Sonnet バッチ |

**モデル変更（リニューアル前 → 後）:**

| 用途 | 変更前 | 変更後 |
|------|--------|--------|
| パッセージ生成 | Haiku 4.5 | **Sonnet 4.6** |
| critique | なし | Haiku 4.5（オフラインのみ） |
| enrich | Haiku 4.5 | Haiku 4.5（維持） |

---

## 7. 観測値との照合（問題提起時の試算）

### 7.1 1時間バケット 468,034 トークンの内訳（コンソール）

| モデル | 観測 | 想定される主な発生源 |
|--------|------|---------------------|
| Sonnet 368,849 | ~79% | 動的パッセージ生成、**3×リトライ増幅**、prefetch、warmup |
| Haiku 99,185 | ~21% | enrich バッチ、critique |

### 7.2 当時の仮説（後に `token_usage` で裏付け）

- Sonnet の大半は **パッセージ生成の 3 回リトライ** が主因
- `retry_0` / `retry_1` / `retry_2` が **ほぼ同数**（例: 36/36/36、47/47/47）→ 毎生成が 3 回 API を叩いていた
- 根本原因: Claude が返す `char_start` / `char_end` の誤報告 + 活用形不一致（`have` → `had` 等）

---

## 8. コスト増幅要因チェックリスト

| # | 要因 | 影響 | 状態（2026-06-22） |
|---|------|------|-------------------|
| 1 | `enrichAllTranslations()` 実行中 | Haiku 大量 | 手動のみ。差分 enrich 導入済み |
| 2 | `USE_DYNAMIC_PASSAGES=true` | 毎リクエスト Sonnet | **hybrid** で運用中 |
| 3 | `distinct_passages_count < 3` | hybrid でも Sonnet 頻発 | 設計どおり（要相談） |
| 4 | 生成リトライ（最大3回） | Sonnet ×3 | **§12 で大幅改善** |
| 5 | critique ループ（warmup/テンプレ） | Sonnet + Haiku ×最大3 | オフラインのみ |
| 6 | enrich 分割・欠落リトライ | Haiku 呼び出し増 | 未変更 |
| 7 | `preparePromptRenewalRefresh()` 後の enrich | 全件再実行 | **差分方式に変更済み** |
| 8 | prefetch 3 本並列 | `retry_0` 増 | **未対応**（要相談） |
| 9 | プロンプトキャッシュなし | 入力トークン重複 | **導入済み** |
| 10 | トークン未記録 | 原因特定困難 | **`token_usage` 導入済み** |

---

## 9. 本チャット（2026-06-22）で実施した対応

### Phase 1 — 計測基盤

- `token_usage` シート追加（列: `ts`, `model`, `purpose`, `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `retry_index`）
- 全 Claude API 呼び出しで `recordAnthropicUsage_()` を記録
- `reportTokenUsage*` 系の集計関数を GAS エディタから実行可能に

### Phase 2.1 — プロンプトキャッシュ

- `anthropic-beta: prompt-caching-2024-07-31`
- `PASSAGE_SYSTEM_PROMPT_` と critique 固定部に `cache_control: ephemeral`
- 観測: 多くの passage 呼び出しで `cache_read_input_tokens: 1154` 前後

### Phase 2.2 — キャッシュヒット強化

- `findCachedPassageContainingChunks_()` — 要求チャンクのスーパーセットキャッシュを再利用
- `setupNightlyWarmupTrigger()` / `runNightlyWarmup_()` — 夜間 warmup

### Phase 2.3 — 3×リトライ修正（最重要）

| 関数 | 役割 |
|------|------|
| `repairPassageTargetChunkSpans_()` | 本文からチャンク位置を再検索し `char_start`/`char_end` を補正 |
| `findChunkSpanInPassage_()` | 完全一致 + 複数語チャンクの先頭語活用許容（`have an opinion on` → `had an opinion on`） |
| `describePassageQualityFailure_()` | 失敗理由の具体化 |
| `logPassageGenerationFailure_()` | リトライごとに実行ログ出力 |
| `debugPassageValidationSample(band)` | 補正前後の検証を 1 ショット診断 |

**診断例（修正前）:** `have an opinion on` / `vitally` — `would_pass_after_repair: false`  
**診断例（修正後）:** `portion` / `plan ahead` — `failures_after_repair: []`, `would_pass_after_repair: true`

### Phase 3 — 差分 enrich

- `chunks_master.enrich_version` 列
- `ENRICH_PROMPT_VERSION = 1`
- `preparePromptRenewalRefresh()` は翻訳全消去せず、バージョン不一致行のみ re-enrich

### デプロイ

- GAS エディタへの貼り付けが 3000 行超で失敗 → **clasp push** で同期
- Script ID: `1ROQTY7sEJxCZvzytE_dCdJmTkvsNk2f96FHKguX9Jr4a1MJjIixNI0TW`
- GitHub `main` に GAS URL・`Code.gs` を反映（最新コミット `90e3f11` 付近）

---

## 10. 現状のトークン利用状況（`token_usage` 実測）

**計測条件:** Script Property `TOKEN_USAGE_SINCE_ISO` = `2026-06-22T20:30:00+09:00`（最新デプロイ以降）

### 10.1 リトライ回数の推移

| 時期 | retry_0 | retry_1 | retry_2 | 解釈 |
|------|---------|---------|---------|------|
| 修正前（例） | 36 | 36 | 36 | **毎生成が 3 回 API** — 検証失敗で常にフルリトライ |
| 修正直後（20:20〜） | 5 | 2 | 3 | 改善傾向だがまだリトライあり |
| **最新（20:30〜、読書テスト後）** | **9** | **1** | **0** | **9 回の生成のうち余分な API は 1 回のみ** |

`rows_in_window: 10` = 9 + 1 = 10 API 呼び出し（purpose=`passage`, model=Sonnet）

**`retry_index` の意味:**

| 値 | 意味 |
|----|------|
| 0 | その `generate_passage` 要求における 1 回目の Sonnet 呼び出し |
| 1 | 同一要求内の 2 回目（1 回目が検証失敗） |
| 2 | 同一要求内の 3 回目 |

別の HTTP リクエスト（本番・prefetch 各々）はそれぞれ `retry_index=0` から開始。

### 10.2 効果の定量イメージ

| 指標 | 修正前 | 修正後（最新） |
|------|--------|---------------|
| 1 生成あたり平均 Sonnet 呼び出し | ~3.0 回 | ~1.1 回（10÷9） |
| 3 回目まで失敗 | 頻発 | **0 件**（retry_2=0） |
| プロンプトキャッシュ | なし | 入力の大部分が cache read |

→ **Sonnet コストの最大要因だった 3×増幅はほぼ解消。** 残りは prefetch 並列・稀な検証失敗・GAS 応答遅延。

### 10.3 読書 UX 上の観測（トークンとは別件）

ブラウザコンソールに時々:

```
[ERT] remote next passage timed out after 4000ms
[ERT] action lock timed out — recovering
```

- 先読みが間に合わず GAS 生成が 4 秒超 → ローカルテンプレにフォールバック
- 10 秒でアクションロック自動復帰（読書は継続可能）
- **トークン削減とはトレードオフ**（prefetch が Sonnet を先に呼ぶ）

---

## 11. Claude に相談したい具体的な質問（更新版）

### 解決済み・効果確認できた点

1. ~~トークン計測の最小実装~~ → `token_usage` 導入済み
2. ~~3×リトライの主因~~ → `char_start`/`char_end` 補正 + 活用形マッチで解消
3. ~~全件 enrich の代替~~ → `enrich_version` 差分方式導入済み

### 今後相談したい点

1. **残り 1 回のリトライ（9 回中 1 回）** — どの検証ルールがまだ落としているか。実行ログの `Passage attempt` パターンからさらに削るべきか。
2. **prefetch 3 本のコスト対効果** — `PREFETCH_QUEUE_SIZE` を 1 に下げる、または encounter 後にクリアしない設計の是非。
3. **Sonnet 4.6 維持の ROI** — 品質要件（CEFR i+1、チャンク整合）を満たす最小コストモデルは Sonnet か Haiku 4.5 か。
4. **プロンプトキャッシュの最大化** — system 以外にキャッシュ可能な固定ブロックはあるか。`cache_read` 比率をさらに上げる方法。
5. **enrich バッチ 150 vs 625** — GAS 6 分制限下での最適バッチと `max_tokens` 設定。
6. **hybrid の `distinct_passages_count < 3`** — Sonnet 呼び出し頻度を下げる閾値調整 vs nightly warmup の先行投入。
7. **468k/時間は妥当だったか** — 修正後の想定時間あたりコスト（読書 3–4 パッセージ/セッション）の目安。
8. **巨大 `output_tokens`（2000–3500）** — 検証失敗や JSON 肥大の扱い。`max_tokens` 上限を下げるべきか。

---

## 12. 関連ファイル

| ファイル | 内容 |
|---------|------|
| `gas/Code.gs` | 全 API 呼び出し・token 記録・span 補正・キャッシュ |
| `gas/.clasp.json.example` | clasp 同期用テンプレート |
| `gas/pbcopy-code.sh` | クリップボード経由の手動同期補助 |
| `src/lib/config.js` | GAS URL・prefetch・タイムアウト定数 |
| `src/hooks/usePassagePrefetch.js` | 先読みキュー |
| `docs/claude-api.md` | プロンプト全文・検証アーキテクチャ |
| `docs/setup.md` | デプロイ・enrich 手順 |

---

## 13. 補足: `token_usage` シートの列定義

```javascript
// SHEET_HEADERS.token_usage
['ts', 'model', 'purpose', 'input_tokens', 'output_tokens',
 'cache_creation_input_tokens', 'cache_read_input_tokens', 'retry_index']
```

| purpose 例 | 説明 |
|-----------|------|
| `passage` | リアルタイム / warmup の Sonnet 生成 |
| `enrich_ja` / `enrich_en` | Haiku enrich バッチ |
| `critique` | Haiku 品質採点（オフライン） |
| `warmup` | 夜間 warmup（passage と同系統） |

Anthropic API の `usage` オブジェクトをそのまま記録。プロンプトキャッシュ利用時は `cache_read_input_tokens` > 0 となる。
