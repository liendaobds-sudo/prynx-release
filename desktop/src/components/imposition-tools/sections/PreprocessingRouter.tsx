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
import SplitTool from '../../preprocess-tools/SplitTool';
import MergeTool from '../../preprocess-tools/MergeTool';
import PreflightTool from '../../preprocess-tools/PreflightTool';
import HairlinesTool from '../../preprocess-tools/HairlinesTool';
import ConvertColorsTool from '../../preprocess-tools/ConvertColorsTool';
import TrapPresetsTool from '../../preprocess-tools/TrapPresetsTool';
import SavePdfxTool from '../../preprocess-tools/SavePdfxTool';
import DataMergeTool from '../../preprocess-tools/DataMergeTool';
import OcrTool from '../../preprocess-tools/OcrTool';
import OptimizeTool from '../../preprocess-tools/OptimizeTool';
import StickerTool from '../../preprocess-tools/StickerTool';
import BgRemoverTool from '../../preprocess-tools/BgRemoverTool';
import WatermarkTool from '../../preprocess-tools/WatermarkTool';
import UpscaleTool from '../../preprocess-tools/UpscaleTool';

import PageToolsPanel from '../../preprocess-tools/PageToolsPanel';
import { PREPROCESS_ROUTER_TOOLS } from './preprocessRouterTools';

// ─── Tool Header Definitions ────────────────────────────────────────────────
const TOOL_HEADERS: Record<string, { icon: string; title: string; desc: string }> = {
    shuffle: { icon: '🔀', title: 'Xáo trộn trang (Shuffle)', desc: 'Sắp xếp, đảo ngược, xoay chiều trang tự động.' },
    resize: { icon: '📏', title: 'Co giãn trang (Resize)', desc: 'Thu phóng nội dung fit vào khổ giấy mới.' },
    split: { icon: '✂', title: 'Tách file (Split)', desc: 'Tách lẻ trang hoặc chia nhóm file đều đặn.' },
    merge: { icon: '🔗', title: 'Ghép file & Chèn trang (Merge/Insert)', desc: 'Gộp nhiều PDF, trộn xen kẽ lẻ chẵn, chèn trang đệm.' },
    preflight: { icon: '🩺', title: 'Preflight (Kiểm tra chuẩn in)', desc: 'Quét lỗi hệ màu, font, DPI và tự động sửa.' },
    hairlines: { icon: '✏️', title: 'Sửa nét mảnh (Fix Hairlines)', desc: 'Phát hiện & tăng độ dày nét quá mảnh.' },
    convertcolors: { icon: '🎨', title: 'Chuyển đổi màu (Convert Colors)', desc: 'RGB→CMYK, Spot→CMYK, ICC Profile, Rendering Intent.' },
    trapping: { icon: '🔲', title: 'Chồng tràn (Trapping)', desc: 'Overprint text đen, chống lỗi knockout.' },
    pdfx: { icon: '📄', title: 'Xuất PDF/X', desc: 'Kiểm tra & xuất chuẩn PDF/X-1a hoặc PDF/X-4.' },
    ocr: { icon: '🔍', title: 'OCR Searchable PDF', desc: 'Nhúng lớp text vô hình để tìm kiếm, bôi đen, copy chữ.' },
    optimize: { icon: '📦', title: 'Nén / Tối ưu PDF', desc: 'Giảm dung lượng file, nén ảnh, gỡ metadata thừa.' },
    sticker: { icon: '🔪', title: 'Bù xén - tạo đường cắt', desc: 'Quét hình ảnh, tự động offset viền và tràn lề cho tem nhãn.' },
    bgremover: { icon: '✨', title: 'Tách nền AI', desc: 'Sử dụng AI siêu nét để bóc tách nền tóc, lưới, chi tiết mảnh.' },
    datamerge: { icon: '🔤', title: 'Trộn dữ liệu VDP', desc: 'Vui lòng sử dụng Không gian thiết kế ở màn hình bên phải để kéo thả vùng in và nạp dữ liệu.' },
    numbering: { icon: '🔢', title: 'Nhảy số tự động', desc: 'Vui lòng sử dụng Không gian thiết kế ở màn hình bên phải để cấu hình số nhảy.' },
    stick_text_number: { icon: '🔠', title: 'Header & Footer', desc: 'Vui lòng sử dụng Không gian thiết kế ở màn hình bên phải để đóng dấu cố định trang.' },
    watermark: { icon: '©️', title: 'Chèn Nền & Đóng Dấu', desc: 'Chèn phôi nền (Background), logo chìm, text mờ (Watermark).' },
    upscale: { icon: '🪄', title: 'Phóng to Ảnh', desc: 'Phóng to ảnh nhưng vẫn giữ được độ sắc nét, không bị vỡ hạt.' },
    pages: { icon: '📄', title: 'Quản lý trang', desc: 'Nhân bản, xóa, xoay, và di chuyển trang PDF.' },
};


// ─── Props ──────────────────────────────────────────────────────────────────

interface PreprocessingRouterProps {
    tabId: string;
    activeTool: string;
    pdfFile: File | null;
    isProcessing: boolean;
    onStartShuffle?: (settings: any) => void;
    onStartResize?: (settings: any) => void;
    onStartSplit?: (settings: any) => void;
    onStartMerge?: (settings: any) => void;
    onIssueSelect: (issue: any) => void;
    onOpenOutputPreview: () => void;
    onFileFixed?: (blob: Blob, name: string) => void;
}

export default function PreprocessingRouter({
    tabId, activeTool, pdfFile, isProcessing,
    onStartShuffle, onStartResize, onStartSplit, onStartMerge,
    onIssueSelect, onOpenOutputPreview, onFileFixed,
}: PreprocessingRouterProps) {
    const s = useImposerSettingsStore(useShallow(state => ({
        spawnNewTab: state.spawnNewTab, setSpawnNewTab: state.setSpawnNewTab,
        shuffleSettings: state.shuffleSettings, setShuffleSettings: state.setShuffleSettings,
        resizeSettings: state.resizeSettings, setResizeSettings: state.setResizeSettings,
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
                        <span>{header.icon}</span>
                        <span>{header.title}</span>
                    </h2>
                    <p className="text-[11px] text-slate-500 mt-1">{header.desc}</p>
                </div>
            )}

            {/* ═══ CONTENT ═══ */}
            {activeTool === 'shuffle' && (
                <div>
                    <ShuffleTool settings={s.shuffleSettings} onChange={s.setShuffleSettings} />
                    <div className="mt-4 mb-2">
                        <Checkbox checked={s.spawnNewTab} onChange={s.setSpawnNewTab} label="Mở kết quả sang Tab mới" />
                    </div>
                    <button 
                        onClick={() => onStartShuffle && onStartShuffle({ ...s.shuffleSettings, spawnNewTab: s.spawnNewTab })} 
                        disabled={isProcessing}
                        className="mt-2 w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded font-bold shadow-sm transition-colors disabled:opacity-50"
                    >
                        {isProcessing ? 'Đang áp dụng...' : 'Thực Thi Xáo Trộn'}
                    </button>
                </div>
            )}
            
            {activeTool === 'resize' && (
                <div>
                    <PageResizerTool settings={s.resizeSettings} onChange={s.setResizeSettings} />
                    <div className="mt-4 mb-2">
                        <Checkbox checked={s.spawnNewTab} onChange={s.setSpawnNewTab} label="Mở kết quả sang Tab mới" />
                    </div>
                    <button 
                        onClick={() => onStartResize && onStartResize({ ...s.resizeSettings, spawnNewTab: s.spawnNewTab })} 
                        disabled={isProcessing}
                        className="mt-2 w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded font-bold shadow-sm transition-colors disabled:opacity-50"
                    >
                        {isProcessing ? 'Đang áp dụng...' : 'Thực Thi Đổi Khổ'}
                    </button>
                </div>
            )}

            {activeTool === 'split' && (
                <div>
                    <SplitTool settings={s.splitSettings} onChange={s.setSplitSettings} />
                    <div className="mt-4 mb-2">
                        <Checkbox checked={s.spawnNewTab} onChange={s.setSpawnNewTab} label="Mở kết quả sang Tab mới" />
                    </div>
                    <button 
                        onClick={() => onStartSplit && onStartSplit({ ...s.splitSettings, spawnNewTab: s.spawnNewTab })} 
                        disabled={isProcessing}
                        className="mt-2 w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded font-bold transition-colors disabled:opacity-50"
                    >
                        {isProcessing ? 'Đang áp dụng...' : 'Thực Thi Tách File'}
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
                    onFileFixed={(blob, name) => {
                        (window as any).__preflightFixedBlob = blob;
                        (window as any).__preflightFixedName = name;
                        if (onFileFixed) onFileFixed(blob, name);
                    }}
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
                <StickerTool pdfFile={pdfFile} onFileFixed={(blob, name) => { if (onFileFixed) onFileFixed(blob, name); }} />
            )}

            {activeTool === 'bgremover' && (
                <BgRemoverTool tabId={tabId} pdfFile={pdfFile} />
            )}

            {activeTool === 'watermark' && (
                <WatermarkTool pdfFile={pdfFile} onFileFixed={(blob, name) => { if (onFileFixed) onFileFixed(blob, name); }} />
            )}

            {activeTool === 'upscale' && (
                <UpscaleTool pdfFile={pdfFile} onFileFixed={(blob, name) => { if (onFileFixed) onFileFixed(blob, name); }} />
            )}
        </>
    );
}
