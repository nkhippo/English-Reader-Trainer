# Work Request: CEFR 語彙・チャンクデータ生成

> **依頼先**: Claude（Web / Projects / API いずれでも可）
> **依頼者**: Naoya
> **用途**: English-Reader-Trainer / English-Listening-Trainer の **共有資産**
> **前提**: ソース CSV・EVP エクスポート等は **持っていない**。Claude が公開されている語彙プロファイル知識を根拠に **新規生成** する
> **一括生成**: §6 の **推奨方式** は全量を1回で出力。Phase A/B/C は任意（品質確認用）

---

## 0. このドキュメントの読み方

本ファイルは Claude への **work-request** である。

- **§1〜§4**: 何を作るか（What）
- **§5**: 品質基準（How）
- **§6**: 作業方式（一括生成推奨 / 段階生成は任意）
- **§7**: 受け入れ条件
- **§8**: スコープ外
- **§9**: 納品形式

関連仕様書（参照のみ・本依頼の正本ではない）:

| ドキュメント | 参照箇所 |
|---|---|
| `english-reader-trainer-work-request.md` | §3.1 chunks_master, §3.2 Drive `/shared/` |
| `listening-trainer-v2-work-request.md` | §2.3 累積語数, §3.4.1 JSON 構造 |

---

## 1. 目的

2つの英語学習アプリが **同じ CEFR 語彙プール** を参照できるよう、Google Drive `/EnglishReaderTrainer/shared/` に置く JSON 2ファイルを生成する。

| アプリ | 使い方 |
|---|---|
| **English-Reader-Trainer** | `chunks_master` シートへ GAS が取り込み → 読書パッセージ生成の語彙制約 |
| **English-Listening-Trainer** | 生成プロンプトへの CEFR 制約注入（`src/data/cefr/` にも分割配置可） |

**日本語訳（`ja_translation`）は本依頼のスコープ外**。英語の headword / chunk / example のみ生成する。日本語訳は English-Reader-Trainer Phase 2 の別タスク（GAS + Claude API）で後から付与する。

---

## 2. 出力物（必須）

### 2.1 Drive 用（メイン納品）

```
cefr_words.json      ← 全 headword（約 3,400 語）
cefr_chunks.json     ← 全 MWE・チャンク（約 1,800 件）
```

配置先（Naoya がアップロード）:

```
Google Drive: /EnglishReaderTrainer/shared/
  cefr_words.json
  cefr_chunks.json
```

### 2.2 Listening Trainer 用（任意・推奨）

分割ファイルも同時に生成すると取り込みが楽:

```
a1a2_words.json    b1_words.json    b2_words.json
a1a2_chunks.json   b1_chunks.json   b2_chunks.json
```

各ファイルは **その段階で新規追加される分のみ**（累積ではない）:

| ファイル | 含む CEFR | 目標件数（words） | 目標件数（chunks） |
|---|---|---|---|
| `a1a2_*` | A1 + A2 | 約 1,300 | 約 350 |
| `b1_*` | B1 のみ（A1+A2 除く） | 約 900 | 約 450 |
| `b2_*` | B2 のみ（B1 以下除く） | 約 1,200 | 約 1,000 |

---

## 3. 目標数量

Cambridge English Vocabulary Profile (EVP) を **参考にした概算**。±10% は許容。大幅な不足（−20% 以上）は不可。

### 3.1 累積目標

| CEFR | 累積 headword 数 | 累積 chunk 数 | 備考 |
|---|---|---|---|
| A1 | 約 600 | 約 100 | |
| A2 | 約 1,300 | 約 350 | A1 含む累積 |
| B1 | 約 2,200 | 約 800 | A1+A2 含む累積 |
| B2 | 約 3,400 | 約 1,800 | 全段階含む累積 |

### 3.2 アプリ UI 上の3バンド

| UI ラベル | 含む CEFR タグ | 用途 |
|---|---|---|
| A1+A2 | `A1`, `A2` | 初級帯 |
| B1 | `B1` | 中級帯 |
| B2 | `B2` | 中上級帯 |

**JSON 内の `cefr` フィールドは A1 / A2 / B1 / B2 の4値**を使う（A1+A2 を1値にまとめない）。

---

## 4. JSON スキーマ

### 4.1 `cefr_words.json`

```json
{
  "version": "1",
  "generated_at": "2026-06-20T12:00:00Z",
  "source_notes": "Generated from EVP/Oxford 3000/5000 knowledge. No proprietary dataset copied verbatim.",
  "total_count": 3400,
  "entries": [
    {
      "text": "manage",
      "lemma": "manage",
      "pos": "verb",
      "cefr": "A2",
      "type": "word"
    }
  ]
}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `text` | string | ✅ | 学習単位として表示する形（通常 = lemma） |
| `lemma` | string | ✅ | 見出し語（活用形ではなく原形） |
| `pos` | enum | ✅ | `noun` / `verb` / `adjective` / `adverb` / `preposition` / `conjunction` / `determiner` / `pronoun` / `interjection` |
| `cefr` | enum | ✅ | `A1` / `A2` / `B1` / `B2` |
| `type` | string | ✅ | 常に `"word"` |

**ルール**:

- 固有名詞・極端に稀な語・スラングは除外
- 同一 `lemma` + `pos` の重複禁止
- 成人学習者向け（日常・仕事・旅行で使う語彙を優先）
- 語数が多いほど高頻度語から優先して選ぶ

### 4.2 `cefr_chunks.json`

```json
{
  "version": "1",
  "generated_at": "2026-06-20T12:00:00Z",
  "source_notes": "...",
  "total_count": 1800,
  "entries": [
    {
      "text": "managed to",
      "cefr": "B1",
      "type": "phrasal_verb",
      "example": "She managed to finish the report by midnight."
    }
  ]
}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `text` | string | ✅ | チャンク本体（小文字始まり可。固有名詞を含む場合は文脈例に合わせる） |
| `cefr` | enum | ✅ | `A1` / `A2` / `B1` / `B2` |
| `type` | enum | ✅ | 下表参照 |
| `example` | string | ✅ | **英語のみ**の代表例文（1文、8〜20語程度） |

**`type` の enum**:

| type | 例 | 目安割合 |
|---|---|---|
| `chunk` | `at the moment`, `a lot of` | 30% |
| `phrasal_verb` | `pick up`, `turn out`, `look forward to` | 35% |
| `collocation` | `make a decision`, `heavy rain` | 25% |
| `idiom` | `break the ice`, `once in a while` | 10% |

**ルール**:

- 2語以上の MWE（multi-word expression）のみ。単語1語は `cefr_words.json` 側
- 同一 `text`（大文字小文字正規化後）の重複禁止
- 例文はチャンクを **自然に** 含むこと（不自然な詰め込み禁止）
- English-Reader-Trainer の学習単位として **文脈で再会させる価値がある** チャンクを優先

### 4.3 English-Reader-Trainer 取り込み時のマッピング（参考）

GAS `importChunksFromCefr()` が行う変換（Claude は意識不要だが参考）:

```
chunk_id  = "ch_" + sha256(text)[0:8]
chunks_master.type ← entry.type（word も chunks に含める場合あり）
ja_translation     ← Phase 2 別タスクで付与
example_sentence   ← entry.example（chunks）または後生成（words）
```

---

## 5. 品質基準・生成方針

### 5.1 根拠と正直さ

- **EVP / Oxford 3000・5000 / OPAL** 等の公開情報を **参考** に CEFR タグを付ける
- プロプライエタリデータセットの **逐語的コピーは禁止**
- `source_notes` に「参照した公開ソース名」を1〜2文で記載
- 不確実な CEFR タグは **1段階保守的**（迷ったら低め）に付ける

### 5.2 頻度・実用性

- 各 CEFR 帯で **高頻度 → 低頻度** の順に選ぶ
- B2 にはアカデミック・ビジネスで使うチャンクを多めに（OPAL 系）
- A1+A2 には日常会話・旅行・買い物で使うチャンクを多めに

### 5.3 チャンク選定の優先度（English-Reader-Trainer 向け）

以下を **多めに** 含める（成人学習者の「規則で導けない個別頻度知識」）:

- 句動詞（phrasal verbs）
- 動詞＋名詞コロケーション（`make a mistake`, `take a break`）
- ディスコースマーカー（`on the other hand`, `as a result`）
- 多義語の慣用パターン（`pick up` = 習得／拾う／迎えに行く 等は **別エントリにしない**。最頻出の1意味で1エントリ）

### 5.4 除外

- 専門用語・医学/legal jargon（一般学習者向けでないもの）
- 極端に古い・文語的な idiom
- 侮辱語・スラング
- 1文字・記号のみ
- 同一概念の微小バリエーション（`pick up` と `pickup` を両方入れない 等）

---

## 6. 作業方式

### 6.1 推奨: 一括生成（1回で全量）

**Naoya の作業方針に合わせ、全量を1回で出力する方式を推奨する。**

1回の依頼で以下を生成:

| ファイル | 内容 |
|---|---|
| `cefr_words.json` | 全 headword 約 3,400 entries |
| `cefr_chunks.json` | 全 chunk 約 1,800 entries |
| `a1a2_words.json` 等（任意） | §2.2 の分割6ファイル |

**生成順序（Claude 内部）**: A1 → A2 → B1 → B2 の順で entries を並べる。ファイルは **マージ済み2ファイル** を主納品とする。

**UI との関係**: JSON 内の `cefr` は `A1` / `A2` / `B1` / `B2` の4値のまま。アプリ側で3バンド（A1+A2 / B1 / B2）にフィルタして表示する。**生成を段階分割する必要はない。**

**一括生成時の注意**:

- 出力が長くなる場合は **2ファイルを別コードブロック** で出力（words → chunks の順）
- 末尾に **件数サマリ・CEFR 分布・重複チェック結果** を必ず付ける（§10）
- 件数不足や JSON 切れが疑われる場合のみ §6.2 の段階生成に切り替える

### 6.2 任意: 段階生成（品質確認用）

出力が切れた・件数が大幅に不足した・サンプル確認を挟みたい場合に使う。**必須ではない。**

| Phase | 生成物 | 目安件数 |
|---|---|---|
| A（A1+A2） | `a1a2_words.json`, `a1a2_chunks.json` | 1,300 words / 350 chunks |
| B（B1） | `b1_words.json`, `b1_chunks.json` | +900 words / +450 chunks |
| C（B2 + マージ） | `b2_*` + `cefr_words.json` + `cefr_chunks.json` | +1,200 words / +1,000 chunks |

各 Phase 完了後、Naoya がサンプル確認してから次へ進める。

**Naoya 確認ポイント（一括・段階共通）**:

- [ ] A1 語彙が初級（`the`, `go`, `want` 級）から始まっている
- [ ] チャンクに `look at`, `managed to`, `according to` 等、各帯の典型 MWE が含まれる
- [ ] 累積件数が §3.1 ±10% 以内
- [ ] 重複なし（words: lemma+pos、chunks: text 正規化後）
- [ ] JSON がパース可能、各 chunk に `example` あり

---

## 7. 受け入れ条件

- [ ] `cefr_words.json` に **約 3,400** entries（A1:600, A2:700, B1:900, B2:1200 のイメージ）
- [ ] `cefr_chunks.json` に **約 1,800** entries（累積）
- [ ] 全 entries に必須フィールドが揃っている
- [ ] 重複なし（words: lemma+pos、chunks: text 正規化後）
- [ ] 各 chunk に英語 example 文が1つずつ
- [ ] JSON が valid（`JSON.parse` 可能、UTF-8）
- [ ] `version`, `generated_at`, `total_count`, `source_notes` がルートにある
- [ ] 分割6ファイル（任意）も生成されている場合、件数が §2.2 と一致

---

## 8. スコープ外

| 項目 | 理由 |
|---|---|
| 日本語訳（`ja_translation`） | English-Reader-Trainer Phase 2 の GAS バッチで別途生成 |
| 音声（TTS mp3） | Phase 5 |
| C1 / C2 レベル | 当面 B2 まで |
| `chunks_master` への直接書き込み | GAS import スクリプトが担当 |
| Google Drive へのアップロード | Naoya が手動で実施 |

---

## 9. 納品形式

### 9.1 Claude への依頼文（コピペ用・一括生成）

```
本ファイル（cefr-data-generation-work-request.md）に従い、CEFR 語彙・チャンク JSON を一括生成してください。

必須納品:
- cefr_words.json（全約3,400 entries）
- cefr_chunks.json（全約1,800 entries）

任意: a1a2_words.json, a1a2_chunks.json, b1_words.json, b1_chunks.json, b2_words.json, b2_chunks.json

各 entry の cefr は A1/A2/B1/B2。UI用3バンド（A1+A2, B1, B2）はアプリ側でフィルタする。
JSON は valid、重複なし、chunks には example 必須。
2ファイルは別コードブロックで全文出力。末尾に件数サマリ・CEFR分布・重複チェック結果を付けてください。
```

### 9.1b Claude への依頼文（段階生成・任意）

出力が切れた場合など、§6.2 に従い Phase A から:

```
Phase A（A1+A2）のみ: a1a2_words.json, a1a2_chunks.json
```

Phase A 承認後 → Phase B → Phase C（最終マージ）。

### 9.2 ファイル命名

| ファイル | 内容 |
|---|---|
| `cefr_words.json` | 全 headword（マージ済み） |
| `cefr_chunks.json` | 全 chunk（マージ済み） |
| `a1a2_words.json` 等 | 段階別（任意） |

### 9.3 Naoya の次のアクション（データ納品後）

1. 2ファイルを Google Drive `/EnglishReaderTrainer/shared/` にアップロード
2. Cursor に「CEFR データを Drive に配置した。Phase 2 を続けて」と依頼
3. Cursor が GAS `importChunksFromCefr()` 実行 → `chunks_master` 投入 → フロント CEFR 切替 UI 実装

---

## 10. 検証スクリプト（Cursor / Naoya 用・参考）

納品後にローカルで実行できる簡易チェック:

```javascript
const words = JSON.parse(fs.readFileSync('cefr_words.json'));
const chunks = JSON.parse(fs.readFileSync('cefr_chunks.json'));

// 件数
console.log('words:', words.entries.length, 'expected ~3400');
console.log('chunks:', chunks.entries.length, 'expected ~1800');

// CEFR 分布
const dist = (arr, key) => arr.reduce((m, e) => (m[e[key]] = (m[e[key]]||0)+1, m), {});
console.log('words by cefr:', dist(words.entries, 'cefr'));
console.log('chunks by cefr:', dist(chunks.entries, 'cefr'));

// 重複
const wordKeys = words.entries.map(e => `${e.lemma}|${e.pos}`);
const chunkKeys = chunks.entries.map(e => e.text.toLowerCase().trim());
console.log('word dupes:', wordKeys.length - new Set(wordKeys).size);
console.log('chunk dupes:', chunkKeys.length - new Set(chunkKeys).size);
```

---

*Ver. 1.0 — CEFR 共有データ生成 / Claude work-request*
*Blocking: English-Reader-Trainer Phase 2, English-Listening-Trainer Phase 2 実データ*
