// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OfficeConvertTool from './OfficeConvertTool';
import { OFFICE_EXTENSIONS, isGoogleOfficeUrl } from '../../lib/officeFileTypes';

const authenticatedFetch = vi.fn();
const prepareFileForUpload = vi.fn();
const tauriOpen = vi.fn();
const tauriInvoke = vi.fn();

vi.mock('../../lib/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
  getApiUrl: () => 'http://127.0.0.1:8321/api',
  prepareFileForUpload: (...args: unknown[]) => prepareFileForUpload(...args),
}));

vi.mock('../../stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    licensePlan: 'pro',
    licenseFeatures: ['pdf.office_batch'],
  }),
}));

vi.mock('../../lib/license/features', () => ({
  canUse: () => true,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: (...args: unknown[]) => tauriOpen(...args),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => tauriInvoke(...args),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const name = key.split(':').at(-1) || key;
      if (!values) return name;
      return `${name} ${Object.values(values).join('/')}`;
    },
  }),
}));

const fullCapability: {
  supported_extensions: string[];
  unsupported_extensions: string[];
  engine_by_extension: Record<string, string>;
  hint: string;
} = {
  supported_extensions: ['.doc', '.docx', '.odt', '.rtf', '.xls', '.xlsx', '.ods', '.csv', '.ppt', '.pptx', '.odp'],
  unsupported_extensions: [],
  engine_by_extension: {},
  hint: 'Office ready',
};

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body };
}

function pdfResponse() {
  return {
    ok: true,
    status: 200,
    blob: async () => new Blob([new Uint8Array(64)], { type: 'application/pdf' }),
  };
}

function pathResponse(path: string, filename: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ path, filename }),
  };
}


function pathBackedFile(name: string, path = `D:\\${name}`): File {
  const file = new File([], name);
  Object.defineProperty(file, 'path', { value: path });
  Object.defineProperty(file, 'size', { value: 128 });
  return file;
}

function installDefaultApi(capability = fullCapability) {
  authenticatedFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url.endsWith('/office-convert/status')) return Promise.resolve(jsonResponse(capability));
    if (/\/office-convert\/jobs\/[^/]+$/.test(url)) {
      return Promise.resolve(jsonResponse({ phase: 'converting', terminal: false, remaining_seconds: 250 }));
    }
    if (url.endsWith('/cancel')) return Promise.resolve(jsonResponse({ cancelled: true }));
    if (url.endsWith('/extend')) return Promise.resolve(jsonResponse({ extended: true }));
    throw new Error(`Unexpected request: ${url} ${init?.method || 'GET'}`);
  });
}

function pendingUntilAbort(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
  });
}

describe('OfficeConvertTool lifecycle', () => {
  beforeEach(() => {
    authenticatedFetch.mockReset();
    prepareFileForUpload.mockReset();
    tauriOpen.mockReset();
    tauriInvoke.mockReset();
    prepareFileForUpload.mockImplementation(async (file: File) => file);
    installDefaultApi();
    delete (window as any).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    cleanup();
    delete (window as any).__TAURI_INTERNALS__;
  });

  it('khóa oracle 11 Office và mọi dạng Google file được hỗ trợ', () => {
    expect([...OFFICE_EXTENSIONS]).toEqual([
      'doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'csv', 'ppt', 'pptx', 'odp',
    ]);
    expect([
      'https://docs.google.com/document/d/Doc99/edit',
      'https://docs.google.com/spreadsheets/d/Sheet99/edit',
      'https://docs.google.com/presentation/d/Slide99/edit',
      'https://drive.google.com/file/d/DriveFile99/view',
      'https://drive.google.com/open?id=DriveFile99',
    ].every(isGoogleOfficeUrl)).toBe(true);
    expect(isGoogleOfficeUrl('https://drive.google.com/drive/folders/Folder99')).toBe(false);
    expect(isGoogleOfficeUrl('https://example.com/private.docx')).toBe(false);
  });

  it('chặn định dạng mà capability thật không hỗ trợ trước khi gọi convert', async () => {
    installDefaultApi({
      ...fullCapability,
      supported_extensions: ['.doc', '.docx'],
      unsupported_extensions: ['.pptx'],
    });
    render(<OfficeConvertTool officeSourceFile={pathBackedFile('slides.pptx')} onFileFixed={vi.fn()} />);

    await screen.findByText(/supported_on_machine/);
    fireEvent.click(await screen.findByRole('button', { name: 'run' }));

    expect(await screen.findByText(/format_unavailable/)).not.toBeNull();
    expect(authenticatedFetch.mock.calls.some(([url]) => String(url).endsWith('/office-convert/file'))).toBe(false);
  });

  it('Dừng single abort request hiện tại và gửi cancel đúng job', async () => {
    let fileSignal: AbortSignal | undefined;
    authenticatedFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/office-convert/status')) return Promise.resolve(jsonResponse(fullCapability));
      if (url.endsWith('/office-convert/file')) {
        fileSignal = init?.signal || undefined;
        return pendingUntilAbort(init?.signal);
      }
      if (url.endsWith('/cancel')) return Promise.resolve(jsonResponse({ cancelled: true }));
      if (/\/jobs\/[^/]+$/.test(url)) return Promise.resolve(jsonResponse({ phase: 'converting', terminal: false, remaining_seconds: 250 }));
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<OfficeConvertTool officeSourceFile={pathBackedFile('input.docx')} onFileFixed={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'run' }));
    fireEvent.click(await screen.findByRole('button', { name: 'batch_stop' }));

    await waitFor(() => expect(fileSignal?.aborted).toBe(true));
    await waitFor(() => expect(authenticatedFetch.mock.calls.some(([url]) => String(url).endsWith('/cancel'))).toBe(true));
    expect(await screen.findByText(/cancelled/)).not.toBeNull();
  });

  it('single + resize truyền cùng AbortSignal nhưng dùng job_id riêng từng stage', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    authenticatedFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/office-convert/status')) return Promise.resolve(jsonResponse(fullCapability));
      if (/\/jobs\/[^/]+$/.test(url)) return Promise.resolve(jsonResponse({ phase: 'converting', terminal: false, remaining_seconds: 250 }));
      if (url.endsWith('/office-convert/file') || url.endsWith('/office-convert/resize-output')) {
        requests.push({ url, init });
        return Promise.resolve(pdfResponse());
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const onFileFixed = vi.fn();
    render(<OfficeConvertTool officeSourceFile={pathBackedFile('input.docx')} onFileFixed={onFileFixed} />);

    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'a4' } });
    fireEvent.click(await screen.findByRole('button', { name: 'run' }));

    await waitFor(() => expect(onFileFixed).toHaveBeenCalledTimes(1));
    expect(requests).toHaveLength(2);
    expect(requests[0].init?.signal).toBe(requests[1].init?.signal);
    expect(requests[0].init?.signal).toBeInstanceOf(AbortSignal);
    const firstForm = requests[0].init?.body as FormData;
    const resizeForm = requests[1].init?.body as FormData;
    expect(firstForm.get('job_id')).toBeTruthy();
    expect(resizeForm.get('job_id')).toBeTruthy();
    expect(resizeForm.get('job_id')).not.toBe(firstForm.get('job_id'));
  });

  it('Google request có signal, job_id và mở output đúng một lần', async () => {
    let googleInit: RequestInit | undefined;
    authenticatedFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/office-convert/status')) return Promise.resolve(jsonResponse(fullCapability));
      if (/\/jobs\/[^/]+$/.test(url)) return Promise.resolve(jsonResponse({ phase: 'downloading', terminal: false, remaining_seconds: 80 }));
      if (url.endsWith('/office-convert/google')) {
        googleInit = init;
        return Promise.resolve(pdfResponse());
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const onFileFixed = vi.fn();
    render(<OfficeConvertTool onFileFixed={onFileFixed} />);

    fireEvent.click(screen.getByRole('button', { name: /tab_google/ }));
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'https://drive.google.com/open?id=DriveFile99' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'run' }));

    await waitFor(() => expect(onFileFixed).toHaveBeenCalledWith(expect.any(Blob), 'google_export.pdf', undefined));
    expect(googleInit?.signal).toBeInstanceOf(AbortSignal);
    expect((googleInit?.body as FormData).get('job_id')).toBeTruthy();
  });

  it('Tauri single dùng native result path và không đọc PDF blob', async () => {
    (window as any).__TAURI_INTERNALS__ = {};
    let fileForm: FormData | undefined;
    authenticatedFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/office-convert/status')) return Promise.resolve(jsonResponse(fullCapability));
      if (/\/jobs\/[^/]+$/.test(url)) return Promise.resolve(jsonResponse({ phase: 'converting', terminal: false, remaining_seconds: 250 }));
      if (url.endsWith('/office-convert/file')) {
        fileForm = init?.body as FormData;
        return Promise.resolve(pathResponse('D:\\PrynX\\results\\converted.pdf', 'converted_input.pdf'));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const onFileFixed = vi.fn();
    render(<OfficeConvertTool officeSourceFile={pathBackedFile('input.docx')} onFileFixed={onFileFixed} />);

    fireEvent.click(await screen.findByRole('button', { name: 'run' }));

    await waitFor(() => expect(onFileFixed).toHaveBeenCalledWith(
      expect.any(Blob),
      'converted_input.pdf',
      'D:\\PrynX\\results\\converted.pdf',
    ));
    expect(fileForm?.get('return_path')).toBe('true');
  });

  it('Tauri batch truyền path kết quả thẳng sang copy native, không ghi lại bytes PDF', async () => {
    (window as any).__TAURI_INTERNALS__ = {};
    tauriOpen.mockResolvedValue('D:/Output');
    tauriInvoke.mockImplementation((command: string, args?: Record<string, string>) => {
      if (command === 'copy_batch_pdf') {
        return Promise.resolve(`D:/Output/${args?.preferredName}`);
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });
    authenticatedFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/office-convert/status')) return Promise.resolve(jsonResponse(fullCapability));
      if (/\/jobs\/[^/]+$/.test(url)) {
        return Promise.resolve(jsonResponse({ phase: 'completed', terminal: true, remaining_seconds: 0 }));
      }
      if (url.endsWith('/office-convert/file')) {
        const form = init?.body as FormData;
        expect(form.get('return_path')).toBe('true');
        const source = String(form.get('file_path'));
        const stem = source.includes('one') ? 'one' : 'two';
        return Promise.resolve(pathResponse(`D:/PrynX/results/${stem}.pdf`, `${stem}.pdf`));
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<OfficeConvertTool officeSourceFiles={[
      pathBackedFile('one.docx', 'D:/one.docx'),
      pathBackedFile('two.docx', 'D:/two.docx'),
    ]} onFileFixed={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'batch_choose_output' }));
    fireEvent.click(await screen.findByRole('button', { name: 'batch_start' }));

    await waitFor(() => expect(tauriInvoke).toHaveBeenCalledTimes(2));
    expect(tauriInvoke).toHaveBeenNthCalledWith(1, 'copy_batch_pdf', {
      source: 'D:/PrynX/results/one.pdf',
      outputDir: 'D:/Output',
      preferredName: 'one.pdf',
    });
    expect(tauriInvoke).toHaveBeenNthCalledWith(2, 'copy_batch_pdf', {
      source: 'D:/PrynX/results/two.pdf',
      outputDir: 'D:/Output',
      preferredName: 'two.pdf',
    });
    expect(tauriInvoke.mock.calls.some(([command]) => command === 'write_batch_pdf')).toBe(false);
  });
  it('unmount hủy job và callback trả muộn không được mở file', async () => {
    let resolveFile!: (value: ReturnType<typeof pdfResponse>) => void;
    authenticatedFetch.mockImplementation((url: string) => {
      if (url.endsWith('/office-convert/status')) return Promise.resolve(jsonResponse(fullCapability));
      if (url.endsWith('/office-convert/file')) {
        return new Promise((resolve) => { resolveFile = resolve; });
      }
      if (url.endsWith('/cancel')) return Promise.resolve(jsonResponse({ cancelled: true }));
      if (/\/jobs\/[^/]+$/.test(url)) return Promise.resolve(jsonResponse({ phase: 'converting', terminal: false, remaining_seconds: 250 }));
      throw new Error(`Unexpected request: ${url}`);
    });
    const onFileFixed = vi.fn();
    const view = render(<OfficeConvertTool officeSourceFile={pathBackedFile('input.docx')} onFileFixed={onFileFixed} />);
    fireEvent.click(await screen.findByRole('button', { name: 'run' }));
    await waitFor(() => expect(resolveFile).toBeTypeOf('function'));

    view.unmount();
    resolveFile(pdfResponse());
    await Promise.resolve();
    await Promise.resolve();

    expect(onFileFixed).not.toHaveBeenCalled();
    expect(authenticatedFetch.mock.calls.some(([url]) => String(url).endsWith('/cancel'))).toBe(true);
  });

  it('Dừng batch abort file hiện tại thay vì chỉ dừng trước file kế tiếp', async () => {
    (window as any).__TAURI_INTERNALS__ = {};
    tauriOpen.mockResolvedValue('D:\\Output');
    tauriInvoke.mockResolvedValue(undefined);
    let batchSignal: AbortSignal | undefined;
    authenticatedFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/office-convert/status')) return Promise.resolve(jsonResponse(fullCapability));
      if (url.endsWith('/office-convert/file')) {
        batchSignal = init?.signal || undefined;
        return pendingUntilAbort(init?.signal);
      }
      if (url.endsWith('/cancel')) return Promise.resolve(jsonResponse({ cancelled: true }));
      if (/\/jobs\/[^/]+$/.test(url)) return Promise.resolve(jsonResponse({ phase: 'converting', terminal: false, remaining_seconds: 250 }));
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<OfficeConvertTool officeSourceFiles={[
      pathBackedFile('one.docx', 'D:\\one.docx'),
      pathBackedFile('two.docx', 'D:\\two.docx'),
    ]} onFileFixed={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'batch_choose_output' }));
    fireEvent.click(await screen.findByRole('button', { name: 'batch_start' }));
    fireEvent.click(await screen.findByRole('button', { name: 'batch_stop' }));

    await waitFor(() => expect(batchSignal?.aborted).toBe(true));
    await waitFor(() => expect(authenticatedFetch.mock.calls.some(([url]) => String(url).endsWith('/cancel'))).toBe(true));
  });
});