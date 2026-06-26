# Implementation Plan: Mockup 3D Realism

## Overview

Triển khai theo nguyên tắc tách lớp logic thuần (`desktop/src/lib/mockup3d/`) khỏi lớp render R3F (`desktop/src/components/dieline-tool/`). Xây dựng và kiểm thử (property-based test với `fast-check` + `vitest`) toàn bộ hàm thuần trước, sau đó dựng các component render tiêu thụ logic đó, cuối cùng wiring vào `DielineScene3D`/`MockupPanel` dưới nhánh `viewMode === '3d'`. Generator và `types.ts` giữ nguyên byte-identical; không thêm request backend/telemetry.

Ngôn ngữ triển khai: **TypeScript** (theo design document, không cần chọn lại).

## Tasks

- [x] 1. Thiết lập khung logic layer mockup3d
  - [x] 1.1 Tạo cấu trúc thư mục `desktop/src/lib/mockup3d/` với `index.ts` (barrel export) và `types.ts` cục bộ (kiểu `BBox`, `EdgeColor`, `PlacementMode`, `ArtworkTransform`, `FinishId`, `ExportScale`)
    - Chỉ import kiểu `Panel`/`DielineModel`/`BoxParams` từ `types.ts` hiện có (read-only), KHÔNG sửa file đó
    - Thiết lập thư mục `__tests__/` và quy ước đặt tên `*.pbt.test.ts`
    - _Requirements: 9.2_

- [x] 2. Hình học panel solid + chuẩn hóa độ dày và màu cạnh
  - [x] 2.1 Triển khai `panelSolid.ts`: `normalizeEdgeColor`, `clampThickness`, hằng `DEFAULT_EDGE_COLOR`
    - clamp: ≤0/NaN/undefined → 0.5; >50 → 50; ngược lại giữ nguyên
    - normalize: ngoài {kraft, white} → kraft
    - _Requirements: 1.2, 1.3, 1.4, 1.6, 1.7_

  - [x]* 2.2 Property test cho `clampThickness`
    - **Property 2: Chuẩn hóa độ dày hiển thị**
    - **Validates: Requirements 1.4, 1.6, 1.7**
    - File riêng `__tests__/panelSolid.clampThickness.pbt.test.ts`, ≥100 iteration

  - [x]* 2.3 Property test cho `normalizeEdgeColor`
    - **Property 3: Chuẩn hóa màu cạnh giấy**
    - **Validates: Requirements 1.2, 1.3**

  - [x]* 2.4 Unit test ví dụ màu cạnh mặc định kraft
    - Kiểm giá trị mặc định khi không chỉ định
    - _Requirements: 1.2_

  - [x] 2.5 Triển khai `buildPanelSolid` (ExtrudeGeometry: mặt ngoài + mặt trong + tường cạnh chu vi và mọi lỗ khoét)
    - depth = `clampThickness(params.T)`; tường khép kín dọc outline và mỗi hole
    - _Requirements: 1.1, 1.5_

  - [x]* 2.6 Property test khép kín (manifold) của panel solid
    - **Property 1: Panel solid khép kín dọc chu vi và mọi lỗ khoét**
    - **Validates: Requirements 1.1, 1.5**

- [x] 3. Bù độ dày khi gập
  - [x] 3.1 Triển khai `foldCompensation.ts`: `computeFoldThicknessOffset` (chỉ dùng depth/thickness/foldAngle, clamp miền bù [0.01, 5.00] mm)
    - _Requirements: 2.1, 2.4_

  - [x] 3.2 Triển khai `applyFoldCompensation` (trả `FoldCompResult`: matrix/skipped/warning; giữ nguyên `foldPhase`/`depth`; skip khi thiếu pivotEdge/parent/depth)
    - _Requirements: 2.2, 2.3, 2.5, 2.6_

  - [x]* 3.3 Property test tỉ lệ bù & độc lập tên panel
    - **Property 4: Bù độ dày tỉ lệ theo độ dày và độc lập với tên panel**
    - **Validates: Requirements 2.1, 2.4**

  - [x]* 3.4 Property test gập hoàn toàn không xuyên/không hở
    - **Property 5: Gập hoàn toàn cho khít không xuyên, không hở**
    - **Validates: Requirements 2.2, 2.3**

  - [x]* 3.5 Property test bảo toàn foldPhase/depth
    - **Property 6: Áp bù bảo toàn thứ tự và quan hệ gập**
    - **Validates: Requirements 2.5**

  - [x]* 3.6 Property test bỏ qua panel thiếu hình học
    - **Property 7: Panel thiếu hình học bị bỏ qua an toàn**
    - **Validates: Requirements 2.6**

- [x] 4. Thư viện vật liệu/finish và xác thực mask
  - [x] 4.1 Triển khai `materialLibrary.ts`: `FINISH_LIBRARY` (≥6 finish), `getFinish`, helper áp finish đồng nhất cho toàn bộ panel
    - _Requirements: 4.1, 4.2, 4.4_

  - [x] 4.2 Triển khai ánh xạ mask spot-UV (ngưỡng >50%) và clamp độ cao emboss [0.0, 5.0] mm trong `materialLibrary.ts`
    - _Requirements: 4.3, 4.5_

  - [x] 4.3 Triển khai `maskValidation.ts`: `validateMask` (định dạng ảnh hợp lệ + kích thước khớp bề mặt)
    - _Requirements: 4.6_

  - [x]* 4.4 Property test miền PBR của finish
    - **Property 8: Giá trị PBR của mọi finish nằm trong miền hợp lệ**
    - **Validates: Requirements 4.2**

  - [x]* 4.5 Property test finish đồng nhất toàn panel
    - **Property 9: Finish áp dụng đồng nhất cho toàn bộ panel**
    - **Validates: Requirements 4.4**

  - [x]* 4.6 Property test spot-UV ngưỡng 50%
    - **Property 10: Spot-UV ánh xạ mask theo ngưỡng 50%**
    - **Validates: Requirements 4.3**

  - [x]* 4.7 Property test giới hạn độ cao emboss
    - **Property 11: Giới hạn độ cao emboss**
    - **Validates: Requirements 4.5**

  - [x]* 4.8 Property test xác thực mask
    - **Property 12: Xác thực mặt nạ**
    - **Validates: Requirements 4.6**

  - [x]* 4.9 Unit test danh sách finish library (≥6 mục)
    - _Requirements: 4.1_

- [x] 5. Quy trình ánh xạ ảnh nghệ thuật
  - [x] 5.1 Triển khai `artworkMapping.ts`: `clampArtworkTransform` (scale [10,1000]%, offset [-100,+100]%, idempotent)
    - _Requirements: 5.6, 5.7, 5.8_

  - [x] 5.2 Triển khai `computePanelUV` (per-face + aligned-to-dieline theo globalBBox, giữ hướng đọc không lật gương Y)
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x]* 5.3 Property test clamp transform
    - **Property 17: Clamp tỉ lệ và vị trí ảnh nghệ thuật**
    - **Validates: Requirements 5.6, 5.7, 5.8**

  - [x]* 5.4 Property test đặt ảnh per-face độc lập
    - **Property 13: Đặt ảnh per-face độc lập giữa các mặt**
    - **Validates: Requirements 5.1**

  - [x]* 5.5 Property test canh ảnh aligned-to-dieline
    - **Property 14: Canh ảnh theo dieline khớp vị trí mặt**
    - **Validates: Requirements 5.2**

  - [x]* 5.6 Property test mặt ngoài không lật gương
    - **Property 15: Ảnh mặt ngoài giữ hướng đọc, không lật gương**
    - **Validates: Requirements 5.3**

  - [x]* 5.7 Property test độc lập mặt trong/mặt ngoài
    - **Property 16: Cấu hình mặt trong và mặt ngoài độc lập**
    - **Validates: Requirements 5.4**

- [x] 6. Logic xuất, exploded view và overlay kích thước
  - [x] 6.1 Triển khai `exportSizing.ts`: `computeExportSize` (giới hạn 16384 px)
    - _Requirements: 6.4_

  - [x] 6.2 Triển khai `explodedView.ts`: tính offset theo pháp tuyến panel tỉ lệ hệ số (clamp [0.0, 5.0]) + khôi phục vị trí khi hệ số = 0
    - _Requirements: 7.5, 7.6_

  - [x] 6.3 Triển khai `dimensionFormat.ts`: làm tròn kích thước L×W×H đến 0.1 mm
    - _Requirements: 7.7_

  - [x]* 6.4 Property test giới hạn kích thước xuất
    - **Property 18: Giới hạn kích thước xuất ảnh**
    - **Validates: Requirements 6.4**

  - [x]* 6.5 Property test exploded tỉ lệ theo hệ số
    - **Property 19: Exploded view tỉ lệ theo hệ số tách**
    - **Validates: Requirements 7.5**

  - [x]* 6.6 Property test exploded round-trip
    - **Property 20: Tách rồi gộp khôi phục vị trí lắp ráp (round-trip)**
    - **Validates: Requirements 7.6**

  - [x]* 6.7 Property test làm tròn overlay 0.1 mm
    - **Property 21: Làm tròn kích thước overlay đến 0.1 mm**
    - **Validates: Requirements 7.7**

- [x] 7. Checkpoint - Logic layer
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. State layer cho mockup
  - [x] 8.1 Tạo `useMockupStore` với `MockupState` (edgeColor, finishId, hdriPreset, cameraPreset, backgroundPreset, explodedFactor, showDimensions, artwork{...}, exportScale, hdriStatus, webglSupported)
    - State tách biệt khỏi đường dẫn dieline, không sửa `useBoxStore` lõi
    - _Requirements: 4.4, 5.4, 7.4_

- [x] 9. Lớp render R3F
  - [x] 9.1 Triển khai `useWebGLSupport.ts` (phát hiện WebGL, trả cờ supported) và UI fallback khi không hỗ trợ
    - _Requirements: 8.4_

  - [x] 9.2 Triển khai `MockupCanvas.tsx` (bao `Canvas`, đặt `ACESFilmicToneMapping`, guard WebGL)
    - _Requirements: 3.4, 8.4_

  - [x] 9.3 Triển khai `EnvironmentRig.tsx` (≥3 HDRI preset studio qua drei `Environment`/PMREM, IBL + phản chiếu, fallback đèn studio + banner khi lỗi/quá 10s, asset HDRI import cục bộ)
    - _Requirements: 3.1, 3.2, 3.3, 3.6, 9.5_

  - [x] 9.4 Triển khai `CameraRig.tsx` (4 preset: front/top/isometric/orthographic, chuyển cảnh ≤500ms)
    - _Requirements: 7.1, 7.2_

  - [x] 9.5 Triển khai `ShadowFloor.tsx` (soft/contact shadow tại chân hộp + ≥2 preset nền/sàn giữ nguyên đến khi đổi)
    - _Requirements: 3.5, 7.3, 7.4_

  - [x] 9.6 Triển khai `DimensionOverlay.tsx` (overlay L×W×H bằng drei `Html`, dùng `dimensionFormat`)
    - _Requirements: 7.7_

  - [x] 9.7 Triển khai `MockupArtworkPanel.tsx` (điều khiển scale/offset, chế độ per-face/aligned, in mặt trong, bleed/safe-area, upload mask spot-uv/emboss, báo lỗi nạp ảnh giữ scale/offset)
    - _Requirements: 5.4, 5.5, 5.6, 5.7, 5.8, 5.9_

  - [x] 9.8 Triển khai `useSceneExport.ts` (exportPNG qua `toBlob` + resize tạm; exportGLB qua `GLTFExporter` GLB; tải file phía client; try/catch báo lỗi giữ cảnh)
    - _Requirements: 6.1, 6.3, 6.5, 6.6, 6.7, 6.8_

  - [x] 9.9 Triển khai `useDisposeResources.ts` (giải phóng geometry/material/texture không còn tham chiếu trước khi cấp phát mới)
    - _Requirements: 8.3_

  - [x] 9.10 Triển khai `SolidPanelMesh.tsx` thay `FlatPanelMesh` (tiêu thụ `buildPanelSolid` + `computePanelUV` + finish material + `applyFoldCompensation` + exploded offset)
    - _Requirements: 1.1, 2.1, 4.4, 5.1, 5.3, 7.5_

- [x] 10. Wiring vào khung xem hiện có
  - [x] 10.1 Tích hợp các component render vào `DielineScene3D.tsx` dưới nhánh `viewMode === '3d'` (Environment, Camera, ShadowFloor, SolidPanelMesh, Overlay, fallback WebGL), không chạm nhánh 2D
    - _Requirements: 3.1, 3.5, 7.1, 8.4, 9.3_

  - [x] 10.2 Nối các điều khiển `MockupPanel`/`ParamPanel` tới `useMockupStore` và hook export
    - _Requirements: 4.1, 6.1, 6.2, 6.6, 7.3_

- [x] 11. Kiểm thử hồi quy và tích hợp
  - [x]* 11.1 Golden test generator byte-identical
    - **Property 22: Generator giữ tính tất định và không hồi quy**
    - **Validates: Requirements 9.1**

  - [x]* 11.2 Integration test 0 backend/telemetry (spy `fetch`/`XMLHttpRequest`/`WebSocket`)
    - _Requirements: 9.5_

  - [x]* 11.3 Integration/smoke test wiring render (Environment, ShadowFloor, tone mapping, export PNG/GLB, camera transition) bằng jsdom + WebGL stub
    - _Requirements: 3.1, 3.3, 3.5, 6.1, 6.3, 6.5, 6.6, 7.2_

  - [x]* 11.4 Unit test nhánh lỗi/trạng thái (HDRI fail 3.6, ảnh fail 5.9, export PNG/GLB fail 6.7/6.8, đổi preset nền 7.4, WebGL unsupported 8.4)
    - _Requirements: 3.6, 5.9, 6.7, 6.8, 7.4, 8.4_

  - [x]* 11.5 Chạy toàn bộ suite dieline hiện có xác nhận không hồi quy + giữ nguyên chữ ký API generator
    - _Requirements: 9.2, 9.3, 9.4_

- [x] 12. Checkpoint cuối - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Các sub-task gắn `*` là tùy chọn (test) và có thể bỏ qua khi cần MVP nhanh; sub-task không gắn `*` là bắt buộc.
- Mỗi property test chạy tối thiểu 100 iteration và gắn thẻ `// Feature: mockup-3d-realism, Property {n}: {text}`.
- Mỗi task tham chiếu tiêu chí cụ thể để truy vết; property test ánh xạ 1-1 tới property trong design.
- Checkpoint bảo đảm kiểm chứng tăng dần; tiêu chí render WebGL/IBL/hiệu năng kiểm bằng integration/smoke test thay vì property.
- Generator, `types.ts`, canvas 2D và xuất 2D giữ nguyên (byte-identical); không thêm request backend/telemetry.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "3.1", "4.1", "4.3", "5.1", "6.1", "6.2", "6.3", "8.1", "9.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "2.5", "3.2", "4.2", "5.2", "3.3", "4.4", "4.5", "4.8", "4.9", "5.3", "6.4", "6.5", "6.6", "6.7", "9.2", "9.3", "9.4", "9.5", "9.6", "9.7", "9.8", "9.9"] },
    { "id": 3, "tasks": ["2.6", "3.4", "3.5", "3.6", "4.6", "4.7", "5.4", "5.5", "5.6", "5.7", "9.10"] },
    { "id": 4, "tasks": ["10.1", "10.2"] },
    { "id": 5, "tasks": ["11.1", "11.2", "11.3", "11.4", "11.5"] }
  ]
}
```
