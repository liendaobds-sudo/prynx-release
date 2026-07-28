// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FontToolsTool from './FontToolsTool';

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
    t: (key: string, values?: Record<string, number>) => {
      const name = key.split(':').at(-1) || key;
      return values?.page ? `${name} ${values.page}` : name;
    },
  }),
}));

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body };
}

const reportWithLiveText = {
  total_pages: 1,
  issues: [{ rule_id: 'TEXT_DETECTED', severity: 'warning', page: 1, description: 'Có chữ sống' }],
  font_summary: { total: 2, embedded: 2, not_embedded: 0 },
};

describe('FontToolsTool', () => {
  beforeEach(() => {
    authenticatedFetch.mockReset();
    uploadPDF.mockReset();
    uploadPDF.mockResolvedValue({ id: 'file-1' });
  });

  afterEach(cleanup);

  it('quét trước rồi mới cho khóa chữ và chuyển file kết quả về viewer', async () => {
    const onFileFixed = vi.fn();
    authenticatedFetch
      .mockResolvedValueOnce(jsonResponse(reportWithLiveText))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        output_filename: 'outlined.pdf',
        log: [{ status: 'success', message: 'Đã khóa chữ', duration_ms: 10 }],
      }))
      .mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['pdf']) });

    const { rerender } = render(
      <FontToolsTool pdfFile={new File(['pdf'], 'input.pdf')} onFileFixed={onFileFixed} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'quet_chu_font' }));
    const outlineButton = await screen.findByRole('button', { name: 'khoa_chu' });
    expect((outlineButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(outlineButton);
    await waitFor(() => expect(onFileFixed).toHaveBeenCalledWith(expect.any(Blob), 'outlined.pdf'));
    expect(authenticatedFetch).toHaveBeenCalledTimes(3);

    // Parent commit file kết quả làm prop pdfFile đổi ngay. Thông báo thành công
    // phải còn hiển thị thay vì bị effect reset về giao diện ban đầu.
    rerender(
      <FontToolsTool pdfFile={new File(['outlined'], 'outlined.pdf')} onFileFixed={onFileFixed} />,
    );
    expect(screen.queryByText('thanh_cong')).not.toBeNull();
    expect(screen.queryByText('Đã khóa chữ')).not.toBeNull();
  });

  it('chặn khóa chữ khi báo cáo còn font chưa nhúng', async () => {
    authenticatedFetch.mockResolvedValueOnce(jsonResponse({
      total_pages: 1,
      issues: [{ rule_id: 'FONT_NOT_EMBEDDED', severity: 'error', page: 1, description: 'Thiếu font' }],
      font_summary: { total: 1, embedded: 0, not_embedded: 1 },
    }));

    render(<FontToolsTool pdfFile={new File(['pdf'], 'input.pdf')} onFileFixed={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'quet_chu_font' }));

    expect((await screen.findByRole('button', { name: 'khoa_chu' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('can_font_goc_title')).not.toBeNull();
  });
});