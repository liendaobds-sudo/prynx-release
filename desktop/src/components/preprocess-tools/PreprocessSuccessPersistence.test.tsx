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

function colorPreviewResponse({
  requestId = 'preview-1',
  policy = 'manual',
  page = 1,
  gamutMapping = 'icc',
  scopeNote = 'Chỉ số của trang đang xem',
  adjustments = {
    brightness_lstar: 0,
    contrast_percent: 0,
    vibrance_percent: 0,
    adjustment_stage: 'post_cmyk',
  },
  recommendation = {
    status: 'manual',
    gates_passed: false,
    reason_codes: ['MANUAL_SETTINGS_NOT_RANKED'],
  },
}: {
  requestId?: string;
  policy?: 'manual' | 'balanced-v1';
  page?: number;
  gamutMapping?: 'icc' | 'adaptive_vivid';
  scopeNote?: string;
  adjustments?: {
    brightness_lstar: number;
    contrast_percent: number;
    vibrance_percent: number;
    adjustment_stage: 'post_cmyk' | 'pre_icc';
  };
  recommendation?: {
    status: 'manual' | 'recommended' | 'identity' | 'unavailable';
    gates_passed: boolean;
    reason_codes: string[];
  };
}) {
  return {
    success: true,
    request_id: requestId,
    page,
    requested_dpi: 150,
    effective_dpi: 150,
    effective_adjustments: adjustments,
    effective_options: {
      gamut_mapping: gamutMapping,
    },
    preview: {
      source_b64: 'cHJldmlldw==',
      output_b64: 'cHJldmlldw==',
      gamut_b64: null,
      mime: 'image/png',
      width: 80,
      height: 60,
      proof_accuracy: 'rip_softproof',
      proof_engine: 'ppe+lcms',
      measurement_basis: 'display_rgb_vs_rip_softproof',
    },
    metrics: {
      sample_pixels: 4_800,
      delta_lstar_mean: 0.25,
      delta_chroma_mean: 1.5,
      delta_e00_mean: 1.75,
      delta_e00_p95: 3.25,
      new_highlight_clip_pct: 0.1,
      new_shadow_clip_pct: 0.2,
      new_paper_white_pct: 0.05,
      neutral_delta_e00_mean: 1.0,
      skin_delta_e00_mean: 2.0,
      out_of_gamut_pct: 0.5,
      tac: {
        available: true,
        mean_pct: 126.2 as number | null,
        p95_pct: 229.4 as number | null,
        max_pct: 306.7 as number | null,
        engine: 'ppe',
        spot_excluded: true,
        spot_plate_count: 0,
      },
    },
    recommendation: {
      policy,
      ...recommendation,
    },
    warnings: [scopeNote],
  };
}

function colorPreviewFromRequest(options?: RequestInit) {
  const body = JSON.parse(String(options?.body));
  return colorPreviewResponse({
    requestId: body.request_id,
    policy: body.preview_policy,
    page: body.page,
    gamutMapping: body.gamut_mapping,
    adjustments: {
      brightness_lstar: body.brightness_lstar,
      contrast_percent: body.contrast_percent,
      vibrance_percent: body.vibrance_percent,
      adjustment_stage: body.adjustment_stage,
    },
  });
}

function openColorAdvancedOptions() {
  const toggle = screen.getByTestId('color-advanced-toggle');
  if (toggle.getAttribute('aria-expanded') !== 'true') {
    fireEvent.click(toggle);
  }
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
      authenticatedFetch.mockImplementation(async (
        input: RequestInfo | URL,
        options?: RequestInit,
      ) => {
        const url = String(input);
        if (url.includes('/icc-profiles')) {
          return jsonResponse({
            profiles: [
              { id: 'fogra39', name: 'FOGRA39', description: 'Coated', available: true },
            ],
          });
        }
        if (url.includes('/convert-colors/preview')) {
          return jsonResponse(colorPreviewFromRequest(options));
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

      if (Component === ConvertColorsTool) {
        fireEvent.click(
          screen.getByRole('button', { name: 'xem_truoc_thong_so_hien_tai' }),
        );
        await waitFor(() => {
          expect((screen.getByRole('button', { name: 'run' }) as HTMLButtonElement).disabled)
            .toBe(false);
        });
      }
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
    authenticatedFetch.mockImplementation(async (
      input: RequestInfo | URL,
      options?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes('/icc-profiles')) {
        return jsonResponse({
          profiles: [
            { id: 'fogra39', name: 'FOGRA39', description: 'Coated', available: true },
            { id: 'swop', name: 'SWOP', description: 'Web offset', available: true },
          ],
        });
      }
      if (url.includes('/convert-colors/preview')) {
        return jsonResponse(colorPreviewFromRequest(options));
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

    openColorAdvancedOptions();
    const profileSelect = await screen.findByRole('combobox', { name: 'ho_so_mau_dich' });
    const intentSelect = screen.getByRole('combobox', { name: 'rendering_intent' });
    expect((profileSelect as HTMLSelectElement).value).toBe('swop');
    expect((intentSelect as HTMLSelectElement).value).toBe('perceptual');

    fireEvent.change(profileSelect, { target: { value: 'fogra39' } });
    fireEvent.change(intentSelect, { target: { value: 'relative' } });
    expect(store.getState().outputPreviewProfileId).toBe('fogra39');
    expect(store.getState().outputPreviewRenderingIntent).toBe('relative');

    fireEvent.click(
      screen.getByRole('button', { name: 'xem_truoc_thong_so_hien_tai' }),
    );
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'run' }) as HTMLButtonElement).disabled)
        .toBe(false);
    });

    const adjustmentStageSelect = screen.getByRole('combobox', { name: 'vi_tri_tinh_chinh' });
    expect((adjustmentStageSelect as HTMLSelectElement).value).toBe('post_cmyk');
    fireEvent.change(screen.getByRole('slider', { name: 'bu_sang_lstar' }), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByRole('slider', { name: 'tuong_phan_percent' }), {
      target: { value: '5' },
    });
    fireEvent.change(screen.getByRole('slider', { name: 'do_ruc_percent' }), {
      target: { value: '-4' },
    });
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'run' }) as HTMLButtonElement).disabled)
        .toBe(false);
    }, { timeout: 2000 });
    fireEvent.click(screen.getByRole('button', { name: 'run' }));
    await waitFor(() => expect(onFileFixed).toHaveBeenCalledTimes(1));
    const convertCall = authenticatedFetch.mock.calls.find(
      ([input]) => String(input).endsWith('/preflight/convert-colors'),
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

  it('preview cân bằng chỉ điền slider rồi execute đúng numerics đã xem', async () => {
    const onFileFixed = vi.fn();
    const store = createWorkspaceStore();
    store.setState({ viewerActivePage: 2 });
    const suggested = {
      brightness_lstar: 1,
      contrast_percent: 2,
      vibrance_percent: 6,
      adjustment_stage: 'post_cmyk' as const,
    };

    authenticatedFetch.mockImplementation(async (
      input: RequestInfo | URL,
      options?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes('/icc-profiles')) {
        return jsonResponse({
          profiles: [
            { id: 'fogra39', name: 'FOGRA39', description: 'Coated', available: true },
          ],
        });
      }
      if (url.includes('/convert-colors/preview')) {
        const body = JSON.parse(String(options?.body));
        return jsonResponse(colorPreviewResponse({
          requestId: body.request_id,
          policy: body.preview_policy,
          page: body.page,
          scopeNote: 'Chỉ số riêng của trang 2',
          adjustments: suggested,
          recommendation: {
            status: 'recommended',
            gates_passed: true,
            reason_codes: [],
          },
        }));
      }
      if (url.includes('/download/')) return blobResponse();
      return jsonResponse({ success: true, output_filename: 'balanced.pdf', log: [] });
    });

    render(
      <WorkspaceContext.Provider value={store}>
        <ConvertColorsTool
          pdfFile={new File(['input'], 'input.pdf', { type: 'application/pdf' })}
          onFileFixed={onFileFixed}
        />
      </WorkspaceContext.Provider>,
    );

    openColorAdvancedOptions();
    const runButton = screen.getByRole('button', { name: 'run' }) as HTMLButtonElement;
    expect(runButton.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'sang_nhe_2' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'goi_y_can_bang_trang' }));
    await waitFor(() => expect(screen.getByText('Chỉ số riêng của trang 2')).not.toBeNull());

    expect(onFileFixed).not.toHaveBeenCalled();
    expect(authenticatedFetch.mock.calls.some(
      ([input]) => String(input).includes('/download/'),
    )).toBe(false);
    expect((screen.getByRole('slider', { name: 'bu_sang_lstar' }) as HTMLInputElement).value)
      .toBe('0');
    expect(runButton.disabled).toBe(true);
    expect(screen.getByText(/306\.70%/)).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'ap_dung_goi_y_an_toan' }));
    expect((screen.getByRole('slider', { name: 'bu_sang_lstar' }) as HTMLInputElement).value)
      .toBe('1');
    expect((screen.getByRole('slider', { name: 'tuong_phan_percent' }) as HTMLInputElement).value)
      .toBe('2');
    expect((screen.getByRole('slider', { name: 'do_ruc_percent' }) as HTMLInputElement).value)
      .toBe('6');
    await waitFor(() => expect(runButton.disabled).toBe(false));

    fireEvent.click(runButton);
    await waitFor(() => expect(onFileFixed).toHaveBeenCalledTimes(1));

    const previewCall = authenticatedFetch.mock.calls.find(
      ([input]) => String(input).includes('/convert-colors/preview'),
    );
    expect(JSON.parse(String(previewCall?.[1]?.body))).toMatchObject({
      page: 2,
      preview_policy: 'balanced-v1',
      brightness_lstar: 0,
      contrast_percent: 0,
      vibrance_percent: 0,
    });
    const executeCall = authenticatedFetch.mock.calls.find(
      ([input]) => String(input).endsWith('/preflight/convert-colors'),
    );
    expect(JSON.parse(String(executeCall?.[1]?.body))).toMatchObject({
      brightness_lstar: 1,
      contrast_percent: 2,
      vibrance_percent: 6,
      adjustment_stage: 'post_cmyk',
    });
  });


  it('preset adaptive dùng Relative+BPC và execute đúng transform đã preview', async () => {
    const store = createWorkspaceStore();
    const onFileFixed = vi.fn();
    const previewBodies: Array<Record<string, unknown>> = [];
    const executeBodies: Array<Record<string, unknown>> = [];

    authenticatedFetch.mockImplementation(async (
      input: RequestInfo | URL,
      options?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes('/icc-profiles')) {
        return jsonResponse({
          profiles: [
            { id: 'fogra39', name: 'FOGRA39', description: 'Coated', available: true },
          ],
        });
      }
      if (url.includes('/convert-colors/preview')) {
        const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
        previewBodies.push(body);
        return jsonResponse(colorPreviewFromRequest(options));
      }
      if (url.endsWith('/preflight/convert-colors')) {
        executeBodies.push(JSON.parse(String(options?.body)) as Record<string, unknown>);
        return jsonResponse({ success: true, output_filename: 'adaptive.pdf', log: [] });
      }
      if (url.includes('/download/')) return blobResponse();
      throw new Error('Unexpected request: ' + url);
    });

    render(
      <WorkspaceContext.Provider value={store}>
        <ConvertColorsTool
          pdfFile={new File(['input'], 'input.pdf', { type: 'application/pdf' })}
          onFileFixed={onFileFixed}
        />
      </WorkspaceContext.Provider>,
    );

    fireEvent.click(screen.getByTestId('color-vivid-preset'));

    await waitFor(() => expect(previewBodies).toHaveLength(1));
    expect(previewBodies[0]).toMatchObject({
      conversions: ['rgb_to_cmyk'],
      rendering_intent: 'relative',
      black_point_compensation: true,
      gamut_mapping: 'adaptive_vivid',
      adjustment_stage: 'post_cmyk',
      brightness_lstar: 0,
      contrast_percent: 0,
      vibrance_percent: 0,
    });
    expect(screen.queryByTestId('color-advanced-options')).toBeNull();
    expect(screen.getByTestId('color-vivid-preset').getAttribute('aria-pressed'))
      .toBe('true');

    const runButton = screen.getByRole('button', { name: 'run' }) as HTMLButtonElement;
    await waitFor(() => expect(runButton.disabled).toBe(false));
    fireEvent.click(runButton);
    await waitFor(() => expect(onFileFixed).toHaveBeenCalledTimes(1));

    const transformKeys = [
      'conversions', 'icc_profile', 'rendering_intent', 'preserve_black',
      'black_point_compensation', 'gamut_mapping', 'adjustment_stage',
      'brightness_lstar', 'contrast_percent', 'vibrance_percent',
    ] as const;
    const transformFrom = (body: Record<string, unknown>) => Object.fromEntries(
      transformKeys.map(key => [key, body[key]]),
    );
    expect(executeBodies).toHaveLength(1);
    expect(transformFrom(executeBodies[0])).toEqual(transformFrom(previewBodies[0]));
  });
  it('cập nhật preview theo slider và bỏ response cũ khi thông số đổi', async () => {
    const store = createWorkspaceStore();
    const onFileFixed = vi.fn();
    const previewBodies: Array<Record<string, unknown>> = [];
    const previewResolvers: Array<(value: ReturnType<typeof jsonResponse>) => void> = [];
    let previewCallCount = 0;

    authenticatedFetch.mockImplementation(async (
      input: RequestInfo | URL,
      options?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes('/icc-profiles')) {
        return jsonResponse({
          profiles: [
            { id: 'fogra39', name: 'FOGRA39', description: 'Coated', available: true },
          ],
        });
      }
      if (url.includes('/convert-colors/preview')) {
        const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
        previewBodies.push(body);
        previewCallCount += 1;
        if (previewCallCount === 1) {
          return jsonResponse(colorPreviewResponse({
            requestId: String(body.request_id),
            policy: 'manual',
            page: Number(body.page),
          }));
        }
        return await new Promise<ReturnType<typeof jsonResponse>>(resolve => {
          previewResolvers.push(resolve);
        });
      }
      throw new Error('Unexpected request: ' + url);
    });

    render(
      <WorkspaceContext.Provider value={store}>
        <ConvertColorsTool
          pdfFile={new File(['input'], 'input.pdf', { type: 'application/pdf' })}
          onFileFixed={onFileFixed}
        />
      </WorkspaceContext.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'xem_truoc_thong_so_hien_tai' }));
    await waitFor(() => expect(screen.queryByTestId('color-adjustment-panel')).not.toBeNull());

    fireEvent.change(screen.getByRole('slider', { name: 'bu_sang_lstar' }), {
      target: { value: '1' },
    });
    fireEvent.change(screen.getByRole('slider', { name: 'bu_sang_lstar' }), {
      target: { value: '2' },
    });
    await waitFor(() => expect(previewCallCount).toBe(2), { timeout: 2000 });
    expect(previewBodies[1].brightness_lstar).toBe(2);

    fireEvent.change(screen.getByRole('slider', { name: 'bu_sang_lstar' }), {
      target: { value: '3' },
    });
    const staleBody = previewBodies[1];
    previewResolvers[0](jsonResponse(colorPreviewResponse({
      requestId: String(staleBody.request_id),
      policy: 'manual',
      page: Number(staleBody.page),
      adjustments: {
        brightness_lstar: 2,
        contrast_percent: 0,
        vibrance_percent: 0,
        adjustment_stage: 'post_cmyk',
      },
    })));

    await waitFor(() => expect(previewCallCount).toBe(3), { timeout: 2000 });
    const latestBody = previewBodies[2];
    previewResolvers[1](jsonResponse(colorPreviewResponse({
      requestId: String(latestBody.request_id),
      policy: 'manual',
      page: Number(latestBody.page),
      adjustments: {
        brightness_lstar: 3,
        contrast_percent: 0,
        vibrance_percent: 0,
        adjustment_stage: 'post_cmyk',
      },
    })));

    await waitFor(() => {
      expect((screen.getByRole('slider', { name: 'bu_sang_lstar' }) as HTMLInputElement).value)
        .toBe('3');
      expect(previewBodies).toHaveLength(3);
      expect(previewBodies[2].brightness_lstar).toBe(3);
    });
    expect(onFileFixed).not.toHaveBeenCalled();
  });

  it('không tự áp recommendation khi PPE hoặc TAC chưa đủ tin', async () => {
    const onFileFixed = vi.fn();
    authenticatedFetch.mockImplementation(async (
      input: RequestInfo | URL,
      options?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes('/icc-profiles')) {
        return jsonResponse({
          profiles: [
            { id: 'fogra39', name: 'FOGRA39', description: 'Coated', available: true },
          ],
        });
      }
      if (url.includes('/convert-colors/preview')) {
        const body = JSON.parse(String(options?.body));
        const response = colorPreviewResponse({
          requestId: body.request_id,
          policy: body.preview_policy,
          page: body.page,
          adjustments: {
            brightness_lstar: 2,
            contrast_percent: 0,
            vibrance_percent: 4,
            adjustment_stage: 'post_cmyk',
          },
          recommendation: {
            status: 'unavailable',
            gates_passed: false,
            reason_codes: ['PROOF_OR_TAC_UNTRUSTED'],
          },
        });
        response.preview.proof_accuracy = 'approximate';
        response.preview.measurement_basis = 'display_rgb_vs_approximate_softproof';
        response.metrics.tac.available = false;
        response.metrics.tac.mean_pct = null;
        response.metrics.tac.p95_pct = null;
        response.metrics.tac.max_pct = null;
        return jsonResponse(response);
      }
      throw new Error('Unexpected request: ' + url);
    });

    render(
      <WorkspaceContext.Provider value={createWorkspaceStore()}>
        <ConvertColorsTool
          pdfFile={new File(['input'], 'input.pdf', { type: 'application/pdf' })}
          onFileFixed={onFileFixed}
        />
      </WorkspaceContext.Provider>,
    );

    openColorAdvancedOptions();
    fireEvent.click(screen.getByRole('button', { name: 'goi_y_can_bang_trang' }));
    await waitFor(() => expect(screen.queryByTestId('color-preview-result')).not.toBeNull());

    expect(screen.queryByRole('button', { name: 'ap_dung_goi_y_an_toan' })).toBeNull();
    expect((screen.getByRole('slider', { name: 'bu_sang_lstar' }) as HTMLInputElement).value)
      .toBe('0');
    expect((screen.getByRole('slider', { name: 'do_ruc_percent' }) as HTMLInputElement).value)
      .toBe('0');
    expect(onFileFixed).not.toHaveBeenCalled();
    expect(authenticatedFetch.mock.calls.some(
      ([input]) => String(input).includes('/download/'),
    )).toBe(false);
  });

  it('re-upload khi thứ tự hoặc góc trang làm Working PDF đổi revision', async () => {
    const store = createWorkspaceStore();
    const inputFile = new File(['input'], 'input.pdf', { type: 'application/pdf' });
    const previewBodies: Array<Record<string, unknown>> = [];
    uploadPDF.mockReset();
    uploadPDF
      .mockResolvedValueOnce({ id: 'working-revision-1' })
      .mockResolvedValueOnce({ id: 'working-revision-2' });

    authenticatedFetch.mockImplementation(async (
      input: RequestInfo | URL,
      options?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes('/icc-profiles')) {
        return jsonResponse({
          profiles: [
            { id: 'fogra39', name: 'FOGRA39', description: 'Coated', available: true },
          ],
        });
      }
      if (url.includes('/convert-colors/preview')) {
        const body = JSON.parse(String(options?.body));
        previewBodies.push(body);
        return jsonResponse(colorPreviewFromRequest(options));
      }
      throw new Error('Unexpected request: ' + url);
    });

    render(
      <WorkspaceContext.Provider value={store}>
        <ConvertColorsTool pdfFile={inputFile} />
      </WorkspaceContext.Provider>,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'xem_truoc_thong_so_hien_tai' }),
    );
    await waitFor(() => expect(previewBodies).toHaveLength(1));

    store.setState({
      viewerPageOrder: [2, 1],
      viewerPageRotations: [0, 0],
    });
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'run' }) as HTMLButtonElement).disabled)
        .toBe(true);
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'xem_truoc_thong_so_hien_tai' }),
    );
    await waitFor(() => expect(previewBodies).toHaveLength(2));

    expect(uploadPDF).toHaveBeenCalledTimes(2);
    expect(previewBodies.map(body => body.file_id)).toEqual([
      'working-revision-1',
      'working-revision-2',
    ]);
  });

  it('không commit response execute cũ sau khi PDF nguồn đổi', async () => {
    const store = createWorkspaceStore();
    const onFileFixed = vi.fn();
    const firstFile = new File(['first'], 'first.pdf', { type: 'application/pdf' });
    const secondFile = new File(['second'], 'second.pdf', { type: 'application/pdf' });
    let resolveExecute:
      | ((value: ReturnType<typeof jsonResponse>) => void)
      | undefined;
    let executeSignal: AbortSignal | undefined;

    authenticatedFetch.mockImplementation(async (
      input: RequestInfo | URL,
      options?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes('/icc-profiles')) {
        return jsonResponse({
          profiles: [
            { id: 'fogra39', name: 'FOGRA39', description: 'Coated', available: true },
          ],
        });
      }
      if (url.includes('/convert-colors/preview')) {
        return jsonResponse(colorPreviewFromRequest(options));
      }
      if (url.endsWith('/preflight/convert-colors')) {
        executeSignal = options?.signal ?? undefined;
        return await new Promise<ReturnType<typeof jsonResponse>>(resolve => {
          resolveExecute = resolve;
        });
      }
      if (url.includes('/download/')) return blobResponse();
      throw new Error('Unexpected request: ' + url);
    });

    const { rerender } = render(
      <WorkspaceContext.Provider value={store}>
        <ConvertColorsTool pdfFile={firstFile} onFileFixed={onFileFixed} />
      </WorkspaceContext.Provider>,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'xem_truoc_thong_so_hien_tai' }),
    );
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'run' }) as HTMLButtonElement).disabled)
        .toBe(false);
    });
    fireEvent.click(screen.getByRole('button', { name: 'run' }));
    await waitFor(() => expect(resolveExecute).toBeTypeOf('function'));

    rerender(
      <WorkspaceContext.Provider value={store}>
        <ConvertColorsTool pdfFile={secondFile} onFileFixed={onFileFixed} />
      </WorkspaceContext.Provider>,
    );
    await waitFor(() => expect(executeSignal?.aborted).toBe(true));

    resolveExecute?.(jsonResponse({
      success: true,
      output_filename: 'stale-colors.pdf',
      log: [],
    }));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(authenticatedFetch.mock.calls.some(
      ([request]) => String(request).includes('/download/'),
    )).toBe(false);
    expect(onFileFixed).not.toHaveBeenCalled();
  });

  it('không áp gợi ý cũ sau khi đổi context trang', async () => {
    const store = createWorkspaceStore();
    authenticatedFetch.mockImplementation(async (
      input: RequestInfo | URL,
      options?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes('/icc-profiles')) {
        return jsonResponse({
          profiles: [
            { id: 'fogra39', name: 'FOGRA39', description: 'Coated', available: true },
          ],
        });
      }
      if (url.includes('/convert-colors/preview')) {
        const body = JSON.parse(String(options?.body));
        return jsonResponse(colorPreviewResponse({
          requestId: body.request_id,
          policy: 'balanced-v1',
          page: body.page,
          adjustments: {
            brightness_lstar: 1,
            contrast_percent: 0,
            vibrance_percent: 4,
            adjustment_stage: 'post_cmyk',
          },
          recommendation: {
            status: 'recommended',
            gates_passed: true,
            reason_codes: [],
          },
        }));
      }
      throw new Error('Unexpected request: ' + url);
    });

    render(
      <WorkspaceContext.Provider value={store}>
        <ConvertColorsTool
          pdfFile={new File(['input'], 'input.pdf', { type: 'application/pdf' })}
        />
      </WorkspaceContext.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'goi_y_can_bang_trang' }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'ap_dung_goi_y_an_toan' }))
        .not.toBeNull();
    });

    store.setState({ viewerActivePage: 2 });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'ap_dung_goi_y_an_toan' }))
        .toBeNull();
    });
  });

  it('fail closed nếu backend gắn gates_passed cho proof hoặc TAC không tin cậy', async () => {
    authenticatedFetch.mockImplementation(async (
      input: RequestInfo | URL,
      options?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes('/icc-profiles')) {
        return jsonResponse({
          profiles: [
            { id: 'fogra39', name: 'FOGRA39', description: 'Coated', available: true },
          ],
        });
      }
      if (url.includes('/convert-colors/preview')) {
        const body = JSON.parse(String(options?.body));
        const response = colorPreviewResponse({
          requestId: body.request_id,
          policy: 'balanced-v1',
          page: body.page,
          adjustments: {
            brightness_lstar: 1,
            contrast_percent: 0,
            vibrance_percent: 4,
            adjustment_stage: 'post_cmyk',
          },
          recommendation: {
            status: 'recommended',
            gates_passed: true,
            reason_codes: [],
          },
        });
        response.preview.proof_accuracy = 'approximate';
        response.preview.measurement_basis = 'display_rgb_vs_approximate_softproof';
        response.metrics.tac.available = false;
        return jsonResponse(response);
      }
      throw new Error('Unexpected request: ' + url);
    });

    render(
      <WorkspaceContext.Provider value={createWorkspaceStore()}>
        <ConvertColorsTool
          pdfFile={new File(['input'], 'input.pdf', { type: 'application/pdf' })}
        />
      </WorkspaceContext.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'goi_y_can_bang_trang' }));
    await waitFor(() => expect(screen.queryByTestId('color-preview-result')).not.toBeNull());
    expect(screen.queryByRole('button', { name: 'ap_dung_goi_y_an_toan' })).toBeNull();
  });


  it('preview lỗi không commit hoặc làm mất file đang làm việc', async () => {
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
      if (url.includes('/convert-colors/preview')) {
        return errorResponse('PPE chưa dựng đủ trang', 422);
      }
      throw new Error('Unexpected request: ' + url);
    });

    render(
      <WorkspaceContext.Provider value={createWorkspaceStore()}>
        <ConvertColorsTool
          pdfFile={new File(['input'], 'input.pdf', { type: 'application/pdf' })}
          onFileFixed={onFileFixed}
        />
      </WorkspaceContext.Provider>,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'xem_truoc_thong_so_hien_tai' }),
    );
    await waitFor(() => {
      expect(screen.getByText('PPE chưa dựng đủ trang')).not.toBeNull();
    });
    expect(screen.getByText('chuyen_sang_cmyk')).not.toBeNull();
    expect(onFileFixed).not.toHaveBeenCalled();
    expect(authenticatedFetch.mock.calls.some(
      ([input]) => String(input).includes('/download/'),
    )).toBe(false);
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
    authenticatedFetch.mockImplementation(async (
      input: RequestInfo | URL,
      options?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes('/icc-profiles')) {
        return jsonResponse({
          profiles: [
            { id: 'fogra39', name: 'FOGRA39', description: 'Coated', available: true },
          ],
        });
      }
      if (url.includes('/convert-colors/preview')) {
        return jsonResponse(colorPreviewFromRequest(options));
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
    fireEvent.click(
      screen.getByRole('button', { name: 'xem_truoc_thong_so_hien_tai' }),
    );
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'run' }) as HTMLButtonElement).disabled)
        .toBe(false);
    });
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
