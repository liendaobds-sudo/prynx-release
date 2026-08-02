/**
 * SheetViewerDialog.tsx — "Xem Tay In" (Printer's Sheet View)
 *
 * Shows physical sheets exactly as they will be printed.
 * Simple toggle for front/back, side arrows for navigation, compact bottom bar.
 */
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, RotateCw, Layers, Grid3X3 } from 'lucide-react';
import { generateBindingMap, type VirtualSheet, type PageSlot } from '../../lib/imposerEngine/VirtualMap';
import { SPREAD_FOLD_REGISTRY, getExactPatternForPageCount, getSpreadPatternById } from '../../lib/imposerEngine/FoldPatterns';
import { computeSpreadGrid } from '../../lib/imposerEngine/InstructionSerializer';
import { useTranslation } from 'react-i18next';
import { tv } from '../../i18n';
import { buildTileUrl } from './tileUrl';

const MM_TO_PT = 2.83465;

const SIG_COLORS = [
    { bg: 'rgba(99,102,241,0.12)', border: 'rgba(99,102,241,0.4)', text: '#6366f1' },
    { bg: 'rgba(16,185,129,0.12)', border: 'rgba(16,185,129,0.4)', text: '#10b981' },
    { bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.4)', text: '#f59e0b' },
    { bg: 'rgba(239,68,68,0.12)',  border: 'rgba(239,68,68,0.4)',  text: '#ef4444' },
    { bg: 'rgba(139,92,246,0.12)', border: 'rgba(139,92,246,0.4)', text: '#8b5cf6' },
    { bg: 'rgba(6,182,212,0.12)',  border: 'rgba(6,182,212,0.4)',  text: '#06b6d4' },
];

const BINDING_LABELS: Record<string, string> = {
    saddle: 'Bấm Ghim', thread: 'Khâu Chỉ', cut_stacks: 'Bóc Tép', continuous: 'Liên Tục',
    flush_mount: 'Dán Đôi Lưng',
};

interface SheetViewerDialogProps {
    isOpen: boolean;
    onClose: () => void;
    pdfFile?: any;
    pageOrder: number[];
    pageRotations?: number[];
    bindingMode: 'continuous' | 'saddle' | 'thread' | 'cut_stacks' | 'flush_mount';
    foliosize: number;
    sheetWidth?: number;
    sheetHeight?: number;
    scaleMode?: string;
    foldPattern?: string;
    catalogJobs?: import('../../lib/imposerEngine/CatalogPlanner').PlateJob[];
    /** true khi chế độ In Nhanh (digital) — ẩn sơ đồ kẽm */
    isDigital?: boolean;
    gripperMargin?: number;
    /** Kích thước 1 trang nguồn (điểm/pt) — để preview digital tính đúng lưới step&repeat. */
    pageWpt?: number;
    pageHpt?: number;
    /** Thông số layout (mm) — dùng chung computeSpreadGrid với output thật. */
    bleed?: number;
    gapX?: number;
    gapY?: number;
    marginLeft?: number;
    marginRight?: number;
    marginTop?: number;
    blankPlacement?: 'end' | 'center';
    separateCover?: boolean;
    coverPageCount?: number;
}

// ─── Single page image ───
const PageSlotView: React.FC<{
    slot: PageSlot; pageOrder: number[]; pageRotations?: number[]; pdfFile?: any;
    pageWpt?: number; pageHpt?: number; bleed?: number;
}> = ({ slot, pageOrder, pageRotations = [], pdfFile, pageWpt, pageHpt, bleed }) => {
  const { t } = useTranslation();
    const [loaded, setLoaded] = useState(false);
    const isBlank = slot.srcIndex === null || slot.srcIndex >= pageOrder.length;
    const pdfPageNum = !isBlank ? pageOrder[slot.srcIndex!] : -1;
    const isBlankPage = isBlank || pdfPageNum === -1;
    const userRotation = !isBlank ? (pageRotations[slot.srcIndex!] || 0) : 0;
    const totalPages = pageOrder.length;

    let coverLabel = '';
    if (!isBlankPage && totalPages >= 4) {
        if (slot.logicalIndex === 1) coverLabel = t('misc.sheetViewerDialog:bia_truoc');
        else if (slot.logicalIndex === 2) coverLabel = t('misc.sheetViewerDialog:trong_bia_truoc');
        else if (slot.logicalIndex === totalPages - 1) coverLabel = t('misc.sheetViewerDialog:trong_bia_sau');
        else if (slot.logicalIndex === totalPages) coverLabel = t('misc.sheetViewerDialog:bia_sau');
    }

    const imageUrl = useMemo(() => {
        if (isBlankPage || !pdfFile?.path) return '';
        return buildTileUrl({
            path: pdfFile.path, page: pdfPageNum, scale: 1.0, rot: userRotation,
            pageWpt, pageHpt, bleedMm: bleed,
        });
    }, [isBlankPage, pdfPageNum, pdfFile, userRotation, pageWpt, pageHpt, bleed]);

    return (
        <div className="relative flex flex-col items-center justify-center w-full h-full min-w-0 min-h-0">
            {isBlankPage ? (
                <div className="bg-slate-100 dark:bg-zinc-800/80 flex items-center justify-center max-w-full max-h-full transition-colors duration-300" style={{ aspectRatio: '1 / 1.414', height: '600px' }}>
                    <span className="text-slate-400 dark:text-zinc-500 text-xs">{t('misc.sheetViewerDialog:trang_trong')}</span>
                </div>
            ) : imageUrl ? (
                <>
                    {!loaded && (
                        <div className="absolute inset-0 bg-slate-100 flex items-center justify-center z-10">
                            <div className="w-5 h-5 border-2 border-slate-300 border-t-indigo-500 rounded-full animate-spin" />
                        </div>
                    )}
                    <img
                        src={imageUrl} alt={t('misc.sheetViewerDialog:trang_n', { n: slot.logicalIndex })}
                        className={`max-w-full max-h-full object-contain transition-opacity duration-200 ${loaded ? 'opacity-100' : 'opacity-0'}`}
                        onLoad={() => setLoaded(true)} draggable={false}
                    />
                </>
            ) : (
                <div className="bg-slate-100 dark:bg-zinc-800/80 flex items-center justify-center max-w-full max-h-full transition-colors duration-300" style={{ aspectRatio: '1 / 1.414', height: '600px' }}>
                    <span className="text-slate-400 dark:text-zinc-500 text-xs">P.{slot.logicalIndex}</span>
                </div>
            )}
            
            {/* Label - absolute positioned inside the page at the bottom center */}
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 pointer-events-none z-20 flex flex-col items-center gap-1 w-[90%] justify-center">
                {coverLabel && (
                    <span className="bg-red-100/90 dark:bg-red-500/90 text-red-600 dark:text-white text-[9px] font-medium px-2 py-0.5 rounded shadow-sm whitespace-nowrap backdrop-blur-sm max-w-full overflow-hidden text-ellipsis text-center tracking-wide border border-red-200 dark:border-red-400/30">
                        {coverLabel}
                    </span>
                )}
                <span className="bg-white/80 dark:bg-zinc-800/80 text-slate-800 dark:text-white text-[11px] font-medium px-2.5 py-1 rounded shadow-sm whitespace-nowrap backdrop-blur-sm border border-slate-200 dark:border-white/10 max-w-full overflow-hidden text-ellipsis text-center">
                    {isBlankPage ? t('misc.sheetViewerDialog:trong') : t('misc.sheetViewerDialog:trang_n', { n: slot.logicalIndex })}
                </span>
            </div>
        </div>
    );
};

// ─── Main Dialog ───
// ─── Blueprint grid cell ───
// Bìa chỉ áp dụng cho bấm ghim (saddle) — bìa cùng chất liệu
// Khâu chỉ / Bóc tép / Liên tục → bìa in riêng trên giấy khác → tất cả trang đều là ruột
const COVER_STYLES = {
    bia1: { label: 'Bìa Trước', bg: 'rgba(239,68,68,0.15)', border: 'rgba(239,68,68,0.5)', text: '#f87171' },
    bia2: { label: 'Trong Bìa Trước', bg: 'rgba(251,146,60,0.15)', border: 'rgba(251,146,60,0.5)', text: '#fb923c' },
    bia3: { label: 'Trong Bìa Sau', bg: 'rgba(251,146,60,0.15)', border: 'rgba(251,146,60,0.5)', text: '#fb923c' },
    bia4: { label: 'Bìa Sau', bg: 'rgba(239,68,68,0.15)', border: 'rgba(239,68,68,0.5)', text: '#f87171' },
};

const BlueprintCell: React.FC<{
    logicalIndex: number; isBlank: boolean; rotation: number;
    userRotation?: number;
    totalPages: number; bindingMode: string;
    pdfFile?: any; pageNum?: number;
    currentJob?: import('../../lib/imposerEngine/CatalogPlanner').PlateJob;
    width?: number;
    height?: number;
}> = ({ logicalIndex, isBlank, rotation, userRotation = 0, totalPages, bindingMode, pdfFile, pageNum, currentJob, width = 120, height = 160 }) => {
  const { t } = useTranslation();
    const isCoverJob = currentJob ? currentJob.isCover : false;
    const isSameMaterialCover = !currentJob && bindingMode === 'saddle';

    let coverStyle: typeof COVER_STYLES.bia1 | null = null;
    let coverLabel = '';
    if (!isBlank && totalPages >= 4 && (isCoverJob || isSameMaterialCover)) {
        // For cover jobs with rewritten logicalIndex (global page numbers),
        // compare against actual page indices from the job
        if (isCoverJob && currentJob) {
            const coverIndices = currentJob.pageIndices.filter(i => i !== -1);
            const srcIdx = logicalIndex - 1; // convert back to 0-based
            if (coverIndices.length >= 4) {
                if (srcIdx === coverIndices[0]) { coverStyle = COVER_STYLES.bia1; coverLabel = COVER_STYLES.bia1.label; }
                else if (srcIdx === coverIndices[1]) { coverStyle = COVER_STYLES.bia2; coverLabel = COVER_STYLES.bia2.label; }
                else if (srcIdx === coverIndices[2]) { coverStyle = COVER_STYLES.bia3; coverLabel = COVER_STYLES.bia3.label; }
                else if (srcIdx === coverIndices[3]) { coverStyle = COVER_STYLES.bia4; coverLabel = COVER_STYLES.bia4.label; }
            }
        } else {
            // Same-material cover: use standard 1-based position check
            if (logicalIndex === 1) { coverStyle = COVER_STYLES.bia1; coverLabel = COVER_STYLES.bia1.label; }
            else if (logicalIndex === 2) { coverStyle = COVER_STYLES.bia2; coverLabel = COVER_STYLES.bia2.label; }
            else if (logicalIndex === totalPages - 1) { coverStyle = COVER_STYLES.bia3; coverLabel = COVER_STYLES.bia3.label; }
            else if (logicalIndex === totalPages) { coverStyle = COVER_STYLES.bia4; coverLabel = COVER_STYLES.bia4.label; }
        }
    }

    const bgClass = isBlank ? 'bg-slate-200/50 dark:bg-zinc-800/50' : coverStyle ? '' : 'bg-slate-100/40 dark:bg-zinc-700/40';
    const borderClass = coverStyle ? '' : 'border-slate-300/80 dark:border-zinc-600/50';

    const imageUrl = useMemo(() => {
        if (isBlank || !pdfFile?.path || !pageNum || pageNum === -1) return '';
        return buildTileUrl({ path: pdfFile.path, page: pageNum, scale: 1.0, rot: userRotation });
    }, [isBlank, pageNum, pdfFile, userRotation]);

    return (
        <div className={`relative flex items-center justify-center overflow-hidden shrink-0 transition-all duration-300 border ${bgClass} ${borderClass}`} style={{ width: `${width}px`, height: `${height}px`, transform: rotation === 180 ? 'rotate(180deg)' : undefined, background: coverStyle ? coverStyle.bg : undefined, borderColor: coverStyle ? coverStyle.border : undefined }}>
            {imageUrl && (
                <img src={imageUrl} className="absolute inset-0 w-full h-full object-contain opacity-40 dark:opacity-30 mix-blend-multiply dark:mix-blend-overlay pointer-events-none" alt="" />
            )}
            {isBlank ? <span className="text-slate-400 dark:text-zinc-600 text-sm">—</span> : (
                <div className="flex flex-col items-center gap-1">
                    <span className="text-slate-800 dark:text-white font-bold text-2xl">{logicalIndex}</span>
                    {coverLabel ? (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded shadow-sm" style={{ color: coverStyle!.text, background: coverStyle!.bg, border: `1px solid ${coverStyle!.border}` }}>{tv(coverLabel)}</span>
                    ) : (isSameMaterialCover || currentJob) ? (
                        <span className="text-slate-500 dark:text-zinc-400 text-[10px]">{t('misc.sheetViewerDialog:ruot')}</span>
                    ) : null}
                    {rotation === 180 && <span className="text-slate-400 dark:text-zinc-500 text-[10px]">↻180°</span>}
                </div>
            )}
        </div>
    );
};

// ─── Blueprint grid showing full plate layout ───
const BlueprintGrid: React.FC<{
    pattern: import('../../lib/imposerEngine/FoldPatterns').SpreadFoldPattern;
    sheets: VirtualSheet[];
    currentSheetIdx: number;
    pageOrder: number[];
    pageRotations?: number[];
    bindingMode: string;
    pdfFile?: any;
    currentJob?: import('../../lib/imposerEngine/CatalogPlanner').PlateJob;
    gripperMargin?: number;
}> = ({ pattern, sheets, currentSheetIdx, pageOrder, pageRotations = [], bindingMode, pdfFile, currentJob, gripperMargin }) => {
  const { t } = useTranslation();
    const hasBack = pattern.backPlate.length > 0;
    // When catalog jobs are active, logicalIndex has been rewritten to global page numbers
    // So totalPages should be global (pageOrder.length) not job.actualPageCount
    const actualTotalPages = pageOrder.length;

    const spreads = useMemo(() => {
        const result: { left: PageSlot; right: PageSlot }[] = [];
        for (const sheet of sheets) {
            result.push({ left: sheet.front.left, right: sheet.front.right });
            result.push({ left: sheet.back.left, right: sheet.back.right });
        }
        return result;
    }, [sheets]);

    const cs = sheets[currentSheetIdx];
    const sigSheets = sheets.filter(s => (s.signatureIndex ?? 1) === (cs.signatureIndex ?? 1));
    const sigSpreadOffset = (sigSheets[0]?.sheetIndex ?? 0) * 2;

    const maxCols = Math.max(0, ...pattern.frontPlate.map(s => s.col)) + 1;
    const pagesPerRow = maxCols * 2;
    const numPlates = hasBack ? 2 : 1;
    const totalPagesAcross = pagesPerRow * numPlates;
    const rows = pattern.rows;

    let cellWidth = 120;
    let cellHeight = 160;

    if (totalPagesAcross <= 4 && rows <= 2) {
        cellWidth = 200;
        cellHeight = 266;
    } else if (totalPagesAcross <= 8 && rows <= 2) {
        cellWidth = 150;
        cellHeight = 200;
    } else if (totalPagesAcross > 12 || rows >= 4) {
        cellWidth = 90;
        cellHeight = 120;
    }

    const renderPlate = (slots: import('../../lib/imposerEngine/FoldPatterns').SpreadSlot[], label: string, colorClass: string, bgClass: string) => (
        <div className="flex flex-col items-center gap-2">
            <div className={`inline-flex items-center justify-center h-7 text-[11px] font-bold tracking-wider uppercase px-5 rounded-md ${bgClass} ${colorClass}`}>{label}</div>
            <div className="bg-white/50 dark:bg-zinc-800/50 border border-slate-300 dark:border-zinc-700/50 rounded-lg p-4 shadow-lg backdrop-blur-sm transition-colors duration-300">
                <div className="flex flex-col gap-1">
                    {Array.from({ length: pattern.rows }, (_, row) => (
                        <div key={row} className="flex gap-1">
                            {slots.filter(s => s.row === row).sort((a, b) => a.col - b.col).map((slot, i) => {
                                const spreadIdx = sigSpreadOffset + slot.spreadIndex;
                                const spread = spreadIdx < spreads.length ? spreads[spreadIdx] : null;
                                const leftBlank = !spread || spread.left.srcIndex === null || spread.left.srcIndex === -1 || spread.left.srcIndex >= pageOrder.length;
                                const rightBlank = !spread || spread.right.srcIndex === null || spread.right.srcIndex === -1 || spread.right.srcIndex >= pageOrder.length;
                                const leftPageNum = !leftBlank && spread?.left.srcIndex !== null ? pageOrder[spread.left.srcIndex!] : -1;
                                const rightPageNum = !rightBlank && spread?.right.srcIndex !== null ? pageOrder[spread.right.srcIndex!] : -1;
                                const leftRotation = !leftBlank && spread?.left.srcIndex !== null ? (pageRotations[spread.left.srcIndex!] || 0) : 0;
                                const rightRotation = !rightBlank && spread?.right.srcIndex !== null ? (pageRotations[spread.right.srcIndex!] || 0) : 0;
                                return (
                                    <div key={i} className="flex border-2 border-dashed border-slate-300 dark:border-zinc-500 p-[2px] rounded transition-colors duration-300" style={{ transform: slot.rotation === 180 ? 'rotate(180deg)' : undefined }}>
                                        <BlueprintCell logicalIndex={spread?.left.logicalIndex ?? 0} isBlank={leftBlank} rotation={0} userRotation={leftRotation} totalPages={actualTotalPages} bindingMode={bindingMode} pdfFile={pdfFile} pageNum={leftPageNum} currentJob={currentJob} width={cellWidth} height={cellHeight} />
                                        <div className="w-[3px] bg-red-500/80 shrink-0 relative z-10 mx-[2px]" />
                                        <BlueprintCell logicalIndex={spread?.right.logicalIndex ?? 0} isBlank={rightBlank} rotation={0} userRotation={rightRotation} totalPages={actualTotalPages} bindingMode={bindingMode} pdfFile={pdfFile} pageNum={rightPageNum} currentJob={currentJob} width={cellWidth} height={cellHeight} />
                                    </div>
                                );
                            })}
                        </div>
                    ))}
                </div>
            </div>
            {(gripperMargin && gripperMargin > 0) ? (
                <div className="w-full h-3 mt-1 bg-red-100/80 dark:bg-red-500/20 border-t border-red-300 dark:border-red-500/50 flex items-center justify-center rounded-b-md relative shrink-0 overflow-visible z-10 shadow-sm" title={t('misc.sheetViewerDialog:nhip_in_mm', { n: gripperMargin })}>
                    <span className="text-[9px] font-bold text-red-500/90 dark:text-red-400 whitespace-nowrap px-1 bg-white/60 dark:bg-zinc-800/60 rounded">
                        {t('misc.sheetViewerDialog:can_nhip_mm', { n: gripperMargin })}
                    </span>
                </div>
            ) : null}
        </div>
    );

    return (
        <div className="flex flex-col items-center gap-3">
            <div className="flex items-center gap-8">
                {renderPlate(pattern.frontPlate, hasBack ? t('misc.sheetViewerDialog:mat_a_truoc') : t('misc.sheetViewerDialog:tu_tro_1_kem'), 'text-sky-500 dark:text-sky-400', 'bg-sky-100 dark:bg-sky-500/20')}
                {hasBack && renderPlate(pattern.backPlate, t('misc.sheetViewerDialog:mat_b_sau'), 'text-amber-500 dark:text-amber-400', 'bg-amber-100 dark:bg-amber-500/20')}
            </div>
            <div className="flex items-center justify-center gap-6 text-sm font-medium text-slate-300 mt-2">
                <span className="flex items-center gap-2"><span className="inline-block w-5 h-[2px] bg-red-500/80 rounded" /> {t('misc.sheetViewerDialog:gay_gap')}</span>
                <span className="flex items-center gap-2"><span className="inline-block w-5 border-t-2 border-dashed border-slate-400" /> {t('misc.sheetViewerDialog:duong_cat')}</span>
                {(bindingMode === 'saddle' && (!currentJob || currentJob.isCover)) && (
                    <>
                        <span className="text-slate-500 font-normal">|</span>
                        <span className="flex items-center gap-2">
                            <span className="inline-block w-4 h-4 rounded-sm" style={{ background: 'rgba(239,68,68,0.2)', border: '1px solid rgba(239,68,68,0.6)' }} />
                            {currentJob ? t('misc.sheetViewerDialog:bia_chat_lieu_rieng') : t('misc.sheetViewerDialog:bia_cung_chat_lieu')}
                        </span>
                    </>
                )}
            </div>
        </div>
    );
};

// ─── Digital Press Sheet Simulation Grid (SSOT: dùng computeSpreadGrid như output) ───
const DigitalPressSheetGrid: React.FC<{
    sheets: VirtualSheet[];
    currentSheetIdx: number;
    pageOrder: number[];
    pageRotations?: number[];
    pdfFile?: any;
    scaleMode: string;
    pageWpt: number;
    pageHpt: number;
    sheetWmm: number;
    sheetHmm: number;
    bleed: number;
    gapX: number;
    gapY: number;
    marginLeft: number;
    marginRight: number;
    marginTop: number;
    gripperMargin: number;
    singleSided?: boolean;
}> = ({ sheets, currentSheetIdx, pageOrder, pageRotations = [], pdfFile, scaleMode, pageWpt, pageHpt, sheetWmm, sheetHmm, bleed, gapX, gapY, marginLeft, marginRight, marginTop, gripperMargin, singleSided = false }) => {
  const { t } = useTranslation();
    const cs = sheets[currentSheetIdx];

    // Đo vùng chứa thật để fit-contain 2 plate (tránh khổ landscape tràn giao diện).
    const areaRef = useRef<HTMLDivElement>(null);
    const [area, setArea] = useState({ w: 0, h: 0 });
    useEffect(() => {
        const el = areaRef.current;
        if (!el) return;
        const ro = new ResizeObserver(() => setArea({ w: el.clientWidth, h: el.clientHeight }));
        ro.observe(el);
        setArea({ w: el.clientWidth, h: el.clientHeight });
        return () => ro.disconnect();
    }, []);

    const bleedPt = (bleed || 0) * MM_TO_PT;
    // Spread khớp phase-1 (auto_100, clustered kéo sát gáy → trừ 2×bleed).
    const spreadWpt = Math.max(1, pageWpt * 2 - 2 * bleedPt);
    const spreadHpt = Math.max(1, pageHpt);

    const { frameW, frameH, cols, rows, cellPos } = useMemo(() => computeSpreadGrid(
        spreadWpt, spreadHpt,
        (sheetWmm || 0) * MM_TO_PT, (sheetHmm || 0) * MM_TO_PT,
        (gapX || 0) * MM_TO_PT, (gapY || 0) * MM_TO_PT,
        (marginLeft || 0) * MM_TO_PT, (marginRight || 0) * MM_TO_PT,
        (marginTop || 0) * MM_TO_PT, (gripperMargin || 0) * MM_TO_PT,
    ), [spreadWpt, spreadHpt, sheetWmm, sheetHmm, gapX, gapY, marginLeft, marginRight, marginTop, gripperMargin]);

    // Spread nội dung cho ô thứ i của 1 mặt. Step&Repeat: mọi ô = spread hiện tại.
    // Cut&Stack: các ô là những tờ booklet KHÁC nhau (mô phỏng — lấp lưới tuần tự).
    const spreadForCell = (cellIndex: number): VirtualSheet | null => {
        if (scaleMode !== 'cut_stack') return cs;
        const idx = (currentSheetIdx + cellIndex) % Math.max(1, sheets.length);
        return sheets[idx] ?? null;
    };

    const renderCell = (cellIndex: number, isBack: boolean) => {
        const spread = spreadForCell(cellIndex);
        if (!spread) return null;
        const side = isBack ? spread.back : spread.front;
        return (
            <div className="flex w-full h-full border border-slate-200 dark:border-zinc-600 bg-white dark:bg-zinc-800 overflow-hidden">
                <div className="flex-1 min-w-0 h-full flex items-center justify-center p-1">
                    <PageSlotView slot={side.left} pageOrder={pageOrder} pageRotations={pageRotations} pdfFile={pdfFile} />
                </div>
                <div className="shrink-0 w-px bg-red-400/70 z-10" />
                <div className="flex-1 min-w-0 h-full flex items-center justify-center p-1">
                    <PageSlotView slot={side.right} pageOrder={pageOrder} pageRotations={pageRotations} pdfFile={pdfFile} />
                </div>
            </div>
        );
    };

    // Fit-contain: mỗi plate chiếm nửa vùng (trừ padding p-4=32, gap-8=32), cao trừ nhãn (~44).
    const availW = Math.max(1, (area.w - (singleSided ? 32 : 64)) / (singleSided ? 1 : 2));
    const availH = Math.max(1, area.h - 44);
    const fitScale = Math.min(availW / frameW, availH / frameH);
    const boxW = frameW * fitScale;
    const boxH = frameH * fitScale;

    const renderPlate = (label: string, isBack: boolean, colorClass: string, bgClass: string) => (
        <div className="flex flex-col items-center gap-3 min-h-0 min-w-0">
            <div className={`shrink-0 inline-flex items-center justify-center h-7 text-[11px] font-bold tracking-wider uppercase px-5 rounded-md ${bgClass} ${colorClass}`}>
                {label}
            </div>
            <div className="relative bg-slate-100 dark:bg-zinc-900 rounded-lg border border-slate-300 dark:border-zinc-700 shadow-lg" style={{ width: `${boxW}px`, height: `${boxH}px` }}>
                {Array.from({ length: rows }).map((_, r) =>
                    Array.from({ length: cols }).map((_, c) => {
                        const pos = cellPos(c, r);
                        const cellIndex = r * cols + c;
                        return (
                            <div key={`${c}-${r}`} className="absolute" style={{
                                left: `${(pos.x / frameW) * 100}%`,
                                top: `${((frameH - pos.y - spreadHpt) / frameH) * 100}%`,
                                width: `${(spreadWpt / frameW) * 100}%`,
                                height: `${(spreadHpt / frameH) * 100}%`,
                            }}>
                                {renderCell(cellIndex, isBack)}
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );

    return (
        <div ref={areaRef} className="flex-1 flex items-center justify-center gap-8 p-4 min-h-0 min-w-0 w-full">
            {renderPlate(t('misc.sheetViewerDialog:mat_truoc'), false, 'text-sky-500 dark:text-sky-400', 'bg-sky-100 dark:bg-sky-500/20')}
            {!singleSided && renderPlate(t('misc.sheetViewerDialog:mat_sau'), true, 'text-amber-500 dark:text-amber-400', 'bg-amber-100 dark:bg-amber-500/20')}
        </div>
    );
};

export const SheetViewerDialog: React.FC<SheetViewerDialogProps> = ({
    isOpen, onClose, pdfFile, pageOrder, pageRotations = [], bindingMode, foliosize, sheetWidth, sheetHeight, scaleMode = '100', foldPattern = '', catalogJobs, isDigital = false, gripperMargin = 0,
    pageWpt = 0, pageHpt = 0, bleed = 0, gapX = 0, gapY = 0, marginLeft = 0, marginRight = 0, marginTop = 0,
    blankPlacement = 'end', separateCover = false, coverPageCount = 4,
}) => {
  const { t } = useTranslation();
    const [currentSheetIdx, setCurrentSheetIdx] = useState(0);
    const [showBack, setShowBack] = useState(false);
    const [blueprintMode, setBlueprintMode] = useState(false);

    const imposedPageOrder = useMemo(() => {
        if (catalogJobs?.length || !separateCover || pageOrder.length < coverPageCount + 4) return pageOrder;
        const half = Math.floor(coverPageCount / 2);
        return pageOrder.slice(half, pageOrder.length - half);
    }, [catalogJobs, separateCover, coverPageCount, pageOrder]);

    const imposedPageRotations = useMemo(() => {
        if (catalogJobs?.length || !separateCover || pageOrder.length < coverPageCount + 4) return pageRotations;
        const half = Math.floor(coverPageCount / 2);
        return pageRotations.slice(half, pageOrder.length - half);
    }, [catalogJobs, separateCover, coverPageCount, pageOrder.length, pageRotations]);

    const { sheets, report, jobMap } = useMemo(() => {
        if (catalogJobs && catalogJobs.length > 0) {
            const allSheets: VirtualSheet[] = [];
            const jMap = new Map<VirtualSheet, import('../../lib/imposerEngine/CatalogPlanner').PlateJob>();
            for (const job of catalogJobs) {
                const { sheets: jobSheets } = generateBindingMap(job.pageIndices.length, job.bindingMode, job.actualPageCount);
                for (const s of jobSheets) {
                    const rewrite = (slot: PageSlot) => {
                        if (slot.srcIndex !== null && slot.srcIndex < job.pageIndices.length) {
                            const actualIdx = job.pageIndices[slot.srcIndex];
                            slot.srcIndex = actualIdx;
                            if (actualIdx !== -1) {
                                slot.logicalIndex = actualIdx + 1;
                            }
                        }
                    };
                    rewrite(s.front.left); rewrite(s.front.right);
                    rewrite(s.back.left); rewrite(s.back.right);
                    
                    // NOTE: must re-assign sheetIndex to be absolute across ALL jobs
                    s.sheetIndex = allSheets.length;
                    s.signatureIndex = job.sortOrder;
                    allSheets.push(s);
                    jMap.set(s, job);
                }
            }
            return { sheets: allSheets, report: t('misc.sheetViewerDialog:dua_tren_cau_hinh_auto_catalog'), jobMap: jMap };
        } else {
            if (!imposedPageOrder.length) return { sheets: [] as VirtualSheet[], report: '', jobMap: null };
            return { ...generateBindingMap(imposedPageOrder.length, bindingMode, foliosize, blankPlacement, scaleMode || '100'), jobMap: null };
        }
    }, [catalogJobs, imposedPageOrder, bindingMode, foliosize, blankPlacement, scaleMode]);

    const cs = sheets[currentSheetIdx];
    const currentJob = jobMap?.get(cs);

    // Preview chỉ hiển thị blueprint khi pattern khớp tuyệt đối tay hiện tại.
    const patternCandidate = currentJob
        ? (getSpreadPatternById(currentJob.foldPatternId) || getExactPatternForPageCount(currentJob.actualPageCount))
        : ((scaleMode === 'chain_nup' && foldPattern && foldPattern !== '' && foldPattern !== 'auto')
            ? (SPREAD_FOLD_REGISTRY.find(p => p.id === foldPattern) || null)
            : null);
    const currentSignature = cs?.signatureIndex ?? 1;
    const currentSignatureSurfaces = sheets.filter(s => (s.signatureIndex ?? 1) === currentSignature).length * 2;
    const activeFoldPattern = patternCandidate && patternCandidate.spreadsPerSig === currentSignatureSurfaces
        ? patternCandidate
        : null;

    const signatureGroups = useMemo(() => {
        const groups: { sigIndex: number; sheets: VirtualSheet[]; color: typeof SIG_COLORS[0] }[] = [];
        let cur = -1;
        for (const sheet of sheets) {
            const sig = sheet.signatureIndex ?? 1;
            if (sig !== cur) { cur = sig; groups.push({ sigIndex: sig, sheets: [], color: SIG_COLORS[Math.max(0, sig > 0 ? sig - 1 : 0) % SIG_COLORS.length] }); }
            groups[groups.length - 1].sheets.push(sheet);
        }
        return groups;
    }, [sheets]);

    useEffect(() => { if (isOpen) { setCurrentSheetIdx(0); setBlueprintMode(false); } }, [isOpen, bindingMode, foliosize]);

    const goToSheet = useCallback((idx: number) => { setCurrentSheetIdx(idx); }, []);

    useEffect(() => {
        if (!isOpen) return;
        const h = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
            
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onClose();
                return;
            }

            // Prevent background scrolling for space and arrows when modal is open
            if (e.key === ' ' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                e.stopPropagation();
                return;
            }

            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                e.stopPropagation();
                if (blueprintMode) {
                    const sig = cs?.signatureIndex ?? 1;
                    const curGroupIdx = signatureGroups.findIndex(g => g.sigIndex === sig);
                    if (curGroupIdx > 0) goToSheet(sheets.indexOf(signatureGroups[curGroupIdx - 1].sheets[0]));
                } else {
                    if (currentSheetIdx > 0) goToSheet(currentSheetIdx - 1);
                }
            }
            
            if (e.key === 'ArrowRight') {
                e.preventDefault();
                e.stopPropagation();
                if (blueprintMode) {
                    const sig = cs?.signatureIndex ?? 1;
                    const curGroupIdx = signatureGroups.findIndex(g => g.sigIndex === sig);
                    if (curGroupIdx >= 0 && curGroupIdx < signatureGroups.length - 1) goToSheet(sheets.indexOf(signatureGroups[curGroupIdx + 1].sheets[0]));
                } else {
                    if (currentSheetIdx < sheets.length - 1) goToSheet(currentSheetIdx + 1);
                }
            }
        };
        // Use capture phase to ensure we intercept before AcrobatViewer
        window.addEventListener('keydown', h, true);
        return () => window.removeEventListener('keydown', h, true);
    }, [isOpen, onClose, currentSheetIdx, sheets, blueprintMode, signatureGroups, cs, goToSheet]);

    if (!isOpen || sheets.length === 0 || !cs) return null;

    const sig = cs.signatureIndex ?? 1;
    const sc = SIG_COLORS[Math.max(0, sig > 0 ? sig - 1 : 0) % SIG_COLORS.length];
    const cg = signatureGroups.find(g => g.sigIndex === sig);
    const activeSide = showBack ? cs.back : cs.front;

    return createPortal(
        <div className="fixed inset-0 z-[9999] bg-slate-50/95 dark:bg-zinc-900/95 backdrop-blur-md select-none transition-colors duration-300">
            {/* ── TOP BAR ── */}
            <div className="absolute top-0 left-0 right-0 h-14 px-6 flex items-center justify-between border-b border-slate-200 dark:border-white/10 bg-white/80 dark:bg-zinc-800/80 shadow-sm backdrop-blur-md transition-colors duration-300">
                <div className="flex items-center gap-3">
                    <Layers className="w-5 h-5 text-indigo-500 dark:text-indigo-400" />
                    <span className="text-slate-900 dark:text-white text-[15px] font-bold tracking-wide whitespace-nowrap">{t('misc.sheetViewerDialog:xem_bai_in')}</span>
                    <span className="text-slate-500 dark:text-zinc-300 text-[13px] font-medium whitespace-nowrap">• {tv(BINDING_LABELS[bindingMode])}</span>
                </div>
                <div className="flex items-center gap-3">
                    {activeFoldPattern && bindingMode !== 'continuous' && !isDigital && (
                        <button
                            onClick={() => setBlueprintMode(b => !b)}
                            className={`flex items-center justify-center gap-2 text-[13px] font-bold transition-all px-4 py-2 rounded-md whitespace-nowrap flex-shrink-0 ${blueprintMode ? 'bg-indigo-500 text-white shadow-md' : 'text-slate-600 dark:text-zinc-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-zinc-700 bg-slate-100 dark:bg-zinc-700/50'}`}
                        >
                            <Grid3X3 className="w-4 h-4" />
                            {blueprintMode ? t('misc.sheetViewerDialog:so_do_kem') : t('misc.sheetViewerDialog:so_do_kem')}
                        </button>
                    )}
                    <button onClick={onClose} className="text-slate-600 dark:text-zinc-300 hover:text-slate-900 dark:hover:text-white text-[13px] font-bold transition-colors px-4 py-2 rounded-md hover:bg-slate-200 dark:hover:bg-zinc-700 bg-slate-100 dark:bg-zinc-700/30 whitespace-nowrap flex-shrink-0">
                        {t('misc.sheetViewerDialog:dong_esc')}
                    </button>
                </div>
            </div>

            {/* ── MAIN AREA ── */}
            <div className="absolute top-14 bottom-16 left-0 right-0 flex items-center justify-center px-16 py-4">
                {/* Left arrow */}
                <button
                    onClick={() => {
                        if (blueprintMode) {
                            const curGroupIdx = signatureGroups.findIndex(g => g.sigIndex === sig);
                            if (curGroupIdx > 0) goToSheet(sheets.indexOf(signatureGroups[curGroupIdx - 1].sheets[0]));
                        } else {
                            if (currentSheetIdx > 0) goToSheet(currentSheetIdx - 1);
                        }
                    }}
                    disabled={blueprintMode ? signatureGroups.findIndex(g => g.sigIndex === sig) === 0 : currentSheetIdx === 0}
                    className="absolute left-4 top-1/2 -translate-y-1/2 w-10 h-10 flex items-center justify-center rounded-full bg-white/80 dark:bg-zinc-800/80 text-slate-700 dark:text-white hover:bg-white dark:hover:bg-zinc-700 hover:scale-110 transition-all disabled:opacity-30 disabled:cursor-not-allowed z-10 shadow-md dark:shadow-lg backdrop-blur-sm"
                >
                    <ChevronLeft className="w-6 h-6" />
                </button>

                {/* Sheet container */}
                <div className="flex flex-col w-full h-full max-w-6xl">
                    {/* Sheet header */}
                    <div className="shrink-0 flex items-center justify-between px-5 py-3">
                        <div className="flex items-center gap-3">
                            <span className="text-slate-800 dark:text-white text-sm font-bold">
                                {t('misc.sheetViewerDialog:to_x_y', { x: currentSheetIdx + 1, y: sheets.length })}
                            </span>
                            {bindingMode === 'thread' && cg && (
                                <>
                                    <span className="text-slate-400 dark:text-zinc-600 text-sm">•</span>
                                    <span className="text-sm font-medium" style={{ color: sc.text }}>
                                        {t('misc.sheetViewerDialog:tep_sig_to_x_y', { sig, x: cg.sheets.indexOf(cs) + 1, y: cg.sheets.length })}
                                    </span>
                                </>
                            )}
                        </div>
                    </div>

                    {blueprintMode && activeFoldPattern ? (
                        /* ── BLUEPRINT GRID VIEW ── */
                        <div className="flex-1 flex items-center justify-center p-4 min-h-0 min-w-0">
                            <BlueprintGrid pattern={activeFoldPattern} sheets={sheets} currentSheetIdx={currentSheetIdx} pageOrder={imposedPageOrder} pageRotations={imposedPageRotations} bindingMode={bindingMode} pdfFile={pdfFile} currentJob={currentJob} gripperMargin={gripperMargin} />
                        </div>
                    ) : (isDigital && (scaleMode === 'chain_nup' || scaleMode === 'cut_stack')) ? (
                        /* ── DIGITAL PRESS SHEET SIMULATION VIEW ── */
                        <div className="flex-1 flex flex-col items-center justify-center min-h-0 min-w-0">
                            <DigitalPressSheetGrid
                                sheets={sheets}
                                currentSheetIdx={currentSheetIdx}
                                pageOrder={imposedPageOrder}
                                pageRotations={imposedPageRotations}
                                pdfFile={pdfFile}
                                scaleMode={scaleMode}
                                pageWpt={pageWpt}
                                pageHpt={pageHpt}
                                sheetWmm={sheetWidth || 0}
                                sheetHmm={sheetHeight || 0}
                                bleed={bleed}
                                gapX={gapX}
                                gapY={gapY}
                                marginLeft={marginLeft}
                                marginRight={marginRight}
                                marginTop={marginTop}
                                gripperMargin={gripperMargin}
                                singleSided={bindingMode === 'flush_mount'}
                            />
                            {/* Message about digital imposition */}
                            <div className="shrink-0 mt-2 bg-white/90 dark:bg-zinc-800/95 text-slate-800 dark:text-white px-6 py-3.5 rounded-xl text-sm font-medium shadow-xl dark:shadow-2xl flex items-center gap-3 border border-indigo-200 dark:border-indigo-500/30 max-w-2xl w-max text-center leading-relaxed backdrop-blur-sm z-50 relative">
                                <span className="flex items-center justify-center w-6 h-6 rounded-full bg-indigo-100 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-400">💡</span>
                                {scaleMode === 'chain_nup' 
                                    ? t('misc.sheetViewerDialog:ban_xem_truoc_mo_phong_cum_trang_duoc') 
                                    : t('misc.sheetViewerDialog:ban_xem_truoc_mo_phong_cac_to_booklet')}
                            </div>
                        </div>
                    ) : (
                        /* ── SIDE-BY-SIDE ACTUAL PAGES VIEW ── */
                        <div className="flex-1 flex items-center justify-center gap-8 p-4 min-h-0 min-w-0">
                            {/* FRONT PLATE */}
                            <div className="flex flex-col items-center gap-3 max-h-full w-1/2 justify-center min-w-0">
                                <div className="shrink-0 inline-flex items-center justify-center h-7 text-[11px] font-bold tracking-wider uppercase px-5 rounded-md bg-sky-100 dark:bg-sky-500/20 text-sky-500 dark:text-sky-400">
                                    {t('misc.sheetViewerDialog:mat_truoc')}
                                </div>
                                <div className="flex justify-center bg-white dark:bg-zinc-800 rounded-lg border border-slate-200 dark:border-zinc-700 shadow-lg overflow-hidden min-h-0 min-w-0">
                                    <div className="flex-1 min-w-0 h-full min-h-0 flex items-center justify-center p-2">
                                        <PageSlotView slot={cs.front.left} pageOrder={imposedPageOrder} pageRotations={imposedPageRotations} pdfFile={pdfFile} pageWpt={pageWpt} pageHpt={pageHpt} bleed={bleed} />
                                    </div>
                                    <div className="shrink-0 w-px bg-red-400/60 z-10" />
                                    <div className="flex-1 min-w-0 h-full min-h-0 flex items-center justify-center p-2">
                                        <PageSlotView slot={cs.front.right} pageOrder={imposedPageOrder} pageRotations={imposedPageRotations} pdfFile={pdfFile} pageWpt={pageWpt} pageHpt={pageHpt} bleed={bleed} />
                                    </div>
                                </div>
                            </div>
                            
                            {/* BACK PLATE */}
                            {bindingMode === 'flush_mount' ? null : (
                            <div className="flex flex-col items-center gap-3 max-h-full w-1/2 justify-center min-w-0">
                                <div className="shrink-0 inline-flex items-center justify-center h-7 text-[11px] font-bold tracking-wider uppercase px-5 rounded-md bg-amber-100 dark:bg-amber-500/20 text-amber-500 dark:text-amber-400">
                                    {t('misc.sheetViewerDialog:mat_sau')}
                                </div>
                                <div className="flex justify-center bg-white dark:bg-zinc-800 rounded-lg border border-slate-200 dark:border-zinc-700 shadow-lg overflow-hidden min-h-0 min-w-0">
                                    <div className="flex-1 min-w-0 h-full min-h-0 flex items-center justify-center p-2">
                                        <PageSlotView slot={cs.back.left} pageOrder={imposedPageOrder} pageRotations={imposedPageRotations} pdfFile={pdfFile} pageWpt={pageWpt} pageHpt={pageHpt} bleed={bleed} />
                                    </div>
                                    <div className="shrink-0 w-px bg-red-400/60 z-10" />
                                    <div className="flex-1 min-w-0 h-full min-h-0 flex items-center justify-center p-2">
                                        <PageSlotView slot={cs.back.right} pageOrder={imposedPageOrder} pageRotations={imposedPageRotations} pdfFile={pdfFile} pageWpt={pageWpt} pageHpt={pageHpt} bleed={bleed} />
                                    </div>
                                </div>
                            </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Right arrow */}
                <button
                    onClick={() => {
                        if (blueprintMode) {
                            const curGroupIdx = signatureGroups.findIndex(g => g.sigIndex === sig);
                            if (curGroupIdx < signatureGroups.length - 1) goToSheet(sheets.indexOf(signatureGroups[curGroupIdx + 1].sheets[0]));
                        } else {
                            if (currentSheetIdx < sheets.length - 1) goToSheet(currentSheetIdx + 1);
                        }
                    }}
                    disabled={blueprintMode ? signatureGroups.findIndex(g => g.sigIndex === sig) >= signatureGroups.length - 1 : currentSheetIdx >= sheets.length - 1}
                    className="absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 flex items-center justify-center rounded-full bg-white/80 dark:bg-zinc-800/80 text-slate-700 dark:text-white hover:bg-white dark:hover:bg-zinc-700 hover:scale-110 transition-all disabled:opacity-30 disabled:cursor-not-allowed z-10 shadow-md dark:shadow-lg backdrop-blur-sm"
                >
                    <ChevronRight className="w-6 h-6" />
                </button>
            </div>

            {/* ── BOTTOM BAR ── */}
            <div className="absolute bottom-0 left-0 right-0 min-h-[4rem] flex flex-col items-center justify-center border-t border-slate-200 dark:border-white/10 bg-white/90 dark:bg-zinc-900/90 z-20 py-2 backdrop-blur-md transition-colors duration-300">
                <div className="flex flex-wrap items-center justify-center gap-4 max-w-full px-4">
                    {!blueprintMode && <div className="w-px h-6 bg-slate-300 dark:bg-zinc-700 hidden sm:block" />}

                    {/* Hide scrollbar using tailwind custom class or inline styles */}
                    {!blueprintMode && (
                        <div className="flex flex-wrap justify-center gap-1 max-w-[90vw] px-1 py-1">
                            {sheets.map((sheet, idx) => {
                                const s = sheet.signatureIndex ?? 1;
                                const c = SIG_COLORS[Math.max(0, s > 0 ? s - 1 : 0) % SIG_COLORS.length];
                                const isCur = idx === currentSheetIdx;
                                const prevS = idx > 0 ? (sheets[idx - 1].signatureIndex ?? 1) : s;
                                const divider = (bindingMode === 'thread' && idx > 0 && prevS !== s) || (catalogJobs && idx > 0 && prevS !== s);
                                return (
                                    <React.Fragment key={idx}>
                                        {divider && <div className="w-px h-5 bg-slate-300 dark:bg-zinc-600 mx-1 self-center" />}
                                        <button
                                            onClick={() => goToSheet(idx)}
                                            className="shrink-0 rounded text-[11px] font-bold transition-all"
                                            style={{
                                                width: '32px', height: '28px', lineHeight: '28px', textAlign: 'center',
                                                background: isCur ? c.border : c.bg,
                                                color: isCur ? 'white' : c.text,
                                                border: isCur ? `1px solid ${c.text}` : '1px solid transparent',
                                            }}
                                        >
                                            {idx + 1}
                                        </button>
                                    </React.Fragment>
                                );
                            })}
                        </div>
                    )}

                    {signatureGroups.length > 1 && (
                        <>
                            {!blueprintMode && <div className="w-px h-6 bg-slate-300 dark:bg-zinc-700 hidden sm:block" />}
                            <div className="flex flex-wrap justify-center gap-1 max-w-[90vw] px-1 py-1">
                                {signatureGroups.map((g) => {
                                    const isAct = g.sigIndex === sig;
                                    const job = jobMap?.get(g.sheets[0]);
                                    let label = t('misc.sheetViewerDialog:tep_sig', { n: g.sigIndex });
                                    if (job && job.label) {
                                        label = job.label.replace('Kẽm ', 'Tờ in ').replace('Tay ', '').replace(' — Tép ', ' Tép ').replace(/— Trang lẻ.*/, t('misc.sheetViewerDialog:le')).replace(/\(Tự Trở.*\)/, '').trim();
                                    } else if (job) {
                                        label = job.isCover ? t('misc.sheetViewerDialog:to_bia') : t('misc.sheetViewerDialog:to_in_n', { n: job.sortOrder || g.sigIndex });
                                    }
                                    return (
                                        <button key={g.sigIndex}
                                            onClick={() => goToSheet(sheets.indexOf(g.sheets[0]))}
                                            className="shrink-0 inline-flex items-center justify-center whitespace-nowrap px-6 py-2 rounded-lg text-xs font-semibold transition-all"
                                            style={{
                                                background: isAct ? g.color.border : g.color.bg,
                                                color: isAct ? 'white' : g.color.text,
                                                border: `1px solid ${g.color.border}`,
                                            }}
                                        >
                                            {label}
                                        </button>
                                    );
                                })}
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>,
        document.body
    );
};
