import type { ImposerSlice } from '../sliceType';
import type { ShuffleSettings } from '../../../preprocess-tools/ShuffleTool';
import type { PageResizerSettings } from '../../../preprocess-tools/pageResizerViewLogic';
import type { SplitSettings } from '../../../preprocess-tools/SplitTool';
import type { TrimShiftSettings } from '../../../preprocess-tools/TrimShiftTool';

/** Mặc định co giãn trang — dùng khi init + merge persist. */
export const DEFAULT_RESIZE_SETTINGS = {
    sizePresetId: 'A4',
    targetW: 210,
    targetH: 297,
    pageSizeMode: 'fixed' as const,
    scaleMode: 'fit' as const,
    applyTo: 'all' as const,
    applyToStr: 'all',
    resizeMode: 'auto',
    // targetDpi: undefined = tự động giảm mẫu khi thu nhỏ
    // RESIZE (audit 2026-07-31 §B.2): state hiển thị và state thực thi phải trùng.
    autoTrimBefore: false,
    // RESIZE (audit 2026-08-03 §TR.4): mặc định giữ toàn bộ khổ trang có alpha.
    resizeByContent: false,
    bgFillMode: 'mirror' as const,
    bgFillColor: '#ffffff',
};

export interface PreprocSlice {
    shuffleSettings: ShuffleSettings;
    setShuffleSettings: (v: ShuffleSettings) => void;
    resizeSettings: PageResizerSettings;
    setResizeSettings: (v: PageResizerSettings) => void;
    splitSettings: SplitSettings;
    setSplitSettings: (v: SplitSettings) => void;
    trimShiftSettings: TrimShiftSettings;
    setTrimShiftSettings: (v: TrimShiftSettings) => void;
}

/** Lưu thiết lập preprocess qua localStorage (lần chạy sau nhớ lại). */
export const PREPROC_PERSIST_KEYS = ['resizeSettings'] as const;

export const createPreprocSlice: ImposerSlice<PreprocSlice> = (set) => ({
    shuffleSettings: { presetId: 'custom', rule: '', groupSize: 1, mode: 'normal' },
    setShuffleSettings: (v) => set({ shuffleSettings: v }),
    resizeSettings: { ...DEFAULT_RESIZE_SETTINGS },
    setResizeSettings: (v) => set({ resizeSettings: v }),
    splitSettings: { mode: 'by_range', ranges: '', pagesPerFile: 1, pageListStr: '' },
    setSplitSettings: (v) => set({ splitSettings: v }),
    trimShiftSettings: {
        unit: 'mm', sameAllEdges: false,
        trimTop: 0, trimBottom: 0, trimLeft: 0, trimRight: 0,
        shiftX: 0, shiftY: 0,
        bindingEnabled: false, bindingMm: 0, bindingInward: true,
        creepEnabled: false, creepMm: 0, creepAxis: 'x',
        mirrorFill: false,
        contentMode: 'original', keepBleed: false,
        applyToStr: 'all',
        split: {
            enabled: false,
            axis: 'vertical',
            count: 2,
            pieces: [
                { top: 0, bottom: 0, left: 0, right: 0 },
                { top: 0, bottom: 0, left: 0, right: 0 },
                { top: 0, bottom: 0, left: 0, right: 0 },
            ],
        },
    },
    setTrimShiftSettings: (v) => set({ trimShiftSettings: v }),
});
