// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
    createImposerSettingsStore,
    ImposerSettingsContext,
} from '../useImposerSettingsStore';
import GridSettingsSection, { type GridSettingsProps } from './GridSettingsSection';
import AdvancedSettingsSection from './AdvancedSettingsSection';

// MIXED-GUILLOTINE (audit 2026-07-30 §MG.8/§MG.9): khóa phạm vi hiển thị mode và cạnh lật.
type TestTool = 'nup' | 'sticker_imposer' | 'cnc_imposer';
type TestLayout = 'sequential' | 'mixed_guillotine';

interface RenderOptions {
    activeTool?: TestTool;
    impositionUnit?: 'sticker' | 'page_sheet';
    layoutType?: TestLayout;
    duplexFlow?: 'normal' | 'double';
    taskMode?: 'nup' | 'step_repeat';
}

afterEach(() => {
    cleanup();
    localStorage.clear();
});

function renderGridSettings({
    activeTool = 'nup',
    impositionUnit = 'sticker',
    layoutType = 'sequential',
    duplexFlow = 'normal',
    taskMode = 'nup',
}: RenderOptions = {}) {
    localStorage.clear();
    const store = createImposerSettingsStore();
    store.setState({
        activeDashboardTool: activeTool,
        impositionUnit,
        layoutType,
        taskMode,
    });

    const props: GridSettingsProps = {
        taskMode,
        setTaskMode: () => undefined,
        activeTool,
        duplexFlow,
        setDuplexFlow: () => undefined,
        gridStrategy: 'optimal_auto',
        setGridStrategy: () => undefined,
        targetQuantity: 0,
        setTargetQuantity: () => undefined,
        targetQuantitiesByPage: {},
        setTargetQuantitiesByPage: () => undefined,
        previewCapacity: 0,
        previewCapacities: {},
        mixedPlacedByPage: {},
        sourceTotalPages: 4,
        columns: 0,
        setColumns: () => undefined,
        rows: 0,
        setRows: () => undefined,
        gapX: 0,
        setGapX: () => undefined,
        gapY: 0,
        setGapY: () => undefined,
        showGapSettings: false,
        setShowGapSettings: () => undefined,
        detectedShapesByPage: {},
        setDetectedShapesByPage: () => undefined,
        viewerActivePage: 1,
        viewerPageOrder: null,
    };

    const view = render(
        <ImposerSettingsContext.Provider value={store}>
            <GridSettingsSection {...props} />
        </ImposerSettingsContext.Provider>,
    );
    return { store, ...view };
}
function renderAdvancedSettings({
    layoutType = 'mixed_guillotine',
    duplexFlow = 'double',
    taskMode = 'nup',
}: Pick<RenderOptions, 'layoutType' | 'duplexFlow' | 'taskMode'> = {}) {
    localStorage.clear();
    const store = createImposerSettingsStore();
    store.setState({
        activeDashboardTool: 'nup',
        impositionUnit: 'sticker',
        layoutType,
        duplexFlow,
        taskMode,
        mixedExcessPercent: 0,
    });
    const view = render(
        <ImposerSettingsContext.Provider value={store}>
            <AdvancedSettingsSection activeTool="nup" sourceTotalPages={4} />
        </ImposerSettingsContext.Provider>,
    );
    return { store, ...view };
}

describe('GridSettingsSection — Dàn nhiều kích thước', () => {
    it('dropdown cùng khổ chỉ giữ ba cách ráp nghiệp vụ', () => {
        renderGridSettings({ activeTool: 'nup' });

        const select = screen.getByRole('option', { name: 'Xếp lần lượt' }).closest('select');
        expect(select).toBeTruthy();
        expect(Array.from((select as HTMLSelectElement).options).map((option) => option.value)).toEqual([
            'sequential',
            'cut_stacks',
            'ratio_stack',
        ]);
        expect(screen.queryByRole('option', { name: 'Dàn nhiều kích thước' })).toBeNull();
    });

    it('hiển thị trạng thái tự động thay cho dropdown khi tài liệu khác khổ', () => {
        renderGridSettings({ activeTool: 'nup', layoutType: 'mixed_guillotine' });

        const status = screen.getByTestId('mixed-guillotine-auto-status');
        expect(status.textContent).toContain('Tự động');
        expect(status.textContent).toContain('Dàn nhiều kích thước');
        expect(screen.queryByRole('option', { name: 'Dàn nhiều kích thước' })).toBeNull();
    });

    it.each([
        ['Tem bế', 'sticker_imposer', 'sticker'],
        ['CNC', 'cnc_imposer', 'sticker'],
        ['Nguyên tấm decal', 'sticker_imposer', 'page_sheet'],
    ] as const)('không hiện Dàn nhiều kích thước trong %s', (_label, activeTool, impositionUnit) => {
        renderGridSettings({ activeTool, impositionUnit, layoutType: 'mixed_guillotine' });

        expect(
            screen.queryByRole('option', { name: 'Dàn nhiều kích thước' }),
        ).toBeNull();
        expect(screen.queryByTestId('mixed-guillotine-auto-status')).toBeNull();
    });

    it('chỉ chuyển cạnh lật vào Thiết lập mở rộng và tự động hóa mức in dư', () => {
        renderGridSettings({
            layoutType: 'mixed_guillotine',
            duplexFlow: 'double',
        });
        expect(screen.queryByRole('option', { name: 'Theo cạnh dài' })).toBeNull();
        expect(document.getElementById('mixed-excess-percent')).toBeNull();

        const { store } = renderAdvancedSettings();
        expect(document.getElementById('mixed-excess-percent')).toBeNull();
        const longEdgeOption = screen.getByRole('option', { name: 'Theo cạnh dài' });
        const flipEdgeSelect = longEdgeOption.closest('select');
        expect(flipEdgeSelect).toBeTruthy();
        fireEvent.change(flipEdgeSelect as HTMLSelectElement, { target: { value: 'short' } });
        expect(store.getState().duplexFlipEdge).toBe('short');
    });
    it.each([
        ['mixed nhưng một mặt', 'mixed_guillotine', 'normal', 'nup'],
        ['hai mặt nhưng mode cũ', 'sequential', 'double', 'nup'],
        ['mixed hai mặt nhưng tác vụ Bình trang', 'mixed_guillotine', 'double', 'step_repeat'],
    ] as const)('ẩn selector cạnh lật khi %s', (_label, layoutType, duplexFlow, taskMode) => {
        renderAdvancedSettings({ layoutType, duplexFlow, taskMode });

        expect(screen.queryByRole('option', { name: 'Theo cạnh dài' })).toBeNull();
        expect(screen.queryByRole('option', { name: 'Theo cạnh ngắn' })).toBeNull();
    });
});
