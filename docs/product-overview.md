# English Reader Trainer — 思想・現状仕様・ロードマップ

本ドキュメントは、アプリの **設計思想**、**現在の実装仕様**、**今後の構想** を一か所に整理したものです。詳細 API・スキーマは `english-reader-trainer-work-request.md` を参照してください。

**関連ドキュメント**

- セットアップ: [setup.md](./setup.md)
- 実装サマリ: [README.md](../README.md)
- 公開アプリ: https://nkhippo.github.io/English-Reader-Trainer/

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

**2026年6月時点 — Phase 1〜4 実装済み**

### 2.1 アーキテクチャ

```
ブラウザ (React / GitHub Pages)
    ↕ GET/POST（GAS Web App / session・generate_passage 等）
Google Apps Script
    ↕
Google Sheets（SRS・ログ・メタ） + Google Drive（passages JSON・CEFR・将来 audio）
    ↕
Claude API（ja_translation バッチ + 動的パッセージ生成）
```

**設計上の核心**

1. **SRS は GAS 側** — フロントは「次に何を読むか」を決めない
2. **1パッセージ = 2〜4 チャンク** — 新規露出と既習想起の混在
3. **Sheets / Drive 分離** — 行データは Sheets、本文 JSON は Drive
4. **正答率ではなく遭遇・文脈数** — 卒業判定の主軸

### 2.2 データモデル

| リソース | 役割 | 現状 |
|----------|------|------|
| `chunks_master` | CEFR 語彙・チャンク（約 7,125 件） | ✅ 投入済み。`ja_translation` はバッチ完走前の行あり得る |
| `user_progress` | チャンクごとの SRS 状態 | ✅ 更新中 |
| `encounter_log` | 遭遇イベント（追記専用） | ✅ 更新中 |
| `passages_meta` | 生成パッセージのメタデータ | ✅ 動的生成時に行追加 |
| Drive `shared/` | `cefr_words.json`, `cefr_chunks.json` | ✅ |
| Drive `passages/` | パッセージ本文 JSON | ✅ 動的生成時に保存 |
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
| `session` | 起動時：**1本**のパッセージ + ヘッダー統計 |
| `generate_passage` | 次のパッセージを **1本** 取得（末尾到達時も使用） |
| `due_chunks` | 期限到来・新規チャンク一覧（**パッセージ生成の内部で使用**） |
| `log_encounter` | `encounter_log` 追記 + `user_progress` 更新 |
| `stats` | CEFR 帯別 reviewing / graduated 集計 |

### 2.4 パッセージ供給（Phase 4）

Script Property **`USE_DYNAMIC_PASSAGES`** で切替。

| フラグ | 挙動 |
|--------|------|
| `true` | `due_chunks` から 2〜4 チャンク選定 → Claude 生成 → 検証 → Drive/Sheets 保存 |
| `false` / 未設定 | CEFR 帯ごとの **固定テンプレ 3 本** をランダムローテーション |

**動的生成の流れ（`true` 時）**

1. `due_chunks` で new / learning / reviewing を混在選定（目安: new 1 + learning 1〜2 + reviewing 1）
2. 同一 chunk 組み合わせのキャッシュが Drive にあれば再利用
3. なければ Claude（`claude-haiku-4-5-20251001`）で 3〜6 文の英文 + 和訳 + 位置情報を生成
4. 指定チャンクが本文に含まれるか検証（最大 3 回試行）
5. `passages/` に JSON、`passages_meta` に行を追加
6. **直近 24 時間**に読んだ `passage_id` は再出題しない
7. 失敗時は固定テンプレに **fallback**

### 2.5 フロントエンド（React）

| 機能 | 仕様 | 現状 |
|------|------|------|
| 読み流し | 終わりのない extensive reading | ✅ 「次へ」で **無限に** 続く（都度 GAS から 1 本取得） |
| セッションカウンタ | 仕様に **なし** | ✅ ヘッダーの「N / N」は **削除済み** |
| 30秒タイマー | passive ログ用 | ✅ **表示あり**（残り秒数 + バー）。**自動ページ送りなし** |
| 開始 / 中断オーバーレイ | 低摩擦のため削除 | ✅ 起動後すぐ読める |
| チャンクハイライト | `{{chunk}}` マークアップ | ✅ |
| Marginalia | 右余白に chunk 情報 | ✅ 和訳・例文・遭遇回数・stage |
| 翻訳オーバーレイ | 本文タップで和訳 ~3.5 秒 | ✅ 英文は常に英文のまま |
| 日本語 / EN | **UI ラベルのみ** 切替 | ✅ 本文・marginalia の言語は固定 |
| Got it / Still hard | 低摩擦フィードバック | ✅ |
| Cloze（柱 5） | 約 30% で 1 チャンクを `___` 表示、タップで開示 | ✅ |
| CEFR 切替 | A1+A2 / B1 / B2 | ✅ |
| ヘッダー統計 | reviewing / graduated | ✅ |

### 2.6 思想と実装の対応（現時点）

| 設計柱 | 実装での対応 |
|--------|--------------|
| 文脈内・間隔再会 | SRS + 動的パッセージ（またはテンプレローテ）で **別 passage_id** に遭遇 |
| 異なる文脈での遭遇数 | `distinct_passages_count` がパッセージごとに増加可能 |
| 低摩擦 UX | セッション終了なし、採点は 2 ボタンのみ、タイマーは **通知のみ** |
| 翻訳を挟ませない | 和訳はオーバーレイ / marginalia のみ |
| 軽い想起 | Cloze 空白（確率 30%）で文脈からの recall を促す |
| サーバが次を決める | GAS が due + 生成（クライアントは表示のみ） |

### 2.7 運用タスク（開発外）

| タスク | 状態 |
|--------|------|
| `importChunksFromCefr()` | ✅ 7,125 件 |
| `enrichAllTranslations(10)` → `remaining: 0` | 🔄 要確認・継続 |
| GAS 再デプロイ + `USE_DYNAMIC_PASSAGES=true` | 運用中 |
| 実際に読んで SRS データ蓄積 | 🔄 推奨 |

---

## 3. Phase 4 の位置づけ（実装済み・残課題）

### 3.1 解決したこと

Phase 3 までの **「SRS と固定テンプレ 3 本の切り離し」** を解消した。

- `due_chunks` がパッセージ選定に使われる
- 新しい `passage_id` が増え、`distinct_passages_count` が卒業条件を満たしうる
- フロントは 1 本ずつ取得する **無限読書** フローに変更

### 3.2 残課題・改善候補（2026-06 対応済み）

| 項目 | 内容 | 状態 |
|------|------|------|
| バックグラウンド先読み | `usePassagePrefetch` で次パッセージを読書中に事前取得 | ✅ |
| `CHUNK_JA_FALLBACKS` 撤去 | GAS / フロントのハードコード辞書を削除、`chunks_master.ja_translation` のみ使用 | ✅ |
| 生成品質の検証 | `validatePassageQuality_`（文数・語数・和訳・位置情報）+ 最大 3 回リトライ | ✅ |
| Cloze（柱 5） | `CLOZE_PROBABILITY=0.3`、空白表示 → タップで開示 → 2 回目で marginalia | ✅ |
| 翻訳カバレッジ監査 | GAS `auditTranslationCoverage()` で `remaining` を確認 | ✅（手動実行） |

**継続モニタリング**: 長期利用で Claude 生成パッセージの自然さ・CEFR 遵守を目視確認。`enrichAllTranslations` が `remaining: 0` であることを `auditTranslationCoverage()` で確認。

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

**現状**: ヘッダーの reviewing / graduated 件数のみ（Phase 6 の縮小版）

### スコープ外

- フラッシュカード型 UI
- 文法解説・総合テスト
- 多ユーザ認証（現状 `user_id = naoya` 固定）
- AI による学習計画の自動推薦

---

## 5. フェーズ一覧

```
Phase 1  基盤・UI・encounter ログ           ✅
Phase 2  CEFR 取込・ja_translation バッチ   ✅（バッチ完走は運用）
Phase 3  SRS エンジン                       ✅
         UX 改修（セッション終了削除・無限読書・タイマー表示） ✅
Phase 4  Claude 動的パッセージ生成           ✅（USE_DYNAMIC_PASSAGES）
Phase 5  TTS（Listening Trainer 共有）       ⬜
Phase 6  進捗ダッシュボード                  ⬜
```

---

## 6. 推奨する次のアクション

### 運用（今すぐ）

1. `enrichAllTranslations(10)` を `remaining: 0` まで実行
2. `USE_DYNAMIC_PASSAGES=true` で GAS を再デploy
3. 1〜2 週間、実際に読み `user_progress` / `distinct_passages_count` の増加を確認

### 開発（優先度順）

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

---

*最終更新: 2026-06（Phase 4 残課題対応 — 先読み・Cloze・品質検証・fallback 撤去）*
