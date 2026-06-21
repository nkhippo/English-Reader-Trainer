# Work Request: Claude API プロンプト・モデル全面見直し — English Reader Trainer

> **依頼先**: Cursor
> **依頼者**: Naoya
> **対象リポ**: English-Reader-Trainer
> **関連ドキュメント**:
> - 現状: `docs/claude-api.md` (モデル・プロンプト現状)
> - 仕様: `english-reader-trainer-work-request.md`
> - 概要: `docs/product-overview.md`
> **本書の位置づけ**: プロンプト品質の**全面リニューアル**。学習効果 (SLA 観点) を最大化する。

---

## 0. このリニューアルの目的

アプリの根本目的に立ち返る:

> **異なる文脈で、間隔をあけて、多数回チャンクに出会わせ、チャンク知識を自動化する。**

現行プロンプトは「動く JSON を返す」最低限は満たすが、**学習効果を駆動する仕掛けがほぼ入っていない**。本書は SLA (第二言語習得) の確立した原理に基づき、3つの Claude プロンプトすべてと、モデル選択、検証ロジックを刷新する。

### 反映する SLA 原理 (MECE)

| 原理 | 出典 | 現行 | 本書での適用 |
|---|---|---|---|
| **理解可能input (i+1)** | Krashen | ❌ 誤実装 (i+0 指示) | 周囲=既知語、ターゲット=唯一の新規、文脈で推測可能に |
| **気づき (noticing)** | Schmidt | ❌ なし | チャンクを知覚的に際立たせ、形と意味の結合を促す |
| **処理水準 (levels of processing)** | Craik & Lockhart | ❌ なし | 具体的・情景的な文ほど記憶に残る → 抽象的な埋め草を禁止 |
| **符号化の多様性 (encoding variability)** | 文脈変動説 | ❌ **実装ゼロ** | **再会ごとに異なる場面・共起語・文型** (最重要) |
| **用法基盤 (usage-based)** | Tomasello 他 | △ "natural" のみ | チャンクを典型的な共起語と共に提示 |
| **コアミーニング** | Naoya 教科書 | ❌ なし | 多義チャンクは最頻出の1コア意味で訳す |

---

## 1. 現状診断 (Before)

`gas/Code.gs` の3プロンプトを精査した結果:

### 1.1 動的パッセージ生成 (`callClaudeGeneratePassage_`, L1111)

| 問題 | 現行の記述 | なぜ問題か |
|---|---|---|
| **i+1 の誤実装** | "Use ONLY vocabulary appropriate for CEFR X and below (i+1 principle)" | これは i+0。i+1 は「既知 + 新規1個」。周囲を固めてターゲットだけ新規にする指示が必要 |
| **推測可能性の欠如** | なし | チャンクの意味が文脈から**推測できる**手がかりの指示がない |
| **多様性の欠如** | なし | 過去の登場文脈を渡していない → 毎回似た文脈になり「異なる文脈」要件 (思想の柱) を満たせない |
| **具体性の欠如** | "natural English reading passage" | 抽象的・一般論的な文を許容してしまう。記憶に残らない |
| **system 分離なし** | 全文 user ロール1発 | 役割・原則・出力形式が混在。指示が弱まる |

### 1.2 日本語訳 enrich (`callClaudeEnrich_`, L329)

| 問題 | 現行の記述 | なぜ問題か |
|---|---|---|
| コア意味の指示なし | "concise natural Japanese" | `pick up` を「拾う」とだけ訳すと多義の核を見失う。仕様の「1チャンク1意味 (最頻出)」と整合しない |
| 例文の目的が不明 | "natural 8-18 word sentence" | 例文が「典型的な使用文脈を示す」「具体的で記憶に残る」という機能が指示されていない |

### 1.3 英語グロス enrich (`callClaudeEnrichEnglish_`, L547)

現行は概ね良好。軽微改善のみ (コア意味・見出し語より平易・最頻出語義の固定)。

### 1.4 検証 (`validatePassageQuality_`, L1167)

文数・語数・位置情報の**体裁しか見ていない**。自然さ・i+1・推測可能性・多様性という**学習価値を一切検証していない**。

### 1.5 モデル

全用途が Haiku 4.5。パッセージ生成は**創造性・自然さ・多様性が core value** なのに Haiku では力不足。

---

## 2. モデル変更

| 用途 | 現行 | 変更後 | 理由 |
|---|---|---|---|
| **動的パッセージ生成** | Haiku 4.5 | **Sonnet 4.6** (`claude-sonnet-4-6`) | 自然さ・多様性・具体性が学習効果に直結。Naoya 承認済み |
| **品質critique (新規)** | — | Haiku 4.5 | rubric ベースの採点。オフライン実行でコスト優先。不安定なら Sonnet 昇格 |
| 日本語訳 enrich | Haiku 4.5 | **Haiku 4.5 維持** | 辞書的バッチ作業。コスト優先 |
| 英語グロス enrich | Haiku 4.5 | **Haiku 4.5 維持** | 定型作業 |

`Code.gs` に用途別モデル定数を追加:

```javascript
const MODEL_PASSAGE  = 'claude-sonnet-4-6';        // 生成 (品質優先)
const MODEL_CRITIQUE = 'claude-haiku-4-5-20251001'; // 採点 (コスト優先)
const MODEL_ENRICH   = 'claude-haiku-4-5-20251001'; // enrich (コスト優先)
```

---

## 3. 最重要変更: 文脈の多様性 (encoding variability)

**これが本リニューアルの核心。** アプリの思想「同じチャンク × 異なる文脈で再会」を、初めてプロンプトレベルで実装する。

### 3.1 現状のギャップ

- SRS はチャンクを「間隔をあけて」再投入するが、生成プロンプトは**そのチャンクが過去どう登場したかを知らない**
- 結果、再会のたびに似た場面・似た文型になりうる → 「異なる文脈での遭遇数 (`distinct_passages_count`)」が量的には増えても、**質的に同じ文脈**なら学習効果は頭打ち

### 3.2 実装: 過去文脈の取得と注入

**新規データ取得ステップ** (`selectChunksForPassage_` の後、生成の前):

各ターゲットチャンクについて、過去に登場したパッセージの**該当文を最大3件**取得する。

```javascript
// 案: getChunkPriorContexts_(chunkId, limit = 3)
// - passages_meta から target_chunk_ids に該当 chunkId を含む行を新しい順に取得
// - 各 passage JSON を Drive から読み、該当チャンクを含む「文」だけを抽出
// - 最大 limit 件の短い文脈スニペットを返す
// - 0 件なら「初出」として扱う
```

取得したスニペットを生成プロンプトの user メッセージに渡す (§4.1 参照)。生成 Claude は「**今回はこれらと違う場面・共起語・文型にする**」よう指示される。

### 3.3 効果

- `distinct_passages_count` が「数」だけでなく「**質的な多様性**」を持つ
- 卒業判定 (5回遭遇 × 3文脈) が**意味のある多様性**を担保する
- これがないと、アプリの中核思想が名目だけになる

---

## 4. プロンプト全文 (After)

### 4.1 動的パッセージ生成 — system / user 分離

**system プロンプト** (新規・固定):

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

**user プロンプト** (テンプレート):

```
CEFR band: {band}
Length: 3 to 6 sentences, 60 to 120 words total.

Target chunks (embed ALL of them, each at least once):

{各チャンクについて:}
- "{text}"  (chunk_id: {chunk_id})
    intended meaning: {ja_translation がなければ en_translation}
    {prior_contexts があれば:}
    previously appeared as:
      • {prior snippet 1}
      • {prior snippet 2}
      • {prior snippet 3}
    make this encounter clearly different from the above.
    {prior_contexts がなければ:}
    this is the learner's FIRST encounter — introduce it in an especially clear, self-explaining context.

Write the passage now.
```

**ポイント:**
- `intended meaning` を渡すことで、多義チャンクの**意図した語義**で使わせる (語義ドリフト防止)
- `prior_contexts` が encoding variability の実装 (§3)
- `self_check` は埋め込み自己検証 — 後述の高速ゲートとログに使う

### 4.2 品質 critique — 生成と検証の分離 (新規)

Naoya の要望「生成と検証を分離」を、**UX レイテンシを増やさない形で**実装する (§5 のアーキテクチャ参照)。

**critique プロンプト** (Haiku, オフラインバッチで実行):

```
You are a strict reviewer of graded reading passages for CEFR {band} learners of English. Score the passage on each criterion from 0 to 2 (0 = fails, 1 = weak, 2 = good). Be honest; this gates what learners see.

Passage:
{text}

Japanese translation:
{ja_translation}

Target chunks (with intended meaning):
{chunk list with meanings}

{prior_contexts があれば渡す}

Criteria:
- naturalness: reads like authentic English; no chunk was forced in awkwardly
- comprehensibility: surrounding vocabulary is within CEFR {band}; nothing harder than the target chunks themselves
- inferability: each target chunk's meaning can be guessed from the surrounding context
- chunk_integrity: every target chunk appears verbatim and is used correctly
- variety: genuinely different scenario/collocates/structure from the prior contexts (score 2 if no prior contexts were given)
- concreteness: a vivid, specific situation rather than abstract filler
- translation_fidelity: the Japanese is accurate and natural

Output ONLY JSON:
{
  "scores": {
    "naturalness": 0,
    "comprehensibility": 0,
    "inferability": 0,
    "chunk_integrity": 0,
    "variety": 0,
    "concreteness": 0,
    "translation_fidelity": 0
  },
  "total": 0,
  "verdict": "pass" or "revise",
  "problems": ["short bullet per issue"],
  "revision_hint": "one concrete instruction for regeneration, if verdict is revise"
}

Pass threshold: total >= 11 AND no single criterion scores 0.
```

`verdict: "revise"` の場合、`revision_hint` を生成プロンプトの user 末尾に追記して再生成 (オフラインなのでリトライのレイテンシは問題にならない)。

### 4.3 日本語訳 enrich — コアミーニング反映

```
You are a bilingual English–Japanese lexicographer creating entries for a chunk-learning app. For each item, provide:

- ja_translation: the CORE meaning in concise, natural Japanese. Capture the functional nucleus of the chunk, not a word-by-word gloss. If the chunk is polysemous, give the SINGLE most frequent sense only (the app stores one sense per chunk). Use 〜 to mark where words attach (e.g. "〜を引き受ける", "〜のおかげで").
- example_sentence: keep the existing one if it is provided and good; otherwise write ONE natural, CONCRETE sentence (8–18 words) showing the chunk in its most typical context — a specific situation the learner can picture, never a generic statement.

Keep the Japanese clear and natural for a general adult learner (avoid overly literary vocabulary).

Return ONLY a JSON array, no markdown:
[{"chunk_id":"...","ja_translation":"...","example_sentence":"..."}]

Items:
${JSON.stringify(input)}
```

**変更点:** 「コア意味」「多義は最頻出1語義」(= 仕様の1チャンク1意味、= Naoya 教科書の『1つのコアから枝分かれ』思想) + 「具体的で描ける例文」(levels of processing)。

### 4.4 英語グロス enrich — 学習者が「英語で意味を取る」ための設計

**設計思想:** `en_translation` は「日本語訳の英語版」ではない。**英語を英語のまま理解する回路 (L2-L2 マッピング)** を作るための足場である。日本語を介さず意味に到達する訓練は流暢性の中核なので、グロスは「学習者が英語で読んで一発で腑に落ちる」ことを最優先に設計する。

**学習者視点で満たすべき条件 (MECE):**

| 条件 | 根拠 |
|---|---|
| **グロス自体が i+1** | 本文で i+1 を守ったのに、意味確認のグロスで難語を使ったら初学者は読めない。グロスは見出し語より**1〜2 CEFR 帯下**の語だけで書く |
| **循環定義の禁止** | 見出し語やその派生語をグロス内で使わない (`manage` を "to manage to do" で説明しない) |
| **使い方の明示 (チャンク)** | 句動詞・コロケーションは意味だけでなく「**何に対して・どんな場面で**」使うかが本体。"to switch on a device" のように対象を含める |
| **想起しやすさ** | 抽象的辞書定義より、典型的な動作・場面が浮かぶ語り口 |
| **語義の単一性** | 多義は最頻出の1語義に絞る (仕様の1チャンク1意味と整合) |

**en_translation プロンプト** (Haiku 維持):

```
You are writing English-in-English glosses for a chunk-learning app used by Japanese learners. The gloss's job is to let a learner understand the item's meaning WITHOUT translating to Japanese — building a direct English-to-meaning pathway. Optimize for "a learner reads this and instantly gets it."

For each item, provide:

- en_translation: a short English gloss (about 6–15 words) capturing the single most frequent sense.

Rules the gloss MUST follow:
1. SIMPLER THAN THE HEADWORD. Use only words that are clearly easier than the item itself — roughly one to two CEFR levels below it. A learner who needs this gloss does not know hard words, so the gloss must not contain any.
2. NO CIRCULAR DEFINITION. Never use the headword or its derivatives in the gloss (do not gloss "manage" with "to manage to..."). 
3. SHOW HOW IT IS USED, not just what it means. For phrasal verbs and collocations, include the typical object or situation so the learner sees the chunk in action — e.g. "pick up" → "to lift something from the ground, or collect a person"; "make a decision" → "to choose what to do after thinking".
4. EVOKE A SITUATION. Prefer wording that brings a concrete action or scene to mind over an abstract dictionary phrase.
5. ONE SENSE ONLY. If the item is polysemous, gloss only its most frequent sense.

If ja_translation is provided, use it only as private context for picking the right sense. Write the gloss in English only.

Return ONLY a JSON array, no markdown:
[{"chunk_id":"...","en_translation":"..."}]

Items:
${JSON.stringify(input)}
```

**変更点 (Before → After):**
- 「見出し語より平易」→ **具体的に「1〜2 CEFR 帯下の語のみ」** (グロス自体の i+1 を定量化)
- **循環定義の明示的禁止** を追加 (見出し語・派生語をグロスに使わない)
- 「意味の説明」→ **「使い方を見せる」** (対象・場面を含める) — チャンク学習の本質
- **場面想起** を促す語り口の指示を追加 (処理水準)
- 冒頭に **L2-L2 マッピングという目的** を明示 (グロスを「英語で考える足場」と位置づけ)

---

## 5. 検証アーキテクチャ — レイテンシを増やさない分離

Naoya の条件「UX 上の処理に時間がかからないのであれば分離したい」を満たす設計。

### 5.1 2経路に分ける

| 経路 | いつ | 生成 | 検証 | レイテンシ |
|---|---|---|---|---|
| **リアルタイム** | ユーザーがパッセージを要求 | Sonnet 1発 + `self_check` | 既存の高速 regex (文数・語数・位置・チャンク含有) のみ | 低 (1往復) |
| **バックグラウンド** | warmup バッチ / 事前生成 | Sonnet | critique プロンプト (§4.2) で採点 → revise なら再生成 | 問わない (オフライン) |

### 5.2 仕組み

1. **事前生成 (warmup)**: due になりそうなチャンクの組み合わせを予測し、バックグラウンドで生成 → critique → 合格品のみ Drive `passages/` にキャッシュ
2. **リアルタイム**: ユーザー要求時はまず Drive キャッシュ (合格済み) を探す → ヒットすれば即配信 (検証済み・高速)
3. **キャッシュミス時**: その場で Sonnet 生成 + 高速 regex + `self_check` の真偽だけ確認して配信 (現行と同等の速度)。そのパッセージは後続の warmup で critique にかけ、低品質なら差し替え

→ ユーザーは常に「検証済みキャッシュ」か「高速生成」のどちらかを得る。critique のレイテンシはユーザーに乗らない。

### 5.3 既存コードへの接続

- `findCachedPassage_` (L1045) は既にキャッシュ探索を実装済み → これを「合格済みのみ返す」よう、`passages_meta` に `critique_total` / `critique_verdict` 列を追加してフィルタ
- warmup 関数は新規 (または listening trainer の warmup を参考に)

---

## 6. チャンク選定の i+1 ガード (副次修正)

`selectChunksForPassage_` (L999) の backfill ロジックに穴がある。

**現状の問題:**

```javascript
if (selected.length < 2) {
  newChunks.slice(1, 4).forEach(add);   // ← new を最大3個追加しうる
}
```

new (未知) チャンクが1パッセージに最大4個入りうる = **未知語が4つ = i+1 違反** (i+4 になる)。

**修正方針:**

- 1パッセージの new チャンクは**最大1個**を原則とする (i+1 を守る)
- backfill は new を積み増すのではなく、**learning / reviewing / due** を優先
- どうしても2個に満たない場合のみ new を2個目として許容 (3個以上にしない)

```
優先順 (修正後):
  1. new 1個
  2. learning (stage 1-3) 最大2個
  3. reviewing (stage 4+) 最大1個
  4. 不足時: due から補充 (new ではなく既習を優先)
  5. なお不足: new を2個目まで (上限2)
  6. それでも不足: テンプレ先頭の chunk_texts
```

---

## 7. 固定テンプレ再生成ワークフロー (45本)

`claude-api.md` §6 のワークフローを、本書の新プロンプトで実体化する。

### 7.1 方針

- 現テンプレ45本 (手書き) を、**§4.1 の新生成プロンプト + Sonnet + §4.2 critique** で作り直す
- ただし**一括自動置換はしない**。生成 → critique 合格品を Naoya がサンプルレビュー → 段階マージ

### 7.2 新規 GAS 関数 (バッチ生成)

```javascript
// 案: generateTemplateBatch_(band, count)
// 1. chunks_master からバンド適合チャンクをサンプリング
//    (テーマ・チャンク型が偏らないよう分散)
// 2. 2-4個ずつ束ね、§4.1 プロンプト + MODEL_PASSAGE で count 本生成
// 3. 各本を §4.2 critique にかけ、verdict=pass のみ採用
// 4. passage-templates.json 形式で Drive または Logger に出力
// 5. Naoya レビュー後に shared/passage-templates.json へマージ
```

### 7.3 テンプレ多様性の制約

- 既存テンプレの冒頭文・テーマを exclude リストとして渡し、重複を避ける
- バンド内でテーマ (日常 / 仕事 / 旅行 / 買い物 / 人間関係…) が分散するよう、生成時にテーマを指定

---

## 8. Acceptance

### 8.1 プロンプト・モデル
- [ ] パッセージ生成が Sonnet 4.6 を使用
- [ ] 生成 system / user プロンプトが §4.1 の内容に置き換わっている
- [ ] 生成 user プロンプトに各チャンクの `intended meaning` が渡されている
- [ ] 生成 user プロンプトに各チャンクの `prior_contexts` (最大3件) が渡されている (初出時は初出と明示)
- [ ] 日本語訳 enrich が §4.3 (コア意味・最頻出語義・具体例文) に置き換わっている
- [ ] 英語グロス enrich が §4.4 に置き換わっている (グロス自体が見出し語より1〜2帯下の語・循環定義なし・使い方を含む)

### 8.2 文脈多様性 (核心)
- [ ] `getChunkPriorContexts_` 相当が実装され、過去パッセージの該当文を取得できる
- [ ] 同一チャンクの2回目以降の生成が、1回目と異なる場面・共起語になっていることを目視確認 (3例以上)

### 8.3 検証
- [ ] critique プロンプト (§4.2) が実装され、JSON スコアを返す
- [ ] リアルタイム経路は高速 regex + self_check のみで、critique を待たない (レイテンシ計測で確認)
- [ ] バックグラウンド経路で critique が走り、verdict=pass のみキャッシュされる
- [ ] `passages_meta` に critique 結果列が追加されている

### 8.4 i+1 ガード
- [ ] 1パッセージの new チャンクが最大1個 (例外的に2個、3個以上は出ない)

### 8.5 テンプレ再生成
- [ ] `generateTemplateBatch_` 相当が実装されている
- [ ] 各バンド1本ずつ、新プロンプトでの生成サンプルを Naoya がレビューできる形で出力

---

## 9. 作業順序の推奨

```
Day 1:
  §2   モデル定数追加                          (15 分)
  §4.3 日本語訳 enrich プロンプト差し替え       (15 分)
  §4.4 英語グロス enrich プロンプト差し替え     (15 分)
  §6   チャンク選定 i+1 ガード                  (30 分)

Day 1-2:
  §4.1 生成 system/user 分離・新プロンプト      (1-2 時間)
  §3   過去文脈取得の実装 (getChunkPriorContexts_) (2-3 時間)

Day 2-3:
  §4.2 critique プロンプト実装                  (1-2 時間)
  §5   2経路検証アーキテクチャ                  (半日)

Day 3+:
  §7   テンプレ再生成バッチ + サンプル出力      (半日)
       → Naoya レビュー → 段階マージ
```

**根拠:** enrich とモデル定数は独立で即効。生成プロンプト刷新 + 過去文脈が本丸。critique/アーキテクチャはその後。テンプレ再生成は最後。

---

## 10. スコープ外

| 項目 | 理由 |
|---|---|
| CEFR 語彙リスト全件のプロンプト注入 | 3000+語は毎回渡せない。モデルの CEFR 知識 + self_check + critique で担保 |
| パッセージ音声 (TTS) | Phase 5 |
| critique の人手評価データセット構築 | 当面は rubric ベースの自動採点で運用 |
| enrich のモデル昇格 | コスト優先で Haiku 維持。品質不足が確認されたら別途検討 |

---

## 11. 補足: なぜこれで学習効果が上がるか (Naoya 向け要約)

| 変更 | 効く SLA 原理 | 期待効果 |
|---|---|---|
| i+1 の正しい実装 | 理解可能input | 周囲が分かるのでチャンクだけに注意が向く。推測 → 定着 |
| 過去文脈の注入 (§3) | 符号化の多様性 | **同じチャンクが毎回違う顔で出る** → 表面記憶でなく抽象化された知識に |
| intended meaning 注入 | 語義の一貫性 | 多義チャンクが毎回バラバラの意味で出る事故を防ぐ |
| 具体・情景的な文の強制 | 処理水準 | 抽象的な文より圧倒的に記憶に残る |
| コア意味訳 (§4.3) | コアミーニング | 「拾う」だけでなく `pick up` の核を掴む → 多義に対応できる |
| 英語グロスの再設計 (§4.4) | L2-L2 マッピング | 日本語を介さず英語で意味に到達する回路を作る。グロス自体も i+1 で初学者が読める |
| Sonnet 昇格 | (品質全般) | 不自然さ・単調さが減り、読書体験そのものが向上 |
| critique 分離 (§5) | 品質保証 | レイテンシを犠牲にせず低品質パッセージを排除 |

最大の一手は **§3 (過去文脈の注入)**。これがアプリの「異なる文脈で再会」という思想を、初めて本当に実装する。

---

*Ver. 1.0 — Claude API プロンプト・モデル全面見直し / Cursor work-request*
*Blocking: なし (既存機能の品質向上。段階的に適用可能)*
