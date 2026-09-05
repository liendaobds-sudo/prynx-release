// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LicenseValidationOutcome } from '../../stores/useAuthStore';

type OverlayStoreState = {
  isLicenseLocked: boolean;
  lockReason: string;
  retryValidation: () => Promise<void>;
  isRevoking: boolean;
  licenseValidationOutcome: LicenseValidationOutcome;
};

const mocks = vi.hoisted(() => ({
  state: {} as OverlayStoreState,
}));

vi.mock('../../stores/useAuthStore', () => ({
  useAuthStore: () => mocks.state,
}));

vi.mock('./ChangeLicenseKeyPanel', () => ({
  default: () => null,
}));

vi.mock('react-i18next', () => {
  const messages: Record<string, string> = {
    'misc.licenseLockOverlay:ban_quyen_da_bi_thu_hoi': 'Bản quyền đã bị thu hồi',
    'misc.licenseLockOverlay:ban_quyen_da_het_han': 'Bản quyền đã hết hạn',
    'misc.licenseLockOverlay:dat_gioi_han_thiet_bi': 'Đã đạt giới hạn thiết bị',
    'misc.licenseLockOverlay:khong_the_xac_minh_ban_quyen': 'Không thể xác minh bản quyền',
  };
  return {
    useTranslation: () => ({ t: (key: string) => messages[key] ?? key }),
  };
});

import LicenseLockOverlay from './LicenseLockOverlay';

function setOutcome(
  licenseValidationOutcome: LicenseValidationOutcome,
  lockReason: string,
): void {
  mocks.state = {
    isLicenseLocked: true,
    lockReason,
    retryValidation: vi.fn(async () => undefined),
    isRevoking: false,
    licenseValidationOutcome,
  };
}

describe('LicenseLockOverlay — phân loại trạng thái bản quyền', () => {
  beforeEach(() => {
    setOutcome('token_invalid', 'Không thể xác minh bản quyền.');
  });

  afterEach(() => {
    cleanup();
  });

  it('token_invalid không bị gắn nhầm nhãn thu hồi dù câu mô tả có chữ thu hồi', () => {
    setOutcome('token_invalid', 'Bản quyền đã bị thu hồi');

    render(<LicenseLockOverlay />);

    expect(screen.getByRole('heading', {
      level: 2,
      name: 'Không thể xác minh bản quyền',
    })).toBeTruthy();
    expect(screen.queryByRole('heading', {
      level: 2,
      name: 'Bản quyền đã bị thu hồi',
    })).toBeNull();
  });

  it('chỉ server_rejected mới hiện tiêu đề bản quyền đã bị thu hồi', () => {
    setOutcome('server_rejected', 'Bản quyền không còn hợp lệ.');

    render(<LicenseLockOverlay />);

    expect(screen.getByRole('heading', {
      level: 2,
      name: 'Bản quyền đã bị thu hồi',
    })).toBeTruthy();
  });

  it('device_limit hiện đúng giới hạn thiết bị, không hiện thu hồi', () => {
    setOutcome('device_limit', 'Khóa bản quyền đã đạt giới hạn thiết bị.');

    render(<LicenseLockOverlay />);

    expect(screen.getByRole('heading', {
      level: 2,
      name: 'Đã đạt giới hạn thiết bị',
    })).toBeTruthy();
    expect(screen.queryByRole('heading', {
      level: 2,
      name: 'Bản quyền đã bị thu hồi',
    })).toBeNull();
  });
});
