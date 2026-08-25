export interface DirtySessionLike {
  isDirty?: boolean;
}

/**
 * Tab chỉ mang dirty phục hồi khi đang giữ đúng tài liệu đã được khôi phục.
 * Hai giá trị rỗng không đại diện cho cùng một tài liệu (`null === null` từng
 * làm mọi tab công cụ chưa mở file bị hỏi lưu khi đóng).
 */
export function isRestoredDocumentDirty<T extends object>(
  currentDocument: T | null | undefined,
  restoredDirtyDocument: T | null | undefined,
): boolean {
  return currentDocument != null && restoredDirtyDocument === currentDocument;
}

/** Một nguồn duy nhất cho mọi cổng đóng tab/cửa sổ. */
export function isDirtySession(session: DirtySessionLike | null | undefined): boolean {
  return session?.isDirty === true;
}

export function hasDirtySessions(sessions: readonly DirtySessionLike[]): boolean {
  return sessions.some(isDirtySession);
}
