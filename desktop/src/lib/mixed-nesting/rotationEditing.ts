/**
 * Hàm thuần cho phần điều khiển xoay — phase P10.
 *
 * Kế hoạch: `docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md` §15.
 *
 * Tách khỏi `PartsTable.tsx` vì hai lý do thật: `InputPanel.tsx` cũng cần
 * `switchRotationMode`, và eslint `react-refresh/only-export-components` chặn việc một file
 * component export cả hàm thuần.
 *
 * Bất biến của cả module: **không có khái niệm "bước góc"**. Mọi hàm ở đây chỉ làm việc với
 * danh sách góc và cung góc — hai thứ có trong hợp đồng. Không hàm nào làm tròn hay kẹp giá
 * trị vào `[0°, 360°)`: canonicalize là việc của engine, làm ở đây sẽ tạo nguồn chân lý thứ hai.
 */

import type { PartRotationConstraint, RotationMode } from './types';

/**
 * Đọc danh sách số từ chuỗi người dùng gõ. Nhận dấu phẩy, chấm phẩy hoặc khoảng trắng.
 *
 * Giá trị `Number.parseFloat` được giữ **nguyên**; chỉ loại phần tử không hữu hạn.
 */
export function parseAngleList(raw: string): number[] {
  return raw
    .split(/[,;\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => Number.parseFloat(token))
    .filter((value) => Number.isFinite(value));
}

/** In lại danh sách góc. Dùng `String()` vì `toFixed` sẽ cắt chữ số của `double`. */
export function formatAngleList(values: readonly number[]): string {
  return values.map((value) => String(value)).join(', ');
}

/**
 * Đổi mode mà giữ lại thông tin dùng được, để người dùng không phải gõ lại.
 *
 * Khi không có gì để giữ, mặc định của `discrete` là **hai** góc `0/180`, cố ý KHÔNG phải
 * bốn góc cardinal: gợi ý bốn góc như mặc định sẽ đẩy người dùng về đúng cái sàn an toàn
 * mà tính năng này tồn tại để vượt qua.
 */
export function switchRotationMode(
  current: PartRotationConstraint,
  mode: RotationMode,
): PartRotationConstraint {
  if (mode === current.mode) return current;
  switch (mode) {
    case 'inherit':
      return { mode: 'inherit' };
    case 'free':
      return { mode: 'free' };
    case 'fixed': {
      const seed =
        current.mode === 'discrete' && current.anglesDeg.length > 0
          ? current.anglesDeg[0]
          : current.mode === 'ranges' && current.arcs.length > 0
            ? current.arcs[0].startDeg
            : 0;
      return { mode: 'fixed', angleDeg: seed };
    }
    case 'discrete': {
      if (current.mode === 'fixed') return { mode: 'discrete', anglesDeg: [current.angleDeg] };
      if (current.mode === 'ranges' && current.arcs.length > 0) {
        return { mode: 'discrete', anglesDeg: current.arcs.map((arc) => arc.startDeg) };
      }
      return { mode: 'discrete', anglesDeg: [0, 180] };
    }
    case 'ranges': {
      if (current.mode === 'fixed') {
        return { mode: 'ranges', arcs: [{ startDeg: current.angleDeg, sweepDeg: 10 }] };
      }
      if (current.mode === 'discrete' && current.anglesDeg.length > 0) {
        return {
          mode: 'ranges',
          arcs: current.anglesDeg.map((angle) => ({ startDeg: angle, sweepDeg: 10 })),
        };
      }
      return { mode: 'ranges', arcs: [{ startDeg: 0, sweepDeg: 45 }] };
    }
    default:
      return current;
  }
}

/** Nhãn tiếng Việt cho từng mode. `inherit` nói rõ nó kế thừa gì để không ai phải đoán. */
export const ROTATION_MODE_LABEL: Record<RotationMode, string> = {
  inherit: 'Theo cài đặt chung',
  free: 'Tự do (0°–360°)',
  fixed: 'Khóa một góc',
  discrete: 'Danh sách góc',
  ranges: 'Khoảng góc',
};

/** Thứ tự hiển thị: hai lựa chọn rộng nhất lên trước. */
export const ROTATION_MODE_ORDER: readonly RotationMode[] = [
  'inherit',
  'free',
  'fixed',
  'discrete',
  'ranges',
] as const;
