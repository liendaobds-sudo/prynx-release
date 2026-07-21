import { useState } from 'react';
import { authenticatedFetch, getApiUrl, prepareFileForUpload } from '../../lib/api';
import { useWorkingPdf } from '../../hooks/useWorkingPdf';
import { ToolSectionLabel, ToolCardOption, ToolCheckboxOption, ToolInfo } from './ToolUI';
import { useTranslation } from 'react-i18next';
import { tv } from '../../i18n';

interface Props {
    pdfFile: File | null;
    onFileFixed?: (blob: Blob, filename: string) => void;
}

const LANG_OPTIONS = [
    { id: 'vie+eng', label: 'Tiếng Việt + English', desc: 'Mặc định' },
    { id: 'eng', label: 'English Only', desc: 'Chỉ tiếng Anh' },
    { id: 'vie', label: 'Tiếng Việt Only', desc: 'Chỉ tiếng Việt' },
    { id: 'jpn+eng', label: '日本語 + English', desc: 'Nhật + Anh' },
    { id: 'kor+eng', label: '한국어 + English', desc: 'Hàn + Anh' },
    { id: 'chi_sim+eng', label: '中文简体 + English', desc: 'Trung giản thể + Anh' },
    { id: 'chi_tra+eng', label: '中文繁體 + English', desc: 'Trung phồn thể + Anh' },
    { id: 'khm+eng', label: 'ភាសាខ្មែរ + English', desc: 'Khmer + Anh' },
];

const DPI_OPTIONS = [
    { id: '150', label: '150 DPI', desc: 'Nhanh, chất lượng thấp' },
    { id: '300', label: '300 DPI', desc: 'Cân bằng (Khuyến nghị)' },
    { id: '600', label: '600 DPI', desc: 'Chậm, chính xác cao' },
];

export default function OcrTool({ pdfFile, onFileFixed }: Props) {
  const { t } = useTranslation();
    const getWorkingFile = useWorkingPdf();
    const [lang, setLang] = useState('vie+eng');
    const [dpi, setDpi] = useState('300');
    const [preprocess, setPreprocess] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [progress, setProgress] = useState('');
    const [result, setResult] = useState<{ totalPages: number; pagesWithText: number; totalWords: number } | null>(null);
    const [error, setError] = useState('');

    const handleRun = async () => {
        if (!pdfFile) {
            setError(t('preprocess.ocr:chua_mo_file_pdf_nao'));
            return;
        }

        setIsProcessing(true);
        setError('');
        setResult(null);
        setProgress(t('preprocess.ocr:dang_chuan_bi_du_lieu'));

        try {
            const realFile = await prepareFileForUpload((await getWorkingFile()) || pdfFile);
            const formData = new FormData();
            formData.append('file', realFile, pdfFile.name);
            formData.append('lang', lang);
            formData.append('dpi', dpi);
            formData.append('preprocess', preprocess ? 'true' : 'false');

            setProgress(t('preprocess.ocr:dang_chay_ocr_tesseract_co_the_mat_vai'));

            const response = await authenticatedFetch(`${getApiUrl()}/pdf-tools/ocr-searchable`, {
                method: 'POST',
                body: formData,
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => null);
                throw new Error(errData?.detail || `${tv('Lỗi Server')} (${response.status})`);
            }

            const blob = await response.blob();

            // Read OCR stats from response headers
            const totalPages = parseInt(response.headers.get('X-OCR-Total-Pages') || '0');
            const pagesWithText = parseInt(response.headers.get('X-OCR-Pages-With-Text') || '0');
            const totalWords = parseInt(response.headers.get('X-OCR-Total-Words') || '0');

            setResult({ totalPages, pagesWithText, totalWords });
            setProgress('');

            // Deliver the file
            if (onFileFixed) {
                const newName = `Searchable_${pdfFile.name}`;
                onFileFixed(blob, newName);
            }
        } catch (e: any) {
            setError(e.message || t('preprocess.ocr:da_xay_ra_loi_khong_xac_dinh'));
            setProgress('');
        } finally {
            setIsProcessing(false);
        }
    };

    return (
        <div className="flex flex-col gap-4">
            {/* Language Selection */}
            <div>
                <ToolSectionLabel>{t('preprocess.ocr:ngon_ngu_nhan_dien')}</ToolSectionLabel>
                <div className="grid grid-cols-2 gap-1.5">
                    {LANG_OPTIONS.map(opt => (
                        <ToolCardOption
                            key={opt.id}
                            label={tv(opt.label)}
                            desc={tv(opt.desc)}
                            selected={lang === opt.id}
                            onClick={() => setLang(opt.id)}
                        />
                    ))}
                </div>
            </div>

            {/* DPI Selection */}
            <div>
                <ToolSectionLabel>{t('preprocess.ocr:do_phan_giai_quet')}</ToolSectionLabel>
                <div className="grid grid-cols-3 gap-1.5">
                    {DPI_OPTIONS.map(opt => (
                        <ToolCardOption
                            key={opt.id}
                            label={opt.label}
                            desc={tv(opt.desc)}
                            selected={dpi === opt.id}
                            onClick={() => setDpi(opt.id)}
                        />
                    ))}
                </div>
            </div>

            {/* Preprocess Toggle */}
            <div>
                <ToolSectionLabel>{t('preprocess.ocr:tien_xu_ly_anh')}</ToolSectionLabel>
                <ToolCheckboxOption
                    label={t('preprocess.ocr:khu_nhieu_nan_thang_deskew')}
                    desc={t('preprocess.ocr:bat_cho_file_scan_tu_giay_tat_neu_file')}
                    selected={preprocess}
                    onClick={() => setPreprocess(!preprocess)}
                />
            </div>

            {/* Info Box */}
            <ToolInfo desc={
                <>
                    <strong>OCR Searchable PDF</strong> {t('preprocess.ocr:nhung_lop_text_vo_hinh_vao_pdf_scan')} <strong>{t('preprocess.ocr:tim_kiem_ctrl_f')}</strong>, <strong>{t('preprocess.ocr:boi_den_copy')}</strong> {t('preprocess.ocr:noi_dung_anh_goc_khong_bi_thay_doi')}
                </>
            } />

            {/* Execute Button */}
            <button
                onClick={handleRun}
                disabled={isProcessing || !pdfFile}
                className={`w-full py-3 rounded-xl text-[13px] font-bold transition-all shadow-lg ${
                    isProcessing || !pdfFile
                        ? 'bg-slate-300 dark:bg-zinc-700 text-slate-500 cursor-not-allowed'
                        : 'bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-600 hover:to-blue-700 text-white shadow-cyan-500/25 hover:shadow-cyan-500/40'
                }`}
            >
                {t('preprocess.common:run')}{isProcessing ? '…' : ''}
            </button>

            {/* Progress */}
            {progress && (
                <div className="flex items-center gap-3 bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg border border-blue-200 dark:border-blue-800/50">
                    <div className="w-5 h-5 rounded-full border-2 border-blue-500 border-t-transparent animate-spin shrink-0" />
                    <span className="text-[12px] text-blue-700 dark:text-blue-300 font-medium">{progress}</span>
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
                    <h4 className="text-[12px] font-bold text-emerald-700 dark:text-emerald-400 mb-2">{t('preprocess.ocr:ocr_thanh_cong')}</h4>
                    <div className="grid grid-cols-3 gap-2">
                        <div className="text-center">
                            <div className="text-lg font-black text-emerald-600 dark:text-emerald-300">{result.totalPages}</div>
                            <div className="text-[10px] text-emerald-600/70 dark:text-emerald-400/70">{t('preprocess.ocr:tong_trang')}</div>
                        </div>
                        <div className="text-center">
                            <div className="text-lg font-black text-emerald-600 dark:text-emerald-300">{result.pagesWithText}</div>
                            <div className="text-[10px] text-emerald-600/70 dark:text-emerald-400/70">{t('preprocess.ocr:trang_co_chu')}</div>
                        </div>
                        <div className="text-center">
                            <div className="text-lg font-black text-emerald-600 dark:text-emerald-300">{result.totalWords.toLocaleString()}</div>
                            <div className="text-[10px] text-emerald-600/70 dark:text-emerald-400/70">{t('preprocess.ocr:tu_da_nhung')}</div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
