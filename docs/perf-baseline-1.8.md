# AI Meta Viewer v1.8 性能ベースライン（Phase 0）

- 仕様書: `docs/261126_plan_refactoring.md`（以下、仕様書）
- 対象: Chrome 拡張「AI Meta Viewer」Manifest V3 / プレーン JavaScript
- 計測日: 2026-11-26（作業環境のローカル日付）
- ベースライン commit: `a0f0095`（`chore: bump extension version to 1.8.0`）
- 作業ブランチ: `phase/0-baseline`
- Phase 0 の制約: `extension/` 以下のプロダクトコードは未変更。テスト期待値も未変更。
  追加したのは本ドキュメントと、B-04/B-05 の再現用テスト専用スクリプト
  `tests/phase0/measure_baseline.cjs` のみ（§13.2-4 の B-04(c) 例外の範囲）。

> 仕様書 §0-2 が参照する `f114ec0` は本リポジトリの履歴に存在しない。
> そのため Phase 0 は、仕様書の数値と同一のファイル構成を持つ親コミット
> `a0f0095` で計測した。B-01/B-02 の実測値は仕様書 §1.1 の値と完全に一致しており、
> 仕様書が前提とする相対関係（大小・比率）は保たれている。

## 計測環境

| 項目 | 値 |
|---|---|
| OS | Linux 6.18.33.2-microsoft-standard-WSL2 (x86_64) |
| CPU | 13th Gen Intel(R) Core(TM) i5-13600KF（20 logical CPUs） |
| RAM | 31 GiB |
| Node.js | v22.23.2 |
| テスト | `node --test tests/metadata/*.test.cjs` |
| 計測方法 | B-03/B-04 とも初回をウォームアップとして捨て、残り 5 回の中央値 |

## B-01 content script 常駐分の実測と区分内訳

`extension/manifest.json` の `content_scripts[0]` を正として、現行 13 本 + CSS を
`wc -c` 相当（`fs.statSync().size`）で計測した。

### 区分別

| §4.1 区分 | ファイル | bytes |
|---|---|---:|
| 常駐（現行） | `settings_loader.js` | 14,310 |
| 常駐（現行） | `content.js` | 98,854 |
| 常駐（現行） | `badge_controller.js` | 17,696 |
| 常駐（現行）小計 | JS 3 本 | **130,860** |
| 常駐 CSS | `styles.css` | **9,157** |
| 常駐合計（JS + CSS） | 現行の常駐相当 | **140,017** |
| 遅延 A | `comfyui_parser.js` | 22,306 |
| 遅延 A | `ui.js` | 81,877 |
| 遅延 A 小計 | 2 本 | **104,183** |
| 遅延 B | `scanner.js` | 4,047 |
| 遅延 B | `scanner/utils.js` | 3,210 |
| 遅延 B | `scanner/progress-ui.js` | 6,435 |
| 遅延 B | `scanner/thumbnail-finder.js` | 3,511 |
| 遅延 B | `scanner/core.js` | 17,334 |
| 遅延 B | `scanner/ui.js` | 20,247 |
| 遅延 B | `scanner/controller.js` | 6,052 |
| 遅延 B 小計 | 7 本 | **60,836** |
| 条件付き | `adapters.js` | **34,377** |
| 全体合計 | JS 13 本 + CSS | **339,413** |

### FR-CS-01 との関係

- 現行の常駐相当は **140,017 bytes**、目標は **120,000 bytes 以下**。
- 差分は **20,017 bytes の削減不足**（現行常駐の 14.3%、`content.js` の 20.2%）。
- ファイル境界だけで常駐外へ出せる量は、遅延 A + 遅延 B + 条件付きの
  **199,396 bytes**（JS のみ）。ただし `content.js` 自体が常駐に残るため、
  この分離だけでは 120,000 bytes に到達しない。
- `content.js` 内の場面限定コード候補（行範囲ベースの参考実測）:
  - Civitai リトライ / SPA URL 監視 / safetensors リンク監視: 12,415 bytes
  - 動画 observation 一式: 13,843 bytes
  - 直接画像表示（`handleDirectImageView` 周辺）: 1,643 bytes
  - 拡張コンテキスト health check: 1,808 bytes
  - file:// 用デバッグ DOM 描画: 2,000 bytes
  - 参考合計: 31,709 bytes
- したがって Phase 0 時点では「構造上達成不能」とは判断しない。Phase 1 で
  実際の常駐後サイズを `wc -c` で再計測し、120,000 bytes を超える場合は
  実装を完了扱いにせず、§0-2 / FR-CS-01 に従って先に仕様書を改訂する。
- 仕様書 §1.1 の 330,256 bytes（JS）+ 9,157 bytes（CSS）= 339,413 bytes と一致。

## B-02 Service Worker 起動時ロード

`background.js` の `importScripts(...)`（265 行目）を正として計測した。

| ロード順 | ファイル | bytes |
|---:|---|---:|
| 0 | `background.js` 本体 | 224,634 |
| 1 | `pako.js` | 238,805 |
| 2 | `jszip.min.js` | 97,630 |
| 3 | `parser.js` | 76,296 |
| 4 | `video_parser.js` | 42,628 |
| 5 | `video_range_reader.js` | 3,917 |
| 6 | `png_metadata_scanner.js` | 68,156 |
|  | **起動時合計** | **752,066** |

- 仕様書 §1.1 の 752,066 bytes と一致。
- FR-SW-01 の目標は **250,000 bytes 以下**。現行 `background.js` を維持する場合、
  ローダ追加・共有診断ファイルに使える余地は **25,366 bytes**。
  Phase 2 で `background.js` がこれを超えて増える場合は、遅延ロード対象の
  切り出し方を見直す。

## B-03 既存テストの実行時間

### 結果

| run | 扱い | wall time (ms) | Node 内部 duration (ms) | tests | pass | fail |
|---:|---|---:|---:|---:|---:|---:|
| 1 | ウォームアップ（破棄） | 229 | 183.325 | 84 | 84 | 0 |
| 2 | 採用 | 193 | 168.700 | 84 | 84 | 0 |
| 3 | 採用 | 180 | 152.909 | 84 | 84 | 0 |
| 4 | 採用 | 168 | 144.473 | 84 | 84 | 0 |
| 5 | 採用 | 179 | 154.307 | 84 | 84 | 0 |
| 6 | 採用 | 183 | 156.886 | 84 | 84 | 0 |

- **wall time 中央値: 180 ms**（採用 5 回: 168, 179, 180, 183, 193）
- **Node 内部 duration 中央値: 154.307 ms**
- 全 6 回とも `fail 0`。既存テストは緑。
- Phase 1 以降の PR では、この 180 ms を同一環境での比較基準とする。

## B-04 大容量 PNG の scanner 所要時間

テスト専用スクリプト `tests/phase0/measure_baseline.cjs` で合成フィクスチャを
バイト列から生成し、`scanPngMetadataBuffer` を 1 ケースにつき 6 回実行した
（初回破棄、残り 5 回の中央値）。フィクスチャ生成時間は計測に含めない。
VM コンテキストには `parser.js` + `pako.js` + `png_metadata_scanner.js` をロードした。

| ID | ケース | PNG bytes | 採用 5 回 (ms) | 中央値 (ms) | status |
|---|---|---:|---|---:|---|
| a | 4096x4096 / 通常メタデータなし | 65,299 | 631.359, 623.443, 625.938, 635.178, 623.808 | **625.938** | `not-found` |
| b | 4096x4096 / tEXt が IDAT より前 | 65,340 | 466.235, 466.126, 459.623, 464.359, 463.031 | **464.359** | `normal` |
| b2 | 4096x4096 / tEXt が IDAT より後 | 65,339 | 624.085, 623.171, 624.377, 621.684, 626.344 | **624.085** | `normal` |
| c | 1024x1024 / Alpha Stealth あり（合成） | 4,689 | 76.622, 76.686, 75.411, 73.462, 74.676 | **75.411** | `stealth` |

### 読み取り

- (a) と (b2) は IDAT の全展開・行検証が支配的で、約 620〜626 ms。
- (b) は IDAT 前に通常メタデータが確定するため Stealth 候補処理が早期に
  抑制され、約 464 ms。仕様書 §7.1 が述べるチャンク順序依存を実測で確認した。
- (c) は 1024x1024 の Alpha Stealth を最後まで復号して約 75 ms。
- Phase 5 では (a)/(b)/(b2)/(c) を同一スクリプトで再計測し、この中央値と比較する。
- (c) の Stealth はテスト専用生成コードで合成しており、実画像ではない。
  B-06 の実例とは別扱いとする。

## B-05 Phase 4 等価性フィクスチャ（旧 `extractPngMetadata` vs scanner）

同じ PNG バイト列を `extractPngMetadata`（旧 PNG 一括実装）と
`scanPngMetadataBuffer`（現行 scanner）へ入力し、メタデータ内容と確定状態を
比較した。scanner は `parserState` ではなく `status` を返すため、比較時は
次の互換対応を用いた。

| scanner status | 対応する parserState |
|---|---|
| `normal` / `stealth` | `resolved` |
| `not-found` | `empty-confirmed` |
| `unresolved` | `unresolved` |
| `invalid-png` | `invalid` |
| `resource-limit` | `resource-limit` |

| ケース | 旧 parserState | 旧 metadata | scanner status | scanner metadata | 判定 |
|---|---|---|---|---|---|
| tEXt が IDAT より前 | `resolved` | `parameters=before-idat` | `normal` | `parameters=before-idat` | 一致 |
| tEXt が IDAT より後 | `resolved` | `Comment=after-idat` | `normal` | `Comment=after-idat` | 一致（scanner は `intentional-stealth-stop` 診断付き） |
| 非圧縮 iTXt | `resolved` | `parameters=itxt-plain` | `normal` | `parameters=itxt-plain` | 一致 |
| 圧縮 iTXt | `resolved` | `parameters=itxt-compressed` | `normal` | `parameters=itxt-compressed` | 一致 |
| eXIf | `resolved` | `Description=phase0 exif` | `normal` | `Description=phase0 exif` | 一致 |
| Stealth（Alpha） | `empty-confirmed` | なし | `stealth` | `Stealth PNG Info (Alpha)=phase0 stealth` | 差分（旧実装は Stealth 非対応。Phase 4 は scanner を基準） |
| テキストなし | `empty-confirmed` | なし | `not-found` | なし | 対応表上一致 |
| IEND 前で切断 | `unresolved` | なし | `invalid-png` (`reason=truncated`) | なし | 差分（終端分類。Phase 4 で scanner 基準に統一） |
| IEND 後の tEXt（suffix） | `empty-confirmed` | なし | `not-found` | なし | 対応表上一致（suffix は解析しない） |

- Phase 4 の FR-UNI-02 では、Phase 4 着手直前の scanner 出力を基準にし、
  本表を入力ケースとして再利用する。Phase 3 で追加される担体（zTXt / trailing 等）
  による差分は、Phase 4 の PR で一覧化して理由を記録する。
- `truncated-before-iend` の「旧 unresolved / scanner invalid-png」は、
  Phase 4 で旧実装を削除する際の既知差分として残す。テスト期待値の変更は
  本 Phase 0 では行っていない。

## B-06 Stealth 実例の画素数（§7.3 決定ゲート用）

ローカル作業ツリー内の PNG を現行 scanner で走査し、`status=stealth` に
なった実例を記録した。合成 Stealth での代替は不要だった。

| ファイル | 寸法 | 画素数 | MP |
|---|---|---:|---:|
| `test_clean.png` | 1216x832 | 1,011,712 | 0.965 |
| `149017640_p0.png` | 1024x1024 | 1,048,576 | 1.000 |
| `test2_clean_1.png` | 1536x1024 | 1,572,864 | 1.500 |

- 最小: **1,011,712 画素（0.965 MP）**
- 最大: **1,572,864 画素（1.500 MP）**
- 3 例とも Alpha Stealth。RGB Stealth / 16-bit / インターレースの実例は
  今回のローカル集合には含まれない。
- §7.3 の上限 **33,554,432 画素（33.5 MP）** に対し、最大実例でも約 21.3 倍の
  余裕がある。4K（約 8.3 MP）も上限内。
- 決定ゲート判定: 実例が上限に近くないため、上限値の引き上げ・引き下げは
  行わず、仕様書どおり **33.5 MP を暫定値として採用**する。Phase 5 の PR には
  本実測が 3 例のみである旨と、33.5 MP を採用した旨を記録する。

## Phase 0 完了チェック

| 項目 | 状態 |
|---|---|
| B-01 常駐分・区分内訳 | 完了（339,413 / 常駐相当 140,017） |
| B-02 SW 起動時ロード | 完了（752,066） |
| B-03 既存テスト時間 | 完了（wall 中央値 180 ms / 84 tests green） |
| B-04 大容量 PNG 計測 | 完了（4 ケース、各 6 回） |
| B-05 等価性フィクスチャ | 完了（9 ケース、差分記録済み） |
| B-06 Stealth 画素数 | 完了（3 実例、0.965〜1.500 MP） |
| プロダクトコード変更 | なし（`extension/` 差分なし） |
| 既存テスト期待値変更 | なし |

## 再現コマンド

```bash
cd /mnt/c/github/aiMetaViewer

# B-03
node --test tests/metadata/*.test.cjs

# B-01 / B-02 のバイト数
wc -c extension/*.js extension/scanner/*.js extension/*.css

# B-04 / B-05（テスト専用スクリプト、JSON 出力）
node tests/phase0/measure_baseline.cjs

# 変更ファイルの構文確認
node --check tests/phase0/measure_baseline.cjs
```

## Phase 0 PR 用メモ

- 満たした要件: B-01, B-02, B-03, B-04, B-05, B-06（§10）
- 仕様書 §11.4 の手動確認: Phase 0 は対象項目なし（§11.4 に Phase 0 の
  チェックリストはない）。Phase 1 以降で該当項目を実施する。
- Phase 1 以降の比較基準:
  - content script 常駐相当: 140,017 bytes（目標 120,000）
  - SW 起動時: 752,066 bytes（目標 250,000）
  - 既存テスト wall time: 180 ms
  - 4K scanner: a=625.938 ms, b=464.359 ms, b2=624.085 ms
  - 1024x1024 Stealth: 75.411 ms
