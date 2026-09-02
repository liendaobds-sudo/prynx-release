/**
 * Phạm vi hiển thị option "Nesting tối ưu theo đường bế" — Lô A4a-3.
 *
 * Bộ test này khoá cả **ca dương** (đúng công cụ, đúng taskMode, cờ bật) lẫn
 * **ca âm**, vì rủi ro thật của lô này không phải "option không hiện" mà là
 * "option hiện ở chỗ chưa được phép":
 *
 * - hiện ở Bình trang/S&R (`step_repeat`) — kernel còn kém baseline rất xa ở S&R
 *   hình tam giác (77–84 so với 152 con/tờ theo số đo Lô 0);
 * - hiện ở công cụ ngoài Tem bế/CNC;
 * - hiện ở bản phát hành khi cờ chưa bật.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GRID_STRATEGY,
  TRUE_SHAPE_NESTING_BACKEND_FLAG_NAME,
  TRUE_SHAPE_NESTING_FLAG_NAME,
  TRUE_SHAPE_NESTING_STRATEGY,
  isSpecialShapeType,
  isTrueShapeNestingEnabled,
  jobHasSpecialShape,
  resolveGridStrategy,
  shouldShowTrueShapeNestingOption,
  shouldUseTrueShapeNesting,
  trueShapeJobMembershipKey,
} from './trueShapeNestingRollout';
import { MIXED_NESTING_FLAG_NAME } from '../../lib/mixed-nesting/rollout';

describe('cờ rollout nesting theo đường bế', () => {
  it('mặc định HOLD ở bản phát hành, mở trong dev', () => {
    expect(isTrueShapeNestingEnabled(false, false)).toBe(false);
    expect(isTrueShapeNestingEnabled(false, true)).toBe(true);
    expect(isTrueShapeNestingEnabled(true, false)).toBe(true);
    expect(isTrueShapeNestingEnabled(true, true)).toBe(true);
  });

  it('là cờ RIÊNG, không dùng chung với công cụ Mixed Nesting standalone', () => {
    // Dùng chung cờ thì không tách được kill switch của hai đường.
    expect(TRUE_SHAPE_NESTING_FLAG_NAME).not.toBe(MIXED_NESTING_FLAG_NAME);
    expect(TRUE_SHAPE_NESTING_FLAG_NAME).toBe('VITE_TRUE_SHAPE_NESTING_ENABLED');
    expect(TRUE_SHAPE_NESTING_BACKEND_FLAG_NAME).toBe(
      'PRYNX_TRUE_SHAPE_NESTING_ENABLED',
    );
  });

  it('giá trị strategy khớp nhãn enum Rust', () => {
    expect(TRUE_SHAPE_NESTING_STRATEGY).toBe('true_shape_nesting');
  });
});

describe('phạm vi hiển thị option', () => {
  const show = (over: Partial<Parameters<typeof shouldShowTrueShapeNestingOption>[0]>) =>
    shouldShowTrueShapeNestingOption({
      enabled: true,
      activeTool: 'sticker_imposer',
      taskMode: 'nup',
      ...over,
    });

  it('CA DƯƠNG: hiện ở nhánh gang của Tem bế và CNC', () => {
    expect(show({ activeTool: 'sticker_imposer' })).toBe(true);
    expect(show({ activeTool: 'cnc_imposer' })).toBe(true);
  });

  it('CA ÂM: cờ tắt thì không hiện dù đúng công cụ và taskMode', () => {
    expect(show({ enabled: false })).toBe(false);
    expect(show({ enabled: false, activeTool: 'cnc_imposer' })).toBe(false);
  });

  it('CA ÂM: không hiện ở Bình trang/S&R', () => {
    expect(show({ taskMode: 'step_repeat' })).toBe(false);
    expect(show({ activeTool: 'cnc_imposer', taskMode: 'step_repeat' })).toBe(false);
  });

  it('CA ÂM: không hiện ở booklet hay taskMode lạ', () => {
    expect(show({ taskMode: 'booklet' })).toBe(false);
    expect(show({ taskMode: '' })).toBe(false);
    expect(show({ taskMode: 'NUP' })).toBe(false);
  });

  it('CA ÂM: không hiện ở công cụ ngoài Tem bế/CNC', () => {
    for (const tool of [
      'guillotine_imposer',
      'booklet_imposer',
      'mixed_nesting',
      'pdf_tools',
      '',
    ]) {
      expect(show({ activeTool: tool })).toBe(false);
    }
  });

  it('CA ÂM: tên công cụ legacy không được lọt qua', () => {
    // `sticker_imposer`/`cnc_imposer` từng bị dùng như taskMode; giá trị legacy
    // đó ở ô taskMode không được coi là nhánh gang.
    expect(show({ taskMode: 'sticker_imposer' })).toBe(false);
    expect(show({ taskMode: 'cnc_imposer' })).toBe(false);
  });

  it('ba điều kiện phải ĐỒNG THỜI đúng', () => {
    expect(
      shouldShowTrueShapeNestingOption({
        enabled: false,
        activeTool: 'guillotine_imposer',
        taskMode: 'step_repeat',
      }),
    ).toBe(false);
    expect(
      shouldShowTrueShapeNestingOption({
        enabled: true,
        activeTool: 'cnc_imposer',
        taskMode: 'nup',
      }),
    ).toBe(true);
  });
});

describe('resolveGridStrategy — chống rò true_shape_nesting sang công cụ khác', () => {
  const resolve = (over: Partial<Parameters<typeof resolveGridStrategy>[0]>) =>
    resolveGridStrategy({
      enabled: true,
      activeTool: 'sticker_imposer',
      taskMode: 'nup',
      gridStrategy: TRUE_SHAPE_NESTING_STRATEGY,
      ...over,
    });

  it('GIỮ true_shape_nesting khi đúng công cụ + taskMode nup + cờ bật', () => {
    expect(resolve({ activeTool: 'sticker_imposer' })).toBe(TRUE_SHAPE_NESTING_STRATEGY);
    expect(resolve({ activeTool: 'cnc_imposer' })).toBe(TRUE_SHAPE_NESTING_STRATEGY);
  });

  it('CHUẨN HOÁ về optimal_auto khi rò sang Bình cắt xén / công cụ ngoài phạm vi', () => {
    // Đây là ca P1: giá trị persist từ tem bế rò sang guillotine → backend fail-closed.
    expect(resolve({ activeTool: 'guillotine_imposer' })).toBe(DEFAULT_GRID_STRATEGY);
    expect(resolve({ activeTool: 'booklet_imposer' })).toBe(DEFAULT_GRID_STRATEGY);
    expect(resolve({ activeTool: '' })).toBe(DEFAULT_GRID_STRATEGY);
  });

  it('CHUẨN HOÁ khi taskMode là step_repeat (S&R) dù đúng công cụ', () => {
    expect(resolve({ taskMode: 'step_repeat' })).toBe(DEFAULT_GRID_STRATEGY);
    expect(resolve({ activeTool: 'cnc_imposer', taskMode: 'step_repeat' })).toBe(
      DEFAULT_GRID_STRATEGY,
    );
  });

  it('CHUẨN HOÁ khi cờ tắt (bản phát hành HOLD) dù đúng công cụ + taskMode', () => {
    // Trạng thái tự khoá: option không hiện lại nên user không gỡ được từ UI.
    expect(resolve({ enabled: false })).toBe(DEFAULT_GRID_STRATEGY);
  });

  it('GIỮ NGUYÊN mọi giá trị hợp lệ khác, bất kể công cụ/taskMode/cờ', () => {
    for (const value of ['optimal_auto', 'simple_auto', 'manual']) {
      expect(resolve({ gridStrategy: value })).toBe(value);
      expect(resolve({ gridStrategy: value, activeTool: 'guillotine_imposer' })).toBe(value);
      expect(resolve({ gridStrategy: value, taskMode: 'step_repeat' })).toBe(value);
      expect(resolve({ gridStrategy: value, enabled: false })).toBe(value);
    }
  });

  it('DEFAULT_GRID_STRATEGY là optimal_auto (khớp default nupSlice + dropdown)', () => {
    expect(DEFAULT_GRID_STRATEGY).toBe('optimal_auto');
  });
});

describe('isSpecialShapeType — CUSTOM/thiếu/lạ = đặc biệt; hình có tên = không', () => {
  it('đặc biệt: null, undefined, rỗng, CUSTOM, giá trị lạ', () => {
    expect(isSpecialShapeType(null)).toBe(true);
    expect(isSpecialShapeType(undefined)).toBe(true);
    expect(isSpecialShapeType('')).toBe(true);
    expect(isSpecialShapeType('   ')).toBe(true);
    expect(isSpecialShapeType('CUSTOM')).toBe(true);
    expect(isSpecialShapeType('custom')).toBe(true);
    expect(isSpecialShapeType('rác_không_tồn_tại')).toBe(true);
  });

  it('không đặc biệt: đúng 10 hình có tên (khớp ShapeType backend trừ CUSTOM)', () => {
    for (const named of [
      'CIRCLE_ELLIPSE',
      'TRIANGLE',
      'RECTANGLE',
      'PENTAGON',
      'HEXAGON',
      'DUMBBELL',
      'HAMMER',
      'TRAPEZOID',
      'PARALLELOGRAM',
      'ARROW',
    ]) {
      expect(isSpecialShapeType(named)).toBe(false);
      expect(isSpecialShapeType(named.toLowerCase())).toBe(false);
    }
  });
});

describe('jobHasSpecialShape — "quy về đặc biệt hết" + tôn trọng SL trang', () => {
  it('có 1 CUSTOM ⇒ true; toàn hình có tên ⇒ false', () => {
    expect(jobHasSpecialShape({ shapesByPage: { 0: 'CUSTOM' } })).toBe(true);
    expect(jobHasSpecialShape({ shapesByPage: { 0: 'TRIANGLE', 1: 'HEXAGON' } })).toBe(false);
  });

  it('gang lẫn hình có tên + CUSTOM ⇒ true', () => {
    expect(
      jobHasSpecialShape({ shapesByPage: { 0: 'TRIANGLE', 1: 'CUSTOM', 2: 'RECTANGLE' } }),
    ).toBe(true);
  });

  it('thiếu / rỗng shapesByPage ⇒ thận trọng đặc biệt', () => {
    expect(jobHasSpecialShape({ shapesByPage: undefined })).toBe(true);
    expect(jobHasSpecialShape({ shapesByPage: {} })).toBe(true);
  });

  it('chỉ trang SL>0 vào job: global là mặc định, override 0 loại đúng mẫu', () => {
    expect(
      jobHasSpecialShape({
        shapesByPage: { 0: 'TRIANGLE', 1: 'CUSTOM' },
        targetQuantitiesByPage: { 0: 100, 1: 0 },
      }),
    ).toBe(false);
    expect(
      jobHasSpecialShape({
        shapesByPage: { 0: 'TRIANGLE', 1: 'CUSTOM' },
        targetQuantitiesByPage: { 0: 0, 1: 50 },
      }),
    ).toBe(true);

    // MAP-NEST-01: global > 0 phải áp cho mọi trang đã biết; override 0 thắng global.
    expect(
      jobHasSpecialShape({
        shapesByPage: { 0: 'TRIANGLE', 1: 'CUSTOM' },
        targetQuantity: 25,
        targetQuantitiesByPage: { 1: 0 },
      }),
    ).toBe(false);
    expect(
      jobHasSpecialShape({
        shapesByPage: { 0: 'TRIANGLE', 1: 'CUSTOM' },
        targetQuantity: '25',
        targetQuantitiesByPage: { 0: 0 },
      }),
    ).toBe(true);
  });
});

describe('trueShapeJobMembershipKey — khóa hình học Bình trang', () => {
  const shapesByPage = { 0: 'CUSTOM', 1: 'TRIANGLE', 2: 'RECTANGLE' };

  it('giữ nguyên khi chỉ đổi giá trị SL hoặc thứ tự key của cùng tập trang', () => {
    const first = trueShapeJobMembershipKey({
      shapesByPage,
      targetQuantitiesByPage: { 0: 100, 2: 25, 1: 0 },
    });
    const edited = trueShapeJobMembershipKey({
      shapesByPage,
      targetQuantitiesByPage: { 2: 999, 1: 0, 0: 200 },
    });

    expect(first).toBe('0,2');
    expect(edited).toBe(first);
  });

  it('đổi khi một mẫu được thêm vào hoặc loại khỏi job', () => {
    expect(trueShapeJobMembershipKey({
      shapesByPage,
      targetQuantitiesByPage: { 0: 100, 1: 0, 2: 25 },
    })).toBe('0,2');
    expect(trueShapeJobMembershipKey({
      shapesByPage,
      targetQuantitiesByPage: { 0: 100, 1: 50, 2: 0 },
    })).toBe('0,1');
  });
});

describe('shouldUseTrueShapeNesting — auto-route đồng bộ backend route_true_shape', () => {
  const use = (over: Partial<Parameters<typeof shouldUseTrueShapeNesting>[0]>) =>
    shouldUseTrueShapeNesting({
      enabled: true,
      imposerMode: undefined,
      isDieCut: true,
      pageSheetMode: false,
      layoutType: 'sequential',
      gridStrategy: 'optimal_auto',
      cutType: 'default',
      groupingStrategy: 'free_gang',
      shapesByPage: { 0: 'CUSTOM' },
      ...over,
    });

  it('CA DƯƠNG: CUSTOM + "Xếp tối ưu" trên tem bế → true', () => {
    expect(use({})).toBe(true);
  });

  it('CA DƯƠNG: CNC (imposerMode=cnc) + CUSTOM + optimal → true dù isDieCut=false', () => {
    expect(use({ imposerMode: 'cnc', isDieCut: false })).toBe(true);
  });

  it('CA DƯƠNG: gang lẫn hình có tên + CUSTOM → true', () => {
    expect(use({ shapesByPage: { 0: 'TRIANGLE', 1: 'CUSTOM', 2: 'RECTANGLE' } })).toBe(true);
  });

  it('CA ÂM: toàn hình có tên → false (giữ tiler chuyên biệt cũ)', () => {
    expect(use({ shapesByPage: { 0: 'TRIANGLE', 1: 'HEXAGON' } })).toBe(false);
  });

  it('CA ÂM: "Lưới đơn giản" / manual → false', () => {
    expect(use({ gridStrategy: 'simple_auto' })).toBe(false);
    expect(use({ gridStrategy: 'manual' })).toBe(false);
  });

  it('CA ÂM: 1 Dao (chữ nhật) → false dù dò ra CUSTOM', () => {
    expect(use({ cutType: 'one_dao' })).toBe(false);
    expect(use({ cutType: 'ONE_DAO' })).toBe(false);
  });

  it('CA ÂM: nguyên tấm decal (page_sheet) → false', () => {
    expect(use({ pageSheetMode: true })).toBe(false);
  });

  it('CA ÂM: dàn nhiều kích thước (mixed_guillotine) → false', () => {
    expect(use({ layoutType: 'mixed_guillotine' })).toBe(false);
  });

  it.each([
    ['ratio_stack', { layoutType: 'ratio_stack' }],
    ['cut_stacks', { layoutType: 'cut_stacks' }],
    ['strict_ratio', { groupingStrategy: 'strict_ratio' }],
    ['grouping none ở N-up', { groupingStrategy: 'none' }],
    ['cluster_tile', { groupingStrategy: 'cluster_tile' }],
    ['cluster mode', { clusterMode: 'rows' }],
    ['xoay xen kẽ', { alternateRotation: 'row' }],
    ['viền cắt', { cutBorderEnabled: true }],
    ['OCG đang ẩn', { hiddenOcgLayerIds: ['ocg-1'] }],
    ['lưu theo report', { saveByReport: true }],
  ] as const)('CA ÂM compatibility: %s → false', (_name, overrides) => {
    expect(use(overrides)).toBe(false);
  });

  it('CA DƯƠNG: N-up nhận free_gang/maximize_area; S&R chỉ nhận none/free_gang', () => {
    expect(use({ groupingStrategy: 'free_gang' })).toBe(true);
    expect(use({ groupingStrategy: 'maximize_area' })).toBe(true);
    expect(use({ groupingStrategy: undefined })).toBe(true);
    expect(
      use({ taskMode: 'step_repeat', layoutType: 'repeat', groupingStrategy: 'none' }),
    ).toBe(true);
    expect(
      use({
        taskMode: 'step_repeat',
        layoutType: 'repeat',
        groupingStrategy: 'maximize_area',
      }),
    ).toBe(false);
    expect(
      use({
        imposerMode: 'cnc',
        isDieCut: false,
        cncTwoSided: false,
        cncDuplexMarks: true,
      }),
    ).toBe(true);
  });

  it('CA DƯƠNG: CNC hai mặt có dấu canh dùng true-shape ở preview/export', () => {
    expect(
      use({
        imposerMode: 'cnc',
        isDieCut: false,
        cncTwoSided: true,
        cncDuplexMarks: true,
      }),
    ).toBe(true);
  });

  it('CA ÂM: không die-cut và không CNC (guillotine / N-Up thường) → false', () => {
    expect(use({ isDieCut: false, imposerMode: undefined })).toBe(false);
  });

  it('CA ÂM: cờ master tắt → false (bản phát hành HOLD)', () => {
    expect(use({ enabled: false })).toBe(false);
  });

  it('trang SL 0 KHÔNG kéo cả job thành đặc biệt (khớp _page_quantities backend)', () => {
    expect(
      use({
        shapesByPage: { 0: 'TRIANGLE', 1: 'CUSTOM' },
        targetQuantitiesByPage: { 0: 100, 1: 0 },
      }),
    ).toBe(false);
  });

  it('shapesByPage rỗng / thiếu → thận trọng đặc biệt (die-cut chưa dò = CUSTOM)', () => {
    expect(use({ shapesByPage: {} })).toBe(true);
    expect(use({ shapesByPage: undefined })).toBe(true);
  });
});
