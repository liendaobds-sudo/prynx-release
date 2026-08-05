import { describe, expect, it, vi } from 'vitest';

import {
  TileUrlLruCache,
  tileUrlCacheBudgetForTotalRam,
} from './tileUrlCache';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

describe('frontend tile URL cache', () => {
  it('chỉ giảm ngân sách trên máy dưới 16 GB', () => {
    expect(tileUrlCacheBudgetForTotalRam(4 * GIB)).toBe(32 * MIB);
    expect(tileUrlCacheBudgetForTotalRam(8 * GIB)).toBe(64 * MIB);
    expect(tileUrlCacheBudgetForTotalRam(15 * GIB)).toBe(64 * MIB);
    expect(tileUrlCacheBudgetForTotalRam(16 * GIB)).toBeNull();
    expect(tileUrlCacheBudgetForTotalRam(64 * GIB)).toBeNull();
    expect(tileUrlCacheBudgetForTotalRam(null)).toBeNull();
  });

  it('đẩy đúng URL ít dùng nhất cho tới khi tile mới vừa ngân sách', () => {
    const revoke = vi.fn();
    const cache = new TileUrlLruCache(10, revoke);
    cache.set('a', 'blob:a', 4);
    cache.set('b', 'blob:b', 4);
    expect(cache.get('a')).toBe('blob:a');

    expect(cache.set('c', 'blob:c', 5)).toBe(true);

    expect(cache.get('a')).toBe('blob:a');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe('blob:c');
    expect(cache.currentBytes).toBe(9);
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:b');
  });

  it('không giữ tile lớn hơn budget và không revoke URL đang do caller sở hữu', () => {
    const revoke = vi.fn();
    const cache = new TileUrlLruCache(8, revoke);

    expect(cache.set('large', 'blob:large', 9)).toBe(false);

    expect(cache.get('large')).toBeUndefined();
    expect(cache.currentBytes).toBe(0);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('thay key và dọn theo file cập nhật byte, revoke đúng một lần', () => {
    const revoke = vi.fn();
    const cache = new TileUrlLruCache(null, revoke);
    cache.set('file-a_1', 'blob:old', 4);
    cache.set('file-a_1', 'blob:new', 6);
    cache.set('file-a_2', 'blob:second', 3);
    cache.set('file-b_1', 'blob:other', 5);

    expect(cache.currentBytes).toBe(14);
    cache.clearPrefix('file-a_');

    expect(cache.currentBytes).toBe(5);
    expect(cache.get('file-b_1')).toBe('blob:other');
    expect(revoke.mock.calls).toEqual([
      ['blob:old'],
      ['blob:new'],
      ['blob:second'],
    ]);
  });

  it('áp budget phát hiện muộn và thu gọn cache ngay lập tức', () => {
    const revoke = vi.fn();
    const cache = new TileUrlLruCache(null, revoke);
    cache.set('a', 'blob:a', 4);
    cache.set('b', 'blob:b', 4);
    cache.set('c', 'blob:c', 4);

    cache.setMaxBytes(8);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.currentBytes).toBe(8);
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:a');
  });
});
