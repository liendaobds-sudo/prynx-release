import React, { useState, useEffect, useRef } from 'react';
import {
    CheckCircle2,
    AlertTriangle,
    AlertCircle,
    X,
    ChevronDown,
    ChevronUp,
    Palette,
    Type,
    Image as ImageIcon,
    Sliders,
    Sparkles,
} from 'lucide-react';
import type { InstantPreflightResult, InstantPreflightIssue } from '../../lib/instantPreflight';

interface InstantPreflightHudProps {
    result: InstantPreflightResult | null;
    onDismiss: () => void;
    onOpenTool?: (toolName: 'hairlines' | 'convertColors' | 'preflight') => void;
}

/**
 * UIUX (Phase 2): Instant Preflight HUD (Heads-Up Display)
 * Hiển thị tức thì thanh cảnh báo lỗi chế bản khi người dùng vừa lưu file từ Illustrator/CorelDRAW:
 * - CMYK / RGB / Spot color
 * - Chữ Rich Black (đen 4 màu)
 * - Nét mảnh Hairline (< 0.1pt)
 * - Ảnh Low-res (< 150 DPI)
 */
export const InstantPreflightHud: React.FC<InstantPreflightHudProps> = ({
    result,
    onDismiss,
    onOpenTool,
}) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const [isHovered, setIsHovered] = useState(false);
    const dismissTimerRef = useRef<NodeJS.Timeout | null>(null);

    // Tự động đóng sau 6 giây nếu người dùng không tương tác (không rê chuột và không mở rộng)
    useEffect(() => {
        if (!result) return;

        if (dismissTimerRef.current) {
            clearTimeout(dismissTimerRef.current);
            dismissTimerRef.current = null;
        }

        if (!isHovered && !isExpanded) {
            dismissTimerRef.current = setTimeout(() => {
                onDismiss();
            }, 6000);
        }

        return () => {
            if (dismissTimerRef.current) {
                clearTimeout(dismissTimerRef.current);
            }
        };
    }, [result, isHovered, isExpanded, onDismiss]);

    if (!result) return null;

    const { summary, issues, hasErrors, hasWarnings, scanDurationMs } = result;
    const isClean = !hasErrors && !hasWarnings;

    // Phân nhóm issues
    const hairlineIssues = issues.filter(i => i.type === 'hairline');
    const richBlackIssues = issues.filter(i => i.type === 'rich_black');
    const lowResIssues = issues.filter(i => i.type === 'low_res_image');
    const rgbIssues = issues.filter(i => i.type === 'rgb_color');
    const spotIssues = issues.filter(i => i.type === 'spot_color');

    return (
        <div
            className="fixed bottom-9 right-5 z-50 transition-all duration-300 ease-out select-none"
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
        >
            <div
                className={`flex flex-col backdrop-blur-xl border shadow-2xl rounded-2xl overflow-hidden transition-all duration-300 ${
                    hasErrors
                        ? 'bg-slate-900/95 border-red-500/40 text-slate-100 shadow-red-950/30'
                        : hasWarnings
                        ? 'bg-slate-900/95 border-amber-500/40 text-slate-100 shadow-amber-950/30'
                        : 'bg-slate-900/90 border-emerald-500/40 text-slate-100 shadow-emerald-950/20'
                } ${isExpanded ? 'w-96' : 'max-w-lg'}`}
            >
                {/* ── Compact Bar Header ── */}
                <div
                    className="flex items-center gap-2.5 px-3.5 py-2.5 cursor-pointer hover:bg-white/5 transition-colors"
                    onClick={() => setIsExpanded(!isExpanded)}
                >
                    {/* Status Icon */}
                    <div className="shrink-0 flex items-center justify-center">
                        {hasErrors ? (
                            <AlertCircle className="w-5 h-5 text-red-400 animate-pulse" />
                        ) : hasWarnings ? (
                            <AlertTriangle className="w-5 h-5 text-amber-400" />
                        ) : (
                            <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                        )}
                    </div>

                    {/* Headline text */}
                    <div className="flex-1 min-w-0 flex items-center gap-2">
                        <span className="text-xs font-semibold tracking-wide">
                            {isClean ? 'Đã cập nhật' : hasErrors ? 'Lỗi chế bản' : 'Cảnh báo in ấn'}
                        </span>
                        <span className="text-white/30 text-xs">·</span>
                        <span className="text-xs text-slate-300 truncate">
                            {isClean
                                ? 'CMYK chuẩn · Sắc nét · 0 lỗi'
                                : `${issues.length} vấn đề cần lưu ý (${
                                      hasWarnings ? 'Rich Black / Nét mảnh' : 'Lỗi kỹ thuật'
                                  })`}
                        </span>
                    </div>

                    {/* Expand/Collapse Chevron & Close */}
                    <div className="flex items-center gap-1 shrink-0 ml-1">
                        <button
                            type="button"
                            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
                            onClick={e => {
                                e.stopPropagation();
                                setIsExpanded(!isExpanded);
                            }}
                            title={isExpanded ? 'Thu gọn' : 'Xem chi tiết'}
                        >
                            {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
                        </button>
                        <button
                            type="button"
                            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
                            onClick={e => {
                                e.stopPropagation();
                                onDismiss();
                            }}
                            title="Đóng thông báo"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                </div>

                {/* ── Expanded Details Card ── */}
                {isExpanded && (
                    <div className="px-4 pb-3.5 pt-1 border-t border-white/10 flex flex-col gap-2.5 text-xs">
                        {/* Summary grid */}
                        <div className="grid grid-cols-2 gap-2 mt-1">
                            {/* Color Mode */}
                            <div className="bg-white/5 rounded-xl p-2 flex items-center gap-2 border border-white/5">
                                <Palette className="w-4 h-4 text-blue-400 shrink-0" />
                                <div className="min-w-0">
                                    <div className="text-[10px] text-slate-400 font-medium">Hệ màu</div>
                                    <div className="font-semibold text-slate-200 truncate">
                                        {summary.colorMode} {summary.hasRgb ? '(Có RGB)' : ''}
                                    </div>
                                </div>
                            </div>

                            {/* Spot Colors / Khuôn bế */}
                            <div className="bg-white/5 rounded-xl p-2 flex items-center gap-2 border border-white/5">
                                <Sparkles className="w-4 h-4 text-purple-400 shrink-0" />
                                <div className="min-w-0">
                                    <div className="text-[10px] text-slate-400 font-medium">Spot Color</div>
                                    <div className="font-semibold text-slate-200 truncate" title={summary.spotColors.join(', ')}>
                                        {summary.spotColors.length > 0 ? summary.spotColors.join(', ') : 'Không có'}
                                    </div>
                                </div>
                            </div>

                            {/* Hairlines */}
                            <div className="bg-white/5 rounded-xl p-2 flex items-center gap-2 border border-white/5">
                                <Sliders className="w-4 h-4 text-amber-400 shrink-0" />
                                <div className="min-w-0">
                                    <div className="text-[10px] text-slate-400 font-medium">Nét mảnh &lt;0.1pt</div>
                                    <div
                                        className={`font-semibold truncate ${
                                            summary.hairlineCount > 0 ? 'text-amber-300 font-bold' : 'text-slate-200'
                                        }`}
                                    >
                                        {summary.hairlineCount > 0
                                            ? `${summary.hairlineCount} nét (min ${summary.minHairlineWidthPt?.toFixed(2)} pt)`
                                            : '0 (Chuẩn)'}
                                    </div>
                                </div>
                            </div>

                            {/* Rich Black Text */}
                            <div className="bg-white/5 rounded-xl p-2 flex items-center gap-2 border border-white/5">
                                <Type className="w-4 h-4 text-emerald-400 shrink-0" />
                                <div className="min-w-0">
                                    <div className="text-[10px] text-slate-400 font-medium">Chữ Rich Black</div>
                                    <div
                                        className={`font-semibold truncate ${
                                            summary.richBlackCount > 0 ? 'text-amber-300 font-bold' : 'text-slate-200'
                                        }`}
                                    >
                                        {summary.richBlackCount > 0 ? `${summary.richBlackCount} cụm chữ` : '0 (Chuẩn K)'}
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Detailed Issues List */}
                        {issues.length > 0 && (
                            <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto pr-1 mt-1">
                                {issues.map((issue, idx) => (
                                    <div
                                        key={idx}
                                        className={`p-2 rounded-lg border text-[11px] flex flex-col gap-0.5 ${
                                            issue.severity === 'error'
                                                ? 'bg-red-500/10 border-red-500/20 text-red-200'
                                                : issue.severity === 'warning'
                                                ? 'bg-amber-500/10 border-amber-500/20 text-amber-200'
                                                : 'bg-blue-500/10 border-blue-500/20 text-blue-200'
                                        }`}
                                    >
                                        <div className="flex items-center justify-between font-semibold">
                                            <span className="flex items-center gap-1.5">
                                                <span>{issue.title}</span>
                                                <span className="text-[10px] opacity-70 font-normal">
                                                    (Trang {issue.page})
                                                </span>
                                            </span>
                                            {issue.metric && (
                                                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-black/30">
                                                    {issue.metric}
                                                </span>
                                            )}
                                        </div>
                                        <div className="opacity-90 leading-tight text-[10.5px]">
                                            {issue.description}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Action buttons */}
                        <div className="flex items-center justify-between pt-1 border-t border-white/5 text-[11px] text-slate-400">
                            <span>Quét nhanh trong {scanDurationMs}ms</span>
                            <div className="flex items-center gap-2">
                                {summary.hairlineCount > 0 && onOpenTool && (
                                    <button
                                        type="button"
                                        className="px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 font-medium transition-colors"
                                        onClick={() => onOpenTool('hairlines')}
                                    >
                                        Sửa nét mảnh
                                    </button>
                                )}
                                {summary.hasRgb && onOpenTool && (
                                    <button
                                        type="button"
                                        className="px-2.5 py-1 rounded-lg bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 font-medium transition-colors"
                                        onClick={() => onOpenTool('convertColors')}
                                    >
                                        Chuyển CMYK
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};
