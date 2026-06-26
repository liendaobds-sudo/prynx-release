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
            <CollapsibleSection title="Vật liệu / Gia công bề mặt" defaultOpen badge={finishLabel}>
                <select
                    className="dt-param-select"
                    value={finishId}
                    onChange={(e) => setFinishId(e.target.value as FinishId)}
                    title="Kiểu gia công bề mặt (PBR): kraft, cán mờ/bóng, spot-UV, ép kim, dập nổi…"
                >
                    {finishes.map((f) => (
                        <option key={f.id} value={f.id}>{f.label}</option>
                    ))}
                </select>

                <label className="dt-section-label" style={{ marginTop: '0.75rem' }}>Màu cạnh giấy</label>
                <div className="dt-glue-side-toggle">
                    {EDGE_COLORS.map((c) => (
                        <button
                            key={c.id}
                            className={`dt-glue-side-btn ${edgeColor === c.id ? 'active' : ''}`}
                            onClick={() => setEdgeColor(c.id)}
                            title="Màu mép giấy lộ ở tường cạnh"
                        >
                            {c.label}
                        </button>
                    ))}
                </div>
            </CollapsibleSection>

            {/* ─── Cảnh / Ánh sáng / Camera ─── */}
            <CollapsibleSection title="Cảnh & Góc nhìn" defaultOpen>
                <label className="dt-section-label">Ánh sáng studio (HDRI)</label>
                <select
                    className="dt-param-select"
                    value={hdriPreset}
                    onChange={(e) => setHdriPreset(e.target.value)}
                    title="Môi trường chiếu sáng IBL/HDRI"
                >
                    {HDRI_PRESETS.map((p) => (
                        <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                </select>

                <label className="dt-section-label" style={{ marginTop: '0.75rem' }}>Phông nền / sàn</label>
                <select
                    className="dt-param-select"
                    value={backgroundPreset}
                    onChange={(e) => setBackgroundPreset(e.target.value)}
                >
                    {BACKGROUND_PRESETS.map((p) => (
                        <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                </select>

                <label className="dt-section-label" style={{ marginTop: '0.75rem' }}>Góc nhìn camera</label>
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
                    title="Canh khung & đặt lại góc nhìn về preset hiện tại (sau khi đã xoay/zoom/kéo)"
                >
                    🎯 Canh khung / Đặt lại góc nhìn
                </button>
            </CollapsibleSection>

            {/* ─── Exploded view + overlay kích thước ─── */}
            <CollapsibleSection title="Tách rời & Kích thước">
                <div className="dt-param-slider">
                    <div className="dt-param-header">
                        <label className="dt-param-label">Tách rời (exploded)</label>
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
                        title="Tách các mặt theo pháp tuyến để xem cấu trúc gập"
                    />
                </div>

                <div
                    className="dt-param-cell"
                    style={{ cursor: 'pointer', marginTop: '0.5rem' }}
                    onClick={() => setShowDimensions(!showDimensions)}
                    title="Hiện nhãn kích thước Dài × Rộng × Cao"
                >
                    <label className="dt-param-cell-label" style={{ cursor: 'pointer' }}>
                        Hiện kích thước L×W×H
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
            <CollapsibleSection title="Xuất mockup">
                <div className="dt-param-header" style={{ marginBottom: '0.35rem' }}>
                    <label className="dt-param-label">Độ phân giải</label>
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
                    <button className="dt-glue-side-btn" onClick={() => requestExportPng()} title="Xuất ảnh PNG phía client">
                        ⬇ Xuất PNG
                    </button>
                    <button className="dt-glue-side-btn" onClick={() => requestExportBatch()} title="Xuất 4 góc: mặt trước, phối cảnh, từ trên, trực giao">
                        ⬇ 4 góc
                    </button>
                    <button className="dt-glue-side-btn" onClick={() => requestExportGlb()} title="Xuất mô hình GLB phía client">
                        ⬇ GLB
                    </button>
                </div>

                <div
                    className="dt-param-cell"
                    style={{ cursor: 'pointer', marginTop: '0.5rem' }}
                    onClick={() => setExportTransparent(!exportTransparent)}
                    title="Ẩn nền/sàn và xuất PNG có nền trong suốt (alpha)"
                >
                    <label className="dt-param-cell-label" style={{ cursor: 'pointer' }}>
                        Nền trong suốt (PNG)
                    </label>
                    <input
                        type="checkbox"
                        checked={exportTransparent}
                        readOnly
                        style={{ accentColor: 'var(--dt-accent)' }}
                    />
                </div>
                <p className="dt-param-desc">
                    Ảnh PNG xuất theo độ phân giải đã chọn; GLB xuất hộp ở trạng thái gập hiện tại.
                </p>
            </CollapsibleSection>

            {/* ─── Lưu / khôi phục cấu hình cảnh ─── */}
            <CollapsibleSection title="Cấu hình cảnh">
                <p className="dt-param-desc" style={{ marginTop: 0 }}>
                    Lưu finish, môi trường, góc nhìn và canh chỉnh ảnh (không gồm tệp ảnh) để dùng lại lần sau.
                </p>
                <div className="dt-glue-side-toggle">
                    <button className="dt-glue-side-btn" onClick={() => saveScenePreset()} title="Lưu cấu hình cảnh hiện tại">
                        💾 Lưu
                    </button>
                    <button
                        className="dt-glue-side-btn"
                        onClick={() => loadScenePreset()}
                        disabled={!scenePresetSaved}
                        style={!scenePresetSaved ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
                        title={scenePresetSaved ? 'Khôi phục cấu hình đã lưu' : 'Chưa có cấu hình đã lưu'}
                    >
                        ♻ Khôi phục
                    </button>
                </div>
            </CollapsibleSection>
        </div>
    );
}
