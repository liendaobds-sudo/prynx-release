// ============================================================
// DielineCanvas2D — SVG renderer cho bản vẽ khuôn bế 2D
// Hỗ trợ Zoom/Pan, phân biệt CUT/CREASE/BLEED bằng màu & nét
// ============================================================

import React, { useRef, useState, useCallback, useEffect } from 'react';
import { useBoxStore } from '../../store/useBoxStore';
import { DielineModel, PathSegment, Panel } from '../../lib/dieline/types';
import { buildChains, chainToSvgD, computeEnvelopeDims, deriveLegendTags } from '../../lib/dieline/sharedGeometry';
// Desktop: no auth/settings needed — all features available

// Màu sắc và style cho từng loại nét
// CUT dùng CSS variable để thích ứng light/dark theme
const PATH_STYLES: Record<string, { stroke: string; dashArray: string; width: number; label: string }> = {
    CUT: { stroke: 'var(--dt-cut-color, #ffffff)', dashArray: 'none', width: 0.8, label: 'Cắt' },
    CREASE: { stroke: '#ff4444', dashArray: '3,2', width: 0.5, label: 'Cấn' },
    BLEED: { stroke: '#4488ff', dashArray: '1,1', width: 0.3, label: 'Tràn lề' },
};

export default function DielineCanvas2D() {
    const { dieline } = useBoxStore();
    const isAdmin = true; // Desktop app: all features enabled
    const svgRef = useRef<SVGSVGElement>(null);
    const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
    const [isPanning, setIsPanning] = useState(false);
    const [panStart, setPanStart] = useState({ x: 0, y: 0 });
    const [showDimensions, setShowDimensions] = useState(true);
    const [showPanelLabels, setShowPanelLabels] = useState(false);
    const [showSegmentLabels, setShowSegmentLabels] = useState(false);
    const [showAnnotations, setShowAnnotations] = useState(true);

    // Auto-fit on dieline change
    useEffect(() => {
        if (dieline && svgRef.current) {
            const svg = svgRef.current;
            const rect = svg.getBoundingClientRect();
            const padding = 60;
            const scaleX = (rect.width - padding * 2) / dieline.boundingBox.width;
            const scaleY = (rect.height - padding * 2) / dieline.boundingBox.height;
            const scale = Math.min(scaleX, scaleY, 4);
            setTransform({
                x: (rect.width / 2) - (dieline.boundingBox.minX + dieline.boundingBox.width / 2) * scale,
                y: (rect.height / 2) + (dieline.boundingBox.minY + dieline.boundingBox.height / 2) * scale,
                scale,
            });
        }
    }, [dieline]);

    // Zoom — dùng native listener với { passive: false } để preventDefault thực sự chặn browser zoom
    const handleWheel = useCallback((e: WheelEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        const svg = svgRef.current;
        if (!svg) return;
        const rect = svg.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        setTransform((prev) => {
            const newScale = Math.max(0.1, Math.min(20, prev.scale * factor));
            return {
                scale: newScale,
                x: mx - (mx - prev.x) * (newScale / prev.scale),
                y: my - (my - prev.y) * (newScale / prev.scale),
            };
        });
    }, []);

    // Gắn native wheel listener với { passive: false } — React onWheel mặc định là passive nên preventDefault() bị bỏ qua
    useEffect(() => {
        const svg = svgRef.current;
        if (!svg) return;
        svg.addEventListener('wheel', handleWheel, { passive: false });
        return () => svg.removeEventListener('wheel', handleWheel);
    }, [handleWheel]);

    // Pan
    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        if (e.button === 0) {
            setIsPanning(true);
            setPanStart({ x: e.clientX - transform.x, y: e.clientY - transform.y });
        }
    }, [transform]);

    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        if (isPanning) {
            setTransform((prev) => ({
                ...prev,
                x: e.clientX - panStart.x,
                y: e.clientY - panStart.y,
            }));
        }
    }, [isPanning, panStart]);

    const handleMouseUp = useCallback(() => {
        setIsPanning(false);
    }, []);

    if (!dieline) {
        return <div className="dt-canvas-2d-empty">Nhập thông số để tạo khuôn bế</div>;
    }

    return (
        <div className="dt-canvas-2d-container" style={{ position: 'relative' }}>
            {/* Toolbar */}
            <div className="dt-canvas-toolbar">
                <button onClick={() => setShowDimensions(!showDimensions)} className="dt-toolbar-btn" title="Hiển thị kích thước">
                    📏 {showDimensions ? 'Ẩn' : 'Hiện'} kích thước
                </button>
                {isAdmin && (
                    <>
                        <button onClick={() => setShowPanelLabels(!showPanelLabels)} className="dt-toolbar-btn" title="Hiển thị tên các mặt">
                            {showPanelLabels ? '👁️' : '🚫'} Tên mặt
                        </button>
                        <button onClick={() => setShowSegmentLabels(!showSegmentLabels)} className="dt-toolbar-btn" title="Hiển thị tên từng đoạn cắt">
                            {showSegmentLabels ? '👁️' : '🚫'} Đoạn cắt
                        </button>
                        <button onClick={() => setShowAnnotations(!showAnnotations)} className="dt-toolbar-btn" title="Hiển thị chú thích điểm ảnh">
                            {showAnnotations ? '👁️' : '🚫'} Chú thích điểm
                        </button>
                    </>
                )}
                <span className="dt-zoom-info">🔍 {Math.round(transform.scale * 100)}%</span>
                <span className="dt-sheet-size">
                    Khổ trải: {dieline.boundingBox.width.toFixed(1)} × {dieline.boundingBox.height.toFixed(1)} mm
                </span>
                {/* Legend — chỉ hiển thị tag thực sự có trong file (phương án B) */}
                <div className="dt-legend">
                    {[...deriveLegendTags(dieline)].map((tag) => {
                        const style = PATH_STYLES[tag];
                        if (!style) return null;
                        return (
                            <span key={tag} className="dt-legend-item">
                                <span className="dt-legend-line" style={{ backgroundColor: style.stroke }} />
                                {style.label}
                            </span>
                        );
                    })}
                </div>
            </div>

            {/* SVG Canvas */}
            <svg
                ref={svgRef}
                className="dt-dieline-svg"
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
            >
                {/* Grid */}
                <defs>
                    <pattern id="dt-grid-small" width={10 * transform.scale} height={10 * transform.scale} patternUnits="userSpaceOnUse"
                        x={transform.x} y={transform.y}>
                        <path d={`M ${10 * transform.scale} 0 L 0 0 0 ${10 * transform.scale}`}
                            fill="none" stroke="var(--dt-grid-color, rgba(255,255,255,0.04))" strokeWidth="0.5" />
                    </pattern>
                    <pattern id="dt-grid-large" width={50 * transform.scale} height={50 * transform.scale} patternUnits="userSpaceOnUse"
                        x={transform.x} y={transform.y}>
                        <path d={`M ${50 * transform.scale} 0 L 0 0 0 ${50 * transform.scale}`}
                            fill="none" stroke="var(--dt-grid-major-color, rgba(255,255,255,0.08))" strokeWidth="0.5" />
                    </pattern>
                </defs>
                <rect width="100%" height="100%" fill="url(#dt-grid-small)" />
                <rect width="100%" height="100%" fill="url(#dt-grid-large)" />

                {/* Paths — chain segments liền mạch */}
                <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.scale}, ${-transform.scale})`}>
                    <ChainedPathRenderer paths={dieline.allPaths} />

                    {/* Dimension Annotations */}
                    {showDimensions && <DimensionAnnotations dieline={dieline} scale={transform.scale} showDetail={showDimensions} />}

                    {/* Panel Labels — hiện tên panel khi bật chi tiết */}
                    {showPanelLabels && <PanelLabels panels={dieline.panels} scale={transform.scale} />}

                    {/* Annotations — hiện chú thích góc/điểm */}
                    {showAnnotations && <PanelAnnotations panels={dieline.panels} scale={transform.scale} />}

                    {/* Segment Labels — đánh tên từng đoạn khi bật chi tiết */}
                    {showSegmentLabels && <SegmentLabels dieline={dieline} scale={transform.scale} />}
                </g>
            </svg>

            {/* 3D Preview Thumbnail — top-right corner */}
            <PreviewThumbnail boxType={dieline.params.boxType} />
        </div>
    );
}

/** Default preview labels per box type */
const DEFAULT_PREVIEWS: Record<string, { label: string }> = {
    rte: { label: 'Hộp Nắp Cài' },
    slb: { label: 'Hộp Đáy Gài' },
    gable: { label: 'Hộp Quai Xách' },
    paper_bag: { label: 'Túi Giấy SOS' },
    cup_sleeve: { label: 'Bọc Ly' },
    pizza: { label: 'Hộp Pizza' },
    envelope: { label: 'Bì Thư' },
    tray: { label: 'Hộp Diêm / Khay' },
};

/** Floating label thumbnail — góc trên phải canvas 2D (Desktop: no images, just label) */
function PreviewThumbnail({ boxType }: { boxType: string }) {
    const info = DEFAULT_PREVIEWS[boxType] || { label: boxType };
    return (
        <div className="dt-preview-thumbnail">
            <div className="dt-preview-placeholder">
                <span className="dt-preview-placeholder-icon">📦</span>
                <span className="dt-preview-placeholder-text">{info.label}</span>
            </div>
        </div>
    );
}

// ── Chain helpers: dùng chung từ sharedGeometry.ts (buildChains / chainToSvgD) ──

/** Renderer liền mạch — gom segments cùng tag + endpoint trùng thành 1 SVG path */
function ChainedPathRenderer({ paths }: { paths: PathSegment[] }) {
    const chains = React.useMemo(() => buildChains(paths), [paths]);
    return (
        <>
            {chains.map((chain, i) => {
                const style = PATH_STYLES[chain.tag] || PATH_STYLES.CUT;
                const d = chainToSvgD(chain.segs);
                return (
                    <path
                        key={i}
                        d={d}
                        fill="none"
                        stroke={style.stroke}
                        strokeWidth={style.width}
                        strokeDasharray={style.dashArray}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        vectorEffect="non-scaling-stroke"
                    />
                );
            })}
        </>
    );
}
/** Panel labels — hiện tên tại tâm mỗi panel */
function PanelLabels({ panels, scale }: { panels: Panel[]; scale: number }) {
    return (
        <g className="dt-panel-labels">
            {panels.map((panel) => {
                // Tính bounding box từ paths + pivotEdge
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                const addPoint = (p: { x: number; y: number }) => {
                    if (p.x < minX) minX = p.x;
                    if (p.y < minY) minY = p.y;
                    if (p.x > maxX) maxX = p.x;
                    if (p.y > maxY) maxY = p.y;
                };
                for (const path of panel.paths) {
                    for (const p of path.points) addPoint(p);
                }
                // Pivot edge = cạnh nối parent → quan trọng cho Front/Back/Lid
                if (panel.pivotEdge) {
                    addPoint(panel.pivotEdge[0]);
                    addPoint(panel.pivotEdge[1]);
                }
                if (!isFinite(minX)) return null;

                const cx = (minX + maxX) / 2;
                const cy = (minY + maxY) / 2;
                const fontSize = Math.max(6, Math.min(12, 8 / scale));

                return (
                    <text
                        key={panel.name}
                        x={cx}
                        y={cy}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fill="rgba(0, 200, 255, 0.35)"
                        fontSize={fontSize}
                        fontFamily="monospace"
                        fontWeight="600"
                        transform={`translate(${cx}, ${cy}) scale(1, -1) translate(${-cx}, ${-cy})`}
                        style={{ pointerEvents: 'none', userSelect: 'none' }}
                    >
                        {panel.label}
                    </text>
                );
            })}
        </g>
    );
}

/** Panel annotations — hiển thị các text phụ trợ cho từng điểm trên panel, có thể kéo thả */
function PanelAnnotations({ panels, scale }: { panels: Panel[]; scale: number }) {
    const [offsets, setOffsets] = React.useState<Record<string, {x: number, y: number}>>({});
    const [draggingId, setDraggingId] = React.useState<string | null>(null);

    React.useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!draggingId) return;
            setOffsets(prev => {
                const current = prev[draggingId] || {x: 0, y: 0};
                return {
                    ...prev,
                    [draggingId]: {
                        x: current.x + e.movementX / scale,
                        y: current.y - e.movementY / scale
                    }
                };
            });
        };
        const handleMouseUp = () => {
            setDraggingId(null);
        };
        if (draggingId) {
            window.addEventListener('mousemove', handleMouseMove);
            window.addEventListener('mouseup', handleMouseUp);
        }
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [draggingId, scale]);

    return (
        <g className="dt-panel-annotations">
            {panels.map((panel) => {
                if (!panel.annotations) return null;
                return panel.annotations.map((ann, i) => {
                    const key = `${panel.name}-ann-${i}`;
                    const offset = offsets[key] || {x: 0, y: 0};
                    const fontSize = Math.max(4, Math.min(10, 8 / scale));
                    const cx = ann.point.x + offset.x;
                    const cy = ann.point.y + offset.y;

                    return (
                        <g key={key}>
                            {/* Leader line from original point to dragged text center */}
                            <line 
                                x1={ann.point.x} y1={ann.point.y} 
                                x2={cx} y2={cy}
                                stroke="#ff00ff" strokeWidth={0.5 / scale} opacity={0.7}
                                style={{ pointerEvents: 'none' }} 
                            />
                            {/* Anchor dot at the original point */}
                            <circle 
                                cx={ann.point.x} cy={ann.point.y} r={fontSize * 0.3 / scale}
                                fill="#ff00ff" opacity={1} style={{ pointerEvents: 'none' }} 
                            />
                            {/* Draggable Text */}
                            <text
                                x={cx}
                                y={cy}
                                textAnchor={ann.anchor || 'middle'}
                                dominantBaseline={(ann.baseline || 'central') as any}
                                fill="#ff00ff"
                                fontSize={fontSize}
                                fontWeight="bold"
                                transform={`scale(1, -1) translate(0, ${-2 * cy})`}
                                style={{ 
                                    userSelect: 'none', 
                                    cursor: draggingId === key ? 'grabbing' : 'grab',
                                    paintOrder: 'stroke',
                                    stroke: '#ffffff',
                                    strokeWidth: fontSize * 0.2
                                }}
                                onMouseDown={(e) => {
                                    e.stopPropagation();
                                    setDraggingId(key);
                                }}
                            >
                                {ann.text}
                            </text>
                        </g>
                    );
                });
            })}
        </g>
    );
}

/** Segment labels — draggable, with leader lines + anchor dots */
function SegmentLabels({ dieline, scale }: { dieline: DielineModel; scale: number }) {
    const fontSize = Math.max(3, Math.min(6, 4 / scale));

    const pathLabelMap = React.useMemo(() => {
        const m = new Map<PathSegment, string>();
        for (const panel of dieline.panels) {
            panel.paths.forEach((seg, idx) => m.set(seg, `${panel.name}[${idx}]`));
        }
        let si = 0;
        for (const seg of dieline.allPaths) {
            if (!m.has(seg)) { m.set(seg, `#${si}`); si++; }
        }
        return m;
    }, [dieline]);

    const baseItems = React.useMemo(() => {
        const out: Array<{ label: string; mx: number; my: number; color: string }> = [];
        for (const seg of dieline.allPaths) {
            const label = pathLabelMap.get(seg) || '';
            let mx: number, my: number;
            if (seg.type === 'bezier' && seg.controlPoints) {
                const [p0, , , p3] = seg.controlPoints;
                mx = (p0.x + p3.x) / 2; my = (p0.y + p3.y) / 2;
            } else if (seg.points.length >= 2) {
                mx = (seg.points[0].x + seg.points[seg.points.length - 1].x) / 2;
                my = (seg.points[0].y + seg.points[seg.points.length - 1].y) / 2;
            } else continue;
            const color = seg.tag === 'CREASE' ? 'rgba(255,120,120,0.8)'
                : seg.tag === 'BLEED' ? 'rgba(100,160,255,0.8)' : 'rgba(0,255,150,0.9)';
            out.push({ label, mx, my, color });
        }
        return out;
    }, [dieline, pathLabelMap]);

    // Dragged offsets per label
    const [offsets, setOffsets] = React.useState<Record<number, { dx: number; dy: number }>>({});
    const [dragState, setDragState] = React.useState<{ idx: number; sx: number; sy: number; odx: number; ody: number; sc: number } | null>(null);

    const screenToSvg = React.useCallback((e: React.PointerEvent) => {
        const svg = (e.target as Element).closest('svg') as SVGSVGElement | null;
        if (!svg) return { x: 0, y: 0 };
        const ctm = svg.getScreenCTM();
        if (!ctm) return { x: 0, y: 0 };
        return { x: (e.clientX - ctm.e) / ctm.a, y: (e.clientY - ctm.f) / ctm.d };
    }, []);

    const onDown = React.useCallback((idx: number, e: React.PointerEvent) => {
        e.stopPropagation(); e.preventDefault();
        const off = offsets[idx] || { dx: 0, dy: 0 };
        const svg = (e.target as Element).closest('svg') as SVGSVGElement | null;
        const ctm = svg?.getScreenCTM();
        const sc = ctm ? Math.abs(ctm.a) : 1;
        setDragState({ idx, sx: e.clientX, sy: e.clientY, odx: off.dx, ody: off.dy, sc });
    }, [offsets]);

    React.useEffect(() => {
        if (!dragState) return;

        const onMove = (e: PointerEvent) => {
            const d = dragState;
            const dx = d.odx + (e.clientX - d.sx) / d.sc;
            const dy = d.ody - (e.clientY - d.sy) / d.sc;
            setOffsets(prev => ({ ...prev, [d.idx]: { dx, dy } }));
        };

        const onUp = () => {
            setDragState(null);
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
    }, [dragState]);

    return (
        <g className="dt-segment-labels">
            {baseItems.map((p, i) => {
                const off = offsets[i] || { dx: 0, dy: 0 };
                const lx = p.mx + off.dx;
                const ly = p.my + off.dy;
                const bgW = p.label.length * fontSize * 0.62;
                const bgH = fontSize * 1.3;
                return (
                    <g key={`sl-${i}`}>
                        {/* Leader line → segment midpoint */}
                        <line x1={lx} y1={ly} x2={p.mx} y2={p.my}
                            stroke={p.color} strokeWidth={0.15 / scale} opacity={0.5}
                            style={{ pointerEvents: 'none' }} />
                        {/* Anchor dot on segment */}
                        <circle cx={p.mx} cy={p.my} r={fontSize * 0.15 / scale}
                            fill={p.color} opacity={0.9} style={{ pointerEvents: 'none' }} />
                        {/* Background for readability */}
                        <rect x={lx - bgW / 2} y={ly - bgH / 2} width={bgW} height={bgH}
                            fill="rgba(0,0,0,0.7)" rx={fontSize * 0.15}
                            transform={`translate(${lx},${ly}) scale(1,-1) translate(${-lx},${-ly})`}
                            onPointerDown={e => onDown(i, e)}
                            style={{ cursor: 'grab' }} />
                        {/* Label text */}
                        <text x={lx} y={ly} textAnchor="middle" dominantBaseline="central"
                            fill={p.color} fontSize={fontSize} fontFamily="monospace" fontWeight="bold"
                            transform={`translate(${lx},${ly}) scale(1,-1) translate(${-lx},${-ly})`}
                            onPointerDown={e => onDown(i, e)}
                            style={{ cursor: 'grab', userSelect: 'none' }}>
                            {p.label}
                        </text>
                    </g>
                );
            })}
        </g>
    );
}

/** Đường đo kích thước tự động */
function DimensionAnnotations({ dieline, scale, showDetail }: { dieline: DielineModel; scale: number; showDetail: boolean }) {
    const { L, W, D, G, panelOrder, boxType } = dieline.params;

    // Cup sleeve không dùng dimension annotations của hộp
    if (boxType === 'cup_sleeve') return null;

    const bb = dieline.boundingBox;
    const fontSize = Math.max(8, 12 / scale);
    const offset = 8 / scale;
    const arrowSize = 3 / scale;

    // Helper: vẽ 1 dimension line
    const Dim = ({ x1, y1, x2, y2, label, side, color, small }: {
        x1: number; y1: number; x2: number; y2: number; label: string;
        side: 'top' | 'bottom' | 'left' | 'right'; color?: string; small?: boolean;
    }) => {
        const c = color || '#ffaa00';
        const fs = small ? Math.max(6, 9 / scale) : fontSize;
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        return (
            <g>
                <line x1={x1} y1={y1} x2={x2} y2={y2}
                    stroke={c} strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
                {side === 'top' || side === 'bottom' ? (
                    <>
                        <line x1={x1} y1={y1 - arrowSize} x2={x1} y2={y1 + arrowSize}
                            stroke={c} strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
                        <line x1={x2} y1={y2 - arrowSize} x2={x2} y2={y2 + arrowSize}
                            stroke={c} strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
                    </>
                ) : (
                    <>
                        <line x1={x1 - arrowSize} y1={y1} x2={x1 + arrowSize} y2={y1}
                            stroke={c} strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
                        <line x1={x2 - arrowSize} y1={y2} x2={x2 + arrowSize} y2={y2}
                            stroke={c} strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
                    </>
                )}
                <text x={mx} y={my}
                    fill={c}
                    fontSize={fs}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    transform={`scale(1, -1) translate(0, ${-2 * my})`}
                >
                    {label}
                </text>
            </g>
        );
    };

    // ── ENVELOPE: dimensions riêng ──
    if (boxType === 'envelope') {
        const { envW, envH, envStyle } = dieline.params;
        const isVertical = envStyle === 'pocket';
        const { FH, SF } = computeEnvelopeDims(dieline.params);
        const rightX = bb.maxX + offset * 3;
        const topY = bb.maxY + offset * 3;

        if (!isVertical) {
            // NGANG layout — vertical stacking
            const backShort = 5;
            return (
                <g className="dimensions">
                    <Dim x1={0} y1={topY} x2={envW} y2={topY} label={`W=${envW}`} side="top" />
                    <Dim x1={rightX} y1={backShort} x2={rightX} y2={envH} label={`${envH - backShort}`} side="right" color="#999" small />
                    <Dim x1={rightX + offset * 3} y1={envH} x2={rightX + offset * 3} y2={envH + envH} label={`H=${envH}`} side="right" />
                    <Dim x1={rightX} y1={envH + envH} x2={rightX} y2={envH + envH + FH} label={`FH=${FH}`} side="right" color="#66ccff" small />
                    <Dim x1={-SF} y1={topY + offset} x2={0} y2={topY + offset} label={`SF=${SF}`} side="top" color="#66ccff" small />
                </g>
            );
        } else {
            // DỌC layout — Back(trái)|Front(phải), Seal(trên), Tai(phải+dưới)
            // Internal: W=envH (panel width), H=envW (panel height)
            const pW = envH;  // panel width (swapped)
            const pH = envW;  // panel height (swapped)
            return (
                <g className="dimensions">
                    {/* Back panel width */}
                    <Dim x1={0} y1={topY} x2={pW} y2={topY} label={`${envH}`} side="top" color="#999" small />
                    {/* Front panel width */}
                    <Dim x1={pW} y1={topY + offset} x2={pW + pW} y2={topY + offset} label={`H=${envH}`} side="top" />
                    {/* Panel height */}
                    <Dim x1={rightX} y1={0} x2={rightX} y2={pH} label={`W=${envW}`} side="right" />
                    {/* Seal flap height */}
                    <Dim x1={rightX} y1={pH} x2={rightX} y2={pH + FH} label={`FH=${FH}`} side="right" color="#66ccff" small />
                    {/* Side flap right */}
                    <Dim x1={pW + pW} y1={topY + offset} x2={pW + pW + SF} y2={topY + offset} label={`SF=${SF}`} side="top" color="#66ccff" small />
                </g>
            );
        }
    }

    // ── PIZZA BOX: layout dọc (Front|Bottom|Back|Lid theo Y, Side Walls theo X) ──
    if (boxType === 'pizza') {
        const yFrontBot = -D;
        const yBottomBot = 0;
        const yBackTop = W + D;
        const yLidTop = W + D + W;

        const rightX = bb.maxX + offset * 3;

        return (
            <g className="dimensions">
                {/* Panel heights trên Y (phải) */}
                <Dim x1={rightX} y1={yFrontBot} x2={rightX} y2={yBottomBot} label={`D=${D}`} side="right" />
                <Dim x1={rightX + offset * 3} y1={yBottomBot} x2={rightX + offset * 3} y2={W} label={`W=${W}`} side="right" />
                <Dim x1={rightX} y1={W} x2={rightX} y2={yBackTop} label={`D=${D}`} side="right" />
                <Dim x1={rightX + offset * 3} y1={yBackTop} x2={rightX + offset * 3} y2={yLidTop} label={`W=${W}`} side="right" />
                {/* L trên X (trên) */}
                <Dim x1={0} y1={bb.maxY + offset * 3} x2={L} y2={bb.maxY + offset * 3} label={`L=${L}`} side="top" />
                {/* Side wall D trên X */}
                <Dim x1={-D} y1={bb.maxY + offset * 6} x2={0} y2={bb.maxY + offset * 6} label={`D=${D}`} side="top" color="#66ccff" small />
                <Dim x1={L} y1={bb.maxY + offset * 6} x2={L + D} y2={bb.maxY + offset * 6} label={`D=${D}`} side="top" color="#66ccff" small />
            </g>
        );
    }

    // ── TRAY (Matchbox): 5-layer double-wall structure ──
    if (boxType === 'tray') {
        const tG = dieline.params.G;  // beam width
        const tTH = dieline.params.TH; // tab height
        const T = dieline.params.T;
        const clearance = 1; // sleeve clearance (matches MatchboxSleeve.ts)

        // ── Tray-only bounding box (exclude sleeve panels) ──
        const trayPanels = dieline.panels.filter(p => !p.name.startsWith('sleeve_'));
        let tMinX = Infinity, tMinY = Infinity, tMaxX = -Infinity, tMaxY = -Infinity;
        for (const panel of trayPanels) {
            for (const path of panel.paths) {
                for (const p of path.points) {
                    if (p.x < tMinX) tMinX = p.x;
                    if (p.y < tMinY) tMinY = p.y;
                    if (p.x > tMaxX) tMaxX = p.x;
                    if (p.y > tMaxY) tMaxY = p.y;
                }
            }
        }

        // ── Sleeve bounding box ──
        const sleevePanels = dieline.panels.filter(p => p.name.startsWith('sleeve_'));
        let sMinX = Infinity, sMinY = Infinity, sMaxX = -Infinity, sMaxY = -Infinity;
        for (const panel of sleevePanels) {
            for (const path of panel.paths) {
                for (const p of path.points) {
                    if (p.x < sMinX) sMinX = p.x;
                    if (p.y < sMinY) sMinY = p.y;
                    if (p.x > sMaxX) sMaxX = p.x;
                    if (p.y > sMaxY) sMaxY = p.y;
                }
            }
        }
        const hasSleeve = isFinite(sMinX);

        // ── Sleeve panel Y positions (for breakdown dims) ──
        const sL = L + clearance;
        const sW = W + clearance;
        const sD = D + clearance;
        const sG = Math.min(dieline.params.sleeveGlue ?? 15, sD / 2); // sleeve glue flap width

        // Tray dimension positions
        const trayTopY = tMaxY + offset * 3;
        const trayRightX = tMaxX + offset * 3;

        // Sleeve dimension positions
        const sleeveTopY = hasSleeve ? sMaxY + offset * 3 : 0;
        const sleeveRightX = hasSleeve ? sMaxX + offset * 3 : 0;

        return (
            <g className="dimensions">
                {/* ══ KHAY (Tray) ══ */}
                {/* L dimension (top, across bottom panel) */}
                <Dim x1={0} y1={trayTopY} x2={L} y2={trayTopY} label={`L=${L}`} side="top" />
                {/* W dimension (right, across bottom panel) */}
                <Dim x1={trayRightX} y1={0} x2={trayRightX} y2={W} label={`W=${W}`} side="right" />
                {/* D = wall height (right, front wall) */}
                <Dim x1={trayRightX + offset * 3} y1={W} x2={trayRightX + offset * 3} y2={W + D} label={`D=${D}`} side="right" color="#66ccff" small />
                {/* G = beam (right) */}
                <Dim x1={trayRightX} y1={W + D} x2={trayRightX} y2={W + D + tG} label={`G=${tG}`} side="right" color="#88ee88" small />
                {/* TH = tab (right) */}
                <Dim x1={trayRightX} y1={W + D + tG + (D - 2 * T)} x2={trayRightX} y2={W + D + tG + (D - 2 * T) + tTH} label={`TH=${tTH}`} side="right" color="#88ee88" small />
            </g>
        );
    }

    // ── RTE / SLB / Gable / Paper Bag: layout WLWL / LWLW ──
    // Panel widths theo panelOrder
    const pw = panelOrder === 'LWLW' ? [L, W, L, W] : [W, L, W, L];
    const pl = panelOrder === 'LWLW'
        ? [`L=${L}`, `W=${W}`, `L=${L}`, `W=${W}`]
        : [`W=${W}`, `L=${L}`, `W=${W}`, `L=${L}`];

    const { glueSide } = dieline.params;
    const glueIsLeft = glueSide === 'left';

    const topY = bb.maxY + offset * 3;
    // BUG-2 fix: Correctly compute x positions based on glueSide
    const glueOffset = glueIsLeft ? G : 0;
    const x_p1 = glueOffset;
    const x_p2 = glueOffset + pw[0];
    const x_p3 = glueOffset + pw[0] + pw[1];
    const x_p4 = glueOffset + pw[0] + pw[1] + pw[2];
    const x_p5 = glueOffset + pw[0] + pw[1] + pw[2] + pw[3];
    // Glue flap position
    const x_gL = glueIsLeft ? 0 : x_p5;
    const x_gR = glueIsLeft ? G : x_p5 + G;

    // === Gable-specific dimensions ===
    const isGable = boxType === 'gable';
    const isFrontFirst = panelOrder === 'LWLW';
    const xFrontL = isFrontFirst ? x_p1 : x_p2;
    const xFrontR = isFrontFirst ? x_p2 : x_p3;
    const frontW = xFrontR - xFrontL; // = L

    const h1 = W / 2;
    const AB_w = Math.round(5 / 6 * frontW * 10) / 10;
    const inset1 = (frontW - AB_w) / 2;
    const h2 = Math.round(0.9 * h1 * 10) / 10;

    const yTop = D;
    const yAB = yTop + h1;
    const yEF = yAB + h2;

    const aX = xFrontL + inset1;
    const bX = xFrontR - inset1;
    const EF_w = Math.round(2 / 3 * AB_w * 10) / 10;
    const inset2 = (AB_w - EF_w) / 2;
    const eX = aX + inset2;
    const fX = bX - inset2;
    const tabW = Math.round(AB_w / 9 * 10) / 10;
    const holeWVal = Math.round(2 / 5 * AB_w * 10) / 10;
    const holeHVal = Math.round(h2 / 2 * 10) / 10;
    const holeCX = (aX + bX) / 2;
    const holeLeft = holeCX - holeWVal / 2;
    const holeRight = holeCX + holeWVal / 2;
    const holeTopY = yAB + holeHVal;

    const isPaperBag = boxType === 'paper_bag';
    const bottomOffset = isPaperBag ? (dieline.params.BF > 0 ? dieline.params.BF : Math.round(W * 0.85)) : 0;

    return (
        <g className="dimensions">
            <Dim x1={x_gL} y1={topY} x2={x_gR} y2={topY} label={`G=${G}`} side="top" />
            <Dim x1={x_p1} y1={topY + offset} x2={x_p2} y2={topY + offset} label={pl[0]} side="top" />
            <Dim x1={x_p2} y1={topY} x2={x_p3} y2={topY} label={pl[1]} side="top" />
            <Dim x1={x_p3} y1={topY + offset} x2={x_p4} y2={topY + offset} label={pl[2]} side="top" />
            <Dim x1={x_p4} y1={topY} x2={x_p5} y2={topY} label={pl[3]} side="top" />
            <Dim x1={bb.maxX + offset * 3} y1={bottomOffset} x2={bb.maxX + offset * 3} y2={bottomOffset + D} label={`D=${D}`} side="right" />

            {/* Gable detail dimensions */}
            {isGable && showDetail && (
                <>
                    {/* Chiều cao hình thang dưới W/2 */}
                    <Dim x1={bb.maxX + offset * 6} y1={yTop} x2={bb.maxX + offset * 6} y2={yAB}
                        label={`${h1}`} side="right" color="#66ccff" small />
                    {/* Chiều cao hình thang trên h2 */}
                    <Dim x1={bb.maxX + offset * 9} y1={yAB} x2={bb.maxX + offset * 9} y2={yEF}
                        label={`${h2}`} side="right" color="#66ccff" small />
                    {/* Tổng chiều cao gable */}
                    <Dim x1={bb.maxX + offset * 12} y1={yTop} x2={bb.maxX + offset * 12} y2={yEF}
                        label={`${Math.round((h1 + h2) * 10) / 10}`} side="right" color="#66ccff" small />
                    {/* AB width */}
                    <Dim x1={aX} y1={yAB - offset} x2={bX} y2={yAB - offset}
                        label={`${AB_w}`} side="top" color="#66ccff" small />
                    {/* EF width */}
                    <Dim x1={eX} y1={yEF + offset} x2={fX} y2={yEF + offset}
                        label={`${EF_w}`} side="top" color="#66ccff" small />
                    {/* Tab width */}
                    <Dim x1={aX} y1={yAB + offset * 2} x2={aX + tabW} y2={yAB + offset * 2}
                        label={`${tabW}`} side="top" color="#66ccff" small />
                    {/* Hole width */}
                    <Dim x1={holeLeft} y1={holeTopY + offset} x2={holeRight} y2={holeTopY + offset}
                        label={`${holeWVal}`} side="top" color="#88ee88" small />
                    {/* Hole height */}
                    <Dim x1={holeLeft - offset * 2} y1={yAB} x2={holeLeft - offset * 2} y2={holeTopY}
                        label={`${holeHVal}`} side="left" color="#88ee88" small />
                </>
            )}
        </g>
    );
}
