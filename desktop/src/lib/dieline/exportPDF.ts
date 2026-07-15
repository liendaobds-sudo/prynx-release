// ============================================================
// Export PDF Vector — Sử dụng svg2pdf.js để chuyển SVG → PDF
//
// Chiến lược (tham khảo bocly 2.html):
//   1. Build SVG string từ DielineModel (M/L/C commands)
//   2. Gộp segment nối tiếp → 1 path liên tục (M L L C L...)
//   3. Dùng svg2pdf.js render vào jsPDF → TRUE vector curves
//
// CUT = đen nét liền, CREASE = đỏ nét đứt
// ============================================================

import { DielineModel } from './types';
import { jsPDF } from 'jspdf';
import 'svg2pdf.js';
import { toast } from 'sonner';
import { buildChains, chainToSvgD, computeEnvelopeDims } from './sharedGeometry';
import {
    validateClosedContours,
    OpenContourWarning,
    ContourValidationResult,
} from './contourValidator';
import { saveJsPdfDoc } from './saveJsPdfDoc';
import { tv } from '../../i18n';

/**
 * Kết quả quyết định của cổng xuất (Export_Gate) — Requirement 3.2, 3.6.
 *
 *   - `created`   : mọi biên ngoài (Outer_Silhouette) khép kín HOẶC người
 *                   dùng đã xác nhận tường minh ⇒ tiến hành ghi file.
 *   - `cancelled` : tồn tại Open_Outer_Boundary chưa được xác nhận ⇒ KHÔNG
 *                   ghi bất kỳ đầu ra nào; kèm danh sách cảnh báo quan sát được.
 */
export type ExportGateDecision =
    | { kind: 'created' }
    | { kind: 'cancelled'; warnings: OpenContourWarning[] };

/**
 * Hàm THUẦN quyết định cổng xuất — điểm quan sát được cho test cổng mà
 * không phá vỡ chữ ký công khai `Promise<void>` của `downloadPDF`.
 *
 * Quy tắc (Requirement 3.1, 3.2, 3.5, 3.6):
 *   - `result.allClosed === true` ⇒ `created` (tạo file không hỏi).
 *   - có biên ngoài hở:
 *       • `confirmed === true`  ⇒ `created` (người dùng xác nhận ghi).
 *       • `confirmed === false` ⇒ `cancelled` kèm danh sách cảnh báo
 *         (không callback / callback trả `false`).
 *
 * Hàm chỉ đọc `result`, không biến đổi đầu vào.
 */
export function decideExportGate(
    result: ContourValidationResult,
    confirmed: boolean,
): ExportGateDecision {
    if (result.allClosed || confirmed) {
        return { kind: 'created' };
    }
    return { kind: 'cancelled', warnings: result.openContours };
}

/** Style cho từng tag */
const TAG_STYLES: Record<string, { stroke: string; width: number; dashArray?: string }> = {
    CUT: { stroke: '#000000', width: 0.3 },
    CREASE: { stroke: '#ff0000', width: 0.2, dashArray: '2,1' },
    BLEED: { stroke: '#0000ff', width: 0.15, dashArray: '1,1' },
};

/**
 * Build complete SVG string từ DielineModel.
 * Segments nối tiếp → gộp thành 1 path liên tục.
 * Includes dimension annotations (double-headed arrow lines).
 */
function buildSvgString(model: DielineModel): string {
    const { boundingBox } = model;
    const margin = 10;

    // Thêm margin cho dimension annotations (phải + trên)
    const dimExtra = 35;
    const svgW = boundingBox.width + margin * 2 + dimExtra;
    const svgH = boundingBox.height + margin * 2 + dimExtra;

    const offsetX = margin - boundingBox.minX;
    const offsetY = margin - boundingBox.minY + dimExtra;

    // Gộp segments → chains liên tục
    const chains = buildChains(model.allPaths);

    // Build SVG path elements
    let pathElements = '';
    for (const chain of chains) {
        const style = TAG_STYLES[chain.tag] || TAG_STYLES.CUT;
        const dashAttr = style.dashArray ? ` stroke-dasharray="${style.dashArray}"` : '';
        const d = chainToSvgD(chain.segs);
        pathElements += `    <path d="${d}" fill="none" stroke="${style.stroke}" stroke-width="${style.width}"${dashAttr}/>\n`;
    }

    // Build dimension annotations
    const dimSvg = buildDimensionSvg(model);

    return `<svg xmlns="http://www.w3.org/2000/svg"
     width="${svgW}mm" height="${svgH}mm"
     viewBox="0 0 ${svgW} ${svgH}">
  <g transform="translate(${offsetX}, ${svgH - offsetY}) scale(1, -1)">
${pathElements}
    <!-- Dimension annotations -->
${dimSvg}
  </g>
</svg>`;
}

// ── Dimension annotation helpers ──

/** Tạo 1 đường đo kích thước với mũi tên 2 đầu */
function dimLine(
    x1: number, y1: number, x2: number, y2: number,
    label: string, side: 'top' | 'bottom' | 'left' | 'right',
    color = '#f97316', small = false,
): string {
    const arrowSize = 3;
    const fontSize = small ? 5 : 6;
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;

    let svg = '';

    // Main line
    svg += `    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="0.3"/>\n`;

    // End ticks
    if (side === 'top' || side === 'bottom') {
        svg += `    <line x1="${x1}" y1="${y1 - arrowSize}" x2="${x1}" y2="${y1 + arrowSize}" stroke="${color}" stroke-width="0.3"/>\n`;
        svg += `    <line x1="${x2}" y1="${y2 - arrowSize}" x2="${x2}" y2="${y2 + arrowSize}" stroke="${color}" stroke-width="0.3"/>\n`;
    } else {
        svg += `    <line x1="${x1 - arrowSize}" y1="${y1}" x2="${x1 + arrowSize}" y2="${y1}" stroke="${color}" stroke-width="0.3"/>\n`;
        svg += `    <line x1="${x2 - arrowSize}" y1="${y2}" x2="${x2 + arrowSize}" y2="${y2}" stroke="${color}" stroke-width="0.3"/>\n`;
    }

    // Label (flipped Y for readability)
    const bgW = label.length * fontSize * 0.65;
    const bgH = fontSize * 1.4;
    svg += `    <rect x="${mx - bgW / 2}" y="${my - bgH / 2}" width="${bgW}" height="${bgH}" rx="1" fill="white" fill-opacity="0.9" transform="translate(${mx},${my}) scale(1,-1) translate(${-mx},${-my})"/>\n`;
    svg += `    <text x="${mx}" y="${my}" text-anchor="middle" dominant-baseline="central" fill="${color}" font-size="${fontSize}" font-family="Arial, sans-serif" font-weight="600" transform="translate(${mx},${my}) scale(1,-1) translate(${-mx},${-my})">${label}</text>\n`;

    return svg;
}

/** Tạo SVG markup cho tất cả dimension annotations */
function buildDimensionSvg(model: DielineModel): string {
    const { params } = model;
    const { L, W, D, G, TH, boxType, panelOrder } = params;
    const bb = model.boundingBox;
    const offset = 8;

    if (boxType === 'cup_sleeve') return '';

    // ── ENVELOPE ──
    if (boxType === 'envelope') {
        const { envW, envH, envStyle } = params;
        const { FH, SF } = computeEnvelopeDims(params);
        const rightX = bb.maxX + offset * 3;
        const topY = bb.maxY + offset * 3;
        let svg = '';
        if (envStyle !== 'pocket') {
            const backShort = 5;
            svg += dimLine(0, topY, envW, topY, `W=${envW}`, 'top');
            svg += dimLine(rightX, backShort, rightX, envH, `${envH - backShort}`, 'right', '#999', true);
            svg += dimLine(rightX + offset * 3, envH, rightX + offset * 3, envH + envH, `H=${envH}`, 'right');
            svg += dimLine(rightX, envH + envH, rightX, envH + envH + FH, `FH=${FH}`, 'right', '#66ccff', true);
            svg += dimLine(-SF, topY + offset, 0, topY + offset, `SF=${SF}`, 'top', '#66ccff', true);
        } else {
            const pW = envH, pH = envW;
            svg += dimLine(0, topY, pW, topY, `${envH}`, 'top', '#999', true);
            svg += dimLine(pW, topY + offset, pW + pW, topY + offset, `H=${envH}`, 'top');
            svg += dimLine(rightX, 0, rightX, pH, `W=${envW}`, 'right');
            svg += dimLine(rightX, pH, rightX, pH + FH, `FH=${FH}`, 'right', '#66ccff', true);
            svg += dimLine(pW + pW, topY + offset, pW + pW + SF, topY + offset, `SF=${SF}`, 'top', '#66ccff', true);
        }
        return svg;
    }

    // ── PIZZA BOX ──
    if (boxType === 'pizza') {
        const rightX = bb.maxX + offset * 3;
        let svg = '';
        svg += dimLine(rightX, -D, rightX, 0, `D=${D}`, 'right');
        svg += dimLine(rightX + offset * 3, 0, rightX + offset * 3, W, `W=${W}`, 'right');
        svg += dimLine(rightX, W, rightX, W + D, `D=${D}`, 'right');
        svg += dimLine(rightX + offset * 3, W + D, rightX + offset * 3, W + D + W, `W=${W}`, 'right');
        svg += dimLine(0, bb.maxY + offset * 3, L, bb.maxY + offset * 3, `L=${L}`, 'top');
        svg += dimLine(-D, bb.maxY + offset * 6, 0, bb.maxY + offset * 6, `D=${D}`, 'top', '#66ccff', true);
        svg += dimLine(L, bb.maxY + offset * 6, L + D, bb.maxY + offset * 6, `D=${D}`, 'top', '#66ccff', true);
        return svg;
    }

    // ── TRAY (Matchbox) ──
    if (boxType === 'tray') {
        const tG = G;
        const T = params.T;
        const clearance = 1;
        let svg = '';

        // Tray bounding box
        const trayPanels = model.panels.filter(p => !p.name.startsWith('sleeve_'));
        let tMinX = Infinity, tMinY = Infinity, tMaxX = -Infinity, tMaxY = -Infinity;
        for (const panel of trayPanels) {
            for (const path of panel.paths) {
                for (const p of path.points) {
                    if (p.x < tMinX) tMinX = p.x;
                    if (p.y < tMinY) tMinY = p.y;
                    if (p.x > tMaxX) tMaxX = p.x;
                    if (p.y > tMaxY) tMaxY = p.y;
                }
            }
        }

        const trayTopY = tMaxY + offset * 3;
        const trayRightX = tMaxX + offset * 3;

        svg += dimLine(0, trayTopY, L, trayTopY, `L=${L}`, 'top');
        svg += dimLine(trayRightX, 0, trayRightX, W, `W=${W}`, 'right');
        svg += dimLine(trayRightX + offset * 3, W, trayRightX + offset * 3, W + D, `D=${D}`, 'right', '#66ccff', true);
        svg += dimLine(trayRightX, W + D, trayRightX, W + D + tG, `G=${tG}`, 'right', '#88ee88', true);
        svg += dimLine(trayRightX, W + D + tG + (D - 2 * T), trayRightX, W + D + tG + (D - 2 * T) + TH, `TH=${TH}`, 'right', '#88ee88', true);

        return svg;
    }

    // ── RTE / SLB / Gable / Paper Bag ──
    const pw = panelOrder === 'LWLW' ? [L, W, L, W] : [W, L, W, L];
    const pl = panelOrder === 'LWLW'
        ? [`L=${L}`, `W=${W}`, `L=${L}`, `W=${W}`]
        : [`W=${W}`, `L=${L}`, `W=${W}`, `L=${L}`];

    const glueIsLeft = params.glueSide === 'left';
    const topY = bb.maxY + offset * 3;
    const glueOffset = glueIsLeft ? G : 0;
    const x_p1 = glueOffset;
    const x_p2 = glueOffset + pw[0];
    const x_p3 = glueOffset + pw[0] + pw[1];
    const x_p4 = glueOffset + pw[0] + pw[1] + pw[2];
    const x_p5 = glueOffset + pw[0] + pw[1] + pw[2] + pw[3];
    const x_gL = glueIsLeft ? 0 : x_p5;
    const x_gR = glueIsLeft ? G : x_p5 + G;

    const isPaperBag = boxType === 'paper_bag';
    const bottomOffset = isPaperBag ? (params.BF > 0 ? params.BF : Math.round(W * 0.85)) : 0;

    let svg = '';
    svg += dimLine(x_gL, topY, x_gR, topY, `G=${G}`, 'top');
    svg += dimLine(x_p1, topY + offset, x_p2, topY + offset, pl[0], 'top');
    svg += dimLine(x_p2, topY, x_p3, topY, pl[1], 'top');
    svg += dimLine(x_p3, topY + offset, x_p4, topY + offset, pl[2], 'top');
    svg += dimLine(x_p4, topY, x_p5, topY, pl[3], 'top');
    svg += dimLine(bb.maxX + offset * 3, bottomOffset, bb.maxX + offset * 3, bottomOffset + D, `D=${D}`, 'right');

    return svg;
}

/**
 * Tạo và download file PDF vector từ DielineModel.
 *
 * Segments nối tiếp → gộp thành 1 path SVG liên tục (M L C L...)
 * → svg2pdf.js render vào PDF → true vector curves, liền mạch.
 *
 * CỔNG KIỂM TRA BIÊN DẠNG (Requirement 3):
 *   1. Chạy `validateClosedContours(model)` trước khi ghi file.
 *   2. Nếu mọi Cut_Piece khép kín (`allClosed === true`) → tạo file
 *      ngay, không hỏi (Requirement 3.1, 3.2).
 *   3. Nếu có biên hở → hiển thị cảnh báo liệt kê panel + `gapMm`
 *      (Requirement 3.3) và chỉ ghi file khi `confirmOpenContours`
 *      trả về `true` (Requirement 3.5). Không có callback / callback
 *      trả `false` → cổng kết thúc `cancelled`, KHÔNG ghi file và model
 *      không đổi (Requirement 3.6).
 *
 *   Quyết định cổng được tập trung trong hàm thuần `decideExportGate`
 *   để quan sát được mà không đổi chữ ký công khai của `downloadPDF`.
 *
 * @param confirmOpenContours Callback xác nhận khi phát hiện biên hở;
 *   nhận danh sách cảnh báo, trả `true` để tiếp tục ghi file.
 */
export async function downloadPDF(
    model: DielineModel,
    filename?: string,
    confirmOpenContours?: (warnings: OpenContourWarning[]) => Promise<boolean>,
): Promise<void> {
    // ── Cổng kiểm tra biên dạng khép kín trước khi xuất ──
    // Quyết định cổng được tập trung vào hàm thuần `decideExportGate` để
    // vừa quan sát được (created / cancelled) vừa giữ chữ ký `Promise<void>`.
    const validation = validateClosedContours(model);

    let confirmed = false;
    if (!validation.allClosed) {
        const warnings = validation.openContours;

        // Cảnh báo cho người dùng trước khi tạo file (Requirement 3.3).
        const detail = warnings
            .map((w) => `• ${w.panelLabel || w.panelName}: hở ${w.gapMm.toFixed(3)}mm`)
            .join('\n');
        toast.warning(
            `Phát hiện ${warnings.length} biên dạng cắt hở:\n${detail}`,
        );

        // Chỉ xác nhận khi có callback và callback trả về `true` (Requirement 3.5).
        // Không có callback → coi như chưa xác nhận (Requirement 3.6).
        if (confirmOpenContours) {
            confirmed = await confirmOpenContours(warnings);
        }
    }

    // Không ghi bất kỳ đầu ra nào khi cổng kết thúc ở trạng thái `cancelled`
    // (Requirement 3.6) — model không bị biến đổi vì luồng ghi chưa chạy.
    const decision = decideExportGate(validation, confirmed);
    if (decision.kind === 'cancelled') {
        return;
    }

    const toastId = toast.loading(tv('Đang tạo PDF...'));

    try {
        const { boundingBox } = model;
        const margin = 10;
        const dimExtra = 35; // extra space for dimension annotations
        const pageW = boundingBox.width + margin * 2 + dimExtra;
        const pageH = boundingBox.height + margin * 2 + dimExtra;

        // BUG-12: Warn on very large dielines that may slow down the browser
        if (pageW > 2000 || pageH > 2000) {
            console.warn(`[exportPDF] Khổ trải lớn: ${Math.round(pageW)}×${Math.round(pageH)}mm — có thể mất thời gian`);
        }

        const doc = new jsPDF({
            orientation: pageW > pageH ? 'landscape' : 'portrait',
            unit: 'mm',
            format: [pageW, pageH],
        });

        const svgString = buildSvgString(model);
        const parser = new DOMParser();
        const svgDoc = parser.parseFromString(svgString, 'image/svg+xml');
        const svgElement = svgDoc.documentElement;

        await (doc as any).svg(svgElement, {
            x: 0,
            y: 0,
            width: pageW,
            height: pageH,
        });

        doc.setProperties({
            title: `${model.name} - ${model.params.L}x${model.params.W}x${model.params.D}`,
            subject: `Khuôn bế ${model.standardCode}`,
            creator: 'Dieline Generator',
        });

        const name = filename || `${model.standardCode}_${model.params.L}x${model.params.W}x${model.params.D}.pdf`;
        const result = await saveJsPdfDoc(doc, name);
        if (result.kind === 'cancelled') {
            toast.dismiss(toastId);
            return;
        }
        toast.success(tv('Đã xuất file PDF'), { id: toastId });
    } catch (err) {
        console.error('PDF Export Error:', err);
        toast.error('Lỗi khi tạo PDF: ' + (err instanceof Error ? err.message : 'Unknown error'), { id: toastId });
    }
}
