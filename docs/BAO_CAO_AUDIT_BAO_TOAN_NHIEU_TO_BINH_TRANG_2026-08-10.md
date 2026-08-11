# BÁO CÁO AUDIT BẢO TOÀN NHIỀU TỜ BÌNH TRANG — 2026-08-10

> Audit unit: `W2-U06`  
> Baseline: working tree tại `89a9048`, branch `codex/pre-release-audit-2026-08-04`  
> Trạng thái: **đã duyệt và hoàn tất sửa `§MSHEET.1`**  
> Phạm vi: N-Up/cắt xén, Bình tem bế, CNC, Bình nguyên tấm, Mixed Guillotine và Booklet; kiểm hợp đồng từ solver → preview → UI chuyển tờ → PDF xuất.

## 1. Kết luận điều hành

Audit xác nhận **một lỗi cùng họ và đã sửa sau khi người dùng duyệt**:

| Mã | Trạng thái | Mức / effort | Kết luận |
|---|---|---|---|
| `§MSHEET.1` | `[CONFIRMED · FIXED]` | **P0 / M** | CNC **Dàn nhiều mẫu** từng chỉ giữ tờ mẫu đầu khi tổng số mẫu vượt sức chứa một tờ. Layout, preview và renderer nay bảo toàn mọi tờ mẫu; ca không thể đặt đủ sẽ dừng rõ ràng. |

Lỗi N-Up 31 trang A5, 4-up, xếp lần lượt một mặt đã được sửa trong working tree hiện tại: preview trả đủ 8 tờ và engine dựng đủ 8 tờ. Trong các nhánh còn lại đã truy vết và chạy test đại diện, **không tìm thấy thêm trường hợp âm thầm bỏ tờ/mẫu cùng kiểu**.

Kết luận trên không có nghĩa là “toàn bộ bình trang không còn bug”. Bằng chứng hiện tại ở mức code trace + test tự động + một artifact CNC tái hiện; chưa thao tác lại mọi mode trên app desktop thật.

## 2. Bất biến dùng để audit

Audit tách hai khái niệm không được trộn:

- **Tờ mẫu khác nhau:** có placements hoặc `pageIdx` khác nhau; mọi tờ mẫu phải hiện trong preview và phải có trong artifact xuất.
- **Lượt in lặp:** cùng một tờ mẫu được in nhiều lần; được phép chỉ materialize một template nếu response/report ghi rõ `runCount` hoặc số tờ cần in.

Nếu preview báo `N > 1` nhưng các tờ có nội dung khác nhau, response phải trả đủ `sheets[]` để UI chuyển xem. Không được dùng một con số `sheetsNeeded` để thay thế dữ liệu placements của những tờ khác nhau.

## 3. Finding `§MSHEET.1` — CNC bỏ mẫu sau tờ đầu

**Trạng thái:** `[CONFIRMED · FIXED]` · **P0** · Effort M.

### 3.1 Đường chạy sống

```text
ImposerDashboard
  → ImpositionTab
  → processHandlers
  → nup_engine định tuyến imposerMode=cnc
  → cnc_render.run_cnc_two_sided
  → cnc_layout.build_cnc_gang_layout
  → cnc_layout.build_cnc_front_layout
  → _render_cnc_unit
  → PDF [Front, Back nếu có, Cut]

GridPreview
  → POST /imposition/preview-layout
  → build_cnc_front_layout
  → cells + sheetsNeeded
  → nút chuyển tờ chỉ xuất hiện khi response có sheets[].length > 1
```

Các điểm quyết định:

- Có số lượng: `build_cnc_front_layout()` gọi `_ratio_fill_layout()` đúng một packer tại `backend/app/workers/cnc_layout.py:155`; hàm này chỉ dựng một tờ.
- Không số lượng: `solve_auto_fill_mixed()` có thể trả nhiều `sheets`, nhưng CNC chỉ đọc `res['placements']` của tờ đầu tại `backend/app/workers/cnc_layout.py:168`.
- Vòng tính `sheets_needed` tại `backend/app/workers/cnc_layout.py:216-228` bỏ qua mẫu có `cnt == 0`; vì vậy mẫu không đặt được không làm tăng số tờ và cũng không gây lỗi.
- `build_cnc_gang_layout()` chỉ bọc lại kết quả một tờ tại `backend/app/workers/cnc_layout.py:243-287`.
- Nhánh gang tạo đúng một `unit` cho toàn bộ mẫu tại `backend/app/workers/cnc_render.py:489`, rồi render unit đó một lần tại `backend/app/workers/cnc_render.py:517-528`.
- Preview chỉ tuần tự hóa `cnc_layout['placements']` và `sheetsNeeded`, không trả `sheets`, tại `backend/app/api/routes/imposition.py:2022-2065`.
- UI chỉ hiện nút chuyển tờ khi có `layoutResult.sheets.length > 1` tại `desktop/src/components/imposition-tools/sections/GridPreview.tsx:2141-2158`.

### 3.2 Tái hiện bằng helper production

Đầu vào: 5 mẫu `90 × 90`, vùng in `100 × 100`, gap `0`, không xoay. Sức chứa đúng một mẫu/tờ.

Không nhập số lượng:

```text
visible=[0]
placed_by_page={0:1, 1:1, 2:1, 3:1, 4:1}
sheets_needed=1
has_sheets=False
```

Response tự mâu thuẫn: chỉ có cell của trang 1 nhưng `placedByPage` lại tuyên bố cả 5 trang đã được đặt. Nguyên nhân là solver nền đã dựng nhiều tờ và gộp thống kê, còn adapter CNC bỏ `sheets`.

Mỗi mẫu một bản:

```text
visible=[0]
placed_by_page={0:1}
sheets_needed=1
has_sheets=False
```

Bốn mẫu sau biến mất ngay trong layout.

### 3.3 Tái hiện qua API preview thật

Cùng PDF 5 trang, request `imposer_mode='cnc'`, `layout_type='sequential'`:

| Ca | Cells nhìn thấy | `sheetsNeeded` | `sheets[]` | `placedByPage` |
|---|---|---:|---:|---|
| Không nhập SL | `[0]` | 1 | không có | khai đủ `0…4` |
| Mỗi mẫu SL=1 | `[0]` | 1 | không có | chỉ có `0` |

Do response không có `sheets`, GridPreview không thể hiện nút `◄ Tờ n/N ►` dù UI đã hỗ trợ hợp đồng này.

### 3.4 Tái hiện artifact PDF xuất

Harness gọi trực tiếp `run_cnc_two_sided()` với PDF 5 trang có nhãn `MODEL_1…MODEL_5`, một mặt, mỗi mẫu SL=1:

- PDF thực tế có **2 trang**: một Front và một Cut.
- Text mặt Front chỉ có `MODEL_1`.
- `MODEL_2…MODEL_5` không có trong artifact.
- Với sức chứa một mẫu/tờ và chế độ xuất tờ mẫu duy nhất, artifact đúng phải chứa 5 Front + 5 Cut, tức 10 trang.

Đây là lỗi giao file in thiếu nội dung nhưng không báo lỗi, nên xếp **P0** thay vì lỗi hiển thị P1/P2.

## 4. Ma trận các chế độ đã kiểm

| Chế độ | Hợp đồng nhiều tờ hiện tại | Bằng chứng | Phân loại |
|---|---|---|---|
| N-Up `sequential`, một mặt | Mỗi chunk sức chứa là một tờ khác nhau; preview và engine materialize toàn bộ chunk. | `imposition.py:2911-2939`; `nup_engine.py:3264-3415`; ca 31 trang/4-up trả đúng 8 tờ. | `[DISPROVED]` trên working tree hiện tại |
| N-Up `sequential`, hai mặt | Preview trả từng tờ mặt trước; mặt sau được dựng theo cặp sản phẩm. Số tờ vật lý không nhân đôi. | `test_nup_sequential_multi_page.py:137-172`; `test_ratio_stack_nup.py:414-452`. | `[DISPROVED]` |
| N-Up `cut_stacks` | Trả đủ các tờ khác nhau theo công thức cọc; không chỉ giữ tờ 0. | `imposition.py:2852-2871`; test 10 trang/4-up trả 3 tờ với page map khác nhau. | `[DISPROVED]` |
| N-Up `ratio_stack` | Dựng nhiều template khi số loại vượt sức chứa; mỗi template có `runCount`. | `nup_layout_solver.py:369-443`; `imposition.py:2826-2849`; test 72 mẫu trả 4 tờ mẫu. | `[DISPROVED]` |
| Bình trang/S&R `repeat` | Mỗi mẫu được bình thành template riêng; các bản giống nhau có thể thu gọn theo số lượt in. | `nup_engine.py:1805-1883` và metadata theo tờ tại `nup_engine.py:3479-3593`. | `[EXPECTED]` |
| Mixed Guillotine | Plan giữ mọi template; preview materialize front/back một lần và `runCount` mô tả lượt lặp. | `imposition.py:1296-1396`; `test_mixed_guillotine_preview.py:185-267`. | `[DISPROVED]` |
| Bình tem bế trộn, auto-fill/offset | Solver trả `sheets`; engine lặp qua mọi tờ mẫu thay vì chỉ dùng `placements` top-level. | `nup_engine.py:1980-2011` và `:2079-2126`; `test_multi_sheet_overflow.py`. | `[DISPROVED]` |
| Bình tem bế đồng nhất | Preview chia nội dung nguồn qua toàn bộ `_sheets_out_h`. | `imposition.py:2319-2364`; test 45 mẫu/28-up trả 2 tờ và bảo toàn đủ mẫu. | `[DISPROVED]` |
| Chia cụm/tile/zone | Cùng `compute_cluster_sheets()` cho preview và output; các tờ nằm trong `sheets`. | `imposition.py:1857-1951`; `nup_engine.py:1285-1528` và `:2448-2697`. | `[DISPROVED]` trong ca đại diện |
| Chia cọc theo loại | Một template cố định lặp nhiều tờ; `ratioUnplaced` công khai loại không có chỗ. | `imposition.py:2550-2607`; `test_guillotine_preview_live_pages.py:155-189`. | `[EXPECTED]` |
| Bình nguyên tấm | Mỗi mẫu là nguyên tấm; test artifact khóa trang in/khuôn, pont và giới hạn nhiều khổ. Không có bài toán tràn ô cùng loại. | `test_page_sheet_imposition.py`. | `[EXPECTED]` |
| Booklet/đóng cuốn | `generateBindingMap()` tạo toàn bộ `VirtualSheet`; Sheet Viewer giữ `currentSheetIdx`, nút trước/sau và danh sách mọi tờ. | `VirtualMap.ts:45-216`; `SheetViewerDialog.tsx:490-830`. | `[DISPROVED]` ở tầng map/consumer |
| CNC `repeat` | Mỗi trang mặt trước là một unit riêng. | `cnc_render.py:487`. | `[DISPROVED]` trong hợp đồng hiện tại |
| CNC Dàn nhiều mẫu | Mỗi tờ mẫu khác nhau có unit riêng; preview trả `sheets[]`; artifact render đủ Front/[Back]/Cut. | Mục 3 và mục 7. | `[CONFIRMED · FIXED]` |

`[DISPROVED]` ở đây nghĩa là giả thuyết “chỉ giữ tờ đầu” đã bị bác bỏ trong đường chạy và ca đại diện đã kiểm, không phải chứng nhận mọi hình học/marks/report của mode đều hoàn hảo.

## 5. Verify đã chạy

### Backend

Nhóm test đại diện gồm sequential/cut-stacks/duplex, ratio-stack, mixed guillotine, sticker overflow, homogeneous sticker, cluster, CNC hiện có, page sheet và booklet scheduler:

- Kết quả sau sửa: **116/116 ca đạt**.
- Lần chạy audit ban đầu có một `Hypothesis FailedHealthCheck: too_slow` ở property CNC, không có assertion sai; chạy riêng property đó đạt. Bộ final không còn cảnh báo health-check này.

### Frontend

- `GridPreview.mixedDuplex.test.tsx` + `SheetViewerDialog.grid.test.ts`: **8/8 đạt**.
- TypeScript typecheck sau bản sửa CNC đạt.

### Artifact

- Đã tạo và parse lại PDF CNC 5 mẫu như mục 3.4; lỗi mất mẫu xuất hiện trong file thật.
- Chưa chạy thao tác tay toàn ma trận trên app Tauri, chưa build installer và chưa in/cắt vật lý.

## 6. Lô sửa đã duyệt và triển khai

Đã giữ đúng một lô 5 file:

1. `backend/app/workers/cnc_layout.py`: contract nhiều tờ, run count riêng từng template, giữ shape metadata và công khai `unplaced_pages`.
2. `backend/app/workers/cnc_render.py`: render từng template thành Front/[Back]/Cut và fail-closed nếu thiếu dù chỉ một mẫu bắt buộc.
3. `backend/app/api/routes/imposition.py`: trả đủ `sheets[]`, `runCount`, `physicalSheetIndex`; top-level vẫn là tờ đầu để tương thích.
4. `backend/tests/test_cnc_multi_template.py`: khóa helper, API, artifact một/hai mặt, có/không SL và ca không thể đặt đủ.
5. `desktop/src/components/imposition-tools/sections/GridPreview.mixedDuplex.test.tsx`: khóa nút chuyển tờ CNC và không fetch lại backend.

Điều kiện nghiệm thu:

- 5 mẫu/1 mẫu mỗi tờ: preview có 5 tờ, artifact một mặt có 10 trang Front/Cut và phủ đủ `MODEL_1…MODEL_5`.
- Hai mặt: mỗi template có đúng Front/Back/Cut, mặt sau giữ phép lật long/short hiện tại.
- Không nhập SL và có SL đều không rơi mẫu; `placedByPage`, `sheetsNeeded`, `sheets[].runCount` không tự mâu thuẫn.
- Bộ test N-Up/Sticker/Mixed/Booklet hiện có vẫn xanh; typecheck đạt; parse/raster lại artifact trước khi báo xong.

## 7. Kết quả sau sửa

- 5 mẫu `90 × 90` trên vùng in `100 × 100`: helper và API trả 5 tờ theo `pageIdx` `0…4`, cả khi có và không nhập SL.
- Artifact một mặt có đúng 10 trang: `Front 1, Cut 1, …, Front 5, Cut 5`; parse text phủ đủ `MODEL_1…MODEL_5`.
- Artifact hai mặt 3 sản phẩm có đúng 9 trang và giữ đủ ba cặp Front/Back cùng ba trang Cut.
- Mẫu vượt khổ trong một job có mẫu khác vẫn đặt được nay trả lỗi tiếng Việt, không xuất PDF thiếu âm thầm.
- GridPreview chuyển `Tờ 1/2 → Tờ 2/2` từ dữ liệu đã nhận, không gọi lại backend.
- Verify cuối: backend bình trang liên quan **116 passed**; frontend GridPreview + Sheet Viewer **8 passed**; TypeScript typecheck đạt; diff check đạt.
