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
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation();
    const { transform, onChange } = props;
    return (
        <>
            <SliderRow
                label={t('dieline.mockupArtwork:ti_le')} value={transform.scalePct} min={SCALE_MIN_PCT} max={SCALE_MAX_PCT}
                step={1} unit="%" title={t('dieline.mockupArtwork:phong_to_thu_nho_anh_quanh_tam_mat')}
                onChange={(v) => onChange({ ...transform, scalePct: v })}
            />
            <SliderRow
                label={t('dieline.mockupArtwork:lech_ngang_x')} value={transform.offsetXPct} min={OFFSET_MIN_PCT} max={OFFSET_MAX_PCT}
                step={1} unit="%" title={t('dieline.mockupArtwork:dich_anh_theo_truc_ngang')}
                onChange={(v) => onChange({ ...transform, offsetXPct: v })}
            />
            <SliderRow
                label={t('dieline.mockupArtwork:lech_doc_y')} value={transform.offsetYPct} min={OFFSET_MIN_PCT} max={OFFSET_MAX_PCT}
                step={1} unit="%" title={t('dieline.mockupArtwork:dich_anh_theo_truc_doc')}
                onChange={(v) => onChange({ ...transform, offsetYPct: v })}
            />
            <SliderRow
                label="Xoay" value={transform.rotationDeg ?? 0} min={ROTATION_MIN_DEG} max={ROTATION_MAX_DEG}
                step={1} unit="°" title={t('dieline.mockupArtwork:xoay_anh_quanh_tam')}
                onChange={(v) => onChange({ ...transform, rotationDeg: v })}
            />
            <div className="dt-art-actions">
                <button type="button" className="dt-mini-btn" title={t('dieline.mockupArtwork:canh_anh_ve_giua_mat')}
                    onClick={() => onChange({ ...transform, offsetXPct: 0, offsetYPct: 0 })}>
                    {t('dieline.mockupArtwork:giua')}
                </button>
                <button type="button" className="dt-mini-btn" title={t('dieline.mockupArtwork:dat_ti_le_ve_100')}
                    onClick={() => onChange({ ...transform, scalePct: 100 })}>
                    ⤢ 100%
                </button>
                <button type="button" className="dt-mini-btn" title={t('dieline.mockupArtwork:xoay_them_90')}
                    onClick={() => onChange({ ...transform, rotationDeg: wrapDeg((transform.rotationDeg ?? 0) + 90) })}>
                    ⟳ 90°
                </button>
                <button type="button" className={`dt-mini-btn ${transform.flipH ? 'active' : ''}`} title={t('dieline.mockupArtwork:lat_ngang_anh')}
                    onClick={() => onChange({ ...transform, flipH: !transform.flipH })}>
                    ⇋ Ngang
                </button>
                <button type="button" className={`dt-mini-btn ${transform.flipV ? 'active' : ''}`} title={t('dieline.mockupArtwork:lat_doc_anh')}
                    onClick={() => onChange({ ...transform, flipV: !transform.flipV })}>
                    {t('dieline.mockupArtwork:doc')}
                </button>
                <button type="button" className="dt-mini-btn" title={t('dieline.mockupArtwork:dat_lai_toan_bo_transform')}
                    onClick={() => onChange({ ...DEFAULT_TRANSFORM })}>
                    {t('dieline.mockupArtwork:dat_lai')}
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
  const { t } = useTranslation();
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
                    {url ? (fileName ?? t('dieline.mockupArtwork:anh_da_tai')) : `Kéo-thả hoặc bấm để tải ${label.toLowerCase()}`}
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
                    {t('dieline.mockupArtwork:xoa_anh')}
                </button>
            )}
        </div>
    );
}

export default function MockupArtworkPanel() {
  const { t } = useTranslation();
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
            setError(t('dieline.mockupArtwork:khong_nap_duoc_anh_be_mat_giu_vat_lieu'));
        }
    }

    // ── Tải mặt nạ spot-UV / emboss với xác thực (Yêu cầu 4.6) ──
    async function handleMaskUpload(file: File, setMaskUrl: (url: string | null) => void) {
        setMaskError(null);
        if (!surface) {
            setMaskError(t('dieline.mockupArtwork:chua_co_khuon_be_de_xac_dinh_kich_thuoc'));
            return;
        }
        let info: LoadedImageInfo;
        try {
            info = await loadImageFile(file);
        } catch {
            setMaskError(t('dieline.mockupArtwork:khong_nap_duoc_mat_na_anh_hong_hoac_sai'));
            return;
        }
        const result = validateMask(
            { width: info.width, height: info.height, format: info.format },
            surface,
            { allowResize: true },
        );
        if (!result.valid) {
            URL.revokeObjectURL(info.url);
            setMaskError(result.reason ?? t('dieline.mockupArtwork:mat_na_khong_hop_le'));
            return;
        }
        setMaskUrl(info.url);
        // Lệch kích thước → KHÔNG chặn, chỉ thông báo sẽ co giãn theo bề mặt.
        if (info.width !== surface.width || info.height !== surface.height) {
            setMaskError(`Mặt nạ ${info.width}×${info.height}px sẽ được co giãn về bề mặt ${surface.width}×${surface.height}px.`);
        }
    }

    const placementModes: { id: PlacementMode; label: string; hint: string }[] = [
        { id: 'per-face', label: t('dieline.mockupArtwork:theo_tung_mat'), hint: t('dieline.mockupArtwork:moi_mat_anh_xa_anh_doc_lap_theo_bbox') },
        { id: 'aligned-to-dieline', label: t('dieline.mockupArtwork:canh_theo_khuon'), hint: t('dieline.mockupArtwork:canh_anh_theo_toa_do_khuon_be_bien_anh') },
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
                    title={t('dieline.mockupArtwork:hoan_tac_ctrl_z')}
                >
                    {t('dieline.mockupArtwork:hoan_tac')}
                </button>
                <button
                    type="button"
                    className="dt-mini-btn"
                    onClick={() => redoArtwork()}
                    disabled={!canRedo}
                    style={!canRedo ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
                    title={t('dieline.mockupArtwork:lam_lai_ctrl_y')}
                >
                    {t('dieline.mockupArtwork:lam_lai')}
                </button>
            </div>

            {/* ─── Ảnh mặt ngoài (mở sẵn) ─── */}
            <CollapsibleSection title={t('dieline.mockupArtwork:anh_mat_ngoai')} defaultOpen badge={artwork.outer.url ? '●' : undefined}>
                <ArtworkUploader
                    label={t('dieline.mockupArtwork:anh_mat_ngoai')}
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
                    title={t('dieline.mockupArtwork:bat_de_keo_anh_truc_tiep_tren_mat_3d')}
                >
                    <label className="dt-param-cell-label" style={{ cursor: 'inherit' }}>
                        {t('dieline.mockupArtwork:keo_anh_tren_mo_hinh_3d')}
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
                        {t('dieline.mockupArtwork:dang_bat_keo_chuot_tren_mat_hop_de_doi')}
                    </p>
                )}
            </CollapsibleSection>

            {/* ─── Chế độ đặt ảnh ─── */}
            <CollapsibleSection title={t('dieline.mockupArtwork:che_do_dat_anh')}>
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
            <CollapsibleSection title={t('dieline.mockupArtwork:in_mat_trong')} badge={artwork.inner.enabled ? t('dieline.mockupArtwork:bat') : undefined}>
                <div
                    className="dt-param-cell"
                    style={{ cursor: 'pointer' }}
                    onClick={() => setInnerArtworkEnabled(!artwork.inner.enabled)}
                    title={t('dieline.mockupArtwork:in_anh_rieng_cho_mat_trong_hop_doc_dung')}
                >
                    <label className="dt-section-label" style={{ cursor: 'pointer', margin: 0 }}>
                        {t('dieline.mockupArtwork:bat_in_mat_trong')}
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
                            label={t('dieline.mockupArtwork:anh_mat_trong')}
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
                    title={t('dieline.mockupArtwork:hien_duong_bien_vung_tran_le_bleed_va')}
                >
                    <label className="dt-section-label" style={{ cursor: 'pointer', margin: 0 }}>
                        {t('dieline.mockupArtwork:hien_bleed_safe_area')}
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
            <CollapsibleSection title={t('dieline.mockupArtwork:mat_na_gia_cong')}>
                <p className="dt-param-desc">
                    {surface
                        ? `Kích thước mặt nạ phải khớp bề mặt ${surface.width}×${surface.height} px.`
                        : t('dieline.mockupArtwork:can_co_khuon_be_de_xac_dinh_kich_thuoc')}
                </p>

                <div className="dt-glue-side-toggle">
                    <label className="dt-glue-side-btn" style={{ cursor: 'pointer' }} title={t('dieline.mockupArtwork:tai_mat_na_phu_uv_cuc_bo_spot_uv')}>
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
                            title={t('dieline.mockupArtwork:xoa_mask_spot_uv')}
                        >
                            🗑️
                        </button>
                    )}
                </div>

                <div className="dt-glue-side-toggle" style={{ marginTop: '0.5rem' }}>
                    <label className="dt-glue-side-btn" style={{ cursor: 'pointer' }} title={t('dieline.mockupArtwork:tai_mat_na_dap_noi_emboss')}>
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
                            title={t('dieline.mockupArtwork:xoa_mask_emboss')}
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
                    label={t('dieline.mockupArtwork:do_cao_emboss')}
                    value={artwork.embossHeightMm}
                    min={EMBOSS_MIN_HEIGHT_MM}
                    max={EMBOSS_MAX_HEIGHT_MM}
                    step={0.1}
                    unit=" mm"
                    title={t('dieline.mockupArtwork:chieu_cao_dap_noi_mo_phong_theo_mat_na')}
                    onChange={setEmbossHeightMm}
                />
            </CollapsibleSection>
        </div>
    );
}
