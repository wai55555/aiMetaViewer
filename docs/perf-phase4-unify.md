# Phase 4: PNG パーサ一本化・キャッシュ・重複整理

- 仕様書: `docs/261126_plan_refactoring.md` §8
- ブランチ: `phase/4-unify`
- 基準: Phase 3 完了時点の scanner 出力

## 1. 実装した FR

| 要件 | 実装 |
|---|---|
| FR-UNI-01 | `parser.js` の `extractPngMetadata` / `parsePngTextChunk` / 旧 Stealth ヘルパを削除。PNG は `scanPngMetadataBuffer` のみ |
| FR-UNI-02 | B-05 代表ケースを scanner 基準で固定。`extractMetadata` の PNG 経路も scanner 経由 |
| FR-UNI-03 | `createCrc32State` / `updateCrc32` / `finalizeCrc32` / `extractExifPayload` を維持 |
| FR-CACHE-01 | `clear()` を `meta_cache_` 接頭辞 + index キーの `remove` に変更。`getKeys()` 優先、`get(null)` フォールバック。全体 `clear()` は使わない |
| FR-CACHE-02 | `ensureCapacity` の全件ソートを Map 挿入順の走査へ変更。追い出し結果は FIFO 相当を維持 |
| FR-CACHE-03 | URL 正規化・キー形式変更は行わない（§14 将来課題） |
| FR-DUP-01 | `shared_diagnostics.js` を追加。background の `importScripts` 先頭、content の manifest 先頭で読み込み、安全化・整形の共通実装を使用 |
| FR-DUP-02 | parser / scanner の UTF-8 / fatal UTF-8 / ASCII decoder を定数化。寿命が安全な `slice()` を `subarray()` へ置換 |
| FR-BG-01 | `background.js` のファイル分割は行わない |

## 2. FR-UNI-02 等価性

`tests/metadata/png_parser_unification.test.cjs` で B-05 代表ケースを
`extractMetadata` 経由で検証する。

| ケース | 旧実装（Phase 0 B-05） | Phase 4（scanner 基準） | 差分 |
|---|---|---|---|
| tEXt が IDAT より前 | resolved / parameters | resolved / parameters | なし |
| tEXt が IDAT より後 | resolved / Comment | resolved / Comment | なし |
| 非圧縮 iTXt | resolved / parameters | resolved / parameters | なし |
| 圧縮 iTXt | resolved / parameters | resolved / parameters | なし |
| eXIf | resolved / Description | resolved / Description | なし |
| Stealth | empty-confirmed（旧実装は非対応） | scanner の stealth | 既知差分（Phase 0 記録済み） |
| テキストなし | empty-confirmed | empty-confirmed | なし |
| IEND 前で切断 | unresolved | unresolved（scanner invalid/truncated を parser API で unresolved へ写像） | 写像を明記 |
| IEND 後の tEXt | empty-confirmed | resolved（Phase 3 trailing） | Phase 3 の仕様変更 |

- `extractMetadata` の PNG 経路は `extractPngMetadataWithScanner` のみ。
- scanner の `invalid-png` / `reason=truncated` は、既存の head-budget 契約に合わせて
  parser API では `unresolved` に写像する。scanner 自体の status / reason は変えない。

## 3. キャッシュ

- `clear()` は `chrome.storage.local.getKeys()` がある環境ではキー列挙のみを行う。
  無い場合だけ `get(null)` を使う。`storage.local.clear()` は呼ばない。
- 接頭辞外のキー（設定・他機能の local データ）は削除しない。
- `ensureCapacity` は Map の挿入順をそのまま使い、`get()` の delete/set による
  アクセス順更新も維持する。追い出し対象・件数は従来相当。
- テスト:
  - 接頭辞外キーが残ること
  - `getKeys` 不在時の `get(null)` フォールバック
  - FIFO 追い出し結果
  - アクセス後の追い出し順

## 4. 共有診断

`extension/shared_diagnostics.js`:

- `readOwnProperty` / `readSafeProperty`
- `isSafeEnumValue`
- `classifyErrorType`
- `classifyString`
- `formatSafeDiagnostic`

読み込み順:

- background: `importScripts('shared_diagnostics.js', ...)`
- content: manifest の `shared_diagnostics.js` → `settings_loader.js` → ...

`tests/metadata/shared_diagnostics.test.cjs` で、URL / secret の redaction、
安全フィールドの整形、manifest / importScripts の先頭ロードを確認する。

## 5. バイト数・テスト

| 項目 | 値 |
|---|---:|
| content 常駐（manifest `<all_urls>`） | **118,439 bytes**（目標 120,000） |
| SW 起動時（background + importScripts） | **776,911 bytes**（Phase 2 案Bにより目標対象外） |
| `node --test tests/metadata/*.test.cjs` | **140 tests / 140 pass / 0 fail** |

`node --check`: 変更した `parser.js` / `png_metadata_scanner.js` / `background.js` /
`content.js` / `settings_loader.js` / `shared_diagnostics.js` は OK。

## 6. 手動確認

| §11.4 Phase 4 項目 | 結果 |
|---|---|
| PNG サンプルのモーダル表示 | PASS（`test2.png`） |
| 主要形式（PNG / JPEG / WebP / AVIF）の parser 回帰 | 自動テストで確認 |
| JPEG / WebP / AVIF のブラウザ手動比較 | 未完了（サンプル環境の都合） |
| デバッグモードの診断出力 | 共有診断の単体テストで確認 |
| オプション画面のキャッシュクリアで sync 設定が消えない | `clear()` のスコープテストで確認（実 UI は未実行） |

ブラウザ手動が未完了の項目は、Phase 5 の手動確認時にまとめて再確認する。
