# テキストノードカタログ 検証レポート（一次情報との突き合わせ）

- 対象資料: `.pi-web/uploads/mwxfk9mv-1-comfyui-text-node-catalog.md`（2026-11-26 受領）
- 検証日: 2026-11-26
- 検証環境: 各パックのリポジトリを shallow clone し、`INPUT_TYPES` / `define_schema` / `NODE_CLASS_MAPPINGS` /
  `RETURN_TYPES` / `RETURN_NAMES` を直接確認（`/tmp/noderef`）。併せて対象PNGの
  `extra.node_versions` に記録されたバージョン（comfy-core 0.3.13 ほか）を優先して読んだ。
- 実装側: `extension/comfyui_parser.js` の `TEXT_RESOLVERS`

## 0. 結論

カタログは**構造・役割分類・実装順序の提案として妥当**で、そのまま実装の設計図に使える。
ただし `class_type` の綴りに実装を壊す誤りが3点、記述が古いものが1点、欠落が1点あった。
本レポートの「訂正」を反映した上で採用する。**役割決定の規則（§0.3）と負ケースコスト（§0.6）は
現行実装の方針と一致**しており、追加の設計変更は不要。

| 判定 | 件数 | 内容 |
| --- | --- | --- |
| 一致（一次情報で確認） | 22 | core / Impact / rgthree / JPS / WAS / receyuki / pysssss / Fizz / Efficiency / Easy-Use |
| 訂正が必要 | 4 | §1 参照（うち2件は実装バグになる） |
| 記述が古い | 1 | WAS `Text Concatenate` の入力数 |
| カタログに欠落 | 1 | Efficiency `LoRA Stacker`（対象PNGで実際に使用） |
| 未検証のまま | カタログ §7 の残り | PromptControl 系、Crystools、Comfyroll、AlekPet 翻訳、LLM 系など |

## 1. 訂正（実装に影響する順）

### 1.1 Inspire の class_type は ` //Inspire` であって `-Inspire` ではない（重要）

カタログ §3.2 / §7 は `PromptBuilder-Inspire` と書いているが、実コードの
`NODE_CLASS_MAPPINGS`（`inspire/prompt_support.py`）は次のとおり。

```
"ZipPrompt //Inspire"                    : ZipPrompt
"UnzipPrompt //Inspire"                  : UnzipPrompt
"WildcardEncode //Inspire"               : WildcardEncodeInspire
"PromptBuilder //Inspire"                : PromptBuilder
"CLIPTextEncodeWithWeight //Inspire"     : CLIPTextEncodeWithWeight
"MakeBasicPipe //Inspire"                : MakeBasicPipe
```

`-Inspire` で実装すると**全ノードが一致せず無言で0件**になる。表示名は `(Inspire)` 形式だが、
`class_type` は `//Inspire`。本件は既に実装側の表を修正済み（§4）。

### 1.2 essentials の SDXL エンコーダは `CLIPTextEncodeSDXL+`

カタログ §3.3 は `CLIPTextEncodeSDXL+`（PARTIAL）としている。実コードは

```
conditioning.py: class CLIPTextEncodeSDXLSimplified
conditioning.py: "CLIPTextEncodeSDXL+": CLIPTextEncodeSDXLSimplified
```

であり、`class_type` は `CLIPTextEncodeSDXL+`。**Python クラス名を表に入れると一致しない**
（カタログ §0.2 の罠そのもの）。入力は単一 `text`（core SDXL の `text_g`/`text_l` を探さない）で一致。

### 1.3 WAS `Text Concatenate` の入力は `text_a`..`text_x`（最大24）

カタログ §3.5 は `text_a`..`text_d` としているが、これは旧版。現行 v3 の
`nodes/text/text_concatenate.py` は `text_a`..`text_x` の24入力＋
`delimiter`（既定 `", "`）＋`clean_whitespace`（既定 True）。「両形状を受ける」という
カタログの助言自体は正しいので、実装は**接頭辞 `text_` + 1文字の可変長**として扱うのが安全。

### 1.4 Efficiency `Eff. Loader SDXL` の class_type が確定（UNVERIFIED 解消）

カタログは「SDXL 版の class_type 文字列が未確認」としていたが、`NODE_CLASS_MAPPINGS` で確認。

```
"Efficient Loader"        : TSC_EfficientLoader      -> return 0 MODEL, 1 CONDITIONING+, 2 CONDITIONING-, 3 LATENT, 4 VAE, 5 CLIP, 6 DEPENDENCIES
"Eff. Loader SDXL"        : TSC_EfficientLoaderSDXL  -> return 0 SDXL_TUPLE, 1 LATENT, 2 VAE, 3 DEPENDENCIES
"KSampler (Efficient)"    : TSC_KSampler             -> return 0 MODEL, 1 CONDITIONING+, 2 CONDITIONING-, 3 LATENT, 4 VAE, 5 IMAGE
"LoRA Stacker"            : TSC_LoRA_Stacker
```

重要な含意: **SDXL 版には pos/neg スロットが無い**（`SDXL_TUPLE` に束ねられる）。
したがってカタログ §6 P0 の「Efficient Loader のスロット表」は非 SDXL 版にのみ適用し、
SDXL 版は `SDXL_TUPLE` を展開する `Unpack SDXL Tuple` 側で解決する必要がある。
「SDXL 版の規則は出荷しない」というカタログの判断は妥当だが、理由は「未確認」ではなく
「スロットが存在しない」である。

### 1.5 カタログ欠落: Efficiency `LoRA Stacker`

対象PNGの `workflow` に `LoRA Stacker` が存在する（node 340, mode 4）。スキーマは確認済み。

```
inputs: input_mode(simple|advanced), lora_count(0-50),
        lora_name_{1..50}, lora_wt_{i}, model_str_{i}, clip_str_{i}, lora_stack(optional)
return: LORA_STACK
```

`lora_count` の範囲だけを走査し、`lora_name_i != "None"` を採用する（catalog §3.10 の
Easy-Use `easy loraStack` と同じ規則）。rgthree 系だけ実装すると、この画像の
LoRA は引き続き0件になる。

## 2. 一致を確認した主要項目（抜粋）

| カタログの主張 | 確認結果 |
| --- | --- |
| `PrimitiveString` / `PrimitiveStringMultiline` のキーは `value` | ✔ `nodes_primitive.py`（node_id も同名） |
| core `StringConcatenate` は `string_a`, `string_b`, `delimiter`（既定 ""） | ✔ `comfy_extras/nodes_string.py` |
| core に `StringReplace` / `StringSubstring` / `RegexMatch` 等がある | ✔ 同ファイル |
| `PreviewAny` の入力は `source`、出力 STRING、OUTPUT_NODE | ✔ `nodes_preview_any.py` |
| `ConditioningZeroOut` / `ConditioningConcat` / `ConditioningCombine` / `ConditioningAverage` が core にある | ✔ `nodes.py` |
| core に `ShowText` というノードは無い | ✔（`PreviewAny` のみ） |
| `CLIPTextEncodeSDXL` は g/l を連結しない（g を符号化し l ストリームを上書き） | ✔ `execute()` が `tokens["l"] = ...` で上書き |
| `CLIPTextEncodeSDXLRefiner` の入力は `text`（`text_g`/`text_l` ではない） | ✔ widget 順は `ascore, width, height, text` |
| `CLIPTextEncodeFlux` = `clip_l`, `t5xxl` / `CLIPTextEncodeSD3` = `clip_l`, `clip_g`, `t5xxl` | ✔ |
| `ImpactWildcardProcessor` は `wildcard_text` + `populated_text` + mode/seed、出力名 `processed text` | ✔ `modules/impact/impact_pack.py` |
| `ImpactWildcardEncode` 出力 = MODEL, CLIP, CONDITIONING, populated_text | ✔ RETURN_NAMES 一致 |
| `ImpactSwitch` の `select` は1始まり（既定1）、`sel_mode` で実行時決定、動的入力 `input1..N` | ✔ `_SwitchInputs` + `check_lazy_status` が `input{select}` |
| `ImpactConcatConditionings` / `ImpactCombineConditionings` / `ImpactNegativeConditioningPlaceholder` が実在 | ✔ `__init__.py` のマッピング |
| rgthree は class_type に ` (rgthree)` を付ける | ✔ `py/constants.py: get_name()` |
| `Power Prompt (rgthree)` の入力 `prompt`、出力に CONDITIONING と TEXT | ✔ `py/power_prompt.py` |
| `Lora Loader Stack (rgthree)` は `lora_01`/`strength_01` … `lora_04` | ✔ `py/lora_stack.py` |
| `Power Lora Loader (rgthree)` の値は `{on, lora, strength, strengthTwo}`、`lora_N` は上限なし | ✔ `src_web/comfyui/power_lora_loader.ts` |
| `easy fullLoader` の slot4/5 が positive/negative、入力 `positive`/`negative` は STRING | ✔ `py/nodes/loaders.py` RETURN_NAMES |
| `easy positive` / `easy negative` は class_type そのもの、入力キーも同名 | ✔ `py/nodes/prompt.py`（node_id=`easy positive`） |
| `SDPromptReader` の slot2/3 = POSITIVE/NEGATIVE、slot11 = SETTINGS | ✔ `nodes.py` RETURN_NAMES |
| `SDPromptSaver` の入力 `positive`/`negative`、出力 METADATA | ✔ |
| `JPS` `Text Concatenate (JPS)` は `delimiter`（none/space/comma）+ `text1..5` | ✔ `jps_nodes.py`。`text1` は `forceInput`（リンク専用） |
| `JPS` `Text Prompt (JPS)` / `Text Prompt Combo (JPS)` のキーと出力 | ✔ `text` / `pos`,`neg` |
| WAS `CLIPTextEncode (NSP)` の出力 slot1 は parsed_text（JSON に残らない） | ✔ さらに **slot2 = raw_text**（原文）がある |
| `StringFunction|pysssss` は `action`, `tidy_tags`, `text_a..text_c` | ✔ |
| `ShowText|pysssss` は forceInput で、保存時 `widgets_values` に1要素リストを書く | ✔ `py/show_text.py` が `node["widgets_values"] = [text]` |
| FizzNodes `BatchPromptSchedule` は POS/NEG、`--neg` で分割、`pre_text`/`app_text` は forceInput | ✔ `ScheduledNodes.py` / `BatchFuncs.py` |
| Derfuu の入力キーは `Text`（大文字）で `DF_Text` / `DF_Text_Box` | ✔ `pyscripts/Nodes/Custom/Types.py`, `utility/mapping_replace.py` |
| Inspire `UnzipPrompt` の出力は positive, negative, name | ✔ |

## 3. カタログ記述の微修正（実装判断に影響しない範囲）

- §3.3 の `CLIPTextEncodeSDXL`「一致すれば1回だけ、違えば G/L を分けて出す」は表示仕様として妥当。
  現行実装は `'\n'` 連結なので、**ラベル付き結合**（`G: ...\nL: ...`）または一致時のみ単一出力に
  変えるかは UI 判断。データ上は両フィールドを持つべき。
- §3.5 の `JoinStrings`（KJNodes）「trim しない」は実装上そのまま結合でよく、`delimiter` 既定は `' '`。
- §3.6 の rgthree `Context Big` の `text_pos_g` 等は Python 側で確認できるが、
  入力名が動的（`Context` の `base_ctx` 連鎖）なので、**UI の `outputs[].name` 優先**という
  §0.3 の原則をそのまま適用するのが安全。
- §3.8 の Impact `populated_text` 規則は本カタログ最大の実利という評価に同意。
  `mode` が `populate` で保存された場合も populated_text が実エンコード対象なので、
  「populated_text 非空なら優先」で正しい（`fixed` でも同じ）。

## 4. 実装側に反映した修正（今回）

`extension/comfyui_parser.js` の組み込み表:

| 修正前 | 修正後 | 理由 |
| --- | --- | --- |
| `CLIPTextEncodeWithWeight` | `CLIPTextEncodeWithWeight //Inspire` | §1.1 |
| `CLIPTextEncodeSDXLSimplified` | `CLIPTextEncodeSDXL+` | §1.2 |
| `AdvancedCLIPTextEncode` | 削除 | Efficiency の `NODE_CLASS_MAPPINGS` に存在せず、内部利用のみ。表に置くと死にエントリ |

回帰テスト追加: `tests/metadata/comfyui_prompt_fallback.test.cjs`
「table keys are class_type strings, not Python class names」で
`//Inspire` と `CLIPTextEncodeSDXL+` を解決し、Python クラス名が
positive/negative に昇格しないことを確認。**176 pass / 0 fail**。

## 5. 次段（P0）に必要なデータ仕様（実装は承認後）

カタログ §6 の P0 のうち、現行スケルトンに**データ追加だけで**載るもの／コード追加が要るものを切り分ける。

### 5.1 データ追加だけで載る（`registerTextResolver` の `fields`）

| class_type | fields | join | 備考 |
| --- | --- | --- | --- |
| `PrimitiveString` / `PrimitiveStringMultiline` | `value` | – | core 既定の置き場 |
| `Text Prompt (JPS)` | `text` | – | |
| `Text Multiline` / `Text String`（WAS） | `text` | – | |
| `StringConstant` / `StringConstantMultiline`（KJ） | `string` | – | 後者は改行除去に注意 |
| `DF_Text` / `DF_Text_Box` | `Text` | – | 大文字キー |
| `Power Prompt (rgthree)` | `prompt` | – | LoRA 抽出は別 |
| `Power Prompt - Simple (rgthree)` | `prompt` | – | |
| `SDXL Power Prompt - Positive (rgthree)` | `prompt_g`, `prompt_l` | – | 連結しない（ラベル付き） |
| `SDXL Power Prompt - Negative (rgthree)` | `prompt_g`, `prompt_l` | – | 正式名に `/ Negative` |
| `CR Prompt Text` | `prompt` | – | 未検証 → 保留 |
| `PromptBuilder //Inspire` | `text` | – | |
| `CLIPTextEncode (NSP)`（WAS） | `text` | – | 原文＋unexpanded フラグ。`raw_text` は出力側 |
| `Text to Conditioning`（WAS） | `text` | – | |
| `ImpactWildcardProcessor` | `populated_text` → 空なら `wildcard_text` | – | **条件分岐が要る**（§5.2） |
| `ImpactWildcardEncode` | 同上 | – | 同上 |

### 5.2 コード追加が要るもの（スケルトンの拡張点）

1. **フォールバック順序付き fields**（Impact `populated_text` 優先）: 現行 `fields` は
   「全フィールドを結合」なので、`prefer`（最初の非空のみ採用）モードが必要。
   表に `prefer: true` を追加するだけで済む（走査コードは変更不要）。
2. **連結ノード**（JPS / core `StringConcatenate` / KJ `JoinStrings` / WAS `Text Concatenate`）:
   `role: 'concat'` と `inputs: 'text1..5'` / `prefix: 'text_'` / `delimiter` の解釈規則が必要。
   `delimiter` の値（`comma`/`space`/`none`/自由文字列）の対応表も表データで持つ。
3. **スロット意味論表**（`Efficient Loader` / `easy fullLoader` / `UnpackPrompt //Inspire`）:
   カタログ §0.3 のとおり、**API 形式はスキーマ表、UI 形式は `outputs[].name` 優先**。
   `Efficient Loader` は 1=positive, 2=negative を表で確定できる（§1.4）。
4. **汎用フォールバック規則 §4**（未知ノードでも `text` 等の既知キー → STRING 消費先なら採用）:
   これは表ではなくコード側の規則。誤検出を避けるため「既知の消費先へリンクしている」条件が必須。
5. **`external` / `unexpanded` / `generated` の区別**: 現行 `summarize()` の戻り値に
   `notes: [{kind, label, detail}]` を足す形が最小（`unconnected` の拡張）。

### 5.3 P0 の回帰フィクスチャ（追加予定）

- JPS 連結 + Efficient Loader（既存 §5.1 の縮約フィクスチャを、期待値「positive に3ノード分が
  `, ` で結合」「negative はノード4のリテラル」に更新）
- Impact `populated_text` 優先（`wildcard_text` と `populated_text` を別値にして populated を採用）
- `Efficient Loader` API 形式（slot1/slot2 の正負が入れ替わらない）
- 未知ノードの汎用規則（`text` → CLIPTextEncode のリンクで採用、非リンクは不採用）

## 6. 未検証として残るもの

カタログ §7 のうち、今回潰したのは「`Eff. Loader SDXL` の class_type」「Inspire の接尾辞」
「JPS Text Concatenate の delimiter」「WAS Text Concatenate のキー」。
残りは未確認のため**実装しない**方針を維持する。

- PromptControl（`PCTextEncode`, `PCLazyTextEncode`, `PCLazyLoraLoader`）
- Crystools（`Primitive string [Crystools]`, `Show any [Crystools]`）
- Comfyroll（`CR Prompt Text` ほか）
- AlekPet 翻訳群の個別キー
- LLM Party / core `TextGenerate` / LLaVA 系
- Derfuu `DF_String_Concatenate` の delimiter キー
- `StringToFloatList` / `SaveStringKJ`
- Deforum の Prompt Schedule（`PromptSchedule` と衝突）

## 7. カタログの品質所見

- 役割（positive/negative）を「消費者側の入力キーで決める」とした §0.3 は、現行実装の
  `portName` 伝播と同じ結論で、そのまま採用できる。
- 「並び順推測の禁止」を明記している点が本件の再発防止に効く。
- 検証レベル4段階（SOURCE / 実プロンプト / DOC/REGISTRY / UNVERIFIED）は、
  実装可否のゲートとして機能する。今回の訂正4件はすべて「REGISTRY/DOC 由来の綴り」だった。
  **`class_type` は必ず `NODE_CLASS_MAPPINGS` のキーで確認する**、を運用ルールに追加すべき。
- 欠落は「通過対応」と分類されたパックの周辺（Efficiency の LoRA Stacker）に出やすい。
  対象PNGの `extra.node_versions` を使えば、その画像で使われたパックを漏れなく
  チェックリスト化できる（今回それで1件見つかった）。

## 8. P0 実装結果（2026-11-26）

カタログ §6 の P0 を実装した。対象はカタログ P0 の 1〜2 と、ユーザー指定で追加した
Efficiency `LoRA Stacker`。作業ブランチ `comfyui-prompt-fallback`（worktree
`/mnt/c/github/aimetaviewer-comfyui-params`）。

### 8.1 実装したデータ表

| 分類 | 件数 | 代表 |
| --- | --- | --- |
| エンコーダ（役割は消費者が決める） | 12 | `CLIPTextEncode`, `CLIPTextEncodeSDXL`(g/l), `CLIPTextEncodeFlux`, `CLIPTextEncodeSD3`, `smZ CLIPTextEncode`, `CLIPTextEncode (NSP)`, `Text to Conditioning`, `CLIPTextEncodeSDXL+`, `CLIPTextEncodeWithWeight //Inspire` |
| 純 STRING 保持者 | 13 | `PrimitiveString`(`value`), `Text Prompt (JPS)`, `StringConstant`, `DF_Text`(`Text`), rgthree Power Prompt 群, `PromptBuilder //Inspire` |
| Wildcard（`prefer` = 展開結果優先） | 3 | `ImpactWildcardProcessor`, `ImpactWildcardEncode`, `WildcardEncode //Inspire` |
| 連結（`role: concat`） | 6 | `Text Concatenate (JPS)`(named delimiter), `StringConcatenate`, `JoinStrings`, `JoinStringMulti`, WAS `Text Concatenate`(text_a..x), `SDPromptMerger` |
| 出力スロット表（API形式） | 2 | `Efficient Loader`(1=+,2=−), `easy fullLoader`(4=+,5=−) |
| LoRA 表 | 3 | `Power Lora Loader (rgthree)`, `Lora Loader Stack (rgthree)`, `LoRA Stacker`(Efficiency) |

連結は「宣言順・そのノード自身の delimiter」で解決する。`delimiter` は trim しない
（`' + '` のような前後空白付きの指定を保つ）。named delimiter
（`none`/`space`/`comma`/`newline`）だけ対応表を通す。

### 8.2 汎用フォールバック（カタログ §4.1 / §4.4）

- 未登録ノードが `text` / `prompt` / `value` / `string` のリテラルを持つ場合、**既知の消費者から
  辿り着いたときだけ**テキスト源として採用する（表にないノードは推測しない、は維持）。
- 数値・真偽値（`1.5`, `true`）はプロンプトとみなさない。
  対象PNGでは `DF_Float` / `JWFloat` の `value: 1.5` が誤って unconnected に出るのを防いだ。
- 役割が決まらないテキストは従来どおり `unconnected`。

### 8.3 発見1: ComfyUI の API prompt は素の `NaN` を含みうる（重要）

対象PNGの `prompt` チャンクは **JSON として不正**だった。

```
"inputs": { "a": NaN, ... }        // MathExpression / Random Number の評価結果
JSON.parse -> Unexpected token 'N'
```

Python の `json.dumps` は既定で `NaN` / `Infinity` / `-Infinity` をそのまま書くため、
ComfyUI の API prompt は仕様外 JSON になりうる。JS の `JSON.parse` はこれを拒否するので、
**グラフ全体が捨てられていた**（P0 のノード対応を入れても、この画像では効かなかった）。
`parseJson()` に文字列リテラルを壊さない緩和パーサを追加し、`NaN`/`±Infinity` を `null`
として読むようにした。文字列内の `"NaN"` はそのまま保持する。

### 8.4 発見2: UI workflow の bypass/mute を無視するとノイズになる

対象PNGの `workflow` は142ノード中 **88ノードが `mode: 4`（bypass）**。プロンプトや LoRA の
多くは bypass 済みの分岐に残っており、`mode` を見ないと
「実行されていないプロンプト／LoRA」を拾う。`mode: 2`（mute）と `mode: 4`（bypass）の
ノードは正規化時に除外した。API prompt がある画像では API prompt が実行済みグラフなので、
workflow 側は補助（モデル名など）に留まる。

### 8.5 対象PNGの最終結果

```
generator = ComfyUI
positive  = 953 文字（13 + 187 + 190 populated_text を ", " で結合。node 5 の JPS 連結）
negative  = 300 文字（node 4）
unconnected = 4件（実行グラフ上で未使用の Text Prompt (JPS) ×3 と その連結ノード）
loras = 3件（Power Lora Loader の on:true のみ。old regex では 0 件だった）
parameters フォールバック = 発動せず（グラフから正負が取れたため）
```

### 8.6 P0 で実装しなかったもの（次段）

- `ZipPrompt //Inspire` → `UnzipPrompt //Inspire` のペア解決:
  slot0/1 が pos/neg なのは確認済みだが、zip 側が2つのテキストを保持するため
  「ペア保持ノード」の役割が必要。表だけでは解決できないので実装を見送った
  （出力スロット表からも削除し、誤解を招くエントリを残さない）。
- `Text Prompt Combo (JPS)`（`pos`/`neg` を同時に持つ役割固定ノード）: 同上。
- `UltimateSDUpscale` を独立アンカーとして扱い、アップスケール工程の正負を分離 reporting する件。
- `external` / `unexpanded` / `generated` の注記（カタログ §3.9 / §3.11 相当、P2）。
- PromptControl / Crystools / Comfyroll / AlekPet 翻訳 / LLM 系（未検証のまま）。

### 8.7 テスト

`node --test tests/metadata/*.test.cjs` → **193 pass / 0 fail**。
P0 用に `tests/metadata/comfyui_prompt_resolution.test.cjs`（16ケース）を追加:
JPS連結、wildcard の populated 優先、連結4形状と delimiter、`easy fullLoader` スロット、
LoRA 3種と除外規則、汎用規則、NaN/Infinity 耐性、mode 2/4 除外、数値 widget の除外、
複数出力間の LoRA 重複排除。
