// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addOpenPayloadToRecent, useRecentFiles } from './useRecentFiles';

describe('useRecentFiles — Khả năng chống chịu QuotaExceededError và persist an toàn', () => {
  const originalSetItem = window.localStorage.setItem;

  beforeEach(() => {
    localStorage.clear();
    useRecentFiles.setState({ files: [], missingPaths: [] });
  });

  afterEach(() => {
    window.localStorage.setItem = originalSetItem;
    vi.restoreAllMocks();
  });

  it('không crash khi localStorage.setItem ném QuotaExceededError', () => {
    // Giả lập localStorage đầy quota 5MB
    const quotaError = new DOMException(
      "Failed to execute 'setItem' on 'Storage': Setting the value of 'prynx-recent-files' exceeded the quota.",
      'QuotaExceededError'
    );
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw quotaError;
    });

    const file = new File([], 'tai_lieu_quan_trong.pdf');
    Object.defineProperty(file, 'path', { value: 'D:/tai_lieu_quan_trong.pdf' });

    // addOpenPayloadToRecent và addFile không được ném unhandled error
    expect(() => {
      const added = addOpenPayloadToRecent({ file });
      expect(added).toBe(1);
    }).not.toThrow();

    // State in-memory vẫn được cập nhật bình thường
    expect(useRecentFiles.getState().files.length).toBe(1);
    expect(useRecentFiles.getState().files[0].name).toBe('tai_lieu_quan_trong.pdf');
  });

  it('tự động dọn dẹp các key scoped imposer cũ khi gặp QuotaExceededError', async () => {
    // Giả lập có 3 key scoped imposer mồ côi chiếm chỗ
    localStorage.setItem('ps_imposer_settings:tab-old-1', 'x'.repeat(100));
    localStorage.setItem('ps_imposer_settings:tab-old-2', 'x'.repeat(100));
    localStorage.setItem('ps_imposer_settings:tab-old-3', 'x'.repeat(100));
    localStorage.setItem('ps_custom_marks_config', 'keep-me');

    let threwOnce = false;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, val) => {
      if (key === 'prynx-recent-files' && !threwOnce) {
        threwOnce = true;
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }
      originalSetItem.call(localStorage, key, val);
    });

    useRecentFiles.getState().addFile({
      path: 'D:/test.pdf',
      name: 'test.pdf',
      size: 1024,
    });

    // Chờ queue async flush hoàn tất
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Các key scoped imposer mồ côi đã được dọn sạch để giải phóng quota
    expect(localStorage.getItem('ps_imposer_settings:tab-old-1')).toBeNull();
    expect(localStorage.getItem('ps_imposer_settings:tab-old-2')).toBeNull();
    expect(localStorage.getItem('ps_imposer_settings:tab-old-3')).toBeNull();
    // Key của tính năng khác vẫn giữ nguyên
    expect(localStorage.getItem('ps_custom_marks_config')).toBe('keep-me');
  });

  it('không văng lỗi khi markMissing hoặc clearMissing được gọi', () => {
    const quotaError = new DOMException('Quota exceeded', 'QuotaExceededError');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw quotaError;
    });

    expect(() => {
      useRecentFiles.getState().markMissing('D:/file-khong-ton-tai.pdf');
      useRecentFiles.getState().clearMissing('D:/file-khong-ton-tai.pdf');
    }).not.toThrow();
  });
});
