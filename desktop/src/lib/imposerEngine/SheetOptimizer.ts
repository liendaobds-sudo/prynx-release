// src/lib/imposerEngine/SheetOptimizer.ts
// =========================================================================
//  Smart Sheet & Signature Optimizer
//
//  Tự động tính toán:
//  1. Master Signature tối ưu (16 > 8 > 4) dựa trên kích thước trang + kẽm
//  2. Validate khổ giấy có phù hợp với bài bình không
//  3. Gợi ý khổ giấy tối thiểu cần thiết
// =========================================================================

import { MM_TO_POINTS } from '../pdfImposer';

// ==================== INTERFACES ====================

export interface PageDimensions {
    /** Chiều rộng trang (pt) */
    width: number;
    /** Chiều cao trang (pt) */
    height: number;
}

export interface SheetDimensions {
    /** Chiều rộng khổ kẽm (mm) */
    width: number;
    /** Chiều cao khổ kẽm (mm) */
    height: number;
}

export interface MarginConfig {
    /** Nhíp máy phía dưới (mm) */
    gripperMargin: number;
    /** Lề trên (mm) */
    marginTop: number;
    /** Lề trái (mm) */
    marginLeft: number;
    /** Lề phải (mm) */
    marginRight: number;
    /** Bleed (mm) */
    bleed: number;
    /** Khoảng hở ngang giữa các cụm spread (mm) */
    gapX?: number;
    /** Khoảng hở dọc giữa các cụm spread (mm) */
    gapY?: number;
}

export interface SigOption {
    /** Số trang / tay (4, 8, 16) */
    pagesPerSig: number;
    /** ID fold pattern */
    foldPatternId: string;
    /** Label hiển thị */
    label: string;
    /** Số cột × số hàng spread trên kẽm */
    cols: number;
    rows: number;
    /** Có vừa khổ kẽm không? */
    fits: boolean;
    /** Diện tích sử dụng kẽm (%) — càng cao càng tối ưu */
    sheetUtilization: number;
    /** Kích thước grid chiếm (mm) */
    gridWidthMm: number;
    gridHeightMm: number;
    /** Khoảng trống dư (mm) theo mỗi chiều */
    gapWidthMm: number;
    gapHeightMm: number;
}

export interface OptimizationResult {
    /** Tất cả options (fit + không fit) */
    allOptions: SigOption[];
    /** Options khả thi (fits = true) */
    validOptions: SigOption[];
    /** Option tối ưu nhất (utilization cao nhất) — null nếu không có */
    recommended: SigOption | null;
    /** Cảnh báo nếu có */
    warnings: string[];
    /** Kích thước trang gốc (mm) cho hiển thị */
    pageSizeMm: { w: number; h: number };
}

// ==================== SIG DEFINITIONS ====================

interface SigDef {
    pagesPerSig: number;
    foldPatternId: string;
    label: string;
    cols: number;
    rows: number;
}

const SIG_DEFS: SigDef[] = [
    { pagesPerSig: 16, foldPatternId: 'sig_16p', label: 'Tay 16 trang', cols: 2, rows: 2 },
    { pagesPerSig: 8,  foldPatternId: 'sig_8p',  label: 'Tay 8 trang',  cols: 2, rows: 2 },
    { pagesPerSig: 4,  foldPatternId: 'sig_4p_2up',  label: 'Tay 4 trang (2 bộ)', cols: 2, rows: 2 },
    { pagesPerSig: 4,  foldPatternId: 'sig_4p_1up',  label: 'Tay 4 trang (1 bộ)', cols: 1, rows: 2 },
];

// ==================== CORE LOGIC ====================

/**
 * Tính spread dimensions từ page dimensions.
 * 1 spread = 2 trang ghép cạnh (double-page spread) + bleed mỗi bên.
 * 
 * Ví dụ trang A5 (148×210mm), bleed 2mm:
 *   spread = (148 + 2×2) × 2 hướng width THỰC RA KHÔNG PHẢI NHƯ VẬY
 *   
 * Thực tế spread dimensions lấy từ GeometricSolver:
 *   spreadW = pageW * 2 (2 trang ghép ngang, bleed đã tính trong pageW nếu có)
 *   spreadH = pageH
 *   Rồi pipeline thêm bleed thêm 1 lớp nữa nếu cần.
 * 
 * Để đơn giản và chính xác cho optimizer, ta tính:
 *   spreadW = pageW + pageW = pageW * 2  (2 trang ngang)
 *   spreadH = pageH  
 *   Bleed thêm mỗi cạnh spread: +2×bleed mỗi chiều
 */
function calcSpreadSize(page: PageDimensions, bleedMm: number, spineGapMm: number = 0): { w: number; h: number } {
    const bleedPt = bleedMm * MM_TO_POINTS;
    const gapPt = spineGapMm * MM_TO_POINTS;
    
    // Spread = 2 trang ghép ngang. 
    // Trang PDF đã CÓ SẴN bleed. 
    // Khi ráp lồng (saddle), 2 mép gáy đè lên nhau -> chiều rộng tổng giảm đi 2*bleedPt.
    // Nếu có khoảng hở gáy (gapPt) thì cộng thêm vào.
    const w = page.width * 2 - 2 * bleedPt + gapPt;
    
    // Chiều cao giữ nguyên vì trang PDF đã bao gồm bleed trên/dưới.
    const h = page.height;
    
    return { w, h };
}

/**
 * Tính vùng in hiệu dụng trên tờ kẽm (sau khi trừ nhíp + lề).
 * QUAN TRỌNG: Trong in Offset, nhíp (gripper) LUÔN LUÔN nằm ở cạnh DÀI của kẽm (chiều dài trục bồng).
 * Do đó, nhíp sẽ "ăn" vào kích thước của cạnh NGẮN (chu vi bồng).
 */
function calcUsableArea(sheet: SheetDimensions, margins: MarginConfig): { w: number; h: number } {
    const isPortrait = sheet.height >= sheet.width;
    
    let w, h;
    if (isPortrait) {
        // Cạnh ngắn là width (ví dụ 430x650 -> width = 430). 
        // Nhíp phải ăn vào width!
        w = sheet.width - margins.gripperMargin - margins.marginTop;
        h = sheet.height - margins.marginLeft - margins.marginRight;
    } else {
        // Cạnh ngắn là height.
        // Nhíp ăn vào height.
        w = sheet.width - margins.marginLeft - margins.marginRight;
        h = sheet.height - margins.gripperMargin - margins.marginTop;
    }

    return { w: Math.max(0, w), h: Math.max(0, h) };
}

/**
 * Quyết định: Có nên xoay khổ kẽm 90° không?
 * (Landscape / Portrait optimization)
 */
function shouldRotateSheet(spreadW: number, spreadH: number, usableW: number, usableH: number, cols: number, rows: number): boolean {
    const gridW_normal = cols * spreadW;
    const gridH_normal = rows * spreadH;
    const fits_normal = gridW_normal <= usableW && gridH_normal <= usableH;

    // Thử xoay kẽm (swap usable W↔H)
    const fits_rotated = gridW_normal <= usableH && gridH_normal <= usableW;

    if (fits_normal) return false;
    if (fits_rotated && !fits_normal) return true;
    return false;
}

// ==================== PUBLIC API ====================

/**
 * Phân tích và đề xuất Master Signature tối ưu nhất.
 * 
 * @param pageDim - Kích thước trang PDF gốc (pt)
 * @param sheet   - Khổ kẽm (mm)
 * @param margins - Nhíp + lề + bleed (mm)
 * @returns OptimizationResult với danh sách options và recommendation
 */
export function optimizeMasterSig(
    pageDim: PageDimensions,
    sheet: SheetDimensions,
    margins: MarginConfig
): OptimizationResult {
    const warnings: string[] = [];
    const pageMm = {
        w: Math.round(pageDim.width / MM_TO_POINTS * 10) / 10,
        h: Math.round(pageDim.height / MM_TO_POINTS * 10) / 10,
    };

    // Tính spread size (pt)
    const spread = calcSpreadSize(pageDim, margins.bleed, margins.gapX || 0);
    const spreadMm = {
        w: spread.w / MM_TO_POINTS,
        h: spread.h / MM_TO_POINTS,
    };

    // ===================================================================
    // FIT CHECK: Dùng TOÀN BỘ diện tích kẽm vật lý (không trừ lề).
    //
    // Lý do: Spread size đã bao gồm bleed bên trong. Lề (marginTop,
    // gripperMargin, marginLeft, marginRight) là vùng offset bố cục,
    // KHÔNG PHẢI vùng cấm cứng. Thợ in luôn điều chỉnh được vị trí
    // kẽm trên máy. Nếu grid vừa khít tờ kẽm về mặt vật lý, ta nên
    // cho phép fit và chỉ cảnh báo nếu dung sai quá hẹp.
    // ===================================================================
    const fullSheet = { w: sheet.width, h: sheet.height };

    // Vùng có lề — chỉ dùng tính dung sai + hiển thị gap
    const usableWithMargins = calcUsableArea(sheet, margins);

    // Vùng FIT THẬT = khổ trừ ĐÚNG nhíp (gripper) — vùng cấm CỨNG không in được.
    // Lề top/bottom/left/right là lề MỀM (bố cục, thợ in dịch kẽm được) → KHÔNG trừ khi
    // check fit, chỉ dùng để cảnh báo "sát lề". (Trước đây trừ cả marginTop làm tay 16 bị
    // loại oan khi gripper+marginTop > dung sai, dù vật lý vẫn vừa.)
    const gripperUsable = calcUsableArea(sheet, {
        ...margins, marginTop: 0, marginLeft: 0, marginRight: 0,
    });

    const allOptions: SigOption[] = [];

    const gapX = margins.gapX || 0;
    const gapY = margins.gapY || 0;

    for (const def of SIG_DEFS) {
        const gridW = spreadMm.w * def.cols + (def.cols > 1 ? (def.cols - 1) * gapX : 0);
        const gridH = spreadMm.h * def.rows + (def.rows > 1 ? (def.rows - 1) * gapY : 0);

        // === PRIMARY FIT: chỉ trừ nhíp cứng (gripperUsable), lề mềm không tính ===
        let fits = gridW <= gripperUsable.w && gridH <= gripperUsable.h;
        let actualGridW = gridW;
        let actualGridH = gridH;
        let isRotated = false;

        // Thử xoay kẽm nếu không fit
        if (!fits) {
            const fitsRotated = gridW <= gripperUsable.h && gridH <= gripperUsable.w;
            if (fitsRotated) {
                fits = true;
                isRotated = true;
            }
        }

        // === TIGHT FIT WARNING: Cảnh báo nếu dung sai quá hẹp ===
        let tightFit = false;
        if (fits) {
            const effectiveUsableW = isRotated ? fullSheet.h : fullSheet.w;
            const effectiveUsableH = isRotated ? fullSheet.w : fullSheet.h;
            const remainW = effectiveUsableW - gridW;
            const remainH = effectiveUsableH - gridH;
            // Nếu dung sai < tổng lề yêu cầu → cảnh báo
            const neededMarginW = margins.marginLeft + margins.marginRight;
            const neededMarginH = margins.gripperMargin + margins.marginTop;
            if (remainW < neededMarginW || remainH < neededMarginH) {
                tightFit = true;
            }
        }

        const sheetArea = sheet.width * sheet.height;
        const gridArea = actualGridW * actualGridH;
        const utilization = sheetArea > 0 ? Math.round((gridArea / sheetArea) * 1000) / 10 : 0;

        // Tính gap dựa trên vùng có lề (để hiển thị khoảng dư thực tế)
        const displayUsableW = isRotated ? usableWithMargins.h : usableWithMargins.w;
        const displayUsableH = isRotated ? usableWithMargins.w : usableWithMargins.h;

        allOptions.push({
            pagesPerSig: def.pagesPerSig,
            foldPatternId: def.foldPatternId,
            label: def.label + (tightFit ? ' (sát lề)' : ''),
            cols: def.cols,
            rows: def.rows,
            fits,
            sheetUtilization: utilization,
            gridWidthMm: Math.round(actualGridW * 10) / 10,
            gridHeightMm: Math.round(actualGridH * 10) / 10,
            gapWidthMm: Math.round(Math.max(0, displayUsableW - actualGridW) * 10) / 10,
            gapHeightMm: Math.round(Math.max(0, displayUsableH - actualGridH) * 10) / 10,
        });
    }

    const validOptions = allOptions.filter(o => o.fits);
    
    // Recommended = fits + pagesPerSig lớn nhất (hiệu suất cao nhất)
    const recommended = validOptions.length > 0 
        ? validOptions.reduce((best, curr) => curr.pagesPerSig > best.pagesPerSig ? curr : best)
        : null;

    // Warnings
    if (!recommended) {
        warnings.push(`⚠ Khổ kẽm ${sheet.width}×${sheet.height}mm quá nhỏ cho trang ${pageMm.w}×${pageMm.h}mm! Không vừa kể cả Tay 4.`);
    } else if (recommended.pagesPerSig === 4) {
        warnings.push(`⚠ Khổ kẽm chỉ vừa Tay 4 — có thể tối ưu hơn nếu tăng khổ giấy.`);
    }

    if (recommended && recommended.label.includes('sát lề')) {
        warnings.push(`⚠ Tay ${recommended.pagesPerSig} trang fit sát lề kẽm. Dung sai hẹp — kiểm tra lại nhíp máy và lề gặm.`);
    }

    if (recommended && recommended.gapWidthMm > spreadMm.w * 0.5) {
        warnings.push(`💡 Kẽm còn dư nhiều (${recommended.gapWidthMm}mm ngang). Có thể giảm khổ giấy để tiết kiệm.`);
    }

    return {
        allOptions,
        validOptions,
        recommended,
        warnings,
        pageSizeMm: pageMm,
    };
}

/**
 * Gợi ý khổ giấy tối thiểu để fit Tay 16 (hoặc Tay 8 nếu quá lớn).
 */
export function suggestMinimumSheet(
    pageDim: PageDimensions,
    margins: MarginConfig
): { forSig16: SheetDimensions | null; forSig8: SheetDimensions; forSig4: SheetDimensions } {
    const spread = calcSpreadSize(pageDim, margins.bleed);
    const sMm = { w: spread.w / MM_TO_POINTS, h: spread.h / MM_TO_POINTS };

    const extraW = margins.marginLeft + margins.marginRight;
    const extraH = margins.gripperMargin + margins.marginTop;

    const sig16W = Math.ceil(sMm.w * 2 + extraW);
    const sig16H = Math.ceil(sMm.h * 2 + extraH);
    const sig8W = Math.ceil(sMm.w * 2 + extraW);
    const sig8H = Math.ceil(sMm.h * 2 + extraH);
    const sig4W = Math.ceil(sMm.w * 1 + extraW);
    const sig4H = Math.ceil(sMm.h * 2 + extraH);

    return {
        forSig16: { width: sig16W, height: sig16H },
        forSig8: { width: sig8W, height: sig8H },
        forSig4: { width: sig4W, height: sig4H },
    };
}
