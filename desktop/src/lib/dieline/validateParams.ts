// ============================================================
// validateParams — Kiểm tra & chuẩn hóa thông số hộp
//
// Trả về params đã clamp + danh sách cảnh báo (nếu có).
// Logic clamp được tập trung tại đây thay vì rải rác trong store.
// ============================================================

import { BoxParams } from './types';
// [HANGING-WINDOW 2026-07-27] Kẹp tham số riêng của hộp treo theo đúng miền
// mà hangingWindowDims() dùng, để form không hiển thị số đo khác khuôn thật.
import { HGB_WINDOW_MARGIN_MM, HGB_TAB_H_MIN, HGB_TAB_H_MAX } from './constants';

/** Kết quả validation */
export interface ValidationResult {
    /** Thông số đã được clamp về giá trị hợp lệ */
    params: BoxParams;
    /** Danh sách cảnh báo (rỗng nếu tất cả hợp lệ) */
    warnings: string[];
    /** Có giá trị nào bị clamp không? */
    wasClamped: boolean;
}

// ============================================================
// Giới hạn tuyệt đối (an toàn sản xuất)
// ============================================================
const LIMITS = {
    L: { min: 30, max: 600 },
    W: { min: 15, max: 400 },
    D: { min: 10, max: 600 },
    T: { min: 0.2, max: 3 },
    C: { min: 0.2, max: 3 },
    G: { min: 5, max: 30 },
    TH: { min: 0, max: 80 },
    HH: { min: 0, max: 200 },
    HW: { min: 0, max: 400 },
    HHL: { min: 0, max: 100 },
    HFH: { min: 0, max: 150 },
    SLP: { min: 0, max: 5 },
    LTW: { min: 5, max: 50 },
    LTH: { min: 5, max: 50 },
    BF: { min: 0, max: 300 },
    HR: { min: 0, max: 10 },
    HM: { min: 0, max: 100 },
    HS: { min: 0, max: 200 },
    DFH: { min: 0, max: 300 },
    ABD: { min: 0, max: 400 },
    cupD1: { min: 20, max: 500 },
    cupD2: { min: 25, max: 500 },  // min 25 = cupD1 min(20) + 5mm gap tối thiểu
    cupH: { min: 10, max: 500 },
    cupCoverage: { min: 1, max: 100 },
    envW: { min: 80, max: 500 },
    envH: { min: 50, max: 400 },
    envFH: { min: 0, max: 200 },
    envSF: { min: 0, max: 100 },
    envWindowW: { min: 10, max: 300 },
    envWindowH: { min: 10, max: 200 },
    envWindowX: { min: 5, max: 400 },
    envWindowY: { min: 5, max: 300 },
    lidD: { min: 0, max: 600 },
    lidGap: { min: 0, max: 5 },
    // [HANGING-WINDOW 2026-07-27] Hộp treo có cửa sổ — 0 = tự động suy theo L/D.
    WNW: { min: 0, max: 600 },
    WNH: { min: 0, max: 600 },
    HTH: { min: 0, max: HGB_TAB_H_MAX },
} as const;

type NumericKey = keyof typeof LIMITS;

/** Clamp giá trị về [min, max] */
function clamp(v: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, v));
}

/**
 * Validate & chuẩn hóa BoxParams.
 * 
 * @param raw - Thông số đầu vào (có thể chưa hợp lệ)
 * @param changedKey - Tên trường vừa thay đổi (để biết ưu tiên clamp)
 * @returns Kết quả validation
 */
export function validateParams(
    raw: BoxParams,
    changedKey?: keyof BoxParams
): ValidationResult {
    const p = { ...raw };
    const warnings: string[] = [];
    let wasClamped = false;

    // --- 1. Clamp từng giá trị về giới hạn tuyệt đối ---
    for (const key of Object.keys(LIMITS) as NumericKey[]) {
        const { min, max } = LIMITS[key];
        const original = p[key] as number;
        const clamped = clamp(original, min, max);
        if (clamped !== original) {
            (p[key] as number) = clamped;
            wasClamped = true;
        }
    }

    // --- 2. Ràng buộc: W ≤ L (bỏ qua cho pizza, tray, double_tray — hộp hình chữ nhật ngang hợp lệ) ---
    if (p.W > p.L && p.boxType !== 'pizza' && p.boxType !== 'tray' && p.boxType !== 'double_tray') {
        if (changedKey === 'W') {
            // Nếu user đang chỉnh W → tự động tăng L lên bằng W
            p.L = clamp(p.W, LIMITS.L.min, LIMITS.L.max);
            // Nếu L bị clamp max mà vẫn < W → giảm W về L
            if (p.W > p.L) p.W = p.L;
            warnings.push(`L đã tăng lên ${p.L}mm (W không được vượt quá L)`);
        } else {
            p.W = p.L;
            warnings.push(`W đã giảm về ${p.W}mm (không được vượt quá L=${p.L}mm)`);
        }
        wasClamped = true;
    }

    // --- 3. Ràng buộc: T phải nhỏ hơn đáng kể so với W và D ---
    if (p.T >= p.W / 2) {
        p.T = clamp(p.T, LIMITS.T.min, p.W / 2 - 0.1);
        wasClamped = true;
        warnings.push(`T quá lớn so với W, đã giảm về ${p.T}mm`);
    }

    // --- 4. Ràng buộc snap-lock: unitW ≥ 20mm ---
    if (p.boxType === 'slb' || p.boxType === 'gable') {
        const { L, W, T, SLP } = p;
        const r = Math.min(5, Math.max(2, W * 0.05));
        let N: number;
        if (SLP >= 1 && SLP <= 3) {
            N = Math.round(SLP);
        } else {
            const diff = L - W;
            N = diff < 150 ? 1 : diff < 250 ? 2 : 3;
        }
        // Engine tự co outer ears khi L ≈ W, chỉ cần đảm bảo
        // panel L đủ rộng cho N slots tối thiểu + fillet
        const minSlotW = 5;
        const minTotalInner = minSlotW * N + N * r;
        const totalPanelW = L - T;
        // Ear tự co: earW = min(W/2, (totalPanelW - minTotalInner) / 2)
        // Chỉ lỗi khi totalPanelW < minTotalInner (không đủ chỗ cho slot nào cả)
        if (totalPanelW < minTotalInner) {
            if (changedKey === 'W') {
                p.W = Math.floor(L - T - minTotalInner);
                if (p.W < LIMITS.W.min) p.W = LIMITS.W.min;
            } else {
                p.L = Math.ceil(T + minTotalInner);
            }
            wasClamped = true;
            warnings.push('Kích thước không đủ cho đáy khoá — đã tự điều chỉnh');
        }

        // Cảnh báo rủi ro khi L = W (hoặc gần bằng)
        if (Math.abs(p.L - p.W) < 5) {
            warnings.push('Với kích thước L ≈ W, đáy khoá có thể gặp rủi ro cho sản xuất. Nếu được, hãy chuyển sang hộp nắp gài.');
        }
    }

    // --- 5. Ràng buộc Gable Box: HW ≤ L - 20 ---
    if (p.boxType === 'gable' && p.HW > 0) {
        const maxHW = Math.max(20, p.L - 20);
        if (p.HW > maxHW) {
            p.HW = maxHW;
            wasClamped = true;
            warnings.push(`Rộng lỗ quai đã giảm về ${p.HW}mm`);
        }
    }

    // --- 6. Ràng buộc: G (mép keo) phải hợp lý so với W ---
    if (p.G > p.W * 0.6) {
        p.G = Math.round(p.W * 0.6);
        wasClamped = true;
        warnings.push(`Mép keo quá rộng, đã giảm về ${p.G}mm`);
    }

    // --- 7. Ràng buộc: TH (tai đút) không nên cao hơn W ---
    if (p.TH > p.W) {
        p.TH = p.W;
        wasClamped = true;
        warnings.push(`Tai đút quá cao, đã giảm về ${p.TH}mm`);
    }

    // --- 8. Ràng buộc Paper Bag: chiều cao đáy BF ≤ 85% độ rộng hông (W) ---
    if (p.boxType === 'paper_bag' && p.BF > 0) {
        const maxBF = Math.floor(p.W * 0.85);
        if (p.BF > maxBF) {
            p.BF = maxBF;
            wasClamped = true;
            warnings.push(`Chiều cao đáy không vượt quá 85% rộng hông, đã giảm về ${p.BF}mm`);
        }
    }

    // --- 9. Ràng buộc Cup Sleeve: cupD1 + 5mm ≤ cupD2 ---
    if (p.boxType === 'cup_sleeve') {
        const MIN_CUP_GAP = 5; // mm — tránh denominator gần 0 trong tính bán kính cung
        if (p.cupD2 - p.cupD1 < MIN_CUP_GAP) {
            // Auto-swap nếu cupD1 >= cupD2
            if (p.cupD1 >= p.cupD2) {
                const temp = p.cupD1;
                p.cupD1 = p.cupD2;
                p.cupD2 = temp;
            }
            // Đảm bảo gap >= MIN_CUP_GAP
            if (p.cupD2 - p.cupD1 < MIN_CUP_GAP) {
                p.cupD2 = clamp(p.cupD1 + MIN_CUP_GAP, LIMITS.cupD2.min, LIMITS.cupD2.max);
                // Nếu cupD2 bị clamp max → giảm cupD1
                if (p.cupD2 - p.cupD1 < MIN_CUP_GAP) {
                    p.cupD1 = p.cupD2 - MIN_CUP_GAP;
                }
            }
            wasClamped = true;
            warnings.push(`Đường kính miệng nhỏ phải nhỏ hơn miệng lớn ít nhất ${MIN_CUP_GAP}mm — đã tự điều chỉnh`);
        }
    }

    // --- 10. Ràng buộc Pizza Box: D > T, D hợp lý, slot fit ---
    if (p.boxType === 'pizza') {
        // D phải > T (tránh fan tab radius = D - T ≤ 0 → crash)
        if (p.D <= p.T) {
            p.D = clamp(p.T + 1, LIMITS.D.min, LIMITS.D.max);
            wasClamped = true;
            warnings.push(`D phải lớn hơn T — đã tăng D lên ${p.D}mm`);
        }
        // Pizza thường có D rất thấp so với W — cảnh báo nếu bất thường
        if (p.D > p.W / 3) {
            warnings.push(`Chiều cao D=${p.D}mm khá lớn cho hộp pizza (thường ≤ ${Math.floor(p.W / 3)}mm)`);
        }
        // Slot offset (so = D+5) + slot length (sl = W*0.15) phải nằm trong bottom
        const so = p.D + 5;
        const sl = p.W * 0.15;
        if (so + sl > p.W) {
            warnings.push(`Khe slot có thể vượt ra ngoài đáy — giảm D hoặc tăng W`);
        }
    }

    // --- 11. Ràng buộc DFH: không vượt quá min(L/2, W+T) ---
    if (p.DFH > 0 && (p.boxType === 'rte' || p.boxType === 'slb' || p.boxType === 'auto_bottom')) {
        const maxDFH = Math.min(p.L / 2 - 1, p.W + p.T);
        if (p.DFH > maxDFH) {
            p.DFH = Math.floor(clamp(maxDFH, 0, LIMITS.DFH.max));
            wasClamped = true;
            warnings.push(`Tai bụi quá cao, đã giảm về ${p.DFH}mm`);
        }
    }

    // --- 11b. Ràng buộc Auto-Bottom (hộp đáy dán) ---
    if (p.boxType === 'auto_bottom') {
        // ABD = chiều sâu mảnh đáy chính. Phải ≥ W/2 để hai mảnh chồng nhau
        // tạo đáy kín, và ≤ W − T để không vượt qua vách đối diện.
        if (p.ABD > 0) {
            const minABD = Math.ceil(p.W / 2);
            const maxABD = Math.max(minABD, Math.floor(p.W - p.T));
            if (p.ABD < minABD) {
                p.ABD = minABD;
                wasClamped = true;
                warnings.push(`Đáy dán quá ngắn (hở đáy), đã tăng về ${p.ABD}mm`);
            } else if (p.ABD > maxABD) {
                p.ABD = maxABD;
                wasClamped = true;
                warnings.push(`Đáy dán quá sâu, đã giảm về ${p.ABD}mm`);
            }
        }
        // Đáy dán cần L > W: hai tai đáy hông (mỗi tai ~W/2) không được đè
        // lên nhau khi hộp bẹp lại. Engine tự co tai khi thiếu chỗ.
        if (p.W > p.L - 4) {
            warnings.push('Đáy dán cần L lớn hơn W — với kích thước này tai đáy đã bị co lại, nên chuyển sang hộp đáy gài hoặc nắp cài.');
        }
    }

    // --- 11c. Ràng buộc Double Tray (hộp âm dương) --- [DOUBLE-TRAY 2026-07-26]
    if (p.boxType === 'double_tray') {
        const shortSide = Math.min(p.L, p.W);
        // Dầm hai bên không được nuốt hết cạnh ngắn (chừa ≥ 1mm cho mí).
        const maxG = Math.max(LIMITS.G.min, Math.floor((shortSide - 1) / 2));
        if (p.G > maxG) {
            p.G = maxG;
            wasClamped = true;
            warnings.push(`Dầm quá rộng so với cạnh ngắn, đã giảm về ${p.G}mm`);
        }
        // Hai vát 45° của mí không được chồng nhau trên cạnh ngắn.
        const maxTH = Math.max(0.5, (shortSide - 2 * p.G) / 2);
        if (p.TH > maxTH) {
            p.TH = Math.round(maxTH * 10) / 10;
            wasClamped = true;
            warnings.push(`Mí gập quá cao so với cạnh ngắn, đã giảm về ${p.TH}mm`);
        }
        // Thành đủ sâu cho khe vạt góc max(2T, 2C) + bề vạt + mép an toàn.
        const slit = Math.max(2 * p.T, 2 * p.C);
        const minD = Math.max(LIMITS.D.min, Math.ceil(slit + p.T + 2));
        if (p.D < minD) {
            p.D = minD;
            wasClamped = true;
            warnings.push(`Thành quá thấp cho kết cấu góc thành kép, đã tăng về ${p.D}mm`);
        }
        if (p.lidD > 0 && p.lidD < minD) {
            p.lidD = minD;
            wasClamped = true;
            warnings.push(`Thành nắp quá thấp, đã tăng về ${p.lidD}mm`);
        }
    }

    // --- 12. Ràng buộc Envelope ---
    if (p.boxType === 'envelope') {
        // FH không nên vượt quá envH
        if (p.envFH > 0 && p.envFH > p.envH) {
            p.envFH = p.envH;
            wasClamped = true;
            warnings.push(`Nắp dán quá cao, đã giảm về ${p.envFH}mm`);
        }
        // SF không nên vượt quá envW/2
        if (p.envSF > 0 && p.envSF > p.envW / 2) {
            p.envSF = Math.floor(p.envW / 2);
            wasClamped = true;
            warnings.push(`Tai hông quá rộng, đã giảm về ${p.envSF}mm`);
        }
        // Window bounds check
        if (p.envWindow) {
            const maxWinW = p.envW - 2 * p.envWindowX;
            if (p.envWindowW > maxWinW) {
                p.envWindowW = Math.floor(Math.max(10, maxWinW));
                wasClamped = true;
                warnings.push(`Cửa sổ quá rộng, đã giảm về ${p.envWindowW}mm`);
            }
            const maxWinH = p.envH - 2 * p.envWindowY;
            if (p.envWindowH > maxWinH) {
                p.envWindowH = Math.floor(Math.max(10, maxWinH));
                wasClamped = true;
                warnings.push(`Cửa sổ quá cao, đã giảm về ${p.envWindowH}mm`);
            }
        }
    }

    // --- 13. Ràng buộc Hộp treo có cửa sổ --- [HANGING-WINDOW 2026-07-27]
    if (p.boxType === 'hanging_window') {
        // Cửa sổ luôn căn giữa mặt trước và phải chừa lề HGB_WINDOW_MARGIN_MM
        // mỗi phía (chỗ dán màng PVC/PET) — kẹp đúng miền của hangingWindowDims.
        if (p.hgbWindow && p.WNW > 0) {
            const maxWNW = p.L - 2 * HGB_WINDOW_MARGIN_MM;
            if (p.WNW > maxWNW) {
                // Giữ ≥ 1mm để không rơi về 0 (0 mang nghĩa "tự động").
                p.WNW = Math.max(1, Math.floor(maxWNW));
                wasClamped = true;
                warnings.push(`Rộng cửa sổ vượt lề an toàn ${HGB_WINDOW_MARGIN_MM}mm mỗi bên, đã giảm về ${p.WNW}mm`);
            }
        }
        if (p.hgbWindow && p.WNH > 0) {
            const maxWNH = p.D - 2 * HGB_WINDOW_MARGIN_MM;
            if (p.WNH > maxWNH) {
                p.WNH = Math.max(1, Math.floor(maxWNH));
                wasClamped = true;
                warnings.push(`Cao cửa sổ vượt lề an toàn ${HGB_WINDOW_MARGIN_MM}mm mỗi bên, đã giảm về ${p.WNH}mm`);
            }
        }
        // Cao MỘT lớp tai treo: chỉ nằm trong miền treo được lỗ euro.
        if (p.HTH > 0) {
            const clampedTabH = clamp(p.HTH, HGB_TAB_H_MIN, HGB_TAB_H_MAX);
            if (clampedTabH !== p.HTH) {
                p.HTH = clampedTabH;
                wasClamped = true;
                warnings.push(`Cao tai treo phải trong khoảng ${HGB_TAB_H_MIN}–${HGB_TAB_H_MAX}mm, đã đưa về ${p.HTH}mm`);
            }
        }
    }

    return { params: p, warnings, wasClamped };
}
