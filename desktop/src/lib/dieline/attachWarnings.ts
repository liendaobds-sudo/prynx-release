// ============================================================
// attachWarnings — Hợp nhất cảnh báo vào DielineModel.warnings
//
// Gộp cảnh báo từ validateParams với cảnh báo phát sinh trong
// quá trình sinh mô hình (vd: snap-lock) vào DUY NHẤT một trường
// `DielineModel.warnings`, khử trùng lặp theo nội dung chuỗi và
// giữ thứ tự ổn định (xác định).
//
// _Requirements: 3.1, 3.2, 3.3, 3.5, 3.6_
// ============================================================

import { DielineModel } from './types';

/**
 * Hợp nhất `validationWarnings` (từ validateParams) với các cảnh báo
 * có sẵn trên model (phát sinh khi sinh mô hình, vd snap-lock) vào
 * `model.warnings`.
 *
 * - Khử trùng lặp theo nội dung chuỗi chính xác (exact string content).
 * - Thứ tự ổn định: cảnh báo validation trước, rồi tới cảnh báo sinh mô hình.
 * - Luôn đặt `model.warnings` là một mảng (rỗng nếu không có cảnh báo nào),
 *   không bao giờ null/undefined (Requirement 3.5).
 *
 * @param model - Mô hình vừa được generator tạo ra (có thể đã mang sẵn warnings)
 * @param validationWarnings - Cảnh báo trả về từ validateParams
 * @returns Chính `model` đã được gán `model.warnings` đã hợp nhất + khử trùng lặp
 */
export function attachWarnings(
    model: DielineModel,
    validationWarnings: string[],
): DielineModel {
    const merged: string[] = [];
    const seen = new Set<string>();

    const pushUnique = (w: string): void => {
        if (!seen.has(w)) {
            seen.add(w);
            merged.push(w);
        }
    };

    // 1. Cảnh báo từ validateParams (gồm cả cảnh báo snap-lock về kích thước).
    for (const w of validationWarnings ?? []) {
        pushUnique(w);
    }

    // 2. Cảnh báo phát sinh trong quá trình sinh mô hình (nếu generator có gán).
    for (const w of model.warnings ?? []) {
        pushUnique(w);
    }

    model.warnings = merged;
    return model;
}
