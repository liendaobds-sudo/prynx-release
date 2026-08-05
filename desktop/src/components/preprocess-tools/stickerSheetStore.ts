import { create } from 'zustand';

import {
    analyzeStickerSheet,
    closeStickerSheetSession,
    exportStickerSheet,
    type StickerSheetExportPayload,
    type StickerSheetManifest,
    type StickerSheetModel,
} from '../../lib/stickerSheetApi';


export type StickerSourceMode = 'existing' | 'ai-sheet';
export type StickerMaskTool = 'erase' | 'restore' | 'merge';

export interface NormalizedMaskPoint {
    x: number;
    y: number;
}

export interface StickerMaskStroke {
    kind: 'stroke';
    id: string;
    tool: 'erase' | 'restore';
    instanceId: number;
    radius: number;
    points: NormalizedMaskPoint[];
}

export interface StickerMergeEdit {
    kind: 'merge';
    id: string;
    sourceId: number;
    targetId: number;
}

export type StickerSheetEdit = StickerMaskStroke | StickerMergeEdit;

export interface StickerSheetTabState {
    mode: StickerSourceMode;
    status: 'idle' | 'analyzing' | 'ready' | 'error';
    isExporting: boolean;
    sourceFile: File | null;
    manifest: StickerSheetManifest | null;
    previewUrl: string;
    labelsUrl: string;
    uncertaintyUrl: string;
    selectedInstanceId: number | null;
    activeTool: StickerMaskTool;
    brushRadius: number;
    edits: StickerSheetEdit[];
    redoEdits: StickerSheetEdit[];
    model: StickerSheetModel;
    alphaThreshold: number;
    outputDpi: number;
    outputDpiY: number;
    offsetMm: number;
    bleedMm: number;
    error: string;
}

interface StickerSheetStore {
    tabs: Record<string, StickerSheetTabState>;
    initTab: (tabId: string) => void;
    getTab: (tabId: string) => StickerSheetTabState;
    setMode: (tabId: string, mode: StickerSourceMode) => void;
    setActiveTool: (tabId: string, tool: StickerMaskTool) => void;
    setBrushRadius: (tabId: string, radius: number) => void;
    setSelectedInstance: (tabId: string, instanceId: number | null) => void;
    setOutputSettings: (
        tabId: string,
        settings: Partial<Pick<StickerSheetTabState, 'outputDpi' | 'outputDpiY' | 'offsetMm' | 'bleedMm'>>,
    ) => void;
    analyze: (tabId: string, file: File) => Promise<void>;
    exportFile: (tabId: string, outputFormat?: 'pdf' | 'png_zip') => Promise<StickerSheetExportPayload | null>;
    addStroke: (tabId: string, stroke: Omit<StickerMaskStroke, 'kind' | 'id'>) => void;
    mergeInstance: (tabId: string, sourceId: number, targetId: number) => void;
    undo: (tabId: string) => void;
    redo: (tabId: string) => void;
    resetAnalysis: (tabId: string) => void;
    disposeTab: (tabId: string) => void;
}

const ANALYZE_CONTROLLERS = new Map<string, AbortController>();

function defaultTabState(): StickerSheetTabState {
    return {
        mode: 'existing',
        status: 'idle',
        isExporting: false,
        sourceFile: null,
        manifest: null,
        previewUrl: '',
        labelsUrl: '',
        uncertaintyUrl: '',
        selectedInstanceId: null,
        activeTool: 'erase',
        brushRadius: 0.015,
        edits: [],
        redoEdits: [],
        model: 'birefnet-lite',
        alphaThreshold: 128,
        // SIZE (audit 2026-08-05 §AI2.SIZE1): ảnh không metadata DPI phải dùng
        // cùng quy ước 72 DPI của cửa mở ảnh, tránh thu nhỏ kết quả 4,1667 lần.
        outputDpi: 72,
        outputDpiY: 72,
        offsetMm: 0,
        bleedMm: 2,
        error: '',
    };
}

function revokeUrl(url: string): void {
    if (url && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(url);
    }
}

function releaseAssets(tab: StickerSheetTabState): void {
    revokeUrl(tab.previewUrl);
    revokeUrl(tab.labelsUrl);
    revokeUrl(tab.uncertaintyUrl);
    if (tab.manifest?.session_id) void closeStickerSheetSession(tab.manifest.session_id);
}

function makeEditId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export const useStickerSheetStore = create<StickerSheetStore>((set, get) => ({
    tabs: {},

    initTab: (tabId) => {
        if (!get().tabs[tabId]) {
            set(state => ({ tabs: { ...state.tabs, [tabId]: defaultTabState() } }));
        }
    },
    getTab: (tabId) => get().tabs[tabId] || defaultTabState(),
    setMode: (tabId, mode) => set(state => {
        const tab = state.tabs[tabId] || defaultTabState();
        return { tabs: { ...state.tabs, [tabId]: { ...tab, mode } } };
    }),
    setActiveTool: (tabId, activeTool) => set(state => {
        const tab = state.tabs[tabId] || defaultTabState();
        return { tabs: { ...state.tabs, [tabId]: { ...tab, activeTool } } };
    }),
    setBrushRadius: (tabId, brushRadius) => set(state => {
        const tab = state.tabs[tabId] || defaultTabState();
        const normalized = Math.max(0.002, Math.min(0.08, brushRadius));
        return { tabs: { ...state.tabs, [tabId]: { ...tab, brushRadius: normalized } } };
    }),
    setSelectedInstance: (tabId, selectedInstanceId) => set(state => {
        const tab = state.tabs[tabId] || defaultTabState();
        return { tabs: { ...state.tabs, [tabId]: { ...tab, selectedInstanceId } } };
    }),
    setOutputSettings: (tabId, settings) => set(state => {
        const tab = state.tabs[tabId] || defaultTabState();
        return { tabs: { ...state.tabs, [tabId]: { ...tab, ...settings } } };
    }),
    analyze: async (tabId, file) => {
        const previous = get().tabs[tabId] || defaultTabState();
        ANALYZE_CONTROLLERS.get(tabId)?.abort();
        const controller = new AbortController();
        ANALYZE_CONTROLLERS.set(tabId, controller);
        releaseAssets(previous);
        set(state => ({
            tabs: {
                ...state.tabs,
                [tabId]: {
                    ...previous,
                    mode: 'ai-sheet',
                    status: 'analyzing',
                    isExporting: false,
                    sourceFile: file,
                    manifest: null,
                    previewUrl: '',
                    labelsUrl: '',
                    uncertaintyUrl: '',
                    selectedInstanceId: null,
                    edits: [],
                    redoEdits: [],
                    error: '',
                },
            },
        }));
        try {
            const payload = await analyzeStickerSheet(file, {
                model: previous.model,
                alphaThreshold: previous.alphaThreshold,
                signal: controller.signal,
            });
            if (ANALYZE_CONTROLLERS.get(tabId) !== controller) return;
            const previewUrl = URL.createObjectURL(payload.previewBlob);
            const labelsUrl = URL.createObjectURL(payload.labelsBlob);
            const uncertaintyUrl = URL.createObjectURL(payload.uncertaintyBlob);
            set(state => {
                const current = state.tabs[tabId] || defaultTabState();
                return {
                    tabs: {
                        ...state.tabs,
                        [tabId]: {
                            ...current,
                            status: 'ready',
                            manifest: payload.manifest,
                            previewUrl,
                            labelsUrl,
                            uncertaintyUrl,
                            selectedInstanceId: payload.manifest.instances[0]?.id || null,
                            outputDpi: payload.manifest.dpi?.[0] || current.outputDpi,
                            outputDpiY: payload.manifest.dpi?.[1] || payload.manifest.dpi?.[0] || current.outputDpiY,
                            error: '',
                        },
                    },
                };
            });
        } catch (error) {
            if (controller.signal.aborted || ANALYZE_CONTROLLERS.get(tabId) !== controller) return;
            set(state => {
                const current = state.tabs[tabId] || defaultTabState();
                return {
                    tabs: {
                        ...state.tabs,
                        [tabId]: {
                            ...current,
                            status: 'error',
                            error: error instanceof Error ? error.message : 'Không phân tích được ảnh nhiều tem.',
                        },
                    },
                };
            });
        } finally {
            if (ANALYZE_CONTROLLERS.get(tabId) === controller) ANALYZE_CONTROLLERS.delete(tabId);
        }
    },
    exportFile: async (tabId, outputFormat = 'pdf') => {
        const tab = get().tabs[tabId] || defaultTabState();
        if (!tab.manifest || tab.status !== 'ready' || tab.isExporting) return null;
        set(state => ({
            tabs: {
                ...state.tabs,
                [tabId]: { ...(state.tabs[tabId] || tab), isExporting: true, error: '' },
            },
        }));
        try {
            return await exportStickerSheet(tab.manifest.session_id, {
                edits: tab.edits,
                dpi: tab.outputDpi,
                dpiY: tab.outputDpiY,
                offsetMm: tab.offsetMm,
                bleedMm: tab.bleedMm,
                outputFormat,
            });
        } catch (error) {
            set(state => {
                const current = state.tabs[tabId] || tab;
                return {
                    tabs: {
                        ...state.tabs,
                        [tabId]: {
                            ...current,
                            error: error instanceof Error ? error.message : 'Không tạo được file tem.',
                        },
                    },
                };
            });
            return null;
        } finally {
            set(state => {
                const current = state.tabs[tabId];
                return current ? {
                    tabs: { ...state.tabs, [tabId]: { ...current, isExporting: false } },
                } : state;
            });
        }
    },
    addStroke: (tabId, stroke) => set(state => {
        const tab = state.tabs[tabId] || defaultTabState();
        const edit: StickerMaskStroke = { ...stroke, kind: 'stroke', id: makeEditId() };
        return {
            tabs: {
                ...state.tabs,
                [tabId]: { ...tab, edits: [...tab.edits, edit], redoEdits: [] },
            },
        };
    }),
    mergeInstance: (tabId, sourceId, targetId) => {
        if (sourceId === targetId) return;
        set(state => {
            const tab = state.tabs[tabId] || defaultTabState();
            const edit: StickerMergeEdit = {
                kind: 'merge', id: makeEditId(), sourceId, targetId,
            };
            return {
                tabs: {
                    ...state.tabs,
                    [tabId]: { ...tab, edits: [...tab.edits, edit], redoEdits: [] },
                },
            };
        });
    },
    undo: (tabId) => set(state => {
        const tab = state.tabs[tabId] || defaultTabState();
        const edit = tab.edits[tab.edits.length - 1];
        if (!edit) return state;
        return {
            tabs: {
                ...state.tabs,
                [tabId]: {
                    ...tab,
                    edits: tab.edits.slice(0, -1),
                    redoEdits: [...tab.redoEdits, edit],
                },
            },
        };
    }),
    redo: (tabId) => set(state => {
        const tab = state.tabs[tabId] || defaultTabState();
        const edit = tab.redoEdits[tab.redoEdits.length - 1];
        if (!edit) return state;
        return {
            tabs: {
                ...state.tabs,
                [tabId]: {
                    ...tab,
                    edits: [...tab.edits, edit],
                    redoEdits: tab.redoEdits.slice(0, -1),
                },
            },
        };
    }),
    resetAnalysis: (tabId) => set(state => {
        const tab = state.tabs[tabId] || defaultTabState();
        ANALYZE_CONTROLLERS.get(tabId)?.abort();
        ANALYZE_CONTROLLERS.delete(tabId);
        releaseAssets(tab);
        return {
            tabs: {
                ...state.tabs,
                [tabId]: { ...defaultTabState(), mode: tab.mode },
            },
        };
    }),
    disposeTab: (tabId) => set(state => {
        const tab = state.tabs[tabId];
        ANALYZE_CONTROLLERS.get(tabId)?.abort();
        ANALYZE_CONTROLLERS.delete(tabId);
        if (tab) releaseAssets(tab);
        const tabs = { ...state.tabs };
        delete tabs[tabId];
        return { tabs };
    }),
}));
