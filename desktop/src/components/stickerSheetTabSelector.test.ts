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
});
