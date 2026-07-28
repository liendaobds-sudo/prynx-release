// ============================================================
// SolidPanelMesh — Mockup 3D Realism (Render Layer)
//
// Thay thế `FlatPanelMesh` (mesh phẳng ShapeGeometry) bằng một panel
// SOLID có độ dày thật, tiêu thụ trực tiếp lớp logic thuần
// `lib/mockup3d/`:
//
//   - `buildPanelSolid`        → ExtrudeGeometry (mặt ngoài + mặt trong +
//                                tường cạnh khép kín dọc chu vi & lỗ khoét)
//                                (Yêu cầu 1.1).
//   - `computePanelUV`         → UV theo mode per-face/aligned-to-dieline,
//                                mặt ngoài giữ hướng đọc (không lật gương),
//                                mặt trong lật gương (Yêu cầu 5.1, 5.3).
//   - `getFinish` + Physical PBR → `MeshPhysicalMaterial` (roughness/
//                                metalness/clearcoat/sheen/envMapIntensity)
//                                áp ĐỒNG NHẤT cho toàn panel,
//                                điều khiển bởi `useMockupStore.finishId`
//                                (Yêu cầu 4.4); màu tường cạnh theo
//                                `useMockupStore.edgeColor`.
//   - `applyFoldCompensation`  → ma trận gập + bù độ dày (Yêu cầu 2.1).
//   - `applyExplodedOffset` /  → dịch panel theo pháp tuyến khi tách rời,
//     `computeExplodedOffset`    điều khiển bởi `useMockupStore.explodedFactor`
//                                (Yêu cầu 7.5).
//
// TƯƠNG PHẢN MẶT NGOÀI / MẶT TRONG + ĐƯỜNG GẤP:
//   - Mặt ngoài (+Z) dùng finish/ảnh nghệ thuật; mặt trong (−Z) dùng màu
//     giấy bồi tương phản để dễ phân biệt khi xoay hộp; tường cạnh dùng màu
//     mép giấy. Ba nhóm tam giác (cap ngoài / cap trong / tường) được tách
//     theo dấu pháp tuyến trục Z và gán material riêng.
//   - Overlay đường CẮT (CUT) và CẤN/GẤP (CREASE) dựng từ `panel.paths`,
//     vẽ ở cả hai mặt — khôi phục chi tiết CAD như lớp render phẳng cũ.
//
// Vòng đời geometry/material được quản lý bằng `useDisposableResource`
// (task 9.9) để giải phóng GPU trước khi cấp phát mới (Yêu cầu 8.3).
//
// Component này render BÊN TRONG `<Canvas>`. Nó là drop-in cho nhánh 3D
// (`FlatPanelMesh`): nhận cùng bộ props hình học (panel, allPanels,
// foldProgress, depthMap, maxD, thickness, globalBBox, texture) và bổ
// sung đọc state trình bày từ `useMockupStore`. KHÔNG chạm nhánh 2D.
//
// _Requirements: 1.1, 2.1, 4.4, 5.1, 5.3, 7.5_
// ============================================================

import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';

import { useMockupStore } from '../../store/useMockupStore';
import type { BBox, Panel, Point2D } from '../../lib/mockup3d/types';
import { buildPanelSolid, buildFoldFilletGeometry, clampThickness, normalizeEdgeColor } from '../../lib/mockup3d/panelSolid';
import { buildConeFrustumGeometry, buildConeGluePatchGeometry, buildConeOutlineGeometries, type ConeWarpParams } from '../../lib/mockup3d/cupSleeveCone';
import { tracePerimeter } from '../../lib/dieline/tracePerimeter';
import { clampArtworkTransform, computePanelUV } from '../../lib/mockup3d/artworkMapping';
import {
    clampEmbossHeight,
    composeAppearance,
    substrateInnerFaceColor,
    SPOT_UV_GLOSS_CLEARCOAT,
    SPOT_UV_GLOSS_CLEARCOAT_ROUGHNESS,
    SPOT_UV_GLOSS_ROUGHNESS,
} from '../../lib/mockup3d/materialLibrary';
import { getKraftGrainBumpTexture } from '../../lib/mockup3d/proceduralTextures';
import { applyFoldCompensation, type FoldCompensationScratch } from '../../lib/mockup3d/foldCompensation';
import { applyExplodedOffset, type Vec3 } from '../../lib/mockup3d/explodedView';
import { foldLive, seedFoldLiveFromStore } from '../../lib/mockup3d/foldLive';
import { moveToMockupVisualOnlyLayer } from './renderLayers';
import { useDisposableResource } from './useDisposeResources';

// ─── Bảng màu ───────────────────────────────────────────────────────────────

/**
 * Màu albedo của TƯỜNG CẠNH (mép giấy) theo `edgeColor`.
 * - kraft: nâu giấy kraft tự nhiên.
 * - white: trắng ngà của giấy bồi/SBS.
 */
const EDGE_COLOR_HEX: Record<'kraft' | 'white', string> = {
    kraft: '#c9a06b',
    white: '#f3efe7',
};

/** Khoảng cách tách rời cơ sở (mm) ứng với 1 đơn vị hệ số explodedFactor. */
const DEFAULT_EXPLODE_SPACING_MM = 40;

/** Chỉ số material cho từng nhóm tam giác của geometry solid. */
const MAT_OUTER = 0; // cap mặt ngoài (+Z)
const MAT_WALL = 1; // tường cạnh (⊥ Z)
const MAT_INNER = 2; // cap mặt trong (−Z)

/** Ngưỡng |pháp tuyến.z| để coi một tam giác là cap (mặt phẳng) thay vì tường. */
const CAP_NORMAL_Z_THRESHOLD = 0.7;

const SPOT_UV_ROUGHNESS_SHADER_TARGET = 'roughnessFactor *= texelRoughness.g;';

/** Chuyển mask Spot-UV trắng thành vùng bóng, thay vì phép nhân roughness mặc định. */
export function patchSpotUvRoughnessShader(fragmentShader: string): string {
    return fragmentShader.replace(
        SPOT_UV_ROUGHNESS_SHADER_TARGET,
        `roughnessFactor = texelRoughness.g > 0.5 ? ${SPOT_UV_GLOSS_ROUGHNESS.toFixed(4)} : roughnessFactor;`,
    );
}

/**
 * Patch clearcoat: vùng mask trắng (g channel của clearcoatMap / roughnessMap)
 * dùng clearcoat bóng UV; nền giữ clearcoatFactor gốc.
 *
 * Three.js Physical dùng `clearcoatFactor *= texelClearcoat.x` khi có CLEARCOATMAP.
 * Ta thay bằng ngưỡng 50% giống spot-UV roughness.
 */
export function patchSpotUvClearcoatShader(fragmentShader: string): string {
    const targets = [
        'clearcoatFactor *= texelClearcoat.x;',
        'clearcoatFactor *= texelClearcoat.r;',
    ];
    let out = fragmentShader;
    for (const target of targets) {
        if (out.includes(target)) {
            out = out.replace(
                target,
                `clearcoatFactor = texelClearcoat.x > 0.5 ? ${SPOT_UV_GLOSS_CLEARCOAT.toFixed(4)} : clearcoatFactor;`,
            );
            break;
        }
    }
    // clearcoatRoughness similarly if map is present
    const roughTargets = [
        'clearcoatRoughnessFactor *= texelClearcoatRoughness.y;',
        'clearcoatRoughnessFactor *= texelClearcoatRoughness.g;',
    ];
    for (const target of roughTargets) {
        if (out.includes(target)) {
            out = out.replace(
                target,
                `clearcoatRoughnessFactor = texelClearcoatRoughness.y > 0.5 ? ${SPOT_UV_GLOSS_CLEARCOAT_ROUGHNESS.toFixed(4)} : clearcoatRoughnessFactor;`,
            );
            break;
        }
    }
    return out;
}

/** Áp cả roughness + clearcoat spot-UV lên fragment shader Physical. */
export function patchSpotUvPhysicalShader(fragmentShader: string): string {
    return patchSpotUvClearcoatShader(patchSpotUvRoughnessShader(fragmentShader));
}

// ─── Props ───────────────────────────────────────────────────────────────────

export interface SolidPanelMeshProps {
    /** Panel cần render (dùng `outline`/`holes` cho hình học solid). */
    panel: Panel;
    /** Toàn bộ panel của hộp (để tích lũy ma trận gập theo chuỗi cha). */
    allPanels: Panel[];
    /** Tiến trình gập hiện tại trong [0, 1]. */
    foldProgress: number;
    /** Mốc kết thúc gấp trong tiến trình live; phần còn lại dành cho lồng/chụp hai mảnh. */
    liveFoldEnd?: number;
    /** Bản đồ độ sâu (level) của panel trong cây gập. */
    depthMap: Map<string, number>;
    /** Độ sâu tối đa trong cây gập (dùng cho auto-phase). */
    maxD: number;
    /** Độ dày vật liệu (mm), thường là `params.T`. */
    thickness: number;
    /** Bounding box toàn cục của dieline (cho mode aligned-to-dieline). */
    globalBBox: BBox;
    /** Texture ảnh nghệ thuật mặt ngoài (đã nạp ở lớp trên); `null` = chỉ finish. */
    texture?: THREE.Texture | null;
    /** Texture ảnh nghệ thuật mặt trong (khi bật in mặt trong); `null` = giấy bồi. */
    innerTexture?: THREE.Texture | null;
    /** Mặt vật lý nhận artwork ngoài. Pizza gấp về +Z nên mặt ngoài là cap −Z. */
    outerFaceNegativeZ?: boolean;
    /** Chọn cấu hình artwork cho mẫu thường, khay hoặc vỏ hộp diêm. */
    artworkPart?: 'default' | 'tray' | 'sleeve';
    /** Mask tuyến tính điều khiển vùng bóng cục bộ khi chọn finish Spot-UV. */
    spotUvTexture?: THREE.Texture | null;
    /** Mask tuyến tính dùng làm bump map khi chọn finish Emboss. */
    embossTexture?: THREE.Texture | null;
    /** Khoảng cách tách rời cơ sở (mm) cho 1 đơn vị hệ số; mặc định 40mm. */
    explodeSpacing?: number;
    /**
     * Tham số cuộn nón cụt cho thân bọc ly. Khi khác `null`, hình học panel
     * được warp từ quạt phẳng thành mặt nón cụt 3D (Yêu cầu: bọc ly cuộn tròn).
     */
    coneWarp?: ConeWarpParams | null;
    /**
     * Toàn bộ đường nét khuôn (CUT/CREASE, gồm đường nhấn mí dán) để vẽ bám lên
     * mặt nón cuốn khi `coneWarp` khác null. Lấy từ `dieline.allPaths`.
     */
    conePaths?: Panel['paths'] | null;
    /**
     * Khi true (panel TAI DÁN của bọc ly): dựng mặt patch ánh xạ từ outline lên
     * mặt nón thay vì dựng nguyên khối nón cụt.
     */
    conePatchOnly?: boolean;
    /**
     * Ẩn overlay đường CAD (cắt/cấn) cho mặt phẳng. Dùng cho bì thư: các mặt
     * gập áp phẳng đồng phẳng (giấy mỏng) khiến nét CAD nâng nổi lòi xuyên qua
     * mặt trên — tắt đi để render sạch, hình dạng/viền lấy từ silhouette khối.
     */
    hideCadLines?: boolean;
    /**
     * Bo tròn (fillet) tại nếp gập: thêm dải cong bán kính T/2 nối 2 mặt ở mỗi
     * đường gập để chỗ gập trông cong mượt như giấy thật (không gãy góc cứng).
     */
    roundFolds?: boolean;
}

// ─── Tách nhóm material theo mặt (ngoài / trong / tường) ─────────────────────

/**
 * Phân nhóm tam giác của geometry solid thành 3 material group dựa trên dấu
 * pháp tuyến trục Z (tính trực tiếp từ vị trí đỉnh, KHÔNG phụ thuộc attribute
 * normal): cap mặt ngoài (+Z → `MAT_OUTER`), cap mặt trong (−Z → `MAT_INNER`),
 * tường cạnh (≈⊥Z → `MAT_WALL`). Nhờ đó hai mặt cap nhận material khác nhau để
 * giữ độ tương phản. ExtrudeGeometry không index hóa nên mỗi 3 đỉnh liên tiếp
 * là một tam giác.
 */
function assignFaceMaterialGroups(geometry: THREE.BufferGeometry): void {
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos || pos.count === 0) {
        return;
    }
    const index = geometry.getIndex();
    const idxAt = (i: number): number => (index ? index.getX(i) : i);
    const triCount = (index ? index.count : pos.count) / 3;

    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const n = new THREE.Vector3();

    geometry.clearGroups();
    let runStart = 0;
    let runMat = -1;

    for (let t = 0; t < triCount; t++) {
        a.fromBufferAttribute(pos, idxAt(t * 3));
        b.fromBufferAttribute(pos, idxAt(t * 3 + 1));
        c.fromBufferAttribute(pos, idxAt(t * 3 + 2));
        ab.subVectors(b, a);
        ac.subVectors(c, a);
        n.crossVectors(ab, ac);
        const len = n.length() || 1;
        const nz = n.z / len;

        let mat: number;
        if (nz > CAP_NORMAL_Z_THRESHOLD) mat = MAT_OUTER;
        else if (nz < -CAP_NORMAL_Z_THRESHOLD) mat = MAT_INNER;
        else mat = MAT_WALL;

        if (mat !== runMat) {
            if (runMat !== -1) {
                geometry.addGroup(runStart * 3, (t - runStart) * 3, runMat);
            }
            runStart = t;
            runMat = mat;
        }
    }
    if (runMat !== -1) {
        geometry.addGroup(runStart * 3, (triCount - runStart) * 3, runMat);
    }
}

/**
 * Góc gập NET (radian, có dấu) của panel tại `foldProgress` — sao chép logic
 * `effectiveFoldAngle` (chỉ đọc dữ liệu panel + depth/maxD) để dựng fillet gập.
 */
function effFoldAngleRad(
    panel: Panel,
    foldProgress: number,
    depth: number,
    maxD: number,
): number {
    if (!Number.isFinite(panel.foldAngle) || panel.foldAngle === 0) return 0;
    let ps: number, pe: number;
    if (panel.foldPhase) {
        [ps, pe] = panel.foldPhase;
    } else {
        const step = maxD > 0 ? 1 / (maxD + 1) : 1;
        ps = depth * step;
        pe = (depth + 1) * step;
    }
    const span = pe - ps;
    const lp = span !== 0 ? Math.max(0, Math.min(1, (foldProgress - ps) / span)) : 0;
    const eased = lp < 0.5 ? 2 * lp * lp : 1 - Math.pow(-2 * lp + 2, 2) / 2;
    return ((panel.foldAngle * eased * (panel.foldDirection || 1)) * Math.PI) / 180;
}

// ─── Tiện ích UV ─────────────────────────────────────────────────────────────
/**
 * Tính và gán UV cho TOÀN BỘ đỉnh của geometry solid bằng cách tiêu thụ
 * `computePanelUV`.
 *
 * Cách làm: coi danh sách đỉnh (x, y) của geometry như một "outline" và
 * gọi `computePanelUV` hai lần — một lần cho mặt ngoài (`outer`, giữ hướng
 * đọc), một lần cho mặt trong (`inner`, lật gương trục ngang). Mỗi đỉnh
 * được gán UV theo mặt mà nó thuộc về, phân định bằng tọa độ Z so với mặt
 * phẳng giữa của panel (geometry đã được canh giữa quanh z = 0).
 *
 * Đỉnh tường cạnh dùng chung material màu cạnh (không có map) nên UV của
 * chúng không ảnh hưởng hiển thị.
 *
 * _Requirements: 5.1, 5.3_
 */
type ArtworkXform = {
    scalePct: number;
    offsetXPct: number;
    offsetYPct: number;
    rotationDeg?: number;
    flipH?: boolean;
    flipV?: boolean;
};

function applySolidPanelUV(
    geometry: THREE.ExtrudeGeometry,
    panel: Panel,
    mode: 'per-face' | 'aligned-to-dieline',
    outerTransform: ArtworkXform,
    innerTransform: ArtworkXform,
    globalBBox: BBox,
    outerImageAspect?: number,
    innerImageAspect?: number,
    outerFaceNegativeZ = false,
): void {
    const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!position || position.count === 0) {
        return;
    }

    const count = position.count;
    const points: Point2D[] = new Array(count);
    // Khi panel đã được warp thành mặt cong (vd thân bọc ly cuộn nón cụt),
    // tọa độ `position` không còn phẳng → dùng tọa độ phẳng gốc lưu trong
    // `userData.flatXY` để ánh xạ ảnh theo bản trải phẳng (đúng nghệ thuật).
    const flatXY = (geometry.userData?.flatXY as Float32Array | undefined) ?? null;
    const flatZ = (geometry.userData?.flatZ as Float32Array | undefined) ?? null;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
        const z = flatZ ? flatZ[i] : position.getZ(i);
        points[i] = flatXY
            ? { x: flatXY[i * 2], y: flatXY[i * 2 + 1] }
            : { x: position.getX(i), y: position.getY(i) };
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
    }
    const midZ = (minZ + maxZ) / 2;

    // Panel giả lập: chỉ `outline` được `computePanelUV` sử dụng để ánh xạ.
    const pseudoPanel = { ...panel, outline: points } as Panel;

    // Mặt ngoài / mặt trong dùng transform ĐỘC LẬP (Yêu cầu 5.4).
    const outerUV = computePanelUV(
        pseudoPanel, mode, outerTransform, globalBBox,
        outerFaceNegativeZ ? 'inner' : 'outer', outerImageAspect,
    );
    const innerUV = computePanelUV(
        pseudoPanel, mode, innerTransform, globalBBox,
        outerFaceNegativeZ ? 'outer' : 'inner', innerImageAspect,
    );

    const uv = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
        const z = flatZ ? flatZ[i] : position.getZ(i);
        // Mặt ở phía Z+ coi là mặt ngoài; phía Z- là mặt trong.
        const positiveCapIsOuter = !outerFaceNegativeZ;
        const src = (z >= midZ) === positiveCapIsOuter ? outerUV : innerUV;
        uv[i * 2] = src[i * 2];
        uv[i * 2 + 1] = src[i * 2 + 1];
    }

    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const uvAttr = geometry.getAttribute('uv') as THREE.BufferAttribute;
    uvAttr.needsUpdate = true;
}

// ─── Đường CAD (cắt / cấn) từ panel.paths ────────────────────────────────────

/**
 * Dựng hai `BufferGeometry` đường: một cho nét CẮT (CUT/BLEED) và một cho nét
 * CẤN/GẤP (CREASE), lấy trực tiếp từ `panel.paths`. Bezier được lấy mẫu thành
 * đoạn thẳng; các đoạn khác nối điểm liên tiếp. Trả về `[cutGeo, creaseGeo]`
 * để `useDisposableResource` giải phóng đúng cách khi panel đổi.
 */
function buildPathLineGeometries(panel: Panel): THREE.BufferGeometry[] {
    const cutPts: THREE.Vector3[] = [];
    const creasePts: THREE.Vector3[] = [];

    for (const seg of panel.paths) {
        const arr = seg.tag === 'CREASE' ? creasePts : cutPts;
        if (seg.type === 'bezier' && seg.controlPoints && seg.controlPoints.length >= 4) {
            const [p0, cp1, cp2, p3] = seg.controlPoints;
            const curve = new THREE.CubicBezierCurve3(
                new THREE.Vector3(p0.x, p0.y, 0),
                new THREE.Vector3(cp1.x, cp1.y, 0),
                new THREE.Vector3(cp2.x, cp2.y, 0),
                new THREE.Vector3(p3.x, p3.y, 0),
            );
            const pts = curve.getPoints(12);
            for (let i = 0; i < pts.length - 1; i++) {
                arr.push(pts[i], pts[i + 1]);
            }
        } else if (seg.points.length >= 2) {
            for (let i = 0; i < seg.points.length - 1; i++) {
                arr.push(new THREE.Vector3(seg.points[i].x, seg.points[i].y, 0));
                arr.push(new THREE.Vector3(seg.points[i + 1].x, seg.points[i + 1].y, 0));
            }
        }
    }

    const cutGeo = new THREE.BufferGeometry().setFromPoints(cutPts);
    const creaseGeo = new THREE.BufferGeometry().setFromPoints(creasePts);
    return [cutGeo, creaseGeo];
}

/**
 * Giữ tỷ lệ artwork trên thân bọc ly. Geometry nón có UV chuẩn hóa sẵn;
 * chuyển UV đó sang hệ vật lý của mặt khai triển tại chu vi trung bình.
 */
function applyConeArtworkUV(
    geometry: THREE.BufferGeometry,
    cone: ConeWarpParams,
    outerTransform: ArtworkXform,
    innerTransform: ArtworkXform,
    outerImageAspect?: number,
    innerImageAspect?: number,
): void {
    const uv = geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
    if (!uv || uv.count === 0) return;

    const cacheKey = '__prynxBaseArtworkUv';
    let base = geometry.userData[cacheKey] as Float32Array | undefined;
    if (!base || base.length !== uv.count * 2) {
        base = Float32Array.from(uv.array as ArrayLike<number>);
        geometry.userData[cacheKey] = base;
    }

    const coverage = Math.max(0, cone.psiMax / (2 * Math.PI));
    const meanCircumference = Math.PI * ((cone.d1 + cone.d2) / 2) * coverage;
    const slantHeight = Math.max(1e-6, cone.r2 - cone.r1);
    const targetAspect = meanCircumference / slantHeight;

    const applyRange = (
        start: number,
        count: number,
        side: 'outer' | 'inner',
        transform: ArtworkXform,
        imageAspect?: number,
    ) => {
        if (!Number.isFinite(imageAspect) || imageAspect! <= 0 || !(targetAspect > 0)) return;
        const t = clampArtworkTransform(transform);
        const scale = t.scalePct / 100;
        const cover = Math.max(targetAspect / imageAspect!, 1);
        const renderedWidth = imageAspect! * cover * scale;
        const renderedHeight = cover * scale;
        const rot = ((t.rotationDeg ?? 0) * Math.PI) / 180;
        const cosR = Math.cos(rot);
        const sinR = Math.sin(rot);

        const end = Math.min(uv.count, start + count);
        for (let i = Math.max(0, start); i < end; i++) {
            let dx = (base![i * 2] - 0.5) * targetAspect;
            let dy = base![i * 2 + 1] - 0.5;
            if (side === 'inner') dx = -dx;
            if (t.flipH) dx = -dx;
            if (t.flipV) dy = -dy;
            const rx = dx * cosR + dy * sinR;
            const ry = -dx * sinR + dy * cosR;
            uv.setXY(
                i,
                rx / renderedWidth + 0.5 - t.offsetXPct / 100,
                ry / renderedHeight + 0.5 - t.offsetYPct / 100,
            );
        }
    };

    // Khôi phục UV gốc trước mỗi lần đổi transform để không cộng dồn sai số.
    for (let i = 0; i < uv.count; i++) uv.setXY(i, base[i * 2], base[i * 2 + 1]);
    for (const group of geometry.groups) {
        if (group.materialIndex === MAT_OUTER) {
            applyRange(group.start, group.count, 'outer', outerTransform, outerImageAspect);
        } else if (group.materialIndex === MAT_INNER) {
            applyRange(group.start, group.count, 'inner', innerTransform, innerImageAspect);
        }
    }
    uv.needsUpdate = true;
}
/** Đọc đúng tỷ lệ pixel của ảnh đã giải mã trong THREE.Texture. */
function textureImageAspect(texture: THREE.Texture | null): number | undefined {
    const image = (texture?.source?.data ?? texture?.image) as {
        naturalWidth?: number;
        naturalHeight?: number;
        videoWidth?: number;
        videoHeight?: number;
        width?: number;
        height?: number;
    } | undefined;
    if (!image) return undefined;
    const width = image.naturalWidth ?? image.videoWidth ?? image.width;
    const height = image.naturalHeight ?? image.videoHeight ?? image.height;
    return Number.isFinite(width) && Number.isFinite(height) && width! > 0 && height! > 0
        ? width! / height!
        : undefined;
}

/**
 * Trích mảng điểm (mỗi cặp liên tiếp = 1 đoạn) từ geometry lineSegments để
 * truyền vào drei <Line segments>. Gán `z` cố định (lượng nâng nét) cho mọi
 * điểm. Trả [] nếu rỗng.
 */
function bufferToSegPoints(
    geo: THREE.BufferGeometry | null,
    z: number,
): [number, number, number][] {
    const pos = geo?.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos || pos.count === 0) return [];
    const out: [number, number, number][] = new Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
        out[i] = [pos.getX(i), pos.getY(i), z];
    }
    return out;
}

// ─── Component ───────────────────────────────────────────────────────────────
/**
 * SolidPanelMesh — panel solid có độ dày, finish PBR, ảnh nghệ thuật,
 * gập có bù độ dày và dịch tách rời (exploded view).
 */
export default function SolidPanelMesh({
    panel,
    allPanels,
    foldProgress,
    liveFoldEnd = 1,
    depthMap,
    maxD,
    thickness,
    globalBBox,
    texture = null,
    innerTexture = null,
    outerFaceNegativeZ = false,
    artworkPart = 'default',
    spotUvTexture = null,
    embossTexture = null,
    explodeSpacing = DEFAULT_EXPLODE_SPACING_MM,
    coneWarp = null,
    conePaths = null,
    conePatchOnly = false,
    hideCadLines = false,
    roundFolds = false,
}: SolidPanelMeshProps) {
    const groupRef = useRef<THREE.Group>(null);
    const cadVisualsRef = useRef<THREE.Group>(null);
    const resolvedFoldProgress = liveFoldEnd < 1
        ? Math.min(foldProgress / Math.max(liveFoldEnd, 1e-6), 1)
        : foldProgress;

    // State trình bày từ store mockup (tách biệt khỏi đường dẫn dieline).
    const substrateId = useMockupStore((s) => s.substrateId);
    const surfaceFinishId = useMockupStore((s) => s.surfaceFinishId);
    const edgeColor = useMockupStore((s) => s.edgeColor);
    const qualityTier = useMockupStore((s) => s.qualityTier);
    const showPaperGrain = useMockupStore((s) => s.showPaperGrain);
    const explodedFactor = useMockupStore((s) => s.explodedFactor);
    const artworkMode = useMockupStore((s) => s.artwork.mode);
    const defaultOuter = useMockupStore((s) => s.artwork.outer);
    const trayOuter = useMockupStore((s) => s.artwork.trayOuter);
    const sleeveOuter = useMockupStore((s) => s.artwork.sleeveOuter);
    const innerTransform = useMockupStore((s) => s.artwork.inner.transform);
    const artworkEditMode = useMockupStore((s) => s.artworkEditMode);
    const embossHeightMm = useMockupStore((s) => s.artwork.embossHeightMm);
    const storedInnerImageAspect = useMockupStore((s) => s.artwork.inner.aspectRatio);
    const setDefaultArtworkTransform = useMockupStore((s) => s.setOuterArtworkTransform);
    const setTrayArtworkTransform = useMockupStore((s) => s.setTrayArtworkTransform);
    const setSleeveArtworkTransform = useMockupStore((s) => s.setSleeveArtworkTransform);
    const outerConfig = artworkPart === 'tray'
        ? trayOuter
        : artworkPart === 'sleeve' ? sleeveOuter : defaultOuter;
    const outerTransform = outerConfig.transform;
    const outerUrl = outerConfig.url;
    const storedOuterImageAspect = outerConfig.aspectRatio;
    const setOuterArtworkTransform = artworkPart === 'tray'
        ? setTrayArtworkTransform
        : artworkPart === 'sleeve' ? setSleeveArtworkTransform : setDefaultArtworkTransform;
    const outerImageAspect = Number.isFinite(storedOuterImageAspect) && storedOuterImageAspect! > 0
        ? storedOuterImageAspect!
        : textureImageAspect(texture);
    const innerImageAspect = Number.isFinite(storedInnerImageAspect) && storedInnerImageAspect! > 0
        ? storedInnerImageAspect!
        : textureImageAspect(innerTexture);

    // Độ dày hiển thị đã chuẩn hóa (mm) — dùng cho canh giữa Z và đặt line overlay.
    const depth = clampThickness(thickness);
    const offsetZ = depth / 2;

    // ── 1. Hình học solid (Yêu cầu 1.1) — quản lý vòng đời GPU (Yêu cầu 8.3) ──
    const geometry = useDisposableResource<THREE.BufferGeometry>(() => {
        // Bọc ly: DỰNG TRỰC TIẾP lưới nón cụt (không đùn phẳng + warp) để luôn
        // ra hình nón sạch, đúng tỉ lệ d1/d2/H; canh trục nón & giữa chiều cao
        // về tâm bbox phẳng để bù phép canh giữa `-center` ở BoxScene.
        if (coneWarp) {
            const cx = globalBBox.minX + globalBBox.width / 2;
            const cy = globalBBox.minY + globalBBox.height / 2;
            const ty = cy; // geometry nón tự canh tâm về gốc → chỉ bù tâm bbox.
            // Tai dán: dựng mặt patch GẮN LIỀN thân (cạnh mạch trùng mặt trong,
            // phần vượt mép gài vào trong) → không rời, không z-fighting.
            if (conePatchOnly) {
                const outline = (panel.outline && panel.outline.length >= 3)
                    ? panel.outline
                    : tracePerimeter(panel.paths);
                const patch = buildConeGluePatchGeometry(outline, coneWarp, resolvedFoldProgress, thickness);
                patch.translate(cx, ty, 0);
                return patch;
            }
            const cone = buildConeFrustumGeometry(coneWarp, thickness, resolvedFoldProgress);
            cone.translate(cx, ty, 0);
            return cone;
        }
        const geo = buildPanelSolid(panel, thickness);
        // Canh giữa theo trục Z để mặt phẳng giữa panel nằm tại z = 0,
        // khớp trục gập trong mặt phẳng XY (giống FlatPanelMesh canh ±offsetZ).
        const pos = geo.getAttribute('position');
        if (pos && pos.count > 0) {
            geo.translate(0, 0, -depth / 2);
            // Tách nhóm material: cap ngoài / cap trong / tường cạnh.
            assignFaceMaterialGroups(geo);
        }
        return geo;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [panel, thickness, coneWarp, conePatchOnly, coneWarp ? resolvedFoldProgress : 0]);

    // ── 1b. Dải BO TRÒN tại nếp gập (fillet) — góc gập cong mượt như giấy ──
    const foldFilletGeo = useDisposableResource<THREE.BufferGeometry | null>(() => {
        if (!roundFolds || coneWarp) return null;
        if (panel.parent === null || !panel.pivotEdge) return null;
        const piv = panel.pivotEdge;
        const depthLevel = depthMap.get(panel.name) ?? 0;
        const theta = effFoldAngleRad(panel, resolvedFoldProgress, depthLevel, maxD);
        if (Math.abs(theta) < 1e-4) return null;
        const ring = (panel.outline && panel.outline.length >= 3)
            ? panel.outline
            : tracePerimeter(panel.paths);
        if (ring.length < 3) return null;
        let cx = 0, cy = 0;
        for (const p of ring) { cx += p.x; cy += p.y; }
        cx /= ring.length; cy /= ring.length;
        return buildFoldFilletGeometry(piv[0], piv[1], theta, thickness, { x: cx, y: cy });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [panel, thickness, roundFolds, coneWarp, resolvedFoldProgress, depthMap, maxD]);

    // ── 2. UV theo ảnh nghệ thuật (Yêu cầu 5.1, 5.3, 5.4) ──
    // Áp lại khi geometry hoặc tham số ánh xạ đổi; mutate uv attribute tại chỗ.
    useEffect(() => {
        if (!geometry) return;
        if (coneWarp) {
            applyConeArtworkUV(
                geometry,
                coneWarp,
                outerTransform,
                innerTransform,
                outerImageAspect,
                innerImageAspect,
            );
            return;
        }
        applySolidPanelUV(
            geometry as THREE.ExtrudeGeometry,
            panel,
            artworkMode,
            outerTransform,
            innerTransform,
            globalBBox,
            outerImageAspect,
            innerImageAspect,
            outerFaceNegativeZ,
        );
    }, [geometry, panel, artworkMode, outerTransform, innerTransform, globalBBox, coneWarp, outerImageAspect, innerImageAspect, outerFaceNegativeZ]);

    // ── 3. Vật liệu: mặt ngoài (finish/ảnh) ≠ mặt trong (giấy bồi) ≠ tường cạnh.
    //    Thứ tự material khớp chỉ số nhóm: [MAT_OUTER, MAT_WALL, MAT_INNER]
    //    (Yêu cầu 4.4 + giữ tương phản hai mặt).
    const materials = useDisposableResource<THREE.Material[]>(() => {
        const appearance = composeAppearance(substrateId, surfaceFinishId);
        const phys = appearance.phys;
        const edge = normalizeEdgeColor(edgeColor);
        const baseColor = appearance.baseColor;
        const edgeHex = EDGE_COLOR_HEX[edge];
        // Mặt trong = giấy bồi theo CHẤT LIỆU (substrate), không theo edgeColor.
        const innerHex = substrateInnerFaceColor(substrateId);

        // Solid khép kín có pháp tuyến hướng RA NGOÀI, nên dùng `FrontSide`
        // cho cả ba nhóm: tránh vẽ thừa mặt sau (backface) của hai cap chỉ
        // cách nhau bằng độ dày giấy (rất mỏng) — nguyên nhân gây nhấp nháy
        // (Z-fighting) trên toàn bề mặt khi xoay. Cap ngoài hướng +Z, cap
        // trong hướng −Z, tường cạnh hướng ra ngoài → FrontSide hiển thị đúng.
        const spotUvEnabled = appearance.needsSpotUvMask && !!spotUvTexture;
        const embossEnabled = appearance.needsEmbossMask && !!embossTexture && embossHeightMm > 0;
        // Grain: chỉ khi user BẬT (mặc định tắt — tránh lag GPU).
        // Emboss luôn ưu tiên bumpMap. Size tối đa 256 live.
        const wantGrain =
            !embossEnabled
            && showPaperGrain
            && phys.grainBumpScale > 0;
        const grainTex = wantGrain
            ? (getKraftGrainBumpTexture(256, undefined, THREE) as THREE.Texture | null)
            : null;
        const grainScale = grainTex ? phys.grainBumpScale : 0;
        // Sheen đắt GPU — chỉ khi grain bật hoặc quality high.
        const useSheen = showPaperGrain || qualityTier === 'high';

        const outerMaterial = new THREE.MeshPhysicalMaterial({
            color: texture ? '#ffffff' : baseColor,
            map: texture ?? null,
            roughnessMap: spotUvEnabled ? spotUvTexture : null,
            clearcoatMap: spotUvEnabled ? spotUvTexture : null,
            // Dùng cùng mask: vùng trắng → clearcoatRoughness thấp (bóng UV).
            clearcoatRoughnessMap: spotUvEnabled ? spotUvTexture : null,
            bumpMap: embossEnabled ? embossTexture : (grainTex ?? null),
            bumpScale: embossEnabled ? clampEmbossHeight(embossHeightMm) : grainScale,
            roughness: phys.roughness,
            metalness: phys.metalness,
            clearcoat: phys.clearcoat,
            clearcoatRoughness: phys.clearcoatRoughness,
            sheen: useSheen ? phys.sheen : 0,
            sheenColor: new THREE.Color(phys.sheenColor),
            sheenRoughness: phys.sheenRoughness,
            envMapIntensity: phys.envMapIntensity,
            side: THREE.FrontSide,
        });
        if (spotUvEnabled) {
            // Mask trắng (>50%) = vùng phủ UV bóng (roughness thấp + clearcoat cao).
            outerMaterial.onBeforeCompile = (shader) => {
                shader.fragmentShader = patchSpotUvPhysicalShader(shader.fragmentShader);
            };
            outerMaterial.customProgramCacheKey = () => 'prynx-spot-uv-physical-v2';
        }
        if (texture) {
            texture.colorSpace = THREE.SRGBColorSpace;
        }

        // Tường / mặt trong: Standard (rẻ hơn Physical) — không clearcoat/sheen.
        const wallMaterial = new THREE.MeshStandardMaterial({
            color: edgeHex,
            roughness: 0.9,
            metalness: 0.0,
            envMapIntensity: Math.min(0.4, phys.envMapIntensity),
            side: THREE.FrontSide,
        });

        const hasInnerArt = !!innerTexture;
        const innerMaterial = new THREE.MeshStandardMaterial({
            color: hasInnerArt ? '#ffffff' : innerHex,
            map: innerTexture ?? null,
            roughness: hasInnerArt ? phys.roughness : 0.95,
            metalness: hasInnerArt ? phys.metalness : 0.0,
            envMapIntensity: hasInnerArt ? phys.envMapIntensity * 0.85 : 0.35,
            side: THREE.FrontSide,
        });
        if (innerTexture) {
            innerTexture.colorSpace = THREE.SRGBColorSpace;
        }

        // Chỉ số mảng = chỉ số material group: 0=ngoài, 1=tường, 2=trong.
        // Bì thư: các mặt gập áp phẳng đồng phẳng nhau → dùng polygonOffset theo
        // thứ tự lớp (panel.stackZ) để không z-fighting mà KHÔNG tách rời hình
        // học (giữ các mặt dính liền tại nếp gập).
        const off = -(panel.stackZ ?? 0);
        if (off !== 0) {
            for (const mat of [outerMaterial, wallMaterial, innerMaterial]) {
                mat.polygonOffset = true;
                mat.polygonOffsetFactor = off;
                mat.polygonOffsetUnits = off;
            }
        }
        return outerFaceNegativeZ
            ? [innerMaterial, wallMaterial, outerMaterial]
            : [outerMaterial, wallMaterial, innerMaterial];
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [substrateId, surfaceFinishId, edgeColor, texture, innerTexture, spotUvTexture, embossTexture, panel.stackZ, outerFaceNegativeZ, qualityTier, showPaperGrain]);

    // Slider emboss chỉ cập nhật uniform bumpScale, không dựng lại geometry/material
    // trên mọi panel. Nhờ đó kéo chỉnh vẫn mượt với khuôn có nhiều mặt.
    useEffect(() => {
        const outerMaterial = materials[outerFaceNegativeZ ? MAT_INNER : MAT_OUTER] as THREE.MeshPhysicalMaterial;
        const enabled = surfaceFinishId === 'emboss' && !!embossTexture && embossHeightMm > 0;
        if ('bumpScale' in outerMaterial) {
            outerMaterial.bumpScale = enabled ? clampEmbossHeight(embossHeightMm) : 0;
        }
    }, [materials, surfaceFinishId, embossTexture, embossHeightMm, outerFaceNegativeZ]);
    // Material riêng cho dải bo nếp gập — Standard (rẻ).
    const filletMaterial = useDisposableResource<THREE.MeshStandardMaterial>(() => {
        const appearance = composeAppearance(substrateId, surfaceFinishId);
        return new THREE.MeshStandardMaterial({
            color: appearance.baseColor,
            roughness: appearance.phys.roughness,
            metalness: appearance.phys.metalness,
            envMapIntensity: appearance.phys.envMapIntensity * 0.8,
            side: THREE.DoubleSide,
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [substrateId, surfaceFinishId]);

    // ── 3b. Đường CAD cắt/cấn — bản phẳng (panel.paths) hoặc bám mặt nón ──
    const lineGeometries = useDisposableResource<THREE.BufferGeometry[]>(
        () => {
            if (coneWarp) {
                // Tai dán chỉ là mặt patch (không vẽ outline riêng); thân vẽ nét
                // khuôn parametrik (vành + mép + đường nhấn mí dán) — sạch, không
                // dính outline tai dán lồi ra.
                if (conePatchOnly) {
                    return [new THREE.BufferGeometry(), new THREE.BufferGeometry()];
                }
                return buildConeOutlineGeometries(coneWarp, resolvedFoldProgress, thickness);
            }
            return buildPathLineGeometries(panel);
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [panel, coneWarp, conePatchOnly, coneWarp ? resolvedFoldProgress : 0, thickness],
    );
    const cutGeo = lineGeometries?.[0] ?? null;
    const creaseGeo = lineGeometries?.[1] ?? null;

    // [SHADOW FIX 2026-07-27 §DT3D-008] Đường CAD chỉ là lớp chú thích hiển thị.
    // Tách chúng khỏi depth pass của ContactShadows để hai khuôn phẳng của hộp
    // âm dương không in hàng sọc vào texture bóng; mesh giấy vẫn đổ bóng như hộp khác.
    useLayoutEffect(() => {
        moveToMockupVisualOnlyLayer(cadVisualsRef.current);
    }, [cutGeo, creaseGeo, hideCadLines, resolvedFoldProgress]);

    // Điểm cho FAT LINE (drei <Line segments>) — đặt nét NGAY TRÊN mặt ngoài
    // panel (z = offsetZ), KHÔNG nâng hình học (nâng nhiều → nét lềnh bềnh tách
    // khỏi mặt khi gập). Tránh z-fighting bằng polygonOffset ở material (lệch
    // độ sâu, không dời hình) → nét bám mặt, không chìm, không trôi.
    const cutOuterPts = useMemo(() => bufferToSegPoints(cutGeo, offsetZ), [cutGeo, offsetZ]);
    const creaseOuterPts = useMemo(() => bufferToSegPoints(creaseGeo, offsetZ), [creaseGeo, offsetZ]);

    // ── 4–5. Ma trận gập + exploded ──
    // Khi animation driver chạy: đọc `foldLive` trong useFrame (60fps) — KHÔNG
    // phụ thuộc re-render React. Khi user kéo slider: seed foldLive + áp ngay.
    const foldScratch = useRef({
        version: -1,
        basePos: new THREE.Vector3(),
        worldNormal: new THREE.Vector3(),
        delta: new THREE.Matrix4(),
        // [PERF (audit 2026-07-27 §DT3D-004)] Tái sử dụng ma trận cho panel này.
        fold: {
            result: new THREE.Matrix4(),
            step: new THREE.Matrix4(),
            temp: new THREE.Matrix4(),
        } satisfies FoldCompensationScratch,
        warned: false,
    });

    const applyFoldMatrix = (progress: number) => {
        const group = groupRef.current;
        if (!group || coneWarp) {
            if (group && coneWarp) {
                group.matrix.identity();
                group.matrixWorldNeedsUpdate = true;
            }
            return;
        }
        const foldResult = applyFoldCompensation(
            panel, allPanels, progress, depthMap, maxD, thickness,
            foldScratch.current.fold,
        );
        if (foldResult.skipped && foldResult.warning && !foldScratch.current.warned) {
            foldScratch.current.warned = true;
            console.warn(`[SolidPanelMesh] ${foldResult.warning}`);
        }
        const m = foldResult.matrix;
        const { basePos, worldNormal, delta } = foldScratch.current;
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

    const resolveLiveProgress = (progress: number) => (
        liveFoldEnd < 1
            ? Math.min(progress / Math.max(liveFoldEnd, 1e-6), 1)
            : progress
    );

    // Slider / store → live (khi không có driver animation).
    useEffect(() => {
        seedFoldLiveFromStore(foldProgress);
        if (!foldLive.driving) {
            applyFoldMatrix(resolvedFoldProgress);
            foldScratch.current.version = foldLive.version;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [foldProgress, resolvedFoldProgress, liveFoldEnd, panel, allPanels, depthMap, maxD, thickness, explodedFactor, explodeSpacing, coneWarp]);

    // Animation: cập nhật ma trận mỗi frame từ foldLive, không re-render React.
    useFrame(() => {
        if (foldLive.version === foldScratch.current.version) return;
        foldScratch.current.version = foldLive.version;
        // [DOUBLE-TRAY FIX 2026-07-27 §DT3D-002] Panel hoàn tất gấp
        // trước khi pose lồng/chụp bắt đầu.
        applyFoldMatrix(resolveLiveProgress(foldLive.progress));
    });

    // ── Kéo ảnh TRỰC TIẾP trên mặt 3D (artworkEditMode) ──
    // Bbox outline phẳng của panel (mm) để chuẩn hoá vị trí điểm chạm về [0,1].
    const outlineBBox = useMemo(() => {
        const ring = (panel.outline && panel.outline.length >= 3) ? panel.outline : null;
        if (!ring) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of ring) {
            if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        }
        return { minX, minY, width: maxX - minX, height: maxY - minY };
    }, [panel.outline]);

    const artEditable = artworkEditMode && !!outerUrl && !coneWarp;
    const dragRef = useRef<{ nu: number; nv: number } | null>(null);

    // Chuẩn hoá điểm chạm (world → local panel → [0,1] theo khung tham chiếu).
    const toNorm = (e: ThreeEvent<PointerEvent>): { nu: number; nv: number } | null => {
        const mesh = e.object as THREE.Mesh;
        const local = mesh.worldToLocal(e.point.clone());
        const ref = artworkMode === 'aligned-to-dieline'
            ? { minX: globalBBox.minX, minY: globalBBox.minY, width: globalBBox.width, height: globalBBox.height }
            : outlineBBox;
        if (!ref || !(ref.width > 0) || !(ref.height > 0)) return null;
        return { nu: (local.x - ref.minX) / ref.width, nv: (local.y - ref.minY) / ref.height };
    };

    const onArtDown = (e: ThreeEvent<PointerEvent>) => {
        if (!artEditable) return;
        e.stopPropagation();
        const n = toNorm(e);
        if (n) {
            dragRef.current = n;
            (e.target as Element | null)?.setPointerCapture?.(e.pointerId);
        }
    };
    const onArtMove = (e: ThreeEvent<PointerEvent>) => {
        if (!artEditable || !dragRef.current) return;
        e.stopPropagation();
        const n = toNorm(e);
        if (!n) return;
        const dnu = n.nu - dragRef.current.nu;
        const dnv = n.nv - dragRef.current.nv;
        dragRef.current = n;
        // offset% tăng theo vị trí điểm chạm → ảnh "đi theo" con trỏ.
        setOuterArtworkTransform({
            ...outerTransform,
            offsetXPct: (outerTransform.offsetXPct ?? 0) + dnu * 100,
            offsetYPct: (outerTransform.offsetYPct ?? 0) + dnv * 100,
        });
    };
    const onArtUp = (e: ThreeEvent<PointerEvent>) => {
        if (dragRef.current) {
            e.stopPropagation();
            dragRef.current = null;
        }
    };

    // Không render nếu geometry rỗng (outline panel không hợp lệ).
    const positionAttr = geometry?.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!geometry || !positionAttr || positionAttr.count === 0) {
        return null;
    }

    const flatHasCut = !coneWarp && !hideCadLines && !!cutGeo && (cutGeo.getAttribute('position')?.count ?? 0) > 0;
    const flatHasCrease = !coneWarp && !hideCadLines && !!creaseGeo && (creaseGeo.getAttribute('position')?.count ?? 0) > 0;
    // Bọc ly: nét khuôn đã ánh xạ bám mặt nón; đặt ở cùng tịnh tiến với geometry
    // nón (cx, cy−H/2) để trùng surface.
    const coneLines = !!coneWarp && !hideCadLines && !!conePaths;
    const coneCutHas = coneLines && !!cutGeo && (cutGeo.getAttribute('position')?.count ?? 0) > 0;
    const coneCreaseHas = coneLines && !!creaseGeo && (creaseGeo.getAttribute('position')?.count ?? 0) > 0;
    const coneLinePos: [number, number, number] = coneWarp
        ? [
            globalBBox.minX + globalBBox.width / 2,
            globalBBox.minY + globalBBox.height / 2,
            0,
        ]
        : [0, 0, 0];

    // Nâng nhẹ đường CAD ra khỏi mặt cap để không trùng mặt phẳng (tránh
    // Z-fighting line↔mặt). Lượng nâng nhỏ so với kích thước hộp nên không
    // gây cảm giác đường bị tách rời.
    const lineLift = Math.max(depth * 0.5, 0.12);
    const outerLineZ = offsetZ + lineLift;
    const innerLineZ = -(offsetZ + lineLift);

    return (
        <group ref={groupRef} matrixAutoUpdate={false}>
            <mesh
                geometry={geometry}
                material={materials}
                castShadow
                receiveShadow
                onPointerDown={artEditable ? onArtDown : undefined}
                onPointerMove={artEditable ? onArtMove : undefined}
                onPointerUp={artEditable ? onArtUp : undefined}
            />

            {/* ── Dải bo tròn tại nếp gập (góc gập cong mượt như giấy) ── */}
            {foldFilletGeo && (
                <mesh geometry={foldFilletGeo} material={filletMaterial} castShadow receiveShadow />
            )}

            <group ref={cadVisualsRef} name="panel-cad-visuals">
                {/* ── Nét khuôn bám mặt nón (bọc ly) — cuốn theo foldProgress ── */}
                {coneCutHas && (
                    <lineSegments geometry={cutGeo!} position={coneLinePos}>
                        <lineBasicMaterial color="#5a4a36" transparent opacity={0.55} depthWrite={false} />
                    </lineSegments>
                )}
                {coneCreaseHas && (
                    <lineSegments geometry={creaseGeo!} position={coneLinePos}>
                        <lineBasicMaterial color="#8a6a40" transparent opacity={0.5} depthWrite={false} />
                    </lineSegments>
                )}

                {/* ── Overlay đường CAD (FAT LINE, bám mặt nhờ polygonOffset) ── */}
                {flatHasCut && cutOuterPts.length > 1 && (
                    <Line points={cutOuterPts} segments color="#23272e" lineWidth={1.6} transparent opacity={0.9}
                        depthWrite={false} polygonOffset polygonOffsetFactor={-4} polygonOffsetUnits={-4} />
                )}
                {flatHasCrease && creaseOuterPts.length > 1 && (
                    <Line points={creaseOuterPts} segments color="#e23b3b" lineWidth={1.6} transparent opacity={0.95}
                        depthWrite={false} polygonOffset polygonOffsetFactor={-4} polygonOffsetUnits={-4} />
                )}
            </group>
        </group>
    );
}
