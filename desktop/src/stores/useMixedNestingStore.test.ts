import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_JOB_ROTATION,
  DEFAULT_PART_ROTATION,
  buildRequestFromTab,
  canRun,
  hasUsableResult,
  isRunning,
  isTabDirty,
  sheetCount,
  totalInstances,
  useMixedNestingStore,
  type MixedNestingPart,
  type MixedNestingTabState,
} from './useMixedNestingStore';
import {
  MIXED_NESTING_PROTOCOL_VERSION,
  type JobStatus,
  type PartRotationConstraint,
  type RingMm,
} from '../lib/mixed-nesting/types';

const store = () => useMixedNestingStore.getState();

function rect(w: number, h: number): RingMm {
  return [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
}

function part(overrides: Partial<Omit<MixedNestingPart, 'uiId'>> = {}) {
  return {
    partId: 'part-a',
    quantity: 4,
    outer: rect(90, 60),
    holes: [],
    rotationConstraint: { ...DEFAULT_PART_ROTATION },
    ...overrides,
  };
}

function manifest(tab: MixedNestingTabState, jobId: string, overrides: Record<string, unknown> = {}) {
  const placements = tab.parts.flatMap((p) =>
    Array.from({ length: p.quantity }, (_, index) => ({
      instanceId: `${p.partId}#${String(index + 1).padStart(4, '0')}`,
      partId: p.partId,
      sheetIndex: 0,
      pose: { rotationDeg: 13.372849, translateXmm: 10.5 + index, translateYmm: 20.25 },
    })),
  );
  return {
    protocolVersion: MIXED_NESTING_PROTOCOL_VERSION,
    engineVersion: '0.2.0',
    jobId,
    seed: tab.seed,
    status: 'completed',
    placements,
    unplaced: [],
    stats: {
      sheetCount: 1,
      placedCount: placements.length,
      unplacedCount: 0,
      materialUtilization: 0.31,
      elapsedMs: 120,
      attempts: 4,
      orientationEvaluations: 40,
      poseRefinements: 400,
      terminationReason: 'all_placed',
    },
    validation: { valid: true, validatorVersion: 1 },
    ...overrides,
  };
}

function status(jobId: string, overrides: Partial<JobStatus> = {}): JobStatus {
  return {
    jobId,
    status: 'nesting',
    terminal: false,
    cancelRequested: false,
    createdAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  useMixedNestingStore.setState({ tabs: {} });
});

// ─────────────────────────────────────────────────────────────────────────────
//  1. Hai tab độc lập
// ─────────────────────────────────────────────────────────────────────────────

describe('phân vùng theo tabId', () => {
  it('hai tab không dùng chung chi tiết, tham số hay job', () => {
    store().initTab('tab-a');
    store().initTab('tab-b');

    store().addPart('tab-a', part({ partId: 'chi-tiet-a' }));
    store().setGapMm('tab-a', 7.5);
    store().setProfile('tab-a', 'tight');
    store().beginRun('tab-a', 'job-a');

    const a = store().getTab('tab-a');
    const b = store().getTab('tab-b');
    expect(a.parts).toHaveLength(1);
    expect(b.parts).toHaveLength(0);
    expect(a.gapMm).toBe(7.5);
    expect(b.gapMm).toBe(3);
    expect(a.profile).toBe('tight');
    expect(b.profile).toBe('balanced');
    expect(a.job?.jobId).toBe('job-a');
    expect(b.job).toBeNull();
  });

  it('initTab không ghi đè tab đã có', () => {
    store().initTab('tab-a');
    store().addPart('tab-a', part());
    store().initTab('tab-a');
    expect(store().getTab('tab-a').parts).toHaveLength(1);
  });

  it('destroyTab xoá sạch key, không để lại rác', () => {
    store().initTab('tab-a');
    store().initTab('tab-b');
    store().addPart('tab-a', part());
    store().destroyTab('tab-a');

    expect(Object.keys(useMixedNestingStore.getState().tabs)).toEqual(['tab-b']);
    // Đọc lại tab đã xoá trả về mặc định sạch, không phải state cũ.
    expect(store().getTab('tab-a').parts).toHaveLength(0);
  });

  it('getTab của tab chưa init trả mặc định mà KHÔNG tạo key', () => {
    const tab = store().getTab('chua-init');
    expect(tab.parts).toHaveLength(0);
    expect(Object.keys(useMixedNestingStore.getState().tabs)).toEqual([]);
  });

  it('mặc định của hai tab là hai object khác nhau — không chia sẻ tham chiếu', () => {
    store().initTab('tab-a');
    store().initTab('tab-b');
    store().setMargin('tab-a', { left: 25 });
    expect(store().getTab('tab-a').sheet.marginMm.left).toBe(25);
    expect(store().getTab('tab-b').sheet.marginMm.left).toBe(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  2. Mặc định free-angle, không có mirror/grid ẩn
// ─────────────────────────────────────────────────────────────────────────────

describe('mặc định xoay', () => {
  it('cấp job mặc định free, cấp chi tiết mặc định inherit', () => {
    store().initTab('t');
    expect(store().getTab('t').defaultRotation).toEqual({ mode: 'free' });
    expect(DEFAULT_JOB_ROTATION).toEqual({ mode: 'free' });
    store().addPart('t', part());
    expect(store().getTab('t').parts[0].rotationConstraint).toEqual({ mode: 'inherit' });
  });

  it('state không có trường bước góc, lưới hay lật khuôn', () => {
    store().initTab('t');
    const keys = Object.keys(store().getTab('t'));
    for (const cam of [
      'angleStep',
      'angleStepDeg',
      'rotationStep',
      'snapMm',
      'gridMm',
      'snapToGrid',
      'mirror',
      'mirrorX',
      'flip',
      'scale',
      'shear',
      'reflection',
      'translationStep',
    ]) {
      expect(keys, cam).not.toContain(cam);
    }
  });

  it('payload gửi server không mang mirror/grid/step ở bất kỳ đâu', () => {
    store().initTab('t');
    store().addPart('t', part());
    const request = buildRequestFromTab(store().getTab('t'));
    const json = JSON.stringify(request);
    for (const cam of ['mirror', 'flip', 'scale', 'shear', 'angleStep', 'translationStep', 'grid', 'snap']) {
      expect(json.toLowerCase(), cam).not.toContain(cam.toLowerCase());
    }
    expect(request.orientationPolicy.reflection).toBe('forbidden');
    expect(request.layoutIntent).toBe('quantity_fulfillment');
  });

  it('standalone luôn giữ validator và request theo quantity_fulfillment', () => {
    store().initTab('t');
    store().addPart('t', part({ quantity: 3 }));
    const request = buildRequestFromTab(store().getTab('t'));
    expect(request.layoutIntent).toBe('quantity_fulfillment');
    expect(request.parts[0].quantity).toBe(3);
  });

  it('bốn mode thu hẹp per-part serialize nguyên vẹn', () => {
    store().initTab('t');
    const uiId = store().addPart('t', part());

    const constraints: PartRotationConstraint[] = [
      { mode: 'free' },
      { mode: 'fixed', angleDeg: 13.372849 },
      { mode: 'discrete', anglesDeg: [0, 90, 180, 270] },
      { mode: 'ranges', arcs: [{ startDeg: 350, sweepDeg: 25 }] },
      { mode: 'inherit' },
    ];
    for (const constraint of constraints) {
      store().setPartRotation('t', uiId, constraint);
      const request = buildRequestFromTab(store().getTab('t'));
      expect(request.parts[0].rotationConstraint).toEqual(constraint);
      // Round-trip JSON không mất chữ số của góc không-cardinal.
      expect(JSON.parse(JSON.stringify(request)).parts[0].rotationConstraint).toEqual(constraint);
    }
  });

  it('đổi ràng buộc cấp job không đụng override của chi tiết', () => {
    store().initTab('t');
    const uiId = store().addPart('t', part());
    store().setPartRotation('t', uiId, { mode: 'fixed', angleDeg: 41.25 });
    store().setDefaultRotation('t', { mode: 'discrete', anglesDeg: [0, 180] });

    const request = buildRequestFromTab(store().getTab('t'));
    expect(request.orientationPolicy.defaultRotation).toEqual({
      mode: 'discrete',
      anglesDeg: [0, 180],
    });
    expect(request.parts[0].rotationConstraint).toEqual({ mode: 'fixed', angleDeg: 41.25 });
  });

  it('uiId và sourceLabel KHÔNG lọt lên server', () => {
    store().initTab('t');
    store().addPart('t', part({ sourceLabel: 'hop-nap-cai.pdf' }));
    const request = buildRequestFromTab(store().getTab('t'));
    expect(Object.keys(request.parts[0]).sort()).toEqual(
      ['holes', 'outer', 'partId', 'quantity', 'rotationConstraint'].sort(),
    );
  });

  it('timeBudgetMs null nghĩa là work-plan cố định, không gửi trường', () => {
    store().initTab('t');
    store().addPart('t', part());
    expect('timeBudgetMs' in buildRequestFromTab(store().getTab('t'))).toBe(false);
    store().setTimeBudgetMs('t', 30_000);
    expect(buildRequestFromTab(store().getTab('t')).timeBudgetMs).toBe(30_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  3. Job cũ và kết quả lỗi thời
// ─────────────────────────────────────────────────────────────────────────────

describe('job cũ không ghi đè tab', () => {
  it('snapshot của job khác bị bỏ qua', () => {
    store().initTab('t');
    store().addPart('t', part());
    store().beginRun('t', 'job-1');

    expect(store().applyJobStatus('t', status('job-1', { status: 'nesting' }))).toBe(true);
    expect(store().getTab('t').job?.status).toBe('nesting');

    // Lượt polling của job cũ vẫn đang bay.
    expect(store().applyJobStatus('t', status('job-0', { status: 'completed', terminal: true }))).toBe(
      false,
    );
    expect(store().getTab('t').job?.status).toBe('nesting');
    expect(store().getTab('t').job?.terminal).toBe(false);
  });

  it('chạy lần hai tăng runToken và bỏ hết dấu vết lần một', () => {
    store().initTab('t');
    store().addPart('t', part());
    store().beginRun('t', 'job-1');
    store().applyJobStatus('t', status('job-1', { terminal: true, status: 'completed' }));
    store().applyManifest('t', manifest(store().getTab('t'), 'job-1'));
    expect(hasUsableResult(store().getTab('t'))).toBe(true);

    store().beginRun('t', 'job-2');
    const tab = store().getTab('t');
    expect(tab.job?.jobId).toBe('job-2');
    expect(tab.job?.runToken).toBe(2);
    expect(tab.manifest).toBeNull();
    expect(hasUsableResult(tab)).toBe(false);
  });

  it('snapshot khi không có job nào thì bị bỏ qua', () => {
    store().initTab('t');
    expect(store().applyJobStatus('t', status('job-la'))).toBe(false);
    expect(store().getTab('t').job).toBeNull();
  });

  it('manifest của job khác bị bỏ qua', () => {
    store().initTab('t');
    store().addPart('t', part());
    store().beginRun('t', 'job-1');
    const raw = manifest(store().getTab('t'), 'job-KHAC');
    expect(store().applyManifest('t', raw)).toBe(false);
    expect(store().getTab('t').manifest).toBeNull();
  });

  it('sửa đầu vào sau khi gửi job thì manifest bị coi là lỗi thời', () => {
    store().initTab('t');
    store().addPart('t', part());
    store().beginRun('t', 'job-1');
    const tabLucGui = store().getTab('t');

    // Người dùng đổi khe hở trong lúc job chạy.
    store().setGapMm('t', 5);
    expect(store().applyManifest('t', manifest(tabLucGui, 'job-1'))).toBe(false);
    expect(store().getTab('t').manifest).toBeNull();
  });

  it('sửa đầu vào sau khi CÓ kết quả thì kết quả mất hiệu lực ngay', () => {
    store().initTab('t');
    store().addPart('t', part());
    store().beginRun('t', 'job-1');
    expect(store().applyManifest('t', manifest(store().getTab('t'), 'job-1'))).toBe(true);
    expect(hasUsableResult(store().getTab('t'))).toBe(true);

    store().setSeed('t', 999);
    expect(store().getTab('t').manifest).toBeNull();
    expect(hasUsableResult(store().getTab('t'))).toBe(false);
  });

  it.each([
    ['setGapMm', () => store().setGapMm('t', 9)],
    ['setProfile', () => store().setProfile('t', 'fast')],
    ['setSeed', () => store().setSeed('t', 5)],
    ['setSheet', () => store().setSheet('t', { widthMm: 500 })],
    ['setMargin', () => store().setMargin('t', { top: 20 })],
    ['setTimeBudgetMs', () => store().setTimeBudgetMs('t', 1000)],
    ['setDefaultRotation', () => store().setDefaultRotation('t', { mode: 'free' })],
    ['addPart', () => store().addPart('t', part({ partId: 'them' }))],
  ])('%s làm tăng revision', (_name, action) => {
    store().initTab('t');
    store().addPart('t', part());
    const truoc = store().getTab('t').revision;
    action();
    expect(store().getTab('t').revision).toBeGreaterThan(truoc);
  });

  it('manifest không đúng hợp đồng bị từ chối kèm danh sách lỗi', () => {
    store().initTab('t');
    store().addPart('t', part());
    store().beginRun('t', 'job-1');

    const xau = manifest(store().getTab('t'), 'job-1', { matrix: [1, 0, 0, 1, 0, 0] });
    expect(store().applyManifest('t', xau)).toBe(false);
    const tab = store().getTab('t');
    expect(tab.manifest).toBeNull();
    expect(tab.issues.some((entry) => entry.code === 'FORBIDDEN_FIELD')).toBe(true);
    expect(tab.error).toContain('hợp đồng');
  });

  it('manifest thiếu con bị từ chối vì không bảo toàn số lượng', () => {
    store().initTab('t');
    store().addPart('t', part({ quantity: 4 }));
    store().beginRun('t', 'job-1');

    const raw = manifest(store().getTab('t'), 'job-1');
    raw.placements = raw.placements.slice(0, 2);
    (raw.stats as Record<string, unknown>).placedCount = 2;

    expect(store().applyManifest('t', raw)).toBe(false);
    expect(
      store().getTab('t').issues.some((entry) => entry.code === 'QUANTITY_MISMATCH'),
    ).toBe(true);
  });

  it('giữ nguyên precision pose khi lưu vào store', () => {
    store().initTab('t');
    store().addPart('t', part({ quantity: 1 }));
    store().beginRun('t', 'job-1');
    expect(store().applyManifest('t', manifest(store().getTab('t'), 'job-1'))).toBe(true);

    const pose = store().getTab('t').manifest?.placements[0].pose;
    expect(pose?.rotationDeg).toBe(13.372849);
    expect(pose?.translateXmm).toBe(10.5);
    expect(pose?.translateYmm).toBe(20.25);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  4. Cancel, dirty và bộ chọn
// ─────────────────────────────────────────────────────────────────────────────

describe('cancel và dirty', () => {
  it('markCancelRequested chỉ đánh dấu, không tự chuyển terminal', () => {
    store().initTab('t');
    store().addPart('t', part());
    store().beginRun('t', 'job-1');
    store().markCancelRequested('t');

    const job = store().getTab('t').job;
    expect(job?.cancelRequested).toBe(true);
    expect(job?.terminal).toBe(false);
    // Terminal chỉ đến từ server.
    store().applyJobStatus('t', status('job-1', { terminal: true, status: 'cancelled', cancelRequested: true }));
    expect(store().getTab('t').job?.status).toBe('cancelled');
  });

  it('dirty theo dữ liệu người dùng, không theo job đang chạy', () => {
    store().initTab('t');
    expect(isTabDirty(store().getTab('t'))).toBe(false);

    store().beginRun('t', 'job-1');
    expect(isTabDirty(store().getTab('t'))).toBe(false);

    const uiId = store().addPart('t', part());
    expect(isTabDirty(store().getTab('t'))).toBe(true);

    store().removePart('t', uiId);
    expect(isTabDirty(store().getTab('t'))).toBe(false);
  });

  it('isRunning và canRun phản ánh đúng trạng thái', () => {
    store().initTab('t');
    expect(canRun(store().getTab('t'))).toBe(false); // chưa có chi tiết

    store().addPart('t', part());
    expect(canRun(store().getTab('t'))).toBe(true);
    expect(isRunning(store().getTab('t'))).toBe(false);

    store().beginRun('t', 'job-1');
    expect(isRunning(store().getTab('t'))).toBe(true);
    expect(canRun(store().getTab('t'))).toBe(false);

    store().applyJobStatus('t', status('job-1', { terminal: true, status: 'completed' }));
    expect(isRunning(store().getTab('t'))).toBe(false);
    expect(canRun(store().getTab('t'))).toBe(true);
  });

  it('chi tiết sai dữ liệu thì không cho chạy', () => {
    store().initTab('t');
    const uiId = store().addPart('t', part());
    store().updatePart('t', uiId, { quantity: 0 });
    expect(canRun(store().getTab('t'))).toBe(false);

    store().updatePart('t', uiId, { quantity: 2, outer: [[0, 0], [1, 1]] });
    expect(canRun(store().getTab('t'))).toBe(false);

    store().updatePart('t', uiId, { outer: rect(50, 50) });
    expect(canRun(store().getTab('t'))).toBe(true);
  });

  it('totalInstances và sheetCount', () => {
    store().initTab('t');
    store().addPart('t', part({ partId: 'a', quantity: 3 }));
    store().addPart('t', part({ partId: 'b', quantity: 5 }));
    expect(totalInstances(store().getTab('t'))).toBe(8);
    expect(sheetCount(store().getTab('t'))).toBe(0);

    store().beginRun('t', 'job-1');
    store().applyManifest('t', manifest(store().getTab('t'), 'job-1'));
    expect(sheetCount(store().getTab('t'))).toBe(1);
  });

  it('reset đưa tab về mặc định nhưng không đụng tab khác', () => {
    store().initTab('t');
    store().initTab('u');
    store().addPart('t', part());
    store().addPart('u', part());
    store().reset('t');

    expect(store().getTab('t').parts).toHaveLength(0);
    expect(store().getTab('t').defaultRotation).toEqual({ mode: 'free' });
    expect(store().getTab('u').parts).toHaveLength(1);
  });

  it('setActiveSheetIndex không nhận giá trị âm hay số lẻ', () => {
    store().initTab('t');
    store().setActiveSheetIndex('t', -3);
    expect(store().getTab('t').activeSheetIndex).toBe(0);
    store().setActiveSheetIndex('t', 2.9);
    expect(store().getTab('t').activeSheetIndex).toBe(2);
  });

  it('clearJob bỏ job nhưng giữ dữ liệu đầu vào', () => {
    store().initTab('t');
    store().addPart('t', part());
    store().beginRun('t', 'job-1');
    store().clearJob('t');
    expect(store().getTab('t').job).toBeNull();
    expect(store().getTab('t').parts).toHaveLength(1);
  });

  it('clearJob bỏ luôn KẾT QUẢ, không để lại phương án không còn xuất được', () => {
    store().initTab('t');
    store().addPart('t', part());
    store().beginRun('t', 'job-1');
    expect(store().applyManifest('t', manifest(store().getTab('t'), 'job-1'))).toBe(true);
    expect(hasUsableResult(store().getTab('t'))).toBe(true);

    store().clearJob('t');
    const tab = store().getTab('t');
    // Nút "Bỏ kết quả" xoá job trên sidecar; giữ manifest lại là hiện một kết quả đã chết —
    // preview và nút Xuất PDF vẫn đứng đó nhưng không xuất được nữa.
    expect(tab.manifest).toBeNull();
    expect(tab.manifestRevision).toBeNull();
    expect(hasUsableResult(tab)).toBe(false);
    expect(tab.activeSheetIndex).toBe(0);
    // Nhưng đầu vào phải còn để xếp lại ngay: bắt nhập lại khuôn thì vô lý.
    expect(tab.parts).toHaveLength(1);
  });
});
