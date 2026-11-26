# デバッグ全検知 Level 2（強制 full-body 取得）

## 設定

オプション画面の Debug セクションで **Force Full Fetch (Level 2)** を有効にする。
設定キーは `debugForceFullFetch`（既定 `false`）。

Level 2 は Level 1（`debugAllDetections`）を含む。Level 2 を有効にすると、
Level 1 の論理抑制解除・`DEBUG` バッジ・キャッシュ bypass も同時に有効になる。

## 挙動

- HTTP(S) の初回取得で Range リクエストを送らず、byte 0 からの full-body 取得を行う。
- PNG は byte 0 からの full stream として scanner に渡す。
- WebP は deep scan の上限まで構造を走査する。
- その他の形式は既存の full-fetch リーダーを使う。
- full-body 応答が既に得られている場合は追加取得しない。
- 通常モードの Range 取得、検出優先順位、キャッシュ版数は変更しない。

## 維持される安全上限

Level 2 でも以下は変更しない。

- `MAX_DECODED_BYTES`
- text / zTXt / eXIf prefix
- trailing 1MiB
- JPEG head budget / SOS 打ち切り
- PNG full stream gate（同時本数・in-flight 予算）
- 形式別 head budget
- WebP deep scan 上限

上限で検査できなかった場合は `debug.limited` に理由が入る
（例: `png-idat-not-acquired`, `png-idat-framing-only`）。

## デバッグ表示

- バッジ: `DEBUG`
- モーダル: `Debug Detections` セクション
- Level 2 で full-body 取得を行った場合:
  `debug.forcedFullFetch = true`

## 確認例

`01_furina_1.png`（Software + Stealth）で Level 2 を有効にすると、
Range を使わず full-body 取得し、`DEBUG` バッジ、`Debug Detections`、
`forcedFullFetch: true`、Stealth / Software の担体が表示される。

テストはヘッドレス Chromium 151 で CDP の
`Extensions.loadUnpacked` を使って実施した。


## 確認結果（2026-11-26）

- ブラウザ: ヘッドレス Chromium 151.0.7922.34
- 拡張: CDP `Extensions.loadUnpacked`
- 設定: `debugAllDetections=false`, `debugForceFullFetch=true`
- 画像: `01_furina_1.png`（Software + Stealth）
- ローカルHTTPサーバの観測: 画像取得に Range ヘッダなし（full-body GET）
- UI: `DEBUG` バッジ、`Debug Detections`、`"forcedFullFetch": true`、
  Stealth / Software の担体を確認
- 自動テスト: `node --test tests/metadata/*.test.cjs` 166 pass / 0 fail
