// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ConvertColorsTool from './ConvertColorsTool';
import HairlinesTool from './HairlinesTool';
import MetadataTool from './MetadataTool';
import SavePdfxTool from './SavePdfxTool';
import TrapPresetsTool from './TrapPresetsTool';
import { createWorkspaceStore, WorkspaceContext } from '../../stores/useWorkspaceStore';

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

function errorResponse(detail: string, status = 500) {
  return {
    ok: false,
    status,
    json: async () => ({ detail }),
    blob: async () => new Blob([detail], { type: 'application/json' }),
  };
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
      authenticatedFetch.mockImplementation(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/icc-profiles')) {
          return jsonResponse({
            profiles: [
              { id: 'fogra39', name: 'FOGRA39', description: 'Coated', available: true },
            ],
          });
        }
        if (url.includes('/download/')) return blobResponse();
        return jsonResponse({ success: true, output_filename: testCase.outputName, log: [] });
      });

      const Component = testCase.Component;
      const inputFile = new File(['input'], 'input.pdf', { type: 'application/pdf' });
      const store = createWorkspaceStore();
      const view = (file: File) => (
        <WorkspaceContext.Provider value={store}>
          <Component pdfFile={file} onFileFixed={onFileFixed} />
        </WorkspaceContext.Provider>
      );
      const { rerender } = render(view(inputFile));

      fireEvent.click(screen.getByRole('button', { name: 'run' }));
      await waitFor(() => {
        expect(onFileFixed).toHaveBeenCalledWith(
          expect.any(Blob),
          testCase.outputName,
          undefined,
          null,
        );
      });

      rerender(view(new File(['output'], testCase.outputName, { type: 'application/pdf' })));
      expect(screen.queryByText(testCase.successText, { exact: false })).not.toBeNull();

      rerender(view(new File(['other'], 'unrelated.pdf', { type: 'application/pdf' })));
      await waitFor(() => {
        expect(screen.queryByText(testCase.successText, { exact: false })).toBeNull();
      });
    });
  }

  it('chuyển màu dùng chung profile và intent với Output Preview trong đúng tab', async () => {
    const store = createWorkspaceStore();
    store.setState({
      outputPreviewProfileId: 'swop',
      outputPreviewRenderingIntent: 'perceptual',
    });
    const onFileFixed = vi.fn();
    authenticatedFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/icc-profiles')) {
        return jsonResponse({
          profiles: [
            { id: 'fogra39', name: 'FOGRA39', description: 'Coated', available: true },
            { id: 'swop', name: 'SWOP', description: 'Web offset', available: true },
          ],
        });
      }
      if (url.includes('/download/')) return blobResponse();
      return jsonResponse({ success: true, output_filename: 'colors.pdf', log: [] });
    });

    render(
      <WorkspaceContext.Provider value={store}>
        <ConvertColorsTool
          pdfFile={new File(['input'], 'input.pdf', { type: 'application/pdf' })}
          onFileFixed={onFileFixed}
        />
      </WorkspaceContext.Provider>,
    );

    const profileSelect = await screen.findByRole('combobox', { name: 'ho_so_mau_dich' });
    const intentSelect = screen.getByRole('combobox', { name: 'rendering_intent' });
    const adjustmentStageSelect = screen.getByRole('combobox', { name: 'vi_tri_tinh_chinh' });
    expect((profileSelect as HTMLSelectElement).value).toBe('swop');
    expect((intentSelect as HTMLSelectElement).value).toBe('perceptual');
    expect((adjustmentStageSelect as HTMLSelectElement).value).toBe('post_cmyk');

    fireEvent.change(profileSelect, { target: { value: 'fogra39' } });
    fireEvent.change(intentSelect, { target: { value: 'relative' } });
    fireEvent.change(screen.getByRole('slider', { name: 'bu_sang_lstar' }), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByRole('slider', { name: 'tuong_phan_percent' }), {
      target: { value: '5' },
    });
    fireEvent.change(screen.getByRole('slider', { name: 'do_ruc_percent' }), {
      target: { value: '-4' },
    });
    expect(store.getState().outputPreviewProfileId).toBe('fogra39');
    expect(store.getState().outputPreviewRenderingIntent).toBe('relative');

    fireEvent.click(screen.getByRole('button', { name: 'run' }));
    await waitFor(() => expect(onFileFixed).toHaveBeenCalledTimes(1));
    const convertCall = authenticatedFetch.mock.calls.find(
      ([input]) => String(input).includes('/convert-colors'),
    );
    expect(JSON.parse(String(convertCall?.[1]?.body))).toMatchObject({
      icc_profile: 'fogra39',
      rendering_intent: 'relative',
      preserve_black: true,
      black_point_compensation: true,
      adjustment_stage: 'post_cmyk',
      brightness_lstar: 2,
      contrast_percent: 5,
      vibrance_percent: -4,
    });
  });

  it('PDF/X hiển thị cảnh báo mất vector do backend trả về', async () => {
    const onFileFixed = vi.fn();
    authenticatedFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/download/')) return blobResponse();
      return jsonResponse({
        success: true,
        output_filename: 'flattened.pdf',
        warnings: ['MẤT VECTOR: trang 1 đã raster hoá'],
        engine: 'pikepdf',
      });
    });

    render(
      <SavePdfxTool
        pdfFile={new File(['input'], 'input.pdf', { type: 'application/pdf' })}
        onFileFixed={onFileFixed}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'run' }));

    await waitFor(() => expect(onFileFixed).toHaveBeenCalledTimes(1));
    expect(screen.getByText('MẤT VECTOR: trang 1 đã raster hoá')).not.toBeNull();
  });

  it('PDF/X không commit hoặc hiện xanh khi download artifact thất bại', async () => {
    const onFileFixed = vi.fn();
    authenticatedFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/download/')) return errorResponse('File đã hết hạn', 404);
      return jsonResponse({
        success: true,
        output_filename: 'missing.pdf',
        warnings: [],
      });
    });

    render(
      <SavePdfxTool
        pdfFile={new File(['input'], 'input.pdf', { type: 'application/pdf' })}
        onFileFixed={onFileFixed}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'run' }));

    await waitFor(() => expect(screen.getByText(/❌/)).not.toBeNull());
    expect(onFileFixed).not.toHaveBeenCalled();
    expect(screen.queryByText('da_xuat_x_thanh_cong', { exact: false })).toBeNull();
  });

  it('chuyển màu không commit hoặc giữ panel thành công khi download lỗi', async () => {
    const onFileFixed = vi.fn();
    authenticatedFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/icc-profiles')) {
        return jsonResponse({
          profiles: [
            { id: 'fogra39', name: 'FOGRA39', description: 'Coated', available: true },
          ],
        });
      }
      if (url.includes('/download/')) return errorResponse('File đã hết hạn', 404);
      return jsonResponse({ success: true, output_filename: 'missing-colors.pdf', log: [] });
    });

    render(
      <WorkspaceContext.Provider value={createWorkspaceStore()}>
        <ConvertColorsTool
          pdfFile={new File(['input'], 'input.pdf', { type: 'application/pdf' })}
          onFileFixed={onFileFixed}
        />
      </WorkspaceContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'run' }));

    await waitFor(() => expect(screen.getByText(/File đã hết hạn/)).not.toBeNull());
    expect(onFileFixed).not.toHaveBeenCalled();
    expect(screen.queryByText('thanh_cong', { exact: true })).toBeNull();
  });

  it('PDF/X compliance HTTP lỗi phải hiện detail thay vì panel im lặng', async () => {
    authenticatedFetch.mockResolvedValue(errorResponse('Không đọc được PDF', 422));
    render(
      <SavePdfxTool
        pdfFile={new File(['input'], 'input.pdf', { type: 'application/pdf' })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'kiem_tra_compliance' }));
    await waitFor(() => expect(screen.getByText(/Không đọc được PDF/)).not.toBeNull());
  });

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
