// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DielineTool from '../DielineTool';

const mocks = vi.hoisted(() => ({
    regenerate: vi.fn(),
    requestFeatureAction: vi.fn((_featureId: string, action: () => void) => { action(); return true; }),
    downloadPDF: vi.fn(),
    dieline: null as null | { params: { boxType: string }; allPaths: never[]; panels: never[] },
}));

// [VARIANT 2026-07-29] onSelect nhận `variant.id` (không phải boxType nữa)
vi.mock('../DielineGallery', () => ({
    default: ({ onSelect }: { onSelect: (variantId: string) => void }) => (
        <button type="button" onClick={() => onSelect('rte_std')}>Mở trình sửa</button>
    ),
}));

vi.mock('../ParamPanel', async () => {
    const ReactModule = await import('react');
    function MockParamPanel() {
        const [value, setValue] = ReactModule.useState(0);
        return (
            <button type="button" data-testid="param-state" onClick={() => setValue((current) => current + 1)}>
                Giá trị {value}
            </button>
        );
    }
    return { default: MockParamPanel };
});

vi.mock('../MockupPanel', () => ({ default: () => <div>Mockup</div> }));
vi.mock('../DielineCanvas2D', () => ({ default: () => <div>Canvas 2D</div> }));
vi.mock('../NestingPanel', () => ({ default: () => <div>Nesting panel</div> }));
vi.mock('../NestingCanvas', () => ({ default: () => <div>Nesting canvas</div> }));
vi.mock('../DielineScene3D', () => ({ default: () => <div>Canvas 3D</div> }));

vi.mock('../../../stores/useBoxStore', () => ({
    useBoxStore: () => ({
        dieline: mocks.dieline,
        nestingResult: null,
        sleeveNestingResult: null,
        nestingConfig: {},
        setParam: vi.fn(),
        // [VARIANT 2026-07-29] DielineTool chọn biến thể qua setVariant
        setVariant: vi.fn(),
        regenerate: mocks.regenerate,
        isGenerating: false,
        isModelCurrent: true,
        generationError: null,
    }),
}));

vi.mock('../../../lib/dieline/exportPDF', () => ({
    downloadPDF: mocks.downloadPDF,
    buildDielinePdfBlob: vi.fn(),
}));
vi.mock('../../../lib/dieline/exportNestingPDF', () => ({
    downloadNestingPDF: vi.fn(),
    buildNestingPdfBlob: vi.fn(),
    buildTrayNestingPdfBlob: vi.fn(),
    downloadTrayNestingPDF: vi.fn(),
}));
vi.mock('../../../lib/dieline/productionPDF', () => ({
    downloadProductionDielinePDF: vi.fn(),
    downloadProductionNestingPDF: vi.fn(),
    downloadProductionTrayNestingPDF: vi.fn(),
}));
vi.mock('../../shared/usePrintDialog', () => ({
    usePrintDialog: () => ({ openPrintDialog: vi.fn(), printDialog: null }),
}));
vi.mock('../../../i18n', () => ({ tv: (value: string) => value }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (value: string) => value }) }));
vi.mock('sonner', () => ({ toast: { warning: vi.fn(), loading: vi.fn(), dismiss: vi.fn(), error: vi.fn() } }));
vi.mock('../../../hooks/useToolActivationGuard', () => ({
    useFeatureActionGuard: () => mocks.requestFeatureAction,
}));

const toolRect = {
    x: 0,
    y: 0,
    width: 1000,
    height: 800,
    top: 0,
    left: 0,
    right: 1000,
    bottom: 800,
    toJSON: () => ({}),
} as DOMRect;

describe('DielineTool movable customization panel', () => {
    beforeEach(() => {
        window.localStorage.clear();
        mocks.regenerate.mockReset();
        mocks.downloadPDF.mockReset();
        mocks.dieline = null;
        mocks.requestFeatureAction.mockReset();
        mocks.requestFeatureAction.mockImplementation((_featureId: string, action: () => void) => { action(); return true; });
        if (!window.PointerEvent) {
            Object.defineProperty(window, 'PointerEvent', { value: MouseEvent, configurable: true });
        }
    });

    afterEach(() => {
        cleanup();
        document.body.classList.remove('dt-panel-interacting');
    });

    it('requests full nesting only when the nesting tab is opened', () => {
        render(<DielineTool />);
        fireEvent.click(screen.getByRole('button', { name: 'Mở trình sửa' }));
        fireEvent.click(screen.getByRole('button', { name: /xep_khuon/ }));
        expect(mocks.regenerate).toHaveBeenCalledWith(true);
    });

    it('resizes, detaches, moves and docks without remounting panel content', async () => {
        const view = render(<DielineTool />);
        fireEvent.click(screen.getByRole('button', { name: 'Mở trình sửa' }));

        const tool = view.container.querySelector('main.dieline-tool') as HTMLElement;
        vi.spyOn(tool, 'getBoundingClientRect').mockReturnValue(toolRect);
        const panel = screen.getByLabelText('Bảng tùy chỉnh khuôn') as HTMLElement;
        const statefulControl = screen.getByTestId('param-state');
        fireEvent.click(statefulControl);
        expect(statefulControl.textContent).toContain('1');

        const widthHandle = screen.getByLabelText('Kéo để đổi độ rộng bảng tùy chỉnh');
        fireEvent.pointerDown(widthHandle, { button: 0, clientX: 280, clientY: 100 });
        fireEvent.pointerMove(window, { clientX: 400, clientY: 100 });
        fireEvent.pointerUp(window);
        expect(panel.style.width).toBe('400px');
        await waitFor(() => expect(window.localStorage.getItem('prynx.dieline.sidebarWidth')).toBe('400'));

        fireEvent.click(screen.getByRole('button', { name: 'Tách bảng để di chuyển' }));
        expect(panel.classList.contains('dt-sidebar-floating')).toBe(true);
        expect(screen.getByTestId('param-state')).toBe(statefulControl);
        expect(statefulControl.textContent).toContain('1');

        const toolbar = panel.querySelector('.dt-sidebar-toolbar') as HTMLElement;
        fireEvent.pointerDown(toolbar, { button: 0, clientX: 20, clientY: 20 });
        fireEvent.pointerMove(window, { clientX: 120, clientY: 100 });
        fireEvent.pointerUp(window);
        expect(panel.style.left).toBe('120px');
        expect(panel.style.top).toBe('100px');

        const cornerHandle = screen.getByLabelText('Kéo để đổi kích thước bảng tùy chỉnh');
        fireEvent.pointerDown(cornerHandle, { button: 0, clientX: 400, clientY: 640 });
        fireEvent.pointerMove(window, { clientX: 450, clientY: 700 });
        fireEvent.pointerUp(window);
        expect(panel.style.width).toBe('450px');
        expect(panel.style.height).toBe('700px');

        fireEvent.click(screen.getByRole('button', { name: 'Ghim bảng vào cạnh trái' }));
        expect(panel.classList.contains('dt-sidebar-floating')).toBe(false);
        expect(screen.getByTestId('param-state')).toBe(statefulControl);
        expect(panel.style.width).toBe('450px');
    });

    it('đọc lại quyền Pro ngay trước khi xuất PDF và không dùng model cũ sau downgrade', () => {
        mocks.dieline = {
            params: { boxType: 'rte' },
            allPaths: [],
            panels: [],
        };
        mocks.requestFeatureAction.mockImplementation(() => false);
        render(<DielineTool />);
        fireEvent.click(screen.getByRole('button', { name: 'Mở trình sửa' }));

        fireEvent.click(screen.getByRole('button', { name: 'PDF kỹ thuật' }));
        expect(mocks.requestFeatureAction).toHaveBeenCalledWith('packaging.dieline', expect.any(Function));
        expect(mocks.downloadPDF).not.toHaveBeenCalled();

        mocks.requestFeatureAction.mockImplementation((_featureId: string, action: () => void) => { action(); return true; });
        fireEvent.click(screen.getByRole('button', { name: 'PDF kỹ thuật' }));
        expect(mocks.downloadPDF).toHaveBeenCalledOnce();
    });
});
