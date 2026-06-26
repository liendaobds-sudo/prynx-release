# Design Document — Mockup 3D Realism

## Overview

Tài liệu thiết kế này mô tả cách nâng cấp khung xem 3D hiện có (`DielineScene3D`) và bảng tham số (`ParamPanel`) để đạt chất lượng hiển thị tiệm cận các phần mềm mockup chuyên nghiệp, đồng thời tuân thủ ràng buộc "chỉ chạy phía client, không backend, không telemetry" và "không hồi quy dieline 2D / generator / test hiện có".

Hướng tiếp cận chủ đạo:

- **Tách lớp logic khỏi lớp render.** Toàn bộ phép tính hình học (sinh tường cạnh, bù độ dày khi gập, ánh xạ UV theo mặt, clamp tham số) được tách thành các **hàm thuần (pure functions)** trong `desktop/src/lib/mockup3d/`. Lớp React/R3F chỉ tiêu thụ kết quả của các hàm này. Việc tách lớp giúp kiểm thử thuộc tính (property-based testing) bằng `fast-check` mà không cần WebGL.
- **Mở rộng, không sửa đổi phá vỡ.** Generator và `types.ts` (cấu trúc `Panel`/`DielineModel`) giữ nguyên byte-identical. Tính năng mới đọc dữ liệu hiện có (`outline`, `holes`, `pivotEdge`, `parent`, `foldPhase`, `params.T`) và bổ sung state mới vào store hoặc state cục bộ của component, không chạm vào đường dẫn sinh dieline.
- **Suy giảm chức năng có kiểm soát (graceful degradation).** Khi WebGL hoặc HDRI không khả dụng, hệ thống chuyển sang trạng thái dự phòng (đèn studio mặc định / thông báo lỗi) thay vì treo.

### Phạm vi công nghệ

| Hạng mục | Lựa chọn | Lý do |
|---|---|---|
| Render 3D | `@react-three/fiber` 9, `three` 0.184 | Đã có sẵn trong dự án (GĐ trong requirements) |
| Helpers cảnh | `@react-three/drei` 10 (`Environment`, `OrbitControls`, `AccumulativeShadows`/`ContactShadows`, `Html`, `useGLTF`) | Thuộc ngăn xếp three/r3f/drei (Yêu cầu 9.6) |
| Hình học tường cạnh | `THREE.ExtrudeGeometry` theo `THREE.Shape` của panel | Tạo solid có chiều dày + thành lỗ khoét tự động |
| Xuất ảnh | `gl.domElement.toBlob()` + `renderer.setSize` tạm thời | Hoàn toàn phía client (Yêu cầu 6.1, 6.5) |
| Xuất mô hình | `GLTFExporter` (binary GLB) từ `three/examples` | Phía client (Yêu cầu 6.6) |
| Kiểm thử | `vitest` 4 + `fast-check` 4 | Đã có trong `devDependencies` |

### Tham chiếu nguồn (kỹ thuật three.js)

- IBL/Environment & tone mapping: [three.js manual — Lighting / PMREM & tone mapping](https://threejs.org/manual/#en/lights). HDRI được nạp qua `Environment` của drei, dùng PMREM để tạo bản đồ phản chiếu; tone mapping (`ACESFilmicToneMapping`) đặt trên renderer. *Nội dung đã được diễn giải lại để tuân thủ giấy phép.*
- Xuất GLB: [three.js GLTFExporter docs](https://threejs.org/docs/#examples/en/exporters/GLTFExporter). *Đã diễn giải lại.*
- Soft/contact shadow: drei `ContactShadows`/`AccumulativeShadows` ([drei docs](https://github.com/pmndrs/drei#contactshadows)). *Đã diễn giải lại.*

## Architecture

### Sơ đồ thành phần

```mermaid
graph TD
    Store[useBoxStore + useMockupStore] --> Scene[DielineScene3D]
    Panel[ParamPanel / MockupPanel] --> Store

    subgraph Render Layer (React / R3F)
        Scene --> CanvasWrap[MockupCanvas]
        CanvasWrap --> EnvRig[EnvironmentRig]
        CanvasWrap --> CamRig[CameraRig]
        CanvasWrap --> SolidPanels[SolidPanelMesh*]
        CanvasWrap --> ShadowRig[ShadowFloor]
        CanvasWrap --> Overlay[DimensionOverlay]
        CanvasWrap --> Exporter[useSceneExport hook]
    end

    subgraph Logic Layer (pure, lib/mockup3d)
        Geo[panelSolid.ts]
        Fold[foldCompensation.ts]
        UV[artworkMapping.ts]
        Mat[materialLibrary.ts]
        Clamp[paramClamp.ts]
        ExpLogic[exportSizing.ts]
        Mask[maskValidation.ts]
    end

    SolidPanels --> Geo
    SolidPanels --> Fold
    SolidPanels --> UV
    SolidPanels --> Mat
    Panel --> Clamp
    Exporter --> ExpLogic
    Mat --> Mask
```

### Phân lớp

1. **Logic Layer** (`desktop/src/lib/mockup3d/`) — hàm thuần, không phụ thuộc React/DOM/WebGL. Đây là nơi đặt phần lớn các correctness property.
2. **Render Layer** (`desktop/src/components/dieline-tool/`) — các component R3F tiêu thụ logic layer; chứa side-effect (WebGL, tải file).
3. **State Layer** — mở rộng `useBoxStore` (hoặc store mới `useMockupStore`) chứa state mockup (finish, HDRI preset, artwork config, camera preset, exploded factor, overlay toggle). State mockup tách biệt để không can thiệp đường dẫn dieline.

### Ràng buộc cách ly (Yêu cầu 9)

- Generator và `types.ts`: **không sửa**. Nếu cần dữ liệu phụ (ví dụ pháp tuyến panel cho exploded view), tính toán phía render layer từ dữ liệu sẵn có, không thêm trường vào `Panel` được generator sinh ra.
- Canvas 2D & xuất 2D: không thay đổi mã. Tính năng 3D nằm ở nhánh `viewMode === '3d'`.
- Mạng: không thêm `fetch`/`XMLHttpRequest`/WebSocket. HDRI được đóng gói như asset tĩnh trong bundle (import cục bộ), nạp qua object URL/asset path do bundler phục vụ, không gọi backend.

## Components and Interfaces

### Logic Layer (hàm thuần)

```typescript
// lib/mockup3d/panelSolid.ts
/** Màu cạnh giấy hợp lệ */
export type EdgeColor = 'kraft' | 'white';
export const DEFAULT_EDGE_COLOR: EdgeColor = 'kraft';

/** Chuẩn hóa màu cạnh: giá trị ngoài tập hợp lệ → kraft (Yêu cầu 1.2, 1.3) */
export function normalizeEdgeColor(input: unknown): EdgeColor;

/** Chuẩn hóa độ dày hiển thị (Yêu cầu 1.4, 1.6, 1.7):
 *  - <=0 / NaN / undefined → 0.5
 *  - > 50 → 50
 *  - ngược lại giữ nguyên */
export function clampThickness(rawT: number | undefined): number;

/** Tạo ExtrudeGeometry solid cho 1 panel: mặt ngoài + mặt trong + tường cạnh
 *  khép kín dọc chu vi ngoài VÀ mọi lỗ khoét (Yêu cầu 1.1, 1.5).
 *  depth = clampThickness(params.T). */
export function buildPanelSolid(panel: Panel, thickness: number): THREE.ExtrudeGeometry;
```

```typescript
// lib/mockup3d/foldCompensation.ts
/** Tính lượng dịch bù độ dày cho panel khi gập, CHỈ dựa trên hình học
 *  (pivotEdge, parent, depth) — KHÔNG dùng tên panel (Yêu cầu 2.4).
 *  Trả về offset (mm) theo pháp tuyến trục gập, tỉ lệ theo thickness. */
export function computeFoldThicknessOffset(args: {
    depth: number;
    thickness: number;       // miền bù hợp lệ 0.01..5.00mm sau khi tỉ lệ
    foldAngleDeg: number;
}): number;

/** Kết quả áp bù cho 1 panel; nếu thiếu hình học → skip + cảnh báo (Yêu cầu 2.6) */
export interface FoldCompResult {
    matrix: THREE.Matrix4;
    skipped: boolean;
    warning?: string;        // "Panel <name> thiếu pivotEdge/parent/depth"
}
export function applyFoldCompensation(
    panel: Panel, allPanels: Panel[], foldProgress: number,
    depthMap: Map<string, number>, maxD: number, thickness: number,
): FoldCompResult;
```

```typescript
// lib/mockup3d/artworkMapping.ts
export type PlacementMode = 'per-face' | 'aligned-to-dieline';
export interface ArtworkTransform { scalePct: number; offsetXPct: number; offsetYPct: number; }

/** Clamp scale về [10,1000]%, offset về [-100,+100]% (Yêu cầu 5.6, 5.7, 5.8) */
export function clampArtworkTransform(t: ArtworkTransform): ArtworkTransform;

/** Tính UV cho panel theo mode.
 *  - aligned-to-dieline: ánh xạ theo globalBBox của dieline (Yêu cầu 5.2, sai số ≤1px)
 *  - per-face: ánh xạ theo bbox riêng của panel (Yêu cầu 5.1)
 *  Bảo đảm hướng đọc đúng, KHÔNG lật gương trục Y trên mặt ngoài (Yêu cầu 5.3). */
export function computePanelUV(
    panel: Panel, mode: PlacementMode, transform: ArtworkTransform,
    globalBBox: BBox, faceSide: 'outer' | 'inner',
): Float32Array;
```

```typescript
// lib/mockup3d/materialLibrary.ts
export type FinishId =
  | 'kraft' | 'sbs-white' | 'matte-lam' | 'gloss-lam' | 'spot-uv' | 'foil-metallic' | 'emboss';
export interface FinishSpec {
    id: FinishId; label: string;
    roughness: number; // 0..1
    metalness: number; // 0..1
    needsMask: boolean; // spot-uv, emboss
}
/** Tối thiểu 6 finish (Yêu cầu 4.1). Trả về roughness/metalness trong [0,1] (Yêu cầu 4.2). */
export const FINISH_LIBRARY: Record<FinishId, FinishSpec>;
export function getFinish(id: FinishId): FinishSpec;
```

```typescript
// lib/mockup3d/maskValidation.ts
export interface MaskValidationResult { valid: boolean; reason?: string; }
/** Kiểm tra mask spot-uv/emboss: đúng định dạng ảnh + kích thước khớp bề mặt
 *  (Yêu cầu 4.6). Không hợp lệ → valid=false + reason. */
export function validateMask(
    mask: { width: number; height: number; format: string } | null,
    surface: { width: number; height: number },
): MaskValidationResult;
```

```typescript
// lib/mockup3d/exportSizing.ts
export const MAX_EXPORT_PX = 16384;
export type ExportScale = 1 | 2 | 4;
export interface ExportSizeResult { ok: boolean; width: number; height: number; reason?: string; }
/** Nhân hệ số; nếu vượt 16384px ở W hoặc H → ok=false (Yêu cầu 6.4). */
export function computeExportSize(viewW: number, viewH: number, scale: ExportScale): ExportSizeResult;
```

### Render Layer (component R3F)

```typescript
// MockupCanvas.tsx — bao Canvas, đặt tone mapping + WebGL guard
interface MockupCanvasProps { /* đọc từ store */ }

// SolidPanelMesh.tsx — thay FlatPanelMesh: dùng buildPanelSolid + UV + material finish
// EnvironmentRig.tsx — quản lý HDRI preset, fallback đèn studio (Yêu cầu 3)
// CameraRig.tsx — 4 preset camera + chuyển cảnh ≤500ms (Yêu cầu 7.1, 7.2)
// ShadowFloor.tsx — contact/soft shadow + preset nền/sàn (Yêu cầu 3.5, 7.3, 7.4)
// DimensionOverlay.tsx — overlay L×W×H (Yêu cầu 7.7)
// useSceneExport.ts — hook xuất PNG/GLB phía client (Yêu cầu 6)
// useWebGLSupport.ts — phát hiện WebGL, trả cờ supported (Yêu cầu 8.4)
```

### Hook xuất cảnh

```typescript
// useSceneExport.ts
export function useSceneExport() {
  return {
    exportPNG(scale: ExportScale): Promise<void>; // toBlob → tải, lỗi → onError (Yêu cầu 6.1,6.3,6.5,6.7)
    exportGLB(): Promise<void>;                    // GLTFExporter → tải (Yêu cầu 6.6,6.8)
  };
}
```

## Data Models

### State mockup (mở rộng store)

```typescript
interface MockupState {
    edgeColor: EdgeColor;                 // 'kraft' | 'white', mặc định 'kraft'
    finishId: FinishId;                   // mặc định 'kraft'
    hdriPreset: string;                   // id preset HDRI (>=3 preset)
    cameraPreset: 'front' | 'top' | 'isometric' | 'orthographic';
    backgroundPreset: string;             // >=2 preset nền/sàn
    explodedFactor: number;               // 0.0..5.0, 0 = lắp ráp
    showDimensions: boolean;
    artwork: {
        outer: { url: string | null; transform: ArtworkTransform; };
        inner: { enabled: boolean; url: string | null; transform: ArtworkTransform; };
        mode: PlacementMode;
        showBleedSafe: boolean;
        spotUvMaskUrl: string | null;
        embossMaskUrl: string | null;
        embossHeightMm: number;           // 0.0..5.0
    };
    exportScale: ExportScale;             // mặc định 1
    hdriStatus: 'loading' | 'ready' | 'failed';
    webglSupported: boolean;
}
```

Các kiểu `Panel`, `DielineModel`, `BoxParams` **giữ nguyên** từ `types.ts`. Logic layer chỉ đọc.

### Bảng ánh xạ Finish → vật liệu PBR (giá trị khởi tạo)

| Finish | roughness | metalness | needsMask |
|---|---|---|---|
| kraft | 0.85 | 0.0 | false |
| sbs-white | 0.55 | 0.0 | false |
| matte-lam | 0.70 | 0.0 | false |
| gloss-lam | 0.12 | 0.0 | false |
| spot-uv | nền 0.7 / vùng mask 0.08 | 0.0 | true |
| foil-metallic | 0.25 | 0.9 | false |
| emboss | 0.6 | 0.0 | true |

## Correctness Properties

*Một property là một đặc tính hoặc hành vi phải đúng trên mọi lần thực thi hợp lệ của hệ thống — về bản chất là một phát biểu hình thức về điều hệ thống phải làm. Property là cầu nối giữa đặc tả cho người đọc và bảo đảm tính đúng đắn kiểm chứng được bằng máy.*

Các property dưới đây tập trung vào **logic layer thuần** (`lib/mockup3d/`) và tính hồi quy của generator — những phần mà biến thiên đầu vào thực sự bộc lộ lỗi. Các tiêu chí thuộc về render WebGL/IBL, hiệu năng, hay cấu hình danh sách được kiểm bằng integration/example/smoke test (xem Testing Strategy), không nằm ở đây.

### Property 1: Panel solid khép kín dọc chu vi và mọi lỗ khoét

*For any* panel hợp lệ (outline ≥ 3 đỉnh, kèm danh sách lỗ khoét tùy ý) và độ dày dương, geometry do `buildPanelSolid` sinh ra phải khép kín (manifold): mỗi cạnh biên của mặt ngoài và mặt trong — bao gồm cả mép của từng lỗ khoét — đều được nối bằng tường cạnh, không tồn tại cạnh biên hở.

**Validates: Requirements 1.1, 1.5**

### Property 2: Chuẩn hóa độ dày hiển thị

*For any* giá trị độ dày đầu vào (kể cả 0, số âm, NaN, undefined, hoặc > 50), `clampThickness` trả về: giá trị mặc định 0.5 khi không hợp lệ/≤0, đúng 50 khi > 50, và chính giá trị đó khi thuộc [0.1, 50]; bề dày của geometry kết quả bằng giá trị trả về với sai số ≤ 0.01 mm.

**Validates: Requirements 1.4, 1.6, 1.7**

### Property 3: Chuẩn hóa màu cạnh giấy

*For any* giá trị đầu vào, `normalizeEdgeColor` trả về chính giá trị đó nếu thuộc {kraft, white}, ngược lại luôn trả về kraft.

**Validates: Requirements 1.2, 1.3**

### Property 4: Bù độ dày tỉ lệ theo độ dày và độc lập với tên panel

*For any* panel có quan hệ gập và độ dày trong miền hợp lệ, lượng bù do `computeFoldThicknessOffset` tính ra tỉ lệ đơn điệu không giảm theo độ dày và luôn nằm trong miền bù [0.01, 5.00] mm sau khi tỉ lệ; đồng thời, đổi thuộc tính `name` của panel (giữ nguyên `pivotEdge`/`parent`/`depth`) không làm thay đổi lượng bù.

**Validates: Requirements 2.1, 2.4**

### Property 5: Gập hoàn toàn cho khít không xuyên, không hở

*For any* cây panel hợp lệ, khi `foldProgress = 1` và đã áp bù độ dày, mọi cặp panel kề nhau có độ giao cắt thể tích ≤ 5% độ dày vật liệu, và khe hở giữa các mép kề nhau ≤ 5% độ dày vật liệu.

**Validates: Requirements 2.2, 2.3**

### Property 6: Áp bù bảo toàn thứ tự và quan hệ gập

*For any* tập panel, sau khi `applyFoldCompensation` chạy, giá trị `foldPhase` và `depth` của mọi panel giữ nguyên không đổi so với trước khi áp bù.

**Validates: Requirements 2.5**

### Property 7: Panel thiếu hình học bị bỏ qua an toàn

*For any* panel có quan hệ gập nhưng thiếu hoặc không hợp lệ một trong các thuộc tính `pivotEdge`/`parent`/`depth`, `applyFoldCompensation` trả về `skipped = true`, kèm cảnh báo xác định panel đó, và ma trận giữ nguyên vị trí gập cơ bản (không áp bù).

**Validates: Requirements 2.6**

### Property 8: Giá trị PBR của mọi finish nằm trong miền hợp lệ

*For any* `FinishId` trong thư viện, `getFinish` trả về `roughness` và `metalness` đều thuộc [0.0, 1.0].

**Validates: Requirements 4.2**

### Property 9: Finish áp dụng đồng nhất cho toàn bộ panel

*For any* dieline với số lượng panel bất kỳ, sau khi chọn một finish, mọi panel của hộp đều được gán cùng một `FinishId` đã chọn.

**Validates: Requirements 4.4**

### Property 10: Spot-UV ánh xạ mask theo ngưỡng 50%

*For any* mặt nạ spot-UV, hàm ánh xạ trả về độ nhám "bóng" tại mọi điểm ảnh có giá trị mask > 50%, và giữ nguyên độ nhám của bề mặt nền tại mọi điểm còn lại.

**Validates: Requirements 4.3**

### Property 11: Giới hạn độ cao emboss

*For any* giá trị độ cao emboss đầu vào, giá trị được áp dụng luôn thuộc [0.0, 5.0] mm (clamp về biên gần nhất).

**Validates: Requirements 4.5**

### Property 12: Xác thực mặt nạ

*For any* mặt nạ và bề mặt áp dụng, `validateMask` trả về `valid = true` khi và chỉ khi mask có định dạng ảnh hợp lệ và kích thước khớp bề mặt; ngược lại trả về `valid = false` kèm lý do.

**Validates: Requirements 4.6**

### Property 13: Đặt ảnh per-face độc lập giữa các mặt

*For any* tập mặt và một mặt mục tiêu, khi gán ảnh ở chế độ per-face cho mặt mục tiêu, cấu hình ảnh/UV của mọi mặt khác giữ nguyên không đổi.

**Validates: Requirements 5.1**

### Property 14: Canh ảnh theo dieline khớp vị trí mặt

*For any* panel và bounding box toàn cục của dieline, UV do `computePanelUV` (chế độ aligned-to-dieline) sinh ra ánh xạ tuyến tính đúng vị trí của panel trong bounding box, sao cho biên ảnh trùng biên vùng mặt tương ứng (sai số quy đổi ≤ 1 px).

**Validates: Requirements 5.2**

### Property 15: Ảnh mặt ngoài giữ hướng đọc, không lật gương

*For any* hai điểm trên mặt ngoài có hoành độ tăng dần, tọa độ U tương ứng trong UV cũng tăng dần (ánh xạ không đảo trục ngang), bảo đảm nội dung không bị lật gương theo trục Y.

**Validates: Requirements 5.3**

### Property 16: Cấu hình mặt trong và mặt ngoài độc lập

*For any* cấu hình ảnh mặt ngoài và mặt trong, thay đổi cấu hình (ảnh, tỉ lệ, vị trí) của một mặt không làm thay đổi cấu hình của mặt còn lại.

**Validates: Requirements 5.4**

### Property 17: Clamp tỉ lệ và vị trí ảnh nghệ thuật

*For any* giá trị `ArtworkTransform` đầu vào, `clampArtworkTransform` trả về `scalePct` thuộc [10, 1000], `offsetXPct`/`offsetYPct` thuộc [-100, +100], luôn là giá trị hợp lệ gần nhất với đầu vào, và phép clamp là idempotent (`clamp(clamp(x)) = clamp(x)`).

**Validates: Requirements 5.6, 5.7, 5.8**

### Property 18: Giới hạn kích thước xuất ảnh

*For any* kích thước khung xem và hệ số xuất ∈ {1, 2, 4}, `computeExportSize` trả về `ok = true` khi và chỉ khi cả chiều rộng và chiều cao sau khi nhân hệ số đều ≤ 16384 px; nếu không, trả về `ok = false` và không thay đổi kích thước cảnh.

**Validates: Requirements 6.4**

### Property 19: Exploded view tỉ lệ theo hệ số tách

*For any* panel và hệ số tách đầu vào, vị trí panel sau khi tách dịch chuyển dọc pháp tuyến của nó một lượng tỉ lệ tuyến tính theo hệ số, với hệ số luôn được giới hạn trong [0.0, 5.0].

**Validates: Requirements 7.5**

### Property 20: Tách rồi gộp khôi phục vị trí lắp ráp (round-trip)

*For any* tập panel, áp dụng exploded view với hệ số bất kỳ rồi đặt hệ số về 0 sẽ đưa mọi panel trở về đúng vị trí lắp ráp ban đầu.

**Validates: Requirements 7.6**

### Property 21: Làm tròn kích thước overlay đến 0.1 mm

*For any* giá trị kích thước thực (dài/rộng/cao), giá trị hiển thị trong overlay bằng giá trị thực làm tròn đến 0.1 mm.

**Validates: Requirements 7.7**

### Property 22: Generator giữ tính tất định và không hồi quy

*For any* bộ tham số `BoxParams` hợp lệ, đầu ra của mỗi generator giống hệt (đối tượng/byte-identical) so với ảnh chụp baseline trước khi nâng cấp khi nhận cùng đầu vào.

**Validates: Requirements 9.1**

## Error Handling

| Tình huống lỗi | Yêu cầu | Hành vi |
|---|---|---|
| Màu cạnh không hợp lệ | 1.3 | `normalizeEdgeColor` → kraft, tiếp tục render |
| Độ dày ≤ 0 / NaN / undefined | 1.6 | `clampThickness` → 0.5 mm |
| Độ dày > 50 mm | 1.7 | `clampThickness` → 50 mm |
| Panel thiếu pivotEdge/parent/depth | 2.6 | `applyFoldCompensation` skip bù, giữ vị trí cơ bản, đẩy cảnh báo vào `model.warnings`/console (không ném lỗi) |
| HDRI nạp lỗi hoặc quá 10 s | 3.6 | `EnvironmentRig` đặt `hdriStatus='failed'`, chuyển sang đèn studio mặc định, hiển thị banner trạng thái |
| Mask spot-uv/emboss không hợp lệ | 4.6 | `validateMask` từ chối, giữ finish hiện tại, hiển thị thông báo lỗi |
| scale/offset ngoài miền | 5.8 | `clampArtworkTransform` về biên gần nhất, giữ render hợp lệ trước đó |
| Ảnh nghệ thuật nạp lỗi | 5.9 | Hiển thị bề mặt với finish hiện tại, báo lỗi, giữ scale/offset |
| Kích thước xuất > 16384 px | 6.4 | `computeExportSize` ok=false, giữ cảnh, báo lỗi |
| Xuất PNG thất bại | 6.7 | Bắt exception trong `exportPNG`, giữ cảnh, báo lỗi |
| Xuất GLB thất bại | 6.8 | Bắt exception trong `exportGLB`, giữ cảnh, báo lỗi |
| Trình duyệt không hỗ trợ WebGL | 8.4 | `useWebGLSupport` → false, render fallback UI, app vẫn phản hồi |

Nguyên tắc chung: các hàm logic thuần không ném exception cho input "không hợp lệ về dữ liệu" mà trả về giá trị đã chuẩn hóa/cờ lỗi; các side-effect (xuất file, nạp tài nguyên) bọc trong try/catch và báo lỗi qua state để UI hiển thị, không làm treo cảnh.

## Testing Strategy

### Cách tiếp cận kép

- **Property-based test (`fast-check` + `vitest`)**: kiểm 22 property ở trên trên lớp logic thuần. Mỗi test chạy **tối thiểu 100 iteration** (`fc.assert(fc.property(...), { numRuns: 100 })`).
- **Unit test (ví dụ/edge-case)**: cấu hình danh sách (3.2, 4.1, 6.2, 7.1, 7.3), reducer xử lý lỗi/trạng thái (3.6, 5.9, 6.7, 6.8, 7.4, 8.4), và các nhánh cụ thể.
- **Integration/smoke test (render + ràng buộc)**: mount component R3F bằng jsdom để xác nhận wiring (Environment, ShadowFloor, tone mapping), spy `fetch`/`XHR`/`WebSocket` để chứng minh 0 backend/telemetry request (9.5), golden test cho dieline 2D/generator (9.1, 9.3), và chạy toàn bộ suite hiện có để bảo đảm không hồi quy (9.4).

### Vì sao PBT áp dụng được ở đây

Phần lớn độ phức tạp nằm ở **hình học và biến đổi tham số** — hàm thuần với miền đầu vào lớn (đa giác, độ dày, góc gập, tỉ lệ/vị trí ảnh, kích thước xuất). Đây là nơi PBT bộc lộ edge case (đa giác lõm, lỗ khoét, độ dày biên, giá trị ngoài miền) hiệu quả hơn nhiều so với vài ví dụ cố định. Ngược lại, IBL/HDRI/đổ bóng/hiệu năng/FPS không có quan hệ "for all input → property" có ý nghĩa nên dùng integration/smoke.

### Thư viện và cấu hình

- Dùng `fast-check` 4 (đã có trong `devDependencies`), không tự cài đặt PBT từ đầu.
- Đặt test logic tại `desktop/src/lib/mockup3d/__tests__/*.pbt.test.ts`.
- Mỗi property test gắn thẻ tham chiếu đến property trong tài liệu này theo định dạng:
  `// Feature: mockup-3d-realism, Property {number}: {property_text}`
- Mock WebGL (jsdom + stub `WebGLRenderingContext`) cho các test logic để không phụ thuộc GPU; geometry property kiểm tra trên cấu trúc `BufferGeometry`/đỉnh (CPU-side), không cần render thực.

### Bảng truy vết tiêu chí → loại test

| Loại | Tiêu chí |
|---|---|
| PROPERTY | 1.1, 1.3, 1.4, 1.5, 1.6, 1.7, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 4.2, 4.3, 4.4, 4.5, 4.6, 5.1, 5.2, 5.3, 5.4, 5.6, 5.7, 5.8, 6.4, 7.5, 7.6, 7.7, 9.1 |
| EXAMPLE | 1.2, 3.2, 3.6, 4.1, 5.5, 5.9, 6.2, 6.7, 6.8, 7.1, 7.3, 7.4, 8.3, 8.4 |
| INTEGRATION | 3.1, 3.3, 3.5, 6.1, 6.3, 6.5, 6.6, 7.2, 8.1, 8.2, 9.3, 9.5 |
| SMOKE | 3.4, 9.2, 9.4, 9.6, 9.7 |
