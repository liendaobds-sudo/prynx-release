# Audit Bình tem bế — clip mask mép biên và căn giữa (2026-09-13)

Phạm vi: một tem bế tròn, bù xén 2 mm (bleed 1 mm mỗi phía), gap 2 mm, sole/stagger trên khổ tờ. Đây là audit read-only; chưa sửa production.

## Đường chạy đã trace

`nup_process_chunk.process_chunk()` → dựng `placements` → mirror duplex (nếu có) → render phase → `place_one_artwork()` trong `backend/app/workers/nup_artwork.py` → `show_pdf_page(... out_clip/out_clip_path ...)`.

- `backend/app/workers/nup_process_chunk.py:901-904`: chỉ tính `compute_output_clips(placements, bleed_pt)` khi `not is_die_cut and not page_sheet_mode`.
- `backend/app/workers/nup_process_chunk.py:903-905`: tem bế (`is_die_cut`) dùng `compute_block_bbox(placements)` thay thế.
- `backend/app/workers/nup_artwork.py:853-919`: `compute_output_clips()` chia bleed theo láng giềng hình học toàn tờ; cạnh không có láng giềng giữ full bleed, seam nhận tối đa nửa gap.
- `backend/app/workers/nup_artwork.py:1111-1128`: nhánh legacy của tem bế quyết định mép ngoài theo bbox `(cluster_idx, blockId)`; mọi placement ở mép bbox nhận full bleed.
- `backend/app/workers/nup_artwork.py:1328-1436`: clip được truyền vào writer (`out_clip`/clip theo hình).
- `desktop/src/lib/imposerEngine/NupRenderer.ts:420-448`: preview cũng xác định mép theo block cục bộ, không theo láng giềng toàn tờ.

## Phát hiện

### [VERIFIED] P1 — Tem bế vi phạm contract: full bleed chỉ được phép ở bình bài xén

Bằng chứng code: điều kiện tại `nup_process_chunk.py:901` loại toàn bộ `is_die_cut` khỏi `compute_output_clips()`. Sau đó `place_one_artwork()` dùng bbox của từng `(cluster_idx, blockId)` (`nup_artwork.py:1111-1128`). Nhánh này cho phép `_is_left/_is_right/_is_top/_is_bottom` nhận `bleed_pt` đầy đủ. Điều đó phù hợp với bình bài xén, nhưng **trái contract tem bế**: mọi cạnh của tem bế phải bị clipmask đồng nhất; không cạnh nào được đặc cách full bleed theo block/cụm. Với tem tròn/sole, rectangle clip sau đó cắt phần bleed không đồng nhất, phù hợp trực tiếp với hiện tượng user mô tả.

Đây là lỗi correctness trên artifact xuất, chưa được nâng lên `ARTIFACT/RUNTIME` vì lượt này chưa có PDF mẫu để raster đo.

### [VERIFIED] P1 — Preview và output cùng chia sẻ quy ước mép cục bộ, nên có thể cùng tái hiện hình “lạ”

`NupRenderer.ts:420-448` dùng `renderBlocks`/`blockId` để chọn `isTop/Bottom/Left/Right`; backend dùng `compute_block_bbox`. Hai bên không có phép tính láng giềng toàn sheet cho die-cut. Do đó việc preview “trông hợp lý/khác nhẹ” không bác bỏ lỗi writer; cần so artifact thật.

### [SUSPECTED] P1 — Lệch tâm là lỗi layout độc lập hoặc hệ quả quan sát từ clip

`nup_process_chunk.py:350-370` căn `super_grid_w/super_grid_h` vào `sheet_usable_w/sheet_usable_h`, còn placement trim dùng `abs_x/original_cell_y`; bleed/clip không được đưa vào phép căn giữa. Nếu yêu cầu căn giữa tính theo vùng bleed ngoài cùng, layout hiện tại có thể lệch đúng bằng phần bleed bất đối xứng. Cần log/render đo `min/max` trim và clip trên PDF để phân biệt: (a) trim grid lệch thật, hay (b) trim đã giữa nhưng artwork/bleed bị clip lệch.

## Khoảng trống xác minh

- Chưa có input PDF + JSON placements của ca 2 mm/2 mm để chạy lại.
- Chưa raster hóa PDF xuất và đo khoảng cách từng clip tới seam/biên tờ.
- Chưa xác nhận sole có placement xoay 90° hay duplex mirror; các nhánh này có thể đổi trục clip.

## Đề xuất lô sửa (chờ duyệt)

1. Tách contract rõ ràng: `compute_output_clips()`/full bleed chỉ dành cho bình bài xén; tem bế phải dùng clipmask đồng nhất theo gap/bleed (không kiểm tra mép block để nới full bleed).
2. Đồng bộ preview theo manifest clip đã giải từ backend, tránh hai thuật toán mép cục bộ.
3. Thêm regression test: tem tròn sole, gap=2 mm, bleed=1 mm; kiểm mỗi seam tổng clip đúng gap và kiểm bounding box trim/clip đối xứng quanh tâm tờ.
4. Chạy artifact test/raster trước khi cập nhật golden master; runtime app thật còn cần xác minh.

## Trạng thái

Đã sửa theo yêu cầu người dùng:

- `backend/app/workers/nup_artwork.py`: tem bế không còn dải chữ nhật `block_rect`, giữ contour clip theo hình.
- `backend/app/workers/nup_process_chunk.py`: căn lại bbox placement thực tế của cụm tem bế vào tâm vùng sử dụng sau khi cắt số lượng.
- Regression clip shape: 15 test pass.

Mức bằng chứng: `SOURCE + AUTO · cần chạy lại artifact/runtime ca tem tròn thực tế`.

## Ghi chú lỗi preview HTTP 422 (2026-09-13)

Ảnh UI `Không thể tính preview (422)` không đủ để kết luận lỗi hình học. Endpoint `/api/imposition/preview-layout` có nhiều chốt từ chối hợp lệ (schema FastAPI, manual grid vượt vùng giấy, kích thước/khổ không hợp lệ, nguồn nesting thiếu hoặc job không dựng được). Trước đây UI chỉ đọc `detail` dạng chuỗi; lỗi schema FastAPI trả `detail` dạng mảng nên bị che thành thông báo chung. Đã sửa `GridPreview.tsx` để hiển thị `loc: msg` của từng lỗi validation. Cần chạy lại preview sau khi rebuild frontend để thu được nguyên nhân cụ thể của ca người dùng.
