// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ToolMenuList from './ToolMenuList';

const mocks = vi.hoisted(() => ({
    requestActivation: vi.fn(),
    setActiveTool: vi.fn(),
    setTaskMode: vi.fn(),
}));

vi.mock('../../hooks/useToolActivationGuard', () => ({
    useToolActivationGuard: () => mocks.requestActivation,
}));

vi.mock('../../stores/appSettingsStore', () => ({
    useAppSettingsStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
        hiddenTools: [],
        favoriteTools: [],
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
        mocks.requestActivation.mockImplementation(() => false);
    });
    afterEach(cleanup);

    it('không đưa app standalone vào router workspace', () => {
        render(<ToolMenuList setActiveTool={mocks.setActiveTool} setTaskMode={mocks.setTaskMode} />);
        expect(screen.queryByText('Khuôn bế Bao bì')).toBeNull();
        expect(screen.queryByText('Thư viện vật tư in')).toBeNull();
        expect(screen.queryByText('So sánh PDF (In ấn)')).toBeNull();
    });

    it('Chữ & Font hiện badge Pro và không đổi store khi guard từ chối', () => {
        render(<ToolMenuList setActiveTool={mocks.setActiveTool} setTaskMode={mocks.setTaskMode} />);
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
        render(<ToolMenuList setActiveTool={mocks.setActiveTool} setTaskMode={mocks.setTaskMode} />);
        clickTool('Chữ & Font');
        expect(mocks.setActiveTool).toHaveBeenCalledWith('font_tools');
    });
});
