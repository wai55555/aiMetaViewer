# Phase 2: Service Worker 遅延ロード方式の比較（案 A / 案 B）

- 仕様書: `docs/261126_plan_refactoring.md` §5.2
- 作成日: 2026-11-26
- 状態: **未決**。Phase 2 は方式決定まで保留する。

## 0. 前提：MV3 Service Worker の制約

Chrome MV3 の Service Worker では、初期評価後の `importScripts()` と
動的 `import()` を実行できない。

Chromium 158 での実測:

```text
fetch(chrome.runtime.getURL('parser.js'))
  -> HTTP 200, Content-Type: text/javascript

importScripts(chrome.runtime.getURL('parser.js'))
  -> NetworkError: Failed to execute 'importScripts' on 'WorkerGlobalScope':
     The script at 'chrome-extension://.../parser.js' failed to load.
```

web.dev の Service Worker 仕様でも、dynamic `importScripts()` は不可、
`import()` は Service Worker では静的 import のみと明記されている。
したがって、現行仕様の「起動後に importScripts で parser/pako/scanner を
遅延ロードする」方式は成立しない。

現行の起動時ロード（Phase 1 完了時点）:

| ファイル | bytes |
|---|---:|
| `background.js` | 238,522 |
| `pako.js` | 238,805 |
| `jszip.min.js` | 97,630 |
| `parser.js` | 76,296 |
| `video_parser.js` | 42,628 |
| `video_range_reader.js` | 3,917 |
| `png_metadata_scanner.js` | 68,156 |
| **合計** | **765,954** |

Phase 0 のベースラインは 752,066 bytes。Phase 1 で `background.js` が
3,888 bytes 増えたため、現在は 765,954 bytes。

### 0.1 コールドスタート実測（決定ゲート）

`tests/phase2/measure_sw_startup.cjs` で、一時的な計測用コピーだけを使い、
新しい Chrome プロファイルで 6 run（初回破棄、5 run 中央値）測定した。
詳細は `docs/phase2-sw-cold-start.md`。

| 指標 | current | background-only | 差分 |
|---|---:|---:|---:|
| `background.js` 評価時間 中央値 | **42.0 ms** | **2.7 ms** | **39.3 ms** |
| うち `importScripts` 部分 | **39.0 ms** | 0 ms | 39.0 ms |

計測範囲は `background.js` の評価開始から終了まで。Chrome プロセス起動や
ページ取得は含まない。

**判定ゲート**: `current` の評価時間中央値が **100 ms 以上**、または p95 が
**150 ms 以上**なら案Aの正当性を再検討する。現状は 42.0 ms なので、
このゲートは満たさない。

---

## 案 A: offscreen document へ解析を移す

### A-1. 構成

Service Worker はイベントルーターだけを残し、取得・解析の実体を
`offscreen.html` + `offscreen.js` に移す。offscreen document は拡張ページ
なので、必要なときに `<script src>` や動的 `import()` で重いライブラリを
読み込める。

```text
content script / action
        |
        v
Service Worker (background.js)
  - runtime/action/download のイベント受付
  - リクエストの合流・キャンセル
  - offscreen document の生成/終了管理
        |
        v  chrome.runtime message
offscreen document (offscreen.html + offscreen.js)
  - parser.js / pako.js / png_metadata_scanner.js
  - video_parser.js / video_range_reader.js
  - jszip.min.js
  - 取得・解析・ZIP 生成
```

### A-2. 重要な設計分岐

#### A-2a: SW が取得し、bytes を offscreen へ送る

- SW の既存取得層をそのまま使える。
- ただし PNG の全 body、metadata head、Range 断片を
  `chrome.runtime.sendMessage` で送る必要がある。
- 拡張メッセージは構造化クローン/JSON 化のコストが大きく、巨大 PNG では
  メモリ複製と転送量が増える。stream の逐次転送も難しい。
- **採用しない**。P-1（negative コスト）に反する可能性が高い。

#### A-2b: offscreen が取得から解析まで行う

- SW は「どのURLを、どの優先度で解析するか」だけを offscreen に伝える。
- offscreen が fetch / Range / stream / PNG scanner / 動画 parser を実行する。
- 大きな bytes をメッセージで往復しないため、性能上の懸念が小さい。
- 既存 `background.js` の取得・解析コードを offscreen 側へ移す必要がある。
  これは §0-6 の「取得層は原則対象外」を超えるため、仕様改訂が必要。

### A-3. 必要な変更

| 項目 | 内容 |
|---|---|
| manifest | `"permissions": ["offscreen"]` を追加。`background.js` は SW のまま |
| 最低 Chrome | **109 以降**（`chrome.offscreen` API）。現行仕様の 95 下限を改訂 |
| 新規ファイル | `offscreen.html`、`offscreen.js`（取得・解析の実体） |
| SW | offscreen の生成/再利用/終了、メッセージ転送、リクエスト合流 |
| 取得層 | `handleFetchImageMetadata` / `handleFetchVideoMetadata` / ZIP 生成を offscreen へ移設 |
| ZIP / ダウンロード | offscreen では `chrome.downloads` を使えない（公開 API は `chrome.runtime` messaging のみ）。offscreen が Blob URL を作り、URL文字列を SW に返し、SW が `chrome.downloads.download` を呼ぶ。`downloadPathQueue` と `onDeterminingFilename` の順序、Blob URL の寿命・revoke、offscreen 終了との競合を実装前に検証する |
| キャッシュ | offscreen document が使える拡張 API は `chrome.runtime` messaging のみ。`chrome.storage` は SW 側に残し、必要なら runtime message 経由で読み書きする |
| 同時実行ゲート | offscreen 内へ移すか、SW 側でリクエスト単位に維持するかを設計 |
| テスト | offscreen を直接 Node で動かせないため、メッセージ契約と純粋関数を分離してテスト |

### A-4. offscreen document のライフサイクル

- 最初の画像/動画/ZIP 要求で `chrome.offscreen.createDocument({...})`。
- 既に存在する場合は作成しない。`chrome.runtime.getContexts()` は Chrome 116+
  のため、109〜115 では「作成失敗（既存）」を許容するか、SW 内フラグと
  メッセージ応答で判定する。
- 一定時間（例: 30 秒）要求がなければ `chrome.offscreen.closeDocument()`。
- SW 再起動時は offscreen が残っている可能性があるため、存在確認を必須にする。
- offscreen の理由（`reasons`）は用途に合うものを選ぶ。解析専用なら
  `WORKERS` / `DOM_PARSER` 等の妥当性を実装時に確認する。

### A-5. 利点

- FR-SW-01 の 250,000 bytes 目標を達成できる可能性が高い。
  SW 本体から取得・解析コードを外せば、起動時はルーター + 共有診断程度になる。
- `eval` / `unsafe-eval` を使わない。CSP を弱めない。
- parser/scanner の同期 API を offscreen 内で維持できる。
- offscreen は拡張ページなので、`<script>` / 動的 `import()` の制約が緩い。
- 将来の重い処理（別形式、画像デコード等）も同じ場所へ隔離できる。

### A-6. 欠点・リスク

- **実装規模が大きい**。Phase 2 の範囲を超え、取得層の移設を含む。
- Chrome 109 未満を切るか、109 未満では従来の起動時ロードへフォールバックする
  二重経路が必要。
- offscreen の生成/終了、SW 再起動、同時要求、キャンセル、タイムアウトの
  状態管理が増える。
- メッセージ往復が増えるため、小さい画像ではオーバーヘッドが増える可能性。
- offscreen document のデバッグが SW より難しい。
- Web Store 審査で `offscreen` 権限の justification が追加になる。
- Phase 2 を「2A: offscreen 基盤」「2B: 取得・解析移設」に分割する必要がある。
- ZIP ダウンロードは offscreen に `chrome.downloads` がなく、Blob URL の受け渡し・
  寿命・revoke の検証が必要。失敗すると ZIP 保存経路が壊れる。

### A-8. 案Aを選ぶ場合の実装前検証項目

案Aは実装前に、少なくとも以下をスパイクで確認する。1つでも成立しなければ
案Aは採用しない。

1. offscreen document で `URL.createObjectURL(new Blob(...))` を作成できる。
2. その Blob URL を SW に渡し、SW の `chrome.downloads.download` で
   実際に保存できる（Chrome 109+ と現行 Chromium の両方）。
3. offscreen document を閉じた後もダウンロードが完了するか、完了まで
   offscreen を維持する必要があるかを確定できる。
4. `chrome.downloads.onDeterminingFilename` と `downloadPathQueue` の
   既存ファイル名決定が、Blob URL でも従来どおり動く。
5. ZIP の大きな Blob を作っても、メッセージで bytes を往復せずに保存できる。
6. offscreen の生成/終了と SW 再起動が競合しても、二重 document や
   ダウンロード失敗を起こさない。

### A-7. 向いている条件

- SW コールドスタート削減を v2.0.0 の必須要件として維持する。
- 実装期間・リスクを許容できる。
- 取得層の移設を含む仕様改訂を承認できる。
- Chrome 109 以上を最低要件にできる。

---

## 案 B: SW 遅延ロードを v2.0.0 から外す

### B-1. 構成

- 現行どおり `background.js` の先頭で `importScripts(...)` を実行する。
- FR-SW-01/02 を v2.0.0 の完了条件から外し、将来課題へ送る。
- Phase 2 は「pako ゲートの結論（CUT-13）」と「SW 遅延ロードは案B（現状維持）」
  を記録して完了とする。
- Phase 3 以降は予定どおり進める。

### B-2. 必要な変更

| 項目 | 内容 |
|---|---|
| manifest | 変更なし（`offscreen` 権限不要） |
| 最低 Chrome | 95 のまま |
| SW | 現行の起動時 `importScripts` を維持 |
| 仕様 | FR-SW-01/02 を v2.0.0 の対象外へ。§14 将来課題へ移動 |
| pako | CUT-13 により現行 `pako.js` を維持 |
| テスト | Phase 2 の追加テストは「保留」として実施しない |

### B-3. 利点

- 追加実装がほぼない。既存挙動を変えない。
- 新しい権限・最低 Chrome バージョン・offscreen 状態管理が不要。
- Phase 3（検知追加）へすぐ進める。
- 取得層を触らないため、§0-6 と衝突しない。

### B-4. 欠点

- SW 起動時ロードは **765,954 bytes** のまま。
- 本計画の「SW コールドスタート固定費を下げる」目的は未達。
- 将来、`docs/phase2-sw-cold-start.md` の再評価条件を満たした場合に、
  offscreen 移行を別計画として起案する必要がある。

### B-5. 向いている条件

- v2.0.0 のスコープを守り、Phase 3〜5 を優先する。
- SW 起動時ロードの削減を別リリースへ送る。
- 取得層の大規模移設を避ける。

---

## 比較表

| 観点 | 案 A（offscreen） | 案 B（現状維持） |
|---|---|---|
| FR-SW-01 250KB 目標 | 達成可能 | 未達（765,954 bytes） |
| 現状の起動時評価 | 42.0 ms（実測） | 42.0 ms（実測） |
| 案Aの実装前検証 | offscreen ZIP / Blob URL 等が必要 | 不要 |
| 最低 Chrome | 109+ | 95 のまま |
| 新権限 | `offscreen` | なし |
| 取得層の変更 | 大（移設） | なし |
| 実装リスク | 高 | 低 |
| Phase 3 への影響 | Phase 2 が長期化 | すぐ進める |
| CSP / eval | 変更不要 | 変更不要 |
| テスト | メッセージ契約の新設 | 既存のまま |
| 主な不確実性 | offscreen ライフサイクル、性能、審査 | 性能目標未達 |

## 決定（2026-11-26）

コールドスタート実測が **42.0 ms**（importScripts 39.0 ms、background-only
2.7 ms）だったため、**案Bを採用**する。

- 現行の起動時 `importScripts` を維持する。
- FR-SW-01/02 は v2.0.0 の対象外とし、§14 将来課題へ送る。
- pako は CUT-13 により現行 `pako.js` を維持する。
- Phase 3 以降を先に進める。
- 案Aは `docs/phase2-sw-cold-start.md` の再評価条件（評価時間中央値
  100 ms 以上、または p95 150 ms 以上）を満たした場合に、独立計画として
  起案する。案Aを起案する場合は A-8 の実装前検証を必須とする。
