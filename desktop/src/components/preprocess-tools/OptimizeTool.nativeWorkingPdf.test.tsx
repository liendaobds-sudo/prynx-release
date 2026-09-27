// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PDFDocument } from 'pdf-lib';
import OptimizeTool from './OptimizeTool';
import { WorkspaceContext, createWorkspaceStore } from '../../stores/useWorkspaceStore';
import { materializeWorkingPdfRevision } from '../../hooks/useWorkingPdf';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  fetch: vi.fn(),
  bytes: vi.fn(),
  upload: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../../lib/api', () => ({
  authenticatedFetch: mocks.fetch,
  getApiUrl: () => 'http://127.0.0.1:8321/api',
  prepareFileForUpload: mocks.upload,
}));
vi.mock('../../lib/utils', async (original) => ({
  ...await original<typeof import('../../lib/utils')>(),
  getFileArrayBuffer: mocks.bytes,
}));

const path = 'C:\\Users\\Khanh Pham\\Desktop\\[CYMK] BẢNG GIÁ.pdf';
function nativeFile() {
  const file = new File([], 'BẢNG GIÁ.pdf', { type: 'application/pdf' });
  Object.defineProperties(file, {
    path: { value: path },
    size: { value: 1_500_992_842 },
  });
  return file;
}

describe('Optimize — tích hợp resolver PDF làm việc thật với nguồn native', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    mocks.bytes.mockRejectedValue(new Error('Không được đọc toàn bộ PDF để đếm trang'));
    mocks.upload.mockRejectedValue(new Error('Không được upload nguồn native chưa sửa'));
    mocks.invoke.mockResolvedValue({ numPages: 45 });
    mocks.fetch.mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ path: 'D:\\results\\optimized.pdf', original_size: 1_500_992_842, size: 900_000_000, ratio: 40 }),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('đếm trang bằng metadata trước khi gửi đường dẫn, không nạp 1,5 GB qua WebView', async () => {
    const file = nativeFile();
    const store = createWorkspaceStore();
    store.setState({ file, viewerPageOrder: Array.from({ length: 45 }, (_, i) => i + 1), viewerPageRotations: Array(45).fill(0) });
    const fixed = vi.fn();
    render(<WorkspaceContext.Provider value={store}><OptimizeTool pdfFile={file} onFileFixed={fixed} /></WorkspaceContext.Provider>);
    expect(mocks.bytes).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /thực thi/i }));
    await waitFor(() => expect(fixed).toHaveBeenCalledOnce());
    expect(mocks.invoke).toHaveBeenCalledWith('get_pdf_viewer_bootstrap', { filePath: path });
    expect(mocks.bytes).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    const body = mocks.fetch.mock.calls[0][1].body as FormData;
    expect(body.get('file_path')).toBe(path);
    expect(body.get('return_path')).toBe('true');
    expect(body.has('file')).toBe(false);
  });

  it('vẫn nhận biết xóa trang cuối, không coi prefix là file chưa chỉnh sửa', async () => {
    const source = await PDFDocument.create();
    for (let i = 0; i < 3; i++) source.addPage([100 + i, 100]);
    mocks.invoke.mockResolvedValue({ numPages: 3 });
    mocks.bytes.mockResolvedValue(await source.save());
    const file = nativeFile();
    const output = await materializeWorkingPdfRevision({ file, viewerPageOrder: [1, 2], viewerPageInstanceIds: ['a', 'b'], viewerPageRotations: [0, 0], editGeneration: 0 });
    expect(output).not.toBe(file);
    expect(mocks.bytes).toHaveBeenCalledOnce();
    const buffer = await new Promise<ArrayBuffer>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.readAsArrayBuffer(output);
    });
    expect((await PDFDocument.load(buffer)).getPageCount()).toBe(2);
  });

  it.each([null, { numPages: 0 }, { numPages: 1.5 }, { numPages: '45' }])('metadata không hợp lệ %j không kích hoạt đọc toàn file dự phòng', async (metadata) => {
    mocks.invoke.mockResolvedValue(metadata);
    await expect(materializeWorkingPdfRevision({ file: nativeFile(), viewerPageOrder: [1], viewerPageInstanceIds: ['a'], viewerPageRotations: [0], editGeneration: 0 })).rejects.toThrow();
    expect(mocks.bytes).not.toHaveBeenCalled();
  });

  it('lỗi native được trả về và lượt sau có thể thử lại mà không tải bytes dự phòng', async () => {
    const file = nativeFile();
    const snapshot = { file, viewerPageOrder: [1], viewerPageInstanceIds: ['a'], viewerPageRotations: [0], editGeneration: 0 };
    mocks.invoke.mockRejectedValueOnce(new Error('File đang thay đổi')).mockResolvedValueOnce({ numPages: 1 });
    await expect(materializeWorkingPdfRevision(snapshot)).rejects.toThrow('File đang thay đổi');
    await expect(materializeWorkingPdfRevision(snapshot)).resolves.toBe(file);
    expect(mocks.bytes).not.toHaveBeenCalled();
  });
});
