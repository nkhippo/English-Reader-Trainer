# English Reader Trainer — 思想・現状仕様・ロードマップ

本ドキュメントは、アプリの **設計思想**、**現在の実装仕様**、**今後の構想** を一か所に整理したものです。

**関連ドキュメント**

| ドキュメント | 内容 |
|-------------|------|
| [setup.md](./setup.md) | GAS / Drive / GitHub Pages のセットアップ |
| [claude-api.md](./claude-api.md) | Claude モデル・プロンプト現状、テンプレ再生成ワークフロー |
| [README.md](../README.md) | リポジトリ概要 |
| 公開アプリ | https://nkhippo.github.io/English-Reader-Trainer/ |

---

## 1. アプリの思想（何のために作るか）

### 1.1 解こうとしている課題

英語の語彙・コロケーション・チャンクは、文法規則だけでは身につかない **個別頻度由来の知識** である。

- フラッシュカード → 文脈がない
- 放任読書 → 出会い頻度・間隔を制御できない

本アプリはその中間に立ち、**「異なる文脈で、間隔をあけて、多数回出会わせる」** エンジンとして設計する。

### 1.2 6つの設計柱

| # | 柱 | 意味 |
|---|-----|------|
| 1 | **単位＝3〜6文の易しいパッセージ** | パッセージあたり 2〜4 チャンクを自然に織り込む。周囲は既知語（i+1） |
| 2 | **文脈内・間隔再会エンジン** | 各チャンクが 1日・3日・7日… 後に **新しい文脈** で再登場 |
| 3 | **翻訳を挟ませない** | 意味は文脈から取る。日本語訳は本文タップ時の **一時表示** のみ |
| 4 | **低摩擦・高流量 UX** | スワイプで読み流す。**採点摩擦・セッション終了・診断 UI を作らない** |
| 5 | **軽い検索だけ差す** | たまに Cloze 的想起（**約 30% の確率で 1 チャンクを空白表示**） |
| 6 | **卒業＝遭遇回数 × 文脈数** | 正答率ではなく **異なるパッセージでの遭遇数** を価値指標とする |

### 1.3 Listening Trainer との関係

| | Listening Trainer | English Reader Trainer |
|---|-------------------|------------------------|
| 鍛える回路 | 音→意味 | 形→意味（語彙・チャンクの自動化） |
| 入力 | 音声中心 | 視覚中心（音声は Phase 5 で補助） |
| 難度設計 | 難・少・反復・診断 | 易・多・没入・露出 |
| 共有資産 | CEFR JSON、Drive 音声キャッシュ、Claude 生成 | 同左 |

設計原則が正反対なので **別アプリ**。CEFR データは Drive `shared/` で共有。

### 1.4 UX のメタファ

> **書籍の余白に書き込まれた marginalia（注釈）**

学習アプリというより **読書体験**。チャンクの説明はポップアップではなく、右余白（モバイルは下シート）の marginalia に表示する。

---

## 2. 現状の仕様（思想をどう実装しているか）

**2026年6月時点 — Phase 1〜4 実装済み（hybrid + 即時 advance 対応済み）**

### 2.1 アーキテクチャ

```
ブラウザ (React / GitHub Pages)
  ├─ shared/passage-templates.json 同梱（45 本・即時 fallback）
  ├─ 先読みキュー 3 本（usePassagePrefetch）
  └─ 「理解した」→ キュー / ローカルテンプレ即表示（~200ms）
       ↕ GET/POST（GAS Web App）
Google Apps Script（hybrid モード推奨）
  ↕
Google Sheets（SRS・ログ・メタ） + Google Drive（passages / shared / 将来 audio）
  ↕
Claude API（enrich 完走済み + hybrid 時の動的生成）
```

**設計上の核心**

1. **SRS は GAS 側** — 次に読む内容の最終決定は GAS（hybrid ロジック）
2. **UX は即時** — フロントがローカルテンプレ / 先読みで GAS 待ちを隠す
3. **1 パッセージ = 2〜4 チャンク** — 新規露出と既習想起の混在
4. **Sheets / Drive 分離** — 行データは Sheets、本文 JSON は Drive
5. **正答率ではなく遭遇・文脈数** — 卒業判定の主軸

### 2.2 データモデル

| リソース | 役割 | 現状 |
|----------|------|------|
| `chunks_master` | CEFR 語彙・チャンク（7,125 件） | ✅ `ja_translation` / `en_translation` **100%** |
| `user_progress` | チャンクごとの SRS 状態 | ✅ 更新中 |
| `encounter_log` | 遭遇イベント（追記専用） | ✅ 更新中 |
| `passages_meta` | 生成パッセージのメタデータ | ✅ hybrid / dynamic 時に行追加 |
| Drive `shared/` | `cefr_*.json`, `passage-templates.json` | ✅ |
| リポジトリ `shared/passage-templates.json` | フロント同梱テンプレ（45 本） | ✅ GAS と同一 JSON を推奨 |
| Drive `passages/` | 動的生成パッセージ JSON | ✅ hybrid / dynamic 時 |
| Drive `audio/` | TTS キャッシュ | ⬜ Phase 5 |

### 2.3 SRS エンジン（GAS）

**ステージと間隔**

| stage | 次回まで | 状態 |
|-------|----------|------|
| 0 | 即座 | new（未遭遇） |
| 1 | +1日 | learning |
| 2 | +3日 | learning |
| 3 | +7日 | reviewing |
| 4 | +14日 | reviewing |
| 5 | +30日 | graduated 相当 |

**評価シグナル**

| 操作 | signal | SRS への効果 |
|------|--------|--------------|
| 「理解した →」 | `got_it` | stage +1 |
| 「まだ難しい」 | `still_hard` | stage −1（最低 0） |
| **30秒経過**（無操作） | `passive` | stage 維持、`next_due_at` +1日 |
| スワイプ / → キー | （ログなしで次へ） | パッセージ遷移のみ |

**卒業条件**

```
encounter_count >= 5
AND distinct_passages_count >= 3
AND still_hard_count / encounter_count < 0.3
→ status = graduated
```

**GAS エンドポイント**

| action | 用途 |
|--------|------|
| `session` | 起動時：1 本のパッセージ + ヘッダー統計 |
| `generate_passage` | 次パッセージ 1 本（先読み・末尾 advance 用） |
| `due_chunks` | 期限到来・新規チャンク（生成の内部で使用） |
| `log_encounter` | `encounter_log` 追記 + `user_progress` 更新 |
| `stats` | CEFR 帯別 reviewing / graduated 集計 |

### 2.4 パッセージ供給（Phase 4 + hybrid）

Script Property **`USE_DYNAMIC_PASSAGES`** で 3 モード切替。

| 値 | 挙動 |
|----|------|
| 未設定 / `false` | **テンプレのみ** — Drive（または inline fallback）の固定テンプレをローテ |
| **`hybrid`（推奨）** | キャッシュ → テンプレ（due チャンクをカバー）→ **必要時のみ Claude** |
| `true` | **常に Claude 優先**（失敗時テンプレ fallback） |

**固定テンプレ**

- **45 本**（A1A2 / B1 / B2 各 **15 本**）
- ソース: `shared/passage-templates.json`
- GAS: Drive `shared/` から読込（未配置時は inline 3 本/バンド fallback）
- フロント: 同 JSON を **バンドル同梱** → GAS 不通でも即時表示
- ⚠️ **現状テンプレ本文は手書き**（Claude API 未使用）。品質改善は [claude-api.md §6](./claude-api.md) 参照

**hybrid モードの GAS フロー**

1. `due_chunks` から 2〜4 チャンク選定
2. 同一 chunk 組み合わせの **キャッシュ** が Drive にあれば再利用
3. due チャンクを **カバーするテンプレ** があればそれを返す
4. チャンクが **new** または **distinct_passages_count < 3** なら Claude 生成
5. 生成物は `validatePassageQuality_` で検証（最大 3 回リトライ）
6. `passages/` + `passages_meta` に保存
7. クライアント指定 + 直近 24h の `passage_id` を **exclude** して重複回避
8. 失敗時は固定テンプレ fallback

**Claude 動的生成（参考）**

- モデル: `claude-haiku-4-5-20251001`
- 3〜6 文、60〜120 語、CEFR 帯準拠、chunk 位置情報付き
- 詳細プロンプト: [claude-api.md §4.3](./claude-api.md)

**フロント側の即時 advance フロー**

```
「理解した」/「まだ難しい」
  → log_encounter（非同期）
  → 先読みキューから 1 本（同期）
  → なければローカルテンプレ（同期）
  → ページ遷移 ~200ms（Saving オーバーレイは遷移中のみ）
  → バックグラウンドで GAS 先読みキュー補充（3 本）
```

### 2.5 フロントエンド（React）

| 機能 | 仕様 | 現状 |
|------|------|------|
| 読み流し | 終わりのない extensive reading | ✅ 末尾で自動 append、セッション終了なし |
| 即時 advance | GAS 待ちなしで次パッセージ | ✅ キュー + ローカルテンプレ |
| 先読み | 読書中に 3 本 prefetch | ✅ `PREFETCH_QUEUE_SIZE=3` |
| 30秒タイマー | passive ログ用 | ✅ 残り秒数 + バー。**自動ページ送りなし** |
| 読み始め / 中断 | 低摩擦の開始・一時停止 | ✅ StartReadingOverlay + Suspend |
| チャンクハイライト | `{{chunk}}` マークアップ | ✅ |
| Marginalia | chunk 情報（ja / en グロス） | ✅ UI=EN 時は英語グロス |
| 翻訳オーバーレイ | 本文タップで和訳 ~3.5 秒 | ✅ 英文本文は常に英文 |
| UI 言語 | ラベルのみ ja / en 切替 | ✅ |
| Got it / Still hard | 低摩擦フィードバック | ✅ |
| Cloze（柱 5） | ~30% で 1 チャンク `___`、タップで開示 | ✅ |
| CEFR 切替 | A1+A2 / B1 / B2（セグメント） | ✅ |
| ヘッダー統計 | reviewing / graduated + **初回露出・卒業のプログレスバー** | ✅ |

### 2.6 思想と実装の対応

| 設計柱 | 実装での対応 |
|--------|--------------|
| 文脈内・間隔再会 | SRS + hybrid（キャッシュ / テンプレ / Claude）で **別 passage_id** に遭遇 |
| 異なる文脈での遭遇数 | `distinct_passages_count` がパッセージごとに増加 |
| 低摩擦 UX | 即時 advance、2 ボタンのみ、タイマーは通知のみ |
| 翻訳を挟ませない | 和訳はオーバーレイ / marginalia のみ |
| 軽い想起 | Cloze 空白（30%） |
| サーバが次を決める | GAS hybrid が due + 生成を決定。フロントは体感速度のためローカル fallback |

### 2.7 運用状態（2026-06-21）

| タスク | 状態 |
|--------|------|
| `importChunksFromCefr()` | ✅ 7,125 件 |
| `enrichAllTranslations()` | ✅ `remaining: 0`（100%） |
| `enrichAllEnglishGlosses()` | ✅ `remaining: 0`（100%） |
| GAS hybrid デプロイ | ✅ `USE_DYNAMIC_PASSAGES=hybrid` |
| Drive `passage-templates.json` | ✅ 45 本 |
| フロント GitHub Pages | ✅ 最新 URL・テンプレ同梱 |
| 日常読書で SRS データ蓄積 | 🔄 継続推奨 |

---

## 3. 直近の改善（2026-06）

### 3.1 完了したこと

| 項目 | 内容 |
|------|------|
| hybrid モード | キャッシュ → テンプレ → 条件付き Claude |
| テンプレ拡充 | 3 本/バンド → **15 本/バンド**（計 45 本） |
| フロント同梱 + 即時 fallback | `localPassages.js` + `passage-templates.json` |
| 先読みキュー | 3 本バックグラウンド prefetch |
| 楽観的 UI | Saving オーバーレイを遷移 ~200ms に限定 |
| 同一パッセージ連続 | exclude_passage_ids + インデックス非リセット |
| EN marginalia | UI=EN 時 `en_translation` 表示 |
| enrich 完走 | ja / en グロス 7,125 / 7,125 |
| 品質検証 | `validatePassageQuality_` + 最大 3 回リトライ |
| Cloze | `CLOZE_PROBABILITY=0.3` |

### 3.2 進行中・次の改善候補

| 項目 | 内容 | 優先度 |
|------|------|--------|
| **テンプレ品質の Claude 再生成** | 手書き 45 本 → 改善プロンプトで作り直し | 高 |
| **モデル / プロンプト更新** | Haiku 統一 → 用途別（テンプレ=Sonnet 等） | 高 |
| **テンプレ一括生成 GAS 関数** | `generateTemplateBatch_()` でレビュー可能な出力 | 中 |
| Claude 生成品質の目視監視 | hybrid 時の自然さ・CEFR 遵守 | 中 |
| Phase 5 TTS | Listening Trainer 共有キャッシュ | 低（次フェーズ） |
| Phase 6 ダッシュボード | 接触量・卒業数の可視化 | 低 |

テンプレ / プロンプト改善の手順は **[claude-api.md](./claude-api.md)** に記載。

---

## 4. 今後の構想（Phase 5〜6）

### Phase 5: TTS 音声統合（補助）

**目的**: 読みながら聴く dual coding。必須ではない。

- `/tts` — Listening Trainer と **Drive キャッシュ共有**
- パッセージ音声 → `passages_meta.audio_drive_url`
- フロントに再生 UI（マイクアイコン等）

**前提**: パッセージが Drive に保存されていること（Phase 4 ✅）

### Phase 6: 進捗ダッシュボード

**目的**: 接触量・卒業数の可視化。**AI 推薦はしない。**

- CEFR × ステータス（new / learning / reviewing / graduated）の内訳
- 日次接触カレンダー
- 「卒業近い」「停滞中」チャンクリスト
- 累積読書時間

**現状**: ヘッダーに reviewing / graduated 件数 + 初回露出・卒業の 2 本プログレスバー（Phase 6 の縮小版）

### スコープ外

- フラッシュカード型 UI
- 文法解説・総合テスト
- 多ユーザ認証（現状 `user_id = naoya` 固定）
- AI による学習計画の自動推薦

---

## 5. フェーズ一覧

```
Phase 1  基盤・UI・encounter ログ              ✅
Phase 2  CEFR 取込・ja/en enrich               ✅（7,125 / 7,125）
Phase 3  SRS エンジン                          ✅
         UX（無限読書・タイマー・Cloze）         ✅
Phase 4  パッセージ供給（hybrid + 45 テンプレ） ✅
         即時 advance + 先読み 3 本              ✅
Phase 4b テンプレ Claude 再生成・プロンプト改善  🔄 次タスク
Phase 5  TTS（Listening Trainer 共有）          ⬜
Phase 6  進捗ダッシュボード                     ⬜
```

---

## 6. 推奨する次のアクション

### コンテンツ品質（優先）

1. [claude-api.md §6](./claude-api.md) の依頼文で Claude に **プロンプト改善案 + サンプルテンプレ** を生成してもらう
2. `gas/Code.gs` のモデル / プロンプトを更新
3. `shared/passage-templates.json` を Claude 生成版に差し替え（Drive + フロント同梱）
4. GAS 再デプロイ → 本番で 15 本/バンドの多様性を確認

### 運用（継続）

1. 本番 https://nkhippo.github.io/English-Reader-Trainer/ で日常読書
2. `user_progress` の `distinct_passages_count` 増加を確認
3. hybrid 時の Claude 生成パッセージをたまに目視チェック

### 開発（その後）

1. **Phase 5** — TTS + 再生 UI
2. **Phase 6** — ダッシュボード画面

---

## 7. 用語集

| 用語 | 意味 |
|------|------|
| チャンク | 語彙・コロケーション・句動詞などの学習単位（例: `managed to`） |
| パッセージ | 3〜6 文の短い読み物。2〜4 チャンクを含む |
| 遭遇（encounter） | パッセージを読みチャンクに触れたイベント |
| passive | 30 秒経過時の自動ログ（明示評価なし） |
| SRS | Spaced Re-encounter — 間隔を空けた文脈内再会 |
| due | `next_due_at` を過ぎ、再投入すべきチャンク |
| graduated | 卒業 — 遭遇数・文脈多様性・still_hard 率を満たした状態 |
| marginalia | 右余白のチャンク注釈パネル |
| hybrid | キャッシュ → テンプレ → 条件付き Claude の 3 段供給 |
| 先読みキュー | 読書中に GAS から裏で取得する次 3 パッセージ |

---

*最終更新: 2026-06-21（hybrid・45 テンプレ・即時 advance・enrich 100%・claude-api 連携）*
