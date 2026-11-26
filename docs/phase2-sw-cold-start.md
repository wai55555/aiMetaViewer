# Phase 2 決定ゲート: Service Worker 起動時評価の実測

- 目的: 現行の起動時 `importScripts`（約 766KB）が実際に何 ms かかるかを測り、
  案A（offscreen document 移行）の実装リスクに見合うかを判定する。
- 仕様書: `docs/261126_plan_refactoring.md` §5.2
- 測定スクリプト: `tests/phase2/measure_sw_startup.cjs`（テスト専用）
- 測定日: 2026-11-26
- 環境:
  - Windows 11 / WSL2 ホスト
  - Chromium 158.0.8127.37（Playwright 同梱）
  - Node.js v22.21.0（Windows 側）
  - CPU: 13th Gen Intel Core i5-13600KF

## 1. 測定方法

一時的な拡張コピーにだけ計測コードを入れ、製品ファイルは変更していない。

- `background.js` の先頭で `performance.now()` を記録
- `importScripts(...)` の直前・直後で `performance.now()` を記録
- `background.js` の評価終了時に `chrome.storage.local` へ結果を保存
- 各 run は**新しい Chrome プロファイル**で起動（コールドスタート）
- 6 run 実施し、初回を捨てて残り 5 run の中央値を採用
- 比較対象:
  - **current**: 現行どおり 6 ファイルを `importScripts`
  - **background-only**: `importScripts` を外した `background.js` のみ

計測範囲は「`background.js` の評価開始から評価終了まで」であり、
Chrome プロセス起動、拡張機能の登録、ページのネットワーク取得は含まない。

## 2. 結果

| 指標 | current | background-only | 差分 |
|---|---:|---:|---:|
| 評価時間 中央値 | **42.0 ms** | **2.7 ms** | **39.3 ms** |
| importScripts 部分 中央値 | **39.0 ms** | 0 ms | 39.0 ms |
| 5 run の範囲（total） | 38.5〜46.5 ms | 2.6〜4.1 ms | — |

### current の採用 5 run

| run | total (ms) | import (ms) |
|---:|---:|---:|
| 2 | 40.5 | 36.9 |
| 3 | 38.5 | 35.5 |
| 4 | 42.0 | 39.0 |
| 5 | 42.3 | 39.4 |
| 6 | 46.5 | 43.6 |

### background-only の採用 5 run

| run | total (ms) | import (ms) |
|---:|---:|---:|
| 2 | 2.7 | 0 |
| 3 | 2.7 | 0 |
| 4 | 2.6 | 0 |
| 5 | 3.0 | 0 |
| 6 | 4.1 | 0 |

## 3. 判定

**現状の起動時評価は中央値 42.0 ms、うち importScripts が 39.0 ms。**
数十 ms 級であり、数百 ms 級ではない。

この結果から、**案A（offscreen document へ取得・解析を移す）を v2.0.0 で
実施する正当性はない**と判断する。案Aは以下の大きなリスクを伴う。

- §0-6 の例外として取得層（Range / full fetch / stream / negative cache）を触る
- offscreen の生成・終了・SW 再起動・同時要求・キャンセル・タイムアウトの状態管理
- 最低 Chrome 109 への引き上げ、`offscreen` 権限追加
- ZIP ダウンロードの blob URL 受け渡し検証
- Phase 2 の長期化と Phase 3〜5 の遅延

42 ms の短縮のために取得層という最も壊してはいけない層を移すのは、
費用対効果が合わない。

## 4. 決定

- **案Bを採用**する。
- FR-SW-01/02 は v2.0.0 の対象から外し、§14 将来課題へ送る。
- 現行の起動時 `importScripts` を維持する。
- pako は CUT-13 により現行 `pako.js` を維持する。
- Phase 3 以降を先に進める。

## 5. 将来の再評価条件（案Aの起案条件）

以下を満たした場合に限り、案Aを独立計画として起案する。

1. 本ドキュメントと同じプロトコルで、`current` の評価時間中央値が
   **100 ms 以上**、または p95 が **150 ms 以上**になった場合。
2. ユーザー体感の遅延（バッジ表示までの待ち等）として
   **100 ms 以上**のコールドスタート起因の遅延が実測された場合。
3. 起動時ロードが現在の 766KB から **1MB 超**へ増え、
   同じ測定で 100 ms 以上の悪化が確認された場合。

再測定は、起動時 import 対象のファイル構成・サイズが 25% 以上変わったとき、
または対象最低スペックの端末で実施する。

## 6. 再現方法

```bash
# WSL 側でテストページを配信
python3 -m http.server 8765 --directory /tmp/aimv-phase1

# Windows 側 Node で実行（Playwright Chromium のパスは環境に合わせる）
cd /d C:\github\aiMetaViewer
node tests/phase2/measure_sw_startup.cjs
```

前提: このスクリプトは WebSocket クライアントとして `ws` を使う。
Windows 側 Node がリポジトリの `node_modules` を解決できる状態にするか、
テスト専用として `npm install --no-save ws` を実行しておく。
製品のビルド依存には追加しない。

環境変数: `CHROME_PATH`, `BENCH_URL`, `BENCH_RUNS`。
スクリプトは一時コピーだけを計測し、`extension/` は変更しない。
