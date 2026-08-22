// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SettingsModal from './SettingsModal';
import { useAppSettingsStore } from '../stores/appSettingsStore';

vi.mock('../stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    licensePlan: 'free',
    licenseFeatures: null,
  }),
}));

afterEach(() => {
  cleanup();
  useAppSettingsStore.setState({ hiddenTools: [], favoriteTools: [] });
});

describe('SettingsModal — phân loại công cụ Pro', () => {
  it('hiển thị badge theo featureId trong danh sách quản lý công cụ', () => {
    render(<SettingsModal onClose={vi.fn()} />);

    expect(screen.getByText('Trim & Shift')).toBeTruthy();
    expect(document.querySelector('[data-feature-id="pdf.trim_shift"]')?.textContent).toContain('PRO');

    expect(screen.getByText('Cắt khổ trang (Crop)')).toBeTruthy();
    expect(document.querySelector('[data-feature-id="pdf.crop"]')).toBeNull();
  });
});
