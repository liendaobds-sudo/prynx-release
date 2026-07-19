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
//   - `getFinish` + finish PBR → vật liệu `MeshStandardMaterial` (roughness/
//                                metalness) áp ĐỒNG NHẤT cho toàn panel,
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

import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';

import { useMockupStore } from '../../store/useMockupStore';
import type { BBox, Panel, Point2D } from '../../lib/mockup3d/types';
import { buildPanelSolid, buildFoldFilletGeometry, clampThickness, normalizeEdgeColor } from '../../lib/mockup3d/panelSolid';
import { buildConeFrustumGeometry, buildConeGluePatchGeometry, buildConeOutlineGeometries, type ConeWarpParams } from '../../lib/mockup3d/cupSleeveCone';
import { tracePerimeter } from '../../lib/dieline/tracePerimeter';
import { clampArtworkTransform, computePanelUV } from '../../lib/mockup3d/artworkMapping';
import { getFinish } from '../../lib/mockup3d/materialLibrary';
import { applyFoldCompensation } from '../../lib/mockup3d/foldCompensation';
import { applyExplodedOffset, type Vec3 } from '../../lib/mockup3d/explodedView';
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

/**
 * Màu albedo MẶT TRONG (mặt giấy bồi không in) theo `edgeColor`. Cố tình
 * chọn tông trầm/ấm KHÁC RÕ so với mặt ngoài để người dùng phân biệt được
 * mặt trước/mặt sau khi xoay mô hình (yêu cầu giữ độ tương phản hai mặt).
 */
const INNER_FACE_COLOR: Record<'kraft' | 'white', string> = {
    kraft: '#a9784a',
    white: '#cbb896',
};

/**
 * Màu albedo NỀN của mặt panel theo finish (dùng khi KHÔNG có ảnh nghệ
 * thuật). Khi có texture, màu nền là trắng để không nhuộm màu ảnh.
 */
const FINISH_BASE_COLOR: Record<string, string> = {
    kraft: '#c8a16a',
    'sbs-white': '#f3efe7',
    'matte-lam': '#fbfaf7',
    'gloss-lam': '#ffffff',
    'spot-uv': '#fbfaf7',
    'foil-metallic': '#d8d2c2',
    emboss: '#ece6d8',
};

/** Khoảng cách tách rời cơ sở (mm) ứng với 1 đơn vị hệ số explodedFactor. */
const DEFAULT_EXPLODE_SPACING_MM = 40;

/** Chỉ số material cho từng nhóm tam giác của geometry solid. */
const MAT_OUTER = 0; // cap mặt ngoài (+Z)
const MAT_WALL = 1; // tường cạnh (⊥ Z)
const MAT_INNER = 2; // cap mặt trong (−Z)

/** Ngưỡng |pháp tuyến.z| để coi một tam giác là cap (mặt phẳng) thay vì tường. */
const CAP_NORMAL_Z_THRESHOLD = 0.7;

// ─── Props ───────────────────────────────────────────────────────────────────

export interface SolidPanelMeshProps {
    /** Panel cần render (dùng `outline`/`holes` cho hình học solid). */
    panel: Panel;
    /** Toàn bộ panel của hộp (để tích lũy ma trận gập theo chuỗi cha). */
    allPanels: Panel[];
    /** Tiến trình gập hiện tại trong [0, 1]. */
    foldProgress: number;
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
    const outerUV = computePanelUV(pseudoPanel, mode, outerTransform, globalBBox, 'outer', outerImageAspect);
    const innerUV = computePanelUV(pseudoPanel, mode, innerTransform, globalBBox, 'inner', innerImageAspect);

    const uv = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
        const z = flatZ ? flatZ[i] : position.getZ(i);
        // Mặt ở phía Z+ coi là mặt ngoài; phía Z- là mặt trong.
        const src = z >= midZ ? outerUV : innerUV;
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
    const image = texture?.image as {
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
    depthMap,
    maxD,
    thickness,
    globalBBox,
    texture = null,
    innerTexture = null,
    explodeSpacing = DEFAULT_EXPLODE_SPACING_MM,
    coneWarp = null,
    conePaths = null,
    conePatchOnly = false,
    hideCadLines = false,
    roundFolds = false,
}: SolidPanelMeshProps) {
    const groupRef = useRef<THREE.Group>(null);

    // State trình bày từ store mockup (tách biệt khỏi đường dẫn dieline).
    const finishId = useMockupStore((s) => s.finishId);
    const edgeColor = useMockupStore((s) => s.edgeColor);
    const explodedFactor = useMockupStore((s) => s.explodedFactor);
    const artworkMode = useMockupStore((s) => s.artwork.mode);
    const outerTransform = useMockupStore((s) => s.artwork.outer.transform);
    const innerTransform = useMockupStore((s) => s.artwork.inner.transform);
    const artworkEditMode = useMockupStore((s) => s.artworkEditMode);
    const outerUrl = useMockupStore((s) => s.artwork.outer.url);
    const setOuterArtworkTransform = useMockupStore((s) => s.setOuterArtworkTransform);
    const outerImageAspect = textureImageAspect(texture);
    const innerImageAspect = textureImageAspect(innerTexture);

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
                const patch = buildConeGluePatchGeometry(outline, coneWarp, foldProgress, thickness);
                patch.translate(cx, ty, 0);
                return patch;
            }
            const cone = buildConeFrustumGeometry(coneWarp, thickness, foldProgress);
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
    }, [panel, thickness, coneWarp, conePatchOnly, coneWarp ? foldProgress : 0]);

    // ── 1b. Dải BO TRÒN tại nếp gập (fillet) — góc gập cong mượt như giấy ──
    const foldFilletGeo = useDisposableResource<THREE.BufferGeometry | null>(() => {
        if (!roundFolds || coneWarp) return null;
        if (panel.parent === null || !panel.pivotEdge) return null;
        const piv = panel.pivotEdge;
        const depthLevel = depthMap.get(panel.name) ?? 0;
        const theta = effFoldAngleRad(panel, foldProgress, depthLevel, maxD);
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
    }, [panel, thickness, roundFolds, coneWarp, foldProgress, depthMap, maxD]);

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
        );
    }, [geometry, panel, artworkMode, outerTransform, innerTransform, globalBBox, coneWarp, outerImageAspect, innerImageAspect]);

    // ── 3. Vật liệu: mặt ngoài (finish/ảnh) ≠ mặt trong (giấy bồi) ≠ tường cạnh.
    //    Thứ tự material khớp chỉ số nhóm: [MAT_OUTER, MAT_WALL, MAT_INNER]
    //    (Yêu cầu 4.4 + giữ tương phản hai mặt).
    const materials = useDisposableResource<THREE.MeshStandardMaterial[]>(() => {
        const finish = getFinish(finishId);
        const edge = normalizeEdgeColor(edgeColor);
        const baseColor = FINISH_BASE_COLOR[finish.id] ?? '#ffffff';
        const edgeHex = EDGE_COLOR_HEX[edge];
        const innerHex = INNER_FACE_COLOR[edge];

        // Solid khép kín có pháp tuyến hướng RA NGOÀI, nên dùng `FrontSide`
        // cho cả ba nhóm: tránh vẽ thừa mặt sau (backface) của hai cap chỉ
        // cách nhau bằng độ dày giấy (rất mỏng) — nguyên nhân gây nhấp nháy
        // (Z-fighting) trên toàn bề mặt khi xoay. Cap ngoài hướng +Z, cap
        // trong hướng −Z, tường cạnh hướng ra ngoài → FrontSide hiển thị đúng.
        const outerMaterial = new THREE.MeshStandardMaterial({
            color: texture ? '#ffffff' : baseColor,
            map: texture ?? null,
            roughness: finish.roughness,
            metalness: finish.metalness,
            side: THREE.FrontSide,
        });
        if (texture) {
            texture.colorSpace = THREE.SRGBColorSpace;
        }

        // Tường cạnh: màu mép giấy.
        const wallMaterial = new THREE.MeshStandardMaterial({
            color: edgeHex,
            roughness: 0.9,
            metalness: 0.0,
            side: THREE.FrontSide,
        });

        // Mặt trong: ảnh in (khi bật) hoặc màu giấy bồi tương phản.
        const hasInnerArt = !!innerTexture;
        const innerMaterial = new THREE.MeshStandardMaterial({
            color: hasInnerArt ? '#ffffff' : innerHex,
            map: innerTexture ?? null,
            roughness: hasInnerArt ? finish.roughness : 0.95,
            metalness: hasInnerArt ? finish.metalness : 0.0,
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
        return [outerMaterial, wallMaterial, innerMaterial];
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [finishId, edgeColor, texture, innerTexture, panel.stackZ]);

    // Material riêng cho dải bo nếp gập: màu giấy mặt ngoài, 2 mặt (DoubleSide)
    // để hiện đúng dù chiều winding nào.
    const filletMaterial = useDisposableResource<THREE.MeshStandardMaterial>(() => {
        const finish = getFinish(finishId);
        const baseColor = FINISH_BASE_COLOR[finish.id] ?? '#ffffff';
        return new THREE.MeshStandardMaterial({
            color: baseColor,
            roughness: finish.roughness,
            metalness: finish.metalness,
            side: THREE.DoubleSide,
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [finishId]);

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
                return buildConeOutlineGeometries(coneWarp, foldProgress, thickness);
            }
            return buildPathLineGeometries(panel);
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [panel, coneWarp, conePatchOnly, coneWarp ? foldProgress : 0, thickness],
    );
    const cutGeo = lineGeometries?.[0] ?? null;
    const creaseGeo = lineGeometries?.[1] ?? null;

    // Điểm cho FAT LINE (drei <Line segments>) — đặt nét NGAY TRÊN mặt ngoài
    // panel (z = offsetZ), KHÔNG nâng hình học (nâng nhiều → nét lềnh bềnh tách
    // khỏi mặt khi gập). Tránh z-fighting bằng polygonOffset ở material (lệch
    // độ sâu, không dời hình) → nét bám mặt, không chìm, không trôi.
    const cutOuterPts = useMemo(() => bufferToSegPoints(cutGeo, offsetZ), [cutGeo, offsetZ]);
    const creaseOuterPts = useMemo(() => bufferToSegPoints(creaseGeo, offsetZ), [creaseGeo, offsetZ]);

    // ── 4. Ma trận gập + bù độ dày (Yêu cầu 2.1) ──
    const foldResult = useMemo(
        () => applyFoldCompensation(panel, allPanels, foldProgress, depthMap, maxD, thickness),
        [panel, allPanels, foldProgress, depthMap, maxD, thickness],
    );

    // Cảnh báo panel thiếu hình học (Yêu cầu 2.6) — không làm treo cảnh.
    useEffect(() => {
        if (foldResult.skipped && foldResult.warning) {
            console.warn(`[SolidPanelMesh] ${foldResult.warning}`);
        }
    }, [foldResult]);

    // ── 5. Dịch tách rời theo pháp tuyến panel (Yêu cầu 7.5) ──
    const finalMatrix = useMemo(() => {
        // Bọc ly: hình học đã đặt sẵn trong không gian nón (qua mapper); KHÔNG
        // áp ma trận gập/tách rời (panel tai dán có quan hệ gập sẽ làm lệch).
        if (coneWarp) {
            return new THREE.Matrix4();
        }
        const m = foldResult.matrix.clone();

        // Pháp tuyến panel ở trạng thái phẳng là +Z; biến đổi theo ma trận gập
        // để lấy pháp tuyến trong không gian thế giới.
        const worldNormal = new THREE.Vector3(0, 0, 1).transformDirection(m);
        const normal: Vec3 = { x: worldNormal.x, y: worldNormal.y, z: worldNormal.z };

        // Vị trí gập gốc (tịnh tiến của ma trận gập).
        const basePos = new THREE.Vector3().setFromMatrixPosition(m);
        const moved = applyExplodedOffset(
            { x: basePos.x, y: basePos.y, z: basePos.z },
            normal,
            explodedFactor,
            explodeSpacing,
        );

        // Áp phần dịch tách rời như tịnh tiến trong không gian thế giới.
        const delta = new THREE.Matrix4().makeTranslation(
            moved.x - basePos.x,
            moved.y - basePos.y,
            moved.z - basePos.z,
        );
        return delta.multiply(m);
    }, [foldResult, explodedFactor, explodeSpacing, coneWarp]);

    // Áp ma trận trực tiếp lên group (matrixAutoUpdate=false).
    useEffect(() => {
        if (groupRef.current) {
            groupRef.current.matrix.copy(finalMatrix);
            groupRef.current.matrixWorldNeedsUpdate = true;
        }
    }, [finalMatrix]);

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
    );
}
