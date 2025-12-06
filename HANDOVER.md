# AI Meta Viewer 開発詳細引き継ぎ書

**最終更新日**: 2025年12月7日
**対象バージョン**: 1.0.0 (Commit: `415d2ad`)
**前任開発者**: Antigravity Agent

---

## 1. プロジェクト概要

### 1.1. 目的
**AI Meta Viewer** は、ブラウザ上で閲覧している画像（Web上の画像およびローカルファイル）に含まれる生成AIのメタデータ（プロンプト、ネガティブプロンプト、生成パラメータなど）を、画像をダウンロードすることなくその場で確認できる Chrome 拡張機能です。

### 1.2. コアバリュー
- **即時性**: 画像の上にマウスオーバーするだけで「View Metadata」バッジを表示し、ワンクリックで詳細を確認可能。
- **多機能対応**: 主要な画像生成AIツール（NovelAI, Stable Diffusion, Midjourney, ComfyUI, Civitai, Tensor.art）の独自メタデータ形式を自動判別・解析。
- **プライバシー**: すべての処理をブラウザ内で完結させ、外部サーバーへのデータ送信を行わない（完全ローカル処理）。

### 1.3. 技術スタック
- **プラットフォーム**: Chrome Extension (Manifest V3)
- **言語**: JavaScript (ES2020+), HTML5, CSS3
- **フレームワーク**: バニラJS (依存ライブラリなし)
- **ビルドツール**: なし (標準Web技術のみで構成)

---

## 2. 現在の開発状況とバージョン管理

### 2.1. Git リポジトリ状態
- **HEAD**: `194920908f0f6267643118b9557e1ea2acd93f38`
- **Branch**: `main`
- **Web Store 公開版**: `3619211f09fbf822baecbf2e2fd2af995852fedb` (Midjourney対応版)

### 2.2. 未公開の変更点（公開版からの差分）
公開版 (`3619211`) 以降、以下の重要な修正と機能追加が行われています。これらは次期アップデートに含まれるべき内容です。

#### A. ローカルファイルアクセス (file://) の堅牢化【重要】
- **背景**: Chrome のセキュリティポリシーにより、Content Script (Isolated World) から `file://` 画像への XHR/Fetch が **CORS エラーでブロック**される問題が発生。
- **根本原因**: 
  - Content Script は Isolated World で動作し、`file://` から `file://` へのアクセスは Same-Origin Policy により禁止される。
  - **重要**: `file://` URL では `console.log` が DevTools に表示されない（Chrome の仕様）ため、デバッグが極めて困難。
- **最終的な対策（Commit: `415d2ad`）**:
  - **`content.js`**: `fetchLocalImage()` 関数を完全に削除。`file://` URL の場合、画像データを取得せず、URL のみを `background.js` に送信する。
  - **`background.js`**: Service Worker から直接 `fetch(file://...)` を実行。拡張機能の設定で「ファイルの URL へのアクセスを許可」が有効な場合のみ成功する。
  - **デバッグ支援**: `debugLog()` 関数を実装し、`file://` URL では画面下部に緑色のログコンテナを表示してデバッグ情報を可視化。
- **現状の制約**: 
  - ユーザーが Chrome の拡張機能設定で「ファイルの URL へのアクセスを許可」を有効にしていない場合、ローカルファイルのメタデータは取得できない。
  - この設定はユーザーが手動で行う必要があり、拡張機能側から自動化できない。

#### B. UI/UX の改善
- **NovelAI Negative Prompt**: `uc` キーを優先し、オブジェクト形式（v4など）のネガティブプロンプトも正しく文字列化して表示するように修正。
- **モデル名のハイライト**: `parameters_settings` 内の `Model:` フィールドを検出し、オレンジ色（`#ff9500`）かつ太字で強調表示。視認性を大幅に向上。
- **Civitai 判定強化**: `Version: v1.10.` などのバージョン表記パターンを検出し、Civitai 生成画像として正しく分類。

#### C. 安全性の向上
- **Null Safety**: `document.body` が `null` になる可能性があるタイミング（読み込み初期や特定のフレーム内）でのアクセスに対し、徹底的な null チェックを追加。ランタイムエラーを防止。
- **不要メタデータの除外**: CLIP STUDIO PAINT (Celsys Studio Tool) などのペイントソフトが付与するメタデータは、AI生成情報ではないため表示対象外とした。

---

## 3. アーキテクチャ詳細設計

### 3.1. コンポーネント構成

#### `manifest.json`
- **権限**:
  - `activeTab`: 現在のタブへのアクセス。
  - `storage`: 設定の保存。
  - `declarativeNetRequest`: (将来的な拡張用、現在は静的ルールのみ)。
  - `host_permissions`: `<all_urls>` (全サイトでの画像アクセスに必須)。
- **Content Scripts**: 全ページ (`<all_urls>`)、全フレーム (`all_frames: true`) で動作。

#### `content.js` (Content Script)
ページのDOMにアクセスし、画像を監視する最前線のスクリプト。
- **責務**:
  - `MutationObserver` による動的に追加される画像の監視。
  - 画像へのマウスオーバーイベントのハンドリング。
  - 「View Metadata」バッジの生成と配置 (`ui.js` 利用)。
  - 画像 URL の解決（サイト別アダプター使用）と `background.js` への解析リクエスト。
  - 解析結果のキャッシュ管理 (`metadataCache`)。
- **重要ロジック**:
  - `debugLog(message, data)`: `file://` URL でのデバッグ用。DOM に直接ログを表示する。
  - `isDirectImageView()`: ブラウザが画像を直接開いている状態（HTMLなし）を判定。
  - **注意**: `fetchLocalImage()` は削除済み。ローカルファイルは `background.js` に委譲する。

#### `background.js` (Service Worker)
バックグラウンドで動作し、クロスオリジン制約を回避して画像データを取得・解析する。
- **責務**:
  - `content.js` からの `fetchImageMetadata` メッセージの受信。
  - 画像URLからのデータ取得 (`fetch`)。
  - `parser.js` を使用したバイナリ解析。
  - 解析結果の返却。
- **特記事項**: `file://` プロトコルへのアクセスは、Service Worker から直接 `fetch()` で実行される。拡張機能の「ファイルの URL へのアクセスを許可」設定が有効な場合のみ成功する。Content Script からは CORS により失敗するため、この委譲方式が必須である。

#### `parser.js` (Metadata Parser)
画像バイナリからメタデータを抽出するコアロジック。
- **対応フォーマット**:
  - **PNG**: `tEXt` (textual data), `iTXt` (international textual data) チャンクの解析。
  - **JPEG**: Exif (APP1) セグメントの解析。UserComment タグのデコード。
  - **WebP**: RIFF コンテナ内の EXIF チャンク解析。
  - **AVIF**: ISO BMFF ボックス構造の解析、Exif ボックスの特定。
- **特徴**: バイナリデータを直接扱うため、高速かつメモリ効率が良い。`TextDecoder` を使用して UTF-8 などを適切にデコードする。

#### `ui.js` (UI Component)
画面に表示される要素（バッジ、モーダル）の生成と制御。
- **責務**:
  - バッジ (`createBadge`) の生成。
  - モーダル (`createModal`) の生成、表示、イベントハンドリング（閉じる、コピーなど）。
  - メタデータの整形表示（タブ分け、ハイライト処理）。
  - **Generator Detection**: メタデータの内容から生成ツール（NovelAI, Midjourney等）を推定するロジック (`detectGenerator`)。

### 3.2. データフロー
1. **ユーザーアクション**: 画像にマウスオーバー。
2. **Content Script**:
   - キャッシュを確認。あれば即バッジ表示。
   - なければ `background.js` へ URL を送信（`file://` の場合は自身でデータ取得して送信）。
3. **Background**:
   - URL から画像データを `ArrayBuffer` として取得。
   - `extractMetadata()` を実行。
   - 結果を Content Script へ返送。
4. **Content Script**:
   - 結果を受信しキャッシュ。
   - メタデータが存在すればバッジを表示。
5. **ユーザーアクション**: バッジをクリック。
6. **UI**:
   - メタデータを解析 (`parseMetadataToTabs`)。
   - モーダルを生成し `document.body` に追加。

---

## 4. 詳細実装解説

### 4.1. メタデータ解析ロジック (`parser.js`)
- **PNG**: シグネチャ確認後、チャンクを順次読み込む。`tEXt` キーワードが "parameters" (A1111), "Description", "Comment" (NovelAI), "Software" などの場合に値を抽出。
- **JPEG**: SOI マーカーから開始し、`FF E1` (APP1) マーカーを探す。Exif ヘッダーを確認し、IFD (Image File Directory) をパースして `UserComment` (Tag 0x9286) を取得。
- **Stealth PNG Info**: A1111 などが埋め込む、RGB 値の最下位ビットに情報を隠す方式には現在**未対応**（将来的な課題）。現在はテキストチャンクのみ対応。

### 4.2. ツール判定ロジック (`ui.js` - `detectGenerator`)
メタデータの特徴からツールを特定します。
- **Midjourney**: `Description` に "Job ID:" または `--v` 等のパラメータが含まれる。
- **NovelAI**: `Comment` キーが存在する、または `Description` に "NovelAI" 文字列が含まれる。`Software: NovelAI` も確認。
- **Tensor.art**: `prompt` 内に `ECHOCheckpointLoaderSimple` がある。
- **ComfyUI**: `workflow` または `generation_data` キーが存在する。
- **Civitai**: `parameters` 内に "Civitai metadata" または "Version: v1.10." 等のパターンがある。
- **Stable Diffusion WebUI**: 上記以外で `parameters` がある場合のデフォルト。

### 4.3. NovelAI 特有の処理
NovelAI はバージョンによってメタデータの格納場所が異なります。
- **V3**: `Comment` 内の JSON に `uc` (Undesired Content) としてネガティブプロンプトを格納。
- **V4**: `v4_negative_prompt` オブジェクト内に格納される場合がある。
- **対策**: `ui.js` の `parseMetadataToTabs` で、`uc` キーを最優先し、次に `negative` を含むキーを検索。値がオブジェクトの場合は `caption.base_caption` を探すか、`JSON.stringify` で文字列化して表示するロジックを実装済み。

---

## 5. 既知の課題と制約事項

### 5.1. `file://` プロトコルの CORS 問題
**現状**: ローカルの HTML ファイル (`file:///.../index.html`) から、同じローカルの画像 (`file:///.../image.png`) を読み込もうとすると、Chrome はセキュリティ上の理由で XHR/Fetch をブロックします（Origin 'null'）。
**影響**: 拡張機能の設定で「ファイルの URL へのアクセスを許可」していても、スクリプトからのアクセスはブロックされることがあります。
**回避策**:
- 開発・テスト時は `python -m http.server` 等でローカルサーバーを立てることを強く推奨。
- 一般ユーザーに対しては、Web 上の画像や、ブラウザに直接ドラッグ＆ドロップした画像（直接表示）での利用を案内する。

### 5.2. 画像フォーマットの制限
- **JPEG**: Exif の `UserComment` 以外の場所にメタデータが格納されている場合（例: Photoshop の XMP データなど）は未対応。
- **WebP/AVIF**: まだ採用例が少なく、実装は実験的な段階。Exif チャンクの解析のみ対応。

### 5.3. 大量画像のパフォーマンス
- ページ内に数百枚の画像がある場合、すべての画像に対してメタデータチェック（ヘッダー取得など）を行うとパフォーマンスに影響する可能性がある。現在はマウスオーバー時ではなく、`MutationObserver` で検知した時点でチェックを行っているため、将来的に「マウスオーバー時に初めてチェックする」遅延ロード方式への変更を検討してもよい。

---

## 6. 今後の開発ロードマップ（推奨）

### Phase 1: 安定性向上（即時）
- [ ] **エラーレポートの強化**: `content.js` で発生したエラーをユーザーに通知する仕組み（現在はコンソールログのみ）。
- [ ] **ローカルファイル対応の限界調査**: File System Access API などの代替手段の調査（ただし権限要求が厳しい）。

### Phase 2: 対応フォーマット・ツールの拡充
- [ ] **Stealth PNG Info 対応**: A1111 の Stealth PNG Info をデコードする機能の追加。
- [ ] **XMP メタデータ対応**: JPEG/PNG に含まれる XMP データの解析。Adobe 製品や一部の AI ツールで使用される。

### Phase 3: UI/UX の高度化
- [ ] **設定画面の充実**: ハイライト色のカスタマイズ、バッジ表示位置の変更、除外サイトの管理などを GUI で行えるようにする。
- [ ] **履歴機能**: 閲覧したメタデータの履歴を保存し、後から参照できる機能。
- [ ] **比較機能**: 2つの画像のメタデータを並べて比較する機能（パラメータの差分表示など）。

---

## 7. 開発環境セットアップ手順

1. **リポジトリのクローン**
   ```powershell
   git clone https://github.com/wai55555/aiMetaViewer.git
   cd aiMetaViewer
   ```

2. **Chrome への読み込み**
   - Chrome で `chrome://extensions/` を開く。
   - 右上の「デベロッパーモード」をオンにする。
   - 「パッケージ化されていない拡張機能を読み込む」をクリック。
   - `aiMetaViewer/extension` フォルダを選択。

3. **ローカルテスト環境の構築**
   - Python がインストールされている場合:
     ```powershell
     python -m http.server 8000
     ```
   - ブラウザで `http://localhost:8000/test_NovelAI.html` (存在する場合) や、任意の画像を含む HTML にアクセス。

4. **デバッグ**
   - 拡張機能のアイコンを右クリック → オプション → 「Debug Mode」を有効にする。
   - ページのコンソール (F12) に `[AI Meta Viewer]` プレフィックス付きのログが出力される。
   - **`file://` URL でのデバッグ**: 
     - `console.log` は DevTools に表示されない（Chrome の仕様）。
     - `debugLog()` 関数により、画面下部に緑色のログコンテナが表示される。
     - `background.js` のログは Service Worker のコンソールで確認可能（`chrome://extensions` → 拡張機能の「Service Worker」リンク）。

---

## 8. ファイル構成一覧

```
aiMetaViewer/
├── extension/
│   ├── manifest.json       # 拡張機能定義ファイル
│   ├── background.js       # バックグラウンド処理 (Service Worker)
│   ├── content.js          # ページ内スクリプト (DOM操作、画像監視)
│   ├── parser.js           # メタデータ解析ロジック (バイナリ処理)
│   ├── ui.js               # UI生成、表示ロジック
│   ├── options.js          # オプション画面用スクリプト
│   ├── options.html        # オプション画面 HTML
│   ├── popup.html          # ポップアップ HTML (現在は簡易的なもの)
│   ├── styles.css          # UI用スタイルシート
│   ├── rules.json          # declarativeNetRequest 用ルール (空または静的ルール)
│   └── icons/              # アイコン画像
├── docs/                   # ドキュメント類
├── test_*.html             # テスト用 HTML (Git管理外の場合あり)
├── test_*.js               # テスト用スクリプト (Git管理外の場合あり)
├── HANDOVER.md             # 本ファイル
└── README.md               # 一般ユーザー向け説明書
```

---

このドキュメントは、プロジェクトの全容を把握し、スムーズに開発を継続するために作成されました。不明点はソースコード内のコメント（日本語で記述済み）も併せて参照してください。
