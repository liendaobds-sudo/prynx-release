import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MixedNestingApiError,
  assertNoForbiddenFields,
  buildCreateJobRequest,
  cancelJob,
  createJob,
  deleteJob,
  findForbiddenFields,
  getCapabilities,
  getJobResult,
  getJobStatus,
  serializeCreateJobRequest,
  waitForJob,
} from './api';
import {
  MAX_REQUEST_BYTES,
  MIXED_NESTING_PROTOCOL_VERSION,
  ROTATION_PRESET_CARDINAL,
  type CreateJobRequest,
  type PartRotationConstraint,
  type PartSpec,
} from './types';

const apiMocks = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
  getApiUrl: vi.fn(() => 'http://127.0.0.1:8321/api'),
  formatApiErrorDetail: vi.fn((detail: unknown, fallback: string) =>
    typeof detail === 'string' ? detail : fallback,
  ),
}));
vi.mock('../api', () => apiMocks);

function responseJson(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function rect(w: number, h: number): [number, number][] {
  return [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
}

const PART: PartSpec = {
  partId: 'part-a',
  quantity: 4,
  outer: rect(90, 60),
  holes: [],
  rotationConstraint: { mode: 'inherit' },
};

function buildOptions(overrides: Partial<Parameters<typeof buildCreateJobRequest>[0]> = {}) {
  return {
    seed: 20260826,
    profile: 'balanced' as const,
    sheet: {
      widthMm: 700,
      heightMm: 1000,
      marginMm: { left: 10, right: 10, top: 10, bottom: 10 },
      maxSheets: 20,
    },
    gapMm: 3,
    orientationPolicy: { defaultRotation: { mode: 'free' as const }, reflection: 'forbidden' as const },
    parts: [PART],
    ...overrides,
  };
}

beforeEach(() => {
  apiMocks.authenticatedFetch.mockReset();
  apiMocks.getApiUrl.mockReturnValue('http://127.0.0.1:8321/api');
});

// ─────────────────────────────────────────────────────────────────────────────
//  Dựng request: không lọt trường server-owned hay legacy
// ─────────────────────────────────────────────────────────────────────────────

describe('buildCreateJobRequest', () => {
  it('dựng đúng hợp đồng và không mang trường lạ', () => {
    const request = buildCreateJobRequest(buildOptions());
    expect(Object.keys(request).sort()).toEqual(
      ['gapMm', 'orientationPolicy', 'parts', 'profile', 'protocolVersion', 'seed', 'sheet'].sort(),
    );
    expect(request.protocolVersion).toBe(MIXED_NESTING_PROTOCOL_VERSION);
    expect(request.orientationPolicy.reflection).toBe('forbidden');
    expect(Object.keys(request.parts[0]).sort()).toEqual(
      ['holes', 'outer', 'partId', 'quantity', 'rotationConstraint'].sort(),
    );
  });

  it('không gửi timeBudgetMs khi không khai — work-plan cố định là mặc định', () => {
    expect('timeBudgetMs' in buildCreateJobRequest(buildOptions())).toBe(false);
    const withBudget = buildCreateJobRequest(buildOptions({ timeBudgetMs: 30_000 }));
    expect(withBudget.timeBudgetMs).toBe(30_000);
  });

  it('bỏ mọi trường lạ mà state UI mang theo', () => {
    const dirtyPart = {
      ...PART,
      // Ba trường server-owned + một trường legacy, đúng kiểu state UI hay tích tụ.
      referencePointMm: [1, 2],
      geometryHash: 'abc',
      sourceRevision: 'def',
      angleStepDeg: 90,
      uiSelected: true,
    } as unknown as PartSpec;
    const request = buildCreateJobRequest(buildOptions({ parts: [dirtyPart] }));
    expect(Object.keys(request.parts[0]).sort()).toEqual(
      ['holes', 'outer', 'partId', 'quantity', 'rotationConstraint'].sort(),
    );
  });

  it('luôn ép reflection về forbidden dù caller khai khác', () => {
    const request = buildCreateJobRequest(
      buildOptions({
        orientationPolicy: {
          defaultRotation: { mode: 'free' },
          reflection: 'allowed',
        } as never,
      }),
    );
    expect(request.orientationPolicy.reflection).toBe('forbidden');
  });

  it('copy sâu contour: sửa mảng nguồn không làm lệch payload', () => {
    const source: PartSpec = { ...PART, outer: rect(90, 60), holes: [rect(10, 10)] };
    const request = buildCreateJobRequest(buildOptions({ parts: [source] }));
    source.outer[0][0] = 999;
    source.holes[0][0][1] = 888;
    expect(request.parts[0].outer[0][0]).toBe(0);
    expect(request.parts[0].holes[0][0][1]).toBe(0);
  });

  it('giữ nguyên precision của góc không-cardinal và toạ độ phần lẻ', () => {
    const request = buildCreateJobRequest(
      buildOptions({
        gapMm: 1.37,
        parts: [
          {
            ...PART,
            outer: [
              [0, 0],
              [28.630000000000003, 0],
              [28.630000000000003, 19.41],
              [0, 19.41],
            ],
            rotationConstraint: { mode: 'fixed', angleDeg: 13.372849 },
          },
        ],
      }),
    );
    const roundTrip = JSON.parse(JSON.stringify(request)) as CreateJobRequest;
    expect(roundTrip.gapMm).toBe(1.37);
    expect(roundTrip.parts[0].outer[1][0]).toBe(28.630000000000003);
    expect(roundTrip.parts[0].rotationConstraint).toEqual({
      mode: 'fixed',
      angleDeg: 13.372849,
    });
  });

  it('giữ nguyên năm mode rotation, kể cả preset compile về discrete', () => {
    const constraints: PartRotationConstraint[] = [
      { mode: 'inherit' },
      { mode: 'free' },
      { mode: 'fixed', angleDeg: 41.25 },
      ROTATION_PRESET_CARDINAL,
      { mode: 'ranges', arcs: [{ startDeg: 350, sweepDeg: 25 }] },
    ];
    for (const constraint of constraints) {
      const request = buildCreateJobRequest(
        buildOptions({ parts: [{ ...PART, rotationConstraint: constraint }] }),
      );
      expect(request.parts[0].rotationConstraint).toEqual(constraint);
    }
  });
});

describe('findForbiddenFields', () => {
  it('bắt trường legacy và server-owned ở mọi độ sâu', () => {
    const payload = {
      protocolVersion: 1,
      translationStepMm: 0.1,
      orientationPolicy: { defaultRotation: { mode: 'free', angleStepDeg: 15 } },
      parts: [{ partId: 'a', geometryHash: 'x' }, { partId: 'b', matrix: [1, 0, 0, 1, 0, 0] }],
    };
    expect(findForbiddenFields(payload).sort()).toEqual(
      [
        'translationStepMm',
        'orientationPolicy.defaultRotation.angleStepDeg',
        'parts[0].geometryHash',
        'parts[1].matrix',
      ].sort(),
    );
  });

  it('cho reflection: forbidden đi qua, chặn mọi giá trị khác', () => {
    expect(findForbiddenFields({ reflection: 'forbidden' })).toEqual([]);
    expect(findForbiddenFields({ reflection: 'allowed' })).toEqual(['reflection']);
    expect(findForbiddenFields({ orientationPolicy: { reflection: 'mirror' } })).toEqual([
      'orientationPolicy.reflection',
    ]);
  });

  it.each([
    'matrix',
    'transform',
    'affine',
    'mirror',
    'flipX',
    'scale',
    'shear',
    'skewY',
    'snapToGridMm',
    'allowedRotationsDeg',
    'rotationStepDeg',
    'jobId',
    'sourceRevision',
  ])('chặn trường %s', (field) => {
    expect(findForbiddenFields({ [field]: 1 })).toEqual([field]);
  });

  it('assertNoForbiddenFields ném lỗi 422 có mã ổn định', () => {
    expect(() => assertNoForbiddenFields({ matrix: [1, 0, 0, 1, 0, 0] })).toThrowError(
      MixedNestingApiError,
    );
    try {
      assertNoForbiddenFields({ jobId: 'client-chon' });
    } catch (error) {
      const apiError = error as MixedNestingApiError;
      expect(apiError.status).toBe(422);
      expect(apiError.code).toBe('MIXED_NESTING_INVALID_REQUEST');
      expect(apiError.message).toContain('jobId');
    }
  });
});

describe('serializeCreateJobRequest', () => {
  it('chặn payload vượt trần byte trước khi gửi', () => {
    const huge: PartSpec = {
      ...PART,
      outer: Array.from({ length: 20_000 }, (_, i) => [i * 1.000001, i * 2.000001] as [number, number]),
    };
    const request = buildCreateJobRequest(
      buildOptions({ parts: Array.from({ length: 40 }, (_, i) => ({ ...huge, partId: `p-${i}` })) }),
    );
    let thrown: MixedNestingApiError | null = null;
    try {
      serializeCreateJobRequest(request);
    } catch (error) {
      thrown = error as MixedNestingApiError;
    }
    expect(thrown).toBeInstanceOf(MixedNestingApiError);
    expect(thrown?.status).toBe(413);
    expect(thrown?.message).toContain(String(MAX_REQUEST_BYTES));
  });

  it('payload thường thì serialize được và round-trip đúng số', () => {
    const request = buildCreateJobRequest(buildOptions());
    const body = serializeCreateJobRequest(request);
    expect(JSON.parse(body)).toEqual(request);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Endpoint
// ─────────────────────────────────────────────────────────────────────────────

describe('endpoint', () => {
  it('createJob POST đúng URL, đúng Content-Type, trả 202 payload', async () => {
    apiMocks.authenticatedFetch.mockResolvedValue(
      responseJson({ jobId: 'abc123', status: 'queued' }, 202),
    );
    const request = buildCreateJobRequest(buildOptions());
    const accepted = await createJob(request);

    expect(accepted).toEqual({ jobId: 'abc123', status: 'queued' });
    const [url, init] = apiMocks.authenticatedFetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8321/api/mixed-nesting/jobs');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual(request);
  });

  it('không tự đặt header license/chữ ký — việc đó của Rust', async () => {
    apiMocks.authenticatedFetch.mockResolvedValue(responseJson({ jobId: 'x', status: 'queued' }, 202));
    await createJob(buildCreateJobRequest(buildOptions()));
    const [, init] = apiMocks.authenticatedFetch.mock.calls[0];
    for (const name of Object.keys(init.headers as Record<string, string>)) {
      expect(name.toLowerCase()).not.toMatch(/^x-(license|prynx|hardware)/);
    }
  });

  it('getJobStatus và getJobResult encode jobId', async () => {
    apiMocks.authenticatedFetch.mockResolvedValue(responseJson({ jobId: 'a b', status: 'queued' }));
    await getJobStatus('a b');
    expect(apiMocks.authenticatedFetch.mock.calls[0][0]).toBe(
      'http://127.0.0.1:8321/api/mixed-nesting/jobs/a%20b',
    );

    apiMocks.authenticatedFetch.mockResolvedValue(responseJson({ protocolVersion: 1 }));
    await getJobResult('x/y');
    expect(apiMocks.authenticatedFetch.mock.calls[1][0]).toBe(
      'http://127.0.0.1:8321/api/mixed-nesting/jobs/x%2Fy/result',
    );
  });

  it('cancelJob và deleteJob dùng đúng method', async () => {
    apiMocks.authenticatedFetch.mockResolvedValue(
      responseJson({ jobId: 'j', status: 'cancelled', cancelled: true, alreadyCancelled: false, terminal: true }),
    );
    await cancelJob('j');
    expect(apiMocks.authenticatedFetch.mock.calls[0][1].method).toBe('POST');

    apiMocks.authenticatedFetch.mockResolvedValue(responseJson({ jobId: 'j', deleted: true }));
    await deleteJob('j');
    expect(apiMocks.authenticatedFetch.mock.calls[1][1].method).toBe('DELETE');
  });

  it('getCapabilities trả đủ trường bất biến', async () => {
    apiMocks.authenticatedFetch.mockResolvedValue(
      responseJson({
        protocolVersion: 1,
        engineVersion: '0.1.0',
        reflection: 'forbidden',
        defaultRotation: 'free',
        continuousTranslation: true,
        profiles: ['fast', 'balanced', 'tight'],
        maxRequestBytes: MAX_REQUEST_BYTES,
      }),
    );
    const capabilities = await getCapabilities();
    expect(capabilities.reflection).toBe('forbidden');
    expect(capabilities.defaultRotation).toBe('free');
    expect(capabilities.continuousTranslation).toBe(true);
  });

  it('giữ nguyên precision khi đọc manifest về', async () => {
    apiMocks.authenticatedFetch.mockResolvedValue(
      responseJson({
        placements: [
          {
            pose: {
              rotationDeg: 13.372849,
              translateXmm: 123.45678901234567,
              translateYmm: 67.891234,
            },
          },
        ],
      }),
    );
    const manifest = (await getJobResult('j')) as unknown as {
      placements: { pose: { rotationDeg: number; translateXmm: number; translateYmm: number } }[];
    };
    expect(manifest.placements[0].pose.rotationDeg).toBe(13.372849);
    expect(manifest.placements[0].pose.translateXmm).toBe(123.45678901234567);
    expect(manifest.placements[0].pose.translateYmm).toBe(67.891234);
  });
});

describe('lỗi HTTP', () => {
  it.each([
    [403, 'isForbidden'],
    [404, 'isUnavailable'],
  ] as const)('phân loại status %i', async (status, flag) => {
    apiMocks.authenticatedFetch.mockResolvedValue(responseJson({ detail: 'khong duoc' }, status));
    await expect(getJobStatus('j')).rejects.toThrowError(MixedNestingApiError);

    apiMocks.authenticatedFetch.mockResolvedValue(responseJson({ detail: 'khong duoc' }, status));
    try {
      await getJobStatus('j');
    } catch (error) {
      const apiError = error as MixedNestingApiError;
      expect(apiError.status).toBe(status);
      expect(apiError[flag]).toBe(true);
    }
  });

  it('503 ENGINE_UNAVAILABLE nhận diện được, và KHÔNG có nhánh fallback', async () => {
    apiMocks.authenticatedFetch.mockResolvedValue(
      responseJson({ detail: { code: 'ENGINE_UNAVAILABLE', message: 'thieu native' } }, 503),
    );
    try {
      await getCapabilities();
      expect.unreachable('phải ném lỗi');
    } catch (error) {
      const apiError = error as MixedNestingApiError;
      expect(apiError.isEngineUnavailable).toBe(true);
      expect(apiError.code).toBe('ENGINE_UNAVAILABLE');
    }
    // Chỉ đúng một lần gọi: không có lượt thử lại sang endpoint khác.
    expect(apiMocks.authenticatedFetch).toHaveBeenCalledTimes(1);
  });

  it('body lỗi không phải JSON vẫn cho message dùng được', async () => {
    apiMocks.authenticatedFetch.mockResolvedValue(new Response('boom', { status: 500 }));
    await expect(getJobStatus('j')).rejects.toThrow('Không đọc được trạng thái job lồng ghép.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Polling
// ─────────────────────────────────────────────────────────────────────────────

describe('waitForJob', () => {
  const sleep = () => Promise.resolve();

  it('poll tới khi terminal và gọi onStatus mỗi lần', async () => {
    const snapshots = [
      { jobId: 'j', status: 'queued', terminal: false, cancelRequested: false, createdAt: 1 },
      { jobId: 'j', status: 'nesting', terminal: false, cancelRequested: false, createdAt: 1 },
      { jobId: 'j', status: 'completed', terminal: true, cancelRequested: false, createdAt: 1 },
    ];
    apiMocks.authenticatedFetch.mockImplementation(() =>
      Promise.resolve(responseJson(snapshots.shift())),
    );
    const seen: string[] = [];
    const final = await waitForJob('j', { onStatus: (s) => void seen.push(s.status), sleep });

    expect(seen).toEqual(['queued', 'nesting', 'completed']);
    expect(final.terminal).toBe(true);
  });

  it('onStatus trả false thì dừng theo dõi mà KHÔNG hủy job', async () => {
    apiMocks.authenticatedFetch.mockResolvedValue(
      responseJson({ jobId: 'j', status: 'nesting', terminal: false, cancelRequested: false, createdAt: 1 }),
    );
    const final = await waitForJob('j', { onStatus: () => false, sleep });
    expect(final.terminal).toBe(false);
    // Chỉ một lượt GET; tuyệt đối không có POST /cancel.
    expect(apiMocks.authenticatedFetch).toHaveBeenCalledTimes(1);
    expect(apiMocks.authenticatedFetch.mock.calls[0][1]?.method).toBeUndefined();
  });

  it('hết timeout thì ném 504 và KHÔNG hủy job', async () => {
    apiMocks.authenticatedFetch.mockResolvedValue(
      responseJson({ jobId: 'j', status: 'nesting', terminal: false, cancelRequested: false, createdAt: 1 }),
    );
    await expect(waitForJob('j', { timeoutMs: -1, sleep })).rejects.toThrow(/Hết thời gian/);
    for (const call of apiMocks.authenticatedFetch.mock.calls) {
      expect(call[1]?.method ?? 'GET').toBe('GET');
    }
  });

  it('signal đã abort thì dừng ngay, không gọi mạng', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(waitForJob('j', { signal: controller.signal, sleep })).rejects.toThrowError(
      MixedNestingApiError,
    );
    expect(apiMocks.authenticatedFetch).not.toHaveBeenCalled();
  });

  it('khoảng polling mặc định nằm trong 300–500 ms theo kế hoạch', async () => {
    const { POLL_INTERVAL_MS } = await import('./api');
    expect(POLL_INTERVAL_MS).toBeGreaterThanOrEqual(300);
    expect(POLL_INTERVAL_MS).toBeLessThanOrEqual(500);
  });
});
