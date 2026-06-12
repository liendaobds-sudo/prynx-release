// ============================================================
// Shared Helpers — Dust Flap & Tuck Flap builders
// Used by: ReverseTuckEnd, SnapLockBottom
//
// Extracted from ReverseTuckEnd.ts to eliminate duplication.
// ZERO logic changes — copy-paste verbatim.
// ============================================================

import { PathSegment } from './types';
import { pt, line, snap, bezierSegment } from './utils';
import { KAPPA, DUST_FLAP_BEZIER_SCALE } from './constants';

// ============================================================
// buildDustFlap — Sinh hình dạng tai chống bụi (Dust Flap)
//
// Hình dạng tham khảo từ file "6. Nô lệ hộp mềm.jsx":
//
// mirrorX=false (mặc định):      mirrorX=true (đối xứng gương):
//    P2──────────P3                   P3──────────P2
//   ╱              ╲                 ╱              ╲
//  ╱                P4             P4                ╲
// ╱                  │P5         P5│                  ╲
// P0─────────────────P6          P6─────────────────P0
//
// 7 điểm chính, bo góc cubic bezier tại điểm chuyển tiếp P3.
// ============================================================
export function buildDustFlap(
    xLeft: number,
    xRight: number,
    yBase: number,
    height: number,
    dir: 1 | -1, // 1 = lên trên, -1 = xuống dưới
    mirrorX: boolean = false, // true = lật ngang (step bên trái, 45° bên phải)
    reliefStart: number = 0,  // Bo giảm lực tại P0 (dịch xLeft vào trong)
    reliefEnd: number = 0,    // Bo giảm lực tại P6 (dịch xRight vào trong)
    yStartOffset: number = 0, // Offset Y cho P0 (nối với closure)
    yEndOffset: number = 0    // Offset Y cho P6 (nối với closure)
): PathSegment[] {
    const paths: PathSegment[] = [];
    const w = xRight - xLeft;

    // Kích thước tham chiếu (tỷ lệ theo chiều rộng panel W)
    const sx2 = snap(w * 0.05);   // Lề xiên ≈ 5% rộng panel ≈ 3mm
    const sx3 = snap(w * 0.035);  // Bậc step ≈ 3.5% rộng panel ≈ 2mm
    const sy1 = snap(height * 0.1); // Bậc dọc step ≈ 10% chiều cao ≈ 5mm

    const flapH = height;                     // Chiều cao tai chống bụi
    const yTip = snap(yBase + dir * flapH);   // Y đỉnh (điểm xa nhất)

    // 7 điểm chính — tùy theo mirrorX
    let p0, p1, p2, p3, p4, p5, p6;

    if (!mirrorX) {
        // --- BÌNH THƯỜNG: xiên 45° bên trái, step vuông bên phải ---
        p0 = pt(snap(xLeft + reliefStart), snap(yBase + yStartOffset)); // Base trái
        p1 = pt(snap(xLeft + sx2), snap(yBase + dir * sx2));            // Giao xiên-thẳng
        p2 = pt(snap(xLeft + 2 * sx2), yTip);                          // Đỉnh trái
        p3 = pt(snap(xRight - 2.5 * sx2), yTip);                       // Đỉnh phải (bo tròn)
        p4 = pt(snap(xRight - sx3), snap(yBase + dir * (sy1 + sx3)));   // Step trên
        p5 = pt(xRight, snap(yBase + dir * sy1));                       // Step dưới
        p6 = pt(snap(xRight - reliefEnd), snap(yBase + yEndOffset));    // Base phải
    } else {
        // --- ĐỐI XỨNG GƯƠNG: step vuông bên trái, xiên 45° bên phải ---
        p0 = pt(snap(xLeft + reliefStart), snap(yBase + yStartOffset)); // Base trái
        p1 = pt(xLeft, snap(yBase + dir * sy1));                        // Step dưới
        p2 = pt(snap(xLeft + sx3), snap(yBase + dir * (sy1 + sx3)));    // Step trên
        p3 = pt(snap(xLeft + 2.5 * sx2), yTip);                        // Đỉnh trái (bo tròn)
        p4 = pt(snap(xRight - 2 * sx2), yTip);                         // Đỉnh phải
        p5 = pt(snap(xRight - sx2), snap(yBase + dir * sx2));           // Giao thẳng-xiên
        p6 = pt(snap(xRight - reliefEnd), snap(yBase + yEndOffset));    // Base phải
    }

    if (!mirrorX) {
        // P0→P1→P2: cạnh trái (xiên 45° + thẳng đứng lên đỉnh)
        paths.push(line(p0, p1, 'CUT'));
        paths.push(line(p1, p2, 'CUT'));
    } else {
        // P0→P1→P2: cạnh trái (step + xiên lên)
        paths.push(line(p0, p1, 'CUT'));
        paths.push(line(p1, p2, 'CUT'));
    }

    // --- Bo góc bezier tại P3 (chuyển tiếp cạnh đỉnh → xiên xuống) ---
    const boGoc = snap(Math.min(sx2, flapH * 0.08)); // Bán kính bo ≈ min(lề, 8% cao)

    // Vector P2→P3 (hướng vào P3)
    const dx_in = p3.x - p2.x;
    const dy_in = p3.y - p2.y;
    const len_in = Math.sqrt(dx_in * dx_in + dy_in * dy_in);
    const ux_in = dx_in / len_in;
    const uy_in = dy_in / len_in;

    // Vector P3→P4 (hướng ra khỏi P3)
    const dx_out = p4.x - p3.x;
    const dy_out = p4.y - p3.y;
    const len_out = Math.sqrt(dx_out * dx_out + dy_out * dy_out);
    const ux_out = dx_out / len_out;
    const uy_out = dy_out / len_out;

    // Góc giữa 2 vector
    const dotProduct = ux_in * ux_out + uy_in * uy_out;
    const alpha = Math.acos(Math.max(-1, Math.min(1, dotProduct)));
    const halfTan = Math.tan(alpha / 2);
    const d = halfTan > 0 ? Math.min(boGoc / halfTan, len_in / 2, len_out / 2) : 0;

    // Điểm tiếp tuyến T1 (trước P3) và T2 (sau P3)
    const t1 = pt(snap(p3.x - d * ux_in), snap(p3.y - d * uy_in));
    const t2 = pt(snap(p3.x + d * ux_out), snap(p3.y + d * uy_out));

    // P2 → T1
    paths.push(line(p2, t1, 'CUT'));

    // Đường cong bezier T1 → T2 (native bezier, không sampling)
    if (d > 0 && alpha > 0.01) {
        const k = (4 / 3) * Math.tan(alpha / 4) * (halfTan > 0 ? d * halfTan : boGoc);
        const cp1 = pt(snap(t1.x + k * ux_in), snap(t1.y + k * uy_in));
        const cp2 = pt(snap(t2.x - k * ux_out), snap(t2.y - k * uy_out));
        const scaleFactor = DUST_FLAP_BEZIER_SCALE;
        const cp1s = pt(
            snap(t1.x + (cp1.x - t1.x) * scaleFactor),
            snap(t1.y + (cp1.y - t1.y) * scaleFactor)
        );
        const cp2s = pt(
            snap(t2.x + (cp2.x - t2.x) * scaleFactor),
            snap(t2.y + (cp2.y - t2.y) * scaleFactor)
        );
        paths.push(bezierSegment(t1, cp1s, cp2s, t2, 'CUT'));
    } else {
        paths.push(line(t1, t2, 'CUT'));
    }

    if (!mirrorX) {
        // Cạnh phải: P3(bo)→D(xiên)→E(step)→F(base)
        paths.push(line(t2, p4, 'CUT'));  // Bo → D (xiên xuống)
        paths.push(line(p4, p5, 'CUT')); // D → E (step dọc)
        paths.push(line(p5, p6, 'CUT')); // E → F (step ngang ra base)
    } else {
        // Cạnh phải: P3(bo)→D(đỉnh)→E(xiên)→F(base)
        paths.push(line(t2, p4, 'CUT'));  // Bo → D (cạnh đỉnh)
        paths.push(line(p4, p5, 'CUT')); // D → E (xiên 45° xuống)
        paths.push(line(p5, p6, 'CUT')); // E → F (chạm base)
    }

    return paths;
}


// ============================================================
// buildTuckFlap — Sinh lưỡi đút / tai gài (Tuck-in Flap)
//
// Hình dạng tham khảo từ file "6. Nô lệ hộp mềm.jsx":
//       ╭───────────────╮    ← bo tròn Bezier kappa 2 góc trên
//       │               │    ← cạnh thẳng đứng (KHÔNG taper)
//       │               │
//  T────┘               └────T  ← thụt vào bằng T (đã tính trong tuckInset)
//       └───────────────┘    ← base (CREASE, gắn vào closure)
// ============================================================
export function buildTuckFlap(
    xLeft: number,
    yBase: number,
    width: number,
    height: number,
    cornerR: number,
    dir: 1 | -1
): PathSegment[] {
    const paths: PathSegment[] = [];
    const xRight = snap(xLeft + width);
    const yTip = snap(yBase + dir * height);

    // Đảm bảo cornerR không lớn hơn kích thước cho phép
    const maxR = snap(Math.min(cornerR, height * 0.4, width / 2));

    // Tọa độ Y nơi bắt đầu bo tròn
    const yCornerStart = snap(yTip - dir * maxR);

    // === CẠNH TRÁI (thẳng đứng từ base lên bắt đầu bo) ===
    paths.push(line(pt(xLeft, yBase), pt(xLeft, yCornerStart), 'CUT'));

    // === BO TRÒN GÓC TRÁI — Bezier kappa (chuẩn script tham khảo) ===
    const kLen = snap(maxR * KAPPA);

    if (dir === 1) {
        // Hướng lên: góc trái-trên
        paths.push(bezierSegment(
            pt(xLeft, yCornerStart),
            pt(xLeft, snap(yCornerStart + kLen)),
            pt(snap(xLeft + maxR - kLen), yTip),
            pt(snap(xLeft + maxR), yTip),
            'CUT'
        ));
    } else {
        // Hướng xuống: góc trái-dưới
        paths.push(bezierSegment(
            pt(xLeft, yCornerStart),
            pt(xLeft, snap(yCornerStart - kLen)),
            pt(snap(xLeft + maxR - kLen), yTip),
            pt(snap(xLeft + maxR), yTip),
            'CUT'
        ));
    }

    // === CẠNH TRÊN (ngang) ===
    paths.push(line(pt(snap(xLeft + maxR), yTip), pt(snap(xRight - maxR), yTip), 'CUT'));

    // === BO TRÒN GÓC PHẢI — Bezier kappa ===
    if (dir === 1) {
        // Hướng lên: góc phải-trên
        paths.push(bezierSegment(
            pt(snap(xRight - maxR), yTip),
            pt(snap(xRight - maxR + kLen), yTip),
            pt(xRight, snap(yCornerStart + kLen)),
            pt(xRight, yCornerStart),
            'CUT'
        ));
    } else {
        // Hướng xuống: góc phải-dưới
        paths.push(bezierSegment(
            pt(snap(xRight - maxR), yTip),
            pt(snap(xRight - maxR + kLen), yTip),
            pt(xRight, snap(yCornerStart - kLen)),
            pt(xRight, yCornerStart),
            'CUT'
        ));
    }

    // === CẠNH PHẢI (thẳng đứng từ bo xuống base) ===
    paths.push(line(pt(xRight, yCornerStart), pt(xRight, yBase), 'CUT'));

    return paths;
}
