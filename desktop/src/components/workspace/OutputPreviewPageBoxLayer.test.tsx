// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { OutputPreviewPageBoxes } from '../../lib/outputPreviewOverlay';
import OutputPreviewPageBoxLayer from './OutputPreviewPageBoxLayer';

const BOXES: OutputPreviewPageBoxes = {
    viewerPageNum: 2,
    sourcePageNum: 4,
    cropbox: { x0: 10, y0: 20, x1: 110, y1: 70, width: 100, height: 50 },
    trimbox: { x0: 20, y0: 30, x1: 90, y1: 60, width: 70, height: 30 },
    bleedbox: { x0: 15, y0: 25, x1: 100, y1: 65, width: 85, height: 40 },
    artbox: { x0: 25, y0: 35, x1: 80, y1: 55, width: 55, height: 20 },
    has_trimbox: true,
    has_bleedbox: true,
    has_artbox: false,
    rotation: 0,
};

describe('Output Preview — lớp khung PageBox', () => {
    it('vẽ đúng phần trăm CropBox và chỉ vẽ box được khai báo', () => {
        const view = render(
            <OutputPreviewPageBoxLayer boxes={BOXES} viewerPageNum={2} show />,
        );

        const bleed = view.container.querySelector('[data-output-preview-page-box="bleedbox"]') as HTMLElement;
        const trim = view.container.querySelector('[data-output-preview-page-box="trimbox"]') as HTMLElement;
        expect(bleed.style.left).toBe('5%');
        expect(bleed.style.top).toBe('10%');
        expect(bleed.style.width).toBe('85%');
        expect(bleed.style.height).toBe('80%');
        expect(trim.style.borderStyle).toBe('dashed');
        expect(view.container.querySelector('[data-output-preview-page-box="artbox"]')).toBeNull();
    });

    it('không vẽ khi toggle tắt hoặc response thuộc frame khác', () => {
        const view = render(
            <OutputPreviewPageBoxLayer boxes={BOXES} viewerPageNum={2} show={false} />,
        );
        expect(view.container.querySelector('[data-output-preview-page-box-layer]')).toBeNull();

        view.rerender(<OutputPreviewPageBoxLayer boxes={BOXES} viewerPageNum={3} show />);
        expect(view.container.querySelector('[data-output-preview-page-box-layer]')).toBeNull();
    });
});
