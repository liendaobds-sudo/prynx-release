import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { buildProductionDielinePdf, buildProductionNestingPdf, buildProductionTrayNestingPdf } from './productionPDF';
import { DEFAULT_PARAMS, DielineModel, PathSegment } from './types';
import { DEFAULT_NESTING_CONFIG, NestingResult } from './nestingTypes';

import { runDielineEngine } from './engine';
import { splitTrayDieline } from './trayParts';
import { withBleedPaths } from './bleedContours';
import { PDFDocument } from 'pdf-lib';

function model(): DielineModel {
    const points = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }];
    const cut: PathSegment[] = points.map((point, index) => ({
        type: 'line', tag: 'CUT', points: [point, points[(index + 1) % points.length]],
    }));
    const crease: PathSegment = { type: 'line', tag: 'CREASE', points: [{ x: 50, y: 0 }, { x: 50, y: 50 }] };
    return {
        name: 'Test', standardCode: 'TEST', description: '', params: { ...DEFAULT_PARAMS },
        panels: [{ name: 'body', label: 'Body', paths: cut, parent: null, pivotEdge: null, foldAngle: 0, foldDirection: 1 }],
        allPaths: [...cut, crease],
        boundingBox: { minX: 0, minY: 0, maxX: 100, maxY: 50, width: 100, height: 50 },
    };
}

describe('production PDF', () => {
    it('uses named spot separations and overprint without proof annotations', async () => {
        const text = await buildProductionDielinePdf(model()).text();
        expect(text).toContain('/Separation /CutContour');
        expect(text).toContain('/Separation /Crease');
        expect(text).toContain('/CSBleed CS');
        expect(text).toContain('/OP true /op true /OPM 1');
        expect(text).not.toContain(' BT');
        expect(text).not.toContain('/DeviceRGB');
    });

    it('writes all nesting placements on the real sheet MediaBox', async () => {
        const result: NestingResult = {
            positions: [{ x: 10, y: 10, rotation: 0 }, { x: 120, y: 10, rotation: 180 }],
            countPerSheet: 2, rows: 1, cols: 2, utilization: 20,
            usableArea: { width: 400, height: 280 }, actualSheet: { width: 420, height: 297 },
            cellSize: { width: 103, height: 53 }, label: 'test', superTile: null,
        };
        const text = await buildProductionNestingPdf(model(), result).text();
        expect(text).toContain('/MediaBox [0 0 1190.5512 841.8898]');
        expect((text.match(/\/CSCut CS/g) || []).length).toBe(8);
        expect(DEFAULT_NESTING_CONFIG.dieGap).toBeGreaterThan(0);
    });
describe('tray/sleeve production PDF', () => {
    function trayResponse(mode: 'combined' | 'split') {
        const config = {
            ...structuredClone(DEFAULT_NESTING_CONFIG),
            sheet: { width: 900, height: 650 },
            sleeveSheet: { width: 700, height: 500 },
            margin: { top: 10, right: 10, bottom: 10, left: 10 },
            trayNestingMode: mode,
        };
        return {
            config,
            response: runDielineEngine({
                params: { ...DEFAULT_PARAMS, boxType: 'tray', L: 120, W: 85, D: 25 },
                nestingConfig: config,
            }),
        };
    }

    it('writes tray and sleeve exactly at their own positions on a combined sheet', async () => {
        const { config, response } = trayResponse('combined');
        const blob = await buildProductionTrayNestingPdf(
            response.dieline, response.nestingResult!, response.sleeveNestingResult!, config,
        );
        const pdf = await PDFDocument.load(await blob.arrayBuffer());
        expect(pdf.getPageCount()).toBe(1);
        const text = await blob.text();
        const parts = splitTrayDieline(response.dieline)!;
        const expectedCommands = withBleedPaths(parts.tray).allPaths.length * response.nestingResult!.positions.length
            + withBleedPaths(parts.sleeve).allPaths.length * response.sleeveNestingResult!.positions.length;
        expect((text.match(/\/CS(?:Cut|Crease|Bleed) CS/g) || []).length).toBe(expectedCommands);
    });

    it('writes independent tray and sleeve sheets as two PDF pages', async () => {
        const { config, response } = trayResponse('split');
        const blob = await buildProductionTrayNestingPdf(
            response.dieline, response.nestingResult!, response.sleeveNestingResult!, config,
        );
        const pdf = await PDFDocument.load(await blob.arrayBuffer());
        expect(pdf.getPageCount()).toBe(2);
        expect(pdf.getPage(0).getSize()).not.toEqual(pdf.getPage(1).getSize());
    });
    it.runIf(Boolean(process.env.PRRYNX_TRAY_PDF_VISUAL_DIR))('writes tray visual QA fixtures when requested', async () => {
        const directory = process.env.PRRYNX_TRAY_PDF_VISUAL_DIR!;
        await mkdir(directory, { recursive: true });
        for (const mode of ['combined', 'split'] as const) {
            const { config, response } = trayResponse(mode);
            const blob = await buildProductionTrayNestingPdf(
                response.dieline,
                response.nestingResult!,
                response.sleeveNestingResult!,
                config,
            );
            await writeFile(`${directory}/tray-${mode}.pdf`, Buffer.from(await blob.arrayBuffer()));
        }
    });

});

});

    it.runIf(Boolean(process.env.PRRYNX_PDF_VISUAL_OUT))('writes a visual QA fixture when explicitly requested', async () => {
        const output = process.env.PRRYNX_PDF_VISUAL_OUT!;
        const directory = output.slice(0, Math.max(output.lastIndexOf('/'), output.lastIndexOf('\\')));
        if (directory) await mkdir(directory, { recursive: true });
        const blob = buildProductionDielinePdf(model());
        await writeFile(output, Buffer.from(await blob.arrayBuffer()));
        expect(blob.size).toBeGreaterThan(500);
    });
