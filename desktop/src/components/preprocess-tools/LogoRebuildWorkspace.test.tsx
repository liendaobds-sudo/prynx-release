// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cancelLogoRebuildPreview,
  createLogoRebuildPreview,
  getLogoRebuildCapabilities,
  preflightLogoRebuild,
} from '../../lib/logoRebuildApi';
import { saveBlob } from '../../lib/saveBlob';
import LogoRebuildWorkspace from './LogoRebuildWorkspace';

vi.mock('../../lib/logoRebuildApi', () => ({
  getLogoRebuildCapabilities: vi.fn(),
  preflightLogoRebuild: vi.fn(),
  createLogoRebuildPreview: vi.fn(),
  cancelLogoRebuildPreview: vi.fn(),
}));
vi.mock('../../lib/saveBlob', () => ({ saveBlob: vi.fn() }));

async function selectFileAndApplySuggestedPalette(filename: string): Promise<File> {
  const file = new File(['png-data'], filename, { type: 'image/png' });
  fireEvent.change(screen.getByLabelText('Chọn ảnh có logo'), { target: { files: [file] } });
  fireEvent.click(await screen.findByRole('button', { name: 'Áp dụng gợi ý' }));
  return file;
}

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
    vi.mocked(preflightLogoRebuild).mockResolvedValue({
      status: 'ready',
      source: {
        width_px: 320,
        height_px: 180,
        mode: 'RGBA',
        format: 'PNG',
        file_size_bytes: 8,
        has_alpha: true,
        has_icc_profile: false,
        dpi: null,
      },
      settings: {
        mode: 'fixed_palette',
        palette: ['#000000', '#ffffff'],
        smoothing: 0,
        despeckle_size_px: 4,
        illumination_correction: false,
      },
      palette_suggestions: [
        { color: '#233d69', coverage_ratio: 0.7 },
        { color: '#ef4444', coverage_ratio: 0.3 },
      ],
      warnings: [],
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
    expect(screen.getByRole('button', { name: 'Logo màu' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByLabelText('Độ mượt đường cong') as HTMLInputElement).value).toBe('0');
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
    fireEvent.change(screen.getByLabelText('Mã màu 1'), { target: { value: '#233d69' } });
    fireEvent.change(screen.getByLabelText('Mã màu 2'), { target: { value: '#ef4444' } });
    fireEvent.click(screen.getByLabelText('Loại màu nền khỏi SVG'));
    fireEvent.click(screen.getByRole('button', { name: 'Tạo preview SVG' }));

    await waitFor(() => expect(createLogoRebuildPreview).toHaveBeenCalledTimes(1));
    const [, settings] = vi.mocked(createLogoRebuildPreview).mock.calls[0];
    expect(settings.mode).toBe('fixed_palette');
    expect(settings.palette).toEqual(['#233d69', '#ef4444']);
    expect(settings.background_color).toBe('#ffffff');
    expect(settings.smoothing).toBe(0);
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

  it('không tự áp dụng palette gợi ý và Undo khôi phục palette trước đó', async () => {
    render(<LogoRebuildWorkspace />);
    await waitFor(() => expect(screen.getByText(/vtracer 1.0.0-alpha.2/i)).toBeTruthy());

    const file = new File(['png-data'], 'suggestions.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Chọn ảnh có logo'), { target: { files: [file] } });
    const apply = await screen.findByRole('button', { name: 'Áp dụng gợi ý' });

    expect((screen.getByLabelText('Mã màu 1') as HTMLInputElement).value).toBe('#000000');
    expect((screen.getByLabelText('Mã màu 2') as HTMLInputElement).value).toBe('#ffffff');

    fireEvent.click(screen.getByRole('button', { name: 'Tạo preview SVG' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Hãy áp dụng bảng màu');
    expect(createLogoRebuildPreview).not.toHaveBeenCalled();

    fireEvent.click(apply);
    expect((screen.getByLabelText('Mã màu 1') as HTMLInputElement).value).toBe('#233d69');
    expect((screen.getByLabelText('Mã màu 2') as HTMLInputElement).value).toBe('#ef4444');

    fireEvent.click(screen.getByRole('button', { name: 'Hoàn tác' }));
    expect((screen.getByLabelText('Mã màu 1') as HTMLInputElement).value).toBe('#000000');
    expect((screen.getByLabelText('Mã màu 2') as HTMLInputElement).value).toBe('#ffffff');
  });

  it('bỏ response preflight trễ của file cũ', async () => {
    type PreflightResult = Awaited<ReturnType<typeof preflightLogoRebuild>>;
    const resultFor = (color: string): PreflightResult => ({
      status: 'ready',
      source: {
        width_px: 100,
        height_px: 100,
        mode: 'RGB',
        format: 'PNG',
        file_size_bytes: 8,
        has_alpha: false,
        has_icc_profile: false,
        dpi: null,
      },
      settings: {
        mode: 'fixed_palette',
        palette: ['#000000'],
        smoothing: 0,
        despeckle_size_px: 4,
        illumination_correction: false,
      },
      palette_suggestions: [{ color, coverage_ratio: 1 }],
      warnings: [],
      limitations: [],
    });
    let resolveFirst!: (value: PreflightResult) => void;
    let resolveSecond!: (value: PreflightResult) => void;
    vi.mocked(preflightLogoRebuild)
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve; }));

    render(<LogoRebuildWorkspace />);
    await waitFor(() => expect(screen.getByText(/vtracer 1.0.0-alpha.2/i)).toBeTruthy());

    const first = new File(['first'], 'first.png', { type: 'image/png' });
    const second = new File(['second'], 'second.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Chọn ảnh có logo'), { target: { files: [first] } });
    fireEvent.change(screen.getByLabelText('Chọn ảnh có logo'), { target: { files: [second] } });

    await act(async () => {
      resolveSecond(resultFor('#00ff00'));
      await Promise.resolve();
    });
    expect(await screen.findByText('#00ff00')).toBeTruthy();

    await act(async () => {
      resolveFirst(resultFor('#ff0000'));
      await Promise.resolve();
    });
    expect(screen.queryByText('#ff0000')).toBeNull();
    expect(screen.getByText('#00ff00')).toBeTruthy();
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

    await selectFileAndApplySuggestedPalette('history.png');
    fireEvent.click(screen.getByRole('button', { name: 'Tạo preview SVG' }));
    await screen.findByAltText('SVG vector đã dựng');
    expect(screen.getByText(/Preview đã sẵn sàng/)).toBeTruthy();

    const download = screen.getByRole('button', { name: /Tải SVG/ }) as HTMLButtonElement;
    expect(download.disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Đen trắng' }));
    expect(download.disabled).toBe(true);
    expect(screen.queryByAltText('SVG vector đã dựng')).toBeNull();
    expect(screen.queryByText(/Preview đã sẵn sàng/)).toBeNull();

    const undo = screen.getByRole('button', { name: 'Hoàn tác' }) as HTMLButtonElement;
    const redo = screen.getByRole('button', { name: 'Làm lại' }) as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    fireEvent.click(undo);
    expect(screen.getByRole('button', { name: 'Logo màu' }).getAttribute('aria-pressed')).toBe('true');
    expect(redo.disabled).toBe(false);
    fireEvent.click(redo);
    expect(screen.getByRole('button', { name: 'Đen trắng' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('bỏ response preview trễ sau khi cấu hình đổi', async () => {
    let resolvePreview!: (value: Awaited<ReturnType<typeof createLogoRebuildPreview>>) => void;
    vi.mocked(createLogoRebuildPreview).mockReturnValue(new Promise(resolve => { resolvePreview = resolve; }));
    render(<LogoRebuildWorkspace />);
    await waitFor(() => expect(screen.getByText(/vtracer 1.0.0-alpha.2/i)).toBeTruthy());

    await selectFileAndApplySuggestedPalette('stale.png');
    fireEvent.click(screen.getByRole('button', { name: 'Tạo preview SVG' }));
    fireEvent.click(screen.getByRole('button', { name: 'Đen trắng' }));
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
    await selectFileAndApplySuggestedPalette('cancel.png');

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

    await selectFileAndApplySuggestedPalette('unmount.png');
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
      await selectFileAndApplySuggestedPalette('coalesce.png');

      const smoothing = screen.getByLabelText('Độ mượt đường cong') as HTMLInputElement;
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

    fireEvent.click(screen.getByRole('button', { name: 'Đen trắng' }));
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect(screen.getByRole('button', { name: 'Logo màu' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Đen trắng' }));
    const smoothing = screen.getByLabelText('Độ mượt đường cong') as HTMLInputElement;
    fireEvent.change(smoothing, { target: { value: '0.8' } });
    fireEvent.keyDown(smoothing, { key: 'z', ctrlKey: true });
    expect(smoothing.value).toBe('0.5');

    fireEvent.click(screen.getByRole('button', { name: 'Logo màu' }));
    const colorCode = screen.getByLabelText('Mã màu 1') as HTMLInputElement;
    fireEvent.change(colorCode, { target: { value: '#123456' } });
    fireEvent.keyDown(colorCode, { key: 'z', ctrlKey: true });
    expect(colorCode.value).toBe('#123456');

    rerender(<LogoRebuildWorkspace isActive={false} />);
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect(screen.getByRole('button', { name: 'Logo màu' }).getAttribute('aria-pressed')).toBe('true');
  });
});
