import React, { useRef } from 'react';
import { getApiUrl, authenticatedFetch } from '../../lib/api';
import BgRemoverOptions from './BgRemoverOptions';
import { useBgRemoverStore, defaultTabState } from './useBgRemoverStore';
import { normalizeAndAddFiles, openFilePicker, saveBatch } from './imageBatch/helpers';
import { ImageBatchPreview } from './imageBatch/ImageBatchPreview';
import { toast } from '../ui/Toast';
import { RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { tv } from '../../i18n';

// ─── Props ───────────────────────────────────────────────────────────────────
interface Props {
    tabId: string;
    pdfFile: File | null;
}

// ─── Process batch (riêng cho tách nền — gọi /remove-background) ──────────────
async function processBatch(tabId: string) {
    const store = useBgRemoverStore.getState();
    const tabState = store.getTab(tabId);
    const { options, batchItems } = tabState;
    store.setIsProcessing(tabId, true);
    const items = [...batchItems];
    let processed = 0;
    const apiUrl = getApiUrl();
    for (let i = 0; i < items.length; i++) {
        if (items[i].status === 'success') continue;
        processed++;
        store.setProgress(tabId, `${tv('Đang tách nền')} ${processed} / ${items.length}...`);
        items[i] = { ...items[i], status: 'processing', error: undefined };
        store.setBatchItems(tabId, [...items]);
        try {
            const formData = new FormData();
            const item = items[i];
            // Always send file content if available (normalized PNG)
            if (item.fileObj && item.fileObj.size > 0) {
                formData.append('file', item.fileObj, item.fileName);
            } else if (item.path && item.path !== 'browser-file') {
                formData.append('file_path', item.path);
            } else {
                throw new Error(tv('Không tìm thấy file gốc'));
            }
            formData.append('engine', options.aiEngine || 'general');
            formData.append('edge_shift', options.edgeShift.toString());
            formData.append('bg_color', options.bgColor);
            formData.append('custom_hex', options.customHex);
            formData.append('auto_crop', options.autoCrop ? 'true' : 'false');
            // PHẢI dùng authenticatedFetch: router /pdf-tools có Depends(require_license)
            // → ở production cần X-PrynX-Token + chữ ký HMAC (Rust sign_api_request).
            // Raw fetch thiếu các header này → 403 trên bản đóng gói (chỉ dev mới lọt).
            const res = await authenticatedFetch(`${apiUrl}/pdf-tools/remove-background`, { method: 'POST', body: formData });
            if (!res.ok) {
                const errorText = await res.text();
                console.error('[BgRemover] Server error:', errorText);
                throw new Error(`${tv('Lỗi Server')} (${res.status}): ${errorText}`);
            }
            const outBlob = await res.blob();
            const outUrl = URL.createObjectURL(outBlob);
            items[i] = { ...items[i], status: 'success', resultBlob: outBlob, resultUrl: outUrl };
        } catch (e: any) {
            console.error('[BgRemover] Error:', e);
            items[i] = { ...items[i], status: 'error', error: e.message };
        }
        store.setBatchItems(tabId, [...items]);
    }
    store.setProgress(tabId, '');
    store.setIsProcessing(tabId, false);
}

async function handleSave(tabId: string) {
    const { saved, ok } = await saveBatch(tabId, useBgRemoverStore, 'nobg');
    if (!ok) toast.error(tv('Lỗi khi lưu file.'));
    else if (saved > 0) toast.success(`✅ ${tv('Đã lưu thành công')} ${saved} ${tv('ảnh!')}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIDEBAR — Rendered in the right settings panel
// ═══════════════════════════════════════════════════════════════════════════════

export default function BgRemoverTool({ tabId, pdfFile }: Props) {
  const { t } = useTranslation();
    const tabState = useBgRemoverStore(state => state.tabs[tabId] || defaultTabState);
    const storeActions = useBgRemoverStore.getState();
    const { batchItems, selectedId, options, isProcessing, progress, error } = tabState;

    // console.log(`[BgRemoverTool] render tabId="${tabId}", batchItems=${batchItems.length}`);

    const hasPending = batchItems.some(i => i.status === 'pending' || i.status === 'error');
    const hasSuccess = batchItems.some(i => i.status === 'success');

    // Auto-add pdfFile
    const addedRef = useRef<Set<string>>(new Set());
    React.useEffect(() => {
        const currentStore = useBgRemoverStore.getState();
        currentStore.initTab(tabId);
        if (!pdfFile) {
            // console.log('[BgRemover] Auto-add: pdfFile is null');
            return;
        }
        const isImage = pdfFile.type.startsWith('image/') || pdfFile.name.match(/\.(jpg|jpeg|png|webp|gif|tiff?|bmp)$/i);
        // console.log('[BgRemover] Auto-add: checking pdfFile', pdfFile.name, 'isImage:', !!isImage);
        if (!isImage) return;
        const key = ((pdfFile as any).path || '') + '|' + pdfFile.name + '|' + pdfFile.size;
        if (addedRef.current.has(key)) {
            // console.log('[BgRemover] Auto-add: already added', key);
            return;
        }
        addedRef.current.add(key);
        normalizeAndAddFiles([pdfFile], tabId, useBgRemoverStore);
    }, [pdfFile, tabId]);

    // Global flag
    React.useEffect(() => {
        (window as any).__isBgRemoverActive = true;
        // Nạp sẵn ĐÚNG model AI người dùng đang chọn (chạy nền) → lần bấm Tách Nền
        // đầu không phải chờ cold-start. Fire-and-forget, lỗi bỏ qua.
        try {
            const eng = useBgRemoverStore.getState().getTab(tabId)?.options?.aiEngine || 'general';
            const fd = new FormData();
            fd.append('engine', eng);
            authenticatedFetch(`${getApiUrl()}/pdf-tools/remove-background/warmup`, { method: 'POST', body: fd }).catch(() => {});
        } catch { /* ignore */ }
        return () => { (window as any).__isBgRemoverActive = false; };
    }, [tabId]);

    // Listen for external file events
    React.useEffect(() => {
        const handleAdd = (e: Event) => {
            const files = (e as CustomEvent).detail?.files as File[];
            if (files?.length) normalizeAndAddFiles(files, tabId, useBgRemoverStore);
        };
        const handleTrigger = () => openFilePicker(tabId, useBgRemoverStore);
        window.addEventListener('prynx-bgremover-add-files', handleAdd);
        window.addEventListener('prynx-bgremover-trigger-select', handleTrigger);
        return () => {
            window.removeEventListener('prynx-bgremover-add-files', handleAdd);
            window.removeEventListener('prynx-bgremover-trigger-select', handleTrigger);
        };
    }, [tabId]);

    // Removed reset store on unmount to keep state when switching tools


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
                    <div onClick={() => openFilePicker(tabId, useBgRemoverStore)}
                        className="shrink-0 w-14 h-14 rounded-lg border-2 border-dashed border-slate-300 dark:border-zinc-600 flex items-center justify-center cursor-pointer hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors">
                        <span className="text-lg text-slate-400">+</span>
                    </div>
                </div>
            )}

            <BgRemoverOptions options={options} onChange={(opts) => storeActions.setOptions(tabId, opts)} />

            <div className="flex flex-col gap-2">
                <button onClick={() => processBatch(tabId)} disabled={isProcessing || !hasPending}
                    className={`w-full h-11 rounded-xl text-[13px] font-bold transition-all flex items-center justify-center gap-2 shadow-sm ${
                        isProcessing || !hasPending
                        ? 'bg-slate-300 text-slate-500 cursor-not-allowed dark:bg-zinc-700 dark:text-zinc-400'
                        : 'bg-indigo-600 hover:bg-indigo-700 text-white'}`}>
                    {isProcessing ? t('preprocess.bgRemover:dang_xu_ly') : t('preprocess.bgRemover:bat_dau_tach_nen')}
                </button>
                {hasSuccess && (
                    <div className="flex gap-2">
                        <button onClick={() => handleSave(tabId)}
                            className="flex-1 h-11 rounded-xl text-[13px] font-bold bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm flex items-center justify-center gap-2 transition-all">
                            💾 {t('preprocess.bgRemover:luu_tat_ca')} ({batchItems.filter(i => i.status === 'success').length})
                        </button>
                        {batchItems.find(i => i.id === selectedId)?.status === 'success' && (
                            <button onClick={() => selectedId && storeActions.undoItem(tabId, selectedId)} title={t('preprocess.bgRemover:hoan_tac_de_chinh_sua_lai')}
                                className="px-4 h-11 rounded-xl text-[13px] font-bold bg-amber-500 hover:bg-amber-600 text-white shadow-sm flex items-center justify-center gap-1.5 transition-all">
                                <RotateCcw className="w-4 h-4" /> {t('preprocess.bgRemover:hoan_tac')}
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
// PREVIEW — wrapper mỏng quanh ImageBatchPreview dùng chung (zoom/pan/slider).
// ═══════════════════════════════════════════════════════════════════════════════

export function BgRemoverPreview({ tabId }: { tabId: string }) {
  const { t } = useTranslation();
    return (
        <ImageBatchPreview
            tabId={tabId}
            store={useBgRemoverStore}
            labels={{
                resultBadge: t('preprocess.bgRemover:da_tach_nen'),
                originalBadge: t('preprocess.bgRemover:anh_goc'),
                emptyTitle: t('preprocess.bgRemover:tach_nen_ai'),
                emptyHint: <>{t('preprocess.bgRemover:keo_tha_anh_vao_day_hoac_bam_de_chon')}<br/>{t('preprocess.bgRemover:ho_tro_jpg_png_tiff_webp_bmp')}</>,
                emptyIcon: '✨',
                processingText: t('preprocess.bgRemover:dang_tach_nen'),
            }}
        />
    );
}

