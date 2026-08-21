// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  stat: vi.fn(),
  invoke: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }));
vi.mock('@tauri-apps/plugin-fs', () => ({ stat: mocks.stat }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('./ui/Toast', () => ({ toast: { info: mocks.toastInfo } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import PDFUploader from './PDFUploader';

function renderUploader(onFileSelected = vi.fn(), acceptImages = false) {
  const rendered = render(
    <PDFUploader
      label="File gốc"
      sublabel="Chọn file cần đối chiếu"
      onFileSelected={onFileSelected}
      acceptImages={acceptImages}
    />,
  );
  const zone = screen.getByText('File gốc').closest('.upload-zone');
  if (!zone) throw new Error('Không tìm thấy vùng tải file');
  return { ...rendered, zone, onFileSelected };
}

describe('PDFUploader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: undefined,
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('nhận ảnh và PDF theo đúng thứ tự khi tab bật hỗ trợ ảnh', () => {
    const onFileSelected = vi.fn();
    const { container, zone } = renderUploader(onFileSelected, true);
    const ignored = new File(['text'], 'ghi-chu.txt', { type: 'text/plain' });
    const image = new File(['png'], 'mau-in.PNG', { type: 'image/png' });
    const pdf = new File(['pdf'], 'ban-sua.pdf', { type: 'application/pdf' });

    fireEvent.drop(zone, { dataTransfer: { files: [ignored, image, pdf] } });

    expect(onFileSelected).toHaveBeenCalledWith(image, [image, pdf]);
    expect(container.querySelector('input[type="file"]')?.getAttribute('accept')).toBe(
      '.pdf,.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff',
    );
  });

  it('giữ chế độ mặc định chỉ nhận PDF cho các màn hình dùng chung khác', () => {
    const onFileSelected = vi.fn();
    const { container, zone } = renderUploader(onFileSelected);
    const image = new File(['png'], 'mau-in.png', { type: 'image/png' });

    fireEvent.drop(zone, { dataTransfer: { files: [image] } });

    expect(onFileSelected).not.toHaveBeenCalled();
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      'misc.pDFUploader:vui_long_chon_hoac_tha_file_pdf',
    );
    expect(container.querySelector('input[type="file"]')?.getAttribute('accept')).toBe('.pdf');
  });

  it('hiện thông báo đúng khi chế độ ảnh nhận file không hỗ trợ', () => {
    const { zone } = renderUploader(vi.fn(), true);
    const unsupported = new File(['svg'], 'vector.svg', { type: 'image/svg+xml' });

    fireEvent.drop(zone, { dataTransfer: { files: [unsupported] } });

    expect(mocks.toastInfo).toHaveBeenCalledWith(
      'misc.pDFUploader:vui_long_chon_hoac_tha_file_pdf_hoac_anh',
    );
  });

  it('bộ chọn native nhận đủ định dạng ảnh và giữ MIME/path của ảnh', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    });
    mocks.open.mockResolvedValue(['D:\\jobs\\proof.TIFF']);
    mocks.stat.mockResolvedValue({ size: 321 });
    const onFileSelected = vi.fn();
    const { zone } = renderUploader(onFileSelected, true);

    fireEvent.click(zone);

    await waitFor(() => expect(onFileSelected).toHaveBeenCalledTimes(1));
    expect(mocks.open).toHaveBeenCalledWith({
      multiple: true,
      filters: [{
        name: 'PDF / Ảnh',
        extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'],
      }],
    });
    const [selected, allSelected] = onFileSelected.mock.calls[0];
    expect(selected.name).toBe('proof.TIFF');
    expect(selected.type).toBe('image/tiff');
    expect(selected.size).toBe(321);
    expect((selected as File & { path?: string }).path).toBe('D:\\jobs\\proof.TIFF');
    expect(allSelected).toEqual([selected]);
  });
});
