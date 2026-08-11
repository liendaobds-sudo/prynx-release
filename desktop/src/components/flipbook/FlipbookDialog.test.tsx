// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FlipbookDialog } from './FlipbookDialog';

const mocks = vi.hoisted(() => ({
    invoke: vi.fn(),
    buildTileUrl: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('react-pdf', () => ({
    pdfjs: {
        GlobalWorkerOptions: {},
        getDocument: vi.fn(),
    },
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf.worker.js' }));
vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('./FlipBook', () => ({
    FlipBook: ({ data }: { data: { pages: Array<{ imageUrl: string }> } }) => (
        <div data-testid="flipbook-pages">
            {data.pages.map(page => page.imageUrl || 'empty').join('|')}
        </div>
    ),
}));
vi.mock('./tileUrl', () => ({
    buildTileUrl: mocks.buildTileUrl,
    trimmedAspectRatio: (width: number, height: number) => width / height,
}));
vi.mock('../../lib/imposerEngine/VirtualMap', () => ({
    generateBindingMap: () => ({
        sheets: [{
            signatureIndex: 1,
            front: {
                left: { logicalIndex: 1, srcIndex: 0 },
                right: { logicalIndex: 2, srcIndex: 1 },
            },
            back: {
                left: { logicalIndex: 3, srcIndex: 2 },
                right: { logicalIndex: 4, srcIndex: 3 },
            },
        }],
    }),
}));

const metadata = {
    widthPt: 200,
    heightPt: 300,
    allDims: {
        '1': { widthPt: 200, heightPt: 300 },
        '2': { widthPt: 200, heightPt: 300 },
        '3': { widthPt: 200, heightPt: 300 },
        '4': { widthPt: 200, heightPt: 300 },
    },
};

describe('FlipbookDialog', () => {
    beforeEach(() => {
        mocks.invoke.mockReset();
        mocks.buildTileUrl.mockReset();
        mocks.invoke.mockResolvedValue(metadata);
        mocks.buildTileUrl.mockImplementation(({ page, purpose }) => (
            `tile://page-${page}?purpose=${purpose}&call=${mocks.buildTileUrl.mock.calls.length}`
        ));
        Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    });

    afterEach(() => {
        cleanup();
        delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    });

    it('dựng lại hai trang đầu khi đóng rồi mở lại cùng PDF', async () => {
        const baseProps: React.ComponentProps<typeof FlipbookDialog> = {
            isOpen: true,
            onClose: vi.fn(),
            pdfUrl: 'blob:prynx-same-document',
            pdfFile: { path: 'D:\\jobs\\same.pdf' },
            pageOrder: [1, 2, 3, 4],
            pageRotations: [0, 0, 0, 0],
            bindingMode: 'continuous',
            foliosize: 4,
        };
        const view = render(<FlipbookDialog {...baseProps} />);

        await waitFor(() => {
            expect(mocks.buildTileUrl.mock.calls.filter(
                ([options]) => options.purpose === 'interactive',
            )).toHaveLength(2);
        });
        const firstOpenInteractiveCalls = mocks.buildTileUrl.mock.calls.filter(
            ([options]) => options.purpose === 'interactive',
        ).length;

        view.rerender(<FlipbookDialog {...baseProps} isOpen={false} />);
        await act(async () => Promise.resolve());
        view.rerender(<FlipbookDialog {...baseProps} isOpen />);

        await waitFor(() => {
            const interactiveCalls = mocks.buildTileUrl.mock.calls.filter(
                ([options]) => options.purpose === 'interactive',
            ).length;
            expect(interactiveCalls).toBe(firstOpenInteractiveCalls + 2);
        });
        expect(mocks.invoke.mock.calls.filter(([command]) => command === 'get_pdf_metadata')).toHaveLength(2);
    });
});
