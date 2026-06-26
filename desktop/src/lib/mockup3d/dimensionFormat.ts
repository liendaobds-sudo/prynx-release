// ============================================================
// Dimension Format — Mockup 3D Realism (Logic Layer)
//
// Hàm thuần làm tròn và định dạng kích thước hộp (L×W×H) cho
// Overlay_Kích_Thước. Tách khỏi lớp render R3F (`DimensionOverlay.tsx`)
// để kiểm thử thuộc tính (PBT) mà không cần WebGL.
//
// Task 6.3 triển khai DUY NHẤT logic làm tròn đến 0.1 mm + định dạng.
// Property test (làm tròn 0.1 mm) thuộc task 6.7.
// _Requirements: 7.7_
// ============================================================

/** Bước làm tròn của overlay kích thước: 0.1 mm (Yêu cầu 7.7). */
export const DIMENSION_ROUND_STEP_MM = 0.1;

/** Số chữ số thập phân hiển thị, tương ứng bước làm tròn 0.1 mm. */
const DECIMALS = 1;

/** Kích thước hộp thô theo đơn vị mm (chiều dài × chiều rộng × chiều cao). */
export interface BoxDimensions {
    /** Chiều dài (length), mm. */
    length: number;
    /** Chiều rộng (width), mm. */
    width: number;
    /** Chiều cao (height), mm. */
    height: number;
}

/**
 * Kết quả định dạng kích thước cho overlay.
 * - `length`/`width`/`height`: giá trị số đã làm tròn đến 0.1 mm.
 * - `label`: chuỗi hiển thị "L × W × H mm" với đúng 1 chữ số thập phân.
 */
export interface FormattedDimensions {
    length: number;
    width: number;
    height: number;
    label: string;
}

/**
 * Làm tròn một giá trị kích thước (mm) đến bội số gần nhất của 0.1 mm
 * (Yêu cầu 7.7). Quy ước làm tròn về số gần nhất (round half away from zero
 * theo `Math.round` của JS đối với giá trị dương).
 *
 * Đầu vào không phải số hữu hạn (NaN/undefined/±Infinity) → trả về 0
 * để giữ overlay ở trạng thái hiển thị được, không ném lỗi.
 */
export function roundToTenthMm(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) {
        return 0;
    }
    // Math.round(value * 10) / 10 làm tròn đến bội số gần nhất của 0.1.
    // Cộng thêm 0 để chuẩn hóa -0 thành 0.
    return Math.round(value / DIMENSION_ROUND_STEP_MM) * DIMENSION_ROUND_STEP_MM + 0;
}

/**
 * Định dạng một giá trị số đã làm tròn thành chuỗi với đúng 1 chữ số
 * thập phân (ví dụ `120` → "120.0").
 */
function formatValue(value: number): string {
    // Chuẩn hóa -0 → 0 trước khi format để tránh hiển thị "-0.0".
    const normalized = value === 0 ? 0 : value;
    return normalized.toFixed(DECIMALS);
}

/**
 * Làm tròn kích thước L×W×H đến 0.1 mm và định dạng chuỗi hiển thị
 * cho Overlay_Kích_Thước (Yêu cầu 7.7).
 *
 * Trả về cả giá trị số đã làm tròn (để tiêu thụ tiếp) lẫn nhãn
 * "L × W × H mm" với đơn vị mi-li-mét.
 */
export function formatDimensions(dims: BoxDimensions): FormattedDimensions {
    const length = roundToTenthMm(dims?.length);
    const width = roundToTenthMm(dims?.width);
    const height = roundToTenthMm(dims?.height);

    const label = `${formatValue(length)} × ${formatValue(width)} × ${formatValue(height)} mm`;

    return { length, width, height, label };
}
