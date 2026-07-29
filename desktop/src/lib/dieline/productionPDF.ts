import { DielineModel, PathSegment, PathTag, Point2D } from './types';
import { withBleedPaths } from './bleedContours';
import { NestingResult } from './nestingTypes';
import { validateClosedContours } from './contourValidator';
import { savePdfBlob } from './savePdfBlob';
import { toast } from 'sonner';
import { tv } from '../../i18n';
import { mapPointToPlacement } from './placementTransform';
import { splitTrayDieline } from './trayParts';
import { splitDoubleTrayDieline } from './DoubleTray';
import { PDFDocument } from 'pdf-lib';
import {
    addOptionalContentSource,
    createOptionalContentTransfer,
    finishOptionalContentTransfer,
} from '../pdfOptionalContent';
import type { NestingConfig } from './nestingTypes';

const PT_PER_MM = 72 / 25.4;
const round = (value: number): string => (Math.round(value * 10_000) / 10_000).toString();
const pt = (mm: number): string => round(mm * PT_PER_MM);

type Mapper = (point: Point2D) => Point2D;

const STYLE: Record<PathTag, { colorSpace: string; width: number; dash: number[] }> = {
    CUT: { colorSpace: 'CSCut', width: 0.1, dash: [] },
    CREASE: { colorSpace: 'CSCrease', width: 0.1, dash: [2, 1] },
    BLEED: { colorSpace: 'CSBleed', width: 0.08, dash: [1, 1] },
};

function segmentCommands(segment: PathSegment, map: Mapper): string {
    const style = STYLE[segment.tag];
    const dash = style.dash.length ? `[${style.dash.map(pt).join(' ')}] 0 d` : '[] 0 d';
    let path = '';
    if (segment.type === 'bezier' && segment.controlPoints) {
        const [p0, c1, c2, p3] = segment.controlPoints.map(map) as [Point2D, Point2D, Point2D, Point2D];
        path = `${pt(p0.x)} ${pt(p0.y)} m ${pt(c1.x)} ${pt(c1.y)} ${pt(c2.x)} ${pt(c2.y)} ${pt(p3.x)} ${pt(p3.y)} c`;
    } else {
        const points = segment.points.map(map);
        if (points.length < 2) return '';
        path = `${pt(points[0].x)} ${pt(points[0].y)} m `
            + points.slice(1).map((p) => `${pt(p.x)} ${pt(p.y)} l`).join(' ');
    }
    return `/${style.colorSpace} CS 1 SCN ${pt(style.width)} w ${dash} ${path} S`;
}

function makePdf(pageWidthMm: number, pageHeightMm: number, commands: string[]): Blob {
    const content = `q\n/GSOverprint gs\n1 J 1 j\n${commands.join('\n')}\nQ\n`;
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pt(pageWidthMm)} ${pt(pageHeightMm)}] /Resources << /ColorSpace << /CSCut 5 0 R /CSCrease 7 0 R /CSBleed 9 0 R >> /ExtGState << /GSOverprint 11 0 R >> >> /Contents 4 0 R >>`,
        `<< /Length ${content.length} >>\nstream\n${content}endstream`,
        '[ /Separation /CutContour /DeviceCMYK 6 0 R ]',
        '<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 1 0 0] /N 1 >>',
        '[ /Separation /Crease /DeviceCMYK 8 0 R ]',
        '<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [1 0 1 0] /N 1 >>',
        '[ /Separation /Bleed /DeviceCMYK 10 0 R ]',
        '<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [1 0 0 0] /N 1 >>',
        '<< /Type /ExtGState /OP true /op true /OPM 1 >>',
    ];
    let pdf = '%PDF-1.7\n';
    const offsets = [0];
    objects.forEach((object, index) => {
        offsets.push(pdf.length);
        pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets.slice(1)) pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return new Blob([new TextEncoder().encode(pdf)], { type: 'application/pdf' });
}

function assertProductionReady(model: DielineModel): void {
    const validation = validateClosedContours(model);
    if (!validation.allClosed) {
        const details = validation.openContours.map((item) => `${item.panelLabel || item.panelName}: ${item.gapMm.toFixed(3)}mm`).join(', ');
        throw new Error(`Không thể xuất PDF sản xuất vì biên cắt đang hở (${details}).`);
    }
}

export function buildProductionDielinePdf(model: DielineModel): Blob {
    assertProductionReady(model);
    const margin = 5;
    const renderModel = withBleedPaths(model);
    const bb = model.boundingBox;
    const map: Mapper = (p) => ({ x: p.x - bb.minX + margin, y: p.y - bb.minY + margin });
    return makePdf(bb.width + margin * 2, bb.height + margin * 2,
        renderModel.allPaths.map((segment) => segmentCommands(segment, map)).filter(Boolean));
}

function nestingMapper(model: DielineModel, pos: { x: number; y: number; rotation: number }, pageHeight: number): Mapper {
    const bb = model.boundingBox;
    return (point) => {
        const placed = mapPointToPlacement(point, pos, bb);
        return { x: placed.x, y: pageHeight - placed.y };
    };
}

function placementCommands(model: DielineModel, result: NestingResult): string[] {
    const renderModel = withBleedPaths(model);
    const commands: string[] = [];
    for (const position of result.positions) {
        const map = nestingMapper(model, position, result.actualSheet.height);
        for (const segment of renderModel.allPaths) commands.push(segmentCommands(segment, map));
    }
    return commands.filter(Boolean);
}

export function buildProductionNestingPdf(model: DielineModel, result: NestingResult): Blob {
    assertProductionReady(model);
    return makePdf(result.actualSheet.width, result.actualSheet.height, placementCommands(model, result));
}

export async function downloadProductionDielinePDF(model: DielineModel, filename?: string): Promise<void> {
    try {
        const blob = buildProductionDielinePdf(model);
        const name = filename || `${model.standardCode}_${model.params.L}x${model.params.W}x${model.params.D}_production.pdf`;
        if ((await savePdfBlob(blob, name)).kind === 'saved') toast.success(tv('Đã xuất PDF sản xuất'));
    } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
    }
}

export async function downloadProductionNestingPDF(model: DielineModel, result: NestingResult, filename?: string): Promise<void> {
    try {
        const blob = buildProductionNestingPdf(model, result);
        const name = filename || `nesting_${model.standardCode}_${result.countPerSheet}up_production.pdf`;
        if ((await savePdfBlob(blob, name)).kind === 'saved') toast.success(tv('Đã xuất PDF sản xuất'));
    } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
    }
}
export async function buildProductionTrayNestingPdf(
    model: DielineModel,
    trayResult: NestingResult,
    sleeveResult: NestingResult,
    config: Pick<NestingConfig, 'trayNestingMode'>,
): Promise<Blob> {
    // [DOUBLE-TRAY 2026-07-26] đáy+nắp dùng chung hạ tầng khay+vỏ
    const parts = model.params.boxType === 'double_tray'
        ? splitDoubleTrayDieline(model)
        : splitTrayDieline(model);
    if (!parts) throw new Error('Không tìm thấy đủ khuôn khay và vỏ.');
    assertProductionReady(parts.tray);
    assertProductionReady(parts.sleeve);

    if (config.trayNestingMode === 'combined') {
        const sheet = trayResult.actualSheet;
        if (sheet.width !== sleeveResult.actualSheet.width || sheet.height !== sleeveResult.actualSheet.height) {
            throw new Error('Khay và vỏ chung tờ nhưng kích thước tờ không khớp.');
        }
        return makePdf(sheet.width, sheet.height, [
            ...placementCommands(parts.tray, trayResult),
            ...placementCommands(parts.sleeve, sleeveResult),
        ]);
    }

    const trayPdf = makePdf(
        trayResult.actualSheet.width,
        trayResult.actualSheet.height,
        placementCommands(parts.tray, trayResult),
    );
    const sleevePdf = makePdf(
        sleeveResult.actualSheet.width,
        sleeveResult.actualSheet.height,
        placementCommands(parts.sleeve, sleeveResult),
    );
    const merged = await PDFDocument.create();
    // [OCG FIX 2026-07-28] Giữ optional content khi ghép, để lớp khuôn bế không bị mất
    // nếu về sau makePdf sinh ra layer.
    const ocTransfer = createOptionalContentTransfer();
    for (const blob of [trayPdf, sleevePdf]) {
        const source = await PDFDocument.load(await blob.arrayBuffer());
        addOptionalContentSource(ocTransfer, source);
        const pages = await merged.copyPages(source, source.getPageIndices());
        pages.forEach((page) => merged.addPage(page));
    }
    finishOptionalContentTransfer(ocTransfer, merged);
    return new Blob([new Uint8Array(await merged.save())], { type: 'application/pdf' });
}

export async function downloadProductionTrayNestingPDF(
    model: DielineModel,
    trayResult: NestingResult,
    sleeveResult: NestingResult,
    config: Pick<NestingConfig, 'trayNestingMode'>,
): Promise<void> {
    try {
        const blob = await buildProductionTrayNestingPdf(model, trayResult, sleeveResult, config);
        const pages = config.trayNestingMode === 'split' ? '_2pages' : '';
        const name = `nesting_${model.standardCode}_tray_sleeve${pages}_production.pdf`;
        if ((await savePdfBlob(blob, name)).kind === 'saved') toast.success(tv('Đã xuất PDF sản xuất'));
    } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
    }
}
