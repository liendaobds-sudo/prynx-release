// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import OptimizeTool from './OptimizeTool';

vi.mock('../../lib/api', () => ({
  authenticatedFetch: vi.fn(),
  getApiUrl: () => 'http://127.0.0.1:8321/api',
  prepareFileForUpload: vi.fn(async (file) => file),
}));

vi.mock('../../hooks/useWorkingPdf', () => ({
  useWorkingPdf: () => vi.fn(async () => null),
}));

vi.mock('../../stores/useWorkspaceStore', () => ({
  useWorkspaceStore: vi.fn((selector) =>
    selector({
      fileSizeStr: '3.24 MB',
    })
  ),
}));

describe('OptimizeTool — kích thước file trước và sau khi nén', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hiển thị đúng kích thước Sau khi backend trả về header X-Output-Size', async () => {
    const { authenticatedFetch } = await import('../../lib/api');
    const mockBlob = new Blob([new Uint8Array(3400000)], { type: 'application/pdf' }); // ~3.24 MB
    (authenticatedFetch as any).mockResolvedValueOnce({
      ok: true,
      headers: new Headers({
        'X-Original-Size': '19500000', // ~18.6 MB
        'X-Output-Size': '3400000',
        'X-Compression-Ratio': '82.6',
      }),
      blob: async () => mockBlob,
    });

    const file = new File([new Uint8Array(19500000)], 'test.pdf', { type: 'application/pdf' });
    render(<OptimizeTool pdfFile={file} onFileFixed={vi.fn()} />);

    const runBtn = screen.getByRole('button', { name: /thực thi/i });
    fireEvent.click(runBtn);

    await waitFor(() => {
      expect(screen.getByText(/18\.6 MB/i)).toBeDefined();
      expect(screen.getByText(/3\.2 MB/i)).toBeDefined();
    });
    expect(screen.queryByText(/0 B/i)).toBeNull();
  });

  it('hiển thị đúng kích thước Sau khi backend trả về header X-Optimized-Size (tương thích ngược)', async () => {
    const { authenticatedFetch } = await import('../../lib/api');
    const mockBlob = new Blob([new Uint8Array(3400000)], { type: 'application/pdf' });
    (authenticatedFetch as any).mockResolvedValueOnce({
      ok: true,
      headers: new Headers({
        'X-Original-Size': '19500000',
        'X-Optimized-Size': '3400000',
        'X-Compression-Ratio': '82.6',
      }),
      blob: async () => mockBlob,
    });

    const file = new File([new Uint8Array(19500000)], 'test.pdf', { type: 'application/pdf' });
    render(<OptimizeTool pdfFile={file} onFileFixed={vi.fn()} />);

    const runBtn = screen.getByRole('button', { name: /thực thi/i });
    fireEvent.click(runBtn);

    await waitFor(() => {
      expect(screen.getByText(/18\.6 MB/i)).toBeDefined();
      expect(screen.getByText(/3\.2 MB/i)).toBeDefined();
    });
    expect(screen.queryByText(/0 B/i)).toBeNull();
  });

  it('fallback sang blob.size khi header bị thiếu hoàn toàn, không hiển thị 0 B', async () => {
    const { authenticatedFetch } = await import('../../lib/api');
    const mockBlob = new Blob([new Uint8Array(3400000)], { type: 'application/pdf' });
    (authenticatedFetch as any).mockResolvedValueOnce({
      ok: true,
      headers: new Headers({}), // Header rỗng
      blob: async () => mockBlob,
    });

    const file = new File([new Uint8Array(19500000)], 'test.pdf', { type: 'application/pdf' });
    render(<OptimizeTool pdfFile={file} onFileFixed={vi.fn()} />);

    const runBtn = screen.getByRole('button', { name: /thực thi/i });
    fireEvent.click(runBtn);

    await waitFor(() => {
      expect(screen.getByText(/18\.6 MB/i)).toBeDefined();
      expect(screen.getByText(/3\.2 MB/i)).toBeDefined();
    });
    expect(screen.queryByText(/0 B/i)).toBeNull();
  });

  it('dùng đường dẫn native cho PDF lớn thay vì đưa toàn bộ bytes vào WebView', async () => {
    const { authenticatedFetch, prepareFileForUpload } = await import('../../lib/api');
    const nativePath = 'C:\\Users\\Khanh Pham\\Desktop\\large.pdf';
    const previous = (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    try {
      (authenticatedFetch as any).mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          path: 'C:\\Users\\Khanh Pham\\AppData\\Local\\Temp\\optimized.pdf',
          original_size: 1_500_000_000,
          size: 900_000_000,
          ratio: 40,
        }),
      });

      const file = new File([new Uint8Array([1])], 'large.pdf', { type: 'application/pdf' });
      Object.defineProperty(file, 'path', { value: nativePath, configurable: true });
      const onFileFixed = vi.fn();
      render(<OptimizeTool pdfFile={file} onFileFixed={onFileFixed} />);

      fireEvent.click(screen.getByRole('button', { name: /thực thi/i }));
      await waitFor(() => expect(onFileFixed).toHaveBeenCalledTimes(1));

      const [artifact, , resultPath] = onFileFixed.mock.calls[0] as [Blob, string, string];
      expect(artifact.size).toBe(0);
      expect(resultPath).toContain('optimized.pdf');
      expect(prepareFileForUpload).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      else Object.defineProperty(window, '__TAURI_INTERNALS__', { value: previous, configurable: true });
    }
  });
});
