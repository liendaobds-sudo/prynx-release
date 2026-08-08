// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  appearanceTierForTotalMemory,
  applyAppearancePerformanceTier,
  refineAppearanceForHardware,
} from './appearanceBootstrap';

const GIB = 1024 ** 3;

describe('appearance performance tier', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('perf-low', 'perf-mid');
  });

  it('chia đúng các biên RAM <8, 8–15 và >=16 GB', () => {
    expect(appearanceTierForTotalMemory(4 * GIB)).toBe('low');
    expect(appearanceTierForTotalMemory(8 * GIB - 1)).toBe('low');
    expect(appearanceTierForTotalMemory(8 * GIB)).toBe('mid');
    expect(appearanceTierForTotalMemory(15 * GIB)).toBe('mid');
    expect(appearanceTierForTotalMemory(16 * GIB - 1)).toBe('mid');
    expect(appearanceTierForTotalMemory(16 * GIB)).toBe('full');
    expect(appearanceTierForTotalMemory(32 * GIB)).toBe('full');
    expect(appearanceTierForTotalMemory(0)).toBeNull();
  });

  it('xóa tier cũ trước khi áp tier mới và máy mạnh giữ full', () => {
    const root = document.documentElement;
    applyAppearancePerformanceTier(root, 'low');
    expect(root.classList.contains('perf-low')).toBe(true);

    applyAppearancePerformanceTier(root, 'mid');
    expect(root.classList.contains('perf-low')).toBe(false);
    expect(root.classList.contains('perf-mid')).toBe(true);

    applyAppearancePerformanceTier(root, 'full');
    expect(root.classList.contains('perf-low')).toBe(false);
    expect(root.classList.contains('perf-mid')).toBe(false);
  });

  it('dùng RAM native thật để hiệu chỉnh heuristic', async () => {
    const root = document.documentElement;
    root.classList.add('perf-low');
    const invokeCommand = vi.fn(async () => ({ installedBytes: 32 * GIB, totalBytes: 31 * GIB }));

    await refineAppearanceForHardware(invokeCommand, root);

    expect(invokeCommand).toHaveBeenCalledWith('get_system_memory_status');
    expect(root.classList.contains('perf-low')).toBe(false);
    expect(root.classList.contains('perf-mid')).toBe(false);
  });

  it('IPC lỗi thì giữ nguyên heuristic hiện tại', async () => {
    const root = document.documentElement;
    root.classList.add('perf-low');

    await refineAppearanceForHardware(vi.fn(async () => { throw new Error('IPC unavailable'); }), root);

    expect(root.classList.contains('perf-low')).toBe(true);
  });
});
