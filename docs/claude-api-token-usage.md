# Claude API トークン利用量 — 相談用サマリー

> **作成日:** 2026-06-22  
> **目的:** Anthropic コンソールで想定より多いトークン消費が観測されたため、Claude（Web/API）と相談するための事実整理  
> **ソース:** `gas/Code.gs`（現行実装）、運用ドキュメント、Anthropic コンソール観測値

---

## 0. 相談したいこと

1. **観測された利用量は、このアプリの想定運用として妥当か**
2. **コストを下げる余地があるか**（モデル選択・バッチサイズ・プロンプト短縮・キャッシュ優先の強化など）
3. **2026-06-21 のプロンプトリニューアル後の一括ジョブ**（enrich 再実行・テンプレ再生成）が、一時的なスパイクの主因かどうかの見立て

---

## 1. 観測された利用量（Anthropic コンソール）

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
| チャンク総数 | **7,125 件**（`chunks_master`） |
| 固定テンプレ | 45 本（手書き。Sonnet 再生成予定） |

**重要:** コードは API レスポンスの `usage`（input/output tokens）を **記録していない**。コンソール以外にアプリ内のトークン計測はない。

---

## 3. モデル定数と max_tokens

```javascript
// gas/Code.gs L48-58
const MODEL_PASSAGE  = 'claude-sonnet-4-6';
const MODEL_CRITIQUE = 'claude-haiku-4-5-20251001';
const MODEL_ENRICH   = 'claude-haiku-4-5-20251001';

const ENRICH_BATCH_SIZE      = 150;   // 1 API 呼び出しあたりの件数
const ENRICH_JA_MAX_TOKENS   = 64000; // Haiku 出力上限
const ENRICH_EN_MAX_TOKENS   = 64000;
```

| 用途 | 関数 | モデル | max_tokens（出力上限） | 1回あたりの件数 |
|------|------|--------|----------------------|----------------|
| 動的パッセージ生成 | `callClaudeGeneratePassage_()` | Sonnet 4.6 | **4,096** | 1 パッセージ |
| 品質 critique | `callClaudeCritiquePassage_()` | Haiku 4.5 | **2,048** | 1 パッセージ |
| 日本語訳 + 例文 enrich | `callClaudeEnrich_()` | Haiku 4.5 | **64,000** | **150 チャンク** |
| 英語グロス enrich | `callClaudeEnrichEnglish_()` | Haiku 4.5 | **64,000** | **150 チャンク** |

> **注意:** `docs/claude-api.md` には enrich バッチサイズ **625 件/回** と記載されているが、**現行コードは 150 件/回**。ドキュメントと実装が不一致。

---

## 4. API 呼び出し経路一覧

### 4.1 リアルタイム（ユーザー読書時）

**トリガー:** フロント → GAS `doPost` → `buildPassageForUser_()`

**モード:** Script Property `USE_DYNAMIC_PASSAGES`

| 値 | 挙動 | API コスト |
|----|------|-----------|
| `hybrid`（**デフォルト**） | キャッシュ → テンプレ → 条件付き Sonnet | 条件付き |
| `true` | 常に Sonnet 優先（失敗時テンプレ） | **高** |
| `false` / `template` | テンプレのみ（Claude 失敗時のみフォールバック） | **低** |

**hybrid で Sonnet が呼ばれる条件**（`needsNewPassageContext_()`）:

```
キャッシュに該当なし
  AND テンプレでカバーできない
  AND 選択チャンクのいずれかが:
    - progress 未登録（new）
    - srs_stage === 0
    - distinct_passages_count < 3  ← 文脈が足りないチャンク
```

**1回のパッセージ要求で Sonnet が呼ばれた場合:**

| ステップ | API 呼び出し | 最大回数 |
|---------|-------------|---------|
| 生成 | `callClaudeGeneratePassage_()` (Sonnet) | **3 回**（検証失敗でリトライ） |
| critique | なし（リアルタイム経路では呼ばない） | 0 |

**入力プロンプトの規模（概算）:**

| 要素 | 概算トークン |
|------|-------------|
| `PASSAGE_SYSTEM_PROMPT_` | ~1,500–2,000（約60行の system） |
| user: CEFR・チャンク 2–4 個・`intended meaning` | ~200–500 |
| user: `getChunkPriorContexts_()` 各チャンク最大3件 | ~100–600（チャンク数・履歴次第） |
| **入力合計（1回）** | **~2,000–3,500** |
| **出力（1回）** | パッセージ JSON + 和訳 + self_check → **~800–2,000**（max 4,096） |

**最悪ケース（3リトライ全部失敗後フォールバック）:** Sonnet × 3 ≈ **6,000–16,000 トークン/要求**

---

### 4.2 バックグラウンド（手動 GAS 関数）

| 関数 | Sonnet 呼び出し | Haiku 呼び出し | 備考 |
|------|----------------|---------------|------|
| `enrichAllTranslations()` | 0 | 1回/150件、自動継続 | ja + example_sentence |
| `enrichAllEnglishGlosses()` | 0 | 1回/150件、自動継続 | en グロス |
| `generateTemplateBatch_(band, count)` | count 回 | count 回（critique） | count 最大 5 |
| `warmupPassagesForBand_(band, count)` | 最大 3×count 回 | 最大 3×count 回 | critique 不合格で再生成 |
| `generatePassageWithCritique_(...)` | 最大 3 回/パッセージ | 最大 3 回/パッセージ | 内部ループ |

---

### 4.3 enrich バッチの詳細（Haiku 大量消費の主因候補）

**実行フロー:**

```
enrichAllTranslations()
  → enrichAllTranslationsRun_()
    → runEnrichJob_()  // 1 GAS 実行あたり最大 4.5 分
      → enrichTranslationsBatch_(150)  // 150件ずつ
        → callClaudeEnrich_()
          → fetchEnrichBatchResults_()
            → callClaudeEnrichWithSplitRetry_()  // 失敗時は半分に分割再試行
```

**自動継続:**

| 定数 | 値 | 意味 |
|------|-----|------|
| `ENRICH_SOFT_LIMIT_MS` | 4.5 分 | 1 GAS 実行のソフトリミット |
| `ENRICH_BATCH_RESERVE_MS` | 2.5 分 | 次バッチ開始に必要な残り時間 |
| `ENRICH_CONTINUE_DELAY_MS` | 30 秒 | 未完時の次実行までの待機 |
| `ENRICH_SAFETY_CONTINUE_MS` | 6.5 分 | タイムアウト安全トリガー |

→ 実質 **1 GAS 実行あたり 1 バッチ（150件）** が多く、完了まで **30秒間隔で自動再実行**。

**リトライによる増幅:**

1. **分割リトライ:** バッチ失敗時、150件 → 75+75 に分割（`ENRICH_MIN_SPLIT_SIZE = 50` 未満では分割しない）
2. **欠落リトライ:** レスポンスに含まれなかった `chunk_id` を最大 **3 回** 再送
3. **max_tokens 切れ:** `stop_reason === 'max_tokens'` 時は警告ログのみ（バッチサイズ縮小を推奨するエラーメッセージあり）

**全件 enrich の API 呼び出し回数（理論最小）:**

| ジョブ | 件数 | バッチサイズ | 最小 API 呼び出し数 |
|--------|------|-------------|-------------------|
| ja enrich | 7,125 | 150 | **48 回** |
| en enrich | 7,125 | 150 | **48 回** |
| **合計** | | | **96 回**（リトライ・分割なしの場合） |

**enrich 1 回あたりのプロンプト規模（概算）:**

| 要素 | 概算トークン |
|------|-------------|
| 指示文（`buildJaEnrichPayload_` / `buildEnEnrichPayload_`） | ~400–600 |
| 入力 JSON（150 件 × chunk_id, text, type 等） | ~3,000–8,000 |
| **入力合計** | **~4,000–9,000** |
| **出力（150件の翻訳+例文 or グロス）** | **~5,000–30,000**（max 64,000） |

**全 ja enrich 理論最小（リトライなし）:** 48 × (7,000 input + 15,000 output) ≈ **~100 万トークン**  
**全 en enrich 追加:** 同程度 → **合計 ~200 万トークン**（初回フル実行時）

---

### 4.4 パッセージ生成 + critique（Sonnet + Haiku ペア）

**`generatePassageWithCritique_()` のループ（最大 3 試行）:**

```
試行ごとに:
  1. callClaudeGeneratePassage_()     → Sonnet
  2. validatePassageChunks_()         → ローカル（API なし）
  3. validatePassageQuality_()        → ローカル
  4. callClaudeCritiquePassage_()     → Haiku
  5. critiquePasses_() が false なら revision_hint 付きで再試行
```

**critique 不合格時:** Sonnet + Haiku が **もう1セット**（最大 3 セット = Sonnet 3 + Haiku 3）

**1 パッセージ成功時の概算:**

| | 入力 | 出力 |
|--|------|------|
| Sonnet 生成 ×1 | ~3,000 | ~1,500 |
| Haiku critique ×1 | ~1,500（パッセージ全文+和訳+チャンク情報） | ~300 |
| **合計** | ~4,500 | ~1,800 |

---

## 5. API を呼ばない経路（コストゼロ）

| 経路 | 条件 |
|------|------|
| Drive キャッシュ | `findCachedPassage_()` で chunks の組み合わせが一致 |
| 固定テンプレ 45 本 | `pickTemplatePassage_()` / `pickTemplateCoveringChunks_()` |
| ローカルテンプレ（フロント） | GitHub Pages 上の `shared/passage-templates.json`（GAS 経由なし） |
| 検証・採点 | `validatePassageChunks_`, `validatePassageQuality_`, `validatePassageSelfCheck_` |

---

## 6. 2026-06 プロンプトリニューアル後の運用状態

2026-06-21 に以下が実行済み・進行中（`docs/claude-api.md` より）:

| ステップ | 状態 | トークン影響 |
|---------|------|-------------|
| `preparePromptRenewalRefresh()` | ✅ 完了 | 7,125 行の ja/en/example をクリア → **enrich 全件再実行が必要** |
| `enrichAllTranslations()` | 🔄 実行中/待ち | Haiku **~100万トークン規模** |
| `enrichAllEnglishGlosses()` | ⬜ ja 完走後 | Haiku **~100万トークン規模** |
| `generateTemplateBatch_()` | ⬜ 予定 | Sonnet + Haiku × 最大5本/バンド |
| 固定テンプレ 45 本 Sonnet 差し替え | ⬜ 予定 | Sonnet + Haiku × 45本（critique 込みで最大 3倍） |

**モデル変更（リニューアル前 → 後）:**

| 用途 | 変更前 | 変更後 |
|------|--------|--------|
| パッセージ生成 | Haiku 4.5 | **Sonnet 4.6** ← 単価・消費量ともに大幅増 |
| critique | なし | Haiku 4.5（新規） |
| enrich | Haiku 4.5 | Haiku 4.5（維持） |

→ **パッセージ生成の Sonnet 昇格** と **enrich 全件再実行** が、コスト増の主要因候補。

---

## 7. 観測値との照合（ざっくり試算）

### 7.1 1時間バケット 468,034 トークンの内訳

| モデル | 観測 | 想定される主な発生源 |
|--------|------|---------------------|
| Sonnet 368,849 | ~79% | 動的パッセージ生成（hybrid/dynamic）、`generateTemplateBatch_`、`warmupPassagesForBand_`、リトライ |
| Haiku 99,185 | ~21% | `enrichAllTranslations` / `enrichAllEnglishGlosses`、critique |

### 7.2 Sonnet 368k の分解例

| シナリオ | 1回あたり | 回数 | 合計 |
|---------|----------|------|------|
| パッセージ生成（成功1回） | ~5,000 | 74 回 | ~370k |
| パッセージ生成（3リトライ） | ~15,000 | 25 回 | ~375k |
| テンプレバッチ 5本 × 3バンド | ~5,000×15 | 15 回 | ~75k |

→ **1時間に Sonnet 生成 70–90 回** 相当。enrich 単体では Sonnet は増えない。

### 7.3 Haiku 99k の分解例

| シナリオ | 1回あたり | 回数 | 合計 |
|---------|----------|------|------|
| enrich バッチ（150件） | ~20,000 | 5 回 | ~100k |
| critique のみ | ~2,000 | 50 回 | ~100k |

→ **enrich が 4–5 バッチ進んだ1時間**、または **critique 多数** のどちらか（または併用）と整合的。

---

## 8. コスト増幅要因チェックリスト

| # | 要因 | 影響 | 確認方法 |
|---|------|------|---------|
| 1 | `enrichAllTranslations()` 実行中 | Haiku 大量・自動継続 | GAS 実行ログ・トリガー一覧 |
| 2 | `USE_DYNAMIC_PASSAGES=true` | 毎リクエスト Sonnet | Script Properties |
| 3 | `distinct_passages_count < 3` のチャンクが多い | hybrid でも Sonnet 頻発 | user_progress シート |
| 4 | 生成リトライ（最大3回） | Sonnet ×3 | GAS ログ "Generated passage failed" |
| 5 | critique ループ（warmup/テンプレ） | Sonnet + Haiku ×最大3 | `generatePassageWithCritique_` ログ |
| 6 | enrich 分割・欠落リトライ | Haiku 呼び出し増 | "retrying as two halves" / "retrying N missing" |
| 7 | `preparePromptRenewalRefresh()` 後の初回 enrich | 全7,125件 ×2（ja+en） | 運用タイムライン |
| 8 | コンソール利用（Claude.ai）混在 | API 以外のトークン含む | コンソール注記参照 |

---

## 9. Claude に相談したい具体的な質問

1. **enrich バッチサイズ 150 vs 625:** 現行 150 は GAS 6分制限対策。625 に戻すと1回あたりのトークン効率は上がるがタイムアウトリスクが増える。最適バッチサイズの目安は？
2. **enrich の max_tokens 64,000:** 150件で過剰か。実出力に合わせて下げるべきか（切れリスクとのトレードオフ）。
3. **Sonnet 昇格の ROI:** パッセージ品質向上に対し、Haiku 維持 + critique 強化の方がコスト効率が良いか。
4. **hybrid の `distinct_passages_count < 3` 閾値:** この条件が Sonnet 呼び出しを増やしすぎていないか。閾値を下げる（例: < 2）か、warmup を先に回すべきか。
5. **全件 enrich の代替:** 7,125件を毎回フル再生成するのではなく、差分のみ enrich する設計にすべきか。
6. **トークン計測:** GAS で `body.usage` をログ/シートに記録する最小実装の推奨。
7. **観測値 468k/時間の妥当性:** 上記運用（リニューアル直後の enrich + 読書）と整合するか。

---

## 10. 関連ファイル

| ファイル | 内容 |
|---------|------|
| `gas/Code.gs` | 全 API 呼び出し・定数・バッチジョブ |
| `docs/claude-api.md` | プロンプト全文・検証アーキテクチャ（バッチサイズ記載は要更新） |
| `docs/claude-api-prompt-renewal-work-request.md` | 2026-06 リニューアル設計（Sonnet 昇格の根拠） |
| `docs/setup.md` | enrich 手動実行手順 |
| `docs/product-overview.md` | 運用状態・チャンク数 |

---

## 11. 補足: API レスポンスの usage フィールド（未実装）

Anthropic Messages API はレスポンスに以下を返すが、現行コードは **破棄している**:

```json
{
  "usage": {
    "input_tokens": 1234,
    "output_tokens": 567
  }
}
```

`callAnthropicJson_()` / `fetchAnthropicEnrichArray_()` は `body.content[0].text` のみ使用。  
コスト監視には `usage` のログ記録追加が有効。
