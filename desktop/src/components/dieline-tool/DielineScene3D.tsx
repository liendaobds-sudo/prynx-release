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

import React, { useMemo, useRef, useEffect, useLayoutEffect } from 'react';
import { useLoader, useThree, useFrame } from '@react-three/fiber';
import { OrbitControls, GizmoHelper, GizmoViewcube } from '@react-three/drei';
import * as THREE from 'three';
import { useBoxStore } from '../../stores/useBoxStore';
import { useMockupStore } from '../../stores/useMockupStore';
import type { DielineNesting, Panel } from '../../lib/dieline/types';
import { computeBoundingBox } from '../../lib/dieline/utils';
import MockupCanvas from './MockupCanvas';
import EnvironmentRig from './EnvironmentRig';
import CameraRig from './CameraRig';
import ShadowFloor from './ShadowFloor';
import DimensionOverlay from './DimensionOverlay';
import SolidPanelMesh from './SolidPanelMesh';
// [HANGING-WINDOW 2026-07-27] Màng cửa sổ trong suốt — thuần hiển thị 3D.
import WindowPaneMesh from './WindowPaneMesh';
import GussetMesh from './GussetMesh';
import { computeConeWarp } from '../../lib/mockup3d/cupSleeveCone';
import { sampleHeroTimeline } from '../../lib/mockup3d/heroTimeline';
import {
    foldLive,
    registerFoldLiveInvalidate,
    seedFoldLiveFromStore,
    setFoldLiveDriving,
    writeFoldLive,
} from '../../lib/mockup3d/foldLive';
import { useSceneExport } from './useSceneExport';
import { useTranslation } from 'react-i18next';

// ─── Helpers ───────────────────────────────────────────────

/** Mảnh ĐỨNG YÊN của hộp 2 mảnh khi model có `nesting`: vỏ hộp diêm
 *  (sleeve_*) hoặc khay đáy hộp âm dương (base_*). Mảnh còn lại (khay diêm /
 *  nắp lid_*) trượt theo vector nesting cuối hoạt ảnh. [DOUBLE-TRAY 2026-07-26] */
const isStaticPieceName = (name: string) => name.startsWith('sleeve_') || name.startsWith('base_');
/** Toàn bộ gấp hoàn tất trước khi bắt đầu lồng/chụp hai mảnh. */
const NEST_START = 0.8;

function nestingProgress(progress: number): number {
    const raw = Math.max(0, Math.min(1, (progress - NEST_START) / (1 - NEST_START)));
    return raw < 0.5 ? 2 * raw * raw : 1 - Math.pow(-2 * raw + 2, 2) / 2;
}

function phaseProgress(value: number, start: number, end: number): number {
    if (end <= start) return value >= end ? 1 : 0;
    return THREE.MathUtils.smoothstep(Math.max(0, Math.min(1, (value - start) / (end - start))), 0, 1);
}

/**
 * Pose cấp mảnh đọc trực tiếp `foldLive`, tránh chờ React/Zustand commit rồi nhảy nắp
 * ở cuối hoạt ảnh. Pivot nằm trong hệ tọa độ khuôn toàn cục.
 */
function NestingMotionGroup({
    nesting,
    foldProgress,
    children,
}: {
    nesting: DielineNesting;
    foldProgress: number;
    children: React.ReactNode;
}) {
    const groupRef = useRef<THREE.Group>(null);
    const liveVersionRef = useRef(-1);
    const pivot = nesting.pivot ?? { x: 0, y: 0, z: 0 };
    const rotationDeg = nesting.rotationDeg ?? { x: 0, y: 0, z: 0 };
    const choreography = nesting.choreography;
    const preRotationDeg = choreography?.preRotationDeg ?? { x: 0, y: 0, z: 0 };
    const preQuaternion = useMemo(() => new THREE.Quaternion().setFromEuler(new THREE.Euler(
        THREE.MathUtils.degToRad(preRotationDeg.x),
        THREE.MathUtils.degToRad(preRotationDeg.y),
        THREE.MathUtils.degToRad(preRotationDeg.z),
    )), [preRotationDeg.x, preRotationDeg.y, preRotationDeg.z]);
    const flipQuaternion = useMemo(() => new THREE.Quaternion().setFromEuler(new THREE.Euler(
        THREE.MathUtils.degToRad(rotationDeg.x),
        THREE.MathUtils.degToRad(rotationDeg.y),
        THREE.MathUtils.degToRad(rotationDeg.z),
    )), [rotationDeg.x, rotationDeg.y, rotationDeg.z]);
    const targetQuaternion = useMemo(
        () => choreography ? preQuaternion.clone().multiply(flipQuaternion) : flipQuaternion.clone(),
        [choreography, preQuaternion, flipQuaternion],
    );

    const applyPose = (progress: number) => {
        const group = groupRef.current;
        if (!group?.quaternion || !group.position) return;
        const k = nestingProgress(progress);
        let moveK = k;
        let z = nesting.z * k;

        if (choreography) {
            const preEnd = choreography.preRotateEnd;
            const liftEnd = choreography.liftEnd;
            const translateEnd = choreography.translateEnd;
            const preK = phaseProgress(k, 0, preEnd);
            const liftK = phaseProgress(k, preEnd, liftEnd);
            moveK = phaseProgress(k, liftEnd, translateEnd);
            const flipK = phaseProgress(k, translateEnd, 1);
            if (k < preEnd) {
                z = 0;
                group.quaternion.identity().slerp(preQuaternion, preK);
            } else if (k < liftEnd) {
                z = THREE.MathUtils.lerp(0, choreography.liftZ, liftK);
                group.quaternion.copy(preQuaternion);
            } else if (k < translateEnd) {
                z = choreography.liftZ;
                group.quaternion.copy(preQuaternion);
            } else {
                z = THREE.MathUtils.lerp(choreography.liftZ, nesting.z, flipK);
                group.quaternion.copy(preQuaternion).slerp(targetQuaternion, flipK);
            }
        } else {
            group.quaternion.identity().slerp(targetQuaternion, k);
        }

        group.position.set(
            pivot.x + nesting.x * moveK,
            pivot.y + nesting.y * moveK,
            pivot.z + z,
        );
        group.matrixWorldNeedsUpdate = true;
    };

    useLayoutEffect(() => {
        applyPose(foldProgress);
        liveVersionRef.current = foldLive.version;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        foldProgress,
        nesting.x,
        nesting.y,
        nesting.z,
        pivot.x,
        pivot.y,
        pivot.z,
        rotationDeg.x,
        rotationDeg.y,
        rotationDeg.z,
        targetQuaternion,
        choreography?.preRotateEnd,
        choreography?.liftEnd,
        choreography?.translateEnd,
        choreography?.liftZ,
        preQuaternion,
    ]);

    useFrame(() => {
        if (foldLive.version === liveVersionRef.current) return;
        liveVersionRef.current = foldLive.version;
        applyPose(foldLive.progress);
    });

    return (
        <group ref={groupRef}>
            <group position={[-pivot.x, -pivot.y, -pivot.z]}>
                {children}
            </group>
        </group>
    );
}

function artworkPartForPanel(
    panelName: string,
    boxType: string,
): 'tray' | 'sleeve' {
    // [DOUBLE-TRAY FIX 2026-07-27 §DT3D-003] Contract split: base=tray, lid=sleeve.
    if (boxType === 'double_tray') {
        return panelName.startsWith('base_') ? 'tray' : 'sleeve';
    }
    return isStaticPieceName(panelName) ? 'sleeve' : 'tray';
}

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
    // [PERF (audit 2026-07-27 §DT3D-006)] Chỉ subscribe ba trường scene thực sự dùng;
    // thay đổi unrelated trong useBoxStore không dựng lại toàn bộ cây 50 panel.
    const dieline = useBoxStore((state) => state.dieline);
    const foldProgress = useBoxStore((state) => state.foldProgress);
    const mockupTextureUrl = useBoxStore((state) => state.mockupTextureUrl);
    // Nguồn ảnh nghệ thuật hợp nhất: ưu tiên ảnh từ panel Mockup (có transform
    // chỉnh được + view canh chỉnh 2D), fallback ảnh tải nhanh ở ParamPanel.
    const outerArtworkUrl = useMockupStore((s) => s.artwork.outer.url);
    const innerArtworkUrl = useMockupStore((s) => s.artwork.inner.url);
    const trayArtworkUrl = useMockupStore((s) => s.artwork.trayOuter.url);
    const sleeveArtworkUrl = useMockupStore((s) => s.artwork.sleeveOuter.url);
    const innerArtworkEnabled = useMockupStore((s) => s.artwork.inner.enabled);
    const spotUvMaskUrl = useMockupStore((s) => s.artwork.spotUvMaskUrl);
    const embossMaskUrl = useMockupStore((s) => s.artwork.embossMaskUrl);
    const showTechnicalLines = useMockupStore((s) => s.showTechnicalLines);
    // [HANGING-WINDOW 2026-07-27] Công tắc màng cửa sổ trong suốt (chỉ hiển thị).
    const showWindowFilm = useMockupStore((s) => s.showWindowFilm);
    const textureUrl = outerArtworkUrl ?? mockupTextureUrl;
    const innerUrl = innerArtworkEnabled ? innerArtworkUrl : null;
    const maxAnisotropy = useThree((s) => s.gl.capabilities.getMaxAnisotropy());

    // Load texture (placeholder khi chưa có ảnh — giữ hook ổn định).
    const texture = useLoader(
        THREE.TextureLoader,
        textureUrl || BLANK_TEXTURE,
    ) as THREE.Texture;
    const innerTexture = useLoader(
        THREE.TextureLoader,
        innerUrl || BLANK_TEXTURE,
    ) as THREE.Texture;
    const trayTexture = useLoader(
        THREE.TextureLoader,
        trayArtworkUrl || BLANK_TEXTURE,
    ) as THREE.Texture;
    const sleeveTexture = useLoader(
        THREE.TextureLoader,
        sleeveArtworkUrl || BLANK_TEXTURE,
    ) as THREE.Texture;
    const spotUvTexture = useLoader(
        THREE.TextureLoader,
        spotUvMaskUrl || BLANK_TEXTURE,
    ) as THREE.Texture;
    const embossTexture = useLoader(
        THREE.TextureLoader,
        embossMaskUrl || BLANK_TEXTURE,
    ) as THREE.Texture;

    // Setup texture color space and wrapping
    useEffect(() => {
        if (texture && textureUrl) {
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.generateMipmaps = true;
            texture.minFilter = THREE.LinearMipmapLinearFilter;
            texture.anisotropy = Math.min(8, maxAnisotropy);
            texture.flipY = true;
            texture.needsUpdate = true;
        }
    }, [texture, textureUrl, maxAnisotropy]);
    useEffect(() => {
        if (trayTexture && trayArtworkUrl) {
            trayTexture.colorSpace = THREE.SRGBColorSpace;
            trayTexture.generateMipmaps = true;
            trayTexture.minFilter = THREE.LinearMipmapLinearFilter;
            trayTexture.anisotropy = Math.min(8, maxAnisotropy);
            trayTexture.flipY = true;
            trayTexture.needsUpdate = true;
        }
    }, [trayTexture, trayArtworkUrl, maxAnisotropy]);
    useEffect(() => {
        if (sleeveTexture && sleeveArtworkUrl) {
            sleeveTexture.colorSpace = THREE.SRGBColorSpace;
            sleeveTexture.generateMipmaps = true;
            sleeveTexture.minFilter = THREE.LinearMipmapLinearFilter;
            sleeveTexture.anisotropy = Math.min(8, maxAnisotropy);
            sleeveTexture.flipY = true;
            sleeveTexture.needsUpdate = true;
        }
    }, [sleeveTexture, sleeveArtworkUrl, maxAnisotropy]);    useEffect(() => {
        if (innerTexture && innerUrl) {
            innerTexture.colorSpace = THREE.SRGBColorSpace;
            innerTexture.generateMipmaps = true;
            innerTexture.minFilter = THREE.LinearMipmapLinearFilter;
            innerTexture.anisotropy = Math.min(8, maxAnisotropy);
            innerTexture.flipY = true;
            innerTexture.needsUpdate = true;
        }
    }, [innerTexture, innerUrl, maxAnisotropy]);
    useEffect(() => {
        if (spotUvTexture && spotUvMaskUrl) {
            spotUvTexture.colorSpace = THREE.NoColorSpace;
            spotUvTexture.generateMipmaps = true;
            spotUvTexture.minFilter = THREE.LinearMipmapLinearFilter;
            spotUvTexture.magFilter = THREE.LinearFilter;
            spotUvTexture.anisotropy = Math.min(8, maxAnisotropy);
            spotUvTexture.wrapS = THREE.ClampToEdgeWrapping;
            spotUvTexture.wrapT = THREE.ClampToEdgeWrapping;
            spotUvTexture.flipY = true;
            spotUvTexture.needsUpdate = true;
        }
    }, [spotUvTexture, spotUvMaskUrl, maxAnisotropy]);
    useEffect(() => {
        if (embossTexture && embossMaskUrl) {
            // Mask là dữ liệu tuyến tính, không phải ảnh màu sRGB.
            embossTexture.colorSpace = THREE.NoColorSpace;
            embossTexture.generateMipmaps = true;
            embossTexture.minFilter = THREE.LinearMipmapLinearFilter;
            embossTexture.magFilter = THREE.LinearFilter;
            embossTexture.anisotropy = Math.min(8, maxAnisotropy);
            embossTexture.wrapS = THREE.ClampToEdgeWrapping;
            embossTexture.wrapT = THREE.ClampToEdgeWrapping;
            embossTexture.flipY = true;
            embossTexture.needsUpdate = true;
        }
    }, [embossTexture, embossMaskUrl, maxAnisotropy]);
    useEffect(() => () => {
        if (textureUrl?.startsWith('blob:')) {
            texture.dispose();
            useLoader.clear(THREE.TextureLoader, textureUrl);
        }
    }, [texture, textureUrl]);
    useEffect(() => () => {
        if (trayArtworkUrl?.startsWith('blob:')) {
            trayTexture.dispose();
            useLoader.clear(THREE.TextureLoader, trayArtworkUrl);
        }
    }, [trayTexture, trayArtworkUrl]);
    useEffect(() => () => {
        if (sleeveArtworkUrl?.startsWith('blob:')) {
            sleeveTexture.dispose();
            useLoader.clear(THREE.TextureLoader, sleeveArtworkUrl);
        }
    }, [sleeveTexture, sleeveArtworkUrl]);    useEffect(() => () => {
        if (innerUrl?.startsWith('blob:')) {
            innerTexture.dispose();
            useLoader.clear(THREE.TextureLoader, innerUrl);
        }
    }, [innerTexture, innerUrl]);
    useEffect(() => () => {
        if (spotUvMaskUrl?.startsWith('blob:')) {
            spotUvTexture.dispose();
            useLoader.clear(THREE.TextureLoader, spotUvMaskUrl);
        }
    }, [spotUvTexture, spotUvMaskUrl]);
    useEffect(() => () => {
        if (embossMaskUrl?.startsWith('blob:')) {
            embossTexture.dispose();
            useLoader.clear(THREE.TextureLoader, embossMaskUrl);
        }
    }, [embossTexture, embossMaskUrl]);


    // Compute depth map for auto-phasing (cần cho SolidPanelMesh / foldCompensation).
    const panels = useMemo(() => dieline?.panels ?? [], [dieline?.panels]);
    const depthMap = useMemo(() => computeDepths(panels), [panels]);
    const maxD = useMemo(() => maxDepth(depthMap), [depthMap]);
    const partArtworkBBoxes = useMemo(() => {
        if (!dieline?.nesting) return null;
        const tray = panels.filter(
            (panel) => artworkPartForPanel(panel.name, dieline.params.boxType) === 'tray',
        );
        const sleeve = panels.filter(
            (panel) => artworkPartForPanel(panel.name, dieline.params.boxType) === 'sleeve',
        );
        return {
            tray: computeBoundingBox(tray.flatMap((panel) => panel.paths)),
            sleeve: computeBoundingBox(sleeve.flatMap((panel) => panel.paths)),
        };
    }, [dieline?.nesting, dieline?.params.boxType, panels]);

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

    // ── Hộp hai mảnh: LỒNG/CHỤP mảnh động vào mảnh tĩnh ở cuối hoạt ảnh ──
    // [FLIP-TOP-TUCK 2026-08-02 §FTT.2] Các hộp có panel gốc là đáy nằm ngang
    // phải đặt mặt in ở cap âm Z để mặt ngoài hướng ra ngoài sau khi gấp.
    const outerFaceNegativeZ = params.boxType === 'pizza'
        || params.boxType === 'tray'
        || params.boxType === 'double_tray'
        || params.boxType === 'flip_top_tuck';

    // Khi có `nesting`, dồn toàn bộ GẬP vào [0, NEST_START], rồi dùng đoạn
    // [NEST_START, 1] để chạy choreography lắp khay/nắp. Hộp khác giữ nguyên (foldT =
    // foldProgress).
    const nesting = dieline.nesting;
    const foldT = nesting ? Math.min(foldProgress / NEST_START, 1) : foldProgress;

    const isSleeve = isStaticPieceName; // sleeve_ (vỏ diêm) hoặc base_ (đáy hộp âm dương)
    const trayPanels = nesting ? panels.filter((p) => !isSleeve(p.name)) : panels;
    const sleevePanels = nesting ? panels.filter((p) => isSleeve(p.name)) : [];

    const renderPanel = (panel: Panel) => {
        const artworkPart = nesting
            ? artworkPartForPanel(panel.name, dieline.params.boxType)
            : 'default';
        const sleeveArtworkPart = artworkPart === 'sleeve';
        const partTextureUrl = nesting
            ? (sleeveArtworkPart ? sleeveArtworkUrl : trayArtworkUrl)
            : textureUrl;
        const partTexture = nesting
            ? (sleeveArtworkPart ? sleeveTexture : trayTexture)
            : texture;
        const partBBox = partArtworkBBoxes
            ? (sleeveArtworkPart ? partArtworkBBoxes.sleeve : partArtworkBBoxes.tray)
            : dieline.boundingBox;

        // [HANGING-WINDOW 2026-07-27] Panel có lỗ khoét cửa sổ → kèm màng nhựa
        // trong suốt. Chỉ áp cho các loại hộp CÓ cửa sổ thật (hiện: hộp treo);
        // lỗ euro của tai treo là lỗ TREO, không dán màng nên loại trừ.
        const pane = showWindowFilm
            && dieline.params.boxType === 'hanging_window'
            && panel.name === 'front'
            && (panel.holes?.length ?? 0) > 0
            ? (
                <WindowPaneMesh
                    key={`${panel.name}__film`}
                    panel={panel}
                    allPanels={panels}
                    foldProgress={foldProgress}
                    liveFoldEnd={nesting ? NEST_START : 1}
                    depthMap={depthMap}
                    maxD={maxD}
                    thickness={thickness}
                />
            )
            : null;

        const panelMesh = panel.gusset ? (
            <GussetMesh
                key={panel.name}
                panel={panel}
                allPanels={panels}
                foldProgress={foldT}
                depthMap={depthMap}
                maxD={maxD}
                thickness={thickness}
                hideCadLines={!showTechnicalLines}
            />
        ) : (
            <SolidPanelMesh
                key={panel.name}
                panel={panel}
                allPanels={panels}
                foldProgress={foldProgress}
                liveFoldEnd={nesting ? NEST_START : 1}
                depthMap={depthMap}
                maxD={maxD}
                thickness={thickness}
                globalBBox={partBBox}
                texture={partTextureUrl ? partTexture : null}
                innerTexture={innerUrl ? innerTexture : null}
                outerFaceNegativeZ={outerFaceNegativeZ}
                artworkPart={artworkPart}
                spotUvTexture={spotUvMaskUrl ? spotUvTexture : null}
                embossTexture={embossMaskUrl ? embossTexture : null}
                coneWarp={isCupSleeve ? coneWarp : null}
                conePaths={panel.name === 'body' && isCupSleeve ? dieline.allPaths : null}
                conePatchOnly={isCupSleeve && panel.name !== 'body'}
                hideCadLines={!showTechnicalLines || dieline.standardCode === 'ENV'}
                roundFolds={dieline.params.boxType === 'pizza'}
            />
        );

        if (!pane) return panelMesh;
        return (
            <React.Fragment key={panel.name}>
                {panelMesh}
                {pane}
            </React.Fragment>
        );
    };

    return (
        <group position={[-center.x, -center.y, 0]}>
            {/* Mảnh động: khay hộp diêm hoặc nắp hộp âm dương. */}
            {nesting ? (
                <NestingMotionGroup nesting={nesting} foldProgress={foldProgress}>
                    {trayPanels.map(renderPanel)}
                </NestingMotionGroup>
            ) : (
                <group>
                    {trayPanels.map(renderPanel)}
                </group>
            )}
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

/**
 * UI gập: animation chỉ ghi `foldLive` + state local (slider).
 * Zustand `foldProgress` chỉ commit khi dừng/kết thúc — tránh re-render BoxScene.
 */
function FoldControls() {
  const { t } = useTranslation();
    const foldProgress = useBoxStore((s) => s.foldProgress);
    const setFoldProgress = useBoxStore((s) => s.setFoldProgress);
    const isAnimating = useBoxStore((s) => s.isAnimating);
    const setIsAnimating = useBoxStore((s) => s.setIsAnimating);
    const heroDemoPlaying = useMockupStore((s) => s.heroDemoPlaying);
    const setHeroDemoPlaying = useMockupStore((s) => s.setHeroDemoPlaying);
    const animRef = useRef<number | null>(null);
    const heroRef = useRef<number | null>(null);
    /** Giá trị slider hiển thị — local khi đang animate. */
    const [displayFold, setDisplayFold] = React.useState(foldProgress);
    const driving = isAnimating || heroDemoPlaying;

    // Đồng bộ display khi store đổi từ ngoài (và không đang animate).
    useEffect(() => {
        if (!driving) setDisplayFold(foldProgress);
    }, [foldProgress, driving]);

    const commitFold = (v: number) => {
        const p = Math.max(0, Math.min(1, v));
        writeFoldLive(p, 0);
        setFoldProgress(p);
        setDisplayFold(p);
    };

    const stopAllAnim = () => {
        setFoldLiveDriving(false);
        setIsAnimating(false);
        setHeroDemoPlaying(false);
        // Giữ pose hiện tại (foldLive) → commit store
        commitFold(foldLive.progress);
    };

    // Ping-pong fold — 0 Zustand mid-flight
    useEffect(() => {
        if (!isAnimating) {
            if (animRef.current) cancelAnimationFrame(animRef.current);
            return;
        }
        setHeroDemoPlaying(false);
        setFoldLiveDriving(true);
        writeFoldLive(useBoxStore.getState().foldProgress, 0);

        let start: number | null = null;
        let lastUi = 0;
        const duration = 2000;

        const animate = (timestamp: number) => {
            if (!start) start = timestamp;
            const elapsed = timestamp - start;
            const t = Math.min(elapsed / duration, 1);
            const pingPong = t <= 0.5 ? t * 2 : 2 - t * 2;
            writeFoldLive(pingPong, 0);
            // Chỉ cập nhật DOM slider ~15fps, không đụng store
            if (timestamp - lastUi >= 66) {
                lastUi = timestamp;
                setDisplayFold(pingPong);
            }
            if (t < 1) {
                animRef.current = requestAnimationFrame(animate);
            } else {
                setFoldLiveDriving(false);
                setIsAnimating(false);
                setFoldProgress(pingPong);
                setDisplayFold(pingPong);
            }
        };

        animRef.current = requestAnimationFrame(animate);
        return () => {
            if (animRef.current) cancelAnimationFrame(animRef.current);
            setFoldLiveDriving(false);
        };
    }, [isAnimating, setFoldProgress, setIsAnimating, setHeroDemoPlaying]);

    // Hero demo — 0 Zustand mid-flight
    useEffect(() => {
        if (!heroDemoPlaying) {
            if (heroRef.current) cancelAnimationFrame(heroRef.current);
            return;
        }
        setIsAnimating(false);
        setFoldLiveDriving(true);

        const reducedMotion =
            typeof window !== 'undefined'
            && typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        let start: number | null = null;
        let lastUi = 0;
        writeFoldLive(0, 0);
        setDisplayFold(0);

        const tick = (timestamp: number) => {
            if (!start) start = timestamp;
            const elapsed = (timestamp - start) / 1000;
            const pose = sampleHeroTimeline(elapsed, { cycleSec: 8, reducedMotion });
            writeFoldLive(pose.foldProgress, pose.orbitYawRad);
            if (timestamp - lastUi >= 66) {
                lastUi = timestamp;
                setDisplayFold(pose.foldProgress);
            }
            if (pose.done) {
                setFoldLiveDriving(false);
                setHeroDemoPlaying(false);
                setFoldProgress(1);
                setDisplayFold(1);
                writeFoldLive(1, 0);
                return;
            }
            heroRef.current = requestAnimationFrame(tick);
        };
        heroRef.current = requestAnimationFrame(tick);
        return () => {
            if (heroRef.current) cancelAnimationFrame(heroRef.current);
            setFoldLiveDriving(false);
        };
    }, [heroDemoPlaying, setFoldProgress, setIsAnimating, setHeroDemoPlaying]);

    return (
        <div className="dt-fold-controls" style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>

            <button
                className={`dt-fold-play-btn ${isAnimating ? 'active' : ''}`}
                onClick={() => {
                    if (isAnimating) stopAllAnim();
                    else {
                        setHeroDemoPlaying(false);
                        setIsAnimating(true);
                    }
                }}
                title={isAnimating ? t('dieline.dielineScene3D:dung') : t('dieline.dielineScene3D:chay_hoat_anh_gap')}
            >
                {isAnimating ? '⏸' : '▶'}
            </button>
            <button
                className={`dt-fold-play-btn ${heroDemoPlaying ? 'active' : ''}`}
                onClick={() => {
                    if (heroDemoPlaying) stopAllAnim();
                    else {
                        setIsAnimating(false);
                        setHeroDemoPlaying(true);
                    }
                }}
                title={heroDemoPlaying ? 'Dừng demo gập' : 'Demo gập (fold → orbit)'}
            >
                {heroDemoPlaying ? '⏹' : '🎬'}
            </button>
            <button
                className="dt-fold-step-btn"
                onClick={() => { stopAllAnim(); commitFold(0); }}
                title={t('dieline.dielineScene3D:trai_phang_0')}
            >
                {t('dieline.dielineScene3D:trai')}
            </button>
            <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={displayFold}
                onChange={(e) => {
                    stopAllAnim();
                    commitFold(parseFloat(e.target.value));
                }}
                className="dt-fold-slider"
            />
            <button
                className="dt-fold-step-btn"
                onClick={() => { stopAllAnim(); commitFold(1); }}
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
                    value={Math.round(displayFold * 100)}
                    onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        if (!Number.isNaN(v)) {
                            stopAllAnim();
                            commitFold(v / 100);
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

// ─── Live fold pump + orbit (trong Canvas, không re-render React) ───────────

/** Đăng ký invalidate cho foldLive.write — giữ frameloop demand khi animate. */
function FoldLivePump() {
    const invalidate = useThree((s) => s.invalidate);
    useEffect(() => {
        registerFoldLiveInvalidate(() => invalidate());
        // seed lần đầu từ store
        seedFoldLiveFromStore(useBoxStore.getState().foldProgress);
        return () => registerFoldLiveInvalidate(null);
    }, [invalidate]);
    return null;
}

/** Group xoay hero orbit từ foldLive — không subscribe Zustand. */
function HeroOrbitGroup({
    isStanding,
    yOffset,
    children,
}: {
    isStanding: boolean;
    yOffset: number;
    children: React.ReactNode;
}) {
    const ref = useRef<THREE.Group>(null);
    useFrame(() => {
        const g = ref.current;
        if (!g) return;
        const yaw = foldLive.orbitYawRad;
        if (isStanding) {
            g.rotation.set(0, yaw, 0);
        } else {
            g.rotation.set(-Math.PI / 2, 0, yaw);
        }
    });
    return (
        <group
            ref={ref}
            position={isStanding ? [0, yOffset, 0] : [0, 0, 0]}
            rotation={isStanding ? [0, 0, 0] : [-Math.PI / 2, 0, 0]}
        >
            {children}
        </group>
    );
}

// ─── Main Export ────────────────────────────────────────────

export default function DielineScene3D() {
  const { t } = useTranslation();
    // Chỉ subscribe flag animation — KHÔNG foldProgress mỗi frame (tránh re-render cây 3D).
    const dieline = useBoxStore((s) => s.dieline);
    const isStanding = useBoxStore((s) => s.isStanding);
    const isAnimating = useBoxStore((s) => s.isAnimating);
    const artworkEditMode = useMockupStore((s) => s.artworkEditMode);
    const showFloorGrid = useMockupStore((s) => s.showFloorGrid);
    const heroDemoPlaying = useMockupStore((s) => s.heroDemoPlaying);
    const setHeroDemoPlaying = useMockupStore((s) => s.setHeroDemoPlaying);

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
                <FoldLivePump />

                {/* ── HDRI/IBL + phản chiếu, fallback đèn studio (Yêu cầu 3.1) ── */}
                <EnvironmentRig />

                {/* ── Contact/soft shadow + preset nền/sàn (Yêu cầu 3.5, 7.3) ── */}
                <ShadowFloor
                    floorY={-yOffset}
                    size={bbExtent}
                    showFloorPlane
                    showGrid={showFloorGrid}
                    freezeShadow={isAnimating || heroDemoPlaying}
                />

                {/* Box + orbit live (không re-render React khi yaw đổi) */}
                <HeroOrbitGroup isStanding={isStanding} yOffset={yOffset}>
                    <BoxScene />
                    <DimensionOverlay />
                </HeroOrbitGroup>

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
                    dampingFactor={0.08}
                    makeDefault
                    maxPolarAngle={Math.PI / 2 + 0.15}
                    minDistance={camDist * 0.2}
                    maxDistance={camDist * 5}
                    onStart={() => {
                        if (heroDemoPlaying || isAnimating) {
                            setFoldLiveDriving(false);
                            setHeroDemoPlaying(false);
                            useBoxStore.getState().setIsAnimating(false);
                            writeFoldLive(foldLive.progress, 0);
                        }
                    }}
                />
            </MockupCanvas>

            {/* Fold slider overlay — DOM thường, đặt cạnh canvas (ngoài cây R3F) */}
            <FoldControls />
        </div>
    );
}
