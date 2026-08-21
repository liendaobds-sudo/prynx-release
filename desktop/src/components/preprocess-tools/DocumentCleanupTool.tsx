import React, { useMemo, useRef, useState } from 'react';
import { Maximize2, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';

import { authenticatedFetch, getApiUrl } from '../../lib/api';
import { formatError } from '../../lib/errorMessages';
import { appendImagePageToPdfDoc } from '../../lib/imageNormalizer';
import { IMAGE_BATCH_DROP_EVENTS } from '../../lib/tabNavigation';
import { tv } from '../../i18n';
import { toast } from '../ui/Toast';
import { invalidateBatchResults, type BatchItem } from './imageBatch/store';
import { normalizeAndAddFiles, openFilePicker, saveBatch } from './imageBatch/helpers';
import {
    defaultDocumentCleanupTabState,
    type CardDetectionState,
    type DocumentCleanupOptions,
    type NormalizedPoint,
    useDocumentCleanupStore,
} from './useDocumentCleanupStore';


interface Props {
    tabId: string;
    pdfFile: File | null;
    sourceImageFile?: File | null;
    /** PDF đã bake thứ tự/xoay trang hiện tại của AcrobatViewer. */
    getWorkingFile?: () => Promise<File>;
    onFileFixed?: (blob: Blob, name: string, path?: string) => void | boolean | Promise<void | boolean>;
}

const cleanupControllers = new Map<string, AbortController>();
// DOC-CLEANUP UIUX (2026-08-20): POST vẫn truyền file một lần; job ID chỉ dùng
// để đọc tiến độ từng trang và gửi lệnh hủy tới sidecar trong lúc POST đang chạy.
const cleanupJobIds = new Map<string, string>();

interface CleanupJobProgress {
    current: number;
    total: number;
    phase: string;
    terminal: boolean;
}

function createCleanupJobId(): string {
    return globalThis.crypto?.randomUUID?.() || `cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function pollCleanupJob(
    tabId: string,
    jobId: string,
    controller: AbortController,
    startedAt: number,
    active: { value: boolean },
): Promise<void> {
    while (active.value && !controller.signal.aborted) {
        try {
            const response = await authenticatedFetch(`${getApiUrl()}/document-cleanup/jobs/${jobId}`, {
                signal: controller.signal,
            });
            if (response.ok) {
                const status = await response.json() as CleanupJobProgress;
                const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
                const pageProgress = status.total > 0
                    ? `${tv('Đang làm sạch trang')} ${status.current} / ${status.total}`
                    : tv('Đang chuẩn bị PDF…');
                useDocumentCleanupStore.getState().setProgress(
                    tabId,
                    `${pageProgress} · ${elapsedSeconds} ${tv('giây')}`,
                );
                if (status.terminal) return;
            }
        } catch {
            if (controller.signal.aborted) return;
            // Request xử lý có thể chưa kịp đăng ký job; lần poll kế tiếp sẽ lấy được.
        }
        await new Promise(resolve => window.setTimeout(resolve, 450));
    }
}

function cancelDocumentCleanup(tabId: string): void {
    const jobId = cleanupJobIds.get(tabId);
    if (jobId) {
        void authenticatedFetch(`${getApiUrl()}/document-cleanup/jobs/${jobId}/cancel`, {
            method: 'POST',
        }).catch(() => undefined);
    }
    cleanupControllers.get(tabId)?.abort();
}

function sourceKey(file: File): string {
    const path = 'path' in file && typeof file.path === 'string' ? file.path : '';
    return `${path}|${file.name}|${file.size}`;
}

function cleanupRequestKey(options: DocumentCleanupOptions, itemId: string): string {
    if (options.operation === 'scan') {
        return JSON.stringify([
            options.operation,
            options.outputDpi,
            options.scanMode,
            options.strength,
            options.removeShadows,
            options.deskew,
        ]);
    }
    return JSON.stringify([
        options.operation,
        options.outputDpi,
        options.cardRatio,
        options.customWidthMm,
        options.customHeightMm,
        options.detections[itemId]?.points || [],
    ]);
}

interface WorkingPdfSource {
    sourceFile: File;
    getWorkingFile: () => Promise<File>;
}

type CleanupResultReady = (result: {
    blob: Blob;
    name: string;
    item: BatchItem;
    items: BatchItem[];
}) => boolean | void | Promise<boolean | void>;

const DOCUMENT_CLEANUP_RESULT_ID_PROPERTY = '__prynxDocumentCleanupResultId';
type DocumentCleanupResultCarrier = Blob & { __prynxDocumentCleanupResultId?: string };

function documentCleanupResultIdentity(tabId: string, itemId: string): string {
    return JSON.stringify([tabId, itemId]);
}

function readDocumentCleanupResultIdentity(value?: Blob | null): string | undefined {
    const identity = (value as DocumentCleanupResultCarrier | null | undefined)?.[
        DOCUMENT_CLEANUP_RESULT_ID_PROPERTY
    ];
    return typeof identity === 'string' && identity.length > 0 ? identity : undefined;
}

// eslint-disable-next-line react-refresh/only-export-components
export function tagDocumentCleanupResultIdentity(value: Blob, tabId: string, itemId: string): string {
    const identity = documentCleanupResultIdentity(tabId, itemId);
    Object.defineProperty(value, DOCUMENT_CLEANUP_RESULT_ID_PROPERTY, {
        value: identity,
        configurable: true,
    });
    return identity;
}

// Giữ token khi ImpositionTab bọc Blob ảnh kết quả thành File nguồn mới.
// eslint-disable-next-line react-refresh/only-export-components
export function copyDocumentCleanupResultIdentity(source: Blob, target: Blob): void {
    const identity = readDocumentCleanupResultIdentity(source);
    if (!identity) return;
    Object.defineProperty(target, DOCUMENT_CLEANUP_RESULT_ID_PROPERTY, {
        value: identity,
        configurable: true,
    });
}

function filePath(file: File): string {
    return 'path' in file && typeof file.path === 'string' ? file.path : '';
}

function isSameBatchSource(item: BatchItem, file: File): boolean {
    const path = filePath(file);
    if (path && item.sourceIdentity === `path:${path}`) return true;
    if (path && item.path === path) return true;
    return !path && item.fileName === file.name && item.fileObj === file;
}

// eslint-disable-next-line react-refresh/only-export-components
export function isDocumentCleanupInputAlreadyTracked(items: BatchItem[], inputFile: File): boolean {
    const resultIdentity = readDocumentCleanupResultIdentity(inputFile);
    return items.some(item => (
        isSameBatchSource(item, inputFile)
        || (!!resultIdentity && item.resultIdentity === resultIdentity)
    ));
}

function isCurrentDocumentCleanupWorkingResult(
    tabId: string,
    item: BatchItem,
    sourceImageFile?: File | null,
): boolean {
    if (!sourceImageFile || !item.resultIdentity) return false;
    return item.resultIdentity === documentCleanupResultIdentity(tabId, item.id)
        && readDocumentCleanupResultIdentity(sourceImageFile) === item.resultIdentity;
}

// eslint-disable-next-line react-refresh/only-export-components
export function documentCleanupOutputName(
    fileName: string,
    operation: DocumentCleanupOptions['operation'],
    mimeType: string,
): string {
    const stem = fileName.replace(/\.[^/.]+$/, '') || 'tai_lieu';
    const prefix = operation === 'card' ? 'nan_thang' : 'scan_sach';
    const extension = mimeType === 'application/pdf'
        ? 'pdf'
        : mimeType === 'image/jpeg'
            ? 'jpg'
            : mimeType === 'image/webp'
                ? 'webp'
                : 'png';
    return `${prefix}_${stem}.${extension}`;
}

// eslint-disable-next-line react-refresh/only-export-components
export async function buildDocumentCleanupBatchArtifact(
    items: readonly BatchItem[],
    operation: DocumentCleanupOptions['operation'],
): Promise<{ blob: Blob; name: string; pageCount: number }> {
    if (items.length === 0 || items.some(item => !item.resultBlob)) {
        throw new Error(tv('Chưa xử lý xong toàn bộ tài liệu.'));
    }

    if (items.length === 1) {
        const item = items[0];
        const blob = item.resultBlob!;
        let pageCount = 1;
        if (blob.type === 'application/pdf') {
            const { PDFDocument } = await import('pdf-lib');
            pageCount = (await PDFDocument.load(await blob.arrayBuffer())).getPageCount();
        }
        return {
            blob,
            name: documentCleanupOutputName(item.fileName, operation, blob.type),
            pageCount,
        };
    }

    // UIUX (feedback 2026-08-21 §DOC.HANDOFF.02): batch là một tài liệu nhiều
    // trang khi đi sang Viewer/Bình bản. Giữ đúng thứ tự thumbnail và không xuất
    // artifact thiếu trang nếu một item chưa có kết quả.
    const { PDFDocument } = await import('pdf-lib');
    const output = await PDFDocument.create();
    for (const item of items) {
        const result = item.resultBlob!;
        const resultName = documentCleanupOutputName(item.fileName, operation, result.type);
        const bytes = await result.arrayBuffer();
        if (result.type === 'application/pdf') {
            const source = await PDFDocument.load(bytes);
            const pages = await output.copyPages(source, source.getPageIndices());
            for (const page of pages) output.addPage(page);
        } else if (result.type.startsWith('image/')) {
            await appendImagePageToPdfDoc(output, bytes, resultName);
        } else {
            throw new Error(tv('Kết quả có định dạng không thể đưa vào PDF làm việc.'));
        }
    }
    const pageCount = output.getPageCount();
    if (pageCount === 0) throw new Error(tv('Không có trang kết quả để tạo PDF làm việc.'));
    const pdfBytes = await output.save();
    const prefix = operation === 'card' ? 'nan_thang' : 'scan_sach';
    return {
        blob: new Blob([pdfBytes as unknown as BlobPart], { type: 'application/pdf' }),
        name: `${prefix}_${pageCount}_trang.pdf`,
        pageCount,
    };
}

function isWorkspacePdfItem(item: BatchItem, sourceFile: File): boolean {
    if (item.fileObj === sourceFile) return true;
    const sourcePath = 'path' in sourceFile && typeof sourceFile.path === 'string'
        ? sourceFile.path
        : '';
    return !!sourcePath && item.path === sourcePath;
}

function isPdfName(name: string): boolean {
    return /\.pdf$/i.test(name);
}

// eslint-disable-next-line react-refresh/only-export-components
export function shouldShowDocumentCleanupOverlay(hasPdfFile: boolean, hasSourceImage: boolean): boolean {
    return !hasPdfFile || hasSourceImage;
}

function switchToScanForPdf(tabId: string, files: File[]): void {
    if (!files.some(file => file.type === 'application/pdf' || isPdfName(file.name))) return;
    const store = useDocumentCleanupStore.getState();
    const tab = store.getTab(tabId);
    if (tab.options.operation !== 'scan') {
        store.setOptions(tabId, { ...tab.options, operation: 'scan' });
    }
}

async function readApiError(response: Response): Promise<string> {
    const text = await response.text();
    try {
        const parsed = JSON.parse(text) as { detail?: string };
        return parsed.detail || text || tv('Không xử lý được tài liệu');
    } catch {
        return text || tv('Không xử lý được tài liệu');
    }
}

function appendSource(formData: FormData, item: BatchItem, sourceFile = item.fileObj): void {
    if (sourceFile && sourceFile.size > 0) {
        formData.append('file', sourceFile, item.fileName);
        return;
    }
    throw new Error(tv('Không đọc được ảnh gốc; hãy chọn lại file.'));
}

async function resolveProcessingSource(
    item: BatchItem,
    workingPdfSource?: WorkingPdfSource,
): Promise<File | undefined> {
    if (!workingPdfSource || !isPdfName(item.fileName) || !isWorkspacePdfItem(item, workingPdfSource.sourceFile)) {
        return item.fileObj;
    }
    // DOC-CLEANUP FIX (2026-08-20): xóa/xoay/sắp trang trong viewer chỉ là state
    // đến lúc xuất. Không được gửi file gốc vì backend sẽ làm sạch lại các trang đã xóa.
    const workingFile = await workingPdfSource.getWorkingFile();
    // Tauri có thể giữ File nguồn chỉ mang path, size = 0. Khi viewer không có
    // thay đổi, callback trả lại đúng object đó; bytes đã chuẩn hóa trong batch
    // mới là dữ liệu upload được. Bản bake sau chỉnh trang luôn là File mới có bytes.
    if (workingFile === workingPdfSource.sourceFile && workingFile.size === 0 && item.fileObj?.size) {
        return item.fileObj;
    }
    return workingFile;
}

async function requestCardDetection(item: BatchItem, signal: AbortSignal): Promise<CardDetectionState> {
    const formData = new FormData();
    appendSource(formData, item);
    formData.append('use_ai', 'true');
    const response = await authenticatedFetch(`${getApiUrl()}/document-cleanup/detect-card`, {
        method: 'POST',
        body: formData,
        signal,
    });
    if (!response.ok) throw new Error(await readApiError(response));
    const payload = await response.json() as {
        points: NormalizedPoint[];
        confidence: number;
        needs_review: boolean;
        method: string;
    };
    return {
        points: payload.points,
        confidence: payload.confidence,
        needsReview: payload.needs_review,
        method: payload.method,
    };
}

function updateDetection(tabId: string, itemId: string, detection: CardDetectionState): void {
    const store = useDocumentCleanupStore.getState();
    const tab = store.getTab(tabId);
    store.setOptions(tabId, {
        ...tab.options,
        detections: { ...tab.options.detections, [itemId]: detection },
    });
}

// eslint-disable-next-line react-refresh/only-export-components
export async function detectSelectedDocumentCard(tabId: string): Promise<void> {
    const store = useDocumentCleanupStore.getState();
    const tab = store.getTab(tabId);
    const item = tab.batchItems.find(current => current.id === tab.selectedId);
    if (!item) return;
    const controller = new AbortController();
    cleanupControllers.get(tabId)?.abort();
    cleanupControllers.set(tabId, controller);
    store.setError(tabId, '');
    store.setIsProcessing(tabId, true);
    store.setProgress(tabId, tv('Đang nhận diện bốn góc thẻ…'));
    try {
        const detection = await requestCardDetection(item, controller.signal);
        updateDetection(tabId, item.id, detection);
    } catch (error) {
        if (!controller.signal.aborted) {
            store.setError(tabId, formatError(error, tv('Không nhận diện được bốn góc thẻ')));
        }
    } finally {
        if (cleanupControllers.get(tabId) === controller) {
            cleanupControllers.delete(tabId);
            store.setProgress(tabId, '');
            store.setIsProcessing(tabId, false);
        }
    }
}

// eslint-disable-next-line react-refresh/only-export-components
export async function processDocumentCleanupBatch(
    tabId: string,
    onResultReady?: CleanupResultReady,
    workingPdfSource?: WorkingPdfSource,
): Promise<void> {
    const store = useDocumentCleanupStore.getState();
    const initial = store.getTab(tabId);
    const options = initial.options;
    const items = [...initial.batchItems];
    const controller = new AbortController();
    cleanupControllers.get(tabId)?.abort();
    cleanupControllers.set(tabId, controller);
    store.setError(tabId, '');
    store.setIsProcessing(tabId, true);
    let done = 0;
    const pendingCount = items.filter(item => item.status !== 'success').length;
    let detections = { ...options.detections };
    try {
        for (let index = 0; index < items.length; index += 1) {
            if (items[index].status === 'success') continue;
            if (controller.signal.aborted) break;
            done += 1;
            const item = items[index];
            const isPdf = isPdfName(item.fileName);
            items[index] = { ...item, status: 'processing', error: undefined };
            store.setBatchItems(tabId, [...items]);
            store.setProgress(tabId, `${tv('Đang xử lý')} ${done} / ${pendingCount}…`);
            try {
                if (options.operation === 'card' && isPdfName(item.fileName)) {
                    throw new Error(tv('PDF chỉ dùng được với chế độ Làm trắng scan.'));
                }
                if (options.operation === 'card' && !detections[item.id]) {
                    store.setProgress(tabId, `${tv('Đang nhận diện thẻ')} ${done} / ${pendingCount}…`);
                    const detected = await requestCardDetection(item, controller.signal);
                    detections = { ...detections, [item.id]: detected };
                    store.setOptions(tabId, { ...options, detections });
                }
                const requestKey = cleanupRequestKey({ ...options, detections }, item.id);
                const formData = new FormData();
                appendSource(formData, item, await resolveProcessingSource(item, workingPdfSource));
                formData.append('operation', options.operation);
                let jobId: string | null = null;
                if (options.operation === 'card') {
                    formData.append('points_json', JSON.stringify(detections[item.id]?.points || []));
                    formData.append('card_ratio', options.cardRatio);
                    formData.append('custom_width_mm', String(options.customWidthMm));
                    formData.append('custom_height_mm', String(options.customHeightMm));
                    formData.append('output_dpi', String(options.outputDpi));
                    formData.append('use_ai', 'true');
                } else {
                    formData.append('output_dpi', String(options.outputDpi));
                    formData.append('scan_mode', options.scanMode);
                    formData.append('strength', String(options.strength));
                    formData.append('remove_shadows', String(options.removeShadows));
                    formData.append('deskew', String(options.deskew));
                    if (isPdf) {
                        jobId = createCleanupJobId();
                        cleanupJobIds.set(tabId, jobId);
                        formData.append('job_id', jobId);
                    }
                }
                const pollState = { value: !!jobId };
                const pollPromise = jobId
                    ? pollCleanupJob(tabId, jobId, controller, Date.now(), pollState)
                    : Promise.resolve();
                let response: Response;
                try {
                    response = await authenticatedFetch(`${getApiUrl()}/document-cleanup/process`, {
                        method: 'POST',
                        body: formData,
                        signal: controller.signal,
                    });
                } finally {
                    pollState.value = false;
                    await pollPromise;
                    if (jobId && cleanupJobIds.get(tabId) === jobId) cleanupJobIds.delete(tabId);
                }
                if (!response.ok) throw new Error(await readApiError(response));
                const blob = await response.blob();
                if (cleanupRequestKey(store.getTab(tabId).options, item.id) !== requestKey) {
                    const currentItems = store.getTab(tabId).batchItems.map(current => (
                        current.id === item.id
                            ? { ...current, status: 'pending' as const, error: undefined }
                            : current
                    ));
                    store.setBatchItems(tabId, currentItems);
                    store.setError(tabId, tv('Thiết lập đã thay đổi trong lúc xử lý. Hãy bấm Xử lý lại.'));
                    return;
                }
                const outputName = documentCleanupOutputName(item.fileName, options.operation, blob.type);
                const resultIdentity = tagDocumentCleanupResultIdentity(blob, tabId, item.id);
                const candidateItem: BatchItem = {
                    ...items[index],
                    // Ghi token ngay khi có artifact, nhưng vẫn giữ trạng thái
                    // processing cho tới khi workspace xác nhận commit xong. Nếu
                    // callback làm parent rerender, effect dedupe đã thấy token.
                    status: 'processing',
                    resultBlob: blob,
                    resultIdentity,
                };
                const candidateItems = [...items];
                candidateItems[index] = candidateItem;
                items[index] = candidateItem;
                store.setBatchItems(tabId, [...items]);
                let appliedToWorkspace = false;
                if (onResultReady) {
                    const committed = await onResultReady({
                        blob,
                        name: outputName,
                        item: candidateItem,
                        items: candidateItems,
                    });
                    if (committed === false) {
                        throw new Error(tv('Kết quả chưa được cập nhật vào khung xem.'));
                    }
                    appliedToWorkspace = committed === true;
                }
                const resultUrl = URL.createObjectURL(blob);
                items[index] = {
                    ...candidateItem,
                    status: 'success',
                    resultUrl,
                    resultInfo: options.operation === 'card'
                        ? `${tv('Đã nắn thẳng theo tỷ lệ thẻ')}${appliedToWorkspace ? ` · ${tv('Có thể chuyển thẳng sang công cụ khác')}` : ''}`
                        : `${tv('Đã làm sạch nền scan')}${appliedToWorkspace ? ` · ${tv('Có thể chuyển thẳng sang công cụ khác')}` : ''}`,
                };
                if (appliedToWorkspace && items.length > 1) {
                    const batchInfo = options.operation === 'card'
                        ? `${tv('Đã nắn thẳng theo tỷ lệ thẻ')} · ${tv('Có thể chuyển thẳng sang công cụ khác')}`
                        : `${tv('Đã làm sạch nền scan')} · ${tv('Có thể chuyển thẳng sang công cụ khác')}`;
                    for (let resultIndex = 0; resultIndex < items.length; resultIndex += 1) {
                        if (items[resultIndex].resultBlob) {
                            items[resultIndex] = { ...items[resultIndex], resultInfo: batchInfo };
                        }
                    }
                }
            } catch (error) {
                if (controller.signal.aborted) {
                    items[index] = { ...items[index], status: 'pending', error: undefined };
                    break;
                }
                const message = formatError(error, tv('Không xử lý được tài liệu'));
                items[index] = { ...items[index], status: 'error', error: message };
                store.setError(tabId, message);
            }
            store.setBatchItems(tabId, [...items]);
        }
    } finally {
        if (cleanupControllers.get(tabId) === controller) {
            cleanupControllers.delete(tabId);
            store.setProgress(tabId, '');
            store.setIsProcessing(tabId, false);
        }
    }
}

// eslint-disable-next-line react-refresh/only-export-components
export function disposeDocumentCleanupTab(tabId: string): void {
    cancelDocumentCleanup(tabId);
    cleanupControllers.delete(tabId);
    cleanupJobIds.delete(tabId);
    useDocumentCleanupStore.getState().destroyTab(tabId);
}

function setOptionsAndInvalidate(tabId: string, next: DocumentCleanupOptions): void {
    const store = useDocumentCleanupStore.getState();
    const tab = store.getTab(tabId);
    store.setBatchItems(tabId, invalidateBatchResults(tab.batchItems));
    store.setOptions(tabId, next);
    store.setError(tabId, '');
}

function receiveDocumentCleanupFiles(tabId: string, files: File[]): void {
    if (!files.length) return;
    const store = useDocumentCleanupStore.getState();
    if (store.getTab(tabId).isProcessing) return;
    switchToScanForPdf(tabId, files);
    void normalizeAndAddFiles(files, tabId, useDocumentCleanupStore, { allowPdf: true });
}

/**
 * UIUX (feedback 2026-08-21 §DOC.VIEW.01): bộ nhận file phải sống cùng workspace,
 * không nằm trong panel thông số có thể bị thu gọn. Component này luôn được mount
 * khi công cụ đang mở nên file native không còn bị rơi mất lúc đóng sidebar.
 */
export function DocumentCleanupDropReceiver({ tabId, isActive }: { tabId: string; isActive: boolean }) {
    React.useEffect(() => {
        if (!isActive) return;
        const receiveFiles = (event: Event) => {
            const detail = (event as CustomEvent<{ tabId?: string; files?: File[] }>).detail;
            if (detail?.tabId !== tabId || !detail.files?.length) return;
            receiveDocumentCleanupFiles(tabId, detail.files);
        };
        window.addEventListener(IMAGE_BATCH_DROP_EVENTS.document_cleanup, receiveFiles);
        return () => window.removeEventListener(IMAGE_BATCH_DROP_EVENTS.document_cleanup, receiveFiles);
    }, [isActive, tabId]);
    return null;
}

export default function DocumentCleanupTool({ tabId, pdfFile, sourceImageFile, getWorkingFile, onFileFixed }: Props) {
    const tab = useDocumentCleanupStore(state => state.tabs[tabId] || defaultDocumentCleanupTabState);
    const store = useDocumentCleanupStore.getState();
    const { batchItems, selectedId, options, isProcessing, progress, error } = tab;
    const added = useRef(new Set<string>());
    const mountedRef = useRef(true);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            // Đổi công cụ trong lúc job còn chạy không được để response muộn
            // thay tài liệu mà người dùng đang thao tác ở công cụ mới.
            cancelDocumentCleanup(tabId);
        };
    }, [tabId]);

    React.useEffect(() => {
        store.initTab(tabId);
        if (store.getTab(tabId).isProcessing) return;
        const input = sourceImageFile || pdfFile;
        if (!input || !(input.type.startsWith('image/') || input.type === 'application/pdf' || /\.(png|jpe?g|webp|tiff?|bmp|pdf)$/i.test(input.name))) return;
        const currentItems = store.getTab(tabId).batchItems;
        // UIUX (feedback 2026-08-21 §DOC.HANDOFF.01): ảnh/PDF kết quả đã được
        // commit lại workspace không được ingest thành thumbnail pending thứ hai,
        // kể cả khi người dùng rời công cụ rồi quay lại.
        if (isDocumentCleanupInputAlreadyTracked(currentItems, input)) return;
        if (!sourceImageFile && currentItems.length > 0) return;
        const key = sourceKey(input);
        if (added.current.has(key)) return;
        added.current.add(key);
        switchToScanForPdf(tabId, [input]);
        void normalizeAndAddFiles([input], tabId, useDocumentCleanupStore, { allowPdf: true });
    }, [pdfFile, sourceImageFile, store, tabId]);

    const selected = batchItems.find(item => item.id === selectedId);
    const hasPending = batchItems.some(item => item.status === 'pending' || item.status === 'error');
    const hasSuccess = batchItems.some(item => item.status === 'success');
    const setOption = <K extends keyof DocumentCleanupOptions>(key: K, value: DocumentCleanupOptions[K]) => {
        if (isProcessing || options[key] === value) return;
        setOptionsAndInvalidate(tabId, { ...options, [key]: value });
    };
    const handleResultReady = React.useCallback<CleanupResultReady>(async ({ blob, name, items }) => {
        if (!mountedRef.current || !onFileFixed) return;
        if (items.length > 1) {
            // Chỉ publish một lần khi TẤT CẢ item đã có artifact. Callback được gọi
            // tuần tự sau từng item nên điều kiện này đúng duy nhất ở kết quả cuối.
            if (items.some(current => !current.resultBlob)) return;
            const artifact = await buildDocumentCleanupBatchArtifact(items, options.operation);
            if (!mountedRef.current) return;
            const committed = await onFileFixed(artifact.blob, artifact.name);
            return committed === false ? false : true;
        }
        const committed = await onFileFixed(blob, name);
        return committed === false ? false : true;
    }, [onFileFixed, options.operation]);
    const handleUndoSelected = React.useCallback(async () => {
        if (!selected) return;
        if (isCurrentDocumentCleanupWorkingResult(tabId, selected, sourceImageFile)) {
            if (!onFileFixed || !selected.fileObj) return;
            const originalPath = selected.path && selected.path !== 'browser-file'
                ? selected.path
                : undefined;
            try {
                const restored = await onFileFixed(selected.fileObj, selected.fileName, originalPath);
                if (restored === false) throw new Error(tv('Ảnh gốc chưa được khôi phục vào khung xem.'));
            } catch (undoError) {
                toast.error(formatError(undoError, tv('Không thể khôi phục ảnh gốc')));
                return;
            }
        }
        store.undoItem(tabId, selected.id);
    }, [onFileFixed, selected, sourceImageFile, store, tabId]);

    return (
        <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 rounded-xl bg-slate-100 p-1 dark:bg-zinc-800">
                <button type="button" disabled={isProcessing} onClick={() => setOption('operation', 'card')}
                    className={`rounded-lg px-2 py-2 text-[12px] font-bold disabled:cursor-not-allowed disabled:opacity-50 ${options.operation === 'card' ? 'bg-white text-violet-700 shadow dark:bg-zinc-700 dark:text-violet-300' : 'text-slate-500'}`}>
                    {tv('Nắn thẻ')}
                </button>
                <button type="button" disabled={isProcessing} onClick={() => setOption('operation', 'scan')}
                    className={`rounded-lg px-2 py-2 text-[12px] font-bold disabled:cursor-not-allowed disabled:opacity-50 ${options.operation === 'scan' ? 'bg-white text-violet-700 shadow dark:bg-zinc-700 dark:text-violet-300' : 'text-slate-500'}`}>
                    {tv('Làm trắng scan')}
                </button>
            </div>

            {batchItems.length > 0 && (
                <div aria-label={tv('Danh sách ảnh')} className="flex flex-wrap gap-2">
                    {batchItems.map(item => (
                        <div key={item.id} className="group relative h-14 w-14 shrink-0">
                            <button
                                type="button"
                                aria-label={`${tv('Chọn')} ${item.fileName}`}
                                data-testid={`document-cleanup-thumbnail-${item.id}`}
                                onClick={() => store.setSelectedId(tabId, item.id)}
                                className={`relative h-full w-full overflow-hidden rounded-lg border-2 transition-all ${selectedId === item.id ? 'border-violet-500 ring-2 ring-violet-200' : 'border-slate-200 hover:border-slate-400 dark:border-zinc-700'}`}
                            >
                                {isPdfName(item.fileName)
                                    ? <span className="flex h-full w-full items-center justify-center bg-red-50 text-2xl dark:bg-red-950/30">📄</span>
                                    : <img src={item.resultUrl || item.originalUrl} alt="" className="h-full w-full object-cover" draggable={false} />}
                                <span className={`absolute inset-x-0 bottom-0 py-px text-[9px] font-bold text-white ${item.status === 'success' ? 'bg-emerald-500' : item.status === 'processing' ? 'bg-amber-500' : item.status === 'error' ? 'bg-red-500' : 'bg-slate-500/80'}`}>
                                    {item.status === 'success' ? '✓' : item.status === 'processing' ? '⏳' : item.status === 'error' ? '✗' : '•'}
                                </span>
                            </button>
                            <button
                                type="button"
                                aria-label={`${tv('Xóa')} ${item.fileName}`}
                                disabled={isProcessing}
                                onClick={() => store.removeItem(tabId, item.id)}
                                className="absolute right-0 top-0 z-10 flex h-4 w-4 items-center justify-center rounded-bl bg-red-500 text-[9px] text-white opacity-0 transition-opacity hover:bg-red-600 focus:opacity-100 disabled:hidden group-hover:opacity-100"
                            >×</button>
                        </div>
                    ))}
                    <button
                        type="button"
                        aria-label={tv('Thêm ảnh hoặc PDF')}
                        disabled={isProcessing}
                        onClick={() => void openFilePicker(tabId, useDocumentCleanupStore, { allowPdf: true, onFilesSelected: files => switchToScanForPdf(tabId, files) })}
                        className="h-14 w-14 rounded-lg border-2 border-dashed border-slate-300 text-xl text-slate-400 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-600 dark:hover:bg-zinc-800"
                    >+</button>
                </div>
            )}

            <label className="block text-[11px] font-bold text-slate-600 dark:text-zinc-300">
                {tv('Độ phân giải đầu ra (DPI)')}
                <input type="number" min="72" max="1200" step="1" value={options.outputDpi} disabled={isProcessing}
                    onChange={event => setOption('outputDpi', Number(event.target.value))}
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-2 text-[12px] dark:border-zinc-700 dark:bg-zinc-800" />
            </label>

            {options.operation === 'card' ? (
                <div className="space-y-3 rounded-xl border border-slate-200 p-3 dark:border-zinc-700">
                    <label className="block text-[11px] font-bold text-slate-600 dark:text-zinc-300">
                        {tv('Tỷ lệ thẻ')}
                        <select value={options.cardRatio} disabled={isProcessing} onChange={event => setOption('cardRatio', event.target.value as DocumentCleanupOptions['cardRatio'])}
                            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-2 text-[12px] dark:border-zinc-700 dark:bg-zinc-800">
                            <option value="id1">ID-1 — 85,60 × 53,98 mm</option>
                            <option value="auto">{tv('Giữ tỷ lệ nhận diện')}</option>
                            <option value="custom">{tv('Kích thước tùy chỉnh')}</option>
                        </select>
                    </label>
                    {options.cardRatio === 'custom' && (
                        <div className="grid grid-cols-2 gap-2">
                            <label className="text-[10px] text-slate-500">{tv('Rộng (mm)')}<input type="number" min="10" max="1000" step="0.1" value={options.customWidthMm} disabled={isProcessing} onChange={event => setOption('customWidthMm', Number(event.target.value))} className="mt-1 w-full rounded border p-1.5 disabled:opacity-50 dark:bg-zinc-800" /></label>
                            <label className="text-[10px] text-slate-500">{tv('Cao (mm)')}<input type="number" min="10" max="1000" step="0.1" value={options.customHeightMm} disabled={isProcessing} onChange={event => setOption('customHeightMm', Number(event.target.value))} className="mt-1 w-full rounded border p-1.5 disabled:opacity-50 dark:bg-zinc-800" /></label>
                        </div>
                    )}
                    <button type="button" disabled={!selected || isProcessing || isPdfName(selected.fileName)} onClick={() => void detectSelectedDocumentCard(tabId)}
                        className="w-full rounded-lg border border-violet-300 px-3 py-2 text-[12px] font-bold text-violet-700 disabled:opacity-50 dark:border-violet-800 dark:text-violet-300">
                        {tv('Tự nhận diện lại bốn góc')}
                    </button>
                    {selected && options.detections[selected.id]?.needsReview && (
                        <p className="rounded-lg bg-amber-50 p-2 text-[11px] text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                            {tv('Biên thẻ chưa rõ. Hãy kéo bốn điểm ở ảnh bên trái rồi mới xử lý.')}
                        </p>
                    )}
                </div>
            ) : (
                <div className="space-y-3 rounded-xl border border-slate-200 p-3 dark:border-zinc-700">
                    <label className="block text-[11px] font-bold text-slate-600 dark:text-zinc-300">{tv('Kiểu đầu ra')}
                        <select value={options.scanMode} disabled={isProcessing} onChange={event => setOption('scanMode', event.target.value as DocumentCleanupOptions['scanMode'])} className="mt-1 w-full rounded-lg border p-2 text-[12px] disabled:opacity-50 dark:bg-zinc-800">
                            <option value="color">{tv('Giữ màu — bảo vệ dấu và chữ ký')}</option>
                            <option value="gray">{tv('Xám sạch')}</option>
                            <option value="bw">{tv('Đen trắng')}</option>
                        </select>
                    </label>
                    <label className="block text-[11px] font-bold text-slate-600 dark:text-zinc-300">{tv('Mức làm sạch')}: {Math.round(options.strength * 100)}%
                        <input type="range" min="0" max="1" step="0.05" value={options.strength} disabled={isProcessing} onChange={event => setOption('strength', Number(event.target.value))} className="mt-1 w-full disabled:opacity-50" />
                    </label>
                    <label className="flex items-center gap-2 text-[11px]"><input type="checkbox" checked={options.removeShadows} disabled={isProcessing} onChange={event => setOption('removeShadows', event.target.checked)} />{tv('Loại bóng và nền xám không đều')}</label>
                    <label className="flex items-center gap-2 text-[11px]"><input type="checkbox" checked={options.deskew} disabled={isProcessing} onChange={event => setOption('deskew', event.target.checked)} />{tv('Tự nắn xoay nhẹ')}</label>
                </div>
            )}

            <button type="button" disabled={isProcessing || !hasPending} onClick={() => void processDocumentCleanupBatch(
                tabId,
                handleResultReady,
                pdfFile && getWorkingFile ? { sourceFile: pdfFile, getWorkingFile } : undefined,
            )}
                className="h-11 w-full rounded-xl bg-violet-600 text-[13px] font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500">
                {isProcessing ? tv('Đang xử lý…') : tv('Xử lý')}
            </button>
            {isProcessing && <button type="button" onClick={() => cancelDocumentCleanup(tabId)} className="h-10 rounded-xl bg-rose-600 text-[12px] font-bold text-white">{tv('Hủy xử lý')}</button>}
            {hasSuccess && (
                <div className="flex gap-2">
                    <button type="button" onClick={async () => {
                        const { saved, ok } = await saveBatch(tabId, useDocumentCleanupStore, options.operation === 'card' ? 'nan_thang' : 'scan_sach');
                        if (!ok) toast.error(tv('Lỗi khi lưu file.'));
                        else if (saved) toast.success(`${tv('Đã lưu')} ${saved} ${tv('tệp')}`);
                    }} className="h-11 flex-1 rounded-xl bg-emerald-600 text-[12px] font-bold text-white">💾 {tv('Lưu bản sao')}</button>
                    {batchItems.length === 1 && selected?.status === 'success' && !isPdfName(selected.fileName) && <button type="button" disabled={isProcessing} onClick={() => void handleUndoSelected()} className="h-11 rounded-xl bg-amber-500 px-3 text-white disabled:opacity-50" title={tv('Hoàn tác')}><RotateCcw className="h-4 w-4" /></button>}
                </div>
            )}
            {selected?.status === 'success' && selected.resultInfo && (
                <p className="rounded-lg bg-emerald-50 px-3 py-2 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
                    ✓ {selected.resultInfo}
                </p>
            )}
            {progress && (
                <div aria-live="polite" className="overflow-hidden rounded-lg bg-violet-50 text-[11px] font-medium text-violet-700 dark:bg-violet-950/30 dark:text-violet-300">
                    {isProcessing && <div className="h-1 w-full animate-pulse bg-violet-500" />}
                    <div className="p-3">{progress}</div>
                </div>
            )}
            {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">{error}</div>}
        </div>
    );
}

export function DocumentCleanupPreview({ tabId, isActive }: { tabId: string; isActive: boolean }) {
    const tab = useDocumentCleanupStore(state => state.tabs[tabId] || defaultDocumentCleanupTabState);
    const selected = tab.batchItems.find(item => item.id === tab.selectedId);
    const detection = selected ? tab.options.detections[selected.id] : undefined;
    const [showResult, setShowResult] = useState(true);
    const [zoom, setZoom] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const [isPanning, setIsPanning] = useState(false);
    const [isDragOver, setIsDragOver] = useState(false);
    const previewRef = useRef<HTMLDivElement | null>(null);
    const svgRef = useRef<SVGSVGElement | null>(null);
    const spaceHeld = useRef(false);
    const panStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
    const zoomRef = useRef(1);
    const panRef = useRef({ x: 0, y: 0 });
    const points = useMemo(() => detection?.points || [], [detection]);
    const pointString = useMemo(() => points.map(point => `${point.x},${point.y}`).join(' '), [points]);
    const isPdf = !!selected && isPdfName(selected.fileName);
    const resultVisible = showResult && !!selected?.resultUrl;

    const resetView = React.useCallback(() => {
        zoomRef.current = 1;
        panRef.current = { x: 0, y: 0 };
        setZoom(1);
        setPan({ x: 0, y: 0 });
    }, [setPan, setZoom]);

    React.useEffect(() => {
        resetView();
        setShowResult(true);
    }, [resetView, selected?.id, selected?.resultUrl]);

    React.useEffect(() => {
        if (!isActive) {
            spaceHeld.current = false;
            return;
        }
        const onKeyDown = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            if (event.code !== 'Space' || event.repeat || target?.closest('input, textarea, select, [contenteditable="true"]')) return;
            spaceHeld.current = true;
            event.preventDefault();
        };
        const onKeyUp = (event: KeyboardEvent) => {
            if (event.code === 'Space') spaceHeld.current = false;
        };
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
        };
    }, [isActive]);

    React.useEffect(() => {
        if (!isPanning) return;
        const onMove = (event: MouseEvent) => {
            const next = {
                x: panStart.current.panX + event.clientX - panStart.current.x,
                y: panStart.current.panY + event.clientY - panStart.current.y,
            };
            panRef.current = next;
            setPan(next);
        };
        const onUp = () => setIsPanning(false);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, [isPanning]);

    const updateZoom = React.useCallback((nextZoom: number, clientX?: number, clientY?: number) => {
        const currentZoom = zoomRef.current;
        const clamped = Math.max(0.2, Math.min(12, nextZoom));
        if (Math.abs(clamped - currentZoom) < 1e-6) return;

        let nextPan = panRef.current;
        const rect = previewRef.current?.getBoundingClientRect();
        if (rect && clientX !== undefined && clientY !== undefined) {
            // Giữ đúng điểm dưới con trỏ khi thu phóng để người dùng soi chi tiết
            // mà không phải kéo ảnh về lại vị trí cũ sau mỗi nấc cuộn.
            const cursorX = clientX - (rect.left + rect.width / 2);
            const cursorY = clientY - (rect.top + rect.height / 2);
            const worldX = (cursorX - nextPan.x) / currentZoom;
            const worldY = (cursorY - nextPan.y) / currentZoom;
            nextPan = {
                x: cursorX - worldX * clamped,
                y: cursorY - worldY * clamped,
            };
        }
        zoomRef.current = clamped;
        panRef.current = nextPan;
        setZoom(clamped);
        setPan(nextPan);
    }, [setPan, setZoom]);

    React.useEffect(() => {
        const preview = previewRef.current;
        if (!preview || !isActive || !selected || isPdf) return;
        const handleWheel = (event: WheelEvent) => {
            event.preventDefault();
            event.stopPropagation();
            updateZoom(
                zoomRef.current * (event.deltaY < 0 ? 1.15 : 0.87),
                event.clientX,
                event.clientY,
            );
        };
        // WebView2 có thể coi listener wheel của React là passive. Listener native
        // non-passive giữ thao tác trong vùng xem, không cuộn cả panel bên ngoài.
        preview.addEventListener('wheel', handleWheel, { passive: false });
        return () => preview.removeEventListener('wheel', handleWheel);
    }, [isActive, isPdf, selected, updateZoom]);

    const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
        if (!isActive || isPdf) return;
        if ((event.target as HTMLElement | null)?.closest('button')) return;
        const directPan = resultVisible;
        if (event.button !== 1 && !(event.button === 0 && (directPan || event.ctrlKey || spaceHeld.current))) return;
        event.preventDefault();
        setIsPanning(true);
        panStart.current = {
            x: event.clientX,
            y: event.clientY,
            panX: panRef.current.x,
            panY: panRef.current.y,
        };
    };

    const receivePreviewFiles = (files: File[]) => {
        receiveDocumentCleanupFiles(tabId, files);
    };

    const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setIsDragOver(false);
        receivePreviewFiles(Array.from(event.dataTransfer.files));
    };

    const movePoint = (index: number, event: React.PointerEvent<SVGCircleElement>) => {
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        const apply = (clientX: number, clientY: number) => {
            const rect = svgRef.current?.getBoundingClientRect();
            if (!rect || !selected || !detection) return;
            const next = detection.points.map((point, current) => current === index ? {
                x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
                y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
            } : point);
            updateDetection(tabId, selected.id, { ...detection, points: next, needsReview: false, method: 'manual' });
        };
        apply(event.clientX, event.clientY);
        const onMove = (move: PointerEvent) => apply(move.clientX, move.clientY);
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, { once: true });
    };

    if (!selected) {
        return (
            <div
                ref={previewRef}
                data-testid="document-cleanup-preview"
                className={`flex h-full items-center justify-center p-8 transition-colors dark:bg-zinc-950 ${isDragOver ? 'bg-violet-100 ring-4 ring-inset ring-violet-400' : 'bg-slate-100'}`}
                onDragOver={event => { event.preventDefault(); setIsDragOver(true); }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={handleDrop}
            >
                <button type="button" onClick={() => void openFilePicker(tabId, useDocumentCleanupStore, { allowPdf: true, onFilesSelected: files => switchToScanForPdf(tabId, files) })} className="rounded-3xl border-2 border-dashed border-violet-300 bg-white px-12 py-14 text-center shadow dark:bg-zinc-900">
                    <div className="text-5xl">🪪</div>
                    <div className="mt-3 text-lg font-black text-slate-800 dark:text-white">{tv('Nắn thẻ – Làm trắng scan')}</div>
                    <div className="mt-2 text-sm text-slate-500">{tv('Kéo thả ảnh/PDF scan hoặc bấm để chọn')}</div>
                </button>
            </div>
        );
    }

    const imageUrl = resultVisible ? selected.resultUrl! : selected.originalUrl;
    const imageTransform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;
    return (
        <div
            ref={previewRef}
            data-testid="document-cleanup-preview"
            className={`relative flex h-full items-center justify-center overflow-hidden p-6 transition-colors ${isDragOver ? 'bg-violet-950 ring-4 ring-inset ring-violet-400' : 'bg-[#505458]'} ${isActive ? '' : 'pointer-events-none'} ${isPanning ? 'cursor-grabbing' : resultVisible ? 'cursor-grab' : ''}`}
            onDragOver={event => { event.preventDefault(); setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
            onMouseDown={handleMouseDown}
            onDoubleClick={resetView}
        >
            <div className="absolute left-4 top-4 z-20 flex rounded-lg bg-white/95 p-1 text-[11px] font-bold shadow">
                <button type="button" onClick={() => setShowResult(false)} className={`rounded px-3 py-1.5 ${!resultVisible ? 'bg-violet-600 text-white' : 'text-slate-600'}`}>{tv('Ảnh gốc')}</button>
                <button type="button" disabled={!selected.resultUrl} onClick={() => setShowResult(true)} className={`rounded px-3 py-1.5 disabled:opacity-40 ${resultVisible ? 'bg-violet-600 text-white' : 'text-slate-600'}`}>{tv('Kết quả')}</button>
            </div>
            {!isPdf && (
                <div className="absolute right-4 top-4 z-30 flex items-center gap-1 rounded-lg bg-white/95 p-1 text-slate-700 shadow" onMouseDown={event => event.stopPropagation()}>
                    <button type="button" aria-label={tv('Thu nhỏ')} title={tv('Thu nhỏ')} onClick={() => updateZoom(zoomRef.current * 0.87)} className="rounded p-2 hover:bg-slate-100"><ZoomOut className="h-4 w-4" /></button>
                    <span className="min-w-12 text-center text-[11px] font-bold tabular-nums">{Math.round(zoom * 100)}%</span>
                    <button type="button" aria-label={tv('Phóng to')} title={tv('Phóng to')} onClick={() => updateZoom(zoomRef.current * 1.15)} className="rounded p-2 hover:bg-slate-100"><ZoomIn className="h-4 w-4" /></button>
                    <button type="button" aria-label={tv('Vừa khung')} title={tv('Vừa khung')} onClick={resetView} className="rounded p-2 hover:bg-slate-100"><Maximize2 className="h-4 w-4" /></button>
                </div>
            )}
            <div
                data-testid="document-cleanup-canvas"
                className="relative inline-flex max-h-full max-w-full items-center justify-center shadow-2xl"
                style={{
                    transform: imageTransform,
                    transformOrigin: 'center center',
                    transition: isPanning ? 'none' : 'transform 100ms ease-out',
                }}
            >
                {isPdf ? (
                    <div className="flex min-h-72 min-w-80 flex-col items-center justify-center rounded-2xl bg-white p-10 text-center dark:bg-zinc-900">
                        <div className="text-6xl">📄</div>
                        <div className="mt-4 max-w-72 break-all text-sm font-bold text-slate-700 dark:text-zinc-200">{selected.fileName}</div>
                        <div className="mt-2 text-xs text-slate-500">{resultVisible ? tv('Đã cập nhật tài liệu hiện tại; có thể chuyển sang công cụ khác') : tv('PDF scan nhiều trang')}</div>
                    </div>
                ) : <img src={imageUrl} alt={selected.fileName} className="block max-h-[calc(100vh-150px)] max-w-full select-none object-contain" draggable={false} />}
                {!resultVisible && tab.options.operation === 'card' && points.length === 4 && (
                    <svg ref={svgRef} className="absolute inset-0 h-full w-full touch-none" viewBox="0 0 1 1" preserveAspectRatio="none">
                        <polygon points={pointString} fill="rgba(124,58,237,0.12)" stroke="#7c3aed" strokeWidth="0.004" vectorEffect="non-scaling-stroke" />
                        {points.map((point, index) => (
                            <circle key={index} cx={point.x} cy={point.y} r="0.018" fill="#7c3aed" stroke="white" strokeWidth="0.006" vectorEffect="non-scaling-stroke" onPointerDown={event => movePoint(index, event)} className="cursor-move" />
                        ))}
                    </svg>
                )}
            </div>
            {!isPdf && (
                <div className="pointer-events-none absolute bottom-5 right-4 z-20 rounded-full bg-black/50 px-3 py-1 text-[10px] text-white/80 backdrop-blur-sm">
                    {resultVisible ? tv('Kéo để di chuyển · Cuộn để thu phóng') : tv('Giữ Space/Ctrl rồi kéo · Cuộn để thu phóng')}
                </div>
            )}
        </div>
    );
}
