import { describe, expect, it } from 'vitest';
import { warmupPlanForTotalRam, warmupRamBytesFromMemoryStatus } from './pdfWarmup';

const GIB = 1024 ** 3;

describe('warmupPlanForTotalRam', () => {
  it.each([
    [4 * GIB, { workspace: 'none', pdfium: true, pdfjs: false }],
    [8 * GIB, { workspace: 'primary', pdfium: true, pdfjs: false }],
    [15 * GIB, { workspace: 'primary', pdfium: true, pdfjs: false }],
    [16 * GIB, { workspace: 'full', pdfium: true, pdfjs: true }],
    [64 * GIB, { workspace: 'full', pdfium: true, pdfjs: true }],
  ] as const)('chọn đúng policy cho %s byte RAM', (totalBytes, expected) => {
    expect(warmupPlanForTotalRam(totalBytes)).toEqual(expected);
  });

  it.each([null, Number.NaN, -1])(
    'không giảm warm-up khi không đọc được RAM (%s)',
    totalBytes => {
      expect(warmupPlanForTotalRam(totalBytes)).toEqual({
        workspace: 'full',
        pdfium: true,
        pdfjs: true,
      });
    },
  );

  it('coi máy lắp 16 GB là full dù Windows chỉ dùng được 15.x GB', () => {
    const ramBytes = warmupRamBytesFromMemoryStatus({
      installedBytes: 16 * GIB,
      totalBytes: 15.25 * GIB,
      availableBytes: 10 * GIB,
    });

    expect(ramBytes).toBe(16 * GIB);
    expect(warmupPlanForTotalRam(ramBytes)).toEqual({
      workspace: 'full',
      pdfium: true,
      pdfjs: true,
    });
  });

  it('coi máy lắp 8 GB là tier trung bình dù Windows chỉ dùng được 7.x GB', () => {
    const ramBytes = warmupRamBytesFromMemoryStatus({
      installed_bytes: 8 * GIB,
      total_bytes: 7.5 * GIB,
      available_bytes: 5 * GIB,
    });

    expect(ramBytes).toBe(8 * GIB);
    expect(warmupPlanForTotalRam(ramBytes)).toEqual({
      workspace: 'primary',
      pdfium: true,
      pdfjs: false,
    });
  });

  it('fallback về totalBytes cho payload cũ hoặc installedBytes không hợp lệ', () => {
    expect(warmupRamBytesFromMemoryStatus({ totalBytes: 12 * GIB })).toBe(12 * GIB);
    expect(warmupRamBytesFromMemoryStatus({
      installedBytes: 8 * GIB,
      totalBytes: 16 * GIB,
    })).toBe(16 * GIB);
    expect(warmupRamBytesFromMemoryStatus(null)).toBeNull();
  });
});
