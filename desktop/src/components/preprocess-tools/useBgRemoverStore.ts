import { create } from 'zustand';
import { BgRemoverOptionsState } from './BgRemoverOptions';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BatchItem {
    id: string;
    path: string;
    fileName: string;
    originalUrl: string;
    resultBlob?: Blob;
    resultUrl?: string;
    status: 'pending' | 'processing' | 'success' | 'error';
    error?: string;
    fileObj?: File;
}

export interface TabState {
    batchItems: BatchItem[];
    selectedId: string | null;
    options: BgRemoverOptionsState;
    isProcessing: boolean;
    progress: string;
    error: string;
}

export const defaultTabState: TabState = {
    batchItems: [],
    selectedId: null,
    options: { aiEngine: 'general', edgeShift: 0, bgColor: 'transparent', customHex: '#FFFFFF', autoCrop: false },
    isProcessing: false,
    progress: '',
    error: '',
};

interface BgRemoverStore {
    tabs: Record<string, TabState>;

    initTab: (tabId: string) => void;
    getTab: (tabId: string) => TabState;
    setBatchItems: (tabId: string, items: BatchItem[] | ((prev: BatchItem[]) => BatchItem[])) => void;
    setSelectedId: (tabId: string, id: string | null) => void;
    setOptions: (tabId: string, opts: BgRemoverOptionsState) => void;
    setIsProcessing: (tabId: string, v: boolean) => void;
    setProgress: (tabId: string, v: string) => void;
    setError: (tabId: string, v: string) => void;
    addItems: (tabId: string, items: BatchItem[]) => void;
    removeItem: (tabId: string, id: string) => void;
    undoItem: (tabId: string, id: string) => void;
    reset: (tabId: string) => void;
}

export const useBgRemoverStore = create<BgRemoverStore>((set, get) => ({
    tabs: {},

    initTab: (tabId) => {
        if (!get().tabs[tabId]) {
            set(state => ({ tabs: { ...state.tabs, [tabId]: { ...defaultTabState } } }));
        }
    },
    getTab: (tabId) => {
        return get().tabs[tabId] || { ...defaultTabState };
    },
    setBatchItems: (tabId, itemsOrFn) => set(state => {
        const tab = state.tabs[tabId] || { ...defaultTabState };
        const newItems = typeof itemsOrFn === 'function' ? itemsOrFn(tab.batchItems) : itemsOrFn;
        return { tabs: { ...state.tabs, [tabId]: { ...tab, batchItems: newItems } } };
    }),
    setSelectedId: (tabId, id) => set(state => {
        const tab = state.tabs[tabId] || { ...defaultTabState };
        return { tabs: { ...state.tabs, [tabId]: { ...tab, selectedId: id } } };
    }),
    setOptions: (tabId, opts) => set(state => {
        const tab = state.tabs[tabId] || { ...defaultTabState };
        return { tabs: { ...state.tabs, [tabId]: { ...tab, options: opts } } };
    }),
    setIsProcessing: (tabId, v) => set(state => {
        const tab = state.tabs[tabId] || { ...defaultTabState };
        return { tabs: { ...state.tabs, [tabId]: { ...tab, isProcessing: v } } };
    }),
    setProgress: (tabId, v) => set(state => {
        const tab = state.tabs[tabId] || { ...defaultTabState };
        return { tabs: { ...state.tabs, [tabId]: { ...tab, progress: v } } };
    }),
    setError: (tabId, v) => set(state => {
        const tab = state.tabs[tabId] || { ...defaultTabState };
        return { tabs: { ...state.tabs, [tabId]: { ...tab, error: v } } };
    }),
    addItems: (tabId, items) => set(state => {
        const tab = state.tabs[tabId] || { ...defaultTabState };
        const updated = [...tab.batchItems, ...items];
        return { 
            tabs: { 
                ...state.tabs, 
                [tabId]: { ...tab, batchItems: updated, selectedId: tab.selectedId || items[0]?.id || null, error: '' } 
            } 
        };
    }),
    removeItem: (tabId, id) => set(state => {
        const tab = state.tabs[tabId] || { ...defaultTabState };
        const updated = tab.batchItems.filter(i => i.id !== id);
        return {
            tabs: {
                ...state.tabs,
                [tabId]: {
                    ...tab,
                    batchItems: updated,
                    selectedId: tab.selectedId === id ? (updated[0]?.id || null) : tab.selectedId,
                }
            }
        };
    }),
    undoItem: (tabId, id) => set(state => {
        const tab = state.tabs[tabId] || { ...defaultTabState };
        const updated = tab.batchItems.map(i => 
            i.id === id ? { ...i, status: 'pending' as const, resultUrl: undefined, resultBlob: undefined, error: undefined } : i
        );
        return { tabs: { ...state.tabs, [tabId]: { ...tab, batchItems: updated } } };
    }),
    reset: (tabId) => set(state => ({
        tabs: { ...state.tabs, [tabId]: { ...defaultTabState } }
    })),
}));
