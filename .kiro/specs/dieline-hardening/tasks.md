# Implementation Plan: Dieline Hardening (Giai đoạn 1)

## Overview

Kế hoạch hiện thực 6 workstream củng cố chất lượng cho module dieline phía client (`desktop/src/lib/dieline/`) bằng TypeScript thuần, dùng `fast-check` cho property-based test. Trình tự bám sát nguyên tắc xây dựng tăng dần: tạo module dùng chung trước, refactor export/canvas để dùng lại, thêm cổng kiểm tra biên dạng khi xuất, hợp nhất warnings, dẫn xuất legend, sửa chú thích `dieGap`, và cuối cùng phủ kiểm thử hình học cho 8 generator. Mọi thay đổi giữ nguyên hình học đầu ra trong dung sai 0.001mm và không làm hỏng 102 test hiện có.

## Tasks

- [x] 1. Thiết lập phụ thuộc kiểm thử
  - [x] 1.1 Thêm `fast-check` làm devDependency cho package `desktop`
    - Cập nhật `desktop/package.json` thêm `fast-check` vào `devDependencies` và cài đặt
    - Xác nhận `vitest` nhận diện được `fast-check` (import thử trong một test tạm rồi xóa)
    - Không thêm bất kỳ phụ thuộc nào khác ngoài phạm vi 6 workstream
    - _Requirements: 7.5, 2.6_

- [x] 2. Tạo Shared_Geometry_Module (chống drift)
  - [x] 2.1 Tạo `sharedGeometry.ts` với logic nối chuỗi dùng chung
    - Tạo `desktop/src/lib/dieline/sharedGeometry.ts`
    - Khai báo hằng số `SNAP_TOLERANCE = 0.01`
    - Di chuyển nguyên trạng (verbatim) `ptEq`, `segEndpoints`, `buildChains`, `chainToSvgD` và kiểu `Chain` từ `exportPDF.ts` sang module này, giữ nguyên thuật toán và dung sai
    - _Requirements: 4.1, 1.5_

  - [x] 2.2 Bổ sung công thức kích thước, dẫn xuất legend và guard model không hợp lệ
    - Thêm `computeEnvelopeDims(params)` trả về `{ FH, SF }` (rút công thức trùng lặp giữa export và canvas)
    - Thêm `deriveLegendTags(model)` trả về `Set<PathTag>` các tag thực sự xuất hiện trong `model.allPaths`
    - Thêm kiểm tra đầu vào: nếu model thiếu segment hoặc chứa chuỗi không khép kín vượt `SNAP_TOLERANCE` thì ném lỗi rõ ràng, không trả về SVG/kích thước một phần
    - _Requirements: 4.2, 5.1, 5.4, 4.7_

  - [x]* 2.3 Viết property test cho tính khớp Export ↔ Canvas
    - **Property 7: Export và Canvas cho đầu ra hình học khớp nhau**
    - **Validates: Requirements 4.5**
    - File: `sharedGeometry.test.ts`; so khớp chuỗi SVG `d` ký-tự-theo-ký-tự và giá trị FH/SF trong 0.001mm

  - [x]* 2.4 Viết property test cho việc từ chối model không hợp lệ
    - **Property 10: Module dùng chung từ chối model không hợp lệ**
    - **Validates: Requirements 4.7**
    - File: `sharedGeometry.test.ts`; model thiếu segment / chuỗi hở vượt `SNAP_TOLERANCE` phải ném lỗi, không trả về đầu ra một phần

  - [x]* 2.5 Viết golden-master snapshot test cho ổn định chuỗi SVG
    - Chụp baseline chuỗi SVG + giá trị kích thước cho các DielineModel mẫu TRƯỚC khi refactor export/canvas, lưu snapshot
    - **Validates: Requirements 4.6**
    - File: `goldenMaster.test.ts`; so khớp char-identical, kích thước ≤ 0.001mm

- [x] 3. Refactor Export và Canvas dùng lại Shared_Geometry_Module
  - [x] 3.1 Refactor `exportPDF.ts` để import từ `sharedGeometry`
    - Thay các bản sao cục bộ `buildChains`/`segEndpoints`/`chainToSvgD` và công thức FH/SF bằng import từ `sharedGeometry`
    - Xóa định nghĩa trùng lặp khỏi `exportPDF.ts`
    - _Requirements: 4.3_

  - [x] 3.2 Refactor `DielineCanvas2D.tsx` để import từ `sharedGeometry`
    - Thay bản sao cục bộ logic nối chuỗi và công thức kích thước bằng import từ `sharedGeometry`
    - Xóa định nghĩa trùng lặp khỏi `DielineCanvas2D.tsx`
    - _Requirements: 4.4_

  - [x]* 3.3 Viết smoke test chống trùng lặp
    - Xác minh `sharedGeometry` export đủ hàm; `exportPDF`/`DielineCanvas2D` import từ đó và không định nghĩa cục bộ logic nối chuỗi/công thức
    - File: `drift.smoke.test.ts`
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [x] 4. Hiện thực Contour_Validator
  - [x] 4.1 Tạo `contourValidator.ts` tái dùng `tracePerimeter`
    - Tạo `desktop/src/lib/dieline/contourValidator.ts` với kiểu `OpenContourWarning`, `ContourValidationResult`
    - Hiện thực `validateClosedContours(model)`: với mỗi panel lọc segment `CUT`/`BLEED`, gọi `tracePerimeter` để nối chuỗi (không viết thuật toán nối thứ hai), tính khoảng hở Euclid đầu-cuối, đánh dấu hở khi > `SNAP_TOLERANCE`
    - Bao gồm các góc bị `Connect_Corner` biến đổi trong biên panel cần kiểm tra
    - _Requirements: 1.1, 1.2, 1.5, 1.6, 1.7_

  - [x]* 4.2 Viết property test cho phân loại biên dạng
    - **Property 1: Validator phân loại đúng tính khép kín của biên dạng**
    - **Validates: Requirements 1.1, 1.2, 1.5, 1.8**
    - File: `contourValidator.test.ts`; bắt đầu từ model khép kín → `allClosed=true`; nhiễu loạn một endpoint đi `d > SNAP_TOLERANCE` → báo đúng panel và `gapMm ≈ d`

  - [x]* 4.3 Viết smoke test tái dùng `tracePerimeter`
    - Xác minh `contourValidator` dùng `tracePerimeter`, không có vòng nối chuỗi trùng lặp
    - File: `contourValidator.test.ts`
    - _Requirements: 1.6_

- [x] 5. Tích hợp cổng kiểm tra biên dạng vào luồng xuất
  - [x] 5.1 Wire `validateClosedContours` vào `downloadPDF`
    - Bổ sung tham số `confirmOpenContours?: (warnings) => Promise<boolean>` vào `downloadPDF` trong `exportPDF.ts`
    - Nếu `allClosed` → tạo file ngay không hỏi; nếu có biên hở → hiển thị cảnh báo liệt kê panel + `gapMm` và chỉ ghi file khi callback trả `true`; không có callback → không ghi file
    - _Requirements: 1.3, 1.4, 1.8_

  - [x]* 5.2 Viết example test cho cổng xác nhận xuất file
    - Mock `confirmOpenContours`: false → không ghi file; true → ghi; xác minh callback nhận danh sách cảnh báo; model toàn biên kín → ghi trực tiếp không gọi callback
    - File: `exportGate.test.ts`
    - _Requirements: 1.3, 1.4, 1.8_

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Hợp nhất Warnings vào DielineModel.warnings
  - [x] 7.1 Hiện thực `attachWarnings` và tích hợp vào `generateDieline`
    - Tạo `attachWarnings(model, validationWarnings)` hợp nhất + khử trùng lặp theo nội dung chuỗi
    - Trong `generateDieline` (dispatch): gọi `validateParams` lấy warnings, gọi generator, gán `model.warnings` (mảng rỗng nếu không có); đưa cảnh báo snap-lock vào cùng trường này
    - Nếu `validateParams` ném lỗi → lan truyền lỗi, không tạo model với `warnings` thiếu/sai
    - _Requirements: 3.1, 3.2, 3.3, 3.5, 3.7_

  - [x] 7.2 Loại bỏ nguồn cảnh báo riêng ở Canvas và Store
    - `DielineCanvas2D.tsx` đọc cảnh báo hiển thị chỉ từ `model.warnings`
    - Gỡ bỏ trường riêng `snapLockWarning` trong `useBoxStore.ts` (hoặc biến nó thành dẫn xuất từ `model.warnings`)
    - _Requirements: 3.4_

  - [x]* 7.3 Viết property test cho hợp nhất warnings
    - **Property 6: Warnings được hợp nhất đầy đủ, chính xác và xác định**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.5, 3.6**
    - File: `warnings.test.ts`; `model.warnings` luôn là mảng đã dedupe = union(validateParams, snap-lock); hai lần sinh cùng params cho kết quả giống hệt

  - [x]* 7.4 Viết test biên cho lỗi validate và nguồn cảnh báo
    - Ép `validateParams` ném lỗi → `generateDieline` ném lỗi, không trả model lỗi; xác minh Canvas không tham chiếu `snapLockWarning`
    - File: `warnings.test.ts`
    - _Requirements: 3.4, 3.7_

- [x] 8. Dẫn xuất legend theo tag thực có trong file (BLEED — phương án B)
  - [x] 8.1 Render legend bằng `deriveLegendTags` ở Canvas và Export
    - Cập nhật `DielineCanvas2D.tsx` và `exportPDF.ts` lặp qua `deriveLegendTags(model)` thay vì hằng số `PATH_STYLES` đầy đủ
    - Giữ nguyên `PATH_STYLES`/`TAG_STYLES` đầy đủ định nghĩa; chỉ phần hiển thị legend là dẫn xuất
    - _Requirements: 5.1, 5.2, 5.4_

  - [x]* 8.2 Viết property test cho legend
    - **Property 8: Legend bằng đúng tập tag thực có trong file**
    - **Validates: Requirements 5.1, 5.4, 5.5, 5.6**
    - File: `legend.test.ts`; đẳng thức tập hợp hai chiều giữa tag legend và tag trong `model.allPaths`

- [x] 9. Sửa chú thích `dieGap`
  - [x] 9.1 Cập nhật JSDoc của `dieGap` trong `nestingTypes.ts`
    - Bỏ cụm "offset polygon ra ngoài mỗi bên"; mô tả `dieGap` là khoảng hở giữa bounding box của hai khuôn liền kề; ghi chú offset polygon thực là known limitation Giai đoạn 2
    - Không thay đổi bất kỳ câu lệnh thực thi nào trong `nestingEngine.ts`
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [x]* 9.2 Viết static test kiểm tra nội dung chú thích
    - Đọc nguồn `nestingTypes.ts`: không còn cụm "offset polygon ra ngoài mỗi bên"; có mô tả gap giữa bounding box; có ghi chú known limitation Giai đoạn 2
    - File: `dieGapDoc.test.ts`
    - _Requirements: 6.1, 6.2, 6.3_

- [x] 10. Bộ kiểm thử hình học cho 8 generator
  - [x] 10.1 Hiện thực helper hình học và generator dữ liệu test
    - Tạo `geometryHelpers.ts`: `polygonArea` (shoelace), `polygonIntersectionArea`, `pointToSegmentDist`, `contourGap` (dùng `tracePerimeter`), `expectedFlatArea`
    - Tạo `arbBoxParams(boxType)` của `fast-check` sinh params hợp lệ (đi qua `validateParams`), phủ edge case (min/max, L≈W, auto-size 0)
    - _Requirements: 2.6, 2.7_

  - [x]* 10.2 Viết property test khép kín Cut_Piece (× 8 generator)
    - **Property 2: Mọi Cut_Piece do generator sinh ra đều khép kín**
    - **Validates: Requirements 2.1, 1.7**
    - File: `geometry.test.ts`; chạy riêng từng generator, dung sai 0.001mm, ≥100 iterations

  - [x]* 10.3 Viết property test không chồng lấn Panel (× 8 generator)
    - **Property 3: Các Panel không chồng lấn**
    - **Validates: Requirements 2.2**
    - File: `geometry.test.ts`; giao diện tích ≤ 0.01 mm²; thông báo lỗi nêu tên generator + params

  - [x]* 10.4 Viết property test diện tích phẳng (× 8 generator)
    - **Property 4: Diện tích phẳng khớp công thức kỳ vọng**
    - **Validates: Requirements 2.3**
    - File: `geometry.test.ts`; sai lệch tương đối ≤ 0.1%; thông báo lỗi nêu generator + params

  - [x]* 10.5 Viết property test động học gập (× 8 generator)
    - **Property 5: Nhất quán động học gập (fold kinematics)**
    - **Validates: Requirements 2.4**
    - File: `geometry.test.ts`; khoảng cách đầu mút `pivotEdge` tới biên chung ≤ 0.001mm

  - [x]* 10.6 Viết property test hồi quy hình học (golden master)
    - **Property 9: Hình học generator ổn định và xác định (chống hồi quy)**
    - **Validates: Requirements 7.3**
    - File: `regression.test.ts`; `panels`/`allPaths` cùng số lượng/thứ tự vs baseline, mỗi tọa độ lệch ≤ 0.001mm; nêu generator + phần tử sai lệch khi fail (7.4)

- [x] 11. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass (giữ 102 test hiện có pass, 0 fail, 0 skip mới), ask the user if questions arise.
  - _Requirements: 2.5, 7.1, 7.2, 7.6_

## Notes

- Tasks marked with `*` are optional (test-related) and can be skipped for faster MVP.
- Mỗi property test gắn nhãn comment `// Feature: dieline-hardening, Property {number}: {property_text}` và chạy `fc.assert(prop, { numRuns: 100 })`.
- Mỗi task tham chiếu sub-requirement cụ thể để truy vết.
- Checkpoint đảm bảo xác thực tăng dần và không hồi quy.
- Property tests xác minh các correctness property 1–10; example/unit/smoke test phủ luồng UI, cổng xác nhận, điều kiện lỗi và nội dung tài liệu.
- Golden-master (2.5) cần chụp baseline TRƯỚC khi refactor (task 3) để so khớp sau refactor.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "9.1"] },
    { "id": 1, "tasks": ["2.1", "10.1", "9.2"] },
    { "id": 2, "tasks": ["2.2", "2.5"] },
    { "id": 3, "tasks": ["3.1", "3.2", "4.1", "2.4"] },
    { "id": 4, "tasks": ["5.1", "4.2", "2.3", "3.3"] },
    { "id": 5, "tasks": ["7.1", "4.3", "5.2"] },
    { "id": 6, "tasks": ["7.2", "7.3"] },
    { "id": 7, "tasks": ["8.1", "7.4"] },
    { "id": 8, "tasks": ["8.2", "10.2", "10.6"] },
    { "id": 9, "tasks": ["10.3"] },
    { "id": 10, "tasks": ["10.4"] },
    { "id": 11, "tasks": ["10.5"] }
  ]
}
```
