/**
 * SSOT khổ giấy + phân loại mục đích in.
 * Predefined chỉ series ISO A (A0–A7). Preset custom lưu qua usages[].
 */
import { PREDEFINED_SIZES, DEFAULT_FORMSIZE } from './types';

export { PREDEFINED_SIZES, DEFAULT_FORMSIZE };

export type PaperUsage = 'in_nhanh' | 'offset' | 'diecut' | 'nup';

export interface SavedForm {
    id: string;
    name: string;
    w: number;
    h: number;
    marginTop: number;
    marginBottom: number;
    marginLeft: number;
    marginRight: number;
    marginMode?: 'labels_only' | 'include_marks';
    classification?: 'offset' | 'in_nhanh';
    usages?: PaperUsage[];
    gripperMargin?: number;
}

/**
 * Usages của preset. Ưu tiên `usages` (multi). Form cũ chỉ có `classification`:
 *   offset → ['offset']; còn lại → ['in_nhanh'] (không tự gán diecut/nup).
 */
export function formUsages(f: Pick<SavedForm, 'usages' | 'classification'>): PaperUsage[] {
    if (Array.isArray(f.usages) && f.usages.length > 0) return f.usages;
    return f.classification === 'offset' ? ['offset'] : ['in_nhanh'];
}

/** Context lọc dropdown / heal formsize theo tool đang mở. */
export function paperContextFromTool(
    activeTool: string,
    paperClassification: 'offset' | 'in_nhanh',
): PaperUsage {
    if (activeTool === 'sticker_imposer' || activeTool === 'cnc_imposer') return 'diecut';
    if (activeTool === 'nup') return 'nup';
    return paperClassification;
}

/** Predefined ISO A chỉ hiện ở in_nhanh + nup (không offset/diecut). */
export function showsPredefinedSheets(context: PaperUsage): boolean {
    return context === 'in_nhanh' || context === 'nup';
}

/**
 * Binary classification lưu kèm preset (booklet offset/in_nhanh).
 * Lọc tool diecut/nup dựa usages[], không dựa field này.
 */
export function primaryClassificationFromUsages(usages: PaperUsage[]): 'offset' | 'in_nhanh' {
    return usages.includes('offset') ? 'offset' : 'in_nhanh';
}

/** Usages mặc định khi mở dialog "tạo khổ" theo tool hiện tại. */
export function defaultUsagesForContext(context: PaperUsage): PaperUsage[] {
    return [context];
}

export function isFreeFormsize(formsize: string): boolean {
    return formsize === 'custom' || formsize === 'auto_100';
}

export function isCustomPresetId(formsize: string): boolean {
    return formsize.startsWith('custom_');
}

export function isKnownPredefined(formsize: string): boolean {
    return Boolean(PREDEFINED_SIZES[formsize]);
}

/**
 * Resolve W×H mm từ formsize + savedForms + mirror custom.
 * Không swap offset — caller dùng resolvePressSheetDimsMm.
 */
export function resolveSheetDimsMm(
    formsize: string,
    savedForms: Pick<SavedForm, 'id' | 'w' | 'h'>[],
    customW: number,
    customH: number,
): { w: number; h: number } {
    if (isCustomPresetId(formsize)) {
        const p = savedForms.find(f => f.id === formsize);
        if (p) return { w: p.w, h: p.h };
        return { w: customW, h: customH };
    }
    if (!isFreeFormsize(formsize)) {
        const ps = PREDEFINED_SIZES[formsize];
        if (ps) return { w: ps.w, h: ps.h };
        // Legacy id (SRA3, B, …) đã gỡ → tin mirror hoặc default A3
        if (customW > 0 && customH > 0) return { w: customW, h: customH };
        const d = PREDEFINED_SIZES[DEFAULT_FORMSIZE];
        return { w: d.w, h: d.h };
    }
    return { w: customW, h: customH };
}

/**
 * Chỉ booklet + offset ép ngang (cạnh dài = trục bồng).
 * N-up / bế tem / CNC không swap — chặn rò classification offset.
 */
export function resolvePressSheetDimsMm(
    dims: { w: number; h: number },
    opts: { activeTool: string; paperClassification: 'offset' | 'in_nhanh'; taskMode?: string },
): { w: number; h: number } {
    const isBooklet = opts.activeTool === 'booklet' || opts.taskMode === 'booklet';
    if (isBooklet && opts.paperClassification === 'offset') {
        return { w: Math.max(dims.w, dims.h), h: Math.min(dims.w, dims.h) };
    }
    return dims;
}

/** formsize fallback khi xóa preset / heal sai context. */
export function fallbackFormsizeForContext(
    context: PaperUsage,
    savedForms: Pick<SavedForm, 'id' | 'usages' | 'classification'>[],
): string {
    const match = savedForms.find(f => formUsages(f).includes(context));
    if (match) return match.id;
    if (showsPredefinedSheets(context)) return DEFAULT_FORMSIZE;
    return 'custom';
}
