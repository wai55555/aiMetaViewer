# AI Meta Viewer (Chrome Extension)

![](https://raw.githubusercontent.com/wai55555/aiMetaViewer/refs/heads/main/sample/sample_civitai.png)

[Chrome Web Store](https://chromewebstore.google.com/detail/ai-meta-viewer/glggkpjfgbabooefiijgnaemfabdmkgf?hl=en&authuser=5)

AI生成画像のメタデータ（プロンプト、設定情報など）をブラウザ上で簡単に閲覧できるChrome拡張機能です。
Webページ上の画像を自動的に解析し、メタデータが含まれている場合に表示します。

## ✨ 主な機能

- **自動検出**: ページ内の画像を監視し、AI生成メタデータが含まれる画像を自動検出
- **Stealth PNG 対応**: アルファチャンネルに隠された「Stealth PNG Info」も検出可能
- **高度なリンク解析**:
  - **Discord**: プレビュー画像からオリジナル画像のリンクを自動検出し、劣化のないメタデータを取得
  - **Pixiv**: オリジナル画像リンクを自動検出
  - **Civitai**: モデルファイル（.safetensors, .ckpt）とサンプル画像を検出、最適化されたAPI URLハンドリング
  - **ローカルファイル**: `file://` URLで開いた画像にも対応
- **対応フォーマット**:
  - PNG (tEXt / iTXt / Stealth Info)
  - JPEG (Exif UserComment)
  - WebP (EXIF チャンク)
  - AVIF (Exif UserComment)
  - Safetensors (モデルメタデータ)
- **生成ツール自動判定**:
  - Stable Diffusion WebUI (A1111, Forge)
  - ComfyUI (Workflow JSON対応)
  - NovelAI (V3 / V4 / V4.5)
  - Tensor.art
- **詳細ビューア**:
  - Positive Prompt / Negative Prompt / Other Settings に自動分類
  - **多色ハイライト**: 項目ごとに異なる色で強調表示（Model, ADetailer, Hires, Lora 等）
  - 全メタデータのコピー機能
  - JSONデータの整形表示
- **一括スキャン＆ダウンローダー**:
  - 拡張機能アイコンをクリックしてページ全体をスキャン
  - 画像、動画、音声、アーカイブファイルを一括ダウンロード
  - **柔軟なフォルダ構成**: ページタイトル、ドメイン名、またはフラットな構造で自動整理
  - **メディアタイプフィルタ**: 画像、動画、音声、アーカイブで絞り込み表示
  - **複数メディア対応**: 画像、動画、音声ファイル、モデルアーカイブ（.safetensors, .ckpt, .zip等）をダウンロード
- **クロスブラウザ対応**:
  - Chrome/Chromiumベースのブラウザ（Chrome, Brave, Edge等）に対応
  - 堅牢な拡張機能コンテキスト検証と自動復旧

## 🚀 インストール方法
[Chrome Web Store](https://chromewebstore.google.com/detail/ai-meta-viewer/glggkpjfgbabooefiijgnaemfabdmkgf?hl=en&authuser=5)
~~webstoreに最新版があります。~~

最新版は、以下の手順で手動インストールしてください。

![](https://raw.githubusercontent.com/wai55555/aiMetaViewer/refs/heads/main/sample/code_download_zip.png)

1. このリポジトリをダウンロードします（緑色の **Code** ボタン -> **Download ZIP**）。
2. ダウンロードしたZIPファイルを解凍します。
3. Google Chromeを開き、アドレスバーに `chrome://extensions` と入力します。
4. 右上の **「デベロッパーモード」** スイッチをオンにします。
5. **「パッケージ化されていない拡張機能を読み込む」** をクリックします。
6. 解凍したフォルダの中にある `extension` フォルダを選択します。

## 📖 使い方

### 個別画像の閲覧
1. 拡張機能を有効にした状態で、AI生成画像が含まれるWebサイトを開きます。
2. メタデータが含まれる画像の左上に **"View Metadata"** バッジが表示されます。
3. バッジをクリックすると、詳細なメタデータが表示されます。
4. 各項目の「Copy」ボタンで内容をクリップボードにコピーできます。

### ページ内一括スキャン＆ダウンロード
1. ブラウザのツールバーにある **AI Meta Viewer** 拡張機能のアイコンをクリックします。
2. ページ内の画像スキャンが開始されます（プログレスバーが表示されます）。
3. スキャン完了後、ダウンローダー画面が表示されます。
4. 保存したい画像を選択（またはフィルタリング）し、**"Download Selected"** をクリックします。
5. 設定したフォルダ構成（ページタイトル等）で、ブラウザのダウンロードフォルダに保存されます。

## ⚙️ 設定オプション

拡張機能のアイコンを右クリック -> 「オプション」から以下の設定が可能です。

- **画像処理**: メタデータチェックを行う最小画素数（閾値）の設定
- **除外サイト**: 拡張機能を無効化したいサイトをワイルドカードで指定
- **ダウンローダー設定**: 
  - 保存先のサブフォルダ構成（ページタイトル、ドメイン名、なし）を選択
  - メインフォルダ名（デフォルト: `AI_Meta_Viewer`）のカスタマイズ
  - メインフォルダを作成せず「ダウンロード」直下に保存するオプション
- **通知**: エラー時の通知表示設定
- **キャッシュ**: メモリ解放のためのキャッシュクリア



## 🔒 プライバシーとセキュリティ

- **ローカル処理**: 画像の解析はすべてブラウザ内（ローカル）で行われます。外部サーバーに画像データやメタデータを送信することはありません。
- **権限**: 
  - `activeTab` / `host_permissions`: ページ上の画像データにアクセスするために使用します。
  - `storage`: 設定を保存するために使用します。

## 🛠️ 技術仕様

- **Manifest V3** 準拠
- **Background Service Worker**: 
  - 画像のFetchとバイナリ解析を担当
  - Stealth PNGの高速解析（シグネチャによる早期リターン、LRUキャッシュ）
- **Content Script**: 
  - DOM監視（IntersectionObserver, MutationObserver）
  - サイト別アダプター（Discord, Pixiv等の特殊構造対応）
- **Parser**: バイナリパーサー（エンディアン判定、文字コード判定対応）

## 📂 ディレクトリ構成

```
aiMetaViewer/
└─ extension/          # Chrome拡張機能のソースコード
   ├── manifest.json   # 設定ファイル
   ├── background.js   # Service Worker (Fetch & Parse & Download & Cache)
   ├── content.js      # Content Script (Badge管理)
   ├── scanner.js      # 一括スキャン＆ダウンローダー
   ├── parser.js       # メタデータ解析ロジック
   ├── ui.js           # UIコンポーネント
   ├── options.html    # 設定画面HTML
   ├── options.js      # 設定画面ロジック
   ├── styles.css      # スタイルシート
   └── icons/          # アイコン画像
```

## 📜 ライセンス

MIT License

## 🔐 プライバシーポリシー

この拡張機能はユーザーデータを一切収集しません。すべての処理はローカル（ブラウザ内）で完結します。

詳細: [Privacy Policy](https://wai55555.github.io/aiMetaViewer/privacy-policy.html)
