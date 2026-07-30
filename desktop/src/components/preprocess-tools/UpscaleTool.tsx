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

// ─── Props ───────────────────────────────────────────────────────────────────
interface Props {
    tabId: string;
    pdfFile: File | null;
}


// ─── Process batch (riêng cho upscale — gọi /upscale) ─────────────────────────
const upscaleControllers = new Map<string, AbortController>();
let warmupWarningShown = false;

// UIUX (audit 2026-07-29 §NET.10): nhãn kết quả chỉ nói TÊN CHẾ ĐỘ, không nêu tên
// model/kiến trúc. Tên model chỉ còn trong THIRD_PARTY_NOTICES.md — chỗ đó là nghĩa
// vụ ghi công của giấy phép BSD-3-Clause, không được bỏ.
function modeLabel(model: 'quality' | 'balanced' | 'general'): string {
    if (model === 'quality') return tv('Chất lượng');
    if (model === 'balanced') return tv('Cân bằng');
    return tv('Nhanh');
}

async function processBatch(tabId: string) {
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
                const formData = new FormData();
                const item = items[i];
                if (item.fileObj && item.fileObj.size > 0) {
                    formData.append('file', item.fileObj, item.fileName);
                } else if (item.path && item.path !== 'browser-file') {
                    formData.append('file_path', item.path);
                } else {
                    throw new Error(tv('Không tìm thấy file gốc'));
                }
                formData.append('engine', options.model);
                formData.append('scale_factor', String(options.scaleFactor));
                const res = await authenticatedFetch(apiUrl + '/pdf-tools/upscale', {
                    method: 'POST',
                    body: formData,
                    signal: controller.signal,
                });
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
                    toast.info(tv('Ảnh CMYK đã được chuyển sang sRGB để mô hình AI xử lý.'));
                }
                if (warningCodes.includes('bit-depth-reduced-to-8')) {
                    toast.info(tv('Ảnh 16-bit được xử lý ở 8-bit; hãy kiểm tra chuyển sắc trước khi in.'));
                }
                const outputSize = res.headers.get('X-Upscale-Output-Size') || '';
                const outBlob = await res.blob();
                const outUrl = URL.createObjectURL(outBlob);
                items[i] = {
                    ...items[i],
                    status: 'success',
                    resultBlob: outBlob,
                    resultUrl: outUrl,
                    resultInfo: (outputSize ? outputSize.replace('x', ' × ') + ' px · ' : '')
                        + '×' + options.scaleFactor + ' · ' + modeLabel(options.model),
                };
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
async function handleSave(tabId: string) {
    const { saved, ok } = await saveBatch(tabId, useUpscaleStore, 'upscaled');
    if (!ok) toast.error(tv('Lỗi khi lưu file.'));
    else if (saved > 0) toast.success(`✅ ${tv('Đã lưu thành công')} ${saved} ${tv('ảnh!')}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIDEBAR — Rendered in the right settings panel
// ═══════════════════════════════════════════════════════════════════════════════

export default function UpscaleTool({ tabId, pdfFile }: Props) {
  const { t } = useTranslation();
    const tabState = useUpscaleStore(state => state.tabs[tabId] || defaultUpscaleTabState);
    const storeActions = useUpscaleStore.getState();
    const { batchItems, selectedId, options, isProcessing, progress, error } = tabState;

    const hasPending = batchItems.some(i => i.status === 'pending' || i.status === 'error');
    const hasSuccess = batchItems.some(i => i.status === 'success');

    // Auto-add pdfFile khi mount (dedup theo path|name|size)
    const addedRef = useRef<Set<string>>(new Set());
    React.useEffect(() => {
        useUpscaleStore.getState().initTab(tabId);
        if (!pdfFile) return;
        const isImage = pdfFile.type.startsWith('image/') || pdfFile.name.match(/\.(jpg|jpeg|png|webp|tiff?|bmp)$/i);
        if (!isImage) return;
        const sourcePath = 'path' in pdfFile && typeof pdfFile.path === 'string' ? pdfFile.path : '';
        const key = sourcePath + '|' + pdfFile.name + '|' + pdfFile.size;
        if (addedRef.current.has(key)) return;
        addedRef.current.add(key);
        normalizeAndAddFiles([pdfFile], tabId, useUpscaleStore);
    }, [pdfFile, tabId]);

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

    // Global flag + warm model (fire-and-forget).
    React.useEffect(() => {
        const upscaleWindow = window as Window & { __isUpscalerActive?: boolean };
        upscaleWindow.__isUpscalerActive = true;
        try {
            const fd = new FormData();
            fd.append('engine', options.model);
            void authenticatedFetch(getApiUrl() + '/pdf-tools/upscale/warmup', { method: 'POST', body: fd })
                .then(async response => {
                    const payload = response.ok ? await response.json() as { ok?: boolean } : null;
                    if (!payload?.ok && !warmupWarningShown) {
                        warmupWarningShown = true;
                        toast.info(tv('Mô hình Upscale chưa sẵn sàng; lần xử lý đầu có thể thất bại.'));
                    }
                })
                .catch(() => {
                    if (!warmupWarningShown) {
                        warmupWarningShown = true;
                        toast.info(tv('Không thể kiểm tra mô hình Upscale; hãy kiểm tra sidecar.'));
                    }
                });
        } catch { /* ignore */ }
        return () => { upscaleWindow.__isUpscalerActive = false; };
    }, [tabId, options.model]);

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
                resultUrl: undefined,
                resultInfo: undefined,
                error: undefined,
            };
        }));
        storeActions.setOptions(tabId, { ...options, [key]: val });
    };

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
                <button onClick={() => processBatch(tabId)} disabled={isProcessing || !hasPending}
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
                            <button onClick={() => selectedId && storeActions.undoItem(tabId, selectedId)} title={t('preprocess.upscale:hoan_tac_de_chinh_sua_lai')}
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
