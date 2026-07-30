// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cancelLogoRebuildPreview,
  createLogoRebuildPreview,
  getLogoRebuildCapabilities,
} from '../../lib/logoRebuildApi';
import { saveBlob } from '../../lib/saveBlob';
import LogoRebuildWorkspace from './LogoRebuildWorkspace';

vi.mock('../../lib/logoRebuildApi', () => ({
  getLogoRebuildCapabilities: vi.fn(),
  createLogoRebuildPreview: vi.fn(),
  cancelLogoRebuildPreview: vi.fn(),
}));
vi.mock('../../lib/saveBlob', () => ({ saveBlob: vi.fn() }));

describe('LogoRebuildWorkspace', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getLogoRebuildCapabilities).mockResolvedValue({
      version: 'mvp-preflight-v1',
      modes: ['monochrome', 'fixed_palette'],
      supported_formats: ['png', 'jpeg', 'webp'],
      auto_color_enabled: false,
      preview_engine_enabled: true,
      engine: { engine: 'vtracer', version: '1.0.0-alpha.2', cancellable: true },
      limitations: [],
    });
    vi.mocked(cancelLogoRebuildPreview).mockResolvedValue(true);
    vi.mocked(saveBlob).mockResolvedValue({ kind: 'saved' });
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:logo-preview'),
      revokeObjectURL: vi.fn(),
    });
  });

  it('chỉ hiển thị hai mode đã duyệt, không có auto-color', async () => {
    render(<LogoRebuildWorkspace />);
    await waitFor(() => expect(screen.getByText(/vtracer 1.0.0-alpha.2/i)).toBeTruthy());

    expect(screen.getByRole('button', { name: 'Đen trắng' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Màu đã xác nhận' })).toBeTruthy();
    expect(screen.queryByText(/auto.?color/i)).toBeNull();
    expect((screen.getByLabelText('Cân bằng ánh sáng trên vải/ảnh chụp') as HTMLInputElement).checked).toBe(false);
  });

  it('gửi palette người dùng xác nhận và hiển thị SVG preview', async () => {
    vi.mocked(createLogoRebuildPreview).mockResolvedValue({
      status: 'ready',
      job_id: 'job-test',
      svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      width_px: 320,
      height_px: 180,
      warnings: [],
      engine: 'vtracer',
      engine_version: '1.0.0-alpha.2',
    });
    render(<LogoRebuildWorkspace />);
    await waitFor(() => expect(screen.getByText(/vtracer 1.0.0-alpha.2/i)).toBeTruthy());

    const file = new File(['png-data'], 'logo.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Chọn ảnh có logo'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Màu đã xác nhận' }));
    fireEvent.change(screen.getByLabelText('Mã màu 1'), { target: { value: '#233d69' } });
    fireEvent.change(screen.getByLabelText('Mã màu 2'), { target: { value: '#ef4444' } });
    fireEvent.click(screen.getByLabelText('Loại màu nền khỏi SVG'));
    fireEvent.click(screen.getByRole('button', { name: 'Tạo preview SVG' }));

    await waitFor(() => expect(createLogoRebuildPreview).toHaveBeenCalledTimes(1));
    const [, settings] = vi.mocked(createLogoRebuildPreview).mock.calls[0];
    expect(settings.mode).toBe('fixed_palette');
    expect(settings.palette).toEqual(['#233d69', '#ef4444']);
    expect(settings.background_color).toBe('#ffffff');
    expect(settings.smoothing).toBe(1);
    expect(settings.illumination_correction).toBe(false);
    expect(await screen.findByAltText('SVG vector đã dựng')).toBeTruthy();
    expect((screen.getByRole('button', { name: /Tải SVG/ }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /Tải SVG/ }));
    await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveBlob).mock.calls[0][1]).toBe('logo_vector.svg');
    expect(vi.mocked(saveBlob).mock.calls[0][2]).toEqual({
      title: 'Lưu file SVG',
      filterName: 'SVG',
      extensions: ['svg'],
    });

    vi.mocked(saveBlob).mockRejectedValueOnce(new Error('Không ghi được SVG.'));
    fireEvent.click(screen.getByRole('button', { name: /Tải SVG/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('Không ghi được SVG.');
    expect((screen.getByRole('button', { name: /Tải SVG/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('hoàn tác, làm lại và vô hiệu preview khi cấu hình đổi', async () => {
    vi.mocked(createLogoRebuildPreview).mockResolvedValue({
      status: 'ready',
      job_id: 'history-job',
      svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      width_px: 100,
      height_px: 100,
      warnings: [],
      engine: 'vtracer',
      engine_version: '1.0.0-alpha.2',
    });
    render(<LogoRebuildWorkspace />);
    await waitFor(() => expect(screen.getByText(/vtracer 1.0.0-alpha.2/i)).toBeTruthy());

    const file = new File(['png-data'], 'history.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Chọn ảnh có logo'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Tạo preview SVG' }));
    await screen.findByAltText('SVG vector đã dựng');
    expect(screen.getByText(/Preview đã sẵn sàng/)).toBeTruthy();

    const download = screen.getByRole('button', { name: /Tải SVG/ }) as HTMLButtonElement;
    expect(download.disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Màu đã xác nhận' }));
    expect(download.disabled).toBe(true);
    expect(screen.queryByAltText('SVG vector đã dựng')).toBeNull();
    expect(screen.queryByText(/Preview đã sẵn sàng/)).toBeNull();

    const undo = screen.getByRole('button', { name: 'Hoàn tác' }) as HTMLButtonElement;
    const redo = screen.getByRole('button', { name: 'Làm lại' }) as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    fireEvent.click(undo);
    expect(screen.getByRole('button', { name: 'Đen trắng' }).getAttribute('aria-pressed')).toBe('true');
    expect(redo.disabled).toBe(false);
    fireEvent.click(redo);
    expect(screen.getByRole('button', { name: 'Màu đã xác nhận' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('bỏ response preview trễ sau khi cấu hình đổi', async () => {
    let resolvePreview!: (value: Awaited<ReturnType<typeof createLogoRebuildPreview>>) => void;
    vi.mocked(createLogoRebuildPreview).mockReturnValue(new Promise(resolve => { resolvePreview = resolve; }));
    render(<LogoRebuildWorkspace />);
    await waitFor(() => expect(screen.getByText(/vtracer 1.0.0-alpha.2/i)).toBeTruthy());

    const file = new File(['png-data'], 'stale.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Chọn ảnh có logo'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Tạo preview SVG' }));
    fireEvent.click(screen.getByRole('button', { name: 'Màu đã xác nhận' }));
    resolvePreview({
      status: 'ready',
      job_id: 'stale-job',
      svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      width_px: 100,
      height_px: 100,
      warnings: [],
      engine: 'vtracer',
      engine_version: '1.0.0-alpha.2',
    });

    await waitFor(() => expect(screen.queryByAltText('SVG vector đã dựng')).toBeNull());
    expect((screen.getByRole('button', { name: /Tải SVG/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('hủy job cũ không nhận response trễ và không abort nhầm job mới', async () => {
    let resolveFirst!: (value: Awaited<ReturnType<typeof createLogoRebuildPreview>>) => void;
    let resolveSecond!: (value: Awaited<ReturnType<typeof createLogoRebuildPreview>>) => void;
    let resolveCancel!: (value: boolean) => void;
    vi.mocked(createLogoRebuildPreview)
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve; }));
    vi.mocked(cancelLogoRebuildPreview).mockReturnValue(new Promise(resolve => { resolveCancel = resolve; }));

    render(<LogoRebuildWorkspace />);
    await waitFor(() => expect(screen.getByText(/vtracer 1.0.0-alpha.2/i)).toBeTruthy());
    const file = new File(['png-data'], 'cancel.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Chọn ảnh có logo'), { target: { files: [file] } });

    fireEvent.click(screen.getByRole('button', { name: 'Tạo preview SVG' }));
    const firstSignal = vi.mocked(createLogoRebuildPreview).mock.calls[0][3] as AbortSignal;
    fireEvent.click(screen.getByTitle('Hủy preview'));
    await waitFor(() => expect(cancelLogoRebuildPreview).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(firstSignal.aborted).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Tạo preview SVG' }));
    const secondSignal = vi.mocked(createLogoRebuildPreview).mock.calls[1][3] as AbortSignal;
    await act(async () => {
      resolveFirst({
        status: 'ready',
        job_id: 'cancelled-job',
        svg: '<svg xmlns="http://www.w3.org/2000/svg" data-job="cancelled"/>',
        width_px: 100,
        height_px: 100,
        warnings: [],
        engine: 'vtracer',
        engine_version: '1.0.0-alpha.2',
      });
      resolveCancel(true);
      await Promise.resolve();
    });

    expect(secondSignal.aborted).toBe(false);
    expect(screen.queryByAltText('SVG vector đã dựng')).toBeNull();

    await act(async () => {
      resolveSecond({
        status: 'ready',
        job_id: 'current-job',
        svg: '<svg xmlns="http://www.w3.org/2000/svg" data-job="current"/>',
        width_px: 100,
        height_px: 100,
        warnings: [],
        engine: 'vtracer',
        engine_version: '1.0.0-alpha.2',
      });
    });
    expect(await screen.findByAltText('SVG vector đã dựng')).toBeTruthy();
  });

  it('không tạo Blob URL mới khi response về sau lúc đóng workspace', async () => {
    let resolvePreview!: (value: Awaited<ReturnType<typeof createLogoRebuildPreview>>) => void;
    vi.mocked(createLogoRebuildPreview).mockReturnValue(new Promise(resolve => { resolvePreview = resolve; }));
    const { unmount } = render(<LogoRebuildWorkspace />);
    await waitFor(() => expect(screen.getByText(/vtracer 1.0.0-alpha.2/i)).toBeTruthy());

    const file = new File(['png-data'], 'unmount.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Chọn ảnh có logo'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Tạo preview SVG' }));
    const signal = vi.mocked(createLogoRebuildPreview).mock.calls[0][3] as AbortSignal;
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
    const objectUrlCallsBeforeUnmount = vi.mocked(URL.createObjectURL).mock.calls.length;

    unmount();
    await waitFor(() => expect(signal.aborted).toBe(true));
    await act(async () => {
      resolvePreview({
        status: 'ready',
        job_id: 'unmounted-job',
        svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
        width_px: 100,
        height_px: 100,
        warnings: [],
        engine: 'vtracer',
        engine_version: '1.0.0-alpha.2',
      });
    });
    expect(URL.createObjectURL).toHaveBeenCalledTimes(objectUrlCallsBeforeUnmount);
  });

  it('đóng phiên gộp history tại cấu hình đã dùng để tạo preview', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      vi.mocked(createLogoRebuildPreview).mockResolvedValue({
        status: 'ready',
        job_id: 'history-boundary',
        svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
        width_px: 100,
        height_px: 100,
        warnings: [],
        engine: 'vtracer',
        engine_version: '1.0.0-alpha.2',
      });
      render(<LogoRebuildWorkspace />);
      await waitFor(() => expect(screen.getByText(/vtracer 1.0.0-alpha.2/i)).toBeTruthy());
      const file = new File(['png-data'], 'coalesce.png', { type: 'image/png' });
      fireEvent.change(screen.getByLabelText('Chọn ảnh có logo'), { target: { files: [file] } });

      const smoothing = screen.getByLabelText('Độ mượt') as HTMLInputElement;
      fireEvent.change(smoothing, { target: { value: '0.4' } });
      fireEvent.click(screen.getByRole('button', { name: 'Tạo preview SVG' }));
      await screen.findByAltText('SVG vector đã dựng');
      fireEvent.change(smoothing, { target: { value: '0.3' } });
      fireEvent.click(screen.getByRole('button', { name: 'Hoàn tác' }));
      expect(smoothing.value).toBe('0.4');
    } finally {
      now.mockRestore();
    }
  });
  it('chỉ nhận phím tắt hoàn tác khi workspace thuộc tab đang hoạt động', async () => {
    const { rerender } = render(<LogoRebuildWorkspace isActive />);
    await waitFor(() => expect(screen.getByText(/vtracer 1.0.0-alpha.2/i)).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Màu đã xác nhận' }));
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect(screen.getByRole('button', { name: 'Đen trắng' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Màu đã xác nhận' }));
    const smoothing = screen.getByLabelText('Độ mượt') as HTMLInputElement;
    fireEvent.change(smoothing, { target: { value: '0.8' } });
    fireEvent.keyDown(smoothing, { key: 'z', ctrlKey: true });
    expect(smoothing.value).toBe('1');

    const colorCode = screen.getByLabelText('Mã màu 1') as HTMLInputElement;
    fireEvent.change(colorCode, { target: { value: '#123456' } });
    fireEvent.keyDown(colorCode, { key: 'z', ctrlKey: true });
    expect(colorCode.value).toBe('#123456');

    rerender(<LogoRebuildWorkspace isActive={false} />);
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect(screen.getByRole('button', { name: 'Màu đã xác nhận' }).getAttribute('aria-pressed')).toBe('true');
  });
});
