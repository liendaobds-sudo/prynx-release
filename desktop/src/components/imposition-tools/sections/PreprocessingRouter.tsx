/**
 * PreprocessingRouter — Routes to the correct preprocessing sub-tool.
 * 
 * Extracted from ImposerDashboard.tsx (lines 876-952 headers + 1653-1803 content).
 * Renders the appropriate sub-tool component based on activeTool.
 */
import React, { type ComponentProps } from 'react';
import { useImposerSettingsStore } from '../useImposerSettingsStore';
import { Checkbox } from '../SharedUI';
import { useShallow } from 'zustand/react/shallow';

import ShuffleTool from '../../preprocess-tools/ShuffleTool';
import PageResizerTool from '../../preprocess-tools/PageResizerTool';
import TrimShiftTool from '../../preprocess-tools/TrimShiftTool';
import SplitTool from '../../preprocess-tools/SplitTool';
import PreflightTool from '../../preprocess-tools/PreflightTool';
import FontToolsTool from '../../preprocess-tools/FontToolsTool';
import HairlinesTool from '../../preprocess-tools/HairlinesTool';
import InkManagerTool from '../../preprocess-tools/InkManagerTool';
import ConvertColorsTool from '../../preprocess-tools/ConvertColorsTool';
import TrapPresetsTool from '../../preprocess-tools/TrapPresetsTool';
import SavePdfxTool from '../../preprocess-tools/SavePdfxTool';
import OcrTool from '../../preprocess-tools/OcrTool';
import OptimizeTool from '../../preprocess-tools/OptimizeTool';
import StickerCutlineTool from '../../preprocess-tools/StickerCutlineTool';
import StickerToolErrorBoundary from '../../preprocess-tools/StickerToolErrorBoundary';
import BgRemoverTool from '../../preprocess-tools/BgRemoverTool';
import DocumentCleanupTool from '../../preprocess-tools/DocumentCleanupTool';
import WatermarkTool from '../../preprocess-tools/WatermarkTool';
import UpscaleTool from '../../preprocess-tools/UpscaleTool';
import EncryptTool from '../../preprocess-tools/EncryptTool';
import MetadataTool from '../../preprocess-tools/MetadataTool';
import OfficeConvertTool from '../../preprocess-tools/OfficeConvertTool';
import CropDialog from '../../workspace/CropDialog';

import PageToolsPanel from '../../preprocess-tools/PageToolsPanel';
import { PREPROCESS_ROUTER_TOOLS } from './preprocessRouterTools';
import { useTranslation } from 'react-i18next';
import { tv } from '../../../i18n';
import { CropIcon } from '../../shared/ToolIcons';
import type { RecipeOperationTicket } from '../../../lib/recipe/RecipeRecorder';
import type { ShuffleSettings } from '../../preprocess-tools/ShuffleTool';
import type { PageResizerSettings } from '../../preprocess-tools/pageResizerViewLogic';
import type { SplitSettings } from '../../preprocess-tools/SplitTool';
import type { TrimShiftSettings } from '../../preprocess-tools/TrimShiftTool';

// ─── Tool Header Definitions ────────────────────────────────────────────────
const TOOL_HEADERS: Record<string, { icon: React.ReactNode; title: string; desc: string }> = {
    shuffle: { icon: '🔀', title: 'Xáo trộn trang (Shuffle)', desc: 'Sắp xếp, đảo ngược, xoay chiều trang tự động.' },
    resize: { icon: '📏', title: 'Co giãn trang (Resize)', desc: 'Thu phóng nội dung fit vào khổ giấy mới.' },
    trim_shift: { icon: '⇔', title: 'Cắt xén & Dời (Trim & Shift)', desc: 'Chỉnh khổ từng cạnh, dời nội dung, bù lề gáy & creep.' },
    split: { icon: '✂', title: 'Tách file (Split)', desc: 'Tách lẻ trang hoặc chia nhóm file đều đặn.' },
    merge: { icon: '🔗', title: 'Ghép file & Chèn trang (Merge/Insert)', desc: 'Gộp nhiều PDF, trộn xen kẽ lẻ chẵn, chèn trang đệm.' },
    preflight: { icon: '🩺', title: 'Preflight (Kiểm tra chuẩn in)', desc: 'Quét lỗi hệ màu, font, DPI và tự động sửa.' },
    font_tools: { icon: '🔤', title: 'Chữ & Font', desc: 'Kiểm tra font nhúng, chữ sống và khóa chữ có hậu kiểm.' },
    hairlines: { icon: '✏️', title: 'Sửa nét mảnh (Fix Hairlines)', desc: 'Phát hiện & tăng độ dày nét quá mảnh.' },
    inkmanager: { icon: '🖨️', title: 'Quản lý mực (Ink Manager)', desc: 'Kiểm tra kênh Process/Spot và chuyển màu Spot có chủ đích.' },
    convertcolors: { icon: '🎨', title: 'Chuyển đổi màu (Convert Colors)', desc: 'RGB→CMYK, Spot→CMYK, ICC Profile, Rendering Intent.' },
    trapping: { icon: '🔲', title: 'Chồng tràn (Trapping)', desc: 'Overprint text đen, chống lỗi knockout.' },
    pdfx: { icon: '📄', title: 'Xuất PDF/X', desc: 'Kiểm tra & xuất chuẩn PDF/X-1a hoặc PDF/X-4.' },
    ocr: { icon: '🔍', title: 'OCR Searchable PDF', desc: 'Nhúng lớp text vô hình để tìm kiếm, bôi đen, copy chữ.' },
    optimize: { icon: '📦', title: 'Nén / Tối ưu PDF', desc: 'Giảm dung lượng file, nén ảnh, gỡ metadata thừa.' },
    sticker: { icon: '🔪', title: 'Bù xén - Tạo đường cắt', desc: 'Quét hình ảnh, tự động offset viền và tràn lề cho tem nhãn.' },
    bgremover: { icon: '✨', title: 'Tách nền AI', desc: 'Sử dụng AI siêu nét để bóc tách nền tóc, lưới, chi tiết mảnh.' },
    document_cleanup: { icon: '🪪', title: 'Nắn thẻ – Làm trắng scan', desc: 'Nắn ảnh giấy tờ chụp xiên và làm sạch nền xám của bản scan.' },
    datamerge: { icon: '🔤', title: 'Trộn dữ liệu VDP', desc: 'Vui lòng sử dụng Không gian thiết kế ở màn hình bên phải để kéo thả vùng in và nạp dữ liệu.' },
    numbering: { icon: '🔢', title: 'Nhảy số tự động', desc: 'Vui lòng sử dụng Không gian thiết kế ở màn hình bên phải để cấu hình số nhảy.' },
    stick_text_number: { icon: '🔠', title: 'Header & Footer', desc: 'Vui lòng sử dụng Không gian thiết kế ở màn hình bên phải để đóng dấu cố định trang.' },
    watermark: { icon: '©️', title: 'Chèn Nền & Đóng Dấu', desc: 'Chèn phôi nền (Background), logo chìm, text mờ (Watermark).' },
    upscale: { icon: '🪄', title: 'Phóng to Ảnh', desc: 'Cải thiện độ nét cảm nhận khi phóng to; AI có thể suy đoán chi tiết.' },
    logo_rebuild: { icon: '🧩', title: 'Vector hóa Logo', desc: 'Dựng SVG từ logo đen trắng hoặc bảng màu đã xác nhận.' },
    pages: { icon: '📄', title: 'Quản lý trang', desc: 'Nhân bản, xóa, xoay, và di chuyển trang PDF.' },
    encrypt: { icon: '🔐', title: 'Khóa / Mở khóa PDF', desc: 'Đặt mật khẩu, hạn chế in/copy, hoặc gỡ khóa khi biết mật khẩu.' },
    metadata: { icon: '🏷️', title: 'Metadata PDF', desc: 'Xem / sửa Title, Author, Subject… hoặc xóa metadata.' },
    office_convert: { icon: '📝', title: 'Word / Excel / Google → PDF', desc: 'Chuyển .docx/.xlsx hoặc link Google Docs/Sheets thành PDF.' },
    crop: { icon: <CropIcon className="h-4 w-4" />, title: 'Cắt khổ trang (Crop)', desc: 'Quét vùng, nhập kích thước và canh theo toàn bộ trang.' },
};


// ─── Props ──────────────────────────────────────────────────────────────────

type PreflightIssue = Parameters<NonNullable<ComponentProps<typeof PreflightTool>['onIssueSelect']>>[0];
type PreprocessRunSettings<T> = T & { spawnNewTab?: boolean };

interface PreprocessingRouterProps {
    tabId: string;
    activeTool: string;
    pdfFile: File | null;
    sourceImageFile?: File | null;
    sourceImageReferenceFile?: File | null;
    getWorkingFile?: () => Promise<File>;
    getPreparedWorkingFile?: () => Promise<File>;
    viewerActivePage?: number;
    viewerPageOrder?: number[];
    viewerPageRotations?: number[];
    isActive?: boolean;
    isProcessing: boolean;
    onStartShuffle?: (settings: PreprocessRunSettings<ShuffleSettings>) => void;
    onStartResize?: (settings: PreprocessRunSettings<PageResizerSettings>) => void;
    onStartTrimShift?: (settings: PreprocessRunSettings<TrimShiftSettings>) => void;
    onStartSplit?: (settings: PreprocessRunSettings<SplitSettings>) => void;
    onIssueSelect: (issue: PreflightIssue) => void;
    onOpenOutputPreview: () => void;
    onOpenTool?: (tool: string) => void;
    // RECIPE (audit 2026-08-17 §REC.4R): kết quả commit phải propagate về tool để
    // tool không báo thành công khi bị chặn.
    onFileFixed?: (
        blob: Blob,
        name: string,
        path?: string,
        recipeTicket?: RecipeOperationTicket | null,
    ) => void | boolean | Promise<void | boolean>;
    officeSourceFile?: File | null;
    officeSourceFiles?: File[];
    ensureCropFileId?: (signal?: AbortSignal) => Promise<string>;
    onCropApplied?: (blob: Blob, filename: string, openInNewTab: boolean) => void | Promise<void>;
    onCropClose?: () => void;
}

export default function PreprocessingRouter({
    tabId, activeTool, pdfFile, sourceImageFile, sourceImageReferenceFile, getWorkingFile, getPreparedWorkingFile, viewerActivePage, viewerPageOrder, viewerPageRotations, isProcessing, isActive, ensureCropFileId, onCropApplied, onCropClose,
    onStartShuffle, onStartResize, onStartTrimShift, onStartSplit,
    onIssueSelect, onOpenOutputPreview, onOpenTool, onFileFixed, officeSourceFile, officeSourceFiles,
}: PreprocessingRouterProps) {
  const { t } = useTranslation();
  const forwardFileFixedResult = async (
    blob: Blob,
    name: string,
    path?: string,
    recipeTicket?: RecipeOperationTicket | null,
  ): Promise<void | boolean> => {
    return onFileFixed ? await onFileFixed(blob, name, path, recipeTicket) : undefined;
  };
  const forwardFileFixedVoid = async (
    blob: Blob,
    name: string,
    path?: string,
    recipeTicket?: RecipeOperationTicket | null,
  ): Promise<void> => {
    await onFileFixed?.(blob, name, path, recipeTicket);
  };
    const s = useImposerSettingsStore(useShallow(state => ({
        spawnNewTabByTool: state.spawnNewTabByTool, setSpawnNewTab: state.setSpawnNewTab,
        shuffleSettings: state.shuffleSettings, setShuffleSettings: state.setShuffleSettings,
        resizeSettings: state.resizeSettings, setResizeSettings: state.setResizeSettings,
        trimShiftSettings: state.trimShiftSettings, setTrimShiftSettings: state.setTrimShiftSettings,
        splitSettings: state.splitSettings, setSplitSettings: state.setSplitSettings,
    })));

    const header = TOOL_HEADERS[activeTool];

    // Tự bảo vệ: chỉ render khi activeTool thực sự là công cụ tiền xử lý (SSOT).
    // No-op trong thực tế (ImposerDashboard chỉ mount router cho kind 'preprocess'),
    // nhưng chặn rò nếu sau này có tool lọt vào sai chỗ.
    if (!(PREPROCESS_ROUTER_TOOLS as readonly string[]).includes(activeTool)) return null;

    return (
        <>
            {/* ═══ HEADER ═══ */}
            {header && (
                <div className="pt-2 text-center pb-2">
                    <h2 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center justify-center gap-2">
                        <span className="inline-flex items-center justify-center">{header.icon}</span>
                        <span>{tv(header.title)}</span>
                    </h2>
                    <p className="text-[11px] text-slate-500 mt-1">{tv(header.desc)}</p>
                </div>
            )}

            {/* ═══ CONTENT ═══ */}
            {activeTool === 'crop' && ensureCropFileId && onCropApplied && (
                <CropDialog tabId={tabId} embedded ensureFileId={ensureCropFileId} onApplied={onCropApplied} onClose={onCropClose || (() => undefined)} />
            )}

            {activeTool === 'shuffle' && (
                <div>
                    <ShuffleTool settings={s.shuffleSettings} onChange={s.setShuffleSettings} />
                    <div className="mt-4 mb-2">
                        <Checkbox checked={s.spawnNewTabByTool[activeTool] ?? true} onChange={(v) => s.setSpawnNewTab(activeTool, v)} label={t('imposition.preprocessingRouter:mo_ket_qua_sang_tab_moi')} />
                    </div>
                    <button 
                        onClick={() => onStartShuffle && onStartShuffle({ ...s.shuffleSettings, spawnNewTab: s.spawnNewTabByTool[activeTool] ?? true })} 
                        disabled={isProcessing}
                        className="mt-2 w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded font-bold shadow-sm transition-colors disabled:opacity-50"
                    >
                        {t('preprocess.common:run')}{isProcessing ? '…' : ''}
                    </button>
                </div>
            )}
            
            {activeTool === 'resize' && (
                <div>
                    <PageResizerTool
                        settings={s.resizeSettings}
                        onChange={s.setResizeSettings}
                        pdfFile={pdfFile}
                        sourceImageFile={sourceImageFile}
                        getWorkingFile={getWorkingFile}
                        viewerPageOrder={viewerPageOrder}
                        viewerPageRotations={viewerPageRotations}
                    />
                    <div className="mt-4 mb-2">
                        <Checkbox checked={s.spawnNewTabByTool[activeTool] ?? true} onChange={(v) => s.setSpawnNewTab(activeTool, v)} label={t('imposition.preprocessingRouter:mo_ket_qua_sang_tab_moi')} />
                    </div>
                    <button 
                        onClick={() => onStartResize && onStartResize({ ...s.resizeSettings, spawnNewTab: s.spawnNewTabByTool[activeTool] ?? true })} 
                        disabled={isProcessing}
                        className="mt-2 w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded font-bold shadow-sm transition-colors disabled:opacity-50"
                    >
                        {t('preprocess.common:run')}{isProcessing ? '…' : ''}
                    </button>
                </div>
            )}

            {activeTool === 'trim_shift' && (
                <div>
                    <TrimShiftTool settings={s.trimShiftSettings} onChange={s.setTrimShiftSettings} />
                    <div className="mt-4 mb-2">
                        <Checkbox checked={s.spawnNewTabByTool[activeTool] ?? true} onChange={(v) => s.setSpawnNewTab(activeTool, v)} label={t('imposition.preprocessingRouter:mo_ket_qua_sang_tab_moi')} />
                    </div>
                    <button
                        onClick={() => onStartTrimShift && onStartTrimShift({ ...s.trimShiftSettings, spawnNewTab: s.spawnNewTabByTool[activeTool] ?? true })}
                        disabled={isProcessing}
                        className="mt-2 w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded font-bold shadow-sm transition-colors disabled:opacity-50"
                    >
                        {t('preprocess.common:run')}{isProcessing ? '…' : ''}
                    </button>
                </div>
            )}

            {activeTool === 'split' && (
                <div>
                    <SplitTool settings={s.splitSettings} onChange={s.setSplitSettings} />
                    <div className="mt-4 mb-2">
                        <Checkbox checked={s.spawnNewTabByTool[activeTool] ?? true} onChange={(v) => s.setSpawnNewTab(activeTool, v)} label={t('imposition.preprocessingRouter:mo_ket_qua_sang_tab_moi')} />
                    </div>
                    <button 
                        onClick={() => onStartSplit && onStartSplit({ ...s.splitSettings, spawnNewTab: s.spawnNewTabByTool[activeTool] ?? true })} 
                        disabled={isProcessing}
                        className="mt-2 w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded font-bold transition-colors disabled:opacity-50"
                    >
                        {t('preprocess.common:run')}{isProcessing ? '…' : ''}
                    </button>
                </div>
            )}

            {activeTool === 'pages' && (
                <PageToolsPanel tabId={tabId} />
            )}



            {activeTool === 'preflight' && (
                <PreflightTool
                    pdfFile={pdfFile}
                    onIssueSelect={onIssueSelect}
                    onOpenOutputPreview={onOpenOutputPreview}
                    onOpenFontTools={() => onOpenTool?.('font_tools')}
                    onFileFixed={forwardFileFixedResult}
                />
            )}

            {activeTool === 'font_tools' && (
                <FontToolsTool
                    pdfFile={pdfFile}
                    onFileFixed={forwardFileFixedResult}
                />
            )}

            {activeTool === 'hairlines' && (
                <HairlinesTool tabId={tabId} pdfFile={pdfFile} onFileFixed={forwardFileFixedResult} />
            )}

            {activeTool === 'inkmanager' && (
                <InkManagerTool tabId={tabId} pdfFile={pdfFile} onFileFixed={forwardFileFixedVoid} />
            )}

            {activeTool === 'convertcolors' && (
                <ConvertColorsTool tabId={tabId} pdfFile={pdfFile} onFileFixed={forwardFileFixedVoid} />
            )}

            {activeTool === 'trapping' && (
                <TrapPresetsTool tabId={tabId} pdfFile={pdfFile} onFileFixed={forwardFileFixedResult} />
            )}

            {activeTool === 'pdfx' && (
                <SavePdfxTool tabId={tabId} pdfFile={pdfFile} onFileFixed={forwardFileFixedResult} />
            )}

            {activeTool === 'ocr' && (
                <OcrTool pdfFile={pdfFile} onFileFixed={forwardFileFixedResult} />
            )}

            {activeTool === 'optimize' && (
                <OptimizeTool tabId={tabId} pdfFile={pdfFile} onFileFixed={forwardFileFixedVoid} />
            )}

            {activeTool === 'sticker' && (
                <StickerToolErrorBoundary>
                    <StickerCutlineTool
                        tabId={tabId}
                        pdfFile={pdfFile}
                        sourceImageFile={sourceImageFile}
                        activeSourcePage={viewerPageOrder?.[Math.max(0, (viewerActivePage || 1) - 1)]
                            ?? viewerActivePage
                            ?? 1}
                        activeWorkingPage={viewerActivePage ?? 1}
                        pageOrder={viewerPageOrder}
                        isActive={isActive === true}
                        onOpenTool={onOpenTool}
                        onFileFixed={forwardFileFixedResult}
                    />
                </StickerToolErrorBoundary>
            )}

            {activeTool === 'bgremover' && (
                <BgRemoverTool
                    tabId={tabId}
                    pdfFile={pdfFile}
                    sourceImageFile={sourceImageFile}
                />
            )}

            {activeTool === 'document_cleanup' && (
                <DocumentCleanupTool
                    tabId={tabId}
                    pdfFile={pdfFile}
                    sourceImageFile={sourceImageFile}
                    getWorkingFile={getPreparedWorkingFile}
                    onFileFixed={forwardFileFixedResult}
                />
            )}

            {activeTool === 'watermark' && (
                <WatermarkTool pdfFile={pdfFile} onFileFixed={forwardFileFixedResult} />
            )}

            {activeTool === 'upscale' && (
                <UpscaleTool
                    tabId={tabId}
                    pdfFile={pdfFile}
                    sourceImageFile={sourceImageFile}
                    sourceImageReferenceFile={sourceImageReferenceFile}
                    getWorkingFile={getPreparedWorkingFile}
                    activeWorkingPage={viewerActivePage ?? 1}
                    onFileFixed={forwardFileFixedVoid}
                />
            )}

            {activeTool === 'logo_rebuild' && (
                <div className="rounded-lg border border-violet-200 bg-violet-50/70 p-3 text-xs leading-relaxed text-violet-800 dark:border-violet-900 dark:bg-violet-950/30 dark:text-violet-200">
                    {tv('Workspace bên trái dùng để chọn ảnh, xác nhận bảng màu, tạo preview và tải SVG.')}
                </div>
            )}

            {activeTool === 'encrypt' && (
                <EncryptTool pdfFile={pdfFile} onFileFixed={forwardFileFixedResult} />
            )}

            {activeTool === 'metadata' && (
                <MetadataTool pdfFile={pdfFile} onFileFixed={forwardFileFixedResult} />
            )}

            {activeTool === 'office_convert' && (
                <OfficeConvertTool
                    pdfFile={pdfFile}
                    officeSourceFile={officeSourceFile}
                    officeSourceFiles={officeSourceFiles}
                    onFileFixed={forwardFileFixedResult}
                />
            )}
        </>
    );
}
