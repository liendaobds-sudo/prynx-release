// ============================================================
// WindowPaneMesh — Màng cửa sổ trong suốt (PVC/PET) cho hộp có cửa sổ
// [HANGING-WINDOW 2026-07-27]
//
// CHỈ LÀ LỚP HIỂN THỊ 3D: không sinh nét CUT/CREASE, không đụng generator,
// không vào golden master. Khuôn bế và PDF xuất ra không đổi.
//
// Hình học: lấy ĐÚNG vòng điểm `panel.holes[i]` mà generator đã khoét (cửa sổ
// mặt trước), dựng `ShapeGeometry` phẳng ở toạ độ TRẢI PHẲNG — cùng hệ với
// `buildPanelSolid` (panel đùn từ z = 0 đến z = thickness) nên chỉ cần dùng lại
// ma trận gập của panel là màng bám đúng khung suốt hành trình gấp.
//
// Vật liệu chia hai bậc theo `qualityTier` (AGENTS.md luật 1 — máy yếu mới giảm):
//   - high     : `transmission = 1` + `ior 1.5` → xuyên thấy lòng hộp, khúc xạ
//                nhẹ. Đắt: three.js phải render thêm một transmission target.
//   - balanced : `transparent` + `opacity` thấp + `envMapIntensity` cao → vẫn ra
//                vệt phản chiếu studio, KHÔNG tốn transmission pass.
//
// Phản chiếu lấy từ env map studio do `EnvironmentRig` bake qua PMREM (không
// request mạng). Đây là phản chiếu MÔI TRƯỜNG, không phải gương thật phản chiếu
// thân hộp — gương thật cần CubeCamera/SSR render lại cảnh mỗi frame, quá đắt
// cho một tấm màng vài chục mm.
// ============================================================

import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';

import type { Panel, Point2D } from '../../lib/dieline/types';
import { useMockupStore } from '../../store/useMockupStore';
import { applyFoldCompensation, type FoldCompensationScratch } from '../../lib/mockup3d/foldCompensation';
import { applyExplodedOffset } from '../../lib/mockup3d/explodedView';
import { foldLive, seedFoldLiveFromStore } from '../../lib/mockup3d/foldLive';

/** Độ dày màng nhựa (mm) — PVC cửa sổ thực tế 0,15–0,25mm. */
export const WINDOW_FILM_THICKNESS_MM = 0.2;
/** Khe hở màng ↔ mặt trong panel (mm) — tránh z-fighting với nắp mặt trong. */
const FILM_GAP_MM = 0.02;
/** Độ mờ của màng ở bậc `balanced` (không có transmission pass). */
const FILM_OPACITY_BALANCED = 0.18;
/** Khoảng cách tách rời cơ sở (mm) — khớp SolidPanelMesh. */
const DEFAULT_EXPLODE_SPACING_MM = 40;

export interface WindowPaneMeshProps {
    /** Panel MANG lỗ cửa sổ (mặt trước). */
    panel: Panel;
    allPanels: Panel[];
    foldProgress: number;
    depthMap: Map<string, number>;
    maxD: number;
    /** Độ dày vật liệu hộp (mm) — quyết định mặt trong nằm ở z nào. */
    thickness: number;
    /** Kết thúc hành trình gấp live (hộp hai mảnh dồn gấp vào [0, x]). */
    liveFoldEnd?: number;
    explodeSpacing?: number;
}

/** Dựng ShapeGeometry phẳng từ một vòng điểm (toạ độ trải phẳng, mm). */
function buildPaneGeometry(rings: Point2D[][]): THREE.BufferGeometry | null {
    const shapes: THREE.Shape[] = [];
    for (const ring of rings) {
        if (!ring || ring.length < 3) continue;
        const shape = new THREE.Shape();
        shape.moveTo(ring[0].x, ring[0].y);
        for (let i = 1; i < ring.length; i++) shape.lineTo(ring[i].x, ring[i].y);
        shape.closePath();
        shapes.push(shape);
    }
    if (shapes.length === 0) return null;
    // Đùn mỏng để màng có bề dày thật — mép màng bắt sáng, nhìn ra "miếng nhựa".
    return new THREE.ExtrudeGeometry(shapes, {
        depth: WINDOW_FILM_THICKNESS_MM,
        bevelEnabled: false,
        curveSegments: 1,
        steps: 1,
    });
}

export default function WindowPaneMesh({
    panel,
    allPanels,
    foldProgress,
    depthMap,
    maxD,
    thickness,
    liveFoldEnd = 1,
    explodeSpacing = DEFAULT_EXPLODE_SPACING_MM,
}: WindowPaneMeshProps) {
    const qualityTier = useMockupStore((s) => s.qualityTier);
    const explodedFactor = useMockupStore((s) => s.explodedFactor);

    const geometry = useMemo(() => buildPaneGeometry(panel.holes ?? []), [panel.holes]);
    useEffect(() => () => geometry?.dispose(), [geometry]);

    const material = useMemo(() => {
        const highQuality = qualityTier === 'high';
        const mat = new THREE.MeshPhysicalMaterial({
            // Màng TRONG SUỐT (không pha màu) theo yêu cầu: PVC cửa sổ trong veo.
            color: 0xffffff,
            roughness: 0.05,
            metalness: 0.0,
            ior: 1.5,
            envMapIntensity: 1.6,
            clearcoat: 1.0,
            clearcoatRoughness: 0.03,
            side: THREE.DoubleSide,
            // Không ghi depth: màng nằm trước lòng hộp, ghi depth sẽ che mất chi
            // tiết bên trong ở bậc balanced.
            depthWrite: false,
            transparent: true,
        });
        if (highQuality) {
            mat.transmission = 1.0;
            mat.thickness = WINDOW_FILM_THICKNESS_MM;
            mat.opacity = 1.0;
        } else {
            mat.transmission = 0.0;
            mat.opacity = FILM_OPACITY_BALANCED;
        }
        return mat;
    }, [qualityTier]);
    useEffect(() => () => material.dispose(), [material]);

    // ── Ma trận gập: DÙNG LẠI của chính panel mang cửa sổ ──
    // Cùng cơ chế SolidPanelMesh: khi animation driver chạy thì đọc `foldLive`
    // trong useFrame (60fps, không re-render React); khi kéo slider thì seed lại.
    const groupRef = useRef<THREE.Group>(null);
    const scratch = useRef({
        version: -1,
        basePos: new THREE.Vector3(),
        worldNormal: new THREE.Vector3(),
        delta: new THREE.Matrix4(),
        fold: {
            result: new THREE.Matrix4(),
            step: new THREE.Matrix4(),
            temp: new THREE.Matrix4(),
        } satisfies FoldCompensationScratch,
    });

    const applyFoldMatrix = (progress: number) => {
        const group = groupRef.current;
        if (!group) return;
        const foldResult = applyFoldCompensation(
            panel, allPanels, progress, depthMap, maxD, thickness,
            scratch.current.fold,
        );
        const m = foldResult.matrix;
        const { basePos, worldNormal, delta } = scratch.current;
        worldNormal.set(0, 0, 1).transformDirection(m);
        basePos.setFromMatrixPosition(m);
        const moved = applyExplodedOffset(
            { x: basePos.x, y: basePos.y, z: basePos.z },
            { x: worldNormal.x, y: worldNormal.y, z: worldNormal.z },
            explodedFactor,
            explodeSpacing,
        );
        delta.makeTranslation(
            moved.x - basePos.x,
            moved.y - basePos.y,
            moved.z - basePos.z,
        );
        group.matrix.copy(delta).multiply(m);
        group.matrixWorldNeedsUpdate = true;
    };

    const resolvedFoldProgress = liveFoldEnd < 1
        ? Math.min(foldProgress / Math.max(liveFoldEnd, 1e-6), 1)
        : foldProgress;

    useEffect(() => {
        seedFoldLiveFromStore(foldProgress);
        if (!foldLive.driving) {
            applyFoldMatrix(resolvedFoldProgress);
            scratch.current.version = foldLive.version;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [foldProgress, resolvedFoldProgress, liveFoldEnd, panel, allPanels, depthMap, maxD, thickness, explodedFactor, explodeSpacing]);

    useFrame(() => {
        if (foldLive.version === scratch.current.version) return;
        scratch.current.version = foldLive.version;
        applyFoldMatrix(
            liveFoldEnd < 1
                ? Math.min(foldLive.progress / Math.max(liveFoldEnd, 1e-6), 1)
                : foldLive.progress,
        );
    });

    if (!geometry) return null;

    // Màng dán ở MẶT TRONG panel: panel đùn từ z = 0 (mặt trong) tới z = thickness.
    // Đặt màng ngay dưới z = 0 một khe nhỏ để không đồng phẳng nắp mặt trong.
    const zFilm = -(FILM_GAP_MM + WINDOW_FILM_THICKNESS_MM);

    return (
        <group ref={groupRef} matrixAutoUpdate={false}>
            <mesh
                geometry={geometry}
                material={material}
                position={[0, 0, zFilm]}
                renderOrder={10}
                castShadow={false}
                receiveShadow={false}
            />
        </group>
    );
}
