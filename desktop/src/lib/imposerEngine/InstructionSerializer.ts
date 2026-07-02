// src/lib/imposerEngine/InstructionSerializer.ts
// =========================================================================
//  Biến output của Planner (VirtualMap, GeometricSolver, FoldPatterns)
//  thành JSON Instruction Set thuần túy để gửi cho Backend Python.
//
//  Module này KHÔNG import pdf-lib. Chỉ làm việc với con số.
// =========================================================================

import type { VirtualSheet } from './VirtualMap';
import type { GeometricContext } from './GeometricSolver';
import { solvePageTransform } from './GeometricSolver';
import type { ProcessingSettings } from '../pdfImposer';
import { getSpreadPatternById, getPatternForPageCount, type SpreadFoldPattern } from './FoldPatterns';

const MM_TO_POINTS = 2.83465;

// ==================== OUTPUT TYPES ====================

export interface PlacementInstruction {
    /** 0-based source page index from original PDF, or null for blank */
    source_page: number | null;
    x_pt: number;
    y_pt: number;
    rotation_deg: number;
    scale: number;
    /** Clipping rectangle, null = no clip */
    clip: {
        x_pt: number;
        y_pt: number;
        w_pt: number;
        h_pt: number;
    } | null;
    /** Native rotation angle from source page (0, 90, 180, 270) */
    native_angle: number;
}

export interface MarkInstruction {
    type: 'trim_line' | 'fold_mark' | 'slit_mark' | 'registration' | 'color_bar';
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    /** CMYK color: [C, M, Y, K] where each is 0-1. For RGB marks, approximate. */
    color: [number, number, number, number];
    thickness_pt: number;
}

export interface SheetSideInstruction {
    placements: PlacementInstruction[];
    marks: MarkInstruction[];
}

export interface SheetInstruction {
    sheet_index: number;
    width_pt: number;
    height_pt: number;
    front: SheetSideInstruction;
    back: SheetSideInstruction;
}

export interface InstructionSet {
    version: string;
    source_pdf_path: string;
    output_dir: string;
    global: {
        bleed_pt: number;
        paper_thickness_pt: number;
        total_source_pages: number;
        mark_type: string;
        mark_length_pt: number;
        mark_offset_pt: number;
        mark_thickness_pt: number;
    };
    /** Page details: native rotation angles for each source page */
    page_details: { angle: number; visual_w: number; visual_h: number }[];
    sheets: SheetInstruction[];
    /**
     * Phase-2 arrangement (Step & Repeat / Fold Pattern / Cut & Stack).
     * Khi có: `sheets` là các "trang spread" trung gian (mỗi sheet = 1 mặt spread,
     * chỉ dùng `front`). Backend render `sheets` ra doc tạm rồi đặt từng spread
     * (theo `spread_index`) lên các tờ kẽm lớn theo `plates`.
     */
    phase2?: Phase2Set;
}

export interface Phase2Placement {
    /** Index vào mảng `sheets` (mỗi sheet = 1 trang spread trung gian) */
    spread_index: number;
    x_pt: number;
    y_pt: number;
    /** 0 hoặc 180 (chưa hỗ trợ xoay lưới 90° trong phase-2) */
    rotation_deg: number;
}

export interface Phase2Plate {
    width_pt: number;
    height_pt: number;
    placements: Phase2Placement[];
    marks: MarkInstruction[];
    label?: string;
}

export interface Phase2Set {
    mode: 'step_repeat' | 'fold_pattern' | 'cut_stack';
    spread_w_pt: number;
    spread_h_pt: number;
    plates: Phase2Plate[];
}

// ==================== BOOKLET SERIALIZER ====================

/**
 * Serialize a Booklet rendering plan (VirtualMap + GeometricContext) into JSON.
 * This replaces the role of Renderer.ts (renderBooklet) for Backend execution.
 */
export function serializeBookletPlan(
    virtualMap: VirtualSheet[],
    srcPageDetails: { visualW: number; visualH: number; angle: number }[],
    context: GeometricContext,
    bleedPt: number,
    paperThicknessPt: number,
    isSaddleOrThread: boolean,
    markType: string,
    interleaveMode: string,
    settings: ProcessingSettings,
    sourcePdfPath: string,
    outputDir: string,
    totalSourcePages: number
): InstructionSet {
    const markLenPt = ((settings as any).markLength ?? 5.0) * MM_TO_POINTS;
    const markOffPt = ((settings as any).markOffset ?? 3.0) * MM_TO_POINTS;
    const markThickPt = ((settings as any).markThickness ?? 0.25) * MM_TO_POINTS;

    // ── Spread-frame layout knobs (mirror Renderer.renderBooklet phase-1) ──
    // Phase 1 luôn dùng clustered + spineGap=0 (gáy sát để gấp/khâu).
    // Gutter (lề gáy) áp cho perfect/sewn; cut_stacks "Hút gáy" xoay 180° cọc phải.
    const bindingMode = (settings as any).bindingMode;
    const gutterPt = ((settings as any).gutterMargin || 0) * MM_TO_POINTS;
    const isCutStackSpread = bindingMode === 'cut_stacks';
    const isSaddle = bindingMode === 'saddle';
    const cutStackDistribution = (settings as any).spreadDistribution || 'clustered';
    const cutStackHutGay = cutStackDistribution !== 'even';
    /** Cọc phải khi "Hút gáy & Xén úp" phải xoay 180° để 2 nửa đối xứng lề khi úp. */
    const cutStackRotates = (isFront: boolean, isLeft: boolean): boolean => {
        const isRightStack = isFront ? !isLeft : isLeft;
        return isCutStackSpread && cutStackHutGay && isRightStack;
    };

    // Build surface iteration order (same logic as Renderer.ts)
    const surfaces: { sheetIndex: number; isFront: boolean; slots: any; sheet: VirtualSheet }[] = [];

    const isSingleSided = (settings as any).signatureMode === 'flush_mount';

    if (interleaveMode === 'normal' || isSingleSided) {
        for (const sheet of virtualMap) {
            surfaces.push({ sheetIndex: sheet.sheetIndex, isFront: true, slots: sheet.front, sheet });
            if (!isSingleSided) {
                surfaces.push({ sheetIndex: sheet.sheetIndex, isFront: false, slots: sheet.back, sheet });
            } else {
                surfaces.push({ sheetIndex: sheet.sheetIndex, isFront: false, slots: null, sheet, isEmpty: true } as any);
            }
        }
    } else if (interleaveMode === 'all_fronts_first') {
        for (const sheet of virtualMap) {
            surfaces.push({ sheetIndex: sheet.sheetIndex, isFront: true, slots: sheet.front, sheet });
        }
        for (const sheet of virtualMap) {
            surfaces.push({ sheetIndex: sheet.sheetIndex, isFront: false, slots: sheet.back, sheet });
        }
    } else if (interleaveMode === 'reverse_backs' || interleaveMode === 'reverse_backs_180') {
        for (const sheet of virtualMap) {
            surfaces.push({ sheetIndex: sheet.sheetIndex, isFront: true, slots: sheet.front, sheet });
        }
        const reversedMap = [...virtualMap].reverse();
        for (const sheet of reversedMap) {
            surfaces.push({ sheetIndex: sheet.sheetIndex, isFront: false, slots: sheet.back, sheet });
        }
    }

    // ── Helper: dựng 1 placement cho slot left/right của 1 surface (spread frame) ──
    const makePlacement = (surf: any, isLeft: boolean): PlacementInstruction => {
        const isFront = surf.isFront;
        const slot = isLeft ? surf.slots.left : surf.slots.right;
        const effSheetIndex = surf.sheet.sigLocalIndex ?? surf.sheetIndex;
        const effTotalSheets = surf.sheet.sigTotalSheets ?? virtualMap.length;
        const transform = solvePageTransform(
            context, isLeft, isFront, effSheetIndex, effTotalSheets,
            bleedPt, paperThicknessPt, isSaddleOrThread,
            gutterPt, isCutStackSpread, 0, 'clustered', isSaddle
        );
        const srcIndex = slot.srcIndex;
        const srcDetail = srcIndex !== null && srcIndex < srcPageDetails.length
            ? srcPageDetails[srcIndex] : null;
        // is180 = XOR(reverse_backs_180 trên mặt sau, cọc phải cut-stack hút gáy)
        const rev180 = !isFront && interleaveMode === 'reverse_backs_180';
        const rot180 = rev180 !== cutStackRotates(isFront, isLeft);
        return {
            source_page: srcIndex,
            x_pt: transform.rawX,
            y_pt: transform.rawY,
            rotation_deg: rot180 ? 180 : 0,
            scale: transform.scale,
            clip: {
                x_pt: transform.clipX,
                y_pt: transform.clipY,
                w_pt: transform.clipW,
                h_pt: transform.clipH,
            },
            native_angle: srcDetail?.angle ?? 0,
        };
    };
    const buildSurfacePlacements = (surf: any): PlacementInstruction[] =>
        (!surf || (surf as any).isEmpty) ? [] : [makePlacement(surf, true), makePlacement(surf, false)];

    // ── Phát hiện chế độ phase-2 (Step&Repeat / Fold Pattern / Cut&Stack) ──
    const fpId = (settings as any).foldPattern;
    let foldPattern: SpreadFoldPattern | null = null;
    if (fpId && fpId !== 'auto') {
        foldPattern = getSpreadPatternById(fpId) ?? null;
    } else if (fpId === 'auto' && virtualMap.length > 0) {
        const firstSigSheets = virtualMap[0].sigTotalSheets ?? virtualMap.length;
        foldPattern = getPatternForPageCount(firstSigSheets * 4) ?? null;
    }
    const wantChainNup = !!(settings as any).chainNup;
    const wantCutStack = !!(settings as any).cutStack;
    const phase2Mode: 'step_repeat' | 'fold_pattern' | 'cut_stack' | null =
        foldPattern ? 'fold_pattern'
            : (wantChainNup && wantCutStack) ? 'cut_stack'
                : wantChainNup ? 'step_repeat'
                    : null;

    const sheets: SheetInstruction[] = [];
    let phase2: Phase2Set | undefined = undefined;

    if (phase2Mode) {
        // Phase-1: mỗi surface → 1 trang spread trung gian (front-only, KHÔNG marks).
        // Backend render các trang này ra doc tạm rồi sắp lên kẽm lớn theo phase2.plates.
        for (const surf of surfaces) {
            sheets.push({
                sheet_index: sheets.length,
                width_pt: context.finalSheetWidth,
                height_pt: context.finalSheetHeight,
                front: { placements: buildSurfacePlacements(surf), marks: [] },
                back: undefined as any,
            });
        }

        const spreadW = context.finalSheetWidth;
        const spreadH = context.finalSheetHeight;
        const pressW = ((settings as any).sheetWidth || 0) * MM_TO_POINTS;
        const pressH = ((settings as any).sheetHeight || 0) * MM_TO_POINTS;

        phase2 = buildPhase2(
            phase2Mode, foldPattern, surfaces.length, spreadW, spreadH,
            pressW, pressH, bleedPt, markLenPt, markOffPt, markThickPt, markType, settings
        );
    } else {
        // ── Đường thường: 1-up booklet, mỗi tờ kẽm = front + back của 1 virtual sheet ──
        // Trim box THỰC của spread: lấy từ chính solvePageTransform (đồng bộ tuyệt đối
        // với cách đặt trang — pull-to-spine, gutter…). Trim cố định mọi tờ (creep không
        // dời trim) nên tính 1 lần với sheetIndex=0. Sửa lỗi dấu xén lệch ngang = bleed.
        const _tL = solvePageTransform(context, true, true, 0, virtualMap.length,
            bleedPt, paperThicknessPt, isSaddleOrThread, gutterPt, isCutStackSpread, 0, 'clustered', isSaddle);
        const _tR = solvePageTransform(context, false, true, 0, virtualMap.length,
            bleedPt, paperThicknessPt, isSaddleOrThread, gutterPt, isCutStackSpread, 0, 'clustered', isSaddle);
        const spreadTrim = {
            left: _tL.trimBox.x,
            right: _tR.trimBox.x + _tR.trimBox.width,
            bottom: _tL.trimBox.y,
            top: _tL.trimBox.y + _tL.trimBox.height,
        };
        for (let surfIdx = 0; surfIdx < surfaces.length; surfIdx += 2) {
            const frontSurf = surfaces[surfIdx];
            const backSurf = surfaces[surfIdx + 1];

            const frontPlacements = buildSurfacePlacements(frontSurf);
            const backPlacements = buildSurfacePlacements(backSurf);

            const frontMarks = serializeBookletMarks(context, spreadTrim, markLenPt, markOffPt, markThickPt, markType);
            const backMarks = serializeBookletMarks(context, spreadTrim, markLenPt, markOffPt, markThickPt, markType);

            const sheet: SheetInstruction = {
                sheet_index: frontSurf?.sheetIndex ?? surfIdx / 2,
                width_pt: context.finalSheetWidth,
                height_pt: context.finalSheetHeight,
                front: { placements: frontPlacements, marks: frontMarks },
                back: (backSurf as any)?.isEmpty ? undefined : { placements: backPlacements, marks: backMarks },
            } as any;

            if (context.isRotated) {
                const innerW = context.finalSheetWidth - context.margins.left - context.margins.right;
                const innerH = context.finalSheetHeight - context.margins.top - context.margins.bottom;
                const cx = context.margins.left + innerW / 2;
                const cy = context.margins.bottom + innerH / 2;
                applyGridRotation(sheet, cx, cy);
            }

            sheets.push(sheet);
        }
    }

    return {
        version: '1.0',
        source_pdf_path: sourcePdfPath,
        output_dir: outputDir,
        global: {
            bleed_pt: bleedPt,
            paper_thickness_pt: paperThicknessPt,
            total_source_pages: totalSourcePages,
            mark_type: markType,
            mark_length_pt: markLenPt,
            mark_offset_pt: markOffPt,
            mark_thickness_pt: markThickPt,
        },
        page_details: srcPageDetails.map(d => ({
            angle: d.angle, visual_w: d.visualW, visual_h: d.visualH,
        })),
        sheets,
        ...(phase2 ? { phase2 } : {}),
    };
}

// ==================== PHASE-2 ARRANGEMENT BUILDER ====================

/**
 * Dựng các tờ kẽm lớn (plates) sắp xếp các trang spread trung gian.
 * Toạ độ trả về theo gốc PDF bottom-left (backend tự đổi sang top-left).
 *
 * Giới hạn hiện tại (ghi rõ để không hiểu lầm là đã đủ):
 *   - CHƯA xoay lưới 90° để fit khổ (chỉ đặt lưới theo đúng chiều spread).
 *     Người dùng cần chọn khổ kẽm có chiều phù hợp với spread.
 *   - rotation per-slot chỉ 0/180 (đúng theo SpreadFoldPattern).
 */
export interface SpreadGridLayout {
    /** Khổ tờ in output (pt) — ĐÃ xoay landscape cho digital nếu cần. */
    frameW: number;
    frameH: number;
    cols: number;
    rows: number;
    /** Gốc dưới-trái (pt) của ô lưới (col, row); row 0 = hàng dưới cùng. */
    cellPos: (col: number, row: number) => { x: number; y: number };
}

/**
 * Lưới step & repeat / cut-stack cho 1 spread trên tờ in. NGUỒN CHÂN LÝ DUY NHẤT
 * dùng chung bởi serializer (output thật) và preview "Xem Bài In" để khớp tuyệt đối.
 * Mọi tham số theo POINTS. Trả về khổ tờ đã xoay landscape (digital) + lưới ô.
 */
export function computeSpreadGrid(
    spreadW: number, spreadH: number,
    pressW: number, pressH: number,
    gapXPt: number, gapYPt: number,
    marginLeftPt: number, marginRightPt: number, marginTopPt: number, gripperPt: number,
): SpreadGridLayout {
    const hasPress = pressW > 0 && pressH > 0;
    const sheetW = hasPress ? pressW : spreadW + marginLeftPt + marginRightPt;
    const sheetH = hasPress ? pressH : spreadH + gripperPt + marginTopPt;

    const usableW0 = sheetW - marginLeftPt - marginRightPt;
    const usableH0 = sheetH - gripperPt - marginTopPt;
    const gridRatio = spreadW / spreadH;
    const sheetRatio = usableW0 / usableH0;
    let isRotated = false;
    if (gridRatio < 1 && sheetRatio > 1.05) isRotated = true;
    else if (gridRatio > 1 && sheetRatio < 0.95) isRotated = true;

    const frameW = isRotated ? sheetH : sheetW;
    const frameH = isRotated ? sheetW : sheetH;

    const usableW = frameW - marginLeftPt - marginRightPt;
    const usableH = frameH - gripperPt - marginTopPt;
    const cols = Math.max(1, Math.floor((usableW + gapXPt) / (spreadW + gapXPt)));
    const rows = Math.max(1, Math.floor((usableH + gapYPt) / (spreadH + gapYPt)));
    const gridW = cols * spreadW + (cols - 1) * gapXPt;
    const gridH = rows * spreadH + (rows - 1) * gapYPt;
    const oX = marginLeftPt + (usableW - gridW) / 2;
    const oY = gripperPt + (usableH - gridH) / 2;
    const cellPos = (c: number, r: number) => ({
        x: oX + c * (spreadW + gapXPt),
        y: oY + (rows - 1 - r) * (spreadH + gapYPt),
    });
    return { frameW, frameH, cols, rows, cellPos };
}

function buildPhase2(
    mode: 'step_repeat' | 'fold_pattern' | 'cut_stack',
    pattern: SpreadFoldPattern | null,
    surfaceCount: number,
    spreadW: number,
    spreadH: number,
    pressW: number,
    pressH: number,
    bleedPt: number,
    markLenPt: number,
    markOffPt: number,
    markThickPt: number,
    markType: string,
    settings: ProcessingSettings,
): Phase2Set {
    const gapXPt = ((settings as any).gapX || 0) * MM_TO_POINTS;
    const gapYPt = ((settings as any).gapY || 0) * MM_TO_POINTS;
    const marginLeftPt = ((settings as any).marginLeft || 0) * MM_TO_POINTS;
    const marginRightPt = ((settings as any).marginRight || 0) * MM_TO_POINTS;
    const marginTopPt = ((settings as any).marginTop || 0) * MM_TO_POINTS;
    const gripperPt = ((settings as any).gripperMargin || 0) * MM_TO_POINTS;
    const isEven = (settings as any).spreadDistribution === 'even';

    // Honor the user-specified press sheet. A booklet spread is ~2× a page wide,
    // so it is often wider than a portrait press sheet — the rotation step below
    // turns the spread 90° to fit (e.g. 418mm spread onto a 320×430 sheet). Only
    // grow the sheet to the spread when the user gave no press size.
    const hasPress = pressW > 0 && pressH > 0;
    const sheetW = hasPress ? pressW : spreadW + marginLeftPt + marginRightPt;
    const sheetH = hasPress ? pressH : spreadH + gripperPt + marginTopPt;

    // ── Quyết định xoay lưới 90° để fit khổ (giống SpreadPlacer/NupRenderer) ──
    let gW: number, gH: number;
    if (mode === 'fold_pattern' && pattern) {
        gW = pattern.cols * spreadW + (pattern.cols - 1) * gapXPt;
        gH = pattern.rows * spreadH + (pattern.rows - 1) * gapYPt;
    } else {
        gW = spreadW; gH = spreadH;
    }
    const usableW0 = sheetW - marginLeftPt - marginRightPt;
    const usableH0 = sheetH - gripperPt - marginTopPt;
    const gridRatio = gW / gH;
    const sheetRatio = usableW0 / usableH0;
    let isRotated = false;
    if (gridRatio < 1 && sheetRatio > 1.05) isRotated = true;
    else if (gridRatio > 1 && sheetRatio < 0.95) isRotated = true;

    // Khung dựng lưới (logic): nếu xoay thì hoán W/H tờ in.
    const frameW = isRotated ? sheetH : sheetW;
    const frameH = isRotated ? sheetW : sheetH;

    const black: [number, number, number, number] = [0, 0, 0, 1];
    const red: [number, number, number, number] = [0, 1, 1, 0]; // Magenta+Yellow ≈ Đỏ (CMYK) cho dấu gấp gáy
    const bindingMode = (settings as any).bindingMode;
    const isFoldable = bindingMode === 'saddle' || bindingMode === 'thread';
    const showMarks = !!markType && markType !== 'none';

    // Trim marks 4 góc + dấu gáy giữa spread. Gáy: đỏ (gấp) cho saddle/thread,
    // đen (xẻ/cắt) cho continuous/cut_stacks.
    const cellTrimMarks = (cellX: number, cellY: number): MarkInstruction[] => {
        if (!showMarks) return [];
        const tx = cellX + bleedPt, ty = cellY + bleedPt;
        const tw = spreadW - 2 * bleedPt, th = spreadH - 2 * bleedPt;
        const r = tx + tw, t = ty + th;
        const mk = (x1: number, y1: number, x2: number, y2: number): MarkInstruction =>
            ({ type: 'trim_line', x1, y1, x2, y2, color: black, thickness_pt: markThickPt });
        const spineX = cellX + spreadW / 2;
        const spineColor = isFoldable ? red : black;
        const spineType: MarkInstruction['type'] = isFoldable ? 'fold_mark' : 'slit_mark';
        const spineMk = (y1: number, y2: number): MarkInstruction =>
            ({ type: spineType, x1: spineX, y1, x2: spineX, y2, color: spineColor, thickness_pt: markThickPt });
        return [
            mk(tx, t + markOffPt, tx, t + markOffPt + markLenPt),
            mk(tx - markOffPt, t, tx - markOffPt - markLenPt, t),
            mk(r, t + markOffPt, r, t + markOffPt + markLenPt),
            mk(r + markOffPt, t, r + markOffPt + markLenPt, t),
            mk(tx, ty - markOffPt, tx, ty - markOffPt - markLenPt),
            mk(tx - markOffPt, ty, tx - markOffPt - markLenPt, ty),
            mk(r, ty - markOffPt, r, ty - markOffPt - markLenPt),
            mk(r + markOffPt, ty, r + markOffPt + markLenPt, ty),
            spineMk(t + markOffPt, t + markOffPt + markLenPt),
            spineMk(ty - markOffPt, ty - markOffPt - markLenPt),
        ];
    };

    // usableW/H trong khung logic (fold_pattern dùng để căn giữa lưới even).
    const usableW = frameW - marginLeftPt - marginRightPt;
    const usableH = frameH - gripperPt - marginTopPt;

    // Lưới đơn (step_repeat / cut_stack) — dùng CHUNG computeSpreadGrid với preview.
    const simpleGrid = computeSpreadGrid(
        spreadW, spreadH, pressW, pressH,
        gapXPt, gapYPt, marginLeftPt, marginRightPt, marginTopPt, gripperPt,
    );
    const simpleCols = simpleGrid.cols;
    const simpleRows = simpleGrid.rows;
    const simpleCellPos = simpleGrid.cellPos;

    let plates: Phase2Plate[] = [];

    if (mode === 'fold_pattern' && pattern) {
        const cols = pattern.cols, rows = pattern.rows;
        const gridW = cols * spreadW + (cols - 1) * gapXPt;
        const gridH = rows * spreadH + (rows - 1) * gapYPt;
        const totalGridW = isEven ? usableW : gridW;
        const totalGridH = isEven ? usableH : gridH;
        const originX = marginLeftPt + (usableW - totalGridW) / 2;
        const originY = gripperPt + (usableH - totalGridH) / 2;
        const cellPos = (col: number, row: number): { x: number; y: number } => {
            if (isEven) {
                const cw = cols > 0 ? usableW / cols : usableW;
                const ch = rows > 0 ? usableH / rows : usableH;
                return {
                    x: originX + col * cw + (cw - spreadW) / 2,
                    y: originY + (rows - 1 - row) * ch + (ch - spreadH) / 2,
                };
            }
            return { x: originX + col * (spreadW + gapXPt), y: originY + (rows - 1 - row) * (spreadH + gapYPt) };
        };
        const spreadsPerSig = pattern.spreadsPerSig;
        const totalSigs = Math.ceil(surfaceCount / spreadsPerSig);
        const sides: ('front' | 'back')[] = pattern.backPlate.length > 0 ? ['front', 'back'] : ['front'];
        for (let sig = 0; sig < totalSigs; sig++) {
            const sigOffset = sig * spreadsPerSig;
            for (const side of sides) {
                const slots = side === 'front' ? pattern.frontPlate : pattern.backPlate;
                const placements: Phase2Placement[] = [];
                const marks: MarkInstruction[] = [];
                for (const slot of slots) {
                    const spreadIndex = sigOffset + slot.spreadIndex;
                    if (spreadIndex >= surfaceCount) continue;
                    const { x, y } = cellPos(slot.col, slot.row);
                    placements.push({ spread_index: spreadIndex, x_pt: x, y_pt: y, rotation_deg: slot.rotation });
                    marks.push(...cellTrimMarks(x, y));
                }
                if (placements.length === 0) continue;
                plates.push({
                    width_pt: frameW, height_pt: frameH, placements, marks,
                    label: `Tay ${sig + 1}${sides.length > 1 ? (side === 'front' ? 'A' : 'B') : ''}`,
                });
            }
        }
    } else if (mode === 'cut_stack') {
        // Ghép nửa cuốn (Cut & Stack): mỗi tờ kẽm 2 mặt (front=surface chẵn, back=lẻ).
        // Mặt sau mirror cột (duplex lật trái-phải). Thứ tự cards theo cut&stack:
        // bookletSheet = cellIndex*stackDepth + depth → xén thành cols×rows cọc rồi
        // chồng theo thứ tự → ra cuốn liền mạch.
        const cells = simpleCols * simpleRows;
        const B = Math.floor(surfaceCount / 2); // số tờ sách (cặp front/back surface)
        const stackDepth = Math.max(1, Math.ceil(B / cells));
        for (let depth = 0; depth < stackDepth; depth++) {
            const front: Phase2Placement[] = [];
            const back: Phase2Placement[] = [];
            const fMarks: MarkInstruction[] = [];
            const bMarks: MarkInstruction[] = [];
            for (let cell = 0; cell < cells; cell++) {
                const bsi = cell * stackDepth + depth;
                if (bsi >= B) continue;
                const c = cell % simpleCols, r = Math.floor(cell / simpleCols);
                const pf = simpleCellPos(c, r);
                front.push({ spread_index: 2 * bsi, x_pt: pf.x, y_pt: pf.y, rotation_deg: 0 });
                fMarks.push(...cellTrimMarks(pf.x, pf.y));
                const pb = simpleCellPos(simpleCols - 1 - c, r); // mirror cột cho mặt sau
                back.push({ spread_index: 2 * bsi + 1, x_pt: pb.x, y_pt: pb.y, rotation_deg: 0 });
                bMarks.push(...cellTrimMarks(pb.x, pb.y));
            }
            if (front.length) plates.push({ width_pt: frameW, height_pt: frameH, placements: front, marks: fMarks, label: `Tờ ${depth + 1} - Mặt A` });
            if (back.length) plates.push({ width_pt: frameW, height_pt: frameH, placements: back, marks: bMarks, label: `Tờ ${depth + 1} - Mặt B` });
        }
    } else {
        // step_repeat: mỗi surface → 1 tờ kẽm, nhân bản đầy lưới.
        for (let si = 0; si < surfaceCount; si++) {
            const placements: Phase2Placement[] = [];
            const marks: MarkInstruction[] = [];
            for (let r = 0; r < simpleRows; r++) {
                for (let c = 0; c < simpleCols; c++) {
                    const { x, y } = simpleCellPos(c, r);
                    placements.push({ spread_index: si, x_pt: x, y_pt: y, rotation_deg: 0 });
                    marks.push(...cellTrimMarks(x, y));
                }
            }
            plates.push({ width_pt: frameW, height_pt: frameH, placements, marks, label: `Spread ${si + 1}` });
        }
    }

    // ── Xoay lưới 90° sang khổ thật ──
    // Offset (fold_pattern): giữ tờ kẽm ĐÚNG hướng người dùng đặt (feed vật lý trên máy
    // in) → xoay NỘI DUNG 90° cho vừa. Digital (step_repeat/cut_stack): người dùng muốn
    // kết quả NẰM NGANG, nội dung đứng đọc được → xuất luôn khổ landscape (frameW×frameH),
    // KHÔNG xoay nội dung lại (tờ đã landscape sẵn, spread đặt 100% đứng thẳng).
    if (isRotated && mode === 'fold_pattern') {
        plates = plates.map(pl => rotatePlate90(pl, frameW, spreadW, spreadH));
    }

    return { mode, spread_w_pt: spreadW, spread_h_pt: spreadH, plates };
}

/**
 * Xoay 1 plate 90° CCW từ khung logic (frameW×frameH) sang khổ thật.
 * Map điểm: (x,y) → (frameH_logic? ...). Dùng CCW quanh gốc + tịnh tiến:
 *   real(x,y) = (frameW - y, x); box (w,h) → (h,w); rotation += 90.
 * Lưu ý: frameW ở đây = bề rộng khung LOGIC (= sheetH thật) ⇒ Rw = frameH_logic.
 * Ta truyền frameW(logic) và suy Rw từ chiều cao plate cũ.
 */
function rotatePlate90(plate: Phase2Plate, frameW: number, spreadW: number, spreadH: number): Phase2Plate {
    const Lw = plate.width_pt;   // = frameW (logic)
    const Lh = plate.height_pt;  // = frameH (logic)
    const Rw = Lh;               // khổ thật rộng
    const Rh = Lw;               // khổ thật cao
    void frameW;
    const placements = plate.placements.map(p => {
        const rotIs90 = (p.rotation_deg % 180) !== 0;
        const boxH = rotIs90 ? spreadW : spreadH; // chiều cao box TRƯỚC khi xoay thêm
        return {
            spread_index: p.spread_index,
            x_pt: Rw - p.y_pt - boxH,
            y_pt: p.x_pt,
            rotation_deg: (p.rotation_deg + 90) % 360,
        };
    });
    const marks = plate.marks.map(m => ({
        ...m,
        x1: Rw - m.y1, y1: m.x1,
        x2: Rw - m.y2, y2: m.x2,
    }));
    return { width_pt: Rw, height_pt: Rh, placements, marks, label: plate.label };
}

// ==================== MARKS SERIALIZER ====================
// (dấu xén lấy từ trimBox thực của solvePageTransform — đồng bộ mép cắt)

function serializeBookletMarks(
    context: GeometricContext,
    spreadTrim: { left: number; right: number; bottom: number; top: number },
    markLenPt: number,
    markOffPt: number,
    markThickPt: number,
    markType: string,
): MarkInstruction[] {
    if (!markType || markType === 'none') return [];

    const marks: MarkInstruction[] = [];
    // Toạ độ trim LẤY TRỰC TIẾP từ trimBox thật của solvePageTransform → dấu xén
    // luôn trùng mép cắt thực, đúng cả pull-to-spine/gutter (không còn lệch = bleed).
    const trimX = spreadTrim.left;
    const trimY = spreadTrim.bottom;
    const right = spreadTrim.right;
    const top = spreadTrim.top;
    const black: [number, number, number, number] = [0, 0, 0, 1];
    const red: [number, number, number, number] = [0, 1, 1, 0]; // Magenta+Yellow ≈ Red in CMYK

    const addMark = (type: MarkInstruction['type'], x1: number, y1: number, x2: number, y2: number, color: [number, number, number, number]) => {
        marks.push({ type, x1, y1, x2, y2, color, thickness_pt: markThickPt });
    };

    // Trim marks at 4 corners
    addMark('trim_line', trimX, top + markOffPt, trimX, top + markOffPt + markLenPt, black);
    addMark('trim_line', trimX - markOffPt, top, trimX - markOffPt - markLenPt, top, black);
    addMark('trim_line', right, top + markOffPt, right, top + markOffPt + markLenPt, black);
    addMark('trim_line', right + markOffPt, top, right + markOffPt + markLenPt, top, black);
    addMark('trim_line', trimX, trimY - markOffPt, trimX, trimY - markOffPt - markLenPt, black);
    addMark('trim_line', trimX - markOffPt, trimY, trimX - markOffPt - markLenPt, trimY, black);
    addMark('trim_line', right, trimY - markOffPt, right, trimY - markOffPt - markLenPt, black);
    addMark('trim_line', right + markOffPt, trimY, right + markOffPt + markLenPt, trimY, black);

    // Fold mark at center spine
    const centerX = context.finalSheetWidth / 2;
    addMark('fold_mark', centerX, top + markOffPt, centerX, top + markOffPt + markLenPt, red);
    addMark('fold_mark', centerX, trimY - markOffPt, centerX, trimY - markOffPt - markLenPt, red);

    return marks;
}

// ==================== ROTATION UTILS ====================

function applyGridRotation(sheet: SheetInstruction, cx: number, cy: number) {
    if (sheet.front) applyGridRotationToSide(sheet.front, cx, cy);
    if (sheet.back) applyGridRotationToSide(sheet.back, cx, cy);
}

function applyGridRotationToSide(side: SheetSideInstruction, cx: number, cy: number) {
    const rotX = (x: number, y: number) => cx + (y - cy);
    const rotY = (x: number, y: number) => cy - (x - cx);

    if (side.placements) {
        for (const p of side.placements) {
            if (!p.clip) continue;

            const cellCx = p.x_pt + p.clip.w_pt / 2;
            const cellCy = p.y_pt + p.clip.h_pt / 2;
            
            const newCellCx = cx + (cellCy - cy);
            const newCellCy = cy - (cellCx - cx);
            
            const newW = p.clip.h_pt;
            const newH = p.clip.w_pt;
            
            p.x_pt = newCellCx - newW / 2;
            p.y_pt = newCellCy - newH / 2;
            
            const clipCx = p.clip.x_pt + p.clip.w_pt / 2;
            const clipCy = p.clip.y_pt + p.clip.h_pt / 2;
            const newClipCx = cx + (clipCy - cy);
            const newClipCy = cy - (clipCx - cx);
            
            p.clip.x_pt = newClipCx - newW / 2;
            p.clip.y_pt = newClipCy - newH / 2;
            p.clip.w_pt = newW;
            p.clip.h_pt = newH;
            
            p.rotation_deg = (p.rotation_deg + 270) % 360;
        }
    }

    if (side.marks) {
        for (const m of side.marks) {
            const nx1 = rotX(m.x1, m.y1);
            const ny1 = rotY(m.x1, m.y1);
            const nx2 = rotX(m.x2, m.y2);
            const ny2 = rotY(m.x2, m.y2);
            m.x1 = nx1; m.y1 = ny1;
            m.x2 = nx2; m.y2 = ny2;
        }
    }
}

