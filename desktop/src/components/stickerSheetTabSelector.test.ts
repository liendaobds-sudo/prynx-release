/* @vitest-environment jsdom */

import { createElement } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { create } from 'zustand';
import { shallow } from 'zustand/shallow';
import { useShallow } from 'zustand/react/shallow';

import type { StickerSheetTabState } from './preprocess-tools/stickerSheetStore';
import {
    resolveStickerSourceSyncMarker,
    selectStickerSheetTabSummary,
    selectStickerSheetPageWorkflowStatuses,
    stickerSheetWorkflowStatusAtViewerPosition,
    stickerSourceOwnerFromHistory,
    viewerShowsStickerSource,
} from './stickerSheetTabSelector';

describe('selectStickerSheetTabSummary', () => {
    it('giữ snapshot ổn định khi tab chưa được khởi tạo', () => {
        const state = { tabs: {} };

        const first = selectStickerSheetTabSummary(state, 'tab-chua-co');
        const second = selectStickerSheetTabSummary(state, 'tab-chua-co');

        expect(first.stickerSheetPages).toBe(second.stickerSheetPages);
        expect(shallow(first, second)).toBe(true);
    });

    it('không lặp useSyncExternalStore khi tab chưa được khởi tạo', () => {
        const useProbeStore = create<{
            tabs: Record<string, StickerSheetTabState>;
        }>(() => ({ tabs: {} }));

        function Probe() {
            useProbeStore(useShallow(
                state => selectStickerSheetTabSummary(state, 'tab-chua-co'),
            ));
            return null;
        }

        expect(() => render(createElement(Probe))).not.toThrow();
    });

    it('gắn trạng thái theo vị trí Working PDF, không theo số trang nguồn', () => {
        const source = new File(['pdf'], 'working.pdf', { type: 'application/pdf' });
        const summary = selectStickerSheetTabSummary({
            tabs: {
                'tab-ai': {
                    mode: 'ai-sheet',
                    sourceFile: source,
                    activeSourcePage: 2,
                    pages: {
                        1: { status: 'mask-ready' },
                        2: { status: 'mask-review' },
                        3: { status: 'detecting' },
                    },
                    inspection: { page_count: 3 },
                    sourceImageCount: 0,
                    status: 'ready',
                } as unknown as StickerSheetTabState,
            },
        }, 'tab-ai');

        expect(selectStickerSheetPageWorkflowStatuses(summary, 3)).toEqual({
            1: 'ready',
            2: 'review',
            3: 'processing',
        });
    });

    it('không phát badge AI-sheet khi Viewer không còn đúng nguồn AI', () => {
        const summary = selectStickerSheetTabSummary({ tabs: {} }, 'tab-khac');

        expect(selectStickerSheetPageWorkflowStatuses(summary, 2)).toBeUndefined();
    });

    it('tra badge theo vị trí Viewer để hai bản duplicate không dùng chung trạng thái', () => {
        const statuses = { 1: 'ready', 2: 'review', 3: 'error' } as const;

        expect(stickerSheetWorkflowStatusAtViewerPosition(statuses, 0)).toBe('ready');
        expect(stickerSheetWorkflowStatusAtViewerPosition(statuses, 1)).toBe('review');
        expect(stickerSheetWorkflowStatusAtViewerPosition(statuses, 2)).toBe('error');
    });

    it('không mở lại nguyên tấm sau khi commit PDF tách tem', () => {
        const source = new File(['source'], 'sheet.png', { type: 'image/png' });
        const output = new File(['output'], 'tem_tach.pdf', { type: 'application/pdf' });

        expect(resolveStickerSourceSyncMarker(source, null, true)).toBe(source);
        expect(viewerShowsStickerSource(output, null, source)).toBe(false);
    });

    it('chỉ hiện lớp mask khi Viewer đang hiển thị đúng nguồn AI', () => {
        const sourceImage = new File(['source'], 'sheet.png', { type: 'image/png' });
        const normalizedPdf = new File(['pdf'], 'sheet.pdf', { type: 'application/pdf' });
        const pdfSource = new File(['pdf'], 'sheet-source.pdf', { type: 'application/pdf' });

        expect(viewerShowsStickerSource(normalizedPdf, sourceImage, sourceImage)).toBe(true);
        expect(viewerShowsStickerSource(pdfSource, null, pdfSource)).toBe(true);
    });

    it('nhận file lịch sử là cùng nguồn PDF để Undo không kích hoạt lượt mở thứ hai', () => {
        const pdfSource = new File(['pdf'], 'sheet-source.pdf', { type: 'application/pdf' });
        const historyFile = new File([], 'sheet-source.pdf', { type: 'application/pdf' });
        Object.defineProperty(historyFile, '__prynxStickerSourceFile', {
            value: pdfSource,
            configurable: true,
        });

        expect(stickerSourceOwnerFromHistory(historyFile)).toBe(pdfSource);
        expect(viewerShowsStickerSource(historyFile, null, pdfSource)).toBe(true);
    });
});
