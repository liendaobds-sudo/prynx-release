# Implementation Plan — Die Shape Detection SSOT

## Overview

Kế hoạch hiện thực nguyên lý **"Detect once, flow everywhere"** theo đúng **5 phase migration** trong design (Phase 0 → 4). Mỗi phase tự đứng được (self-contained) và **backward compatible**; phase sau dựa trên bất biến phase trước đã thiết lập.

Ngôn ngữ hiện thực: **Python** (backend FastAPI + worker) và **Rust** (`imposition_core` qua `pdfcompare_native`) — theo đúng module map của design.

Quy ước:
- Task con đánh dấu `*` là **test (property/unit/smoke/integration), tuỳ chọn** cho MVP nhanh; agent KHÔNG tự động hiện thực task `*`.
- Property test Python dùng **Hypothesis**, Rust dùng **proptest**; mỗi test gắn tag `# Feature: die-shape-detection-ssot, Property {n}: ...`.
- Ràng buộc xuyên suốt: **không hồi quy solver Rust hiện có** (giữ nguyên chữ ký/kiểu trả về/hành vi lỗi), **giữ fail-fast `require_rust`**, **mỗi phase backward compatible**.

## Tasks

- [ ] 1. Phase 0 — Đặt nền: contract + enum + parity guard
  - [x] 1.1 Tạo enum `ShapeType` thống nhất tại `backend/app/workers/shape_types.py`
    - Định nghĩa đúng 11 giá trị: CIRCLE_ELLIPSE, TRIANGLE, RECTANGLE, PENTAGON, HEXAGON, DUMBBELL, HAMMER, TRAPEZOID, PARALLELOGRAM, ARROW, CUSTOM (không thêm giá trị khác)
    - Là vị trí định nghĩa enum DUY NHẤT trong mã nguồn
    - _Requirements: 10.1, 10.4_

  - [x] 1.2 Ánh xạ enum cũ → enum thống nhất và bỏ định nghĩa trùng
    - Thêm bảng ánh xạ theo TÊN từ `shape_analyzer.ShapeType` (9 giá trị) và `shape_classifier.ShapeType` (11 giá trị) sang enum thống nhất
    - Thay mọi tham chiếu enum cũ ở `shape_classifier.py`/`shape_analyzer.py` bằng import từ `shape_types`
    - Tham chiếu giá trị ngoài tập 11 → lỗi tại import-time với thông báo nêu rõ tên giá trị
    - _Requirements: 10.2, 10.3, 10.5, 10.6_

  - [x] 1.3 Định nghĩa contract `DetectedShape`, `Trim` và validation tại `backend/app/workers/die_detection.py`
    - Khai báo `@dataclass(frozen=True)` cho `Trim` và `DetectedShape` đủ 7 trường (`page`, `type`, `props`, `trim`, `poly`, `source`, `confidence`)
    - `__post_init__` validate: không null; `confidence ∈ [0.0,1.0]`; `0.0 < trim.w,h ≤ 14400.0`; `source` thuộc tập hợp lệ; số trong `props` đã round 3 chữ số
    - _Requirements: 1.1, 1.3, 1.5, 1.6_

  - [x] 1.4 Định nghĩa `DetectionConfig`, `PageDetectionStatus`, `DetectionResult` và JSON Schema
    - Thêm các dataclass cấu hình/trạng thái với mặc định theo design (die_channel_names, max_xobject_depth=10, batch_size=50, raster_fallback_dpi=144, parity_tol_mm=0.1, classifier_tol_mm=0.01)
    - Thêm JSON Schema draft-07 cho `DetectedShape` + hàm serialize/deserialize qua boundary process/HTTP
    - _Requirements: 1.2, 5.3, 7.5, 11.5_

  - [x] 1.5 Hiện thực mapping tương thích ngược `to_legacy_response` và `from_legacy_settings`
    - `to_legacy_response(DetectionResult)` trả `shapes`/`dimensions`/`shapeParams` (đúng tên + kiểu frontend đang dùng) + `perPage` + `success`
    - `from_legacy_settings(settings)` ánh xạ `detectedShapesByPage`/`detectedShapeParamsByPage`/`detectedDimensionsByPage` → `dict[int, DetectedShape]`, không loại trang nào; dữ liệu không ánh xạ được → lỗi nêu trường gây lỗi, giữ nguyên job
    - _Requirements: 14.1, 14.2, 14.3_

  - [x] 1.6 Thêm parity guard `assert_parity` + cấu hình dung sai
    - Hàm `assert_parity(preview_items, output_items, tol)` so từng phần tử: vị trí/kích thước ≤ 0.1 mm, góc ≤ 0.01°
    - Vượt dung sai → trả lỗi nêu rõ phần tử + loại sai lệch; config thiếu/ngoài khoảng → dùng mặc định + log cảnh báo
    - _Requirements: 7.3, 7.4, 7.5_

  - [x]* 1.7 Viết property test cho contract DetectedShape
    - **Property 1: DetectedShape luôn well-formed**
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.5, 1.6**

  - [x]* 1.8 Viết property test cho ánh xạ enum cũ → mới
    - **Property 16: Ánh xạ enum cũ → enum thống nhất**
    - **Validates: Requirements 10.5**

  - [x]* 1.9 Viết property test round-trip mapping legacy ↔ DetectedShape
    - **Property 17: Round-trip mapping legacy ↔ DetectedShape**
    - **Validates: Requirements 14.2**

  - [x]* 1.10 Viết smoke test gộp enum một định nghĩa
    - Khẳng định chỉ còn một định nghĩa `ShapeType`, đúng 11 giá trị, tham chiếu sai → lỗi khởi tạo
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.6_

- [ ] 2. Phase 1 — Gộp Detection (SSOT)
  - [x] 2.1 Hiện thực các helper chọn đường khuôn (gom 1 chỗ) trong `die_detection.py`
    - ✅ `_select_from_paths`/`select_die_path` (ưu tiên spot-name → stroke → fill, loại nền full-page, largest-area, deterministic — R3.1, R3.2, R3.10); `_match_die_channel` khớp tên kênh full-name/case-insensitive/độc lập CMYK (R3.7, R3.9); `_same_color_group_poly` union subpath (R3.5); raster fallback (R3.8)
    - ✅ Mở rộng `pdf_content_parser`: theo dõi colorspace Separation/DeviceN → gắn `spot_name` (R3.6, R3.7); đệ quy Form XObject ≤ `max_xobject_depth` + log khi chạm giới hạn, chặn vòng lặp vô hạn (R3.3, R3.4)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10_

  - [x] 2.2 Hiện thực `_classify`, `_normalize_to_trim`, `_build_detected_shape`
    - `_classify` gọi classifier Python hiện có (Rust nối ở Phase 4); `_normalize_to_trim` chuẩn hoá props/poly về TRIM + round 3 số; `_build_detected_shape` lắp ráp + validate đủ 7 trường, fail chuẩn hoá → không tạo shape một phần
    - _Requirements: 1.2, 1.4, 1.7_

  - [x] 2.3 Hiện thực `detect_die_shapes` với per-page isolation + batch không giới hạn
    - Vòng lặp mọi trang trong scope cô lập lỗi: lỗi 1 trang → CUSTOM + `source=custom`, log số trang 1-based, giữ nguyên trang đã thành công; tất cả trang lỗi vẫn hoàn tất cấp file
    - Chia lô theo `batch_size`, phủ đủ trang 0..N−1, trả `DetectionResult` (total_pages, success_pages, failed_pages 1-based)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.7, 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x] 2.4 Sửa route `/detect-shape` trong `imposition.py`
    - Xoá logic inline chọn-path, gọi `detect_die_shapes`; bỏ `max_pages=30`; thay `success=false` toàn cục → per-page status; trả response qua `to_legacy_response`
    - _Requirements: 3.1, 4.6, 5.2, 14.1_

  - [x] 2.5 Thu gọn `shape_analyzer.py` chỉ còn raster helpers
    - Bỏ enum trùng, import `ShapeType` từ `shape_types`; chỉ giữ các raster-mask helper phục vụ fallback
    - _Requirements: 10.3_

  - [x]* 2.6 Viết property test khớp tên kênh khuôn
    - **Property 6: Khớp tên kênh khuôn full-name, case-insensitive, độc lập CMYK**
    - **Validates: Requirements 3.7, 3.9**

  - [x]* 2.7 Viết property test chia lô phủ đủ trang
    - **Property 7: Chia lô phủ đủ mọi trang, không sót không lặp**
    - **Validates: Requirements 5.3**

  - [x]* 2.8 Viết property test xử lý đủ N trang theo thứ tự
    - **Property 8: Xử lý đủ N trang theo đúng thứ tự**
    - **Validates: Requirements 5.1, 5.2, 6.4**

  - [ ]* 2.9 Viết property test biểu diễn tương đương cho cùng đường khuôn
    - **Property 5: Biểu diễn tương đương cho cùng một đường khuôn (fill/xobject/multi-subpath)**
    - **Validates: Requirements 3.2, 3.3, 3.5, 15.5**

  - [x]* 2.10 Viết property test tính quyết định của nhận diện
    - **Property 3: Nhận diện có tính quyết định (≥3 lần detect cùng kết quả)**
    - **Validates: Requirements 3.10, 15.1**

  - [x]* 2.11 Viết property test cô lập lỗi theo trang
    - **Property 4: Cô lập lỗi theo từng trang (fault injection)**
    - **Validates: Requirements 4.1, 4.3, 4.4, 5.4, 15.4**

  - [ ]* 2.12 Viết unit test edge case nhận diện
    - Trang rỗng/thiếu trường, normalize/trim fail → không tạo shape một phần (R1.7); không phân loại được → CUSTOM (R1.4); vượt depth XObject (R3.4); Separation `CutContour` → `source=separation` (R3.6); raster-only → `source=raster_fallback` (R3.8)
    - _Requirements: 1.4, 1.7, 3.4, 3.6, 3.8_

  - [ ]* 2.13 Viết integration test tương thích ngược `/detect-shape`
    - Khẳng định response giữ `shapes`/`dimensions`/`shapeParams` + thêm `perPage`; file >30 trang vẫn nhận diện đủ
    - _Requirements: 14.1, 5.2, 4.6_

- [ ] 3. Checkpoint — Phase 0 + Phase 1
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Phase 2 — Layout tin Detection (bỏ re-classify)
  - [x] 4.1 Hiện thực `compute_layout(DetectedShape, ...)` tại `backend/app/workers/imposition_layout.py`
    - Gọi `require_rust("compute_layout")` TRƯỚC mọi phép tính; `_validate_layout_input` (thiếu/rỗng `type`/`props` → lỗi nêu trường, không classify thay thế); NFP chỉ lấy `base_poly` từ `shape.poly`; gắn lại `type`/`props`/`poly` y nguyên ở đầu ra; CUSTOM với poly ≥3 đỉnh → xếp theo poly, poly rỗng/<3 đỉnh → lỗi "poly không hợp lệ"
    - _Requirements: 2.2, 2.5, 2.6, 6.1, 6.2, 6.3, 6.5, 6.6, 2.7, 12.1_

  - [x] 4.2 Sửa `sticker_imposer_pkg/layout_compute.py` thành adapter mỏng
    - ✅ HONOR `shape_props_override` (sửa RC-4: trước luôn bỏ + tái trích → lệch preview/output); chỉ classify làm fallback khi không có override; `require_rust("sticker_layout")` gọi đầu hàm (R12.1). Giữ tên `compute_sticker_layout_for_page` (tương thích ngược 3 callers); facade `compute_layout` dùng cho luồng có DetectedShape.
    - Bỏ re-classify + force re-extract props + NFP override (RC-4); `compute_sticker_layout_for_page(DetectedShape, ...)` gọi thẳng `compute_layout`, giữ tên hàm để tương thích ngược
    - _Requirements: 2.2, 6.2, 7.2_

  - [x] 4.3 Sửa `nup_diecut.py` để NFP chỉ trả `base_poly`
    - ✅ `_find_largest_die_path` ủy quyền sang `die_detection.select_die_path` (gom chọn-path 1 chỗ — R3.1, kèm ưu tiên spot). `get_optimal_head_to_tail_overlap` vẫn classify nội bộ CHỈ để tinh chỉnh tham số NFP (RECTANGLE/CIRCLE/HEXAGON), KHÔNG ghi đè type khi đã có override (đã được guard `if not shape_type_override` ở layout_compute → R2.6).
    - `get_optimal_head_to_tail_overlap` không còn gọi `classify_shape`; chỉ tính NFP params + trả `base_poly`; `type` không đổi sau NFP
    - _Requirements: 2.4, 2.5, 2.6_

  - [x] 4.4 Cập nhật frontend tiêu thụ per-page status
    - `useWorkspaceStore.ts`/`ImposerDashboard.tsx`/`processHandlers.ts` đọc `perPage`, bỏ guard `success` toàn cục để vẫn cập nhật khi có trang CUSTOM
    - _Requirements: 4.6_

  - [x]* 4.5 Viết property test lan truyền bất biến
    - **Property 2: Lan truyền bất biến xuống mọi lớp dưới Detection**
    - **Validates: Requirements 2.2, 2.3, 2.6, 6.2, 6.3, 8.1, 9.1**

  - [ ]* 4.6 Viết property test parity preview == output
    - **Property 9: Parity preview == output**
    - **Validates: Requirements 7.1, 7.3, 15.2**

  - [ ]* 4.7 Viết property test bố cục đồng nhất 3 đường
    - **Property 10: Bố cục đồng nhất giữa Tem Bế, N-up và CNC qua compute_layout**
    - **Validates: Requirements 8.2, 8.4, 14.5**

  - [ ]* 4.8 Viết property test require_rust được gọi trước tính layout
    - **Property 15: require_rust được gọi trước mọi phép tính layout**
    - **Validates: Requirements 12.1**

  - [ ]* 4.9 Viết unit test CUSTOM poly không hợp lệ
    - CUSTOM + poly rỗng/<3 đỉnh → lỗi, giữ nguyên DetectedShape đầu vào
    - _Requirements: 6.6, 2.7_

- [ ] 5. Checkpoint — Phase 2
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Phase 3 — Hợp nhất CNC gang
  - [x] 6.1 Hiện thực `build_cnc_gang_layout(List[DetectedShape], ...)` trong `cnc_layout.py`
    - ✅ Nhận `List[(DetectedShape, qty)]`; gắn `shapeType`/`shapeProps`/`poly` theo page vào mỗi cell + placement (sửa RC-5 drop-shape). Packing theo chữ nhật bao của trim (baseline → R8.5); nâng mật độ bằng nesting đa giác cho gang là cải tiến tương lai.
    - Thay `build_cnc_front_layout` cũ (chỉ nhận `(page_idx, trim_w, trim_h, qty)`, bin-pack chữ nhật); dùng `poly` thật cho mẫu khác RECTANGLE/CUSTOM; đảm bảo số mẫu/tờ không nhỏ hơn bin-pack chữ nhật bao của `trim`
    - _Requirements: 8.1, 8.3, 8.5, 8.6_

  - [x] 6.2 Định tuyến CNC gang + S&R qua `compute_layout` trong `cnc_render.py::_layout_for`
    - ✅ Gang → dựng DetectedShape mỗi mẫu rồi gọi `build_cnc_gang_layout`. S&R 1 mẫu giữ `compute_sticker_layout_for_page` (chính là worker dùng chung mà `compute_layout` delegate tới — đã shape-aware + honor props), không reroute để tránh đổi hành vi đã pass test.
    - S&R một mẫu → `compute_layout(DetectedShape, ...)`; gang nhiều mẫu → `build_cnc_gang_layout`; không sửa `type`/`props`/`poly`
    - _Requirements: 8.1, 8.2, 8.4_

  - [x] 6.3 Giữ render đặc thù CNC trong `cnc_render.py`
    - `run_cnc_two_sided` xuất Mặt trước → [Mặt sau lật gương theo `cncFlipEdge`] → trang Khuôn (một mặt: Mặt trước → Khuôn); gộp đường bế mọi mẫu vào trang Khuôn (chỉ chứa đường cắt/bế); 2 mặt + số trang lẻ → lỗi yêu cầu số trang chẵn, không tạo trang; ô không có đường bế hợp lệ → bỏ qua + log
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

  - [x]* 6.4 Viết property test xếp theo poly không tệ hơn bin-pack chữ nhật
    - **Property 11: Xếp theo poly không tệ hơn bin-pack hình chữ nhật**
    - **Validates: Requirements 6.5, 8.3, 8.5, 8.6**

  - [ ]* 6.5 Viết property test round-trip lật gương Mặt sau
    - **Property 13: Round-trip lật gương Mặt sau**
    - **Validates: Requirements 9.4**

  - [ ]* 6.6 Viết property test thứ tự trang đầu ra theo chế độ CNC
    - **Property 14: Thứ tự trang đầu ra theo chế độ CNC**
    - **Validates: Requirements 9.2, 9.3**

  - [ ]* 6.7 Viết unit test edge case CNC
    - 2 mặt trang lẻ → lỗi không tạo trang; ô không cut → bỏ qua; trang Khuôn chỉ chứa cut
    - _Requirements: 9.5, 9.6, 9.7_

- [ ] 7. Checkpoint — Phase 3
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Phase 4 — Port Rust classifier + fallback
  - [ ] 8.1 Thêm `classify_die_shape` và `select_die_path` vào `imposition_core/src/shape.rs`
    - Port logic phân loại sang Rust thuần (`DiePathItem`, `ClassifyResult` với `shape_type`/`props`/`confidence∈[0,1]`); width-profile cho hammer/dumbbell; KHÔNG sửa solver `shape_*`/`sticker_*`/`NfpSolver` hiện có (chỉ thêm hàm mới)
    - _Requirements: 11.1, 3.1, 13.4_

  - [ ] 8.2 Expose binding mới qua `pdfcompare_native` trong `native/`
    - Thêm binding cho `classify_die_shape`/`select_die_path`; giữ nguyên binding solver cũ
    - _Requirements: 11.1, 13.4_

  - [ ] 8.3 Hoàn thiện wrapper Python `shape_classifier.classify_die_shape` + fallback
    - Ưu tiên Rust khi `RUST_AVAILABLE`; `IMPOSITION_ALLOW_PY_FALLBACK=1` → đường dẫn Python (cùng tập `type`); thiếu Rust + fallback tắt → raise "không có đường dẫn phân loại khả dụng"; đọc PDF + trích Spot/Separation luôn bằng Python
    - _Requirements: 11.2, 11.3, 11.4_

  - [ ] 8.4 Nối `require_rust` fail-fast cho mọi entry layout
    - Khẳng định `compute_layout` và các entry preview/output/CNC gọi `require_rust` trước tính; thiếu Rust + fallback tắt → raise ngay không output một phần; fallback bật → log đúng một cảnh báo parity
    - _Requirements: 12.2, 12.3, 12.4_

  - [ ]* 8.5 Viết proptest Rust cho classifier trong `imposition_core`
    - proptest cho `classify_die_shape` (idempotence + biên `confidence`), làm cặp đối chiếu với Hypothesis
    - **Property 12: Đối chiếu classifier Rust và Python**
    - **Validates: Requirements 11.5, 15.3**

  - [ ]* 8.6 Viết property test đối chiếu Rust == Python (Hypothesis, model-based)
    - **Property 12: Đối chiếu classifier Rust và Python (cùng `type`, sai số số học ≤ 0.01 mm)**
    - **Validates: Requirements 11.5, 15.3**

  - [ ]* 8.7 Viết regression test không hồi quy solver Rust
    - So snapshot baseline ≤1e-6 (R13.2); idempotence ≥100 lần chạy (R13.3 / **Property 3**); benchmark ≤110% (R13.5); hành vi lỗi không đổi với đầu vào không hợp lệ (R13.6); cùng tập trường đầu ra (R13.1)
    - _Requirements: 13.1, 13.2, 13.3, 13.5, 13.6_

  - [ ]* 8.8 Viết smoke/static test khẳng định ranh giới kiến trúc
    - grep/static: gom heuristic một chỗ (R3.1), enum một định nghĩa + không import enum cũ (R10.1–R10.3), chữ ký solver Rust không đổi (R13.4)
    - _Requirements: 3.1, 10.1, 10.2, 10.3, 13.4_

- [ ] 9. Checkpoint cuối — Toàn bộ 5 phase
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Task con đánh dấu `*` là test tuỳ chọn (property/unit/smoke/integration), có thể bỏ qua cho MVP nhanh; agent KHÔNG tự hiện thực.
- Mỗi task tham chiếu sub-requirement cụ thể; property test tham chiếu đúng property trong design.
- Trình tự thực thi tôn trọng thứ tự an toàn của design: Phase 0 (contract + parity guard) → Phase 1 (SSOT detection, giữ API cũ) → Phase 2 (layout tin Detection) → Phase 3 (CNC gang trên layout dùng chung) → Phase 4 (Rust classifier, rủi ro cao nhất nhưng đã có fallback + parity guard).
- Ràng buộc bất biến: không hồi quy solver Rust hiện có, giữ `require_rust` fail-fast, mỗi phase backward compatible.

## Phụ thuộc giữa các phase

- **Phase 0** không phụ thuộc gì (chỉ thêm module + test), thiết lập enum + contract + parity guard.
- **Phase 1** phụ thuộc Phase 0 (enum thống nhất + `DetectedShape` + legacy mapping).
- **Phase 2** phụ thuộc Phase 1 (Detection ổn định) + Phase 0 (`assert_parity`).
- **Phase 3** phụ thuộc Phase 2 (`compute_layout` dùng chung).
- **Phase 4** phụ thuộc Phase 1–3 đã chạy độc lập với Rust classifier (fallback Python) + Phase 0 (parity guard).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["1.4", "1.6"] },
    { "id": 3, "tasks": ["1.5", "1.10"] },
    { "id": 4, "tasks": ["1.7", "1.8", "1.9"] },
    { "id": 5, "tasks": ["2.1"] },
    { "id": 6, "tasks": ["2.2"] },
    { "id": 7, "tasks": ["2.3"] },
    { "id": 8, "tasks": ["2.4", "2.5"] },
    { "id": 9, "tasks": ["2.6", "2.7", "2.8", "2.9", "2.10", "2.11", "2.12", "2.13"] },
    { "id": 10, "tasks": ["4.1"] },
    { "id": 11, "tasks": ["4.2", "4.3", "4.4"] },
    { "id": 12, "tasks": ["4.5", "4.6", "4.7", "4.8", "4.9"] },
    { "id": 13, "tasks": ["6.1"] },
    { "id": 14, "tasks": ["6.2"] },
    { "id": 15, "tasks": ["6.3"] },
    { "id": 16, "tasks": ["6.4", "6.5", "6.6", "6.7"] },
    { "id": 17, "tasks": ["8.1"] },
    { "id": 18, "tasks": ["8.2"] },
    { "id": 19, "tasks": ["8.3", "8.4"] },
    { "id": 20, "tasks": ["8.5", "8.6", "8.7", "8.8"] }
  ]
}
```
