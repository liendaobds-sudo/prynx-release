import { isOfficePathOrName } from './officeFileTypes';
import { markGeneratedWorkspaceFile } from './nativeFileAccess';

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
    document_cleanup: 'prynx-document-cleanup-add-files',
    logo_rebuild: 'prynx-logo-rebuild-add-files',
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

/**
 * Yêu cầu shell mở một AppTool **standalone** kèm file, từ trong một tool khác.
 *
 * Vì sao cần một đường riêng: `onSpawnTab` của workspace hard-code `handleOpenApp('imposition', …)`
 * (App.tsx), nên nó chỉ mở được biến thể `ImpositionTab`. Các tool standalone như
 * `mixed_nesting` hay `dieline` không có cửa nào để tới từ bên trong một tool. Trước đây
 * chuyển tiếp duy nhất trong họ khuôn bế là `StickerTool.openImpositionTool`, và nó chỉ đổi
 * `activeDashboardTool` trong CÙNG một tab — cách đó không áp dụng được ở đây.
 *
 * Vì sao là event chứ không phải prop: chuỗi prop từ shell tới `StickerTool` đi qua
 * `ImpositionTab` → `ImposerDashboard` → `PreprocessingRouter` → `StickerCutlineTool`, tức
 * hai god file. Xuyên prop qua đó chỉ để truyền một callback là đổi rủi ro lớn lấy tiện lợi
 * nhỏ. `StickerTool` vốn đã tự đọc `useImposerSettingsStore`/`findToolByUniqueKey`, nên một
 * bus nhẹ đặt cùng chỗ với các helper điều hướng khác là nhất quán hơn.
 *
 * **Quyền vẫn phải kiểm hai lần**: bên gửi đi qua `useToolActivationGuard` như mọi cửa mở
 * tool, và bên nhận (shell) kiểm lại registry + license trước khi mở. Event không phải giấy
 * thông hành.
 */
export const OPEN_TOOL_REQUEST_EVENT = 'prynx-open-tool-request';

export interface OpenToolRequestDetail {
    toolId: string;
    file?: File;
}

export function requestOpenTool(toolId: string, file?: File): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(
        new CustomEvent<OpenToolRequestDetail>(OPEN_TOOL_REQUEST_EVENT, {
            detail: { toolId, file },
        }),
    );
}

const SOURCE_TAB_PAYLOAD_KEY = '__prynxOpenExistingSource';

/**
 * FILEIO (audit 2026-08-26 §FILE.A4): mở file nguồn sang tab khác. Khóa nội bộ bị loại trước khi
 * payload tới tab, tránh biến cơ chế routing thành metadata lâu dài.
 */
export function buildSourceTabOptions(extraPayload?: Record<string, unknown>): Record<string, unknown> {
    return {
        ...(extraPayload || {}),
        [SOURCE_TAB_PAYLOAD_KEY]: true,
    };
}

/** Tab kết quả bắt đầu ở viewer thường; chỉ intent tường minh mới thêm lockedMode/focusFeature. */
export function buildResultTabPayload(file: File, extraPayload?: Record<string, unknown>) {
    const {
        [SOURCE_TAB_PAYLOAD_KEY]: openExistingSource,
        ...safeExtraPayload
    } = extraPayload || {};
    if (openExistingSource !== true) markGeneratedWorkspaceFile(file);
    return { file, ...safeExtraPayload };
}
export interface IncomingFileLike {
    name: string;
}

export type IncomingFilePlan<T> =
    | { mode: 'combine'; files: T[] }
    | { mode: 'default'; pdfFiles: T[]; officeFiles: T[]; otherFiles: T[] };

/**
 * FILEIO (audit 2026-08-02 §COMB.1): intent từ verb Explorer phải được xét
 * trước quy tắc Acrobat mặc định; nếu không PDF bị tách thành nhiều tab trước khi
 * Combine có cơ hội nhận toàn bộ batch.
 */
export function planIncomingFiles<T extends IncomingFileLike>(
    files: readonly T[],
    intent: string,
): IncomingFilePlan<T> {
    if (intent === 'combine') {
        return { mode: 'combine', files: [...files] };
    }
    return { mode: 'default', ...partitionIncomingFiles(files) };
}

/**
 * PDF luôn là tài liệu độc lập và phải mở mỗi file ở một tab mới. Tách PDF trước
 * khi xét receiver của công cụ ảnh để tab Upscale/Tách nền không hút nhầm PDF.
 */
export function partitionIncomingFiles<T extends IncomingFileLike>(files: readonly T[]) {
    const pdfFiles: T[] = [];
    const officeFiles: T[] = [];
    const otherFiles: T[] = [];
    for (const file of files) {
        if (/\.pdf$/i.test(file.name)) pdfFiles.push(file);
        else if (isOfficePathOrName(file.name)) officeFiles.push(file);
        else otherFiles.push(file);
    }
    return { pdfFiles, officeFiles, otherFiles };
}
