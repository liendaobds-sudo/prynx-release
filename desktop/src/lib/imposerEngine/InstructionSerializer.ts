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

const MM_TO_POINTS = 2.83465;

// ==================== OUTPUT TYPES ====================

export interface PlacementInstruction {
    /** 0-based source page index from original PDF, or null for blank */
    source_page: number | null;
    x_pt: number;
    y_pt: number;
    rotation_deg: number;
    scale: number;
    creep_offset_pt: number;
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

    const sheets: SheetInstruction[] = [];

    for (let surfIdx = 0; surfIdx < surfaces.length; surfIdx += 2) {
        const frontSurf = surfaces[surfIdx];
        const backSurf = surfaces[surfIdx + 1];

        const frontPlacements: PlacementInstruction[] = [];
        const backPlacements: PlacementInstruction[] = [];

        // Process front side
        if (frontSurf) {
            for (const pos of ['left', 'right']) {
                const isLeft = pos === 'left';
                const slot = isLeft ? frontSurf.slots.left : frontSurf.slots.right;
                const effSheetIndex = frontSurf.sheet.sigLocalIndex ?? frontSurf.sheetIndex;
                const effTotalSheets = frontSurf.sheet.sigTotalSheets ?? virtualMap.length;

                const transform = solvePageTransform(
                    context, isLeft, true, effSheetIndex, effTotalSheets,
                    bleedPt, paperThicknessPt, isSaddleOrThread
                );

                const srcIndex = slot.srcIndex;
                const srcDetail = srcIndex !== null && srcIndex < srcPageDetails.length
                    ? srcPageDetails[srcIndex] : null;

                frontPlacements.push({
                    source_page: srcIndex,
                    x_pt: transform.rawX,
                    y_pt: transform.rawY,
                    rotation_deg: 0,
                    scale: transform.scale,
                    creep_offset_pt: paperThicknessPt * ((effTotalSheets - 1) / 2 - effSheetIndex),
                    clip: {
                        x_pt: transform.clipX,
                        y_pt: transform.clipY,
                        w_pt: transform.clipW,
                        h_pt: transform.clipH,
                    },
                    native_angle: srcDetail?.angle ?? 0,
                });
            }
        }

        // Process back side
        if (backSurf && !(backSurf as any).isEmpty) {
            for (const pos of ['left', 'right']) {
                const isLeft = pos === 'left';
                const slot = isLeft ? backSurf.slots.left : backSurf.slots.right;
                const effSheetIndex = backSurf.sheet.sigLocalIndex ?? backSurf.sheetIndex;
                const effTotalSheets = backSurf.sheet.sigTotalSheets ?? virtualMap.length;

                const transform = solvePageTransform(
                    context, isLeft, false, effSheetIndex, effTotalSheets,
                    bleedPt, paperThicknessPt, isSaddleOrThread
                );

                const srcIndex = slot.srcIndex;
                const srcDetail = srcIndex !== null && srcIndex < srcPageDetails.length
                    ? srcPageDetails[srcIndex] : null;

                backPlacements.push({
                    source_page: srcIndex,
                    x_pt: transform.rawX,
                    y_pt: transform.rawY,
                    rotation_deg: (interleaveMode === 'reverse_backs_180') ? 180 : 0,
                    scale: transform.scale,
                    creep_offset_pt: paperThicknessPt * ((effTotalSheets - 1) / 2 - effSheetIndex),
                    clip: {
                        x_pt: transform.clipX,
                        y_pt: transform.clipY,
                        w_pt: transform.clipW,
                        h_pt: transform.clipH,
                    },
                    native_angle: srcDetail?.angle ?? 0,
                });
            }
        }

        // Generate trim + fold marks
        const frontMarks = serializeBookletMarks(
            context, bleedPt, markLenPt, markOffPt, markThickPt, markType
        );
        const backMarks = serializeBookletMarks(
            context, bleedPt, markLenPt, markOffPt, markThickPt, markType
        );

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
    };
}

// ==================== MARKS SERIALIZER ====================

function serializeBookletMarks(
    context: GeometricContext,
    bleedPt: number,
    markLenPt: number,
    markOffPt: number,
    markThickPt: number,
    markType: string,
): MarkInstruction[] {
    if (!markType || markType === 'none') return [];

    const marks: MarkInstruction[] = [];
    const trimW = context.actualDrawnWidth - 2 * bleedPt;
    const trimH = context.actualDrawnHeight - 2 * bleedPt;
    const marginX = (context.finalSheetWidth - context.actualDrawnWidth * 2) / 2;
    const marginY = (context.finalSheetHeight - context.actualDrawnHeight) / 2;

    // Spread trim box
    const trimX = marginX + bleedPt;
    const trimY = marginY + bleedPt;
    const spreadTrimW = trimW * 2;
    const spreadTrimH = trimH;
    const right = trimX + spreadTrimW;
    const top = trimY + spreadTrimH;
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

