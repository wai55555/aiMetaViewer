# Phase 5: Stealth 二段化と切り捨て

- 仕様書: `docs/261126_plan_refactoring.md` §7
- ブランチ: `phase/5-stealth`
- 基準: Phase 0 B-04、Phase 4 完了時点の scanner

## 1. 実装した FR

| 要件 | 実装 |
|---|---|
| FR-STL-01 | 第 1 段は `MAX_STEALTH_HEADER_ROWS`（160 行）までの署名判定。候補が rejected になった時点でその候補の画素処理を停止 |
| FR-STL-02 | 署名 matched の候補だけがペイロード読み取りの全展開を継続 |
| FR-STL-03 | tEXt / iTXt / zTXt / eXIf で通常メタデータが確定した場合、Stealth 候補を作らず、IDAT はフレーミング + CRC のみ |
| FR-STL-04 | 通常メタデータなしで全候補が rejected になった場合、残りの IDAT はフレーミング + CRC のみ。後続チャンクの検出は継続 |
| FR-STL-04b | zlib 展開検証を落とす 3 ケースを明示: (i) 通常メタデータ確定、(ii) 候補 rejected、(iii) 候補を作らない（対象外レイアウト / インターレース / 画素上限超過） |
| FR-STL-05 | 画素数 **33,554,432（2^25）** 超では候補を作らず、`unsupported-stealth` 診断を残してテキスト検出のみ継続 |
| FR-STL-06 | `MAX_DECODED_BYTES` 512MB はデコード経路の安全弁として維持 |
| FR-STL-07 | `PNG_SCANNER_CACHE_VERSION` を `png-scanner-v4` へ更新 |

## 2. 挙動の変化（FR-STL-04b）

| ケース | zlib 破損のみ | chunk CRC 不一致 |
|---|---|---|
| 通常メタデータ確定 | IEND 到達なら `normal`（メタデータあり） | `invalid-png` |
| Stealth 候補 rejected | IEND 到達なら `not-found`（empty-confirmed） | `invalid-png` |
| 候補を作らない（対象外/上限超過） | IEND 到達なら `not-found`（empty-confirmed） | `invalid-png` |

- chunk CRC（圧縮バイト列に対する検証）は 3 ケースとも従来どおり行う。
- 通常メタデータあり + zlib 破損は「メタデータあり」として返る。
- 候補なし + zlib 破損は negative cache（empty-confirmed）の対象になり得る。
  これは意図したトレードオフであり、`png-scanner-v4` で旧キャッシュを無効化する。

## 3. 決定ゲート（33.5MP）

Phase 0 B-06 の実測:

| 実例 | 画素数 |
|---|---:|
| `test_clean.png` | 1,011,712 |
| `149017640_p0.png` | 1,048,576 |
| `test2_clean_1.png` | 1,572,864 |

- 最小 0.965MP、最大 1.500MP。
- 上限 33,554,432 画素に対し、最大実例でも約 21.3 倍の余裕がある。
- 4K（約 8.3MP）も上限内。
- 実例が上限に近くないため、上限値の変更は行わず **33.5MP を採用**する。
- B-06 は 3 例のみであり、上限付近の実例がない点は Phase 5 の既知の制約として残す。

## 4. 性能（Phase 0 B-04 比較）

`tests/phase0/measure_baseline.cjs` の scanner 単体測定（新規プロファイル、
6 run、初回破棄、5 run 中央値）。

| ケース | Phase 0 | Phase 5 | 改善 |
|---|---:|---:|---:|
| 4096² / メタデータなし | 625.938 ms | **180.844 ms** | -445.094 ms |
| 4096² / tEXt 前 | 464.359 ms | **0.320 ms** | -464.039 ms |
| 4096² / tEXt 後 | 624.085 ms | **178.350 ms** | -445.735 ms |
| 1024² / Stealth あり | 75.411 ms | **74.082 ms** | -1.329 ms |

- 通常メタデータが IDAT より前にある場合、IDAT の zlib 展開を行わないため
  0.3ms 級になる。
- メタデータなし / IDAT 後メタデータでも、Stealth 候補 rejected 後に
  IDAT デコードを打ち切るため約 180ms まで短縮。
- matched Stealth は従来どおり全展開するため 74ms で横ばい。

## 5. テスト

- `node --test tests/metadata/*.test.cjs`: **149 tests / 149 pass / 0 fail**
- 追加テスト `png_stealth_phase5.test.cjs`:
  - rejected 後の `decodedRows <= 160`
  - matched Stealth の検出維持
  - 通常メタデータ + 不正 zlib で `normal`
  - rejected + 不正 zlib で `not-found`
  - 対象外レイアウト / 33.5MP 超で inflate しないこと
  - 3 ケースすべてで chunk CRC 不一致が `invalid-png`
  - `MAX_STEALTH_PIXELS` / `MAX_STEALTH_HEADER_ROWS` / `MAX_DECODED_BYTES` の維持
- 変更 JS の `node --check`: OK

## 6. 手動確認

| §11.4 Phase 5 項目 | 結果 |
|---|---|
| 大容量 PNG のページでバッジ判定が体感で速くなること | scanner 実測で 625.938 → 180.844 ms（4K / メタデータなし）。ブラウザの体感時間は未計測 |
| Stealth 実例で従来どおり検出できること | `149017640_p0.png` / `test_clean.png` / `test2_clean_1.png` の 3 例で `status=stealth` を確認 |

ブラウザ上の 4K 体感時間は、Phase 6 の通し確認時に再確認する。
