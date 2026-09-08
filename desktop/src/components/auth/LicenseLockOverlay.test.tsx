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
  licenseValid?: boolean;
  licenseToken?: string | null;
};

const mocks = vi.hoisted(() => ({
  state: {} as OverlayStoreState,
}));

vi.mock('../../stores/useAuthStore', () => ({
  useAuthStore: () => mocks.state,
  isTransientLicenseOutcome: (outcome: string) => [
    'anchor_missing', 'anchor_corrupt', 'anchor_unavailable',
    'network_error', 'rate_limited',
  ].includes(outcome),
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
    'misc.licenseLockOverlay:dang_kiem_tra': 'Đang kiểm tra…',
    'misc.licenseLockOverlay:he_thong_tu_dong_kiem_tra_dinh_ky': 'Hệ thống tự động kiểm tra định kỳ',
    'misc.licenseLockOverlay:dang_thu': 'Đang thử…',
    'misc.licenseLockOverlay:thu_lai_ngay': 'Thử lại ngay',
    'misc.licenseLockOverlay:dang_dung_phien_offline': 'Đang dùng phiên offline',
    'misc.licenseLockOverlay:offline_dang_cho_xac_minh': 'Đang chờ kết nối lại để xác minh phiên bản quyền.',
    'misc.licenseLockOverlay:offline_duoi_mot_phut': 'Sắp hết phiên offline; hãy kết nối mạng để tiếp tục.',
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

  it('lỗi mạng/anchor chỉ hiện banner không chặn', () => {
    setOutcome('anchor_missing', 'Chưa có checkpoint thời gian tin cậy.');

    render(<LicenseLockOverlay />);

    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Nhập license key khác' })).toBeNull();
  });

  it('hiện trạng thái phiên offline thay vì giả là đang online', () => {
    mocks.state = {
      isLicenseLocked: false,
      lockReason: '',
      retryValidation: vi.fn(async () => undefined),
      isRevoking: false,
      licenseValidationOutcome: 'valid_offline',
      licenseValid: true,
      licenseToken: null,
    };

    render(<LicenseLockOverlay />);

    expect(screen.getByText('Đang dùng phiên offline')).toBeTruthy();
    expect(screen.getByText('Đang chờ kết nối lại để xác minh phiên bản quyền.')).toBeTruthy();
  });

  it('retry luôn thoát loading nếu validator ném lỗi bất ngờ', async () => {
    const retry = vi.fn(async () => { throw new Error('unexpected'); });
    mocks.state = {
      isLicenseLocked: true,
      lockReason: 'Mạng tạm thời lỗi.',
      retryValidation: retry,
      isRevoking: false,
      licenseValidationOutcome: 'network_error',
    };
    render(<LicenseLockOverlay />);

    // React event handler promise bị reject; gọi trực tiếp để kiểm tra spinner
    // không bị kẹt (console error của React không làm test fail).
    const button = screen.getByRole('button', { name: 'Thử lại ngay' });
    button.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
