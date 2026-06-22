# Claude API — モデル・プロンプト・検証（現行仕様）

> **最終更新:** 2026-06-21  
> **ソース:** `gas/Code.gs`（コミット `3a5c22a` 以降）  
> **設計根拠:** [claude-api-prompt-renewal-work-request.md](./claude-api-prompt-renewal-work-request.md)

---

## 0. Claude レビュー依頼（このドキュメントの目的）

English Reader Trainer は **SLA（第二言語習得）原理に基づくチャンク再会エンジン** です。2026-06 に Claude API のモデル・プロンプト・検証を全面リニューアルしました。

**レビューしてほしい観点:**

1. 3 プロンプト（パッセージ生成 / ja enrich / en enrich）が SLA 原理（i+1、noticing、encoding variability、コアミーニング、L2-L2 グロス）を十分に実装しているか
2. パッセージ生成の **prior_contexts 注入** が「異なる文脈で再会」の思想をプロンプトレベルで担保できているか
3. critique rubric（7 基準・合計 11 点以上）の妥当性
4. リアルタイム経路（高速 regex + self_check）とバックグラウンド経路（critique）の分離が UX と品質のバランスとして適切か
5. 固定テンプレ 45 本（手書き）を `generateTemplateBatch_()` で Sonnet 再生成する前に、プロンプトの追加改善余地

**運用ステータス（2026-06-21 時点）**

| ステップ | 状態 |
|---------|------|
| コード反映（`gas/Code.gs`） | ✅ 完了・デプロイ済み |
| `preparePromptRenewalRefresh()` | ✅ 実行済み（7,125 行クリア、critique 列追加） |
| `enrichAllTranslations()` | 🔄 **実行待ち / 実行中** |
| `enrichAllEnglishGlosses()` | ⬜ ja 完走後 |
| `generateTemplateBatch_()` | ⬜ enrich 完走後 |
| 固定テンプレ 45 本の差し替え | ⬜ サンプルレビュー後 |

**GAS Web App:** `https://script.google.com/macros/s/AKfycbydfzsGuLKFKHNVjnZhEDd-hLSYe0tJTDYv0EcovHRMRGZRJIPJzZxEa2mD4jGSKUv8/exec`

---

## 1. コンテンツと Claude の関係

| コンテンツ | 生成方法 | モデル | 状態 |
|-----------|---------|--------|------|
| `chunks_master.ja_translation` | `callClaudeEnrich_()` | Haiku 4.5 | 🔄 再生成中 |
| `chunks_master.en_translation` | `callClaudeEnrichEnglish_()` | Haiku 4.5 | ⬜ 待ち |
| `chunks_master.example_sentence` | ja enrich と同時 | Haiku 4.5 | 🔄 再生成中 |
| **動的パッセージ**（hybrid/dynamic） | `callClaudeGeneratePassage_()` | **Sonnet 4.6** | ✅ 新プロンプト |
| **critique 採点** | `callClaudeCritiquePassage_()` | Haiku 4.5 | ✅ オフラインのみ |
| **`shared/passage-templates.json`**（45 本） | **手書き**（Claude 未使用） | — | ⬜ Sonnet 再生成予定 |

---

## 2. モデル定数（`gas/Code.gs`）

```javascript
const MODEL_PASSAGE  = 'claude-sonnet-4-6';
const MODEL_CRITIQUE = 'claude-haiku-4-5-20251001';
const MODEL_ENRICH   = 'claude-haiku-4-5-20251001';
```

| 用途 | 定数 | max_tokens | バッチ |
|------|------|------------|--------|
| 動的パッセージ生成 | `MODEL_PASSAGE` | 4,096 | 1 本/回（最大 3 リトライ） |
| 品質 critique | `MODEL_CRITIQUE` | 2,048 | 1 本/回 |
| 日本語訳 enrich | `MODEL_ENRICH` | 64,000 | 625 件/回 |
| 英語グロス enrich | `MODEL_ENRICH` | 64,000 | 625 件/回 |

- エンドポイント: `https://api.anthropic.com/v1/messages`
- API バージョン: `anthropic-version: 2023-06-01`
- 認証: Script Property `ANTHROPIC_API_KEY`

---

## 3. SLA 原理とプロンプトの対応

| SLA 原理 | 実装箇所 |
|---------|---------|
| 理解可能 input（真の i+1） | パッセージ system §1、`selectChunksForPassage_`（new 最大 2 個） |
| 気づき（noticing） | `{{chunk}}` マークアップ + marginalia |
| 処理水準（具体性） | パッセージ system §4、ja enrich の具体例文指示 |
| **符号化の多様性** | **`getChunkPriorContexts_()` → user プロンプト注入** |
| 用法基盤 | パッセージ system §3（典型共起語） |
| コアミーニング | ja enrich（最頻出 1 語義）、`intended meaning` 注入 |
| L2-L2 マッピング | en enrich（グロス自体 i+1、循環定義禁止） |

---

## 4. プロンプト全文（現行・`Code.gs` 実装）

### 4.1 動的パッセージ生成 — `callClaudeGeneratePassage_()`

**system** (`PASSAGE_SYSTEM_PROMPT_`):

```
You are an expert writer of graded reading passages for Japanese learners of English. Your passages power a spaced-repetition reading app whose single goal is to automatize knowledge of multi-word chunks (phrasal verbs, collocations, idioms, discourse markers) through repeated encounters in DIFFERENT contexts.

Follow these principles without exception:

1. COMPREHENSIBLE INPUT (true i+1). The words AROUND the target chunks must be ones the learner already knows — at or below the stated CEFR band. The target chunks are the ONLY new or practiced element (the "+1"). Never place an unknown word next to a target chunk; the learner must be able to lean on known context.

2. INFERABILITY. For each target chunk, the situation must give concrete cues to its meaning, so a learner who does not yet know the chunk could reasonably guess it from context — without a dictionary.

3. NATURAL USE. Each chunk must appear in the grammatical frame and with the typical collocates a fluent writer would actually use. Never twist a sentence just to fit a chunk. If two chunks cannot co-occur naturally, prioritize naturalness and say so in self_check.

4. CONCRETE AND MEMORABLE. Write a vivid, specific scene — a particular person doing a particular thing in a particular place. Concrete, imageable situations are remembered far better than abstract statements. Never write generic filler such as "Many people think that..." or "In today's society...".

5. CONTEXTUAL VARIETY. You will be told how each chunk appeared in PREVIOUS passages. Make THIS passage genuinely different: a different scenario, different collocates, a different sentence structure. Reusing a prior context defeats the entire purpose of the app.

6. REGISTER BY CEFR BAND.
   - A1/A2: short concrete sentences; everyday scenes (home, shopping, travel, daily routine); present and past simple dominant.
   - B1: everyday plus light work and social topics; a wider range of connectors; some complex sentences.
   - B2: may include abstract or argumentative topics and a reporting register; richer cohesion.

Output ONLY valid JSON (no markdown fences), in exactly this shape:
{
  "text": "the passage as plain text",
  "ja_translation": "natural Japanese translation faithful to the English",
  "target_chunks": [
    {"chunk_id": "...", "text": "exact substring as it appears in text", "char_start": 0, "char_end": 0}
  ],
  "self_check": {
    "all_chunks_used_naturally": true,
    "surrounding_vocab_within_band": true,
    "each_chunk_inferable_from_context": true,
    "different_from_prior_contexts": true,
    "notes": "one short sentence; flag any compromise you had to make"
  }
}

char_start and char_end are 0-based, end-exclusive indices into the "text" field.
```

**user** (`buildPassageUserPrompt_()` — テンプレート):

```
CEFR band: {A1/A2 | B1 | B2}
Length: 3 to 6 sentences, 60 to 120 words total.

Target chunks (embed ALL of them, each at least once):

- "{chunk text}"  (chunk_id: {id})
    intended meaning: {ja_translation or en_translation from chunks_master}
    previously appeared as:          ← getChunkPriorContexts_() 最大 3 件
      • {prior snippet 1}
      • ...
    make this encounter clearly different from the above.
    — または初出時 —
    this is the learner's FIRST encounter — introduce it in an especially clear, self-explaining context.

Write the passage now.
Revision instruction: {revision_hint}   ← critique 再生成時のみ
```

**prior_contexts の取得:** `getChunkPriorContexts_(chunkId, index, 3)`  
`passages_meta` → Drive JSON → 該当チャンクを含む文を抽出。

---

### 4.2 品質 critique — `callClaudeCritiquePassage_()`（オフライン専用）

```
You are a strict reviewer of graded reading passages for CEFR {band} learners of English.
Score each criterion 0–2 (0 = fails, 1 = weak, 2 = good).

Passage: {text}
Japanese translation: {ja_translation}
Target chunks (with intended meaning + prior contexts): {chunkLines}

Criteria:
- naturalness
- comprehensibility
- inferability
- chunk_integrity
- variety
- concreteness
- translation_fidelity

Output ONLY JSON:
{
  "scores": { ... },
  "total": 0,
  "verdict": "pass" or "revise",
  "problems": ["..."],
  "revision_hint": "..."
}

Pass threshold: total >= 11 AND no single criterion scores 0.
```

**合格判定:** `critiquePasses_()` — 全基準 > 0、合計 ≥ 11、`verdict !== 'revise'`

---

### 4.3 日本語訳 enrich — `callClaudeEnrich_()`

```
You are a bilingual English–Japanese lexicographer creating entries for a chunk-learning app. For each item, provide:

- ja_translation: the CORE meaning in concise, natural Japanese. Capture the functional nucleus of the chunk, not a word-by-word gloss. If the chunk is polysemous, give the SINGLE most frequent sense only (the app stores one sense per chunk). Use 〜 to mark where words attach (e.g. "〜を引き受ける", "〜のおかげで").
- example_sentence: keep the existing one if it is provided and good; otherwise write ONE natural, CONCRETE sentence (8–18 words) showing the chunk in its most typical context — a specific situation the learner can picture, never a generic statement.

Keep the Japanese clear and natural for a general adult learner (avoid overly literary vocabulary).

Return ONLY a JSON array, no markdown:
[{"chunk_id":"...","ja_translation":"...","example_sentence":"..."}]

Items: ${JSON.stringify(input)}
```

---

### 4.4 英語グロス enrich — `callClaudeEnrichEnglish_()`

```
You are writing English-in-English glosses for a chunk-learning app used by Japanese learners. The gloss's job is to let a learner understand the item's meaning WITHOUT translating to Japanese — building a direct English-to-meaning pathway. Optimize for "a learner reads this and instantly gets it."

For each item, provide:
- en_translation: a short English gloss (about 6–15 words) capturing the single most frequent sense.

Rules the gloss MUST follow:
1. SIMPLER THAN THE HEADWORD. Use only words that are clearly easier than the item itself — roughly one to two CEFR levels below it.
2. NO CIRCULAR DEFINITION. Never use the headword or its derivatives in the gloss.
3. SHOW HOW IT IS USED, not just what it means. Include typical object or situation.
4. EVOKE A SITUATION. Prefer concrete action or scene over abstract dictionary phrase.
5. ONE SENSE ONLY. If polysemous, gloss only the most frequent sense.

If ja_translation is provided, use it only as private context. Write the gloss in English only.

Return ONLY a JSON array, no markdown:
[{"chunk_id":"...","en_translation":"..."}]

Items: ${JSON.stringify(input)}
```

---

## 5. 検証アーキテクチャ（2 経路）

| 経路 | タイミング | 生成 | 検証 | ユーザー体感 |
|------|-----------|------|------|-------------|
| **リアルタイム** | hybrid/dynamic 要求時 | Sonnet 1 発 | regex（文数・語数・位置・chunk 含有）+ `self_check` 真偽 | 低レイテンシ（1 往復） |
| **バックグラウンド** | warmup / テンプレバッチ | Sonnet | critique（Haiku）→ revise なら `revision_hint` 付き再生成 | ユーザーに非同期 |

### 5.1 リアルタイム検証

| 関数 | 内容 |
|------|------|
| `validatePassageChunks_()` | 全ターゲット chunk が本文に含まれる |
| `validatePassageQuality_()` | 文数 3–6、語数 40–140、位置情報一致 |
| `validatePassageSelfCheck_()` | `self_check` の 4 フラグが `false` でない |

### 5.2 キャッシュフィルタ（`findCachedPassage_()`）

- `critique_verdict=revise` → **除外**
- `critique_verdict=pass` → **優先**
- verdict 空（リアルタイム生成直後）→ fallback として使用可

### 5.3 チャンク選定 i+1 ガード（`selectChunksForPassage_()`）

```
1. new 1 個
2. learning (stage 1–3) 最大 2 個
3. reviewing (stage 4+) 最大 1 個
4. 不足 → due から既習優先（new 以外）
5. 不足 → new 2 個目まで（上限 2）
6. 不足 → テンプレ先頭 chunk_texts
```

---

## 6. GAS 手動関数一覧

| 関数 | 用途 |
|------|------|
| `preparePromptRenewalRefresh()` | ja/en/example 全クリア + passages キャッシュ削除 + critique 列追加 |
| `enrichAllTranslations()` | ja + example_sentence バッチ（625 件/回、自動継続） |
| `enrichAllEnglishGlosses()` | en バッチ（ja 完走後） |
| `auditTranslationCoverage()` | ja カバレッジ確認 |
| `auditEnglishGlossCoverage()` | en カバレッジ確認 |
| `generateTemplateBatch_(band, count)` | テンプレ候補生成 → Drive `shared/template-batch-*.json` |
| `warmupPassagesForBand_(band, count)` | critique 合格パッセージを事前キャッシュ |
| `generatePassageWithCritique_(...)` | 内部: 生成 + critique ループ |

---

## 7. スプレッドシートスキーマ（更新後）

### `chunks_master`

| 列 | リフレッシュ後 |
|----|--------------|
| `ja_translation` | 空 → enrich で再填入 |
| `en_translation` | 空 → enrich で再填入 |
| `example_sentence` | 空 → ja enrich で再填入 |

### `passages_meta`（列追加）

| 列 | 説明 |
|----|------|
| `critique_total` | critique 合計点（0–14） |
| `critique_verdict` | `pass` / `revise` / 空（リアルタイム） |

**リフレッシュで触らないもの:** `user_progress`, `encounter_log`

---

## 8. 固定テンプレ JSON スキーマ

```json
{
  "passage_id": "ps_001",
  "cefr_band": "B1",
  "text_markup": "We {{managed to}} finish on time.",
  "ja_translation": "...",
  "chunk_texts": ["managed to", "turned out"]
}
```

- 現行 45 本は **手書き**（A1A2/B1/B2 各 15 本）
- 再生成: `generateTemplateBatch_("B1", 1)` → Naoya レビュー → `shared/passage-templates.json` マージ

---

## 9. 関連ファイル

| ファイル | 役割 |
|---------|------|
| `gas/Code.gs` | 全 Claude 呼び出し・検証・hybrid |
| `docs/claude-api-prompt-renewal-work-request.md` | リニューアル設計書（依頼元） |
| `docs/product-overview.md` | アプリ思想・全体仕様 |
| `docs/setup.md` | デプロイ・運用手順（Phase 4b） |
| `shared/passage-templates.json` | 固定テンプレ（手書き、再生成予定） |

---

## 10. 変更履歴

| 日付 | 内容 |
|------|------|
| 2026-06-21 午前 | 初版 — Before 状態の文書化 |
| 2026-06-21 午後 | **After 反映** — Sonnet/Haiku 分離、全プロンプト更新、prior_contexts、critique、refresh 関数。enrich 再実行フェーズ開始 |
