export interface NavigationTabLike {
    id: string;
    type: string;
    payload?: Record<string, unknown>;
}

/** Chỉ tab chuyên dụng đang active mới được nhận file ngoài ứng dụng. */
export function resolveActiveDedicatedReceiver(
    tabs: readonly NavigationTabLike[],
    activeTabId: string,
    feature: string,
): string | null {
    const activeTab = tabs.find((tab) => tab.id === activeTabId);
    if (activeTab?.type !== 'imposition') return null;
    return activeTab.payload?.focusFeature === feature || activeTab.payload?.lockedMode === feature
        ? activeTab.id
        : null;
}

export const IMAGE_BATCH_DROP_EVENTS = {
    bgremover: 'prynx-bgremover-add-files',
    upscale: 'prynx-upscale-add-files',
} as const;

export type ImageBatchReceiverFeature = keyof typeof IMAGE_BATCH_DROP_EVENTS;

/** Trang thai cong cu dang hien thi thuc te trong tung workspace tab. */
const activeTabFeatures = new Map<string, string>();

export function registerActiveTabFeature(tabId: string, feature: string): () => void {
    activeTabFeatures.set(tabId, feature);
    return () => {
        // Chi go dung lan dang ky nay; effect moi co the da ghi feature ke tiep.
        if (activeTabFeatures.get(tabId) === feature) activeTabFeatures.delete(tabId);
    };
}




/** Định tuyến file native vào đúng công cụ ảnh chuyên dụng đang được xem. */
export function resolveActiveImageBatchReceiver(
    tabs: readonly NavigationTabLike[],
    activeTabId: string,
): { tabId: string; feature: ImageBatchReceiverFeature; eventName: string } | null {
    if (!tabs.some(tab => tab.id === activeTabId)) return null;

    // Trang thai runtime la nguon dung: payload.focusFeature chi la y dinh luc mo tab.
    const liveFeature = activeTabFeatures.get(activeTabId);
    if (liveFeature !== undefined) {
        if (liveFeature in IMAGE_BATCH_DROP_EVENTS) {
            const feature = liveFeature as ImageBatchReceiverFeature;
            return {
                tabId: activeTabId,
                feature,
                eventName: IMAGE_BATCH_DROP_EVENTS[feature],
            };
        }
        // Da biet cong cu hien tai khong phai batch anh; khong roi ve intent cu.
        return null;
    }

    // Fallback ngan truoc khi workspace dang ky trang thai runtime lan dau.

    for (const feature of Object.keys(IMAGE_BATCH_DROP_EVENTS) as ImageBatchReceiverFeature[]) {
        const tabId = resolveActiveDedicatedReceiver(tabs, activeTabId, feature);
        if (tabId) {
            return {
                tabId,
                feature,
                eventName: IMAGE_BATCH_DROP_EVENTS[feature],
            };
        }
    }
    return null;
}

/** Tab kết quả bắt đầu ở viewer thường; chỉ intent tường minh mới thêm lockedMode/focusFeature. */
export function buildResultTabPayload<T>(file: T, extraPayload?: Record<string, unknown>) {
    return { file, ...(extraPayload || {}) };
}