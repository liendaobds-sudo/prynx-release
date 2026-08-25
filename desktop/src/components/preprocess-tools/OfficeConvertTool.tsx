/**
 * Word / Excel / Google → PDF
 *
 * Luồng đáng tin cậy trên Tauri:
 *  - Chọn file: dialog native (plugin-dialog), không phụ thuộc HTML input
 *  - Convert: gửi file_path tuyệt đối lên backend (cùng máy sidecar) — Word/Excel COM
 *  - Drop cửa sổ: App/SystemIntegrations → prop officeSourceFile hoặc event
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch, getApiUrl, prepareFileForUpload } from '../../lib/api';
import { OFFICE_EXTENSIONS, isGoogleOfficeUrl, isOfficePathOrName, mimeForOfficeName, officeExtension } from '../../lib/officeFileTypes';
import { ToolSectionLabel } from './ToolUI';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../../stores/useAuthStore';
import { canUse } from '../../lib/license/features';

interface Props {
    pdfFile?: File | null;
    /** File Office từ tab payload (Ctrl+O / drop cửa sổ) */
    officeSourceFile?: File | null;
    officeSourceFiles?: File[];
    onFileFixed?: (blob: Blob, filename: string, path?: string) => void | boolean | Promise<void | boolean>;
}
interface OfficePathResponse {
    path: string;
    filename?: string;
}
interface OfficeCapabilityStatus {
    supported_extensions: string[];
    unsupported_extensions: string[];
    engine_by_extension: Record<string, string>;
    hint?: string | null;
}

interface ActiveOfficeRequest {
    controller: AbortController;
    generation: number;
    jobId?: string;
    pollTimer?: ReturnType<typeof setTimeout>;
    elapsedTimer?: ReturnType<typeof setInterval>;
}

interface OfficeJobStatus {
    phase: string;
    terminal: boolean;
    remaining_seconds: number;
}

type Mode = 'file' | 'google';
function createOfficeJobId(): string {
    return globalThis.crypto?.randomUUID?.() || '00000000-0000-4000-8000-' + Date.now().toString(16).padStart(12, '0').slice(-12);
}

function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError';
}

function getErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'object' && error !== null && 'message' in error) {
        const message = error.message;
        if (typeof message === 'string' && message) return message;
    }
    return fallback;
}

function formatValidationDetailItem(detail: unknown): string {
    if (typeof detail === 'object' && detail !== null && 'msg' in detail) {
        const message = detail.msg;
        if (typeof message === 'string' && message) return message;
    }
    return JSON.stringify(detail) ?? '';
}

async function readOfficeOutput(
    response: Response,
    preferPath: boolean,
    fallbackName: string,
): Promise<{ blob: Blob; name: string; path?: string }> {
    if (preferPath) {
        const data = await response.json() as OfficePathResponse;
        if (!data?.path) throw new Error('Backend không trả về đường dẫn PDF kết quả.');
        return {
            blob: new Blob([], { type: 'application/pdf' }),
            name: data.filename || fallbackName,
            path: data.path,
        };
    }
    return { blob: await response.blob(), name: fallbackName };
}

function clearOfficeRequestTimers(request: ActiveOfficeRequest | null): void {
    if (!request) return;
    if (request.pollTimer) clearTimeout(request.pollTimer);
    if (request.elapsedTimer) clearInterval(request.elapsedTimer);
}

function cancelOfficeBackendJob(jobId?: string): void {
    if (!jobId) return;
    void authenticatedFetch(`${getApiUrl()}/pdf-tools/office-convert/jobs/${jobId}/cancel`, {
        method: 'POST',
    }).catch(() => undefined);
}
type ExcelLayout = 'preserve' | 'fit_width' | 'one_page';
type BatchResizePreset = 'none' | 'a4' | 'a3' | 'letter' | 'custom';

const BATCH_ENTITLEMENT_CHANGED_ERROR = 'Quyền xử lý hàng loạt đã thay đổi. Tác vụ đã dừng; hãy kích hoạt lại key Pro rồi thử lại.';

interface BatchFolderFile {
    path: string;
    name: string;
    size: number;
}

interface BatchResult extends BatchFolderFile {
    status: 'pending' | 'processing' | 'success' | 'error' | 'cancelled';
    outputPath?: string;
    error?: string;
}

function isExcelName(name: string): boolean {
    return /\.(xls|xlsx|ods|csv)$/i.test(name);
}

function isSupportedLooseName(name: string): boolean {
    return /\.pdf$/i.test(name) || isOfficePathOrName(name);
}


export default function OfficeConvertTool({ officeSourceFile, officeSourceFiles, onFileFixed }: Props) {
    const { t } = useTranslation();
    const licensePlan = useAuthStore((state) => state.licensePlan);
    const licenseFeatures = useAuthStore((state) => state.licenseFeatures);
    // SEC/UIUX (audit 2026-08-04 §UI.06): hai capability được cấp độc lập;
    // không dùng office_batch để mở ké resize_batch (hoặc ngược lại).
    const canOfficeBatch = canUse('pdf.office_batch', licensePlan, licenseFeatures);
    const canResizeBatch = canUse('pdf.resize_batch', licensePlan, licenseFeatures);
    const canAnyBatch = canOfficeBatch || canResizeBatch;
    const convertingRef = useRef(false);
    const lastSourceKeyRef = useRef<string>('');
    const batchCancelRef = useRef(false);
    const activeRequestRef = useRef<ActiveOfficeRequest | null>(null);
    const batchRequestRef = useRef<ActiveOfficeRequest | null>(null);
    const singleGenerationRef = useRef(0);
    const batchGenerationRef = useRef(0);

    const [mode, setMode] = useState<Mode>('file');
    const [googleUrl, setGoogleUrl] = useState('');
    const [pickedFile, setPickedFile] = useState<File | null>(null);
    const [excelLayout, setExcelLayout] = useState<ExcelLayout>('fit_width');
    const [singleResizePreset, setSingleResizePreset] = useState<BatchResizePreset>('none');
    const [singleCustomWidth, setSingleCustomWidth] = useState(210);
    const [singleCustomHeight, setSingleCustomHeight] = useState(297);
    const [dragOver, setDragOver] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [progress, setProgress] = useState('');
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const [batchSourceFolder, setBatchSourceFolder] = useState('');
    const [batchOutputFolder, setBatchOutputFolder] = useState('');
    const [batchResults, setBatchResults] = useState<BatchResult[]>([]);
    const [isBatchRunning, setIsBatchRunning] = useState(false);
    const [batchResizePreset, setBatchResizePreset] = useState<BatchResizePreset>('none');
    const [batchCustomWidth, setBatchCustomWidth] = useState(210);
    const [batchCustomHeight, setBatchCustomHeight] = useState(297);
    const [capabilityStatus, setCapabilityStatus] = useState<OfficeCapabilityStatus | null>(null);
    const [activeJobId, setActiveJobId] = useState<string | null>(null);
    const [canExtendLease, setCanExtendLease] = useState(false);
    const [elapsedSeconds, setElapsedSeconds] = useState(0);

    const canStageBatchName = useCallback((name: string): boolean => {
        if (/\.pdf$/i.test(name)) return canAnyBatch;
        return canOfficeBatch && isOfficePathOrName(name);
    }, [canAnyBatch, canOfficeBatch]);

    // SEC/UIUX (audit 2026-08-04 §UI.03): không giữ quyền chụp tại thời điểm render
    // vì key có thể bị hạ trong lúc backend đang chuyển file.
    const hasCurrentBatchEntitlement = useCallback((name: string, needsResize: boolean): boolean => {
        const current = useAuthStore.getState();
        const hasOfficeBatch = canUse('pdf.office_batch', current.licensePlan, current.licenseFeatures);
        const hasResizeBatch = canUse('pdf.resize_batch', current.licensePlan, current.licenseFeatures);
        const isPdf = /\.pdf$/i.test(name);
        return (!needsResize || hasResizeBatch)
            && (isPdf ? hasOfficeBatch || hasResizeBatch : hasOfficeBatch);
    }, []);

    const cancelBatchForEntitlementChange = useCallback(() => {
        batchCancelRef.current = true;
        const request = batchRequestRef.current;
        batchRequestRef.current = null;
        batchGenerationRef.current += 1;
        cancelOfficeBackendJob(request?.jobId);
        request?.controller.abort();
        clearOfficeRequestTimers(request);
        setActiveJobId(null);
        setCanExtendLease(false);
        setProgress('');
        setSuccess('');
        setError(BATCH_ENTITLEMENT_CHANGED_ERROR);
    }, []);

    const batchContainsOffice = batchResults.some((item) => !/\.pdf$/i.test(item.name));

    useEffect(() => {
        if (!isBatchRunning) return;
        const entitlementLost = !canAnyBatch
            || (batchContainsOffice && !canOfficeBatch)
            || (batchResizePreset !== 'none' && !canResizeBatch);
        if (entitlementLost) cancelBatchForEntitlementChange();
    }, [
        batchContainsOffice,
        batchResizePreset,
        canAnyBatch,
        canOfficeBatch,
        canResizeBatch,
        cancelBatchForEntitlementChange,
        isBatchRunning,
    ]);

    useEffect(() => {
        if (!canResizeBatch) setBatchResizePreset('none');
    }, [canResizeBatch]);


    const isFormatSupported = useCallback((name: string): boolean => {
        const extension = officeExtension(name);
        if (!extension || !capabilityStatus) return Boolean(extension);
        return capabilityStatus.supported_extensions.includes(`.${extension}`);
    }, [capabilityStatus]);

    const formatUnavailableMessage = useCallback((name: string): string => {
        const extension = officeExtension(name);
        return t('preprocess.officeConvert:format_unavailable', {
            extension: extension ? `.${extension}` : name,
        });
    }, [t]);

    const isRequestCurrent = useCallback((scope: 'single' | 'batch', request: ActiveOfficeRequest) => {
        const active = scope === 'single' ? activeRequestRef.current : batchRequestRef.current;
        const generation = scope === 'single' ? singleGenerationRef.current : batchGenerationRef.current;
        return active === request && generation === request.generation && !request.controller.signal.aborted;
    }, []);

    const trackRequest = useCallback((
        scope: 'single' | 'batch',
        request: ActiveOfficeRequest,
        initialProgress: string,
    ) => {
        setProgress(initialProgress);
        setElapsedSeconds(0);
        setActiveJobId(request.jobId || null);
        setCanExtendLease(false);
        request.elapsedTimer = setInterval(() => {
            if (isRequestCurrent(scope, request)) setElapsedSeconds((value) => value + 1);
        }, 1000);

        if (!request.jobId) return;
        const poll = async () => {
            if (!isRequestCurrent(scope, request) || !request.jobId) return;
            try {
                const response = await authenticatedFetch(
                    `${getApiUrl()}/pdf-tools/office-convert/jobs/${request.jobId}`,
                    { signal: request.controller.signal },
                );
                if (response.ok) {
                    const status = await response.json() as OfficeJobStatus;
                    if (!isRequestCurrent(scope, request)) return;
                    setProgress(t(`preprocess.officeConvert:phase_${status.phase}`));
                    setCanExtendLease(!status.terminal && status.remaining_seconds <= 60);
                    if (status.terminal) return;
                }
            } catch (pollError) {
                if (isAbortError(pollError)) return;
            }
            if (isRequestCurrent(scope, request)) {
                request.pollTimer = setTimeout(() => void poll(), 500);
            }
        };
        request.pollTimer = setTimeout(() => void poll(), 300);
    }, [isRequestCurrent, t]);

    const beginRequest = useCallback((
        scope: 'single' | 'batch',
        jobId: string | undefined,
        initialProgress: string,
    ): ActiveOfficeRequest => {
        const generationRef = scope === 'single' ? singleGenerationRef : batchGenerationRef;
        const activeRef = scope === 'single' ? activeRequestRef : batchRequestRef;
        const previous = activeRef.current;
        if (previous) {
            cancelOfficeBackendJob(previous.jobId);
            previous.controller.abort();
            clearOfficeRequestTimers(previous);
        }
        const request: ActiveOfficeRequest = {
            controller: new AbortController(),
            generation: ++generationRef.current,
            jobId,
        };
        activeRef.current = request;
        trackRequest(scope, request, initialProgress);
        return request;
    }, [trackRequest]);

    const finishRequest = useCallback((scope: 'single' | 'batch', request: ActiveOfficeRequest): boolean => {
        if (!isRequestCurrent(scope, request)) return false;
        clearOfficeRequestTimers(request);
        if (scope === 'single') activeRequestRef.current = null;
        else batchRequestRef.current = null;
        setActiveJobId(null);
        setCanExtendLease(false);
        return true;
    }, [isRequestCurrent]);

    const cancelActiveRequest = useCallback(() => {
        const request = activeRequestRef.current;
        if (!request) return;
        activeRequestRef.current = null;
        singleGenerationRef.current += 1;
        cancelOfficeBackendJob(request.jobId);
        request.controller.abort();
        clearOfficeRequestTimers(request);
        convertingRef.current = false;
        setIsProcessing(false);
        setProgress('');
        setActiveJobId(null);
        setCanExtendLease(false);
        setError(t('preprocess.officeConvert:cancelled'));
    }, [t]);

    const extendActiveLease = useCallback(async () => {
        if (!activeJobId) return;
        const request = activeRequestRef.current || batchRequestRef.current;
        const formData = new FormData();
        formData.append('seconds', '300');
        try {
            const response = await authenticatedFetch(
                `${getApiUrl()}/pdf-tools/office-convert/jobs/${activeJobId}/extend`,
                { method: 'POST', body: formData, signal: request?.controller.signal },
            );
            if (response.ok) {
                setCanExtendLease(false);
                setProgress(t('preprocess.officeConvert:phase_extended'));
            }
        } catch (extendError) {
            if (!isAbortError(extendError)) {
                setError(t('preprocess.officeConvert:loi_khong_xac_dinh'));
            }
        }
    }, [activeJobId, t]);

    useEffect(() => {
        const controller = new AbortController();
        void authenticatedFetch(`${getApiUrl()}/pdf-tools/office-convert/status`, {
            signal: controller.signal,
        }).then(async (response) => {
            if (!response.ok) return;
            const status = await response.json() as OfficeCapabilityStatus;
            status.supported_extensions = (status.supported_extensions || []).map((ext) => ext.toLowerCase());
            setCapabilityStatus(status);
        }).catch(() => undefined);
        return () => controller.abort();
    }, []);

    useEffect(() => {
        if (activeJobId && elapsedSeconds >= 60) setCanExtendLease(true);
    }, [activeJobId, elapsedSeconds]);

    useEffect(() => () => {
        singleGenerationRef.current += 1;
        batchGenerationRef.current += 1;
        for (const request of [activeRequestRef.current, batchRequestRef.current]) {
            cancelOfficeBackendJob(request?.jobId);
            request?.controller.abort();
            clearOfficeRequestTimers(request);
        }
        activeRequestRef.current = null;
        batchRequestRef.current = null;
    }, []);
    // ── Core convert ─────────────────────────────────────────────
    const convertFile = useCallback(async (
        src: File,
        excelLayoutOverride?: ExcelLayout,
        resizeTarget?: { width: number; height: number } | null,
    ) => {
        if (convertingRef.current) return;
        if (!isFormatSupported(src.name)) {
            setError(formatUnavailableMessage(src.name));
            return;
        }

        convertingRef.current = true;
        setIsProcessing(true);
        setError('');
        setSuccess('');
        setPickedFile(src);
        setMode('file');
        const jobId = createOfficeJobId();
        const request = beginRequest(
            'single',
            jobId,
            t('preprocess.officeConvert:dang_chuyen'),
        );

        try {
            const preferPath = !!window.__TAURI_INTERNALS__;
            const formData = new FormData();
            formData.append('job_id', jobId);
            if (preferPath) formData.append('return_path', 'true');
            if (isExcelName(src.name)) {
                formData.append('excel_layout', excelLayoutOverride || 'preserve');
            }
            const diskPath = src.path;

            if (diskPath && typeof diskPath === 'string' && diskPath.length > 2) {
                formData.append('file_path', diskPath);
            } else {
                const real = await prepareFileForUpload(src);
                const blob = real instanceof Blob ? real : new Blob([real as BlobPart]);
                if (blob.size === 0) {
                    throw new Error(t('preprocess.officeConvert:loi_doc_file'));
                }
                formData.append('file', blob, src.name);
            }

            const res = await authenticatedFetch(`${getApiUrl()}/pdf-tools/office-convert/file`, {
                method: 'POST',
                body: formData,
                signal: request.controller.signal,
            });
            if (!res.ok) {
                const errData = await res.json().catch(() => null);
                const detail = errData?.detail;
                const msg = typeof detail === 'string'
                    ? detail
                    : Array.isArray(detail)
                        ? detail.map((item: unknown) => formatValidationDetailItem(item)).join('; ')
                        : t('preprocess.officeConvert:loi_server', { status: res.status });
                throw new Error(msg);
            }
            const fallbackName = `converted_${src.name.replace(/\.[^.]+$/, '')}.pdf`;
            let output = await readOfficeOutput(res, preferPath, fallbackName);
            if (!isRequestCurrent('single', request)) return;
            if (!output.path && output.blob.size < 32) {
                throw new Error(t('preprocess.officeConvert:loi_pdf_rong'));
            }
            if (resizeTarget) {
                const resizeJobId = createOfficeJobId();
                clearOfficeRequestTimers(request);
                request.jobId = resizeJobId;
                trackRequest('single', request, t('preprocess.officeConvert:phase_resizing'));
                const resizeForm = new FormData();
                if (output.path) {
                    resizeForm.append('file_path', output.path);
                    resizeForm.append('consume_source', 'true');
                    resizeForm.append('return_path', 'true');
                } else {
                    resizeForm.append('file', output.blob, fallbackName);
                }
                resizeForm.append('target_w', String(resizeTarget.width));
                resizeForm.append('target_h', String(resizeTarget.height));
                resizeForm.append('auto_orientation', 'true');
                resizeForm.append('job_id', resizeJobId);
                const resizeResponse = await authenticatedFetch(getApiUrl() + '/pdf-tools/office-convert/resize-output', {
                    method: 'POST',
                    body: resizeForm,
                    signal: request.controller.signal,
                });
                if (!resizeResponse.ok) {
                    const data = await resizeResponse.json().catch(() => null);
                    throw new Error(typeof data?.detail === 'string'
                        ? data.detail
                        : t('preprocess.officeConvert:loi_server', { status: resizeResponse.status }));
                }
                output = await readOfficeOutput(
                    resizeResponse,
                    preferPath,
                    `resized_${fallbackName}`,
                );
                if (!isRequestCurrent('single', request)) return;
            }
            setProgress('');
            // RECIPE (audit 2026-08-17 §REC.4R): commit bị chặn → không báo thành công.
            const committed = await onFileFixed?.(output.blob, output.name, output.path);
            if (committed !== false) setSuccess(t('preprocess.officeConvert:thanh_cong'));
        } catch (convertError) {
            if (!isRequestCurrent('single', request)) return;
            setError(isAbortError(convertError)
                ? t('preprocess.officeConvert:cancelled')
                : getErrorMessage(convertError, t('preprocess.officeConvert:loi_khong_xac_dinh')));
            setProgress('');
        } finally {
            if (finishRequest('single', request)) {
                convertingRef.current = false;
                setIsProcessing(false);
            }
        }
    }, [
        beginRequest,
        finishRequest,
        formatUnavailableMessage,
        isFormatSupported,
        isRequestCurrent,
        onFileFixed,
        t,
        trackRequest,
    ]);

    const stageFile = useCallback((src: File) => {
        if (!isFormatSupported(src.name)) {
            setPickedFile(null);
            setError(formatUnavailableMessage(src.name));
            return;
        }
        setPickedFile(src);
        setMode('file');
        setError('');
        setSuccess('');
        setProgress('');
    }, [formatUnavailableMessage, isFormatSupported]);

    const startSingleConversion = useCallback(async () => {
        if (!pickedFile) return;
        let resizeTarget: { width: number; height: number } | null = null;
        if (singleResizePreset === 'a4') resizeTarget = { width: 210, height: 297 };
        if (singleResizePreset === 'a3') resizeTarget = { width: 297, height: 420 };
        if (singleResizePreset === 'letter') resizeTarget = { width: 215.9, height: 279.4 };
        if (singleResizePreset === 'custom') {
            if (singleCustomWidth < 10 || singleCustomHeight < 10 || singleCustomWidth > 5000 || singleCustomHeight > 5000) {
                setError(t('preprocess.officeConvert:batch_resize_invalid'));
                return;
            }
            resizeTarget = { width: singleCustomWidth, height: singleCustomHeight };
        }
        await convertFile(pickedFile, isExcelName(pickedFile.name) ? excelLayout : undefined, resizeTarget);
    }, [convertFile, excelLayout, pickedFile, singleCustomHeight, singleCustomWidth, singleResizePreset, t]);

    // ── Auto-run when parent passes officeSourceFile ─────────────
    useEffect(() => {
        if (!officeSourceFile || (officeSourceFiles && officeSourceFiles.length > 1)) return;
        const key = `${officeSourceFile.path || ''}|${officeSourceFile.name}|${officeSourceFile.size}`;
        if (key === lastSourceKeyRef.current) return;
        lastSourceKeyRef.current = key;
        if (!isOfficePathOrName(officeSourceFile.name)) {
            setError(t('preprocess.officeConvert:file_khong_hop_le', { name: officeSourceFile.name }));
            return;
        }
        stageFile(officeSourceFile);
    }, [officeSourceFile, officeSourceFiles, stageFile, t]);

    // ── Event bus (drop cửa sổ / legacy) ──────────────────────────

    // ── Tauri native open dialog (primary pick) ──────────────────
    const pickWithDialog = useCallback(async () => {
        setError('');
        setSuccess('');
        try {
            if (window.__TAURI_INTERNALS__) {
                const { open } = await import('@tauri-apps/plugin-dialog');
                const supportedOfficeExtensions = capabilityStatus
                    ? capabilityStatus.supported_extensions.map((ext) => ext.replace(/^\./, ''))
                    : [...OFFICE_EXTENSIONS];
                const pickerExtensions = [
                    ...supportedOfficeExtensions,
                    ...(canAnyBatch ? ['pdf'] : []),
                ];
                const selected = await open({
                    multiple: canAnyBatch,
                    filters: [
                        { name: canAnyBatch ? 'Word / Excel / PowerPoint / PDF' : 'Word / Excel / PowerPoint', extensions: pickerExtensions },
                    ],
                });
                if (!selected) return;
                const selectedPaths = Array.isArray(selected) ? selected : [selected];
                if (selectedPaths.length > 1 || /\.pdf$/i.test(selectedPaths[0] || '')) {
                    await stageLoosePaths(selectedPaths);
                    return;
                }
                const selectedPath = selectedPaths[0];
                if (!selectedPath) return;

                let size = 0;
                try {
                    const { invoke } = await import('@tauri-apps/api/core');
                    size = await invoke<number>('get_file_size', { path: selectedPath });
                } catch {
                    try {
                        const { stat } = await import('@tauri-apps/plugin-fs');
                        size = (await stat(selectedPath)).size;
                    } catch { /* 0 */ }
                }
                const name = selectedPath.split(/[/\\]/).pop() || 'document.docx';
                const fileObj = new File([], name, { type: mimeForOfficeName(name) });
                Object.defineProperty(fileObj, 'path', { value: selectedPath });
                Object.defineProperty(fileObj, 'size', { value: size });
                stageFile(fileObj);
            } else {
                // Browser fallback
                const input = document.createElement('input');
                input.type = 'file';
                input.multiple = canAnyBatch;
                const browserExtensions = capabilityStatus
                    ? capabilityStatus.supported_extensions.map((ext) => ext.replace(/^\./, ''))
                    : [...OFFICE_EXTENSIONS];
                input.accept = [
                    ...browserExtensions,
                    ...(canAnyBatch ? ['pdf'] : []),
                ].map((e) => '.' + e).join(',');
                input.onchange = async () => {
                    const files = Array.from(input.files || []);
                    if (files.length > 1 || /\.pdf$/i.test(files[0]?.name || '')) await stageLooseFiles(files);
                    else if (files[0]) stageFile(files[0]);
                };
                input.click();
            }
        } catch (error) {
            setError(getErrorMessage(error, t('preprocess.officeConvert:loi_khong_xac_dinh')));
        }
    // LINT audit 2026-08-24 LO140: stage helpers are function declarations shared by picker/drop; keep picker trigger scoped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canAnyBatch, canOfficeBatch, capabilityStatus, stageFile, t]);

    const handleGoogle = useCallback(async () => {
        const url = googleUrl.trim();
        if (!url) {
            setError(t('preprocess.officeConvert:chua_dan_link'));
            return;
        }
        if (/drive\.google\.com\/drive\/folders\//i.test(url)) {
            setError(t('preprocess.officeConvert:google_folder_unsupported'));
            return;
        }
        if (!isGoogleOfficeUrl(url)) {
            setError(t('preprocess.officeConvert:google_link_invalid'));
            return;
        }

        setIsProcessing(true);
        setError('');
        setSuccess('');
        const jobId = createOfficeJobId();
        const request = beginRequest(
            'single',
            jobId,
            t('preprocess.officeConvert:dang_tai_google'),
        );
        try {
            const preferPath = !!window.__TAURI_INTERNALS__;
            const formData = new FormData();
            formData.append('url', url);
            formData.append('job_id', jobId);
            if (preferPath) formData.append('return_path', 'true');
            const res = await authenticatedFetch(`${getApiUrl()}/pdf-tools/office-convert/google`, {
                method: 'POST',
                body: formData,
                signal: request.controller.signal,
            });
            if (!res.ok) {
                const errData = await res.json().catch(() => null);
                throw new Error(
                    (typeof errData?.detail === 'string' && errData.detail)
                    || t('preprocess.officeConvert:loi_server', { status: res.status })
                );
            }
            const output = await readOfficeOutput(res, preferPath, 'google_export.pdf');
            if (!isRequestCurrent('single', request)) return;
            setProgress('');
            // RECIPE (audit 2026-08-17 §REC.4R): commit bị chặn → không báo thành công.
            const committed = await onFileFixed?.(output.blob, output.name, output.path);
            if (committed !== false) setSuccess(t('preprocess.officeConvert:thanh_cong_google'));
        } catch (googleError) {
            if (!isRequestCurrent('single', request)) return;
            setError(isAbortError(googleError)
                ? t('preprocess.officeConvert:cancelled')
                : getErrorMessage(googleError, t('preprocess.officeConvert:loi_khong_xac_dinh')));
            setProgress('');
        } finally {
            if (finishRequest('single', request)) setIsProcessing(false);
        }
    }, [beginRequest, finishRequest, googleUrl, isRequestCurrent, onFileFixed, t]);
    const onDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);
        const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
        if (text && /drive\.google\.com\/drive\/folders\//i.test(text)) {
            setError(t('preprocess.officeConvert:google_folder_unsupported'));
            return;
        }
        if (text && isGoogleOfficeUrl(text)) {
            const url = text.trim().split(/\s+/)[0];
            setMode('google');
            setGoogleUrl(url);
            return;
        }
        const droppedFiles = Array.from(e.dataTransfer.files || []);
        if (droppedFiles.length > 1) {
            await stageLooseFiles(droppedFiles);
            return;
        }
        const f = droppedFiles[0];
        if (f && isOfficePathOrName(f.name)) {
            stageFile(f);
            return;
        }
        if (f && /\.pdf$/i.test(f.name)) {
            await stageLooseFiles([f]);
            return;
        }
        if (f) {
            setError(t('preprocess.officeConvert:file_khong_hop_le', { name: f.name }));
            return;
        }
        // Tauri: HTML drop often empty — window-level drag-drop handles paths
        setError(t('preprocess.officeConvert:drop_tauri_hint'));
    };

    const chooseBatchFolders = async () => {
        setError('');
        try {
            if (!window.__TAURI_INTERNALS__) {
                throw new Error(t('preprocess.officeConvert:batch_tauri_only'));
            }
            const { open } = await import('@tauri-apps/plugin-dialog');
            const { invoke } = await import('@tauri-apps/api/core');
            const source = await open({
                directory: true,
                multiple: false,
                title: t('preprocess.officeConvert:batch_choose_source'),
            });
            if (!source || typeof source !== 'string') return;
            const output = await open({
                directory: true,
                multiple: false,
                title: t('preprocess.officeConvert:batch_choose_output'),
            });
            if (!output || typeof output !== 'string') return;

            const files = (await invoke<BatchFolderFile[]>('list_batch_folder_files', { folder: source }))
                .filter((file) => canStageBatchName(file.name));
            files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
            setBatchSourceFolder(source);
            setBatchOutputFolder(output);
            setBatchResults(files.map((file) => ({ ...file, status: 'pending' })));
            if (files.length === 0) setError(t('preprocess.officeConvert:batch_no_files'));
        } catch (error) {
            setError(getErrorMessage(error, t('preprocess.officeConvert:loi_khong_xac_dinh')));
        }
    };

    async function stageLooseFiles(files: File[]) {
        const supported = files.filter((file) => isSupportedLooseName(file.name) && canStageBatchName(file.name));
        if (supported.length === 0) {
            setError(t('preprocess.officeConvert:batch_no_files'));
            return;
        }
        if (supported.length === 1 && isOfficePathOrName(supported[0].name)) {
            stageFile(supported[0]);
            return;
        }
        const missingPath = supported.find((file) => !file.path);
        if (missingPath) {
            setError(t('preprocess.officeConvert:batch_tauri_only'));
            return;
        }
        const results = supported
            .map((file) => ({
                path: file.path as string,
                name: file.name,
                size: file.size,
                status: 'pending' as const,
            }))
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
        setMode('file');
        setPickedFile(null);
        setBatchSourceFolder(t('preprocess.officeConvert:batch_selected_files'));
        setBatchOutputFolder('');
        setBatchResults(results);
        setError('');
        setSuccess('');
    }

    async function stageLoosePaths(paths: string[]) {
        const supportedPaths = paths.filter((path) => isSupportedLooseName(path) && canStageBatchName(path));
        if (supportedPaths.length === 0) {
            setError(t('preprocess.officeConvert:batch_no_files'));
            return;
        }
        const { invoke } = await import('@tauri-apps/api/core');
        const files = await Promise.all(supportedPaths.map(async (path) => {
            const name = path.split(/[/\\]/).pop() || 'document';
            const size = await invoke<number>('get_file_size', { path }).catch(() => 0);
            const file = new File([], name, { type: mimeForOfficeName(name) });
            Object.defineProperty(file, 'path', { value: path });
            Object.defineProperty(file, 'size', { value: size });
            return file;
        }));
        await stageLooseFiles(files);
    }

    async function chooseBatchOutputFolder() {
        if (!window.__TAURI_INTERNALS__) {
            setError(t('preprocess.officeConvert:batch_tauri_only'));
            return;
        }
        const { open } = await import('@tauri-apps/plugin-dialog');
        const output = await open({
            directory: true,
            multiple: false,
            title: t('preprocess.officeConvert:batch_choose_output'),
        });
        if (output && typeof output === 'string') setBatchOutputFolder(output);
    }

    useEffect(() => {
        if (!officeSourceFiles || officeSourceFiles.length < 2) return;
        void stageLooseFiles(officeSourceFiles);
    // LINT audit 2026-08-24 LO140: run only when source prop changes; adding a declaration would stage on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [officeSourceFiles]);
    const updateBatchResult = (index: number, patch: Partial<BatchResult>) => {
        setBatchResults((current) => current.map((item, i) => i === index ? { ...item, ...patch } : item));
    };

    const startBatch = async () => {
        if (isBatchRunning || batchResults.length === 0 || !batchOutputFolder) return;
        if (!canAnyBatch) {
            setError('Quyền xử lý hàng loạt đã thay đổi. Hãy kích hoạt lại key Pro rồi thử lại.');
            return;
        }
        if (!canOfficeBatch && batchResults.some((item) => !/\.pdf$/i.test(item.name))) {
            setError('Key hiện tại chỉ có quyền resize hàng loạt PDF, không có quyền chuyển nhiều file Office.');
            return;
        }
        if (!canResizeBatch && batchResizePreset !== 'none') {
            setError('Resize hàng loạt cần quyền PrynX Pro tương ứng.');
            return;
        }
        let resizeTarget: { width: number; height: number } | null = null;
        if (batchResizePreset === 'a4') resizeTarget = { width: 210, height: 297 };
        if (batchResizePreset === 'a3') resizeTarget = { width: 297, height: 420 };
        if (batchResizePreset === 'letter') resizeTarget = { width: 215.9, height: 279.4 };
        if (batchResizePreset === 'custom') {
            if (batchCustomWidth < 10 || batchCustomHeight < 10 || batchCustomWidth > 5000 || batchCustomHeight > 5000) {
                setError(t('preprocess.officeConvert:batch_resize_invalid'));
                return;
            }
            resizeTarget = { width: batchCustomWidth, height: batchCustomHeight };
        }
        const { invoke } = await import('@tauri-apps/api/core');
        batchCancelRef.current = false;
        setIsBatchRunning(true);
        setError('');
        setSuccess('');
        setBatchResults((current) => current.map((item) => ({ ...item, status: 'pending', outputPath: undefined, error: undefined })));

        let successCount = 0;
        let errorCount = 0;
        let wasCancelled = false;
        for (let index = 0; index < batchResults.length; index += 1) {
            const item = batchResults[index];
            if (!hasCurrentBatchEntitlement(item.name, resizeTarget !== null)) {
                cancelBatchForEntitlementChange();
                setBatchResults((current) => current.map((entry, i) =>
                    i >= index && entry.status === 'pending' ? { ...entry, status: 'cancelled' } : entry));
                wasCancelled = true;
                break;
            }
            if (batchCancelRef.current) {
                setBatchResults((current) => current.map((entry, i) =>
                    i >= index && entry.status === 'pending' ? { ...entry, status: 'cancelled' } : entry));
                wasCancelled = true;
                break;
            }

            const isPdf = /\.pdf$/i.test(item.name);
            if (!isPdf && !isFormatSupported(item.name)) {
                errorCount += 1;
                updateBatchResult(index, {
                    status: 'error',
                    error: formatUnavailableMessage(item.name),
                });
                continue;
            }

            updateBatchResult(index, { status: 'processing' });
            let jobId = isPdf ? undefined : createOfficeJobId();
            const request = beginRequest(
                'batch',
                jobId,
                t('preprocess.officeConvert:batch_progress', {
                    current: index + 1,
                    total: batchResults.length,
                }),
            );
            try {
                const preferredName = `${item.name.replace(/\.[^.]+$/, '')}.pdf`;
                let outputPath: string;

                if (isPdf && !resizeTarget) {
                    if (!hasCurrentBatchEntitlement(item.name, false)) {
                        cancelBatchForEntitlementChange();
                        throw new DOMException('Entitlement changed', 'AbortError');
                    }
                    outputPath = await invoke<string>('copy_batch_pdf', {
                        source: item.path,
                        outputDir: batchOutputFolder,
                        preferredName,
                    });
                } else {
                    let convertedPath: string | null = isPdf ? item.path : null;
                    if (!isPdf) {
                        const formData = new FormData();
                        formData.append('file_path', item.path);
                        formData.append('batch_mode', 'true');
                        formData.append('job_id', jobId || '');
                        formData.append('return_path', 'true');
                        if (isExcelName(item.name)) formData.append('excel_layout', excelLayout);
                        const response = await authenticatedFetch(`${getApiUrl()}/pdf-tools/office-convert/file`, {
                            method: 'POST',
                            body: formData,
                            signal: request.controller.signal,
                        });
                        if (!response.ok) {
                            const data = await response.json().catch(() => null);
                            throw new Error(typeof data?.detail === 'string'
                                ? data.detail
                                : t('preprocess.officeConvert:loi_server', { status: response.status }));
                        }
                        const converted = await response.json() as OfficePathResponse;
                        convertedPath = converted.path || null;
                        if (!isRequestCurrent('batch', request)) {
                            throw new DOMException('Cancelled', 'AbortError');
                        }
                    }

                    if (resizeTarget) {
                        jobId = createOfficeJobId();
                        clearOfficeRequestTimers(request);
                        request.jobId = jobId;
                        trackRequest('batch', request, t('preprocess.officeConvert:phase_resizing'));
                        const resizeForm = new FormData();
                        if (!convertedPath) throw new Error(t('preprocess.officeConvert:loi_pdf_rong'));
                        resizeForm.append('file_path', convertedPath);
                        if (!isPdf) resizeForm.append('consume_source', 'true');
                        resizeForm.append('return_path', 'true');
                        resizeForm.append('target_w', String(resizeTarget.width));
                        resizeForm.append('target_h', String(resizeTarget.height));
                        resizeForm.append('auto_orientation', 'true');
                        resizeForm.append('batch_mode', 'true');
                        if (jobId) resizeForm.append('job_id', jobId);
                        const resizeResponse = await authenticatedFetch(`${getApiUrl()}/pdf-tools/office-convert/resize-output`, {
                            method: 'POST',
                            body: resizeForm,
                            signal: request.controller.signal,
                        });
                        if (!resizeResponse.ok) {
                            const data = await resizeResponse.json().catch(() => null);
                            throw new Error(typeof data?.detail === 'string'
                                ? data.detail
                                : t('preprocess.officeConvert:loi_server', { status: resizeResponse.status }));
                        }
                        const resized = await resizeResponse.json() as OfficePathResponse;
                        convertedPath = resized.path || null;
                    }

                    if (!convertedPath) throw new Error(t('preprocess.officeConvert:loi_pdf_rong'));
                    if (!isRequestCurrent('batch', request)) {
                        throw new DOMException('Cancelled', 'AbortError');
                    }
                    if (!hasCurrentBatchEntitlement(item.name, resizeTarget !== null)) {
                        cancelBatchForEntitlementChange();
                        throw new DOMException('Entitlement changed', 'AbortError');
                    }
                    outputPath = await invoke<string>('copy_batch_pdf', {
                        source: convertedPath,
                        outputDir: batchOutputFolder,
                        preferredName,
                    });
                }
                successCount += 1;
                updateBatchResult(index, { status: 'success', outputPath });
            } catch (batchError) {
                if (batchCancelRef.current || isAbortError(batchError)) {
                    wasCancelled = true;
                    updateBatchResult(index, { status: 'cancelled' });
                    setBatchResults((current) => current.map((entry, i) =>
                        i > index && entry.status === 'pending' ? { ...entry, status: 'cancelled' } : entry));
                    break;
                }
                errorCount += 1;
                updateBatchResult(index, {
                    status: 'error',
                    error: getErrorMessage(batchError, t('preprocess.officeConvert:loi_khong_xac_dinh')),
                });
            } finally {
                finishRequest('batch', request);
            }
        }
        setIsBatchRunning(false);
        setProgress('');
        setSuccess(wasCancelled
            ? t('preprocess.officeConvert:batch_cancelled', { success: successCount, error: errorCount })
            : t('preprocess.officeConvert:batch_summary', { success: successCount, error: errorCount }));
    };

    const stopBatch = () => {
        batchCancelRef.current = true;
        const request = batchRequestRef.current;
        batchRequestRef.current = null;
        batchGenerationRef.current += 1;
        cancelOfficeBackendJob(request?.jobId);
        request?.controller.abort();
        clearOfficeRequestTimers(request);
        setActiveJobId(null);
        setCanExtendLease(false);
        setProgress(t('preprocess.officeConvert:phase_cancel_requested'));
    };

    return (
        <div className="flex flex-col gap-4">

            <div className="flex rounded-lg overflow-hidden border border-slate-200 dark:border-zinc-700">
                <button
                    type="button"
                    onClick={() => { setMode('file'); setError(''); setSuccess(''); }}
                    className={`flex-1 py-2 text-[12px] font-bold ${mode === 'file' ? 'bg-indigo-500 text-white' : 'bg-slate-50 dark:bg-zinc-800 text-slate-600'}`}
                >
                    📄 {t('preprocess.officeConvert:tab_file')}
                </button>
                <button
                    type="button"
                    onClick={() => { setMode('google'); setError(''); setSuccess(''); }}
                    className={`flex-1 py-2 text-[12px] font-bold ${mode === 'google' ? 'bg-sky-500 text-white' : 'bg-slate-50 dark:bg-zinc-800 text-slate-600'}`}
                >
                    🔗 {t('preprocess.officeConvert:tab_google')}
                </button>
            </div>

            <div
                onDragEnter={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragOver(true); }}
                onDragLeave={(e) => {
                    e.preventDefault();
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
                }}
                onDrop={onDrop}
                className={`rounded-xl border-2 border-dashed p-4 transition-colors ${
                    dragOver ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20' : 'border-slate-300 dark:border-zinc-600'
                }`}
            >
                {mode === 'file' ? (
                    <>
                        <p className="text-[12px] font-semibold text-center text-slate-600 dark:text-zinc-300 mb-2">
                            {t('preprocess.officeConvert:keo_tha_huong_dan')}
                        </p>
                        <p className="text-[10px] text-center text-slate-400 mb-3">
                            {t('preprocess.officeConvert:keo_tha_mo_ta')}
                        </p>
                        {pickedFile && (
                            <p className="text-[12px] text-center font-medium text-indigo-600 dark:text-indigo-300 mb-2 truncate">
                                📎 {pickedFile.name}
                            </p>
                        )}
                        {pickedFile && isExcelName(pickedFile.name) && (
                            <div className="mb-3 space-y-2">
                                <ToolSectionLabel>{t('preprocess.officeConvert:excel_layout')}</ToolSectionLabel>
                                <select
                                    value={excelLayout}
                                    onChange={(e) => setExcelLayout(e.target.value as ExcelLayout)}
                                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-[12px]"
                                >
                                    <option value="preserve">{t('preprocess.officeConvert:excel_preserve')}</option>
                                    <option value="fit_width">{t('preprocess.officeConvert:excel_fit_width')}</option>
                                    <option value="one_page">{t('preprocess.officeConvert:excel_one_page')}</option>
                                </select>
                                <p className="text-[10px] text-slate-400">{t('preprocess.officeConvert:excel_layout_hint')}</p>
                            </div>
                        )}
                        {pickedFile && (
                            <div className="mb-3 space-y-2">
                                <ToolSectionLabel>{t('preprocess.officeConvert:batch_resize_title')}</ToolSectionLabel>
                                <select
                                    value={singleResizePreset}
                                    onChange={(e) => setSingleResizePreset(e.target.value as BatchResizePreset)}
                                    disabled={isProcessing}
                                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-[12px]"
                                >
                                    <option value="none">{t('preprocess.officeConvert:batch_resize_none')}</option>
                                    <option value="a4">A4 — 210 × 297 mm</option>
                                    <option value="a3">A3 — 297 × 420 mm</option>
                                    <option value="letter">Letter — 215.9 × 279.4 mm</option>
                                    <option value="custom">{t('preprocess.officeConvert:batch_resize_custom')}</option>
                                </select>
                                {singleResizePreset === 'custom' && (
                                    <div className="grid grid-cols-2 gap-2">
                                        <label className="text-[10px] text-slate-500">
                                            {t('preprocess.officeConvert:batch_resize_width')}
                                            <input
                                                type="number"
                                                min={10}
                                                max={5000}
                                                step={0.1}
                                                value={singleCustomWidth}
                                                onChange={(e) => setSingleCustomWidth(Number(e.target.value))}
                                                className="mt-1 w-full px-2 py-2 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-[12px]"
                                            />
                                        </label>
                                        <label className="text-[10px] text-slate-500">
                                            {t('preprocess.officeConvert:batch_resize_height')}
                                            <input
                                                type="number"
                                                min={10}
                                                max={5000}
                                                step={0.1}
                                                value={singleCustomHeight}
                                                onChange={(e) => setSingleCustomHeight(Number(e.target.value))}
                                                className="mt-1 w-full px-2 py-2 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-[12px]"
                                            />
                                        </label>
                                    </div>
                                )}
                                <p className="text-[10px] text-slate-400">
                                    {t('preprocess.officeConvert:batch_resize_hint')}
                                </p>
                                <button
                                    type="button"
                                    onClick={() => void startSingleConversion()}
                                    disabled={isProcessing}
                                    className="w-full py-3 rounded-xl text-[13px] font-bold bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50"
                                >
                                    {t('preprocess.common:run')}{isProcessing ? '…' : ''}
                                </button>
                            </div>
                        )}
                        <button
                            type="button"
                            onClick={() => void pickWithDialog()}
                            disabled={isProcessing}
                            className="w-full py-3 rounded-xl text-[13px] font-bold bg-gradient-to-r from-indigo-500 to-violet-600 text-white shadow-lg disabled:opacity-50 hover:from-indigo-600 hover:to-violet-700"
                        >
                            {isProcessing
                                ? t('preprocess.officeConvert:dang_chuyen')
                                : t('preprocess.officeConvert:bam_chon_file')}
                        </button>
                        <p className="text-[10px] text-slate-400 mt-2 text-center">{t('preprocess.officeConvert:dinh_dang')}</p>
                        {capabilityStatus && (
                            <p className="text-[10px] text-slate-500 dark:text-zinc-400 mt-1 text-center">
                                {capabilityStatus.hint}<br />
                                {t('preprocess.officeConvert:supported_on_machine', {
                                    extensions: capabilityStatus.supported_extensions.join(', '),
                                })}
                            </p>
                        )}
                    </>
                ) : (
                    <>
                        <ToolSectionLabel>{t('preprocess.officeConvert:link_google')}</ToolSectionLabel>
                        <input
                            type="url"
                            value={googleUrl}
                            onChange={(e) => setGoogleUrl(e.target.value)}
                            placeholder="https://docs.google.com/document/d/…"
                            className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-[13px]"
                        />
                        <p className="text-[10px] text-slate-400 mt-1.5">{t('preprocess.officeConvert:google_hint')}</p>
                        <button
                            type="button"
                            onClick={() => void handleGoogle()}
                            disabled={isProcessing || !googleUrl.trim()}
                            className="mt-3 w-full py-3 rounded-xl text-[13px] font-bold bg-gradient-to-r from-sky-500 to-blue-600 text-white disabled:opacity-50"
                        >
                            {t('preprocess.common:run')}{isProcessing ? '…' : ''}
                        </button>
                    </>
                )}
            </div>

            {mode === 'file' && !canAnyBatch && (
                <div className="rounded-xl border border-amber-200 bg-amber-50/70 dark:border-amber-500/30 dark:bg-amber-500/10 p-3">
                    <div className="text-[12px] font-bold text-amber-800 dark:text-amber-300">Xử lý nhiều file và cả thư mục · PrynX Pro</div>
                    <div className="mt-1 text-[10px] text-amber-700/80 dark:text-amber-200/70">Bản Free vẫn chuyển từng file Word, Excel hoặc Google Docs bình thường.</div>
                </div>
            )}
            {mode === 'file' && canAnyBatch && (
                <div data-testid="office-batch-panel" className="rounded-xl border border-slate-200 dark:border-zinc-700 p-3 space-y-3">
                    <div>
                        <div className="text-[12px] font-bold text-slate-700 dark:text-zinc-200">
                            {t('preprocess.officeConvert:batch_title')}
                        </div>
                        <div className="text-[10px] text-slate-400 mt-1">
                            {t('preprocess.officeConvert:batch_desc')}
                        </div>
                        {!canOfficeBatch && canResizeBatch && (
                            <div className="mt-1 text-[10px] font-medium text-amber-700 dark:text-amber-300">Key hiện tại chỉ xử lý hàng loạt file PDF.</div>
                        )}
                    </div>
                    <button
                        type="button"
                        onClick={() => void chooseBatchFolders()}
                        disabled={isBatchRunning}
                        className="w-full py-2.5 rounded-lg border border-indigo-300 text-indigo-700 dark:text-indigo-300 text-[12px] font-bold hover:bg-indigo-50 dark:hover:bg-indigo-950/30 disabled:opacity-50"
                    >
                        {t('preprocess.officeConvert:batch_choose')}
                    </button>
                    <button
                        type="button"
                        onClick={() => void pickWithDialog()}
                        disabled={isBatchRunning || isProcessing}
                        className="w-full py-2.5 rounded-lg border border-emerald-300 text-emerald-700 dark:text-emerald-300 text-[12px] font-bold hover:bg-emerald-50 dark:hover:bg-emerald-950/30 disabled:opacity-50"
                    >
                        {t('preprocess.officeConvert:batch_choose_files')}
                    </button>
                    {batchResults.length > 0 && !batchOutputFolder && (
                        <button
                            type="button"
                            onClick={() => void chooseBatchOutputFolder()}
                            disabled={isBatchRunning}
                            className="w-full py-2.5 rounded-lg bg-indigo-600 text-white text-[12px] font-bold disabled:opacity-50"
                        >
                            {t('preprocess.officeConvert:batch_choose_output')}
                        </button>
                    )}
                    {batchSourceFolder && (
                        <div className="text-[10px] text-slate-500 dark:text-zinc-400 space-y-1 break-all">
                            <div><b>{t('preprocess.officeConvert:batch_source')}:</b> {batchSourceFolder}</div>
                            <div><b>{t('preprocess.officeConvert:batch_output')}:</b> {batchOutputFolder}</div>
                            <div>{t('preprocess.officeConvert:batch_count', { count: batchResults.length })}</div>
                        </div>
                    )}
                    {batchSourceFolder && canResizeBatch && (
                        <div data-testid="batch-resize-controls" className="space-y-2">
                            <ToolSectionLabel>{t('preprocess.officeConvert:batch_resize_title')}</ToolSectionLabel>
                            <select
                                value={batchResizePreset}
                                onChange={(e) => setBatchResizePreset(e.target.value as BatchResizePreset)}
                                disabled={isBatchRunning}
                                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-[12px]"
                            >
                                <option value="none">{t('preprocess.officeConvert:batch_resize_none')}</option>
                                <option value="a4">A4 — 210 × 297 mm</option>
                                <option value="a3">A3 — 297 × 420 mm</option>
                                <option value="letter">Letter — 215.9 × 279.4 mm</option>
                                <option value="custom">{t('preprocess.officeConvert:batch_resize_custom')}</option>
                            </select>
                            {batchResizePreset === 'custom' && (
                                <div className="grid grid-cols-2 gap-2">
                                    <label className="text-[10px] text-slate-500">
                                        {t('preprocess.officeConvert:batch_resize_width')}
                                        <input
                                            type="number"
                                            min={10}
                                            max={5000}
                                            step={0.1}
                                            value={batchCustomWidth}
                                            onChange={(e) => setBatchCustomWidth(Number(e.target.value))}
                                            className="mt-1 w-full px-2 py-2 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-[12px]"
                                        />
                                    </label>
                                    <label className="text-[10px] text-slate-500">
                                        {t('preprocess.officeConvert:batch_resize_height')}
                                        <input
                                            type="number"
                                            min={10}
                                            max={5000}
                                            step={0.1}
                                            value={batchCustomHeight}
                                            onChange={(e) => setBatchCustomHeight(Number(e.target.value))}
                                            className="mt-1 w-full px-2 py-2 rounded-lg border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-[12px]"
                                        />
                                    </label>
                                </div>
                            )}
                            <p className="text-[10px] text-slate-400">
                                {t('preprocess.officeConvert:batch_resize_hint')}
                            </p>
                        </div>
                    )}
                    {batchSourceFolder && !canResizeBatch && (
                        <div data-testid="batch-resize-locked" className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-[10px] font-medium text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                            Resize hàng loạt cần quyền PrynX Pro tương ứng.
                        </div>
                    )}
                    {batchResults.length > 0 && (
                        <>
                            <div className="max-h-44 overflow-y-auto rounded-lg border border-slate-100 dark:border-zinc-800 divide-y divide-slate-100 dark:divide-zinc-800">
                                {batchResults.map((item, index) => (
                                    <div key={`${item.path}-${index}`} className="px-2 py-1.5 text-[10px]">
                                        <div className="flex items-center gap-2">
                                            <span className="w-4 shrink-0">
                                                {item.status === 'processing' ? '⏳' : item.status === 'success' ? '✅' : item.status === 'error' ? '❌' : item.status === 'cancelled' ? '⏹' : '○'}
                                            </span>
                                            <span className="truncate flex-1 text-slate-600 dark:text-zinc-300">{item.name}</span>
                                        </div>
                                        {item.error && <div className="pl-6 text-red-500 break-words">{item.error}</div>}
                                    </div>
                                ))}
                            </div>
                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    onClick={() => void startBatch()}
                                    disabled={isBatchRunning || !batchOutputFolder}
                                    className="flex-1 py-2.5 rounded-lg bg-indigo-600 text-white text-[12px] font-bold disabled:opacity-50"
                                >
                                    {isBatchRunning ? t('preprocess.officeConvert:batch_running') : t('preprocess.officeConvert:batch_start')}
                                </button>
                                {isBatchRunning && (
                                    <button
                                        type="button"
                                        onClick={stopBatch}
                                        className="px-4 py-2.5 rounded-lg bg-red-50 text-red-600 border border-red-200 text-[12px] font-bold"
                                    >
                                        {t('preprocess.officeConvert:batch_stop')}
                                    </button>
                                )}
                            </div>
                        </>
                    )}
                </div>
            )}
            {progress && (
                <div className="flex items-center gap-3 bg-teal-50 dark:bg-teal-900/20 p-3 rounded-lg border border-teal-200">
                    <div className="w-5 h-5 rounded-full border-2 border-teal-500 border-t-transparent animate-spin shrink-0" />
                    <div className="min-w-0 flex-1">
                        <div className="text-[12px] text-teal-700 font-medium">{progress}</div>
                        {elapsedSeconds > 0 && (
                            <div className="text-[10px] text-teal-600/80">
                                {t('preprocess.officeConvert:elapsed', { seconds: elapsedSeconds })}
                            </div>
                        )}
                    </div>
                    {canExtendLease && activeJobId && (
                        <button
                            type="button"
                            onClick={() => void extendActiveLease()}
                            className="px-3 py-1.5 rounded-lg bg-amber-50 text-amber-700 border border-amber-200 text-[11px] font-bold"
                        >
                            {t('preprocess.officeConvert:continue_waiting')}
                        </button>
                    )}
                    {isProcessing && (
                        <button
                            type="button"
                            onClick={cancelActiveRequest}
                            className="px-3 py-1.5 rounded-lg bg-red-50 text-red-600 border border-red-200 text-[11px] font-bold"
                        >
                            {t('preprocess.officeConvert:batch_stop')}
                        </button>
                    )}
                </div>
            )}
            {error && (
                <div className="bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-200">
                    <span className="text-[12px] text-red-600 font-medium whitespace-pre-wrap">❌ {error}</span>
                </div>
            )}
            {success && (
                <div className="bg-emerald-50 dark:bg-emerald-900/20 p-3 rounded-lg border border-emerald-200">
                    <span className="text-[12px] text-emerald-700 font-medium">✅ {success}</span>
                </div>
            )}
        </div>
    );
}
