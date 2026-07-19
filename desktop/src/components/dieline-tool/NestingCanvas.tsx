// ============================================================
// NestingCanvas — SVG preview xếp khuôn vào khổ in
// Hiển thị tờ giấy, lề, và các khuôn bế đã xếp
// ============================================================

import React, { useRef, useCallback, useEffect, useState, useMemo } from 'react';
import { useBoxStore } from '../../store/useBoxStore';
import { PathSegment } from '../../lib/dieline/types';
import { svgPlacementTransform } from '../../lib/dieline/placementTransform';

// ── CQ-2: Theme-aware tag styles with MutationObserver ──────

const useTagStyles = () => {
    const [cutColor, setCutColor] = useState('#222222');

    useEffect(() => {
        const readColor = () => {
            const root = document.querySelector('.dieline-tool');
            if (root) {
                const color = getComputedStyle(root).getPropertyValue('--dt-cut-color').trim();
                if (color) setCutColor(color);
            }
        };
        readColor();

        // Re-read khi theme (class trên html/body) thay đổi
        const observer = new MutationObserver(readColor);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
    }, []);

    return useMemo(() => ({
        CUT: { stroke: cutColor, width: 0.3 },
        CREASE: { stroke: '#ff4444', width: 0.2, dashArray: '2,1' },
        BLEED: { stroke: '#4488ff', width: 0.15, dashArray: '1,1' },
    } as Record<string, { stroke: string; width: number; dashArray?: string }>), [cutColor]);
};

// ── CQ-1: Transform helper for rotation ─────────────────────

function calcDielineTransform(
    pos: { x: number; y: number; rotation: number },
    bb: { minX: number; minY: number; width: number; height: number; maxX?: number; maxY?: number },
): string {
    return svgPlacementTransform(pos, {
        ...bb,
        maxX: bb.maxX ?? bb.minX + bb.width,
        maxY: bb.maxY ?? bb.minY + bb.height,
    });
}

// ── Build fill path — closed polygon per panel ──────────────
// Each panel's paths + pivotEdge form a closed shape.
// We chain them into a polygon and output one SVG sub-path per panel.

import { Panel } from '../../lib/dieline/types';
import { useTranslation } from 'react-i18next';

interface Pt { x: number; y: number }

function segStart(seg: PathSegment): Pt {
    if (seg.type === 'bezier' && seg.controlPoints) return seg.controlPoints[0];
    return seg.points[0];
}

function segEnd(seg: PathSegment): Pt {
    if (seg.type === 'bezier' && seg.controlPoints) return seg.controlPoints[3];
    if (seg.type === 'arc') return seg.points[seg.points.length - 1];
    return seg.points[seg.points.length - 1];
}

function ptsClose(a: Pt, b: Pt, tol = 0.5): boolean {
    return Math.abs(a.x - b.x) < tol && Math.abs(a.y - b.y) < tol;
}

function segToSvg(seg: PathSegment, isFirst: boolean): string {
    if (seg.type === 'bezier' && seg.controlPoints) {
        const [p0, cp1, cp2, p3] = seg.controlPoints;
        const prefix = isFirst ? `M ${p0.x} ${p0.y} ` : '';
        return `${prefix}C ${cp1.x} ${cp1.y} ${cp2.x} ${cp2.y} ${p3.x} ${p3.y}`;
    }
    if (seg.type === 'arc') {
        const pts = seg.points;
        if (pts.length === 0) return '';
        const prefix = isFirst ? `M ${pts[0].x} ${pts[0].y} ` : '';
        return prefix + pts.slice(1).map(p => `L ${p.x} ${p.y}`).join(' ');
    }
    const [p1, p2] = seg.points;
    return isFirst ? `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}` : `L ${p2.x} ${p2.y}`;
}

function reverseSegment(seg: PathSegment): PathSegment {
    if (seg.type === 'bezier' && seg.controlPoints) {
        const [p0, cp1, cp2, p3] = seg.controlPoints;
        return { ...seg, points: [p3, cp2, cp1, p0], controlPoints: [p3, cp2, cp1, p0] };
    }
    return { ...seg, points: [...seg.points].reverse() };
}

/** Chain an array of segments into a connected sequence */
function chainSegments(segs: PathSegment[]): PathSegment[] {
    if (segs.length === 0) return [];
    const used = new Array(segs.length).fill(false);
    const chain: PathSegment[] = [segs[0]];
    used[0] = true;

    let changed = true;
    while (changed) {
        changed = false;
        const tail = segEnd(chain[chain.length - 1]);
        for (let i = 0; i < segs.length; i++) {
            if (used[i]) continue;
            if (ptsClose(tail, segStart(segs[i]))) {
                chain.push(segs[i]); used[i] = true; changed = true; break;
            }
            if (ptsClose(tail, segEnd(segs[i]))) {
                chain.push(reverseSegment(segs[i])); used[i] = true; changed = true; break;
            }
        }
        if (!changed) {
            const head = segStart(chain[0]);
            for (let i = 0; i < segs.length; i++) {
                if (used[i]) continue;
                if (ptsClose(head, segEnd(segs[i]))) {
                    chain.unshift(segs[i]); used[i] = true; changed = true; break;
                }
                if (ptsClose(head, segStart(segs[i]))) {
                    chain.unshift(reverseSegment(segs[i])); used[i] = true; changed = true; break;
                }
            }
        }
    }
    return chain;
}

function buildPanelFillPaths(panels: Panel[]): string {
    const parts: string[] = [];

    for (const panel of panels) {
        // Collect bbox from ALL points (for fallback)
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let hasPoints = false;
        for (const seg of panel.paths) {
            const points = seg.type === 'bezier' && seg.controlPoints
                ? seg.controlPoints : seg.points;
            for (const p of points) {
                if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
                if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
                hasPoints = true;
            }
        }
        if (panel.pivotEdge) {
            for (const p of panel.pivotEdge) {
                if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
                if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
                hasPoints = true;
            }
        }
        if (!hasPoints || maxX - minX < 0.1 || maxY - minY < 0.1) continue;

        // Try polygon: chain ALL paths + pivotEdge
        const segs = [...panel.paths];
        if (panel.pivotEdge) {
            const [a, b] = panel.pivotEdge;
            segs.push({ points: [a, b], tag: 'CREASE', type: 'line' } as PathSegment);
        }

        const chain = chainSegments(segs);
        if (chain.length >= 3) {
            const start = segStart(chain[0]);
            const end = segEnd(chain[chain.length - 1]);
            if (ptsClose(start, end, 1.0)) {
                // Closed polygon → accurate shape (flaps, body panels)
                const d = chain.map((seg, i) => segToSvg(seg, i === 0)).join(' ');
                parts.push(d + ' Z');
                continue;
            }
        }

        // Fallback: bbox rectangle (closure panels with slit dead-ends)
        parts.push(
            `M ${minX} ${minY} L ${maxX} ${minY} L ${maxX} ${maxY} L ${minX} ${maxY} Z`
        );
    }

    return parts.join(' ');
}


// ── SVG path renderer (used inside <defs>) ──────────────────

function MiniPathRenderer({ path, tagStyles }: { path: PathSegment; tagStyles: Record<string, { stroke: string; width: number; dashArray?: string }> }) {
    const style = tagStyles[path.tag] || tagStyles.CUT;
    if (path.points.length === 2) {
        return (
            <line
                x1={path.points[0].x} y1={path.points[0].y}
                x2={path.points[1].x} y2={path.points[1].y}
                stroke={style.stroke} strokeWidth={style.width}
                strokeDasharray={style.dashArray}
                vectorEffect="non-scaling-stroke"
            />
        );
    }
    if (path.type === 'bezier' && path.controlPoints) {
        const [p0, cp1, cp2, p3] = path.controlPoints;
        return (
            <path
                d={`M ${p0.x} ${p0.y} C ${cp1.x} ${cp1.y} ${cp2.x} ${cp2.y} ${p3.x} ${p3.y}`}
                fill="none" stroke={style.stroke} strokeWidth={style.width}
                strokeDasharray={style.dashArray} vectorEffect="non-scaling-stroke"
            />
        );
    }
    const d = path.points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
    return (
        <path d={d} fill="none" stroke={style.stroke} strokeWidth={style.width}
            strokeDasharray={style.dashArray} vectorEffect="non-scaling-stroke" />
    );
}

export default function NestingCanvas() {
  const { t } = useTranslation();
    const { dieline, nestingConfig, nestingResult, sleeveNestingResult, params } = useBoxStore();
    const tagStyles = useTagStyles();
    const svgRef = useRef<SVGSVGElement>(null);

    // ── CQ-3: useRef for pan state to avoid stale closures ──
    const transformRef = useRef({ x: 0, y: 0, scale: 1 });
    const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
    const isPanningRef = useRef(false);
    const panStartRef = useRef({ x: 0, y: 0 });

    // Sync ref when state changes
    const updateTransform = useCallback((newT: { x: number; y: number; scale: number }) => {
        transformRef.current = newT;
        setTransform(newT);
    }, []);

    // Auto-fit on first render or when result changes
    useEffect(() => {
        if (!nestingResult || !svgRef.current) return;
        const svg = svgRef.current;
        const rect = svg.getBoundingClientRect();
        const { actualSheet } = nestingResult;
        const padding = 40;
        const scaleX = (rect.width - padding * 2) / actualSheet.width;
        const scaleY = (rect.height - padding * 2) / actualSheet.height;
        const scale = Math.min(scaleX, scaleY, 3);
        const x = (rect.width - actualSheet.width * scale) / 2;
        const y = (rect.height - actualSheet.height * scale) / 2;
        updateTransform({ x, y, scale });
    }, [nestingResult, updateTransform]);

    // Zoom (wheel)
    useEffect(() => {
        const svg = svgRef.current;
        if (!svg) return;
        const handleWheel = (e: WheelEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const factor = e.deltaY > 0 ? 0.9 : 1.1;
            const rect = svg.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            const prev = transformRef.current;
            const newScale = Math.max(0.1, Math.min(10, prev.scale * factor));
            updateTransform({
                scale: newScale,
                x: mx - (mx - prev.x) * (newScale / prev.scale),
                y: my - (my - prev.y) * (newScale / prev.scale),
            });
        };
        svg.addEventListener('wheel', handleWheel, { passive: false });
        return () => svg.removeEventListener('wheel', handleWheel);
    }, [updateTransform]);

    // ── Pan (mouse) ──
    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        if (e.button === 0) {
            isPanningRef.current = true;
            panStartRef.current = { x: e.clientX - transformRef.current.x, y: e.clientY - transformRef.current.y };
        }
    }, []);
    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        if (isPanningRef.current) {
            updateTransform({
                ...transformRef.current,
                x: e.clientX - panStartRef.current.x,
                y: e.clientY - panStartRef.current.y,
            });
        }
    }, [updateTransform]);
    const handleMouseUp = useCallback(() => { isPanningRef.current = false; }, []);

    // ── MISS-6: Touch support (pinch-zoom + pan) ──
    const lastTouchRef = useRef<{ x: number; y: number; dist: number } | null>(null);

    useEffect(() => {
        const svg = svgRef.current;
        if (!svg) return;

        const getTouchCenter = (touches: TouchList) => ({
            x: (touches[0].clientX + (touches[1]?.clientX ?? touches[0].clientX)) / (touches.length > 1 ? 2 : 1),
            y: (touches[0].clientY + (touches[1]?.clientY ?? touches[0].clientY)) / (touches.length > 1 ? 2 : 1),
        });
        const getTouchDist = (touches: TouchList) => {
            if (touches.length < 2) return 0;
            const dx = touches[0].clientX - touches[1].clientX;
            const dy = touches[0].clientY - touches[1].clientY;
            return Math.sqrt(dx * dx + dy * dy);
        };

        const onTouchStart = (e: TouchEvent) => {
            e.preventDefault();
            const center = getTouchCenter(e.touches);
            lastTouchRef.current = { x: center.x, y: center.y, dist: getTouchDist(e.touches) };
        };
        const onTouchMove = (e: TouchEvent) => {
            e.preventDefault();
            if (!lastTouchRef.current) return;
            const center = getTouchCenter(e.touches);
            const prev = transformRef.current;

            if (e.touches.length >= 2) {
                // Pinch zoom
                const newDist = getTouchDist(e.touches);
                const oldDist = lastTouchRef.current.dist;
                if (oldDist > 0 && newDist > 0) {
                    const factor = newDist / oldDist;
                    const rect = svg.getBoundingClientRect();
                    const mx = center.x - rect.left;
                    const my = center.y - rect.top;
                    const newScale = Math.max(0.1, Math.min(10, prev.scale * factor));
                    updateTransform({
                        scale: newScale,
                        x: mx - (mx - prev.x) * (newScale / prev.scale),
                        y: my - (my - prev.y) * (newScale / prev.scale),
                    });
                }
            } else {
                // Single-finger pan
                const dx = center.x - lastTouchRef.current.x;
                const dy = center.y - lastTouchRef.current.y;
                updateTransform({ ...prev, x: prev.x + dx, y: prev.y + dy });
            }

            lastTouchRef.current = { x: center.x, y: center.y, dist: getTouchDist(e.touches) };
        };
        const onTouchEnd = () => { lastTouchRef.current = null; };

        svg.addEventListener('touchstart', onTouchStart, { passive: false });
        svg.addEventListener('touchmove', onTouchMove, { passive: false });
        svg.addEventListener('touchend', onTouchEnd);
        svg.addEventListener('touchcancel', onTouchEnd);
        return () => {
            svg.removeEventListener('touchstart', onTouchStart);
            svg.removeEventListener('touchmove', onTouchMove);
            svg.removeEventListener('touchend', onTouchEnd);
            svg.removeEventListener('touchcancel', onTouchEnd);
        };
    }, [updateTransform]);

    // Build fill path — per-panel polygon (memoized per dieline)
    const contourFillD = useMemo(
        () => dieline ? buildPanelFillPaths(dieline.panels) : '',
        [dieline],
    );

    // ── Split mode helpers: filter paths/panels by part ──
    const isSplit = params.boxType === 'tray' && nestingConfig.trayNestingMode === 'split';

    // Build part-specific fill paths and bboxes
    const trayPanels = useMemo(
        () => dieline ? dieline.panels.filter(p => !p.name.startsWith('sleeve_')) : [],
        [dieline],
    );
    const sleevePanels = useMemo(
        () => dieline ? dieline.panels.filter(p => p.name.startsWith('sleeve_')) : [],
        [dieline],
    );
    const trayPaths = useMemo(
        () => dieline ? dieline.allPaths.filter((_, i) => {
            // Find which panel owns this path
            for (const p of (dieline?.panels ?? [])) {
                if (p.paths.includes(dieline!.allPaths[i]) && p.name.startsWith('sleeve_')) return false;
            }
            return true;
        }) : [],
        [dieline],
    );
    const sleevePaths = useMemo(
        () => dieline ? dieline.allPaths.filter((_, i) => {
            for (const p of (dieline?.panels ?? [])) {
                if (p.paths.includes(dieline!.allPaths[i]) && p.name.startsWith('sleeve_')) return true;
            }
            return false;
        }) : [],
        [dieline],
    );

    const trayFillD = useMemo(
        () => trayPanels.length > 0 ? buildPanelFillPaths(trayPanels) : '',
        [trayPanels],
    );
    const sleeveFillD = useMemo(
        () => sleevePanels.length > 0 ? buildPanelFillPaths(sleevePanels) : '',
        [sleevePanels],
    );

    // Compute part bboxes
    const partBBox = (panels: Panel[]) => {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const panel of panels) {
            for (const seg of panel.paths) {
                const pts = seg.type === 'bezier' && seg.controlPoints ? seg.controlPoints : seg.points;
                for (const p of pts) {
                    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
                    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
                }
            }
        }
        if (minX === Infinity) return null;
        return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
    };

    const trayBB = useMemo(() => partBBox(trayPanels), [trayPanels]);
    const sleeveBB = useMemo(() => partBBox(sleevePanels), [sleevePanels]);

    if (!dieline || !nestingResult) {
        return <div className="dt-canvas-2d-empty">{t('dieline.nestingCanvas:nhap_thong_so_de_xem_xep_khuon')}</div>;
    }

    const { actualSheet, positions } = nestingResult;
    const { margin, gripperMargin } = nestingConfig;
    const bb = dieline.boundingBox;
    const effectiveBottom = Math.max(margin.bottom, gripperMargin);

    // ── Combined tray mode: 1 sheet, 2 part types ──
    const isCombinedTray = params.boxType === 'tray' && !isSplit && sleeveNestingResult && trayBB && sleeveBB;

    if (isCombinedTray) {
        return (
            <div className="dt-canvas-2d-container" style={{ position: 'relative' }}>
                <div className="dt-canvas-toolbar">
                    <span className="dt-zoom-info">🔍 {Math.round(transform.scale * 100)}%</span>
                    <span className="dt-sheet-size">
                        {t('dieline.nestingCanvas:to_giay')} {actualSheet.width} × {actualSheet.height} mm
                    </span>
                    <span className="dt-nesting-info" style={{
                        background: 'var(--dt-accent, #f97316)',
                        color: '#fff', padding: '2px 8px', borderRadius: '4px',
                        fontSize: '0.75rem', fontWeight: 600,
                    }}>
                        {t('dieline.nestingCanvas:khay_vo', { khay: nestingResult.countPerSheet, vo: sleeveNestingResult.countPerSheet })}
                    </span>
                </div>

                <svg ref={svgRef} className="dt-dieline-svg"
                    onMouseDown={handleMouseDown} onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}
                    style={{ touchAction: 'none' }}>

                    <defs>
                        {/* Tray defs */}
                        <path id="nesting-tray-fill"
                            d={trayFillD}
                            transform={`translate(0, ${trayBB.minY + trayBB.maxY}) scale(1, -1)`}
                            fillRule="evenodd"
                        />
                        <g id="nesting-tray-template"
                            transform={`translate(0, ${trayBB.minY + trayBB.maxY}) scale(1, -1)`}>
                            {trayPaths.map((path, pi) => (
                                <MiniPathRenderer key={pi} path={path} tagStyles={tagStyles} />
                            ))}
                        </g>
                        {/* Sleeve defs */}
                        <path id="nesting-sleeve-fill"
                            d={sleeveFillD}
                            transform={`translate(0, ${sleeveBB.minY + sleeveBB.maxY}) scale(1, -1)`}
                            fillRule="evenodd"
                        />
                        <g id="nesting-sleeve-template"
                            transform={`translate(0, ${sleeveBB.minY + sleeveBB.maxY}) scale(1, -1)`}>
                            {sleevePaths.map((path, pi) => (
                                <MiniPathRenderer key={pi} path={path} tagStyles={tagStyles} />
                            ))}
                        </g>
                    </defs>

                    <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.scale})`}>
                        {/* Sheet background */}
                        <rect x={0} y={0} width={actualSheet.width} height={actualSheet.height}
                            fill="rgba(255,255,255,0.08)" stroke="rgba(100,150,255,0.6)"
                            strokeWidth={2 / transform.scale} />

                        {/* Gripper */}
                        {gripperMargin > 0 && (
                            <rect x={0} y={actualSheet.height - gripperMargin}
                                width={actualSheet.width} height={gripperMargin}
                                fill="rgba(255,0,0,0.12)" stroke="rgba(255,0,0,0.3)"
                                strokeWidth={1 / transform.scale} />
                        )}

                        {/* Printable area */}
                        <rect x={margin.left} y={margin.top}
                            width={actualSheet.width - margin.left - margin.right}
                            height={actualSheet.height - margin.top - effectiveBottom}
                            fill="none" stroke="rgba(80,180,255,0.4)"
                            strokeWidth={1 / transform.scale}
                            strokeDasharray={`${4 / transform.scale},${2 / transform.scale}`} />

                        {/* Tray dielines — cam */}
                        {positions.map((pos, idx) => (
                            <g key={`t-${idx}`} transform={calcDielineTransform(pos, trayBB)} opacity={0.85}>
                                <use href="#nesting-tray-fill" fill="rgba(249,140,50,0.12)" stroke="rgba(249,140,50,0.3)" strokeWidth={0.3 / transform.scale} />
                                <use href="#nesting-tray-template" />
                            </g>
                        ))}

                        {/* Sleeve dielines — tím */}
                        {sleeveNestingResult.positions.map((pos, idx) => (
                            <g key={`s-${idx}`} transform={calcDielineTransform(pos, sleeveBB)} opacity={0.85}>
                                <use href="#nesting-sleeve-fill" fill="rgba(150,100,255,0.12)" stroke="rgba(150,100,255,0.3)" strokeWidth={0.3 / transform.scale} />
                                <use href="#nesting-sleeve-template" />
                            </g>
                        ))}

                        {/* Sheet label */}
                        <text x={actualSheet.width / 2} y={-8 / transform.scale} textAnchor="middle"
                            fill="rgba(255,255,255,0.5)" fontSize={11 / transform.scale} fontFamily="system-ui">
                            {actualSheet.width} × {actualSheet.height} mm
                        </text>
                    </g>
                </svg>
            </div>
        );
    }

    // ── Split mode: 2 sheets side-by-side ──
    if (isSplit && sleeveNestingResult && trayBB && sleeveBB) {
        const traySheet = nestingResult.actualSheet;
        const sleeveSheet = sleeveNestingResult.actualSheet;
        const gap = 30; // visual gap between sheets
        const totalW = traySheet.width + gap + sleeveSheet.width;
        const maxH = Math.max(traySheet.height, sleeveSheet.height);

        return (
            <div className="dt-canvas-2d-container" style={{ position: 'relative' }}>
                <div className="dt-canvas-toolbar">
                    <span className="dt-zoom-info">🔍 {Math.round(transform.scale * 100)}%</span>
                    <span className="dt-nesting-info" style={{
                        background: 'var(--dt-accent, #f97316)',
                        color: '#fff', padding: '2px 8px', borderRadius: '4px',
                        fontSize: '0.75rem', fontWeight: 600,
                    }}>
                        {t('dieline.nestingCanvas:khay_vo', { khay: nestingResult.countPerSheet, vo: sleeveNestingResult.countPerSheet })}
                    </span>
                </div>

                <svg ref={svgRef} className="dt-dieline-svg"
                    onMouseDown={handleMouseDown} onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}
                    style={{ touchAction: 'none' }}>

                    <defs>
                        {/* Tray defs */}
                        <path id="nesting-tray-fill"
                            d={trayFillD}
                            transform={`translate(0, ${trayBB.minY + trayBB.maxY}) scale(1, -1)`}
                            fillRule="evenodd"
                        />
                        <g id="nesting-tray-template"
                            transform={`translate(0, ${trayBB.minY + trayBB.maxY}) scale(1, -1)`}>
                            {trayPaths.map((path, pi) => (
                                <MiniPathRenderer key={pi} path={path} tagStyles={tagStyles} />
                            ))}
                        </g>

                        {/* Sleeve defs */}
                        <path id="nesting-sleeve-fill"
                            d={sleeveFillD}
                            transform={`translate(0, ${sleeveBB.minY + sleeveBB.maxY}) scale(1, -1)`}
                            fillRule="evenodd"
                        />
                        <g id="nesting-sleeve-template"
                            transform={`translate(0, ${sleeveBB.minY + sleeveBB.maxY}) scale(1, -1)`}>
                            {sleevePaths.map((path, pi) => (
                                <MiniPathRenderer key={pi} path={path} tagStyles={tagStyles} />
                            ))}
                        </g>
                    </defs>

                    <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.scale})`}>

                        {/* ── Tray sheet (left) ── */}
                        <g>
                            <rect x={0} y={0} width={traySheet.width} height={traySheet.height}
                                fill="rgba(255,255,255,0.08)" stroke="rgba(100,150,255,0.6)"
                                strokeWidth={2 / transform.scale} />
                            {gripperMargin > 0 && (
                                <rect x={0} y={traySheet.height - gripperMargin}
                                    width={traySheet.width} height={gripperMargin}
                                    fill="rgba(255,0,0,0.12)" stroke="rgba(255,0,0,0.3)"
                                    strokeWidth={1 / transform.scale} />
                            )}
                            <rect x={margin.left} y={margin.top}
                                width={traySheet.width - margin.left - margin.right}
                                height={traySheet.height - margin.top - effectiveBottom}
                                fill="none" stroke="rgba(80,180,255,0.4)"
                                strokeWidth={1 / transform.scale}
                                strokeDasharray={`${4 / transform.scale},${2 / transform.scale}`} />
                            {positions.map((pos, idx) => (
                                <g key={idx} transform={calcDielineTransform(pos, trayBB)} opacity={0.85}>
                                    <use href="#nesting-tray-fill" fill="rgba(249,140,50,0.12)" stroke="rgba(249,140,50,0.3)" strokeWidth={0.3 / transform.scale} />
                                    <use href="#nesting-tray-template" />
                                </g>
                            ))}
                            <text x={traySheet.width / 2} y={-8 / transform.scale} textAnchor="middle"
                                fill="rgba(255,200,100,0.7)" fontSize={11 / transform.scale} fontFamily="system-ui">
                                {t('dieline.nestingCanvas:khay_kich_thuoc', { w: traySheet.width, h: traySheet.height })}
                            </text>
                        </g>

                        {/* ── Sleeve sheet (right) ── */}
                        <g transform={`translate(${traySheet.width + gap}, 0)`}>
                            <rect x={0} y={0} width={sleeveSheet.width} height={sleeveSheet.height}
                                fill="rgba(255,255,255,0.08)" stroke="rgba(150,100,255,0.6)"
                                strokeWidth={2 / transform.scale} />
                            {gripperMargin > 0 && (
                                <rect x={0} y={sleeveSheet.height - gripperMargin}
                                    width={sleeveSheet.width} height={gripperMargin}
                                    fill="rgba(255,0,0,0.12)" stroke="rgba(255,0,0,0.3)"
                                    strokeWidth={1 / transform.scale} />
                            )}
                            <rect x={margin.left} y={margin.top}
                                width={sleeveSheet.width - margin.left - margin.right}
                                height={sleeveSheet.height - margin.top - effectiveBottom}
                                fill="none" stroke="rgba(150,100,255,0.4)"
                                strokeWidth={1 / transform.scale}
                                strokeDasharray={`${4 / transform.scale},${2 / transform.scale}`} />
                            {sleeveNestingResult.positions.map((pos, idx) => (
                                <g key={idx} transform={calcDielineTransform(pos, sleeveBB)} opacity={0.85}>
                                    <use href="#nesting-sleeve-fill" fill="rgba(150,100,255,0.12)" stroke="rgba(150,100,255,0.3)" strokeWidth={0.3 / transform.scale} />
                                    <use href="#nesting-sleeve-template" />
                                </g>
                            ))}
                            <text x={sleeveSheet.width / 2} y={-8 / transform.scale} textAnchor="middle"
                                fill="rgba(200,150,255,0.7)" fontSize={11 / transform.scale} fontFamily="system-ui">
                                {t('dieline.nestingCanvas:vo_bao_kich_thuoc', { w: sleeveSheet.width, h: sleeveSheet.height })}
                            </text>
                        </g>
                    </g>
                </svg>
            </div>
        );
    }

    // ── Combined mode (default): single sheet ──
    return (
        <div className="dt-canvas-2d-container" style={{ position: 'relative' }}>
            {/* Info bar */}
            <div className="dt-canvas-toolbar">
                <span className="dt-zoom-info">🔍 {Math.round(transform.scale * 100)}%</span>
                <span className="dt-sheet-size">
                    {t('dieline.nestingCanvas:to_giay_kich_thuoc', { w: actualSheet.width, h: actualSheet.height })}
                </span>
                <span className="dt-nesting-info" style={{
                    background: 'var(--dt-accent, #f97316)',
                    color: '#fff',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                }}>
                    {t('dieline.nestingCanvas:khuon_to_su_dung', { n: nestingResult.countPerSheet, u: nestingResult.utilization })}
                </span>
            </div>

            <svg
                ref={svgRef}
                className="dt-dieline-svg"
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
                style={{ touchAction: 'none' }}
            >
                {/* ── Defs — render dieline paths ONCE, reuse via <use> ── */}
                {/* Y-flip: engine dùng Y↑, SVG dùng Y↓ → flip quanh bbox center */}
                <defs>
                    {/* Contour fill shape — dùng cho tô màu theo hình dạng khuôn */}
                    <path id="nesting-contour-fill"
                        d={contourFillD}
                        transform={`translate(0, ${bb.minY + bb.maxY}) scale(1, -1)`}
                        fillRule="evenodd"
                    />
                    {/* Line template — đường cắt/cấn */}
                    <g id="nesting-dieline-template"
                        transform={`translate(0, ${bb.minY + bb.maxY}) scale(1, -1)`}>
                        {dieline.allPaths.map((path, pi) => (
                            <MiniPathRenderer key={pi} path={path} tagStyles={tagStyles} />
                        ))}
                    </g>
                </defs>

                {/* Transform group */}
                <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.scale})`}>
                    {/* Tờ giấy — nền */}
                    <rect
                        x={0} y={0}
                        width={actualSheet.width} height={actualSheet.height}
                        fill="rgba(255,255,255,0.08)"
                        stroke="rgba(100,150,255,0.6)"
                        strokeWidth={2 / transform.scale}
                    />

                    {/* Vùng cắn nhíp — đỏ, PHÍA DƯỚI tờ giấy (leading edge) */}
                    {gripperMargin > 0 && (<>
                        <rect
                            x={0} y={actualSheet.height - gripperMargin}
                            width={actualSheet.width} height={gripperMargin}
                            fill="rgba(255,0,0,0.12)"
                            stroke="rgba(255,0,0,0.3)"
                            strokeWidth={1 / transform.scale}
                        />
                        <text
                            x={actualSheet.width / 2}
                            y={actualSheet.height - gripperMargin / 2 + 3 / transform.scale}
                            textAnchor="middle" fill="rgba(255,80,80,0.7)"
                            fontSize={8 / transform.scale} fontFamily="system-ui"
                        >
                            {t('dieline.nestingCanvas:can_nhip_mm', { n: gripperMargin })}
                        </text>
                    </>)}

                    {/* Lề dưới (nếu > gripperMargin) — cam, gần nhíp */}
                    {gripperMargin > 0 && margin.bottom > gripperMargin && (
                        <rect
                            x={0} y={actualSheet.height - margin.bottom}
                            width={actualSheet.width} height={margin.bottom}
                            fill="rgba(255,165,0,0.08)"
                            stroke="rgba(255,165,0,0.3)"
                            strokeWidth={1 / transform.scale}
                            strokeDasharray={`${3 / transform.scale},${2 / transform.scale}`}
                        />
                    )}

                    {/* Lề trên — hiển thị khi > 0 */}
                    {margin.top > 0 && (
                        <rect
                            x={0} y={0}
                            width={actualSheet.width} height={margin.top}
                            fill="rgba(100,150,255,0.06)"
                            stroke="rgba(100,150,255,0.2)"
                            strokeWidth={0.5 / transform.scale}
                            strokeDasharray={`${3 / transform.scale},${2 / transform.scale}`}
                        />
                    )}

                    {/* Vùng in hợp lệ — viền xanh nét đứt */}
                    <rect
                        x={margin.left} y={margin.top}
                        width={actualSheet.width - margin.left - margin.right}
                        height={actualSheet.height - margin.top - effectiveBottom}
                        fill="none"
                        stroke="rgba(80,180,255,0.4)"
                        strokeWidth={1 / transform.scale}
                        strokeDasharray={`${4 / transform.scale},${2 / transform.scale}`}
                    />

                    {/* Các khuôn bế — sử dụng <use> pattern */}
                    {positions.map((pos, idx) => {
                        const isRotated = pos.rotation === 180 || pos.rotation === 270;
                        const gTransform = calcDielineTransform(pos, bb);

                        return (
                            <g key={idx} transform={gTransform} opacity={0.85}>
                                {/* Nền contour — cam=gốc, xanh=xoay, theo hình dạng khuôn */}
                                <use href="#nesting-contour-fill"
                                    fill={isRotated ? 'rgba(80,160,255,0.12)' : 'rgba(249,140,50,0.12)'}
                                    stroke={isRotated ? 'rgba(80,160,255,0.3)' : 'rgba(249,140,50,0.3)'}
                                    strokeWidth={0.3 / transform.scale}
                                />
                                {/* Đường khuôn bế */}
                                <use href="#nesting-dieline-template" />
                            </g>
                        );
                    })}

                    {/* Labels */}
                    <text
                        x={actualSheet.width / 2}
                        y={-8 / transform.scale}
                        textAnchor="middle"
                        fill="rgba(255,255,255,0.5)"
                        fontSize={11 / transform.scale}
                        fontFamily="system-ui"
                    >
                        {actualSheet.width} × {actualSheet.height} mm
                    </text>
                </g>
            </svg>
        </div>
    );
}
