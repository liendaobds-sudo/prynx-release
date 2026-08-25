import { useState } from 'react';
import { authenticatedFetch, getApiUrl, prepareFileForUpload } from '../../lib/api';
import { useWorkingPdf } from '../../hooks/useWorkingPdf';
import { recipeRecorder, type RecipeOperationTicket } from '../../lib/recipe/RecipeRecorder';
import { ToolSectionLabel, ToolCheckboxOption, ToolNumberInput, ToolInfo } from './ToolUI';
import { useTranslation } from 'react-i18next';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { RichSelect } from '../imposition-tools/SharedUI';

interface Props {
    tabId?: string;
    pdfFile: File | null;
    onFileFixed?: (
        blob: Blob,
        filename: string,
        path?: string,
        recipeTicket?: RecipeOperationTicket | null,
    ) => void | Promise<void>;
}

const PRESETS = [
    { id: 'screen',   label: '📱 Màn hình',     desc: '72 DPI — Nhỏ nhất, gửi email/Zalo' },
    { id: 'ebook',    label: '💻 Ebook/Web',     desc: '150 DPI — Cân bằng chất lượng & dung lượng' },
    { id: 'printer',  label: '🖨️ In kỹ thuật số', desc: '300 DPI — Chất lượng cao, file vừa phải' },
    { id: 'prepress', label: '🏭 Prepress',      desc: '300 DPI — Giữ nguyên tất cả, nén nhẹ nhất' },
    { id: 'custom',   label: '⚙️ Tùy chỉnh',    desc: 'Tự chọn DPI và thông số' },
];

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function OptimizeTool({ tabId, pdfFile, onFileFixed }: Props) {
  const { t } = useTranslation();
    const getWorkingFile = useWorkingPdf();
    const [preset, setPreset] = useState('ebook');
    const [imageDpi, setImageDpi] = useState(300);
    const [stripMetadata, setStripMetadata] = useState(true);
    const [grayscale, setGrayscale] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [progress, setProgress] = useState('');
    const [error, setError] = useState('');
    const [result, setResult] = useState<{
        originalSize: number;
        outputSize: number;
        ratio: number;
    } | null>(null);

    // Dung lượng file hiển thị: đọc fileSizeStr từ store (được ImposerTab cập nhật
    // sau MỌI thao tác: mở file, bù xén, xử lý xong). pdfFile.size không đáng tin —
    // File tham chiếu path trên disk (Tauri) có size===0 sau khi qua công cụ khác.
    const fileSizeStr = useWorkspaceStore((state) => state.fileSizeStr);

    const handleRun = async () => {
        if (!pdfFile) {
            setError(t('preprocess.optimize:chua_mo_file_pdf_nao'));
            return;
        }

        setIsProcessing(true);
        setError('');
        setResult(null);
        setProgress(t('preprocess.optimize:dang_chuan_bi_du_lieu'));

        const shouldRecord = !!tabId && recipeRecorder.isRecordingFor(tabId);
        const recipeTicket = shouldRecord
            ? recipeRecorder.noteOperation('optimize', {
                preset,
                image_dpi: imageDpi,
                strip_metadata: stripMetadata,
                grayscale,
            }, undefined, tabId)
            : null;
        if (shouldRecord && !recipeTicket) {
            setError(t('tabs.imposition:dang_xu_ly_file'));
            setProgress('');
            setIsProcessing(false);
            return;
        }

        try {
            const realFile = await prepareFileForUpload((await getWorkingFile()) || pdfFile);
            const formData = new FormData();
            formData.append('file', realFile, pdfFile.name);
            formData.append('preset', preset);
            formData.append('image_dpi', String(imageDpi));
            formData.append('strip_metadata', stripMetadata ? 'true' : 'false');
            formData.append('grayscale', grayscale ? 'true' : 'false');

            setProgress(t('preprocess.optimize:he_thong_dang_tien_hanh_nen_va_toi_uu'));

            const response = await authenticatedFetch(`${getApiUrl()}/pdf-tools/optimize`, {
                method: 'POST',
                body: formData,
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => null);
                throw new Error(errData?.detail || t('preprocess.optimize:loi_server', { status: response.status }));
            }

            const blob = await response.blob();

            const originalSize = parseInt(response.headers.get('X-Original-Size') || '0');
            const outputSize = parseInt(response.headers.get('X-Output-Size') || '0');
            const ratio = parseFloat(response.headers.get('X-Compression-Ratio') || '0');

            setResult({ originalSize, outputSize, ratio });
            setProgress('');

            if (onFileFixed) {
                const newName = `optimized_${pdfFile.name}`;
                await onFileFixed(blob, newName, undefined, recipeTicket);
            } else {
                recipeRecorder.discardPending(recipeTicket);
            }
        } catch (e: unknown) {
            recipeRecorder.discardPending(recipeTicket);
            const message = e instanceof Error
                ? e.message
                : typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string'
                    ? e.message
                    : '';
            setError(message || t('preprocess.optimize:da_xay_ra_loi_khong_xac_dinh'));
            setProgress('');
        } finally {
            setIsProcessing(false);
        }
    };

    const selectedPreset = PRESETS.find(p => p.id === preset);

    return (
        <div className="flex flex-col gap-4">
            {/* Preset Selection */}
            <div>
                <ToolSectionLabel>{t('preprocess.optimize:muc_nen')}</ToolSectionLabel>
                <RichSelect
                    value={preset}
                    onChange={setPreset}
                    options={PRESETS.map(opt => ({
                        value: opt.id,
                        title: opt.label,
                        desc: opt.desc,
                    }))}
                />
            </div>

            {/* Custom DPI */}
            {preset === 'custom' && (
                <div>
                    <ToolNumberInput
                        label={t('preprocess.optimize:dpi_anh_dau_ra')}
                        value={imageDpi}
                        onChange={setImageDpi}
                        suffix="DPI"
                        step={50}
                    />
                    <p className="text-[10px] text-slate-400 mt-1">{t('preprocess.optimize:in_offset_300_dpi_in_ky_thuat_so_150')}</p>
                </div>
            )}

            {/* Options */}
            <div>
                <ToolSectionLabel>{t('preprocess.optimize:tuy_chon')}</ToolSectionLabel>
                <div className="flex flex-col gap-1.5">
                    <ToolCheckboxOption
                        label={t('preprocess.optimize:xoa_metadata_thua')}
                        desc={t('preprocess.optimize:go_xmp_history_photoshop_thong_tin_tac')}
                        selected={stripMetadata}
                        onClick={() => setStripMetadata(!stripMetadata)}
                    />
                    <ToolCheckboxOption
                        label={t('preprocess.optimize:chuyen_sang_grayscale')}
                        desc={t('preprocess.optimize:bo_toan_bo_mau_chi_giu_den_trang_giam')}
                        selected={grayscale}
                        onClick={() => setGrayscale(!grayscale)}
                    />
                </div>
            </div>

            {/* Info */}
            <ToolInfo desc={
                <>
                    <strong>Optimize PDF</strong> {t('preprocess.optimize:giam_dung_luong_file_bang_cach_nen')}{' '}
                    {t('preprocess.optimize:chat_luong_in')} {selectedPreset?.id === 'screen' ? t('preprocess.optimize:giam_dang_ke') : selectedPreset?.id === 'ebook' ? t('preprocess.optimize:giam_nhe') : t('preprocess.optimize:giu_nguyen')}.
                    {pdfFile && <> {t('preprocess.optimize:file_hien_tai')} <strong>{fileSizeStr || (pdfFile.size > 0 ? formatSize(pdfFile.size) : '—')}</strong></>}
                </>
            } />

            {/* Execute */}
            <button
                onClick={handleRun}
                disabled={isProcessing || !pdfFile}
                className={`w-full py-3 rounded-xl text-[13px] font-bold transition-all shadow-lg ${
                    isProcessing || !pdfFile
                        ? 'bg-slate-300 dark:bg-zinc-700 text-slate-500 cursor-not-allowed'
                        : 'bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white shadow-emerald-500/25 hover:shadow-emerald-500/40'
                }`}
            >
                {t('preprocess.common:run')}{isProcessing ? '…' : ''}
            </button>

            {/* Progress */}
            {progress && (
                <div className="flex items-center gap-3 bg-teal-50 dark:bg-teal-900/20 p-3 rounded-lg border border-teal-200 dark:border-teal-800/50">
                    <div className="w-5 h-5 rounded-full border-2 border-teal-500 border-t-transparent animate-spin shrink-0" />
                    <span className="text-[12px] text-teal-700 dark:text-teal-300 font-medium">{progress}</span>
                </div>
            )}

            {/* Error */}
            {error && (
                <div className="bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-200 dark:border-red-800/50">
                    <span className="text-[12px] text-red-600 dark:text-red-400 font-medium">❌ {error}</span>
                </div>
            )}

            {/* Result */}
            {result && (
                <div className="bg-emerald-50 dark:bg-emerald-900/20 p-4 rounded-lg border border-emerald-200 dark:border-emerald-800/50">
                    <h4 className="text-[12px] font-bold text-emerald-700 dark:text-emerald-400 mb-3">
                        {result.ratio > 0 ? t('preprocess.optimize:nen_thanh_cong') : t('preprocess.optimize:file_da_toi_uu_san_khong_giam_them_duoc')}
                    </h4>

                    {/* Visual size comparison */}
                    <div className="flex items-center gap-3 mb-3">
                        <div className="flex-1 text-center">
                            <div className="text-[10px] text-slate-500 mb-1">{t('preprocess.optimize:truoc')}</div>
                            <div className="text-lg font-black text-slate-600 dark:text-zinc-300">{formatSize(result.originalSize)}</div>
                        </div>
                        <div className="flex flex-col items-center">
                            <svg className="w-5 h-5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                            </svg>
                        </div>
                        <div className="flex-1 text-center">
                            <div className="text-[10px] text-slate-500 mb-1">{t('preprocess.optimize:sau')}</div>
                            <div className="text-lg font-black text-emerald-600 dark:text-emerald-300">{formatSize(result.outputSize)}</div>
                        </div>
                    </div>


                </div>
            )}
        </div>
    );
}
