import type { ImposerSlice } from '../sliceType';
import type { ReportDisplayConfig } from '../../types';
import { DEFAULT_REPORT_CONFIG } from '../../types';

export interface ReportSlice {
    exportUniqueSheets: boolean;
    setExportUniqueSheets: (v: boolean) => void;
    reportDisplay: ReportDisplayConfig;
    setReportDisplay: (v: ReportDisplayConfig | ((prev: ReportDisplayConfig) => ReportDisplayConfig)) => void;
    customMaterials: string[];
    setCustomMaterials: (v: string[]) => void;
    reportMaterial: string;
    setReportMaterial: (v: string) => void;
    reportLamination: number;
    setReportLamination: (v: number) => void;
    reportLaminationSides: number;
    setReportLaminationSides: (v: number) => void;
    reportOrderCode: string;
    setReportOrderCode: (v: string) => void;
    saveByReport: boolean;
    setSaveByReport: (v: boolean) => void;
}

export const REPORT_PERSIST_KEYS = [
    'exportUniqueSheets', 'reportDisplay', 'customMaterials', 'reportMaterial',
    'reportLamination', 'reportLaminationSides', 'saveByReport',
] as const;

export const createReportSlice: ImposerSlice<ReportSlice> = (set) => ({
    exportUniqueSheets: true,
    setExportUniqueSheets: (v) => set({ exportUniqueSheets: v }),
    reportDisplay: DEFAULT_REPORT_CONFIG,
    setReportDisplay: (v) => set((state) => ({
        reportDisplay: typeof v === 'function' ? v(state.reportDisplay) : v,
    })),
    customMaterials: [],
    setCustomMaterials: (v) => set({ customMaterials: v }),
    reportMaterial: '',
    setReportMaterial: (v) => set({ reportMaterial: v }),
    reportLamination: 0,
    setReportLamination: (v) => set({ reportLamination: v }),
    reportLaminationSides: 1,
    setReportLaminationSides: (v) => set({ reportLaminationSides: v }),
    reportOrderCode: '',
    setReportOrderCode: (v) => set({ reportOrderCode: v }),
    saveByReport: false,
    setSaveByReport: (v) => set({ saveByReport: v }),
});
