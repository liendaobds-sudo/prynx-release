import React, { useRef } from 'react';
import { getApiUrl, authenticatedFetch } from '../../lib/api';
import { formatError } from '../../lib/errorMessages';
import { ToolSectionLabel } from './ToolUI';
import { defaultUpscaleTabState, useUpscaleStore } from './useUpscaleStore';
import { normalizeAndAddFiles, openFilePicker, saveBatch } from './imageBatch/helpers';
import { ImageBatchPreview } from './imageBatch/ImageBatchPreview';
import { toast } from '../ui/Toast';
import { RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { tv } from '../../i18n';
import { IMAGE_BATCH_DROP_EVENTS } from '../../lib/tabNavigation';
import type { BatchItem } from './imageBatch/store';
import { rasterizeUpscaleWorkingPage } from './upscaleWorkingPage';
import { getFileArrayBuffer } from '../../lib/utils';
import { sourceImagePixelsPerPdfPoint } from '../../lib/imageNormalizer';

// ─── Props ───────────────────────────────────────────────────────────────────
interface Props {
    tabId: string;
    pdfFile: File | null;
    sourceImageFile?: File | null;
    /** Không được gửi thẳng backend; chỉ dùng khôi phục mật độ raster của PDF revision. */
    sourceImageReferenceFile?: File | null;
    /** PDF đã bake revision Viewer; chỉ gọi khi người dùng bấm Chạy. */
    getWorkingFile?: () => Promise<File>;
    activeWorkingPage?: number;
    onFileFixed?: (blob: Blob, name: string, path?: string) => void | Promise<void>;
}


// ─── Process batch (riêng cho upscale — gọi /upscale) ─────────────────────────
const upscaleControllers = new Map<string, AbortController>();
const upscaleArtifactLeases = new Map<string, Set<string>>();
const UPSCALE_WORKING_PAGE_PLACEHOLDER = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="#e2e8f0"/><rect x="48" y="22" width="64" height="76" rx="5" fill="#f8fafc" stroke="#94a3b8" stroke-width="3"/><path d="M61 45h38M61 58h38M61 71h26" stroke="#94a3b8" stroke-width="4" stroke-linecap="round"/></svg>',
)}`;

async function updateUpscaleArtifactLease(
    action: 'claim' | 'release',
    leaseToken: string,
): Promise<void> {
    const body = new FormData();
    body.append('lease_token', leaseToken);
    const response = await authenticatedFetch(
        `${getApiUrl()}/pdf-tools/upscale/artifact/${action}`,
        { method: 'POST', body },
    );
    if (!response.ok) throw new Error(`Upscale artifact ${action} failed (${response.status})`);
}

async function claimUpscaleArtifactLease(tabId: string, leaseToken: string): Promise<void> {
    await updateUpscaleArtifactLease('claim', leaseToken);
    const leases = upscaleArtifactLeases.get(tabId) ?? new Set<string>();
    leases.add(leaseToken);
    upscaleArtifactLeases.set(tabId, leases);
}

async function releaseUpscaleArtifactLease(leaseToken: string): Promise<void> {
    try {
        await updateUpscaleArtifactLease('release', leaseToken);
    } catch {
        // Marker bền trên đĩa sẽ tự hết hạn sau restart/mất kết nối sidecar.
    }
}

function releaseUpscaleTabArtifacts(tabId: string): void {
    const leases = upscaleArtifactLeases.get(tabId);
    upscaleArtifactLeases.delete(tabId);
    if (!leases) return;
    for (const lease of leases) void releaseUpscaleArtifactLease(lease);
}

// UIUX (audit 2026-07-29 §NET.10): nhãn kết quả chỉ nói TÊN CHẾ ĐỘ, không nêu tên
// model/kiến trúc. Tên model chỉ còn trong THIRD_PARTY_NOTICES.md — chỗ đó là nghĩa
// vụ ghi công của giấy phép BSD-3-Clause, không được bỏ.
function modeLabel(model: 'quality' | 'balanced' | 'general'): string {
    if (model === 'quality') return tv('Chất lượng');
    if (model === 'balanced') return tv('Cân bằng');
    return tv('Nhanh');
}

// Export helper để test khóa hợp đồng đổi công cụ, không phải React component.
// eslint-disable-next-line react-refresh/only-export-components
export function upscaleOutputName(fileName: string): string {
    const stem = fileName.replace(/\.[^/.]+$/, '') || 'image';
    return `upscaled_${stem}.png`;
}

const UPSCALE_RESULT_ID_PROPERTY = '__prynxUpscaleResultId';
type UpscaleResultCarrier = Blob & { __prynxUpscaleResultId?: string };

function upscaleResultIdentity(tabId: string, itemId: string): string {
    return JSON.stringify([tabId, itemId]);
}

function readUpscaleResultIdentity(value?: Blob | null): string | undefined {
    const identity = (value as UpscaleResultCarrier | null | undefined)?.[UPSCALE_RESULT_ID_PROPERTY];
    return typeof identity === 'string' && identity.length > 0 ? identity : undefined;
}

// UIUX (audit 2026-08-11 §UP.X.01): token theo tab+item đi cùng Blob/File kết quả;
// Undo không còn phải đoán owner bằng tên và dung lượng.
// eslint-disable-next-line react-refresh/only-export-components
export function tagUpscaleResultIdentity(value: Blob, tabId: string, itemId: string): string {
    const identity = upscaleResultIdentity(tabId, itemId);
    Object.defineProperty(value, UPSCALE_RESULT_ID_PROPERTY, {
        value: identity,
        configurable: true,
    });
    return identity;
}

// eslint-disable-next-line react-refresh/only-export-components
export function copyUpscaleResultIdentity(source: Blob, target: Blob): void {
    const identity = readUpscaleResultIdentity(source);
    if (!identity) return;
    Object.defineProperty(target, UPSCALE_RESULT_ID_PROPERTY, {
        value: identity,
        configurable: true,
    });
}

function filePath(file: File): string {
    return 'path' in file && typeof file.path === 'string' ? file.path : '';
}

// UIUX (audit 2026-08-10 §UP.X.01): so sánh qua sourceIdentity trước, tránh
// collision khi hai file khác nội dung nhưng trùng tên + size.
function fileIdentity(file: File): string {
    const path = filePath(file);
    return path ? `path:${path}` : '';
}

function isSameBatchSource(item: BatchItem, file: File): boolean {
    // 1. So qua sourceIdentity nếu cả hai đều có
    const identity = fileIdentity(file);
    if (identity && item.sourceIdentity === identity) return true;
    // 2. Fallback: path match
    const path = filePath(file);
    if (path && item.path === path) return true;
    // 3. Browser file không có path: so name + fileObj reference.
    // Không dùng size vì đó là nguồn gốc collision. Cho phép match khi
    // item.fileObj chính là cùng đối tượng File (reference equality).
    if (!path && item.fileName === file.name && item.fileObj === file) return true;
    return false;
}

// eslint-disable-next-line react-refresh/only-export-components
export function shouldPromoteUpscaleResult(
    items: BatchItem[],
    item: BatchItem,
    sourceImageFile?: File | null,
): boolean {
    // Item workspace có owner rõ ràng nên không còn mơ hồ ngay cả khi batch còn
    // các ảnh explicit. Trường hợp PDF revision dùng placeholder này.
    if (item.sourceOrigin === 'workspace') return true;
    // Một ảnh là luồng không mơ hồ. Với batch nhiều ảnh, chỉ thay tài liệu nếu item
    // chính là ảnh nguồn của workspace; không tự chọn hộ người dùng một ảnh khác.
    if (items.length === 1) return true;
    return !!sourceImageFile && isSameBatchSource(item, sourceImageFile);
}

// eslint-disable-next-line react-refresh/only-export-components
export function isUpscaleInputAlreadyTracked(items: BatchItem[], inputFile: File): boolean {
    const resultIdentity = readUpscaleResultIdentity(inputFile);
    return items.some(item => isSameBatchSource(item, inputFile)) || !!(
        resultIdentity && items.some(item => item.resultIdentity === resultIdentity)
    );
}

// eslint-disable-next-line react-refresh/only-export-components
export function isCurrentUpscaleWorkingResult(
    tabId: string,
    item: BatchItem,
    sourceImageFile?: File | null,
): boolean {
    if (!sourceImageFile || !item.resultBlob) return false;
    const expectedIdentity = upscaleResultIdentity(tabId, item.id);
    return item.resultIdentity === expectedIdentity
        && readUpscaleResultIdentity(sourceImageFile) === expectedIdentity;
}

type UpscaleResultReady = (result: {
    blob: Blob;
    name: string;
    workingPdfPath?: string;
    artifactLease?: string;
    item: BatchItem;
    items: BatchItem[];
}) => boolean | void | Promise<boolean | void>;

type UpscaleWorkingPdfPolicy = (item: BatchItem, items: BatchItem[]) => boolean;
type UpscaleSourceResolver = (
    item: BatchItem,
    items: BatchItem[],
    signal: AbortSignal,
) => Promise<File | undefined>;

type NativeUpscaleFileGrant = {
    path: string;
    grant: string;
};

function appendUpscaleOptions(
    formData: FormData,
    model: 'quality' | 'balanced' | 'general',
    scaleFactor: 2 | 4,
    includeWorkingPdf: boolean,
): void {
    formData.append('engine', model);
    formData.append('scale_factor', String(scaleFactor));
    if (includeWorkingPdf) formData.append('include_working_pdf', 'true');
}

async function waitForUpscaleBackend(signal: AbortSignal): Promise<void> {
    // NET (audit 2026-08-20): warmup chạy nền nên không bảo đảm sidecar đã lắng
    // nghe khi người dùng bấm Xử lý. Chờ health (GET idempotent, có retry ở api.ts)
    // trước khi gửi POST Upscale nặng để không phải lặp một tác vụ AI đã bắt đầu.
    const healthUrl = new URL('/health', getApiUrl()).toString();
    const response = await authenticatedFetch(healthUrl, { signal });
    if (!response.ok) {
        throw new Error(tv('Bộ xử lý của PrynX chưa sẵn sàng. Hãy chờ vài giây rồi thử lại.'));
    }
}

async function prepareUpscaleRequest(
    tabId: string,
    item: BatchItem,
    model: 'quality' | 'balanced' | 'general',
    scaleFactor: 2 | 4,
    includeWorkingPdf: boolean,
): Promise<{ formData: FormData; usedPathGrant: boolean }> {
    const formData = new FormData();
    const hasSourceBytes = !!item.fileObj && item.fileObj.size > 0;
    let usedPathGrant = false;

    if (item.path && item.path !== 'browser-file' && (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
        try {
            // SEC (audit 2026-08-11 §UP.R.01): chỉ native host được quyền biến
            // picker/drop path thành capability; renderer không tự ký file_path.
            const { invoke } = await import('@tauri-apps/api/core');
            const granted = await invoke<NativeUpscaleFileGrant>('grant_upscale_file_path', {
                filePath: item.path,
                tabId,
            });
            if (!granted?.path || !granted?.grant) throw new Error('Grant Upscale rỗng');
            formData.append('file_path', granted.path);
            formData.append('file_grant', granted.grant);
            formData.append('file_grant_tab_id', tabId);
            usedPathGrant = true;
        } catch {
            // Startup/recent path không có picker scope hoặc grant đã stale: gửi
            // bytes ngay. Không thử mở rộng allowlist sang Desktop/ổ đĩa.
            if (!hasSourceBytes) throw new Error(tv('Không đọc được file gốc đã chọn'));
            formData.append('file', item.fileObj!, item.fileName);
        }
    } else if (hasSourceBytes) {
        formData.append('file', item.fileObj!, item.fileName);
    } else {
        throw new Error(tv('Không tìm thấy file gốc'));
    }

    appendUpscaleOptions(formData, model, scaleFactor, includeWorkingPdf);
    return { formData, usedPathGrant };
}

// eslint-disable-next-line react-refresh/only-export-components
export async function processUpscaleBatch(
    tabId: string,
    onResultReady?: UpscaleResultReady,
    shouldPrepareWorkingPdf?: UpscaleWorkingPdfPolicy,
    resolveSource?: UpscaleSourceResolver,
) {
    const store = useUpscaleStore.getState();
    const tabState = store.getTab(tabId);
    const { options, batchItems } = tabState;
    const controller = new AbortController();
    upscaleControllers.set(tabId, controller);
    store.setIsProcessing(tabId, true);
    const items = [...batchItems];
    let processed = 0;
    const apiUrl = getApiUrl();

    try {
        for (let i = 0; i < items.length; i++) {
            if (items[i].status === 'success') continue;
            if (controller.signal.aborted) break;
            processed++;
            store.setProgress(tabId, tv('Đang phóng to') + ' ' + processed + ' / ' + items.length + '...');
            items[i] = { ...items[i], status: 'processing', error: undefined };
            store.setBatchItems(tabId, [...items]);
            try {
                const item = items[i];
                const resolvedSource = await resolveSource?.(item, items, controller.signal);
                if (resolvedSource) {
                    items[i] = {
                        ...items[i],
                        path: 'browser-file',
                        fileName: resolvedSource.name,
                        originalUrl: items[i].originalUrl,
                        fileObj: resolvedSource,
                        sourceIdentity: undefined,
                    };
                }
                const requestItem = items[i];
                store.setProgress(tabId, tv('Đang kết nối bộ xử lý...'));
                await waitForUpscaleBackend(controller.signal);
                store.setProgress(tabId, tv('Đang phóng to') + ' ' + processed + ' / ' + items.length + '...');
                const includeWorkingPdf = !!onResultReady
                    && (!shouldPrepareWorkingPdf || shouldPrepareWorkingPdf(requestItem, items));
                const { formData, usedPathGrant } = await prepareUpscaleRequest(
                    tabId,
                    requestItem,
                    options.model,
                    options.scaleFactor,
                    includeWorkingPdf,
                );
                let res = await authenticatedFetch(apiUrl + '/pdf-tools/upscale', {
                    method: 'POST',
                    body: formData,
                    signal: controller.signal,
                });
                // UIUX (audit 2026-08-10 §UP.X.03): grant/path có thể stale sau
                // lúc native cấp. Retry đúng một lần bằng bytes, giữ nguyên option.
                if (!res.ok && usedPathGrant
                    && requestItem.fileObj && requestItem.fileObj.size > 0
                    && [400, 403, 404].includes(res.status)) {
                    console.warn('[Upscale] Quyền đường dẫn đã stale, retry bằng upload.');
                    const retryForm = new FormData();
                    retryForm.append('file', requestItem.fileObj!, requestItem.fileName);
                    appendUpscaleOptions(
                        retryForm,
                        options.model,
                        options.scaleFactor,
                        includeWorkingPdf,
                    );
                    res = await authenticatedFetch(apiUrl + '/pdf-tools/upscale', {
                        method: 'POST',
                        body: retryForm,
                        signal: controller.signal,
                    });
                }
                if (!res.ok) {
                    const errorText = await res.text();
                    console.error('[Upscale] Server error:', errorText);
                    // UIUX (audit 2026-07-29 §NET.04): backend trả 422 kèm thông điệp
                    // tiếng Việt đã soạn cho người dùng (thiếu GPU, vượt trần thời
                    // gian, thiếu RAM). Hiện nguyên văn thay vì dán cả JSON thô.
                    let detail = '';
                    try {
                        const parsed = JSON.parse(errorText) as { detail?: unknown };
                        if (typeof parsed.detail === 'string') detail = parsed.detail;
                    } catch { /* không phải JSON — dùng nguyên văn bên dưới */ }
                    if (res.status === 422 && detail) throw new Error(detail);
                    throw new Error(tv('Lỗi Server') + ' (' + res.status + '): ' + (detail || errorText));
                }
                const warningCodes = (res.headers.get('X-Upscale-Warnings') || '').split(',');
                if (warningCodes.includes('color-converted-to-srgb')) {
                    toast.info(tv('Ảnh CMYK đã được chuyển sang sRGB để xử lý.'));
                }
                // UIUX (audit 2026-08-10 §UP.X.05): cảnh báo khi ICC Gray/LAB bị
                // chuyển sang sRGB hoặc bị bỏ do không tương thích với output RGB.
                if (warningCodes.includes('icc-converted-to-srgb')) {
                    toast.info(tv('ICC profile gốc (Gray/LAB) đã được chuyển sang sRGB.'));
                }
                if (warningCodes.includes('icc-dropped-incompatible')) {
                    toast.info(tv('ICC profile gốc không tương thích RGB — đã bỏ. Kiểm tra lại màu trước khi in.'));
                }
                if (warningCodes.includes('bit-depth-reduced-to-8')) {
                    toast.info(tv('Ảnh 16-bit được xử lý ở 8-bit; hãy kiểm tra chuyển sắc trước khi in.'));
                }
                const outputSize = res.headers.get('X-Upscale-Output-Size') || '';
                const workingPdfPath = res.headers.get('X-Upscale-Working-Pdf-Path') || undefined;
                const artifactLease = res.headers.get('X-Upscale-Artifact-Lease') || undefined;
                const outBlob = await res.blob();
                const resultIdentity = tagUpscaleResultIdentity(outBlob, tabId, requestItem.id);
                const outUrl = URL.createObjectURL(outBlob);
                items[i] = {
                    ...items[i],
                    status: 'success',
                    resultBlob: outBlob,
                    resultIdentity,
                    resultUrl: outUrl,
                    resultInfo: (outputSize ? outputSize.replace('x', ' × ') + ' px · ' : '')
                        + '×' + options.scaleFactor + ' · ' + modeLabel(options.model),
                };
                store.setBatchItems(tabId, [...items]);
                if (onResultReady) {
                    try {
                        const committed = await onResultReady({
                            blob: outBlob,
                            name: upscaleOutputName(requestItem.fileName),
                            workingPdfPath,
                            artifactLease,
                            item: items[i],
                            items: [...items],
                        });
                        if (artifactLease) {
                            if (committed === true) {
                                try {
                                    await claimUpscaleArtifactLease(tabId, artifactLease);
                                } catch (leaseError) {
                                    console.error('[Upscale] Không claim được lease PDF làm việc:', leaseError);
                                    store.setError(
                                        tabId,
                                        tv('PDF làm việc chỉ được giữ tạm thời; hãy lưu kết quả nếu cần dùng lâu.'),
                                    );
                                }
                            } else {
                                void releaseUpscaleArtifactLease(artifactLease);
                            }
                        }
                    } catch (applyError) {
                        if (artifactLease) void releaseUpscaleArtifactLease(artifactLease);
                        // AI đã hoàn tất nên vẫn giữ kết quả để xem/lưu. Lỗi chỉ nằm
                        // ở bước đưa ảnh vào workspace kế tiếp, không được gắn nhãn
                        // sai rằng Upscale thất bại.
                        console.error('[Upscale] Không cập nhật được ảnh đang làm việc:', applyError);
                        store.setError(tabId, formatError(applyError, tv('Không thể dùng kết quả Upscale cho công cụ tiếp theo')));
                    }
                }
            } catch (error: unknown) {
                if (controller.signal.aborted) {
                    items[i] = {
                        ...items[i],
                        status: 'pending',
                        error: undefined,
                        resultInfo: undefined,
                    };
                    store.setBatchItems(tabId, [...items]);
                    break;
                }
                console.error('[Upscale] Error:', error);
                // UIUX (audit 2026-07-29 §NET.09): trước đây ném nguyên chuỗi của
                // trình duyệt ra giao diện, nên sidecar chưa lên xong hoặc vừa
                // restart thì người dùng chỉ thấy "Failed to fetch (localhost:8321)".
                // formatError dịch thành câu tiếng Việt kèm việc cần làm tiếp.
                items[i] = {
                    ...items[i],
                    status: 'error',
                    error: formatError(error, tv('Phóng to ảnh thất bại')),
                };
            }
            store.setBatchItems(tabId, [...items]);
        }
    } finally {
        if (upscaleControllers.get(tabId) === controller) upscaleControllers.delete(tabId);
        store.setProgress(tabId, '');
        store.setIsProcessing(tabId, false);
    }
}

function cancelBatch(tabId: string) {
    upscaleControllers.get(tabId)?.abort();
}

// UIUX (audit 2026-08-10 §UP.X.02): giải phóng toàn bộ tài nguyên của tab Upscale
// khi tab workspace bị đóng — abort controller, revoke URL, xóa state.
// eslint-disable-next-line react-refresh/only-export-components
export function disposeUpscaleTab(tabId: string): void {
    upscaleControllers.get(tabId)?.abort();
    upscaleControllers.delete(tabId);
    releaseUpscaleTabArtifacts(tabId);
    useUpscaleStore.getState().destroyTab(tabId);
}

async function handleSave(tabId: string) {
    const { saved, ok } = await saveBatch(tabId, useUpscaleStore, 'upscaled');
    if (!ok) toast.error(tv('Lỗi khi lưu file.'));
    else if (saved > 0) toast.success(`✅ ${tv('Đã lưu thành công')} ${saved} ${tv('ảnh!')}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIDEBAR — Rendered in the right settings panel
// ═══════════════════════════════════════════════════════════════════════════════

export default function UpscaleTool({
    tabId,
    pdfFile,
    sourceImageFile,
    sourceImageReferenceFile,
    getWorkingFile,
    activeWorkingPage = 1,
    onFileFixed,
}: Props) {
  const { t } = useTranslation();
    const tabState = useUpscaleStore(state => state.tabs[tabId] || defaultUpscaleTabState);
    const storeActions = useUpscaleStore.getState();
    const { batchItems, selectedId, options, isProcessing, progress, error } = tabState;

    const hasPending = batchItems.some(i => i.status === 'pending' || i.status === 'error');
    const hasSuccess = batchItems.some(i => i.status === 'success');

    const mountedRef = useRef(true);
    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            // UIUX (audit 2026-08-10 §UP.X.02): hủy inference khi unmount,
            // không để backend chạy vô ích khi user đã chuyển công cụ.
            cancelBatch(tabId);
        };
    }, [tabId]);

    // Ảnh shadow chỉ được dùng khi upstream xác nhận còn cùng revision. Khi prop
    // này về null sau rotate/reorder/edit, item workspace cũ trở thành placeholder
    // để lúc bấm Chạy raster đúng active Working page; file explicit không đổi.
    const workspaceInputKeyRef = useRef<string | null>(null);
    React.useEffect(() => {
        const store = useUpscaleStore.getState();
        store.initTab(tabId);
        if (isProcessing) return;
        const inputKey = sourceImageFile
            ? [tabId, 'image', filePath(sourceImageFile), sourceImageFile.name, sourceImageFile.size].join('|')
            : pdfFile
                ? [tabId, 'pdf', filePath(pdfFile), pdfFile.name, pdfFile.size, activeWorkingPage].join('|')
                : [tabId, '<none>'].join('|');
        if (workspaceInputKeyRef.current === inputKey) return;
        workspaceInputKeyRef.current = inputKey;
        const currentItems = store.getTab(tabId).batchItems;
        const workspaceItemIsCurrent = (item: BatchItem): boolean => {
            if (item.sourceOrigin !== 'workspace') return true;
            if (sourceImageFile) return isUpscaleInputAlreadyTracked([item], sourceImageFile);
            return !!pdfFile && item.sourceIdentity === inputKey;
        };
        for (const item of currentItems.filter(item => !workspaceItemIsCurrent(item))) {
            store.removeItem(tabId, item.id);
        }
        const remainingItems = store.getTab(tabId).batchItems;
        if (sourceImageFile) {
            if (isUpscaleInputAlreadyTracked(remainingItems, sourceImageFile)) return;
            void normalizeAndAddFiles([sourceImageFile], tabId, useUpscaleStore, {
                sourceOrigin: 'workspace',
            });
            return;
        }
        // Giữ đúng phạm vi cũ: PDF thuần không tự biến thành input Upscale. Chỉ
        // tạo placeholder khi workspace thật sự xuất phát từ một ảnh đã normalize.
        if (!pdfFile || !getWorkingFile || !sourceImageReferenceFile) return;
        if (remainingItems.some(item => item.sourceOrigin === 'workspace' && item.sourceIdentity === inputKey)) return;
        // Không đọc/raster PDF trong effect. Resolver của nút Chạy mới
        // materialize revision và raster đúng vị trí trang đang xem.
        store.addItems(tabId, [{
            id: 'workspace-pdf-' + Math.random().toString(36).slice(2),
            path: 'browser-file',
            fileName: (pdfFile.name.replace(/\.pdf$/i, '') || 'tai_lieu') + '_trang_' + activeWorkingPage + '.png',
            originalUrl: UPSCALE_WORKING_PAGE_PLACEHOLDER,
            status: 'pending',
            sourceOrigin: 'workspace',
            sourceIdentity: inputKey,
        }]);
    }, [activeWorkingPage, getWorkingFile, isProcessing, pdfFile, sourceImageFile, sourceImageReferenceFile, tabId]);

    React.useEffect(() => {
        const handleExternalFiles = (event: Event) => {
            const detail = (event as CustomEvent<{ tabId?: string; files?: File[] }>).detail;
            if (detail?.tabId !== tabId || !detail.files?.length) return;
            void normalizeAndAddFiles(detail.files, tabId, useUpscaleStore);
        };

        // NAV (audit điều hướng tab 2026-07-28 §DROP.01): Tauri phát path qua
        // tuyến native, không đi vào dataTransfer.files của vùng preview.
        window.addEventListener(IMAGE_BATCH_DROP_EVENTS.upscale, handleExternalFiles);
        return () => {
            window.removeEventListener(IMAGE_BATCH_DROP_EVENTS.upscale, handleExternalFiles);
        };
    }, [tabId]);

    // PERF/REVISION (audit 2026-08-25 §REV.06): không tự warm model khi mở
    // panel. Health gate, raster Working page và inference chỉ bắt đầu sau nút Chạy.
    const setOption = <K extends keyof typeof options>(key: K, val: (typeof options)[K]) => {
        if (options[key] === val) return;
        // UIUX (audit 2026-07-28 §UP-04): cấu hình đổi thì kết quả cũ không còn
        // đúng hợp đồng. Thu hồi URL và buộc chạy lại thay vì lưu nhầm ảnh cũ.
        storeActions.setBatchItems(tabId, batchItems.map(item => {
            if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
            return {
                ...item,
                status: 'pending' as const,
                resultBlob: undefined,
                resultIdentity: undefined,
                resultUrl: undefined,
                resultInfo: undefined,
                error: undefined,
            };
        }));
        storeActions.setOptions(tabId, { ...options, [key]: val });
    };

    const handleResultReady = React.useCallback<UpscaleResultReady>(async ({ blob, name, workingPdfPath, item, items }) => {
        if (!mountedRef.current || !onFileFixed) return false;
        if (!shouldPromoteUpscaleResult(items, item, sourceImageFile)) return false;
        // UIUX (feedback 2026-08-10 §UP.WORKING.1): kết quả trở thành ảnh đang
        // làm việc ngay; người dùng có thể chuyển thẳng sang Bù xén/Tạo đường cắt.
        await onFileFixed(blob, name, workingPdfPath);
        return true;
    }, [onFileFixed, sourceImageFile]);
    const shouldPrepareWorkingPdf = React.useCallback<UpscaleWorkingPdfPolicy>(
        (item, items) => shouldPromoteUpscaleResult(items, item, sourceImageFile),
        [sourceImageFile],
    );
    const resolveSource = React.useCallback<UpscaleSourceResolver>(async (item, _items, signal) => {
        if (item.sourceOrigin !== 'workspace' || sourceImageFile) return undefined;
        if (!pdfFile || !getWorkingFile || !sourceImageReferenceFile) {
            throw new Error(tv('Không tìm thấy PDF làm việc hiện tại để phóng to.'));
        }
        // PERF/REVISION (audit 2026-08-25 §REV.06): không warm/raster nền.
        // Chỉ materialize đúng revision khi người dùng bấm Chạy.
        const workingFile = await getWorkingFile();
        const referenceBytes = await getFileArrayBuffer(sourceImageReferenceFile);
        if (signal.aborted) throw new DOMException('Đã hủy chuẩn bị ảnh Upscale.', 'AbortError');
        const sourceDensity = sourceImagePixelsPerPdfPoint(
            referenceBytes,
            sourceImageReferenceFile.name,
        );
        return rasterizeUpscaleWorkingPage(
            workingFile,
            activeWorkingPage,
            signal,
            sourceDensity,
        );
    }, [activeWorkingPage, getWorkingFile, pdfFile, sourceImageFile, sourceImageReferenceFile]);
    const handleUndoSelected = React.useCallback(async () => {
        if (!selectedId) return;
        const item = batchItems.find(candidate => candidate.id === selectedId);
        if (!item) return;
        const isCurrentWorkingResult = isCurrentUpscaleWorkingResult(tabId, item, sourceImageFile);
        if (isCurrentWorkingResult && onFileFixed && item.fileObj) {
            const originalPath = item.path && item.path !== 'browser-file' ? item.path : undefined;
            try {
                await onFileFixed(item.fileObj, item.fileName, originalPath);
            } catch (undoError) {
                toast.error(formatError(undoError, tv('Không thể khôi phục ảnh gốc')));
                return;
            }
        }
        storeActions.undoItem(tabId, selectedId);
    }, [batchItems, onFileFixed, selectedId, sourceImageFile, storeActions, tabId]);

    return (
        <div className="flex flex-col gap-3 animate-in fade-in duration-300">
            {/* Batch Thumbnails */}
            {batchItems.length > 0 && (
                <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-thin flex-wrap">
                    {batchItems.map(item => (
                        <div key={item.id} onClick={() => storeActions.setSelectedId(tabId, item.id)}
                            className={`relative shrink-0 w-14 h-14 rounded-lg overflow-hidden cursor-pointer border-2 transition-all ${
                                selectedId === item.id ? 'border-indigo-500 ring-2 ring-indigo-300'
                                : 'border-slate-200 dark:border-zinc-700 hover:border-slate-400'}`}>
                            <img src={item.resultUrl || item.originalUrl} alt={item.fileName}
                                className="w-full h-full object-cover" draggable={false} />
                            <div className={`absolute bottom-0 left-0 right-0 text-center text-[8px] font-bold py-[1px] ${
                                item.status === 'success' ? 'bg-emerald-500 text-white'
                                : item.status === 'processing' ? 'bg-amber-500 text-white'
                                : item.status === 'error' ? 'bg-red-500 text-white'
                                : 'bg-slate-400/80 text-white'}`}>
                                {item.status === 'success' ? '✓' : item.status === 'processing' ? '⏳' : item.status === 'error' ? '✗' : '•'}
                            </div>
                            <button onClick={e => { e.stopPropagation(); storeActions.removeItem(tabId, item.id); }}
                                className="absolute top-0 right-0 w-4 h-4 bg-red-500 text-white text-[8px] rounded-bl flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity">×</button>
                        </div>
                    ))}
                    <div onClick={() => openFilePicker(tabId, useUpscaleStore)}
                        className="shrink-0 w-14 h-14 rounded-lg border-2 border-dashed border-slate-300 dark:border-zinc-600 flex items-center justify-center cursor-pointer hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors">
                        <span className="text-lg text-slate-400">+</span>
                    </div>
                </div>
            )}

            {/* Options */}
            <div>
                <ToolSectionLabel>{t('preprocess.upscale:che_do_ai')}</ToolSectionLabel>
                <select
                    value={options.model}
                    disabled={isProcessing}
                    onChange={(e) => setOption('model', e.target.value as 'quality' | 'balanced' | 'general')}
                    className="w-full h-10 mt-1 bg-white dark:bg-[#27272a] border border-slate-200 dark:border-white/10 rounded-lg px-3 text-[13px] font-medium text-slate-700 dark:text-zinc-200 outline-none"
                >
                    <option value="balanced">{t('preprocess.upscale:model_can_bang')}</option>
                    <option value="general">{t('preprocess.upscale:model_nhanh')}</option>
                    <option value="quality">{t('preprocess.upscale:model_chat_luong')}</option>
                </select>
                <p className="mt-1 text-[11px] text-slate-500 dark:text-zinc-400">
                    {options.model === 'quality'
                        ? t('preprocess.upscale:model_chat_luong_goi_y')
                        : options.model === 'balanced'
                            ? t('preprocess.upscale:model_can_bang_goi_y')
                            : t('preprocess.upscale:model_nhanh_goi_y')}
                </p>
            </div>

            <div>
                <ToolSectionLabel>{t('preprocess.upscale:muc_do_phong_to_upscale_factor')}</ToolSectionLabel>
                <select
                    value={options.scaleFactor}
                    disabled={isProcessing}
                    onChange={(e) => setOption('scaleFactor', parseInt(e.target.value) as 2 | 4)}
                    className="w-full h-10 mt-1 bg-white dark:bg-[#27272a] border border-slate-200 dark:border-white/10 rounded-lg px-3 text-[13px] font-medium text-slate-700 dark:text-zinc-200 outline-none"
                >
                    <option value={2}>{t('preprocess.upscale:gap_2_lan_2x')}</option>
                    <option value={4}>{t('preprocess.upscale:gap_4_lan_4x')}</option>
                </select>
            </div>

            <div className="flex flex-col gap-2">
                <button onClick={() => processUpscaleBatch(
                    tabId,
                    handleResultReady,
                    shouldPrepareWorkingPdf,
                    resolveSource,
                )} disabled={isProcessing || !hasPending}
                    className={`w-full h-11 rounded-xl text-[13px] font-bold transition-all flex items-center justify-center gap-2 shadow-sm ${
                        isProcessing || !hasPending
                        ? 'bg-slate-300 text-slate-500 cursor-not-allowed dark:bg-zinc-700 dark:text-zinc-400'
                        : 'bg-indigo-600 hover:bg-indigo-700 text-white'}`}>
                    {t('preprocess.common:run')}{isProcessing ? '…' : ''}
                </button>
                {isProcessing && (
                    <button onClick={() => cancelBatch(tabId)}
                        className="w-full h-10 rounded-xl text-[13px] font-bold bg-rose-600 hover:bg-rose-700 text-white transition-colors">
                        {t('preprocess.upscale:huy_xu_ly')}
                    </button>
                )}
                {hasSuccess && (
                    <div className="flex gap-2">
                        <button onClick={() => handleSave(tabId)}
                            className="flex-1 h-11 rounded-xl text-[13px] font-bold bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm flex items-center justify-center gap-2 transition-all">
                            💾 {t('preprocess.upscale:luu_tat_ca')} ({batchItems.filter(i => i.status === 'success').length})
                        </button>
                        {batchItems.find(i => i.id === selectedId)?.status === 'success' && (
                            <button onClick={() => void handleUndoSelected()} title={t('preprocess.upscale:hoan_tac_de_chinh_sua_lai')}
                                className="px-4 h-11 rounded-xl text-[13px] font-bold bg-amber-500 hover:bg-amber-600 text-white shadow-sm flex items-center justify-center gap-1.5 transition-all">
                                <RotateCcw className="w-4 h-4" /> {t('preprocess.upscale:hoan_tac')}
                            </button>
                        )}
                    </div>
                )}
            </div>

            {progress && (
                <div className="flex items-center gap-3 bg-indigo-50 dark:bg-indigo-900/20 p-3 rounded-lg border border-indigo-200 dark:border-indigo-800/50">
                    <div className="w-5 h-5 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin shrink-0" />
                    <span className="text-[12px] text-indigo-700 dark:text-indigo-300 font-medium">{progress}</span>
                </div>
            )}
            {error && (
                <div className="bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-200 dark:border-red-800/50">
                    <span className="text-[12px] text-red-600 dark:text-red-400 font-medium">❌ {error}</span>
                </div>
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PREVIEW — Rendered in the MAIN content area
// ═══════════════════════════════════════════════════════════════════════════════

export function UpscalePreview({ tabId, isActive }: { tabId: string; isActive: boolean }) {
  const { t } = useTranslation();
    return (
        <ImageBatchPreview
            tabId={tabId}
            isActive={isActive}
            store={useUpscaleStore}
            labels={{
                resultBadge: t('preprocess.upscale:da_phong_to'),
                originalBadge: t('preprocess.upscale:anh_goc'),
                emptyTitle: t('preprocess.upscale:phong_to_anh_ai'),
                emptyHint: <>{t('preprocess.upscale:keo_tha_anh_vao_day_hoac_bam_de_chon')}<br/>{t('preprocess.upscale:ho_tro_jpg_png_tiff_webp_bmp')}</>,
                emptyIcon: '🪄',
                processingText: t('preprocess.upscale:dang_phong_to_anh'),
            }}
        />
    );
}
