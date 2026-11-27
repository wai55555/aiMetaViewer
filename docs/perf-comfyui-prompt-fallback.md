# ComfyUI プロンプト検出: parameters フォールバック / 解決器テーブル / ベースライン計測

- 作業日: 2026-11-26
- ブランチ: `comfyui-prompt-fallback`
- worktree: `/mnt/c/github/aimetaviewer-comfyui-params`（基点 `main` = `ca9fea1`）
- 対象: `extension/comfyui_parser.js`（中心）、`extension/ui.js`（フォールバック表示のみ）

## 1. スコープ（今回の3点）

1. **parameters フォールバック**: ComfyUI グラフから positive/negative が1件も取れない場合に限り、
   `parameters` チャンクを A1111 形式として解釈し、**由来を明示して**表示する。
2. **テキスト解決器のテーブル駆動スケルトン + 回帰テスト基盤**:
   添付画像の縮約フィクスチャと、正負入れ替わり再現用の合成グラフを用意。
   ノード意味論は表データとして後から差し込める構造にし、中身は既知の範囲のみ。
3. **現行パーサのベースライン計測**: メタデータ無し／素の CLIPTextEncode のみ、の処理コストを記録。

対象外（意図的に未実装）: スロット意味論の全面実装、個別カスタムノード対応、
UI 形式の bypass/mute 判定、group node 展開、書き戻し対応。

## 2. 解析対象PNGの実測（前提）

添付PNGの tEXt チャンクは3つ。

| chunk | サイズ | 実体 |
| --- | --- | --- |
| `parameters` | 1,182 B | A1111 形式テキスト（`Negative prompt:` と `Steps:` を含む） |
| `prompt` | 23,627 B | ComfyUI API 形式（実行済み 42 ノード） |
| `workflow` | 154,773 B | ComfyUI UI 形式（142 ノード / 252 リンク、88 ノードが `mode: 4`） |

実行グラフではプロンプト文字列が `CLIPTextEncode` に存在しない:

- positive: `Text Prompt (JPS)` → `Text Concatenate (JPS)` → `Efficient Loader.positive`（STRING）
- negative: `Text Prompt (JPS)` → `Efficient Loader.negative`（STRING）
- アップスケール工程: `SD Prompt Reader` の POSITIVE/NEGATIVE 出力 → `CLIPTextEncode`
- 保存: `SDPromptSaver` が入力画像の正負を `parameters` に書き出す

したがって「グラフから取れない → `parameters` にだけ答えがある」ケースの代表例。
変更前の実測は `positive/negative/unconnected = 0/0/0` で、UI には Raw JSON のみが出ていた。

## 3. 実装

### 3.1 テキスト解決器テーブル（`comfyui_parser.js`）

`TEXT_RESOLVERS`（`Map`）に **検証済みの意味論だけ** を登録する。未登録ノードは
「解決できない」として扱い、位置や名前から推測しない。

```js
{
  fields: ['text'],        // プロンプト本文を持つ入力名（リテラルのみ）
  join: '\n',              // 複数フィールドの連結子（既定 '\n'）
  widgets: ['text'],       // UI形式(widgets_values)の並び。任意
  negativeFields: [],      // 予約: 負値専用フィールド
  outputs: [],             // 予約: conditioning 出力スロット意味論
}
```

公開API: `registerTextResolver(type, spec)` / `resetTextResolvers()`。
`resetTextResolvers()` は組み込み表を復元するため、テスト間で安全に使える。

組み込み済み（一次情報で確認したもののみ）:

P0 でカタログの検証済み項目まで拡張した（エンコーダ12 / STRING保持者13 / wildcard 3 /
連結 6 / 出力スロット表 2 / LoRA 表 3）。表の内容と根拠は
`docs/comfyui-text-node-catalog-verification.md` §8 を参照。

※ 表のキーは Python クラス名ではなく `class_type`（`NODE_CLASS_MAPPINGS` のキー）。
Inspire は ` //Inspire`、essentials は `CLIPTextEncodeSDXL+` が実キー（同 §1）。

`textNodesFrom()` と `unconnected` 判定は `isTextCarrier()`（＝表に存在するか）で行う。
これにより「表に1行足す」だけで新しいキャリアが prompt/unconnected に載る。

互換シム: 型名が `CLIPTextEncode` / `TextEncode` を含むノード（`smZ CLIPTextEncode`、
`CLIPTextEncode (NSP)` など）は、表に未登録でも従来どおり
`text, prompt, text_g, clip_g, text_l, clip_l, t5xxl` のリテラルを解決する。
これは既存挙動の維持が目的で、それ以外の型名には一切適用しない。

### 3.2 未解決スロットは `unconnected` に落とす（暫定修正）

従来の `inboundForOutput()` は、API 形式（`outputs[]` メタ無し）で
**入力リンクの並び順からスロット意味論を推測**していた。この推測が
`Efficient Loader`（slot0=MODEL, slot1=CONDITIONING+, slot2=CONDITIONING-）で正負を入れ替えていた。

変更後:

- 生産側が `outputs[]` を宣言している場合のみ、宣言名から解決する
  （`CONDITIONING+` / `CONDITIONING-` / `POSITIVE` / `NEGATIVE` などの別名を正規化）。
  宣言名が `MODEL` / `VAE` / `CLIP` / `LATENT` 等なら「プロンプト無し」と確定。
- API 形式で positive/negative 双方の入力リンクを持つ生産側は**解決不能**として空を返す。
  推測はしない。取り残されたテキストノードは `unconnected` に分類される（誤ラベルを出さない）。

これにより合成グラフ（`Efficient Loader` + CLIPTextEncode 2つ）は
`positive=[]`, `negative=[]`, `unconnected=[POSITIVE TEXT, NEGATIVE TEXT]` になる。

### 3.3 parameters フォールバック（`comfyui_parser.js` + `ui.js`）

`summarize()` の末尾で、**グラフ由来の positive/negative が両方 0 件** のときだけ
`parseA1111Parameters(source.parameters)` を試す。

- 対象はプレーンテキストの A1111 レコードのみ（`{`/`[` で始まる JSON は対象外）
- `Negative prompt:` も `Steps:` も無ければ不採用
- 成功時は `summary.fallback = { source:'parameters', format:'a1111', reason:'graph-prompts-unresolved', positive, negative, settings }`

UI（`buildSections`）は fallback がある場合に次のセクションを追加する（すべて読み取り専用）:

| id | 表示名 | kind |
| --- | --- | --- |
| `comfyFallbackOrigin` | Prompt Source | settings |
| `comfyFallbackPositive` | Positive Prompt (parameters) | positive |
| `comfyFallbackNegative` | Negative Prompt (parameters) | negative |

`comfyFallbackOrigin` の本文:

> No prompt text could be resolved from the ComfyUI graph. The prompts below come from the A1111-format `parameters` carrier.

書き戻し対象にはしない（`editable: false`、`dataFields` 無し）。

実PNGでの確認結果:

```
generator = ComfyUI
graph pos/neg/unconn = 0 0 0
fallback = { source: 'parameters', format: 'a1111', reason: 'graph-prompts-unresolved', posLen: 604, negLen: 290 }
sections:
  comfyFallbackOrigin   | Prompt Source                  | settings | editable false
  comfyFallbackPositive | Positive Prompt (parameters)   | positive | editable false
  comfyFallbackNegative | Negative Prompt (parameters)   | negative | editable false
  comfySummaryModels    | Models and LoRAs               | settings | editable false
  rawApiPrompt          | Raw API Prompt JSON            | raw
  workflow              | Raw Workflow JSON              | raw
  other                 | Other Settings                 | settings
```

## 4. ベースライン計測（項目3）

### 方法

`node tests/perf/comfyui_prompt_cost.cjs`（`--json` で機械可読出力）。
`performance.now()` で1回ずつ計測し、ウォームアップ後に中央値と p95 を算出。
変更前は worktree 作成直後（`ca9fea1` そのまま）、変更後に同スクリプトを再実行。

- 環境: node v22.21.0 / linux-x64 / 13th Gen Intel Core i5-13600KF
- 反復: メタデータ無し 20,000 / 素のCLIPTextEncode 5,000 / 縮約フィクスチャ 1,000

### 結果（ms/op、中央値 (p95)）

| ケース | ノード数 | 変更前 `summarize` | 変更後 `summarize` | 変更前 `buildSections` | 変更後 `buildSections` |
| --- | --- | --- | --- | --- | --- |
| メタデータ無し | 0 | 0.0005 (0.0009) | 0.0004 (0.0009) | 0.0005 (0.0007) | 0.0005 (0.0006) |
| 素の CLIPTextEncode のみ | 7 | 0.0098 (0.0197) | 0.0104 (0.0203) | 0.0183 (0.0291) | 0.0192 (0.0301) |
| JPS 連結 + Efficient Loader | 27 | 0.0333 (0.0712) | 0.0307 (0.0698) | 0.0448 (0.0754) | 0.0461 (0.0718) |

所見:

- 空メタデータはタイマー分解能近辺で、変更前後の差は誤差。
- 素の CLIPTextEncode 経路は表引き（`Map.get`）が増えるが、±2% 以内で実質同等。
- 縮約フィクスチャは走査打ち切り（未解決ポートで探索を止める）により約10%改善。
- ランツー間のばらつきは概ね ±15% のため、この範囲は「回帰なし」と判断。

## 5. 回帰テスト

`node --test tests/metadata/*.test.cjs` → **175 pass / 0 fail**（既存165 + 新規10）。

新規ファイル:

- `tests/metadata/fixtures/comfyui_prompt_fixtures.cjs`
  - `A1111_PARAMETERS` / `A1111_EXPECTED`（実画像と同じ構造、本文は無害化）
  - `emptyMetadata()`
  - `plainClipTextEncodeMetadata()`（7ノード、素の正常系）
  - `jpsEfficientLoaderMetadata()`（実画像の縮約27ノード。JPS連結 + Efficient Loader + SD Prompt Reader + parameters）
  - `efficientLoaderSlotMetadata()`（正負入れ替わり再現用の合成5ノード）
  - `structuredParametersMetadata()`（JSON parameters の負例）
- `tests/metadata/comfyui_prompt_fallback.test.cjs`（10ケース）
  1. グラフ0件のときだけ fallback が立つ
  2. fallback セクションの由来表示と読み取り専用
  3. グラフにプロンプトがあれば fallback しない
  4. JSON parameters では fallback しない
  5. 入れ替わりケースで誤ラベルせず `unconnected` に落ちる
  6. 宣言済み `CONDITIONING+/-` 出力は正しい側に解決する
  7. 表に1件登録するだけで新ノード型が解決できる（`reset` で組み込み復元）
  8. 未登録ノード型は推測しない
  9. `TextEncode` 名を持つ互換ノードは従来どおり解決する
  10. `parseA1111Parameters` の境界（JSON / マーカー無し / 負値無し）

計測スクリプト: `tests/perf/comfyui_prompt_cost.cjs`

## 6. 既知の制約と次段

- 解決器テーブルの中身は最小限。JPS / Impact / WAS / Easy-Use / Comfyroll 等の意味論は未登録のため、
  該当グラフは引き続き「グラフから0件 → parameters フォールバック」で救済される
  （`TextEncode` 名を持つノードだけは互換シムで従来どおり解決）。
  テーブル定義（別途調査中）を差し込む際は `registerTextResolver` を呼ぶだけでよい。
- UI 形式のみの PNG（`prompt` チャンク無し）では `mode: 2/4`（mute/bypass）を見ていない。
  bypass 済み分岐のテキストを拾う可能性が残る。
- `extra.groupNodes`（サブグラフ）は展開していない。
- 旧形式 UI ワークフローで `widget` 名を持たないノードは、型ごとの `widgets` 定義が必要
  （JPS の `Text Prompt (JPS)` など）。
- `parameters` フォールバックは読み取り専用。編集・書き戻しは未対応。
- ノードカタログ（別AI調査）の反映は未着手。検証結果と P0 のデータ仕様は
  `docs/comfyui-text-node-catalog-verification.md` に記載。
- フォールバック条件は「positive/negative が双方0件」。片側だけ取れた場合は発動しない。

## 7. P0 適用後の再計測（2026-11-26）

P0（連結解決・wildcard `populated_text`・出力スロット表・汎用規則・LoRA 表）適用後に
同じスクリプトで再計測した。3回連続実行の中央値レンジを併記する。

| ケース | P0 前 `summarize` | P0 後 `summarize` | P0 前 `buildSections` | P0 後 `buildSections` |
| --- | --- | --- | --- | --- |
| メタデータ無し | 0.0005 | 0.0004–0.0005 | 0.0005 | 0.0005 |
| 素の CLIPTextEncode のみ (7) | 0.0098 | 0.0111–0.0113 | 0.0183 | 0.0204–0.0212 |
| JPS 連結 + Efficient Loader (27) | 0.0333 | 0.0455–0.0460 | 0.0448 | 0.0567–0.0571 |

解釈:

- 空メタデータは変化なし（±0.0001ms、タイマー分解能近辺）。
- 素の CLIPTextEncode 経路は **+14%**（絶対 +1.3µs/グラフ）。ノードごとの表引きと
  汎用規則の走査が増えた分で、以前に設定した ±15% の許容内。
  ホットパス最適化として、正規化時にノードへ resolver をキャッシュし、
  汎用規則のキー走査を1パスに変更した（初回計測は +42% だった）。
- 縮約フィクスチャ（JPS）は **+38%**（絶対 +13µs）。これは P0 で
  「4ノードを1本のプロンプトに合成し、LoRA を1件解決する」処理が新たに増えたため。
  同じ画像で以前は 0 件だったので、コスト増分に対する成果は妥当と判断。
- 参考: 10,000 枚処理した場合の増分は、素の経路で約 0.013 秒、JPS 経路で約 0.13 秒。

### 7.1 P0 で追加した負ケース対策（コストに効く順）

1. `NaN` / `Infinity` を含む API prompt の緩和パース（失敗時のみ発動、通常経路は
   `JSON.parse` 一発のまま）。
2. `mode: 2/4` ノードの正規化時除外（UI workflow の bypass 分岐を走査しない）。
3. ノード単位の resolver キャッシュ（`trim().toLowerCase()` + `Map.get` の繰り返しを排除）。
4. 汎用規則の1パス走査（`inputValue` をキー数だけ呼ばない）。

### 7.2 対象PNGの最終挙動

```
generator = ComfyUI
positive = 953 文字 / negative = 300 文字（JPS 連結 + Efficient Loader）
loras = 3件（Power Lora Loader の有効分のみ）
unconnected = 4件（未使用の JPS プロンプト3件と連結ノード1件）
parameters フォールバック = 発動せず
```

以前（フォールバックのみ実装時）は `parameters` 由来の 604/290 文字だった。
現在は実行グラフのプロンプトが優先され、`parameters` は他セクションに原文が残る。
