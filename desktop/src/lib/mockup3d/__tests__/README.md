# Tests — `lib/mockup3d`

Quy ước đặt tên test cho lớp logic thuần Mockup 3D Realism.

## Quy ước

- **Property-based test** (`fast-check` + `vitest`): đặt tên `*.pbt.test.ts`.
  - Mỗi file ánh xạ 1-1 tới một property trong `design.md`.
  - Ví dụ: `panelSolid.clampThickness.pbt.test.ts`.
  - Mỗi property test chạy **tối thiểu 100 iteration** (`fc.assert(fc.property(...), { numRuns: 100 })`).
  - Gắn thẻ tham chiếu theo định dạng:
    `// Feature: mockup-3d-realism, Property {number}: {property_text}`
  - Gắn liên kết tiêu chí: `**Validates: Requirements X.Y**`.
- **Unit test (ví dụ/edge-case)**: đặt tên `*.test.ts` (không có hậu tố `.pbt`).
  - Dùng cho cấu hình danh sách, nhánh lỗi/trạng thái, và các ví dụ cụ thể.

## Phạm vi

Chỉ kiểm thử **hàm thuần** (không phụ thuộc React/DOM/WebGL). Geometry kiểm tra
trên cấu trúc `BufferGeometry`/đỉnh phía CPU; không cần render thực.
