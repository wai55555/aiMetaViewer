# Phase 3: 検知追加（zTXt / COM / JPEG XMP / trailing / EXIF Software / XMP 改善）

- 仕様書: `docs/261126_plan_refactoring.md` §6
- ブランチ: `phase/3-detection`
- ベースライン: `docs/perf-baseline-1.8.md`（Phase 0）

## 1. 実装した FR

| 要件 | 実装 |
|---|---|
| FR-ZTXT-01〜06 | PNG scanner に zTXt を追加。8 語の許可リスト、128 bytes 先読み、2 MiB 入力 / 8 MiB 出力上限、method 0 のみ、CRC は既存テキストチャンクと同じ |
| FR-COM-01〜04 | JPEG COM を SOS 前のみ走査。UTF-8 デコード、JSON 生成キーまたは A1111 形式の内容ゲート、最初の通過 COM のみ、EXIF 優先 |
| FR-JXMP-01〜04 | JPEG APP1 XMP を識別して既存 `parseXmpMetadata` へ。Extended XMP はスキップ。切り取り時は unresolved / metadataPartial |
| FR-TRL-01〜04 | IEND 後の同一 push / 同一 buffer 内だけ trailing を走査。tEXt/iTXt/zTXt/eXIf、CRC 検証、1 MiB 上限、本体優先 |
| FR-EXIF-01〜03 | EXIF `0x0131 Software` を 256 bytes 以下で収穫。他タグの既存処理は不変 |
| FR-XMP-01〜03 | CDATA、単一引用符属性、16 進参照 / `&apos;`、名前空間接頭辞あり/なしの parameters タグ。既存デコード順は維持し、新規分の二重デコードを防止 |
| FR-DET-00a〜00f | 追加取得なし、既存担体優先、parserState 規則、テスト内バイト列、表示エスケープ方針、キャッシュ版数更新 |

### キャッシュ版数

- `PNG_SCANNER_CACHE_VERSION`: `png-scanner-v2` → **`png-scanner-v3`**
- `PARSER_CACHE_VERSION`: `parser-v1` → **`parser-v2`**

## 2. 設計上の注意

- zTXt は **許可キーワードの先頭部だけ**を 128 bytes の先読みで判定し、許可外なら
  チャンク全体を確保せずスキップする。許可時のみ 2 MiB 以下の圧縮本文を確保する。
- trailing は IEND 後の **同じ `feed()` 内**の残バイトだけを見る。stream 経路で
  IEND と別 push になった suffix は読まない（仕様どおりのベストエフォート）。
- trailing の CRC 検証は解釈対象種別（tEXt/iTXt/zTXt/eXIf）のみ。対象外種別は
  長さでスキップし、CRC を計算しない。
- JPEG COM は UTF-8 fatal デコード。不正 UTF-8 は無関係コメントとして無視する。
- JPEG XMP は `xmlns:parameters="..."` のような名前空間宣言を parameters 属性と
  誤認しないよう、属性の前に空白/先頭を要求する。
- XMP の新規デコード（16 進参照、`&apos;`）は `&amp;` 展開より前に処理し、
  `&amp;#x41;` / `&amp;apos;` の二重デコードを起こさない。既存の
  `&amp;#10;` → 改行の挙動は維持する。

## 3. テスト

- `node --test tests/metadata/*.test.cjs`: **131 tests / 131 pass / 0 fail**
- 変更 JS の `node --check`: OK
- 追加テスト:
  - `png_ztext.test.cjs`: 許可リスト全 8 語、許可外の inflate 回数・大チャンク非確保、
    method 不一致、入出力上限、CRC、本体優先、stream 境界
  - `png_trailing.test.cjs`: tEXt/zTXt、本体優先、framing 不成立、CRC 不一致、
    対象外種別スキップ、eXIf 64KB prefix、1 MiB 上限、stream 同一 push
  - `jpeg_com_xmp.test.cjs`: A1111/JSON/日本語 COM、非対象 COM、UTF-8 不正、
    EXIF 優先、複数 COM、writeJpegMetadata ラウンドトリップ、XMP、Extended XMP、
    切り取り、EXIF/XMP 優先
  - `exif_software.test.cjs`: Software 収穫、256 bytes 上限、両エンディアン
  - `xmp_parser.test.cjs`: CDATA、単一引用符、16 進/apos、名前空間/非接頭辞、
    二重デコード防止、256 KiB の ReDoS 確認
  - `phase3_common.test.cjs`: HTML 断片のテキスト描画契約、キャッシュ版数

### Phase 0 B-04 との比較（scanner 単体）

| ケース | Phase 0 | Phase 3 | 差分 |
|---|---:|---:|---:|
| 4096² / メタデータなし | 625.938 ms | 631.244 ms | +5.306 ms |
| 4096² / tEXt 前 | 464.359 ms | 456.767 ms | -7.592 ms |
| 4096² / tEXt 後 | 624.085 ms | 627.155 ms | +3.070 ms |
| 1024² / Stealth | 75.411 ms | 74.292 ms | -1.119 ms |

Phase 3 の追加処理は negative の既存 4 ケースには入らないため、差分は測定ノイズの
範囲。テスト時間は追加テストにより Phase 0 の 180 ms から 298 ms へ増えた
（プロダクトの処理時間ではない）。

## 4. 手動確認（Chrome / Chromium、unpacked）

| §11.4 Phase 3 項目 | 結果 |
|---|---|
| PNG zTXt + trailing を `file://` で表示 | PASS（zTXt の Positive/Negative/Grid を表示） |
| PNG zTXt + trailing をローカル HTTP Range で表示 | PASS（206 応答経由） |
| JPEG COM をローカル HTTP Range で表示 | PASS（A1111 セクションを表示） |
| JPEG APP1 XMP を `file://` で表示 | PASS（XMP parameters を表示） |
| JPEG APP1 XMP をローカル HTTP Range で表示 | PASS |
| HTML 断片のエスケープ | テストで確認（モーダル本文は `textContent` 経路） |

手動確認用フィクスチャは一時ディレクトリで生成し、リポジトリには追加していない。
