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
import { OFFICE_EXTENSIONS, isOfficePathOrName, mimeForOfficeName } from '../../lib/officeFileTypes';
import { ToolSectionLabel } from './ToolUI';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../../stores/useAuthStore';
import { canUse } from '../../lib/license/features';

interface Props {
    pdfFile?: File | null;
    /** File Office từ tab payload (Ctrl+O / drop cửa sổ) */
    officeSourceFile?: File | null;
    officeSourceFiles?: File[];
    onFileFixed?: (blob: Blob, filename: string) => void;
}

type Mode = 'file' | 'google';
type ExcelLayout = 'preserve' | 'fit_width' | 'one_page';
type BatchResizePreset = 'none' | 'a4' | 'a3' | 'letter' | 'custom';

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
    return /\.(xls|xlsx|csv)$/i.test(name);
}

function isSupportedLooseName(name: string): boolean {
    return /\.pdf$/i.test(name) || isOfficePathOrName(name);
}

function looksLikeGoogleUrl(text: string): boolean {
    const s = text.trim();
    return /docs\.google\.com\/(document|spreadsheets|presentation)\//i.test(s)
        || /drive\.google\.com\/file\/d\//i.test(s);
}

export default function OfficeConvertTool({ officeSourceFile, officeSourceFiles, onFileFixed }: Props) {
    const { t } = useTranslation();
    const licensePlan = useAuthStore((state) => state.licensePlan);
    const licenseFeatures = useAuthStore((state) => state.licenseFeatures);
    const canBatch = canUse('pdf.office_batch', licensePlan, licenseFeatures);
    const convertingRef = useRef(false);
    const lastSourceKeyRef = useRef<string>('');
    const batchCancelRef = useRef(false);

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


    // ── Core convert ─────────────────────────────────────────────
    const convertFile = useCallback(async (
        src: File,
        excelLayoutOverride?: ExcelLayout,
        resizeTarget?: { width: number; height: number } | null,
    ) => {
        if (convertingRef.current) return;
        convertingRef.current = true;
        setIsProcessing(true);
        setError('');
        setSuccess('');
        setProgress(t('preprocess.officeConvert:dang_chuyen'));
        setPickedFile(src);
        setMode('file');

        try {
            const formData = new FormData();
            if (isExcelName(src.name)) {
                formData.append('excel_layout', excelLayoutOverride || 'preserve');
            }
            const diskPath = (src as any).path as string | undefined;

            if (diskPath && typeof diskPath === 'string' && diskPath.length > 2) {
                // Prefer absolute path — backend reads disk, Word COM opens same path
                formData.append('file_path', diskPath);
            } else {
                // Browser File or bytes already loaded
                const real = await prepareFileForUpload(src);
                const blob = real instanceof Blob ? real : new Blob([real as any]);
                if (blob.size === 0) {
                    throw new Error(t('preprocess.officeConvert:loi_doc_file'));
                }
                formData.append('file', blob, src.name);
            }

            const res = await authenticatedFetch(`${getApiUrl()}/pdf-tools/office-convert/file`, {
                method: 'POST',
                body: formData,
            });
            if (!res.ok) {
                const errData = await res.json().catch(() => null);
                const detail = errData?.detail;
                const msg = typeof detail === 'string'
                    ? detail
                    : Array.isArray(detail)
                        ? detail.map((d: any) => d?.msg || JSON.stringify(d)).join('; ')
                        : t('preprocess.officeConvert:loi_server', { status: res.status });
                throw new Error(msg);
            }
            let outBlob = await res.blob();
            if (outBlob.size < 32) {
                throw new Error(t('preprocess.officeConvert:loi_pdf_rong'));
            }
            if (resizeTarget) {
                const resizeForm = new FormData();
                resizeForm.append('file', outBlob, 'converted_' + src.name.replace(/\.[^.]+$/, '') + '.pdf');
                resizeForm.append('target_w', String(resizeTarget.width));
                resizeForm.append('target_h', String(resizeTarget.height));
                resizeForm.append('auto_orientation', 'true');
                const resizeResponse = await authenticatedFetch(getApiUrl() + '/pdf-tools/office-convert/resize-output', {
                    method: 'POST',
                    body: resizeForm,
                });
                if (!resizeResponse.ok) {
                    const data = await resizeResponse.json().catch(() => null);
                    throw new Error(typeof data?.detail === 'string'
                        ? data.detail
                        : t('preprocess.officeConvert:loi_server', { status: resizeResponse.status }));
                }
                outBlob = await resizeResponse.blob();
            }
            const outName = `converted_${src.name.replace(/\.[^.]+$/, '')}.pdf`;
            setSuccess(t('preprocess.officeConvert:thanh_cong'));
            setProgress('');
            onFileFixed?.(outBlob, outName);
        } catch (e: any) {
            setError(e?.message || t('preprocess.officeConvert:loi_khong_xac_dinh'));
            setProgress('');
        } finally {
            convertingRef.current = false;
            setIsProcessing(false);
        }
    }, [onFileFixed, t]);
    const stageFile = useCallback((src: File) => {
        setPickedFile(src);
        setMode('file');
        setError('');
        setSuccess('');
        setProgress('');
    }, []);

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
        const key = `${(officeSourceFile as any).path || ''}|${officeSourceFile.name}|${officeSourceFile.size}`;
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
            if ((window as any).__TAURI_INTERNALS__) {
                const { open } = await import('@tauri-apps/plugin-dialog');
                const selected = await open({
                    multiple: canBatch,
                    filters: [
                        { name: 'Word / Excel / PowerPoint / PDF', extensions: [...OFFICE_EXTENSIONS, 'pdf'] },
                        { name: 'Office / PDF', extensions: [...OFFICE_EXTENSIONS, 'pdf'] },
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
                input.multiple = canBatch;
                input.accept = [...OFFICE_EXTENSIONS, 'pdf'].map((e) => '.' + e).join(',');
                input.onchange = async () => {
                    const files = Array.from(input.files || []);
                    if (files.length > 1 || /\.pdf$/i.test(files[0]?.name || '')) await stageLooseFiles(files);
                    else if (files[0]) stageFile(files[0]);
                };
                input.click();
            }
        } catch (e: any) {
            setError(e?.message || t('preprocess.officeConvert:loi_khong_xac_dinh'));
        }
    }, [canBatch, stageFile, t]);

    const handleGoogle = async () => {
        const url = googleUrl.trim();
        if (!url) {
            setError(t('preprocess.officeConvert:chua_dan_link'));
            return;
        }
        setIsProcessing(true);
        setError('');
        setSuccess('');
        setProgress(t('preprocess.officeConvert:dang_tai_google'));
        try {
            const formData = new FormData();
            formData.append('url', url);
            const res = await authenticatedFetch(`${getApiUrl()}/pdf-tools/office-convert/google`, {
                method: 'POST',
                body: formData,
            });
            if (!res.ok) {
                const errData = await res.json().catch(() => null);
                throw new Error(
                    (typeof errData?.detail === 'string' && errData.detail)
                    || t('preprocess.officeConvert:loi_server', { status: res.status })
                );
            }
            const blob = await res.blob();
            setSuccess(t('preprocess.officeConvert:thanh_cong_google'));
            setProgress('');
            onFileFixed?.(blob, 'google_export.pdf');
        } catch (e: any) {
            setError(e?.message || t('preprocess.officeConvert:loi_khong_xac_dinh'));
            setProgress('');
        } finally {
            setIsProcessing(false);
        }
    };

    const onDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);
        const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
        if (text && looksLikeGoogleUrl(text)) {
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
            if (!(window as any).__TAURI_INTERNALS__) {
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

            const files = await invoke<BatchFolderFile[]>('list_batch_folder_files', { folder: source });
            files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
            setBatchSourceFolder(source);
            setBatchOutputFolder(output);
            setBatchResults(files.map((file) => ({ ...file, status: 'pending' })));
            if (files.length === 0) setError(t('preprocess.officeConvert:batch_no_files'));
        } catch (e: any) {
            setError(e?.message || t('preprocess.officeConvert:loi_khong_xac_dinh'));
        }
    };

    async function stageLooseFiles(files: File[]) {
        const supported = files.filter((file) => isSupportedLooseName(file.name));
        if (supported.length === 0) {
            setError(t('preprocess.officeConvert:batch_no_files'));
            return;
        }
        if (supported.length === 1 && isOfficePathOrName(supported[0].name)) {
            stageFile(supported[0]);
            return;
        }
        const missingPath = supported.find((file) => !(file as any).path);
        if (missingPath) {
            setError(t('preprocess.officeConvert:batch_tauri_only'));
            return;
        }
        const results = supported
            .map((file) => ({
                path: (file as any).path as string,
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
        const supportedPaths = paths.filter(isSupportedLooseName);
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
        if (!(window as any).__TAURI_INTERNALS__) {
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
    }, [officeSourceFiles]);
    const updateBatchResult = (index: number, patch: Partial<BatchResult>) => {
        setBatchResults((current) => current.map((item, i) => i === index ? { ...item, ...patch } : item));
    };

    const startBatch = async () => {
        if (isBatchRunning || batchResults.length === 0 || !batchOutputFolder) return;
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
        for (let index = 0; index < batchResults.length; index += 1) {
            const item = batchResults[index];
            if (batchCancelRef.current) {
                setBatchResults((current) => current.map((entry, i) =>
                    i >= index && entry.status === 'pending' ? { ...entry, status: 'cancelled' } : entry));
                break;
            }
            updateBatchResult(index, { status: 'processing' });
            try {
                const preferredName = `${item.name.replace(/\.[^.]+$/, '')}.pdf`;
                const isPdf = /\.pdf$/i.test(item.name);
                let pdfBlob: Blob | null = null;
                let outputPath: string;

                if (isPdf && !resizeTarget) {
                    outputPath = await invoke<string>('copy_batch_pdf', {
                        source: item.path,
                        outputDir: batchOutputFolder,
                        preferredName,
                    });
                } else {
                    if (!isPdf) {
                        const formData = new FormData();
                        formData.append('file_path', item.path);
                        formData.append('batch_mode', 'true');
                        if (isExcelName(item.name)) formData.append('excel_layout', excelLayout);
                        const response = await authenticatedFetch(`${getApiUrl()}/pdf-tools/office-convert/file`, {
                            method: 'POST',
                            body: formData,
                        });
                        if (!response.ok) {
                            const data = await response.json().catch(() => null);
                            throw new Error(typeof data?.detail === 'string'
                                ? data.detail
                                : t('preprocess.officeConvert:loi_server', { status: response.status }));
                        }
                        pdfBlob = await response.blob();
                    }

                    if (resizeTarget) {
                        const resizeForm = new FormData();
                        if (isPdf) resizeForm.append('file_path', item.path);
                        else if (pdfBlob) resizeForm.append('file', pdfBlob, preferredName);
                        resizeForm.append('target_w', String(resizeTarget.width));
                        resizeForm.append('target_h', String(resizeTarget.height));
                        resizeForm.append('auto_orientation', 'true');
                        resizeForm.append('batch_mode', 'true');
                        const resizeResponse = await authenticatedFetch(`${getApiUrl()}/pdf-tools/office-convert/resize-output`, {
                            method: 'POST',
                            body: resizeForm,
                        });
                        if (!resizeResponse.ok) {
                            const data = await resizeResponse.json().catch(() => null);
                            throw new Error(typeof data?.detail === 'string'
                                ? data.detail
                                : t('preprocess.officeConvert:loi_server', { status: resizeResponse.status }));
                        }
                        pdfBlob = await resizeResponse.blob();
                    }

                    if (!pdfBlob) throw new Error(t('preprocess.officeConvert:loi_pdf_rong'));
                    const contents = new Uint8Array(await pdfBlob.arrayBuffer());
                    outputPath = await invoke<string>('write_batch_pdf', {
                        outputDir: batchOutputFolder,
                        preferredName,
                        contents,
                    });
                }
                successCount += 1;
                updateBatchResult(index, { status: 'success', outputPath });
            } catch (e: any) {
                errorCount += 1;
                updateBatchResult(index, {
                    status: 'error',
                    error: e?.message || t('preprocess.officeConvert:loi_khong_xac_dinh'),
                });
            }
        }
        setIsBatchRunning(false);
        setSuccess(t('preprocess.officeConvert:batch_summary', { success: successCount, error: errorCount }));
    };

    const stopBatch = () => {
        batchCancelRef.current = true;
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

            {mode === 'file' && !canBatch && (
                <div className="rounded-xl border border-amber-200 bg-amber-50/70 dark:border-amber-500/30 dark:bg-amber-500/10 p-3">
                    <div className="text-[12px] font-bold text-amber-800 dark:text-amber-300">Xử lý nhiều file và cả thư mục · PrynX Pro</div>
                    <div className="mt-1 text-[10px] text-amber-700/80 dark:text-amber-200/70">Bản Free vẫn chuyển từng file Word, Excel hoặc Google Docs bình thường.</div>
                </div>
            )}
            {mode === 'file' && canBatch && (
                <div className="rounded-xl border border-slate-200 dark:border-zinc-700 p-3 space-y-3">
                    <div>
                        <div className="text-[12px] font-bold text-slate-700 dark:text-zinc-200">
                            {t('preprocess.officeConvert:batch_title')}
                        </div>
                        <div className="text-[10px] text-slate-400 mt-1">
                            {t('preprocess.officeConvert:batch_desc')}
                        </div>
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
                    {batchSourceFolder && (
                        <div className="space-y-2">
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
                    <span className="text-[12px] text-teal-700 font-medium">{progress}</span>
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
