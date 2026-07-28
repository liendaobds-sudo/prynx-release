import { BoxParams, DielineModel } from './types';
import { generateReverseTuckEnd } from './ReverseTuckEnd';
import { generateSnapLockBottom } from './SnapLockBottom';
import { generateAutoBottomBox } from './AutoBottomBox';
import { generateGableBox } from './GableBox';
import { generatePaperBag } from './PaperBag';
import { generateCupSleeve } from './CupSleeve';
import { generatePizzaBox } from './PizzaBox';
import { generateEnvelope } from './Envelope';
import { generateMatchboxTray } from './MatchboxTray';
import { generateDoubleTray, splitDoubleTrayDieline } from './DoubleTray';
// [HANGING-WINDOW 2026-07-27] Hộp treo có cửa sổ — dùng chung hợp đồng hình học RTE
import { generateHangingWindowBox } from './HangingWindowBox';
import { validateParams } from './validateParams';
import { attachWarnings } from './attachWarnings';
import { NestingConfig, NestingResult } from './nestingTypes';
import { calculateNesting, computeDieOutline } from './nestingEngine';
import { validatePlacementPositions } from './nestingCollision';
import { assertEngineRequest, normalizeNestingConfig } from './runtimeValidation';
import { splitTrayDieline } from './trayParts';

/** Route sang đúng engine dựa vào boxType (không gắn warnings) */
function dispatchGenerator(params: BoxParams): DielineModel {
    switch (params.boxType) {
        case 'slb':
            return generateSnapLockBottom(params);
        case 'auto_bottom':
            return generateAutoBottomBox(params);
        case 'gable':
            return generateGableBox(params);
        case 'paper_bag':
            return generatePaperBag(params);
        case 'cup_sleeve':
            return generateCupSleeve(params);
        case 'pizza':
            return generatePizzaBox(params);
        case 'envelope':
            return generateEnvelope(params);
        case 'tray':
            return generateMatchboxTray(params);
        case 'double_tray':
            return generateDoubleTray(params);
        // [HANGING-WINDOW 2026-07-27] Định tuyến loại hộp treo có cửa sổ
        case 'hanging_window':
            return generateHangingWindowBox(params);
        case 'rte':
        default:
            return generateReverseTuckEnd(params);
    }
}

/** Các loại hộp 2 mảnh dùng chung hạ tầng nesting khay/vỏ (tray/sleeve).
 *  [DOUBLE-TRAY 2026-07-26] Tổng quát hóa gate cũ (hard-code 'tray'):
 *  double_tray dùng khe tray = mảnh ĐÁY, khe sleeve = mảnh NẮP. */
function isTwoPieceBoxType(boxType: BoxParams['boxType']): boolean {
    return boxType === 'tray' || boxType === 'double_tray';
}

/** Tách model 2 mảnh theo loại hộp: khay+vỏ (tray) hoặc đáy+nắp (double_tray). */
function splitTwoPieceDieline(dieline: DielineModel) {
    return dieline.params.boxType === 'double_tray'
        ? splitDoubleTrayDieline(dieline)
        : splitTrayDieline(dieline);
}

/**
 * Lớp dispatch sinh dieline: kiểm tra params, sinh mô hình, rồi hợp nhất
 * mọi cảnh báo (từ validateParams + snap-lock khi sinh) vào `model.warnings`.
 *
 * - Nếu `validateParams` ném lỗi → lan truyền lỗi cho phía gọi, KHÔNG tạo
 *   model với `warnings` thiếu/sai (Requirement 3.7).
 * - Sau khi chạy, `model.warnings` luôn là một mảng (rỗng nếu không có cảnh báo).
 *
 * _Requirements: 3.1, 3.2, 3.3, 3.5, 3.7_
 */
export function generateDieline(rawParams: BoxParams, changedKey?: keyof BoxParams): DielineModel {
    const { params, warnings } = validateParams(rawParams, changedKey);
    const model = dispatchGenerator(params);
    return attachWarnings(model, warnings);
}

/** Tính nesting từ dieline + config */
function recalcNesting(dieline: DielineModel | null, config: NestingConfig): NestingResult | null {
    if (!dieline) return null;
    return calculateNesting(dieline.boundingBox, config, dieline.params, dieline);
}

/** Tính nesting cho chế độ split (tray + sleeve riêng) */
function recalcNestingSplit(
    dieline: DielineModel | null,
    config: NestingConfig,
): { tray: NestingResult | null; sleeve: NestingResult | null } {
    if (!dieline || !isTwoPieceBoxType(dieline.params.boxType)) {
        return { tray: null, sleeve: null };
    }
    const parts = splitTwoPieceDieline(dieline);
    if (!parts) return { tray: null, sleeve: null };
    const trayModel = parts.tray;
    const sleeveModel = parts.sleeve;

    const trayResult = calculateNesting(trayModel.boundingBox, config, dieline.params, trayModel);
    const sleeveConfig = { ...config, sheet: config.sleeveSheet };
    const sleeveResult = calculateNesting(sleeveModel.boundingBox, sleeveConfig, dieline.params, sleeveModel);

    return { tray: trayResult, sleeve: sleeveResult };
}

/**
 * Tính nesting cho chế độ combined tray — cùng 1 tờ giấy.
 */
function recalcNestingCombinedTray(
    dieline: DielineModel,
    config: NestingConfig,
): { tray: NestingResult | null; sleeve: NestingResult | null } {
    const parts = splitTwoPieceDieline(dieline);
    if (!parts) return { tray: null, sleeve: null };
    const trayModel = parts.tray;
    const sleeveModel = parts.sleeve;
    const trayBB = trayModel.boundingBox;
    const sleeveBB = sleeveModel.boundingBox;

    const gap = Math.max(config.gutter, config.dieGap);
    const rawW = config.sheet.width;
    const rawH = config.sheet.height;
    const sheets: Array<{ w: number; h: number }> = [];
    if (config.sheetOrientation === 'portrait') {
        sheets.push({ w: Math.min(rawW, rawH), h: Math.max(rawW, rawH) });
    } else if (config.sheetOrientation === 'landscape') {
        sheets.push({ w: Math.max(rawW, rawH), h: Math.min(rawW, rawH) });
    } else {
        sheets.push({ w: rawW, h: rawH });
        if (rawW !== rawH) sheets.push({ w: rawH, h: rawW });
    }

    const rots = config.rotation === 'none' ? [0] : config.rotation === '90' ? [90] : [0, 90];

    interface Candidate {
        sheetW: number; sheetH: number;
        trayW: number; trayH: number; trayRot: number;
        trayCols: number; trayRows: number;
        sleeveW: number; sleeveH: number; sleeveRot: number;
        sleeveCols: number; sleeveRows: number;
        sleeveOffX: number; sleeveOffY: number;
        total: number;
    }
    let best: Candidate | null = null;

    for (const { w: sheetW, h: sheetH } of sheets) {
        const effBottom = Math.max(config.margin.bottom, config.gripperMargin);
        const areaW = sheetW - config.margin.left - config.margin.right;
        const areaH = sheetH - config.margin.top - effBottom;
        if (areaW <= 0 || areaH <= 0) continue;

        for (const tRot of rots) {
            const tw = tRot === 90 ? trayBB.height : trayBB.width;
            const th = tRot === 90 ? trayBB.width : trayBB.height;
            if (tw > areaW || th > areaH) continue;

            for (const sRot of rots) {
                const sw = sRot === 90 ? sleeveBB.height : sleeveBB.width;
                const sh = sRot === 90 ? sleeveBB.width : sleeveBB.height;
                if (sw > areaW || sh > areaH) continue;

                // Strategy A: Horizontal split
                const tRowsA = Math.floor((areaH + gap) / (th + gap));
                const sRowsA = Math.floor((areaH + gap) / (sh + gap));
                for (let tc = 1; tc * (tw + gap) - gap <= areaW; tc++) {
                    const usedW = tc * (tw + gap) - gap;
                    const remain = areaW - usedW - gap;
                    if (remain <= 0) continue;
                    const sc = Math.floor((remain + gap) / (sw + gap));
                    if (sc === 0) continue;
                    const total = tc * tRowsA + sc * sRowsA;
                    if (total > (best?.total ?? 0)) {
                        best = {
                            sheetW, sheetH,
                            trayW: tw, trayH: th, trayRot: tRot,
                            trayCols: tc, trayRows: tRowsA,
                            sleeveW: sw, sleeveH: sh, sleeveRot: sRot,
                            sleeveCols: sc, sleeveRows: sRowsA,
                            sleeveOffX: usedW + gap, sleeveOffY: 0,
                            total,
                        };
                    }
                }

                // Strategy B: Vertical split
                const tColsB = Math.floor((areaW + gap) / (tw + gap));
                const sColsB = Math.floor((areaW + gap) / (sw + gap));
                for (let tr = 1; tr * (th + gap) - gap <= areaH; tr++) {
                    const usedH = tr * (th + gap) - gap;
                    const remain = areaH - usedH - gap;
                    if (remain <= 0) continue;
                    const sr = Math.floor((remain + gap) / (sh + gap));
                    if (sr === 0) continue;
                    const total = tColsB * tr + sColsB * sr;
                    if (total > (best?.total ?? 0)) {
                        best = {
                            sheetW, sheetH,
                            trayW: tw, trayH: th, trayRot: tRot,
                            trayCols: tColsB, trayRows: tr,
                            sleeveW: sw, sleeveH: sh, sleeveRot: sRot,
                            sleeveCols: sColsB, sleeveRows: sr,
                            sleeveOffX: 0, sleeveOffY: usedH + gap,
                            total,
                        };
                    }
                }
            }
        }
    }

    if (!best) {
        return { tray: calculateNesting(dieline.boundingBox, config, dieline.params, dieline), sleeve: null };
    }

    const effBottom2 = Math.max(config.margin.bottom, config.gripperMargin);
    const areaW2 = best.sheetW - config.margin.left - config.margin.right;
    const areaH2 = best.sheetH - config.margin.top - effBottom2;

    const trayBlockW = best.trayCols * (best.trayW + gap) - gap;
    const trayBlockH = best.trayRows * (best.trayH + gap) - gap;
    const sleeveBlockW = best.sleeveCols * (best.sleeveW + gap) - gap;
    const sleeveBlockH = best.sleeveRows * (best.sleeveH + gap) - gap;

    let totalUsedW: number;
    let totalUsedH: number;
    if (best.sleeveOffX > 0) {
        totalUsedW = trayBlockW + gap + sleeveBlockW;
        totalUsedH = Math.max(trayBlockH, sleeveBlockH);
    } else {
        totalUsedW = Math.max(trayBlockW, sleeveBlockW);
        totalUsedH = trayBlockH + gap + sleeveBlockH;
    }

    const centerOffX = config.margin.left + (areaW2 - totalUsedW) / 2;
    const centerOffY = config.margin.top + (areaH2 - totalUsedH) / 2;

    const trayPositions: Array<{ x: number; y: number; rotation: number }> = [];
    for (let r = 0; r < best.trayRows; r++) {
        for (let c = 0; c < best.trayCols; c++) {
            trayPositions.push({
                x: centerOffX + c * (best.trayW + gap),
                y: centerOffY + r * (best.trayH + gap),
                rotation: best.trayRot,
            });
        }
    }

    const sleevePositions: Array<{ x: number; y: number; rotation: number }> = [];
    for (let r = 0; r < best.sleeveRows; r++) {
        for (let c = 0; c < best.sleeveCols; c++) {
            sleevePositions.push({
                x: centerOffX + best.sleeveOffX + c * (best.sleeveW + gap),
                y: centerOffY + best.sleeveOffY + r * (best.sleeveH + gap),
                rotation: best.sleeveRot,
            });
        }
    }

    const sheetArea = best.sheetW * best.sheetH;
    const trayArea = trayBB.width * trayBB.height * trayPositions.length;
    const sleeveArea = sleeveBB.width * sleeveBB.height * sleevePositions.length;

    const effBottom = Math.max(config.margin.bottom, config.gripperMargin);
    const areaW = best.sheetW - config.margin.left - config.margin.right;
    const areaH = best.sheetH - config.margin.top - effBottom;

    const trayResult: NestingResult = {
        positions: trayPositions,
        countPerSheet: trayPositions.length,
        rows: best.trayRows,
        cols: best.trayCols,
        utilization: Math.round(trayArea / sheetArea * 100),
        usableArea: { width: areaW, height: areaH },
        actualSheet: { width: best.sheetW, height: best.sheetH },
        cellSize: { width: best.trayW + gap, height: best.trayH + gap },
        label: `Khay ${best.trayRot}° ${best.trayCols}×${best.trayRows}`,
        superTile: null,
    };

    const sleeveResult: NestingResult = {
        positions: sleevePositions,
        countPerSheet: sleevePositions.length,
        rows: best.sleeveRows,
        cols: best.sleeveCols,
        utilization: Math.round(sleeveArea / sheetArea * 100),
        usableArea: { width: areaW, height: areaH },
        actualSheet: { width: best.sheetW, height: best.sheetH },
        cellSize: { width: best.sleeveW + gap, height: best.sleeveH + gap },
        label: `Vỏ ${best.sleeveRot}° ${best.sleeveCols}×${best.sleeveRows}`,
        superTile: null,
    };

    const printable = {
        left: config.margin.left,
        top: config.margin.top,
        right: best.sheetW - config.margin.right,
        bottom: best.sheetH - Math.max(config.margin.bottom, config.gripperMargin),
    };
    const checkedTray = validatePlacementPositions(
        trayResult.positions,
        computeDieOutline(trayModel, trayModel.boundingBox),
        config.dieGap,
        printable,
    );
    const checkedSleeve = validatePlacementPositions(
        sleeveResult.positions,
        computeDieOutline(sleeveModel, sleeveModel.boundingBox),
        config.dieGap,
        printable,
    );
    trayResult.positions = checkedTray.positions;
    trayResult.countPerSheet = checkedTray.positions.length;
    sleeveResult.positions = checkedSleeve.positions;
    sleeveResult.countPerSheet = checkedSleeve.positions.length;
    return { tray: trayResult, sleeve: sleeveResult };

}

export interface DielineEngineRequest {
    params: BoxParams;
    nestingConfig: NestingConfig;
    changedKey?: keyof BoxParams;
    includeNesting?: boolean;
}

export interface DielineEngineResponse {
    params: BoxParams;
    dieline: DielineModel;
    nestingResult: NestingResult | null;
    sleeveNestingResult: NestingResult | null;
    wasClamped: boolean;
}

/** Pure entry point bundled into the native sidecar. */
export function runDielineEngine(request: DielineEngineRequest): DielineEngineResponse {
    assertEngineRequest(request);
    const { params, wasClamped } = validateParams(request.params, request.changedKey);
    const dieline = generateDieline(request.params, request.changedKey);
    if (request.includeNesting === false) {
        return {
            params,
            dieline,
            nestingResult: null,
            sleeveNestingResult: null,
            wasClamped,
        };
    }

    const config = normalizeNestingConfig(request.nestingConfig);
    const isTwoPiece = isTwoPieceBoxType(params.boxType);
    const dualResult = isTwoPiece && config.trayNestingMode === 'split'
        ? recalcNestingSplit(dieline, config)
        : isTwoPiece && config.trayNestingMode === 'combined'
            ? recalcNestingCombinedTray(dieline, config)
            : null;

    return {
        params,
        dieline,
        nestingResult: dualResult ? dualResult.tray : recalcNesting(dieline, config),
        sleeveNestingResult: dualResult ? dualResult.sleeve : null,
        wasClamped,
    };
}