import React, { useState } from 'react';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { ToolSectionLabel, ToolNumberInput, ToolCheckboxOption } from './ToolUI';
import { RichSelect } from '../imposition-tools/SharedUI';
import { PDFDocument, rgb, degrees, StandardFonts } from 'pdf-lib';
import { getFileArrayBuffer } from '../../lib/utils';
import { useWorkingPdf } from '../../hooks/useWorkingPdf';
import { imageBytesToPdfDoc, embedImagePreserveCompression } from '../../lib/imageNormalizer';
import { useTranslation } from 'react-i18next';

const ZINDEX_OPTIONS = [
    { value: 'top', title: '⬆️ Đè lên trên' },
    { value: 'bottom', title: '⬇️ Lót dưới cùng' },
];

const TARGET_OPTIONS = [
    { value: 'all', title: '📄 Tất cả trang' },
    { value: 'even', title: '2️⃣ Chỉ trang chẵn' },
    { value: 'odd', title: '1️⃣ Chỉ trang lẻ' },
    { value: 'range', title: '🔢 Khoảng tự chọn...' },
];

const SCALE_OPTIONS = [
    { value: 'absolute', title: '📐 Tuyệt đối (%)' },
    { value: 'fit_page', title: '🖼️ Vừa khít trang (Giữ tỷ lệ)' },
    { value: 'stretch', title: '🪟 Phủ kín trang (Ép méo)' },
];

const POS_X_OPTIONS = [
    { value: 'left', title: '⬅️ Cạnh trái' },
    { value: 'center', title: '↔️ Chính giữa' },
    { value: 'right', title: '➡️ Cạnh phải' },
];

const POS_Y_OPTIONS = [
    { value: 'top', title: '⬆️ Cạnh trên' },
    { value: 'center', title: '↕️ Chính giữa' },
    { value: 'bottom', title: '⬇️ Cạnh dưới' },
];

interface Props {
    pdfFile: File | null;
    onFileFixed?: (blob: Blob, filename: string) => void;
}

export default function WatermarkTool({ pdfFile, onFileFixed }: Props) {
  const { t } = useTranslation();
    const getWorkingFile = useWorkingPdf();
    const [isProcessing, setIsProcessing] = useState(false);
    const [progress, setProgress] = useState('');
    const [error, setError] = useState('');
    const [isSuccess, setIsSuccess] = useState(false);

    // Watermark State
    const [watermarkType, setWatermarkType] = useState<'text' | 'image'>('text');
    const [watermarkText, setWatermarkText] = useState('Trang [PAGE] / [TOTAL]');
    const [batesStart, setBatesStart] = useState(1);
    const [batesPadding, setBatesPadding] = useState(5);
    const [watermarkImageFile, setWatermarkImageFile] = useState<File | null>(null);
    const [watermarkImageUrl, setWatermarkImageUrl] = useState('');
    const [wmWidth, setWmWidth] = useState(100);
    const [wmHeight, setWmHeight] = useState(100);
    
    // Scale & Position
    const [scaleMode, setScaleMode] = useState<'absolute' | 'fit_page' | 'stretch'>('absolute');
    const [imageScale, setImageScale] = useState(0.5);
    const [positionXMode, setPositionXMode] = useState<'center' | 'left' | 'right'>('center');
    const [offsetX, setOffsetX] = useState(0);
    const [positionYMode, setPositionYMode] = useState<'center' | 'top' | 'bottom'>('center');
    const [offsetY, setOffsetY] = useState(0);

    const [opacity, setOpacity] = useState(0.3);
    const [color, setColor] = useState('#000000');
    const [fontSize, setFontSize] = useState(72);
    const [rotation, setRotation] = useState(45);
    const [spacing, setSpacing] = useState(100);
    const [isRepeated, setIsRepeated] = useState(true); // "Canvas Wrap" feature

    // Z-Index & Range
    const [layerZIndex, setLayerZIndex] = useState<'top' | 'bottom'>('top');
    const [targetType, setTargetType] = useState<'all' | 'even' | 'odd' | 'range'>('all');
    const [rangeStart, setRangeStart] = useState(1);
    const [rangeEnd, setRangeEnd] = useState(999);
    
    const setWatermarkPreview = useWorkspaceStore(s => s.setWatermarkPreview);

    // Sync preview state
    React.useEffect(() => {
        setWatermarkPreview({
            watermarkType,
            watermarkText,
            batesStart,
            batesPadding,
            watermarkImageUrl,
            layerZIndex,
            targetType,
            rangeStart,
            rangeEnd,
            color,
            fontSize,
            opacity,
            rotation,
            spacing,
            isRepeated,
            scaleMode,
            imageScale,
            positionXMode,
            offsetX,
            positionYMode,
            offsetY,
            wmWidth,
            wmHeight,
        });

        return () => {
            setWatermarkPreview(null);
        };
    }, [watermarkType, watermarkText, batesStart, batesPadding, watermarkImageUrl, layerZIndex, targetType, rangeStart, rangeEnd, color, fontSize, opacity, rotation, spacing, isRepeated, scaleMode, imageScale, positionXMode, offsetX, positionYMode, offsetY, wmWidth, wmHeight]);

    // Clean up object URL ONLY when component unmounts or image actually changes
    React.useEffect(() => {
        return () => {
            if (watermarkImageUrl) {
                URL.revokeObjectURL(watermarkImageUrl);
            }
        };
    }, [watermarkImageUrl]);

    const hexToRgb = (hex: string) => {
        const r = parseInt(hex.slice(1, 3), 16) / 255;
        const g = parseInt(hex.slice(3, 5), 16) / 255;
        const b = parseInt(hex.slice(5, 7), 16) / 255;
        return rgb(r, g, b);
    };

    const MM_TO_PT = 2.83465;

    const handleRun = async () => {
        if (!pdfFile) return;

        setIsSuccess(false);
        setIsProcessing(true);
        setError('');
        setProgress(t('preprocess.watermark:dang_dong_dau_ban_quyen'));

        try {
            const buf = await getFileArrayBuffer((await getWorkingFile()) || pdfFile);
            let doc: PDFDocument;

            const lowerName = pdfFile.name.toLowerCase();
            const isPng = lowerName.endsWith('.png') || pdfFile.type === 'image/png';
            const isJpg = lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg') || pdfFile.type === 'image/jpeg';

            if (isPng || isJpg) {
                doc = await imageBytesToPdfDoc(buf, pdfFile.name);
            } else {
                doc = await PDFDocument.load(buf, { ignoreEncryption: true });
            }

            const outputPdf = await PDFDocument.create();

            // Embed watermark image if type is image
            let embeddedWmElement: any = null;
            let wmElementWidth = 0;
            let wmElementHeight = 0;

            if (watermarkType === 'image' && watermarkImageFile) {
                const wmBuf = await getFileArrayBuffer(watermarkImageFile);
                const wmLowerName = watermarkImageFile.name.toLowerCase();
                
                if (wmLowerName.endsWith('.pdf') || watermarkImageFile.type === 'application/pdf') {
                    const wmPdf = await PDFDocument.load(wmBuf, { ignoreEncryption: true });
                    const [embeddedPdfPage] = await outputPdf.embedPages([wmPdf.getPage(0)]);
                    embeddedWmElement = embeddedPdfPage;
                    wmElementWidth = embeddedPdfPage.width;
                    wmElementHeight = embeddedPdfPage.height;
                } else {
                    embeddedWmElement = await embedImagePreserveCompression(outputPdf, wmBuf, watermarkImageFile.name);
                    wmElementWidth = embeddedWmElement.width;
                    wmElementHeight = embeddedWmElement.height;
                }
            }
            
            // Try to load custom font for Vietnamese support
            let font;
            try {
                const fontkit = (await import('@pdf-lib/fontkit')).default;
                outputPdf.registerFontkit(fontkit);
                const fontUrl = '/fonts/Roboto-Regular.ttf';
                const fontRes = await fetch(fontUrl);
                if (fontRes.ok) {
                    const fontBytes = await fontRes.arrayBuffer();
                    font = await outputPdf.embedFont(fontBytes);
                }
            } catch (err) {
                console.warn('Failed to load custom font, falling back to standard', err);
            }

            if (!font) {
                font = await outputPdf.embedFont(StandardFonts.HelveticaBold).catch(() => outputPdf.embedFont(StandardFonts.Helvetica));
            }
            
            const textColor = hexToRgb(color);
            const pageCount = doc.getPageCount();

            const shouldProcess = (pageIndex: number) => {
                if (targetType === 'all') return true;
                if (targetType === 'even') return (pageIndex + 1) % 2 === 0;
                if (targetType === 'odd') return (pageIndex + 1) % 2 === 1;
                if (targetType === 'range') return (pageIndex + 1) >= rangeStart && (pageIndex + 1) <= rangeEnd;
                return true;
            };

            const dateStr = new Date().toLocaleDateString('vi-VN');
            const timeStr = new Date().toLocaleTimeString('vi-VN');
            let processCounter = 0;

            for (let i = 0; i < pageCount; i++) {
                const srcPage = doc.getPage(i);
                
                if (!shouldProcess(i)) {
                    const [copied] = await outputPdf.copyPages(doc, [i]);
                    outputPdf.addPage(copied);
                    continue;
                }

                const { width, height } = srcPage.getSize();
                let targetPage;

                if (layerZIndex === 'bottom') {
                    targetPage = outputPdf.addPage([width, height]);
                } else {
                    const [copied] = await outputPdf.copyPages(doc, [i]);
                    targetPage = copied;
                    outputPdf.addPage(copied);
                }

                let elemWidth = 0;
                let elemHeight = 0;
                let finalScaleX = imageScale;
                let finalScaleY = imageScale;
                
                const currentText = watermarkText
                    .replace(/\[PAGE\]/g, (i + 1).toString())
                    .replace(/\[TOTAL\]/g, pageCount.toString())
                    .replace(/\[DATE\]/g, dateStr)
                    .replace(/\[TIME\]/g, timeStr)
                    .replace(/\[BATES\]/g, (batesStart + processCounter).toString().padStart(batesPadding, '0'));
                
                if (watermarkType === 'image' && embeddedWmElement) {
                    if (scaleMode === 'fit_page') {
                        const rad = rotation * Math.PI / 180;
                        const rotatedWmWidth = Math.abs(wmElementWidth * Math.cos(rad)) + Math.abs(wmElementHeight * Math.sin(rad));
                        const rotatedWmHeight = Math.abs(wmElementWidth * Math.sin(rad)) + Math.abs(wmElementHeight * Math.cos(rad));
                        const scaleX = width / rotatedWmWidth;
                        const scaleY = height / rotatedWmHeight;
                        finalScaleX = Math.min(scaleX, scaleY);
                        finalScaleY = finalScaleX;
                    } else if (scaleMode === 'stretch') {
                        const rad = rotation * Math.PI / 180;
                        const targetWidth = width * Math.abs(Math.cos(rad)) + height * Math.abs(Math.sin(rad));
                        const targetHeight = height * Math.abs(Math.cos(rad)) + width * Math.abs(Math.sin(rad));
                        finalScaleX = targetWidth / wmElementWidth;
                        finalScaleY = targetHeight / wmElementHeight;
                    }
                    elemWidth = wmElementWidth * finalScaleX;
                    elemHeight = wmElementHeight * finalScaleY;
                } else if (font) {
                    elemWidth = font.widthOfTextAtSize(currentText, fontSize);
                    elemHeight = font.heightAtSize(fontSize);
                }

                const drawElement = (x: number, y: number) => {
                    if (watermarkType === 'image' && embeddedWmElement) {
                        const isPdfSource = watermarkImageFile && (watermarkImageFile.name.toLowerCase().endsWith('.pdf') || watermarkImageFile.type === 'application/pdf');
                        if (isPdfSource) {
                            // It's an embedded PDF page
                            targetPage.drawPage(embeddedWmElement, { x, y, width: elemWidth, height: elemHeight, opacity: opacity, rotate: degrees(rotation) });
                        } else {
                            targetPage.drawImage(embeddedWmElement, { x, y, width: elemWidth, height: elemHeight, opacity: opacity, rotate: degrees(rotation) });
                        }
                    } else if (font) {
                        targetPage.drawText(currentText, { x, y, size: fontSize, font, color: textColor, opacity: opacity, rotate: degrees(rotation) });
                    }
                };

                if (isRepeated) {
                    // Canvas Wrap Mode
                    const stepX = elemWidth + spacing;
                    const stepY = elemHeight + spacing;
                    
                    let rowCount = 0;
                    for (let y = -height; y < height * 2; y += stepY) {
                        const rowOffsetX = (rowCount % 2 !== 0) ? stepX / 2 : 0;
                        for (let x = -width; x < width * 2; x += stepX) {
                            drawElement(x + rowOffsetX, y);
                        }
                        rowCount++;
                    }
                } else {
                    // Single Mode with Position settings
                    let startX = 0;
                    let startY = 0;

                    if (positionXMode === 'center') startX = width / 2 - elemWidth / 2 + (offsetX * MM_TO_PT);
                    else if (positionXMode === 'left') startX = (offsetX * MM_TO_PT);
                    else if (positionXMode === 'right') startX = width - elemWidth - (offsetX * MM_TO_PT);

                    if (positionYMode === 'center') startY = height / 2 - elemHeight / 2 + (offsetY * MM_TO_PT);
                    else if (positionYMode === 'bottom') startY = (offsetY * MM_TO_PT);
                    else if (positionYMode === 'top') startY = height - elemHeight - (offsetY * MM_TO_PT);

                    drawElement(startX, startY);
                }

                // If bottom layer, draw original page on top
                if (layerZIndex === 'bottom') {
                    const [embedded] = await outputPdf.embedPages([srcPage]);
                    targetPage.drawPage(embedded, { x: 0, y: 0, width, height });
                }

                processCounter++;
            }

            const pdfBytes = await outputPdf.save();
            const blob = new Blob([pdfBytes as any], { type: 'application/pdf' });

            setProgress('');
            if (onFileFixed) {
                onFileFixed(blob, `watermarked_${pdfFile.name}`);
                setIsSuccess(true);
            }
        } catch (e: any) {
            setError(e.message || t('preprocess.watermark:da_xay_ra_loi_khong_xac_dinh'));
            setProgress('');
        } finally {
            setIsProcessing(false);
        }
    };

    return (
        <div className="flex flex-col gap-4 animate-in fade-in duration-300">
            <div>
                <ToolSectionLabel>{t('preprocess.watermark:chen_nen_dong_dau_background_watermark')}</ToolSectionLabel>
                <div className="p-3 bg-slate-50 dark:bg-zinc-800/50 rounded-xl border border-slate-200 dark:border-zinc-700/50 mt-2">
                    <p className="text-xs text-slate-600 dark:text-zinc-400">
                        {t('preprocess.watermark:chen_hinh_nen_file_pdf_anh_ben_duoi')}
                        {' '}{t('preprocess.watermark:xu_ly_truc_tiep_tren_trinh_duyet_bao_mat')}
                    </p>
                </div>
            </div>

            <div className="flex flex-col gap-4">
                {/* 1. NGUỒN DỮ LIỆU (SOURCE) */}
                <div className="flex flex-col gap-2">
                    <div className="flex bg-slate-100 dark:bg-zinc-900 rounded-lg p-1">
                        <button
                            onClick={() => setWatermarkType('text')}
                            className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-colors ${watermarkType === 'text' ? 'bg-white dark:bg-zinc-800 shadow text-slate-800 dark:text-white' : 'text-slate-500 hover:text-slate-700 dark:hover:text-zinc-300'}`}
                        >
                            {t('preprocess.watermark:chu_text')}
                        </button>
                        <button
                            onClick={() => setWatermarkType('image')}
                            className={`flex-1 py-1.5 text-xs font-bold rounded-md transition-colors ${watermarkType === 'image' ? 'bg-white dark:bg-zinc-800 shadow text-slate-800 dark:text-white' : 'text-slate-500 hover:text-slate-700 dark:hover:text-zinc-300'}`}
                        >
                            {t('preprocess.watermark:hinh_anh_phoi_pdf')}
                        </button>
                    </div>

                    {watermarkType === 'text' ? (
                        <div className="flex flex-col gap-1">
                            <label className="text-xs font-bold text-slate-700 dark:text-zinc-300 uppercase tracking-wider">{t('preprocess.watermark:noi_dung_van_ban')}</label>
                            <input 
                                type="text" 
                                value={watermarkText} 
                                onChange={(e) => setWatermarkText(e.target.value)} 
                                className="w-full bg-white dark:bg-zinc-900 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                                placeholder={t('preprocess.watermark:vd_ban_nhap_khong_in')}
                            />
                            {/* Nút bấm nhanh chèn biến */}
                            <div className="flex flex-wrap gap-1.5 mt-1">
                                <button type="button" onClick={() => { setWatermarkText(prev => prev + '[PAGE]'); setIsRepeated(false); setRotation(0); setOpacity(1); }} className="text-[10px] bg-slate-200 dark:bg-zinc-800 hover:bg-slate-300 dark:hover:bg-zinc-700 px-2 py-1 rounded-md text-slate-600 dark:text-zinc-400 font-medium transition-colors">{t('preprocess.watermark:so_trang')}</button>
                                <button type="button" onClick={() => { setWatermarkText(prev => prev + '[TOTAL]'); setIsRepeated(false); setRotation(0); setOpacity(1); }} className="text-[10px] bg-slate-200 dark:bg-zinc-800 hover:bg-slate-300 dark:hover:bg-zinc-700 px-2 py-1 rounded-md text-slate-600 dark:text-zinc-400 font-medium transition-colors">{t('preprocess.watermark:tong_so')}</button>
                                <button type="button" onClick={() => { setWatermarkText(prev => prev + '[DATE]'); setIsRepeated(false); setRotation(0); setOpacity(1); }} className="text-[10px] bg-slate-200 dark:bg-zinc-800 hover:bg-slate-300 dark:hover:bg-zinc-700 px-2 py-1 rounded-md text-slate-600 dark:text-zinc-400 font-medium transition-colors">{t('preprocess.watermark:ngay')}</button>
                                <button type="button" onClick={() => { setWatermarkText(prev => prev + '[TIME]'); setIsRepeated(false); setRotation(0); setOpacity(1); }} className="text-[10px] bg-slate-200 dark:bg-zinc-800 hover:bg-slate-300 dark:hover:bg-zinc-700 px-2 py-1 rounded-md text-slate-600 dark:text-zinc-400 font-medium transition-colors">{t('preprocess.watermark:gio')}</button>
                                <button type="button" onClick={() => { setWatermarkText(prev => prev + '[BATES]'); setIsRepeated(false); setRotation(0); setOpacity(1); }} className="text-[10px] bg-indigo-100 dark:bg-indigo-900/50 hover:bg-indigo-200 dark:hover:bg-indigo-800 px-2 py-1 rounded-md text-indigo-700 dark:text-indigo-300 font-bold border border-indigo-200 dark:border-indigo-700 transition-colors">{t('preprocess.watermark:ma_bates')}</button>
                            </div>
                            
                            {/* Cấu hình Bates */}
                            {watermarkText.includes('[BATES]') && (
                                <div className="flex items-center gap-4 mt-2 bg-indigo-50/50 dark:bg-indigo-900/10 p-3 rounded-lg border border-indigo-100 dark:border-indigo-800/50 animate-in fade-in duration-300">
                                    <div className="flex-1">
                                        <ToolNumberInput label={t('preprocess.watermark:bates_bat_dau')} value={batesStart} onChange={setBatesStart} />
                                    </div>
                                    <div className="flex-1">
                                        <ToolNumberInput label={t('preprocess.watermark:do_dai_so_padding')} value={batesPadding} onChange={setBatesPadding} />
                                    </div>
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="flex flex-col gap-1">
                            <label className="text-xs font-bold text-slate-700 dark:text-zinc-300 uppercase tracking-wider">{t('preprocess.watermark:tai_len_file_nen_pdf_png_jpg')}</label>
                            <div className="flex items-center gap-2">
                                <input
                                    type="file"
                                    accept=".pdf,.png,.jpg,.jpeg"
                                    onChange={async (e) => {
                                        if (e.target.files && e.target.files.length > 0) {
                                            const file = e.target.files[0];
                                            setWatermarkImageFile(file);
                                            
                                            // Provide preview and get dimensions
                                            if (file.type.startsWith('image/')) {
                                                const url = URL.createObjectURL(file);
                                                setWatermarkImageUrl(url);
                                                const img = new Image();
                                                img.onload = () => { setWmWidth(img.width); setWmHeight(img.height); };
                                                img.src = url;
                                            } else if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
                                                setWatermarkImageUrl(''); // No direct image URL
                                                try {
                                                    const { PDFDocument } = await import('pdf-lib');
                                                    const buf = await file.arrayBuffer();
                                                    const pdfDoc = await PDFDocument.load(buf, { ignoreEncryption: true });
                                                    const page = pdfDoc.getPage(0);
                                                    const { width, height } = page.getSize();
                                                    setWmWidth(width);
                                                    setWmHeight(height);
                                                } catch (err) {
                                                    console.warn('Failed to parse PDF dimensions', err);
                                                    setWmWidth(595); // fallback A4 pt
                                                    setWmHeight(842);
                                                }
                                            }
                                        }
                                    }}
                                    className="w-full text-xs file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-bold file:bg-sky-50 file:text-sky-700 dark:file:bg-sky-900/30 dark:file:text-sky-400 hover:file:bg-sky-100 dark:hover:file:bg-sky-900/50 cursor-pointer text-slate-500"
                                />
                            </div>
                        </div>
                    )}
                </div>

                {/* 2. Z-INDEX & RANGE */}
                <div className="grid grid-cols-2 gap-4 border-t border-slate-200 dark:border-zinc-800 pt-4">
                    <div className="relative z-[60]">
                        <span className="text-[11px] font-medium text-slate-500 block mb-1">{t('preprocess.watermark:lop_hien_thi_z_index')}</span>
                        <RichSelect compact={true} value={layerZIndex} onChange={v => setLayerZIndex(v as 'top'|'bottom')} options={ZINDEX_OPTIONS} />
                    </div>
                    <div className="relative z-[50]">
                        <span className="text-[11px] font-medium text-slate-500 block mb-1">{t('preprocess.watermark:ap_dung_cho_trang')}</span>
                        <RichSelect compact={true} value={targetType} onChange={v => setTargetType(v as any)} options={TARGET_OPTIONS} />
                        
                        {targetType === 'range' && (
                            <div className="flex items-center gap-2 mt-2">
                                <ToolNumberInput label={t('preprocess.watermark:tu')} value={rangeStart} onChange={setRangeStart} className="flex-1" />
                                <ToolNumberInput label={t('preprocess.watermark:den')} value={rangeEnd} onChange={setRangeEnd} className="flex-1" />
                            </div>
                        )}
                    </div>
                </div>

                {/* 3. APPEARANCE */}
                <div className="grid grid-cols-2 gap-4 border-t border-slate-200 dark:border-zinc-800 pt-4">
                    {watermarkType === 'text' ? (
                        <>
                            <div>
                                <span className="text-[11px] font-medium text-slate-500 block mb-1">{t('preprocess.watermark:mau_chu')}</span>
                                <div className="flex items-center justify-between bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md p-1 pl-2.5 h-8">
                                    <span className="text-[12px] font-semibold font-mono text-slate-600 dark:text-zinc-400">{color.toUpperCase()}</span>
                                    <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="w-6 h-6 rounded cursor-pointer border-0 p-0" />
                                </div>
                            </div>
                            <ToolNumberInput label={t('preprocess.watermark:co_chu')} value={fontSize} onChange={setFontSize} suffix="pt" />
                        </>
                    ) : (
                        <>
                            <div className="relative z-[40]">
                                <span className="text-[11px] font-medium text-slate-500 block mb-1">{t('preprocess.watermark:che_do_scale')}</span>
                                <RichSelect compact={true} value={scaleMode} onChange={v => setScaleMode(v as any)} options={SCALE_OPTIONS} />
                            </div>
                            {scaleMode === 'absolute' && (
                                <ToolNumberInput label={t('preprocess.watermark:ty_le_kich_thuoc')} value={imageScale * 100} onChange={v => setImageScale(v / 100)} suffix="%" />
                            )}
                        </>
                    )}

                    <div className="flex flex-col gap-2">
                        <ToolNumberInput label={t('preprocess.watermark:do_mo_opacity')} value={Math.round(opacity * 100)} onChange={v => setOpacity(v / 100)} suffix="%" step={5} />
                    </div>
                    
                    <div className="flex flex-col gap-2">
                        <ToolNumberInput label={t('preprocess.watermark:goc_xoay')} value={rotation} onChange={setRotation} suffix="°" step={1} />
                    </div>
                </div>

                {/* 4. POSITION */}
                <div className="border-t border-slate-200 dark:border-zinc-800 pt-4 flex flex-col gap-4">
                    <ToolCheckboxOption 
                        selected={isRepeated} 
                        onClick={() => setIsRepeated(!isRepeated)} 
                        label={t('preprocess.watermark:lap_kin_trang_canvas_wrap')} 
                        desc={t('preprocess.watermark:lap_lai_noi_dung_phu_kin_toan_bo_be_mat')}
                    />

                    {isRepeated ? (
                        <ToolNumberInput label={t('preprocess.watermark:khoang_cach_giua_cac_mat_luoi')} value={spacing} onChange={setSpacing} suffix="px" step={10} />
                    ) : (
                        <div className="bg-slate-50 dark:bg-zinc-800/30 p-4 rounded-xl border border-slate-200 dark:border-zinc-700 flex flex-col gap-4">
                            <div className="grid grid-cols-2 gap-4">
                                <div className="relative z-[30]">
                                    <span className="text-[11px] font-medium text-slate-500 block mb-1">{t('preprocess.watermark:goc_toa_do_doc')}</span>
                                    <RichSelect compact={true} value={positionYMode} onChange={v => setPositionYMode(v as any)} options={POS_Y_OPTIONS} />
                                </div>
                                <div>
                                    <ToolNumberInput label={t('preprocess.watermark:dich_chuyen_doc')} value={offsetY} onChange={setOffsetY} suffix="mm" />
                                </div>
                            </div>
                            <div className="grid grid-cols-2 gap-4 border-t border-slate-200 dark:border-zinc-700 pt-4">
                                <div className="relative z-[20]">
                                    <span className="text-[11px] font-medium text-slate-500 block mb-1">{t('preprocess.watermark:goc_toa_do_ngang')}</span>
                                    <RichSelect compact={true} value={positionXMode} onChange={v => setPositionXMode(v as any)} options={POS_X_OPTIONS} />
                                </div>
                                <div>
                                    <ToolNumberInput label={t('preprocess.watermark:dich_chuyen_ngang')} value={offsetX} onChange={setOffsetX} suffix="mm" />
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* CSS Preview Box removed per user request */}

            {!isSuccess ? (
                <button
                    onClick={handleRun}
                    disabled={isProcessing || !pdfFile || (watermarkType === 'text' && watermarkText.trim() === '') || (watermarkType === 'image' && !watermarkImageFile)}
                    className={`w-full h-12 rounded-xl text-[14px] font-bold transition-all mt-2 flex items-center justify-center gap-2 ${
                        isProcessing || !pdfFile || (watermarkType === 'text' && watermarkText.trim() === '') || (watermarkType === 'image' && !watermarkImageFile)
                            ? 'bg-slate-300 dark:bg-zinc-700 text-slate-500 cursor-not-allowed'
                            : 'bg-sky-600 hover:bg-sky-700 text-white shadow-md'
                    }`}
                >
                    {isProcessing ? t('preprocess.watermark:dang_xu_ly') : t('preprocess.watermark:ap_dung_thay_doi')}
                </button>
            ) : (
                <div className="mt-4 bg-white dark:bg-zinc-800 p-4 rounded-xl shadow-sm border border-emerald-200 dark:border-emerald-800/50 animate-in fade-in slide-in-from-bottom-2 duration-300">
                    <div className="flex items-center gap-2">
                        <div className="w-8 h-8 bg-emerald-100 dark:bg-emerald-900/50 rounded-full flex items-center justify-center shrink-0">
                            <span className="text-sm">✅</span>
                        </div>
                        <div className="flex flex-col">
                            <h3 className="text-[13px] font-bold text-emerald-700 dark:text-emerald-400">{t('preprocess.watermark:chen_thanh_cong')}</h3>
                            <p className="text-[10px] text-slate-500 leading-tight">{t('preprocess.watermark:file_pdf_da_duoc_xu_ly_hoan_tat')}</p>
                        </div>
                    </div>
                    <button onClick={() => setIsSuccess(false)} className="mt-4 w-full text-xs font-bold text-slate-400 hover:text-slate-600 dark:hover:text-zinc-300 py-1 transition-colors">
                        {t('preprocess.watermark:xu_ly_mot_file_khac')}
                    </button>
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
