// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MixedNestingFileInput from './MixedNestingFileInput';
import type { ContourCandidate, SourceRecord } from '../../lib/mixed-nesting/types';

const apiMocks = vi.hoisted(() => ({
  createSource: vi.fn(),
  selectSourceCandidate: vi.fn(),
  acceptSourcePageBox: vi.fn(),
  MixedNestingApiError: class MixedNestingApiError extends Error {
    status: number;
    code?: string;
    constructor(message: string, status: number, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));
vi.mock('../../lib/mixed-nesting/api', () => apiMocks);

function rect(w: number, h: number): [number, number][] {
  return [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
}

function candidate(overrides: Partial<ContourCandidate> = {}): ContourCandidate {
  return {
    candidateId: 'p1-c1',
    pageNumber: 1,
    outer: rect(90, 60),
    holes: [],
    areaMm2: 5400,
    widthMm: 90,
    heightMm: 60,
    vertexCount: 4,
    rejectedReason: null,
    ...overrides,
  };
}

function source(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    sourceId: 'src-1',
    status: 'ready',
    fileName: 'hop-nap-cai.pdf',
    candidates: [candidate()],
    pages: [{ pageNumber: 1, widthMm: 210, heightMm: 297 }],
    selectedCandidateId: 'p1-c1',
    sourceRevision: 'abc123',
    flattenRuleVersion: 1,
    createdAt: 1,
    ...overrides,
  };
}

function pdfFile(name = 'khuon.pdf'): File {
  return new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, {
    type: 'application/pdf',
  });
}

function dropFiles(element: Element, files: File[]) {
  fireEvent.drop(element, { dataTransfer: { files } });
}

beforeEach(() => {
  apiMocks.createSource.mockReset();
  apiMocks.selectSourceCandidate.mockReset();
  apiMocks.acceptSourcePageBox.mockReset();
});

afterEach(() => {
  cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
//  1. Chỉ nhận PDF
// ─────────────────────────────────────────────────────────────────────────────

describe('chỉ nhận PDF', () => {
  it('file PDF được nhận và báo ready', async () => {
    apiMocks.createSource.mockResolvedValue(source());
    const onSourceReady = vi.fn();
    const { container } = render(
      <MixedNestingFileInput tabId="tab-a" isActive onSourceReady={onSourceReady} />,
    );

    dropFiles(container.querySelector('[data-drag-over]')!, [pdfFile()]);
    await waitFor(() => expect(onSourceReady).toHaveBeenCalledTimes(1));
    expect(apiMocks.createSource).toHaveBeenCalledTimes(1);
    const [, candidateArg] = onSourceReady.mock.calls[0];
    expect(candidateArg.candidateId).toBe('p1-c1');
  });

  it.each(['khuon.png', 'khuon.ai', 'khuon.dxf', 'khuon', 'khuon.pdf.exe'])(
    'từ chối %s và nói rõ tên file',
    async (name) => {
      const onSourceReady = vi.fn();
      const { container } = render(
        <MixedNestingFileInput tabId="tab-a" isActive onSourceReady={onSourceReady} />,
      );
      dropFiles(container.querySelector('[data-drag-over]')!, [
        new File(['x'], name, { type: 'application/octet-stream' }),
      ]);
      await waitFor(() => expect(screen.getByTestId('mn-file-error')).toBeTruthy());
      expect(screen.getByTestId('mn-file-error').textContent).toContain(name);
      expect(apiMocks.createSource).not.toHaveBeenCalled();
      expect(onSourceReady).not.toHaveBeenCalled();
    },
  );

  it('trong lô lẫn lộn, chỉ nhận PDF và nói ra cái bị bỏ', async () => {
    apiMocks.createSource.mockResolvedValue(source());
    const { container } = render(
      <MixedNestingFileInput tabId="tab-a" isActive onSourceReady={vi.fn()} />,
    );
    dropFiles(container.querySelector('[data-drag-over]')!, [
      new File(['x'], 'anh.png'),
      pdfFile('that.pdf'),
    ]);
    await waitFor(() => expect(apiMocks.createSource).toHaveBeenCalledTimes(1));
    expect(apiMocks.createSource.mock.calls[0][0].name).toBe('that.pdf');
    expect(screen.getByTestId('mn-file-error').textContent).toContain('anh.png');
  });

  it('nhiều PDF một lượt thì nhận cái đầu và nói rõ', async () => {
    apiMocks.createSource.mockResolvedValue(source());
    const { container } = render(
      <MixedNestingFileInput tabId="tab-a" isActive onSourceReady={vi.fn()} />,
    );
    dropFiles(container.querySelector('[data-drag-over]')!, [pdfFile('a.pdf'), pdfFile('b.pdf')]);
    await waitFor(() => expect(screen.getByTestId('mn-file-error')).toBeTruthy());
    expect(apiMocks.createSource).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('mn-file-error').textContent).toContain('a.pdf');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  2. Chỉ nhận cho đúng tab
// ─────────────────────────────────────────────────────────────────────────────

describe('chỉ nhận cho đúng tab', () => {
  it('tab KHÔNG active thì không nhận file', async () => {
    const onSourceReady = vi.fn();
    const { container } = render(
      <MixedNestingFileInput tabId="tab-nen" isActive={false} onSourceReady={onSourceReady} />,
    );
    dropFiles(container.querySelector('[data-drag-over]')!, [pdfFile()]);
    await Promise.resolve();
    expect(apiMocks.createSource).not.toHaveBeenCalled();
    expect(onSourceReady).not.toHaveBeenCalled();
  });

  it('đang chạy job thì không nhận file mới', async () => {
    const { container } = render(
      <MixedNestingFileInput tabId="tab-a" isActive disabled onSourceReady={vi.fn()} />,
    );
    dropFiles(container.querySelector('[data-drag-over]')!, [pdfFile()]);
    await Promise.resolve();
    expect(apiMocks.createSource).not.toHaveBeenCalled();
  });

  it('KHÔNG đăng ký listener toàn cục — routing PDF của app giữ nguyên', () => {
    const spy = vi.spyOn(window, 'addEventListener');
    render(<MixedNestingFileInput tabId="tab-a" isActive onSourceReady={vi.fn()} />);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('gắn tabId vào DOM để hai thẻ không lẫn nhau', () => {
    const { container } = render(
      <MixedNestingFileInput tabId="tab-x" isActive onSourceReady={vi.fn()} />,
    );
    expect(container.querySelector('[data-tab-id="tab-x"]')).toBeTruthy();
  });

  it('dragOver chỉ bật khi tab active', () => {
    const { container } = render(
      <MixedNestingFileInput tabId="tab-a" isActive={false} onSourceReady={vi.fn()} />,
    );
    const zone = container.querySelector('[data-drag-over]')!;
    fireEvent.dragOver(zone);
    expect(zone.getAttribute('data-drag-over')).toBe('false');
  });

  it('dragOver bật rồi tắt khi rời vùng', () => {
    const { container } = render(
      <MixedNestingFileInput tabId="tab-a" isActive onSourceReady={vi.fn()} />,
    );
    const zone = container.querySelector('[data-drag-over]')!;
    fireEvent.dragOver(zone);
    expect(zone.getAttribute('data-drag-over')).toBe('true');
    fireEvent.dragLeave(zone);
    expect(zone.getAttribute('data-drag-over')).toBe('false');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  3. ambiguous: bắt buộc người dùng chọn
// ─────────────────────────────────────────────────────────────────────────────

describe('nhiều đường bế', () => {
  const ambiguous = source({
    status: 'ambiguous',
    selectedCandidateId: null,
    sourceRevision: null,
    candidates: [
      candidate({ candidateId: 'p1-c1', widthMm: 90, heightMm: 60 }),
      candidate({ candidateId: 'p1-c2', widthMm: 70, heightMm: 70, outer: rect(70, 70) }),
    ],
  });

  it('KHÔNG tự chọn hộ, và hiện đủ ứng viên để bấm', async () => {
    apiMocks.createSource.mockResolvedValue(ambiguous);
    const onSourceReady = vi.fn();
    const { container } = render(
      <MixedNestingFileInput tabId="tab-a" isActive onSourceReady={onSourceReady} />,
    );
    dropFiles(container.querySelector('[data-drag-over]')!, [pdfFile()]);

    await waitFor(() => expect(screen.getByTestId('mn-candidate-picker')).toBeTruthy());
    expect(onSourceReady).not.toHaveBeenCalled();
    expect(container.querySelectorAll('[data-candidate-id]')).toHaveLength(2);
  });

  it('bấm chọn thì gọi API và báo ready', async () => {
    apiMocks.createSource.mockResolvedValue(ambiguous);
    apiMocks.selectSourceCandidate.mockResolvedValue(
      source({ candidates: ambiguous.candidates, selectedCandidateId: 'p1-c2' }),
    );
    const onSourceReady = vi.fn();
    const { container } = render(
      <MixedNestingFileInput tabId="tab-a" isActive onSourceReady={onSourceReady} />,
    );
    dropFiles(container.querySelector('[data-drag-over]')!, [pdfFile()]);
    await waitFor(() => screen.getByTestId('mn-candidate-picker'));

    fireEvent.click(container.querySelector('[data-candidate-id="p1-c2"]')!);
    await waitFor(() => expect(onSourceReady).toHaveBeenCalledTimes(1));
    expect(apiMocks.selectSourceCandidate).toHaveBeenCalledWith('src-1', 'p1-c2');
    expect(onSourceReady.mock.calls[0][1].candidateId).toBe('p1-c2');
  });

  it('mỗi ứng viên vẽ được bằng chính polygon, không cần ảnh raster', async () => {
    apiMocks.createSource.mockResolvedValue(ambiguous);
    const { container } = render(
      <MixedNestingFileInput tabId="tab-a" isActive onSourceReady={vi.fn()} />,
    );
    dropFiles(container.querySelector('[data-drag-over]')!, [pdfFile()]);
    await waitFor(() => screen.getByTestId('mn-candidate-picker'));

    const svgs = container.querySelectorAll('[data-candidate-id] svg');
    expect(svgs).toHaveLength(2);
    expect(svgs[0].querySelector('path')?.getAttribute('d')).toContain('M ');
    expect(container.querySelector('img')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  4. no_contour: cho chọn khổ trang, có xác nhận rõ
// ─────────────────────────────────────────────────────────────────────────────

describe('không có đường bế', () => {
  const empty = source({
    status: 'no_contour',
    selectedCandidateId: null,
    sourceRevision: null,
    candidates: [],
    pages: [
      { pageNumber: 1, widthMm: 210, heightMm: 297 },
      { pageNumber: 2, widthMm: 100, heightMm: 150 },
    ],
  });

  it('hiện từng trang để người dùng xác nhận, không tự dùng khổ trang', async () => {
    apiMocks.createSource.mockResolvedValue(empty);
    const onSourceReady = vi.fn();
    const { container } = render(
      <MixedNestingFileInput tabId="tab-a" isActive onSourceReady={onSourceReady} />,
    );
    dropFiles(container.querySelector('[data-drag-over]')!, [pdfFile()]);

    await waitFor(() => expect(screen.getByTestId('mn-no-contour')).toBeTruthy());
    expect(onSourceReady).not.toHaveBeenCalled();
    expect(container.querySelectorAll('[data-page-number]')).toHaveLength(2);
  });

  it('bấm một trang thì gọi endpoint page-box và báo ready', async () => {
    apiMocks.createSource.mockResolvedValue(empty);
    apiMocks.acceptSourcePageBox.mockResolvedValue(
      source({
        candidates: [candidate({ candidateId: 'p2-pagebox', widthMm: 100, heightMm: 150 })],
        selectedCandidateId: 'p2-pagebox',
      }),
    );
    const onSourceReady = vi.fn();
    const { container } = render(
      <MixedNestingFileInput tabId="tab-a" isActive onSourceReady={onSourceReady} />,
    );
    dropFiles(container.querySelector('[data-drag-over]')!, [pdfFile()]);
    await waitFor(() => screen.getByTestId('mn-no-contour'));

    fireEvent.click(container.querySelector('[data-page-number="2"]')!);
    await waitFor(() => expect(onSourceReady).toHaveBeenCalledTimes(1));
    expect(apiMocks.acceptSourcePageBox).toHaveBeenCalledWith('src-1', 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  5. Ứng viên bị loại vẫn hiện kèm lý do
// ─────────────────────────────────────────────────────────────────────────────

describe('ứng viên bị loại', () => {
  it('hiện lý do, không im lặng bỏ', async () => {
    apiMocks.createSource.mockResolvedValue(
      source({
        status: 'no_contour',
        selectedCandidateId: null,
        candidates: [
          candidate({ candidateId: 'p1-x1', rejectedReason: 'RING_SELF_INTERSECTING' }),
          candidate({ candidateId: 'p1-x2', rejectedReason: 'RING_NOT_CLOSED' }),
        ],
      }),
    );
    const { container } = render(
      <MixedNestingFileInput tabId="tab-a" isActive onSourceReady={vi.fn()} />,
    );
    dropFiles(container.querySelector('[data-drag-over]')!, [pdfFile()]);

    await waitFor(() => expect(screen.getByTestId('mn-rejected')).toBeTruthy());
    const text = screen.getByTestId('mn-rejected').textContent ?? '';
    expect(text).toContain('tự cắt');
    expect(text).toContain('không kín');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  6. Lỗi API
// ─────────────────────────────────────────────────────────────────────────────

describe('lỗi', () => {
  it('lỗi từ server được hiện nguyên văn, không nuốt', async () => {
    apiMocks.createSource.mockRejectedValue(
      new apiMocks.MixedNestingApiError('File PDF vượt trần 64 MB.', 413),
    );
    const { container } = render(
      <MixedNestingFileInput tabId="tab-a" isActive onSourceReady={vi.fn()} />,
    );
    dropFiles(container.querySelector('[data-drag-over]')!, [pdfFile()]);
    await waitFor(() =>
      expect(screen.getByTestId('mn-file-error').textContent).toContain('vượt trần 64 MB'),
    );
  });

  it('lỗi rồi thả lại file tốt thì phục hồi được', async () => {
    apiMocks.createSource.mockRejectedValueOnce(new Error('mang loi'));
    apiMocks.createSource.mockResolvedValueOnce(source());
    const onSourceReady = vi.fn();
    const { container } = render(
      <MixedNestingFileInput tabId="tab-a" isActive onSourceReady={onSourceReady} />,
    );
    const zone = container.querySelector('[data-drag-over]')!;

    dropFiles(zone, [pdfFile()]);
    await waitFor(() => expect(screen.getByTestId('mn-file-error')).toBeTruthy());

    dropFiles(zone, [pdfFile()]);
    await waitFor(() => expect(onSourceReady).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('mn-file-error')).toBeNull();
  });
});
