import { create } from 'zustand';
import { BoxParams, DEFAULT_PARAMS, DielineModel } from '../lib/dieline/types';
import { generateReverseTuckEnd } from '../lib/dieline/ReverseTuckEnd';
import { generateSnapLockBottom } from '../lib/dieline/SnapLockBottom';
import { generateGableBox } from '../lib/dieline/GableBox';
import { generatePaperBag } from '../lib/dieline/PaperBag';
import { generateCupSleeve } from '../lib/dieline/CupSleeve';
import { generatePizzaBox } from '../lib/dieline/PizzaBox';
import { generateEnvelope } from '../lib/dieline/Envelope';
import { generateMatchboxTray } from '../lib/dieline/MatchboxTray';
import { validateParams } from '../lib/dieline/validateParams';
import { attachWarnings } from '../lib/dieline/attachWarnings';
import { NestingConfig, NestingResult, DEFAULT_NESTING_CONFIG } from '../lib/dieline/nestingTypes';
import { calculateNesting } from '../lib/dieline/nestingEngine';

/** Route sang đúng engine dựa vào boxType (không gắn warnings) */
function dispatchGenerator(params: BoxParams): DielineModel {
    switch (params.boxType) {
        case 'slb':
            return generateSnapLockBottom(params);
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
        case 'rte':
        default:
            return generateReverseTuckEnd(params);
    }
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
function generateDieline(rawParams: BoxParams, changedKey?: keyof BoxParams): DielineModel {
    const { params, warnings } = validateParams(rawParams, changedKey);
    const model = dispatchGenerator(params);
    return attachWarnings(model, warnings);
}

/** Tính nesting từ dieline + config */
function recalcNesting(dieline: DielineModel | null, config: NestingConfig): NestingResult | null {
    if (!dieline) return null;
    return calculateNesting(dieline.boundingBox, config, dieline.params);
}

/** Tính bbox từ subset panels (filter theo prefix) */
function computePartBBox(
    dieline: DielineModel,
    filterFn: (panelName: string) => boolean,
): { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number } | null {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let found = false;
    for (const panel of dieline.panels) {
        if (!filterFn(panel.name)) continue;
        for (const seg of panel.paths) {
            const pts = seg.type === 'bezier' && seg.controlPoints ? seg.controlPoints : seg.points;
            for (const p of pts) {
                if (p.x < minX) minX = p.x;
                if (p.y < minY) minY = p.y;
                if (p.x > maxX) maxX = p.x;
                if (p.y > maxY) maxY = p.y;
                found = true;
            }
        }
    }
    if (!found) return null;
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** Tính nesting cho chế độ split (tray + sleeve riêng) */
function recalcNestingSplit(
    dieline: DielineModel | null,
    config: NestingConfig,
): { tray: NestingResult | null; sleeve: NestingResult | null } {
    if (!dieline || dieline.params.boxType !== 'tray') {
        return { tray: null, sleeve: null };
    }
    const trayBB = computePartBBox(dieline, name => !name.startsWith('sleeve_'));
    const sleeveBB = computePartBBox(dieline, name => name.startsWith('sleeve_'));

    const trayResult = trayBB ? calculateNesting(trayBB, config, dieline.params) : null;
    const sleeveConfig = { ...config, sheet: config.sleeveSheet };
    const sleeveResult = sleeveBB ? calculateNesting(sleeveBB, sleeveConfig, dieline.params) : null;

    return { tray: trayResult, sleeve: sleeveResult };
}

/**
 * Tính nesting cho chế độ combined tray — cùng 1 tờ giấy.
 */
function recalcNestingCombinedTray(
    dieline: DielineModel,
    config: NestingConfig,
): { tray: NestingResult | null; sleeve: NestingResult | null } {
    const trayBB = computePartBBox(dieline, name => !name.startsWith('sleeve_'));
    const sleeveBB = computePartBBox(dieline, name => name.startsWith('sleeve_'));
    if (!trayBB || !sleeveBB) return { tray: null, sleeve: null };

    const gap = config.gutter || config.dieGap;
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
        return { tray: calculateNesting(dieline.boundingBox, config, dieline.params), sleeve: null };
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

    return { tray: trayResult, sleeve: sleeveResult };
}

interface BoxStore {
    params: BoxParams;
    dieline: DielineModel | null;
    foldProgress: number;
    viewMode: '2d' | '3d' | 'split';
    isAnimating: boolean;
    clampVersion: number;
    nestingConfig: NestingConfig;
    nestingResult: NestingResult | null;
    sleeveNestingResult: NestingResult | null;
    mockupTextureUrl: string | null;

    setParam: (key: keyof BoxParams, value: BoxParams[keyof BoxParams]) => void;
    setParams: (updates: Partial<BoxParams>) => void;
    regenerate: () => void;
    setFoldProgress: (value: number) => void;
    setViewMode: (mode: '2d' | '3d' | 'split') => void;
    setIsAnimating: (v: boolean) => void;
    setNestingConfig: (updates: Partial<NestingConfig>) => void;
    setMockupTextureUrl: (url: string | null) => void;
    isStanding: boolean;
    setIsStanding: (v: boolean) => void;
}

const initialDieline = generateDieline({ ...DEFAULT_PARAMS });

export const useBoxStore = create<BoxStore>((set, get) => ({
    params: { ...DEFAULT_PARAMS },
    dieline: initialDieline,
    foldProgress: 1,
    viewMode: 'split',
    isAnimating: false,
    clampVersion: 0,
    nestingConfig: { ...DEFAULT_NESTING_CONFIG },
    nestingResult: recalcNesting(initialDieline, DEFAULT_NESTING_CONFIG),
    sleeveNestingResult: null,
    mockupTextureUrl: null,
    isStanding: !['pizza', 'tray'].includes(DEFAULT_PARAMS.boxType),

    setIsStanding: (v) => set({ isStanding: v }),

    setParam: (key, value) => {
        const prev = get().params;
        const rawParams = { ...prev, [key]: value };
        if (key === 'boxType') {
            if (value === 'paper_bag') {
                rawParams.TH = 30;
            } else if (prev.boxType === 'paper_bag') {
                rawParams.TH = DEFAULT_PARAMS.TH;
            }
            if (value === 'cup_sleeve') {
                rawParams.SLP = DEFAULT_PARAMS.SLP;
                rawParams.lockTab = DEFAULT_PARAMS.lockTab;
                rawParams.LTW = DEFAULT_PARAMS.LTW;
                rawParams.LTH = DEFAULT_PARAMS.LTH;
                rawParams.HH = DEFAULT_PARAMS.HH;
                rawParams.HW = DEFAULT_PARAMS.HW;
                rawParams.HHL = DEFAULT_PARAMS.HHL;
                rawParams.HFH = DEFAULT_PARAMS.HFH;
            } else if (prev.boxType === 'cup_sleeve') {
                rawParams.cupD1 = DEFAULT_PARAMS.cupD1;
                rawParams.cupD2 = DEFAULT_PARAMS.cupD2;
                rawParams.cupH = DEFAULT_PARAMS.cupH;
                rawParams.cupCoverage = DEFAULT_PARAMS.cupCoverage;
            }
            const boxVal = String(value);
            if (boxVal === 'pizza') {
                rawParams.L = 300; rawParams.W = 300; rawParams.D = 40;
                rawParams.T = 1.5; rawParams.C = 1; rawParams.TH = 15;
            } else if (prev.boxType === 'pizza' && boxVal !== 'pizza') {
                rawParams.L = DEFAULT_PARAMS.L; rawParams.W = DEFAULT_PARAMS.W;
                rawParams.D = DEFAULT_PARAMS.D; rawParams.T = DEFAULT_PARAMS.T;
                rawParams.C = DEFAULT_PARAMS.C; rawParams.TH = DEFAULT_PARAMS.TH;
            }
            if (boxVal === 'envelope') {
                rawParams.envW = DEFAULT_PARAMS.envW; rawParams.envH = DEFAULT_PARAMS.envH;
                rawParams.envFH = DEFAULT_PARAMS.envFH; rawParams.envSF = DEFAULT_PARAMS.envSF;
            }
            if (boxVal === 'tray') {
                rawParams.L = 200; rawParams.W = 150; rawParams.D = 40;
                rawParams.T = 1; rawParams.G = 10; rawParams.TH = 15;
                rawParams.sleeveGlue = 15;
            }
        }
        const { params: validParams, wasClamped } = validateParams(rawParams, key);
        // generateDieline tự kiểm tra lại (cùng changedKey) và hợp nhất warnings
        // vào model.warnings — đây là nguồn cảnh báo DUY NHẤT cho UI (Requirement 3.4).
        const dieline = generateDieline(rawParams, key);

        const forceRerender = key === 'boxType';
        const nestingConfig = get().nestingConfig;
        const isTray = validParams.boxType === 'tray';
        const isSplit = isTray && nestingConfig.trayNestingMode === 'split';
        const isCombinedTray = isTray && nestingConfig.trayNestingMode === 'combined';
        const dualResult = isSplit
            ? recalcNestingSplit(dieline, nestingConfig)
            : isCombinedTray
                ? recalcNestingCombinedTray(dieline, nestingConfig)
                : null;

        set({
            params: validParams,
            dieline,
            clampVersion: (wasClamped || forceRerender) ? get().clampVersion + 1 : get().clampVersion,
            nestingResult: dualResult ? dualResult.tray : recalcNesting(dieline, nestingConfig),
            sleeveNestingResult: dualResult ? dualResult.sleeve : null,
            // Định hướng mặc định trong 3D: pizza và khay/diêm NẰM (úp đáy xuống
            // sàn), các loại khác dựng đứng. Chỉ áp khi đổi loại khuôn.
            ...(forceRerender ? { isStanding: !['pizza', 'tray'].includes(validParams.boxType) } : {}),
        });
    },

    setParams: (updates) => {
        const rawParams = { ...get().params, ...updates };
        const { params: validParams } = validateParams(rawParams);
        const dieline = generateDieline(rawParams);

        const nestingConfig = get().nestingConfig;
        const isTray = validParams.boxType === 'tray';
        const isSplit = isTray && nestingConfig.trayNestingMode === 'split';
        const isCombinedTray = isTray && nestingConfig.trayNestingMode === 'combined';
        const dualResult = isSplit
            ? recalcNestingSplit(dieline, nestingConfig)
            : isCombinedTray
                ? recalcNestingCombinedTray(dieline, nestingConfig)
                : null;

        set({
            params: validParams,
            dieline,
            nestingResult: dualResult ? dualResult.tray : recalcNesting(dieline, nestingConfig),
            sleeveNestingResult: dualResult ? dualResult.sleeve : null,
        });
    },

    regenerate: () => {
        const dieline = generateDieline(get().params);
        const nestingConfig = get().nestingConfig;
        const isTray = dieline.params.boxType === 'tray';
        const isSplit = isTray && nestingConfig.trayNestingMode === 'split';
        const isCombinedTray = isTray && nestingConfig.trayNestingMode === 'combined';
        const dualResult = isSplit
            ? recalcNestingSplit(dieline, nestingConfig)
            : isCombinedTray
                ? recalcNestingCombinedTray(dieline, nestingConfig)
                : null;

        set({
            dieline,
            nestingResult: dualResult ? dualResult.tray : recalcNesting(dieline, nestingConfig),
            sleeveNestingResult: dualResult ? dualResult.sleeve : null,
        });
    },

    setFoldProgress: (value) => set({ foldProgress: value }),
    setViewMode: (mode) => set({ viewMode: mode }),
    setIsAnimating: (v) => set({ isAnimating: v }),

    setNestingConfig: (updates) => {
        const config = { ...get().nestingConfig, ...updates };
        const dieline = get().dieline;
        const isTray = dieline?.params.boxType === 'tray';
        const isSplit = isTray && config.trayNestingMode === 'split';
        const isCombinedTray = isTray && config.trayNestingMode === 'combined';
        const dualResult = isSplit
            ? recalcNestingSplit(dieline, config)
            : (isCombinedTray && dieline)
                ? recalcNestingCombinedTray(dieline, config)
                : null;

        set({
            nestingConfig: config,
            nestingResult: dualResult ? dualResult.tray : recalcNesting(dieline, config),
            sleeveNestingResult: dualResult ? dualResult.sleeve : null,
        });
    },

    setMockupTextureUrl: (url) => set({ mockupTextureUrl: url }),
}));
