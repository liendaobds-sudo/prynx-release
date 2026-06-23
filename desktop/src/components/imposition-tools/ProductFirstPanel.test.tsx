// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { ImposerSettingsContext, createImposerSettingsStore } from './useImposerSettingsStore';
import ProductFirstPanel from './ProductFirstPanel';

afterEach(cleanup);

function renderPanel() {
    const store = createImposerSettingsStore();
    const utils = render(
        <ImposerSettingsContext.Provider value={store}>
            <ProductFirstPanel pageCount={16} finishedWidthMm={105} finishedHeightMm={148} />
        </ImposerSettingsContext.Provider>
    );
    return { store, ...utils };
}

describe('ProductFirstPanel (smoke)', () => {
    it('render danh sách sản phẩm + ít nhất 1 phương án + nút áp dụng', () => {
        renderPanel();
        expect(screen.getByText('Bấm kim giữa')).toBeTruthy();
        expect(screen.getByText('Cắt-ráp-xấp')).toBeTruthy();
        expect(screen.getAllByText('Dùng thiết lập này').length).toBeGreaterThan(0);
    });

    it('bấm "Dùng thiết lập này" → đổ vào store (taskMode booklet, in_nhanh)', () => {
        const { store } = renderPanel();
        const btns = screen.getAllByText('Dùng thiết lập này');
        fireEvent.click(btns[0]);
        const s = store.getState();
        expect(s.taskMode).toBe('booklet');
        expect(s.paperClassification).toBe('in_nhanh');
        expect(s.foldPattern).toBe(''); // không lẫn knob offset
    });
});
