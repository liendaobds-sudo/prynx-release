// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ConvertColorsTool from './ConvertColorsTool';
import HairlinesTool from './HairlinesTool';
import MetadataTool from './MetadataTool';
import SavePdfxTool from './SavePdfxTool';
import TrapPresetsTool from './TrapPresetsTool';

const authenticatedFetch = vi.fn();
const uploadPDF = vi.fn();
const prepareFileForUpload = vi.fn();

vi.mock('../../lib/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
  getApiUrl: () => 'http://127.0.0.1:8321/api',
  uploadPDF: (...args: unknown[]) => uploadPDF(...args),
  prepareFileForUpload: (...args: unknown[]) => prepareFileForUpload(...args),
}));

vi.mock('../../hooks/useWorkingPdf', () => ({
  useWorkingPdf: () => async () => null,
}));

vi.mock('../../lib/recipe/RecipeRecorder', () => ({
  recipeRecorder: {
    noteOperation: vi.fn(),
    discardPending: vi.fn(),
  },
}));

vi.mock('../../i18n', () => ({
  tv: (value: string) => value,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key.split(':').at(-1) || key,
  }),
}));

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body };
}

function blobResponse() {
  return { ok: true, blob: async () => new Blob(['pdf'], { type: 'application/pdf' }) };
}

const outputCases = [
  { name: 'net manh', Component: HairlinesTool, outputName: 'hairlines.pdf', successText: 'thanh_cong' },
  { name: 'chuyen mau', Component: ConvertColorsTool, outputName: 'colors.pdf', successText: 'thanh_cong' },
  { name: 'trapping', Component: TrapPresetsTool, outputName: 'trapping.pdf', successText: 'da_ap_dung_overprint_den' },
  { name: 'PDF/X', Component: SavePdfxTool, outputName: 'print-ready.pdf', successText: 'da_xuat_x_thanh_cong' },
] as const;

describe('giu thong bao sau khi cap nhat PDF tren viewer', () => {
  beforeEach(() => {
    authenticatedFetch.mockReset();
    uploadPDF.mockReset();
    prepareFileForUpload.mockReset();
    uploadPDF.mockResolvedValue({ id: 'file-1' });
    prepareFileForUpload.mockImplementation(async (file: File) => file);
  });

  afterEach(cleanup);

  for (const testCase of outputCases) {
    it(`${testCase.name}: giu ket qua cua output vua tao va xoa khi mo file khac`, async () => {
      const onFileFixed = vi.fn();
      authenticatedFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, output_filename: testCase.outputName, log: [] }))
        .mockResolvedValueOnce(blobResponse());

      const Component = testCase.Component;
      const inputFile = new File(['input'], 'input.pdf', { type: 'application/pdf' });
      const { rerender } = render(<Component pdfFile={inputFile} onFileFixed={onFileFixed} />);

      fireEvent.click(screen.getByRole('button', { name: 'run' }));
      await waitFor(() => {
        expect(onFileFixed).toHaveBeenCalledWith(
          expect.any(Blob),
          testCase.outputName,
          undefined,
          null,
        );
      });

      rerender(
        <Component
          pdfFile={new File(['output'], testCase.outputName, { type: 'application/pdf' })}
          onFileFixed={onFileFixed}
        />,
      );
      expect(screen.queryByText(testCase.successText, { exact: false })).not.toBeNull();

      rerender(
        <Component
          pdfFile={new File(['other'], 'unrelated.pdf', { type: 'application/pdf' })}
          onFileFixed={onFileFixed}
        />,
      );
      await waitFor(() => {
        expect(screen.queryByText(testCase.successText, { exact: false })).toBeNull();
      });
    });
  }

  it('metadata: giu thong bao sau khi doc lai output vua luu', async () => {
    const onFileFixed = vi.fn();
    authenticatedFetch
      .mockResolvedValueOnce(jsonResponse({ metadata: {} }))
      .mockResolvedValueOnce(blobResponse())
      .mockResolvedValueOnce(jsonResponse({ metadata: { Title: 'Da luu' } }))
      .mockResolvedValueOnce(jsonResponse({ metadata: {} }));

    const inputFile = new File(['input'], 'input.pdf', { type: 'application/pdf' });
    const { rerender } = render(<MetadataTool pdfFile={inputFile} onFileFixed={onFileFixed} />);

    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'run' }));
    await waitFor(() => {
      expect(onFileFixed).toHaveBeenCalledWith(expect.any(Blob), 'metadata_input.pdf');
    });

    rerender(
      <MetadataTool
        pdfFile={new File(['output'], 'metadata_input.pdf', { type: 'application/pdf' })}
        onFileFixed={onFileFixed}
      />,
    );
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(3));
    expect(screen.queryByText('luu_thanh_cong', { exact: false })).not.toBeNull();

    rerender(
      <MetadataTool
        pdfFile={new File(['other'], 'unrelated.pdf', { type: 'application/pdf' })}
        onFileFixed={onFileFixed}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByText('luu_thanh_cong', { exact: false })).toBeNull();
    });
  });
});
