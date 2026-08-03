import { BoxParams, DEFAULT_PARAMS } from './types';
import { NestingConfig } from './nestingTypes';

const MAX_DIMENSION_MM = 10_000;
const MAX_SHEET_MM = 5_000;
const MAX_MARGIN_MM = 500;
const MAX_GAP_MM = 100;

const ENUM_VALUES: Partial<Record<keyof BoxParams, readonly string[]>> = {
    glueSide: ['left', 'right'],
    // [HANGING-WINDOW 2026-07-27] Mở enum cho hộp treo có cửa sổ.
    // Công tắc `hgbWindow` không cần khai ở đây: vòng lặp assertBoxParams suy
    // kiểu theo DEFAULT_PARAMS, nên mọi khoá có mặc định boolean (gồm
    // `hgbWindow`) đều bị bắt buộc là boolean.
    boxType: ['rte', 'slb', 'auto_bottom', 'gable', 'paper_bag', 'cup_sleeve', 'pizza', 'envelope', 'tray', 'double_tray', 'hanging_window', 'flip_top_tuck'],
    panelOrder: ['WLWL', 'LWLW'],
    handleShape: ['oval', 'roundRect'],
    handleY: ['bottom', 'center'],
    gableStyle: ['flat', 'pitched'],
    cupHeightType: ['slant', 'vertical'],
    cupFlapPosition: ['right', 'left', 'none'],
    envFlapShape: ['straight', 'pointed', 'rounded'],
    envStyle: ['wallet', 'pocket'],
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} phải là một object.`);
    }
    return value as Record<string, unknown>;
}

function finiteInRange(value: unknown, label: string, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        throw new Error(`${label} phải là số hữu hạn trong khoảng ${min}–${max}.`);
    }
    return value;
}

/** Strict boundary validation used before any generator/nesting loop runs. */
export function assertBoxParams(value: unknown): asserts value is BoxParams {
    const input = requireRecord(value, 'params');
    for (const [key, defaultValue] of Object.entries(DEFAULT_PARAMS)) {
        if (!(key in input)) throw new Error(`Thiếu params.${key}.`);
        const actual = input[key];
        if (typeof defaultValue === 'number') {
            finiteInRange(actual, `params.${key}`, 0, MAX_DIMENSION_MM);
        } else if (typeof defaultValue === 'boolean') {
            if (typeof actual !== 'boolean') throw new Error(`params.${key} phải là boolean.`);
        } else {
            const allowed = ENUM_VALUES[key as keyof BoxParams];
            if (!allowed?.includes(actual as string)) throw new Error(`params.${key} không hợp lệ.`);
        }
    }
}

export function normalizeNestingConfig(value: unknown): NestingConfig {
    const input = requireRecord(value, 'nestingConfig');
    const sheet = requireRecord(input.sheet, 'nestingConfig.sheet');
    const margin = requireRecord(input.margin, 'nestingConfig.margin');
    const sleeveSheet = requireRecord(input.sleeveSheet, 'nestingConfig.sleeveSheet');
    const enumValue = <T extends string>(raw: unknown, label: string, allowed: readonly T[]): T => {
        if (!allowed.includes(raw as T)) throw new Error(`${label} không hợp lệ.`);
        return raw as T;
    };

    return {
        sheet: {
            width: finiteInRange(sheet.width, 'sheet.width', 50, MAX_SHEET_MM),
            height: finiteInRange(sheet.height, 'sheet.height', 50, MAX_SHEET_MM),
        },
        margin: {
            top: finiteInRange(margin.top, 'margin.top', 0, MAX_MARGIN_MM),
            right: finiteInRange(margin.right, 'margin.right', 0, MAX_MARGIN_MM),
            bottom: finiteInRange(margin.bottom, 'margin.bottom', 0, MAX_MARGIN_MM),
            left: finiteInRange(margin.left, 'margin.left', 0, MAX_MARGIN_MM),
        },
        gripperMargin: finiteInRange(input.gripperMargin, 'gripperMargin', 0, MAX_MARGIN_MM),
        dieGap: finiteInRange(input.dieGap, 'dieGap', 0, MAX_GAP_MM),
        gutter: finiteInRange(input.gutter, 'gutter', 0, MAX_GAP_MM),
        rotation: enumValue(input.rotation, 'rotation', ['none', '90', 'auto']),
        sheetOrientation: enumValue(input.sheetOrientation, 'sheetOrientation', ['auto', 'portrait', 'landscape']),
        nestingMode: enumValue(input.nestingMode, 'nestingMode', ['grid', 'smart']),
        trayNestingMode: enumValue(input.trayNestingMode, 'trayNestingMode', ['combined', 'split']),
        sleeveSheet: {
            width: finiteInRange(sleeveSheet.width, 'sleeveSheet.width', 50, MAX_SHEET_MM),
            height: finiteInRange(sleeveSheet.height, 'sleeveSheet.height', 50, MAX_SHEET_MM),
        },
    };
}

export function normalizeNestingUpdates(
    current: NestingConfig,
    updates: Partial<NestingConfig>,
): NestingConfig {
    return normalizeNestingConfig({
        ...current,
        ...updates,
        sheet: { ...current.sheet, ...(updates.sheet || {}) },
        margin: { ...current.margin, ...(updates.margin || {}) },
        sleeveSheet: { ...current.sleeveSheet, ...(updates.sleeveSheet || {}) },
    });
}

export function assertEngineRequest(value: unknown): asserts value is {
    params: BoxParams;
    nestingConfig: NestingConfig;
    changedKey?: keyof BoxParams;
    includeNesting?: boolean;
} {
    const input = requireRecord(value, 'request');
    assertBoxParams(input.params);
    normalizeNestingConfig(input.nestingConfig);
    if (input.changedKey !== undefined && !(input.changedKey as string in DEFAULT_PARAMS)) {
        throw new Error('changedKey không hợp lệ.');
    }
    if (input.includeNesting !== undefined && typeof input.includeNesting !== 'boolean') {
        throw new Error('includeNesting phải là boolean.');
    }
}

export const DIELINE_LIMITS = {
    maxDimensionMm: MAX_DIMENSION_MM,
    maxSheetMm: MAX_SHEET_MM,
    maxMarginMm: MAX_MARGIN_MM,
    maxGapMm: MAX_GAP_MM,
    maxPlacements: 20_000,
} as const;
