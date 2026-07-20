// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MockupArtworkPanel from '../MockupArtworkPanel';
import { useBoxStore } from '../../../store/useBoxStore';
import { useMockupStore } from '../../../store/useMockupStore';
import { generateDieline } from '../../../lib/dieline/engine';
import { DEFAULT_PARAMS } from '../../../lib/dieline/types';

vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    }),
}));
vi.mock('../../../i18n', () => ({ tv: (value: string) => value }));

describe('MockupArtworkPanel matchbox artwork separation', () => {
    beforeEach(() => {
        useMockupStore.getState().resetMockup();
        const params = { ...DEFAULT_PARAMS, boxType: 'tray' as const, L: 200, W: 150, D: 40, T: 1 };
        useBoxStore.setState({ params, dieline: generateDieline(params), isModelCurrent: true });
    });

    afterEach(() => {
        cleanup();
        useMockupStore.getState().resetMockup();
    });

    it('shows independent upload sections for tray and sleeve', () => {
        render(<MockupArtworkPanel />);
        expect(screen.getAllByText('Ảnh khay').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Ảnh vỏ hộp').length).toBeGreaterThan(0);
        expect(screen.queryByText('dieline.mockupArtwork:anh_mat_ngoai')).toBeNull();
    });
});