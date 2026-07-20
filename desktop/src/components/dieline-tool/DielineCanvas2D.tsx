// ============================================================
// DielineCanvas2D — SVG renderer cho bản vẽ khuôn bế 2D
// Hỗ trợ Zoom/Pan, phân biệt CUT/CREASE/BLEED bằng màu & nét
// ============================================================

import React, { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { useBoxStore } from '../../store/useBoxStore';
import { useMockupStore } from '../../store/useMockupStore';
import { DielineModel, PathSegment, Panel } from '../../lib/dieline/types';
import { buildChains, chainToSvgD, computeEnvelopeDims, deriveLegendTags } from '../../lib/dieline/sharedGeometry';
import { tracePerimeter } from '../../lib/dieline/tracePerimeter';
import { computeBleedContours, DEFAULT_DIELINE_BLEED_MM } from '../../lib/dieline/bleedContours';
import { useTranslation } from 'react-i18next';
import { tv } from '../../i18n';
// Desktop: no auth/settings needed — all features available

// Màu sắc và style cho từng loại nét
// CUT dùng CSS variable để thích ứng light/dark theme
const PATH_STYLES: Record<string, { stroke: string; dashArray: string; width: number; label: string }> = {
    CUT: { stroke: 'var(--dt-cut-color, #ffffff)', dashArray: 'none', width: 0.8, label: 'Cắt' },
    CREASE: { stroke: '#ff4444', dashArray: '3,2', width: 0.5, label: 'Cấn' },
    BLEED: { stroke: '#16a34a', dashArray: '4,2', width: 1.1, label: 'Tràn lề' },
};

/** Nút debug (tên mặt / đoạn cắt / chú thích điểm) chỉ hiện khi dev. */
const IS_DEV = import.meta.env.DEV;

export default function DielineCanvas2D({ rightSlot }: { rightSlot?: React.ReactNode } = {}) {
  const { t } = useTranslation();
    const { dieline } = useBoxStore();
    const svgRef = useRef<SVGSVGElement>(null);
    const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
    const [isPanning, setIsPanning] = useState(false);
    const [panStart, setPanStart] = useState({ x: 0, y: 0 });
    const [showDimensions, setShowDimensions] = useState(true);
    const [showPanelLabels, setShowPanelLabels] = useState(false);
    const [showSegmentLabels, setShowSegmentLabels] = useState(false);
    // Mặc định tắt; chỉ bật được trong DEV qua toolbar.
    const [showAnnotations, setShowAnnotations] = useState(false);

    // ─── Ảnh in (mockup) — canh chỉnh trực tiếp trên khuôn phẳng ───
    const mockupTextureUrl = useBoxStore((s) => s.mockupTextureUrl);
    const outerUrl = useMockupStore((s) => s.artwork.outer.url);
    const artTransform = useMockupStore((s) => s.artwork.outer.transform);
    const setArtTransform = useMockupStore((s) => s.setOuterArtworkTransform);
    const setOuterArtworkUrl = useMockupStore((s) => s.setOuterArtworkUrl);
    const showBleedSafe = useMockupStore((s) => s.artwork.showBleedSafe);
    const setShowBleedSafe = useMockupStore((s) => s.setShowBleedSafe);
    const artworkUrl = outerUrl ?? mockupTextureUrl;
    const storedArtworkAspect = useMockupStore((s) => s.artwork.outer.aspectRatio);
    const [detectedArtworkAspect, setDetectedArtworkAspect] = useState<number | null>(null);
    const [showArtwork, setShowArtwork] = useState(true);
    const dragArtRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
    const pointerMoveFrameRef = useRef<number | null>(null);

    const onUploadArtwork = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            const url = URL.createObjectURL(file);
            const image = new Image();
            image.onload = () => setOuterArtworkUrl(url, image.naturalWidth / image.naturalHeight);
            image.onerror = () => URL.revokeObjectURL(url);
            image.src = url;
        }
        e.target.value = '';
    }, [setOuterArtworkUrl]);

    // Resolve quick-upload/legacy URLs too. Normal uploads retain the intrinsic
    // ratio in the store so both the 2D and 3D renderers use the same geometry.
    useEffect(() => {
        if (!artworkUrl) {
            setDetectedArtworkAspect(null);
            return;
        }
        if (Number.isFinite(storedArtworkAspect) && storedArtworkAspect! > 0) {
            setDetectedArtworkAspect(storedArtworkAspect);
            return;
        }
        let cancelled = false;
        const image = new Image();
        image.onload = () => {
            if (!cancelled && image.naturalWidth > 0 && image.naturalHeight > 0) {
                setDetectedArtworkAspect(image.naturalWidth / image.naturalHeight);
            }
        };
        image.onerror = () => { if (!cancelled) setDetectedArtworkAspect(null); };
        image.src = artworkUrl;
        return () => { cancelled = true; };
    }, [artworkUrl, storedArtworkAspect]);

    // Hình chữ nhật vùng ảnh (toạ độ mm khuôn) khớp ánh xạ UV aligned-to-dieline.
    const artRect = useMemo(() => {
        if (!dieline || !artworkUrl) return null;
        const bb = dieline.boundingBox;
        const sc = (artTransform.scalePct || 100) / 100;
        const offX = (artTransform.offsetXPct || 0) / 100;
        const offY = (artTransform.offsetYPct || 0) / 100;
        const aspect = detectedArtworkAspect;
        const preserveAspect = Number.isFinite(aspect) && aspect! > 0 && bb.width > 0 && bb.height > 0;
        const coverHeight = preserveAspect ? Math.max(bb.width / aspect!, bb.height) : bb.height;
        const w = (preserveAspect ? aspect! * coverHeight : bb.width) * sc;
        const h = coverHeight * sc;
        const cx = bb.minX + bb.width / 2 + offX * w;
        const cy = bb.minY + bb.height / 2 + offY * h;
        return { x: cx - w / 2, y: cy - h / 2, w, h, cx, cy, rot: artTransform.rotationDeg || 0 };
    }, [dieline, artworkUrl, artTransform, detectedArtworkAspect]);

    // Đa giác clip = vùng phủ của MỌI mặt khuôn. Panel nào không khai báo
    // `outline` (tai bụi, đáy, tai đút…) thì DÒ chu vi từ `paths` (giống lớp 3D)
    // để ảnh phủ TRỌN bề mặt trải, KHÔNG bị các mặt đó che mất.
    const clipPolys = useMemo(() => {
        if (!dieline) return [] as string[];
        const polys: string[] = [];
        for (const p of dieline.panels) {
            const pts = (p.outline && p.outline.length >= 3)
                ? p.outline
                : tracePerimeter(p.paths);
            if (pts && pts.length >= 3) {
                polys.push(pts.map((q) => `${q.x},${q.y}`).join(' '));
            }
        }
        return polys;
    }, [dieline]);

    const bleedContours = useMemo(
        () => (dieline && showBleedSafe
            ? computeBleedContours(dieline, DEFAULT_DIELINE_BLEED_MM)
            : []),
        [dieline, showBleedSafe],
    );
    // ── Gizmo biến đổi trực tiếp trên ảnh (kéo/scale/xoay như editor VDP) ──
    // Toạ độ gizmo tính ở KHÔNG GIAN MÀN HÌNH (px svg-local) để núm có kích
    // thước cố định, không bị zoom. Chiếu điểm mm→px: (tx+mx·s, ty−my·s).
    const gizmo = useMemo(() => {
        if (!showArtwork || !artworkUrl || !artRect) return null;
        const { cx, cy, w, h, rot } = artRect;
        const rotA = (-rot * Math.PI) / 180;
        const ca = Math.cos(rotA);
        const sa = Math.sin(rotA);
        const toPx = (mx: number, my: number) => ({
            x: transform.x + mx * transform.scale,
            y: transform.y - my * transform.scale,
        });
        // 4 góc hình ảnh (image-space) qua flip Y + xoay quanh tâm.
        const corner = (sx: number, sy: number) => {
            const px = sx * (w / 2);
            const py = -(sy * (h / 2)); // scale(1,-1)
            const rx = px * ca - py * sa;
            const ry = px * sa + py * ca;
            return toPx(cx + rx, cy + ry);
        };
        const corners = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
        const center = toPx(cx, cy);
        const sorted = [...corners].sort((a, b) => a.y - b.y);
        const topMid = { x: (sorted[0].x + sorted[1].x) / 2, y: (sorted[0].y + sorted[1].y) / 2 };
        const dx = topMid.x - center.x;
        const dy = topMid.y - center.y;
        const d = Math.hypot(dx, dy) || 1;
        const rotHandle = { x: topMid.x + (dx / d) * 30, y: topMid.y + (dy / d) * 30 };
        return { corners, center, topMid, rotHandle };
    }, [showArtwork, artworkUrl, artRect, transform]);

    const toLocal = useCallback((clientX: number, clientY: number) => {
        const r = svgRef.current?.getBoundingClientRect();
        return { x: clientX - (r?.left ?? 0), y: clientY - (r?.top ?? 0) };
    }, []);

    // Kéo góc → scale đồng đều quanh tâm (theo tỉ lệ khoảng cách tới tâm).
    const beginScale = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        if (!gizmo) return;
        const c = gizmo.center;
        const l0 = toLocal(e.clientX, e.clientY);
        const startDist = Math.hypot(l0.x - c.x, l0.y - c.y) || 1;
        const startScale = artTransform.scalePct || 100;
        const move = (ev: MouseEvent) => {
            const ll = toLocal(ev.clientX, ev.clientY);
            const d = Math.hypot(ll.x - c.x, ll.y - c.y);
            const next = Math.max(10, Math.min(1000, startScale * (d / startDist)));
            setArtTransform({ ...artTransform, scalePct: next });
        };
        const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
    }, [gizmo, artTransform, setArtTransform, toLocal]);

    // Kéo núm xoay → đổi rotationDeg theo góc con trỏ quanh tâm.
    const beginRotate = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        if (!gizmo) return;
        const c = gizmo.center;
        const l0 = toLocal(e.clientX, e.clientY);
        const startA = Math.atan2(l0.y - c.y, l0.x - c.x);
        const startRot = artTransform.rotationDeg ?? 0;
        const move = (ev: MouseEvent) => {
            const ll = toLocal(ev.clientX, ev.clientY);
            const a = Math.atan2(ll.y - c.y, ll.x - c.x);
            let deg = startRot - ((a - startA) * 180) / Math.PI;
            while (deg > 180) deg -= 360;
            while (deg < -180) deg += 360;
            setArtTransform({ ...artTransform, rotationDeg: deg });
        };
        const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
    }, [gizmo, artTransform, setArtTransform, toLocal]);

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
    }, [handleWheel, dieline]);

    // Pan
    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        if (e.button === 0) {
            setIsPanning(true);
            setPanStart({ x: e.clientX - transform.x, y: e.clientY - transform.y });
        }
    }, [transform]);

    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        const drag = dragArtRef.current;
        if (pointerMoveFrameRef.current !== null) return;
        const clientX = e.clientX;
        const clientY = e.clientY;
        pointerMoveFrameRef.current = requestAnimationFrame(() => {
        pointerMoveFrameRef.current = null;

        if (drag && dieline) {
            const bb = dieline.boundingBox;
            const sc = (artTransform.scalePct || 100) / 100 || 1;
            const dxPx = clientX - drag.sx;
            const dyPx = clientY - drag.sy;
            // px → mm (chia zoom) → chuẩn hoá theo bbox → offsetPct (chia tỉ lệ ảnh).
            const dOffX = (((dxPx / transform.scale) / bb.width) / sc) * 100;
            // Màn hình kéo xuống (dyPx+) ⇒ khuôn −y ⇒ offset Y giảm.
            const dOffY = ((-(dyPx / transform.scale) / bb.height) / sc) * 100;
            setArtTransform({
                ...artTransform,
                offsetXPct: drag.ox + dOffX,
                offsetYPct: drag.oy + dOffY,
            });
            return;
        }
        if (isPanning) {
            setTransform((prev) => ({
                ...prev,
                x: clientX - panStart.x,
                y: clientY - panStart.y,
            }));
        }
        });
    }, [isPanning, panStart, dieline, artTransform, transform.scale, setArtTransform]);

    useEffect(() => () => {
        if (pointerMoveFrameRef.current !== null) cancelAnimationFrame(pointerMoveFrameRef.current);
    }, []);

    const handleMouseUp = useCallback(() => {
        setIsPanning(false);
        dragArtRef.current = null;
    }, []);

    if (!dieline) {
        return <div className="dt-canvas-2d-empty">{t('dieline.dielineCanvas2D:nhap_thong_so_de_tao_khuon_be')}</div>;
    }

    return (
        <div className="dt-canvas-2d-container" style={{ position: 'relative' }}>
            {/* Toolbar */}
            <div className="dt-canvas-toolbar">
                <button onClick={() => setShowDimensions(!showDimensions)} className="dt-toolbar-btn" title={t('dieline.dielineCanvas2D:hien_thi_kich_thuoc')}>
                    📏 {showDimensions ? t('dieline.dielineCanvas2D:an') : t('dieline.dielineCanvas2D:hien')} {t('dieline.dielineCanvas2D:kich_thuoc')}
                </button>
                <button
                    onClick={() => setShowBleedSafe(!showBleedSafe)}
                    className={`dt-toolbar-btn ${showBleedSafe ? 'active' : ''}`}
                    title={t('dieline.mockupArtwork:hien_duong_bien_vung_tran_le_bleed_va')}
                >
                    🩸 Bleed {DEFAULT_DIELINE_BLEED_MM} mm
                </button>
                {IS_DEV && (
                    <>
                        <button onClick={() => setShowPanelLabels(!showPanelLabels)} className="dt-toolbar-btn" title={t('dieline.dielineCanvas2D:dev_hien_thi_ten_cac_mat')}>
                            {showPanelLabels ? '👁️' : '🚫'} {t('dieline.dielineCanvas2D:ten_mat')}
                        </button>
                        <button onClick={() => setShowSegmentLabels(!showSegmentLabels)} className="dt-toolbar-btn" title={t('dieline.dielineCanvas2D:dev_hien_thi_ten_tung_doan_cat')}>
                            {showSegmentLabels ? '👁️' : '🚫'} {t('dieline.dielineCanvas2D:doan_cat')}
                        </button>
                        <button onClick={() => setShowAnnotations(!showAnnotations)} className="dt-toolbar-btn" title={t('dieline.dielineCanvas2D:dev_hien_thi_chu_thich_diem')}>
                            {showAnnotations ? '👁️' : '🚫'} {t('dieline.dielineCanvas2D:chu_thich_diem')}
                        </button>
                    </>
                )}
                <span className="dt-zoom-info">🔍 {Math.round(transform.scale * 100)}%</span>
                <span className="dt-sheet-size">
                    {t('dieline.dielineCanvas2D:kho_trai')} {dieline.boundingBox.width.toFixed(1)} × {dieline.boundingBox.height.toFixed(1)} mm
                </span>
                {/* Legend — chỉ hiển thị tag thực sự có trong file (phương án B) */}
                <div className="dt-legend">
                    {[...new Set([...deriveLegendTags(dieline), ...(showBleedSafe ? ['BLEED' as const] : [])])].map((tag) => {
                        const style = PATH_STYLES[tag];
                        if (!style) return null;
                        return (
                            <span key={tag} className="dt-legend-item">
                                <span className="dt-legend-line" style={{ backgroundColor: style.stroke }} />
                                {tv(style.label)}
                            </span>
                        );
                    })}
                </div>

                {/* Ảnh in (mockup) — canh chỉnh trực tiếp trên khuôn */}
                <span className="dt-toolbar-sep" />
                <label className="dt-toolbar-btn" title={t('dieline.dielineCanvas2D:tai_anh_in_len_khuon')} style={{ cursor: 'pointer' }}>
                    {t('dieline.dielineCanvas2D:anh_in')}
                    <input type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }} onChange={onUploadArtwork} />
                </label>
                {artworkUrl && (
                    <>
                        <button onClick={() => setShowArtwork((v) => !v)} className="dt-toolbar-btn" title={t('dieline.dielineCanvas2D:an_hien_anh_in')}>
                            {showArtwork ? '👁️' : '🚫'} {t('dieline.dielineCanvas2D:anh')}
                        </button>
                        <label className="dt-art-ctl" title={t('dieline.dielineCanvas2D:ti_le_anh')}>
                            ⤢
                            <input type="range" min={10} max={400} step={1}
                                value={artTransform.scalePct}
                                onChange={(e) => setArtTransform({ ...artTransform, scalePct: parseFloat(e.target.value) })}
                                style={{ width: 80, verticalAlign: 'middle', accentColor: 'var(--dt-accent)' }} />
                        </label>
                        <label className="dt-art-ctl" title={t('dieline.dielineCanvas2D:xoay_anh')}>
                            ⟳
                            <input type="range" min={-180} max={180} step={1}
                                value={artTransform.rotationDeg ?? 0}
                                onChange={(e) => setArtTransform({ ...artTransform, rotationDeg: parseFloat(e.target.value) })}
                                style={{ width: 80, verticalAlign: 'middle', accentColor: 'var(--dt-accent)' }} />
                        </label>
                        <button
                            onClick={() => setArtTransform({ scalePct: 100, offsetXPct: 0, offsetYPct: 0, rotationDeg: 0 })}
                            className="dt-toolbar-btn" title={t('dieline.dielineCanvas2D:dat_lai_vi_tri_anh')}>{t('dieline.dielineCanvas2D:reset_anh')}</button>
                    </>
                )}
            </div>

            {/* Vùng vẽ: SVG bên trái + slot phải (vd 3D khi chia đôi). Toolbar
                ở trên giữ NGUYÊN full chiều rộng. */}
            <div className="dt-canvas-2d-body" style={{ flex: 1, display: 'flex', minHeight: 0 }}>
            <div className="dt-canvas-2d-pane" style={{ flex: 1, minWidth: 0, position: 'relative', display: 'flex' }}>
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
                    {/* Ảnh in: clip theo các mặt khuôn, ánh xạ khớp aligned-to-dieline */}
                    {showArtwork && artworkUrl && artRect && clipPolys.length > 0 && (
                        <>
                            <defs>
                                <clipPath id="dt-artwork-clip" clipPathUnits="userSpaceOnUse">
                                    {clipPolys.map((pts, i) => (
                                        <polygon key={i} points={pts} />
                                    ))}
                                </clipPath>
                            </defs>
                            <g clipPath="url(#dt-artwork-clip)">
                                {/* Lật Y + xoay quanh tâm để ảnh đứng đúng chiều trong group y-up */}
                                <g transform={`translate(${artRect.cx}, ${artRect.cy}) rotate(${-artRect.rot}) scale(1,-1) translate(${-artRect.cx}, ${-artRect.cy})`}>
                                    <image
                                        href={artworkUrl}
                                        x={artRect.x}
                                        y={artRect.y}
                                        width={artRect.w}
                                        height={artRect.h}
                                        preserveAspectRatio="xMidYMid slice"
                                        opacity={0.95}
                                        style={{ cursor: 'move' }}
                                        onMouseDown={(e) => {
                                            e.stopPropagation();
                                            dragArtRef.current = {
                                                sx: e.clientX, sy: e.clientY,
                                                ox: artTransform.offsetXPct, oy: artTransform.offsetYPct,
                                            };
                                        }}
                                    />
                                </g>
                            </g>
                        </>
                    )}

                    {showBleedSafe && <BleedContourRenderer contours={bleedContours} />}
                    <ChainedPathRenderer paths={dieline.allPaths} />

                    {/* Dimension Annotations */}
                    {showDimensions && <DimensionAnnotations dieline={dieline} scale={transform.scale} showDetail={showDimensions} />}

                    {/* Panel / segment / annotations — chỉ DEV */}
                    {IS_DEV && showPanelLabels && <PanelLabels panels={dieline.panels} scale={transform.scale} />}
                    {IS_DEV && showAnnotations && <PanelAnnotations panels={dieline.panels} scale={transform.scale} />}
                    {IS_DEV && showSegmentLabels && <SegmentLabels dieline={dieline} scale={transform.scale} />}
                </g>

                {/* Gizmo biến đổi ảnh (px màn hình, núm cố định kích thước) */}
                {gizmo && (
                    <g>
                        <polygon
                            points={gizmo.corners.map((c) => `${c.x},${c.y}`).join(' ')}
                            fill="none"
                            stroke="var(--dt-accent, #7c5cff)"
                            strokeWidth={1.3}
                            strokeDasharray="5,3"
                            pointerEvents="none"
                        />
                        <line
                            x1={gizmo.topMid.x} y1={gizmo.topMid.y}
                            x2={gizmo.rotHandle.x} y2={gizmo.rotHandle.y}
                            stroke="var(--dt-accent, #7c5cff)" strokeWidth={1.3} pointerEvents="none"
                        />
                        <circle
                            cx={gizmo.rotHandle.x} cy={gizmo.rotHandle.y} r={6.5}
                            fill="#ffffff" stroke="var(--dt-accent, #7c5cff)" strokeWidth={1.6}
                            style={{ cursor: 'grab' }}
                            onMouseDown={beginRotate}
                        />
                        {gizmo.corners.map((c, i) => (
                            <rect
                                key={i}
                                x={c.x - 5} y={c.y - 5} width={10} height={10}
                                fill="#ffffff" stroke="var(--dt-accent, #7c5cff)" strokeWidth={1.6}
                                style={{ cursor: 'nwse-resize' }}
                                onMouseDown={beginScale}
                            />
                        ))}
                    </g>
                )}
            </svg>
            </div>
            {rightSlot && (
                <div className="dt-canvas-2d-pane" style={{ flex: 1, minWidth: 0, position: 'relative', borderLeft: '1px solid var(--dt-border)' }}>
                    {rightSlot}
                </div>
            )}
            </div>
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
                <span className="dt-preview-placeholder-text">{tv(info.label)}</span>
            </div>
        </div>
    );
}

// ── Chain helpers: dùng chung từ sharedGeometry.ts (buildChains / chainToSvgD) ──

function BleedContourRenderer({ contours }: { contours: { x: number; y: number }[][] }) {
    const style = PATH_STYLES.BLEED;
    return (
        <g className="dt-bleed-contours" pointerEvents="none">
            {contours.map((points, index) => (
                <polygon
                    key={index}
                    points={points.map((point) => `${point.x},${point.y}`).join(' ')}
                    fill="none"
                    stroke={style.stroke}
                    strokeWidth={style.width}
                    strokeDasharray={style.dashArray}
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                />
            ))}
        </g>
    );
}
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
                        {tv(panel.label)}
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
                : seg.tag === 'BLEED' ? 'rgba(22,163,74,0.9)' : 'rgba(0,255,150,0.9)';
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
                            {tv(p.label)}
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
