# v2.0.0 手動確認記録（2026-11-26）

対象: `release/2.0.0`（`extension/manifest.json` = 2.0.0）  
ブラウザ: Playwright Chromium **151.0.7922.34**（Windows、headless）
拡張機能: `Extensions.loadUnpacked` で `extension/` を読み込み

> Chrome 151 のコマンドライン `--load-extension` は無視されるため、
> CDP の `Extensions.loadUnpacked` を使用した。拡張 ID は
> `hibnfpeoimlhomdcfmflanngooecnmma`。

## AVIF 実表示

- サンプル: `fox.profile0.8bpc.yuv420.avif`（link-u/avif-sample-images）
- 結果: **PASS**。Chrome が AVIF をデコードし、`naturalWidth=1204`,
  `naturalHeight=800`, `complete=true` を確認。
- このサンプルはメタデータを持たないためバッジは表示されない（想定どおり）。

## InvokeAI

- サンプル: isGenAI の公開サンプル `invokeai-record.png`（`invokeai_metadata` 入り）
- 結果: **PASS**。バッジ「View Metadata」→ モーダルで
  `InvokeAI`、Positive Prompt、Negative Prompt、Steps=30、CFG=4.5、
  Sampler=euler、Seed=0、Size=1024x768、Model を確認。
- 補足: 実生成ファイルではなく、公開されている制御済みサンプル。
  メタデータキーと値は InvokeAI の実フォーマット。

## SwarmUI

- サンプル: Civitai の実画像
  `https://civitai.com/images/70385438` の original PNG。
  `parameters` tEXt に `sui_image_params` JSON を保持。
- 結果: **PASS**（修正後）。バッジ→モーダルで `SwarmUI`、
  Positive/Negative Prompt、Steps、Sampler、Schedule type、CFG、
  LoRAs、SwarmUI version を確認。
- 発見した不具合: 実ファイルは `sui_image_params` が独立キーではなく
  `parameters` 内に入るため、従来は `Stable Diffusion WebUI` と誤判定し
  生JSONを表示していた。`ui.js` で `parameters` 内の
  `sui_image_params` を解釈するよう修正（commit `1a39b59`）。
  回帰テスト追加、`node --test` 165 pass。

## Civitai 実ページ（deepScan）

- URL: `https://civitai.com/images/70385438`
- 結果: **PASS**。ページ上の画像6枚を検出し、バッジ「View Metadata」を確認。
  クリック後のモーダルは SwarmUI としてプロンプト・設定を表示。
- Cloudflare 等のブロックは発生しなかった（headless Chromium、通常UA）。

## 4K PNG の体感

- サンプル: 4096x4096 RGB PNG、1,727,752 bytes。
  IDAT 後に A1111 `parameters` tEXt を配置。
- 5回の新規URL計測（ページ遷移からバッジ表示まで）:
  **78 / 82 / 60 / 63 / 62 ms、中央値 63 ms**。
- モーダルで A1111 のプロンプト・Generation Grid
  （Steps=28, Sampler=Euler a, CFG=7, Seed=42, Size=4096x4096）を確認。
- 体感上の遅延は認められなかった。

## デバッグ全検知モード

比較用に、ユーザー報告 PNG `01_furina_1.png` へ
`Description=normal metadata for debug comparison` を追加した
`debug_compare.png` を使用（Stealth + Software `Celsys Studio Tool`）。

- `debugAllDetections=false`、`ignoredSoftware=['Celsys Studio Tool']`:
  **バッジなし**（通常の論理抑制どおり）。
- `debugAllDetections=true`、同じ `ignoredSoftware`:
  **`DEBUG` バッジ**、モーダルに `Debug Detections`、Description、
  Software、Stealth PNG Info、担体一覧（`carrier`）を確認。
- `01_furina_1.png` 単体でも `DEBUG` バッジと
  Stealth + Software の全担体表示を確認。
- 追加のネットワーク取得は発生せず、結果はキャッシュされない設定で確認。

## 残課題

- InvokeAI は実生成ファイルではなく公開制御サンプル。実生成ファイルでの
  再確認は未実施。
- AVIF はメタデータ付きサンプルでのモーダル確認は未実施（表示のみ確認）。
