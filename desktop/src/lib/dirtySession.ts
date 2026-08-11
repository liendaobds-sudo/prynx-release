export interface DirtySessionLike {
  isDirty?: boolean;
}

/** Một nguồn duy nhất cho mọi cổng đóng tab/cửa sổ. */
export function isDirtySession(session: DirtySessionLike | null | undefined): boolean {
  return session?.isDirty === true;
}

export function hasDirtySessions(sessions: readonly DirtySessionLike[]): boolean {
  return sessions.some(isDirtySession);
}
