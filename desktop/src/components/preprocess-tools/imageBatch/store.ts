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
    resultIdentity?: string;
    resultUrl?: string;
    resultInfo?: string;
    status: 'pending' | 'processing' | 'success' | 'error';
    error?: string;
    fileObj?: File;
    // UIUX (audit 2026-08-10 §UP.X.01): danh tính nội dung bất biến — Tauri dùng
    // canonical path từ picker, browser dùng ingest token. Tránh collision khi hai
    // file trùng tên + size nhưng khác nội dung.
    sourceIdentity?: string;
    // REVISION (audit 2026-08-25 §REV.06): chỉ item tự đồng bộ từ workspace
    // mới được thay khi revision nguồn đổi. Item không có nhãn là dữ liệu cũ và
    // luôn được đối xử như `explicit` để không xóa nhầm ảnh người dùng đã chọn.
    sourceOrigin?: 'workspace' | 'explicit';
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
    // UIUX (audit 2026-08-10 §UP.X.02): giải phóng hoàn toàn tab khi đóng —
    // revoke mọi objectURL, xóa key khỏi state, tránh leak RAM.
    destroyTab: (tabId: string) => void;
}

export function invalidateBatchResults(items: BatchItem[]): BatchItem[] {
    return items.map(item => ({
        ...item,
        status: 'pending' as const,
        resultBlob: undefined,
        resultIdentity: undefined,
        resultUrl: undefined,
        resultInfo: undefined,
        error: undefined,
    }));
}

function revokeUrl(url?: string) {
    if (!url || typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
    URL.revokeObjectURL(url);
}

function revokeReplacedUrls(previous: BatchItem[], next: BatchItem[]) {
    const nextById = new Map(next.map(item => [item.id, item]));
    for (const item of previous) {
        const current = nextById.get(item.id);
        if (!current || current.originalUrl !== item.originalUrl) revokeUrl(item.originalUrl);
        if (!current || current.resultUrl !== item.resultUrl) revokeUrl(item.resultUrl);
    }
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
            revokeReplacedUrls(tab.batchItems, newItems);
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
            const removed = tab.batchItems.find(i => i.id === id);
            if (removed) revokeReplacedUrls([removed], []);
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
            revokeUrl(tab.batchItems.find(i => i.id === id)?.resultUrl);
            const updated = tab.batchItems.map(i =>
                i.id === id ? { ...i, status: 'pending' as const, resultUrl: undefined, resultBlob: undefined, resultIdentity: undefined, resultInfo: undefined, error: undefined } : i
            );
            return { tabs: { ...state.tabs, [tabId]: { ...tab, batchItems: updated } } };
        }),
        reset: (tabId) => set(state => {
            const tab = state.tabs[tabId];
            if (tab) revokeReplacedUrls(tab.batchItems, []);
            return { tabs: { ...state.tabs, [tabId]: makeDefaultTab() } };
        }),
        // UIUX (audit 2026-08-10 §UP.X.02): giải phóng hoàn toàn tab khi đóng.
        destroyTab: (tabId) => set(state => {
            const tab = state.tabs[tabId];
            if (tab) {
                for (const item of tab.batchItems) {
                    revokeUrl(item.originalUrl);
                    revokeUrl(item.resultUrl);
                }
            }
            const rest = { ...state.tabs };
            delete rest[tabId];
            return { tabs: rest };
        }),
    }));
}
