// ============================================================
// Artwork Mapping — Mockup 3D Realism (Logic Layer)
//
// Hàm thuần ánh xạ ảnh nghệ thuật lên mặt hộp. Tách khỏi lớp
// render R3F để kiểm thử thuộc tính (PBT) mà không cần WebGL.
//
// Task 5.1 triển khai `clampArtworkTransform`.
// Task 5.2 triển khai `computePanelUV` (per-face + aligned-to-dieline).
// ============================================================

import type { ArtworkTransform, BBox, Panel, PlacementMode, Point2D } from './types';

/** Miền hợp lệ của tỉ lệ (scale), đơn vị phần trăm (Yêu cầu 5.6). */
export const SCALE_MIN_PCT = 10;
export const SCALE_MAX_PCT = 1000;

/** Miền hợp lệ của dịch chuyển (offset) theo mỗi trục, đơn vị phần trăm (Yêu cầu 5.7). */
export const OFFSET_MIN_PCT = -100;
export const OFFSET_MAX_PCT = 100;

/** Miền hợp lệ của góc xoay (độ). */
export const ROTATION_MIN_DEG = -180;
export const ROTATION_MAX_DEG = 180;

/** Giá trị mặc định khi đầu vào không phải số hữu hạn (NaN/undefined/Infinity). */
const DEFAULT_SCALE_PCT = 100;
const DEFAULT_OFFSET_PCT = 0;
const DEFAULT_ROTATION_DEG = 0;

/**
 * Giới hạn một số về đoạn [min, max].
 * Đầu vào không hữu hạn (NaN, undefined, ±Infinity) → trả về `fallback`.
 * Hàm này là idempotent với mọi đầu ra hợp lệ: clamp(clamp(x)) === clamp(x).
 */
function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
    if (value === undefined || !Number.isFinite(value)) {
        return fallback;
    }
    if (value < min) return min;
    if (value > max) return max;
    return value;
}

/**
 * Giới hạn `ArtworkTransform` về miền hợp lệ (Yêu cầu 5.6, 5.7, 5.8):
 * - `scalePct` → [10, 1000]
 * - `offsetXPct`/`offsetYPct` → [-100, +100]
 *
 * Giá trị ngoài miền được kéo về biên gần nhất. Giá trị không hợp lệ
 * (NaN/undefined/Infinity) được thay bằng mặc định an toàn (scale 100%,
 * offset 0%) để giữ bản render hợp lệ.
 *
 * Bảo đảm idempotent: `clampArtworkTransform(clampArtworkTransform(t))`
 * cho kết quả bằng `clampArtworkTransform(t)`.
 */
export function clampArtworkTransform(t: ArtworkTransform): ArtworkTransform {
    return {
        scalePct: clampNumber(t?.scalePct, SCALE_MIN_PCT, SCALE_MAX_PCT, DEFAULT_SCALE_PCT),
        offsetXPct: clampNumber(t?.offsetXPct, OFFSET_MIN_PCT, OFFSET_MAX_PCT, DEFAULT_OFFSET_PCT),
        offsetYPct: clampNumber(t?.offsetYPct, OFFSET_MIN_PCT, OFFSET_MAX_PCT, DEFAULT_OFFSET_PCT),
        rotationDeg: clampNumber(t?.rotationDeg, ROTATION_MIN_DEG, ROTATION_MAX_DEG, DEFAULT_ROTATION_DEG),
        flipH: !!t?.flipH,
        flipV: !!t?.flipV,
    };
}

// ============================================================
// computePanelUV — Task 5.2
// ============================================================

/**
 * Mặt áp ảnh: mặt ngoài (`outer`) hoặc mặt trong (`inner`).
 * - `outer`: giữ hướng đọc, KHÔNG lật gương trục Y (Yêu cầu 5.3).
 * - `inner`: lật gương trục ngang (U) để bản in mặt trong đọc đúng chiều
 *   khi nhìn từ phía trong hộp; cấu hình độc lập với mặt ngoài (Yêu cầu 5.4).
 */
export type FaceSide = 'outer' | 'inner';

/**
 * Lấy danh sách đỉnh outline của panel để ánh xạ UV.
 *
 * Ưu tiên `panel.outline` (đường viền ngoài khép kín do generator cung cấp).
 * Nếu không có, suy ra từ các điểm liên tiếp trong `paths` (read-only,
 * không sửa dữ liệu generator).
 */
function getOutlinePoints(panel: Panel): Point2D[] {
    if (panel.outline && panel.outline.length > 0) {
        return panel.outline;
    }
    const pts: Point2D[] = [];
    for (const seg of panel.paths ?? []) {
        for (const p of seg.points) {
            pts.push(p);
        }
    }
    return pts;
}

/**
 * Tính bounding box (axis-aligned) từ một tập điểm.
 * Trả về bbox rỗng tại gốc khi không có điểm nào.
 */
function bboxFromPoints(points: Point2D[]): BBox {
    if (points.length === 0) {
        return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * Chuẩn hóa một tọa độ về [0, 1] theo cạnh của bbox.
 * Khi cạnh suy biến (size ≤ 0) → trả 0 để tránh chia cho 0 / NaN.
 */
function normalizeCoord(value: number, min: number, size: number): number {
    if (!(size > 0)) {
        return 0;
    }
    return (value - min) / size;
}

/**
 * Tính tọa độ UV cho một panel theo chế độ đặt ảnh.
 *
 * - `per-face` (Yêu cầu 5.1): chuẩn hóa theo bounding box RIÊNG của panel.
 *   Mỗi mặt được ánh xạ độc lập, không phụ thuộc panel khác.
 * - `aligned-to-dieline` (Yêu cầu 5.2): chuẩn hóa theo `globalBBox` của
 *   toàn dieline, nên biên ảnh trùng vị trí mặt trên dieline (ánh xạ tuyến tính).
 *
 * Hướng đọc (Yêu cầu 5.3): với mặt ngoài, U tăng đơn điệu theo hoành độ X
 * (không đảo trục ngang / không lật gương trục Y). Với mặt trong, U được
 * lật gương để bản in đọc đúng chiều khi nhìn từ trong (Yêu cầu 5.4).
 *
 * `transform` được clamp nội bộ về miền hợp lệ (scale [10,1000]%,
 * offset [-100,+100]%) nên `scale` luôn dương, không gây chia cho 0.
 *
 * Trả về `Float32Array` xen kẽ `[u0, v0, u1, v1, ...]` theo đúng thứ tự
 * đỉnh outline của panel.
 *
 * _Requirements: 5.1, 5.2, 5.3, 5.4_
 */
export function computePanelUV(
    panel: Panel,
    mode: PlacementMode,
    transform: ArtworkTransform,
    globalBBox: BBox,
    faceSide: FaceSide,
    /** Tỷ lệ rộng/cao của ảnh nguồn. Khi có, ảnh được cover mà không méo. */
    imageAspect?: number,
): Float32Array {
    const points = getOutlinePoints(panel);
    const uv = new Float32Array(points.length * 2);

    // Chọn khung tham chiếu cho việc chuẩn hóa.
    const ref: BBox = mode === 'aligned-to-dieline' ? globalBBox : bboxFromPoints(points);

    // Clamp để bảo đảm scale > 0 và offset trong miền hợp lệ.
    const { scalePct, offsetXPct, offsetYPct, rotationDeg } = clampArtworkTransform(transform);
    const scale = scalePct / 100; // ∈ [0.1, 10]
    const offX = offsetXPct / 100; // ∈ [-1, 1]
    const offY = offsetYPct / 100; // ∈ [-1, 1]
    const rot = ((rotationDeg ?? 0) * Math.PI) / 180;
    const cosR = Math.cos(rot);
    const sinR = Math.sin(rot);
    const flipH = !!transform?.flipH;
    const flipV = !!transform?.flipV;

    // Khi biết tỷ lệ ảnh thật, ánh xạ trong hệ tọa độ vật lý của khuôn thay
    // vì chuẩn hóa X/Y độc lập. Ảnh được phóng đều theo kiểu "cover": phủ
    // kín khung tham chiếu, giữ nguyên tỷ lệ và crop cân giữa phần dư.
    // Giữ nhánh cũ khi không có imageAspect để tương thích các caller/test
    // thuần không có texture.
    const preserveAspect = Number.isFinite(imageAspect) && imageAspect! > 0
        && ref.width > 0 && ref.height > 0;
    const coverScale = preserveAspect
        ? Math.max(ref.width / imageAspect!, ref.height)
        : 1;
    const renderedWidth = imageAspect! * coverScale * scale;
    const renderedHeight = coverScale * scale;
    const centerX = ref.minX + ref.width / 2;
    const centerY = ref.minY + ref.height / 2;

    for (let i = 0; i < points.length; i++) {
        const p = points[i];

        if (preserveAspect) {
            // Tọa độ vật lý quanh tâm giúp phép xoay cũng không làm ảnh bị
            // bóp khi khung khuôn không vuông.
            let dx = p.x - centerX;
            let dy = p.y - centerY;
            if (faceSide === 'inner') dx = -dx;
            if (flipH) dx = -dx;
            if (flipV) dy = -dy;

            // Xoay ngược hệ lấy mẫu để ảnh xoay thuận chiều rotationDeg.
            const rx = dx * cosR + dy * sinR;
            const ry = -dx * sinR + dy * cosR;
            uv[i * 2] = rx / renderedWidth + 0.5 - offX;
            uv[i * 2 + 1] = ry / renderedHeight + 0.5 - offY;
            continue;
        }

        // Tọa độ chuẩn hóa cơ sở trong [0,1] theo khung tham chiếu.
        let uBase = normalizeCoord(p.x, ref.minX, ref.width);
        let vBase = normalizeCoord(p.y, ref.minY, ref.height);

        // Mặt trong: lật gương trục ngang (U) để đọc đúng chiều từ phía trong.
        // Mặt ngoài: giữ nguyên hướng (Yêu cầu 5.3).
        if (faceSide === 'inner') {
            uBase = 1 - uBase;
        }
        // Lật ngang/dọc do người dùng chọn (sau bước gương mặt trong).
        if (flipH) uBase = 1 - uBase;
        if (flipV) vBase = 1 - vBase;

        // Áp tỉ lệ quanh tâm (0.5), XOAY quanh tâm, rồi dịch theo offset.
        // scale > 100% ⇒ ảnh phóng to (lấy mẫu vùng nhỏ hơn quanh tâm).
        const du = (uBase - 0.5) / scale;
        const dv = (vBase - 0.5) / scale;
        // Xoay ngược hệ lấy mẫu để ẢNH xoay thuận chiều rotationDeg.
        const ru = du * cosR + dv * sinR;
        const rv = -du * sinR + dv * cosR;
        const u = ru + 0.5 - offX;
        const v = rv + 0.5 - offY;

        uv[i * 2] = u;
        uv[i * 2 + 1] = v;
    }

    return uv;
}
