# Phase 6: 生成元解釈（InvokeAI / SwarmUI）

- 仕様書: `docs/261126_plan_refactoring.md` §9
- ブランチ: `phase/6-generators`
- 位置付け: P-4（positive 限定コスト）。取得コストへの影響なし

## 1. 実装した FR

| 要件 | 実装 |
|---|---|
| FR-GEN-01 | InvokeAI `invokeai_metadata` / 旧 `sd-metadata`、SwarmUI `sui_image_params` を検出し、prompt / negative / generation grid を表示用セクションへ振り分け |
| FR-GEN-02 | Fooocus / Easy Diffusion / Draw Things は実フィクスチャがないため追加しない |
| FR-GEN-03 | JSON パース失敗・想定外スキーマは例外にせず、既存の Other 表示へフォールバック |
| FR-GEN-04 | Midjourney / NovelAI / A1111 / ComfyUI の既存判定は変更しない。NovelAI の Description 単独判定禁止も維持 |

## 2. 対応した JSON

### InvokeAI

- `invokeai_metadata`
- `sd-metadata`（旧形式。`image` 配下の payload も許容）
- 主なキー:
  - `positive_prompt` / `prompt`
  - `negative_prompt`
  - `steps`, `cfg_scale`, `scheduler`, `seed`, `width`, `height`
  - `model.model_name` / `model`
- `invokeai_metadata` の中にさらに `invokeai_metadata` を持つ形も許容。

### SwarmUI

- `sui_image_params`
- 主なキー:
  - `prompt`
  - `negativeprompt` / `negative_prompt`
  - `steps`, `sampler`, `scheduler`, `cfgscale`, `seed`, `width`, `height`
  - `model`, `aspectratio`, `swarm_version`
  - `loras` + `loraweights`
- `sui_image_params` の中にさらに `sui_image_params` を持つ形も許容。

## 3. テスト

- `node --test tests/metadata/*.test.cjs`: **154 tests / 154 pass / 0 fail**
- 追加テスト `generator_sections_phase6.test.cjs`:
  - InvokeAI の検出・positive/negative・grid
  - InvokeAI 旧 `sd-metadata` と prompt fallback
  - SwarmUI の検出・positive/negative・grid・LoRA/version
  - 不正 JSON が例外にならず Other へ落ちること
  - 既存の Midjourney / NovelAI / A1111 / ComfyUI 判定が不変であること
- 変更 JS の `node --check`: OK

## 4. 手動確認

合成 PNG に `invokeai_metadata` / `sui_image_params` の tEXt を埋め込み、
ローカル HTTP 経由で unpacked 拡張に表示させた。

| ケース | 結果 |
|---|---|
| InvokeAI PNG | PASS。tooltip `InvokeAI`、Positive / Negative / Generation Grid を表示 |
| SwarmUI PNG | PASS。tooltip `SwarmUI`、Positive / Negative / Generation Grid を表示 |
| 実サンプル PNG | 未実施（ローカルに InvokeAI / SwarmUI の実サンプルなし） |

実サンプル不在のため、仕様書 §11.4 Phase 6 の「実サンプル」確認は未完了。
合成フィクスチャでの表示確認と自動テストは完了している。

## 5. 備考

- Phase 6 は任意フェーズであり、v2.0.0 への同梱を妨げない。
- 取得側（PNG tEXt 以外の形式への追加取得）は行っていない。
  InvokeAI / SwarmUI のキーは現行 PNG 経路で取得できる範囲に限る。
