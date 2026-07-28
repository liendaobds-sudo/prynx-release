# Nhật ký sửa hộp âm dương — 2026-07-27

## Lô 1 — Pose và động học 3D

- `desktop/src/lib/dieline/types.ts`
  - Mở rộng `DielineNesting` với pivot, góc xoay và choreography nhiều pha.
- `desktop/src/lib/dieline/DoubleTray.ts`
  - Giữ nguyên hình học 2D/CUT/CREASE.
  - Thêm pose nắp lật 180° quanh trục ngang tại tâm root; không xoay phẳng như cái đĩa.
  - Choreography: lật 180° tại tâm → nâng lên cao → di chuyển ngang về tâm khay → hạ xuống, không xoay thêm.
- `desktop/src/components/dieline-tool/DielineScene3D.tsx`
  - Đọc pose trực tiếp từ `foldLive`.
  - Dùng quaternion tuyệt đối, nội suy theo đường ngắn nhất.
  - Tách artwork `base=tray`, `lid=sleeve`.
- `desktop/src/components/dieline-tool/SolidPanelMesh.tsx`
  - Nén tiến trình gấp về [0, 0.8] trước khi chạy choreography lồng/chụp.
- `desktop/src/lib/mockup3d/__tests__/foldPrintOutward.test.ts`
  - Khóa lật 180° tại tâm root, pivot, cao độ nâng và thứ tự pha.
  - Khóa hướng mặt ngoài của bốn thành cho cả base/lid.

## Verify

- `npm.cmd run typecheck`: đạt.
- Test riêng Double Tray trong `foldPrintOutward.test.ts`: 2/2 đạt.
- `npm.cmd run build:dieline-sidecar`: đạt.
- `npm.cmd run check:dieline-webview`: đạt.
- Bộ test gộp trước đó còn lỗi Auto-bottom `bottom_tab_front/back`; lỗi nằm ngoài phạm vi Double Tray.

## Lô tiếp theo

Chưa tối ưu chi phí 50 panel trong animation cho đến khi kiểm tay xác nhận choreography mới đúng. Sau đó profile trước/sau rồi mới sửa cache ma trận theo quy trình `prynx-performance`.
## Lô 2 — Tối ưu animation 50 panel

### Thay đổi

- `desktop/src/lib/mockup3d/foldCompensation.ts`
  - Cache `name → panel` và chuỗi cha theo identity model bằng `WeakMap`.
  - Bỏ `Set` và `allPanels.find(...)` lặp lại cho từng panel trong từng frame.
  - Thêm `FoldCompensationScratch` để tái sử dụng ba `Matrix4` thay vì cấp phát lại.
- `desktop/src/components/dieline-tool/SolidPanelMesh.tsx`
  - Mỗi panel giữ scratch matrix riêng và tái sử dụng trong toàn bộ animation.
- `desktop/src/components/dieline-tool/DielineScene3D.tsx`
  - `BoxScene` chỉ subscribe `dieline`, `foldProgress`, `mockupTextureUrl`; thay đổi store không liên quan không dựng lại cây 50 panel.
  - Guard pose khi chạy test renderer không có đối tượng Three.js thật.
- `desktop/src/lib/mockup3d/__tests__/foldCompensation.fullFold.pbt.test.ts`
  - Khóa việc tái sử dụng scratch và đối chiếu ma trận với đường gọi chuẩn.

Không thay DPR, shadow, chất lượng vật liệu, số panel hoặc thêm cap theo phần cứng.

### Đo trước/sau

Benchmark cục bộ trên cùng model Double Tray 50 panel, 360 frame, median 7 mẫu; đối chiếu trực tiếp code trước Lô 2 từ `HEAD` với code mới:

| Lần đo | Bản cũ | Bản mới | Nhanh hơn |
|---|---:|---:|---:|
| 1 | 21.31 ms | 13.46 ms | 1.58× |
| 2 | 26.13 ms | 14.65 ms | 1.78× |

Ma trận của toàn bộ 50 panel tại 0%, 20%, 40%, 80%, 100% trùng bản cũ đến 10 chữ số thập phân.

### Verify

- `npm.cmd run typecheck`: đạt.
- Property test `foldCompensation`: đạt; test scratch mới 2/2 đạt.
- Test hồi quy RTE, Pizza, Matchbox/Tray và Double Tray + render wiring: 23/23 đạt.
- Toàn bộ `src/lib/mockup3d`: 30/31 file đạt, 133/134 test đạt; còn lỗi Auto-bottom `bottom_tab_front/back` đã tồn tại trước Lô 2.
- `generators.test.ts` + `trayParts.test.ts`: 82/82 đạt.
- `renderWiring.integration.test.ts`: 16/16 đạt.
- `git diff --check` phạm vi Lô 2: đạt.
- Lint phạm vi vẫn báo các lỗi có sẵn trong `DielineScene3D.tsx` và `SolidPanelMesh.tsx`; `foldCompensation.ts` không phát sinh lỗi lint mới.
## Hotfix bóng 3D — DT3D-007

Triệu chứng: contact shadow xuất hiện sọc ngang/moire và chớp ở đầu/cuối animation.

- `desktop/src/components/dieline-tool/ShadowFloor.tsx`
  - Tách mặt sàn và lưới sang layer hiển thị riêng; camera depth của `ContactShadows` không còn capture chính mặt sàn.
  - Bỏ remount `ContactShadows` bằng `key`, tránh render target bị xóa/tạo lại gây nháy.
  - Giữ texture bóng hiện tại trong animation (`frames=0`) và chụp lại một lần khi scene đứng yên (`frames=1`).
- `desktop/src/components/dieline-tool/DielineScene3D.tsx`
  - Truyền trạng thái freeze khi animation gấp hoặc hero demo đang chạy.
- `desktop/src/components/dieline-tool/__tests__/renderWiring.integration.test.ts`
  - Khóa trình tự bóng: đứng yên `1` → animation `0` → đứng yên `1`.

Không giảm resolution 512, blur, opacity, DPR, shadow hay chất lượng vật liệu.

Verify:

- `npm.cmd run typecheck`: đạt.
- `renderWiring.integration.test.ts`: 17/17 đạt.
- `git diff --check` phạm vi hotfix: đạt.
- Chưa kiểm pixel WebGL tự động; cần kiểm tay trong app ở góc camera xiên và trong suốt animation.
## Hotfix bóng 3D — DT3D-008

Hộp âm dương dùng cùng ContactShadows với các loại hộp khác. Khác biệt gây sọc là hai mảnh khuôn có nhiều đường CAD nằm sát mặt giấy; depth pass đã coi các đường chú thích này như vật thể đổ bóng.

- desktop/src/components/dieline-tool/renderLayers.ts
  - Tạo layer hiển thị dùng chung cho sàn, lưới và đường CAD; camera chính vẫn thấy, camera chụp bóng không thấy.
- desktop/src/components/dieline-tool/SolidPanelMesh.tsx
  - Chuyển toàn bộ đường CẮT/CẤN vào layer hiển thị, chỉ mesh giấy và dải bo nếp gấp tham gia tạo bóng.
- desktop/src/components/dieline-tool/ShadowFloor.tsx
  - Dùng cùng hằng số layer thay vì cơ chế riêng cho mặt sàn.
- desktop/src/components/dieline-tool/__tests__/renderLayers.test.ts
  - Khóa việc camera chính nhìn thấy layer CAD và camera bóng mặc định loại bỏ layer đó.

Không giảm resolution, blur, opacity, DPR hoặc chất lượng vật liệu.

Verify:

- npm.cmd run typecheck: đạt.
- renderLayers.test.ts + renderWiring.integration.test.ts: 18/18 đạt.
- Lint hai file mới: đạt.
- git diff --check phạm vi hotfix: đạt.
