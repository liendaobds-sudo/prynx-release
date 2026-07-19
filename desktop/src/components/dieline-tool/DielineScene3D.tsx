// ============================================================
// DielineScene3D — Recursive Panel Folding Engine (3D branch)
// Generic 3D folding cho TẤT CẢ loại hộp dựa trên cây Panel
//
// Task 10.1 — Wiring lớp render mockup 3D vào nhánh xem 3D:
//   - MockupCanvas  : vỏ Canvas + tone mapping ACESFilmic + guard WebGL
//                     (useWebGLSupport + WebGLFallback) (Yêu cầu 3.4, 8.4)
//   - EnvironmentRig: HDRI/IBL + phản chiếu + fallback đèn studio (Yêu cầu 3.1)
//   - CameraRig     : 4 preset camera, chuyển cảnh ≤500ms (Yêu cầu 7.1)
//   - ShadowFloor   : contact/soft shadow + preset nền/sàn (Yêu cầu 3.5)
//   - SolidPanelMesh: panel solid có độ dày thay FlatPanelMesh
//   - DimensionOverlay: overlay kích thước L×W×H (Yêu cầu 7.7)
//
// Nhánh 2D (DielineCanvas2D), generator và đường dẫn dieline KHÔNG bị
// chạm tới. Component này chỉ render khi tab "Mô phỏng 3D" được chọn.
//
// _Requirements: 3.1, 3.5, 7.1, 8.4, 9.3_
// ============================================================

import React, { useMemo, useRef, useEffect } from 'react';
import { useLoader } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, GizmoViewcube } from '@react-three/drei';
import * as THREE from 'three';
import { useBoxStore } from '../../store/useBoxStore';
import { useMockupStore } from '../../store/useMockupStore';
import { Panel } from '../../lib/dieline/types';
import MockupCanvas from './MockupCanvas';
import EnvironmentRig from './EnvironmentRig';
import CameraRig from './CameraRig';
import ShadowFloor from './ShadowFloor';
import DimensionOverlay from './DimensionOverlay';
import SolidPanelMesh from './SolidPanelMesh';
import GussetMesh from './GussetMesh';
import { computeConeWarp } from '../../lib/mockup3d/cupSleeveCone';
import { useSceneExport } from './useSceneExport';
import { useTranslation } from 'react-i18next';

// ─── Helpers ───────────────────────────────────────────────

/** Tính depth (level) trong cây panel → dùng cho auto foldPhase */
function computeDepths(panels: Panel[]): Map<string, number> {
    const depthMap = new Map<string, number>();
    const nameMap = new Map(panels.map(p => [p.name, p]));

    function getDepth(name: string): number {
        if (depthMap.has(name)) return depthMap.get(name)!;
        const panel = nameMap.get(name);
        if (!panel || !panel.parent) {
            depthMap.set(name, 0);
            return 0;
        }
        const d = getDepth(panel.parent) + 1;
        depthMap.set(name, d);
        return d;
    }

    panels.forEach(p => getDepth(p.name));
    return depthMap;
}

/** Tính max depth */
function maxDepth(depthMap: Map<string, number>): number {
    let max = 0;
    depthMap.forEach(d => { if (d > max) max = d; });
    return max;
}

// Placeholder 1x1 trong suốt để useLoader luôn có nguồn hợp lệ khi
// người dùng chưa tải ảnh nghệ thuật (giữ hook ổn định, không request mạng).
const BLANK_TEXTURE =
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// ─── Scene Component ───────────────────────────────────────

function BoxScene() {
    const { dieline, foldProgress, mockupTextureUrl } = useBoxStore();
    // Nguồn ảnh nghệ thuật hợp nhất: ưu tiên ảnh từ panel Mockup (có transform
    // chỉnh được + view canh chỉnh 2D), fallback ảnh tải nhanh ở ParamPanel.
    const outerArtworkUrl = useMockupStore((s) => s.artwork.outer.url);
    const innerArtworkUrl = useMockupStore((s) => s.artwork.inner.url);
    const innerArtworkEnabled = useMockupStore((s) => s.artwork.inner.enabled);
    const showTechnicalLines = useMockupStore((s) => s.showTechnicalLines);
    const textureUrl = outerArtworkUrl ?? mockupTextureUrl;
    const innerUrl = innerArtworkEnabled ? innerArtworkUrl : null;

    // Load texture (placeholder khi chưa có ảnh — giữ hook ổn định).
    const texture = useLoader(
        THREE.TextureLoader,
        textureUrl || BLANK_TEXTURE,
    ) as THREE.Texture;
    const innerTexture = useLoader(
        THREE.TextureLoader,
        innerUrl || BLANK_TEXTURE,
    ) as THREE.Texture;

    // Setup texture color space and wrapping
    useEffect(() => {
        if (texture && textureUrl) {
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.generateMipmaps = true;
            texture.minFilter = THREE.LinearMipmapLinearFilter;
            texture.flipY = true;
        }
    }, [texture, textureUrl]);
    useEffect(() => {
        if (innerTexture && innerUrl) {
            innerTexture.colorSpace = THREE.SRGBColorSpace;
            innerTexture.generateMipmaps = true;
            innerTexture.minFilter = THREE.LinearMipmapLinearFilter;
            innerTexture.flipY = true;
        }
    }, [innerTexture, innerUrl]);
    useEffect(() => () => {
        if (textureUrl?.startsWith('blob:')) {
            texture.dispose();
            useLoader.clear(THREE.TextureLoader, textureUrl);
        }
    }, [texture, textureUrl]);
    useEffect(() => () => {
        if (innerUrl?.startsWith('blob:')) {
            innerTexture.dispose();
            useLoader.clear(THREE.TextureLoader, innerUrl);
        }
    }, [innerTexture, innerUrl]);


    // Compute depth map for auto-phasing (cần cho SolidPanelMesh / foldCompensation).
    const panels = dieline?.panels ?? [];
    const depthMap = useMemo(() => computeDepths(panels), [panels]);
    const maxD = useMemo(() => maxDepth(depthMap), [depthMap]);

    // Bọc ly: tham số cuộn nón cụt cho panel `body` (chỉ khi là khuôn bọc ly).
    // Memo theo thông số ly để ổn định tham chiếu (tránh dựng lại geometry thừa).
    const isCupSleeve = dieline?.standardCode === 'CUP-SLEEVE';
    const coneWarp = useMemo(() => {
        if (!isCupSleeve || !dieline) return null;
        const p = dieline.params;
        return computeConeWarp({
            cupD1: p.cupD1,
            cupD2: p.cupD2,
            cupH: p.cupH,
            cupHeightType: p.cupHeightType,
            cupCoverage: p.cupCoverage,
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        isCupSleeve,
        dieline?.params.cupD1,
        dieline?.params.cupD2,
        dieline?.params.cupH,
        dieline?.params.cupHeightType,
        dieline?.params.cupCoverage,
    ]);

    // Center the model around world origin.
    const center = useMemo(() => {
        if (!dieline) return { x: 0, y: 0 };
        const bb = dieline.boundingBox;
        return {
            x: bb.minX + bb.width / 2,
            y: bb.minY + bb.height / 2,
        };
    }, [dieline]);

    if (!dieline || dieline.panels.length === 0) {
        return null;
    }

    const { params } = dieline;
    // Bì thư là GIẤY MỎNG: render độ dày nhỏ để các mặt gập áp phẳng 180° không
    // lộ rõ chỗ xuyên/khe của khối dày (1.5mm board) — trông phẳng sát như thật.
    const thickness = dieline.standardCode === 'ENV' ? 0.25 : (params.T || 0.5);

    // ── Hộp diêm: LỒNG khay vào vỏ ở cuối hoạt ảnh ──
    // Khi có `nesting`, dồn toàn bộ GẬP vào [0, NEST_START], rồi dùng đoạn
    // [NEST_START, 1] để TRƯỢT khay vào lòng vỏ. Hộp khác giữ nguyên (foldT =
    // foldProgress).
    const NEST_START = 0.8;
    const nesting = dieline.nesting;
    const foldT = nesting ? Math.min(foldProgress / NEST_START, 1) : foldProgress;
    let nestK = 0;
    if (nesting) {
        const raw = Math.max(0, Math.min(1, (foldProgress - NEST_START) / (1 - NEST_START)));
        nestK = raw < 0.5 ? 2 * raw * raw : 1 - Math.pow(-2 * raw + 2, 2) / 2; // ease in-out
    }
    const trayShift: [number, number, number] = nesting
        ? [nesting.x * nestK, nesting.y * nestK, nesting.z * nestK]
        : [0, 0, 0];
    const isSleeve = (name: string) => name.startsWith('sleeve_');
    const trayPanels = nesting ? panels.filter((p) => !isSleeve(p.name)) : panels;
    const sleevePanels = nesting ? panels.filter((p) => isSleeve(p.name)) : [];

    const renderPanel = (panel: Panel) => (
        panel.gusset ? (
            <GussetMesh
                key={panel.name}
                panel={panel}
                allPanels={panels}
                foldProgress={foldT}
                depthMap={depthMap}
                maxD={maxD}
                thickness={thickness}
            />
        ) : (
            <SolidPanelMesh
                key={panel.name}
                panel={panel}
                allPanels={panels}
                foldProgress={foldT}
                depthMap={depthMap}
                maxD={maxD}
                thickness={thickness}
                globalBBox={dieline.boundingBox}
                texture={textureUrl ? texture : null}
                innerTexture={innerUrl ? innerTexture : null}
                coneWarp={isCupSleeve ? coneWarp : null}
                conePaths={panel.name === 'body' && isCupSleeve ? dieline.allPaths : null}
                conePatchOnly={isCupSleeve && panel.name !== 'body'}
                hideCadLines={!showTechnicalLines || dieline.standardCode === 'ENV'}
                roundFolds={dieline.params.boxType === 'pizza'}
            />
        )
    );

    return (
        <group position={[-center.x, -center.y, 0]}>
            {/* Khay (trượt vào vỏ khi đóng) */}
            <group position={trayShift}>
                {trayPanels.map(renderPanel)}
            </group>
            {/* Vỏ (đứng yên) */}
            {sleevePanels.length > 0 && (
                <group>
                    {sleevePanels.map(renderPanel)}
                </group>
            )}
        </group>
    );
}

// ─── Controls ──────────────────────────────────────────────

function FoldControls() {
  const { t } = useTranslation();
    const { foldProgress, setFoldProgress, isAnimating, setIsAnimating } = useBoxStore();
    const animRef = useRef<number | null>(null);

    useEffect(() => {
        if (!isAnimating) {
            if (animRef.current) cancelAnimationFrame(animRef.current);
            return;
        }

        let start: number | null = null;
        const duration = 2000; // 2s full fold

        const animate = (timestamp: number) => {
            if (!start) start = timestamp;
            const elapsed = timestamp - start;
            const t = Math.min(elapsed / duration, 1);
            // Ping-pong: go 0→1 then 1→0
            const pingPong = t <= 0.5 ? t * 2 : 2 - t * 2;
            setFoldProgress(pingPong);

            if (t < 1) {
                animRef.current = requestAnimationFrame(animate);
            } else {
                setIsAnimating(false);
            }
        };

        animRef.current = requestAnimationFrame(animate);
        return () => {
            if (animRef.current) cancelAnimationFrame(animRef.current);
        };
    }, [isAnimating, setFoldProgress, setIsAnimating]);

    return (
        <div className="dt-fold-controls" style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>

            <button
                className={`dt-fold-play-btn ${isAnimating ? 'active' : ''}`}
                onClick={() => setIsAnimating(!isAnimating)}
                title={isAnimating ? t('dieline.dielineScene3D:dung') : t('dieline.dielineScene3D:chay_hoat_anh_gap')}
            >
                {isAnimating ? '⏸' : '▶'}
            </button>
            <button
                className="dt-fold-step-btn"
                onClick={() => { setIsAnimating(false); setFoldProgress(0); }}
                title={t('dieline.dielineScene3D:trai_phang_0')}
            >
                {t('dieline.dielineScene3D:trai')}
            </button>
            <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={foldProgress}
                onChange={(e) => {
                    setIsAnimating(false);
                    setFoldProgress(parseFloat(e.target.value));
                }}
                className="dt-fold-slider"
            />
            <button
                className="dt-fold-step-btn"
                onClick={() => { setIsAnimating(false); setFoldProgress(1); }}
                title={t('dieline.dielineScene3D:gap_hoan_tat_100')}
            >
                {t('dieline.dielineScene3D:gap')}
            </button>
            <span className="dt-fold-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={Math.round(foldProgress * 100)}
                    onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        if (!Number.isNaN(v)) {
                            setIsAnimating(false);
                            setFoldProgress(Math.max(0, Math.min(1, v / 100)));
                        }
                    }}
                    className="dt-num-input"
                    style={{ width: 48 }}
                    title={t('dieline.dielineScene3D:nhap_gap_chinh_xac')}
                />
                %
            </span>
        </div>
    );
}

// ─── Scene Exporter Bridge ─────────────────────────────────
//
// useSceneExport PHẢI chạy bên trong <Canvas> (truy cập renderer/scene/
// camera qua useThree). Các nút xuất nằm ở MockupPanel (DOM, ngoài
// Canvas) nên không gọi hook trực tiếp được. Component cầu nối này lắng
// nghe `exportPngNonce`/`exportGlbNonce` trong store; khi nonce tăng
// (người dùng bấm nút), nó thực thi exportPNG()/exportGLB() tương ứng.
// exportPNG đọc hệ số phóng đại từ `useMockupStore.exportScale` (Yêu cầu 6.2).
//
// _Requirements: 6.1, 6.2, 6.6_

function SceneExporter() {
    const { exportPNG, exportBatchPNG, exportGLB } = useSceneExport();
    const pngNonce = useMockupStore((s) => s.exportPngNonce);
    const glbNonce = useMockupStore((s) => s.exportGlbNonce);
    const batchNonce = useMockupStore((s) => s.exportBatchNonce);

    // Bỏ qua lần render đầu để nonce khởi tạo (0) không kích hoạt xuất.
    const pngInit = useRef(true);
    const glbInit = useRef(true);
    const batchInit = useRef(true);

    useEffect(() => {
        if (pngInit.current) {
            pngInit.current = false;
            return;
        }
        void exportPNG();
        // exportPNG đọc exportScale từ store nên không cần truyền tham số.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pngNonce]);

    useEffect(() => {
        if (batchInit.current) {
            batchInit.current = false;
            return;
        }
        void exportBatchPNG();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [batchNonce]);

    useEffect(() => {
        if (glbInit.current) {
            glbInit.current = false;
            return;
        }
        void exportGLB();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [glbNonce]);

    return null;
}

// ─── Main Export ────────────────────────────────────────────

export default function DielineScene3D() {
  const { t } = useTranslation();
    const { dieline, isStanding, foldProgress, isAnimating } = useBoxStore();
    const artworkEditMode = useMockupStore((s) => s.artworkEditMode);
    const showFloorGrid = useMockupStore((s) => s.showFloorGrid);

    if (!dieline) {
        return (
            <div className="dt-scene-loading">
                <p>{t('dieline.dielineScene3D:nhap_thong_so_de_xem_mo_phong_3d')}</p>
            </div>
        );
    }

    // Camera distance + scene scale based on bounding box.
    const bbExtent = Math.max(dieline.boundingBox.width, dieline.boundingBox.height);
    const camDist = bbExtent * 1.5;
    const yOffset = dieline.boundingBox.height / 2;

    return (
        <div className="dt-scene-3d-container" style={{ position: 'relative', width: '100%', height: '100%' }}>
            <MockupCanvas
                className="dt-mockup-canvas-wrap"
                style={{ width: '100%', height: '100%' }}
                camera={{
                    position: [camDist * 0.5, camDist * 0.7, camDist], // Standard isometric view
                    fov: 45,
                    near: 0.1,
                    far: camDist * 10,
                }}
                background="#0A0A0A"
            >
                {/* ── HDRI/IBL + phản chiếu, fallback đèn studio (Yêu cầu 3.1) ── */}
                <EnvironmentRig />

                {/* ── Contact/soft shadow + preset nền/sàn (Yêu cầu 3.5, 7.3) ── */}
                <ShadowFloor
                    floorY={-yOffset}
                    size={bbExtent}
                    showFloorPlane
                    showGrid={showFloorGrid}
                    shadowRevision={isAnimating ? 'animating' : Math.round(foldProgress * 1000)}
                />

                {/* Box layout orientation */}
                <group
                    position={isStanding ? [0, yOffset, 0] : [0, 0, 0]}
                    rotation={isStanding ? [0, 0, 0] : [-Math.PI / 2, 0, 0]}
                >
                    <BoxScene />
                    {/* Overlay kích thước L×W×H (Yêu cầu 7.7) */}
                    <DimensionOverlay />
                </group>

                {/* ── Camera preset rig: 4 preset, chuyển cảnh ≤500ms (Yêu cầu 7.1) ── */}
                <CameraRig center={[0, 0, 0]} distance={camDist} />

                {/* ── Cầu nối xuất PNG/GLB phía client (Yêu cầu 6.1, 6.6) ── */}
                <SceneExporter />

                {/* ── View cube định hướng (góc dưới-phải) — bấm mặt để xoay nhanh ── */}
                <GizmoHelper alignment="bottom-right" margin={[64, 64]}>
                    <GizmoViewcube
                        color="#e2e8f0"
                        textColor="#0f172a"
                        strokeColor="#94a3b8"
                        hoverColor="#8b5cf6"
                    />
                </GizmoHelper>

                {/* Controls (makeDefault để CameraRig đồng bộ target) */}
                <OrbitControls
                    enablePan={!artworkEditMode}
                    enableZoom
                    enableRotate={!artworkEditMode}
                    enableDamping
                    dampingFactor={0.05}
                    makeDefault
                    maxPolarAngle={Math.PI / 2 + 0.15}
                    minDistance={camDist * 0.2}
                    maxDistance={camDist * 5}
                />
            </MockupCanvas>

            {/* Fold slider overlay — DOM thường, đặt cạnh canvas (ngoài cây R3F) */}
            <FoldControls />
        </div>
    );
}
