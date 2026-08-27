// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import HomeTab from './HomeTab';
import { TOOL_CATEGORIES, getToolUniqueKey, getToolsByCategory } from '../lib/toolRegistry';
import { useAppSettingsStore } from '../stores/appSettingsStore';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('./RecentFiles/RecentFilesGrid', () => ({ default: () => null }));
vi.mock('./ToolHelpModal', () => ({ default: () => null }));
vi.mock('./license/ProFeatureBadge', () => ({ default: () => null }));
vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../i18n', () => ({ tv: (value: string) => value }));

describe('HomeTab — phân loại menu công cụ', () => {
    beforeEach(() => {
        useAppSettingsStore.setState({
            hiddenTools: [],
            favoriteTools: [],
            toolMenuMode: 'full',
            homeToolMenuWidth: 320,
            collapsedSections: {},
        });
    });

    afterEach(() => {
        cleanup();
        useAppSettingsStore.setState({ hiddenTools: [], favoriteTools: [] });
    });

    it('ẩn mọi header nhóm gốc khi toàn bộ công cụ đã được yêu thích', () => {
        useAppSettingsStore.setState({
            favoriteTools: TOOL_CATEGORIES
                .flatMap(category => getToolsByCategory(category.id))
                .map(getToolUniqueKey),
        });

        render(<HomeTab onOpenApp={vi.fn()} isActive={false} />);

        for (const category of TOOL_CATEGORIES) {
            expect(screen.queryByText(category.title)).toBeNull();
        }
    });

    it('chỉ hiển thị mỗi công cụ yêu thích một lần', () => {
        const favoriteTool = getToolsByCategory('file')[0];
        expect(favoriteTool).toBeDefined();
        useAppSettingsStore.setState({
            favoriteTools: [getToolUniqueKey(favoriteTool!)],
        });

        render(<HomeTab onOpenApp={vi.fn()} isActive={false} />);

        expect(screen.getAllByText(favoriteTool!.title)).toHaveLength(1);
    });
});
