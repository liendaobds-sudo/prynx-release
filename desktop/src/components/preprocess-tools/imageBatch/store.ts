import { create } from 'zustand';

// ─── Types ───────────────────────────────────────────────────────────────────
// Store batch ẢNH dùng chung cho các công cụ AI xử lý theo lô (tách nền, upscale).
// Generic theo `options` (O) để mỗi công cụ giữ bộ tuỳ chọn riêng, phần còn lại
// (danh sách item, chọn item, tiến độ, lỗi) hoàn toàn giống nhau.

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

export interface BatchTabState<O> {
    batchItems: BatchItem[];
    selectedId: string | null;
    options: O;
    isProcessing: boolean;
    progress: string;
    error: string;
}

export interface ImageBatchStore<O> {
    tabs: Record<string, BatchTabState<O>>;

    initTab: (tabId: string) => void;
    getTab: (tabId: string) => BatchTabState<O>;
    setBatchItems: (tabId: string, items: BatchItem[] | ((prev: BatchItem[]) => BatchItem[])) => void;
    setSelectedId: (tabId: string, id: string | null) => void;
    setOptions: (tabId: string, opts: O) => void;
    setIsProcessing: (tabId: string, v: boolean) => void;
    setProgress: (tabId: string, v: string) => void;
    setError: (tabId: string, v: string) => void;
    addItems: (tabId: string, items: BatchItem[]) => void;
    removeItem: (tabId: string, id: string) => void;
    undoItem: (tabId: string, id: string) => void;
    reset: (tabId: string) => void;
}

/** Tạo một zustand store xử-lý-lô-ảnh với bộ options mặc định cho trước. */
export function createImageBatchStore<O>(defaultOptions: O) {
    const makeDefaultTab = (): BatchTabState<O> => ({
        batchItems: [],
        selectedId: null,
        options: { ...defaultOptions },
        isProcessing: false,
        progress: '',
        error: '',
    });

    return create<ImageBatchStore<O>>((set, get) => ({
        tabs: {},

        initTab: (tabId) => {
            if (!get().tabs[tabId]) {
                set(state => ({ tabs: { ...state.tabs, [tabId]: makeDefaultTab() } }));
            }
        },
        getTab: (tabId) => {
            return get().tabs[tabId] || makeDefaultTab();
        },
        setBatchItems: (tabId, itemsOrFn) => set(state => {
            const tab = state.tabs[tabId] || makeDefaultTab();
            const newItems = typeof itemsOrFn === 'function' ? itemsOrFn(tab.batchItems) : itemsOrFn;
            return { tabs: { ...state.tabs, [tabId]: { ...tab, batchItems: newItems } } };
        }),
        setSelectedId: (tabId, id) => set(state => {
            const tab = state.tabs[tabId] || makeDefaultTab();
            return { tabs: { ...state.tabs, [tabId]: { ...tab, selectedId: id } } };
        }),
        setOptions: (tabId, opts) => set(state => {
            const tab = state.tabs[tabId] || makeDefaultTab();
            return { tabs: { ...state.tabs, [tabId]: { ...tab, options: opts } } };
        }),
        setIsProcessing: (tabId, v) => set(state => {
            const tab = state.tabs[tabId] || makeDefaultTab();
            return { tabs: { ...state.tabs, [tabId]: { ...tab, isProcessing: v } } };
        }),
        setProgress: (tabId, v) => set(state => {
            const tab = state.tabs[tabId] || makeDefaultTab();
            return { tabs: { ...state.tabs, [tabId]: { ...tab, progress: v } } };
        }),
        setError: (tabId, v) => set(state => {
            const tab = state.tabs[tabId] || makeDefaultTab();
            return { tabs: { ...state.tabs, [tabId]: { ...tab, error: v } } };
        }),
        addItems: (tabId, items) => set(state => {
            const tab = state.tabs[tabId] || makeDefaultTab();
            const updated = [...tab.batchItems, ...items];
            return {
                tabs: {
                    ...state.tabs,
                    [tabId]: { ...tab, batchItems: updated, selectedId: tab.selectedId || items[0]?.id || null, error: '' }
                }
            };
        }),
        removeItem: (tabId, id) => set(state => {
            const tab = state.tabs[tabId] || makeDefaultTab();
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
            const tab = state.tabs[tabId] || makeDefaultTab();
            const updated = tab.batchItems.map(i =>
                i.id === id ? { ...i, status: 'pending' as const, resultUrl: undefined, resultBlob: undefined, error: undefined } : i
            );
            return { tabs: { ...state.tabs, [tabId]: { ...tab, batchItems: updated } } };
        }),
        reset: (tabId) => set(state => ({
            tabs: { ...state.tabs, [tabId]: makeDefaultTab() }
        })),
    }));
}
