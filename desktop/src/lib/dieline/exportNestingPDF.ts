// ============================================================
// Export Nesting PDF — Xuất bản vẽ xếp khuôn vào khổ in
//
// Chiến lược:
//   1. Build SVG string chứa tờ giấy + lề + tất cả khuôn bế
//   2. Dùng svg2pdf.js render vào jsPDF → TRUE vector curves
//   3. Metadata: kích thước tờ, số khuôn, chiến lược, thông số hộp
// ============================================================

import { DielineModel, PathSegment, Point2D, PathTag } from './types';
import { NestingResult, NestingConfig } from './nestingTypes';
import { jsPDF } from 'jspdf';
import 'svg2pdf.js';
import { toast } from 'sonner';

/** Tolerance cho so sánh điểm (0.01mm) */
function ptEq(a: Point2D, b: Point2D): boolean {
    return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
}

/** Lấy điểm đầu/cuối của segment */
function segEndpoints(seg: PathSegment): [Point2D, Point2D] {
    if (seg.type === 'bezier' && seg.controlPoints) {
        return [seg.controlPoints[0], seg.controlPoints[3]];
    }
    return [seg.points[0], seg.points[seg.points.length - 1]];
}

/** Chuyển 1 segment thành SVG commands (continuation, không có M) */
function segmentContinuation(seg: PathSegment): string {
    if (seg.type === 'bezier' && seg.controlPoints) {
        const [, cp1, cp2, p3] = seg.controlPoints;
        return `C ${cp1.x},${cp1.y} ${cp2.x},${cp2.y} ${p3.x},${p3.y}`;
    }
    return seg.points.slice(1)
        .map(p => `L ${p.x},${p.y}`)
        .join(' ');
}

/** Style cho từng tag */
const TAG_STYLES: Record<string, { stroke: string; width: number; dashArray?: string }> = {
    CUT: { stroke: '#000000', width: 0.25 },
    CREASE: { stroke: '#ff0000', width: 0.15, dashArray: '2,1' },
    BLEED: { stroke: '#0000ff', width: 0.1, dashArray: '1,1' },
};

/** Gom segments nối tiếp → chains liên tục */
function buildChains(segments: PathSegment[]): { tag: PathTag; segs: PathSegment[] }[] {
    const chains: { tag: PathTag; segs: PathSegment[] }[] = [];
    let current: PathSegment[] = [];

    for (const seg of segments) {
        const [segStart] = segEndpoints(seg);
        if (current.length === 0) {
            current.push(seg);
        } else {
            const last = current[current.length - 1];
            const [, lastEnd] = segEndpoints(last);
            if (seg.tag === last.tag && ptEq(lastEnd, segStart)) {
                current.push(seg);
            } else {
                chains.push({ tag: current[0].tag, segs: current });
                current = [seg];
            }
        }
    }
    if (current.length > 0) {
        chains.push({ tag: current[0].tag, segs: current });
    }
    return chains;
}

/** Chuyển 1 chain thành SVG `d` attribute */
function chainToSvgD(chain: PathSegment[]): string {
    if (chain.length === 0) return '';
    const [start] = segEndpoints(chain[0]);
    let d = `M ${start.x},${start.y} ` + segmentContinuation(chain[0]);
    for (let i = 1; i < chain.length; i++) {
        d += ' ' + segmentContinuation(chain[i]);
    }
    const [chainStart] = segEndpoints(chain[0]);
    const [, chainEnd] = segEndpoints(chain[chain.length - 1]);
    if (ptEq(chainStart, chainEnd) && chain.length > 1) {
        d += ' Z';
    }
    return d;
}

/** Tính SVG transform cho 1 vị trí khuôn */
function dielineTransformAttr(
    pos: { x: number; y: number; rotation: number },
    bb: { minX: number; minY: number; width: number; height: number },
): string {
    const { x, y, rotation } = pos;
    switch (rotation) {
        case 180:
            return `translate(${x + bb.width - bb.minX}, ${y + bb.height - bb.minY}) rotate(180)`;
        case 90:
            return `translate(${x - bb.minY}, ${y + bb.width - bb.minX}) rotate(-90)`;
        case 270:
            return `translate(${x + bb.height - bb.minY}, ${y - bb.minX}) rotate(90)`;
        case 0:
        default:
            return `translate(${x - bb.minX}, ${y - bb.minY})`;
    }
}

/**
 * Build SVG string cho nesting layout.
 * Includes: tờ giấy, lề, gripper, vùng in, và tất cả khuôn.
 */
function buildNestingSvg(
    model: DielineModel,
    result: NestingResult,
    config: NestingConfig,
): string {
    const { actualSheet, positions } = result;
    const bb = model.boundingBox;
    const effectiveBottom = Math.max(config.margin.bottom, config.gripperMargin);

    // Build dieline path elements (dùng lại cho mỗi vị trí)
    const chains = buildChains(model.allPaths);
    let pathDefs = '';
    chains.forEach((chain, ci) => {
        const style = TAG_STYLES[chain.tag] || TAG_STYLES.CUT;
        const dashAttr = style.dashArray ? ` stroke-dasharray="${style.dashArray}"` : '';
        const d = chainToSvgD(chain.segs);
        pathDefs += `      <path id="chain${ci}" d="${d}" fill="none" stroke="${style.stroke}" stroke-width="${style.width}"${dashAttr}/>\n`;
    });

    // Template group
    const templateDef = `    <g id="dieline-template">\n${pathDefs}    </g>`;

    // Placed dielines
    let placedElements = '';
    positions.forEach((pos, idx) => {
        const gTransform = dielineTransformAttr(pos, bb);
        // Bbox outline nhạt
        const isRotated = pos.rotation === 180 || pos.rotation === 270;
        const bboxStroke = isRotated ? '#5090ff' : '#f98c32';
        placedElements += `    <g transform="${gTransform}" opacity="0.9">
      <rect x="${bb.minX}" y="${bb.minY}" width="${bb.width}" height="${bb.height}" fill="none" stroke="${bboxStroke}" stroke-width="0.15" stroke-dasharray="1,1"/>
      <use href="#dieline-template"/>
      <text x="${bb.minX + bb.width / 2}" y="${bb.minY + bb.height / 2}" text-anchor="middle" font-size="5" fill="#999" opacity="0.4">${idx + 1}</text>
    </g>\n`;
    });

    // Sheet annotation elements
    const infoText = `${result.countPerSheet} khuôn / tờ — ${result.label} — ${result.utilization}%`;

    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="${actualSheet.width}mm" height="${actualSheet.height}mm"
     viewBox="0 0 ${actualSheet.width} ${actualSheet.height}">
  <defs>
${templateDef}
  </defs>

  <!-- Tờ giấy -->
  <rect x="0" y="0" width="${actualSheet.width}" height="${actualSheet.height}" fill="white" stroke="#ccc" stroke-width="0.5"/>

  <!-- Vùng cắn nhíp — phía DƯỚI -->
  <rect x="0" y="${actualSheet.height - config.gripperMargin}" width="${actualSheet.width}" height="${config.gripperMargin}" fill="#fff0f0" stroke="#ffaaaa" stroke-width="0.3"/>
  <text x="${actualSheet.width / 2}" y="${actualSheet.height - config.gripperMargin / 2 + 2}" text-anchor="middle" font-size="4" fill="#ff6666">Cắn nhíp (${config.gripperMargin}mm)</text>

  <!-- Vùng in hợp lệ -->
  <rect x="${config.margin.left}" y="${config.margin.top}"
        width="${actualSheet.width - config.margin.left - config.margin.right}"
        height="${actualSheet.height - config.margin.top - effectiveBottom}"
        fill="none" stroke="#88bbff" stroke-width="0.3" stroke-dasharray="3,2"/>

  <!-- Các khuôn bế -->
${placedElements}
  <!-- Info bottom -->
  <text x="${actualSheet.width / 2}" y="${actualSheet.height - 3}" text-anchor="middle" font-size="4" fill="#666">${infoText}</text>

  <!-- ĐẶC TẢ KHUÔN — Góc phải trên -->
  ${buildSpecBlock(model, result, config)}
</svg>`;
}

/** Tạo text block hiển thị thông số khuôn */
function buildSpecBlock(model: DielineModel, result: NestingResult, config: NestingConfig): string {
    const { params, name, standardCode } = model;
    const { actualSheet } = result;
    const x = actualSheet.width - 8; // right-align
    const blockW = 80;
    const blockX = x - blockW;
    const startY = 6;
    const lineH = 5;

    // Build info lines
    const lines: string[] = [];
    lines.push(`${name} — ${standardCode}`);
    lines.push(`L×W×D: ${params.L} × ${params.W} × ${params.D} mm`);
    if (params.T) lines.push(`Dày giấy (T): ${params.T} mm`);
    if (params.boxType === 'tray') {
        if (params.G) lines.push(`Dầm (G): ${params.G} mm`);
        if (params.sleeveGlue) lines.push(`Mí dán vỏ: ${params.sleeveGlue} mm`);
    }
    if (params.TH) lines.push(`Mí gập (TH): ${params.TH} mm`);
    lines.push('');
    lines.push(`Tờ: ${actualSheet.width}×${actualSheet.height} mm`);
    lines.push(`Khuôn/tờ: ${result.countPerSheet} (${result.cols}×${result.rows})`);
    lines.push(`Sử dụng: ${result.utilization}%`);
    lines.push(`Hở dao bế: ${config.gutter || config.dieGap} mm`);

    const blockH = lines.length * lineH + 6;

    let svg = `<rect x="${blockX}" y="${startY - 4}" width="${blockW}" height="${blockH}" rx="1.5" fill="white" fill-opacity="0.95" stroke="#ccc" stroke-width="0.3"/>\n`;

    lines.forEach((line, i) => {
        if (line === '') return; // skip empty separator
        const ty = startY + i * lineH + 2;
        const isBold = i === 0;
        svg += `  <text x="${x - 2}" y="${ty}" text-anchor="end" font-size="${isBold ? '4.5' : '3.5'}" font-weight="${isBold ? 'bold' : 'normal'}" fill="#333">${escXml(line)}</text>\n`;
    });

    return svg;
}

/** Escape XML special characters */
function escXml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * MISS-3: Xuất PDF nesting layout.
 * Tạo file PDF chứa toàn bộ bản xếp khuôn trên tờ giấy.
 */
export async function downloadNestingPDF(
    model: DielineModel,
    result: NestingResult,
    config: NestingConfig,
    filename?: string,
): Promise<void> {
    const toastId = toast.loading('Đang tạo PDF xếp khuôn...');

    try {
        const { actualSheet } = result;
        const pageW = actualSheet.width;
        const pageH = actualSheet.height;

        const doc = new jsPDF({
            orientation: pageW > pageH ? 'landscape' : 'portrait',
            unit: 'mm',
            format: [pageW, pageH],
        });

        const svgString = buildNestingSvg(model, result, config);
        const parser = new DOMParser();
        const svgDoc = parser.parseFromString(svgString, 'image/svg+xml');
        const svgElement = svgDoc.documentElement;

        await (doc as any).svg(svgElement, {
            x: 0,
            y: 0,
            width: pageW,
            height: pageH,
        });

        const { params } = model;
        doc.setProperties({
            title: `Nesting ${model.name} - ${params.L}x${params.W}x${params.D} - ${result.countPerSheet} khuôn/tờ`,
            subject: `Bình bản ${result.label} — ${result.utilization}%`,
            creator: 'PrintSolutions Dieline Generator',
        });

        const name = filename || `nesting_${model.standardCode}_${params.L}x${params.W}x${params.D}_${result.countPerSheet}up.pdf`;
        doc.save(name);
        toast.dismiss(toastId);
        toast.success(`Đã xuất PDF xếp khuôn (${result.countPerSheet} khuôn/tờ)`);
    } catch (err) {
        console.error('Nesting PDF Export Error:', err);
        toast.dismiss(toastId);
        toast.error('Lỗi khi tạo PDF: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
}
