// @ts-nocheck
/**
 * PreprocessingRouter — Routes to the correct preprocessing sub-tool.
 * 
 * Extracted from ImposerDashboard.tsx (lines 876-952 headers + 1653-1803 content).
 * Renders the appropriate sub-tool component based on activeTool.
 */
import React from 'react';
import { useImposerSettingsStore } from '../useImposerSettingsStore';
import { Checkbox } from '../SharedUI';
import { useShallow } from 'zustand/react/shallow';

import ShuffleTool from '../../preprocess-tools/ShuffleTool';
import PageResizerTool from '../../preprocess-tools/PageResizerTool';
import TrimShiftTool from '../../preprocess-tools/TrimShiftTool';
import SplitTool from '../../preprocess-tools/SplitTool';
import MergeTool from '../../preprocess-tools/MergeTool';
import PreflightTool from '../../preprocess-tools/PreflightTool';
import FontToolsTool from '../../preprocess-tools/FontToolsTool';
import HairlinesTool from '../../preprocess-tools/HairlinesTool';
import ConvertColorsTool from '../../preprocess-tools/ConvertColorsTool';
import TrapPresetsTool from '../../preprocess-tools/TrapPresetsTool';
import SavePdfxTool from '../../preprocess-tools/SavePdfxTool';
import DataMergeTool from '../../preprocess-tools/DataMergeTool';
import OcrTool from '../../preprocess-tools/OcrTool';
import OptimizeTool from '../../preprocess-tools/OptimizeTool';
import StickerTool from '../../preprocess-tools/StickerTool';
import StickerToolErrorBoundary from '../../preprocess-tools/StickerToolErrorBoundary';
import BgRemoverTool from '../../preprocess-tools/BgRemoverTool';
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
    convertcolors: { icon: '🎨', title: 'Chuyển đổi màu (Convert Colors)', desc: 'RGB→CMYK, Spot→CMYK, ICC Profile, Rendering Intent.' },
    trapping: { icon: '🔲', title: 'Chồng tràn (Trapping)', desc: 'Overprint text đen, chống lỗi knockout.' },
    pdfx: { icon: '📄', title: 'Xuất PDF/X', desc: 'Kiểm tra & xuất chuẩn PDF/X-1a hoặc PDF/X-4.' },
    ocr: { icon: '🔍', title: 'OCR Searchable PDF', desc: 'Nhúng lớp text vô hình để tìm kiếm, bôi đen, copy chữ.' },
    optimize: { icon: '📦', title: 'Nén / Tối ưu PDF', desc: 'Giảm dung lượng file, nén ảnh, gỡ metadata thừa.' },
    sticker: { icon: '🔪', title: 'Bù xén - Tạo đường cắt', desc: 'Quét hình ảnh, tự động offset viền và tràn lề cho tem nhãn.' },
    bgremover: { icon: '✨', title: 'Tách nền AI', desc: 'Sử dụng AI siêu nét để bóc tách nền tóc, lưới, chi tiết mảnh.' },
    datamerge: { icon: '🔤', title: 'Trộn dữ liệu VDP', desc: 'Vui lòng sử dụng Không gian thiết kế ở màn hình bên phải để kéo thả vùng in và nạp dữ liệu.' },
    numbering: { icon: '🔢', title: 'Nhảy số tự động', desc: 'Vui lòng sử dụng Không gian thiết kế ở màn hình bên phải để cấu hình số nhảy.' },
    stick_text_number: { icon: '🔠', title: 'Header & Footer', desc: 'Vui lòng sử dụng Không gian thiết kế ở màn hình bên phải để đóng dấu cố định trang.' },
    watermark: { icon: '©️', title: 'Chèn Nền & Đóng Dấu', desc: 'Chèn phôi nền (Background), logo chìm, text mờ (Watermark).' },
    upscale: { icon: '🪄', title: 'Phóng to Ảnh', desc: 'Phóng to ảnh nhưng vẫn giữ được độ sắc nét, không bị vỡ hạt.' },
    pages: { icon: '📄', title: 'Quản lý trang', desc: 'Nhân bản, xóa, xoay, và di chuyển trang PDF.' },
    encrypt: { icon: '🔐', title: 'Khóa / Mở khóa PDF', desc: 'Đặt mật khẩu, hạn chế in/copy, hoặc gỡ khóa khi biết mật khẩu.' },
    metadata: { icon: '🏷️', title: 'Metadata PDF', desc: 'Xem / sửa Title, Author, Subject… hoặc xóa metadata.' },
    office_convert: { icon: '📝', title: 'Word / Excel / Google → PDF', desc: 'Chuyển .docx/.xlsx hoặc link Google Docs/Sheets thành PDF.' },
    crop: { icon: <CropIcon className="h-4 w-4" />, title: 'Cắt khổ trang (Crop)', desc: 'Quét vùng, nhập kích thước và canh theo toàn bộ trang.' },
};


// ─── Props ──────────────────────────────────────────────────────────────────

interface PreprocessingRouterProps {
    tabId: string;
    activeTool: string;
    pdfFile: File | null;
    isProcessing: boolean;
    onStartShuffle?: (settings: any) => void;
    onStartResize?: (settings: any) => void;
    onStartTrimShift?: (settings: any) => void;
    onStartSplit?: (settings: any) => void;
    onStartMerge?: (settings: any) => void;
    onIssueSelect: (issue: any) => void;
    onOpenOutputPreview: () => void;
    onOpenTool?: (tool: string) => void;
    onFileFixed?: (blob: Blob, name: string, path?: string) => void;
    officeSourceFile?: File | null;
    officeSourceFiles?: File[];
    ensureCropFileId?: (signal?: AbortSignal) => Promise<string>;
    onCropApplied?: (blob: Blob, filename: string, openInNewTab: boolean) => void | Promise<void>;
    onCropClose?: () => void;
}

export default function PreprocessingRouter({
    tabId, activeTool, pdfFile, isProcessing, ensureCropFileId, onCropApplied, onCropClose,
    onStartShuffle, onStartResize, onStartTrimShift, onStartSplit, onStartMerge,
    onIssueSelect, onOpenOutputPreview, onOpenTool, onFileFixed, officeSourceFile, officeSourceFiles,
}: PreprocessingRouterProps) {
  const { t } = useTranslation();
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
                <CropDialog embedded ensureFileId={ensureCropFileId} onApplied={onCropApplied} onClose={onCropClose || (() => undefined)} />
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
                    <PageResizerTool settings={s.resizeSettings} onChange={s.setResizeSettings} />
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
                <PageToolsPanel />
            )}



            {activeTool === 'preflight' && (
                <PreflightTool
                    pdfFile={pdfFile}
                    onIssueSelect={onIssueSelect}
                    onOpenOutputPreview={onOpenOutputPreview}
                    onOpenFontTools={() => onOpenTool?.('font_tools')}
                    onFileFixed={(blob, name) => {
                        (window as any).__preflightFixedBlob = blob;
                        (window as any).__preflightFixedName = name;
                        if (onFileFixed) onFileFixed(blob, name);
                    }}
                />
            )}

            {activeTool === 'font_tools' && (
                <FontToolsTool
                    pdfFile={pdfFile}
                    onFileFixed={(blob, name) => { if (onFileFixed) onFileFixed(blob, name); }}
                />
            )}

            {activeTool === 'hairlines' && (
                <HairlinesTool pdfFile={pdfFile} onFileFixed={(blob, name) => { if (onFileFixed) onFileFixed(blob, name); }} />
            )}

            {activeTool === 'convertcolors' && (
                <ConvertColorsTool pdfFile={pdfFile} onFileFixed={(blob, name) => { if (onFileFixed) onFileFixed(blob, name); }} />
            )}

            {activeTool === 'trapping' && (
                <TrapPresetsTool pdfFile={pdfFile} onFileFixed={(blob, name) => { if (onFileFixed) onFileFixed(blob, name); }} />
            )}

            {activeTool === 'pdfx' && (
                <SavePdfxTool pdfFile={pdfFile} onFileFixed={(blob, name) => { if (onFileFixed) onFileFixed(blob, name); }} />
            )}

            {activeTool === 'ocr' && (
                <OcrTool pdfFile={pdfFile} onFileFixed={(blob, name) => { if (onFileFixed) onFileFixed(blob, name); }} />
            )}

            {activeTool === 'optimize' && (
                <OptimizeTool pdfFile={pdfFile} onFileFixed={(blob, name) => { if (onFileFixed) onFileFixed(blob, name); }} />
            )}

            {activeTool === 'sticker' && (
                <StickerToolErrorBoundary>
                    <StickerTool pdfFile={pdfFile} onFileFixed={(blob, name, path) => { if (onFileFixed) onFileFixed(blob, name, path); }} />
                </StickerToolErrorBoundary>
            )}

            {activeTool === 'bgremover' && (
                <BgRemoverTool tabId={tabId} pdfFile={pdfFile} />
            )}

            {activeTool === 'watermark' && (
                <WatermarkTool pdfFile={pdfFile} onFileFixed={(blob, name) => { if (onFileFixed) onFileFixed(blob, name); }} />
            )}

            {activeTool === 'upscale' && (
                <UpscaleTool tabId={tabId} pdfFile={pdfFile} />
            )}

            {activeTool === 'encrypt' && (
                <EncryptTool pdfFile={pdfFile} onFileFixed={(blob, name) => { if (onFileFixed) onFileFixed(blob, name); }} />
            )}

            {activeTool === 'metadata' && (
                <MetadataTool pdfFile={pdfFile} onFileFixed={(blob, name) => { if (onFileFixed) onFileFixed(blob, name); }} />
            )}

            {activeTool === 'office_convert' && (
                <OfficeConvertTool
                    pdfFile={pdfFile}
                    officeSourceFile={officeSourceFile}
                    officeSourceFiles={officeSourceFiles}
                    onFileFixed={(blob, name) => { if (onFileFixed) onFileFixed(blob, name); }}
                />
            )}
        </>
    );
}
