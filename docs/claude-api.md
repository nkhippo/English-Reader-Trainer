# Claude API — モデル・プロンプト現状と改善ワークフロー

> 最終更新: 2026-06-21  
> ソース: `gas/Code.gs`（`ANTHROPIC_MODEL` および各 `callClaude*` 関数）

---

## 1. 重要: テンプレと Claude の関係

| コンテンツ | 生成方法 | Claude 依存 |
|-----------|---------|------------|
| **`shared/passage-templates.json`**（固定テンプレ 45 本） | リポジトリ内で **手書き** | ❌ 現状 Claude は使っていない |
| **動的パッセージ**（hybrid / dynamic モード） | GAS `callClaudeGeneratePassage_()` | ✅ モデル + プロンプトに依存 |
| **`chunks_master.ja_translation`** | GAS `callClaudeEnrich_()` | ✅ |
| **`chunks_master.en_translation`** | GAS `callClaudeEnrichEnglish_()` | ✅ |

**テンプレの質を Claude レベルに揃えたい**場合は、下記 **§6 のワークフロー** で `passage-templates.json` を Claude 生成物に差し替える必要があります。  
動的生成用プロンプト（§4.3）が、テンプレ再生成のベースラインになります。

---

## 2. API 共通設定

| 項目 | 値 |
|------|-----|
| エンドポイント | `https://api.anthropic.com/v1/messages` |
| パッセージ生成 | **`claude-sonnet-4-6`** (`MODEL_PASSAGE`) |
| 品質 critique | **`claude-haiku-4-5-20251001`** (`MODEL_CRITIQUE`) |
| enrich バッチ | **`claude-haiku-4-5-20251001`** (`MODEL_ENRICH`) |
| API バージョン | `anthropic-version: 2023-06-01` |
| パッセージ生成 | system + user 分離、`prior_contexts` 注入、self_check |
| 詳細 | [claude-api-prompt-renewal-work-request.md](./claude-api-prompt-renewal-work-request.md) |

### モデル使い分け（2026-06 更新後）

| 用途 | モデル | max_tokens | 備考 |
|------|--------|------------|------|
| 動的パッセージ生成 | **Sonnet 4.6** | 4,096 | system + user、prior_contexts |
| 品質 critique | Haiku 4.5 | 2,048 | オフライン / warmup のみ |
| 日本語訳 enrich | Haiku 4.5 | 16,384 | 125 件/回 |
| 英語グロス enrich | Haiku 4.5 | 8,192 | 125 件/回 |

---

## 3. 固定テンプレ JSON スキーマ

`shared/passage-templates.json` の 1 エントリ:

```json
{
  "passage_id": "ps_001",
  "cefr_band": "B1",
  "text_markup": "We {{managed to}} finish on time. It {{turned out}} well.",
  "ja_translation": "私たちはなんとか時間通りに終えた。結果的にうまくいった。",
  "chunk_texts": ["managed to", "turned out"]
}
```

| フィールド | 説明 |
|-----------|------|
| `passage_id` | 一意 ID（`ps_` プレフィックス推奨） |
| `cefr_band` | `A1A2` / `B1` / `B2` |
| `text_markup` | ターゲットチャンクを `{{chunk text}}` で囲んだ英文 |
| `ja_translation` | パッセージ全体の自然な日本語訳 |
| `chunk_texts` | 埋め込むチャンク文字列（markup 内と **完全一致**） |

GAS は Drive の同名 JSON を読み、`enrichPassageTemplate_()` で `chunks_master` から gloss を付与します。

---

## 4. プロンプト全文（現行）

### 4.1 日本語訳バッチ — `callClaudeEnrich_()`

**関数:** `enrichTranslationsBatch()` / `enrichAllTranslations()`  
**入力:** 最大 125 件 `{ chunk_id, text, type, example_sentence }`

```
You are a bilingual English-Japanese lexicographer. For each item, provide:
- ja_translation: concise natural Japanese (for chunks include 〜 where needed)
- example_sentence: English example (keep existing if provided, else create one natural 8-18 word sentence)

Return ONLY a JSON array, no markdown:
[{"chunk_id":"...","ja_translation":"...","example_sentence":"..."}]

Items:
${JSON.stringify(input)}
```

**出力パース:** レスポンスから markdown フェンスを除去 → `JSON.parse`

---

### 4.2 英語グロスバッチ — `callClaudeEnrichEnglish_()`

**関数:** `enrichEnglishGlossesBatch()` / `enrichAllEnglishGlosses()`  
**入力:** 最大 125 件 `{ chunk_id, text, type, cefr, ja_translation }`

```
You are an English lexicographer writing learner-friendly glosses for CEFR vocabulary items.
For each item, provide:
- en_translation: a concise English gloss (about 6-15 words)
  - For single words: a brief definition using simple language
  - For phrasal verbs / multi-word chunks: explain the meaning plainly (e.g. "to switch on a device")
  - Match complexity to the CEFR level shown
If ja_translation is provided, use it only as context. Write the gloss in English only.

Return ONLY a JSON array, no markdown:
[{"chunk_id":"...","en_translation":"..."}]

Items:
${JSON.stringify(input)}
```

---

### 4.3 動的パッセージ生成 — `callClaudeGeneratePassage_()`

**関数:** `generateDynamicPassage_()` / hybrid モードの `generateDynamicPassageClaude_()`  
**入力:** 2〜4 チャンク `{ chunk_id, text, cefr }` + CEFR バンド

```
Write a natural English reading passage for CEFR ${cefrHint} learners.

Requirements:
- 3 to 6 sentences, 60-120 words total
- Use ONLY vocabulary appropriate for CEFR ${cefrHint} and below (i+1 principle)
- Naturally embed ALL target chunks below (no forced or awkward insertion)
- Provide accurate Japanese translation
- For each chunk, report exact char_start and char_end (0-based, end exclusive) in the English text

Return ONLY JSON, no markdown:
{
  "text": "full English passage as plain text",
  "ja_translation": "natural Japanese translation",
  "target_chunks": [
    {"chunk_id":"...","text":"exact substring","char_start":0,"char_end":0}
  ]
}

Target chunks:
${JSON.stringify(chunkList)}
```

`${cefrHint}` は `A1A2` バンドのとき `"A1/A2"`、それ以外はバンド名（`B1` / `B2`）。

---

## 5. 生成後の検証・後処理（動的パッセージのみ）

### 5.1 `validatePassageChunks_()`

- 英文（小文字化）に **すべてのターゲットチャンク** が含まれること

### 5.2 `validatePassageQuality_()`

| チェック | 条件 |
|---------|------|
| 英文・和訳 | 非空 |
| 文数 | 3〜6 文 |
| 語数 | 40〜140 語 |
| ターゲット数 | 2 件以上 |
| 位置情報 | 各 chunk の `char_start`/`char_end` が英文の部分文字列と一致 |

不合格 → 最大 **3 回** 再生成。3 回失敗 → テンプレ fallback。

### 5.3 マークアップ変換

`buildTextMarkupFromPositions_()` が `char_start`/`char_end` から `{{chunk}}` 形式の `text_markup` を生成。

### 5.4 チャンク選定（生成前）

`selectChunksForPassage_()` の優先順:

1. new チャンク 1 件
2. learning（stage 1–3）最大 2 件
3. reviewing（stage 4+）最大 1 件
4. 不足時 new / due から補充
5. それでも不足 → テンプレ先頭の chunk_texts

---

## 6. テンプレ再生成ワークフロー（Claude 改善案 → 取り込み）

### Step A — Claude に改善案を依頼

Claude Web / Projects / API に以下をコピペし、**改善プロンプト案** と **サンプルテンプレ 3 本**（各バンド 1 本）を返してもらう。

<details>
<summary>📋 コピペ用依頼文（クリックで展開）</summary>

```
あなたは English Reader Trainer という CEFR ベースの英語多読アプリの編集者です。

## 現状
- 固定テンプレ JSON: shared/passage-templates.json（A1A2/B1/B2 各 15 本、計 45 本）
- 現テンプレは手書きで、Claude API は使っていない
- 動的生成は GAS + claude-haiku-4-5-20251001 + 下記プロンプト

## 動的生成プロンプト（現行）
Write a natural English reading passage for CEFR {band} learners.
- 3 to 6 sentences, 60-120 words
- CEFR {band} and below only (i+1)
- Embed ALL target chunks naturally
- Japanese translation
- char_start/char_end for each chunk

## 固定テンプレ JSON スキーマ
{
  "passage_id": "ps_xxx",
  "cefr_band": "B1",
  "text_markup": "We {{managed to}} finish. It {{turned out}} well.",
  "ja_translation": "...",
  "chunk_texts": ["managed to", "turned out"]
}

## 依頼
1. 動的生成プロンプトの改善案（system/user 分離、CEFR 別ガイドライン、自然さ・多様性・チャンク埋め込み品質）
2. テンプレ専用プロンプト案（15 本/バンド一括生成向け、重複テーマ回避、chunk カバレッジ最大化）
3. モデル推奨（Haiku vs Sonnet、用途別）
4. 各バンド 1 本ずつ、改善後プロンプトで生成したサンプル JSON
5. validatePassageQuality_ 相当の品質チェックリスト追加案

制約:
- チャンクは chunks_master（CEFR 語彙 ~7125 件）から選ぶ想定
- A1A2 は日常・短い文、B2 はやや抽象・報告文体も可
- text_markup の {{}} は chunk_texts と完全一致
```

</details>

### Step B — 改善をコードに反映

| 変更箇所 | 内容 |
|---------|------|
| `gas/Code.gs` | `ANTHROPIC_MODEL`、各プロンプト、必要なら `validatePassageQuality_` |
| `shared/passage-templates.json` | Claude 生成テンプレで全面 or 段階的差し替え |
| `src/lib/chunkGlosses.js` | 新 chunk に fallback が必要な場合のみ |
| Drive `shared/passage-templates.json` | GAS 用に再アップロード |
| GAS | 再デプロイ → `config.js` URL 更新 → push |

### Step C — 一括テンプレ生成用 GAS 関数（未実装・追加候補）

テンプレ 45 本を API で作り直す場合、次のような専用関数を `Code.gs` に追加するのが安全:

```javascript
// 案: generateTemplateBatch_(band, count, chunkPool)
// - chunks_master からバンド適合チャンクをサンプリング
// - 改善版プロンプトで N 本生成
// - passage-templates.json 形式で Logger / Drive に出力
// - 人間レビュー後に shared/ にマージ
```

---

## 7. 改善検討メモ（未適用）

> Claude への依頼結果をここに追記する。

| 項目 | 現状 | 改善案（TBD） |
|------|------|--------------|
| モデル（テンプレ生成） | Haiku 4.5 | Sonnet 推奨？ |
| モデル（enrich バッチ） | Haiku 4.5 | 現状維持でコスト優先？ |
| system プロンプト | なし | 役割・禁止事項を分離 |
| CEFR 別ガイドライン | 1 行のみ | A1A2/B1/B2 別 rubric |
| テーマ多様性 | 指定なし | 日常/仕事/旅行など明示 |
| テンプレ重複回避 | なし | 既存 passage_id / 冒頭文を exclude |
| 和訳スタイル | "natural Japanese" のみ | 多読向け（文語寄り/口語寄り）指定 |

---

## 8. 関連ファイル

| ファイル | 役割 |
|---------|------|
| `gas/Code.gs` | モデル定数、3 プロンプト、検証、hybrid |
| `shared/passage-templates.json` | 固定テンプレ（手書き） |
| `src/lib/localPassages.js` | フロント即時 fallback |
| `src/lib/chunkGlosses.js` | ローカル gloss fallback |
| `docs/setup.md` | デプロイ・Script Property |
| `docs/product-overview.md` | Phase 4 概要 |

---

## 9. 変更履歴

| 日付 | 内容 |
|------|------|
| 2026-06-21 | 初版 — 現行モデル・プロンプト・テンプレ/動的の区別を文書化 |
