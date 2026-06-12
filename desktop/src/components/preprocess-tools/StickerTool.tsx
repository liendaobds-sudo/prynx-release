import React, { useState, useEffect } from 'react';
import { authenticatedFetch, getApiUrl, uploadPDF } from '../../lib/api';
import { useWorkingPdf } from '../../hooks/useWorkingPdf';
import { ToolSectionLabel, ToolCardOption, ToolCheckboxOption, ToolNumberInput, ToolInfo } from './ToolUI';
import { RichSelect, ToolItem } from '../imposition-tools/SharedUI';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { useImposerSettingsStore } from '../imposition-tools/useImposerSettingsStore';

interface Props {
    pdfFile: File | null;
    onFileFixed?: (blob: Blob, filename: string) => void;
}

const CUT_MODES_RICH = [
    { value: 'original', title: '✂️ Theo hình gốc', desc: 'Cắt bám theo viền ảnh hoặc vector.' },
    { value: 'bleed', title: '🩸 Theo mép tràn lề', desc: 'Cắt bao luôn phần lề bù xén (nếu có).' },
    { value: 'none', title: '🚫 Không vẽ đường cắt', desc: 'Chỉ mở nền (tràn màu).' },
];

const CORNER_STYLES = [
    { id: 'round', label: '🟢 Góc tròn', desc: '' },
    { id: 'miter', label: '🔺 Góc nhọn', desc: '' },
];

const BLEED_COLOR_MODES_STICKER = [
    { value: 'image', title: '🖼️ Lấy theo màu viền tem', desc: 'Tự động kéo giãn dải màu sát mép tem ra ngoài để lấp đầy vùng cắt.' },
    { value: 'inpaint', title: '✨ Làm mượt thông minh', desc: 'Tự động tính toán và vẽ tiếp dải màu. Chậm nhưng cho kết quả mượt mà.' },
    { value: 'solid', title: '🎨 Đổ màu trơn', desc: 'Bo viền nền bằng hệ màu in ấn chuyên nghiệp (CMYK).' },
];

const BLEED_COLOR_MODES_RECTANGLE = [
    { value: 'mirror', title: '🪞 Lật gương tự động', desc: 'Lật ngược mép ảnh siêu tốc. Giữ nguyên 100% độ sắc nét ban đầu.' },
    { value: 'inpaint', title: '✨ Làm mượt thông minh', desc: 'Tự động tính toán và vẽ tiếp dải màu cong, hạn chế viền gãy góc.' },
    { value: 'image', title: '🖼️ Kéo giãn mép ảnh', desc: 'Tự động kéo giãn dải màu sát mép ảnh ra ngoài lề.' },
    { value: 'solid', title: '🎨 Đổ màu trơn', desc: 'Bo viền nền bằng hệ màu in ấn chuyên nghiệp (CMYK).' },
];

export default function StickerTool({ pdfFile, onFileFixed }: Props) {
    const getWorkingFile = useWorkingPdf();
    const { setDetectedShapeType, setDetectedShapeParams, setActiveDashboardTool } = useWorkspaceStore();
    
    // Tab State
    const [productType, setProductType] = useState<'sticker' | 'rectangle'>('sticker');
    const setTaskMode = useImposerSettingsStore(s => s.setTaskMode);

    // Helper for localStorage
    const getSaved = (key: string, defaultVal: any) => {
        try { const v = localStorage.getItem(`ps_sticker_${key}`); return v !== null ? JSON.parse(v) : defaultVal; } catch { return defaultVal; }
    };

    // UI State for Sticker
    const [cutMode, setCutMode] = useState(() => getSaved('cutMode', 'original'));
    const [offsetMm, setOffsetMm] = useState<number>(() => getSaved('offsetMm', 0.0));
    const [cornerStyle, setCornerStyle] = useState(() => getSaved('cornerStyle', 'round'));
    const [fillHoles, setFillHoles] = useState<boolean>(() => getSaved('fillHoles', true));

    // Shared State
    const [bleedMm, setBleedMm] = useState<number>(() => getSaved('bleedMm', 0.0));
    const [removeWhiteBg, setRemoveWhiteBg] = useState<boolean>(() => getSaved('removeWhiteBg', true));
    const [bleedColorType, setBleedColorType] = useState(() => getSaved('bleedColorType', 'image')); // 'mirror', 'image', 'inpaint', 'solid'
    const [bleedColorHex, setBleedColorHex] = useState(() => getSaved('bleedColorHex', '#FFFFFF'));

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
    }, [cutMode, offsetMm, cornerStyle, fillHoles, bleedMm, removeWhiteBg, bleedColorType, bleedColorHex]);
    
    // Process state
    const [isProcessing, setIsProcessing] = useState(false);
    const [progress, setProgress] = useState('');
    const [error, setError] = useState('');
    const [isSuccess, setIsSuccess] = useState(false);

    const runVectorMirror = async () => {
        // Step 1: Upload
        setProgress('Đang tải file lên...');
        const uploadRes = await uploadPDF((await getWorkingFile()) || pdfFile!);
        let currentFid = uploadRes.id;
        
        // Step 2: Auto Trim (if requested)
        if (removeWhiteBg) {
            setProgress('Đang xén bỏ lề trắng...');
            const trimRes = await authenticatedFetch(`${getApiUrl()}/preflight/auto-trim`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file_id: currentFid, pages: null, margin_mm: 0 }),
            });
            const trimData = await trimRes.json();
            if (!trimData.success) throw new Error(trimData.detail || 'Lỗi xóa lề trắng');
            
            // Download the trimmed file to re-upload it (since API expects file_id)
            const dlRes = await authenticatedFetch(`${getApiUrl()}/preflight/download/${trimData.output_filename}`);
            const trimBlob = await dlRes.blob();
            const trimFile = new File([trimBlob], 'trimmed.pdf', { type: 'application/pdf' });
            
            setProgress('Đang chuẩn bị xử lý lật gương...');
            const reUploadRes = await uploadPDF(trimFile);
            currentFid = reUploadRes.id;
        }
        
        setProgress('Đang xử lý lật gương tạo vùng bù xén...');
        const bleedRes = await authenticatedFetch(`${getApiUrl()}/preflight/add-bleed`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_id: currentFid, bleed_mm: bleedMm, pages: null }),
        });
        const bleedData = await bleedRes.json();
        if (!bleedData.success) throw new Error(bleedData.detail || 'Lỗi tạo bù xén Vector');
        
        // Final Output
        setProgress('Đang tải file hoàn thiện...');
        const finalRes = await authenticatedFetch(`${getApiUrl()}/preflight/download/${bleedData.output_filename}`);
        return await finalRes.blob();
    };

    const runOpenCVBleed = async () => {
        let currentFid = '';
        let targetFile = (await getWorkingFile()) || pdfFile!;
        
        if (productType === 'rectangle' && removeWhiteBg) {
            setProgress('Đang xén bỏ lề trắng...');
            const uploadRes = await uploadPDF(targetFile);
            currentFid = uploadRes.id;
            
            const trimRes = await authenticatedFetch(`${getApiUrl()}/preflight/auto-trim`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file_id: currentFid, pages: null, margin_mm: 0 }),
            });
            const trimData = await trimRes.json();
            if (!trimData.success) throw new Error(trimData.detail || 'Lỗi xóa lề trắng');
            
            setProgress('Đang tải file đã xén để chuẩn bị bù màu...');
            const dlRes = await authenticatedFetch(`${getApiUrl()}/preflight/download/${trimData.output_filename}`);
            const trimBlob = await dlRes.blob();
            targetFile = new File([trimBlob], 'trimmed.pdf', { type: 'application/pdf' });
        }

        // We use uploadPDF first to bypass FastAPI multipart bugs when mixing files and text fields
        setProgress('Đang tải file lên server...');
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
        
        setProgress('Hệ thống đang phân tích và xử lý bù xén...');
        const response = await authenticatedFetch(`${getApiUrl()}/pdf-tools/sticker-dieline`, {
            method: 'POST',
            body: formData,
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => null);
            throw new Error(errData?.detail || `Lỗi server (${response.status})`);
        }
        
        if (productType === 'sticker') {
            const shapeType = response.headers.get('X-Sticker-Shape-Type');
            const shapeParams = response.headers.get('X-Sticker-Shape-Params');
            setDetectedShapeType(shapeType);
            setDetectedShapeParams(shapeParams);
        }
        
        return await response.blob();
    };

    const handleRun = async () => {
        if (!pdfFile) return;

        setIsSuccess(false);
        setIsProcessing(true);
        setError('');
        setProgress('Đang chuẩn bị dữ liệu...');

        try {
            let resultBlob: Blob;
            
            if (productType === 'rectangle' && bleedColorType === 'mirror') {
                resultBlob = await runVectorMirror();
            } else {
                resultBlob = await runOpenCVBleed();
            }

            setProgress('');
            if (onFileFixed) {
                const prefix = productType === 'rectangle' ? 'autobleed' : 'sticker';
                const baseName = pdfFile.name.replace(/\.[^/.]+$/, "");
                onFileFixed(resultBlob, `${prefix}_${baseName}.pdf`);
                setIsSuccess(true);
            }
        } catch (e: any) {
            setError(e.message || 'Đã xảy ra lỗi không xác định.');
            setProgress('');
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
                    className={`flex-1 flex flex-row items-center justify-center gap-2 py-2.5 rounded-lg text-[11px] font-bold transition-all relative z-10 ${
                        productType === 'sticker'
                            ? 'bg-white dark:bg-zinc-800 text-indigo-600 dark:text-indigo-400 shadow-md ring-1 ring-indigo-100 dark:ring-indigo-500/30'
                            : 'text-slate-500 hover:text-slate-700 dark:hover:text-zinc-300 hover:bg-slate-200/50 dark:hover:bg-zinc-700/50'
                    }`}
                >
                    <span className="text-lg">🔵</span>
                    BẾ TEM NHÃN
                </button>
                <button
                    onClick={() => handleProductTypeChange('rectangle')}
                    className={`flex-1 flex flex-row items-center justify-center gap-2 py-2.5 rounded-lg text-[11px] font-bold transition-all relative z-10 ${
                        productType === 'rectangle'
                            ? 'bg-white dark:bg-zinc-800 text-indigo-600 dark:text-indigo-400 shadow-md ring-1 ring-indigo-100 dark:ring-indigo-500/30'
                            : 'text-slate-500 hover:text-slate-700 dark:hover:text-zinc-300 hover:bg-slate-200/50 dark:hover:bg-zinc-700/50'
                    }`}
                >
                    <span className="text-lg">🟦</span>
                    XÉN VUÔNG GÓC
                </button>
            </div>

            {/* --- TAB 1: BẾ TEM NHÃN --- */}
            {productType === 'sticker' && (
                <div className="animate-in slide-in-from-left-4 fade-in duration-300 space-y-4">
                    {/* 1. Đường cắt */}
                    <div>
                        <ToolSectionLabel>1. Đường cắt (Dieline)</ToolSectionLabel>
                        <div className="flex flex-col gap-1.5 mb-4 relative z-[60]">
                            <RichSelect
                                value={cutMode}
                                onChange={(v) => setCutMode(v)}
                                options={CUT_MODES_RICH}
                            />
                        </div>
                        
                        {cutMode !== 'none' && (
                            <>
                                <div className="flex gap-2 mt-4 items-end">
                                    <ToolNumberInput
                                        label="Co/Giãn viền"
                                        value={offsetMm}
                                        onChange={setOffsetMm}
                                        suffix="mm"
                                        step={0.5}
                                        className="w-[90px] shrink-0"
                                    />
                                    <div className="flex gap-1.5 flex-1">
                                        {CORNER_STYLES.map(opt => (
                                            <button
                                                key={opt.id}
                                                onClick={() => setCornerStyle(opt.id)}
                                                className={`flex-1 h-[32px] rounded border text-[12px] transition-all flex items-center justify-center font-bold ${
                                                    cornerStyle === opt.id
                                                        ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300'
                                                        : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400'
                                                }`}
                                            >
                                                {opt.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <p className="text-[10px] text-slate-400 mt-1 mb-4">Số âm (vd -0.5) ép đường cắt lún vào trong, tránh lộ viền trắng.</p>
                            </>
                        )}
                    </div>
                    {/* 2. Tràn lề */}
                    <div>
                        <ToolSectionLabel>2. Tràn lề & Đặc ruột</ToolSectionLabel>
                        <div className="flex gap-2 mb-4 items-end">
                            <ToolNumberInput
                                label="Tràn màu"
                                value={bleedMm}
                                onChange={setBleedMm}
                                suffix="mm"
                                step={0.5}
                                className="w-[90px] shrink-0"
                            />
                            <div className="flex gap-1.5 flex-1">
                                <button
                                    onClick={() => setFillHoles(!fillHoles)}
                                    title="Bỏ qua các lỗ rỗng bên trong khối hình. Máy bế chỉ cắt viền ngoài cùng."
                                    className={`flex-1 h-[32px] rounded border text-[11px] transition-all flex items-center justify-center font-bold px-1 whitespace-nowrap overflow-hidden ${
                                        fillHoles
                                            ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300'
                                            : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400'
                                    }`}
                                >
                                    {fillHoles ? '✅ Đặc ruột' : 'Đặc ruột'}
                                </button>
                                <button
                                    onClick={() => setRemoveWhiteBg(!removeWhiteBg)}
                                    title="Chỉ dò viền của chi tiết, bỏ qua mảng nền trắng."
                                    className={`flex-1 h-[32px] rounded border text-[11px] transition-all flex items-center justify-center font-bold px-1 whitespace-nowrap overflow-hidden ${
                                        removeWhiteBg
                                            ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300'
                                            : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400'
                                    }`}
                                >
                                    {removeWhiteBg ? '✅ Bỏ nền trắng' : 'Bỏ nền trắng'}
                                </button>
                            </div>
                        </div>
                        
                        {(cutMode === 'bleed' || cutMode === 'none' || bleedMm > 0) && (
                            <div className="mt-6 p-3 bg-slate-50 dark:bg-zinc-800/50 rounded-xl border border-slate-200 dark:border-zinc-700/50">
                                <label className="block text-xs font-bold text-slate-700 dark:text-zinc-300 mb-2">Màu nền bù xén</label>
                                <div className="flex flex-col gap-1.5 mb-2 relative z-[50]">
                                    <RichSelect
                                        value={bleedColorType}
                                        onChange={(v) => setBleedColorType(v)}
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
                        <ToolSectionLabel>Xóa Lề Trắng & Bù Xén</ToolSectionLabel>
                        
                        <div className="flex gap-2 mb-4 items-end">
                            <ToolNumberInput
                                label="Độ dày Bleed"
                                value={bleedMm}
                                onChange={setBleedMm}
                                suffix="mm"
                                step={0.5}
                                className="w-[90px] shrink-0"
                            />
                            <div className="flex-1">
                                <button
                                    onClick={() => setRemoveWhiteBg(!removeWhiteBg)}
                                    title="Tự động thu gọn các khoảng trắng vô dụng xung quanh hình trước khi bù xén. Giữ nguyên chất lượng vector gốc của file."
                                    className={`w-full h-[32px] rounded border text-[11px] transition-all flex items-center justify-center font-bold px-2 whitespace-nowrap overflow-hidden ${
                                        removeWhiteBg
                                            ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300'
                                            : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400'
                                    }`}
                                >
                                    {removeWhiteBg ? '✅ Xóa lề trắng thừa' : 'Xóa lề trắng thừa'}
                                </button>
                            </div>
                        </div>
                        
                        <div className="p-3 bg-slate-50 dark:bg-zinc-800/50 rounded-xl border border-slate-200 dark:border-zinc-700/50">
                            <label className="block text-xs font-bold text-slate-700 dark:text-zinc-300 mb-2">Màu nền bù xén</label>
                            <div className="flex flex-col gap-1.5 mb-2 relative z-[50]">
                                <RichSelect
                                    value={bleedColorType}
                                    onChange={(v) => setBleedColorType(v)}
                                    options={BLEED_COLOR_MODES_RECTANGLE}
                                />
                            </div>
                            
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
                    {isProcessing ? '⏳ Đang xử lý...' : (productType === 'sticker' ? '✂️ Tự động Bù xén & Tạo viền cắt' : '🔲 Tự động Bù xén Hình vuông')}
                </button>
            ) : (
                <div className="mt-4 bg-white dark:bg-zinc-800 p-4 rounded-xl shadow-sm border border-emerald-200 dark:border-emerald-800/50 animate-in fade-in slide-in-from-bottom-2 duration-300">
                    <div className="flex items-center gap-2 mb-4">
                        <div className="w-8 h-8 bg-emerald-100 dark:bg-emerald-900/50 rounded-full flex items-center justify-center shrink-0">
                            <span className="text-sm">✅</span>
                        </div>
                        <div className="flex flex-col">
                            <h3 className="text-[13px] font-bold text-emerald-700 dark:text-emerald-400">Đã tạo bù xén thành công!</h3>
                            <p className="text-[10px] text-slate-500 leading-tight">Bước tiếp theo: Chọn kiểu dàn trang (Imposition)</p>
                        </div>
                    </div>
                    <div className="flex flex-col gap-2">
                        {productType === 'rectangle' && cutMode === 'none' && (
                            <>
                                <ToolItem 
                                    icon="📚" label="Bình Sách & Tạp chí" desc="Khâu chỉ, lồng đôi, bù gáy"
                                    onClick={() => { setActiveDashboardTool('booklet'); setTaskMode('booklet'); }} 
                                    hoverColor="hover:border-emerald-400 dark:hover:border-emerald-500" 
                                />
                                <ToolItem 
                                    icon="🎴" label="Bình bài Xén (N-Up)" desc="N-Up, Nhân bản S&R"
                                    onClick={() => { setActiveDashboardTool('nup'); setTaskMode('nup'); }} 
                                    hoverColor="hover:border-rose-400 dark:hover:border-rose-500" 
                                />
                            </>
                        )}
                        {(productType === 'sticker' || (productType === 'rectangle' && cutMode !== 'none')) && (
                            <ToolItem 
                                icon="✂️" label="Bình bài Bế Tem" desc="Xếp tem bế, tổ ong"
                                onClick={() => { setActiveDashboardTool('sticker_imposer'); setTaskMode('sticker_imposer'); }} 
                                hoverColor="hover:border-pink-400 dark:hover:border-pink-500" 
                            />
                        )}
                    </div>
                    <button
                        onClick={() => setIsSuccess(false)}
                        className="mt-4 w-full text-xs font-bold text-slate-400 hover:text-slate-600 dark:hover:text-zinc-300 py-1 transition-colors"
                    >
                        Quay lại chỉnh sửa bù xén
                    </button>
                </div>
            )}

            {/* Progress */}
            {progress && (
                <div className="flex items-center gap-3 bg-rose-50 dark:bg-rose-900/20 p-3 rounded-lg border border-rose-200 dark:border-rose-800/50 mt-2">
                    <div className="w-5 h-5 rounded-full border-2 border-rose-500 border-t-transparent animate-spin shrink-0" />
                    <span className="text-[12px] text-rose-700 dark:text-rose-300 font-medium">{progress}</span>
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
