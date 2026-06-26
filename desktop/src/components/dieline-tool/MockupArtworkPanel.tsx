// ============================================================
// MockupArtworkPanel — Mockup 3D Realism (Render/Control Layer)
//
// Bảng điều khiển (UI, KHÔNG nằm trong Canvas) cho quy trình đặt ảnh
// nghệ thuật của mockup 3D. Nối toàn bộ điều khiển tới `useMockupStore`.
//
// Nâng cấp UX (chuẩn phần mềm thiết kế pro):
//   - Các nhóm gập/mở (accordion) để sidebar gọn (CollapsibleSection).
//   - Vùng tải ảnh KÉO-THẢ + thumbnail + tên file.
//   - Transform: slider + Ô NHẬP SỐ chính xác + nút Canh giữa / 100% / Xoay 90°
//     / Lật ngang / Lật dọc / Đặt lại.
//   - Tooltip giải thích các tùy chọn khó (per-face vs aligned, emboss…).
//
// _Requirements: 5.4, 5.5, 5.6, 5.7, 5.8, 5.9_
// ============================================================

import React from 'react';
import { useMockupStore } from '../../store/useMockupStore';
import { useBoxStore } from '../../store/useBoxStore';
import CollapsibleSection from './CollapsibleSection';
import {
    validateMask,
    SCALE_MIN_PCT,
    SCALE_MAX_PCT,
    OFFSET_MIN_PCT,
    OFFSET_MAX_PCT,
    ROTATION_MIN_DEG,
    ROTATION_MAX_DEG,
    EMBOSS_MIN_HEIGHT_MM,
    EMBOSS_MAX_HEIGHT_MM,
    type ArtworkTransform,
    type PlacementMode,
} from '../../lib/mockup3d';

/** Định dạng ảnh chấp nhận cho mọi input tải ảnh (GĐ-4). */
const ACCEPT_IMAGE = 'image/png, image/jpeg, image/webp';

/** Transform mặc định (đồng bộ với store) — dùng cho nút "Đặt lại". */
const DEFAULT_TRANSFORM: ArtworkTransform = {
    scalePct: 100, offsetXPct: 0, offsetYPct: 0, rotationDeg: 0, flipH: false, flipV: false,
};

/** Gói góc xoay về miền [-180, 180]. */
function wrapDeg(d: number): number {
    return ((((d + 180) % 360) + 360) % 360) - 180;
}

/** Thông tin ảnh đọc được sau khi nạp thành công. */
interface LoadedImageInfo {
    url: string;
    width: number;
    height: number;
    format: string;
}

/**
 * Nạp một file ảnh phía client để lấy kích thước + xác nhận giải mã được.
 * Trả về thông tin ảnh khi nạp thành công; reject khi ảnh không nạp được
 * (Yêu cầu 5.9 — nhánh lỗi nạp ảnh).
 */
function loadImageFile(file: File): Promise<LoadedImageInfo> {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            resolve({ url, width: img.naturalWidth, height: img.naturalHeight, format: file.type });
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('decode-failed'));
        };
        img.src = url;
    });
}

/** Một hàng slider có nhãn + Ô NHẬP SỐ chính xác + giá trị đơn vị. */
function SliderRow(props: {
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    unit: string;
    onChange: (v: number) => void;
    title?: string;
}) {
    const { label, value, min, max, step, unit, onChange, title } = props;
    return (
        <div className="dt-param-slider" title={title}>
            <div className="dt-param-header">
                <label className="dt-param-label">{label}</label>
                <span className="dt-num-wrap">
                    <input
                        type="number"
                        className="dt-num-input"
                        min={min}
                        max={max}
                        step={step}
                        value={value}
                        onChange={(e) => {
                            const v = parseFloat(e.target.value);
                            if (!Number.isNaN(v)) onChange(v);
                        }}
                    />
                    <span className="dt-num-unit">{unit}</span>
                </span>
            </div>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                className="dt-param-range"
                style={{ accentColor: 'var(--dt-accent)', width: '100%' }}
                onChange={(e) => onChange(parseFloat(e.target.value))}
            />
        </div>
    );
}

/** Cụm điều khiển transform (scale + offset + xoay + lật + thao tác nhanh). */
function TransformControls(props: {
    transform: ArtworkTransform;
    onChange: (t: ArtworkTransform) => void;
}) {
    const { transform, onChange } = props;
    return (
        <>
            <SliderRow
                label="Tỉ lệ" value={transform.scalePct} min={SCALE_MIN_PCT} max={SCALE_MAX_PCT}
                step={1} unit="%" title="Phóng to/thu nhỏ ảnh quanh tâm mặt"
                onChange={(v) => onChange({ ...transform, scalePct: v })}
            />
            <SliderRow
                label="Lệch ngang (X)" value={transform.offsetXPct} min={OFFSET_MIN_PCT} max={OFFSET_MAX_PCT}
                step={1} unit="%" title="Dịch ảnh theo trục ngang"
                onChange={(v) => onChange({ ...transform, offsetXPct: v })}
            />
            <SliderRow
                label="Lệch dọc (Y)" value={transform.offsetYPct} min={OFFSET_MIN_PCT} max={OFFSET_MAX_PCT}
                step={1} unit="%" title="Dịch ảnh theo trục dọc"
                onChange={(v) => onChange({ ...transform, offsetYPct: v })}
            />
            <SliderRow
                label="Xoay" value={transform.rotationDeg ?? 0} min={ROTATION_MIN_DEG} max={ROTATION_MAX_DEG}
                step={1} unit="°" title="Xoay ảnh quanh tâm"
                onChange={(v) => onChange({ ...transform, rotationDeg: v })}
            />
            <div className="dt-art-actions">
                <button type="button" className="dt-mini-btn" title="Canh ảnh về giữa mặt"
                    onClick={() => onChange({ ...transform, offsetXPct: 0, offsetYPct: 0 })}>
                    ⌖ Giữa
                </button>
                <button type="button" className="dt-mini-btn" title="Đặt tỉ lệ về 100%"
                    onClick={() => onChange({ ...transform, scalePct: 100 })}>
                    ⤢ 100%
                </button>
                <button type="button" className="dt-mini-btn" title="Xoay thêm 90°"
                    onClick={() => onChange({ ...transform, rotationDeg: wrapDeg((transform.rotationDeg ?? 0) + 90) })}>
                    ⟳ 90°
                </button>
                <button type="button" className={`dt-mini-btn ${transform.flipH ? 'active' : ''}`} title="Lật ngang ảnh"
                    onClick={() => onChange({ ...transform, flipH: !transform.flipH })}>
                    ⇋ Ngang
                </button>
                <button type="button" className={`dt-mini-btn ${transform.flipV ? 'active' : ''}`} title="Lật dọc ảnh"
                    onClick={() => onChange({ ...transform, flipV: !transform.flipV })}>
                    ⇅ Dọc
                </button>
                <button type="button" className="dt-mini-btn" title="Đặt lại toàn bộ transform"
                    onClick={() => onChange({ ...DEFAULT_TRANSFORM })}>
                    ↺ Đặt lại
                </button>
            </div>
        </>
    );
}

/** Vùng tải ảnh KÉO-THẢ + thumbnail + tên file. */
function ArtworkUploader(props: {
    label: string;
    url: string | null;
    fileName: string | null;
    onFile: (file: File) => void;
    onClear: () => void;
}) {
    const { label, url, fileName, onFile, onClear } = props;
    const [dragOver, setDragOver] = React.useState(false);

    return (
        <div className="dt-uploader">
            <label
                className={`dt-dropzone ${dragOver ? 'drag' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    const f = e.dataTransfer.files?.[0];
                    if (f) onFile(f);
                }}
                title={`${label}: kéo-thả ảnh vào đây hoặc bấm để chọn`}
            >
                {url ? (
                    <img className="dt-thumb" src={url} alt={label} />
                ) : (
                    <span className="dt-dropzone-icon" aria-hidden>🖼️</span>
                )}
                <span className="dt-dropzone-text">
                    {url ? (fileName ?? 'Ảnh đã tải') : `Kéo-thả hoặc bấm để tải ${label.toLowerCase()}`}
                </span>
                <input
                    type="file"
                    accept={ACCEPT_IMAGE}
                    style={{ display: 'none' }}
                    onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) onFile(f);
                        e.target.value = '';
                    }}
                />
            </label>
            {url && (
                <button
                    type="button"
                    className="dt-glue-side-btn"
                    onClick={onClear}
                    style={{ marginTop: '0.4rem', color: 'var(--dt-danger)' }}
                    title={`Xoá ${label.toLowerCase()}`}
                >
                    🗑️ Xoá ảnh
                </button>
            )}
        </div>
    );
}

export default function MockupArtworkPanel() {
    const artwork = useMockupStore((s) => s.artwork);
    const setArtworkMode = useMockupStore((s) => s.setArtworkMode);
    const artworkEditMode = useMockupStore((s) => s.artworkEditMode);
    const setArtworkEditMode = useMockupStore((s) => s.setArtworkEditMode);
    const setOuterArtworkUrl = useMockupStore((s) => s.setOuterArtworkUrl);
    const setOuterArtworkTransform = useMockupStore((s) => s.setOuterArtworkTransform);
    const setInnerArtworkEnabled = useMockupStore((s) => s.setInnerArtworkEnabled);
    const setInnerArtworkUrl = useMockupStore((s) => s.setInnerArtworkUrl);
    const setInnerArtworkTransform = useMockupStore((s) => s.setInnerArtworkTransform);
    const setShowBleedSafe = useMockupStore((s) => s.setShowBleedSafe);
    const setSpotUvMaskUrl = useMockupStore((s) => s.setSpotUvMaskUrl);
    const setEmbossMaskUrl = useMockupStore((s) => s.setEmbossMaskUrl);
    const setEmbossHeightMm = useMockupStore((s) => s.setEmbossHeightMm);
    const undoArtwork = useMockupStore((s) => s.undoArtwork);
    const redoArtwork = useMockupStore((s) => s.redoArtwork);
    const canUndo = useMockupStore((s) => s.artworkPast.length > 0);
    const canRedo = useMockupStore((s) => s.artworkFuture.length > 0);

    const dieline = useBoxStore((s) => s.dieline);

    // Kích thước bề mặt áp mask = bounding box dieline (làm tròn px) — Yêu cầu 4.6.
    const surface = React.useMemo(() => {
        if (!dieline) return null;
        return {
            width: Math.round(dieline.boundingBox.width),
            height: Math.round(dieline.boundingBox.height),
        };
    }, [dieline]);

    // Tên file đã tải (hiển thị cạnh thumbnail).
    const [outerName, setOuterName] = React.useState<string | null>(null);
    const [innerName, setInnerName] = React.useState<string | null>(null);

    // Thông báo lỗi cục bộ cho từng loại tải lên.
    const [outerError, setOuterError] = React.useState<string | null>(null);
    const [innerError, setInnerError] = React.useState<string | null>(null);
    const [maskError, setMaskError] = React.useState<string | null>(null);

    // ── Tải ảnh nghệ thuật (mặt ngoài / mặt trong) ──
    // Yêu cầu 5.9: nếu ảnh nạp lỗi → báo lỗi, KHÔNG đụng tới scale/offset.
    // Phím tắt Hoàn tác/Làm lại (Ctrl/Cmd+Z, Ctrl+Y hoặc Ctrl+Shift+Z).
    // Bỏ qua khi đang gõ trong ô nhập để không cướp undo của input.
    React.useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!(e.ctrlKey || e.metaKey)) return;
            const t = e.target as HTMLElement | null;
            const tag = t?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
            const k = e.key.toLowerCase();
            if (k === 'z' && !e.shiftKey) { e.preventDefault(); undoArtwork(); }
            else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redoArtwork(); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [undoArtwork, redoArtwork]);

    async function handleArtworkUpload(
        file: File,
        setUrl: (url: string | null) => void,
        setError: (msg: string | null) => void,
        setName: (n: string | null) => void,
    ) {
        setError(null);
        try {
            const info = await loadImageFile(file);
            setUrl(info.url); // transform (scale/offset) giữ nguyên — không reset
            setName(file.name);
        } catch {
            setUrl(null);
            setName(null);
            setError('Không nạp được ảnh. Bề mặt giữ vật liệu hiện tại; tỉ lệ/vị trí được giữ nguyên.');
        }
    }

    // ── Tải mặt nạ spot-UV / emboss với xác thực (Yêu cầu 4.6) ──
    async function handleMaskUpload(file: File, setMaskUrl: (url: string | null) => void) {
        setMaskError(null);
        if (!surface) {
            setMaskError('Chưa có khuôn bế để xác định kích thước bề mặt áp mặt nạ.');
            return;
        }
        let info: LoadedImageInfo;
        try {
            info = await loadImageFile(file);
        } catch {
            setMaskError('Không nạp được mặt nạ (ảnh hỏng hoặc sai định dạng).');
            return;
        }
        const result = validateMask(
            { width: info.width, height: info.height, format: info.format },
            surface,
            { allowResize: true },
        );
        if (!result.valid) {
            URL.revokeObjectURL(info.url);
            setMaskError(result.reason ?? 'Mặt nạ không hợp lệ.');
            return;
        }
        setMaskUrl(info.url);
        // Lệch kích thước → KHÔNG chặn, chỉ thông báo sẽ co giãn theo bề mặt.
        if (info.width !== surface.width || info.height !== surface.height) {
            setMaskError(`Mặt nạ ${info.width}×${info.height}px sẽ được co giãn về bề mặt ${surface.width}×${surface.height}px.`);
        }
    }

    const placementModes: { id: PlacementMode; label: string; hint: string }[] = [
        { id: 'per-face', label: 'Theo từng mặt', hint: 'Mỗi mặt ánh xạ ảnh độc lập theo bbox riêng của mặt đó.' },
        { id: 'aligned-to-dieline', label: 'Canh theo khuôn', hint: 'Canh ảnh theo toạ độ khuôn bế — biên ảnh trùng vị trí mặt.' },
    ];

    return (
        <div className="dt-artwork-panel">
            {/* ─── Thanh Hoàn tác / Làm lại ─── */}
            <div className="dt-undo-bar">
                <button
                    type="button"
                    className="dt-mini-btn"
                    onClick={() => undoArtwork()}
                    disabled={!canUndo}
                    style={!canUndo ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
                    title="Hoàn tác (Ctrl+Z)"
                >
                    ↶ Hoàn tác
                </button>
                <button
                    type="button"
                    className="dt-mini-btn"
                    onClick={() => redoArtwork()}
                    disabled={!canRedo}
                    style={!canRedo ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
                    title="Làm lại (Ctrl+Y)"
                >
                    ↷ Làm lại
                </button>
            </div>

            {/* ─── Ảnh mặt ngoài (mở sẵn) ─── */}
            <CollapsibleSection title="Ảnh mặt ngoài" defaultOpen badge={artwork.outer.url ? '●' : undefined}>
                <ArtworkUploader
                    label="Ảnh mặt ngoài"
                    url={artwork.outer.url}
                    fileName={outerName}
                    onFile={(f) => handleArtworkUpload(f, setOuterArtworkUrl, setOuterError, setOuterName)}
                    onClear={() => { setOuterArtworkUrl(null); setOuterError(null); setOuterName(null); }}
                />
                {outerError && (
                    <div className="dt-warning" style={{ marginTop: '0.5rem' }}>
                        <span style={{ fontSize: '1rem' }}>⚠️</span>
                        {outerError}
                    </div>
                )}
                <TransformControls transform={artwork.outer.transform} onChange={setOuterArtworkTransform} />
                <div
                    className={`dt-param-cell ${artworkEditMode ? 'active-edit' : ''}`}
                    style={{ cursor: artwork.outer.url ? 'pointer' : 'not-allowed', marginTop: '0.5rem', opacity: artwork.outer.url ? 1 : 0.5 }}
                    onClick={() => { if (artwork.outer.url) setArtworkEditMode(!artworkEditMode); }}
                    title="Bật để KÉO ảnh trực tiếp trên mặt 3D (tạm tắt xoay quỹ đạo)"
                >
                    <label className="dt-param-cell-label" style={{ cursor: 'inherit' }}>
                        ✋ Kéo ảnh trên mô hình 3D
                    </label>
                    <input
                        type="checkbox"
                        checked={artworkEditMode}
                        readOnly
                        style={{ accentColor: 'var(--dt-accent)' }}
                    />
                </div>
                {artworkEditMode && (
                    <p className="dt-param-desc">
                        Đang bật: kéo chuột trên mặt hộp để dời ảnh; xoay quỹ đạo tạm tắt. Tắt lại để xoay mô hình.
                    </p>
                )}
            </CollapsibleSection>

            {/* ─── Chế độ đặt ảnh ─── */}
            <CollapsibleSection title="Chế độ đặt ảnh">
                <div className="dt-glue-side-toggle">
                    {placementModes.map((m) => (
                        <button
                            key={m.id}
                            className={`dt-glue-side-btn ${artwork.mode === m.id ? 'active' : ''}`}
                            onClick={() => setArtworkMode(m.id)}
                            title={m.hint}
                        >
                            {m.label}
                        </button>
                    ))}
                </div>
                <p className="dt-param-desc">
                    {placementModes.find((m) => m.id === artwork.mode)?.hint}
                </p>
            </CollapsibleSection>

            {/* ─── In mặt trong (độc lập mặt ngoài — Yêu cầu 5.4) ─── */}
            <CollapsibleSection title="In mặt trong" badge={artwork.inner.enabled ? 'Bật' : undefined}>
                <div
                    className="dt-param-cell"
                    style={{ cursor: 'pointer' }}
                    onClick={() => setInnerArtworkEnabled(!artwork.inner.enabled)}
                    title="In ảnh riêng cho mặt trong hộp (đọc đúng chiều từ phía trong)"
                >
                    <label className="dt-section-label" style={{ cursor: 'pointer', margin: 0 }}>
                        Bật in mặt trong
                    </label>
                    <input
                        type="checkbox"
                        checked={artwork.inner.enabled}
                        readOnly
                        style={{ accentColor: 'var(--dt-accent)' }}
                    />
                </div>

                {artwork.inner.enabled && (
                    <>
                        <ArtworkUploader
                            label="Ảnh mặt trong"
                            url={artwork.inner.url}
                            fileName={innerName}
                            onFile={(f) => handleArtworkUpload(f, setInnerArtworkUrl, setInnerError, setInnerName)}
                            onClear={() => { setInnerArtworkUrl(null); setInnerError(null); setInnerName(null); }}
                        />
                        {innerError && (
                            <div className="dt-warning" style={{ marginTop: '0.5rem' }}>
                                <span style={{ fontSize: '1rem' }}>⚠️</span>
                                {innerError}
                            </div>
                        )}
                        <TransformControls transform={artwork.inner.transform} onChange={setInnerArtworkTransform} />
                    </>
                )}
            </CollapsibleSection>

            {/* ─── Bleed / Safe-area (Yêu cầu 5.5) ─── */}
            <CollapsibleSection title="Bleed / Safe-area">
                <div
                    className="dt-param-cell"
                    style={{ cursor: 'pointer' }}
                    onClick={() => setShowBleedSafe(!artwork.showBleedSafe)}
                    title="Hiện đường biên vùng tràn lề (bleed) và vùng an toàn (safe-area)"
                >
                    <label className="dt-section-label" style={{ cursor: 'pointer', margin: 0 }}>
                        Hiện bleed / safe-area
                    </label>
                    <input
                        type="checkbox"
                        checked={artwork.showBleedSafe}
                        readOnly
                        style={{ accentColor: 'var(--dt-accent)' }}
                    />
                </div>
            </CollapsibleSection>

            {/* ─── Mặt nạ spot-UV / emboss (Yêu cầu 4.6) ─── */}
            <CollapsibleSection title="Mặt nạ gia công">
                <p className="dt-param-desc">
                    {surface
                        ? `Kích thước mặt nạ phải khớp bề mặt ${surface.width}×${surface.height} px.`
                        : 'Cần có khuôn bế để xác định kích thước mặt nạ.'}
                </p>

                <div className="dt-glue-side-toggle">
                    <label className="dt-glue-side-btn" style={{ cursor: 'pointer' }} title="Tải mặt nạ phủ UV cục bộ (spot-UV)">
                        ✨ Mask spot-UV
                        <input
                            type="file"
                            accept={ACCEPT_IMAGE}
                            style={{ display: 'none' }}
                            onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) handleMaskUpload(file, setSpotUvMaskUrl);
                                e.target.value = '';
                            }}
                        />
                    </label>
                    {artwork.spotUvMaskUrl && (
                        <button
                            className="dt-glue-side-btn"
                            onClick={() => setSpotUvMaskUrl(null)}
                            style={{ flex: '0 0 auto', padding: '0.5rem', color: 'var(--dt-danger)' }}
                            title="Xoá mask spot-UV"
                        >
                            🗑️
                        </button>
                    )}
                </div>

                <div className="dt-glue-side-toggle" style={{ marginTop: '0.5rem' }}>
                    <label className="dt-glue-side-btn" style={{ cursor: 'pointer' }} title="Tải mặt nạ dập nổi (emboss)">
                        🔲 Mask emboss
                        <input
                            type="file"
                            accept={ACCEPT_IMAGE}
                            style={{ display: 'none' }}
                            onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) handleMaskUpload(file, setEmbossMaskUrl);
                                e.target.value = '';
                            }}
                        />
                    </label>
                    {artwork.embossMaskUrl && (
                        <button
                            className="dt-glue-side-btn"
                            onClick={() => setEmbossMaskUrl(null)}
                            style={{ flex: '0 0 auto', padding: '0.5rem', color: 'var(--dt-danger)' }}
                            title="Xoá mask emboss"
                        >
                            🗑️
                        </button>
                    )}
                </div>

                {maskError && (
                    <div className="dt-warning" style={{ marginTop: '0.5rem' }}>
                        <span style={{ fontSize: '1rem' }}>⚠️</span>
                        {maskError}
                    </div>
                )}

                <SliderRow
                    label="Độ cao emboss"
                    value={artwork.embossHeightMm}
                    min={EMBOSS_MIN_HEIGHT_MM}
                    max={EMBOSS_MAX_HEIGHT_MM}
                    step={0.1}
                    unit=" mm"
                    title="Chiều cao dập nổi mô phỏng theo mặt nạ emboss"
                    onChange={setEmbossHeightMm}
                />
            </CollapsibleSection>
        </div>
    );
}
