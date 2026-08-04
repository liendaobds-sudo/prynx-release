// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ProFeatureBadge from './ProFeatureBadge';

const access = vi.hoisted(() => ({ allowed: false }));

vi.mock('../../stores/useAuthStore', () => ({
    useAuthStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
        licensePlan: 'free',
        licenseFeatures: null,
    }),
}));

vi.mock('../../lib/license/features', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../lib/license/features')>();
    return { ...actual, canUse: () => access.allowed };
});

afterEach(() => {
    cleanup();
    access.allowed = false;
});

describe('ProFeatureBadge', () => {
    it('PRO luôn là phân loại, ổ khóa chỉ phản ánh trạng thái quyền', () => {
        const view = render(<ProFeatureBadge featureId="prepress.preflight" />);
        expect(screen.getByText('🔒 PRO').getAttribute('data-locked')).toBe('true');

        access.allowed = true;
        view.rerender(<ProFeatureBadge featureId="prepress.preflight" />);
        expect(screen.getByText('PRO').getAttribute('data-locked')).toBe('false');
    });

    it('không gắn badge Pro cho capability Free', () => {
        render(<ProFeatureBadge featureId="pdf.crop" />);
        expect(screen.queryByText(/PRO/)).toBeNull();
    });
});
