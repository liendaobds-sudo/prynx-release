import React, { useState, useRef } from 'react';
import { PDFDocument, rgb, degrees, StandardFonts } from 'pdf-lib';
import { getFileArrayBuffer } from '../../lib/utils';
import { ToolSectionLabel } from './ToolUI';
import { FontSelector } from './FontSelector';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { useWorkingPdf } from '../../hooks/useWorkingPdf';
import { formatPageNumber, applyTokens, effectiveLR, NUMBER_STYLES, type NumberStyle } from '../../lib/stampFormat';
import { useTranslation } from 'react-i18next';

interface Props {
    pdfFile: File | null;
    onFileFixed?: (blob: Blob, filename: string) => void;
    onBack?: () => void;
}

export default function StickTextNumberTool({ pdfFile, onFileFixed, onBack }: Props) {
  const { t } = useTranslation();
    const [isProcessing, setIsProcessing] = useState(false);
    const [progress, setProgress] = useState('');
    const [error, setError] = useState('');
    const [isSuccess, setIsSuccess] = useState(false);

    // Header/Footer Fields
    const [fields, setFields] = useState({
        topLeft: '', topCenter: '', topRight: '',
        bottomLeft: '', bottomCenter: '', bottomRight: ''
    });

    // Tracking last focused field for quick actions
    const lastFocusedField = useRef<keyof typeof fields>('topCenter');

    // Number settings
    const [startNumber, setStartNumber] = useState(1);
    const [increment, setIncrement] = useState(1);
    const [padLength, setPadLength] = useState(1);
    const [numberStyle, setNumberStyle] = useState<NumberStyle>('arabic');

    // Appearance
    const [fontName, setFontName] = useState('Helvetica');
    const [fontFile, setFontFile] = useState<string | undefined>();
    const [fontSize, setFontSize] = useState(12);
    const [fontColor, setFontColor] = useState('#000000');

    // Margins (mm)
    const [margins, setMargins] = useState({ top: 12.7, bottom: 12.7, left: 25.4, right: 25.4 });
    const [mirrorMargins, setMirrorMargins] = useState(false);

    // Rotation
    const [rotation, setRotation] = useState(0);

    // Pages
    const [targetType, setTargetType] = useState<'all' | 'even' | 'odd' | 'range'>('all');
    const [rangeStart, setRangeStart] = useState(1);
    const [rangeEnd, setRangeEnd] = useState(999);

    const { setStickPreviewParams } = useWorkspaceStore();
    const getWorkingFile = useWorkingPdf();

    // Sync preview params
    React.useEffect(() => {
        setStickPreviewParams({
            fields, margins, startNumber, increment, padLength,
            fontName, fontSize, fontColor, rotation,
            targetType, rangeStart, rangeEnd,
            numberStyle, mirrorMargins
        });
        return () => setStickPreviewParams(null);
    }, [fields, margins, startNumber, increment, padLength, fontName, fontSize, fontColor, rotation, targetType, rangeStart, rangeEnd, numberStyle, mirrorMargins, setStickPreviewParams]);

    const MM_TO_PT = 2.83465;

    const hexToRgb = (hex: string) => {
        const r = parseInt(hex.slice(1, 3), 16) / 255;
        const g = parseInt(hex.slice(3, 5), 16) / 255;
        const b = parseInt(hex.slice(5, 7), 16) / 255;
        return rgb(r, g, b);
    };

    const handleRun = async () => {
        if (!pdfFile) return;

        setIsSuccess(false);
        setIsProcessing(true);
        setError('');
        setProgress(t('preprocess.stickTextNumber:dang_xu_ly_dong_dau'));

        try {
            // Đóng dấu trên BẢN ĐÃ CHỈNH (viewer reorder/xoay/xoá) nếu có — đồng bộ
            // với các tool khác; tránh đóng lên file gốc làm mất chỉnh sửa.
            const sourceFile = (await getWorkingFile()) || pdfFile;
            const buf = await getFileArrayBuffer(sourceFile);
            const doc = await PDFDocument.load(buf, { ignoreEncryption: true });

            // Load Font
            let font;
            // 1) Font tuỳ chỉnh người dùng chọn (Tauri đọc file .ttf/.otf).
            if (fontFile && (window as any).__TAURI_INTERNALS__) {
                try {
                    const { readFile } = await import('@tauri-apps/plugin-fs');
                    const fontBytes = await readFile(fontFile);

                    const fontkit = (await import('@pdf-lib/fontkit')).default;
                    doc.registerFontkit(fontkit);
                    font = await doc.embedFont(fontBytes);
                } catch (e) {
                    console.error("Failed to load custom font", e);
                }
            }

            // 2) Mặc định: font Unicode bundle (Roboto) — HỖ TRỢ TIẾNG VIỆT.
            //    StandardFonts (Helvetica/Times/Courier) mã hoá WinAnsi, KHÔNG encode
            //    được nhiều ký tự Việt (ụ, ệ, ộ…) → drawText ném lỗi. Roboto nhúng qua
            //    fontkit khắc phục triệt để.
            if (!font) {
                try {
                    const fontkit = (await import('@pdf-lib/fontkit')).default;
                    doc.registerFontkit(fontkit);
                    const res = await fetch('/fonts/Roboto-Regular.ttf');
                    if (res.ok) {
                        font = await doc.embedFont(await res.arrayBuffer());
                    }
                } catch (e) {
                    console.error("Failed to load bundled Unicode font", e);
                }
            }

            // 3) Last resort: StandardFonts (chỉ an toàn với ký tự ASCII/Latin-1).
            if (!font) {
                if (fontName === 'Times-Roman') font = await doc.embedFont(StandardFonts.TimesRoman);
                else if (fontName === 'Courier') font = await doc.embedFont(StandardFonts.Courier);
                else font = await doc.embedFont(StandardFonts.Helvetica);
            }

            const textColor = hexToRgb(fontColor);
            const pageCount = doc.getPageCount();

            const shouldProcess = (pageIndex: number) => {
                if (targetType === 'all') return true;
                if (targetType === 'even') return (pageIndex + 1) % 2 === 0;
                if (targetType === 'odd') return (pageIndex + 1) % 2 === 1;
                if (targetType === 'range') return (pageIndex + 1) >= rangeStart && (pageIndex + 1) <= rangeEnd;
                return true;
            };

            let sequenceCounter = startNumber;

            // Generate today's date
            const todayStr = new Date().toLocaleDateString('vi-VN');

            for (let i = 0; i < pageCount; i++) {
                if (!shouldProcess(i)) continue;

                const page = doc.getPage(i);
                const { width, height } = page.getSize();
                const numStr = formatPageNumber(sequenceCounter, numberStyle, padLength);
                const totalStr = String(pageCount);

                const marginPt = {
                    top: margins.top * MM_TO_PT,
                    bottom: margins.bottom * MM_TO_PT,
                    left: margins.left * MM_TO_PT,
                    right: margins.right * MM_TO_PT
                };
                // Lề gương 2 mặt: hoán đổi trái/phải ở trang chẵn (gáy theo phía trong).
                const eff = effectiveLR(marginPt.left, marginPt.right, i + 1, mirrorMargins);

                const textHeight = font.heightAtSize(fontSize);
                const baselineOffset = textHeight * 0.2; 

                const drawField = (content: string, pos: 'topLeft' | 'topCenter' | 'topRight' | 'bottomLeft' | 'bottomCenter' | 'bottomRight') => {
                    if (!content) return;
                    let drawString = applyTokens(content, numStr, totalStr, todayStr);
                    const textWidth = font.widthOfTextAtSize(drawString, fontSize);

                    let x = 0;
                    let y = 0;

                    // X position
                    if (pos.includes('Left')) {
                        x = eff.left;
                    } else if (pos.includes('Right')) {
                        x = width - textWidth - eff.right;
                    } else {
                        x = (width / 2) - (textWidth / 2);
                    }

                    // Y position
                    if (pos.includes('top')) {
                        y = height - textHeight + baselineOffset - marginPt.top;
                    } else {
                        y = marginPt.bottom + baselineOffset;
                    }

                    // 0° đặt đúng vị trí (đã xác minh). Góc xoay khác: pdf-lib xoay
                    // quanh điểm neo baseline-trái — parity chính xác với preview chưa
                    // xác minh được nên KHÔNG bù tâm ở đây (xem ghi chú UI: chỉ 0°).
                    page.drawText(drawString, {
                        x, y, size: fontSize, font, color: textColor, rotate: degrees(rotation)
                    });
                };

                drawField(fields.topLeft, 'topLeft');
                drawField(fields.topCenter, 'topCenter');
                drawField(fields.topRight, 'topRight');
                drawField(fields.bottomLeft, 'bottomLeft');
                drawField(fields.bottomCenter, 'bottomCenter');
                drawField(fields.bottomRight, 'bottomRight');

                sequenceCounter += increment;
            }

            const pdfBytes = await doc.save();
            const blob = new Blob([pdfBytes as any], { type: 'application/pdf' });

            setProgress('');
            if (onFileFixed) {
                onFileFixed(blob, `Stamped_${pdfFile.name}`);
                setIsSuccess(true);
            }
        } catch (e: any) {
            setError(e.message || t('preprocess.stickTextNumber:da_xay_ra_loi_khi_xu_ly'));
            setProgress('');
        } finally {
            setIsProcessing(false);
        }
    };

    const insertToken = (token: string) => {
        const fieldName = lastFocusedField.current;
        setFields(prev => ({
            ...prev,
            [fieldName]: prev[fieldName] + (prev[fieldName].endsWith(' ') || prev[fieldName] === '' ? '' : ' ') + token
        }));
    };

    const renderFieldInput = (label: string, name: keyof typeof fields) => (
        <div className="flex flex-col gap-1">
            <label className="text-[10px] font-bold text-slate-500 uppercase">{label}</label>
            <input 
                type="text" 
                value={fields[name]} 
                onChange={e => setFields(prev => ({ ...prev, [name]: e.target.value }))}
                onFocus={() => lastFocusedField.current = name}
                className="w-full h-8 px-2 border border-slate-300 dark:border-white/20 rounded dark:bg-zinc-900 text-[11px] focus:outline-none focus:ring-1 focus:ring-sky-500"
                placeholder={t('preprocess.stickTextNumber:nhap_text')}
            />
        </div>
    );

    return (
        <div className="flex flex-col gap-4 animate-in fade-in duration-300 pb-10">
            {/* Header */}
            <div className="flex items-center gap-2 pb-3 border-b border-slate-200 dark:border-zinc-700 shrink-0">
                <button 
                    onClick={onBack}
                    className="p-1.5 hover:bg-slate-100 dark:bg-zinc-800 rounded-md text-slate-500 transition-colors"
                    title={t('preprocess.stickTextNumber:quay_lai')}
                >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
                </button>
                <div className="flex-1 min-w-0 text-center pr-8">
                    <h2 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center justify-center gap-2">
                        <span>🔠</span>
                        <span>HEADER & FOOTER</span>
                    </h2>
                    <p className="text-[11px] text-slate-500 mt-1">{t('preprocess.stickTextNumber:chen_so_trang_ngay_thang_text_co_dinh')}</p>
                </div>
            </div>

            <div className="flex flex-col gap-4">
                {/* Headers & Footers UI */}
                <div className="bg-slate-50 dark:bg-zinc-800/30 p-3 rounded-lg border border-slate-200 dark:border-zinc-700/50 flex flex-col gap-3">
                    {/* Quick tokens */}
                    <div className="flex justify-center gap-2 mb-2">
                        <button onClick={() => insertToken('[page]')} className="px-3 py-1 bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300 text-xs font-bold rounded shadow-sm hover:bg-sky-200 border border-sky-200 dark:border-sky-800">{t('preprocess.stickTextNumber:so_trang_page')}</button>
                        <button onClick={() => insertToken('[total]')} className="px-3 py-1 bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 text-xs font-bold rounded shadow-sm hover:bg-emerald-200 border border-emerald-200 dark:border-emerald-800">{t('preprocess.stickTextNumber:tong_trang_total')}</button>
                        <button onClick={() => insertToken('[date]')} className="px-3 py-1 bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 text-xs font-bold rounded shadow-sm hover:bg-amber-200 border border-amber-200 dark:border-amber-800">{t('preprocess.stickTextNumber:ngay_date')}</button>
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                        {renderFieldInput(t('preprocess.stickTextNumber:header_trai'), "topLeft")}
                        {renderFieldInput(t('preprocess.stickTextNumber:header_giua'), "topCenter")}
                        {renderFieldInput(t('preprocess.stickTextNumber:header_phai'), "topRight")}
                    </div>
                    
                    <div className="grid grid-cols-3 gap-2 mt-2">
                        {renderFieldInput(t('preprocess.stickTextNumber:footer_trai'), "bottomLeft")}
                        {renderFieldInput(t('preprocess.stickTextNumber:footer_giua'), "bottomCenter")}
                        {renderFieldInput(t('preprocess.stickTextNumber:footer_phai'), "bottomRight")}
                    </div>
                </div>

                {/* Numbering logic settings */}
                <div className="border-t border-slate-200 dark:border-zinc-800 pt-3">
                    <span className="text-xs font-bold text-slate-700 dark:text-zinc-300 uppercase tracking-wider mb-2 block">{t('preprocess.stickTextNumber:cai_dat_so_nhay_page')}</span>
                    <div className="grid grid-cols-3 gap-2">
                        <div className="flex flex-col gap-1">
                            <label className="text-[10px] font-bold text-slate-500 uppercase">{t('preprocess.stickTextNumber:so_bat_dau')}</label>
                            <input type="number" value={startNumber} onChange={e => setStartNumber(Number(e.target.value))} className="w-full h-8 px-2 border border-slate-300 dark:border-white/20 rounded dark:bg-zinc-900 text-sm" />
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="text-[10px] font-bold text-slate-500 uppercase">{t('preprocess.stickTextNumber:buoc_nhay')}</label>
                            <input type="number" value={increment} onChange={e => setIncrement(Number(e.target.value))} className="w-full h-8 px-2 border border-slate-300 dark:border-white/20 rounded dark:bg-zinc-900 text-sm" />
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="text-[10px] font-bold text-slate-500 uppercase">{t('preprocess.stickTextNumber:do_dai_so')}</label>
                            <input type="number" min={1} max={10} value={padLength} onChange={e => setPadLength(Number(e.target.value))} className="w-full h-8 px-2 border border-slate-300 dark:border-white/20 rounded dark:bg-zinc-900 text-sm" />
                        </div>
                    </div>
                    <div className="flex flex-col gap-1 mt-2">
                        <label className="text-[10px] font-bold text-slate-500 uppercase">{t('preprocess.stickTextNumber:kieu_so')}</label>
                        <select value={numberStyle} onChange={e => setNumberStyle(e.target.value as NumberStyle)} className="w-full h-8 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm outline-none">
                            {NUMBER_STYLES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                        </select>
                        <span className="text-[10px] text-slate-400 leading-snug mt-0.5">Mẹo: gõ "Trang [page]/[total]" để ra "Trang 1/20". Kiểu La Mã/chữ cái bỏ qua "Độ dài số".</span>
                    </div>
                </div>

                {/* Margins */}
                <div className="border-t border-slate-200 dark:border-zinc-800 pt-3">
                    <span className="text-xs font-bold text-slate-700 dark:text-zinc-300 uppercase tracking-wider mb-2 block">{t('preprocess.stickTextNumber:margin_le_mm')}</span>
                    <div className="grid grid-cols-4 gap-2">
                        <div className="flex flex-col gap-1">
                            <label className="text-[10px] font-bold text-slate-500 uppercase">Top</label>
                            <input type="number" step="1" value={margins.top} onChange={e => setMargins({...margins, top: Number(e.target.value)})} className="w-full h-8 px-2 border border-slate-300 dark:border-white/20 rounded dark:bg-zinc-900 text-sm" />
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="text-[10px] font-bold text-slate-500 uppercase">Bottom</label>
                            <input type="number" step="1" value={margins.bottom} onChange={e => setMargins({...margins, bottom: Number(e.target.value)})} className="w-full h-8 px-2 border border-slate-300 dark:border-white/20 rounded dark:bg-zinc-900 text-sm" />
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="text-[10px] font-bold text-slate-500 uppercase">Left</label>
                            <input type="number" step="1" value={margins.left} onChange={e => setMargins({...margins, left: Number(e.target.value)})} className="w-full h-8 px-2 border border-slate-300 dark:border-white/20 rounded dark:bg-zinc-900 text-sm" />
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="text-[10px] font-bold text-slate-500 uppercase">Right</label>
                            <input type="number" step="1" value={margins.right} onChange={e => setMargins({...margins, right: Number(e.target.value)})} className="w-full h-8 px-2 border border-slate-300 dark:border-white/20 rounded dark:bg-zinc-900 text-sm" />
                        </div>
                    </div>
                    <button onClick={() => setMirrorMargins(!mirrorMargins)}
                        className={`mt-2 w-full text-left px-3 py-2 rounded-lg border text-[12px] transition-all flex items-start gap-2.5
                            ${mirrorMargins ? 'border-sky-500 bg-sky-500/10 text-sky-700 dark:text-sky-300' : 'border-slate-200 dark:border-white/10 hover:bg-slate-50 dark:hover:bg-zinc-800 text-slate-600 dark:text-zinc-400'}`}>
                        <div className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0 ${mirrorMargins ? 'bg-sky-500 border-sky-500' : 'bg-white dark:bg-zinc-800 border-slate-300 dark:border-zinc-500'}`}>
                            {mirrorMargins && <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={4} d="M5 13l4 4L19 7" /></svg>}
                        </div>
                        <div className="flex-1">
                            <span className="font-semibold block">{t('preprocess.stickTextNumber:le_guong_2_mat_dong_cuon')}</span>
                            <span className="text-[10px] text-slate-500 dark:text-zinc-400 block leading-snug mt-0.5">{t('preprocess.stickTextNumber:tu_hoan_doi_le_trai_phai_o_trang_chan')}</span>
                        </div>
                    </button>
                </div>

                {/* Appearance */}
                <div className="border-t border-slate-200 dark:border-zinc-800 pt-3">
                    <span className="text-xs font-bold text-slate-700 dark:text-zinc-300 uppercase tracking-wider mb-2 block">{t('preprocess.stickTextNumber:font_chu')}</span>
                    <div className="grid grid-cols-2 gap-3">
                        <div className="flex flex-col gap-1 col-span-2">
                            <FontSelector value={fontName} fontFile={fontFile} onChange={(name, file) => { setFontName(name); setFontFile(file); }} />
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="text-[10px] font-medium text-slate-500">{t('preprocess.stickTextNumber:co_chu_pt')}</label>
                            <input type="number" min="1" value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} className="w-full h-8 px-2 border border-slate-300 dark:border-white/20 rounded dark:bg-zinc-900 text-sm" />
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="text-[10px] font-medium text-slate-500">{t('preprocess.stickTextNumber:mau_chu')}</label>
                            <div className="flex items-center gap-2">
                                <input type="color" value={fontColor} onChange={(e) => setFontColor(e.target.value)} className="w-8 h-8 rounded cursor-pointer bg-transparent border-0 p-0" />
                                <span className="text-[11px] font-mono text-slate-500">{fontColor.toUpperCase()}</span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Rotate & Pages */}
                <div className="border-t border-slate-200 dark:border-zinc-800 pt-3 grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-bold text-slate-500 uppercase">{t('preprocess.stickTextNumber:goc_xoay')}</label>
                        <select value={rotation} onChange={(e) => setRotation(Number(e.target.value))} className="bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded h-8 px-2 text-sm outline-none">
                            <option value="0">{t('preprocess.stickTextNumber:0_do')}</option>
                            <option value="90">{t('preprocess.stickTextNumber:90_do')}</option>
                            <option value="180">{t('preprocess.stickTextNumber:180_do')}</option>
                            <option value="270">{t('preprocess.stickTextNumber:270_do')}</option>
                        </select>
                    </div>
                    <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-bold text-slate-500 uppercase">{t('preprocess.stickTextNumber:pham_vi_trang')}</label>
                        <select value={targetType} onChange={(e) => setTargetType(e.target.value as any)} className="bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded h-8 px-2 text-sm outline-none">
                            <option value="all">{t('preprocess.stickTextNumber:tat_ca_trang')}</option>
                            <option value="even">{t('preprocess.stickTextNumber:chi_trang_chan')}</option>
                            <option value="odd">{t('preprocess.stickTextNumber:chi_trang_le')}</option>
                            <option value="range">{t('preprocess.stickTextNumber:tuy_chon')}</option>
                        </select>
                    </div>
                </div>

                {targetType === 'range' && (
                    <div className="flex items-center gap-2 text-sm bg-slate-50 dark:bg-zinc-800 p-2 rounded border border-slate-200 dark:border-zinc-700">
                        <span className="text-xs">{t('preprocess.stickTextNumber:tu')}</span>
                        <input type="number" min={1} value={rangeStart} onChange={e => setRangeStart(Number(e.target.value))} className="w-16 h-7 px-1 border border-slate-300 dark:border-white/10 rounded dark:bg-zinc-900" />
                        <span className="text-xs">{t('preprocess.stickTextNumber:den')}</span>
                        <input type="number" min={1} value={rangeEnd} onChange={e => setRangeEnd(Number(e.target.value))} className="w-16 h-7 px-1 border border-slate-300 dark:border-white/10 rounded dark:bg-zinc-900" />
                    </div>
                )}
            </div>

            {/* Run Button */}
            {!isSuccess ? (
                <button
                    onClick={handleRun}
                    disabled={isProcessing || !pdfFile}
                    className={`w-full h-12 rounded-xl text-[14px] font-bold transition-all mt-2 flex items-center justify-center gap-2 ${
                        isProcessing || !pdfFile
                            ? 'bg-slate-300 dark:bg-zinc-700 text-slate-500 cursor-not-allowed'
                            : 'bg-sky-600 hover:bg-sky-700 text-white shadow-md'
                    }`}
                >
                    {isProcessing ? t('preprocess.stickTextNumber:dang_xu_ly') : t('preprocess.stickTextNumber:ap_dung_thay_doi')}
                </button>
            ) : (
                <div className="mt-4 bg-white dark:bg-zinc-800 p-4 rounded-xl shadow-sm border border-emerald-200 dark:border-emerald-800/50 animate-in fade-in slide-in-from-bottom-2 duration-300">
                    <div className="flex items-center gap-2">
                        <div className="w-8 h-8 bg-emerald-100 dark:bg-emerald-900/50 rounded-full flex items-center justify-center shrink-0">
                            <span className="text-sm">✅</span>
                        </div>
                        <div className="flex flex-col">
                            <h3 className="text-[13px] font-bold text-emerald-700 dark:text-emerald-400">{t('preprocess.stickTextNumber:dong_dau_thanh_cong')}</h3>
                            <p className="text-[10px] text-slate-500 leading-tight">{t('preprocess.stickTextNumber:file_pdf_da_duoc_xu_ly_hoan_tat')}</p>
                        </div>
                    </div>
                    <button onClick={() => setIsSuccess(false)} className="mt-4 w-full text-xs font-bold text-slate-400 hover:text-slate-600 dark:hover:text-zinc-300 py-1 transition-colors">
                        {t('preprocess.stickTextNumber:tiep_tuc_voi_file_khac')}
                    </button>
                </div>
            )}

            {error && (
                <div className="bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-200 dark:border-red-800/50 mt-2">
                    <span className="text-[12px] text-red-600 dark:text-red-400 font-medium">❌ {error}</span>
                </div>
            )}
        </div>
    );
}
