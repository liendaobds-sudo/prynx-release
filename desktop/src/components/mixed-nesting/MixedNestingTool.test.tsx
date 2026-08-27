// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import NestingPreview from './NestingPreview';
import ResultSummary from './ResultSummary';
import type { PartSource } from '../../lib/mixed-nesting/previewGeometry';
import { UNPLACED_TEXT, formatMm, formatPercent } from '../../lib/mixed-nesting/resultText';
import type { PlacementManifest, SheetSpec } from '../../lib/mixed-nesting/types';

const apiMocks = vi.hoisted(() => ({
  getCapabilities: vi.fn(),
  exportJob: vi.fn(),
  fetchJobArtifact: vi.fn(),
  deleteJob: vi.fn(),
  createJob: vi.fn(),
  cancelJob: vi.fn(),
  getJobStatus: vi.fn(),
  getJobResult: vi.fn(),
  // PHẢI có: vỏ tool truyền hằng này vào `setInterval`. Thiếu nó thì mock trả `undefined`,
  // `setInterval(fn, undefined)` bắn mỗi tick và gọi `getJobStatus` cũng `undefined` — cả
  // nhóm test đỏ vì một hằng bị bỏ khỏi mock, chứ không vì sản phẩm sai.
  POLL_INTERVAL_MS: 400,
  MixedNestingApiError: class MixedNestingApiError extends Error {
    status: number;
    code?: string;
    constructor(message: string, status: number, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
    get isUnavailable() {
      return this.status === 404;
    }
    get isForbidden() {
      return this.status === 403;
    }
    get isEngineUnavailable() {
      return this.status === 503 || this.code === 'ENGINE_UNAVAILABLE';
    }
  },
}));
vi.mock('../../lib/mixed-nesting/api', () => apiMocks);

const saveMocks = vi.hoisted(() => ({ saveBlob: vi.fn() }));
vi.mock('../../lib/saveBlob', () => saveMocks);

// Nạp muộn để mock có hiệu lực.
async function loadTool() {
  return (await import('./MixedNestingTool')).default;
}

const SHEET: SheetSpec = {
  widthMm: 700,
  heightMm: 1000,
  marginMm: { left: 10, right: 10, top: 10, bottom: 10 },
  maxSheets: 20,
};

const SOURCES: PartSource[] = [
  {
    partId: 'part-a',
    outer: [
      [0, 0],
      [80, 0],
      [80, 40],
      [0, 40],
    ],
    holes: [],
  },
];

function manifest(overrides: Partial<PlacementManifest> = {}): PlacementManifest {
  const placements = [
    {
      instanceId: 'part-a#0001',
      partId: 'part-a',
      sheetIndex: 0,
      pose: { rotationDeg: 13.372849, translateXmm: 123.456789, translateYmm: 67.891234 },
    },
    {
      instanceId: 'part-a#0002',
      partId: 'part-a',
      sheetIndex: 1,
      pose: { rotationDeg: 0, translateXmm: 300, translateYmm: 400 },
    },
  ];
  return {
    protocolVersion: 1,
    engineVersion: '0.1.0',
    jobId: 'job-1',
    seed: 20260826,
    status: 'completed',
    placements,
    unplaced: [],
    stats: {
      sheetCount: 2,
      placedCount: 2,
      unplacedCount: 0,
      // 2 × 3200 mm² / (700 × 1000 × 2) = 0.004571…
      materialUtilization: 6400 / (700 * 1000 * 2),
      elapsedMs: 1840,
      attempts: 32,
      orientationEvaluations: 1840,
      poseRefinements: 312,
      terminationReason: 'all_placed',
    },
    validation: { valid: true, validatorVersion: 1 },
    ...overrides,
  };
}

beforeEach(() => {
  apiMocks.getCapabilities.mockReset();
  apiMocks.exportJob.mockReset();
  apiMocks.fetchJobArtifact.mockReset();
  apiMocks.deleteJob.mockReset();
  apiMocks.createJob.mockReset();
  apiMocks.cancelJob.mockReset();
  apiMocks.getJobStatus.mockReset();
  apiMocks.getJobResult.mockReset();
  saveMocks.saveBlob.mockReset();
  // Mặc định trả Promise cho mọi hàm vỏ tool gọi rồi `.catch(...)`. `mockReset` để lại hàm
  // trả `undefined`, và `void cancelJob(id).catch(...)` lúc đóng tab sẽ nổ TypeError ở
  // teardown — lỗi hiện ra ở test chẳng liên quan.
  apiMocks.cancelJob.mockResolvedValue({
    jobId: '',
    status: 'cancelled',
    cancelled: true,
    alreadyCancelled: false,
    terminal: true,
  });
  apiMocks.deleteJob.mockResolvedValue({ jobId: '', deleted: true });
  vi.resetModules();
});

afterEach(() => {
  cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
//  Vỏ tool: dò engine, ba trạng thái chặn, tab nền
// ─────────────────────────────────────────────────────────────────────────────

describe('MixedNestingTool', () => {
  const CAPABILITIES = {
    protocolVersion: 1,
    engineVersion: '0.1.0',
    reflection: 'forbidden' as const,
    defaultRotation: 'free' as const,
    continuousTranslation: true,
    profiles: ['fast', 'balanced', 'tight'],
    maxRequestBytes: 24 * 1024 * 1024,
  };

  it('tab nền KHÔNG gọi API — mở nhiều thẻ không tạo nhiều request', async () => {
    const Tool = await loadTool();
    render(<Tool tabId="tab-nen" isActive={false} />);
    // Cho effect chạy hết.
    await Promise.resolve();
    expect(apiMocks.getCapabilities).not.toHaveBeenCalled();
  });

  it('tab đang xem thì dò năng lực rồi mở đủ vùng làm việc', async () => {
    apiMocks.getCapabilities.mockResolvedValue(CAPABILITIES);
    const Tool = await loadTool();
    render(<Tool tabId="tab-a" isActive />);

    await waitFor(() => expect(screen.getByTestId('mn-input-panel')).toBeTruthy());
    expect(apiMocks.getCapabilities).toHaveBeenCalledTimes(1);
    // Ba vùng của tool: nhận file, bảng khuôn, tham số.
    expect(screen.getByTestId('mn-file-input')).toBeTruthy();
    expect(screen.getByTestId('mn-parts-empty')).toBeTruthy();
    // Mặc định của sản phẩm là xoay tự do, và nói ra ở panel tham số.
    expect(screen.getByText('Tự do (0°–360°)')).toBeTruthy();
  });

  it('chưa có khuôn thì nút Xếp khuôn bị khoá', async () => {
    apiMocks.getCapabilities.mockResolvedValue(CAPABILITIES);
    const Tool = await loadTool();
    render(<Tool tabId="tab-a" isActive />);
    await waitFor(() => expect(screen.getByTestId('mn-run')).toBeTruthy());
    expect((screen.getByTestId('mn-run') as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    [404, 'rollout'],
    [403, 'license'],
    [503, 'engine'],
    [500, 'unknown'],
  ])('status %i hiện đúng nguyên nhân chặn %s', async (status, reason) => {
    apiMocks.getCapabilities.mockRejectedValue(
      new apiMocks.MixedNestingApiError('bi chan', status),
    );
    const Tool = await loadTool();
    render(<Tool tabId="tab-a" isActive />);

    const blocked = await waitFor(() => screen.getByTestId('mixed-nesting-blocked'));
    expect(blocked.getAttribute('data-reason')).toBe(reason);
  });

  it('không hiện nút Thử lại khi bị chặn bởi quyền hoặc cờ phát hành', async () => {
    apiMocks.getCapabilities.mockRejectedValue(
      new apiMocks.MixedNestingApiError('free', 403),
    );
    const Tool = await loadTool();
    render(<Tool tabId="tab-a" isActive />);
    await waitFor(() => screen.getByTestId('mixed-nesting-blocked'));
    expect(screen.queryByText('Thử lại')).toBeNull();
  });

  it('báo không-dirty và đặt tiêu đề thẻ', async () => {
    apiMocks.getCapabilities.mockResolvedValue(CAPABILITIES);
    const onDirtyChange = vi.fn();
    const onTitleChange = vi.fn();
    const Tool = await loadTool();
    render(
      <Tool tabId="tab-a" isActive onDirtyChange={onDirtyChange} onTitleChange={onTitleChange} />,
    );
    await waitFor(() => expect(onTitleChange).toHaveBeenCalledWith('Bình lồng ghép tự do'));
    expect(onDirtyChange).toHaveBeenCalledWith(false);
  });

  it('gắn tabId vào DOM để hai thẻ không lẫn nhau', async () => {
    apiMocks.getCapabilities.mockResolvedValue(CAPABILITIES);
    const Tool = await loadTool();
    const { container } = render(<Tool tabId="tab-x" isActive />);
    expect(container.querySelector('[data-tab-id="tab-x"]')).toBeTruthy();
  });

  it('không đăng ký listener toàn cục nào', async () => {
    apiMocks.getCapabilities.mockResolvedValue(CAPABILITIES);
    const spy = vi.spyOn(window, 'addEventListener');
    const Tool = await loadTool();
    render(<Tool tabId="tab-a" isActive />);
    await waitFor(() => screen.getByTestId('mn-input-panel'));
    // Home, routing PDF mặc định, Combine, N-Up… phải giữ nguyên hành vi.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Preview: nhiều tờ, pause tab nền, không snap
// ─────────────────────────────────────────────────────────────────────────────

describe('NestingPreview', () => {
  it('tab nền chỉ hiện tóm tắt, KHÔNG dựng SVG', () => {
    const { container } = render(
      <NestingPreview
        manifest={manifest()}
        sheet={SHEET}
        sources={SOURCES}
        activeSheetIndex={0}
        onActiveSheetChange={vi.fn()}
        isActive={false}
      />,
    );
    expect(screen.getByTestId('mn-preview-paused')).toBeTruthy();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('nhiều tờ thì có thanh chọn tờ, mỗi tờ đếm đúng số con', () => {
    render(
      <NestingPreview
        manifest={manifest()}
        sheet={SHEET}
        sources={SOURCES}
        activeSheetIndex={0}
        onActiveSheetChange={vi.fn()}
      />,
    );
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0].textContent).toContain('Tờ 1');
    expect(tabs[0].textContent).toContain('(1)');
    expect(tabs[1].textContent).toContain('(1)');
  });

  it('một tờ thì không hiện thanh chọn', () => {
    const single = manifest({
      placements: [manifest().placements[0]],
      stats: { ...manifest().stats, sheetCount: 1, placedCount: 1 },
    });
    render(
      <NestingPreview
        manifest={single}
        sheet={SHEET}
        sources={SOURCES}
        activeSheetIndex={0}
        onActiveSheetChange={vi.fn()}
      />,
    );
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  it('chỉ số tờ ngoài phạm vi thì về tờ đầu, không vẽ rỗng câm', () => {
    const { container } = render(
      <NestingPreview
        manifest={manifest()}
        sheet={SHEET}
        sources={SOURCES}
        activeSheetIndex={99}
        onActiveSheetChange={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-sheet-index="0"]')).toBeTruthy();
  });

  it('viewBox theo mm thật và giữ nguyên phần lẻ của khổ tờ', () => {
    const { container } = render(
      <NestingPreview
        manifest={manifest()}
        sheet={{ ...SHEET, widthMm: 100.37, heightMm: 60.73 }}
        sources={SOURCES}
        activeSheetIndex={0}
        onActiveSheetChange={vi.fn()}
      />,
    );
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 100.37 60.73');
  });

  it('path mang đúng pose của manifest, không bị làm tròn', () => {
    const { container } = render(
      <NestingPreview
        manifest={manifest()}
        sheet={SHEET}
        sources={SOURCES}
        activeSheetIndex={0}
        onActiveSheetChange={vi.fn()}
      />,
    );
    const path = container.querySelector('[data-instance-id="part-a#0001"]');
    expect(path?.getAttribute('data-rotation-deg')).toBe('13.372849');
    const d = path?.getAttribute('d') ?? '';
    // Toạ độ phần lẻ phải còn trong đường vẽ.
    expect(/\d+\.\d{4,}/.test(d)).toBe(true);
  });

  it('chi tiết lọt ra ngoài lề được tô cảnh báo', () => {
    const lech = manifest({
      placements: [
        {
          instanceId: 'part-a#0001',
          partId: 'part-a',
          sheetIndex: 0,
          pose: { rotationDeg: 0, translateXmm: 5, translateYmm: 5 },
        },
      ],
      stats: { ...manifest().stats, sheetCount: 1, placedCount: 1 },
    });
    const { container } = render(
      <NestingPreview
        manifest={lech}
        sheet={SHEET}
        sources={SOURCES}
        activeSheetIndex={0}
        onActiveSheetChange={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-instance-id="part-a#0001"]')?.getAttribute('stroke')).toBe(
      '#dc2626',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Tóm tắt: utilization tính lại, lý do chưa xếp phân biệt rõ
// ─────────────────────────────────────────────────────────────────────────────

describe('ResultSummary', () => {
  it('hiện số tờ, đã xếp, chưa xếp và lý do kết thúc', () => {
    render(<ResultSummary manifest={manifest()} sheet={SHEET} sources={SOURCES} />);
    expect(screen.getByText('Đã xếp')).toBeTruthy();
    expect(screen.getByText('Đã xếp hết và tìm xong theo kế hoạch')).toBeTruthy();
  });

  it('không báo lệch khi số engine khớp số tính lại', () => {
    render(<ResultSummary manifest={manifest()} sheet={SHEET} sources={SOURCES} />);
    expect(screen.queryByTestId('mn-utilization-mismatch')).toBeNull();
  });

  it('báo lệch khi engine tự khai một tỷ lệ khác', () => {
    const lech = manifest({
      stats: { ...manifest().stats, materialUtilization: 0.95 },
    });
    render(<ResultSummary manifest={lech} sheet={SHEET} sources={SOURCES} />);
    const canhBao = screen.getByTestId('mn-utilization-mismatch');
    expect(canhBao.textContent).toContain('khác số engine báo');
  });

  it('phân biệt "không vừa thật" với "hết ngân sách tìm kiếm"', () => {
    expect(UNPLACED_TEXT.NO_FEASIBLE_POSE).not.toBe(UNPLACED_TEXT.SEARCH_BUDGET_EXHAUSTED);
    expect(UNPLACED_TEXT.NO_FEASIBLE_POSE).toContain('Không vừa');
    expect(UNPLACED_TEXT.SEARCH_BUDGET_EXHAUSTED).toContain('ngân sách');

    const thieu = manifest({
      unplaced: [
        { instanceId: 'part-a#0003', partId: 'part-a', reason: 'NO_FEASIBLE_POSE' },
        { instanceId: 'part-a#0004', partId: 'part-a', reason: 'SEARCH_BUDGET_EXHAUSTED' },
      ],
      stats: { ...manifest().stats, unplacedCount: 2 },
    });
    render(<ResultSummary manifest={thieu} sheet={SHEET} sources={SOURCES} />);
    const danh_sach = screen.getByTestId('mn-unplaced');
    expect(danh_sach.textContent).toContain('Không vừa');
    expect(danh_sach.textContent).toContain('ngân sách');
  });

  it('đếm đúng số góc không vuông', () => {
    const { container } = render(
      <ResultSummary manifest={manifest()} sheet={SHEET} sources={SOURCES} />,
    );
    // "1 / 2" xuất hiện ở hai chỗ (góc không vuông và toạ độ phần lẻ) nên phải tra theo
    // nhãn đi kèm, không tra theo chuỗi giá trị.
    const labels = [...container.querySelectorAll('dt')];
    const gocLabel = labels.find((node) => node.textContent === 'Góc không vuông');
    expect(gocLabel?.nextElementSibling?.textContent?.trim()).toBe('1 / 2');

    const leLabel = labels.find((node) => node.textContent === 'Toạ độ có phần lẻ');
    expect(leLabel?.nextElementSibling?.textContent?.trim()).toBe('1 / 2');
  });

  it('formatMm và formatPercent không cắt mất chữ số có nghĩa', () => {
    expect(formatMm(93.34)).toBe('93.34 mm');
    expect(formatMm(100)).toBe('100 mm');
    expect(formatPercent(0.8123)).toBe('81.23%');
    expect(formatPercent(0.004571428571)).toBe('0.4571%');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Xuất PDF — phase P14a nối vào UI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dựng một tab đã có kết quả dùng được, đi qua ĐÚNG các lệnh của store thật.
 *
 * Không nhồi state trực tiếp: `hasUsableResult` đòi `manifestRevision === revision`, và chỉ
 * `beginRun` + `applyManifest` mới đặt được cặp đó cho đúng. Nhồi tay là test sẽ xanh trong
 * khi sản phẩm đỏ.
 */
async function seedTabWithResult(tabId: string) {
  const store = (await import('../../stores/useMixedNestingStore')).useMixedNestingStore;
  const api = store.getState();
  api.initTab(tabId);
  api.addPart(tabId, {
    partId: 'part-a',
    quantity: 2,
    outer: SOURCES[0].outer,
    holes: [],
    rotationConstraint: { mode: 'inherit' },
    sourceLabel: 'khuon.pdf — trang 1',
  });
  api.beginRun(tabId, 'job-1');
  // Đưa job về terminal như đời thật: job đã có manifest thì đã xong. Bỏ bước này thì vòng
  // polling của vỏ tool vẫn chạy và test đo lẫn cả đường polling.
  api.applyJobStatus(tabId, {
    jobId: 'job-1',
    status: 'completed',
    terminal: true,
    cancelRequested: false,
    createdAt: 1_787_000_000,
    progress: null,
    errorCode: null,
    message: null,
  });
  const accepted = api.applyManifest(tabId, manifest());
  if (!accepted) throw new Error('manifest mẫu bị validator từ chối — sửa fixture, không sửa store');
  return store;
}

const EXPORT_RESULT = {
  artifactId: 'a1b2c3',
  jobId: 'job-1',
  sheetCount: 2,
  sizeBytes: 4096,
  sourceRevision: 'rev-abc',
  exportRuleVersion: 1,
  fileName: 'long-ghep-job-1.pdf',
};

describe('MixedNestingTool — xuất PDF', () => {
  const CAPABILITIES = {
    protocolVersion: 1,
    engineVersion: '0.1.0',
    reflection: 'forbidden' as const,
    defaultRotation: 'free' as const,
    continuousTranslation: true,
    profiles: ['fast', 'balanced', 'tight'],
    maxRequestBytes: 24 * 1024 * 1024,
  };

  async function renderWithResult(tabId = 'tab-export') {
    apiMocks.getCapabilities.mockResolvedValue(CAPABILITIES);
    const Tool = await loadTool();
    const store = await seedTabWithResult(tabId);
    render(<Tool tabId={tabId} isActive />);
    await waitFor(() => expect(screen.getByTestId('mn-export')).toBeTruthy());
    return store;
  }

  it('chưa có kết quả thì KHÔNG có nút Xuất PDF', async () => {
    apiMocks.getCapabilities.mockResolvedValue(CAPABILITIES);
    const Tool = await loadTool();
    render(<Tool tabId="tab-chua-co" isActive />);
    await waitFor(() => screen.getByTestId('mn-input-panel'));
    expect(screen.queryByTestId('mn-export')).toBeNull();
  });

  it('có kết quả dùng được thì hiện nút Xuất PDF', async () => {
    await renderWithResult();
    expect((screen.getByTestId('mn-export') as HTMLButtonElement).disabled).toBe(false);
  });

  it('bấm Xuất PDF thì sinh file rồi tải bytes rồi mới mở hộp thoại lưu', async () => {
    apiMocks.exportJob.mockResolvedValue(EXPORT_RESULT);
    const blob = new Blob([new Uint8Array([37, 80, 68, 70])], { type: 'application/pdf' });
    apiMocks.fetchJobArtifact.mockResolvedValue(blob);
    saveMocks.saveBlob.mockResolvedValue({ kind: 'saved' });
    await renderWithResult();

    fireEvent.click(screen.getByTestId('mn-export'));
    await waitFor(() => expect(screen.getByTestId('mn-export-saved')).toBeTruthy());

    // Thứ tự là hợp đồng: publish trước, stream sau. Đảo lại thì chưa có gì để tải.
    expect(apiMocks.exportJob).toHaveBeenCalledWith('job-1');
    expect(apiMocks.fetchJobArtifact).toHaveBeenCalledWith('job-1');
    expect(apiMocks.exportJob.mock.invocationCallOrder[0]).toBeLessThan(
      apiMocks.fetchJobArtifact.mock.invocationCallOrder[0],
    );
    expect(saveMocks.saveBlob).toHaveBeenCalledTimes(1);
    expect(saveMocks.saveBlob.mock.calls[0][0]).toBe(blob);
    expect(saveMocks.saveBlob.mock.calls[0][1]).toBe('long-ghep-job-1.pdf');
    expect(screen.getByTestId('mn-export-saved').textContent).toContain('2 tờ');
  });

  it('KHÔNG gửi khổ tờ hay tham số nào khác ngoài jobId', async () => {
    apiMocks.exportJob.mockResolvedValue(EXPORT_RESULT);
    apiMocks.fetchJobArtifact.mockResolvedValue(new Blob([]));
    saveMocks.saveBlob.mockResolvedValue({ kind: 'saved' });
    await renderWithResult();

    fireEvent.click(screen.getByTestId('mn-export'));
    await waitFor(() => expect(apiMocks.exportJob).toHaveBeenCalled());
    // Nhận khổ ở lần xuất là mở đường xuất khác khổ đã validate lúc chạy solve.
    expect(apiMocks.exportJob.mock.calls[0]).toEqual(['job-1']);
  });

  it('người dùng bấm Huỷ ở hộp thoại lưu thì KHÔNG báo đã lưu', async () => {
    apiMocks.exportJob.mockResolvedValue(EXPORT_RESULT);
    apiMocks.fetchJobArtifact.mockResolvedValue(new Blob([]));
    saveMocks.saveBlob.mockResolvedValue({ kind: 'cancelled' });
    await renderWithResult();

    fireEvent.click(screen.getByTestId('mn-export'));
    await waitFor(() => expect(saveMocks.saveBlob).toHaveBeenCalled());
    await waitFor(() =>
      expect((screen.getByTestId('mn-export') as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.queryByTestId('mn-export-saved')).toBeNull();
    expect(screen.queryByTestId('mn-export-error')).toBeNull();
  });

  it('lỗi khi xuất thì hiện thông báo lỗi, không hiện thông báo đã lưu', async () => {
    apiMocks.exportJob.mockRejectedValue(
      new apiMocks.MixedNestingApiError('Khuôn nguồn đã hết hạn nên không xuất được.', 409),
    );
    await renderWithResult();

    fireEvent.click(screen.getByTestId('mn-export'));
    const loi = await waitFor(() => screen.getByTestId('mn-export-error'));
    expect(loi.textContent).toContain('hết hạn');
    expect(screen.queryByTestId('mn-export-saved')).toBeNull();
    // Không tải bytes khi bước sinh file đã thất bại.
    expect(apiMocks.fetchJobArtifact).not.toHaveBeenCalled();
  });

  it('đang xuất thì nút bị khoá để không sinh hai file cho cùng một job', async () => {
    let release: (value: typeof EXPORT_RESULT) => void = () => undefined;
    apiMocks.exportJob.mockReturnValue(
      new Promise<typeof EXPORT_RESULT>((resolve) => {
        release = resolve;
      }),
    );
    apiMocks.fetchJobArtifact.mockResolvedValue(new Blob([]));
    saveMocks.saveBlob.mockResolvedValue({ kind: 'saved' });
    await renderWithResult();

    fireEvent.click(screen.getByTestId('mn-export'));
    await waitFor(() =>
      expect((screen.getByTestId('mn-export') as HTMLButtonElement).disabled).toBe(true),
    );
    expect(screen.getByTestId('mn-export').textContent).toContain('Đang xuất');

    release(EXPORT_RESULT);
    await waitFor(() => expect(screen.getByTestId('mn-export-saved')).toBeTruthy());
    expect(apiMocks.exportJob).toHaveBeenCalledTimes(1);
  });

  it('bỏ kết quả thì thông báo đã lưu biến mất cùng nút Xuất', async () => {
    apiMocks.exportJob.mockResolvedValue(EXPORT_RESULT);
    apiMocks.fetchJobArtifact.mockResolvedValue(new Blob([]));
    saveMocks.saveBlob.mockResolvedValue({ kind: 'saved' });
    apiMocks.deleteJob.mockResolvedValue({ jobId: 'job-1', deleted: true });
    await renderWithResult();

    fireEvent.click(screen.getByTestId('mn-export'));
    await waitFor(() => screen.getByTestId('mn-export-saved'));

    fireEvent.click(screen.getByTestId('mn-discard'));
    await waitFor(() => expect(screen.queryByTestId('mn-export')).toBeNull());
    expect(screen.queryByTestId('mn-export-saved')).toBeNull();
  });

  it('chạy lại ra job khác thì thông báo đã lưu của job cũ hết hiệu lực', async () => {
    apiMocks.exportJob.mockResolvedValue(EXPORT_RESULT);
    apiMocks.fetchJobArtifact.mockResolvedValue(new Blob([]));
    saveMocks.saveBlob.mockResolvedValue({ kind: 'saved' });
    const store = await renderWithResult('tab-relaunch');

    fireEvent.click(screen.getByTestId('mn-export'));
    await waitFor(() => screen.getByTestId('mn-export-saved'));

    // Lượt chạy mới: `jobId` đổi ⇒ trạng thái xuất cũ không còn khớp. Job mới chưa terminal
    // nên vòng polling sẽ chạy — cho nó một snapshot hợp lệ để không lẫn lỗi khác vào.
    apiMocks.getJobStatus.mockResolvedValue({
      jobId: 'job-2',
      status: 'running',
      terminal: false,
      cancelRequested: false,
      createdAt: 1_787_000_001,
      progress: null,
      errorCode: null,
      message: null,
    });
    act(() => {
      store.getState().beginRun('tab-relaunch', 'job-2');
    });
    await waitFor(() => expect(screen.queryByTestId('mn-export-saved')).toBeNull());
  });
});
