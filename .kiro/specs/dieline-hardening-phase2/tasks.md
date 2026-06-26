# Implementation Plan: Dieline Hardening (Giai đoạn 2)

## Overview

Kế hoạch hiện thực hai workstream độc lập của Giai đoạn 2 cho module dieline phía client (`desktop/src/lib/dieline/`) bằng TypeScript thuần, dùng `vitest` + `fast-check` (đã thiết lập từ Giai đoạn 1). Trình tự bám sát nguyên tắc xây dựng tăng dần: tạo hàm hình học dùng chung (`extractOuterSilhouette`) làm nền cho cả hai workstream trước, rồi sửa `validateClosedContours` và cổng xuất (Workstream A), sau đó hiện thực `offsetPolygon`/`computeDieOutline` và tích hợp va chạm theo polygon vào `calculateNesting` (Workstream B), cập nhật chú thích `dieGap`, và cuối cùng phủ golden-master + chạy đầy đủ bộ test. Mọi thay đổi chỉ-đọc model, giữ hình học 8 generator bất biến (≤ 0,001 mm), giữ chữ ký công khai tương thích ngược, và giữ 503 test hiện có ở trạng thái pass (ngoại trừ test nesting được cập nhật tường minh theo Requirement 8.2).

## Tasks

- [x] 1. Trích xuất biên ngoài dùng chung (nền tảng cả hai workstream)
  - [x] 1.1 Hiện thực `extractOuterSilhouette` và kiểu `OuterSilhouette` trong `contourValidator.ts`
    - Khai báo interface `OuterSilhouette { vertices: Point2D[]; gapMm: number; area: number; closed: boolean }`
    - Hiện thực hàm thuần `extractOuterSilhouette(cutBleedSegs: PathSegment[]): OuterSilhouette | null` — chỉ-đọc, không biến đổi đầu vào
    - Tái dùng `tracePerimeter` để nối chuỗi (KHÔNG viết thuật toán chaining thứ hai); trả `null` khi không có đoạn `CUT`/`BLEED` (chỉ-CREASE)
    - Chọn vòng ngoài cùng theo diện tích bao lớn nhất (shoelace); loại Interior_Cut_Feature theo quy tắc khách quan (đầu mút không nằm trên biên ngoài trong `SNAP_TOLERANCE` VÀ point-in-polygon trong vùng bao)
    - Đo `gapMm = Euclid(vertices[0], vertices[n-1])`, đặt `closed = gapMm ≤ SNAP_TOLERANCE`; giữ chuỗi đỉnh hở xác định khi không khép được
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [x]* 1.2 Viết smoke test tái dùng `tracePerimeter`
    - Xác minh `extractOuterSilhouette` import & gọi `tracePerimeter`; không có vòng nối chuỗi (chaining) trùng lặp
    - File: `contourValidator.test.ts`
    - _Requirements: 1.2_

- [x] 2. Workstream A — Kiểm tra khép kín chỉ trên biên ngoài
  - [x] 2.1 Sửa `validateClosedContours` dùng `extractOuterSilhouette`
    - Giữ nguyên chữ ký công khai và các kiểu `OpenContourWarning`, `ContourValidationResult` của Giai đoạn 1
    - Giữ nguyên logic gom đoạn `CUT`/`BLEED` và phân nhóm Cut_Piece bằng union-find (`SNAP_TOLERANCE`)
    - Với mỗi Cut_Piece gọi `extractOuterSilhouette`: `null` → bỏ qua; `closed` → không cảnh báo (kể cả còn Interior_Cut_Feature hở); hở → tạo `OpenContourWarning` với `gapMm` biên ngoài
    - Xác định Panel đại diện: Panel chứa nhiều đoạn `CUT`/`BLEED` của biên ngoài hở đó nhất, đồng hạng → chỉ số thấp nhất; dùng `SNAP_TOLERANCE` từ `sharedGeometry`; chỉ-đọc model
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x]* 2.2 Viết smoke test dùng `SNAP_TOLERANCE` dùng chung
    - Xác minh validator import `SNAP_TOLERANCE` từ `sharedGeometry` (0,01 mm), không dùng hằng số nội bộ riêng
    - File: `contourValidator.test.ts`
    - _Requirements: 2.4_

  - [x]* 2.3 Viết property test phân loại khép kín dựa trên biên ngoài
    - **Property 1: Phân loại khép kín dựa trên biên ngoài (bỏ qua đặc trưng cắt nội bộ)**
    - **Validates: Requirements 1.1, 1.3, 1.4, 2.1, 2.2, 2.5, 3.4**
    - File: `contourValidator.test.ts`; bắt đầu từ model biên ngoài kín, thêm Interior_Cut_Feature → vẫn `allClosed=true`; dịch một đầu mút THUỘC biên ngoài đi `d > SNAP_TOLERANCE` → hở với `|gapMm − d| ≤ 0,01 mm`; lặp lại giống hệt; ≥100 iterations, seed ghi nhận

  - [x]* 2.4 Viết property test panel đại diện xác định
    - **Property 2: Panel đại diện của biên ngoài hở là xác định**
    - **Validates: Requirements 2.3**
    - File: `contourValidator.test.ts`; Panel chứa nhiều đoạn biên ngoài hở nhất, đồng hạng → chỉ số thấp nhất, không đổi giữa các lần đánh giá

- [x] 3. Workstream A — Cổng xuất chỉ chặn khi biên ngoài hở
  - [x] 3.1 Hiện thực `decideExportGate` và wire vào `downloadPDF`
    - Thêm kiểu `ExportGateDecision = { kind: 'created' } | { kind: 'cancelled'; warnings: OpenContourWarning[] }`
    - Hiện thực hàm thuần `decideExportGate(result, confirmed)` làm điểm quan sát được cho test cổng
    - Giữ nguyên chữ ký `downloadPDF(model, filename?, confirmOpenContours?)` trả `Promise<void>`; `allClosed` → tạo file không hỏi; có biên hở → hiển thị cảnh báo (panel + `gapMm`), chỉ ghi khi callback `true`; không callback / `false` → không ghi đầu ra, model không đổi, kết thúc `cancelled`
    - _Requirements: 3.1, 3.2, 3.3, 3.5, 3.6_

  - [x]* 3.2 Viết example test cho `decideExportGate` và luồng cổng (mock)
    - allClosed → `created`; có biên hở + confirm `false`/không callback → `cancelled` (không ghi file một phần); confirm `true` → ghi. Mock writer + `confirmOpenContours`
    - File: `exportGate.test.ts`
    - _Requirements: 3.2, 3.3, 3.5_

  - [x]* 3.3 Viết property test validator/cổng không biến đổi model
    - **Property 3: Validator và cổng xuất không biến đổi model**
    - **Validates: Requirements 4.2, 3.6**
    - File: `contourValidator.test.ts`; deep-equal model trước/sau khi gọi `validateClosedContours` và chạy cổng tới `cancelled`; không ghi `Panel.outline`

  - [x]* 3.4 Viết property test mọi generator cho biên ngoài khép kín
    - **Property 4: Mọi generator cho biên ngoài khép kín (loại bỏ cảnh báo giả)**
    - **Validates: Requirements 3.1, 1.5**
    - File: `contourValidator.test.ts`; tái dùng `arbBoxParams(boxType)`, chạy riêng từng loại trong 8 generator (gồm rte/slb/envelope); mọi Cut_Piece kín hoặc chỉ-CREASE ⇒ `allClosed=true`; lỗi nêu tên generator + phản ví dụ shrunk + seed

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Workstream B — Phép offset polygon thực
  - [x] 5.1 Hiện thực `offsetPolygon` trong `nestingEngine.ts`
    - Hàm thuần `offsetPolygon(outline: Point2D[], offset: number): Point2D[]`
    - Kẹp âm: `offset < 0` → coi như 0, không thu nhỏ outline; chuẩn hóa hướng bằng dấu shoelace để pháp tuyến hướng ra ngoài
    - Đẩy mỗi cạnh ra `offset` theo pháp tuyến ngoài, nối góc lồi bằng giao điểm (miter có kẹp); với outline lõm gây tự cắt, tạo đa giác offset không tự cắt bao trọn outline gốc đã giãn `dieGap`
    - Snap mọi tọa độ theo `SNAP_TOLERANCE` để bit-identical; giữ đơn vị mm
    - _Requirements: 5.2, 5.6, 5.7, 6.1, 6.4, 6.5, 6.6, 6.8_

  - [x]* 5.2 Viết property test offset bao trọn outline gốc
    - **Property 5: Đa giác offset bao trọn outline gốc**
    - **Validates: Requirements 5.2, 5.6, 6.1**
    - File: `polygonOffset.test.ts`; `arbSimplePolygon`/`arbConcavePolygon`, mọi đỉnh gốc nằm trong/trên biên offset (lệch ngoài ≤ 0,01 mm), offset không tự cắt; ≥100 iterations, seed ghi nhận

  - [x]* 5.3 Viết property test đơn điệu diện tích
    - **Property 6: Offset không làm giảm diện tích**
    - **Validates: Requirements 6.2**
    - File: `polygonOffset.test.ts`; diện tích offset ≥ diện tích gốc; `dieGap=0` → bằng nhau trong 0,001 mm²

  - [x]* 5.4 Viết property test xác định bit-identical
    - **Property 7: Offset là xác định và bit-identical**
    - **Validates: Requirements 6.3, 6.6**
    - File: `polygonOffset.test.ts`; hai lần gọi cùng số đỉnh, cùng thứ tự, lệch tọa độ 0 mm

  - [x]* 5.5 Viết property test offset hình chữ nhật
    - **Property 8: Offset hình chữ nhật giãn đúng dieGap mỗi cạnh**
    - **Validates: Requirements 6.4**
    - File: `polygonOffset.test.ts`; `arbRectangle`, mỗi cạnh ra đúng `dieGap`, mỗi chiều tăng `2×dieGap` trong 0,001 mm

  - [x] 5.6 Hiện thực `computeDieOutline` trong `nestingEngine.ts`
    - `computeDieOutline(model, bbox): Point2D[]` dùng Outer_Silhouette khi "sẵn có" (≥3 đỉnh, diện tích > 0, `gapMm ≤ SNAP_TOLERANCE`)
    - Ngược lại / suy biến (< 3 đỉnh phân biệt hoặc diện tích ≤ 0,001 mm²) → đa giác chữ nhật suy ra từ `boundingBox` làm đầu vào offset thay thế
    - _Requirements: 5.1, 6.7_

  - [x]* 5.7 Viết example test `computeDieOutline` và kẹp âm
    - Outer_Silhouette sẵn có → dùng nó; suy biến/không hợp lệ → bbox-rect; `dieGap < 0` → kết quả bằng `dieGap = 0` (không thu nhỏ)
    - File: `polygonOffset.test.ts`
    - _Requirements: 5.1, 5.7, 6.7, 6.8_

- [x] 6. Workstream B — Tích hợp va chạm theo polygon vào `calculateNesting`
  - [x] 6.1 Sửa `calculateNesting` dùng va chạm polygon
    - Giữ nguyên chữ ký `calculateNesting(bbox, config, params?)` và các kiểu trong `nestingTypes.ts`
    - Tính `outline = computeDieOutline(...)` một lần; với mỗi góc thuộc `{0°,90°,180°,270°}` xoay outline TRƯỚC rồi `offsetPolygon(rotated, dieGap)` SAU, cùng `offset = dieGap`
    - Vị ngữ va chạm: keep-out offset của một khuôn không chồng lấn outline gốc khuôn kia (diện tích giao ≤ 0,01 mm²); `dieGap=0` cho phép tiếp xúc biên; mọi khuôn nằm trọn vùng in khả dụng (≤ 0,01 mm vượt biên); kết quả xác định
    - _Requirements: 5.3, 5.4, 5.5, 7.2, 7.3, 7.4, 7.5, 8.5_

  - [x]* 6.2 Viết property test clearance/không va chạm
    - **Property 9: Các khuôn đã đặt không va chạm và giữ đúng khoảng hở dieGap**
    - **Validates: Requirements 5.3, 5.4, 5.5, 7.2**
    - File: `nestingEngine.test.ts`; `arbNestingInput`, mọi cặp khuôn: keep-out ∩ outline gốc khuôn kia ≤ 0,01 mm², khoảng cách outline gốc ≥ `dieGap − 0,01 mm`; ≥100 iterations, seed ghi nhận

  - [x]* 6.3 Viết property test mọi khuôn trong vùng in
    - **Property 10: Mọi khuôn đặt nằm trong vùng in khả dụng**
    - **Validates: Requirements 7.3**
    - File: `nestingEngine.test.ts`; mọi Die_Outline đã đặt nằm trọn vùng in (khổ trừ lề + cắn nhíp), không vượt biên quá 0,01 mm

  - [x]* 6.4 Viết property test xoay rồi offset, chỉ tập góc hỗ trợ
    - **Property 12: Offset áp dụng sau khi xoay, chỉ với góc được hỗ trợ**
    - **Validates: Requirements 7.4, 7.5**
    - File: `nestingEngine.test.ts`; keep-out = `offsetPolygon(rotate(outline, θ), dieGap)` với `θ ∈ {0°,90°,180°,270°}`; mọi khuôn chỉ mang góc thuộc tập đó

- [x] 7. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Workstream B — Lồng theo hình dạng & tương thích Giai đoạn 1
  - [x]* 8.1 Viết property test metamorphic không kém Bounding_Box_Gap
    - **Property 11: Lồng theo hình dạng không kém Bounding_Box_Gap**
    - **Validates: Requirements 7.1**
    - File: `nestingEngine.test.ts`; khuôn không-chữ-nhật, cùng cấu hình → số khuôn Polygon_Offset ≥ Bounding_Box_Gap

  - [x]* 8.2 Viết property test trường hợp chữ nhật tương đương Giai đoạn 1
    - **Property 13: Trường hợp chữ nhật tương đương Giai đoạn 1**
    - **Validates: Requirements 8.1**
    - File: `nestingEngine.test.ts`; outline chữ nhật → cùng tập khuôn, vị trí trong 0,001 mm, cùng góc thuộc {0°,90°,180°,270°}; không nới dung sai đã ghim

  - [x]* 8.3 Viết property test xác định kết quả lồng khuôn
    - **Property 14: Kết quả lồng khuôn là xác định**
    - **Validates: Requirements 8.5**
    - File: `nestingEngine.test.ts`; cùng `bbox`/`config`/`params` → `NestingResult` giống hệt (positions, countPerSheet, rows, cols, ...)

- [x] 9. Cập nhật tài liệu `dieGap`
  - [x] 9.1 Cập nhật JSDoc `dieGap` trong `nestingTypes.ts`
    - Mô tả `dieGap` nay là Polygon_Offset thực theo từng cạnh; GỠ ghi chú "known limitation Giai đoạn 2" liên quan offset polygon
    - Không thêm/đổi tên/gỡ trường hoặc tham số công khai
    - _Requirements: 8.3, 8.4_

  - [x]* 9.2 Viết static test kiểm tra nội dung chú thích
    - Đọc nguồn `nestingTypes.ts`: JSDoc `dieGap` mô tả Polygon_Offset thực; KHÔNG còn cụm "known limitation Giai đoạn 2"
    - File: `dieGapDoc.test.ts`
    - _Requirements: 8.3_

- [x] 10. Bảo toàn hình học generator & tương thích ngược
  - [x]* 10.1 Viết golden-master test cho 8 generator
    - Snapshot `panels`/`allPaths` của 8 generator khớp baseline Giai đoạn 1: mỗi PathSegment giữ `tag`/`type`/số điểm, mỗi tọa độ lệch ≤ 0,001 mm
    - File: `regression.test.ts` (tái dùng baseline Giai đoạn 1)
    - _Requirements: 4.1, 4.4_

  - [x]* 10.2 Viết smoke test chữ ký công khai
    - Xác minh `validateClosedContours`/`downloadPDF`/`calculateNesting` giữ số/kiểu tham số bắt buộc và kiểu trả về; 0 lỗi TS mới; mã gọi hiện có không sửa
    - File: `signature.smoke.test.ts`
    - _Requirements: 4.3, 8.4_

- [x] 11. Final checkpoint - Ensure all tests pass
  - Chạy `vitest run` đầy đủ (chế độ không-watch): giữ 503 test hiện có pass (trừ test nesting cập nhật tường minh theo 8.2), 0 fail/0 skip mới, lặp lại giống hệt
  - Xác nhận client-only TS, 0 network/backend, không thêm phụ thuộc ngoài phạm vi, không có tính năng Giai đoạn 2 ngoài hai workstream
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

## Notes

- Tasks marked with `*` are optional (test-related) and can be skipped for faster MVP.
- Mỗi property test gắn nhãn comment `// Feature: dieline-hardening-phase2, Property {number}: {property_text}` và chạy `fc.assert(prop, { numRuns: 100, seed: <seed ghi nhận> })` (Requirement 9.4).
- Mỗi task tham chiếu sub-requirement cụ thể để truy vết; mỗi property task tham chiếu property tương ứng trong design.
- Property test phủ các bất biến hình học/đại số (Property 1–14); example/unit/smoke test phủ luồng cổng xuất, chọn nguồn outline, fallback, chữ ký công khai và nội dung tài liệu.
- Hai workstream độc lập về mã/dữ liệu; chỉ chia sẻ hàm thuần chỉ-đọc `extractOuterSilhouette`.
- Golden-master (10.1) tái dùng baseline Giai đoạn 1; là điều kiện gate cho bất biến hình học (Requirement 4.4).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "5.1", "9.1"] },
    { "id": 1, "tasks": ["2.1", "5.6", "1.2", "5.2", "9.2"] },
    { "id": 2, "tasks": ["3.1", "6.1", "2.2", "5.3"] },
    { "id": 3, "tasks": ["2.3", "5.4", "6.2", "10.2", "3.2"] },
    { "id": 4, "tasks": ["2.4", "5.5", "6.3"] },
    { "id": 5, "tasks": ["3.3", "5.7", "6.4"] },
    { "id": 6, "tasks": ["3.4", "8.1"] },
    { "id": 7, "tasks": ["8.2", "10.1"] },
    { "id": 8, "tasks": ["8.3"] }
  ]
}
```
