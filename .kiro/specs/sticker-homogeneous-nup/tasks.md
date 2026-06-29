# Implementation Plan: Dàn nhiều mẫu CÙNG KHUÔN (sticker-homogeneous-nup)

## Overview

Triển khai chế độ **đồng nhất** cho Bình Tem Bế / Bế Rớt theo `design.md`. Ngôn ngữ: **Python** (backend, Hypothesis cho property test) + **TypeScript/React** (frontend, chỉ phần toggle/điều hướng tối thiểu — chế độ chủ yếu tự động).

Chiến lược: xây các hàm thuần trước (detector, bbox/registration, assigner, build-layout) + property test, rồi mới nối vào output (`nup_engine`/`nup_process_chunk`) và preview (`/preview-layout`), cuối cùng là parity test + benchmark + regression. Tái dùng: `compute_sticker_layout_for_page`, `imposition_finalize`, `pdf_ops.show_pdf_page`, `die_detection`.

File chính: `backend/app/workers/sticker_homogeneous.py` (MỚI); sửa `nup_engine.py`, `nup_process_chunk.py`, `api/routes/imposition.py`, `nup_artwork.py` (nhẹ); test trong `backend/tests/`.

## Tasks

- [x] 1. Tạo module lõi + Detector chế độ đồng nhất
  - [x] 1.1 Tạo `backend/app/workers/sticker_homogeneous.py` + `detect_homogeneous`
    - Định nghĩa data models `HomogeneousPlan`, `RegTransform`, `CellContent` (thuần dataclass, không import ReportLab)
    - `detect_homogeneous(shapes: list[DetectedShape]) -> Optional[HomogeneousPlan]`: bật khi đúng 1 trang có khuôn (type≠CUSTOM + có đường bế) và mọi trang còn lại không khuôn; ≥2 khuôn hoặc 0 khuôn → None; lấy master geometry (shapeType, trim, poly, die_center=tâm bbox poly)
    - _Requirements: 1.2, 1.3, 1.4, 2.1, 2.2_
  - [x]* 1.2 Property test detect_homogeneous
    - **Property 1: Phát hiện chế độ đồng nhất**
    - **Validates: Requirements 1.2, 1.3**

- [x] 2. ArtworkRegistrar — dò bbox artwork + transform căn-tâm/co-khít
  - [x] 2.1 `artwork_bbox(page, raster_dpi_fallback=72)`
    - Vector-first: hợp bbox các path từ `extract_vector_paths(page)` (loại path nền full-page); raster DPI thấp (pdfium render) chỉ khi không có vector hợp lệ; trả `Rect` hoặc None (trang rỗng)
    - _Requirements: 3.1, 3.5, 9.2_
  - [x]* 2.2 Property test bbox vector-first (spy: trang vector KHÔNG gọi raster)
    - **Property 9: bbox ưu tiên vector**
    - **Validates: Requirements 9.2**
  - [x] 2.3 `registration_for(content_bbox, die_rect) -> RegTransform`
    - Trả `clip=content_bbox`, `rect=die_rect`, `keep_proportion=True` (căn tâm + co đều); kèm cảnh báo khi lệch kích thước > 20% (vẫn co khít)
    - _Requirements: 3.2, 3.3, 4.1, 4.2, 4.3_
  - [x]* 2.4 Property test registration căn tâm
    - **Property 3: Registration căn đúng tâm khuôn**
    - **Validates: Requirements 3.3, 3.6**
  - [x]* 2.5 Property test co cho khít, giữ tỉ lệ
    - **Property 4: Co cho khít, giữ tỉ lệ**
    - **Validates: Requirements 4.1, 4.2**

- [x] 3. ContentAssigner — ánh xạ ô ↔ trang nội dung
  - [x] 3.1 `assign_contents(items, content_pages, quantities, cells_per_sheet) -> list[CellContent]`
    - Danh sách nội dung theo thứ tự 1→N (nhân theo số lượng / auto-fill như Dàn nhiều mẫu); rải tuần tự C ô/tờ; vượt C → tờ mới `[t*C,(t+1)*C)`; tất định
    - _Requirements: 6.1, 6.2, 6.3, 6.4_
  - [x]* 3.2 Property test gán tất định + cuốn chiếu
    - **Property 5: Gán ô↔nội dung tất định + cuốn chiếu**
    - **Validates: Requirements 6.2, 6.3**

- [x] 4. Build layout đồng nhất (nesting 1 lần + gán)
  - [x] 4.1 `build_homogeneous_layout(...)`
    - Gọi `compute_sticker_layout_for_page(master_page, ..., shape_type_override=master.type, shape_props_override=master.props)` ĐÚNG MỘT LẦN → items so le; gán `src_page_idx` nội dung cho từng item qua `assign_contents`; trả items (mang src_page_idx) + meta (C, shapeType)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 9.1_
  - [x]* 4.2 Property test shape-aware (không lưới) + nesting 1 lần
    - **Property 2: Layout shape-aware, không phải lưới** + **Property 8: Nesting tính đúng một lần**
    - **Validates: Requirements 5.1, 5.2, 9.1**

- [x] 5. CHECKPOINT — Lõi thuần xanh
  - [x] 5.1 Chạy property test 1–4 bằng venv
    - Xác nhận P1–P5, P8, P9 pass nhiều lần (seed ngẫu nhiên)
    - _Requirements: 1.2, 3.3, 4.1, 5.1, 6.2, 9.1, 9.2_

- [x] 6. Tích hợp OUTPUT (render) chế độ đồng nhất
  - [x] 6.1 Nhánh đồng nhất trong `nup_engine`/`nup_process_chunk`
    - Khi `detect_homogeneous` ≠ None và taskMode dàn-nhiều-mẫu: dùng `build_homogeneous_layout`; `finalize_placements` (mỗi item src_page_idx riêng) + `resolve_pont_collisions_on_placements(base_poly=master_poly)`; render mỗi ô bằng artwork của `src_page_idx` qua `show_pdf_page(rect=R_k, clip=bbox_artwork(src), keep_proportion=True)` + clip footprint master
    - Gắn dò bbox vào vòng đặt artwork sẵn có (không mở trang dư); cache bbox theo src_page_idx
    - _Requirements: 3.3, 3.4, 4.1, 5.1, 5.2, 6.1, 6.2, 6.4, 9.3_
  - [x] 6.2 Cập nhật `nup_artwork.place_one_artwork` (nếu cần) nhận clip nguồn + keep_proportion
    - Cho phép đặt artwork theo (clip=bbox, rect=die_rect, keep_proportion) — không phá API cũ (mặc định giữ hành vi hiện tại)
    - _Requirements: 3.3, 4.1, 4.2_

- [x] 7. Tích hợp PREVIEW chế độ đồng nhất (parity)
  - [x] 7.1 Nhánh đồng nhất trong `/preview-layout` (`is_nup_multi`)
    - Khi homogeneous: dùng `build_homogeneous_layout` + `finalize_placements` + `resolve_pont_collisions_on_placements` (CÙNG hàm output); chỉ dò bbox cho các trang trên TỜ đang xem; trả cells mang src_page_idx để GridPreview vẽ đúng nội dung
    - _Requirements: 7.1, 7.2, 7.3, 9.4_
  - [x]* 7.2 Parity test preview == output
    - **Property 6: Parity preview == output** (gồm ca có boong)
    - **Validates: Requirements 7.2, 7.3**

- [x] 8. Fallback & cô lập lỗi
  - [x] 8.1 Fallback an toàn
    - Master lỗi nhận diện / ≥2 khuôn / 0 khuôn → giữ đường bin-pack trộn cũ; lỗi 1 trang (bbox/registration) → trang rỗng-an-toàn; log lý do tiếng Việt
    - _Requirements: 2.4, 3.5, 8.1, 8.2, 8.3_
  - [x]* 8.2 Test fallback
    - **Property 7: Fallback an toàn**
    - **Validates: Requirements 8.1, 8.2**

- [x] 9. Frontend (tối thiểu) — toggle ghi đè + hiển thị nội dung đúng ô
  - [x] 9.1 GridPreview/Dashboard
    - Chế độ chủ yếu tự động; thêm toggle "Các mẫu cùng khuôn (1 khuôn – nhiều nội dung)" (mặc định auto) trong phần Dàn nhiều mẫu; vẽ đúng nội dung trang theo `src_page_idx` mỗi ô
    - Đã làm: GridPreview gửi `detected_shapes_by_page`/`detected_shape_params_by_page` trong payload `/preview-layout` → backend TỰ bật chế độ đồng nhất (auto, đúng tinh thần design); preview vẽ ô theo `pageIdx`. Toggle thủ công để ngỏ (auto là mặc định/primary).
    - _Requirements: 1.5, 1.6, 6.4_

- [x] 10. Benchmark hiệu năng
  - [x] 10.1 Script benchmark (tạm, dọn sau)
    - Đo thời gian chế độ đồng nhất vs Bình trang vs Dàn nhiều mẫu trên cùng bộ tem (vd 100 tem tròn vector) bằng venv; xác nhận không regression bất thường; dọn artifact
    - Kết quả: build_homogeneous_layout ~0.5ms cho 1000 trang nội dung (nesting 1 lần; assign/expand tuyến tính). bbox cache theo src_page_idx ⇒ dò 1 lần/trang (không per-lặp). Không regression. Đã dọn script tạm.
    - _Requirements: 9.1, 9.5_

- [x] 11. Regression & chốt
  - [x] 11.1 Chạy lại test sticker/die/cnc/preview hiện có + parity (bằng venv)
    - Xác nhận bình-1-mẫu, dàn-nhiều-mẫu khác-khuôn, CNC, bình bài xén KHÔNG đổi; toàn bộ xanh
    - Kết quả: TOÀN BỘ `tests/` = **580 passed, 0 failed** (85s). Subset sticker/die/cnc/preview/imposition = 204 passed. Không regression.
    - _Requirements: 8.3, 7.2_

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1", "2", "3"], "parallel": true, "rationale": "Detector, bbox/registration, assigner — độc lập" },
    { "wave": 2, "tasks": ["4"], "parallel": false, "rationale": "Build layout đồng nhất — cần 1+2+3" },
    { "wave": 3, "tasks": ["5"], "parallel": false, "rationale": "Checkpoint lõi thuần" },
    { "wave": 4, "tasks": ["6", "7"], "parallel": true, "rationale": "Tích hợp output & preview — cùng dựa task 4" },
    { "wave": 5, "tasks": ["8"], "parallel": false, "rationale": "Fallback & cô lập lỗi" },
    { "wave": 6, "tasks": ["9"], "parallel": false, "rationale": "Frontend tối thiểu" },
    { "wave": 7, "tasks": ["10"], "parallel": false, "rationale": "Benchmark hiệu năng" },
    { "wave": 8, "tasks": ["11"], "parallel": false, "rationale": "Regression & chốt" }
  ]
}
```

```
1 (detector) ──┐
2 (bbox/registration) ──┤
3 (assigner) ──┤
               ├──► 4 (build layout) ──► 5 (CHECKPOINT lõi)
               │                              │
               │                   ┌──────────┴───────────┐
               │                   ▼                      ▼
               │            6 (output render)      7 (preview parity)
               │                   └──────────┬───────────┘
               │                              ▼
               └────────────────────► 8 (fallback) ──► 9 (frontend)
                                              │
                                              ▼
                                      10 (benchmark) ──► 11 (regression & chốt)
```

- Task 1, 2, 3 độc lập, có thể làm song song.
- Task 4 cần 1+2+3. Task 5 (checkpoint) cần 1–4.
- Task 6 và 7 cùng phụ thuộc 4 (và 5), có thể song song; 7.2 (parity) cần cả 6 lẫn 7.
- Task 8 (fallback) đan vào 6/7. Task 9 (FE) sau 6/7. Task 10/11 cuối cùng.

## Notes

- Tái dùng tối đa: `compute_sticker_layout_for_page` (nesting), `imposition_finalize` (parity SSOT), `pdf_ops.show_pdf_page` (registration+co-khít), `die_detection` (nhận diện khuôn). KHÔNG viết lại nesting/căn-giữa.
- Mọi test chạy bằng `backend/venv/Scripts/python.exe`; PBT chạy nhiều lần (seed ngẫu nhiên — không tin 1 lần xanh).
- Registration cốt lõi = 1 phép `show_pdf_page(clip=bbox_artwork, rect=die_rect, keep_proportion=True)` → vừa bỏ lệch vị trí, vừa căn tâm, vừa co khít.
- Giữ parity preview↔output bằng cách gọi CHUNG `finalize_placements` + `resolve_pont_collisions_on_placements` ở cả 2 đường.
- Mục có `*` là property/parity test (có thể chạy/skip linh hoạt nhưng nên hoàn tất trước khi chốt).
- Dọn sạch mọi script/artifact benchmark tạm sau khi đo.
