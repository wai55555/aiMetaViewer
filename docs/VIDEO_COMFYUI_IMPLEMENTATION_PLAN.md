# 動画metadata・ComfyUI表示の改善

## 目的

解析メモをもとに、MP4/WebMの埋め込み生成metadataとComfyUI workflowの読みやすい表示を追加する。作業は別worktree・独立ブランチで行い、issue番号とは関連付けない。

## 実装範囲

- MP4の`moov/udta/meta/keys/ilst`、旧式`©cmt`の16-bit user-data text entry、および`desc` data boxから、`prompt`、`workflow`、`parameters`等を抽出する。
- WebMはEBML構造と`Tags/SimpleTag`を解析する。`SeekHead`を優先し、element sizeを使ってCluster本文を読み飛ばす。未知のタグはraw情報として保持し、任意バイト列を文字列検索しない。
- ComfyUI API prompt形式とUI workflow形式を共通グラフ化し、prompt、negative prompt、model、接続済みLoRA、主要sampling設定を要約する。元のJSONは折りたたみ欄に保持する。
- `<video>`要素と動画URLにリンクした画像サムネイルにバッジを付け、既存metadataモーダルを表示専用で再利用する。
- codec等の動画再生情報、`blob:` URL、インタラクティブなノードグラフは対象外。

## 安全・失敗時の扱い

- parserは画像parserから分離し、atom/EBML elementの境界・サイズ・深さを検証する。
- 合計取得量は2 MiB、MP4の初期head/tail windowは各256 KiB、WebMのrange header取得は最大64回とする。
- ComfyUIの`prompt`・`workflow`・`generation_data` graphは各々最大10,000 node・20,000 link・100 output・100,000 traversal workで要約する。3 graphすべてがある場合の総上限は30,000 node・60,000 link・300 output・300,000 traversal workで、最終summary groupは各200件。切り詰め時はraw JSONを残したまま要約が不完全なことを表示する。
- Range非対応、file URLのアクセス拒否、未知サイズ、上限到達、破損データは空metadataとして確定せず、`unresolved`または`resource-limit`を返す。
- WebMのunknown-size Clusterは終了位置を安全に特定できないため走査を`unresolved`にし、後続Tagsやmetadataなしを推測しない。
- `fetchImageMetadata`契約と画像の解析・編集動作を維持する。動画用metadataのキャッシュは画像用と名前空間を分ける。
- 動画metadata本文や`file:` URLのpathを動画診断ログへ出さない。

## 実装チェックリスト

- [x] 独立したWindows-visible worktreeとブランチを作成
- [x] MP4/WebM純粋parserを追加
- [x] Background video metadata取得action・cache・bounded range reader
- [x] ComfyUI workflow normalizerと要約表示
- [x] video/video-link thumbnail observerと表示専用modal
- [x] Node標準test fixturesと構文確認
- [x] 実装後の受け入れ結果を追記

## テスト計画

- MP4: head/tail moov、32/64-bit atom、`keys/ilst`、名前付きComfyUI JSONのraw保持、QuickTime 16-bit user-data textとMacRoman/UTF-16 encoding、旧式`data` box、破損・oversized box、metadataなし。
- WebM: SeekHead、nested SimpleTag、複数Tags、サイズ既知Clusterのskip、unknown-size Clusterの`unresolved`扱い、truncated input、range budget。
- ComfyUI: API link、UI `workflow.links`、複数output branch、cycle、orphan LoRA、widgets値、切り詰めJSON、大規模graphと高密度linkの処理上限。
- UI: video badgeのmodal表示、raw JSON保持、動画編集ボタン非表示、画像modalの従来動作。
- `node --test tests/metadata/*.test.cjs`と、変更したJSファイルの`node --check`を実行する。

fixtureで自動確認するのはparser/range reader、ComfyUIの要約・section model、動画編集を止めるコード条件まで。動画badgeの実DOM表示、IntersectionObserverの遷移、実HTTP/file Range取得、modalの操作と画像側の回帰はブラウザでの受け入れ確認項目とし、この環境では未実施。

## 実装結果

- 作業場所は`/mnt/c/github/aimetaviewer-comfyui-video`、branchは`codex/comfyui-video-metadata`。作成時のbaseは`163c1a6`。作業中にmain checkoutが`0fcd3b9`へ進んだため、統合時に最新状態を確認して追従する。
- `extension/video_parser.js`にMP4の32/64-bit atom、`keys/ilst`、旧式QuickTime comment、WebMのEBML Tags/SimpleTagを読むparserを追加。parserは境界・サイズ・深さ・件数を制限し、動画payload内の任意文字列検索はしない。
- `extension/video_range_reader.js`とBackground actionを追加。HTTP Range/file URLを合計2 MiB以内で読み、Range非対応時もReadableStreamを上限で打ち切る。解析結果は`video-metadata-v1:` namespaceで画像cacheから分離。
- `extension/comfyui_parser.js`でAPI prompt graphとUI workflow graphを要約。接続されたoutput branchからpositive/negative prompt、model、LoRA、sampler設定を拾い、raw JSONも別sectionで保持。
- `<video>`と動画URLリンク画像をviewport queueで解析。最大4件を並行処理し、DOM削除・viewport退出・source変更時に取り消す。動画modalは編集と画像書き込みを無効化。
- Node fixtureテスト54件が成功。変更したJavaScriptの構文確認とmanifest JSON確認も成功。QuickTime 16-bit user-data textのencoding、名前付きComfyUI JSONのraw保持、raw JSON文字列からの要約、旧式MP4タグの破損や短いvalue header、不正JSONの誤要約、Content-Lengthより短い応答、WebM unknown-size Clusterの未確定扱い、大規模workflow要約と高密度linkの処理上限もfixtureで検証する。ブラウザ上での拡張機能手動動作確認はこの環境では行っていない。
