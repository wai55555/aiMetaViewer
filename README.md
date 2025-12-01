# AI Meta Viewer (Chrome Extension)
[](https://raw.githubusercontent.com/wai55555/aiMetaViewer/refs/heads/main/sample/main_window_01.png)
AI生成画像のメタデータ（プロンプト、設定情報など）をブラウザ上で簡単に閲覧できるChrome拡張機能です。
Webページ上の画像を自動的に解析し、メタデータが含まれている場合に表示します。

## ✨ 主な機能

- **自動検出**: ページ内の画像を監視し、AI生成メタデータが含まれる画像を自動検出
- **対応フォーマット**:
  - PNG (tEXt / iTXt チャンク)
  - JPEG (Exif UserComment)
  - WebP (EXIF チャンク)
  - AVIF (Exif UserComment)
- **生成ツール自動判定**:
  - Stable Diffusion WebUI
  - ComfyUI (Workflow)
  - NovelAI (V3 / V4 / V4.5 たぶん対応)
  - Tensor.art
- **詳細ビューア**:
  - Positive Prompt / Negative Prompt / Other Settings に自動分類
  - 全メタデータのコピー機能
  - JSONデータの整形表示

## 🚀 インストール方法

この拡張機能はChromeウェブストアにはまだ公開されていません。以下の手順で手動インストールしてください。

1. このリポジトリをクローンまたはダウンロードします。
   ```bash
   git clone https://github.com/wai55555/aiMetaViewer.git
   ```
2. Google Chromeを開き、アドレスバーに `chrome://extensions` と入力します。
3. 右上の **「デベロッパーモード」** スイッチをオンにします。
4. **「パッケージ化されていない拡張機能を読み込む」** をクリックします。
5. クローンしたディレクトリ内の `extension` フォルダを選択します。

## 📖 使い方

1. 拡張機能を有効にした状態で、AI生成画像が含まれるWebサイト（Civitai, Tensor.art, またはローカルのHTMLビューアなど）を開きます。
2. メタデータが含まれる画像の左上に **"View Metadata"** と表示されます。
3. **"View Metadata"**をクリックすると、メタデータ詳細が表示されるモーダルウィンドウが開きます。
4. 各セクションの「Copy」ボタンで内容をクリップボードにコピーできます。「Copy All Data」で全ての情報をコピーできます。

## 🛠️ 技術仕様

- **Manifest V3** 準拠
- **Background Service Worker**: 画像のFetchとバイナリ解析を担当（CORS回避のため）
- **Content Script**: DOM監視とUI描画を担当
- **Parser**: Rust実装と同等のロジックでJavaScriptに移植されたバイナリパーサー（エンディアン判定、文字コード判定対応）

## 📂 ディレクトリ構成

```
aiMetaViewer/
└─ extension/          # Chrome拡張機能のソースコード
   ├── manifest.json   # 設定ファイル
   ├── background.js   # Service Worker (Fetch & Parse)
   ├── content.js      # Content Script (UI & DOM)
   ├── parser.js       # メタデータ解析ロジック
   ├── ui.js           # UIコンポーネント
   ├── styles.css      # スタイルシート
   ├── popup.html      # ポップアップ画面
   └── icons/          # アイコン画像
```

## 📜 ライセンス

MIT License
