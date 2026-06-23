import type { ImposerSlice } from '../sliceType';

export interface UiSlice {
    showSettings: boolean;
    setShowSettings: (v: boolean) => void;
    showMarksModal: boolean;
    setShowMarksModal: (v: boolean) => void;
    showPontModal: boolean;
    setShowPontModal: (v: boolean) => void;
    isPresetOpen: boolean;
    setIsPresetOpen: (v: boolean) => void;
    showFlipbook: boolean;
    setShowFlipbook: (v: boolean) => void;
    showSheetViewer: boolean;
    setShowSheetViewer: (v: boolean) => void;
}

export const createUiSlice: ImposerSlice<UiSlice> = (set) => ({
    showSettings: false,
    setShowSettings: (v) => set({ showSettings: v }),
    showMarksModal: false,
    setShowMarksModal: (v) => set({ showMarksModal: v }),
    showPontModal: false,
    setShowPontModal: (v) => set({ showPontModal: v }),
    isPresetOpen: false,
    setIsPresetOpen: (v) => set({ isPresetOpen: v }),
    showFlipbook: false,
    setShowFlipbook: (v) => set({ showFlipbook: v }),
    showSheetViewer: false,
    setShowSheetViewer: (v) => set({ showSheetViewer: v }),
});
