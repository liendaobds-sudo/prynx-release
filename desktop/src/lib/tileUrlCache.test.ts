import { describe, expect, it, vi } from 'vitest';

import {
  TileUrlLruCache,
  tileUrlCacheBudgetForTotalRam,
  tileUrlCacheNamespaceForFileKey,
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

  it('mở tab B không dọn tile của tab A còn owner', () => {
    const revoke = vi.fn();
    const cache = new TileUrlLruCache(null, revoke);
    cache.claimOwner('owner-a', 'file-a');
    cache.set('a-display', 'blob:a', 4, 'file-a');
    cache.set('orphan', 'blob:orphan', 3, 'file-old');

    cache.claimOwner('owner-b', 'file-b');
    cache.clearUnowned();

    expect(cache.get('a-display')).toBe('blob:a');
    expect(cache.get('orphan')).toBeUndefined();
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:orphan');
  });

  it('hai tab cùng tài liệu chỉ dọn cache khi owner cuối cùng rời đi', () => {
    const revoke = vi.fn();
    const cache = new TileUrlLruCache(null, revoke);
    cache.claimOwner('owner-a', 'shared-file');
    cache.claimOwner('owner-b', 'shared-file');
    cache.set('shared-display', 'blob:shared', 5, 'shared-file');

    cache.releaseOwner('owner-a');
    expect(cache.get('shared-display')).toBe('blob:shared');
    expect(revoke).not.toHaveBeenCalled();

    cache.releaseOwner('owner-b');
    expect(cache.get('shared-display')).toBeUndefined();
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:shared');
  });

  it('display/accurate dùng chung namespace và clear đúng file có marker màu', () => {
    expect(tileUrlCacheNamespaceForFileKey('localfile://job|color:display')).toBe('localfile://job');
    expect(tileUrlCacheNamespaceForFileKey('localfile://job|color:accurate')).toBe('localfile://job');
    expect(tileUrlCacheNamespaceForFileKey(
      'localfile://job|revision:100:200:300|color:accurate',
    )).toBe('localfile://job');

    const revoke = vi.fn();
    const cache = new TileUrlLruCache(null, revoke);
    cache.set('display-key', 'blob:display', 4, 'localfile://job');
    cache.set('accurate-key', 'blob:accurate', 4, 'localfile://job');
    cache.set('other-key', 'blob:other', 4, 'localfile://other');
    cache.clearNamespace('localfile://job');

    expect(cache.get('display-key')).toBeUndefined();
    expect(cache.get('accurate-key')).toBeUndefined();
    expect(cache.get('other-key')).toBe('blob:other');
  });

  it('owner claim source giữ cache revision qua clearUnowned và dọn khi release', () => {
    const revoke = vi.fn();
    const cache = new TileUrlLruCache(null, revoke);
    const source = 'localfile://revision-owner';
    const revisionFileKey = `${source}|revision:100:200:300|color:display`;
    const namespace = tileUrlCacheNamespaceForFileKey(revisionFileKey);

    cache.claimOwner('owner-a', source);
    cache.set('revision-display', 'blob:revision', 5, namespace);
    cache.clearUnowned();

    expect(cache.get('revision-display')).toBe('blob:revision');
    expect(revoke).not.toHaveBeenCalled();

    cache.releaseOwner('owner-a');
    expect(cache.get('revision-display')).toBeUndefined();
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:revision');
  });
});
