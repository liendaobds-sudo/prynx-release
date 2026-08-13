// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FontToolsTool from './FontToolsTool';
import {
  createWorkspaceStore,
  WorkspaceContext,
  workspaceDocumentIdentity,
} from '../../stores/useWorkspaceStore';

const authenticatedFetch = vi.fn();
const uploadPDF = vi.fn();

vi.mock('../../lib/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
  getApiUrl: () => 'http://127.0.0.1:8321/api',
  uploadPDF: (...args: unknown[]) => uploadPDF(...args),
}));

vi.mock('../../hooks/useWorkingPdf', () => ({
  useWorkingPdf: () => async () => null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, number | string>) => {
      const name = key.split(':').at(-1) || key;
      return values ? `${name} ${Object.values(values).join(' ')}` : name;
    },
  }),
}));

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body };
}

const reportWithLiveText = {
  total_pages: 1,
  issues: [{ rule_id: 'TEXT_DETECTED', severity: 'warning', page: 1, description: 'Có chữ sống' }],
  font_summary: {
    total: 2,
    embedded: 2,
    not_embedded: 0,
    unique_total: 2,
    unique_embedded: 2,
    unique_not_embedded: 0,
  },
};

function renderTool(file: File, onFileFixed: unknown, store = createWorkspaceStore()) {
  store.setState({ file });
  return {
    store,
    ...render(
      <WorkspaceContext.Provider value={store}>
        <FontToolsTool
          pdfFile={file}
          onFileFixed={onFileFixed as (blob: Blob, name: string) => void}
        />
      </WorkspaceContext.Provider>,
    ),
  };
}

describe('FontToolsTool', () => {
  beforeEach(() => {
    authenticatedFetch.mockReset();
    uploadPDF.mockReset();
    uploadPDF.mockResolvedValue({ id: 'file-1' });
  });

  afterEach(cleanup);

  it('tự quét rồi cho khóa chữ và chuyển file kết quả về viewer', async () => {
    const onFileFixed = vi.fn();
    authenticatedFetch
      .mockResolvedValueOnce(jsonResponse(reportWithLiveText))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        output_filename: 'outlined.pdf',
        log: [{ status: 'success', message: 'Đã khóa chữ', duration_ms: 10 }],
      }))
      .mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['pdf']) })
      // Tài liệu kết quả có identity mới nên công cụ sẽ tự quét lại.
      .mockResolvedValueOnce(jsonResponse({
        total_pages: 1,
        issues: [],
        font_summary: { unique_total: 0, unique_embedded: 0, unique_not_embedded: 0 },
      }));

    const inputFile = new File(['pdf'], 'input.pdf');
    const { rerender, store } = renderTool(inputFile, onFileFixed);

    const outlineButton = await screen.findByRole('button', { name: 'khoa_chu' });
    expect((outlineButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(outlineButton);
    await waitFor(() => expect(onFileFixed).toHaveBeenCalledWith(expect.any(Blob), 'outlined.pdf'));
    expect(authenticatedFetch).toHaveBeenCalledTimes(3);

    // Parent commit file kết quả làm prop pdfFile đổi ngay. Thông báo thành công
    // phải còn hiển thị thay vì bị effect reset trước khi user kịp đọc.
    const outputFile = new File(['outlined'], 'outlined.pdf');
    act(() => {
      store.getState().setFile(outputFile);
      rerender(
        <WorkspaceContext.Provider value={store}>
          <FontToolsTool pdfFile={outputFile} onFileFixed={onFileFixed} />
        </WorkspaceContext.Provider>,
      );
    });
    expect(await screen.findByText('thanh_cong')).not.toBeNull();
    expect(screen.queryByText('Đã khóa chữ')).not.toBeNull();
  });

  it('chặn khóa chữ khi báo cáo còn font chưa nhúng', async () => {
    authenticatedFetch.mockResolvedValueOnce(jsonResponse({
      total_pages: 1,
      issues: [{
        rule_id: 'FONT_NOT_EMBEDDED',
        severity: 'error',
        page: 1,
        object_ref: 'Font /F1 (MissingFont)',
        description: 'Thiếu font',
      }],
      font_summary: { total: 1, embedded: 0, not_embedded: 1 },
    }));

    renderTool(new File(['pdf'], 'input.pdf'), vi.fn());

    expect(await screen.findByText('trang_thai_thieu_font_title')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'khoa_chu' })).toBeNull();
  });

  it('tái dùng file ID đã bind với tài liệu trong workspace', async () => {
    const file = new File(['pdf'], 'shared.pdf');
    const store = createWorkspaceStore();
    store.setState({
      file,
      selectionFileId: 'shared-file-id',
      selectionDocumentIdentity: workspaceDocumentIdentity(file, undefined, undefined),
    });
    authenticatedFetch.mockResolvedValueOnce(jsonResponse(reportWithLiveText));

    renderTool(file, vi.fn(), store);

    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(1));
    expect(uploadPDF).not.toHaveBeenCalled();
    expect(JSON.parse(authenticatedFetch.mock.calls[0][1].body)).toMatchObject({
      file_id: 'shared-file-id',
    });
  });

  it('bỏ qua phản hồi quét cũ và tự quét PDF mới sau khi đổi tài liệu', async () => {
    const oldFile = new File(['old'], 'old.pdf');
    const newFile = new File(['new'], 'new.pdf');
    let resolveOldInspect: ((value: unknown) => void) | undefined;
    authenticatedFetch
      .mockReturnValueOnce(new Promise(resolve => { resolveOldInspect = resolve; }))
      .mockResolvedValueOnce(jsonResponse({
        total_pages: 1,
        issues: [],
        font_summary: { unique_total: 0, unique_embedded: 0, unique_not_embedded: 0 },
      }));

    const { rerender, store } = renderTool(oldFile, vi.fn());
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(1));
    const oldSignal = authenticatedFetch.mock.calls[0][1].signal as AbortSignal;

    act(() => store.getState().setFile(newFile));
    rerender(
      <WorkspaceContext.Provider value={store}>
        <FontToolsTool pdfFile={newFile} onFileFixed={vi.fn()} />
      </WorkspaceContext.Provider>,
    );
    expect(oldSignal.aborted).toBe(true);
    resolveOldInspect?.(jsonResponse(reportWithLiveText));

    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('trang_thai_an_toan_title')).not.toBeNull();
  });

  it('không chuyển kết quả khóa chữ cũ về viewer sau khi đổi PDF', async () => {
    const oldFile = new File(['old'], 'old.pdf');
    const newFile = new File(['new'], 'new.pdf');
    const onFileFixed = vi.fn();
    let resolveFix: ((value: unknown) => void) | undefined;
    authenticatedFetch
      .mockResolvedValueOnce(jsonResponse(reportWithLiveText))
      .mockReturnValueOnce(new Promise(resolve => { resolveFix = resolve; }))
      .mockResolvedValueOnce(jsonResponse({
        total_pages: 1,
        issues: [],
        font_summary: { unique_total: 0, unique_embedded: 0, unique_not_embedded: 0 },
      }));

    const { rerender, store } = renderTool(oldFile, onFileFixed);
    fireEvent.click(await screen.findByRole('button', { name: 'khoa_chu' }));
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(2));
    const fixSignal = authenticatedFetch.mock.calls[1][1].signal as AbortSignal;

    act(() => store.getState().setFile(newFile));
    rerender(
      <WorkspaceContext.Provider value={store}>
        <FontToolsTool pdfFile={newFile} onFileFixed={onFileFixed} />
      </WorkspaceContext.Provider>,
    );
    expect(fixSignal.aborted).toBe(true);
    resolveFix?.(jsonResponse({
      success: true,
      output_filename: 'old-outlined.pdf',
      log: [],
    }));

    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(3));
    expect(onFileFixed).not.toHaveBeenCalled();
  });

  it('tự quét đúng một lần cho cùng identity và chỉ quét lại khi người dùng yêu cầu', async () => {
    authenticatedFetch
      .mockResolvedValueOnce(jsonResponse(reportWithLiveText))
      .mockResolvedValueOnce(jsonResponse(reportWithLiveText));

    const file = new File(['pdf'], 'auto.pdf');
    const onFileFixed = vi.fn();
    const { rerender, store } = renderTool(file, onFileFixed);

    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(1));
    rerender(
      <WorkspaceContext.Provider value={store}>
        <FontToolsTool pdfFile={file} onFileFixed={onFileFixed} />
      </WorkspaceContext.Provider>,
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'quet_lai' }));
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(2));
  });

  it('dùng lại báo cáo theo identity khi rời rồi mở lại công cụ', async () => {
    authenticatedFetch.mockResolvedValueOnce(jsonResponse(reportWithLiveText));
    const file = new File(['pdf'], 'cached.pdf');
    const store = createWorkspaceStore();

    const firstMount = renderTool(file, vi.fn(), store);
    expect(await screen.findByText('trang_thai_co_chu_title')).not.toBeNull();
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    firstMount.unmount();

    renderTool(file, vi.fn(), store);
    expect(screen.queryByText('trang_thai_co_chu_title')).not.toBeNull();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
  });

  it('gộp một font thiếu trên 100 trang thành một dòng và dùng số font duy nhất', async () => {
    authenticatedFetch.mockResolvedValueOnce(jsonResponse({
      total_pages: 100,
      issues: Array.from({ length: 100 }, (_, index) => ({
        rule_id: 'FONT_NOT_EMBEDDED',
        severity: 'error',
        page: index + 1,
        object_ref: 'Font /F1 (ABCDEF+FakeFontQA-Regular)',
        description: 'Thiếu font',
      })),
      font_summary: {
        total: 100,
        embedded: 0,
        not_embedded: 100,
        unique_total: 1,
        unique_embedded: 0,
        unique_not_embedded: 1,
        fonts: [{
          name: 'FakeFontQA-Regular',
          embedded: false,
          pages: Array.from({ length: 100 }, (_, index) => index + 1),
          not_embedded_pages: Array.from({ length: 100 }, (_, index) => index + 1),
          occurrences: 100,
        }],
      },
    }));

    renderTool(new File(['pdf'], 'many-pages.pdf'), vi.fn());

    expect(await screen.findByText('FakeFontQA-Regular')).not.toBeNull();
    expect(screen.getAllByText('FakeFontQA-Regular')).toHaveLength(1);
    expect(screen.queryByText(/^100$/)).toBeNull();
    expect(screen.getAllByText(/^1$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/va_them_trang 92/)).not.toBeNull();
  });

  it('vẫn render report cũ chưa có field unique và gộp issue theo object_ref', async () => {
    authenticatedFetch.mockResolvedValueOnce(jsonResponse({
      total_pages: 2,
      issues: [1, 2].map(page => ({
        rule_id: 'FONT_NOT_EMBEDDED',
        severity: 'error',
        page,
        object_ref: 'Font /F1 (ABCDEF+LegacyFont-Regular)',
        description: 'Thiếu font cũ',
      })),
      font_summary: { total: 2, embedded: 0, not_embedded: 2 },
    }));

    renderTool(new File(['pdf'], 'legacy.pdf'), vi.fn());

    expect(await screen.findByText('LegacyFont-Regular')).not.toBeNull();
    expect(screen.getAllByText('LegacyFont-Regular')).toHaveLength(1);
  });

  it('nút Hủy ngắt request đang chạy và không hiển thị lỗi giả', async () => {
    let resolveInspect: ((value: unknown) => void) | undefined;
    authenticatedFetch.mockReturnValueOnce(new Promise(resolve => { resolveInspect = resolve; }));

    renderTool(new File(['pdf'], 'cancel.pdf'), vi.fn());
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(1));
    const signal = authenticatedFetch.mock.calls[0][1].signal as AbortSignal;

    fireEvent.click(screen.getByRole('button', { name: 'huy' }));
    expect(signal.aborted).toBe(true);
    resolveInspect?.(jsonResponse(reportWithLiveText));

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.queryByText('loi_kiem_tra')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'quet_lai' }));
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(2));
  });
});
