# Implementation Plan: CNC ghép nhiều mẫu (cnc-multi-template)

## Overview

Kế hoạch triển khai theo đúng kiến trúc Thiết kế: tách **Layout_Helper dùng chung** (`cnc_layout.py`) làm nguồn chân lý duy nhất, refactor `cnc_render` để gom Mặt trước → 1 cụm trang, bổ sung nhánh preview CNC trong `imposition.py`, và cập nhật GridPreview/Dashboard/Store cho 3 chế độ lật xem + ô SL theo trang chẵn.

Thứ tự thực hiện: **helper + test (nền tảng) → cnc_render → preview backend → frontend → integration/regression**. Mỗi bước cốt lõi đi kèm sub-task viết property test (hypothesis) hoặc unit/spy test theo bảng ánh xạ Property→Test trong Thiết kế (9 properties). Mỗi property test gắn tag `Feature: cnc-multi-template, Property N`.

Ngôn ngữ: **Python** (backend) và **TypeScript/React** (frontend).

## Tasks

- [ ] 1. Tạo Layout_Helper và công thức căn giữa dùng chung
  - [ ] 1.1 Tạo module `backend/app/workers/cnc_layout.py` với `_center_placements` và `build_cnc_front_layout`
    - Viết `_center_placements(...)`: rút công thức căn giữa bbox trên usable area (lề dư trái = phải, trên = dưới), trả `abs_x`, `abs_y`, `original_cell_y` và `cell` (sheet-abs, top-down) đúng cấu trúc placement của `cnc_render`
    - Viết `build_cnc_front_layout(page_dims_qty, usable_w, usable_h, gap, margin_left, margin_bottom, margin_top, allow_rotation)`: chọn solver theo tổng SL (`>0` → `solve_offset_mixed`; `==0` → `solve_auto_fill_mixed`, `sheets_needed=1`), gán `src_page_idx` cho từng ô, trả `{placements, cells, items_per_sheet, placed_by_page, sheets_needed}`
    - Xử lý biên: `page_dims_qty` rỗng → `placements=[]`, `sheets_needed=0`; bắt lỗi solver → layout rỗng-an-toàn
    - _Requirements: 2.1, 2.2, 5.1_

  - [ ]* 1.2 Viết property test cho `build_cnc_front_layout`
    - **Property 4: Chọn solver theo số lượng và căn giữa tờ**
    - **Validates: Requirements 2.1, 2.2, 5.1**
    - Tag: `Feature: cnc-multi-template, Property 4`
    - Tối thiểu 100 iteration; generator phủ số mẫu 1..N, kích thước ô đa dạng, SL hỗn hợp (0 và >0); kiểm chứng selector + bbox căn giữa đối xứng (sai số làm tròn)

  - [ ] 1.3 Refactor `_build_placements` trong `cnc_render.py` để gọi `_center_placements` dùng chung
    - Thay đoạn căn giữa nội bộ bằng `_center_placements`, giữ nguyên hành vi/đầu ra cho các test hiện hữu
    - Bảo đảm `cnc_render` và helper dùng đúng một công thức căn giữa
    - _Requirements: 5.1, 5.2_

  - [ ]* 1.4 Viết unit test xác nhận refactor giữ nguyên hành vi `_build_placements`
    - So sánh đầu ra trước/sau refactor trên vài layout cố định
    - _Requirements: 5.2_

- [ ] 2. Bổ sung hàm chọn trang Mặt trước và lật gương cụm trong `cnc_render.py`
  - [ ] 2.1 Viết `_select_front_pages(page_count, two_sided)`
    - 1 mặt: `front_idxs=[0..n-1]`, `back_of[i]=None`; 2 mặt: `front_idxs=[0,2,4,...]`, `back_of[i]=i+1`
    - _Requirements: 1.1, 1.2, 1.3_

  - [ ]* 2.2 Viết property test cho `_select_front_pages`
    - **Property 1: Chọn tập trang Mặt trước và liên kết Mặt sau**
    - **Validates: Requirements 1.1, 1.2, 1.3, 6.2**
    - Tag: `Feature: cnc-multi-template, Property 1`
    - Generator phủ `page_count` chẵn/lẻ, 1 mặt/2 mặt; tối thiểu 100 iteration

  - [ ] 2.3 Viết `mirror_placements_multi(front_pl, sheet_w, sheet_h, flip_edge, back_of)`
    - Gọi `mirror_placements` (tái dùng, giữ nguyên công thức lật long/short) cho từng ô và gán `src_page_idx = back_of[front_src]` (front_src+1) cho đúng mẫu của ô đó
    - _Requirements: 3.1, 3.3, 3.4, 2.4_

  - [ ]* 2.4 Viết property test cho `mirror_placements_multi`
    - **Property 3: Mỗi ô Mặt sau khớp ô Mặt trước tương ứng**
    - **Validates: Requirements 2.4, 3.3, 3.4**
    - Tag: `Feature: cnc-multi-template, Property 3`
    - Kiểm số ô bằng nhau, đối xứng vị trí theo cạnh lật, `src_page_idx` = front+1, số ô mỗi mẫu giữ nguyên; tối thiểu 100 iteration

  - [ ]* 2.5 Mở rộng property test cho `mirror_placements` (long/short + involution)
    - **Property 2: Lật gương là đối xứng và involution**
    - **Validates: Requirements 3.1, 3.4**
    - Tag: `Feature: cnc-multi-template, Property 2`
    - Kiểm tâm-X/tâm-Y đối xứng qua trục giữa theo cạnh lật; lật hai lần trả về vị trí ban đầu; tối thiểu 100 iteration

- [ ] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Refactor `run_cnc_two_sided` sang gom Mặt trước → 1 cụm trang
  - [ ] 4.1 Đổi luồng chính sang gom Mặt trước và gọi Layout_Helper
    - Validate 2 mặt + trang lẻ → `ValueError` (giữ nguyên); chọn `front_idxs/back_of` qua `_select_front_pages`; tính `trim` + SL từng mẫu lấy theo trang Mặt trước; gọi `build_cnc_front_layout`; render Mặt trước bằng `place_one_artwork` theo `src_page_idx` từng ô
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.3, 5.2_

  - [ ] 4.2 Dựng trang Mặt sau bằng lật gương cả cụm
    - Khi 2 mặt: gọi `mirror_placements_multi` rồi `place_one_artwork` theo `src_page_idx` Mặt sau; mặc định cạnh lật `long`
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [ ] 4.3 Dựng trang Khuôn gộp đường bế theo `src_page_idx` từng ô
    - Lấy `die_items` cache theo mẫu của ô; `draw_die_lines_for_placement` + `finish` per placement; bỏ qua ô không có đường bế (log cảnh báo)
    - _Requirements: 4.1_

  - [ ] 4.4 Wiring boong/duplex và report theo cụm trang
    - Boong: chỉ Mặt trước + Khuôn (không Mặt sau); duplex: Mặt trước + Mặt sau khi 2 mặt; report ghi tổng tờ = `sheets_needed`; output đúng 1 cụm `[Front,Back,Cut]` (2 mặt) hoặc `[Front,Cut]` (1 mặt), không lặp theo số tờ
    - _Requirements: 4.2, 4.3, 4.4, 7.1, 7.2, 7.3, 7.4_

  - [ ]* 4.5 Viết property test cấu trúc cụm trang output
    - **Property 8: Output đúng một cụm trang, độc lập số tờ**
    - **Validates: Requirements 7.1, 7.2, 7.3**
    - Tag: `Feature: cnc-multi-template, Property 8`
    - Dùng PDF tối giản; kiểm `page_count==3` (2 mặt) / `==2` (1 mặt) độc lập `sheets_needed`; tối thiểu 100 iteration

  - [ ]* 4.6 Viết property test report số tờ
    - **Property 9: Report ghi số tờ theo sheets_needed**
    - **Validates: Requirements 7.4**
    - Tag: `Feature: cnc-multi-template, Property 9`
    - Kiểm chuỗi report chứa tổng tờ == `sheets_needed`; tối thiểu 100 iteration

  - [ ]* 4.7 Viết property test đếm đường bế khuôn gộp (spy)
    - **Property 7: Khuôn gộp đúng số đường bế theo từng mẫu**
    - **Validates: Requirements 4.1**
    - Tag: `Feature: cnc-multi-template, Property 7`
    - Monkeypatch/spy `draw_die_lines_for_placement`; kiểm tổng số lần vẽ = số ô có đường bế và nhóm theo mẫu khớp `placed_by_page`; tối thiểu 100 iteration

  - [ ]* 4.8 Viết property test SL lấy từ trang Mặt trước
    - **Property 5: Số lượng của mẫu lấy từ trang Mặt trước**
    - **Validates: Requirements 2.3**
    - Tag: `Feature: cnc-multi-template, Property 5`
    - Kiểm SL dùng để trộn lấy theo trang chẵn, SL trang lẻ bị bỏ qua; tối thiểu 100 iteration

  - [ ]* 4.9 Viết example/spy test cho default & side-effect
    - Default cạnh lật `long` (Yêu cầu 3.2); boong chỉ Front+Cut, không Back (4.2/4.3 — spy); duplex Front+Back khi 2 mặt (4.4 — spy); 2 mặt + trang lẻ → `ValueError` nêu số trang (1.4)
    - _Requirements: 3.2, 4.2, 4.3, 4.4, 1.4_

- [ ] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Bổ sung nhánh preview CNC trong backend
  - [ ] 6.1 Mở rộng `PreviewLayoutRequest` trong `imposition.py`
    - Thêm `imposer_mode: Optional[str]=None`, `cnc_two_sided: Optional[bool]=False`, `cnc_flip_edge: Optional[str]="long"` (giữ `extra='forbid'`, default an toàn cho client cũ)
    - _Requirements: 5.3_

  - [ ] 6.2 Thêm sub-branch CNC trong nhánh `is_nup_multi`
    - Khi `imposer_mode=='cnc'`: chỉ bin-pack trang Mặt trước (trang chẵn nếu 2 mặt) qua `build_cnc_front_layout`; trả `cells` (sheet-abs, top-down) + meta `isCncPreview/cncTwoSided/cncFlipEdge/sheetW/sheetH/sheetsNeeded`; KHÔNG tính Mặt sau ở backend; giữ nguyên nhánh non-CNC mixed
    - _Requirements: 5.3, 6.2, 9.1_

  - [ ]* 6.3 Viết property test preview khớp output
    - **Property 6: Preview khớp output**
    - **Validates: Requirements 5.3, 6.3, 6.4**
    - Tag: `Feature: cnc-multi-template, Property 6`
    - Cùng input gọi helper từ 2 đường (preview vs render) → khớp từng ô (vị trí, size, cờ xoay, `src_page_idx`/`pageIdx`); số ô từng mẫu = `placed_by_page`; tối thiểu 100 iteration

  - [ ]* 6.4 Viết regression test nhánh preview non-CNC không đổi
    - Kiểm nhánh mixed non-CNC trả kết quả như trước (Yêu cầu 9.1)
    - _Requirements: 9.1_

- [ ] 7. Cập nhật frontend GridPreview / Dashboard / Store
  - [ ] 7.1 Sửa `GridPreview.tsx`: 3 chế độ lật xem + props CNC + lật gương SVG
    - Thêm props `imposerMode/cncTwoSided/cncFlipEdge`; gửi `imposer_mode/cnc_two_sided/cnc_flip_edge` trong body fetch; state `viewMode: front|back|cut` + 3 nút (chỉ hiện khi `isCncPreview`); với mixed CNC vẽ trực tiếp cells sheet-abs (bỏ tự căn giữa); Mặt sau = lật gương cụm Front trong toạ độ SVG theo cạnh lật; Khuôn = outline đỏ không tô nền
    - _Requirements: 6.1, 6.3, 6.4_

  - [ ] 7.2 Sửa `ImposerDashboard.tsx` truyền cờ CNC xuống GridPreview
    - Khi `activeTool==='cnc_imposer'` truyền `imposerMode='cnc'`, `cncTwoSided`, `cncFlipEdge`
    - _Requirements: 6.1_

  - [ ] 7.3 Lọc ô nhập SL theo trang chẵn (store + GridSettingsSection)
    - 2 mặt: chỉ hiển thị ô SL cho trang Mặt trước (trang chẵn), ẩn trang Mặt sau; 1 mặt: hiển thị mọi trang; SL ghi vào `targetQuantitiesByPage`
    - _Requirements: 8.1, 8.2, 8.3_

  - [ ]* 7.4 Viết component test (Vitest) cho GridPreview
    - Kiểm 3 chế độ lật xem (front/back/cut) và hiển thị ô SL chỉ ở trang chẵn khi 2 mặt, mọi trang khi 1 mặt
    - _Requirements: 6.1, 8.1, 8.2, 8.3_

- [ ] 8. Integration và regression
  - [ ] 8.1 Viết smoke test dispatch CNC
    - Kiểm `imposerMode=='cnc'` định tuyến tới `cnc_render.run_cnc_two_sided` (không qua nhánh trộn `nup_engine`)
    - _Requirements: 5.4_

  - [ ]* 8.2 Chạy full suite backend + typecheck frontend (regression)
    - Chạy `pytest` toàn bộ backend và `npm run typecheck` để bảo đảm không hồi quy Bình Tem Bế / N-Up / Booklet
    - _Requirements: 9.2, 9.3_

- [ ] 9. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks đánh dấu `*` là tùy chọn (test) và có thể bỏ qua khi cần MVP nhanh; task cốt lõi không bao giờ đánh dấu `*`.
- Mỗi task tham chiếu sub-requirement cụ thể để truy vết.
- Property tests xác thực 9 correctness properties theo bảng ánh xạ trong Thiết kế; chạy tối thiểu 100 iteration và gắn tag `Feature: cnc-multi-template, Property N`.
- Side-effect (boong/duplex), toggle UI và dispatch dùng example/spy/smoke thay vì PBT.
- Checkpoint bảo đảm xác thực tăng dần; task 8.2 chốt không hồi quy các công cụ hiện có (Yêu cầu 9).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "7.1", "7.2", "7.3"] },
    { "id": 1, "tasks": ["1.2", "1.3", "6.1", "7.4"] },
    { "id": 2, "tasks": ["1.4", "2.1", "6.2"] },
    { "id": 3, "tasks": ["2.2", "2.3", "6.3", "6.4"] },
    { "id": 4, "tasks": ["2.4", "2.5", "4.1"] },
    { "id": 5, "tasks": ["4.2"] },
    { "id": 6, "tasks": ["4.3"] },
    { "id": 7, "tasks": ["4.4"] },
    { "id": 8, "tasks": ["4.5", "4.6", "4.7", "4.8", "4.9", "8.1"] },
    { "id": 9, "tasks": ["8.2"] }
  ]
}
```
