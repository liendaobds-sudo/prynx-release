import { describe, expect, it } from 'vitest';

import {
  ANGLE_EPSILON_DEG,
  angleInArc,
  angleMatchesAny,
  canPreview,
  collectPoseMetrics,
  findForbiddenManifestFields,
  groupBySheet,
  hasFractionalTranslation,
  isCardinalAngle,
  validateManifest,
  validatePose,
} from './resultValidator';
import { MIXED_NESTING_PROTOCOL_VERSION, type PlacementManifest } from './types';

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: MIXED_NESTING_PROTOCOL_VERSION,
    engineVersion: '0.1.0',
    jobId: 'deadbeefdeadbeefdeadbeefdeadbeef',
    seed: 20260826,
    status: 'completed',
    placements: [
      {
        instanceId: 'part-a#0001',
        partId: 'part-a',
        sheetIndex: 0,
        pose: { rotationDeg: 13.372849, translateXmm: 123.456789, translateYmm: 67.891234 },
      },
      {
        instanceId: 'part-a#0002',
        partId: 'part-a',
        sheetIndex: 0,
        pose: { rotationDeg: 0, translateXmm: 200, translateYmm: 100 },
      },
    ],
    unplaced: [],
    stats: {
      sheetCount: 1,
      placedCount: 2,
      unplacedCount: 0,
      materialUtilization: 0.4123,
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

function issueCodes(raw: unknown, options?: Parameters<typeof validateManifest>[1]): string[] {
  const result = validateManifest(raw, options);
  return result.ok ? [] : result.issues.map((entry) => entry.code);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Đường xanh
// ─────────────────────────────────────────────────────────────────────────────

describe('manifest hợp lệ', () => {
  it('đi qua và trả manifest đã hẹp kiểu', () => {
    const result = validateManifest(manifest());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const typed: PlacementManifest = result.manifest;
      expect(typed.placements).toHaveLength(2);
      expect(typed.stats.terminationReason).toBe('all_placed');
    }
    expect(canPreview(manifest())).toBe(true);
  });

  it('giữ nguyên precision: không làm tròn góc hay toạ độ', () => {
    const raw = manifest({
      placements: [
        {
          instanceId: 'p#0001',
          partId: 'p',
          sheetIndex: 0,
          pose: {
            rotationDeg: 13.372849,
            translateXmm: 123.45678901234567,
            translateYmm: 0.000000001,
          },
        },
      ],
      stats: { ...(manifest().stats as object), placedCount: 1 },
    });
    const result = validateManifest(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const pose = result.manifest.placements[0].pose;
      expect(pose.rotationDeg).toBe(13.372849);
      expect(pose.translateXmm).toBe(123.45678901234567);
      expect(pose.translateYmm).toBe(0.000000001);
    }
  });

  it('nhận đủ bốn lý do unplaced và năm terminationReason', () => {
    for (const reason of [
      'NO_FEASIBLE_POSE',
      'SEARCH_BUDGET_EXHAUSTED',
      'MAX_SHEETS_REACHED',
      'CANCELLED',
    ]) {
      const raw = manifest({
        unplaced: [{ instanceId: 'p#0003', partId: 'p', reason }],
        stats: { ...(manifest().stats as Record<string, unknown>), unplacedCount: 1 },
      });
      expect(validateManifest(raw).ok).toBe(true);
    }
    for (const termination of [
      'all_placed',
      'work_budget_exhausted',
      'deadline',
      'max_sheets_reached',
      'cancelled',
    ]) {
      const raw = manifest({
        stats: { ...(manifest().stats as Record<string, unknown>), terminationReason: termination },
      });
      expect(validateManifest(raw).ok).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Trường legacy và matrix tùy ý
// ─────────────────────────────────────────────────────────────────────────────

describe('trường bị cấm', () => {
  it.each([
    'matrix',
    'transform',
    'transformMatrix',
    'affine',
    'mirror',
    'mirrorX',
    'flipY',
    'scale',
    'scaleX',
    'shear',
    'skewX',
    'reflect',
    'reflection',
    'translationStepMm',
    'angleStepDeg',
    'rotationStepDeg',
    'allowedRotationsDeg',
    'snapToGridMm',
    'gridMm',
  ])('chặn manifest mang %s ở tầng gốc', (field) => {
    expect(issueCodes(manifest({ [field]: 1 }))).toContain('FORBIDDEN_FIELD');
  });

  it('chặn matrix nằm trong pose — đây là chỗ nguy hiểm nhất', () => {
    const raw = manifest({
      placements: [
        {
          instanceId: 'p#0001',
          partId: 'p',
          sheetIndex: 0,
          pose: {
            rotationDeg: 30,
            translateXmm: 1,
            translateYmm: 2,
            matrix: [0.866, 0.5, -0.5, 0.866, 1, 2],
          },
        },
      ],
      stats: { ...(manifest().stats as Record<string, unknown>), placedCount: 1 },
    });
    const result = validateManifest(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((entry) => entry.path === 'placements[0].pose.matrix')).toBe(true);
    }
  });

  it('findForbiddenManifestFields báo đúng đường dẫn ở mọi độ sâu', () => {
    const paths = findForbiddenManifestFields({
      stats: { scale: 2 },
      placements: [{ pose: { mirror: true } }, { pose: {} }],
    });
    expect(paths.sort()).toEqual(['placements[0].pose.mirror', 'stats.scale'].sort());
  });

  it('reflection bị cấm trong MANIFEST kể cả với giá trị forbidden', () => {
    // Khác request: manifest không có trường này trong hợp đồng, nên sự hiện diện của nó
    // nghĩa là dữ liệu tới từ protocol khác.
    expect(issueCodes(manifest({ reflection: 'forbidden' }))).toContain('FORBIDDEN_FIELD');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Manifest hỏng
// ─────────────────────────────────────────────────────────────────────────────

describe('manifest hỏng', () => {
  it.each([null, undefined, 42, 'chuoi', [], true])('từ chối giá trị không phải object: %s', (raw) => {
    expect(validateManifest(raw).ok).toBe(false);
  });

  it('sai protocolVersion', () => {
    expect(issueCodes(manifest({ protocolVersion: 2 }))).toContain('PROTOCOL_MISMATCH');
    expect(issueCodes(manifest({ protocolVersion: '1' }))).toContain('PROTOCOL_MISMATCH');
    const noVersion = manifest();
    delete noVersion.protocolVersion;
    expect(issueCodes(noVersion)).toContain('PROTOCOL_MISMATCH');
  });

  it('chưa qua validator của engine thì KHÔNG được preview', () => {
    expect(issueCodes(manifest({ validation: { valid: false, validatorVersion: 1 } }))).toContain(
      'NOT_VALIDATED',
    );
    expect(canPreview(manifest({ validation: { valid: false, validatorVersion: 1 } }))).toBe(false);
    const noValidation = manifest();
    delete noValidation.validation;
    expect(issueCodes(noValidation)).toContain('MISSING_FIELD');
  });

  it('status cancelled/failed bị chặn cho export, mở được khi cho phép xem', () => {
    for (const status of ['cancelled', 'failed']) {
      expect(issueCodes(manifest({ status }))).toContain('NOT_VALIDATED');
      expect(validateManifest(manifest({ status }), { allowNonCompleted: true }).ok).toBe(true);
    }
    expect(issueCodes(manifest({ status: 'running' }))).toContain('UNKNOWN_ENUM');
  });

  it.each([
    { rotationDeg: Number.NaN, translateXmm: 0, translateYmm: 0 },
    { rotationDeg: Number.POSITIVE_INFINITY, translateXmm: 0, translateYmm: 0 },
    { rotationDeg: 0, translateXmm: Number.NaN, translateYmm: 0 },
    { rotationDeg: 0, translateXmm: 0, translateYmm: Number.NEGATIVE_INFINITY },
  ])('pose không hữu hạn bị chặn', (pose) => {
    const issues = validatePose(pose, 'pose');
    expect(issues.some((entry) => entry.code === 'NOT_FINITE')).toBe(true);
  });

  it('pose thiếu trường hoặc sai kiểu bị chặn', () => {
    expect(validatePose({}, 'pose').map((entry) => entry.code)).toEqual([
      'MISSING_FIELD',
      'MISSING_FIELD',
      'MISSING_FIELD',
    ]);
    expect(validatePose({ rotationDeg: '30', translateXmm: 0, translateYmm: 0 }, 'pose')[0].code).toBe(
      'WRONG_TYPE',
    );
    expect(validatePose('khong-phai-object', 'pose')[0].code).toBe('WRONG_TYPE');
  });

  it('góc ngoài [0,360) bị chặn — canonical là hợp đồng, không phải gợi ý', () => {
    for (const rotationDeg of [-0.001, 360, 360.5, 720]) {
      const issues = validatePose({ rotationDeg, translateXmm: 0, translateYmm: 0 }, 'pose');
      expect(issues.some((entry) => entry.code === 'OUT_OF_RANGE'), String(rotationDeg)).toBe(true);
    }
    // Biên dưới hợp lệ, và sai số cực nhỏ dưới 0 được tha đúng bằng epsilon.
    expect(validatePose({ rotationDeg: 0, translateXmm: 0, translateYmm: 0 }, 'pose')).toEqual([]);
    expect(
      validatePose({ rotationDeg: -ANGLE_EPSILON_DEG / 2, translateXmm: 0, translateYmm: 0 }, 'pose'),
    ).toEqual([]);
    expect(validatePose({ rotationDeg: 359.999999999, translateXmm: 0, translateYmm: 0 }, 'pose')).toEqual(
      [],
    );
  });

  it('instanceId trùng bị chặn, kể cả trùng giữa placements và unplaced', () => {
    const trungTrongPlacements = manifest({
      placements: [
        { instanceId: 'p#0001', partId: 'p', sheetIndex: 0, pose: { rotationDeg: 0, translateXmm: 0, translateYmm: 0 } },
        { instanceId: 'p#0001', partId: 'p', sheetIndex: 0, pose: { rotationDeg: 0, translateXmm: 1, translateYmm: 1 } },
      ],
    });
    expect(issueCodes(trungTrongPlacements)).toContain('DUPLICATE_ID');

    const trungCheo = manifest({
      unplaced: [{ instanceId: 'part-a#0001', partId: 'part-a', reason: 'NO_FEASIBLE_POSE' }],
      stats: { ...(manifest().stats as Record<string, unknown>), unplacedCount: 1 },
    });
    expect(issueCodes(trungCheo)).toContain('DUPLICATE_ID');
  });

  it('stats phải khớp placements thật', () => {
    expect(
      issueCodes(manifest({ stats: { ...(manifest().stats as Record<string, unknown>), placedCount: 5 } })),
    ).toContain('STATS_MISMATCH');
    expect(
      issueCodes(manifest({ stats: { ...(manifest().stats as Record<string, unknown>), unplacedCount: 3 } })),
    ).toContain('STATS_MISMATCH');
  });

  it('sheetIndex vượt sheetCount bị chặn', () => {
    const raw = manifest({
      placements: [
        { instanceId: 'p#0001', partId: 'p', sheetIndex: 4, pose: { rotationDeg: 0, translateXmm: 0, translateYmm: 0 } },
      ],
      stats: { ...(manifest().stats as Record<string, unknown>), placedCount: 1, sheetCount: 1 },
    });
    expect(issueCodes(raw)).toContain('STATS_MISMATCH');
  });

  it('sheetIndex âm hoặc không nguyên bị chặn', () => {
    for (const sheetIndex of [-1, 1.5, '0']) {
      const raw = manifest({
        placements: [
          { instanceId: 'p#0001', partId: 'p', sheetIndex, pose: { rotationDeg: 0, translateXmm: 0, translateYmm: 0 } },
        ],
        stats: { ...(manifest().stats as Record<string, unknown>), placedCount: 1 },
      });
      expect(issueCodes(raw), String(sheetIndex)).toContain('OUT_OF_RANGE');
    }
  });

  it('unplaced reason lạ bị chặn', () => {
    const raw = manifest({
      unplaced: [{ instanceId: 'p#0003', partId: 'p', reason: 'KHONG_BIET' }],
      stats: { ...(manifest().stats as Record<string, unknown>), unplacedCount: 1 },
    });
    expect(issueCodes(raw)).toContain('UNKNOWN_ENUM');
  });

  it('terminationReason lạ bị chặn', () => {
    expect(
      issueCodes(
        manifest({ stats: { ...(manifest().stats as Record<string, unknown>), terminationReason: 'timeout' } }),
      ),
    ).toContain('UNKNOWN_ENUM');
  });

  it('materialUtilization âm hoặc không hữu hạn bị chặn', () => {
    for (const value of [-0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        issueCodes(manifest({ stats: { ...(manifest().stats as Record<string, unknown>), materialUtilization: value } })),
      ).toContain('OUT_OF_RANGE');
    }
  });

  it('gom nhiều lỗi trong một lần kiểm, không dừng ở lỗi đầu', () => {
    const result = validateManifest({
      protocolVersion: 9,
      matrix: [1, 0, 0, 1, 0, 0],
      placements: 'khong-phai-mang',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = new Set(result.issues.map((entry) => entry.code));
      expect(codes.has('PROTOCOL_MISMATCH')).toBe(true);
      expect(codes.has('FORBIDDEN_FIELD')).toBe(true);
      expect(codes.has('WRONG_TYPE')).toBe(true);
      expect(result.issues.length).toBeGreaterThan(3);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Bảo toàn số lượng
// ─────────────────────────────────────────────────────────────────────────────

describe('bảo toàn số lượng', () => {
  it('đủ số con thì đi qua', () => {
    expect(validateManifest(manifest(), { expectedQuantities: { 'part-a': 2 } }).ok).toBe(true);
  });

  it('thiếu hoặc thừa con bị chặn', () => {
    expect(issueCodes(manifest(), { expectedQuantities: { 'part-a': 3 } })).toContain(
      'QUANTITY_MISMATCH',
    );
    expect(issueCodes(manifest(), { expectedQuantities: { 'part-a': 2, 'part-b': 1 } })).toContain(
      'QUANTITY_MISMATCH',
    );
  });

  it('chi tiết lạ trong manifest bị chặn', () => {
    const raw = manifest({
      placements: [
        { instanceId: 'x#0001', partId: 'part-la', sheetIndex: 0, pose: { rotationDeg: 0, translateXmm: 0, translateYmm: 0 } },
      ],
      stats: { ...(manifest().stats as Record<string, unknown>), placedCount: 1 },
    });
    expect(issueCodes(raw, { expectedQuantities: { 'part-a': 1 } })).toContain('QUANTITY_MISMATCH');
  });

  it('unplaced vẫn tính vào số lượng — không được bỏ part để giảm số tờ', () => {
    const raw = manifest({
      placements: [
        { instanceId: 'part-a#0001', partId: 'part-a', sheetIndex: 0, pose: { rotationDeg: 0, translateXmm: 0, translateYmm: 0 } },
      ],
      unplaced: [{ instanceId: 'part-a#0002', partId: 'part-a', reason: 'NO_FEASIBLE_POSE' }],
      stats: { ...(manifest().stats as Record<string, unknown>), placedCount: 1, unplacedCount: 1 },
    });
    expect(validateManifest(raw, { expectedQuantities: { 'part-a': 2 } }).ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Tiện ích góc
// ─────────────────────────────────────────────────────────────────────────────

describe('tiện ích góc', () => {
  it('angleMatchesAny xử lý vòng qua 0°', () => {
    expect(angleMatchesAny(0, [360])).toBe(true);
    expect(angleMatchesAny(359.9999999, [0])).toBe(true);
    expect(angleMatchesAny(180, [0, 90, 180, 270])).toBe(true);
    expect(angleMatchesAny(13.372849, [0, 90, 180, 270])).toBe(false);
    expect(angleMatchesAny(13.372849, [13.372849])).toBe(true);
  });

  it('angleInArc bao được cung đi qua 0°', () => {
    const arc = { startDeg: 350, sweepDeg: 20 };
    expect(angleInArc(355, arc)).toBe(true);
    expect(angleInArc(5, arc)).toBe(true);
    expect(angleInArc(10, arc)).toBe(true);
    expect(angleInArc(11, arc)).toBe(false);
    expect(angleInArc(349, arc)).toBe(false);
  });

  it('isCardinalAngle chỉ đúng với bốn góc vuông', () => {
    for (const angle of [0, 90, 180, 270, 360]) expect(isCardinalAngle(angle)).toBe(true);
    for (const angle of [13.372849, 45, 89.99, 359.5]) expect(isCardinalAngle(angle)).toBe(false);
  });

  it('hasFractionalTranslation nhận ra toạ độ ngoài lưới mm', () => {
    expect(hasFractionalTranslation({ rotationDeg: 0, translateXmm: 10, translateYmm: 20 })).toBe(false);
    expect(hasFractionalTranslation({ rotationDeg: 0, translateXmm: 10.5, translateYmm: 20 })).toBe(true);
    expect(hasFractionalTranslation({ rotationDeg: 0, translateXmm: 10, translateYmm: 19.999 })).toBe(true);
  });

  it('collectPoseMetrics đếm đúng bằng chứng free-angle và continuous X/Y', () => {
    const result = validateManifest(manifest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const metrics = collectPoseMetrics(result.manifest.placements);
    expect(metrics.nonCardinalAngleCount).toBe(1);
    expect(metrics.fractionalTranslationCount).toBe(1);
    expect(metrics.distinctAngles).toBe(2);
  });

  it('groupBySheet giữ nguyên thứ tự trong manifest', () => {
    const result = validateManifest(
      manifest({
        placements: [
          { instanceId: 'a#0001', partId: 'a', sheetIndex: 1, pose: { rotationDeg: 0, translateXmm: 0, translateYmm: 0 } },
          { instanceId: 'a#0002', partId: 'a', sheetIndex: 0, pose: { rotationDeg: 0, translateXmm: 1, translateYmm: 1 } },
          { instanceId: 'a#0003', partId: 'a', sheetIndex: 1, pose: { rotationDeg: 0, translateXmm: 2, translateYmm: 2 } },
        ],
        stats: { ...(manifest().stats as Record<string, unknown>), placedCount: 3, sheetCount: 2 },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bySheet = groupBySheet(result.manifest.placements);
    expect([...bySheet.keys()]).toEqual([1, 0]);
    expect(bySheet.get(1)?.map((entry) => entry.instanceId)).toEqual(['a#0001', 'a#0003']);
    expect(bySheet.get(0)?.map((entry) => entry.instanceId)).toEqual(['a#0002']);
  });
});
