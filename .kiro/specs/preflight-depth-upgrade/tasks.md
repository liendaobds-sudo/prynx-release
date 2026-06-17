# Implementation Plan: Preflight Depth Upgrade

## Overview

Triển khai ba năng lực preflight bằng cách mở rộng linh kiện sẵn có, theo thứ tự phụ thuộc: ưu tiên hoàn thành phần lõi thuần hàm (số học DPI, tính kích thước đặt từ CTM, cộng/ngưỡng TAC, quy đổi pixel→point, chuẩn hoá ngưỡng, quy đổi đơn vị box) kèm property-based test trước, sau đó tích hợp vào engine và worker multiprocessing, mở rộng API, hoàn thiện UI, rồi integration test và verify build cuối cùng.

Ràng buộc xuyên suốt: mọi đường ghi PDF qua pikepdf (không pdfium), tái dùng `geometry_reader`/`SeparationEngine`/`PageBoxesEngine`/các endpoint sẵn có, giữ `ProcessPoolExecutor` và `CHUNK_SIZE = 10`.

Ngôn ngữ: Backend Python (property test bằng Hypothesis, `@settings(max_examples=100)`), Frontend TypeScript (property test bằng fast-check, `{ numRuns: 100 }`). Mỗi property test gắn tag `Feature: preflight-depth-upgrade, Property {n}: {property_text}`.

## Tasks

- [ ] 1. Hàm thuần tính DPI hiệu dụng (images.py)
  - [ ] 1.1 Triển khai hàm thuần tính kích thước đặt và DPI
    - Thêm hằng `MIN_PLACED_PT = 1.0` vào `backend/app/core/preflight_rules/images.py`
    - Viết `_placed_size_from_matrix(matrix)` → `(hypot(a,b), hypot(c,d))`
    - Viết `_placed_size_from_bbox(bbox)` fallback axis-aligned
    - Viết `compute_effective_dpi(pixel_w, pixel_h, placed_w_pt, placed_h_pt)` trả `(dpi_x, dpi_y, min)` hoặc `None` cho ca suy biến
    - _Requirements: 1.1, 1.2, 1.3, 4.1, 4.4_

  - [ ]* 1.2 Viết property test cho compute_effective_dpi
    - **Property 1: Effective DPI đúng công thức và lấy min**
    - File `backend/tests/test_image_dpi_props.py`, Hypothesis ≥100 iteration
    - **Validates: Requirements 1.1, 1.3**

  - [ ]* 1.3 Viết property test cho placement suy biến
    - **Property 4: Placement suy biến bị bỏ qua** (trả `None`, không phát issue)
    - File `backend/tests/test_image_dpi_props.py`, Hypothesis ≥100 iteration
    - **Validates: Requirements 4.1**

  - [ ]* 1.4 Viết property test cho kích thước đặt từ CTM
    - **Property 2: Kích thước đặt bằng độ dài hai vector cạnh, bất biến theo xoay/nghiêng**
    - File `backend/tests/test_placed_size_props.py`, Hypothesis ≥100 iteration
    - **Validates: Requirements 1.2, 4.4**

- [ ] 2. Liệt kê placement ảnh và ghép pixel↔placement
  - [ ] 2.1 Triển khai list_image_placements (read-only PDFium)
    - Thêm `list_image_placements(pdf_path, page_index)` vào `backend/app/core/geometry_reader.py`
    - Tái dùng vòng lặp `FPDFPage_GetObject`, lọc `FPDF_PAGEOBJ_IMAGE`, lấy bounds + matrix + (nếu có) tên XObject/pixel metadata; không ghi, object lỗi → bỏ qua (debug log)
    - _Requirements: 1.2, 2.1, 2.4, 17.1_

  - [ ] 2.2 Triển khai _match_placements_to_images
    - Thêm `_match_placements_to_images(placements, images)` vào `images.py`: ghép theo `xobject_name` → `(pixel_w, pixel_h)` → greedy theo `draw_index`
    - _Requirements: 2.1, 2.2_

  - [ ]* 2.3 Viết unit test cho matcher
    - Ghép theo tên, theo kích thước pixel, fallback theo thứ tự; placement không ghép được → `image=None`
    - _Requirements: 2.1, 2.2_

- [ ] 3. Sửa _check_image_resolution dùng placement thật
  - [ ] 3.1 Viết lại _check_image_resolution theo placement
    - Giữ chữ ký; dùng pikepdf cho pixel/colorspace và rule màu (giữ nguyên), gọi `list_image_placements(doc._path, page_idx)`, ghép placement↔image, tính DPI theo từng placement
    - Phát `IMAGE_LOW_RES`/`IMAGE_HIGH_DPI` kèm `bbox` vùng đặt; giữ guard `IMAGE_HIGH_DPI` khi placement-size không khả dụng; `_image_total` đếm theo số placement đã đánh giá; bỏ qua trang thiếu MediaBox; `min_dpi` sentinel→0 khi không có placement
    - _Requirements: 1.4, 1.5, 1.6, 2.2, 2.3, 2.5, 4.2, 4.3, 4.5, 5.1, 5.2, 5.4_

  - [ ]* 3.2 Viết property test phân loại ngưỡng DPI
    - **Property 3: Phân loại ngưỡng DPI phát đúng issue theo từng placement, có guard**
    - File `backend/tests/test_image_dpi_props.py`, Hypothesis ≥100 iteration
    - **Validates: Requirements 1.4, 1.5, 2.2, 5.4**

  - [ ]* 3.3 Viết property test nội dung mô tả issue DPI
    - **Property 6: Mô tả issue DPI chứa pixel `{w}×{h}` và DPI làm tròn**
    - File `backend/tests/test_image_dpi_props.py`, Hypothesis ≥100 iteration
    - **Validates: Requirements 1.6**

  - [ ]* 3.4 Viết unit/regression test cho rule ảnh
    - Ảnh phủ một phần trang, tiled, đặt lệch, `min_dpi == 0` khi không có ảnh; regression GIF/progressive JPEG/OPI/RGB/Spot không đổi
    - _Requirements: 5.1, 4.5_

- [ ] 4. Đếm placement và gộp thống kê trên đường file lớn
  - [ ] 4.1 Bảo đảm gộp stats và đếm placement nhất quán
    - Trong `backend/app/core/preflight_engine.py`: xác nhận `run()` (tuần tự + file lớn) và `_content_stream_worker` gán `doc._path`, gộp `_image_total`/`_image_low_res`/`_image_min_dpi` từ mọi chunk; chunk lỗi → `INTERNAL_ERROR` và tiếp tục
    - _Requirements: 2.5, 3.1, 3.2, 3.4, 4.5_

  - [ ]* 4.2 Viết property test gộp thống kê chunk
    - **Property 5: Bất biến đếm placement và gộp thống kê chunk** (`Σ total`, `Σ low_res`, `min(min_dpi)`)
    - File `backend/tests/test_chunk_stats_props.py`, Hypothesis ≥100 iteration
    - **Validates: Requirements 2.1, 2.5, 3.2**

- [ ] 5. Checkpoint - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Hàm thuần rule TAC / Ink-Limit (ink.py)
  - [ ] 6.1 Tạo module ink.py với hằng số và chuẩn hoá ngưỡng
    - Tạo `backend/app/core/preflight_rules/ink.py` với `TAC_RENDER_DPI`, `TAC_DEFAULT_THRESHOLD=300`, `TAC_THRESHOLD_MIN/MAX`, `TAC_MAX_BBOXES=50`, `TAC_TILE_PX=16`
    - Viết `_normalize_tac_threshold(value)`: `[100,400]`→int, ngược lại→300
    - _Requirements: 7.1, 7.2, 7.3_

  - [ ]* 6.2 Viết property test chuẩn hoá ngưỡng TAC
    - **Property 9: Chuẩn hoá ngưỡng TAC**
    - File `backend/tests/test_tac_threshold_props.py`, Hypothesis ≥100 iteration
    - **Validates: Requirements 7.1, 7.2, 7.3**

  - [ ] 6.3 Triển khai cộng kênh TAC, phân loại ngưỡng và mô tả
    - Trong `ink.py`: hàm thuần tính `tac_pct = Σ kênh /255*100`, `max_tac`, `area_pct = mask.mean()*100`, dựng `description` (max TAC + threshold + area)
    - _Requirements: 6.2, 6.3, 6.4, 6.5, 9.4_

  - [ ]* 6.4 Viết property test cộng kênh TAC
    - **Property 7: TAC bằng tổng kênh và đơn điệu không-giảm theo phủ mực** (spot đóng góp như process)
    - File `backend/tests/test_tac_props.py`, Hypothesis ≥100 iteration
    - **Validates: Requirements 6.2, 9.4**

  - [ ]* 6.5 Viết property test phân loại ngưỡng và báo cáo TAC
    - **Property 8: Phân loại ngưỡng TAC và nội dung báo cáo** (phát khi và chỉ khi `max>threshold`)
    - File `backend/tests/test_tac_props.py`, Hypothesis ≥100 iteration
    - **Validates: Requirements 6.3, 6.4, 6.5**

  - [ ] 6.6 Triển khai gom vùng và quy đổi pixel→point
    - Trong `ink.py`: `_cluster_mask_to_bboxes(mask, tile_px, max_bboxes)` grid-tiling + gộp ô kề + giới hạn 50; `_px_bbox_to_pdf_point(bbox_px, img_w, img_h, page_h_pt, render_dpi)` quy đổi `scale=72/render_dpi` + lật trục y
    - _Requirements: 8.1, 8.2, 8.4_

  - [ ]* 6.7 Viết property test gom vùng và quy đổi
    - **Property 10: Gom vùng TAC bị giới hạn (≤50) và quy đổi pixel→point đúng (round-trip)**
    - File `backend/tests/test_tac_bbox_props.py`, Hypothesis ≥100 iteration
    - **Validates: Requirements 8.1, 8.2, 8.4**

- [ ] 7. Tích hợp rule TAC vào PreflightEngine
  - [ ] 7.1 Triển khai _check_tac trong InkRulesMixin
    - Trong `ink.py`: lớp `InkRulesMixin._check_tac(doc, page_nums, tac_threshold)` gọi `SeparationEngine.extract_separations` qua `asyncio.run` (dpi=`TAC_RENDER_DPI`, spot auto-detect), giải nén plate→ndarray, tính TAC, gom bbox, phát `TAC_EXCEEDED` severity `warning`, `auto_fixable=False`; lỗi tách kênh 1 trang → `INTERNAL_ERROR` và tiếp tục; không gom được vùng → `bboxes=[]`
    - _Requirements: 6.1, 6.2, 6.3, 8.3, 9.2, 9.3, 9.4, 10.1, 10.3_

  - [ ] 7.2 Đăng ký mixin, rule và dispatch tham số ngưỡng
    - Thêm `"TAC_EXCEEDED"` vào `ALL_RULES` (`backend/app/core/preflight_models.py`)
    - Trong `preflight_engine.py`: kế thừa `InkRulesMixin`; thêm tham số `run(pdf_path, rules=None, tac_threshold=300)` và `_content_stream_worker(..., tac_threshold)`; dispatch `_check_tac` ở nhánh tuần tự, file lớn và worker; giữ `CHUNK_SIZE`/`ProcessPoolExecutor`
    - _Requirements: 6.1, 7.1, 9.1, 17.2, 17.5_

  - [ ]* 7.3 Viết unit test cho _check_tac
    - Trang dưới ngưỡng (không issue), trang vượt ngưỡng, trang có spot, mặc định 300, `auto_fixable == False`
    - _Requirements: 6.3, 9.3, 9.4, 10.1, 10.3_

- [ ] 8. Mở rộng API inspect cho TAC threshold
  - [ ] 8.1 Thêm tac_threshold vào InspectByIdRequest và summary
    - Trong `backend/app/api/routes/preflight.py`: thêm `tac_threshold: Optional[int] = 300`; truyền `_normalize_tac_threshold(request.tac_threshold)` vào `engine.run`; ghi `summary["tac_threshold"]`; giữ schema `PreflightIssueResponse`/`PreflightReportResponse` không đổi
    - _Requirements: 7.4, 11.4, 5.3_

  - [ ]* 8.2 Viết unit test API passthrough
    - `inspect` truyền `tac_threshold` xuống engine; schema response không đổi
    - _Requirements: 7.4, 5.3_

- [ ] 9. Checkpoint - Ensure all tests pass, ask the user if questions arise.

- [ ] 10. Hàm thuần frontend Set Page Boxes
  - [ ] 10.1 Triển khai quy đổi đơn vị, validate và phân giải phạm vi trang
    - Tạo util (vd `desktop/src/components/preprocess-tools/setPageBoxesUtils.ts`): `MM_PER_UNIT`, `toMm`/`fromMm`/`roundMm2`, `validateRectUnit`, `resolvePages`
    - _Requirements: 13.3, 13.4, 14.2, 14.3, 14.4, 14.5, 16.3_

  - [ ]* 10.2 Viết property test quy đổi đơn vị box
    - **Property 11: Quy đổi đơn vị box round-trip và làm tròn 2 chữ số mm**
    - File `desktop/src/components/preprocess-tools/__tests__/setPageBoxes.props.test.ts`, fast-check `numRuns: 100`
    - **Validates: Requirements 12.2, 12.4, 13.1, 13.5, 16.1, 16.3**

  - [ ]* 10.3 Viết property test xác thực rectangle
    - **Property 12: Xác thực rectangle box**
    - File `setPageBoxes.props.test.ts`, fast-check `numRuns: 100`
    - **Validates: Requirements 13.3, 13.4**

  - [ ]* 10.4 Viết property test phân giải phạm vi trang
    - **Property 13: Phân giải phạm vi trang**
    - File `setPageBoxes.props.test.ts`, fast-check `numRuns: 100`
    - **Validates: Requirements 14.2, 14.3, 14.4, 14.5**

- [ ] 11. Hoàn thiện SetPageBoxesPanel
  - [ ] 11.1 Thêm API client và kiểu dữ liệu
    - Trong `desktop/src/components/preprocess-tools/PageBoxesTool.tsx`: kiểu `Unit/BoxType/RectMm/BoxMm/PageBoxesResponse`, `fetchPageBoxes`, `postSetPageBoxes`
    - _Requirements: 12.1, 13.2, 17.3_

  - [ ] 11.2 Hiển thị 5 box theo Global_Unit
    - Thêm `SetPageBoxesPanel`: gọi `GET page-boxes`, hiển thị MediaBox/CropBox/TrimBox/BleedBox/ArtBox quy đổi từ mm; đánh dấu kế thừa theo `has_*`; đổi đơn vị cập nhật ngay, không mất dữ liệu đang nhập
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 16.1, 16.2_

  - [ ] 11.3 Nhập/sửa box, validate và chọn phạm vi trang
    - Form nhập từng box theo đơn vị hiện tại → quy đổi mm khi gửi; dùng `validateRectUnit`/`resolvePages`; chọn scope single/range/all; chặn gửi + báo lỗi khi không hợp lệ
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 14.1, 14.2, 14.3, 14.4, 14.5_

  - [ ] 11.4 Luồng lưu và xử lý lỗi
    - `ensureUploaded`→`POST set-page-boxes`→`GET download`→`onFileFixed(blob, pagebox_...)`; lỗi API giữ nguyên input và báo lỗi; giữ auto-trim/add-bleed
    - _Requirements: 15.2, 15.3, 15.4, 15.5_

  - [ ] 11.5 Preview overlay 5 box trên viewer
    - Phát sự kiện/`onPreviewBoxes(rectPt[])` để `LivePageFrame` vẽ khung 5 box (SVG), overlay thuần frontend không ghi file
    - _Requirements: 15.1_

  - [ ]* 11.6 Viết unit test cho panel
    - Render 5 box, đánh dấu kế thừa, đổi unit, payload đúng shape, thành công→`onFileFixed`, thất bại→giữ input, preview vẽ khung, auto-trim/add-bleed vẫn chạy
    - _Requirements: 12.1, 12.3, 13.2, 15.1, 15.2, 15.4, 15.5, 16.2_

- [ ] 12. Hiển thị và điều hướng lỗi DPI/TAC
  - [ ] 12.1 Hiển thị issue DPI/TAC, điều hướng/highlight và TAC_Threshold
    - Trong component báo cáo preflight: render `IMAGE_LOW_RES`/`IMAGE_HIGH_DPI`/`TAC_EXCEEDED` (page, description, severity); chọn issue có `bbox`/`bboxes`→nhảy trang + highlight, không có vùng→chỉ nhảy trang; luôn hiển thị `summary.tac_threshold` kèm nhãn đơn vị (DPI, %)
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 16.4_

  - [ ]* 12.2 Viết unit test hiển thị/điều hướng lỗi
    - Render + nhảy trang/highlight theo bbox; không bbox→chỉ nhảy trang; luôn hiển thị TAC_Threshold + nhãn đơn vị
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

- [ ] 13. Checkpoint - Ensure all tests pass, ask the user if questions arise.

- [ ] 14. Integration tests
  - [ ]* 14.1 Test Form XObject lồng nhau
    - PDF có ảnh trong Form lồng; xác nhận kích thước đặt phản ánh tích CTM Form×placement (PDFium flatten)
    - _Requirements: 2.4_

  - [ ]* 14.2 Test parity tuần tự ↔ multiprocessing
    - File > `CHUNK_SIZE` trang; so khớp multiset issue và stats giữa hai đường chạy
    - _Requirements: 2.5, 3.1, 3.3_

  - [ ]* 14.3 Test TAC trên file lớn
    - Đi qua `ProcessPoolExecutor`; lỗi một trang→`INTERNAL_ERROR` và tiếp tục
    - _Requirements: 9.1, 9.3_

  - [ ]* 14.4 Smoke test ràng buộc kiến trúc
    - `"TAC_EXCEEDED" in ALL_RULES`; `TAC_RENDER_DPI` thấp; `set_boxes` ghi qua pikepdf, không có đường ghi pdfium; `CHUNK_SIZE` không đổi
    - _Requirements: 6.1, 9.2, 15.3, 17.4, 17.5_

- [ ] 15. Verify build & typecheck
  - [ ] 15.1 Chạy toàn bộ test backend
    - Chạy `pytest` trong `backend/` (bao gồm property test), sửa lỗi đến khi pass
    - _Requirements: 1.1, 6.1, 7.4_

  - [ ] 15.2 Chạy typecheck và build frontend
    - Chạy `npm run typecheck` và `npm run build` trong `desktop/`, sửa lỗi đến khi pass
    - _Requirements: 11.1, 12.1, 16.1_

- [ ] 16. Final checkpoint - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (test sub-tasks) và có thể bỏ qua cho MVP nhanh.
- Phần lõi thuần hàm được làm trước kèm property test để bắt lỗi số học sớm; tích hợp engine/API/UI sau; integration test và verify build cuối.
- Mỗi property test tham chiếu property thiết kế, chạy ≥100 iteration, gắn tag `Feature: preflight-depth-upgrade, Property {n}`.
- Mọi đường ghi PDF qua pikepdf; tái dùng `geometry_reader`/`SeparationEngine`/`PageBoxesEngine`/endpoint sẵn có; giữ `ProcessPoolExecutor` và `CHUNK_SIZE`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "6.1", "10.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "2.2", "6.2", "6.3", "10.2", "10.3", "10.4"] },
    { "id": 2, "tasks": ["2.3", "3.1", "6.4", "6.5", "6.6"] },
    { "id": 3, "tasks": ["3.2", "3.3", "3.4", "4.1", "6.7", "7.1"] },
    { "id": 4, "tasks": ["4.2", "7.2", "7.3"] },
    { "id": 5, "tasks": ["8.1", "11.1"] },
    { "id": 6, "tasks": ["8.2", "11.2"] },
    { "id": 7, "tasks": ["11.3"] },
    { "id": 8, "tasks": ["11.4"] },
    { "id": 9, "tasks": ["11.5"] },
    { "id": 10, "tasks": ["11.6", "12.1"] },
    { "id": 11, "tasks": ["12.2", "14.1", "14.2", "14.3", "14.4"] },
    { "id": 12, "tasks": ["15.1", "15.2"] }
  ]
}
```
