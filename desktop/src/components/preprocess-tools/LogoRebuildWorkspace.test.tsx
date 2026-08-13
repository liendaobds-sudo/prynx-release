// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cancelLogoRebuildPreview,
  createLogoRebuildPreview,
  getLogoRebuildCapabilities,
  preflightLogoRebuild,
  type LogoRebuildCapabilities,
} from '../../lib/logoRebuildApi';
import { saveBlob } from '../../lib/saveBlob';
import { hasDirtySessions, isDirtySession } from '../../lib/dirtySession';
import { dispatchIncomingFileBatch } from '../../hooks/useIncomingFileDispatcher';
import {
  IMAGE_BATCH_DROP_EVENTS,
  registerActiveTabFeature,
} from '../../lib/tabNavigation';
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

const CORE_CAPABILITIES = {
  version: 'mvp-preflight-v1',
  modes: ['monochrome', 'fixed_palette'],
  supported_formats: ['png', 'jpeg', 'webp'],
  auto_color_enabled: false,
  preview_engine_enabled: true,
  legacy_vtracer_enabled: false,
  engine: {
    engine: 'prynx-logo-core',
    version: '0.1.0-dev.1',
    cancellable: true,
    structured_result: true,
    result_schema_version: 1,
    legacy_engine: 'vtracer',
    legacy_version: '1.0.0-alpha.2',
  },
  limitations: [],
} satisfies LogoRebuildCapabilities;

const READY_QC = {
  physical_width_mm: null,
  physical_height_mm: null,
  result_schema_version: 1,
  artifact_sha256: 'a'.repeat(64),
  preprocess_hash: 'b'.repeat(64),
  native_metrics: {
    layer_count: 2,
    component_count: 3,
    outer_count: 2,
    hole_count: 1,
    source_nodes: 320,
    output_nodes: 120,
    max_error_px: 0.125,
    raster_scale: 4,
    iou: 0.9876,
    mae: 0.0123,
  },
  complexity: {
    path_count: 12,
    drawable_path_count: 12,
    node_count: 240,
    tiny_path_count: 0,
    tiny_path_ratio: 0,
    svg_bytes: 4096,
    removed_redundant_paths: 3,
  },
  review_reasons: [],
  review_actions: [],
};

function mockReadyPreview(jobId = 'logo-dirty-session'): void {
  vi.mocked(createLogoRebuildPreview).mockResolvedValue({
    status: 'ready',
    job_id: jobId,
    svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
    width_px: 100,
    height_px: 100,
    warnings: [],
    engine: 'prynx-logo-core',
    engine_version: '0.1.0-dev.1',
    ...READY_QC,
  });
}

describe('LogoRebuildWorkspace', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getLogoRebuildCapabilities).mockResolvedValue(CORE_CAPABILITIES);
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
        engine: 'prynx_core',
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
    await waitFor(() => expect(screen.getByText(/prynx-logo-core 0.1.0-dev.1 · Schema kết quả 1/i)).toBeTruthy());

    expect(screen.getByRole('button', { name: 'Đen trắng' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Logo màu' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByLabelText('Độ mượt đường cong') as HTMLInputElement).value).toBe('0');
    expect((screen.getByLabelText('Khử hạt nhỏ') as HTMLInputElement).value).toBe('4');
    expect(screen.queryByText(/auto.?color/i)).toBeNull();
    expect((screen.getByLabelText('Cân bằng độ sáng cho artwork phẳng không đều màu') as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByText(/Khử hạt chưa được PrynX core áp dụng/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Đen trắng' }));
    expect(screen.getByText(/Khử hạt chưa được PrynX core áp dụng/i)).toBeTruthy();
  });

  it('giữ workspace trong viewport và cuộn độc lập hai cột nội dung dài', async () => {
    const { container } = render(<LogoRebuildWorkspace />);
    await screen.findByText(/prynx-logo-core 0.1.0-dev.1 · Schema kết quả 1/i);

    const workspace = screen.getByTestId('logo-rebuild-workspace');
    const sidebar = container.querySelector('aside');
    const main = container.querySelector('main');
    const viewport = screen.getByTestId('logo-compare-viewport');

    expect(workspace.className).toContain('overflow-auto');
    expect(workspace.className).toContain('xl:overflow-hidden');
    expect(sidebar?.className).toContain('xl:overflow-y-auto');
    expect(main?.className).toContain('xl:overflow-y-auto');
    expect(main?.className).toContain('xl:grid-rows-[minmax(0,1fr)_auto]');
    expect(viewport.parentElement?.className).toContain('xl:min-h-0');

    const impositionSource = readFileSync(
      resolve(process.cwd(), 'src/components/ImpositionTab.tsx'),
      'utf8',
    );
    expect(impositionSource).toContain('data-testid="logo-rebuild-overlay"');
    expect(impositionSource).toContain('z-[110]');
  });

  it('hiển thị giới hạn trước vùng chọn ảnh và chỉ mô tả artwork phẳng', async () => {
    vi.mocked(getLogoRebuildCapabilities).mockResolvedValue({
      ...CORE_CAPABILITIES,
      limitations: [
        'Chưa tự phục hồi phần logo bị che hoặc mất nét.',
        'Logo màu chỉ chạy khi người dùng xác nhận palette.',
      ],
    });

    render(<LogoRebuildWorkspace />);

    const limitations = await screen.findByRole('region', { name: 'Giới hạn hiện tại' });
    const picker = screen.getByLabelText('Chọn ảnh có logo');
    expect(within(limitations).getByText('Phạm vi hiện tại: artwork/logo phẳng')).toBeTruthy();
    expect(within(limitations).getByText(/chưa tự phục hồi phần logo bị che/i)).toBeTruthy();
    expect(limitations.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/vải\/ảnh chụp/i)).toBeNull();
  });

  it('kết thúc trạng thái loading khi capabilities lỗi và cho phép thử lại', async () => {
    vi.mocked(getLogoRebuildCapabilities)
      .mockRejectedValueOnce(new Error('Sidecar tạm thời không phản hồi'))
      .mockResolvedValueOnce(CORE_CAPABILITIES);

    render(<LogoRebuildWorkspace />);

    expect(await screen.findByText('Không kiểm tra được engine')).toBeTruthy();
    expect(screen.queryByText('Đang kiểm tra engine…')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(await screen.findByText(/prynx-logo-core 0.1.0-dev.1 · Schema kết quả 1/i)).toBeTruthy();
    expect(getLogoRebuildCapabilities).toHaveBeenCalledTimes(2);
  });

  it('picker là button dùng được bằng bàn phím và trạng thái async có live region', async () => {
    render(<LogoRebuildWorkspace />);
    await screen.findByText(/prynx-logo-core 0.1.0-dev.1 · Schema kết quả 1/i);

    const pickerButton = screen.getByRole('button', { name: 'Chọn ảnh có logo' });
    const pickerInput = screen.getByLabelText('Chọn ảnh có logo') as HTMLInputElement;
    const clickSpy = vi.spyOn(pickerInput, 'click');
    fireEvent.click(pickerButton);

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('status').some(region => region.getAttribute('aria-live') === 'polite')).toBe(true);
  });

  it('chỉ báo trạng thái request khi backend chưa cung cấp tiến độ theo phase', async () => {
    let resolvePreview!: (value: Awaited<ReturnType<typeof createLogoRebuildPreview>>) => void;
    vi.mocked(createLogoRebuildPreview).mockReturnValue(new Promise(resolve => { resolvePreview = resolve; }));
    render(<LogoRebuildWorkspace />);
    await selectFileAndApplySuggestedPalette('progress.png');

    fireEvent.click(screen.getByRole('button', { name: 'Tạo preview SVG' }));

    expect(await screen.findByText('Đang xử lý logo trên thiết bị…')).toBeTruthy();
    expect(screen.getByText(/Tiến độ theo phase chưa được backend cung cấp/i)).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();

    await act(async () => {
      resolvePreview({
        status: 'ready',
        job_id: 'progress-job',
        svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
        width_px: 100,
        height_px: 100,
        warnings: [],
        engine: 'prynx-logo-core',
        engine_version: '0.1.0-dev.1',
        ...READY_QC,
      });
    });
  });

  it('đặt màu gợi ý làm nền trong một bước và tự loại màu đó khỏi palette', async () => {
    vi.mocked(preflightLogoRebuild).mockResolvedValue({
      status: 'ready',
      source: {
        width_px: 320,
        height_px: 180,
        mode: 'RGBA',
        format: 'PNG',
        file_size_bytes: 100,
        has_alpha: true,
        has_icc_profile: false,
        dpi: null,
      },
      settings: {
        mode: 'fixed_palette',
        engine: 'prynx_core',
        palette: ['#ffffff', '#233d69'],
        smoothing: 0,
        despeckle_size_px: 4,
        illumination_correction: false,
      },
      palette_suggestions: [
        { color: '#ffffff', coverage_ratio: 0.7 },
        { color: '#233d69', coverage_ratio: 0.3 },
      ],
      warnings: [],
      limitations: [],
    });

    render(<LogoRebuildWorkspace />);
    fireEvent.change(screen.getByLabelText('Chọn ảnh có logo'), {
      target: { files: [new File(['png-data'], 'background.png', { type: 'image/png' })] },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Đặt làm nền #ffffff' }));

    expect((screen.getByLabelText('Loại màu nền khỏi SVG') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Mã màu nền') as HTMLInputElement).value).toBe('#ffffff');
    expect((screen.getByLabelText('Mã màu 1') as HTMLInputElement).value).toBe('#233d69');
    expect(screen.queryByLabelText('Mã màu 2')).toBeNull();
  });

  it('so sánh Gốc/Vector ở 100–800%, hỗ trợ pan và overlay', async () => {
    mockReadyPreview('compare-job');
    render(<LogoRebuildWorkspace />);
    await selectFileAndApplySuggestedPalette('compare.png');
    fireEvent.click(screen.getByRole('button', { name: 'Tạo preview SVG' }));
    await screen.findByAltText('SVG vector đã dựng');

    fireEvent.change(screen.getByLabelText('Mức phóng đại'), { target: { value: '800' } });
    expect(screen.getByTestId('logo-compare-stage').style.transform).toContain('scale(8)');

    fireEvent.click(screen.getByRole('button', { name: 'Chồng lớp' }));
    const overlay = screen.getByTestId('logo-overlay-layer');
    expect(overlay.style.opacity).toBe('0.5');
    fireEvent.change(screen.getByLabelText('Độ mờ vector'), { target: { value: '70' } });
    expect(overlay.style.opacity).toBe('0.7');

    const viewport = screen.getByTestId('logo-compare-viewport');
    fireEvent.keyDown(viewport, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(viewport, { key: 'ArrowDown' });
    expect(screen.getByTestId('logo-compare-stage').style.transform).toContain('translate3d(40px, 12px, 0)');

    fireEvent.keyDown(viewport, { key: '0' });
    expect(screen.getByTestId('logo-compare-stage').style.transform).toContain('scale(1)');
  });

  it('hiển thị tay nắm crop và chặn hình học vượt ra ngoài ảnh trước request', async () => {
    render(<LogoRebuildWorkspace />);
    fireEvent.change(screen.getByLabelText('Chọn ảnh có logo'), {
      target: { files: [new File(['png-data'], 'crop.png', { type: 'image/png' })] },
    });
    fireEvent.change(screen.getByLabelText('Cách chọn vùng logo'), { target: { value: 'crop' } });

    expect(screen.getAllByRole('button', { name: /Điểm crop/ })).toHaveLength(4);
    fireEvent.change(screen.getByLabelText('X %'), { target: { value: '90' } });
    fireEvent.change(screen.getByLabelText('Rộng %'), { target: { value: '20' } });

    expect(screen.getByText(/Vùng crop phải nằm trọn trong ảnh/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Tạo preview SVG' }) as HTMLButtonElement).disabled).toBe(true);
    expect(createLogoRebuildPreview).not.toHaveBeenCalled();
  });

  it('hiển thị bốn tay nắm phối cảnh và chặn tứ giác tự cắt', async () => {
    render(<LogoRebuildWorkspace />);
    fireEvent.change(screen.getByLabelText('Chọn ảnh có logo'), {
      target: { files: [new File(['png-data'], 'quad.png', { type: 'image/png' })] },
    });
    fireEvent.change(screen.getByLabelText('Cách chọn vùng logo'), { target: { value: 'perspective' } });

    expect(screen.getAllByRole('button', { name: /^Điểm [1-4]$/ })).toHaveLength(4);
    fireEvent.change(screen.getByLabelText('P2 X'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('P2 Y'), { target: { value: '95' } });

    expect(screen.getByText(/tứ giác lồi, không suy biến/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Tạo preview SVG' }) as HTMLButtonElement).disabled).toBe(true);
    expect(createLogoRebuildPreview).not.toHaveBeenCalled();
  });

  it('xác nhận kích thước mm theo tỷ lệ và chỉ dùng DPI như gợi ý tường minh', async () => {
    vi.mocked(preflightLogoRebuild).mockResolvedValue({
      status: 'ready',
      source: {
        width_px: 600,
        height_px: 300,
        mode: 'RGB',
        format: 'PNG',
        file_size_bytes: 100,
        has_alpha: false,
        has_icc_profile: false,
        dpi: [300, 300],
      },
      settings: {
        mode: 'fixed_palette',
        engine: 'prynx_core',
        palette: ['#233d69'],
        smoothing: 0,
        despeckle_size_px: 4,
        illumination_correction: false,
      },
      palette_suggestions: [{ color: '#233d69', coverage_ratio: 1 }],
      warnings: [],
      limitations: [],
    });
    vi.mocked(createLogoRebuildPreview).mockResolvedValue({
      status: 'ready',
      job_id: 'physical-size-job',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="50.8mm" height="25.4mm"/>',
      width_px: 600,
      height_px: 300,
      warnings: [],
      engine: 'prynx-logo-core',
      engine_version: '0.1.0-dev.1',
      ...READY_QC,
      physical_width_mm: 50.8,
      physical_height_mm: 25.4,
    });

    render(<LogoRebuildWorkspace />);
    fireEvent.change(screen.getByLabelText('Chọn ảnh có logo'), {
      target: { files: [new File(['png-data'], 'physical.png', { type: 'image/png' })] },
    });
    await screen.findByRole('button', { name: /Dùng gợi ý DPI/ });

    fireEvent.change(screen.getByLabelText('Rộng (mm)'), { target: { value: '100' } });
    expect((screen.getByLabelText('Cao (mm)') as HTMLInputElement).value).toBe('50');
    fireEvent.click(screen.getByRole('button', { name: /Dùng gợi ý DPI/ }));
    expect((screen.getByLabelText('Rộng (mm)') as HTMLInputElement).value).toBe('50.8');
    expect((screen.getByLabelText('Cao (mm)') as HTMLInputElement).value).toBe('25.4');

    fireEvent.click(screen.getByRole('button', { name: 'Áp dụng gợi ý' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tạo preview SVG' }));
    await waitFor(() => expect(createLogoRebuildPreview).toHaveBeenCalledTimes(1));
    const [, settings] = vi.mocked(createLogoRebuildPreview).mock.calls[0];
    expect(settings.physical_width_mm).toBe(50.8);
    expect(settings.physical_height_mm).toBe(25.4);
    expect(await screen.findByText('Kích thước in: 50.8 × 25.4 mm')).toBeTruthy();
  });

  it('đẩy dirty lên tab và giữ nguyên phiên khi workspace tạm ẩn', async () => {
    const onDirtyChange = vi.fn();
    const { rerender } = render(
      <LogoRebuildWorkspace tabId="logo-dirty" isActive onDirtyChange={onDirtyChange} />,
    );
    await waitFor(() => expect(onDirtyChange).toHaveBeenCalledWith(false));
    const source = new File(['png-data'], 'logo-dang-lam.png', { type: 'image/png' });

    fireEvent.change(screen.getByLabelText('Chọn ảnh có logo'), {
      target: { files: [source] },
    });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));

    rerender(
      <LogoRebuildWorkspace tabId="logo-dirty" isActive={false} onDirtyChange={onDirtyChange} />,
    );
    expect(screen.getByText('logo-dang-lam.png')).toBeTruthy();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it('hàng đợi đóng app lưu đúng SVG Logo rồi mới clear dirty', async () => {
    mockReadyPreview('logo-quit-save');
    const onDirtyChange = vi.fn();
    render(<LogoRebuildWorkspace tabId="logo-quit" isActive onDirtyChange={onDirtyChange} />);
    await waitFor(() => expect(screen.getByText(/prynx-logo-core 0.1.0-dev.1 · Schema kết quả 1/i)).toBeTruthy());
    await selectFileAndApplySuggestedPalette('logo-quit.png');
    fireEvent.click(screen.getByRole('button', { name: 'Tạo preview SVG' }));
    await screen.findByAltText('SVG vector đã dựng');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    const saveResults: Array<{ requestId: string; result: string; tabId: string }> = [];
    const handleResult = (event: Event) => {
      saveResults.push((event as CustomEvent).detail);
    };
    window.addEventListener('app-save-result', handleResult);
    try {
      act(() => {
        window.dispatchEvent(new CustomEvent('app-trigger-save', {
          detail: { tabId: 'logo-quit', requestId: 'quit-logo-1', saveAs: false },
        }));
      });
      await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(saveResults).toEqual([{
        requestId: 'quit-logo-1',
        result: 'saved',
        tabId: 'logo-quit',
      }]));
      expect(onDirtyChange).toHaveBeenLastCalledWith(false);

      fireEvent.change(screen.getByLabelText('Độ mượt đường cong'), {
        target: { value: '0.4' },
      });
      await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    } finally {
      window.removeEventListener('app-save-result', handleResult);
    }
  });

  it('save bị hủy hoặc lỗi không được clear dirty', async () => {
    mockReadyPreview('logo-save-not-terminal');
    const onDirtyChange = vi.fn();
    render(<LogoRebuildWorkspace tabId="logo-save" isActive onDirtyChange={onDirtyChange} />);
    await waitFor(() => expect(screen.getByText(/prynx-logo-core 0.1.0-dev.1 · Schema kết quả 1/i)).toBeTruthy());
    await selectFileAndApplySuggestedPalette('logo-save.png');
    fireEvent.click(screen.getByRole('button', { name: 'Tạo preview SVG' }));
    await screen.findByAltText('SVG vector đã dựng');
    const results: string[] = [];
    const handleResult = (event: Event) => {
      results.push((event as CustomEvent).detail.result);
    };
    window.addEventListener('app-save-result', handleResult);

    try {
      onDirtyChange.mockClear();
      vi.mocked(saveBlob).mockResolvedValueOnce({ kind: 'cancelled' });
      act(() => {
        window.dispatchEvent(new CustomEvent('app-trigger-save', {
          detail: { tabId: 'logo-save', requestId: 'cancel-logo' },
        }));
      });
      await waitFor(() => expect(results).toEqual(['cancelled']), { timeout: 3_000 });
      expect(onDirtyChange).not.toHaveBeenCalledWith(false);

      vi.mocked(saveBlob).mockRejectedValueOnce(new Error('Không ghi được SVG.'));
      act(() => {
        window.dispatchEvent(new CustomEvent('app-trigger-save', {
          detail: { tabId: 'logo-save', requestId: 'fail-logo' },
        }));
      });
      await waitFor(() => expect(results).toEqual(['cancelled', 'failed']), { timeout: 3_000 });
      expect((await screen.findByRole('alert')).textContent).toContain('Không ghi được SVG.');
      expect(onDirtyChange).not.toHaveBeenCalledWith(false);
    } finally {
      window.removeEventListener('app-save-result', handleResult);
    }
  });

  it('không đóng hàng đợi sau SVG nếu tài liệu cùng tab vẫn dirty', async () => {
    mockReadyPreview('logo-and-pdf-dirty');
    const onDirtyChange = vi.fn();
    const { rerender } = render(
      <LogoRebuildWorkspace
        tabId="logo-composite"
        isActive
        hasOtherDirtyChanges
        onDirtyChange={onDirtyChange}
      />,
    );
    await waitFor(() => expect(screen.getByText(/prynx-logo-core 0.1.0-dev.1 · Schema kết quả 1/i)).toBeTruthy());
    await selectFileAndApplySuggestedPalette('logo-composite.png');
    fireEvent.click(screen.getByRole('button', { name: 'Tạo preview SVG' }));
    await screen.findByAltText('SVG vector đã dựng');

    const results: string[] = [];
    const handleResult = (event: Event) => results.push((event as CustomEvent).detail.result);
    window.addEventListener('app-save-result', handleResult);
    try {
      act(() => {
        window.dispatchEvent(new CustomEvent('app-trigger-save', {
          detail: { tabId: 'logo-composite', requestId: 'save-logo-first' },
        }));
      });
      await waitFor(() => expect(results).toEqual(['cancelled']));
      expect(onDirtyChange).toHaveBeenLastCalledWith(false);
      expect(screen.getByText(/tab vẫn còn thay đổi tài liệu cần lưu/i)).toBeTruthy();

      rerender(
        <LogoRebuildWorkspace
          tabId="logo-composite"
          isActive
          hasOtherDirtyChanges
          onDirtyChange={onDirtyChange}
        />,
      );
      act(() => {
        window.dispatchEvent(new CustomEvent('app-trigger-save', {
          detail: { tabId: 'logo-composite', requestId: 'save-document-next' },
        }));
      });
      expect(results).toEqual(['cancelled']);
    } finally {
      window.removeEventListener('app-save-result', handleResult);
    }
  });

  it('dùng cùng hợp đồng dirty cho close-tab, browser và Tauri close', () => {
    expect(isDirtySession({ isDirty: true })).toBe(true);
    expect(isDirtySession({ isDirty: false })).toBe(false);
    expect(isDirtySession({})).toBe(false);
    expect(hasDirtySessions([{ isDirty: false }, { isDirty: true }])).toBe(true);

    const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    const impositionSource = readFileSync(
      resolve(process.cwd(), 'src/components/ImpositionTab.tsx'),
      'utf8',
    );
    expect(appSource).toContain('isDirtySession(tabToClose)');
    expect(appSource.match(/hasDirtySessions\(tabsRef\.current\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(impositionSource).toContain('const [logoWorkspaceOpened, setLogoWorkspaceOpened]');
    expect(impositionSource).toContain('if (activeDashboardTool === \'logo_rebuild\') setLogoWorkspaceOpened(true)');
    expect(impositionSource).toContain("const isDirty = logoSessionDirty || documentIsDirty");
    expect(impositionSource).toContain('hasOtherDirtyChanges={documentIsDirty}');
    expect(impositionSource).toContain('onDirtyChange={setLogoSessionDirty}');
  });

  it('nhận ảnh từ DOM drop khi workspace Logo thuộc tab active', async () => {
    render(<LogoRebuildWorkspace tabId="logo-active" isActive />);
    await waitFor(() => expect(screen.getByText(/prynx-logo-core 0.1.0-dev.1 · Schema kết quả 1/i)).toBeTruthy());
    const source = new File(['png-data'], 'logo-dom.png', { type: 'image/png' });
    const workspace = screen.getByTestId('logo-rebuild-workspace');

    fireEvent.dragOver(workspace, { dataTransfer: { files: [source] } });
    fireEvent.drop(workspace, { dataTransfer: { files: [source] } });

    await waitFor(() => expect(preflightLogoRebuild).toHaveBeenCalled());
    expect(vi.mocked(preflightLogoRebuild).mock.calls.at(-1)?.[0]).toBe(source);
  });

  it('nhận file path-backed qua dispatcher native vào đúng tab Logo', async () => {
    const tabs = [
      { id: 'pdf', type: 'imposition', payload: { file: 'working.pdf' } },
      { id: 'logo-native', type: 'imposition', payload: { file: 'source.pdf' } },
    ];
    const unregister = registerActiveTabFeature('logo-native', 'logo_rebuild');
    try {
      render(<LogoRebuildWorkspace tabId="logo-native" isActive />);
    await waitFor(() => expect(screen.getByText(/prynx-logo-core 0.1.0-dev.1 · Schema kết quả 1/i)).toBeTruthy());
      const source = new File(['jpeg-data'], 'logo-native.jpg', { type: 'image/jpeg' });
      Object.defineProperty(source, 'path', {
        configurable: true,
        value: 'D:\\logo\\logo-native.jpg',
      });
      const onOpenApp = vi.fn();

      act(() => {
        dispatchIncomingFileBatch([source], '', onOpenApp, tabs, 'logo-native');
      });

      await waitFor(() => expect(preflightLogoRebuild).toHaveBeenCalled());
      expect(vi.mocked(preflightLogoRebuild).mock.calls.at(-1)?.[0]).toBe(source);
      expect((vi.mocked(preflightLogoRebuild).mock.calls.at(-1)?.[0] as File & { path?: string }).path)
        .toBe('D:\\logo\\logo-native.jpg');
      expect(onOpenApp).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it('từ chối event Logo của tab nền, tab khác và listener đã unmount', async () => {
    const { rerender, unmount } = render(
      <LogoRebuildWorkspace tabId="logo-a" isActive={false} />,
    );
    await waitFor(() => expect(screen.getByText(/prynx-logo-core 0.1.0-dev.1 · Schema kết quả 1/i)).toBeTruthy());
    const source = new File(['png-data'], 'khong-duoc-nhan.png', { type: 'image/png' });
    const emit = (tabId: string) => window.dispatchEvent(new CustomEvent(
      IMAGE_BATCH_DROP_EVENTS.logo_rebuild,
      { detail: { tabId, files: [source] } },
    ));

    act(() => { emit('logo-a'); });
    expect(preflightLogoRebuild).not.toHaveBeenCalled();

    rerender(<LogoRebuildWorkspace tabId="logo-a" isActive />);
    act(() => { emit('logo-b'); });
    expect(preflightLogoRebuild).not.toHaveBeenCalled();

    act(() => { emit('logo-a'); });
    await waitFor(() => expect(preflightLogoRebuild).toHaveBeenCalledTimes(1));

    unmount();
    act(() => { emit('logo-a'); });
    expect(preflightLogoRebuild).toHaveBeenCalledTimes(1);
  });

  it('dùng làm mượt Cutout cho JPEG mà không tăng khử hạt', async () => {
    render(<LogoRebuildWorkspace />);
    await waitFor(() => expect(screen.getByText(/prynx-logo-core 0.1.0-dev.1 · Schema kết quả 1/i)).toBeTruthy());

    const jpeg = new File(['jpeg-data'], 'logo-noisy.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByLabelText('Chọn ảnh có logo'), { target: { files: [jpeg] } });
    expect((screen.getByLabelText('Khử hạt nhỏ') as HTMLInputElement).value).toBe('4');
    expect((screen.getByLabelText('Độ mượt đường cong') as HTMLInputElement).value).toBe('1');

    const png = new File(['png-data'], 'logo-flat.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Chọn ảnh khác'), { target: { files: [png] } });
    expect((screen.getByLabelText('Khử hạt nhỏ') as HTMLInputElement).value).toBe('4');
    expect((screen.getByLabelText('Độ mượt đường cong') as HTMLInputElement).value).toBe('0');
  });

  it('khóa xuất SVG review cho đến khi người dùng xác nhận đã kiểm tra', async () => {
    vi.mocked(createLogoRebuildPreview).mockResolvedValue({
      status: 'review',
      job_id: 'review-job',
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0H10V10H0Z"/></svg>',
      width_px: 100,
      height_px: 100,
      warnings: [],
      engine: 'prynx-logo-core',
      engine_version: '0.1.0-dev.1',
      ...READY_QC,
      complexity: {
        ...READY_QC.complexity,
        path_count: 1200,
        node_count: 24000,
        removed_redundant_paths: 418,
      },
      review_reasons: ['SVG còn nhiều mảng nhỏ, khó chỉnh sửa.'],
      review_actions: ['Tăng mức khử hạt rồi tạo lại preview.'],
    });
    render(<LogoRebuildWorkspace />);
    await waitFor(() => expect(screen.getByText(/prynx-logo-core 0.1.0-dev.1 · Schema kết quả 1/i)).toBeTruthy());
    await selectFileAndApplySuggestedPalette('review.jpg');
    fireEvent.click(screen.getByRole('button', { name: 'Tạo preview SVG' }));

    expect(await screen.findByText('Cần kiểm tra SVG')).toBeTruthy();
    expect(screen.getByText(/1200 path · 24000 node · 418/)).toBeTruthy();
    const download = screen.getByRole('button', { name: /Tải SVG/ }) as HTMLButtonElement;
    expect(download.disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Tôi đã kiểm tra và vẫn muốn xuất' }));
    expect(download.disabled).toBe(false);
  });

  it('gửi palette người dùng xác nhận và hiển thị SVG preview', async () => {
    vi.mocked(createLogoRebuildPreview).mockResolvedValue({
      status: 'ready',
      job_id: 'job-test',
      svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      width_px: 320,
      height_px: 180,
      warnings: [],
      engine: 'prynx-logo-core',
      engine_version: '0.1.0-dev.1',
      ...READY_QC,
    });
    render(<LogoRebuildWorkspace />);
    await waitFor(() => expect(screen.getByText(/prynx-logo-core 0.1.0-dev.1 · Schema kết quả 1/i)).toBeTruthy());

    const file = new File(['png-data'], 'logo.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Chọn ảnh có logo'), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText('Mã màu 1'), { target: { value: '#233d69' } });
    fireEvent.change(screen.getByLabelText('Mã màu 2'), { target: { value: '#ef4444' } });
    fireEvent.click(screen.getByLabelText('Loại màu nền khỏi SVG'));
    fireEvent.click(screen.getByRole('button', { name: 'Tạo preview SVG' }));

    await waitFor(() => expect(createLogoRebuildPreview).toHaveBeenCalledTimes(1));
    const [, settings] = vi.mocked(createLogoRebuildPreview).mock.calls[0];
    expect(settings.mode).toBe('fixed_palette');
    expect(settings.engine).toBe('prynx_core');
    expect(settings.palette).toEqual(['#233d69', '#ef4444']);
    expect(settings.background_color).toBe('#ffffff');
    expect(settings.smoothing).toBe(0);
    expect(settings.illumination_correction).toBe(false);
    expect(await screen.findByAltText('SVG vector đã dựng')).toBeTruthy();
    expect(screen.getByText('Schema kết quả: 1')).toBeTruthy();
    const artifactQuality = screen.getByRole('region', { name: 'Chất lượng artifact' });
    expect(artifactQuality.textContent).toContain('IoU: 0.9876 · MAE: 0.0123');
    expect(artifactQuality.textContent).toContain('Biên ngoài / lỗ: 2 / 1');
    expect(artifactQuality.textContent).toContain('Node nguồn / đầu ra: 320 / 120');
    expect(screen.getByTitle('a'.repeat(64)).textContent).toBe('aaaaaaaaaaaa…');
    expect(screen.getByTitle('b'.repeat(64)).textContent).toBe('bbbbbbbbbbbb…');
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
    await waitFor(() => expect(screen.getByText(/prynx-logo-core 0.1.0-dev.1 · Schema kết quả 1/i)).toBeTruthy());

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
        engine: 'prynx_core',
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
    await waitFor(() => expect(screen.getByText(/prynx-logo-core 0.1.0-dev.1 · Schema kết quả 1/i)).toBeTruthy());

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
      engine: 'prynx-logo-core',
      engine_version: '0.1.0-dev.1',
      ...READY_QC,
    });
    render(<LogoRebuildWorkspace />);
    await waitFor(() => expect(screen.getByText(/prynx-logo-core 0.1.0-dev.1 · Schema kết quả 1/i)).toBeTruthy());

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
    await waitFor(() => expect(screen.getByText(/prynx-logo-core 0.1.0-dev.1 · Schema kết quả 1/i)).toBeTruthy());

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
      engine: 'prynx-logo-core',
      engine_version: '0.1.0-dev.1',
      ...READY_QC,
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
    await waitFor(() => expect(screen.getByText(/prynx-logo-core 0.1.0-dev.1 · Schema kết quả 1/i)).toBeTruthy());
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
        engine: 'prynx-logo-core',
        engine_version: '0.1.0-dev.1',
        ...READY_QC,
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
        engine: 'prynx-logo-core',
        engine_version: '0.1.0-dev.1',
        ...READY_QC,
      });
    });
    expect(await screen.findByAltText('SVG vector đã dựng')).toBeTruthy();
  });

  it('không tạo Blob URL mới khi response về sau lúc đóng workspace', async () => {
    let resolvePreview!: (value: Awaited<ReturnType<typeof createLogoRebuildPreview>>) => void;
    vi.mocked(createLogoRebuildPreview).mockReturnValue(new Promise(resolve => { resolvePreview = resolve; }));
    const { unmount } = render(<LogoRebuildWorkspace />);
    await waitFor(() => expect(screen.getByText(/prynx-logo-core 0.1.0-dev.1 · Schema kết quả 1/i)).toBeTruthy());

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
        engine: 'prynx-logo-core',
        engine_version: '0.1.0-dev.1',
        ...READY_QC,
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
        engine: 'prynx-logo-core',
        engine_version: '0.1.0-dev.1',
        ...READY_QC,
      });
      render(<LogoRebuildWorkspace />);
    await waitFor(() => expect(screen.getByText(/prynx-logo-core 0.1.0-dev.1 · Schema kết quả 1/i)).toBeTruthy());
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
    await waitFor(() => expect(screen.getByText(/prynx-logo-core 0.1.0-dev.1 · Schema kết quả 1/i)).toBeTruthy());

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
