// ============================================================
// MockupPanel — Mockup 3D Realism (Render/Control Layer)
//
// Bảng điều khiển (UI DOM, KHÔNG nằm trong Canvas) tập hợp toàn bộ điều
// khiển trình bày mockup 3D, nối tới `useMockupStore` và hook xuất cảnh.
// Các nhóm được tổ chức thành section gập/mở (accordion) cho gọn.
//
//   - Chọn finish từ `FINISH_LIBRARY` (Yêu cầu 4.1)
//   - Màu cạnh giấy (kraft/white) (Yêu cầu 1.2 → 7.3)
//   - Preset HDRI studio (≥3) (Yêu cầu 3.2)
//   - Preset camera (4 preset) + nút Fit/Reset góc nhìn (Yêu cầu 7.1)
//   - Preset nền/sàn (≥2) (Yêu cầu 7.3)
//   - Hệ số xuất (1x/2x/4x — Yêu cầu 6.2) + nút xuất PNG/GLB (Yêu cầu 6.1, 6.6)
//
// _Requirements: 4.1, 6.1, 6.2, 6.6, 7.3_
// ============================================================

import React from 'react';
import { useMockupStore, type CameraPreset, type MockupQualityTier } from '../../store/useMockupStore';
// [HANGING-WINDOW 2026-07-27] Cần biết khuôn hiện tại có lỗ cửa sổ hay không.
import { useBoxStore } from '../../store/useBoxStore';
import {
    SUBSTRATE_LIBRARY,
    SURFACE_FINISH_LIBRARY,
    composeAppearance,
    TONE_EXPOSURE_MAX,
    TONE_EXPOSURE_MIN,
    type SubstrateId,
    type SurfaceFinishId,
    type EdgeColor,
    type ExportScale,
} from '../../lib/mockup3d';
import { HDRI_PRESETS } from './EnvironmentRig';
import { BACKGROUND_PRESETS } from './ShadowFloor';
import CollapsibleSection from './CollapsibleSection';
import { useTranslation } from 'react-i18next';
import { tv } from '../../i18n';

/** Bốn preset camera hợp lệ (Yêu cầu 7.1). */
const CAMERA_PRESETS: { id: CameraPreset; label: string }[] = [
    { id: 'front', label: 'Mặt trước' },
    { id: 'top', label: 'Từ trên' },
    { id: 'isometric', label: 'Phối cảnh' },
    { id: 'orthographic', label: 'Trực giao' },
];

/** Hệ số xuất hợp lệ (Yêu cầu 6.2). */
const EXPORT_SCALES: ExportScale[] = [1, 2, 4];

/** Màu cạnh giấy hợp lệ (Yêu cầu 1.2). */
const EDGE_COLORS: { id: EdgeColor; label: string }[] = [
    { id: 'kraft', label: 'Kraft' },
    { id: 'white', label: 'Trắng' },
];

export default function MockupPanel() {
  const { t } = useTranslation();
    const substrateId = useMockupStore((s) => s.substrateId);
    const setSubstrateId = useMockupStore((s) => s.setSubstrateId);
    const surfaceFinishId = useMockupStore((s) => s.surfaceFinishId);
    const setSurfaceFinishId = useMockupStore((s) => s.setSurfaceFinishId);
    const edgeColor = useMockupStore((s) => s.edgeColor);
    const setEdgeColor = useMockupStore((s) => s.setEdgeColor);
    const hdriPreset = useMockupStore((s) => s.hdriPreset);
    const setHdriPreset = useMockupStore((s) => s.setHdriPreset);
    const cameraPreset = useMockupStore((s) => s.cameraPreset);
    const setCameraPreset = useMockupStore((s) => s.setCameraPreset);
    const requestCameraReset = useMockupStore((s) => s.requestCameraReset);
    const backgroundPreset = useMockupStore((s) => s.backgroundPreset);
    const setBackgroundPreset = useMockupStore((s) => s.setBackgroundPreset);
    const qualityTier = useMockupStore((s) => s.qualityTier);
    const setQualityTier = useMockupStore((s) => s.setQualityTier);
    const toneExposure = useMockupStore((s) => s.toneExposure);
    const setToneExposure = useMockupStore((s) => s.setToneExposure);
    const showPaperGrain = useMockupStore((s) => s.showPaperGrain);
    const setShowPaperGrain = useMockupStore((s) => s.setShowPaperGrain);
    // [HANGING-WINDOW 2026-07-27] Công tắc màng cửa sổ; chỉ hiện khi khuôn hiện
    // tại THẬT SỰ có lỗ cửa sổ (mặt trước của hộp treo) — tránh ô tích vô nghĩa.
    const showWindowFilm = useMockupStore((s) => s.showWindowFilm);
    const setShowWindowFilm = useMockupStore((s) => s.setShowWindowFilm);
    const hasWindowHole = useBoxStore((s) => (
        s.dieline?.params.boxType === 'hanging_window'
        && (s.dieline?.panels.some((p) => p.name === 'front' && (p.holes?.length ?? 0) > 0) ?? false)
    ));
    const showTechnicalLines = useMockupStore((s) => s.showTechnicalLines);
    const setShowTechnicalLines = useMockupStore((s) => s.setShowTechnicalLines);
    const showFloorGrid = useMockupStore((s) => s.showFloorGrid);
    const setShowFloorGrid = useMockupStore((s) => s.setShowFloorGrid);
    const exportScale = useMockupStore((s) => s.exportScale);
    const setExportScale = useMockupStore((s) => s.setExportScale);
    const exportTransparent = useMockupStore((s) => s.exportTransparent);
    const setExportTransparent = useMockupStore((s) => s.setExportTransparent);
    const requestExportPng = useMockupStore((s) => s.requestExportPng);
    const requestExportGlb = useMockupStore((s) => s.requestExportGlb);
    const requestExportBatch = useMockupStore((s) => s.requestExportBatch);
    const saveScenePreset = useMockupStore((s) => s.saveScenePreset);
    const loadScenePreset = useMockupStore((s) => s.loadScenePreset);
    const scenePresetSaved = useMockupStore((s) => s.scenePresetSaved);

    const substrates = React.useMemo(() => Object.values(SUBSTRATE_LIBRARY), []);
    const surfaces = React.useMemo(() => Object.values(SURFACE_FINISH_LIBRARY), []);
    const appearanceLabel = React.useMemo(
        () => composeAppearance(substrateId, surfaceFinishId).label,
        [substrateId, surfaceFinishId],
    );

    return (
        <div className="dt-param-panel">
            {/* ─── Chất liệu giấy + Gia công bề mặt (tách trục) ─── */}
            <CollapsibleSection title="Vật liệu & gia công" defaultOpen badge={appearanceLabel}>
                <label className="dt-section-label">Chất liệu giấy</label>
                <select
                    className="dt-param-select"
                    value={substrateId}
                    onChange={(e) => setSubstrateId(e.target.value as SubstrateId)}
                    title="Loại giấy/board (substrate) — độc lập với gia công"
                >
                    {substrates.map((s) => (
                        <option key={s.id} value={s.id}>{tv(s.label)}</option>
                    ))}
                </select>

                <label className="dt-section-label" style={{ marginTop: '0.75rem' }}>
                    Gia công bề mặt
                </label>
                <select
                    className="dt-param-select"
                    value={surfaceFinishId}
                    onChange={(e) => setSurfaceFinishId(e.target.value as SurfaceFinishId)}
                    title="Cán màng, spot-UV, ép kim, emboss — độc lập với loại giấy"
                >
                    {surfaces.map((s) => (
                        <option key={s.id} value={s.id}>{tv(s.label)}</option>
                    ))}
                </select>

                <label className="dt-section-label" style={{ marginTop: '0.75rem' }}>{t('dieline.mockup:mau_canh_giay')}</label>
                <div className="dt-glue-side-toggle">
                    {EDGE_COLORS.map((c) => (
                        <button
                            key={c.id}
                            className={`dt-glue-side-btn ${edgeColor === c.id ? 'active' : ''}`}
                            onClick={() => setEdgeColor(c.id)}
                            title={t('dieline.mockup:mau_mep_giay_lo_o_tuong_canh')}
                        >
                            {tv(c.label)}
                        </button>
                    ))}
                </div>

                <div
                    className="dt-param-cell"
                    style={{ cursor: 'pointer', marginTop: '0.75rem' }}
                    onClick={() => setShowPaperGrain(!showPaperGrain)}
                    title="Bump sợi giấy procedural (kraft/SBS) — 0 mạng"
                >
                    <label className="dt-param-cell-label" style={{ cursor: 'pointer' }}>
                        Sợi giấy (grain)
                    </label>
                    <input type="checkbox" checked={showPaperGrain} readOnly style={{ accentColor: 'var(--dt-accent)' }} />
                </div>

                {/* [HANGING-WINDOW 2026-07-27] Màng cửa sổ — chỉ hiện với hộp có cửa sổ. */}
                {hasWindowHole && (
                    <div
                        className="dt-param-cell"
                        style={{ cursor: 'pointer', marginTop: '0.75rem' }}
                        onClick={() => setShowWindowFilm(!showWindowFilm)}
                        title="Màng PVC/PET trong suốt dán mặt trong cửa sổ — chỉ hiển thị 3D, không đổi khuôn bế"
                    >
                        <label className="dt-param-cell-label" style={{ cursor: 'pointer' }}>
                            Màng cửa sổ (PVC)
                        </label>
                        <input type="checkbox" checked={showWindowFilm} readOnly style={{ accentColor: 'var(--dt-accent)' }} />
                    </div>
                )}
            </CollapsibleSection>

            {/* ─── Cảnh / Ánh sáng / Camera ─── */}
            <CollapsibleSection title={t('dieline.mockup:canh_goc_nhin')} defaultOpen>
                <label className="dt-section-label">{t('dieline.mockup:anh_sang_studio_hdri')}</label>
                <select
                    className="dt-param-select"
                    value={hdriPreset}
                    onChange={(e) => setHdriPreset(e.target.value)}
                    title={t('dieline.mockup:moi_truong_chieu_sang_ibl_hdri')}
                >
                    {HDRI_PRESETS.map((p) => (
                        <option key={p.id} value={p.id}>{tv(p.label)}</option>
                    ))}
                </select>

                <label className="dt-section-label" style={{ marginTop: '0.75rem' }}>{t('dieline.mockup:phong_nen_san')}</label>
                <select
                    className="dt-param-select"
                    value={backgroundPreset}
                    onChange={(e) => setBackgroundPreset(e.target.value)}
                >
                    {BACKGROUND_PRESETS.map((p) => (
                        <option key={p.id} value={p.id}>{tv(p.label)}</option>
                    ))}
                </select>

                <label className="dt-section-label" style={{ marginTop: '0.75rem' }}>
                    Chất lượng render
                </label>
                <div className="dt-glue-side-toggle">
                    {([
                        { id: 'balanced' as MockupQualityTier, label: 'Cân bằng' },
                        { id: 'high' as MockupQualityTier, label: 'Cao' },
                    ]).map((q) => (
                        <button
                            key={q.id}
                            type="button"
                            className={`dt-glue-side-btn ${qualityTier === q.id ? 'active' : ''}`}
                            onClick={() => setQualityTier(q.id)}
                            title={q.id === 'high'
                                ? 'Env map 512 — bóng/foil sắc hơn, tốn GPU hơn'
                                : 'Env map 256 — mượt trên máy yếu'}
                        >
                            {q.label}
                        </button>
                    ))}
                </div>

                <label className="dt-section-label" style={{ marginTop: '0.75rem' }}>
                    Phơi sáng
                </label>
                <div className="dt-param-header" style={{ marginBottom: '0.25rem' }}>
                    <input
                        type="range"
                        min={TONE_EXPOSURE_MIN}
                        max={TONE_EXPOSURE_MAX}
                        step={0.05}
                        value={toneExposure}
                        onChange={(e) => setToneExposure(Number(e.target.value))}
                        style={{ width: '100%' }}
                        title="Tone mapping exposure (ACES)"
                    />
                    <span className="dt-param-label" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {toneExposure.toFixed(2)}
                    </span>
                </div>

                <label className="dt-section-label" style={{ marginTop: '0.75rem' }}>{t('dieline.mockup:goc_nhin_camera')}</label>
                <div className="dt-glue-side-toggle">
                    {CAMERA_PRESETS.map((c) => (
                        <button
                            key={c.id}
                            className={`dt-glue-side-btn ${cameraPreset === c.id ? 'active' : ''}`}
                            onClick={() => setCameraPreset(c.id)}
                        >
                            {tv(c.label)}
                        </button>
                    ))}
                </div>
                <button
                    type="button"
                    className="dt-glue-side-btn"
                    style={{ width: '100%', marginTop: '0.5rem' }}
                    onClick={() => requestCameraReset()}
                    title={t('dieline.mockup:canh_khung_dat_lai_goc_nhin_ve_preset')}
                >
                    {t('dieline.mockup:canh_khung_dat_lai_goc_nhin')}
                </button>

                <div
                    className="dt-param-cell"
                    style={{ cursor: 'pointer', marginTop: '0.5rem' }}
                    onClick={() => setShowTechnicalLines(!showTechnicalLines)}
                    title={t('dieline.mockup:duong_ky_thuat_mo_ta')}
                >
                    <label className="dt-param-cell-label" style={{ cursor: 'pointer' }}>
                        {t('dieline.mockup:duong_ky_thuat')}
                    </label>
                    <input type="checkbox" checked={showTechnicalLines} readOnly style={{ accentColor: 'var(--dt-accent)' }} />
                </div>

                <div
                    className="dt-param-cell"
                    style={{ cursor: 'pointer', marginTop: '0.5rem' }}
                    onClick={() => setShowFloorGrid(!showFloorGrid)}
                    title={t('dieline.mockup:luoi_san_mo_ta')}
                >
                    <label className="dt-param-cell-label" style={{ cursor: 'pointer' }}>
                        {t('dieline.mockup:luoi_san')}
                    </label>
                    <input type="checkbox" checked={showFloorGrid} readOnly style={{ accentColor: 'var(--dt-accent)' }} />
                </div>
            </CollapsibleSection>

            {/* ─── Xuất ảnh / mô hình ─── */}
            <CollapsibleSection title={t('dieline.mockup:xuat_mockup')}>
                <div className="dt-param-header" style={{ marginBottom: '0.35rem' }}>
                    <label className="dt-param-label">{t('dieline.mockup:do_phan_giai')}</label>
                </div>
                <div className="dt-glue-side-toggle">
                    {EXPORT_SCALES.map((s) => (
                        <button
                            key={s}
                            className={`dt-glue-side-btn ${exportScale === s ? 'active' : ''}`}
                            onClick={() => setExportScale(s)}
                        >
                            {s}×
                        </button>
                    ))}
                </div>

                <div className="dt-glue-side-toggle" style={{ marginTop: '0.5rem' }}>
                    <button className="dt-glue-side-btn" onClick={() => requestExportPng()} title={t('dieline.mockup:xuat_anh_png_phia_client')}>
                        {t('dieline.mockup:xuat_png')}
                    </button>
                    <button className="dt-glue-side-btn" onClick={() => requestExportBatch()} title={t('dieline.mockup:xuat_4_goc_mat_truoc_phoi_canh_tu_tren')}>
                        {t('dieline.mockup:4_goc')}
                    </button>
                    <button className="dt-glue-side-btn" onClick={() => requestExportGlb()} title={t('dieline.mockup:xuat_mo_hinh_glb_phia_client')}>
                        ⬇ GLB
                    </button>
                </div>

                <div
                    className="dt-param-cell"
                    style={{ cursor: 'pointer', marginTop: '0.5rem' }}
                    onClick={() => setExportTransparent(!exportTransparent)}
                    title={t('dieline.mockup:an_nen_san_va_xuat_png_co_nen_trong')}
                >
                    <label className="dt-param-cell-label" style={{ cursor: 'pointer' }}>
                        {t('dieline.mockup:nen_trong_suot_png')}
                    </label>
                    <input
                        type="checkbox"
                        checked={exportTransparent}
                        readOnly
                        style={{ accentColor: 'var(--dt-accent)' }}
                    />
                </div>
                <p className="dt-param-desc">
                    {t('dieline.mockup:anh_png_xuat_theo_do_phan_giai_da_chon')}
                </p>
            </CollapsibleSection>

            {/* ─── Lưu / khôi phục cấu hình cảnh ─── */}
            <CollapsibleSection title={t('dieline.mockup:cau_hinh_canh')}>
                <p className="dt-param-desc" style={{ marginTop: 0 }}>
                    {t('dieline.mockup:luu_finish_moi_truong_goc_nhin_va_canh')}
                </p>
                <div className="dt-glue-side-toggle">
                    <button className="dt-glue-side-btn" onClick={() => saveScenePreset()} title={t('dieline.mockup:luu_cau_hinh_canh_hien_tai')}>
                        {t('dieline.mockup:luu')}
                    </button>
                    <button
                        className="dt-glue-side-btn"
                        onClick={() => loadScenePreset()}
                        disabled={!scenePresetSaved}
                        style={!scenePresetSaved ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
                        title={scenePresetSaved ? t('dieline.mockup:khoi_phuc_cau_hinh_da_luu') : t('dieline.mockup:chua_co_cau_hinh_da_luu')}
                    >
                        {t('dieline.mockup:khoi_phuc')}
                    </button>
                </div>
            </CollapsibleSection>
        </div>
    );
}
