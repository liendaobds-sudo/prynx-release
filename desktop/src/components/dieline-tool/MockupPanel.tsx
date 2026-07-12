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
//   - Hệ số tách exploded view + toggle overlay kích thước (Yêu cầu 7.5, 7.7)
//   - Hệ số xuất (1x/2x/4x — Yêu cầu 6.2) + nút xuất PNG/GLB (Yêu cầu 6.1, 6.6)
//
// _Requirements: 4.1, 6.1, 6.2, 6.6, 7.3_
// ============================================================

import React from 'react';
import { useMockupStore, type CameraPreset } from '../../store/useMockupStore';
import {
    FINISH_LIBRARY,
    type FinishId,
    type EdgeColor,
    type ExportScale,
} from '../../lib/mockup3d';
import { HDRI_PRESETS } from './EnvironmentRig';
import { BACKGROUND_PRESETS } from './ShadowFloor';
import {
    EXPLODED_FACTOR_MIN,
    EXPLODED_FACTOR_MAX,
} from '../../store/useMockupStore';
import CollapsibleSection from './CollapsibleSection';
import { useTranslation } from 'react-i18next';

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
    const finishId = useMockupStore((s) => s.finishId);
    const setFinishId = useMockupStore((s) => s.setFinishId);
    const edgeColor = useMockupStore((s) => s.edgeColor);
    const setEdgeColor = useMockupStore((s) => s.setEdgeColor);
    const hdriPreset = useMockupStore((s) => s.hdriPreset);
    const setHdriPreset = useMockupStore((s) => s.setHdriPreset);
    const cameraPreset = useMockupStore((s) => s.cameraPreset);
    const setCameraPreset = useMockupStore((s) => s.setCameraPreset);
    const requestCameraReset = useMockupStore((s) => s.requestCameraReset);
    const backgroundPreset = useMockupStore((s) => s.backgroundPreset);
    const setBackgroundPreset = useMockupStore((s) => s.setBackgroundPreset);
    const explodedFactor = useMockupStore((s) => s.explodedFactor);
    const setExplodedFactor = useMockupStore((s) => s.setExplodedFactor);
    const showDimensions = useMockupStore((s) => s.showDimensions);
    const setShowDimensions = useMockupStore((s) => s.setShowDimensions);
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

    // Danh sách finish lấy trực tiếp từ thư viện (Yêu cầu 4.1).
    const finishes = React.useMemo(() => Object.values(FINISH_LIBRARY), []);
    const finishLabel = finishes.find((f) => f.id === finishId)?.label;

    return (
        <div className="dt-param-panel">
            {/* ─── Vật liệu / Finish (mở sẵn) ─── */}
            <CollapsibleSection title={t('dieline.mockup:vat_lieu_gia_cong_be_mat')} defaultOpen badge={finishLabel}>
                <select
                    className="dt-param-select"
                    value={finishId}
                    onChange={(e) => setFinishId(e.target.value as FinishId)}
                    title={t('dieline.mockup:kieu_gia_cong_be_mat_pbr_kraft_can_mo')}
                >
                    {finishes.map((f) => (
                        <option key={f.id} value={f.id}>{f.label}</option>
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
                            {c.label}
                        </button>
                    ))}
                </div>
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
                        <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                </select>

                <label className="dt-section-label" style={{ marginTop: '0.75rem' }}>{t('dieline.mockup:phong_nen_san')}</label>
                <select
                    className="dt-param-select"
                    value={backgroundPreset}
                    onChange={(e) => setBackgroundPreset(e.target.value)}
                >
                    {BACKGROUND_PRESETS.map((p) => (
                        <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                </select>

                <label className="dt-section-label" style={{ marginTop: '0.75rem' }}>{t('dieline.mockup:goc_nhin_camera')}</label>
                <div className="dt-glue-side-toggle">
                    {CAMERA_PRESETS.map((c) => (
                        <button
                            key={c.id}
                            className={`dt-glue-side-btn ${cameraPreset === c.id ? 'active' : ''}`}
                            onClick={() => setCameraPreset(c.id)}
                        >
                            {c.label}
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
            </CollapsibleSection>

            {/* ─── Exploded view + overlay kích thước ─── */}
            <CollapsibleSection title={t('dieline.mockup:tach_roi_kich_thuoc')}>
                <div className="dt-param-slider">
                    <div className="dt-param-header">
                        <label className="dt-param-label">{t('dieline.mockup:tach_roi_exploded')}</label>
                        <span className="dt-param-value">{explodedFactor.toFixed(1)}×</span>
                    </div>
                    <input
                        type="range"
                        min={EXPLODED_FACTOR_MIN}
                        max={EXPLODED_FACTOR_MAX}
                        step={0.1}
                        value={explodedFactor}
                        className="dt-param-range"
                        style={{ accentColor: 'var(--dt-accent)', width: '100%' }}
                        onChange={(e) => setExplodedFactor(parseFloat(e.target.value))}
                        title={t('dieline.mockup:tach_cac_mat_theo_phap_tuyen_de_xem_cau')}
                    />
                </div>

                <div
                    className="dt-param-cell"
                    style={{ cursor: 'pointer', marginTop: '0.5rem' }}
                    onClick={() => setShowDimensions(!showDimensions)}
                    title={t('dieline.mockup:hien_nhan_kich_thuoc_dai_rong_cao')}
                >
                    <label className="dt-param-cell-label" style={{ cursor: 'pointer' }}>
                        {t('dieline.mockup:hien_kich_thuoc_l_w_h')}
                    </label>
                    <input
                        type="checkbox"
                        checked={showDimensions}
                        readOnly
                        style={{ accentColor: 'var(--dt-accent)' }}
                    />
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
