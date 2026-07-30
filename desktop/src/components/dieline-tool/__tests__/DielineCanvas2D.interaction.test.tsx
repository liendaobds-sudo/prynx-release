// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DielineCanvas2D from '../DielineCanvas2D';
import { useBoxStore } from '../../../stores/useBoxStore';
import { useMockupStore } from '../../../stores/useMockupStore';
import { generateDieline } from '../../../lib/dieline/engine';
import { DEFAULT_PARAMS } from '../../../lib/dieline/types';

const rect = {
    x: 0, y: 0, width: 1000, height: 800,
    top: 0, left: 0, right: 1000, bottom: 800,
    toJSON: () => ({}),
} as DOMRect;

describe('DielineCanvas2D interactions', () => {
    beforeEach(() => {
        vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockReturnValue(rect);
        useBoxStore.setState({ dieline: null, isModelCurrent: false });
        useMockupStore.getState().resetMockup();
    });

    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
        useMockupStore.getState().resetMockup();
    });

    it('attaches wheel zoom after the dieline appears in 2D-only view', async () => {
        const view = render(React.createElement(DielineCanvas2D));
        expect(view.container.querySelector('svg')).toBeNull();

        act(() => {
            useBoxStore.setState({
                dieline: generateDieline({ ...DEFAULT_PARAMS, boxType: 'rte' }),
                isModelCurrent: true,
            });
        });

        const svg = await waitFor(() => {
            const element = view.container.querySelector('svg');
            expect(element).not.toBeNull();
            return element as SVGSVGElement;
        });
        const before = view.container.querySelector('.dt-zoom-info')?.textContent;
        act(() => {
            svg.dispatchEvent(new WheelEvent('wheel', {
                deltaY: -100,
                clientX: 500,
                clientY: 400,
                bubbles: true,
                cancelable: true,
            }));
        });
        await waitFor(() => {
            expect(view.container.querySelector('.dt-zoom-info')?.textContent).not.toBe(before);
        });
    });

    it('renders the bleed contour as a bold green guide', async () => {
        const dieline = generateDieline({ ...DEFAULT_PARAMS, boxType: 'rte' });
        useBoxStore.setState({ dieline, isModelCurrent: true });
        useMockupStore.getState().setShowBleedSafe(true);

        const view = render(React.createElement(DielineCanvas2D));
        const bleedPath = await waitFor(() => {
            const element = view.container.querySelector('.dt-bleed-contours polygon');
            expect(element).not.toBeNull();
            return element as SVGPolygonElement;
        });

        expect(bleedPath.getAttribute('stroke')).toBe('#16a34a');
        expect(bleedPath.getAttribute('stroke-width')).toBe('1.1');
        expect(bleedPath.getAttribute('stroke-dasharray')).toBe('4,2');
    });
    it('renders 100% artwork with its intrinsic aspect ratio', async () => {
        const dieline = generateDieline({ ...DEFAULT_PARAMS, boxType: 'rte' });
        useBoxStore.setState({ dieline, isModelCurrent: true });
        useMockupStore.getState().setOuterArtworkUrl('blob:wide-artwork', 2);

        const view = render(React.createElement(DielineCanvas2D));
        const image = await waitFor(() => {
            const element = view.container.querySelector('image');
            expect(element).not.toBeNull();
            return element as SVGImageElement;
        });
        const width = Number(image.getAttribute('width'));
        const height = Number(image.getAttribute('height'));
        expect(width / height).toBeCloseTo(2, 6);
        expect(image.getAttribute('preserveAspectRatio')).not.toBe('none');
    });
});