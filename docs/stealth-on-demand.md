# Stealth メタデータのオンデマンド判定（モーダルのボタン）

- 対象: メタデータ表示モーダル（`extension/ui.js`）
- 背景実装: `extension/background.js`, `extension/png_metadata_scanner.js`, `extension/parser.js`
- 目的: 通常スキャンでは Stealth（画素 LSB）を判定しないケースに限り、
  ユーザー操作でピンポイントに判定できるようにする。

## 1. なぜボタンが必要か

PNG scanner は Phase 5 以降、tEXt / iTXt / zTXt / eXIf で通常メタデータが確定した時点で
Stealth 候補を作らず、IDAT はフレーミング + CRC だけを見る（FR-STL-03）。
そのため「`parameters` はあるが `stealth_pnginfo` も埋まっている」画像では、
Stealth 側が通常表示に出ない。フル展開は 1024² で 70ms 級、4096² で 180ms 級かかるため、
常時判定には戻さず、明示操作のときだけ走らせる。

## 2. UI 仕様

| 項目 | 挙動 |
| --- | --- |
| 位置（結果） | モーダル本文の**先頭**（positive セクションより上）に `Stealth Metadata (PNG LSB)` セクションを置く |
| 位置（ボタン） | モーダル最下部のフッター行の**左端**（`Update & Download` / `Copy All Data` と同じ行の行頭）に置く |
| 表示条件 | PNG かつ IHDR が **α あり（colorType 4/6）** または **8bit RGB（colorType 2）** |
| 非表示 | 上記以外、動画、既に Stealth を検出済み（metadata に `Stealth PNG Info ...` がある） |
| 初期状態 | セクションは展開（ヘッダ「Stealth Metadata (PNG LSB)」）。probe 完了までは非表示 |
| 押下 | 「Check stealth metadata」→ 実行中は「Scanning…」＋無効化 |
| 成功（検出） | ペイロード本文と担体名（`Stealth PNG Info (Alpha)` 等）を表示、ボタンは消える |
| 成功（未検出） | 「No stealth payload found in the pixel LSBs.」 |
| 上限・未対応 | `unsupported-stealth-*` 診断がある場合は「Not checked: …」と理由を表示 |
| 失敗（スキャン） | 「Stealth scan failed.」＋「Retry stealth scan」で再試行可 |
| 失敗（ヘッダ取得） | 「Could not read the PNG header, so the pixel LSBs were not checked.」＋「Retry header check」で再試行可（対象外と区別するため、黙って消さない） |
| 再表示 | 同一ページ内では結果をメモ化し、再スキャンしない |

## 3. 実装

### 3.1 `parser.js`: `parsePngIhdrInfo(buffer)`

先頭 26 bytes（PNG シグネチャ + IHDR）から `colorType` / `bitDepth` を読み、
`hasAlpha` / `hasRgb` / `stealthEligible` を返す純関数。
`stealthEligible` は scanner の `LAYOUTS` に合わせ、
**α は 4/6（8/16bit）、RGB は 8bit のみ**を対象にする（16bit RGB は候補外）。

### 3.2 `png_metadata_scanner.js`: `forceStealth`

- オプション `forceStealth: true` で `hasStealthSuppressingMetadata()` の抑制を解除する
  （`debugAllDetections` とは独立。担体デバッグ収集は有効にしない）。
- 検出時は `result.stealth = { key, value, mode, signature, compressed }` を返す。
  **`metadata` へはマージしない**ため、通常メタデータを上書きしない。
- 画素上限（33,554,432）と IDAT の安全上限は通常時と同じく適用する。

### 3.3 `background.js`

| action | 内容 |
| --- | --- |
| `probePngInfo` | 先頭 64 bytes のみ取得して IHDR を返す。`Range: bytes=0-63`、Range 非対応なら body の先頭だけ読んで cancel。8s timeout。結果は最大 512 件までメモ化 |
| `scanStealthMetadata` | `requestImageMetadata(url, { forceStealth: true })` を 1 回実行し、`stealth` / `scannerStatus` / `diagnostics` を返す |

- `forceStealth` の解析は **永続キャッシュを read/write しない**
  （通常表示の結果を書き換えないため）。
- 進行中の通常解析と `forceStealth` 要求は同居できないので、
  通常解析が終わってから要求し直す（同一 `forceStealth` 同士は相乗り）。
- ゲート（`pngFullStreamGate`）と既存の安全上限はそのまま適用される。
- file:// でも同じ経路（`createFileResult` に `stealth` を追加）。

### 3.4 `ui.js`

`createStealthSection(imageUrl, metadata)` が `{ section, mount(footer) }` を返す。

- `section`: 結果表示（本文先頭に挿入）。probe が終わるまでは `display:none`。
- `mount(footer)`: 実行ボタンをフッター行の左端へ入れる。probe が `mount` より先に
  終わっても、`mount` 側でボタンを置ける（pending キュー）。

ボタンを本文最下部に置くとスクロールしないと見えず使われないため、**操作はフッター行・
結果は本文先頭**に分離した。フッターは `justify-content: flex-end` なので、
ボタンは `margin-right: auto` で左端に寄せる。
`window.createStealthSection` としてテスト用にエクスポートしている（既存の
`window.buildSections` などと同じ互換エクスポート）。

## 4. コスト

| 操作 | 追加コスト |
| --- | --- |
| モーダルを開くだけ | **0**（自動判定は増えない） |
| 初回の表示可否判定 | 64 bytes の Range（1 RTT）。同一 URL はセッション内メモ化 |
| ボタン押下（Stealth なし） | IDAT の再取得＋先頭 160 行までの展開で打ち切り（FR-STL-01/04） |
| ボタン押下（Stealth あり） | payload 長に応じた全展開（1MP で 70ms 級） |
| 同一 URL の再押下 | 0（結果をメモ化） |

参考実測は `docs/perf-phase5-stealth.md`。HTTP では CPU より再取得の通信が支配的。

## 5. 制限

- 33.5MP 超の PNG は候補を作らない（`unsupported-stealth-pixel-limit`）。
- インターレース PNG、scanner 未対応レイアウトは対象外。
- 16bit RGB は RGB モードの対象外（α 付きなら対象）。
- Stealth を既に検出済みの画像ではボタンを出さない（同じ結果になるため）。
- 動画、PNG 以外の形式ではセクション自体を表示しない。
- `file://` の画像は Range を使わず先頭 64 bytes を読む（ローカル読み出しに Range は無い）。
  取得に失敗した場合は上表の「ヘッダ取得」表示になり、`Retry header check` で再試行できる。
- 先頭 64 bytes を読めない状況（ローカルアクセス権限なし等）ではボタンは出ない。

## 6. テスト

- `tests/metadata/stealth_on_demand.test.cjs`（5 ケース）
  - 通常スキャンは従来どおり抑制する
  - `forceStealth` は `stealth` を別枠で返し、`metadata` を汚さない
  - 未検出時は `stealth` を返さない
  - compressed / RGB モードのフラグ
  - `parsePngIhdrInfo` の可否判定（RGBA / Gray+Alpha / RGB8 / RGB16 / Gray / 非PNG / 短い入力）
- `tests/metadata/stealth_modal.test.cjs`（5 ケース）
  - 対象外 PNG はセクションを消す
  - α PNG はボタンを出し、押下で結果を描画してボタンを消す
  - 失敗時は再試行ボタンを残す
  - 再表示はメモ化結果を使い、probe/scan を再送しない
  - 検出済みメタデータではセクションを出さない

`node --test tests/metadata/*.test.cjs` → **215 pass / 0 fail**。

- `stealth_modal.test.cjs` は「ヘッダ取得に失敗したときは黙って消さず、理由と
  `Retry header check` を出す」ことも固定している（`file://` の取得制限を可視化するため）。

## 7. 実機確認（未実施）

ブラウザでの実機確認はまだ行っていない。作業環境が WSL2 で、Windows 側 Chrome の
CDP ポート（127.0.0.1）へ到達できないため、自動の E2E は実行できなかった。

手順は **`docs/stealth-on-demand-e2e.md`** に、期待結果付きのチェックリストとして分離した。
画像セットは `tests/e2e/stealth-on-demand/images/`（`node tests/e2e/stealth-on-demand/build.cjs`
で再生成・自己検証。8 枚、合計 27KB）。チェックリストは次の 4 分類を必ず含む。

| 分類 | 画像 | 期待 |
| --- | --- | --- |
| stealth + 通常メタデータ | `01-…alpha-with-metadata.png`, `08-…rgb-with-metadata.png` | セクション表示 → 押下でペイロード（Alpha / RGB 担体） |
| 通常メタデータのみ | `02-normal-metadata-no-stealth.png` | セクション表示 → 押下で未検出 |
| メタデータ無し | `03-no-metadata-alpha.png` | セクション表示 → 押下で未検出 |
| ComfyUI 発端 | `04-comfyui-api-prompt.png` | ComfyUI の正負 + 押下で未検出 |
| 非表示の分岐 | `05`（検出済み）/ `06`（Gray8）/ `07`（RGB16） | セクションを出さない |

以前この節に書いていた `01_furina_1.png` の例は誤りだった。同ファイルは通常スキャンで
`Stealth PNG Info (Alpha)` が確定する（tEXt に抑制メタデータが無い）ため、
「既に検出済み」の規則でボタンは出ない。押下対象の例としては `test.png` を使う。
