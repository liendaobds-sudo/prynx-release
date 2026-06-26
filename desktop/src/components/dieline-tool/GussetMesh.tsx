// ============================================================
// GussetMesh — Miếng đệm góc khay (FEFCO 0410) render gập đôi theo nếp chéo
//
// Engine gập cây 1-cha không gắn được 1 panel vào ĐỒNG THỜI 2 vách gập độc lập
// (pivotEdge=[a,a] suy biến) → góc khay bị bỏ qua, nằm phẳng như "cắt rời".
// Component này render miếng đệm góc bằng cơ cấu per-frame (lib/mockup3d/
// gussetFold): miếng quạt a–d–c–dP gồm 2 nửa tam giác (a,d,c) bám vách trước/
// sau và (a,c,dP) bám vách hông, gập theo NẾP CHÉO a→c thành sống nổi hướng
// vào lòng hộp — liền mạch 2 vách, không cắt rời, không rách chỗ giao.
//
// Vật liệu khớp các panel hộp: MẶT NGOÀI (finish) ≠ MẶT TRONG (giấy bồi) — vẽ
// 2 mesh single-side với winding nhất quán mặt phẳng gốc (+Z = mặt ngoài). Nét
// khuôn (cắt/nhấn) map từ path 2D lên hình gập 3D để đồng bộ chi tiết CAD.
// ============================================================

import React from 'react';
import * as THREE from 'three';

import { useMockupStore } from '../../store/useMockupStore';
import type { Panel } from '../../lib/mockup3d/types';
import { getFinish } from '../../lib/mockup3d/materialLibrary';
import { normalizeEdgeColor } from '../../lib/mockup3d/panelSolid';
import { computeGussetQuad } from '../../lib/mockup3d/gussetFold';
import { useDisposableResource } from './useDisposeResources';

/** Màu nền MẶT NGOÀI theo finish (khớp SolidPanelMesh.FINISH_BASE_COLOR). */
const FINISH_BASE_COLOR: Record<string, string> = {
    kraft: '#c8a16a',
    'sbs-white': '#f3efe7',
    'matte-lam': '#fbfaf7',
    'gloss-lam': '#ffffff',
    'spot-uv': '#fbfaf7',
    'foil-metallic': '#d8d2c2',
    emboss: '#ece6d8',
};

/** Màu giấy bồi MẶT TRONG (khớp SolidPanelMesh.INNER_FACE_COLOR). */
const INNER_FACE_COLOR: Record<'kraft' | 'white', string> = {
    kraft: '#a9784a',
    white: '#cbb896',
};

export interface GussetMeshProps {
    panel: Panel;
    allPanels: Panel[];
    foldProgress: number;
    depthMap: Map<string, number>;
    maxD: number;
    thickness: number;
}

/**
 * Render một miếng đệm góc khay. Trả về `null` nếu panel không có metadata
 * gusset hoặc hình học suy biến.
 */
export default function GussetMesh({
    panel,
    allPanels,
    foldProgress,
    depthMap,
    maxD,
    thickness,
}: GussetMeshProps) {
    const finishId = useMockupStore((s) => s.finishId);
    const edgeColor = useMockupStore((s) => s.edgeColor);

    // Hình quạt 2 tam giác + nét khuôn — tính lại mỗi khung theo foldProgress.
    // Trả mảng [surface, cutOuter, cutInner, creaseOuter, creaseInner] để hook
    // quản lý vòng đời GPU (dispose khi đổi/unmount).
    const geos = useDisposableResource<THREE.BufferGeometry[]>(() => {
        const q = computeGussetQuad(panel, allPanels, foldProgress, depthMap, maxD, thickness);
        if (!q) return [];
        const { a, d, c, p } = q;

        // Chuẩn hóa winding theo BẢN PHẲNG: mặt ngoài (finish) phải khớp mặt
        // ngoài tờ giấy (+Z phẳng) cho CẢ 4 góc. dirSign khác nhau khiến pháp
        // tuyến (a→d→c) ra +Z với 2 góc và −Z với 2 góc → nếu âm thì đảo thứ tự
        // đỉnh để FrontSide luôn quay về mặt ngoài.
        const g = panel.gusset!;
        const flatZ = (g.d.x - g.a.x) * (g.c.y - g.a.y) - (g.d.y - g.a.y) * (g.c.x - g.a.x);
        const ccw = flatZ >= 0;

        // Mặt: 2 tam giác (a,d,c) + (a,c,p) chung cạnh chéo a→c (đảo nếu cần).
        const surface = new THREE.BufferGeometry();
        const tri = ccw
            ? [a, d, c, a, c, p]
            : [a, c, d, a, p, c];
        surface.setAttribute('position', new THREE.BufferAttribute(new Float32Array(
            tri.flatMap((v) => [v.x, v.y, v.z]),
        ), 3));
        surface.computeVertexNormals();

        // Pháp tuyến miếng góc (hướng MẶT NGOÀI) để nâng nét khỏi mặt.
        const n = d.clone().sub(a).cross(c.clone().sub(a));
        if (!ccw) n.negate();
        if (n.length() > 1e-9) n.normalize();
        const lift = Math.max(thickness * 0.5, 0.12);
        const up = n.clone().multiplyScalar(lift);
        const dn = n.clone().multiplyScalar(-lift);
        const off = (v: THREE.Vector3, o: THREE.Vector3) => v.clone().add(o);

        // Nét khuôn: map path 2D → 3D. b = 1/3 dọc a→c (khớp khuôn 2D: a→b CUT,
        // b→c CREASE, c→d CUT, c→dP CUT).
        const b = a.clone().lerp(c, 1 / 3);
        const cutSeq = [a, b, c, d, c, p]; // (a→b), (c→d), (c→p)
        const creaseSeq = [b, c];          // b→c
        const cutOuter = new THREE.BufferGeometry().setFromPoints(cutSeq.map((v) => off(v, up)));
        const cutInner = new THREE.BufferGeometry().setFromPoints(cutSeq.map((v) => off(v, dn)));
        const creaseOuter = new THREE.BufferGeometry().setFromPoints(creaseSeq.map((v) => off(v, up)));
        const creaseInner = new THREE.BufferGeometry().setFromPoints(creaseSeq.map((v) => off(v, dn)));

        return [surface, cutOuter, cutInner, creaseOuter, creaseInner];
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [panel, allPanels, foldProgress, depthMap, maxD, thickness]);

    // Vật liệu mặt ngoài (finish) + mặt trong (giấy bồi) — khớp panel hộp.
    const outerMaterial = useDisposableResource<THREE.MeshStandardMaterial>(() => {
        const finish = getFinish(finishId);
        return new THREE.MeshStandardMaterial({
            color: FINISH_BASE_COLOR[finish.id] ?? '#ffffff',
            roughness: finish.roughness,
            metalness: finish.metalness,
            side: THREE.FrontSide,
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [finishId]);

    const innerMaterial = useDisposableResource<THREE.MeshStandardMaterial>(() => {
        const edge = normalizeEdgeColor(edgeColor);
        return new THREE.MeshStandardMaterial({
            color: INNER_FACE_COLOR[edge],
            roughness: 0.95,
            metalness: 0.0,
            side: THREE.BackSide,
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [edgeColor]);

    if (!geos || geos.length < 5 || !outerMaterial || !innerMaterial) return null;
    const [surface, cutOuter, cutInner, creaseOuter, creaseInner] = geos;

    const hasCut = (cutOuter.getAttribute('position')?.count ?? 0) > 0;
    const hasCrease = (creaseOuter.getAttribute('position')?.count ?? 0) > 0;

    return (
        <group>
            {/* Mặt ngoài (finish) + mặt trong (giấy bồi) — như các panel hộp. */}
            <mesh geometry={surface} material={outerMaterial} castShadow receiveShadow />
            <mesh geometry={surface} material={innerMaterial} castShadow receiveShadow />

            {/* Nét khuôn (cắt/nhấn) — vẽ 2 mặt như SolidPanelMesh. */}
            {hasCut && (
                <>
                    <lineSegments geometry={cutOuter}>
                        <lineBasicMaterial color="#23272e" transparent opacity={0.45} depthWrite={false} />
                    </lineSegments>
                    <lineSegments geometry={cutInner}>
                        <lineBasicMaterial color="#23272e" transparent opacity={0.4} depthWrite={false} />
                    </lineSegments>
                </>
            )}
            {hasCrease && (
                <>
                    <lineSegments geometry={creaseOuter}>
                        <lineBasicMaterial color="#e23b3b" transparent opacity={0.45} depthWrite={false} />
                    </lineSegments>
                    <lineSegments geometry={creaseInner}>
                        <lineBasicMaterial color="#e23b3b" transparent opacity={0.4} depthWrite={false} />
                    </lineSegments>
                </>
            )}
        </group>
    );
}
