import { useState } from 'react';
import { authenticatedFetch, getApiUrl, prepareFileForUpload } from '../../lib/api';
import { useWorkingPdf } from '../../hooks/useWorkingPdf';
import { recipeRecorder } from '../../lib/recipe/RecipeRecorder';
import { ToolSectionLabel, ToolCardOption, ToolCheckboxOption, ToolNumberInput, ToolInfo } from './ToolUI';

interface Props {
    pdfFile: File | null;
    onFileFixed?: (blob: Blob, filename: string) => void;
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

export default function OptimizeTool({ pdfFile, onFileFixed }: Props) {
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

    const handleRun = async () => {
        if (!pdfFile) {
            setError('Chưa mở file PDF nào.');
            return;
        }

        setIsProcessing(true);
        setError('');
        setResult(null);
        setProgress('Đang chuẩn bị dữ liệu...');

        try {
            const realFile = await prepareFileForUpload((await getWorkingFile()) || pdfFile);
            recipeRecorder.noteOperation('optimize', {
                preset,
                image_dpi: imageDpi,
                strip_metadata: stripMetadata,
                grayscale,
            });
            const formData = new FormData();
            formData.append('file', realFile, pdfFile.name);
            formData.append('preset', preset);
            formData.append('image_dpi', String(imageDpi));
            formData.append('strip_metadata', stripMetadata ? 'true' : 'false');
            formData.append('grayscale', grayscale ? 'true' : 'false');

            setProgress('Hệ thống đang tiến hành nén và tối ưu PDF...');

            const response = await authenticatedFetch(`${getApiUrl()}/pdf-tools/optimize`, {
                method: 'POST',
                body: formData,
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => null);
                throw new Error(errData?.detail || `Lỗi server (${response.status})`);
            }

            const blob = await response.blob();

            const originalSize = parseInt(response.headers.get('X-Original-Size') || '0');
            const outputSize = parseInt(response.headers.get('X-Output-Size') || '0');
            const ratio = parseFloat(response.headers.get('X-Compression-Ratio') || '0');

            setResult({ originalSize, outputSize, ratio });
            setProgress('');

            if (onFileFixed) {
                const newName = `optimized_${pdfFile.name}`;
                onFileFixed(blob, newName);
            }
        } catch (e: any) {
            recipeRecorder.discardPending();
            setError(e.message || 'Đã xảy ra lỗi không xác định.');
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
                <ToolSectionLabel>Mức nén</ToolSectionLabel>
                <div className="flex flex-col gap-1.5">
                    {PRESETS.map(opt => (
                        <ToolCardOption
                            key={opt.id}
                            label={opt.label}
                            desc={opt.desc}
                            selected={preset === opt.id}
                            onClick={() => setPreset(opt.id)}
                        />
                    ))}
                </div>
            </div>

            {/* Custom DPI */}
            {preset === 'custom' && (
                <div>
                    <ToolNumberInput
                        label="DPI ảnh đầu ra"
                        value={imageDpi}
                        onChange={setImageDpi}
                        suffix="DPI"
                        step={50}
                    />
                    <p className="text-[10px] text-slate-400 mt-1">In offset: 300 DPI | In kỹ thuật số: 150-200 DPI | Web: 72 DPI</p>
                </div>
            )}

            {/* Options */}
            <div>
                <ToolSectionLabel>Tùy chọn</ToolSectionLabel>
                <div className="flex flex-col gap-1.5">
                    <ToolCheckboxOption
                        label="Xóa metadata thừa"
                        desc="Gỡ XMP, history Photoshop, thông tin tác giả. Giảm thêm vài %."
                        selected={stripMetadata}
                        onClick={() => setStripMetadata(!stripMetadata)}
                    />
                    <ToolCheckboxOption
                        label="Chuyển sang Grayscale"
                        desc="Bỏ toàn bộ màu, chỉ giữ đen trắng. Giảm mạnh nhưng mất màu hoàn toàn."
                        selected={grayscale}
                        onClick={() => setGrayscale(!grayscale)}
                    />
                </div>
            </div>

            {/* Info */}
            <ToolInfo desc={
                <>
                    <strong>Optimize PDF</strong> — Giảm dung lượng file bằng cách nén ảnh, subset font, gỡ rác. 
                    Chất lượng in {selectedPreset?.id === 'screen' ? 'giảm đáng kể' : selectedPreset?.id === 'ebook' ? 'giảm nhẹ' : 'giữ nguyên'}.
                    {pdfFile && <> File hiện tại: <strong>{formatSize(pdfFile.size)}</strong></>}
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
                {isProcessing ? '⏳ Đang nén...' : '📦 Tối ưu PDF'}
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
                        {result.ratio > 0 ? '✅ Nén thành công!' : '⚠️ File đã tối ưu sẵn, không giảm thêm được.'}
                    </h4>

                    {/* Visual size comparison */}
                    <div className="flex items-center gap-3 mb-3">
                        <div className="flex-1 text-center">
                            <div className="text-[10px] text-slate-500 mb-1">Trước</div>
                            <div className="text-lg font-black text-slate-600 dark:text-zinc-300">{formatSize(result.originalSize)}</div>
                        </div>
                        <div className="flex flex-col items-center">
                            <svg className="w-5 h-5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                            </svg>
                        </div>
                        <div className="flex-1 text-center">
                            <div className="text-[10px] text-slate-500 mb-1">Sau</div>
                            <div className="text-lg font-black text-emerald-600 dark:text-emerald-300">{formatSize(result.outputSize)}</div>
                        </div>
                    </div>


                </div>
            )}
        </div>
    );
}
