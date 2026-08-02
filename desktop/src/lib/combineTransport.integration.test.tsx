// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BackendMergeManifestJobOptions,
  BackendMergeManifestJobStatus,
  BackendMergeManifestResult,
} from './api';

const mocks = vi.hoisted(() => ({
  backendMergePdfsJob: vi.fn(),
  backendMergeManifestJob: vi.fn(),
  mergePdf: vi.fn(),
  pdfShouldThrow: false,
  createObjectURL: vi.fn(),
  revokeObjectURL: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('./api', () => ({
  backendMergePdfsJob: mocks.backendMergePdfsJob,
  backendMergeManifestJob: mocks.backendMergeManifestJob,
}));
vi.mock('./preprocessEngine/PdfMerger', () => ({
  mergePdf: mocks.mergePdf,
}));
vi.mock('react-pdf', () => ({
  Document: ({ children }: { children: unknown }) => {
    if (mocks.pdfShouldThrow) throw new Error('preview failed');
    return children;
  },
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock('@formkit/auto-animate/react', () => ({
  useAutoAnimate: () => [null],
}));
vi.mock('../components/shared/usePrintDialog', () => ({
  usePrintDialog: () => ({
    openPrintDialog: vi.fn(),
    printDialog: null,
  }),
}));
vi.mock('../components/ui/Toast', () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key.endsWith(':khong_xem_truoc_duoc')) return 'Không xem trước được';
      if (key.endsWith(':thu_lai')) return 'Thử lại';
      if (key === 'tabs.combine:dang_ghep_backend_progress') {
        return 'Đang xử lý trên máy này... ' + String(values?.progress) + '%';
      }
      if (key === 'tabs.combine:dang_huy') return 'Đang hủy...';
      if (key === 'tabs.combine:dung') return 'Dừng';
      return key;
    },
  }),
}));

import CombineTab from '../components/CombineTab';
import { runMerge, type ProcessContext } from './processHandlers';

type BackendMergePdfsJobOptions = Omit<BackendMergeManifestJobOptions, 'mode'>;

function sizedFile(name: string, size: number): File {
  const file = new File(['fixture'], name, {
    type: name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/png',
  });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

async function validPdfFile(name = 'small.pdf'): Promise<File> {
  const document = await PDFDocument.create();
  document.addPage([100, 100]);
  const bytes = await document.save();
  const file = new File([bytes as unknown as BlobPart], name, { type: 'application/pdf' });
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
  return file;
}

function processContext(getWorkingBytes = vi.fn<() => Promise<Uint8Array>>()): ProcessContext {
  return {
    file: sizedFile('working.pdf', 100),
    commitWorkingFile: vi.fn().mockResolvedValue(undefined),
    setError: vi.fn(),
    setIsProcessing: vi.fn(),
    setProcessStatus: vi.fn(),
    setReportMsg: vi.fn(),
    setBatchOutput: vi.fn(),
    getWorkingBytes,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const MERGING_STATUS: BackendMergeManifestJobStatus = {
  job_id: 'combine-job-1',
  status: 'merging',
  terminal: false,
  cancel_requested: false,
  progress: 40,
  completed: 2,
  total: 5,
  message: null,
};

async function clickDelegatedCombine(
  onSpawnTab: (file: File) => void,
  onResultsOpened?: () => void,
) {
  const largePdf = sizedFile('large.pdf', 64 * 1024 * 1024);
  const view = render(
    <CombineTab
      initialFiles={[largePdf]}
      onSpawnTab={onSpawnTab}
      onResultsOpened={onResultsOpened}
      isActive
    />,
  );
  const combineButton = screen.getByRole('button', { name: 'tabs.combine:ghep_file' });
  await waitFor(() => expect((combineButton as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(combineButton);
  await waitFor(() => expect(mocks.backendMergeManifestJob).toHaveBeenCalledTimes(1));
  return view;
}

async function clickDelegatedInterleave(onSpawnTab: (file: File) => void) {
  const oddFile = sizedFile('odd.pdf', 32 * 1024 * 1024);
  const evenFile = sizedFile('even.pdf', 32 * 1024 * 1024);
  const view = render(
    <CombineTab initialFiles={[oddFile, evenFile]} onSpawnTab={onSpawnTab} isActive />,
  );
  const interleaveButton = screen.getByRole('button', { name: 'tabs.combine:tron_dan_xen' });
  await waitFor(() => expect((interleaveButton as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(interleaveButton);
  await waitFor(() => expect(mocks.backendMergePdfsJob).toHaveBeenCalledTimes(1));
  return { view, oddFile, evenFile };
}

describe('Combine/Interleave transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pdfShouldThrow = false;
    mocks.backendMergePdfsJob.mockResolvedValue({
      blob: new Blob(['merged'], { type: 'application/pdf' }),
      filename: 'Combined.pdf',
    });
    mocks.backendMergeManifestJob.mockResolvedValue({
      blob: new Blob(['manifest'], { type: 'application/pdf' }),
      filename: 'Combined.pdf',
    });
    mocks.mergePdf.mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
    mocks.createObjectURL.mockReturnValue('blob:combine-preview');
    Object.defineProperty(URL, 'createObjectURL', {
      value: mocks.createObjectURL,
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: mocks.revokeObjectURL,
      configurable: true,
    });
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
  });

  it('thanh công cụ không lặp lại tiêu đề và mô tả đã có trên tab', () => {
    render(<CombineTab isActive />);

    expect(screen.queryByText('tabs.combine:title_b8')).toBeNull();
    expect(screen.queryByText('tabs.combine:help_b8')).toBeNull();
    expect(screen.getByRole('button', { name: 'tabs.combine:trang_trang_2' })).toBeTruthy();
  });

  it('Combine frontend mở kết quả trước rồi mới báo shell đóng tab nguồn', async () => {
    const source = await validPdfFile();
    const onSpawnTab = vi.fn();
    const onResultsOpened = vi.fn();
    render(
      <CombineTab
        initialFiles={[source]}
        onSpawnTab={onSpawnTab}
        onResultsOpened={onResultsOpened}
        isActive
      />,
    );

    const combineButton = screen.getByRole('button', { name: 'tabs.combine:ghep_file' });
    await waitFor(() => expect((combineButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(combineButton);

    await waitFor(() => expect(onSpawnTab).toHaveBeenCalledTimes(1));
    expect(onResultsOpened).toHaveBeenCalledTimes(1);
    expect(onSpawnTab.mock.invocationCallOrder[0]).toBeLessThan(
      onResultsOpened.mock.invocationCallOrder[0],
    );
    expect(mocks.backendMergeManifestJob).not.toHaveBeenCalled();
  });

  it('Interleave lớn dùng đúng odd/even, mode job và không đọc working file', async () => {
    const getWorkingBytes = vi.fn<() => Promise<Uint8Array>>()
      .mockRejectedValue(new Error('không được đọc working file'));
    const context = processContext(getWorkingBytes);
    const oddFile = sizedFile('odd.pdf', 3_000_000);
    const evenFile = sizedFile('even.pdf', 3_000_000);
    mocks.backendMergePdfsJob.mockImplementation((
      _files: File[],
      _mode: 'merge_files' | 'interleave',
      options?: BackendMergePdfsJobOptions,
    ) => {
      options?.onProgress?.(MERGING_STATUS);
      return Promise.resolve({
        blob: new Blob(['merged'], { type: 'application/pdf' }),
        filename: 'Combined.pdf',
      });
    });

    await runMerge(context, {
      mode: 'interleave',
      oddFile,
      evenFile,
      spawnNewTab: false,
    });

    expect(getWorkingBytes).not.toHaveBeenCalled();
    expect(mocks.backendMergePdfsJob).toHaveBeenCalledWith(
      [oddFile, evenFile],
      'interleave',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        onProgress: expect.any(Function),
      }),
    );
    expect(context.setProcessStatus).toHaveBeenCalledWith(expect.stringContaining('40%'));
    expect(context.commitWorkingFile).toHaveBeenCalledWith(
      expect.any(Blob),
      'Interleaved_Document.pdf',
    );
  });

  it('Merge lớn dùng mode merge_files, báo tiến độ và commit native result path', async () => {
    const getWorkingBytes = vi.fn<() => Promise<Uint8Array>>()
      .mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
    const context = processContext(getWorkingBytes);
    const extraFile = sizedFile('extra.pdf', 6_000_000);
    mocks.backendMergePdfsJob.mockImplementation((
      _files: File[],
      _mode: 'merge_files' | 'interleave',
      options?: BackendMergePdfsJobOptions,
    ) => {
      options?.onProgress?.(MERGING_STATUS);
      return Promise.resolve({
        path: 'D:\\output\\Merged_working.pdf',
        filename: 'server-name.pdf',
      });
    });

    await runMerge(context, {
      mode: 'merge_files',
      filesToMerge: [extraFile],
      spawnNewTab: false,
    });

    expect(getWorkingBytes).toHaveBeenCalledTimes(1);
    expect(mocks.backendMergePdfsJob).toHaveBeenCalledTimes(1);
    const [inputs, mode, options] = mocks.backendMergePdfsJob.mock.calls[0] as [
      File[],
      string,
      BackendMergePdfsJobOptions,
    ];
    expect(mode).toBe('merge_files');
    expect(inputs[0].name).toBe('working.pdf');
    expect(inputs[0].size).toBe(4);
    expect(inputs[1]).toBe(extraFile);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(context.setProcessStatus).toHaveBeenCalledWith(expect.stringContaining('40%'));
    expect(context.commitWorkingFile).toHaveBeenCalledWith(
      expect.any(Blob),
      'Merged_working.pdf',
      'D:\\output\\Merged_working.pdf',
    );
  });

  it('runMerge gắn cancel handler; kết quả về muộn sau hủy không commit hoặc mở tab', async () => {
    const job = deferred<BackendMergeManifestResult>();
    const getWorkingBytes = vi.fn<() => Promise<Uint8Array>>()
      .mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
    const context = processContext(getWorkingBytes);
    const onSpawnTab = vi.fn();
    const setCancelHandler = vi.fn();
    context.onSpawnTab = onSpawnTab;
    context.setCancelHandler = setCancelHandler;
    const extraFile = sizedFile('extra.pdf', 6_000_000);
    let signal: AbortSignal | undefined;
    mocks.backendMergePdfsJob.mockImplementation((
      _files: File[],
      _mode: 'merge_files' | 'interleave',
      options?: BackendMergePdfsJobOptions,
    ) => {
      signal = options?.signal;
      return job.promise;
    });

    const operation = runMerge(context, {
      mode: 'merge_files',
      filesToMerge: [extraFile],
      spawnNewTab: true,
    });
    await waitFor(() => expect(mocks.backendMergePdfsJob).toHaveBeenCalledTimes(1));
    const cancelHandler = setCancelHandler.mock.calls.find(
      ([handler]) => typeof handler === 'function',
    )?.[0] as (() => Promise<void>) | undefined;
    expect(cancelHandler).toBeTypeOf('function');

    await cancelHandler?.();
    expect(signal?.aborted).toBe(true);
    job.resolve({ path: 'D:\\output\\late.pdf', filename: 'late.pdf' });
    await operation;

    expect(onSpawnTab).not.toHaveBeenCalled();
    expect(context.commitWorkingFile).not.toHaveBeenCalled();
    expect(context.setError).not.toHaveBeenCalledWith(expect.stringMatching(/ghép/i));
    expect(setCancelHandler).toHaveBeenLastCalledWith(null);
  });

  it('Interleave có ảnh không bị gửi vào endpoint PDF-only', async () => {
    const getWorkingBytes = vi.fn<() => Promise<Uint8Array>>();
    const context = processContext(getWorkingBytes);
    const oddFile = sizedFile('odd.png', 4_000_000);
    const evenFile = sizedFile('even.pdf', 4_000_000);

    await runMerge(context, {
      mode: 'interleave',
      oddFile,
      evenFile,
      spawnNewTab: false,
    });

    expect(getWorkingBytes).not.toHaveBeenCalled();
    expect(mocks.backendMergePdfsJob).not.toHaveBeenCalled();
    expect(mocks.mergePdf).toHaveBeenCalledWith(null, expect.objectContaining({
      mode: 'interleave',
      oddFile,
      evenFile,
    }));
    expect(context.commitWorkingFile).toHaveBeenCalledWith(
      expect.any(Blob),
      'Interleaved_Document.pdf',
    );
  });

  it('thu hồi đúng một object URL do thumbnail ảnh sở hữu khi đóng tab', async () => {
    const image = new File(['png'], 'anh.png', { type: 'image/png' });
    const view = render(<CombineTab initialFiles={[image]} isActive />);

    await waitFor(() => expect(mocks.createObjectURL).toHaveBeenCalledTimes(1));
    view.unmount();

    expect(mocks.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(mocks.revokeObjectURL).toHaveBeenCalledWith('blob:combine-preview');
  });

  it.each([
    ['anh-trong-suot.png', true],
    ['anh-trong-suot.webp', true],
    ['anh-thuong.jpg', false],
  ])('preview %s chỉ dùng nền đen cho định dạng có alpha', async (name, expectsBlack) => {
    const image = new File(['image'], name, { type: `image/${name.split('.').pop()}` });
    const { container } = render(<CombineTab initialFiles={[image]} isActive />);

    const imageElement = await waitFor(() => {
      const element = container.querySelector('img');
      expect(element).not.toBeNull();
      return element as HTMLImageElement;
    });

    expect(imageElement.parentElement?.classList.contains('bg-black')).toBe(expectsBlack);
  });

  it('preview PDF lỗi lặp kết thúc ở cảnh báo có Thử lại, không Loading vô hạn', async () => {
    vi.useFakeTimers();
    mocks.pdfShouldThrow = true;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const pdf = new File(['broken'], 'hong.pdf', { type: 'application/pdf' });

    render(<CombineTab initialFiles={[pdf]} isActive />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    for (let retry = 0; retry < 5; retry += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
    }

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Không xem trước được');
    expect(alert.textContent).toContain('Thử lại');
    expect(alert.textContent).not.toContain('Loading');
    expect(vi.getTimerCount()).toBe(0);

    consoleError.mockRestore();
  });

  it('Combine delegated hiển thị tiến độ và giữ native result path khi mở tab', async () => {
    const job = deferred<BackendMergeManifestResult>();
    const onSpawnTab = vi.fn();
    mocks.backendMergeManifestJob.mockImplementation((
      _files: File[],
      _manifest: unknown[],
      options?: BackendMergeManifestJobOptions,
    ) => {
      options?.onProgress?.(MERGING_STATUS);
      return job.promise;
    });

    await clickDelegatedCombine(onSpawnTab);
    expect(await screen.findByText('40%')).toBeTruthy();
    expect(screen.queryByText(/Đang xử lý trên máy này/)).toBeNull();
    expect(document.querySelector('[data-combine-complete="true"]')).toBeNull();

    await act(async () => {
      job.resolve({ path: 'D:\\output\\Combined.pdf', filename: 'Combined.pdf' });
      await job.promise;
    });

    await waitFor(() => expect(onSpawnTab).toHaveBeenCalledTimes(1));
    const resultFile = onSpawnTab.mock.calls[0][0] as File & { path?: string };
    expect(resultFile.name).toBe('Combined.pdf');
    expect(resultFile.size).toBe(0);
    expect(resultFile.path).toBe('D:\\output\\Combined.pdf');
  });

  it('Combine delegated tick lần lượt card đã ghép xong', async () => {
    const job = deferred<BackendMergeManifestResult>();
    const onSpawnTab = vi.fn();
    let reportProgress: BackendMergeManifestJobOptions['onProgress'];
    mocks.backendMergeManifestJob.mockImplementation((
      _files: File[],
      _manifest: unknown[],
      options?: BackendMergeManifestJobOptions,
    ) => {
      reportProgress = options?.onProgress;
      return job.promise;
    });

    const firstFile = sizedFile('image-1.png', 1_000_000);
    const secondFile = sizedFile('image-2.png', 1_000_000);
    const { container } = render(
      <CombineTab initialFiles={[firstFile, secondFile]} onSpawnTab={onSpawnTab} isActive />,
    );

    await waitFor(() => expect(container.querySelectorAll('[data-combine-index]')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'tabs.combine:ghep_file' }));
    await waitFor(() => expect(mocks.backendMergeManifestJob).toHaveBeenCalledTimes(1));

    const cards = container.querySelectorAll<HTMLElement>('[data-combine-index]');
    await act(async () => {
      reportProgress?.({ ...MERGING_STATUS, progress: 50, completed: 1, total: 2 });
    });
    await waitFor(() => {
      expect(cards[0].querySelector('[data-combine-complete="true"]')).not.toBeNull();
      expect(cards[1].querySelector('[data-combine-complete="true"]')).toBeNull();
    });

    await act(async () => {
      reportProgress?.({ ...MERGING_STATUS, progress: 100, completed: 2, total: 2 });
    });
    await waitFor(() => {
      expect(cards[1].querySelector('[data-combine-complete="true"]')).not.toBeNull();
    });

    await act(async () => {
      job.resolve({ path: 'D:\\output\\Combined.pdf', filename: 'Combined.pdf' });
      await job.promise;
    });
  });

  it('Interleave delegated dùng job mode, hiển thị tiến độ và giữ native result path', async () => {
    const job = deferred<BackendMergeManifestResult>();
    const onSpawnTab = vi.fn();
    mocks.backendMergePdfsJob.mockImplementation((
      _files: File[],
      _mode: 'merge_files' | 'interleave',
      options?: BackendMergePdfsJobOptions,
    ) => {
      options?.onProgress?.(MERGING_STATUS);
      return job.promise;
    });

    const { oddFile, evenFile } = await clickDelegatedInterleave(onSpawnTab);
    expect(mocks.backendMergePdfsJob).toHaveBeenCalledWith(
      [oddFile, evenFile],
      'interleave',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        onProgress: expect.any(Function),
      }),
    );
    expect(await screen.findByText('40%')).toBeTruthy();
    expect(screen.queryByText(/Đang xử lý trên máy này/)).toBeNull();
    expect(document.querySelector('[data-combine-complete="true"]')).toBeNull();

    await act(async () => {
      job.resolve({ path: 'D:\\output\\Interleaved.pdf', filename: 'server-name.pdf' });
      await job.promise;
    });

    await waitFor(() => expect(onSpawnTab).toHaveBeenCalledTimes(1));
    const resultFile = onSpawnTab.mock.calls[0][0] as File & { path?: string };
    expect(resultFile.name).toBe('Interleaved.pdf');
    expect(resultFile.size).toBe(0);
    expect(resultFile.path).toBe('D:\\output\\Interleaved.pdf');
  });

  it('Dừng Interleave delegated abort signal và chặn kết quả về muộn mở tab', async () => {
    const job = deferred<BackendMergeManifestResult>();
    const onSpawnTab = vi.fn();
    let signal: AbortSignal | undefined;
    mocks.backendMergePdfsJob.mockImplementation((
      _files: File[],
      _mode: 'merge_files' | 'interleave',
      options?: BackendMergePdfsJobOptions,
    ) => {
      signal = options?.signal;
      return job.promise;
    });

    await clickDelegatedInterleave(onSpawnTab);
    fireEvent.click(await screen.findByRole('button', { name: 'Dừng' }));
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      job.resolve({ path: 'D:\\output\\late-interleave.pdf', filename: 'late.pdf' });
      await job.promise;
    });
    expect(onSpawnTab).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('unmount Interleave delegated abort signal và generation fence chặn callback cũ', async () => {
    const job = deferred<BackendMergeManifestResult>();
    const onSpawnTab = vi.fn();
    let signal: AbortSignal | undefined;
    mocks.backendMergePdfsJob.mockImplementation((
      _files: File[],
      _mode: 'merge_files' | 'interleave',
      options?: BackendMergePdfsJobOptions,
    ) => {
      signal = options?.signal;
      return job.promise;
    });

    const { view } = await clickDelegatedInterleave(onSpawnTab);
    view.unmount();
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      job.resolve({ path: 'D:\\output\\stale-interleave.pdf', filename: 'stale.pdf' });
      await job.promise;
    });
    expect(onSpawnTab).not.toHaveBeenCalled();
  });

  it('nút Dừng abort job delegated và không đóng tab nguồn', async () => {
    const job = deferred<BackendMergeManifestResult>();
    const onSpawnTab = vi.fn();
    const onResultsOpened = vi.fn();
    let signal: AbortSignal | undefined;
    mocks.backendMergeManifestJob.mockImplementation((
      _files: File[],
      _manifest: unknown[],
      options?: BackendMergeManifestJobOptions,
    ) => {
      signal = options?.signal;
      return job.promise;
    });

    await clickDelegatedCombine(onSpawnTab, onResultsOpened);
    fireEvent.click(await screen.findByRole('button', { name: 'Dừng' }));

    expect(signal?.aborted).toBe(true);
    expect((screen.getByRole('button', { name: 'Đang hủy...' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      job.resolve({ path: 'D:\\output\\late.pdf', filename: 'late.pdf' });
      await job.promise;
    });

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Đang hủy...' })).toBeNull());
    expect(onSpawnTab).not.toHaveBeenCalled();
    expect(onResultsOpened).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('unmount abort job delegated và chặn callback cũ mở tab', async () => {
    const job = deferred<BackendMergeManifestResult>();
    const onSpawnTab = vi.fn();
    let signal: AbortSignal | undefined;
    mocks.backendMergeManifestJob.mockImplementation((
      _files: File[],
      _manifest: unknown[],
      options?: BackendMergeManifestJobOptions,
    ) => {
      signal = options?.signal;
      return job.promise;
    });

    const view = await clickDelegatedCombine(onSpawnTab);
    view.unmount();
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      job.resolve({ path: 'D:\\output\\stale.pdf', filename: 'stale.pdf' });
      await job.promise;
    });
    expect(onSpawnTab).not.toHaveBeenCalled();
  });
});
