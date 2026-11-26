# Phase 2 / FR-PAKO-01〜03: pako → DecompressionStream 検証と判断

- 仕様書: `docs/261126_plan_refactoring.md` §5.3
- 検証スクリプト: `tests/phase2/pako_gate.cjs`（テスト専用、プロダクトコード非変更）
- 実行: `node tests/phase2/pako_gate.cjs`
- 環境: Node.js v22.23.2、`DecompressionStream` 利用可

## 1. 有効データの一致（FR-PAKO-01）

現行の PNG scanner / parser が扱う 3 種類の圧縮データを生成し、pako と
`DecompressionStream` の展開結果をバイト単位で比較した。

| ケース | 形式 | 入力 bytes | 展開後 bytes | バイト一致 |
|---|---|---:|---:|---|
| PNG IDAT（4096×4096 相当の row 列） | zlib | 16,321 | 16,781,312 | 一致 |
| 圧縮 iTXt 本文 | zlib | 64 | 1,867 | 一致 |
| Stealth payload | gzip | 97 | 83 | 一致 |

有効データについては、3 ケースとも pako と `DecompressionStream` の出力は
完全に一致した。

## 2. 破損・切断時の挙動（FR-PAKO-01）

各ケースについて、truncated / bad-checksum / bad-header / empty /
trailing-bytes を比較した。代表的な差異は次のとおり。

| 入力 | pako（ワンショット） | pako（Inflate ストリーム） | DecompressionStream |
|---|---|---|---|
| truncated | `undefined` を返す（例外にならない） | `err=0`, `ended=false`、途中まで出力 | `TypeError`（cause: `unexpected end of file`）、途中まで出力 |
| bad-checksum | `incorrect data check` を throw | `err=-3`, `ended=true` | `TypeError`（cause: `incorrect data check`） |
| bad-header | `incorrect header check` を throw | `err=-3`, `ended=true` | `TypeError`（cause: `incorrect header check`） |
| empty | `undefined` を返す | `err=0`, `ended=false` | `TypeError`（cause: `unexpected end of file`） |
| trailing-bytes | `incorrect header check` を throw（ケースにより異なる） | `err=-3`（trailing junk ではない） | `TypeError`（`Trailing junk found after the end of the compressed stream`） |

- pako のワンショット API は、truncated / empty で `undefined` を返し、
  例外を投げない。scanner は `pako.Inflate` の `err` / `ended` を見て
  不完全を判定している。
- `DecompressionStream` は全ての破損で `TypeError` を reject するが、
  メッセージは `cause` に入る。pako の `err` / `msg` と同じ診断カテゴリへ
  写像するには新しい変換層が必要。
- trailing-bytes の解釈は pako と `DecompressionStream` で異なる。

## 3. FR-PAKO-02 ゲート判定

| 条件 | 判定 | 理由 |
|---|---|---|
| (a) scanner 公開 API の同期性維持、または影響範囲が scanner 内部と直接呼び出し側に閉じる | **不成立** | `scanPngMetadataBuffer` は同期 API。`scanPngMetadataStream` は async だが内部の pako は同期。`parser.js` の `parsePngTextChunk` も同期。`DecompressionStream` は本質的に非同期で、scanner/parser/background の呼び出し契約とテストを広く非同期化する必要がある |
| (b) 破損・切断時の診断カテゴリが現行と一致 | **不成立** | pako の `err`/`ended`/例外と `DecompressionStream` の `TypeError`/cause が一致しない。trailing の解釈も異なる |
| (c) 展開後バイト数の逐次計数と上限 abort を維持 | 実装可能 | reader ループで逐次計数できるが、(a)(b) 不成立のため採用しない |
| (d) §11.2 Phase 2 のテスト密度維持 | 条件付きで可能 | 非同期化に追随するテスト変更が必要 |

**結論: 移行中止（FR-PAKO-03）。** 現行 `pako.js` を維持する。
`pako.js` の inflate-only カスタムビルドも、§5.3 の禁止事項により行わない。

## 4. 仕様書への反映

- §3 に **CUT-13**（pako → DecompressionStream 移行）を追加。
- 付録 A の CUT 範囲を `CUT-01〜CUT-13` に更新。
- §5.3 に本判断を追記。

## 5. 補足

- 本検証は Node.js の `DecompressionStream` 実装で行った。Chrome 95+ の
  実装でも形式（deflate/gzip）は同じだが、エラーメッセージの文字列は
  環境依存であり、診断カテゴリの一致を前提にしない。
- pako の遅延ロード（FR-SW-02 の scanner との組ロード）は、Phase 2 の
  Service Worker 遅延ロード方式そのものが §5.2 の制約で保留になったため、
  現時点では未適用。方式決定後に再評価する。
