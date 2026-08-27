import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  NORMALIZE_RULE_VERSION,
  REFERENCE_POINT_RULE_VERSION,
  applyMatrix,
  deriveReferencePoint,
  flipY,
  isInsideUsable,
  matrixDeterminant,
  placedShapeOf,
  poseMatrix,
  ringAreaMm2,
  ringBounds,
  shapesBySheet,
  sheetViewBox,
  signedRingAreaMm2,
  toSvgPath,
  toSvgPoints,
  transformRing,
  usableRectMm,
  usedAreaMm2,
  usedBoundsOf,
  type PartSource,
} from './previewGeometry';
import type { PlacementRecord, RingMm, SheetSpec } from './types';

const REPO_ROOT = resolve(__dirname, '../../../..');
const NORMALIZE_RS = resolve(
  REPO_ROOT,
  'imposition_core/src/mixed_nesting/normalize.rs',
);

function rect(w: number, h: number, x = 0, y = 0): RingMm {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

const SHEET: SheetSpec = {
  widthMm: 700,
  heightMm: 1000,
  marginMm: { left: 10, right: 10, top: 10, bottom: 10 },
  maxSheets: 20,
};

function placement(
  overrides: Partial<PlacementRecord> & { pose?: Partial<PlacementRecord['pose']> } = {},
): PlacementRecord {
  return {
    instanceId: 'part-a#0001',
    partId: 'part-a',
    sheetIndex: 0,
    ...overrides,
    pose: {
      rotationDeg: 0,
      translateXmm: 0,
      translateYmm: 0,
      ...(overrides.pose ?? {}),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  1. Parity quy tắc pivot với Rust
// ─────────────────────────────────────────────────────────────────────────────

describe('parity với normalize.rs', () => {
  it('hai hằng version khớp Rust — đổi quy tắc là test đỏ', () => {
    const source = readFileSync(NORMALIZE_RS, 'utf8');
    const read = (name: string): number => {
      const match = new RegExp(`pub const ${name}: u32 = (\\d+);`).exec(source);
      expect(match, `không thấy ${name} trong normalize.rs`).not.toBeNull();
      return Number.parseInt(match![1], 10);
    };
    expect(REFERENCE_POINT_RULE_VERSION).toBe(read('REFERENCE_POINT_RULE_VERSION'));
    expect(NORMALIZE_RULE_VERSION).toBe(read('NORMALIZE_RULE_VERSION'));
  });

  it('Rust vẫn dùng trọng tâm diện tích, không phải góc bbox', () => {
    // Nếu ai đó đổi pivot sang bbox mà quên tăng version, chuỗi này sẽ mất.
    const source = readFileSync(NORMALIZE_RS, 'utf8');
    expect(source).toContain('pub fn derive_reference_point');
    expect(source).toContain('Trọng tâm diện tích của vòng');
  });

  it('trọng tâm bất biến với đỉnh bắt đầu và chiều vòng', () => {
    const ring = rect(80, 40, 10, 20);
    const expected = deriveReferencePoint(ring);
    expect(expected).not.toBeNull();

    const rotated: RingMm = [ring[2], ring[3], ring[0], ring[1]];
    const reversed: RingMm = [...ring].reverse();
    for (const variant of [rotated, reversed]) {
      const got = deriveReferencePoint(variant)!;
      expect(got[0]).toBeCloseTo(expected![0], 12);
      expect(got[1]).toBeCloseTo(expected![1], 12);
    }
  });

  it('trọng tâm hình chữ nhật là tâm hình học', () => {
    const centroid = deriveReferencePoint(rect(80, 40))!;
    expect(centroid[0]).toBeCloseTo(40, 12);
    expect(centroid[1]).toBeCloseTo(20, 12);
  });

  it('trọng tâm tam giác là trung bình ba đỉnh', () => {
    const triangle: RingMm = [
      [0, 0],
      [90, 0],
      [30, 60],
    ];
    const centroid = deriveReferencePoint(triangle)!;
    expect(centroid[0]).toBeCloseTo((0 + 90 + 30) / 3, 10);
    expect(centroid[1]).toBeCloseTo((0 + 0 + 60) / 3, 10);
  });

  it('vòng suy biến trả null thay vì một pivot bịa', () => {
    expect(deriveReferencePoint([])).toBeNull();
    expect(deriveReferencePoint([[0, 0]])).toBeNull();
    expect(deriveReferencePoint([[0, 0], [1, 1]])).toBeNull();
    // Ba điểm thẳng hàng: diện tích 0.
    expect(deriveReferencePoint([[0, 0], [1, 0], [2, 0]])).toBeNull();
  });

  it('loại đỉnh thẳng hàng KHÔNG đổi trọng tâm — nên preview khớp engine', () => {
    const tho: RingMm = [
      [0, 0],
      [40, 0],
      [80, 0],
      [80, 40],
      [40, 40],
      [0, 40],
    ];
    const sach = rect(80, 40);
    const a = deriveReferencePoint(tho)!;
    const b = deriveReferencePoint(sach)!;
    expect(a[0]).toBeCloseTo(b[0], 12);
    expect(a[1]).toBeCloseTo(b[1], 12);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  2. Pose: rigid, không mirror, không scale
// ─────────────────────────────────────────────────────────────────────────────

describe('poseMatrix', () => {
  it('định thức luôn +1 — không có đường mirror hay scale', () => {
    for (const angle of [0, 13.372849, 45, 90, 180, 270, 359.999999]) {
      const matrix = poseMatrix(angle, 12.5, -7.25, [3, 4]);
      expect(matrixDeterminant(matrix)).toBeCloseTo(1, 12);
    }
  });

  it('bảo toàn khoảng cách — không co giãn', () => {
    const matrix = poseMatrix(37.5, 100, 200, [10, 20]);
    const a = applyMatrix(matrix, [0, 0]);
    const b = applyMatrix(matrix, [30, 40]);
    const distance = Math.hypot(b[0] - a[0], b[1] - a[1]);
    expect(distance).toBeCloseTo(50, 10);
  });

  it('bảo toàn chiều vòng — dấu diện tích không đổi', () => {
    const ring = rect(80, 40);
    const truoc = signedRingAreaMm2(ring);
    for (const angle of [13.372849, 90, 217.5]) {
      const sau = signedRingAreaMm2(transformRing(ring, angle, 5, 5, [40, 20]));
      expect(Math.sign(sau)).toBe(Math.sign(truoc));
      expect(Math.abs(sau)).toBeCloseTo(Math.abs(truoc), 8);
    }
  });

  it('pivot được đưa đúng về (tx, ty)', () => {
    const ring = rect(80, 40);
    const pivot = deriveReferencePoint(ring)!;
    for (const angle of [0, 13.372849, 123.456]) {
      const matrix = poseMatrix(angle, 123.456789, 67.891234, pivot);
      const anh = applyMatrix(matrix, pivot);
      expect(anh[0]).toBeCloseTo(123.456789, 9);
      expect(anh[1]).toBeCloseTo(67.891234, 9);
    }
  });

  it('góc 0 với pivot ở tâm: chỉ là tịnh tiến quanh pivot', () => {
    const ring = rect(80, 40);
    const moved = transformRing(ring, 0, 100, 200, [40, 20]);
    expect(moved[0][0]).toBeCloseTo(60, 12);
    expect(moved[0][1]).toBeCloseTo(180, 12);
    expect(moved[2][0]).toBeCloseTo(140, 12);
    expect(moved[2][1]).toBeCloseTo(220, 12);
  });

  it('xoay 90° đổi bề rộng và bề cao của bao', () => {
    const ring = rect(80, 40);
    const bounds = ringBounds(transformRing(ring, 90, 0, 0, [40, 20]))!;
    expect(bounds.maxX - bounds.minX).toBeCloseTo(40, 10);
    expect(bounds.maxY - bounds.minY).toBeCloseTo(80, 10);
  });

  it('giữ nguyên precision của góc không-cardinal và toạ độ phần lẻ', () => {
    const shape = placedShapeOf(
      placement({
        pose: {
          rotationDeg: 13.372849,
          translateXmm: 123.45678901234567,
          translateYmm: 67.891234,
        },
      }),
      new Map<string, PartSource>([
        ['part-a', { partId: 'part-a', outer: rect(80, 40), holes: [] }],
      ]),
    )!;
    // Pose gốc đi kèm hình vẽ, nguyên chữ số.
    expect(shape.rotationDeg).toBe(13.372849);
    expect(shape.translateXmm).toBe(123.45678901234567);
    expect(shape.translateYmm).toBe(67.891234);
    // Và toạ độ dẫn xuất KHÔNG bị làm tròn về số nguyên hay 0,1 mm.
    const hasFraction = shape.outer.some(
      ([x, y]) => Math.abs(x - Math.round(x)) > 1e-9 || Math.abs(y - Math.round(y)) > 1e-9,
    );
    expect(hasFraction).toBe(true);
  });

  it('module không chứa phép làm tròn hay tham số lưới', () => {
    const source = readFileSync(
      resolve(__dirname, 'previewGeometry.ts'),
      'utf8',
    );
    // Bỏ comment trước khi soi, để phần giải thích "không làm tròn" không tự làm đỏ.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    for (const cam of ['toFixed(', 'Math.round(', 'snap', 'gridMm', 'stepMm', 'quantize']) {
      expect(code, cam).not.toContain(cam);
    }
    // `Math.round` chỉ được dùng trong TEST để kiểm phần lẻ, không có trong module.
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  3. Từ manifest sang hình vẽ, nhiều tờ
// ─────────────────────────────────────────────────────────────────────────────

describe('placedShapeOf và shapesBySheet', () => {
  const sources: PartSource[] = [
    { partId: 'part-a', outer: rect(80, 40), holes: [rect(20, 10, 10, 10)] },
    { partId: 'part-b', outer: rect(50, 50), holes: [] },
  ];

  it('áp pose cho cả contour ngoài và lỗ', () => {
    const shape = placedShapeOf(
      placement({ pose: { rotationDeg: 90, translateXmm: 100, translateYmm: 100 } }),
      new Map(sources.map((s) => [s.partId, s])),
    )!;
    expect(shape.outer).toHaveLength(4);
    expect(shape.holes).toHaveLength(1);
    expect(shape.holes[0]).toHaveLength(4);
    // Lỗ vẫn nằm trong contour ngoài sau khi xoay.
    const outer = ringBounds(shape.outer)!;
    const hole = ringBounds(shape.holes[0])!;
    expect(hole.minX).toBeGreaterThanOrEqual(outer.minX - 1e-9);
    expect(hole.maxX).toBeLessThanOrEqual(outer.maxX + 1e-9);
  });

  it('partId lạ thì BỎ VẼ, không vẽ hình đoán', () => {
    const shape = placedShapeOf(
      placement({ partId: 'khong-co' }),
      new Map(sources.map((s) => [s.partId, s])),
    );
    expect(shape).toBeNull();
  });

  it('contour nguồn suy biến thì bỏ vẽ', () => {
    const shape = placedShapeOf(
      placement(),
      new Map<string, PartSource>([
        ['part-a', { partId: 'part-a', outer: [[0, 0], [1, 0]], holes: [] }],
      ]),
    );
    expect(shape).toBeNull();
  });

  it('gom đúng nhiều tờ và giữ thứ tự trong từng tờ', () => {
    const placements: PlacementRecord[] = [
      placement({ instanceId: 'a#1', partId: 'part-a', sheetIndex: 1 }),
      placement({ instanceId: 'b#1', partId: 'part-b', sheetIndex: 0 }),
      placement({ instanceId: 'a#2', partId: 'part-a', sheetIndex: 1 }),
      placement({ instanceId: 'b#2', partId: 'part-b', sheetIndex: 2 }),
    ];
    const bySheet = shapesBySheet(placements, sources);
    expect([...bySheet.keys()]).toEqual([1, 0, 2]);
    expect(bySheet.get(1)!.map((s) => s.instanceId)).toEqual(['a#1', 'a#2']);
    expect(bySheet.get(2)!.map((s) => s.instanceId)).toEqual(['b#2']);
  });

  it('placement có partId thiếu nguồn bị loại khỏi mọi tờ', () => {
    const bySheet = shapesBySheet(
      [placement({ partId: 'khong-co', sheetIndex: 0 }), placement({ sheetIndex: 0 })],
      sources,
    );
    expect(bySheet.get(0)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  4. Adapter render — đổi hệ Y chỉ ở đây
// ─────────────────────────────────────────────────────────────────────────────

describe('adapter SVG', () => {
  it('flipY là phép đối xứng: gọi hai lần về giá trị gốc', () => {
    for (const y of [0, 13.372849, 500, 1000]) {
      expect(flipY(SHEET, flipY(SHEET, y))).toBeCloseTo(y, 12);
    }
  });

  it('gốc tờ (0,0) nằm ở đáy khung SVG', () => {
    expect(flipY(SHEET, 0)).toBe(1000);
    expect(flipY(SHEET, 1000)).toBe(0);
  });

  it('viewBox phủ đúng khổ tờ theo mm', () => {
    expect(sheetViewBox(SHEET)).toBe('0 0 700 1000');
    expect(sheetViewBox({ ...SHEET, widthMm: 100.37, heightMm: 60.73 })).toBe(
      '0 0 100.37 60.73',
    );
  });

  it('toSvgPoints không làm tròn toạ độ phần lẻ', () => {
    const points = toSvgPoints([[12.3456789, 20.5]], SHEET);
    expect(points).toBe('12.3456789,979.5');
  });

  it('toSvgPath ghép contour ngoài và lỗ thành một path đóng', () => {
    const shape = placedShapeOf(
      placement(),
      new Map<string, PartSource>([
        ['part-a', { partId: 'part-a', outer: rect(80, 40), holes: [rect(20, 10, 10, 10)] }],
      ]),
    )!;
    const path = toSvgPath(shape, SHEET);
    expect(path.startsWith('M ')).toBe(true);
    // Hai vòng ⇒ hai lệnh Z.
    expect(path.match(/Z/g)).toHaveLength(2);
  });

  it('usableRectMm trừ đúng bốn lề', () => {
    const usable = usableRectMm({
      ...SHEET,
      marginMm: { left: 5.19, right: 6.5, top: 7, bottom: 8.25 },
    });
    expect(usable.minX).toBe(5.19);
    expect(usable.minY).toBe(8.25);
    expect(usable.maxX).toBe(700 - 6.5);
    expect(usable.maxY).toBe(1000 - 7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  5. Số đo cho phần tóm tắt
// ─────────────────────────────────────────────────────────────────────────────

describe('số đo hiển thị', () => {
  const sources: PartSource[] = [
    { partId: 'part-a', outer: rect(80, 40), holes: [rect(20, 10, 10, 10)] },
  ];

  it('ringAreaMm2 dương bất kể chiều vòng', () => {
    const ring = rect(80, 40);
    expect(ringAreaMm2(ring)).toBeCloseTo(3200, 9);
    expect(ringAreaMm2([...ring].reverse())).toBeCloseTo(3200, 9);
  });

  it('usedAreaMm2 trừ diện tích lỗ', () => {
    const shapes = shapesBySheet([placement()], sources).get(0)!;
    expect(usedAreaMm2(shapes)).toBeCloseTo(3200 - 200, 8);
  });

  it('usedBoundsOf gộp bao của mọi hình trên tờ', () => {
    const placements = [
      placement({ instanceId: 'a#1', pose: { rotationDeg: 0, translateXmm: 100, translateYmm: 100 } }),
      placement({ instanceId: 'a#2', pose: { rotationDeg: 0, translateXmm: 300, translateYmm: 400 } }),
    ];
    const shapes = shapesBySheet(placements, sources).get(0)!;
    const bounds = usedBoundsOf(shapes)!;
    expect(bounds.minX).toBeCloseTo(60, 8);
    expect(bounds.minY).toBeCloseTo(80, 8);
    expect(bounds.maxX).toBeCloseTo(340, 8);
    expect(bounds.maxY).toBeCloseTo(420, 8);
  });

  it('usedBoundsOf trả null khi chưa có hình nào', () => {
    expect(usedBoundsOf([])).toBeNull();
  });

  it('isInsideUsable chỉ để CẢNH BÁO, và bắt được hình lọt ra lề', () => {
    const trong = shapesBySheet(
      [placement({ pose: { rotationDeg: 0, translateXmm: 200, translateYmm: 300 } })],
      sources,
    ).get(0)!;
    expect(isInsideUsable(trong[0], SHEET)).toBe(true);

    const ngoai = shapesBySheet(
      [placement({ pose: { rotationDeg: 0, translateXmm: 5, translateYmm: 5 } })],
      sources,
    ).get(0)!;
    expect(isInsideUsable(ngoai[0], SHEET)).toBe(false);
  });

  it('ringBounds trả null cho vòng rỗng', () => {
    expect(ringBounds([])).toBeNull();
  });
});
