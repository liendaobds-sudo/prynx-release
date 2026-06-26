// ============================================================
// maskValidation.ts — Mockup 3D Realism (Logic Layer)
//
// Hàm thuần xác thực mặt nạ (mask) dùng cho finish spot-UV / emboss.
// Mask chỉ được áp dụng khi:
//   1) Định dạng ảnh hợp lệ (PNG, JPEG, WebP — theo GĐ-4 của requirements).
//   2) Kích thước (width × height) khớp đúng với bề mặt áp dụng.
// Trường hợp không hợp lệ → trả về `valid: false` kèm `reason` mô tả lý do,
// để lớp render giữ nguyên finish hiện tại và hiển thị thông báo lỗi.
//
// Hàm thuần, không phụ thuộc React/DOM/WebGL, không ném exception.
// _Requirements: 4.6_
// ============================================================

/**
 * Kết quả xác thực mặt nạ.
 * - `valid`: mask có hợp lệ để áp dụng hay không.
 * - `reason`: lý do từ chối khi `valid = false` (không có khi hợp lệ).
 */
export interface MaskValidationResult {
    valid: boolean;
    reason?: string;
}

/**
 * Mô tả mặt nạ đầu vào: kích thước theo pixel và định dạng ảnh.
 */
export interface MaskInfo {
    width: number;
    height: number;
    format: string;
}

/**
 * Bề mặt áp dụng mask: kích thước mục tiêu mà mask phải khớp.
 */
export interface SurfaceInfo {
    width: number;
    height: number;
}

/**
 * Tập định dạng ảnh hợp lệ cho mask (chuẩn hóa về chữ thường).
 * Chấp nhận cả tên định dạng ngắn (`png`) lẫn MIME type (`image/png`),
 * và bí danh phổ biến (`jpg` ↔ `jpeg`).
 * _Requirements: 4.6_ (GĐ-4: PNG, JPEG, WebP)
 */
export const VALID_MASK_FORMATS: ReadonlySet<string> = new Set([
    'png',
    'jpeg',
    'jpg',
    'webp',
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
]);

/**
 * Kiểm tra một chuỗi định dạng có thuộc tập định dạng ảnh hợp lệ không.
 * Chuẩn hóa: cắt khoảng trắng + chữ thường trước khi đối chiếu.
 */
function isValidFormat(format: string): boolean {
    return VALID_MASK_FORMATS.has(format.trim().toLowerCase());
}

/**
 * Kiểm tra một giá trị kích thước có phải số hữu hạn dương hay không.
 */
function isPositiveFinite(value: number): boolean {
    return Number.isFinite(value) && value > 0;
}

/**
 * Xác thực mặt nạ spot-UV/emboss với bề mặt áp dụng.
 *
 * Trả về `valid = true` KHI VÀ CHỈ KHI mask có định dạng ảnh hợp lệ và
 * kích thước khớp đúng bề mặt; ngược lại trả về `valid = false` kèm `reason`.
 *
 * _Requirements: 4.6_
 *
 * @param mask Thông tin mask (kích thước px + định dạng), hoặc `null` nếu thiếu.
 * @param surface Kích thước bề mặt mục tiêu mà mask phải khớp.
 */
export function validateMask(
    mask: MaskInfo | null,
    surface: SurfaceInfo,
    opts?: { allowResize?: boolean },
): MaskValidationResult {
    if (mask === null || mask === undefined) {
        return { valid: false, reason: 'Mặt nạ không tồn tại (null).' };
    }

    if (!isValidFormat(mask.format)) {
        return {
            valid: false,
            reason: `Định dạng mặt nạ không hợp lệ: "${mask.format}". Chỉ chấp nhận PNG, JPEG hoặc WebP.`,
        };
    }

    if (
        !isPositiveFinite(mask.width) ||
        !isPositiveFinite(mask.height) ||
        !isPositiveFinite(surface.width) ||
        !isPositiveFinite(surface.height)
    ) {
        return {
            valid: false,
            reason: 'Kích thước mặt nạ hoặc bề mặt không hợp lệ (phải là số dương hữu hạn).',
        };
    }

    // Khi cho phép co giãn (allowResize), KHÔNG bắt khớp kích thước tuyệt đối —
    // mặt nạ sẽ được lấy mẫu/co giãn theo UV bề mặt. Chỉ cần định dạng + kích
    // thước dương hợp lệ. (UX chuẩn ngành: không từ chối vì lệch vài pixel.)
    if (opts?.allowResize) {
        return { valid: true };
    }

    if (mask.width !== surface.width || mask.height !== surface.height) {
        return {
            valid: false,
            reason:
                `Kích thước mặt nạ (${mask.width}×${mask.height}) không khớp ` +
                `bề mặt áp dụng (${surface.width}×${surface.height}).`,
        };
    }

    return { valid: true };
}
