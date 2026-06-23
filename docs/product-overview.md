# English Reader Trainer — 思想・現状仕様

> **最終更新:** 2026-06-22  
> **目的:** アプリの設計思想と **現行実装仕様** を Claude レビュー用に整理

**関連**

| ドキュメント | 内容 |
|-------------|------|
| [setup.md](./setup.md) | セットアップ・運用 |
| [chunk-lifecycle-design.md](./chunk-lifecycle-design.md) | チャンク選定・遭遇・卒業（詳細） |
| [claude-api.md](./claude-api.md) | Claude モデル・プロンプト・検証 |
| [claude-api-token-usage.md](./claude-api-token-usage.md) | トークン計測・コスト |
| 公開アプリ | https://nkhippo.github.io/English-Reader-Trainer/ |
| GAS Web App | `https://script.google.com/macros/s/AKfycbwXld2V3mkwok107wvmMP9LwCUkggE1YuZurpQnUna3w1oIBfzVEsGBxPk7rj3h04zP/exec` |

---

## 0. Claude レビュー依頼

1. **個別評価 + exposure 分離** — 卒業の質（OK のみカウント）と文脈露出（次へのみ）の設計は妥当か
2. **フェーズ適応型チャンク選定** — 未学習率に応じた new/復習比率（最大 5 チャンク、new 上限 3）は i+1 を維持できるか
3. **hybrid + 先読み 1 本** — コストと待ち時間のバランス
4. **卒業条件** — got_it ≥ 6 × distinct_passages ≥ 5 × 3 日 × still_hard 率 < 30%

---

## 1. 思想

### 1.1 解く課題

英語チャンクは **文脈・間隔・反復** がなければ定着しない。フラッシュカードには文脈がなく、放任読書では間隔を制御できない。

> **異なる文脈で、間隔をあけて、多数回チャンクに出会わせ、本当に理解したものだけを卒業させる。**

### 1.2 設計柱（現行）

| # | 柱 | 実装 |
|---|-----|------|
| 1 | 単位＝短いパッセージ | 4–7 文、**最大 5 チャンク**（new 最大 3） |
| 2 | 文脈内・間隔再会 | SRS + `prior_contexts` 注入で新文脈生成 |
| 3 | 翻訳を挟ませない | 和訳は本文タップ時の一時表示のみ |
| 4 | 低摩擦 UX | セッション終了なし・「次へ」で即 advance |
| 5 | 軽い想起 | ~30% で 1 チャンク Cloze |
| 6 | 卒業＝能動的 OK × 文脈数 | **個別 OK** と **次への exposure** を分離 |

### 1.3 3 軸の分離（2026-06-22 改修）

| 軸 | トリガー | 効果 |
|----|---------|------|
| 卒業カウント | marginalia「✓ OK」 | `got_it_count++` → 卒業判定の主入力 |
| 保留 | marginalia「△ 保留」 | `still_hard_count++`, stage−1 |
| 文脈露出 | Footer「次へ →」 | 全チャンクに `exposure` → `distinct_passages_count` のみ更新 |
| 1 分タイマー | （記録なし） | 読了目安の表示のみ |

**passive（30 秒自動記録）は廃止。** 離席での誤カウントを防止。

---

## 2. アーキテクチャ

```
ブラウザ (React / GitHub Pages)
  ├─ passage-templates.json 同梱（45 本・オフライン fallback）
  ├─ 先読みキュー 1 本
  ├─ marginalia 個別評価 (got_it / still_hard)
  └─ 「次へ」→ exposure + advance
       ↕ GAS Web App (hybrid)
Google Apps Script
  ├─ フェーズ適応 chunk 選定（最大 5）
  ├─ Drive キャッシュ（完全一致 + スーパーセット）
  ├─ 固定テンプレ 45 本
  └─ Sonnet 動的生成 + span 補正
       ↕
Sheets (SRS, encounter_log, token_usage) + Drive
       ↕
Claude API
  ├─ Sonnet 4.6 — パッセージ生成（prompt caching）
  └─ Haiku 4.5 — critique / enrich
```

---

## 3. データモデル

| リソース | 状態 |
|----------|------|
| `chunks_master` | 7,125 件。`enrich_version` で差分 re-enrich |
| `user_progress` | SRS（個別評価で更新） |
| `encounter_log` | `got_it` / `still_hard` / `exposure` |
| `passages_meta` | 生成キャッシュ + critique |
| `token_usage` | API トークン計測 |
| Drive `passages/` | Sonnet 生成 JSON |
| `shared/passage-templates.json` | 45 本（手書き + ローカル fallback） |

---

## 4. SRS・卒業

### 4.1 ステージ間隔

0→即座, 1→+1日, 2→+3日, 3→+7日, 4→+14日, 5→+30日

### 4.2 シグナル（progress 更新）

| signal | stage | encounter_count | got_it / still_hard | distinct |
|--------|-------|-----------------|---------------------|----------|
| `got_it` | +1 | +1 | got_it++ | 再計算（encounter_log ベース） |
| `still_hard` | −1 | +1 | still_hard++ | 再計算 |
| `exposure` | 据え置き | 据え置き | 据え置き | **のみ更新** |
| `passive` | — | — | — | progress 更新なし |

`distinct_passages_count` のカウント対象: `got_it`, `still_hard`, `exposure`（**`passive` 除外**）。

### 4.3 卒業条件 (`shouldGraduate_`)

- `got_it_count ≥ 6`
- `distinct_passages_count ≥ 5`
- 初回遭遇から ≥ 3 日
- `still_hard_count / got_it_count < 0.3`

passive 放置では卒業しない（got_it が増えない）。

---

## 5. パッセージ供給

### 5.1 hybrid フロー

1. `handleDueChunks_()` — due / new / maintenance
2. `selectChunksForPassage_()` — **フェーズ適応**（下記）
3. `findCachedPassage_()` / `findCachedPassageContainingChunks_()`
4. `pickTemplateCoveringChunks_()` / `pickTemplatePassage_()`
5. `needsNewPassageContext_()` → Sonnet（最大 **2** 試行）

### 5.2 フェーズ適応型選定

`未学習率 = (new + stage0) / バンド内チャンク総数`

| フェーズ | 未学習率 | 構成（最大 5） |
|---------|---------|---------------|
| 導入期 | > 40% | new **3** + 復習 2 |
| 成長期 | 15–40% | new 2 + 復習 3 |
| 定着期 | < 15% | new 0–1 + 復習 4–5 |

復習優先: `still_hard` 多 → `distinct_passages` 少 → `srs_stage` 低。

### 5.3 パッセージ生成仕様

- モデル: `claude-sonnet-4-6`
- 長さ: 4–7 文 / 70–150 語
- 検証: regex + `self_check` + `repairPassageTargetChunkSpans_` / `findChunkSpanInPassage_`
- リアルタイムでは critique なし（オフライン warmup のみ）

---

## 6. フロントエンド機能

| 機能 | 状態 |
|------|------|
| 無限読書 | ✅ |
| marginalia 個別評価 | ✅ |
| 「次へ」+ exposure | ✅ |
| 60 秒表示タイマー（記録なし） | ✅ |
| 先読み 1 本 | ✅ |
| Cloze ~30% | ✅ |
| CEFR A1A2 / B1 / B2 | ✅ |
| ja / en グロス切替 | ✅ |
| ヘッダー reviewing / graduated | ✅ |

---

## 7. 用語集

| 用語 | 意味 |
|------|------|
| チャンク | 語彙・句動詞・コロケーション等の学習単位 |
| パッセージ | 4–7 文、最大 5 チャンクの読み物 |
| exposure | 「次へ」押下時の文脈露出記録 |
| hybrid | キャッシュ → テンプレ → 条件付き Sonnet |
| prior_contexts | 同一チャンクの過去登場文（最大 3）を生成プロンプトに注入 |
| distinct_passages_count | 異なる passage_id での遭遇数（卒業条件） |

---

*最終更新: 2026-06-22 — 個別評価・フェーズ適応選定・先読み 1 本*
