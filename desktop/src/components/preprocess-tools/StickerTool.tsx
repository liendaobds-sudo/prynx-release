import React, { useState, useEffect } from 'react';
import { authenticatedFetch, getApiUrl, uploadPDF } from '../../lib/api';
import { useWorkingPdf } from '../../hooks/useWorkingPdf';
import { recipeRecorder } from '../../lib/recipe/RecipeRecorder';
import { ToolSectionLabel, ToolCardOption, ToolCheckboxOption, ToolNumberInput, ToolInfo } from './ToolUI';
import { RichSelect, ToolItem } from '../imposition-tools/SharedUI';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { useImposerSettingsStore } from '../imposition-tools/useImposerSettingsStore';
import { useTranslation } from 'react-i18next';
import { tv } from '../../i18n';

interface Props {
    pdfFile: File | null;
    onFileFixed?: (blob: Blob, filename: string) => void;
}

const CUT_MODES_RICH = [
    { value: 'original', title: '✂️ Theo hình gốc', desc: 'Cắt bám theo viền ảnh hoặc vector.' },
    { value: 'bleed', title: '🩸 Theo mép tràn lề', desc: 'Đường cắt = mép ngoài lề bù xén (bao luôn tràn màu). Không cắt giữa vành.' },
    { value: 'none', title: '🚫 Không vẽ đường cắt', desc: 'Chỉ mở nền (tràn màu).' },
];

const CORNER_STYLES = [
    { id: 'round', label: '🟢 Góc tròn', desc: '' },
    { id: 'miter', label: '🔺 Góc nhọn', desc: '' },
];

const BLEED_COLOR_MODES_STICKER = [
    { value: 'image', title: '🖼️ Lấy theo màu viền tem', desc: 'Lấy đúng màu dọc viền tem (bỏ AA/trắng mép), kéo ra vùng bù xén. Bật “Bỏ nền trắng” khi file có nền trắng quanh tem.' },
    { value: 'inpaint', title: '✨ Làm mượt thông minh', desc: 'CHỈ hợp mép ảnh chụp/gradient mềm. KHÔNG hợp dải màu phẳng (logo, tem chữ) — sẽ loang, mất nét. Dải màu phẳng nên chọn "Lấy theo màu viền tem".' },
    { value: 'solid', title: '🎨 Đổ màu trơn', desc: 'Bo viền nền bằng hệ màu in ấn chuyên nghiệp (CMYK).' },
];

const BLEED_COLOR_MODES_RECTANGLE = [
    { value: 'mirror', title: '🪞 Lật gương tự động', desc: 'Lật ngược mép ảnh siêu tốc. Giữ nguyên 100% độ sắc nét ban đầu.' },
    { value: 'inpaint', title: '✨ Làm mượt thông minh', desc: 'CHỈ hợp mép ảnh chụp/gradient mềm. KHÔNG hợp dải màu phẳng (banner, card, khối màu) — sẽ loang, không phân biệt được dải màu. Dải màu phẳng nên chọn "Kéo giãn mép ảnh".' },
    { value: 'image', title: '🖼️ Kéo giãn mép ảnh', desc: 'Tự động kéo giãn dải màu sát mép ảnh ra ngoài lề.' },
    { value: 'solid', title: '🎨 Đổ màu trơn', desc: 'Bo viền nền bằng hệ màu in ấn chuyên nghiệp (CMYK).' },
];

export default function StickerTool({ pdfFile, onFileFixed }: Props) {
  const { t } = useTranslation();
    const getWorkingFile = useWorkingPdf();
    const { setDetectedShapeType, setDetectedShapeParams } = useWorkspaceStore();
    const { setActiveDashboardTool } = useImposerSettingsStore();
    
    // Tab State
    const [productType, setProductType] = useState<'sticker' | 'rectangle'>('sticker');
    const setTaskMode = useImposerSettingsStore(s => s.setTaskMode);

    // Helper for localStorage
    const getSaved = (key: string, defaultVal: any) => {
        try { const v = localStorage.getItem(`ps_sticker_${key}`); return v !== null ? JSON.parse(v) : defaultVal; } catch { return defaultVal; }
    };
    // Số từ localStorage PHẢI ép về number hợp lệ + clamp [min,max] ngay lúc khởi tạo.
    // Build cũ (hoặc sửa tay) có thể lưu giá trị vượt giới hạn UI mới, hoặc "null"/"true"
    // → nếu không sanitize, handleRun gửi thẳng giá trị sai/non-number xuống backend.
    const getSavedNum = (key: string, defaultVal: number, min: number, max: number) => {
        const raw = getSaved(key, defaultVal);
        const n = typeof raw === 'number' && isFinite(raw) ? raw : defaultVal;
        return Math.min(max, Math.max(min, n));
    };
    const getSavedEdgeBite = () => {
        const saved = getSavedNum('edgeBiteMm', 0.0, 0, 5);
        const version = localStorage.getItem('ps_sticker_edgeBiteVersion');
        // Migrate the former 0.4 mm default once, while preserving deliberate
        // user values such as 0.2, 0.5 or 1.5 mm.
        if (version !== '2' && saved === 0.4) return 0.0;
        return saved;
    };

    // UI State for Sticker
    const [cutMode, setCutMode] = useState(() => getSaved('cutMode', 'original'));
    const [offsetMm, setOffsetMm] = useState<number>(() => getSavedNum('offsetMm', 0.0, -10, 10));
    const [cornerStyle, setCornerStyle] = useState(() => getSaved('cornerStyle', 'round'));
    const [fillHoles, setFillHoles] = useState<boolean>(() => getSaved('fillHoles', true));
    // "Tạo đường cắt cho trang đầu": file nhiều loại tem CÙNG khuôn → chỉ trang 1 mang
    // đường cắt (khuôn master), trang 2+ chỉ bù xén. Bước đệm sang Bình tem bế/CNC đồng nhất.
    const [cutFirstPageOnly, setCutFirstPageOnly] = useState<boolean>(() => getSaved('cutFirstPageOnly', false));
    // Hình học đường cắt: backend tự nhận (auto_safe). "Hình cắt sai?" → forceContour
    // ép giữ mép ảnh. KHÔNG lưu localStorage: mỗi file khác hình, mặc định luôn auto.
    const [forceContour, setForceContour] = useState<boolean>(false);
    // Tên hình backend đã nhận (đọc từ header X-Sticker-Cut-Kind) → hiện làm van an toàn.
    const [detectedCutKind, setDetectedCutKind] = useState<string | null>(null);

    // Shared State
    const [bleedMm, setBleedMm] = useState<number>(() => getSavedNum('bleedMm', 0.0, 0, 10));
    const [removeWhiteBg, setRemoveWhiteBg] = useState<boolean>(() => getSaved('removeWhiteBg', true));
    const [bleedColorType, setBleedColorType] = useState(() => getSaved('bleedColorType', 'image')); // 'mirror', 'image', 'inpaint', 'solid'
    const [bleedColorHex, setBleedColorHex] = useState(() => getSaved('bleedColorHex', '#FFFFFF'));
    // "Lẹm mép" (rectangle): hút màu sâu vào trong để doa viền trắng mảnh của file không tràn lề.
    // Con dao 2 lưỡi — lẹm quá ăn vào nội dung sát mép → default nhỏ, cho chỉnh/tắt (0).
    const [edgeBiteMm, setEdgeBiteMm] = useState<number>(getSavedEdgeBite);

    // Đổi kiểu màu nền: khi chọn "Đổ màu trơn" mà giá trị hiện tại chưa ở dạng CMYK
    // ("C,M,Y,K"), khởi tạo về "0,0,0,0" để khung CMYK và giá trị gửi backend khớp
    // nhau (tránh hiển thị 0,0,0,0 nhưng lại gửi RGB #FFFFFF).
    const handleBleedColorTypeChange = (v: string) => {
        setBleedColorType(v);
        if (v === 'solid' && bleedColorHex.split(',').length !== 4) {
            setBleedColorHex('0,0,0,0');
        }
    };


    // Save to localStorage whenever state changes
    useEffect(() => {
        localStorage.setItem('ps_sticker_cutMode', JSON.stringify(cutMode));
        localStorage.setItem('ps_sticker_offsetMm', JSON.stringify(offsetMm));
        localStorage.setItem('ps_sticker_cornerStyle', JSON.stringify(cornerStyle));
        localStorage.setItem('ps_sticker_fillHoles', JSON.stringify(fillHoles));
        localStorage.setItem('ps_sticker_bleedMm', JSON.stringify(bleedMm));
        localStorage.setItem('ps_sticker_removeWhiteBg', JSON.stringify(removeWhiteBg));
        localStorage.setItem('ps_sticker_bleedColorType', JSON.stringify(bleedColorType));
        localStorage.setItem('ps_sticker_bleedColorHex', JSON.stringify(bleedColorHex));
        localStorage.setItem('ps_sticker_edgeBiteMm', JSON.stringify(edgeBiteMm));
        localStorage.setItem('ps_sticker_edgeBiteVersion', '2');
        localStorage.setItem('ps_sticker_cutFirstPageOnly', JSON.stringify(cutFirstPageOnly));
    }, [cutMode, offsetMm, cornerStyle, fillHoles, bleedMm, removeWhiteBg, bleedColorType, bleedColorHex, edgeBiteMm, cutFirstPageOnly]);
    
    // Process state
    const [isProcessing, setIsProcessing] = useState(false);
    const [error, setError] = useState('');
    const [warning, setWarning] = useState('');
    const [isSuccess, setIsSuccess] = useState(false);

    const runVectorMirror = async () => {
        // Step 1: Upload
        const uploadRes = await uploadPDF((await getWorkingFile()) || pdfFile!);
        const currentFid = uploadRes.id;
        
        // Khổ trang hiện tại là khổ thành phẩm. Không pixel-auto-trim trước khi
        // bù xén vì vùng trắng sát mép có thể là một phần hợp lệ của thiết kế.
        const bleedRes = await authenticatedFetch(`${getApiUrl()}/preflight/mirror-bleed`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_id: currentFid, bleed_mm: bleedMm, pages: null }),
        });
        const bleedData = await bleedRes.json();
        if (!bleedData.success) throw new Error(bleedData.detail || t('preprocess.sticker:loi_tao_bu_xen_vector'));
        
        // Final Output
        const finalRes = await authenticatedFetch(`${getApiUrl()}/preflight/download/${bleedData.output_filename}`);
        return await finalRes.blob();
    };

    const runOpenCVBleed = async () => {
        const targetFile = (await getWorkingFile()) || pdfFile!;

        // We use uploadPDF first to bypass FastAPI multipart bugs when mixing files and text fields
        const uploadRes = await uploadPDF(targetFile);
        
        const formData = new FormData();
        formData.append('file_id', uploadRes.id);
        formData.append('cut_mode', productType === 'rectangle' ? 'none' : cutMode);
        formData.append('offset_mm', productType === 'rectangle' ? '0' : String(offsetMm));
        formData.append('corner_style', productType === 'rectangle' ? 'miter' : cornerStyle);
        formData.append('bleed_mm', String(bleedMm));
        formData.append('fill_holes', productType === 'rectangle' ? 'true' : (fillHoles ? 'true' : 'false'));
        formData.append('remove_white_bg', productType === 'rectangle' ? 'false' : (removeWhiteBg ? 'true' : 'false'));
        formData.append('draw_cut_contour', productType === 'rectangle' ? 'false' : (cutMode !== 'none' ? 'true' : 'false'));
        formData.append('bleed_color_type', bleedColorType); // 'image', 'inpaint', 'solid'
        formData.append('bleed_color_hex', bleedColorHex);
        // Lẹm mép CHỈ tab Xén vuông (không có “Bỏ nền trắng” dò mask).
        // Tab Bế tem: một nút “Bỏ nền trắng” + sample viền (shell/AA) — không thêm ô lẹm.
        formData.append('edge_bite_mm', productType === 'rectangle' ? String(edgeBiteMm) : '0');
        // "Tạo đường cắt cho trang đầu": chỉ tab Bế tem nhãn. Trang 1 mang khuôn
        // CutContour, trang 2+ chỉ bù xén → bước đệm cho Bình tem bế/CNC đồng nhất.
        formData.append('cut_first_page_only', productType === 'sticker' && cutFirstPageOnly ? 'true' : 'false');
        formData.append('shape_mode', productType === 'sticker' ? (forceContour ? 'contour' : 'auto_safe') : 'contour');
        if (productType === 'rectangle') {
            formData.append('rectangle_mode', 'true');
        }
        
        const response = await authenticatedFetch(`${getApiUrl()}/pdf-tools/sticker-dieline`, {
            method: 'POST',
            body: formData,
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => null);
            throw new Error(errData?.detail || t('preprocess.sticker:loi_server', { status: response.status }));
        }
        
        if (productType === 'sticker') {
            const shapeType = response.headers.get('X-Sticker-Shape-Type');
            const shapeParams = response.headers.get('X-Sticker-Shape-Params');
            setDetectedShapeType(shapeType);
            setDetectedShapeParams(shapeParams);
            // Hình học đường cắt máy tự nhận (van an toàn thay dropdown đã ẩn):
            // có kind → tên hình; không có (die phức tạp / forceContour) → 'contour'.
            const cutKind = response.headers.get('X-Sticker-Cut-Kind');
            setDetectedCutKind(cutKind || (forceContour ? 'contour' : null));
        }

        // Cảnh báo nghiệp vụ (vd một số trang không dò được hình) — header được
        // percent-encode ở backend để giữ tiếng Việt.
        const warnHeader = response.headers.get('X-Sticker-Warning');
        if (warnHeader) {
            try { setWarning(decodeURIComponent(warnHeader)); } catch { setWarning(warnHeader); }
        }
        
        return await response.blob();
    };

    const handleRun = async () => {
        if (!pdfFile) return;

        setIsSuccess(false);
        setIsProcessing(true);
        setError('');
        setWarning('');

        // ─── Recipe record hook ─── (params tất định; phát lại dò contour lại trên file mới)
        recipeRecorder.noteOperation('sticker_dieline', {
            productType, cutMode, offsetMm, cornerStyle, fillHoles,
            bleedMm, removeWhiteBg, bleedColorType, bleedColorHex, edgeBiteMm,
            cutFirstPageOnly, shapeMode: forceContour ? 'contour' : 'auto_safe',
        });

        try {
            let resultBlob: Blob;
            
            if (productType === 'rectangle' && bleedColorType === 'mirror') {
                resultBlob = await runVectorMirror();
            } else {
                resultBlob = await runOpenCVBleed();
            }

            if (onFileFixed) {
                const prefix = productType === 'rectangle' ? 'autobleed' : 'sticker';
                const baseName = pdfFile.name.replace(/\.[^/.]+$/, "");
                onFileFixed(resultBlob, `${prefix}_${baseName}.pdf`);
                setIsSuccess(true);
            }
        } catch (e: any) {
            recipeRecorder.discardPending();
            setError(e.message || t('preprocess.sticker:da_xay_ra_loi_khong_xac_dinh'));
        } finally {
            setIsProcessing(false);
        }
    };

    // Auto-fix bleedColorType when switching tabs
    const handleProductTypeChange = (type: 'sticker' | 'rectangle') => {
        setProductType(type);
        if (type === 'sticker' && bleedColorType === 'mirror') {
            setBleedColorType('image'); // 'mirror' is not supported for stickers
        }
        // Removing the aggressive override when switching to rectangle to preserve user choice
    };

    return (
        <div className="flex flex-col gap-4">
            {/* TABS SELECTOR */}
            <div className="flex bg-slate-100 dark:bg-zinc-800/50 p-1 rounded-xl shadow-inner border border-slate-200 dark:border-white/5 relative z-10">
                <button
                    onClick={() => handleProductTypeChange('sticker')}
                    aria-pressed={productType === 'sticker'}
                    className={`flex-1 flex flex-row items-center justify-center gap-2 py-2.5 rounded-lg text-[11px] font-bold transition-all relative z-10 ${
                        productType === 'sticker'
                            ? 'bg-white dark:bg-zinc-800 text-indigo-600 dark:text-indigo-400 shadow-md ring-1 ring-indigo-100 dark:ring-indigo-500/30'
                            : 'text-slate-500 hover:text-slate-700 dark:hover:text-zinc-300 hover:bg-slate-200/50 dark:hover:bg-zinc-700/50'
                    }`}
                >
                    <span className="text-lg">🔵</span>
                    {t('preprocess.sticker:be_tem_nhan')}
                </button>
                <button
                    onClick={() => handleProductTypeChange('rectangle')}
                    aria-pressed={productType === 'rectangle'}
                    className={`flex-1 flex flex-row items-center justify-center gap-2 py-2.5 rounded-lg text-[11px] font-bold transition-all relative z-10 ${
                        productType === 'rectangle'
                            ? 'bg-white dark:bg-zinc-800 text-indigo-600 dark:text-indigo-400 shadow-md ring-1 ring-indigo-100 dark:ring-indigo-500/30'
                            : 'text-slate-500 hover:text-slate-700 dark:hover:text-zinc-300 hover:bg-slate-200/50 dark:hover:bg-zinc-700/50'
                    }`}
                >
                    <span className="text-lg">🟦</span>
                    {t('preprocess.sticker:xen_vuong_goc')}
                </button>
            </div>

            {/* --- TAB 1: BẾ TEM NHÃN --- */}
            {productType === 'sticker' && (
                <div className="animate-in slide-in-from-left-4 fade-in duration-300 space-y-4">
                    {/* 1. Đường cắt */}
                    <div>
                        <ToolSectionLabel>{t('preprocess.sticker:1_duong_cat_dieline')}</ToolSectionLabel>
                        <div className="flex flex-col gap-1.5 mb-4 relative z-[60]">
                            <RichSelect
                                value={cutMode}
                                onChange={(v) => setCutMode(v)}
                                options={CUT_MODES_RICH}
                            />
                        </div>
                        
                        {cutMode !== 'none' && (
                            <>
                                <div className="flex gap-2 mt-2 items-end">
                                    <ToolNumberInput
                                        label={t('preprocess.sticker:co_gian_vien')}
                                        value={offsetMm}
                                        onChange={setOffsetMm}
                                        suffix="mm"
                                        step={0.5}
                                        min={-10}
                                        max={10}
                                        className="w-[90px] shrink-0"
                                    />
                                    <div className="flex gap-1.5 flex-1">
                                        {CORNER_STYLES.map(opt => (
                                            <button
                                                key={opt.id}
                                                onClick={() => setCornerStyle(opt.id)}
                                                aria-pressed={cornerStyle === opt.id}
                                                className={`flex-1 h-[32px] rounded border text-[12px] transition-all flex items-center justify-center font-bold ${
                                                    cornerStyle === opt.id
                                                        ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300'
                                                        : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400'
                                                }`}
                                            >
                                                {tv(opt.label)}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <p className="text-[10px] text-slate-400 mt-1 mb-4">{t('preprocess.sticker:so_am_vd_0_5_ep_duong_cat_lun_vao_trong')}</p>
                                <label
                                    title={t('preprocess.sticker:file_nhieu_loai_tem_dung_chung_1_khuon')}
                                    className={`w-full min-h-[38px] rounded-lg border px-3 py-2 flex items-center gap-2.5 cursor-pointer select-none transition-all ${
                                        cutFirstPageOnly
                                            ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300'
                                            : 'border-slate-300 bg-white hover:border-slate-400 hover:bg-slate-50 text-slate-700 dark:border-zinc-600 dark:bg-zinc-900 dark:hover:border-zinc-500 dark:hover:bg-zinc-800 dark:text-zinc-300'
                                    }`}
                                >
                                    <input
                                        type="checkbox"
                                        checked={cutFirstPageOnly}
                                        onChange={(event) => setCutFirstPageOnly(event.target.checked)}
                                        className="peer sr-only"
                                    />
                                    <span
                                        aria-hidden="true"
                                        className={`h-[18px] w-[18px] shrink-0 rounded border-2 flex items-center justify-center transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-teal-500 peer-focus-visible:ring-offset-2 dark:peer-focus-visible:ring-offset-zinc-900 ${
                                            cutFirstPageOnly
                                                ? 'border-teal-600 bg-teal-600 text-white'
                                                : 'border-slate-400 bg-white dark:border-zinc-500 dark:bg-zinc-950'
                                        }`}
                                    >
                                        {cutFirstPageOnly && (
                                            <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5">
                                                <path d="M3 8.25 6.5 11.5 13 4.5" strokeLinecap="round" strokeLinejoin="round" />
                                            </svg>
                                        )}
                                    </span>
                                    <span className="text-[11px] font-bold leading-tight">
                                        {t('preprocess.sticker:tao_duong_cat_cho_trang_dau_2')}
                                    </span>
                                </label>
                                <p className="text-[10px] text-slate-400 mt-1 mb-4">{t('preprocess.sticker:nhieu_loai_tem_chung_khuon_chi_trang')}</p>
                            </>
                        )}
                    </div>
                    {/* 2. Tràn lề */}
                    <div>
                        <ToolSectionLabel>{t('preprocess.sticker:2_tran_le_dac_ruot')}</ToolSectionLabel>
                        <div className="flex gap-2 mb-4 items-end">
                            <ToolNumberInput
                                label={t('preprocess.sticker:tran_mau')}
                                value={bleedMm}
                                onChange={setBleedMm}
                                suffix="mm"
                                step={0.5}
                                min={0}
                                max={10}
                                className="w-[90px] shrink-0"
                            />
                            <div className="flex gap-1.5 flex-1">
                                <button
                                    onClick={() => setFillHoles(!fillHoles)}
                                    aria-pressed={fillHoles}
                                    title={t('preprocess.sticker:bo_qua_cac_lo_rong_ben_trong_khoi_hinh')}
                                    className={`flex-1 h-[32px] rounded border text-[11px] transition-all flex items-center justify-center font-bold px-1 whitespace-nowrap overflow-hidden ${
                                        fillHoles
                                            ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300'
                                            : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400'
                                    }`}
                                >
                                    {fillHoles ? t('preprocess.sticker:dac_ruot') : t('preprocess.sticker:dac_ruot_2')}
                                </button>
                                <button
                                    onClick={() => setRemoveWhiteBg(!removeWhiteBg)}
                                    aria-pressed={removeWhiteBg}
                                    title={t('preprocess.sticker:chi_do_vien_cua_chi_tiet_bo_qua_mang')}
                                    className={`flex-1 h-[32px] rounded border text-[11px] transition-all flex items-center justify-center font-bold px-1 whitespace-nowrap overflow-hidden ${
                                        removeWhiteBg
                                            ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300'
                                            : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400'
                                    }`}
                                >
                                    {removeWhiteBg ? t('preprocess.sticker:bo_nen_trang') : t('preprocess.sticker:bo_nen_trang_2')}
                                </button>
                            </div>
                        </div>
                        
                        {(cutMode === 'bleed' || cutMode === 'none' || bleedMm > 0) && (
                            <div className="mt-6 p-3 bg-slate-50 dark:bg-zinc-800/50 rounded-xl border border-slate-200 dark:border-zinc-700/50">
                                <label className="block text-xs font-bold text-slate-700 dark:text-zinc-300 mb-2">{t('preprocess.sticker:mau_nen_bu_xen')}</label>
                                <div className="flex flex-col gap-1.5 mb-2 relative z-[50]">
                                    <RichSelect
                                        value={bleedColorType}
                                        onChange={handleBleedColorTypeChange}
                                        options={BLEED_COLOR_MODES_STICKER}
                                    />
                                </div>
                                {bleedColorType === 'solid' && (
                                    <div className="mt-2 flex flex-col gap-2 bg-white dark:bg-zinc-800 p-3 rounded-lg border border-slate-200 dark:border-zinc-700">
                                        <div className="grid grid-cols-4 gap-2">
                                            {['C', 'M', 'Y', 'K'].map((ch, idx) => {
                                                const val = bleedColorHex.split(',').length === 4 ? bleedColorHex.split(',')[idx] : (ch === 'K' ? '0' : '0');
                                                return (
                                                    <div key={ch} className="flex flex-col gap-1">
                                                        <label className="text-[10px] font-bold text-center text-slate-700 dark:text-zinc-300">{ch}</label>
                                                        <input 
                                                            type="number" min="0" max="100" 
                                                            value={val}
                                                            onChange={(e) => {
                                                                const v = Math.min(100, Math.max(0, parseInt(e.target.value) || 0));
                                                                const current = bleedColorHex.split(',').length === 4 ? bleedColorHex.split(',') : ['0','0','0','0'];
                                                                current[idx] = String(v);
                                                                setBleedColorHex(current.join(','));
                                                            }}
                                                            className="w-full text-center text-xs h-8 border border-slate-200 dark:border-zinc-600 rounded bg-slate-50 dark:bg-zinc-900"
                                                        />
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* --- TAB 2: XÉN VUÔNG GÓC --- */}
            {productType === 'rectangle' && (
                <div className="animate-in slide-in-from-right-4 fade-in duration-300 space-y-4">
                    <div>
                        <div className="flex items-end gap-3 mb-4">
                            <ToolNumberInput
                                label={t('preprocess.sticker:do_day_bleed')}
                                value={bleedMm}
                                onChange={setBleedMm}
                                suffix="mm"
                                step={0.5}
                                min={0}
                                max={10}
                                className="flex-1 min-w-0"
                            />
                            {(bleedColorType === 'image' || bleedColorType === 'inpaint') && (
                                <ToolNumberInput
                                    label={t('preprocess.sticker:do_lem_mep')}
                                    value={edgeBiteMm}
                                    onChange={setEdgeBiteMm}
                                    suffix="mm"
                                    step={0.1}
                                    min={0}
                                    max={5}
                                    className="flex-1 min-w-0"
                                />
                            )}
                        </div>

                        <div className="p-3 bg-slate-50 dark:bg-zinc-800/50 rounded-xl border border-slate-200 dark:border-zinc-700/50">
                            <label className="block text-xs font-bold text-slate-700 dark:text-zinc-300 mb-2">{t('preprocess.sticker:mau_nen_bu_xen')}</label>
                            <div className="flex flex-col gap-1.5 mb-2 relative z-[50]">
                                <RichSelect
                                    value={bleedColorType}
                                    onChange={handleBleedColorTypeChange}
                                    options={BLEED_COLOR_MODES_RECTANGLE}
                                />
                            </div>

                            {bleedColorType === 'mirror' && (
                                <div className="flex items-start gap-2 mb-2 px-2.5 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40">
                                    <span className="text-amber-500 text-sm leading-none mt-0.5">⚠️</span>
                                    <p className="text-[10.5px] text-amber-700 dark:text-amber-300 leading-snug">
                                        {t('preprocess.sticker:lat_guong')} <strong>{t('preprocess.sticker:soi_nguoc_noi_dung_sat_mep')}</strong> {t('preprocess.sticker:ra_vung_bu_xen_vd_chu_n_m')} <strong>{t('preprocess.sticker:sai_noi_dung')}</strong>{t('preprocess.sticker:chi_nen_dung_cho_nen_truu_tuong_hoa_van')} <strong>{t('preprocess.sticker:keo_gian_mep_anh_quoted')}</strong>.
                                    </p>
                                </div>
                            )}
                            
                            {bleedColorType === 'solid' && (
                                <div className="mt-3 flex flex-col gap-2 bg-white dark:bg-zinc-800 p-3 rounded-lg border border-slate-200 dark:border-zinc-700">
                                    <div className="grid grid-cols-4 gap-2">
                                        {['C', 'M', 'Y', 'K'].map((ch, idx) => {
                                            const val = bleedColorHex.split(',').length === 4 ? bleedColorHex.split(',')[idx] : (ch === 'K' ? '0' : '0');
                                            return (
                                                <div key={ch} className="flex flex-col gap-1">
                                                    <label className="text-[10px] font-bold text-center text-slate-700 dark:text-zinc-300">{ch}</label>
                                                    <input 
                                                        type="number" min="0" max="100" 
                                                        value={val}
                                                        onChange={(e) => {
                                                            const v = Math.min(100, Math.max(0, parseInt(e.target.value) || 0));
                                                            const current = bleedColorHex.split(',').length === 4 ? bleedColorHex.split(',') : ['0','0','0','0'];
                                                            current[idx] = String(v);
                                                            setBleedColorHex(current.join(','));
                                                        }}
                                                        className="w-full text-center text-xs h-8 border border-slate-200 dark:border-zinc-600 rounded bg-slate-50 dark:bg-zinc-900"
                                                    />
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>

                    </div>
                </div>
            )}
            {/* Execute */}
            {!isSuccess ? (
                <button
                    onClick={handleRun}
                    disabled={isProcessing || !pdfFile}
                    className={`w-full h-12 rounded-xl text-[14px] font-bold transition-all mt-2 flex items-center justify-center gap-2 ${
                        isProcessing || !pdfFile
                            ? 'bg-slate-300 dark:bg-zinc-700 text-slate-500 cursor-not-allowed'
                            : 'bg-indigo-600 hover:bg-indigo-700 text-white'
                    }`}
                >
                    {t('preprocess.common:run')}{isProcessing ? '…' : ''}
                </button>
            ) : (
                <div className="mt-4 bg-white dark:bg-zinc-800 p-4 rounded-xl shadow-sm border border-emerald-200 dark:border-emerald-800/50 animate-in fade-in slide-in-from-bottom-2 duration-300">
                    <div className="flex items-center gap-2 mb-4">
                        <div className="w-8 h-8 bg-emerald-100 dark:bg-emerald-900/50 rounded-full flex items-center justify-center shrink-0">
                            <span className="text-sm">✅</span>
                        </div>
                        <div className="flex flex-col">
                            <h3 className="text-[13px] font-bold text-emerald-700 dark:text-emerald-400">{t('preprocess.sticker:da_tao_bu_xen_thanh_cong')}</h3>
                            <p className="text-[10px] text-slate-500 leading-tight">{t('preprocess.sticker:buoc_tiep_theo_chon_kieu_dan_trang')}</p>
                        </div>
                    </div>
                    {/* Van an toàn: hiện tên hình cắt máy đã tự nhận + 1 toggle lật về giữ mép
                        ảnh khi nhận sai — thay cho dropdown shape_mode đã ẩn. Chỉ tab bế tem. */}
                    {productType === 'sticker' && cutMode !== 'none' && detectedCutKind && (
                        <div className="mb-3 flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg bg-slate-50 dark:bg-zinc-800/60 border border-slate-200 dark:border-zinc-700/50">
                            <span className="text-[11px] text-slate-600 dark:text-zinc-300">
                                {t('preprocess.sticker:duong_cat_da_nhan')}{' '}
                                <strong>{t(`preprocess.sticker:cut_kind_${detectedCutKind}`)}</strong>
                            </span>
                            {!forceContour && detectedCutKind !== 'contour' && (
                                <button
                                    onClick={() => { setForceContour(true); setIsSuccess(false); setTimeout(handleRun, 0); }}
                                    className="text-[10.5px] font-bold text-amber-600 dark:text-amber-400 hover:underline shrink-0"
                                >
                                    {t('preprocess.sticker:hinh_cat_sai_giu_mep_anh')}
                                </button>
                            )}
                            {forceContour && (
                                <span className="text-[10.5px] font-bold text-teal-600 dark:text-teal-400 shrink-0">
                                    {t('preprocess.sticker:dang_giu_mep_anh')}
                                </span>
                            )}
                        </div>
                    )}
                    <div className="flex flex-col gap-2">
                        {/* Rule in ấn: Xén vuông góc = cắt thẳng → bình guillotine (Booklet/N-Up).
                            Bế tem nhãn = có đường bế contour → Bình Bế Tem.
                            Route theo productType (KHÔNG theo cutMode vì cutMode dùng chung 2 tab). */}
                        {productType === 'rectangle' && (
                            <>
                                <ToolItem 
                                    icon="📚" label={t('preprocess.sticker:binh_sach_tap_chi')} desc={t('preprocess.sticker:khau_chi_long_doi_bu_gay')}
                                    onClick={() => { setActiveDashboardTool('booklet'); setTaskMode('booklet'); }} 
                                    hoverColor="hover:border-emerald-400 dark:hover:border-emerald-500" 
                                />
                                <ToolItem 
                                    icon="🎴" label={t('preprocess.sticker:binh_bai_xen_n_up')} desc={t('preprocess.sticker:n_up_nhan_ban_s_r')}
                                    onClick={() => { setActiveDashboardTool('nup'); setTaskMode('nup'); }} 
                                    hoverColor="hover:border-rose-400 dark:hover:border-rose-500" 
                                />
                            </>
                        )}
                        {productType === 'sticker' && (
                            <ToolItem 
                                icon="✂️" label={t('preprocess.sticker:binh_bai_be_tem')} desc={t('preprocess.sticker:xep_tem_be_to_ong')}
                                onClick={() => { setActiveDashboardTool('sticker_imposer'); setTaskMode('sticker_imposer'); }} 
                                hoverColor="hover:border-pink-400 dark:hover:border-pink-500" 
                            />
                        )}
                    </div>
                    <button
                        onClick={() => setIsSuccess(false)}
                        className="mt-4 w-full text-xs font-bold text-slate-400 hover:text-slate-600 dark:hover:text-zinc-300 py-1 transition-colors"
                    >
                        {t('preprocess.sticker:quay_lai_chinh_sua_bu_xen')}
                    </button>
                </div>
            )}

            {/* Warning (nghiệp vụ, không phải lỗi chặn) */}
            {warning && (
                <div className="bg-amber-50 dark:bg-amber-900/20 p-3 rounded-lg border border-amber-200 dark:border-amber-800/50 mt-2">
                    <span className="text-[12px] text-amber-700 dark:text-amber-300 font-medium">⚠️ {warning}</span>
                </div>
            )}

            {/* Error */}
            {error && (
                <div className="bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-200 dark:border-red-800/50 mt-2">
                    <span className="text-[12px] text-red-600 dark:text-red-400 font-medium">❌ {error}</span>
                </div>
            )}
        </div>
    );
}
