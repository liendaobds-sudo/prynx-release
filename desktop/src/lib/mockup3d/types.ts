// ============================================================
// Local Type Definitions — Mockup 3D Realism (Logic Layer)
//
// Các kiểu cục bộ cho lớp logic thuần `lib/mockup3d/`.
// Quy ước: KHÔNG sửa `lib/dieline/types.ts`. Chỉ import kiểu
// `Panel`/`DielineModel`/`BoxParams` từ đó ở dạng read-only khi
// các module logic cần (re-export bên dưới để tiện tiêu thụ).
// _Requirements: 9.2_
// ============================================================

// Re-export (read-only) các kiểu lõi từ generator hiện có.
// Không định nghĩa lại — chỉ tham chiếu để giữ một nguồn sự thật.
export type { Panel, DielineModel, BoxParams, Point2D } from '../dieline/types';

/**
 * Hộp bao (axis-aligned bounding box) theo đơn vị mm.
 * Cùng quy ước với `DielineModel.boundingBox` để ánh xạ UV
 * theo dieline (chế độ aligned-to-dieline).
 */
export interface BBox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
}

/**
 * Màu cạnh giấy hợp lệ của tường cạnh panel.
 * Giá trị mặc định là `kraft` (xem `DEFAULT_EDGE_COLOR` trong `panelSolid.ts`).
 * _Requirements: 1.2, 1.3_
 */
export type EdgeColor = 'kraft' | 'white';

/**
 * Chế độ đặt ảnh nghệ thuật.
 * - `per-face`: ánh xạ theo bbox riêng của từng mặt.
 * - `aligned-to-dieline`: ánh xạ theo bbox toàn cục của dieline.
 * _Requirements: 5.1, 5.2_
 */
export type PlacementMode = 'per-face' | 'aligned-to-dieline';

/**
 * Biến đổi đặt ảnh nghệ thuật (tỉ lệ + dịch chuyển), đơn vị phần trăm.
 * - `scalePct`: tỉ lệ so với kích thước gốc, miền hợp lệ [10, 1000].
 * - `offsetXPct`/`offsetYPct`: dịch theo trục, miền hợp lệ [-100, +100].
 * _Requirements: 5.6, 5.7, 5.8_
 */
export interface ArtworkTransform {
    scalePct: number;
    offsetXPct: number;
    offsetYPct: number;
    /** Góc xoay ảnh (độ), miền [-180, 180]. Mặc định 0. (Tùy chọn để tương thích ngược.) */
    rotationDeg?: number;
    /** Lật ngang ảnh (gương trục dọc). Mặc định false. */
    flipH?: boolean;
    /** Lật dọc ảnh (gương trục ngang). Mặc định false. */
    flipV?: boolean;
}

/**
 * Chất liệu giấy (substrate) — tách khỏi gia công bề mặt.
 */
export type SubstrateId = 'kraft' | 'sbs-white';

/**
 * Gia công bề mặt (finish) — cán / UV / ép kim / dập nổi.
 * `none` = chỉ giấy trần, không phủ.
 */
export type SurfaceFinishId =
    | 'none'
    | 'matte-lam'
    | 'gloss-lam'
    | 'spot-uv'
    | 'foil-metallic'
    | 'emboss';

/**
 * @deprecated Legacy 1-axis id (gộp giấy + finish). Giữ cho test/preset cũ.
 * Runtime mới dùng `SubstrateId` + `SurfaceFinishId`.
 * _Requirements: 4.1_
 */
export type FinishId =
    | 'kraft'
    | 'sbs-white'
    | 'matte-lam'
    | 'gloss-lam'
    | 'spot-uv'
    | 'foil-metallic'
    | 'emboss';

/**
 * Hệ số nhân độ phân giải khi xuất ảnh render.
 * Mặc định 1x (xem `useMockupStore`).
 * _Requirements: 6.2_
 */
export type ExportScale = 1 | 2 | 4;
