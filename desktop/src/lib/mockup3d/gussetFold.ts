// ============================================================
// Gusset Fold — Miếng đệm góc khay (FEFCO 0410), gập đôi theo nếp chéo
//
// Miếng đệm góc là MỘT tờ giấy hình quạt gồm 2 nửa tam giác nối liền dọc NẾP
// GẬP CHÉO a→c (đường nhấn đỏ ở giữa khuôn 2D):
//   • Nửa (a, d, c) — bám vách trước/sau (cạnh a→d nằm trên cạnh đứng vách).
//   • Nửa (a, c, dP) — bám vách hông (cạnh a→dP nằm trên cạnh đứng vách hông).
//
// Khi 2 vách dựng lên, nếp chéo a→c GẬP LẠI thành SỐNG nổi hướng vào lòng hộp;
// 2 nửa vẫn dính nhau dọc a→c (không cắt rời) và mỗi nửa vẫn bám vách của nó
// (không rách ở chỗ giao). Engine cây 1-cha không mô tả được cơ cấu này nên
// trước đây miếng góc bị bỏ qua / nằm phẳng.
//
// Cách tính mỗi khung:
//   1. Đặt cạnh a→d theo ma trận gập vách trước/sau (A, D1).
//   2. Đặt cạnh a→dP theo ma trận gập vách hông (P2 = đỉnh dP trên vách hông).
//   3. Đỉnh chung c (cuối nếp chéo) = TRILATERATION từ A, D1, P2 với đúng các
//      cự ly cạnh ở trạng thái phẳng (|a-c|, |d-c|, |dP-c|) → c tự cụp vào lòng
//      hộp, nối liền 2 nửa.
//
// Toạ độ trả về ở hệ PHẲNG-ĐÃ-GẬP (khớp ma trận applyFoldCompensation).
// ============================================================

import * as THREE from 'three';
import type { Panel } from './types';
import { applyFoldCompensation } from './foldCompensation';

export interface GussetQuad {
    a: THREE.Vector3; // góc neo
    d: THREE.Vector3; // đỉnh trên cạnh vách trước/sau
    c: THREE.Vector3; // đỉnh nếp chéo (cụp vào trong)
    p: THREE.Vector3; // đỉnh trên cạnh vách hông
}

const dist2D = (x1: number, y1: number, x2: number, y2: number): number =>
    Math.hypot(x1 - x2, y1 - y2);

/**
 * Hệ số ÉP đỉnh miếng góc sát vào mặt phẳng vách hông ∈ [0,1].
 * 0 = giữ nguyên chóp nếp gập (nhô vào lòng); 1 = ép phẳng hẳn vào vách.
 * ~0.6: đỉnh nằm gọn trong vùng dầm (≤ G), không cấn vách phụ khi gập xuống.
 */
const GUSSET_WALL_PRESS = 0.6;

/**
 * Trilateration: tìm điểm cách `p1,p2,p3` lần lượt `r1,r2,r3`. Trả về 2 nghiệm
 * đối xứng qua mặt phẳng (p1,p2,p3), hoặc `null` nếu suy biến/không có nghiệm.
 */
function trilaterate(
    p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3,
    r1: number, r2: number, r3: number,
): [THREE.Vector3, THREE.Vector3] | null {
    const ex = p2.clone().sub(p1);
    const dd = ex.length();
    if (dd < 1e-9) return null;
    ex.divideScalar(dd);
    const p3m1 = p3.clone().sub(p1);
    const i = ex.dot(p3m1);
    const ey = p3m1.clone().sub(ex.clone().multiplyScalar(i));
    const eyLen = ey.length();
    if (eyLen < 1e-9) return null;
    ey.divideScalar(eyLen);
    const ez = ex.clone().cross(ey);
    const j = ey.dot(p3m1);

    const x = (r1 * r1 - r2 * r2 + dd * dd) / (2 * dd);
    const y = (r1 * r1 - r3 * r3 + i * i + j * j) / (2 * j) - (i / j) * x;
    const z2 = r1 * r1 - x * x - y * y;
    const z = Math.sqrt(Math.max(0, z2));

    const base = p1.clone()
        .add(ex.clone().multiplyScalar(x))
        .add(ey.clone().multiplyScalar(y));
    const off = ez.clone().multiplyScalar(z);
    return [base.clone().add(off), base.clone().sub(off)];
}

/**
 * Tính 4 đỉnh 3D của miếng đệm góc tại `foldProgress`. Trả về `null` nếu panel
 * không có metadata gusset hoặc thiếu vách tham chiếu.
 */
export function computeGussetQuad(
    panel: Panel,
    allPanels: Panel[],
    foldProgress: number,
    depthMap: Map<string, number>,
    maxD: number,
    thickness: number,
): GussetQuad | null {
    const g = panel.gusset;
    if (!g) return null;

    const frontWall = allPanels.find((p) => p.name === g.frontWall);
    const sideWall = allPanels.find((p) => p.name === g.sideWall);
    if (!frontWall || !sideWall) return null;

    const Mf = applyFoldCompensation(frontWall, allPanels, foldProgress, depthMap, maxD, thickness).matrix;
    const Ms = applyFoldCompensation(sideWall, allPanels, foldProgress, depthMap, maxD, thickness).matrix;

    // Cạnh a→d bám vách trước/sau; cạnh a→dP bám vách hông.
    const A = new THREE.Vector3(g.a.x, g.a.y, 0).applyMatrix4(Mf);
    const D1 = new THREE.Vector3(g.d.x, g.d.y, 0).applyMatrix4(Mf);
    const P2 = new THREE.Vector3(g.dP.x, g.dP.y, 0).applyMatrix4(Ms);

    // Cự ly cạnh ở trạng thái phẳng (bất biến khi gập).
    const rac = dist2D(g.a.x, g.a.y, g.c.x, g.c.y);   // |a-c|
    const rdc = dist2D(g.d.x, g.d.y, g.c.x, g.c.y);   // |d-c|
    const rpc = dist2D(g.dP.x, g.dP.y, g.c.x, g.c.y); // |dP-c|

    // Đỉnh nếp chéo c: cách A = rac, D1 = rdc, P2 = rpc.
    const sols = trilaterate(A, D1, P2, rac, rdc, rpc);
    let C: THREE.Vector3;
    if (!sols) {
        // Suy biến (vd lúc phẳng) → đặt c theo vách trước/sau.
        C = new THREE.Vector3(g.c.x, g.c.y, 0).applyMatrix4(Mf);
    } else {
        // Chọn nghiệm cụp VÀO LÒNG hộp (gần tâm hơn theo XY).
        const cx = g.center.x, cy = g.center.y;
        const d0 = dist2D(sols[0].x, sols[0].y, cx, cy);
        const d1 = dist2D(sols[1].x, sols[1].y, cx, cy);
        C = d0 <= d1 ? sols[0] : sols[1];
    }

    // ÉP đỉnh sát vào MẶT PHẲNG VÁCH HÔNG: kéo C bớt nhô vào lòng để miếng góc
    // nằm gọn trong vùng dầm (≤ G), tránh cấn vách phụ khi gập xuống. n_side là
    // pháp tuyến vách hông hiện tại (từ Ms); dịch C theo −n_side một phần khoảng
    // cách vuông góc tới mặt vách.
    if (GUSSET_WALL_PRESS > 0) {
        const nSide = new THREE.Vector3(0, 0, 1).transformDirection(Ms);
        const distPerp = C.clone().sub(P2).dot(nSide);
        C.addScaledVector(nSide, -distPerp * GUSSET_WALL_PRESS);
    }

    return { a: A, d: D1, c: C, p: P2 };
}
