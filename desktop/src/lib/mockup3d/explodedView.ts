// ============================================================
// explodedView.ts — Mockup 3D Realism (Logic Layer)
//
// Hàm thuần tính độ dịch (offset) của panel theo chế độ tách rời
// (exploded view). Tách khỏi lớp render R3F để kiểm thử thuộc tính
// (PBT) bằng `fast-check` mà không cần WebGL.
//
// Panel được tách dọc theo trục PHÁP TUYẾN của nó, với lượng dịch
// tỉ lệ tuyến tính theo một hệ số tách rời (explode factor) được
// giới hạn trong [0.0, 5.0]. Khi hệ số = 0, offset bằng đúng vector
// không (0,0,0) → khôi phục vị trí lắp ráp ban đầu (round-trip safe).
//
// Lưu ý: Kiểu `Panel` của generator KHÔNG mang sẵn pháp tuyến 3D.
// Theo design, pháp tuyến panel được tính ở lớp render và truyền vào
// hàm thuần này dưới dạng `Vec3` — KHÔNG thêm trường vào `Panel`.
//
// _Requirements: 7.5, 7.6_
// ============================================================

/**
 * Vector 3 chiều (đơn vị mm trong không gian cảnh).
 * Dùng cho pháp tuyến panel, vị trí và offset tách rời.
 */
export interface Vec3 {
    x: number;
    y: number;
    z: number;
}

/**
 * Cận dưới của hệ số tách rời. Hệ số = 0 nghĩa là lắp ráp (không tách).
 * _Requirements: 7.5, 7.6_
 */
export const MIN_EXPLODE_FACTOR = 0.0;

/**
 * Cận trên của hệ số tách rời.
 * _Requirements: 7.5_
 */
export const MAX_EXPLODE_FACTOR = 5.0;

/**
 * Vector không — vị trí offset khi không tách (hệ số = 0).
 * Trả về bản sao mới ở mỗi lần gọi để tránh chia sẻ tham chiếu.
 */
function zeroVec(): Vec3 {
    return { x: 0, y: 0, z: 0 };
}

/**
 * Giới hạn hệ số tách rời về miền hợp lệ [0.0, 5.0] (Yêu cầu 7.5).
 *
 * - `undefined` / `NaN` / `±Infinity` / `< 0` → 0.0 (lắp ráp).
 * - `> 5.0` → 5.0.
 * - ngược lại → giữ nguyên.
 *
 * Hàm thuần, không ném lỗi; idempotent với mọi đầu ra hợp lệ.
 */
export function clampExplodeFactor(factor: number | undefined): number {
    if (factor === undefined || !Number.isFinite(factor) || factor < MIN_EXPLODE_FACTOR) {
        return MIN_EXPLODE_FACTOR;
    }
    if (factor > MAX_EXPLODE_FACTOR) {
        return MAX_EXPLODE_FACTOR;
    }
    return factor;
}

/**
 * Chuẩn hóa vector về độ dài đơn vị.
 * Trả về `null` khi vector có độ dài 0 hoặc không hữu hạn (suy biến),
 * để hàm gọi quyết định coi như không có hướng tách (offset = 0).
 */
function normalize(n: Vec3): Vec3 | null {
    const len = Math.hypot(n.x, n.y, n.z);
    if (!Number.isFinite(len) || len === 0) {
        return null;
    }
    return { x: n.x / len, y: n.y / len, z: n.z / len };
}

/**
 * Tính offset tách rời của một panel theo PHÁP TUYẾN của nó.
 *
 * offset = normalize(normal) × clampExplodeFactor(factor) × spacing
 *
 * - Lượng dịch tỉ lệ TUYẾN TÍNH theo hệ số đã clamp (Yêu cầu 7.5,
 *   Property 19): nhân đôi hệ số → nhân đôi độ dài offset.
 * - Khi hệ số (sau clamp) = 0 → trả về đúng vector không (0,0,0),
 *   bảo đảm round-trip an toàn (Yêu cầu 7.6, Property 20).
 * - Pháp tuyến suy biến (độ dài 0 / không hữu hạn) → offset = 0.
 *
 * @param normal  Pháp tuyến panel (không cần chuẩn hóa sẵn).
 * @param factor  Hệ số tách rời thô; sẽ được clamp về [0, 5].
 * @param spacing Khoảng cách cơ sở (mm) ứng với 1 đơn vị hệ số; mặc định 1.
 *                Giá trị không hữu hạn được coi như 0 (không tách).
 */
export function computeExplodedOffset(
    normal: Vec3,
    factor: number,
    spacing = 1,
): Vec3 {
    const clampedFactor = clampExplodeFactor(factor);

    // Hệ số 0 → không tách: offset đúng bằng (0,0,0) (round-trip safe).
    if (clampedFactor === 0) {
        return zeroVec();
    }

    const unit = normalize(normal);
    if (unit === null) {
        return zeroVec();
    }

    const safeSpacing = Number.isFinite(spacing) ? spacing : 0;
    const distance = clampedFactor * safeSpacing;

    return {
        x: unit.x * distance,
        y: unit.y * distance,
        z: unit.z * distance,
    };
}

/**
 * Áp offset tách rời lên vị trí lắp ráp gốc của panel.
 *
 * vịTríTách = basePosition + computeExplodedOffset(normal, factor, spacing)
 *
 * Khi `factor` (sau clamp) = 0, offset = (0,0,0) nên kết quả trả về
 * BẰNG ĐÚNG `basePosition` về mặt giá trị — đưa panel về vị trí lắp
 * ráp ban đầu (Yêu cầu 7.6).
 */
export function applyExplodedOffset(
    basePosition: Vec3,
    normal: Vec3,
    factor: number,
    spacing = 1,
): Vec3 {
    const offset = computeExplodedOffset(normal, factor, spacing);
    return {
        x: basePosition.x + offset.x,
        y: basePosition.y + offset.y,
        z: basePosition.z + offset.z,
    };
}
