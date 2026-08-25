// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * RECIPE (audit 2026-08-17 §REC.4R): khi commit bị chặn (đang ghi quy trình mà
 * thao tác chưa nối vé), `onFileFixed` trả `false`. Tool KHÔNG được báo thành công
 * vì tài liệu đang mở không hề đổi. Trước bản vá, cửa chặn trả Promise<void> đã
 * resolve nên tool hiểu "bị chặn" là "đã thành công".
 */
const mocks = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
  getWorkingFile: vi.fn(),
  prepareFileForUpload: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../hooks/useWorkingPdf', () => ({
  useWorkingPdf: () => mocks.getWorkingFile,
}));
vi.mock('../../lib/api', () => ({
  authenticatedFetch: mocks.authenticatedFetch,
  getApiUrl: () => 'http://127.0.0.1:8321/api',
  prepareFileForUpload: mocks.prepareFileForUpload,
}));

import EncryptTool from './EncryptTool';

const LOCK_SUCCESS = 'preprocess.encrypt:khoa_thanh_cong';
type EncryptCommit = NonNullable<ComponentProps<typeof EncryptTool>['onFileFixed']>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getWorkingFile.mockResolvedValue(null);
  mocks.prepareFileForUpload.mockImplementation(async (file: File) => file);
  mocks.authenticatedFetch.mockResolvedValue({
    ok: true,
    blob: async () => new Blob(['pdf'], { type: 'application/pdf' }),
  });
});

function renderLockAndRun(onFileFixed: EncryptCommit) {
  render(
    <EncryptTool
      pdfFile={new File(['source'], 'source.pdf', { type: 'application/pdf' })}
      onFileFixed={onFileFixed}
    />,
  );
  // Nhập mật khẩu user để qua guard, rồi bấm "Chạy".
  const passwordInputs = document.querySelectorAll('input[type="password"]');
  fireEvent.change(passwordInputs[0], { target: { value: 'pw' } }); // user
  fireEvent.change(passwordInputs[1], { target: { value: 'pw' } }); // confirm
  const runButton = screen.getByRole('button', { name: 'preprocess.common:run' });
  fireEvent.click(runButton);
}

describe('Cửa chặn commit trả kết quả — §REC.4R', () => {
  it('commit bị chặn (false) thì KHÔNG hiện thông báo thành công', async () => {
    const onFileFixed = vi.fn(() => false);
    renderLockAndRun(onFileFixed);

    await waitFor(() => expect(onFileFixed).toHaveBeenCalledTimes(1));
    // Cho microtask/finally chạy hết.
    await Promise.resolve();
    expect(screen.queryByText(new RegExp(LOCK_SUCCESS))).toBeNull();
  });

  it('commit thành công (không phải false) thì hiện thông báo thành công', async () => {
    const onFileFixed = vi.fn(() => true);
    renderLockAndRun(onFileFixed);

    await waitFor(() => expect(onFileFixed).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(new RegExp(LOCK_SUCCESS))).toBeTruthy());
  });
});
