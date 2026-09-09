// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LicenseValidationOutcome } from '../../stores/useAuthStore';
import { clearJobCompletionAccess, rememberJobCompletionAccess } from '../../lib/jobCompletionAccess';

type OverlayStoreState = {
  isLicenseLocked: boolean;
  lockReason: string;
  retryValidation: () => Promise<void>;
  isRevoking: boolean;
  licenseRetryAt: number;
  licenseValidationOutcome: LicenseValidationOutcome;
  licenseValid?: boolean;
  licenseToken?: string | null;
  licenseServerStatus?: string | null;
  licenseKey?: string | null;
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
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) => {
        const message = messages[key] ?? String(options?.defaultValue ?? key);
        return message.replace(/\{\{(\w+)\}\}/g, (_match, field: string) => String(options?.[field] ?? ''));
      },
    }),
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
    licenseRetryAt: 0,
    licenseValidationOutcome,
  };
}

const NOW = new Date('2026-09-09T09:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

/** Token giả chỉ dùng cho metadata hiển thị; component không xác minh chữ ký. */
function offlineToken(hoursLeft: number): string {
  const thumbprint = 'A'.repeat(43);
  const deviceId = `d3_${thumbprint}`;
  const payload = JSON.stringify({
    v: 3,
    min_v: 3,
    iat: Math.floor(NOW.getTime() / 1000),
    exp: Math.floor((NOW.getTime() + hoursLeft * HOUR_MS) / 1000),
    cid: '018f0f5e-8d51-7f77-bbd5-f19db33c4b7a',
    d: deviceId,
    cnf: { jkt: thumbprint },
    m: deviceId,
    k: '0123456789abcdef',
    p: 'prynx',
  });
  return `${btoa(payload).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.fakesignature`;
}

describe('LicenseLockOverlay — phân loại trạng thái bản quyền', () => {
  beforeEach(() => {
    clearJobCompletionAccess();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    setOutcome('token_invalid', 'Không thể xác minh bản quyền.');
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
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

  it('hết hạn nhưng có việc đã gửi không phủ dialog chặn tải kết quả', () => {
    setOutcome('server_rejected', 'Bản quyền đã hết hạn.');
    mocks.state.licenseKey = 'TEST-KEY';
    mocks.state.licenseServerStatus = 'EXPIRED';
    rememberJobCompletionAccess('http://localhost:8321', {
      job_id: 'test-job', job_access_token: 'a'.repeat(64),
      job_access_expires_at: Math.floor(Date.now() / 1000) + 3600,
      job_access_paths: ['GET /api/jobs/test-job'],
    }, 'TEST-KEY');
    render(<LicenseLockOverlay />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.getByText(/cần gia hạn để tạo việc mới/)).toBeTruthy();
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
    expect(screen.queryByText(/checkpoint/i)).toBeNull();
    expect(screen.getByText(/Bạn không cần nhập lại key/)).toBeTruthy();
  });

  it.each(['anchor_missing', 'native_error'] as const)(
    '%s: hiện đếm ngược, chặn Retry và mở nút đúng khi hết thời gian chờ',
    async (outcome) => {
      setOutcome(outcome, 'Cần xác minh lại bản quyền.');
      mocks.state.licenseRetryAt = NOW.getTime() + 65_000;
      render(<LicenseLockOverlay />);

      const retry = mocks.state.retryValidation;
      const button = screen.getByRole('button', { name: 'Thử lại sau 01:05' }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
      expect(retry).not.toHaveBeenCalled();

      await act(async () => { await vi.advanceTimersByTimeAsync(64_001); });
      expect(screen.getByRole('button', { name: 'Thử lại sau 00:01' })).toBeTruthy();
      expect(button.disabled).toBe(true);

      await act(async () => { await vi.advanceTimersByTimeAsync(999); });
      expect(screen.getByRole('button', { name: 'Thử lại ngay' })).toBeTruthy();
      expect(button.disabled).toBe(false);
      await act(async () => { fireEvent.click(button); });
      expect(retry).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['valid_offline', 'rate_limited_offline'] as const)(
    '%s: không làm phiền khi phiên offline còn hơn 24 giờ',
    (outcome) => {
      setOutcome(outcome, '');
      Object.assign(mocks.state, {
        isLicenseLocked: false,
        licenseValid: true,
        licenseToken: offlineToken(72),
        licenseRetryAt: NOW.getTime() + 300_000,
      });

      render(<LicenseLockOverlay />);

      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.queryByRole('dialog')).toBeNull();
    },
  );

  it('nhận thời gian chờ mới khi banner đã mở lâu và mở nút khi store bỏ cooldown', async () => {
    setOutcome('network_error', 'Mạng tạm thời lỗi.');
    const view = render(<LicenseLockOverlay />);
    await act(async () => { await vi.advanceTimersByTimeAsync(HOUR_MS); });
    mocks.state.licenseRetryAt = Date.now() + 60_000;

    view.rerender(<LicenseLockOverlay />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(screen.getByRole('button', { name: 'Thử lại sau 01:00' })).toBeTruthy();
    mocks.state.licenseRetryAt = 0;
    view.rerender(<LicenseLockOverlay />);
    expect((screen.getByRole('button', { name: 'Thử lại ngay' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('phiên offline chỉ hiện nhắc kết nối khi còn từ 24 giờ trở xuống', async () => {
    setOutcome('valid_offline', '');
    Object.assign(mocks.state, {
      isLicenseLocked: false,
      licenseValid: true,
      licenseToken: offlineToken(24 + 1 / 60),
    });
    render(<LicenseLockOverlay />);
    expect(screen.queryByRole('status')).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(screen.getByText('Đang dùng phiên offline')).toBeTruthy();
    expect(screen.getByText(/24 giờ 0 phút/)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('hiện trạng thái phiên offline thay vì giả là đang online', () => {
    mocks.state = {
      isLicenseLocked: false,
      lockReason: '',
      retryValidation: vi.fn(async () => undefined),
      isRevoking: false,
      licenseRetryAt: 0,
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
      licenseRetryAt: 0,
      licenseValidationOutcome: 'network_error',
    };
    render(<LicenseLockOverlay />);

    // Validator reject vẫn phải được handler bắt và mở lại nút, không kẹt spinner.
    const button = screen.getByRole('button', { name: 'Thử lại ngay' });
    await act(async () => { fireEvent.click(button); });
    expect(retry).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});
