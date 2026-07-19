import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PARAMS } from './types';
import { DEFAULT_NESTING_CONFIG } from './nestingTypes';
import { runDielineEngine } from './engine';

const pdfHarness = vi.hoisted(() => ({
    instances: [] as Array<{ svg: ReturnType<typeof vi.fn>; addPage: ReturnType<typeof vi.fn> }>,
}));

vi.mock('jspdf', () => ({
    jsPDF: class {
        svg = vi.fn(async () => undefined);
        addPage = vi.fn();
        output = vi.fn(() => new Blob(['proof'], { type: 'application/pdf' }));
        constructor() { pdfHarness.instances.push(this); }
    },
}));
vi.mock('svg2pdf.js', () => ({}));

import { buildTrayNestingPdfBlob } from './exportNestingPDF';

describe('tray/sleeve technical nesting PDF', () => {
    const parsedSvgs: string[] = [];

    beforeEach(() => {
        pdfHarness.instances.length = 0;
        parsedSvgs.length = 0;
        vi.stubGlobal('DOMParser', class {
            parseFromString(source: string) {
                parsedSvgs.push(source);
                return { documentElement: {}, querySelector: () => null };
            }
        });
    });

    afterEach(() => vi.unstubAllGlobals());

    async function build(mode: 'combined' | 'split') {
        const config = {
            ...structuredClone(DEFAULT_NESTING_CONFIG),
            sheet: { width: 900, height: 650 },
            sleeveSheet: { width: 700, height: 500 },
            margin: { top: 10, right: 10, bottom: 10, left: 10 },
            trayNestingMode: mode,
        };
        const response = runDielineEngine({
            params: { ...DEFAULT_PARAMS, boxType: 'tray', L: 120, W: 85, D: 25 },
            nestingConfig: config,
        });
        await buildTrayNestingPdfBlob(
            response.dieline,
            response.nestingResult!,
            response.sleeveNestingResult!,
            config,
        );
    }

    it('overlays isolated tray and sleeve groups on one combined sheet', async () => {
        await build('combined');
        expect(pdfHarness.instances[0].addPage).not.toHaveBeenCalled();
        expect(pdfHarness.instances[0].svg).toHaveBeenCalledTimes(1);
        expect(parsedSvgs).toHaveLength(1);
        expect(parsedSvgs[0]).toContain('sleeve-dieline-template');
    });

    it('creates independent pages for split materials', async () => {
        await build('split');
        expect(pdfHarness.instances[0].addPage).toHaveBeenCalledTimes(1);
        expect(pdfHarness.instances[0].svg).toHaveBeenCalledTimes(2);
        expect(parsedSvgs).toHaveLength(2);
        expect(parsedSvgs[0]).not.toContain('sleeve_');
    });
});
