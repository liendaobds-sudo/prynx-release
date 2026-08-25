// ============================================================
// Matchbox Sleeve — Vỏ Hộp Diêm (bao ngoài, khay trượt vào)
//
// Cấu trúc: ống chữ nhật 4 vách + mí dán keo
//   Khay trượt vào theo hướng L (chiều dài).
//   Mặt cắt ống = W × D → chu vi = 2(sW + sD)
//   Chiều dài ống = sL
//
//   Layout dọc (xoay để L nằm ngang):
//     Chiều ngang mỗi panel: sL (= L + clearance)
//     Chiều dọc stack (bottom → top):
//       Glue(G) | Front(sW) | Side(sD) | Back(sW) | Side(sD)
//
//   Kích thước = Khay + clearance (mặc định 1mm mỗi chiều)
// ============================================================

import {
    BoxParams, Panel, PathSegment, Point2D,
} from './types';
import { pt, line, snap } from './utils';

/** Khe hở giữa khay và vỏ bao ngoài (mm).
 *  1mm mỗi chiều đảm bảo khay trượt vào/ra dễ dàng
 *  mà không quá lỏng. Phù hợp bìa 250–350 gsm. */
const SLEEVE_CLEARANCE = 1;

/**
 * Sinh dieline vỏ hộp diêm (sleeve) — dùng nội bộ, gọi từ MatchboxTray
 * @param params BoxParams gốc (kích thước khay)
 * @param offsetX Dời toàn bộ sleeve sang phải bao nhiêu mm
 * @param offsetY Dời toàn bộ sleeve lên/xuống bao nhiêu mm (để căn giữa với khay)
 * @returns { paths, panels } để ghép vào model chung
 */
export function generateMatchboxSleeve(
    params: BoxParams,
    offsetX: number = 0,
    offsetY: number = 0,
): { paths: PathSegment[]; panels: Panel[] } {
    const clearance = SLEEVE_CLEARANCE;
    const sL = snap(params.L + clearance);  // chiều ngang mỗi panel (tube length)
    const sW = snap(params.W + clearance);  // mặt trước/sau (tube cross-section width)
    const sD = snap(params.D + clearance);  // hông (tube cross-section depth)
    const G = snap(Math.min(params.sleeveGlue ?? 15, sD / 2)); // mí dán keo, max = nửa hông

    const allPaths: PathSegment[] = [];
    const panels: Panel[] = [];

    // ── Layout dọc (Y, bottom → top): Glue | Front(sW) | Side(sD) | Back(sW) | Side(sD) ──
    // Chiều ngang mỗi panel = sL (L hướng ngang)
    const x0 = snap(offsetX);               // cạnh trái (miệng ống)
    const x1 = snap(offsetX + sL);           // cạnh phải (miệng ống)

    // Y positions (stack bottom → top, offset by offsetY for vertical alignment)
    const y0 = snap(offsetY);                 // glue bottom
    const y1 = snap(offsetY + G);             // glue top / front bottom
    const y2 = snap(y1 + sW);                // front top / side1 bottom
    const y3 = snap(y2 + sD);                // side1 top / back bottom
    const y4 = snap(y3 + sW);                // back top / side2 bottom
    const y5 = snap(y4 + sD);                // side2 top

    interface WallCfg {
        name: string; label: string;
        yStart: number; yEnd: number;
        parent: string | null;
    }

    const walls: WallCfg[] = [
        { name: 'sleeve_glue', label: 'Mí dán keo (vỏ)', yStart: y0, yEnd: y1, parent: 'sleeve_front' },
        { name: 'sleeve_front', label: 'Mặt trước (vỏ)', yStart: y1, yEnd: y2, parent: null },
        { name: 'sleeve_side1', label: 'Hông 1 (vỏ)', yStart: y2, yEnd: y3, parent: 'sleeve_front' },
        { name: 'sleeve_back', label: 'Mặt sau (vỏ)', yStart: y3, yEnd: y4, parent: 'sleeve_side1' },
        { name: 'sleeve_side2', label: 'Hông 2 (vỏ)', yStart: y4, yEnd: y5, parent: 'sleeve_back' },
    ];

    for (let i = 0; i < walls.length; i++) {
        const w = walls[i];
        const isGlue = i === 0;
        const paths: PathSegment[] = [];

        // Bottom edge: CREASE (fold) for internal joints, CUT for glue flap outer edge
        const bottomTag = i === 0 ? 'CUT' : 'CREASE';
        // Top edge: CUT for last panel, CREASE for others
        const topTag = i === walls.length - 1 ? 'CUT' : 'CREASE';

        // Left edge (tube opening) → CUT
        paths.push(line(pt(x0, w.yStart), pt(x0, w.yEnd), 'CUT'));
        // Top edge
        paths.push(line(pt(x0, w.yEnd), pt(x1, w.yEnd), topTag));
        // Right edge (tube opening) → CUT
        paths.push(line(pt(x1, w.yEnd), pt(x1, w.yStart), 'CUT'));
        // Bottom edge
        paths.push(line(pt(x1, w.yStart), pt(x0, w.yStart), bottomTag));

        // Glue flap: taper left and right edges inward
        if (isGlue) {
            const taper = snap(G * 0.3);
            // Override with tapered shape
            paths.length = 0; // clear and redraw
            // Bottom edge (outer, shorter due to taper)
            paths.push(line(pt(x0 + taper, w.yStart), pt(x1 - taper, w.yStart), 'CUT'));
            // Right side (angled inward from bottom)
            paths.push(line(pt(x1 - taper, w.yStart), pt(x1, w.yEnd), 'CUT'));
            // Top edge (fold to front)
            paths.push(line(pt(x1, w.yEnd), pt(x0, w.yEnd), 'CREASE'));
            // Left side (angled inward from bottom)
            paths.push(line(pt(x0, w.yEnd), pt(x0 + taper, w.yStart), 'CUT'));
        }

        allPaths.push(...paths);

        // Pivot edge = horizontal edge connecting to parent panel
        // Bản lề: cạnh ngang nối với panel cha. Với mí dán (glue), nếp nhấn nằm
        // ở yEnd (cạnh giáp mặt trước), KHÔNG phải yStart (cạnh ngoài tự do).
        const pivotEdge: [Point2D, Point2D] = isGlue
            ? [pt(x0, w.yEnd), pt(x1, w.yEnd)]
            : [pt(x0, w.yStart), pt(x1, w.yStart)];
        panels.push({
            name: w.name,
            label: w.label,
            paths,
            outline: isGlue ? [
                pt(x0 + (snap(G * 0.3)), w.yStart), pt(x1 - (snap(G * 0.3)), w.yStart), pt(x1, w.yEnd), pt(x0, w.yEnd)
            ] : [
                pt(x0, w.yStart), pt(x1, w.yStart), pt(x1, w.yEnd), pt(x0, w.yEnd)
            ],
            parent: w.parent,
            pivotEdge: i === 1 ? null : pivotEdge, // front = root (no pivot)
            // Mí dán gập VÀO TRONG ống TRƯỚC, rồi hông (side2) mới cuốn vào dán
            // đè lên mí. Vì vậy mí gập SỚM (cùng lúc dựng vách đầu), trước khi
            // side2 đóng. net −90° để lật lên đúng mặt phẳng hông.
            foldAngle: 90,
            foldDirection: isGlue ? -1 : 1,
            ...(isGlue ? { foldPhase: [0.2, 0.4] as [number, number] } : {}),
        });
    }

    return { paths: allPaths, panels };
}
