// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  probeRecentFile: vi.fn(),
}));

vi.mock('../../lib/useRecentFiles', () => ({
  probeRecentFile: mocks.probeRecentFile,
}));
vi.mock('react-pdf', () => ({
  Document: ({ children }: { children: React.ReactNode }) => children,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: 'pdf.worker.js',
}));

import ThumbnailView from './ThumbnailView';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('ThumbnailView — chỉ request tile cho file đã xác nhận tồn tại', () => {
  beforeEach(() => {
    mocks.probeRecentFile.mockReset();
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('tạo tile URL khi native trả available', async () => {
    mocks.probeRecentFile.mockResolvedValue({ status: 'available', size: 123 });
    render(<ThumbnailView path="D:\\viec\\hop-le.pdf" name="hop-le.pdf" />);

    const image = await screen.findByRole('img', { name: 'hop-le.pdf' });
    expect(image.getAttribute('src')).toContain('http://tile.localhost/');
    expect(image.getAttribute('src')).toContain('purpose=background');
  });

  it('không tạo tile khi file đã missing', async () => {
    mocks.probeRecentFile.mockResolvedValue({ status: 'missing', size: 0 });
    render(<ThumbnailView path="D:\\viec\\da-xoa.pdf" name="da-xoa.pdf" />);

    expect(await screen.findByText('Missing')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it.each(['timeout', 'inaccessible'] as const)(
    'không tạo tile khi native trả %s',
    async (status) => {
      mocks.probeRecentFile.mockResolvedValue({ status, size: 0 });
      render(<ThumbnailView path="D:\\viec\\chua-xac-minh.pdf" name="chua-xac-minh.pdf" />);

      await waitFor(() => expect(mocks.probeRecentFile).toHaveBeenCalledTimes(1));
      await screen.findByText('PDF');
      expect(screen.queryByRole('img')).toBeNull();
    },
  );

  it('không remount tile cũ trước probe mới khi Home hiện lại', async () => {
    mocks.probeRecentFile.mockResolvedValueOnce({ status: 'available', size: 123 });
    const view = render(
      <ThumbnailView path="D:\\viec\\tam.pdf" name="tam.pdf" active />,
    );
    await screen.findByRole('img', { name: 'tam.pdf' });

    view.rerender(
      <ThumbnailView path="D:\\viec\\tam.pdf" name="tam.pdf" active={false} />,
    );
    expect(screen.queryByRole('img')).toBeNull();

    const secondProbe = deferred<{ status: 'missing'; size: number }>();
    mocks.probeRecentFile.mockReturnValueOnce(secondProbe.promise);
    view.rerender(
      <ThumbnailView path="D:\\viec\\tam.pdf" name="tam.pdf" active />,
    );
    expect(screen.queryByRole('img')).toBeNull();

    await act(async () => {
      secondProbe.resolve({ status: 'missing', size: 0 });
      await secondProbe.promise;
    });
    expect(await screen.findByText('Missing')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });
});
