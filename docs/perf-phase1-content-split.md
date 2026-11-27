# Phase 1: content script 分割・遅延注入（実装記録）

- 仕様書: `docs/261126_plan_refactoring.md`
- ブランチ: `phase/1-content-split`
- ベースライン: `docs/perf-baseline-1.8.md`（Phase 0）
- 対象: Chrome / Chromium、Manifest V3、プレーン JavaScript（ビルド工程なし）

## 1. 実装した FR

| 要件 | 実装 |
|---|---|
| FR-CS-01 | 常駐を `settings_loader.js` + `content_runtime.js` + `badge_controller.js` + `content.js` + `styles.css` に縮小。**119,040 bytes**（目標 120,000、Phase 0 比 -20,977） |
| FR-CS-02 | `ui.js` / `comfyui_parser.js` / `ui_guard.js` / `ui.css` は SW の `ensureModule` で遅延注入。`adapters.js` は manifest の条件付きエントリへ移動 |
| FR-CS-03 | バッジ・モーダル、アダプタ、アクションスキャン、SPA 再検出を維持。遅延 UI は設定ロード完了後に初期化 |
| FR-CS-04 | 200ms `setInterval` を廃止。`popstate` / `hashchange` / MutationObserver + 100ms デバウンス、800ms 安全弁へ移行 |
| FR-CS-05 | 常駐は `all_frames: true` / `document_start` を維持。content 側フラグ + SW の in-flight Promise + scanner 側ロード済みフラグで二重注入を防止 |
| NFR-CS-01 | 常駐側から遅延側への参照は `typeof` ガード付き。遅延側は常駐初期化後にのみ注入される方向依存に整理 |

## 2. content script バイト数

### 常駐（manifest の `<all_urls>` エントリ）

| ファイル | bytes |
|---|---:|
| `settings_loader.js` | 14,464 |
| `content_runtime.js` | 5,436 |
| `badge_controller.js` | 18,741 |
| `content.js` | 79,116 |
| `styles.css` | 1,283 |
| **合計** | **119,040** |

- Phase 0 ベースライン: 140,017 bytes
- 削減: **20,977 bytes（15.0%）**
- 目標 120,000 bytes に対する余裕: **960 bytes**

### 遅延・条件付き

| 区分 | ファイル | bytes |
|---|---|---:|
| 遅延 A（ui キー） | `ui_guard.js` | 1,007 |
| 遅延 A（ui キー） | `comfyui_parser.js` | 22,447 |
| 遅延 A（ui キー） | `ui.js` | 102,081 |
| 遅延 A CSS | `ui.css` | 7,931 |
| 条件付き | `adapters.js` | 36,667 |
| 遅延 B | `scanner.js` + `scanner/*.js` | 68,256 |

`ui.js` には、content.js から移した以下の場面限定コードを含む。

- Civitai 以外では不要な safetensors リンク監視・リンク解析
- 直接画像表示の処理
- 動画 observation（`<video>` または動画リンク画像が現れた時だけ UI を注入）
- 汎用 safetensors リンクの MutationObserver

これにより、`<all_urls>` の常駐から約 20KB を削減した。通常ページでは
`ui.js` はバッジクリック/ホバー、動画候補、safetensors リンク、直接画像表示の
いずれかが発生するまで読み込まれない。

## 3. 権限判断ゲート（§4.1）

### 結論

`scripting` パーミッションを追加する。

### 根拠

- 遅延 A は content script から `chrome.scripting` を呼べないため、SW からの
  `executeScript` / `insertCSS` に必要。
- `activeTab` は拡張アクション起点の一時権限であり、バッジクリック等の
  ページ内操作から `ensureModule` を送る経路をカバーできない。
- 既存の `host_permissions: ["<all_urls>"]` は維持する。`scripting` 自体は
  Chrome のインストール時警告を追加しない（既存のホスト権限警告の範囲）。
- 代替案（`web_accessible_resources` + `<script>`、content からの動的 import、
  ビルドによるバンドル）は §4.1 の禁止事項または P-5 に反するため採用しない。
- 最低対応バージョンは、`executeScript` の `world` プロパティを含む
  **Chrome 95 以降**とする（仕様書 §0-7）。

### 除外サイトのストレージキー

- `chrome.storage.sync` の **`excludedSites`**
- SW は `ensureModule` とアクションスキャンの前に、このキーを直接読み、
  送信元 URL / タブ URL を除外パターンと照合する。
- `settings_loader.js` の既存パターン照合にあった「アンカーまでエスケープする」
  欠陥を修正し、content 側と SW 側で同じ `*` / `?` ワイルドカード意味論にした。

## 4. adapters.js の条件付き化（棚卸し）

### manifest エントリ

```json
"matches": [
  "*://discord.com/*", "*://*.discord.com/*",
  "*://pixiv.net/*", "*://*.pixiv.net/*",
  "*://civitai.com/*", "*://*.civitai.com/*"
]
```

- `run_at: "document_start"`、`all_frames: true`、`match_about_blank: true` は
  常駐エントリと同一。
- 条件付きエントリを常駐エントリより先に置き、対象ホストでは
  `adapters.js` が content.js より先に読み込まれるようにした。

### 現行アダプターの対応

| アダプター | 現行条件 | manifest |
|---|---|---|
| Discord | `hostname.includes('discord.com')` | `*://discord.com/*`, `*://*.discord.com/*` |
| Pixiv | `hostname.includes('pixiv.net')` | `*://pixiv.net/*`, `*://*.pixiv.net/*` |
| Civitai | `hostname.includes('civitai.com')` または title に Civitai | `*://civitai.com/*`, `*://*.civitai.com/*` |
| 汎用 | `match: () => true`（親リンクの画像拡張子） | 常駐側フォールバックへ移設 |

### 汎用アダプターの扱い

現行 `adapters.js` の最後には全サイトに一致する汎用アダプターがあり、
そのままでは `adapters.js` を条件付き化できない。そこで汎用の親リンク解決
だけを `content.js` と `scanner/utils.js` のフォールバックへ移し、
`adapters.js` は Pixiv / Discord / Civitai のホスト固有実装のみとした。
これにより非対象サイトでは `adapters.js` が読み込まれず、汎用のリンク解決は
従来どおり動作する。

### 読み込み順の棚卸し

旧 manifest で `adapters.js` より後ろに並んでいた
`badge_controller.js`、`scanner/*.js`、`scanner.js`、`content.js` を確認した。
いずれも読み込み時に `SiteAdapters` / `resolveOriginalUrls` を評価せず、
関数実行時または `typeof` ガード付きでのみ参照する。したがって条件付き
エントリを先にしても初期化順は壊れない。

## 5. 遅延注入の実装

### content → SW

- content は `{ action: 'ensureModule', module: 'ui' }` のみを送る。
- SW は固定対応表 `LAZY_MODULE_FILES` のキーだけを解釈し、リクエスト内の
  ファイル名・パスは使わない。
- SW は `(tabId, frameId, module)` 単位で注入中 Promise を共有し、並行要求を
  合流させる。完了後に記録を削除するため、SW 再起動後も content 側の
  ロード済みフラグで再注入を抑止できる。
- 注入前に SW が `excludedSites` を直接確認する。

### ナビゲーション照合（遅延 A のみ）

- SW が要求時点の `sender.url` からハッシュを除いた URL を
  `window.__aiMetaViewerExpectedLazyUrl` に設定する。
- SW は注入前に同じ `func` で自フレームの `location.href` を読み、ハッシュを除いた値が
  `sender.url` と一致するときだけ `ui_guard.js` / `comfyui_parser.js` / `ui.js` を注入する。
  不一致なら何も注入せず `navigation-mismatch` を返す。
- `ui_guard.js` は注入直前の照合（SW の probe と注入の間のレース）用に残す。不一致なら
  `__aiMetaViewerAbortUiModule = true`、`__aiMetaViewerUiModuleReady = false` にする。
  `ui.js` / `comfyui_parser.js` は先頭で abort フラグを見て**静かに中断**し
  （`return`。`throw` ではない）、グローバル関数を定義しない。
  注入ファイル内の例外は拡張側で捕捉できず、ページのコンソールに「Uncaught Error」として
  残るため。UI が不要なページで操作のたびに再試行されると大量のエラーになる
  （Amazon のような画像の多いページで顕在化した）。
- content 側のロード済みフラグは SW の成功応答後にのみ立てる。不一致・失敗時は
  次のバッジ操作で再試行できるが、同じ URL で 3 回連続失敗したら 30 秒の
  クールダウンに入る（`LAZY_MODULE_RETRY_DEFAULTS`）。URL が変われば回数はリセット。
- `about:` / `data:` / `chrome-extension:` などのフレームは対象外
  （`unsupported-frame-url`）。モーダル UI を載せる対象ではなく、Chrome が
  そうしたフレームの `sender.url` に開始元の URL を返すことがあり、照合が永久に
  失敗して再試行だけが残るため。
- `sender.url` が存在せず、サブフレームの location がタブ URL と一致しない
  遅延 B（scanner）では照合を行わない。

### アクションスキャン（遅延 B）

- SW がアクションクリックを受けると、`allFrames: true` で scanner を注入する。
- 各フレームの `__aiMetaViewerScannerLoaded` を probe し、未注入フレームだけに
  `executeScript` / `insertCSS` する。連続クリックは in-flight Promise で合流。
- scanner は各フレームで自フレームの画像を走査し、非トップフレームの結果は
  SW 経由でトップフレームへ転送する。トップフレームが候補を URL 単位で
  マージしてダウンローダーを表示する（iframe 内画像を含む）。

## 6. SPA URL 変化検出

- `content_runtime.js` の `createSpaUrlTracker` を使用。
- `popstate` / `hashchange` / 既存画像 MutationObserver から `schedule()`。
- デバウンス **100ms**、安全弁 **800ms**。
- 200ms 周期の `setInterval` は削除。
- 検出時のバッジ・処理済みマップ・動画状態のクリーンアップは現行同等。
- 単体テストでデバウンス/安全弁の値と発火回数を固定。

## 7. テスト

### 追加テスト

`tests/metadata/content_lazy_split.test.cjs`

- SPA URL tracker の 100ms / 800ms とデバウンス動作
- 遅延モジュールの並行要求合流（`sendMessage` 1 回）
- 成功時のみロード済みフラグを立てること
- ナビゲーション不一致（失敗応答）後にフラグが立たず再試行できること
- 同じ URL で 3 回連続失敗したらクールダウンし、URL 変更と 30 秒経過で再開すること
- 注入ファイル（`ui.js` / `comfyui_parser.js`）が abort 時に throw せず、
  グローバルを定義しないこと
- SW が注入前にフレーム URL を照合し、不一致時にファイルを注入しないこと
- `ui_guard.js` がハッシュ差分を許容し、パス差分で中断すること
- manifest の常駐/条件付き分割、`scripting` 権限、`adapters.js` の条件
- 除外パターンのアンカー・ワイルドカード
- content.js に 200ms ポーリングが残っていないこと
- scanner のフレームセッションとロード済みフラグ

### 結果

- `node --test tests/metadata/*.test.cjs`: **92 tests / 92 pass / 0 fail**
- 変更 JS 全ファイルの `node --check`: OK
- Phase 0 B-03 比較（同一環境、ウォームアップ 1 回 + 5 回中央値）:
  - Phase 0: 180 ms
  - Phase 1: **178 ms**（有意な悪化なし）

### Phase 0 B-04 との比較（scanner 単体）

| ケース | Phase 0 | Phase 1 | 差分 |
|---|---:|---:|---:|
| 4096² / メタデータなし | 625.938 ms | 624.478 ms | -1.460 ms |
| 4096² / tEXt 前 | 464.359 ms | 464.408 ms | +0.049 ms |
| 4096² / tEXt 後 | 624.085 ms | 621.266 ms | -2.819 ms |
| 1024² / Stealth | 75.411 ms | 74.019 ms | -1.392 ms |

scanner 本体は Phase 1 では変更していないため、差分は測定ノイズの範囲。

## 8. 手動確認（Chrome / Chromium headless、unpacked）

| §11.4 Phase 1 項目 | 結果 |
|---|---|
| 通常サイトでバッジが出る | PASS（ローカル HTTP、通常ページ） |
| バッジクリックでモーダルが 1 回で開く | PASS |
| Civitai / Pixiv / Discord でアダプタが効く | 条件付き読み込みと `match()` をローカル host mapping で PASS。実サイト固有の deepScan は未実施 |
| アクションからスキャン・ダウンロード | SW から同一の `executeScript` + `scanPage` 経路で PASS（トップ + iframe の 2 候補を表示）。ツールバークリックそのものは headless のため未実施 |
| SPA 遷移後の再検出 | PASS（`pushState` + 画像差し替え後、約 1.05 秒で新画像のバッジ） |
| 除外サイトでバッジ・解析が動かない | PASS（`excludedSites` 設定時にバッジ 0） |
| 通常ページで遅延 A / B が未読み込み | PASS（初回バッジに tooltip なし、クリック後に UI ロード。`scannerLoaded=false`） |
| iframe 内画像がスキャン対象 | PASS（同等経路で iframe の画像候補を確認） |

未実施は「実 Civitai サイトの deepScan」と「headless でのツールバークリック」。
どちらも Phase 1 のコード経路とは別の外部環境依存部分である。

## 9. 判断・差分の記録

- 汎用アダプターが全サイト一致だったため、`adapters.js` の条件付き化と
  「非対象サイトでは読み込まない」を両立するには、汎用解決を常駐側へ
  移す必要があった。これは仕様 §4.1 の第一選択（manifest 第 2 エントリ）を
  維持するための実装判断である。
- 動画 observation・safetensors リンク解析・直接画像表示を遅延 ui モジュールへ
  移した。これらは「対象場面が発生するまで実行しない」条件を満たすが、
  仕様書の遅延 A の例（モーダル表示）より広いトリガーを含む。FR-CS-01 の
  120,000 bytes を満たすために必要だった。
- `ui.js` は 102KB と大きいが、常駐からは外れており、通常ページでは
  読み込まれない。Phase 2 以降で `ui.js` 自体の分割を検討する場合は別計画とする。
