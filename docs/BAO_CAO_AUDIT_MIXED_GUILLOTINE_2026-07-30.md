# Báo cáo audit — Bình cắt xén, dàn nhiều mẫu KHÁC kích thước (`mixed_guillotine`)

Ngày: 2026-07-30 · Phạm vi: solver `mixed_guillotine` + adapter + 2 điểm tích hợp (preview `/preview-layout`, export `nup_engine`) + tầng vẽ dấu xén.
Trạng thái: **mới khảo sát, CHƯA sửa gì.** Baseline: 39 test backend hiện có PASS.

> ## ⚠️ Bản sửa 2026-07-30 (lần 2) — §MG-A1 và §MG-A3 đã bị BÁC BỎ
>
> Bản đầu của báo cáo này kết luận sai hai phát hiện. Nguyên nhân: `nup_process_chunk` có **hai** đường vẽ dấu xén, tôi chỉ đo một.
>
> ```python
> if not is_die_cut and (mark_type == 'guillotine' or mark_type == 'corners'):
>     mark_segs = _native.compute_mark_coords(placements, mark_type, ...)   # ← ĐƯỜNG BỎ SÓT
> if sheet_idx in chunk_cluster_tile_cuts:
>     draw_tile_cut_marks(...)                                              # ← đường đã đo
> ```
>
> `markType` mặc định là `'guillotine'` ([marksSlice.ts:50](../desktop/src/components/imposition-tools/store/slices/marksSlice.ts#L50)) và mixed không phải die-cut → **đường Rust có chạy**. Nó gom mép trim theo `(cluster_idx, block_id)` = `(zone, sản phẩm)` rồi vẽ tick tại **mọi** mép cột/hàng, đặt ngoài bbox từng zone — đúng cách `drawDynamicTrimMarks` của script Illustrator làm.
>
> Đo lại bằng cách gọi thật hàm Rust trên đúng placements của mixed (`probe_marks_union.py`), 4 ca × mọi mặt:
>
> ```
> mark_type='guillotine' (mặc định):  mép trim THIẾU dấu: x=0 y=0   ← mọi ca, không thiếu mép nào
> ```
>
> - **§MG-A1 hạ P0 → P2.** Không thiếu dấu. Phần còn đúng: đường tile sinh thêm 2–6 toạ độ mỗi mặt không trùng mép thành phẩm — nhưng phần lớn trong đó **hợp lý** (biên zone = nhát dao tách dải; mép `usableRect` = nhát xén mép tờ). Xem §MG-A1 đã viết lại.
> - **§MG-A3 bác bỏ.** Export vẽ 112 segment Rust + dấu tile, **nhiều hơn** preview (63 đường), không phải ít hơn.
>
> Ba phát hiện còn lại (**§MG-A2, §MG-B1, §MG-B2**) không bị ảnh hưởng vì đo trực tiếp từ hình học plan, không qua tầng vẽ dấu.
>
> Bài học: repo này có ghi chú sẵn *"Rust là source-of-truth trong bình bài — đọc Python suông đánh lừa, verify bằng số runtime"*. Tôi vẫn kết luận từ hàm Python `full_span_cut_coordinates`. Mọi phát hiện phải trả lời được "đường runtime thật chạy là gì, và tôi đã ĐO nó chưa".

## Tóm tắt điều hành

Kiến trúc solver đúng và chặt: cây cắt guillotine có validator fail-fast, plan hash, preview và export dùng **chung một** plan builder (SSOT thật). Hình học từng zone không sai. Dấu xén — sau khi đo đúng đường Rust — **phủ đủ 100% mép thành phẩm**.

**Sau 3 vòng kiểm chéo bằng số, chỉ còn MỘT vấn đề thật:**

**Sinh quá nhiều bản kẽm** (§MG-A2, P0 — mức **kinh tế**, không phải in hỏng). SL 5000/1000/200 → **6 bản kẽm**/41 tờ giấy, **4** bản chỉ chạy 1 tờ. Gốc: vòng lặp greedy trong `_build_templates` + ràng buộc "dư = 0" (đo: `excessQuantity == 0` ở 20/20 ca) đang bị test khoá. `exportUniqueSheets=True` **không** gộp — chỉ nén 41 tờ lặp thành 6 trang PDF, 6 `templateId` vẫn riêng biệt = 6 bộ kẽm phải làm.

Hình học thì **đúng**: cây cắt qua validator, số lượng chính xác, dấu xén phủ đủ 100% mép thành phẩm, đăng ký mặt sau sai số 0,00mm ở 12/12 cấu hình lề. Không có lỗi nào gây in hỏng.

### Bảng trạng thái sau 3 vòng kiểm chéo

| Mã | Ban đầu | Sau kiểm | Tình trạng |
|---|---|---|---|
| §MG-A2 | P0 | **P0** | **HOLDS** — tái hiện đúng mọi số. Tôi còn *nói giảm*: 4 bản chạy 1 tờ, không phải 3 |
| §MG-A1 | P0 | P2 | Đo sai đường vẽ dấu — Rust phủ đủ 35/35 mép |
| §MG-A3 | P1 | **bác bỏ** | Export vẽ nhiều hơn preview, không ít hơn |
| §MG-B1 | P1 | **bác bỏ**, P3 | Không phí giấy (160 vs 160 tem/tờ); căn giữa đang gánh đăng ký mặt sau duplex |
| §MG-B2 | P1 → P0 | **bác bỏ** | Lỗi hệ quy chiếu của tôi. Mirror tâm tờ là ĐÚNG và bắt buộc |

**4/5 phát hiện ban đầu sai.** Cả bốn cùng một kiểu lỗi: suy hậu quả từ hình học thay vì đo hậu quả. Ba lần liên tiếp bản sửa tôi đề xuất sẽ **gây hồi quy nặng hơn** thứ nó định sửa — A1: sửa thứ đã đúng; B1: phá đối xứng mép xén → 20/35 mép lệch; B2: phá chồng lưng 15–35mm + vi phạm nhíp 8/12. Xem ghi chú `feedback_measure_consequence_not_just_geometry`.

## Phương pháp

Đọc toàn bộ `mixed_guillotine.py` (1168 dòng), `mixed_guillotine_adapter.py`, 2 điểm tích hợp, `nup_process_chunk.py` (khâu bù xén), `nup_artwork.py` (`place_one_artwork`), `cluster_tile_engine.draw_tile_cut_marks`, `GridPreview.tsx`, `GridSettingsSection.tsx`, 6 file test.

Chạy 6 probe mô phỏng **đúng** đường đi runtime (`backend/scratch/probe_*.py`, chỉ đọc, có thể xóa sau) trên các ca thật của nhà in VN: tờ 79×109cm, name card 90×54 / 85×55 / 90×50mm, gripper 12mm, bleed 3mm. Trong đó `probe_rust_marks.py` và `probe_marks_union.py` gọi **thật** hàm Rust `pdfcompare_native.compute_mark_coords` — chính hai probe này lật lại kết luận §MG-A1/A3.

**Bài học phương pháp:** ba probe đầu chỉ mô phỏng phía Python nên bỏ sót đường vẽ dấu bên Rust. Với repo này, mọi phát hiện về bình bài phải đo **đường Rust**, vì đó là đường runtime duy nhất (xem ghi chú `rust-is-source-of-truth-binhbai`).

## Nhóm A — chặn phát hành

### ~~§MG-A1 · P0 · Thiếu dấu xén~~ → **P2 · Vài toạ độ dấu lạc trong lề** · effort S

**Phát biểu gốc SAI — giữ lại bên dưới để truy vết.** Kết luận đúng sau khi đo cả hai đường vẽ dấu:

Với `mark_type='guillotine'` (mặc định UI), đường Rust `compute_mark_coords` phủ **đủ mọi mép thành phẩm**, mọi ca đo đều `mép trim THIẾU dấu: x=0 y=0`. Không có lỗi thiếu dấu.

Phần còn đúng, mức P2: đường tile (`full_span_cut_coordinates` + phần thêm mép root ở [nup_engine.py:2432-2439](../backend/app/workers/nup_engine.py#L2432-L2439)) sinh thêm 2–6 toạ độ mỗi mặt **không trùng mép thành phẩm nào**. Đo (CA 1, mặt 0): `RAC ngang (mm): 10.0, 378.8, 736.6, 1078.0` — toàn bộ do đường tile sinh, Rust không sinh cái nào.

Nhưng xét ý nghĩa cắt thật thì phần lớn **hợp lý**:

| Toạ độ | Là gì | Có phải rác? |
|---|---|---|
| 378,8 / 736,6mm | biên giữa 2 zone | **Không** — đây là nhát dao tách dải zone, phải cắt |
| 10,0 / 1078,0mm | mép `usableRect` | **Không** — nhát xén mép tờ |
| 154,2 / 317,6mm (CA 2) | biên zone theo trục dọc | **Không** — tách dải zone |

Nên §MG-A1 rút lại chỉ còn: **dấu tại mép `usableRect` không trùng mép thành phẩm nên thợ có thể tưởng đó là đường xén thành phẩm** (lệch 7mm ở CA 1). Đây là nhiễu thẩm mỹ/gây nhầm, không mất dấu. Sửa (nếu muốn): bỏ phần `_face_cuts['v'].update({root.x, root.x+width})` ở nup_engine, để mép tờ do marks thường vẽ. Effort S, không gấp.

<details>
<summary>Phát biểu gốc (SAI) — click để xem</summary>

#### §MG-A1 · P0 · Thiếu dấu xén ở trục vuông góc hướng chia zone · effort M

`full_span_cut_coordinates` ([mixed_guillotine_adapter.py:227-234](../backend/app/workers/mixed_guillotine_adapter.py#L227-L234)) chỉ giữ đường cắt **chạy suốt chiều vùng khả dụng**:

```python
if axis == "x" and start <= min_y + 0.01 and end >= max_y - 0.01:
    vertical.add(...)
```

Đường cắt trong zone (`_tree_cut_lines` gán `start/end` = biên **zone**, không phải biên tờ — [mixed_guillotine.py:470-472](../backend/app/workers/mixed_guillotine.py#L470-L472)) bị loại sạch. Khi solver chia zone theo trục y (rất phổ biến — `horizontal_*` thắng ở phần lớn ca đo), **mọi** đường cắt dọc đều là cục bộ trong zone.

Đo thật (CA 1, 3 name card, tờ 790×1090, chia ngang):

```
tổng cutLines trong plan = 63
  dọc  (x): thẳng suốt tờ = 0, chỉ trong zone = 42
  ngang(y): thẳng suốt tờ = 21, chỉ trong zone = 0
→ dấu xén DỌC thực sự được vẽ: 10.0mm, 780.0mm  (2 dấu)
→ mép trim THỰC theo x: 35 giá trị
→ số mép trim CÓ dấu xén = 2/35   (THIẾU 33)
```

Nặng hơn: 2 dấu còn lại là mép `usableRect`, **không trùng mép thành phẩm nào**. Ca CA 2 mặt thứ 4: `số mép trim CÓ dấu xén = 0/24`, và probe báo `dấu xén DỌC KHÔNG trùng mép trim nào: 10.0mm, 780.0mm`. Thợ xén theo dấu → cắt lệch vào giấy trắng, name card đầu tiên mất một dải mép.

`nup_engine` có thêm mép root vào tập dấu ([nup_engine.py:2432-2439](../backend/app/workers/nup_engine.py#L2432-L2439)) nên `draw_tile_cut_marks` vượt được guard `len(v_cuts) < 2` ([cluster_tile_engine.py:636](../backend/app/workers/cluster_tile_engine.py#L636)) và **không** báo lỗi — hỏng âm thầm, không có cảnh báo nào tới user.

Hướng sửa: dấu xén phải vẽ theo `cutLines` **cục bộ từng zone** (mỗi zone là một khối xén riêng sau khi tách khỏi tờ), không lọc theo full-span. Cần một đường vẽ marks nhận segment có `start/end` thay vì chỉ nhận toạ độ.

*(Hết phần sai. Lỗi của phát biểu này: con số "2/35" là số dấu của RIÊNG đường tile, không phải tổng số dấu trên tờ. Đường Rust `compute_mark_coords` đã làm đúng việc "vẽ dấu cục bộ từng zone" mà phần "hướng sửa" trên đề nghị làm.)*

</details>

### §MG-A2 · P0 · Sinh nhiều bản kẽm thay vì 1 tờ mẫu chia tỉ lệ · effort L

`_build_templates` ([mixed_guillotine.py:832-886](../backend/app/workers/mixed_guillotine.py#L832-L886)) lặp: chọn candidate → in `bulk_runs` tờ → trừ `remaining` → **lặp lại với tập sản phẩm còn lại**. Sản phẩm nào hết SL trước thì vòng sau sinh **template mới** (= bản kẽm mới).

Đo thật:

| Ca | SL | Số bản kẽm | Tổng tờ |
|---|---|---|---|
| CA 1 | 1000 / 1000 / 1000 | **3** | 19 |
| CA 2 | 5000 / 1000 / 200 | **6** | 41 |
| CA 6 | 500 / 500 (210×297 + 55×85) | **3** | 50 |

Chi tiết CA 2 — 3 trong 6 bản kẽm chỉ chạy **1 tờ**:

```
T001 vertical_demand    runCount=18  [SP1x114, SP2x24, SP3x11]
T002 horizontal_demand  runCount=1   [SP1x126, SP2x28, SP3x2]
T003 horizontal_demand  runCount=19  [SP1x126, SP2x28]
T004 horizontal_demand  runCount=1   [SP1x154, SP2x8]
T005 vertical_equal     runCount=1   [SP1x154]
T006 vertical_equal     runCount=1   [SP1x120]
```

Ở VN bản kẽm là chi phí đáng kể nhất của bài in offset; 6 bộ kẽm cho 41 tờ giấy là vô lý về kinh tế. Mode `ratio_stack` cùng repo đã làm **đúng** và ghi rõ nguyên tắc ([nup_engine.py:3115-3118](../backend/app/workers/nup_engine.py#L3115-L3118)):

> mỗi mẫu chiếm số ô theo TỶ LỆ số lượng; MỌI tờ giống HỆT nhau (cùng vị trí ô = cùng mẫu xuyên cả chồng) → dao xén guillotine chém cả chồng ra mỗi xấp MỘT loại sạch.

Gốc của hành vi hiện tại là ràng buộc **dư = 0**, đang bị test khoá ([test_mixed_guillotine_solver.py:155-174](../backend/tests/test_mixed_guillotine_solver.py#L155-L174)): `excessQuantity == 0` và `len(templates) <= 4`. Để đạt đúng 1000 cái, solver buộc phải thêm template sửa số. Thực tế xưởng **chấp nhận bù trừ** (in 1050 lấy 1000) để đổi lấy 1 bản kẽm.

Lưu ý: `_score_candidate` đã có `estimated_runs` và `imbalance` ([mixed_guillotine.py:672-701](../backend/app/workers/mixed_guillotine.py#L672-L701)) nên đã đẩy về hướng cân tỉ lệ — nhưng vì `_build_templates` vẫn lặp tới khi `remaining` rỗng nên không chặn được việc sinh bản kẽm mới. Đây là quyết định **sản phẩm**, không chỉ là bug: cần chốt "1 bản kẽm + cho phép dư %" làm mặc định, có ô nhập ngưỡng dư cho phép.

Đối chiếu: cùng CA 1 nhưng `gap = 6mm` → chỉ còn **2** bản kẽm (T001 runCount=22, T002 runCount=1). Gap ảnh hưởng mạnh tới số bản kẽm — thêm bằng chứng rằng cơ chế hiện tại chưa ổn định theo tham số.

### ~~§MG-A3 · P1 · Preview vẽ đủ đường cắt, export chỉ vẽ một phần~~ → **BÁC BỎ**

Đo lại: export vẽ **112 segment** từ Rust `compute_mark_coords` cộng dấu của đường tile, so với 63 đường trong preview. Export vẽ **nhiều hơn** preview, không ít hơn. Phát hiện này sinh ra từ cùng lỗi của §MG-A1 (chỉ đếm đường tile).

Khác biệt còn lại giữa preview và export là **chủ đích**: preview vẽ đường liền suốt để user thấy cấu trúc chia zone; export vẽ tick ngắn ngoài mép để thợ ngắm dao. Hai cách trình bày khác nhau của cùng một tập đường cắt, không phải sai lệch.

<details>
<summary>Phát biểu gốc (SAI) — click để xem</summary>

#### §MG-A3 · P1 · Preview vẽ đủ đường cắt, export chỉ vẽ một phần · effort S

Preview trả `cutSegments` = **toàn bộ** `cutLines` của plan ([imposition.py:1821](../backend/app/api/routes/imposition.py#L1821)); `GridPreview.tsx` khi có `cutSegments` thì vẽ hết và **bỏ** đường legacy ([GridPreview.tsx:1831-1832](../desktop/src/components/imposition-tools/sections/GridPreview.tsx#L1831-L1832)):

```ts
const cutVpx = cutSegmentsPx.length === 0 ? (_cutLines?.v || []).map(...) : [];
```

Export lại đi qua bộ lọc full-span của §MG-A1. Đo thật: `preview vẽ 63 đường, export vẽ 23 dấu xén` (CA 1) — chênh tới 89 vs 22 ở CA 3. Vá §MG-A1 thì mục này tự đóng phần lớn; vẫn nên thêm test chốt "số dấu xén export == số đường cắt preview".

*(Hết phần sai. "23 dấu xén" chỉ đếm đường tile; đường Rust vẽ thêm 112 segment nữa.)*

</details>

## Nhóm B — sai so với thực tế bình bài

### ~~§MG-B1 · P1 · Căn giữa nội dung trong zone làm phí giấy và lệch dấu xén~~ → **BÁC BỎ (P3, và ĐỪNG sửa như đề xuất)**

> **Bản sửa lần 2 — kiểm chéo bằng số bác bỏ cả hai hậu quả, và cho thấy bản sửa tôi đề xuất sẽ GÂY HỒI QUY.**
>
> Các con số trong phát hiện gốc **đúng nguyên vẹn** (Z003 thừa 50mm → 25mm mỗi bên; cột đầu 3 zone ở 17,0 / 10,0 / 35,0mm). Nhưng cả hai hậu quả tôi gán cho chúng đều sai:
>
> **1. Không hề phí giấy.** `capacity = len(cells)` do `solve_grid` trả trên `zone_rect` **nguyên vẹn**; `offset_x/offset_y` chỉ là phép **dịch** áp sau đó nên toán học không thể đổi số ô. Đo: CA 1 căn giữa = **160 tem/tờ**, sát lề = **160 tem/tờ**. Quét 40 ca ngẫu nhiên (4 khổ tờ × lề 8/10/12 × gripper 10/12/14 × 2–4 mẫu): **0/40** ca có capacity khác. Thừa của mọi zone **nhỏ hơn một tem** ở cả hai trục (Z003: thừa_x 50mm < item 90mm; thừa_y 41,4mm < item 50mm) nên không nhét thêm được cột/hàng nào. Bỏ căn giữa chỉ **di chuyển** chỗ thừa.
>
> **2. Cột lệch mốc là thật nhưng vô hại, và không do căn giữa.** Bước cột 3 zone khác nhau (54 / 55 / 90mm) nên cột chỉ trùng tại k=m=0 bất kể neo ở đâu. Đo cả hai phương án: căn giữa và sát lề đều cho **đúng 35 hoành độ cắt**, đều chỉ **3 hoành độ dùng chung**, **tổng nhát dao bằng nhau (52 = 35 dọc + 17 ngang)**. Vô hại vì mỗi zone là một **dải xén riêng**: trục chia = y, 3 zone tách rời hoàn toàn (10,0–378,8 / 378,8–736,6 / 736,6–1078,0mm), cây cắt guillotine hợp lệ, 42/61 đường cắt item giới hạn trong zone, Rust vẽ đủ 35/35 mép x và 17/17 mép y. Tách dải trước rồi xén từng dải → cột lệch giữa các dải không ảnh hưởng gì.
>
> **3. Căn giữa đang GÁNH việc đăng ký mặt sau duplex.** Vì nó giữ tập mép xén **đối xứng quanh tâm tờ**, lật cạnh dài cho mép xén mặt sau **trùng** mặt trước: **0/35 mép lệch**. Bật `useEdgeAlign` dồn thừa một phía làm mất đối xứng → **20/35 mép lệch** sau khi lật. **Đề xuất "sửa" của tôi sẽ phá đăng ký mặt sau — hồi quy nặng hơn cái nó định sửa.**
>
> **4. "Dải thừa mỏng khó thao tác" cũng không xảy ra**: thừa theo x nằm kề lề tờ nên gộp thành dải dày (17 / 10 / 35mm mỗi bên); thừa theo y gộp với zone kề thành 13,28 / 29,62 / 32,72 / 14,38mm — mỏng nhất 13,28mm.
>
> **Kết luận:** hạ xuống **P3** và phát biểu lại thành *"thiếu tuỳ chọn `useEdgeAlign` để nhà in dồn thừa về một phía"*, kèm điều kiện bắt buộc: **chỉ cho bật khi KHÔNG bình 2 mặt**, hoặc phải bù lại đối xứng cho mặt sau. **Không đưa vào lô sửa nào** trong đợt này.
>
> Bài học: tôi kết luận "phí giấy" từ hình học (thừa chẻ đôi) mà không đo **số tem/tờ** — đúng loại lỗi "trông có vẻ ổn ≠ sửa gốc" đã ghi trong ghi chú `feedback_measure_before_optimizing`.

<details>
<summary>Phát biểu gốc (đã bác bỏ) — click để xem</summary>

#### §MG-B1 · P1 · Căn giữa nội dung trong zone làm phí giấy và lệch dấu xén · effort M

`_solve_zone` căn giữa lưới trong zone ([mixed_guillotine.py:287-294](../backend/app/workers/mixed_guillotine.py#L287-L294)):

```python
offset_x = max(0.0, (zone_rect.width - content_width) / 2.0)
offset_y = max(0.0, (zone_rect.height - content_height) / 2.0)
```

Đo thật CA 1: `Z003 THỪA_TRONG_ZONE=(50.0,41.4)mm offset_content=(25.0,20.7)mm` — 50mm giấy thừa bị **chẻ đôi** thành 25mm mỗi bên. Xưởng thật dồn phần thừa về **một phía** (thường sát mép không cắn nhíp) để còn một dải giấy liền dùng được, và để mọi khối bài neo về một mốc cữ chung.

Hệ quả kép: cột của các zone không cùng mốc (`Z001` bắt đầu x=17.0mm, `Z002` x=10.0mm, `Z003` x=35.0mm) và 2 dấu xén còn sót của §MG-A1 nằm ở 10.0/780.0mm — **trỏ vào chỗ trống**, lệch 7mm so với mép thành phẩm gần nhất của `Z001`.

Hướng sửa: neo lưới về gốc zone (hoặc theo `align` mà user đã chọn ở UI — mode này hiện **bỏ qua** `align`), dồn thừa về một phía.

*(Hết phần đã bác bỏ. "Hướng sửa" trên là chỗ sai nguy hiểm nhất của cả báo cáo: làm đúng như vậy sẽ phá đối xứng mép xén → 20/35 mép lệch khi lật mặt sau. Việc `align` bị bỏ qua vẫn đúng, nhưng đó là thiếu tuỳ chọn, không phải lỗi.)*

</details>

### ~~§MG-B2 · Mặt sau tràn lề~~ → **BÁC BỎ (false positive). ĐỪNG sửa `_mirror_rect`.**

> **Bản sửa lần 3.** Tôi đã nâng phát hiện này lên P0 và định sửa `_mirror_rect` sang mirror quanh tâm vùng in. **Sai — bản sửa đó sẽ phá đăng ký mặt sau 15–35mm.**
>
> **Lỗi của tôi là hệ quy chiếu.** Tôi so bài mặt sau với `usable_rect` **chưa lật**. Khi lật tờ, vùng in của máy lật theo cùng trục với bài, nên phải so với vùng in **đã lật**.
>
> Lập luận vật lý: một tem mặt trước cách mép trái tờ `x`. Lật tờ quanh trục dọc → chính tem đó, đo từ mép trái **mới**, ở `sheet_w − x − w`. Tờ giấy là vật thể bị lật nên **mép tờ là hệ quy chiếu duy nhất hợp lệ**. Mirror quanh tâm vùng in lệch đi đúng `marginLeft − marginRight`.
>
> Số đo (12 cấu hình lề):
>
> | | Mirror tâm TỜ (hiện tại) | Mirror tâm VÙNG IN (tôi đề xuất) |
> |---|---|---|
> | Sai số chồng lưng | **0,00mm** ở 12/12 | lệch **15–35mm** ở 8/12 (ca 2: 20,0mm) |
> | Lệch vết dao 2 mặt | 0,00mm | 20,0 / 15,0mm |
> | Vi phạm nhíp | **0/12** | **8/12** |
>
> Ca 3 (gripper 25mm, flip short): mirror tâm tờ cho khoảng từ cạnh dẫn pass 2 = **37,0mm** (đạt); tâm vùng in = **22,0mm < 25mm** → **vi phạm nhíp**. Tức mirror tâm tờ chính là **cơ chế bảo đảm** bất biến nhíp, không phải thứ phá nó.
>
> Con số "tràn lề phải 6,0mm" tái hiện đúng số học nhưng **vô nghĩa vật lý**: mặt trước cách mép trái 24,0 / mép phải 44,0mm; mặt sau đảo lại đúng 44,0 / 24,0mm — hệ quả tất yếu của phép lật.
>
> Cả repo đã đồng thuận tâm tờ: duplex legacy [nup_process_chunk.py:659](../backend/app/workers/nup_process_chunk.py#L659) dùng `sheet_w - (abs_x + width)`, và test đang xanh [test_mixed_guillotine_export.py:148-150](../backend/tests/test_mixed_guillotine_export.py#L148-L150) assert đúng công thức đó. Bản vá của tôi sẽ làm test này đỏ.
>
> **Vì sao đối chiếu script Illustrator đánh lừa tôi:** script mirror quanh `layoutUsableW`, nhưng nó chạy trong **toạ độ tương đối vùng in** (gốc neo `artboardLeft + marginLeftPt`), hoặc ngầm giả định lề đối xứng. Khi lề đối xứng, hai công thức **trùng nhau** — đo được ở ca 1. Tôi đối chiếu công thức mà không đối chiếu **hệ toạ độ** của nó.
>
> **Phần còn đúng (rủi ro thật, mức thấp, là thiếu tính năng chứ không phải bug):** không có gì cảnh báo khi lề bất đối xứng làm lề cạnh của 2 mặt **đổi chỗ**. Nếu máy khách thật sự không in nổi sát mép phải 30mm ở **cả hai** pass, cách xử lý đúng là **ràng buộc layout mặt trước vào phần đối xứng** (giao của usable với ảnh mirror của nó — flip long thì lấy `max(lề trái, lề phải)` cho cả hai bên), **giữ nguyên trục mirror**. Đó là việc ở khâu dựng `usable_rect`, không phải sửa `_mirror_rect`.
>
> Cũng đúng nhưng vô hại: `validate_guillotine_plan` không kiểm mặt sau. Mặt sau là ảnh mirror **involutive** của một mặt trước đã validate (mirror 2 lần = gốc, đo 6/6 ca), nên kiểm nó bằng `usable_rect` chưa lật sẽ **loại bỏ output đúng** — lặp lại chính lỗi hệ quy chiếu trên.

<details>
<summary>Phát biểu gốc (đã bác bỏ) — click để xem</summary>

`_mirror_rect` với `flip_edge="short"` lật quanh tâm ngang tờ ([mixed_guillotine.py:949-954](../backend/app/workers/mixed_guillotine.py#L949-L954)). Lề trên/dưới bất đối xứng (bình thường: trên 10mm, dưới = gripper 12mm) nên sau khi lật, lề dưới mặt sau nhận giá trị của lề trên:

```
CA B - tờ ĐỨNG 790x1090, flip_edge=short
  lề mặt SAU: trên=12.0mm dưới=10.0mm (gripper yêu cầu >= 12mm ở cạnh nạp giấy = DƯỚI)
  !! LỖI GRIPPER: lề dưới mặt sau 10.0mm < gripper 12mm
```

Lỗi xảy ra ở **cả** tờ đứng và tờ ngang (CA B và CA D). Đây là lỗi **mới của mode này**: duplex mode cũ chỉ mirror X (`p['abs_x'] = sheet_w - (p['abs_x'] + p['width'])`, [nup_process_chunk.py:659](../backend/app/workers/nup_process_chunk.py#L659)), không bao giờ dời theo y nên không chạm vùng nhíp. `mixed_guillotine` là mode guillotine duy nhất cho chọn `flip_edge="short"`.

Hướng sửa: khi `duplex` và `flip_edge="short"`, buộc lề trên/dưới đối xứng (lấy `max` hai lề) trước khi solve, hoặc validate rồi báo lỗi tiếng Việt yêu cầu user tăng lề trên cho bằng gripper.

*(Hết phần đã bác bỏ. Điều trớ trêu: "hướng sửa" trong đoạn gốc này — ép lề đối xứng ở khâu dựng `usable_rect` — mới là cách đúng. Nhưng tôi đã bỏ nó để đổi sang sửa `_mirror_rect`, và đó là chỗ sai.)*

</details>

## Phát hiện thêm (ngoài phạm vi, không sửa trong đợt này)

- **Nhãn "theo cạnh dài/ngắn" không đúng vật lý trên tờ ngang.** `flip_edge="long"` luôn mirror X ([mixed_guillotine.py:942](../backend/app/workers/mixed_guillotine.py#L942)); trên tờ ngang 1090×790, cạnh dài lại là cạnh **ngang** nên đúng vật lý phải mirror Y. **Không đề nghị sửa riêng mode này**: `cnc_render.mirror_placements_multi` dùng đúng cùng quy ước và ghi rõ "lật quanh cạnh dài (trục dọc) → mirror NGANG" ([cnc_render.py:146-148](../backend/app/workers/cnc_render.py#L146-L148)), test cũng đã khoá ([test_mixed_guillotine_solver.py:258-277](../backend/tests/test_mixed_guillotine_solver.py#L258-L277)). Đây là **quy ước toàn dự án**; sửa lẻ sẽ làm CNC và mixed lệch nhau. Nếu muốn chỉnh thì phải đổi đồng bộ cả 2 mode + nhãn UI, thành một việc riêng.
- **Không có bù xén chồng giữa 2 ô cạnh nhau khi `gap=0`.** `clip_off = min(gap/2, bleed) = 0` ([nup_process_chunk.py:807-808](../backend/app/workers/nup_process_chunk.py#L807-L808)) → nội dung bị cắt sát đúng đường trim, dao lệch 0.5mm là hở giấy trắng. Đây là hành vi **dùng chung mọi mode guillotine** (hàm `place_one_artwork` chia sẻ), không riêng mixed → xếp ngoài phạm vi. Ghi lại để tính sau.
- **`mixed_guillotine` bỏ qua `align` của user.** Liên quan §MG-B1; nếu sửa B1 thì nên đọc luôn `align`.
- **`_candidate_groups` là O(n²) trên `_all_candidates`** ([mixed_guillotine.py:731-759](../backend/app/workers/mixed_guillotine.py#L731-L759)), mỗi lần gọi lại solve toàn bộ zone. Với số mẫu nhỏ (≤5) chưa thành vấn đề; nếu sau này cho nhiều mẫu hơn thì cần cache.

## Không phải bug (đã kiểm, loại khỏi danh sách)

- **Hở giữa 2 zone kề nhau khi `gap=0`.** Nghi ban đầu là chồng bù xén, nhưng đo ra hở **thực** giữa sản phẩm 2 zone là 13.28mm và 29.62mm (do căn giữa của §MG-B1 vô tình tạo khoảng đệm) — không chồng. Ghi lại vì nếu sửa B1 (dồn thừa về một phía) thì **phải** kiểm lại điểm này: khi 2 zone sát nhau thật, `bleed` 2 bên sẽ chồng lấn nhau và ô của zone sau sẽ đè lên vùng trim của zone trước.
- **Slot lưới ↔ vị trí (`gridSlot % cols`)** trong validator ([mixed_guillotine.py:1177-1181](../backend/app/workers/mixed_guillotine.py#L1177-L1181)): an toàn vì `solve_grid` luôn trả lưới chữ nhật đầy đủ `cols × rows` ([nup_layout_solver.py:95-105](../backend/app/workers/nup_layout_solver.py#L95-L105)), không có hàng lẻ.
- **Mirror 2 lần ở mặt sau**: đã chặn đúng bằng marker `_duplex_transform_applied` ([nup_process_chunk.py:651-656](../backend/app/workers/nup_process_chunk.py#L651-L656)).
- **Gripper ở mặt trước**: `nup_engine` đã áp `margin_bottom = max(margin_bottom, gripper)` trước khi tính usable ([nup_engine.py:575-577](../backend/app/workers/nup_engine.py#L575-L577)) — đúng.

## Đề xuất thứ tự sửa theo lô

Mỗi lô ≤5 file, verify xong mới sang lô kế (theo `prynx-audit-workflow`).

**Bảng dưới đây đã lỗi thời** (dựng khi §MG-A1/A3 còn được coi là P0). Bảng đúng: xem [Điều chỉnh kế hoạch sửa](#điều-chỉnh-kế-hoạch-sửa) ở cuối phần bổ sung.

<details>
<summary>Bảng lô gốc (lỗi thời)</summary>

| Lô | Nội dung | File | Verify |
|---|---|---|---|
| 1 | §MG-A1 + §MG-A3 — dấu xén theo segment từng zone | `mixed_guillotine_adapter.py`, `nup_engine.py`, `cluster_tile_engine.py` (+1 test mới) | pytest mixed + test mới "dấu xén export == đường cắt preview" |
| 2 | §MG-B2 — chặn/ép lề đối xứng khi lật cạnh ngắn | `mixed_guillotine.py`, `imposition.py` (+test) | pytest mixed |
| 3 | §MG-B1 — neo lưới theo `align`, dồn thừa một phía | `mixed_guillotine.py` (+test) | pytest mixed + **kiểm lại chồng bù xén** (mục "Không phải bug" #1) |
| 4 | §MG-A2 — 1 bản kẽm + ngưỡng dư cho phép | `mixed_guillotine.py`, `GridSettingsSection.tsx`, i18n vi/en (+test) | pytest mixed, `npm run typecheck`, `npm run test` |

</details>

Lô về §MG-A2 cần **quyết định sản phẩm** trước khi code: mặc định 1 bản kẽm, ngưỡng dư cho phép bao nhiêu (đề nghị 5%, có ô nhập), và có giữ chế độ "dư = 0, nhiều bản kẽm" như tuỳ chọn không. Test hiện có khoá `excessQuantity == 0` nên sẽ phải sửa test đó — cần user duyệt vì đây là đổi hành vi nghiệp vụ có chủ đích.

## Ghi chú kiểm chứng

- Chưa chạy `run_dev.bat` xuất PDF thật soi mắt (cần user chạy Windows) — mọi số trên đến từ probe gọi trực tiếp solver/adapter, đúng đường runtime.
- Probe: `backend/scratch/probe_mixed_guillotine.py`, `probe_cutlines.py`, `probe_duplex_gripper.py`, `probe_marks.py`. Xóa được sau khi chốt báo cáo.
- Baseline test trước khi sửa: **39 passed** (6 file mixed).

---

# Phần bổ sung — đối chiếu với script Illustrator đang dùng thật

Nguồn: `scripts/illustrator/1. dev -  Nô lệ bình bài.jsx` — 21.141 dòng ExtendScript, tool sản xuất của nhà in VN. Đây là **chuẩn thực tế**: mọi quy ước trong đó là kinh nghiệm đời thực đã trả giá. Nơi nào PrynX làm khác, mặc định PrynX sai.

Mọi trích dẫn dưới đây tôi đã tự mở file đọc, không qua trung gian.

## Kết quả: 1 phát hiện nâng lên P0, 1 phát hiện phải phát biểu lại, 1 phát hiện được xác nhận nguyên vẹn

*(Phần §MG-A1 dưới đây đã được sửa lại theo bản sửa lần 2 ở đầu báo cáo — script xác nhận nguyên tắc, nhưng PrynX đã làm đúng qua đường Rust.)*

### §MG-A1 — script XÁC NHẬN nguyên tắc, nhưng PrynX **đã làm đúng** rồi (qua đường Rust)

> **Đọc kèm bản sửa lần 2 ở đầu báo cáo.** Phần dưới mô tả đúng cách script Illustrator vẽ dấu, và nguyên tắc đó đúng. Chỗ tôi sai là kết luận PrynX **không** làm vậy — thực ra `compute_mark_coords` bên Rust làm gần hệt: gom mép trim theo `(cluster_idx, block_id)` = `(zone, sản phẩm)`, vẽ tick tại mọi mép cột/hàng, đặt ngoài bbox từng zone. Đo: 35/35 mép có dấu, `0/78` segment dọc rơi vào vùng thành phẩm tem khác.
>
> Khác biệt còn lại là cơ chế chống chồng: script **tắt riêng từng cạnh** khi vùng dấu chồng bleed tem khác; Rust **đặt tick ngoài bbox của cả zone** nên tự nhiên không chồng. Hai cách khác nhau, cùng kết quả đúng. Không cần sửa.



`drawDynamicTrimMarks` (dòng 11678) không có khái niệm "chỉ vẽ khi chạy suốt tờ". Nó vẽ dấu quanh **từng tem một**, và giải quyết xung đột dấu-với-bù-xén bằng cách **tắt riêng từng cạnh**:

```javascript
// Nếu Vùng Dấu Xén Bên Trên của tem hiện tại chồng lên Vùng Bù Xén của tem khác -> Cấm vẽ
if (shouldDraw.top && rectsOverlap(markAreas.top, otherBleedBox)) {
    shouldDraw.top = false;
}
```

Ba chi tiết đáng học:

1. **Toạ độ trim đọc từ `note`, không đo lại** (dòng 11713 "ĐỌC TỌA ĐỘ TỪ NOTE THAY VÌ ĐO"): `trimBoxData = JSON.parse(itemGroup.note)` → `trueLeft/trueTop/trueRight/trueBottom`. Dấu xén luôn nằm đúng mép thành phẩm. PrynX hiện lấy dấu từ mép `usableRect` — chính là lý do 2 dấu còn sót lệch 7mm.
2. **Đơn vị quyết định là tem, không phải tờ.** `shouldDraw = {top, bottom, left, right}` cho mỗi tem.
3. **Tắt cạnh là vì chồng bù xén, không phải vì "không chạy suốt tờ".** Tiêu chí của PrynX (full-span) không tồn tại trong thực tế.

Nguyên tắc rút ra — và PrynX **đã thoả** qua đường Rust: dấu xén phải neo theo **mép thành phẩm thật của từng tem**, và không được rơi vào vùng thành phẩm của tem khác. Điểm duy nhất PrynX còn lệch: mấy dấu ở mép `usableRect` do đường tile thêm vào không neo theo mép thành phẩm nào (§MG-A1 mức P2).

### §MG-A2 — XÁC NHẬN phần "1 bố cục", nhưng bằng chứng SL/tỉ lệ lấy sai đường

> **Bản sửa lần 2.** Công thức `ceil(SL / itemsPerPage)` trích dưới đây ở dòng 13282 nằm trong đường **Bình trang / cùng kích thước**, KHÔNG phải đường trộn khác kích thước. Kiểm lại 2 engine trộn khác size thật:
>
> ```javascript
> // runDynamicGangingForGuillotine (11348)   và   runMultiSizeGanging (14669) — y hệt nhau:
> var multiplier = settings.totalQuantity;
> for (var i = 0; i < temPairs.length; i++)
>     for (var j = 0; j < multiplier; j++) pairsToPlace.push(temPairs[i]);
> ```
>
> **Cả hai đều nhân bản MỌI mẫu với cùng một `multiplier` phẳng** — không đọc `perItemQuantities`. Nghĩa là đơn 1000/500/200 cho 3 mẫu ra tỉ lệ ô **1:1:1**, không phải theo SL. `perItemQuantities` có 13 chỗ đọc, **không chỗ nào** nằm trong 2 engine trộn khác size; dialog vẫn thu SL riêng (9525-9530) rồi **bỏ không dùng** trên đường này.
>
> Hệ quả cho §MG-A2: phần **"1 bố cục dùng chung, không cascade nhiều bản kẽm"** vẫn XÁC NHẬN (help tip 1928 nói rõ ý định "Xếp TẤT CẢ… vào chung một artboard để tối ưu giấy"). Nhưng phần **"chia ô theo tỉ lệ SL"** thì tool sản xuất **cũng không làm** ở mode trộn khác size — nên đừng lấy nó làm chuẩn cho việc đó. `ratio_stack` trong PrynX vẫn là mẫu đúng cho ý tưởng tỉ lệ, nhưng nó chỉ áp dụng cho mẫu **cùng** kích thước.
>
> Cũng sửa: `fillEmptyGangingSlots` **không** bật sẵn mặc định — dòng 21649 `value = true` bị dòng 21650 `enabled = false` vô hiệu ngay, và cả `updateLayoutModeState` (21994-21996) lẫn `updateUIState` (22384-22385) đều ép `value = false` khi control bị disable. Nó chỉ true nếu phiên trước đã lưu.



Công thức số tờ của tool sản xuất (dòng 13282-13284):

```javascript
var currentModelQty = (settings.perItemQuantities && settings.perItemQuantities[i] !== undefined) ? settings.perItemQuantities[i] : settings.totalQuantity;
var sheetsNeeded = currentModelQty > 0 && itemsPerPage > 0 ? Math.ceil(currentModelQty / itemsPerPage) : 0;
var actualQty = sheetsNeeded * itemsPerPage;
```

**Một bố cục, chia, làm tròn lên, rồi BÁO số thực.** Không có vòng lặp sinh bố cục sửa số. Tool có sẵn SL riêng từng mẫu (`perItemQuantities`, dòng 21446) nên đây đúng là ca nhiều mẫu SL khác nhau.

Quan trọng hơn: tool **công khai chấp nhận in dư**. Field report `actualQty` có helpTip (dòng 2464):

> "Show the actual label count after layout (**may exceed the requested quantity**)."

Và có tuỳ chọn `fillEmptyGangingSlots` — chủ động **nhồi thêm tem lấp chỗ trống** khi còn giấy (dòng 11480-11500), xoay vòng qua các mẫu: `var pairToFill = temPairs[fillIndex % temPairs.length]`.

Vậy ràng buộc "dư = 0" của PrynX đi ngược thực tế ngành. Đề xuất lô 4 giữ nguyên hướng nhưng có căn cứ vững: **1 bản kẽm + báo `actualQty` + tuỳ chọn lấp chỗ trống**, thay vì cascade template.

### §MG-B1 — PHẢI PHÁT BIỂU LẠI. Thực tế CÓ căn giữa, nhưng căn giữa CẢ KHỐI một lần

> **Bản sửa lần 2 — hướng phát hiện đúng và còn MẠNH HƠN, nhưng bỏ luận điểm "user chọn được sát lề".**
>
> Kiểm chéo: `useEdgeAlign` / `safeEdgeAlign` mà tôi trích **bị vô hiệu trên đúng đường guillotine**. `isGuillotineMode` (workingModeIndex===2) ép tắt control ở 22203-22204 (`enabled=false; value=false`) kèm comment *"Khóa Canh lề an toàn — Xén thành phẩm không có ốc"*, và `runClusteredGuillotineGanging` **không đọc** `settings.safeEdgeAlign` ở đâu cả. Bằng chứng [6]/[7] tôi trích thuộc đường **die-cut (pont/ốc)**, không phải đường xén thành phẩm.
>
> Nên với mode tương ứng `mixed_guillotine`, thực tế **luôn căn giữa, không có tuỳ chọn sát lề** — ngược với câu tôi viết. Điều này **củng cố** §MG-B1: chuẩn là căn giữa cả khối một lần, và PrynX lệch ở chỗ căn giữa **từng zone**.
>
> Hai điều chỉnh nữa từ kiểm chéo:
> - "Đúng MỘT lần căn giữa cho CẢ TỜ" phải nới thành **"nhiều nhất một lần mỗi MẶT, tính từ một bbox toàn cục"**. Có bất đối xứng thật: dòng 12751 `shouldCenterBack=false` khiến **mặt sau của tờ cuối** trong lô 2 mặt nhiều tờ **không** được căn giữa, còn mặt trước vẫn được (12497 set `shouldCenterFront=true` vô điều kiện).
> - "Không bao giờ căn giữa từng cụm" hơi tuyệt đối: 3477-3502 **có** canh chỉnh cục bộ theo **CỘT** trước khi căn giữa toàn cục. Nhưng nó neo mọi cột vào **một mốc dùng chung** (tâm Y của cột giữa) — vẫn là nguyên tắc "một mốc chung", không phải mỗi zone tự căn giữa mình.



Đây là chỗ báo cáo gốc của tôi suy đoán sai một nửa. Tool sản xuất **có** căn giữa (dòng 13277): `centerContent(resultLayer, trimLayer, docCoords.startX, docCoords.startY, usableWidthPt, usableHeightPt)` — nhưng căn giữa **toàn bộ khối một lần vào vùng in**, và có tuỳ chọn cho user chọn sát lề (dòng 3410-3423):

```javascript
if (useEdgeAlign) {
    // === NẾU TICK (TRUE): Canh sát lề (Cũ) ===
    ...
    centeringOffsetY = usableH - finalBB.maxY; // Sát đáy
} else {
    // === NẾU KHÔNG TICK (FALSE): Canh giữa khổ giấy (An toàn) ===
```

Nên phát biểu đúng của §MG-B1 là: **PrynX căn giữa TỪNG ZONE riêng lẻ (nhiều lần), thực tế căn giữa CẢ TỜ một lần.** Căn giữa từng zone mới là lỗi — nó vừa chẻ đôi giấy thừa vừa làm cột các zone lệch mốc nhau. Sửa: bỏ căn giữa trong `_solve_zone`, neo lưới về gốc zone, rồi căn giữa/sát lề cả khối một lần ở tầng trên — và đọc `align` mà user đã chọn (mode này đang bỏ qua).

### §MG-B2 — NÂNG CẤP. Gốc rễ không phải "lật cạnh ngắn" mà là mirror quanh TÂM TỜ

Script sản xuất mirror mặt sau quanh **vùng in**, không phải khổ tờ (dòng 11228-11230):

```javascript
// Công thức lật: Vị trí X mới = Tổng_Rộng_Usable - Vị_trí_X_cũ - Rộng_của_cụm
var mirroredX_offset = layoutUsableW - currentX_offset - batchRegionWidth;
```

`layoutUsableW` = **vùng in**. PrynX dùng `sheet_width` = **khổ tờ** ([mixed_guillotine.py:942-948](../backend/app/workers/mixed_guillotine.py#L942-L948)). Lề bất đối xứng thì hai cách cho kết quả khác nhau, và cách của PrynX đẩy bài ra ngoài lề.

Đo lại với giả thuyết mới — lỗi **rộng hơn** báo cáo gốc, xảy ra cả với `flip=long` là mặc định:

| Ca | Lề | flip | Mặt sau | Kết quả |
|---|---|---|---|---|
| 1 | đối xứng 10/10/10/10 | long | x 22,2..778,2 | OK |
| 2 | **trái 10 / phải 30** | **long** | x 44,0..766,0 (vùng in 10..760) | **tràn lề phải 6,0mm** |
| 3 | dưới 25 (gripper) | short | y 37,0..1068,0 (vùng in 10..1065) | **tràn lề dưới 3,0mm** |
| 4 | dưới 25 (gripper) | long | x 22,2..778,2 | OK |

Cả 2 ca lỗi: nếu mirror quanh tâm **vùng in** thì mặt sau về đúng vị trí mặt trước (x 24,0..746,0 và y 22,0..1053,0) — **nằm gọn trong vùng in**.

Ý nghĩa cho kế hoạch sửa: §MG-B2 **không phải** lỗi ngách của tumble flip mà là lỗi của **mọi bài 2 mặt có lề bất đối xứng** — mà lề bất đối xứng là chuyện thường ngày vì lề đáy luôn phải ≥ gripper. Sửa chỉ cần đổi `_mirror_rect` lấy `usable_rect` làm trục thay vì `sheet_width/height`; một chỗ đóng cả 2 lỗi. **Nâng B2 từ P1 lên P0** và đưa lên lô 1 vì rẻ và chặn lỗi in hỏng.

Lưu ý khi sửa: `_mirror_cut_lines` và `_mirror_tree` cũng phải đổi trục cùng lúc, nếu không dấu xén sẽ lệch khỏi nội dung.

Kiểm chéo bổ sung xác nhận script **chỉ** mirror X, không tồn tại cơ chế lật Y nào trong 21.141 dòng (grep độc lập cả toán học `.cy=`, `blockH-`, `usableHeightPt-orig` lẫn API Illustrator `ScaleMatrix`, `concatenateMatrix`, `transform`, `resize`, `scaleX/scaleY` âm → không hit nào là lật mặt). Và **script cũng không validate lề đối xứng** khi bình 2 mặt, dù các route lật quanh `usableWidthPt` (13707, 12767, 12815, 19107) ngầm yêu cầu `marginLeft == marginRight` vì gốc neo mặt sau vẫn là `artboardLeft + marginLeftPt`. Nên đây là điểm PrynX **có thể làm tốt hơn** chuẩn thực tế: thêm validate hoặc tự lấy `max` hai lề.

Một chi tiết đáng ghi: dòng 14424 có comment *"Script này dùng logic đối trở (work-and-tumble)"* nhưng code thực thi mirror X = hình học **work-and-turn** (trở lái). Hai thứ ngược trục nhau — comment trong script sản xuất khai sai so với code của chính nó. Không ảnh hưởng kết luận (hành vi code mới là chuẩn), nhưng nếu sau này đối chiếu tiếp thì đừng tin comment đó.

## Khác biệt kiến trúc: shelf bin-packing vs cây cắt zone

> **Bản sửa lần 2 — luận điểm "script không có khái niệm zone" đã BỊ BÁC BỎ.**
>
> Tôi bỏ sót `runClusteredGuillotineGanging` (dòng 10896-11317). Hàm này **làm đúng zone-per-loại-sản-phẩm**, trùng ngữ nghĩa zone của PrynX:
>
> ```javascript
> var itemToPlace_Front = settings.isTwoSided ? itemsForThisRun[i * 2] : itemsForThisRun[i];
> placeItems(itemToPlace_Front, resultLayerFront, layout, batchDocCoordsFront, ...);   // 11180-11182
> drawGridTrimMarks(doc, marksLayerFront, layout, batchDocCoordsFront, settingsForMarks, sidesToDraw);
> ```
>
> Mỗi cụm được cấp **đúng một mẫu**, `placeItems` nhân bản mẫu đó vào mọi ô của lưới cụm, và mỗi cụm có **dấu xén riêng** (11183) + **viền riêng** (11186-11199). Layout từng cụm tính độc lập qua `calculateGridLayout_NLDT(widthPerBatch, layoutUsableH, ...)` (11101).
>
> **Giới hạn thật của nó:** chỉ đo mẫu **đầu tiên** (10910-10925) rồi dùng chung `trueItemW/H` cho mọi cụm (10948-10949, 11101) → **chỉ đúng khi các mẫu CÙNG kích thước**.
>
> Nên phát biểu đúng là: **mô hình zone-per-loại của PrynX trùng chuẩn thực tế** — nhưng thực tế chỉ dùng nó cho mẫu cùng kích thước. Với mẫu **khác** kích thước, script chuyển sang bin-packing toàn cục, trộn mọi size, **không** phân hoạch tờ theo loại. Tức PrynX không "hiểu ngược ý nghĩa cụm"; PrynX **mở rộng** mô hình zone sang ca mà thực tế không dùng nó.
>
> Và có **hai** engine trộn khác size, không phải một — tôi chỉ đọc một:
>
> | Engine | Thuật toán | Xoay? |
> |---|---|---|
> | `runMultiSizeGanging` (14664) | **2D free-rectangle guillotine bin packing**, class `GuillotineBinPack` (14612-14663), Best-Area-Fit + cắt rect thắng thành 2 con theo cạnh dư dài hơn | **Có** 90° |
> | `runDynamicGangingForGuillotine` (11322) | shelf/row packing NFDH (mô tả bên dưới) | Không |
>
> Engine thứ nhất **gần mô hình guillotine của PrynX hơn** shelf packing — nó cũng cắt đệ quy thành hình chữ nhật con. Khác biệt là nó chia theo **chỗ trống còn lại** (free-rect) chứ không chia trước theo loại sản phẩm.
>
> Việc này làm câu hỏi kiến trúc ở cuối báo cáo **rộng hơn 2 lựa chọn**: giữ cây zone / shelf packing / **free-rect guillotine bin packing**. Lựa chọn thứ ba đáng cân nhắc nhất vì vẫn guillotine hợp lệ, vẫn cho phép nhiều loại chung một dải, và có tiền lệ sản xuất.



Đây là phần đáng giá nhất của việc đối chiếu. `runDynamicGangingForGuillotine` (dòng 11321) dùng mô hình **khác hẳn** PrynX:

```javascript
// Tạo danh sách tất cả các tem cần xếp (Required Items)
for (var i = 0; i < temPairs.length; i++) {
    for (var j = 0; j < multiplier; j++) { pairsToPlace.push(temPairs[i]); }
}
// Sắp xếp theo chiều cao giảm dần để tối ưu xếp dòng (Bin Packing Best Fit Height)
pairsToPlace.sort(function (a, b) { ... return hB - hA; });
```

rồi xếp trái→phải, hết chiều rộng thì xuống dòng (dòng 11455-11470):

```javascript
if (currentX > 0 && (currentX + tW) > workingAreaW) {
    currentY += maxRowH + gapPt;  currentX = 0;  maxRowH = 0;
}
if ((currentY + tH) > workingAreaH) { break; }
```

Đây là **First-Fit Decreasing Height (shelf packing)**: danh sách phẳng mọi tem cần xếp, sort chiều cao giảm dần, xếp thành dòng, mỗi dòng cao bằng tem cao nhất trong dòng.

| | PrynX `mixed_guillotine` | Script sản xuất |
|---|---|---|
| Đơn vị bố cục | zone (vùng chữ nhật) | dòng (shelf) |
| Ràng buộc loại | **1 zone = 1 loại** | nhiều loại **chung một dòng** |
| Sinh bố cục | cây cắt guillotine đệ quy | xếp tuần tự theo chiều cao giảm dần |
| Số lượng | chia zone theo tỉ lệ SL, dư = 0 | nhân bản tem theo SL vào danh sách, dư thì báo |
| Chia vùng cố định | không có | có — `useSubArea` cho user nhập cỡ khối |

Ràng buộc "1 zone 1 loại" chính là chỗ PrynX mất năng suất: hai mẫu cao gần bằng nhau (54mm và 55mm trong ca đo) **bắt buộc** phải nằm 2 zone khác nhau, mỗi zone tự làm tròn xuống số hàng và tự sinh phần thừa riêng. Shelf packing cho 2 mẫu đó chung một dòng, phần thừa chỉ còn 1mm chênh chiều cao.

Vẫn xén được bằng dao thẳng: cắt các **dải ngang** trước (mỗi dòng một dải), rồi cắt dọc trong từng dải, rồi cắt phần dư chiều cao của tem thấp hơn trong dải. Ba tầng dao, mỗi nhát vẫn thẳng suốt vùng đang xén — tức là vẫn guillotine hợp lệ, chỉ **không** phải cây cắt 2 tầng như PrynX giả định.

Đây là **thay đổi thuật toán lớn**, không thuộc phạm vi 4 lô hiện tại. Tôi đề nghị tách thành việc riêng, quyết định sau khi đóng xong nhóm A: giữ cây zone (an toàn, chứng minh được, năng suất thấp hơn) hay chuyển shelf packing (đúng chuẩn thực tế, năng suất cao hơn, phải viết lại validator).

## Điều chỉnh kế hoạch sửa

Sau 3 vòng kiểm chéo, chỉ còn **MỘT việc thật**:

| Lô | Nội dung | File | Verify | Ghi chú |
|---|---|---|---|---|
| **1** | **§MG-A2 (P0, mức KINH TẾ)** — giảm số bản kẽm + ngưỡng dư | `mixed_guillotine.py`, `GridSettingsSection.tsx`, i18n vi/en + test | pytest mixed, `npm run typecheck`, `npm run test` | **Cần user chốt ngưỡng dư trước.** Mục tiêu đúng là **"1–2 bản kẽm với ngưỡng dư có giới hạn"**, KHÔNG phải "luôn 1" — xem số đo bên dưới. Phải sửa test đang khoá `excessQuantity == 0` |
| — | §MG-A1 (P2) dọn dấu lạc ở mép `usableRect` | `nup_engine.py` | pytest mixed | Không gấp, không ảnh hưởng kết quả cắt |
| — | ~~§MG-B1~~, ~~§MG-B2~~, ~~§MG-A3~~ | — | — | **Bỏ hẳn.** Cả ba là false positive; bản sửa từng đề xuất cho B1/B2 sẽ gây hồi quy |
| — | (tuỳ chọn) cảnh báo lề bất đối xứng khi bình 2 mặt | `mixed_guillotine.py` hoặc `imposition.py` | pytest mixed | Rủi ro thật mức thấp: lề cạnh 2 mặt đổi chỗ mà không cảnh báo. Cách đúng: ràng buộc layout mặt trước vào phần đối xứng (`max(lề trái, lề phải)`), **giữ nguyên trục mirror** |
| — | **Quyết định kiến trúc**: cây zone / shelf packing / **free-rect guillotine bin packing** | — | — | Không phải lô sửa. Cần user chốt |

**Số đo cho lô 2 (quyết định sản phẩm).** Đo phương án "1 bản kẽm tốt nhất":

| SL | 1 bản kẽm cần | So với hiện tại |
|---|---|---|
| 1000/1000/1000, gap 6mm | 1 kẽm, **cùng 23 tờ**, dư **+1,2%** | Thắng rõ — nên làm |
| 5000/1000/200, gap 0 | 1 kẽm, 45 tờ, dư **+80%** | Hiện tại 6 kẽm/41 tờ. +80% rẻ về tuyệt đối (+160 name card) nhưng đặt mặc định vô điều kiện sẽ thành khiếu nại mới |

Nên cần **ô nhập ngưỡng dư cho phép**, không phải ép luôn 1 kẽm. Đề nghị mặc định 5–10%, và khi vượt ngưỡng thì cho phép 2 kẽm thay vì 6.

**Cũng lưu ý về mức độ §MG-A2:** đây là mức độ **kinh tế**, không phải đúng/sai. Hình học hợp lệ, cây cắt qua validator, số lượng chính xác, không in hỏng — khác lớp với §MG-B2. Nhưng 6 bộ kẽm cho 41 tờ giấy là thứ không xưởng nào dùng, nên vẫn là defect thật.

Probe bổ sung: `backend/scratch/probe_mirror_axis.py`, `probe_rust_marks.py`, `probe_marks_union.py`.
