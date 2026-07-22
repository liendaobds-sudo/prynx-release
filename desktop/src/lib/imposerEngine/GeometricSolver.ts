// src/lib/imposerEngine/GeometricSolver.ts
import type { BookletSettings } from '../../components/imposition-tools/ImposerDashboard';

export interface PageTransform {
    scale: number;
    rawX: number;
    rawY: number;
    clipX: number;
    clipY: number;
    clipW: number;
    clipH: number;
    trimBox: { x: number; y: number; width: number; height: number };
}

export interface GeometricContext {
    finalSheetWidth: number;
    finalSheetHeight: number;
    scaleFactor: number;
    actualDrawnWidth: number;
    actualDrawnHeight: number;
    needsScaleDown: boolean;
    suggestedScaleFactor: number;
    margins: { top: number; bottom: number; left: number; right: number };
    isRotated?: boolean; // Added to indicate if the grid is rotated 90 degrees
}

export const solveGeometry = (
    maxSrcW: number,
    maxSrcH: number,
    settings: BookletSettings,
    PREDEFINED_SIZES: Record<string, { w: number, h: number }>,
    MM_TO_POINTS: number,
    spineGapPt: number = 0
): GeometricContext => {
    let finalSheetWidth = 0;
    let finalSheetHeight = 0;
    let scaleFactor = 1.0;

    const spreadW = maxSrcW * 2 + spineGapPt;
    const spreadH = maxSrcH;

    const bleedPt = (settings.bleed || 0) * MM_TO_POINTS;
    const pullToSpine = settings.spreadDistribution !== 'even';

    if (settings.formsize === 'auto_100') {
        // Shrink the total sheet width by 2x bleed because the pages are pulled towards the center spine
        finalSheetWidth = spreadW - (pullToSpine ? bleedPt * 2 : 0);
        finalSheetHeight = spreadH;
        scaleFactor = 1.0;
    } else {
        const isCustom = settings.formsize === 'custom';
        const wMm = isCustom ? settings.customSheetWidth : PREDEFINED_SIZES[settings.formsize].w;
        const hMm = isCustom ? settings.customSheetHeight : PREDEFINED_SIZES[settings.formsize].h;

        const spreadRatio = spreadW / spreadH;
        const sheetRatio = wMm / hMm;
        let isRotated = false;

        // If the spread is wider than it is tall (typical booklet), 
        // but the paper is taller than it is wide (portrait), rotate the grid
        if (spreadRatio > 1 && sheetRatio < 1) {
            isRotated = true;
        }
        // If the spread is taller than it is wide (very rare vertical booklet or 2x2 grid),
        // but the paper is wider than it is tall, rotate the grid
        else if (spreadRatio <= 1 && sheetRatio >= 1) {
            isRotated = true;
        }

        finalSheetWidth = wMm * MM_TO_POINTS;
        finalSheetHeight = hMm * MM_TO_POINTS;

        const mTop = (settings.marginTop || 0) * MM_TO_POINTS;
        const mBottom = (settings.marginBottom || 0) * MM_TO_POINTS;
        const mLeft = (settings.marginLeft || 0) * MM_TO_POINTS;
        const mRight = (settings.marginRight || 0) * MM_TO_POINTS;
        const marginMode = settings.marginMode || 'labels_only';

        const innerSheetWidth = finalSheetWidth - mLeft - mRight;
        const innerSheetHeight = finalSheetHeight - mTop - mBottom;

        let requiredW = spreadW - (pullToSpine ? bleedPt * 2 : 0);
        let requiredH = spreadH;

        // If they want marks strictly inside the margin, we must add the space marks consume
        if (marginMode === 'include_marks' && settings.markType !== 'none') {
            const extraPt = ((settings.markOffset || 3) + (settings.markLength || 5)) * 2 * MM_TO_POINTS;
            requiredW += extraPt;
            requiredH += extraPt;
        }

        const ratioW = innerSheetWidth / requiredW;
        const ratioH = innerSheetHeight / requiredH;
        const computedScale = Math.min(ratioW, ratioH, 1.0);

        scaleFactor = 1.0; // Default to 1.0 (do not implicitly scale)

        return {
            finalSheetWidth,
            finalSheetHeight,
            scaleFactor,
            actualDrawnWidth: maxSrcW * scaleFactor,
            actualDrawnHeight: maxSrcH * scaleFactor,
            needsScaleDown: computedScale < 0.999,
            suggestedScaleFactor: computedScale,
            margins: { top: mTop, bottom: mBottom, left: mLeft, right: mRight },
            isRotated
        };
    }

    return {
        finalSheetWidth,
        finalSheetHeight,
        scaleFactor,
        actualDrawnWidth: maxSrcW * scaleFactor,
        actualDrawnHeight: maxSrcH * scaleFactor,
        needsScaleDown: false,
        suggestedScaleFactor: scaleFactor,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        isRotated: false
    };
};

export const solvePageTransform = (
    context: GeometricContext,
    isLeftSlot: boolean,
    isFront: boolean,
    sheetIndex: number,
    totalSheets: number,
    bleedPt: number,
    paperThicknessPt: number,
    isSaddleOrThread: boolean,
    gutterPt: number = 0,
    isCutStackSpread: boolean = false,
    spineGapPt: number = 0,
    spreadDistribution?: 'clustered' | 'even',
    isSaddle: boolean = false
): PageTransform => {

    const innerW = context.finalSheetWidth - context.margins.left - context.margins.right;
    const innerH = context.finalSheetHeight - context.margins.top - context.margins.bottom;

    // Centers the entire spread in the middle of the inner safe zone, then offsets by bottom/left margins
    const marginX = context.margins.left + (innerW - (context.actualDrawnWidth * 2)) / 2;
    const marginY = context.margins.bottom + (innerH - context.actualDrawnHeight) / 2;

    const halfSheetCenterX = context.margins.left + innerW / 2;

    // Creep / Shingling compensation (chuẩn ngành in — InDesign, Quite Imposing, Fiery):
    // Tờ trong bị đẩy ra mép ngoài khi gấp lồng → dao xén cắt sâu hơn vào tờ trong.
    // Bù trừ: dịch CONTENT (page image) tờ trong vào gáy. Trim marks CỐ ĐỊNH.
    // Tờ ngoài (bìa) = tham chiếu (shift=0). Tờ càng trong → shift càng nhiều.
    let creepShift = 0;
    if (isSaddleOrThread) {
        // Negative = spread narrows = content moves toward spine
        creepShift = -paperThicknessPt * sheetIndex;
    }

    const trimW = context.actualDrawnWidth - 2 * bleedPt;
    const trimH = context.actualDrawnHeight - 2 * bleedPt;

    let pageX = 0;
    let baseTrimX = 0; // Trim position WITHOUT creep (fixed for all sheets)
    let clipX = 0;
    let clipW = 0;

    if (spreadDistribution === 'even') {
        // Divide the inner safe zone into two equal halves, and center the page in its respective half
        const halfWidth = innerW / 2;
        if (isLeftSlot) {
            pageX = context.margins.left + (halfWidth - context.actualDrawnWidth) / 2;
        } else {
            pageX = halfSheetCenterX + (halfWidth - context.actualDrawnWidth) / 2;
        }
        baseTrimX = pageX + bleedPt;
        clipX = pageX;
        clipW = context.actualDrawnWidth;
    } else {
        // Pull to Spine: aligns to the center spine considering the physical gap (spineGapPt).
        // Bleeds that cross the center will be strictly clipped at halfSheetCenterX.
        if (isLeftSlot) {
            const baseX = halfSheetCenterX - spineGapPt / 2 - context.actualDrawnWidth + bleedPt;
            pageX = baseX;
            baseTrimX = baseX + bleedPt;      // Trim: fixed (no creep)
            clipX = baseX;
            clipW = halfSheetCenterX - baseX + 0.3; // clip up to the center spine
        } else {
            const baseX = halfSheetCenterX + spineGapPt / 2 - bleedPt;
            pageX = baseX;
            baseTrimX = baseX + bleedPt;      // Trim: fixed (no creep)
            clipX = halfSheetCenterX - 0.3;         // clip starting from the center spine
            clipW = context.actualDrawnWidth + (baseX - halfSheetCenterX) + 0.3;
        }
    }

    // Creep / Shingling — applied uniformly to CONTENT only (trim/clip stay fixed),
    // so it works for BOTH 'clustered' (pull-to-spine) and 'even' distribution.
    // Inner sheets (sheetIndex > 0) shift their image toward the spine.
    if (isSaddleOrThread && creepShift !== 0) {
        pageX += isLeftSlot ? -creepShift : creepShift;
    }

    // Gutter: dịch content ra xa spine cho keo gáy / khâu chỉ (perfect/sewn binding).
    // Áp dụng cho 'continuous' VÀ 'thread'; KHÔNG áp cho saddle (gấp tại gáy) và cut_stacks.
    // Trang trái → dịch sang trái (xa spine). Trang phải → dịch sang phải.
    if (gutterPt > 0 && !isSaddle && !isCutStackSpread) {
        if (isLeftSlot) {
            pageX -= gutterPt;
        } else {
            pageX += gutterPt;
        }
    }

    return {
        scale: context.scaleFactor,
        rawX: pageX,
        rawY: marginY,
        clipX: clipX,
        clipY: marginY,
        clipW: clipW,
        clipH: context.actualDrawnHeight,
        trimBox: { x: baseTrimX, y: marginY + bleedPt, width: trimW, height: trimH }
    };
};
