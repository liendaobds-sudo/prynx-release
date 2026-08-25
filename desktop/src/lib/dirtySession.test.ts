import { describe, expect, it } from 'vitest';

import {
  hasDirtySessions,
  isDirtySession,
  isRestoredDocumentDirty,
} from './dirtySession';

describe('hợp đồng dirty khi đóng tab', () => {
  it('không coi tab chưa có tài liệu là phiên phục hồi chưa lưu', () => {
    expect(isRestoredDocumentDirty(null, null)).toBe(false);
    expect(isRestoredDocumentDirty(undefined, undefined)).toBe(false);
  });

  it('chỉ coi dirty khi đúng tài liệu phục hồi vẫn đang mở', () => {
    const restoredFile = {};
    expect(isRestoredDocumentDirty(restoredFile, restoredFile)).toBe(true);
    expect(isRestoredDocumentDirty({}, restoredFile)).toBe(false);
  });

  it('giữ nguyên hợp đồng đóng tab và đóng ứng dụng hiện có', () => {
    expect(isDirtySession({ isDirty: true })).toBe(true);
    expect(isDirtySession({ isDirty: false })).toBe(false);
    expect(hasDirtySessions([{ isDirty: false }, { isDirty: true }])).toBe(true);
  });
});
