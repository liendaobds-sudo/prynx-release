// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
    createImposerSettingsStore,
    ImposerSettingsContext,
} from '../useImposerSettingsStore';
import GridSettingsSection, { type GridSettingsProps } from './GridSettingsSection';
import AdvancedSettingsSection from './AdvancedSettingsSection';
import { buildReportPreview } from '../../../lib/reportPreview';

// MIXED-GUILLOTINE (audit 2026-07-30 §MG.8/§MG.9): khóa phạm vi hiển thị mode và cạnh lật.
type TestTool = 'nup' | 'sticker_imposer' | 'cnc_imposer';
type TestLayout = 'sequential' | 'mixed_guillotine';

interface RenderOptions {
    activeTool?: TestTool;
    impositionUnit?: 'sticker' | 'page_sheet';
    layoutType?: TestLayout;
    duplexFlow?: 'normal' | 'double';
    taskMode?: 'nup' | 'step_repeat' | 'booklet';
    markType?: 'none' | 'corners' | 'guillotine';
    rectangleStickerInking?: boolean;
    showImpositionUnitSelector?: boolean;
    hasValidDie?: boolean | null;
    cutType?: 'default' | 'one_dao';
    dieSizeMode?: 'die' | 'page';
    gridStrategy?: 'optimal_auto' | 'simple_auto' | 'manual';
    fillBlockGap?: number;
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
    showImpositionUnitSelector = true,
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
        showImpositionUnitSelector,
    };

    const view = render(
        <ImposerSettingsContext.Provider value={store}>
            <GridSettingsSection {...props} />
        </ImposerSettingsContext.Provider>,
    );
    return { store, ...view };
}
function renderAdvancedSettings({
    activeTool = 'nup',
    impositionUnit = 'sticker',
    layoutType = 'mixed_guillotine',
    duplexFlow = 'double',
    taskMode = 'nup',
    markType = 'guillotine',
    rectangleStickerInking = false,
    hasValidDie = null,
    cutType = 'default',
    dieSizeMode = 'die',
    gridStrategy = 'optimal_auto',
    fillBlockGap = 0,
}: RenderOptions = {}) {
    localStorage.clear();
    const store = createImposerSettingsStore();
    store.setState({
        activeDashboardTool: activeTool,
        impositionUnit,
        layoutType,
        duplexFlow,
        taskMode,
        markType,
        cutType,
        dieSizeMode,
        gridStrategy,
        fillBlockGap,
        mixedExcessPercent: 0,
    });
    const view = render(
        <ImposerSettingsContext.Provider value={store}>
            <AdvancedSettingsSection
                activeTool={activeTool}
                sourceTotalPages={4}
                rectangleStickerInking={rectangleStickerInking}
                hasValidDie={hasValidDie}
            />
        </ImposerSettingsContext.Provider>,
    );
    return { store, ...view };
}

describe('GridSettingsSection — Dàn nhiều kích thước', () => {
    it('ẩn lựa chọn đơn vị khi file không có khuôn bế hợp lệ', () => {
        renderGridSettings({
            activeTool: 'sticker_imposer',
            showImpositionUnitSelector: false,
        });
        expect(screen.queryByText('Đơn vị bình')).toBeNull();
    });

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

describe('AdvancedSettingsSection — Đối đầu xen kẽ (Inking)', () => {
    function openInkingSettings() {
        const button = screen.getByRole('button', { name: 'Đối đầu xen kẽ (Inking)' });
        if (button.getAttribute('aria-expanded') === 'false') fireEvent.click(button);
    }

    it('là thiết lập riêng, giữ nguyên Cách xếp và cập nhật kiểu xoay', () => {
        const { store } = renderAdvancedSettings({ activeTool: 'nup', layoutType: 'sequential' });

        openInkingSettings();
        const select = screen.getByRole('combobox', { name: 'Xoay đối đầu xen kẽ (Inking)' });
        expect(Array.from((select as HTMLSelectElement).options).map(option => option.value)).toEqual([
            'none',
            'row',
            'column',
        ]);
        fireEvent.change(select, { target: { value: 'row' } });
        expect(store.getState().alternateRotation).toBe('row');
        expect(store.getState().gridStrategy).toBe('optimal_auto');

        renderGridSettings({ activeTool: 'nup', layoutType: 'sequential' });
        expect(screen.queryByRole('option', { name: /Inking/ })).toBeNull();
        const strategySelect = screen.getAllByRole('option', { name: 'Xếp tối ưu' }).at(-1)?.closest('select');
        expect(Array.from((strategySelect as HTMLSelectElement).options).map(option => option.value)).toEqual([
            'optimal_auto',
            'simple_auto',
            'manual',
        ]);
    });

    it.each([
        ['CNC', 'cnc_imposer', 'sticker', 'sequential', 'nup'],
        ['Nguyên tấm decal', 'sticker_imposer', 'page_sheet', 'sequential', 'nup'],
        ['Dàn nhiều kích thước', 'nup', 'sticker', 'mixed_guillotine', 'nup'],
        ['Booklet', 'nup', 'sticker', 'sequential', 'booklet'],
    ] as const)('ẩn trong %s', (_label, activeTool, impositionUnit, layoutType, taskMode) => {
        renderAdvancedSettings({ activeTool, impositionUnit, layoutType, taskMode });

        expect(screen.queryByRole('combobox', { name: 'Xoay đối đầu xen kẽ (Inking)' })).toBeNull();
    });

    it('hiện riêng trong Bình tem bế khi toàn bộ tem là vuông/chữ nhật', () => {
        const { store } = renderAdvancedSettings({
            activeTool: 'sticker_imposer',
            impositionUnit: 'sticker',
            layoutType: 'sequential',
            rectangleStickerInking: true,
        });

        openInkingSettings();
        const select = screen.getByRole('combobox', { name: 'Xoay đối đầu xen kẽ (Inking)' });
        fireEvent.change(select, { target: { value: 'column' } });
        expect(store.getState().alternateRotation).toBe('column');
    });

    it('ẩn trong Bình tem bế khi có tem không phải vuông/chữ nhật', () => {
        renderAdvancedSettings({
            activeTool: 'sticker_imposer',
            impositionUnit: 'sticker',
            layoutType: 'sequential',
            rectangleStickerInking: false,
        });

        expect(screen.queryByRole('combobox', { name: 'Xoay đối đầu xen kẽ (Inking)' })).toBeNull();
    });
});

describe('AdvancedSettingsSection — thiết lập 1 Dao', () => {
    function openCutSettings() {
        const button = screen.getByRole('button', { name: /Định vị.*Cắt/i });
        if (button.getAttribute('aria-expanded') === 'false') fireEvent.click(button);
        return button;
    }

    it('file không khuôn chỉ báo dùng kích thước trang và không hiện lựa chọn khuôn cũ', () => {
        renderAdvancedSettings({
            activeTool: 'sticker_imposer',
            cutType: 'one_dao',
            dieSizeMode: 'die',
            hasValidDie: false,
        });
        openCutSettings();

        expect(screen.queryByRole('option', { name: 'Theo khuôn có sẵn' })).toBeNull();
        expect(screen.getByText('Không có đường bế hợp lệ — tự dùng kích thước trang')).toBeTruthy();
        expect(screen.getByText('CO/MỞ')).toBeTruthy();
    });

    it('file có khuôn mới hiện đủ hai kiểu khuôn', () => {
        renderAdvancedSettings({
            activeTool: 'sticker_imposer',
            cutType: 'one_dao',
            hasValidDie: true,
        });
        openCutSettings();

        expect(screen.getByRole('option', { name: 'Theo khuôn có sẵn' })).toBeTruthy();
        expect(screen.getByRole('option', { name: 'Theo kích thước trang' })).toBeTruthy();
        expect(screen.queryByTestId('die-size-status')).toBeNull();
    });

    it('chỉ hiện KC khối phụ cho Xếp tối ưu', () => {
        const optimal = renderAdvancedSettings({
            activeTool: 'sticker_imposer',
            cutType: 'one_dao',
            hasValidDie: true,
            gridStrategy: 'optimal_auto',
        });
        const cutButton = openCutSettings();
        const gapInput = screen.getByLabelText(/KC khối phụ/i);
        const cutContent = document.getElementById(cutButton.getAttribute('aria-controls') || '');
        expect(cutContent?.contains(gapInput)).toBe(true);

        optimal.unmount();
        renderAdvancedSettings({
            activeTool: 'sticker_imposer',
            cutType: 'one_dao',
            hasValidDie: true,
            gridStrategy: 'simple_auto',
        });
        openCutSettings();
        expect(screen.queryByLabelText(/KC khối phụ/i)).toBeNull();
    });
});

describe('AdvancedSettingsSection — đường viền cắt thủ công', () => {
    it.each([
        ['Dàn nhiều mẫu', 'nup'],
        ['Bình trang', 'step_repeat'],
    ] as const)('hiện trong %s và độc lập với trạng thái dấu xén', (_label, taskMode) => {
        renderAdvancedSettings({ activeTool: 'nup', taskMode, markType: 'none' });
        expect(screen.getByRole('checkbox', { name: 'Đường viền cắt' })).toBeTruthy();
        expect(screen.queryByTestId('cut-border-controls')).toBeNull();
    });

    it.each([
        ['Booklet', 'nup', 'sticker', 'booklet'],
        ['Tem bế', 'sticker_imposer', 'sticker', 'nup'],
        ['CNC', 'cnc_imposer', 'sticker', 'nup'],
        ['Nguyên tấm decal', 'sticker_imposer', 'page_sheet', 'nup'],
    ] as const)('ẩn trong %s', (_label, activeTool, impositionUnit, taskMode) => {
        renderAdvancedSettings({ activeTool, impositionUnit, taskMode });
        expect(screen.queryByTestId('cut-border-settings')).toBeNull();
    });

    it('bật viền mới hiện điều khiển và cập nhật Trim/Bleed, màu, độ dày', () => {
        const { store } = renderAdvancedSettings({
            activeTool: 'nup',
            taskMode: 'nup',
            markType: 'none',
        });
        fireEvent.click(screen.getByRole('checkbox', { name: 'Đường viền cắt' }));
        expect(screen.getByTestId('cut-border-controls')).toBeTruthy();

        fireEvent.change(screen.getByLabelText('Vị trí đường viền'), { target: { value: 'bleed' } });
        fireEvent.change(screen.getByLabelText('Màu viền'), { target: { value: '#ff0000' } });
        fireEvent.change(screen.getByLabelText('Độ dày viền (mm)'), { target: { value: '0.6' } });

        expect(store.getState().cutBorder).toEqual({
            enabled: true,
            position: 'bleed',
            color: '#FF0000',
            thickness: 0.6,
        });
        expect(screen.getByTestId('cut-border-overlap-warning')).toBeTruthy();
    });
});

describe('AdvancedSettingsSection — thứ tự trường report', () => {
    function openReportSettings() {
        fireEvent.click(screen.getByRole('button', { name: /Thông tin sản phẩm \(Report\)/i }));
    }

    it('hiển thị theo fieldOrder và lưu thứ tự mới khi bấm mũi tên', () => {
        const { store } = renderAdvancedSettings({
            activeTool: 'sticker_imposer',
            taskMode: 'nup',
        });
        act(() => {
            store.setState({
                reportOrderCode: 'DH-001',
                reportMaterial: 'Decal Đế vàng',
                reportLamination: 1,
                reportDisplay: {
                    ...store.getState().reportDisplay,
                    fieldOrder: ['material', 'lamination', 'orderCode'],
                },
            });
        });
        openReportSettings();

        const order = screen.getByTestId('report-field-order');
        const fieldKeys = () => Array.from(order.children).map(node => node.getAttribute('data-report-field'));
        expect(fieldKeys().slice(0, 3)).toEqual(['material', 'lamination', 'orderCode']);
        expect(screen.getByText('Decal Đế vàng - Cán bóng - DH-001')).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: /Mã đơn hàng ↑/ }));

        expect(store.getState().reportDisplay.fieldOrder.slice(0, 3)).toEqual([
            'material', 'orderCode', 'lamination',
        ]);
        expect(buildReportPreview(store.getState().reportDisplay, {
            material: store.getState().reportMaterial,
            laminationType: store.getState().reportLamination,
            orderCode: store.getState().reportOrderCode,
        })).toBe('Decal Đế vàng - DH-001 - Cán bóng');
    });
});
