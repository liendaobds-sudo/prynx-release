import React, { useRef } from 'react';
import { getApiUrl, authenticatedFetch } from '../../lib/api';
import { ToolSectionLabel } from './ToolUI';
import { useUpscaleStore } from './useUpscaleStore';
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

// ─── Downscale 2x ─────────────────────────────────────────────────────────────
// Backend chạy scale x4 cố định. Nếu người dùng chọn 2x, hạ ảnh kết
// quả xuống 1/2 bằng canvas chất lượng cao (vẫn nét hơn nội suy trực tiếp từ ảnh
// gốc vì đã qua tái tạo chi tiết AI ở 4x).
async function downscaleBlob(sourceBlob: Blob, factor: number): Promise<Blob> {
    if (factor >= 4) return sourceBlob;
    const img = new Image();
    const url = URL.createObjectURL(sourceBlob);
    try {
        img.src = url;
        await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error(tv('Lỗi đọc ảnh kết quả'))); });
        const targetW = Math.round(img.width * (factor / 4));
        const targetH = Math.round(img.height * (factor / 4));
        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d')!;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, targetW, targetH);
        return await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(b => b ? resolve(b) : reject(new Error('Canvas toBlob failed')), 'image/png'));
    } finally {
        URL.revokeObjectURL(url);
    }
}

// ─── Process batch (riêng cho upscale — gọi /upscale) ─────────────────────────
async function processBatch(tabId: string) {
    const store = useUpscaleStore.getState();
    const tabState = store.getTab(tabId);
    const { options, batchItems } = tabState;
    store.setIsProcessing(tabId, true);
    const items = [...batchItems];
    let processed = 0;
    const apiUrl = getApiUrl();
    for (let i = 0; i < items.length; i++) {
        if (items[i].status === 'success') continue;
        processed++;
        store.setProgress(tabId, `${tv('Đang phóng to')} ${processed} / ${items.length}...`);
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
            formData.append('engine', 'general');
            // authenticatedFetch: router /pdf-tools yêu cầu license + chữ ký HMAC
            // ở bản đóng gói. Raw fetch thiếu header → 403 (chỉ dev mới lọt).
            const res = await authenticatedFetch(`${apiUrl}/pdf-tools/upscale`, { method: 'POST', body: formData });
            if (!res.ok) {
                const errorText = await res.text();
                console.error('[Upscale] Server error:', errorText);
                throw new Error(`${tv('Lỗi Server')} (${res.status}): ${errorText}`);
            }
            let outBlob = await res.blob();
            if (options.scaleFactor === 2) {
                outBlob = await downscaleBlob(outBlob, 2);
            }
            const outUrl = URL.createObjectURL(outBlob);
            items[i] = { ...items[i], status: 'success', resultBlob: outBlob, resultUrl: outUrl };
        } catch (e: any) {
            console.error('[Upscale] Error:', e);
            items[i] = { ...items[i], status: 'error', error: e.message };
        }
        store.setBatchItems(tabId, [...items]);
    }
    store.setProgress(tabId, '');
    store.setIsProcessing(tabId, false);
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
    const tabState = useUpscaleStore(state => state.tabs[tabId] || useUpscaleStore.getState().getTab(tabId));
    const storeActions = useUpscaleStore.getState();
    const { batchItems, selectedId, options, isProcessing, progress, error } = tabState;

    const hasPending = batchItems.some(i => i.status === 'pending' || i.status === 'error');
    const hasSuccess = batchItems.some(i => i.status === 'success');

    // Auto-add pdfFile khi mount (dedup theo path|name|size)
    const addedRef = useRef<Set<string>>(new Set());
    React.useEffect(() => {
        useUpscaleStore.getState().initTab(tabId);
        if (!pdfFile) return;
        const isImage = pdfFile.type.startsWith('image/') || pdfFile.name.match(/\.(jpg|jpeg|png|webp|gif|tiff?|bmp)$/i);
        if (!isImage) return;
        const key = ((pdfFile as any).path || '') + '|' + pdfFile.name + '|' + pdfFile.size;
        if (addedRef.current.has(key)) return;
        addedRef.current.add(key);
        normalizeAndAddFiles([pdfFile], tabId, useUpscaleStore);
    }, [pdfFile, tabId]);

    // Global flag + warm model (fire-and-forget).
    React.useEffect(() => {
        (window as any).__isUpscalerActive = true;
        try {
            const fd = new FormData();
            fd.append('engine', 'general');
            authenticatedFetch(`${getApiUrl()}/pdf-tools/upscale/warmup`, { method: 'POST', body: fd }).catch(() => {});
        } catch { /* ignore */ }
        return () => { (window as any).__isUpscalerActive = false; };
    }, [tabId]);

    const setOption = <K extends keyof typeof options>(key: K, val: (typeof options)[K]) => {
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
                <ToolSectionLabel>{t('preprocess.upscale:muc_do_phong_to_upscale_factor')}</ToolSectionLabel>
                <select
                    value={options.scaleFactor}
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

export function UpscalePreview({ tabId }: { tabId: string }) {
  const { t } = useTranslation();
    return (
        <ImageBatchPreview
            tabId={tabId}
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
