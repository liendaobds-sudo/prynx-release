// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NestingCanvas from '../NestingCanvas';
import { useBoxStore } from '../../../stores/useBoxStore';
import { generateDieline } from '../../../lib/dieline/engine';
import { DEFAULT_PARAMS } from '../../../lib/dieline/types';
import { DEFAULT_NESTING_CONFIG, type NestingResult } from '../../../lib/dieline/nestingTypes';

const canvasRect = {
    x: 0, y: 0, width: 1000, height: 800,
    top: 0, left: 0, right: 1000, bottom: 800,
    toJSON: () => ({}),
} as DOMRect;

function nestingResult(): NestingResult {
    return {
        positions: [],
        countPerSheet: 1,
        rows: 1,
        cols: 1,
        utilization: 10,
        usableArea: { width: 770, height: 1068 },
        actualSheet: { width: 790, height: 1090 },
        cellSize: { width: 100, height: 100 },
        label: 'Test',
        superTile: null,
    };
}

async function expectWheelZooms(container: HTMLElement): Promise<void> {
    const svg = await waitFor(() => {
        const element = container.querySelector('svg');
        expect(element).not.toBeNull();
        return element as SVGSVGElement;
    });
    const before = container.querySelector('.dt-zoom-info')?.textContent;
    const event = new WheelEvent('wheel', {
        deltaY: -100,
        clientX: 500,
        clientY: 400,
        bubbles: true,
        cancelable: true,
    });

    act(() => {
        svg.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => {
        expect(container.querySelector('.dt-zoom-info')?.textContent).not.toBe(before);
    });
}

describe('NestingCanvas — zoom bằng con lăn', () => {
    beforeEach(() => {
        vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockReturnValue(canvasRect);
    });

    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
        useBoxStore.setState({
            dieline: null,
            nestingResult: null,
            sleeveNestingResult: null,
        });
    });

    it('zoom được ở chế độ xếp khuôn thường', async () => {
        const params = { ...DEFAULT_PARAMS, boxType: 'rte' as const };
        useBoxStore.setState({
            params,
            dieline: generateDieline(params),
            nestingConfig: structuredClone(DEFAULT_NESTING_CONFIG),
            nestingResult: nestingResult(),
            sleeveNestingResult: null,
        });

        const view = render(<NestingCanvas />);
        await expectWheelZooms(view.container);
    });

    it.each(['combined', 'split'] as const)(
        'zoom được với hộp hai mảnh ở chế độ %s',
        async (trayNestingMode) => {
            const params = { ...DEFAULT_PARAMS, boxType: 'double_tray' as const };
            useBoxStore.setState({
                params,
                dieline: generateDieline(params),
                nestingConfig: {
                    ...structuredClone(DEFAULT_NESTING_CONFIG),
                    trayNestingMode,
                },
                nestingResult: nestingResult(),
                sleeveNestingResult: nestingResult(),
            });

            const view = render(<NestingCanvas />);
            await expectWheelZooms(view.container);
        },
    );
});