# Stealth オンデマンド走査 — Windows Chrome 実機チェックリスト

- 対象実装: `extension/ui.js` / `background.js` / `png_metadata_scanner.js` / `parser.js`
- 仕様: `docs/stealth-on-demand.md`（本ファイルはその §7 を実機用に展開したもの）
- 画像セット: `tests/e2e/stealth-on-demand/images/`
  （生成 + 検証: `node tests/e2e/stealth-on-demand/build.cjs`。`MANIFEST.json` が期待値の一次情報）
- 実施環境: **Windows 側の Chrome**（WSL の Chrome ではない）。拡張は unpacked で読み込む。

## 1. 準備

1. 画像セットをローカル HTTP で配信する（`file://` では拡張の取得経路が変わるため必ず HTTP）。

   ```powershell
   # Windows PowerShell（リポジトリ直下で）
   cd tests\e2e\stealth-on-demand\images
   python -m http.server 8765
   ```

   WSL 側から起動する場合は `cd /mnt/c/github/aimetaviewer/tests/e2e/stealth-on-demand/images && python3 -m http.server 8765`。

2. Chrome で `chrome://extensions` → デベロッパーモード ON → 「パッケージ化されていない拡張機能を読み込む」で
   リポジトリの `extension/` を指定。
3. 同じ Chrome で `http://localhost:8765/` を開き、画像一覧（8 枚）を表示できることを確認。
4. DevTools（F12）→ Network タブを開き、**「Disable cache」を ON**、フィルタを `png` にする。
   Network のリクエスト数がこのチェックリストの判定材料になる。
5. DevTools → Console を開き、エラーが出ていないことを確認（この後も都度確認する）。

## 2. 画像セットと期待値

`MANIFEST.json` と同一の内容。押下結果の文字列は UI 実装の文言そのもの。

| # | ファイル | IHDR | 通常メタデータ | Stealth セクション | 「Check stealth metadata」押下後 |
| --- | --- | --- | --- | --- | --- |
| 1 | `01-stealth-alpha-with-metadata.png` | 6/8b | `parameters`, `Software` | **表示** | `Stealth PNG Info (Alpha)` + `{"prompt":"e2e alpha payload","steps":28}` |
| 2 | `02-normal-metadata-no-stealth.png` | 2/8b | `parameters` | **表示** | `No stealth payload found in the pixel LSBs.` |
| 3 | `03-no-metadata-alpha.png` | 6/8b | なし | **表示** | `No stealth payload found in the pixel LSBs.` |
| 4 | `04-comfyui-api-prompt.png` | 2/8b | `prompt`（ComfyUI API） | **表示** | `No stealth payload found in the pixel LSBs.` |
| 5 | `05-stealth-only-alpha.png` | 6/8b | `Stealth PNG Info (Alpha)` | **非表示**（通常スキャンで検出済み） | – |
| 6 | `06-gray8-not-eligible.png` | 0/8b | なし | **非表示**（非対象レイアウト） | – |
| 7 | `07-rgb16-not-eligible.png` | 2/16b | なし | **非表示**（16bit RGB は対象外） | – |
| 8 | `08-stealth-rgb-with-metadata.png` | 2/8b | `parameters` | **表示** | `Stealth PNG Info (RGB)` + `{"prompt":"e2e rgb payload"}` |

補足:

- #4 は ComfyUI の P0 解決結果も同時に確認する。期待値は
  positive = `masterpiece, best quality, 1girl, solo, soft lighting`（JPS 連結 + populated_text 優先）、
  negative = `bad quality, worst quality`、LoRA = `style.safetensors (0.7)`。
- #1 / #8 は「通常メタデータがあるため通常スキャンでは LSB を見ていない」画像。
  押下しない限りペイロードが出ないことが本機能の要点。

## 3. 手順と期待結果

各画像で「バッジをクリック → モーダルを開く」ところから始める。Network タブは開いたままにする。

### 3.1 基本フロー（#1 で実施）

| # | 操作 | 期待結果 |
| --- | --- | --- |
| 1.1 | `01-stealth-alpha-with-metadata.png` を開く | 画像右上にバッジが出る。Network に画像 1 件だけ（拡張の通信は無い） |
| 1.2 | バッジをクリックしてモーダルを開く | **64 bytes の Range リクエストが 1 件**増える（`Range: bytes=0-63`、ステータス 206 か 200）。モーダルに `parameters` / `Software` が出る |
| 1.3 | 「Stealth Metadata (PNG LSB)」セクションを見る | セクションが**展開状態**で存在し、説明文 `This image already has metadata, so the pixel LSBs were not scanned. …` と **「Check stealth metadata」ボタン**が出る。ここまでで**ペイロードは表示されていない** |
| 1.4 | ボタンを押す | ボタンが `Scanning…` に変わり無効化、説明文が `Scanning pixel LSBs…` になる。**画像の再取得が 1 回だけ**発生する（Range ではなく本体取得） |
| 1.5 | 完了を待つ | ペイロード `{"prompt":"e2e alpha payload","steps":28}` と、その上に `Stealth PNG Info (Alpha)` のラベルが出る。**ボタンは消える**。1.4 の再取得以外にリクエストが増えない |
| 1.6 | モーダルを閉じ、**同じ画像**でもう一度開く | Stealth の結果が**そのまま再表示**され、**新しいリクエストが 1 件も出ない**（probe も scan もメモ化） |
| 1.7 | 別タブで同じ画像を開いてモーダルを開く | そのページでは 1.2 の probe が 1 回だけ走る（メモ化はページ単位） |

### 3.2 ペイロード無しの分岐（#2 / #3 / #4）

| # | 操作 | 期待結果 |
| --- | --- | --- |
| 2.1 | `02-normal-metadata-no-stealth.png` で 1.2〜1.4 を実施 | セクションは表示され、押下後は `No stealth payload found in the pixel LSBs.` のみ。ボタンは消える（再試行ボタンは出ない） |
| 2.2 | `03-no-metadata-alpha.png` を開く | 通常メタデータのセクションは無い（「メタデータ無し」の表示）。Stealth セクションは**表示**され、押下で 2.1 と同じ未検出文言 |
| 2.3 | `04-comfyui-api-prompt.png` を開く | 生成元が **ComfyUI** と表示され、positive / negative / LoRA が §2 の補足どおりに出る。Stealth セクションは表示、押下で未検出文言 |

### 3.3 非表示の分岐（#5 / #6 / #7）

| # | 操作 | 期待結果 |
| --- | --- | --- |
| 3.1 | `05-stealth-only-alpha.png` を開く | 通常スキャンで `Stealth PNG Info (Alpha)` が出る。**「Stealth Metadata (PNG LSB)」セクションは出ない**（押しても同じ結果のため)。Network に追加リクエストは無い |
| 3.2 | `06-gray8-not-eligible.png` を開く | セクションが出ない。probe の後にセクションが消えるだけで、**画像の本体取得は発生しない** |
| 3.3 | `07-rgb16-not-eligible.png` を開く | 同上（16bit RGB は候補外）。Console にエラーが出ない |

### 3.4 RGB 担体（#8）

| # | 操作 | 期待結果 |
| --- | --- | --- |
| 4.1 | `08-stealth-rgb-with-metadata.png` で 1.2〜1.5 を実施 | ラベルが **`Stealth PNG Info (RGB)`**、本文が `{"prompt":"e2e rgb payload"}`。Alpha 担体と取り違えない |

### 3.5 失敗経路（任意・#1 で実施）

| # | 操作 | 期待結果 |
| --- | --- | --- |
| 5.1 | DevTools の Network で該当 PNG を **Block request URL** にしてからボタンを押す | `Stealth scan failed.` と表示され、ボタンが **`Retry stealth scan`** に変わる |
| 5.2 | ブロックを解除して `Retry stealth scan` を押す | 3.1 の 1.5 と同じ成功表示になる。メタデータ表示は壊れない |
| 5.3 | 再度ブロックしたまま押す | もう一度失敗表示になり、**メタデータのセクションは変化しない**（stealth 失敗が通常メタデータを汚さない） |

## 4. 合否の判定

- 合格条件: §3 の全項目が期待どおり。特に
  (a) 押下しない限りペイロードが出ない、(b) 押下時の本体取得は 1 回、
  (c) 再表示でリクエスト 0、(d) #5/#6/#7 でセクションが出ない、(e) #8 が RGB 担体として出る。
- 不一致があった場合は、以下を記録する: 画像 #、操作 #、実際の表示文言、Network のリクエスト一覧、
  Console のエラー、`chrome://version` の Chrome バージョン。

### 記録表

| 画像 # | セクション表示 | 押下結果 | リクエスト数（probe / scan / 再表示） | 判定 | メモ |
| --- | --- | --- | --- | --- | --- |
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
| 4 | | | | | |
| 5 | | | | | |
| 6 | | | | | |
| 7 | | | | | |
| 8 | | | | | |

## 5. 既知の制限（不具合ではない）

- 33.5MP 超の PNG は候補を作らない（`unsupported-stealth-pixel-limit` → `Not checked: …` 表示）。
- インターレース PNG と scanner 未対応レイアウトは対象外（セクションが出ない）。
- 16bit RGB は RGB モードの対象外（α 付き 16bit は対象）。
- 動画・PNG 以外の形式ではセクション自体を出さない。
- 通常スキャンで既に Stealth を検出済みの画像ではボタンを出さない。

## 6. 自動化の状況

- ユニット/統合: `node --test tests/metadata/*.test.cjs` → **207 pass / 0 fail**
  （`stealth_on_demand.test.cjs` 5 件、`stealth_modal.test.cjs` 5 件、ComfyUI P0 19 件を含む）。
- ブラウザ E2E の自動化: **未実施**。WSL2 から Windows Chrome の CDP ポートへ到達できないため
  （`docs/stealth-on-demand.md` §7 と同じ制約）。到達できない場合の代替は 2 つ:
  1. Windows 側の Node から `--remote-debugging-port=9222` の Chrome に接続して自動化する。
  2. 本チェックリストを手動で実施する（推奨）。

  最後に試行した日時と結果はリポジトリの当該セッション報告に記録する。

## 7. 付録: 画像セットの再生成

```bash
node tests/e2e/stealth-on-demand/build.cjs
```

- 8 枚を再生成し、`MANIFEST.json` に「実際の scanner 結果」と「期待値」を並べて書き出す。
- 生成した画像が期待値と食い違えば **exit 1** で失敗する（実装が変わったときの検知に使う）。
- 出力は決定的（同じ入力から同じ bytes / 同じ sha256）。
