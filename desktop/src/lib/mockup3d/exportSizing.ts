// ============================================================
// exportSizing.ts — Mockup 3D Realism (Logic Layer)
//
// Hàm thuần tính kích thước ảnh xuất từ kích thước khung xem và hệ số
// phóng đại (ExportScale ∈ {1, 2, 4}). Nếu chiều rộng hoặc chiều cao
// sau khi nhân hệ số vượt quá giới hạn `MAX_EXPORT_PX` (16384 px), hàm
// trả về `ok = false` kèm `reason` để lớp render giữ nguyên cảnh hiện
// tại và hiển thị thông báo lỗi — KHÔNG kết xuất ở kích thước quá lớn.
//
// Hàm thuần, không phụ thuộc React/DOM/WebGL, không ném exception.
// _Requirements: 6.4_
// ============================================================

import type { ExportScale } from './types';

/**
 * Giới hạn tối đa cho mỗi chiều (rộng/cao) của ảnh xuất, tính bằng pixel.
 * Tương ứng giới hạn kích thước texture/canvas phổ biến của WebGL.
 * _Requirements: 6.4_
 */
export const MAX_EXPORT_PX = 16384;

/**
 * Kết quả tính kích thước xuất ảnh.
 * - `ok`: kích thước sau khi nhân hệ số có nằm trong giới hạn cho phép không.
 * - `width` / `height`: kích thước (px) sau khi nhân hệ số.
 * - `reason`: lý do từ chối khi `ok = false` (không có khi hợp lệ).
 */
export interface ExportSizeResult {
    ok: boolean;
    width: number;
    height: number;
    reason?: string;
}

/**
 * Kiểm tra một giá trị kích thước có phải số hữu hạn dương hay không.
 */
function isPositiveFinite(value: number): boolean {
    return Number.isFinite(value) && value > 0;
}

/**
 * Tính kích thước ảnh xuất từ kích thước khung xem và hệ số phóng đại.
 *
 * Nhân `viewW`/`viewH` với `scale`. Trả về `ok = true` KHI VÀ CHỈ KHI
 * cả chiều rộng và chiều cao sau khi nhân đều ≤ `MAX_EXPORT_PX`; ngược
 * lại trả về `ok = false` kèm `reason`, vẫn báo cáo kích thước đã tính
 * để lớp gọi hiển thị thông tin chẩn đoán.
 *
 * _Requirements: 6.4_
 *
 * @param viewW Chiều rộng khung xem (px), phải là số dương hữu hạn.
 * @param viewH Chiều cao khung xem (px), phải là số dương hữu hạn.
 * @param scale Hệ số phóng đại ∈ {1, 2, 4}.
 */
export function computeExportSize(
    viewW: number,
    viewH: number,
    scale: ExportScale,
): ExportSizeResult {
    if (!isPositiveFinite(viewW) || !isPositiveFinite(viewH)) {
        return {
            ok: false,
            width: 0,
            height: 0,
            reason: 'Kích thước khung xem không hợp lệ (phải là số dương hữu hạn).',
        };
    }

    const width = viewW * scale;
    const height = viewH * scale;

    if (width > MAX_EXPORT_PX || height > MAX_EXPORT_PX) {
        return {
            ok: false,
            width,
            height,
            reason:
                `Kích thước xuất (${width}×${height} px) vượt giới hạn ` +
                `${MAX_EXPORT_PX} px ở chiều rộng hoặc chiều cao.`,
        };
    }

    return { ok: true, width, height };
}
