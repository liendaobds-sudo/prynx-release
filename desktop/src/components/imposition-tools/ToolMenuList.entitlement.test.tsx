// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ToolMenuList from './ToolMenuList';
import { createWorkspaceStore, WorkspaceContext } from '../../stores/useWorkspaceStore';
import { TOOL_CATEGORIES, getToolUniqueKey, getToolsByCategory } from '../../lib/toolRegistry';

const mocks = vi.hoisted(() => ({
    requestActivation: vi.fn(),
    setActiveTool: vi.fn(),
    setTaskMode: vi.fn(),
    onActiveToolChange: vi.fn(),
    hiddenTools: [] as string[],
    favoriteTools: [] as string[],
}));

vi.mock('../../hooks/useToolActivationGuard', () => ({
    useToolActivationGuard: () => mocks.requestActivation,
}));

vi.mock('../../stores/appSettingsStore', () => ({
    useAppSettingsStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
        hiddenTools: mocks.hiddenTools,
        favoriteTools: mocks.favoriteTools,
        toggleFavoriteTool: vi.fn(),
        collapsedSections: {},
        toggleSection: vi.fn(),
    }),
}));

vi.mock('../license/ProFeatureBadge', () => ({
    default: ({ featureId }: { featureId: string }) => <span data-testid={`badge-${featureId}`}>PRO</span>,
}));

vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../i18n', () => ({ tv: (value: string) => value }));

function renderToolMenu(activeTool = 'none', onActiveToolChange?: (tool: string) => void, query = '') {
    const workspaceStore = createWorkspaceStore();
    workspaceStore.getState().setToolMenuQuery(query);
    return render(
        <WorkspaceContext.Provider value={workspaceStore}>
            <ToolMenuList
                setActiveTool={mocks.setActiveTool}
                setTaskMode={mocks.setTaskMode}
                activeTool={activeTool}
                onActiveToolChange={onActiveToolChange}
            />
        </WorkspaceContext.Provider>,
    );
}

function clickTool(label: string) {
    const text = screen.getByText(label);
    const target = text.closest('[role="button"]');
    if (!target) throw new Error(`Không tìm thấy nút ${label}`);
    fireEvent.click(target);
}

describe('ToolMenuList entitlement', () => {
    beforeEach(() => {
        mocks.requestActivation.mockReset();
        mocks.setActiveTool.mockReset();
        mocks.setTaskMode.mockReset();
        mocks.onActiveToolChange.mockReset();
        mocks.hiddenTools = [];
        mocks.favoriteTools = [];
        mocks.requestActivation.mockImplementation(() => false);
    });
    afterEach(cleanup);

    it('không đưa app standalone vào router workspace', () => {
        renderToolMenu();
        expect(screen.queryByText('Khuôn bế Bao bì')).toBeNull();
        expect(screen.queryByText('Thư viện vật tư in')).toBeNull();
        expect(screen.queryByText('So sánh PDF (In ấn)')).toBeNull();
    });

    it('Chữ & Font hiện badge Pro và không đổi store khi guard từ chối', () => {
        renderToolMenu();
        expect(screen.getAllByTestId('badge-prepress.preflight').length).toBeGreaterThanOrEqual(2);
        clickTool('Chữ & Font');

        expect(mocks.requestActivation).toHaveBeenCalledWith(
            expect.objectContaining({ featureId: 'prepress.preflight' }),
            expect.any(Function),
        );
        expect(mocks.setActiveTool).not.toHaveBeenCalled();
    });

    it('chỉ đổi tool sau khi guard cho phép', () => {
        mocks.requestActivation.mockImplementation((_tool, action: () => void) => { action(); return true; });
        renderToolMenu();
        clickTool('Chữ & Font');
        expect(mocks.setActiveTool).toHaveBeenCalledWith('font_tools');
    });

    it('click lại tool đang mở sẽ đóng panel thiết lập', () => {
        renderToolMenu('font_tools');
        clickTool('Chữ & Font');

        expect(mocks.requestActivation).not.toHaveBeenCalled();
        expect(mocks.setActiveTool).toHaveBeenCalledWith('none');
    });

    it('cho parent xử lý cleanup khi đóng tool đang mở', () => {
        renderToolMenu('font_tools', mocks.onActiveToolChange);
        clickTool('Chữ & Font');

        expect(mocks.requestActivation).not.toHaveBeenCalled();
        expect(mocks.onActiveToolChange).toHaveBeenCalledWith('none');
        expect(mocks.setActiveTool).not.toHaveBeenCalled();
    });

    it('ẩn mọi header nhóm gốc khi toàn bộ công cụ workspace đã được yêu thích', () => {
        mocks.favoriteTools = TOOL_CATEGORIES
            .flatMap(category => getToolsByCategory(category.id))
            .map(getToolUniqueKey);

        renderToolMenu();

        for (const category of TOOL_CATEGORIES.filter(item => item.id !== 'qc')) {
            expect(screen.queryByText(category.title)).toBeNull();
        }
    });

    it('không lặp công cụ yêu thích khi đang tìm kiếm', () => {
        const fontTool = getToolsByCategory('print').find(tool => getToolUniqueKey(tool) === 'font_tools');
        expect(fontTool).toBeDefined();
        mocks.favoriteTools = ['font_tools'];

        renderToolMenu('none', undefined, fontTool!.title);

        expect(screen.getAllByText(fontTool!.title)).toHaveLength(1);
    });

    it('chỉ hiển thị mỗi công cụ yêu thích một lần', () => {
        const fontTool = getToolsByCategory('print').find(tool => getToolUniqueKey(tool) === 'font_tools');
        expect(fontTool).toBeDefined();
        mocks.favoriteTools = ['font_tools'];

        renderToolMenu();

        expect(screen.getAllByText(fontTool!.title)).toHaveLength(1);
    });

    it('giữ header nhóm trong block flow, không để flex co sập', () => {
        mocks.favoriteTools = ['font_tools'];

        renderToolMenu();

        const fileCategory = TOOL_CATEGORIES.find(category => category.id === 'file');
        expect(fileCategory).toBeDefined();
        for (const label of ['imposition.toolMenuList:cong_cu_yeu_thich', fileCategory!.title]) {
            const header = screen.getByText(label).closest('button');
            const catalog = header?.parentElement?.parentElement;
            expect(catalog?.className).not.toContain('flex-col');
            expect(catalog?.getAttribute('style')).toBeNull();
        }
    });

    it('dùng cùng metric hiển thị cân đối như danh mục công cụ ở Home', () => {
        renderToolMenu();

        const search = screen.getByLabelText('imposition.toolMenuList:tim_cong_cu');
        const searchWrapper = search.parentElement;
        const catalog = searchWrapper?.parentElement;
        expect(catalog?.className).toContain('px-3');
        expect(catalog?.className).toContain('py-4');
        expect(catalog?.className).toContain('overflow-x-hidden');
        expect(searchWrapper?.className).toContain('mb-3');
        expect(search.className).toContain('h-9');

        const fileCategory = TOOL_CATEGORIES.find(category => category.id === 'file');
        expect(fileCategory).toBeDefined();
        const sectionButton = screen.getByText(fileCategory!.title).closest('button');
        const sectionHeader = sectionButton?.parentElement;
        expect(sectionHeader?.className).toContain('mt-5');
        expect(sectionHeader?.className).toContain('mb-3');
        expect(sectionHeader?.className).toContain('px-1');
        expect(sectionButton?.className).toContain('gap-2');
        expect(sectionButton?.className).not.toContain('justify-between');
        expect(sectionButton?.getAttribute('aria-expanded')).toBe('true');

        const firstTool = getToolsByCategory(fileCategory!.id).find(tool => getToolUniqueKey(tool) !== 'none');
        expect(firstTool).toBeDefined();
        const toolLabel = screen.getByText(firstTool!.title);
        const toolButton = toolLabel.closest('[role="button"]');
        const toolList = toolButton?.parentElement?.parentElement;
        expect(toolList?.className).toContain('gap-[6px]');
        expect(toolList?.className).toContain('mt-1');
        expect(toolList?.className).toContain('mb-2');
        expect(toolLabel.className).toContain('text-[13.5px]');
    });
});
