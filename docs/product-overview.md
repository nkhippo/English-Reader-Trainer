# English Reader Trainer — 思想・現状仕様・ロードマップ

本ドキュメントは、アプリの **設計思想**、**現在の実装仕様**、**運用状態** を一か所に整理したものです。Claude API の詳細は [claude-api.md](./claude-api.md) を参照してください。

**関連ドキュメント**

| ドキュメント | 内容 |
|-------------|------|
| [setup.md](./setup.md) | GAS / Drive / GitHub Pages のセットアップ・運用手順 |
| [claude-api.md](./claude-api.md) | Claude モデル・プロンプト全文・検証（**Claude レビュー用**） |
| [claude-api-prompt-renewal-work-request.md](./claude-api-prompt-renewal-work-request.md) | 2026-06 プロンプトリニューアル設計書 |
| [chunk-lifecycle-design.md](./chunk-lifecycle-design.md) | チャンク提案・AI 生成・データ管理（**Claude 設計レビュー用**） |
| [README.md](../README.md) | リポジトリ概要 |
| 公開アプリ | https://nkhippo.github.io/English-Reader-Trainer/ |
| GAS Web App | `https://script.google.com/macros/s/AKfycbydfzsGuLKFKHNVjnZhEDd-hLSYe0tJTDYv0EcovHRMRGZRJIPJzZxEa2mD4jGSKUv8/exec` |

---

## 0. Claude レビュー依頼（このドキュメントの目的）

**English Reader Trainer** は、CEFR チャンクを **異なる文脈・間隔をあけて多数回再会** させ、チャンク知識を自動化する多読アプリです。

2026-06-21 時点で以下が完了・進行中です。Claude に以下をレビューしてほしいです:

1. **思想（§1）と実装（§2）の整合** — 特に「異なる文脈での再会」が hybrid + prior_contexts で担保されているか
2. **プロンプトリニューアル後のパイプライン** — enrich 再実行 → テンプレ Sonnet 再生成の順序は妥当か
3. **UX と学習効果のトレードオフ** — 即時 advance（ローカルテンプレ）と GAS hybrid の役割分担
4. **残タスク（§3.2）** の優先度と抜け

---

## 1. アプリの思想

### 1.1 解こうとしている課題

英語の語彙・コロケーション・チャンクは **個別頻度由来の知識**。フラッシュカードには文脈がなく、放任読書では間隔を制御できない。

> **異なる文脈で、間隔をあけて、多数回チャンクに出会わせ、チャンク知識を自動化する。**

### 1.2 6つの設計柱

| # | 柱 | 意味 |
|---|-----|------|
| 1 | **単位＝3〜6文の易しいパッセージ** | 2〜4 チャンクを自然に織り込む。周囲は既知語（i+1） |
| 2 | **文脈内・間隔再会エンジン** | 1日・3日・7日… 後に **新しい文脈** で再登場 |
| 3 | **翻訳を挟ませない** | 和訳は本文タップ時の一時表示のみ |
| 4 | **低摩擦・高流量 UX** | 採点摩擦・セッション終了・診断 UI を作らない |
| 5 | **軽い検索だけ差す** | ~30% で 1 チャンクを Cloze 空白 |
| 6 | **卒業＝遭遇回数 × 文脈数** | 正答率ではなく **異なる passage_id での遭遇数** |

### 1.3 SLA 原理との対応（2026-06 プロンプトリニューアル）

| 原理 | 実装 |
|------|------|
| 理解可能 input（i+1） | パッセージ system プロンプト §1 + new チャンク最大 2 個/パッセージ |
| 気づき | `{{chunk}}` ハイライト + marginalia |
| 符号化の多様性 | **`getChunkPriorContexts_()` → 生成プロンプト注入** |
| コアミーニング | ja enrich + `intended meaning` 注入 |
| L2-L2 グロス | en enrich（グロス自体 i+1） |

### 1.4 UX メタファ

> 書籍の余白に書き込まれた **marginalia（注釈）** — 学習アプリというより読書体験。

---

## 2. 現状の仕様

**2026-06-21 — Phase 1〜4 実装済み。Phase 4b（プロンプトリニューアル）コード反映済み、enrich 再実行フェーズ。**

### 2.1 アーキテクチャ

```
ブラウザ (React / GitHub Pages)
  ├─ passage-templates.json 同梱（45 本・即時 fallback）
  ├─ 先読みキュー 3 本
  └─ 「理解した」→ 先読みキュー / GAS hybrid（SRS 駆動）→ ローカルテンプレ fallback
       ↕ GAS Web App (hybrid)
Google Apps Script
  ├─ キャッシュ (critique_verdict=pass 優先)
  ├─ 固定テンプレ 45 本
  └─ Sonnet 動的生成 (prior_contexts + self_check)
       ↕
Sheets (SRS) + Drive (passages/, shared/)
       ↕
Claude API
  ├─ Sonnet 4.6 — パッセージ生成
  ├─ Haiku 4.5 — critique / enrich
  └─ Haiku 4.5 — ja/en バッチ（🔄 再実行中）
```

### 2.2 データモデル

| リソース | 件数 / 状態 |
|----------|------------|
| `chunks_master` | 7,125 件。**ja/en/example はリフレッシュ済み → enrich 再填入中** |
| `user_progress` | SRS 状態（リフレッシュ後も保持） |
| `encounter_log` | 遭遇ログ（保持） |
| `passages_meta` | critique 列追加済み。旧キャッシュは削除済み |
| Drive `passages/` | 空（リフレッシュ後。warmup で再蓄積予定） |
| Drive `shared/passage-templates.json` | 45 本（**手書き**。Sonnet 再生成予定） |
| リポジトリ `shared/passage-templates.json` | フロント同梱（GAS と同期推奨） |

### 2.3 SRS エンジン

**ステージ:** 0→即座, 1→+1日, 2→+3日, 3→+7日, 4→+14日, 5→+30日

**シグナル:** got_it (+1 stage) / still_hard (−1) / passive (+1日延長)

**卒業:** got_it ≥ 6 AND distinct_passages ≥ 5 AND 初回遭遇から ≥ 3日 AND still_hard率 < 30%（passive のみでは卒業しない）

### 2.4 パッセージ供給（hybrid）

| `USE_DYNAMIC_PASSAGES` | 挙動 |
|------------------------|------|
| `hybrid`（**デフォルト**） | キャッシュ → テンプレ → 条件付き Sonnet 生成 |
| `true` | 常に Sonnet 優先 |
| `false` / `template` | テンプレのみ |

**hybrid フロー**

1. `selectChunksForPassage_()` — i+1 ガード付き 2〜4 チャンク選定
2. `findCachedPassage_()` — critique pass 優先
3. `pickTemplateCoveringChunks_()` — due チャンクをカバーするテンプレ
4. `needsNewPassageContext_()` — new または distinct_passages < 3 なら Sonnet 生成
5. リアルタイム: regex + self_check のみ（critique は待たない）
6. バックグラウンド: `warmupPassagesForBand_()` / `generatePassageWithCritique_()` で critique 合格品をキャッシュ

**Claude パッセージ生成（2026-06 更新後）**

- モデル: **`claude-sonnet-4-6`**
- system + user 分離、6 原則（i+1 / inferability / variety 等）
- 各チャンクに `intended meaning` + `prior_contexts`（最大 3 件）
- 出力に `self_check` 必須

### 2.5 フロントエンド

| 機能 | 状態 |
|------|------|
| 無限読書（セッション終了なし） | ✅ |
| 即時 advance + 先読み 3 本 | ✅ |
| hybrid GAS + ローカルテンプレ fallback | ✅ |
| Marginalia（ja / en グロス） | ✅ enrich 再填入後に品質向上 |
| Cloze ~30% | ✅ |
| CEFR A1A2 / B1 / B2 切替 | ✅ |
| ヘッダー reviewing / graduated | ✅ |

### 2.6 運用状態（2026-06-21）

| タスク | 状態 |
|--------|------|
| Phase 1–4 コード | ✅ |
| hybrid デプロイ | ✅ |
| プロンプトリニューアル（Code.gs） | ✅ コミット `3a5c22a` |
| `preparePromptRenewalRefresh()` | ✅ 7,125 行クリア実行済み |
| `enrichAllTranslations()` | 🔄 **次に実行** |
| `enrichAllEnglishGlosses()` | ⬜ ja 完走後 |
| `generateTemplateBatch_()` | ⬜ enrich 完走後 |
| 固定テンプレ 45 本 Sonnet 差し替え | ⬜ サンプルレビュー後 |
| GitHub Pages | ✅ URL 更新済み（`26b58c8`） |

---

## 3. フェーズと残タスク

### 3.1 完了済み（2026-06）

| カテゴリ | 内容 |
|---------|------|
| UX | 即時 advance、先読み 3 本、楽観的 UI、Cloze |
| 供給 | hybrid、45 テンプレ、exclude 重複回避 |
| Claude | Sonnet/Haiku 分離、SLA 準拠プロンプト、prior_contexts、critique 2 経路 |
| インフラ | refresh 関数、critique 列、template batch / warmup 関数 |

### 3.2 進行中・次のタスク

| 優先 | タスク | 担当 |
|------|--------|------|
| **P0** | `enrichAllTranslations()` → `remaining: 0` | Naoya（GAS 実行） |
| **P0** | `enrichAllEnglishGlosses()` → `remaining: 0` | Naoya（GAS 実行） |
| **P1** | `generateTemplateBatch_()` 各バンド 1 本 → Claude/Naoya レビュー | Naoya + Cursor |
| **P1** | 45 本テンプレ Sonnet 再生成 → `passage-templates.json` マージ | Cursor |
| **P2** | `warmupPassagesForBand_()` で critique 合格キャッシュ蓄積 | Naoya |
| **P2** | hybrid 生成品質の目視監視（3 例以上） | Naoya |
| **P3** | Phase 5 TTS | 将来 |
| **P3** | Phase 6 ダッシュボード | 将来 |

---

## 4. フェーズ一覧

```
Phase 1   基盤・UI・encounter ログ                 ✅
Phase 2   CEFR 取込・ja/en enrich                   🔄 再実行中
Phase 3   SRS エンジン                              ✅
Phase 4   hybrid + 45 テンプレ + 即時 advance       ✅
Phase 4b  プロンプトリニューアル（SLA 準拠）          🔄 コード ✅ / enrich 🔄 / テンプレ ⬜
Phase 5   TTS                                         ⬜
Phase 6   ダッシュボード                              ⬜
```

---

## 5. 推奨オペレーション（現在地から）

```
✅ preparePromptRenewalRefresh()     … 完了
→  enrichAllTranslations()           … 実行中 / 次
→  enrichAllEnglishGlosses()         … ja 完走後
→  generateTemplateBatch_("B1", 1)   … サンプルレビュー
→  45 本テンプレ差し替え              … レビュー後 Cursor
→  warmupPassagesForBand_("B1", 3)    … 任意
```

---

## 6. 用語集

| 用語 | 意味 |
|------|------|
| チャンク | 語彙・句動詞・コロケーション等の学習単位 |
| パッセージ | 3〜6 文、2〜4 チャンクを含む読み物 |
| hybrid | キャッシュ → テンプレ → 条件付き Sonnet |
| prior_contexts | 同一チャンクの過去登場文（最大 3 件）を生成プロンプトに注入 |
| critique | Haiku による 7 基準 rubric 採点（オフライン） |
| distinct_passages_count | チャンクが登場した異なる passage_id 数（卒業条件） |

---

*最終更新: 2026-06-21 — プロンプトリニューアル反映・refresh 完了・enrich 再実行フェーズ*
