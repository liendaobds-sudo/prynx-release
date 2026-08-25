import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  statNativeSystemFile,
  type NativeFileStatResult,
} from './nativeFileAccess';
import { isOutputFile } from './constants';

export interface RecentFile {
  path: string;
  name: string;
  size: number;
  timestamp: number;
  isStarred: boolean;
}

interface RecentFilesState {
  files: RecentFile[];
  /**
   * Đường dẫn đã xác nhận KHÔNG còn trên đĩa (stat lỗi). KHÔNG persist — mỗi lần mở
   * app kiểm lại, vì file có thể được đưa về đúng chỗ giữa hai phiên.
   *
   * UIUX (audit menu 2026-07-28 §RF.1): trước đây mỗi UI tự `stat()` riêng
   * (RecentFilesGrid, ThumbnailView, menu Mở gần đây) và không ai nhớ kết quả — cùng
   * một file mất bị stat lại nhiều lần, và chỗ này báo "Missing" thì chỗ kia vẫn hiện
   * bình thường. Nay tập trung ở đây, ai cũng đọc/ghi cùng một nguồn.
   */
  missingPaths: string[];
  addFile: (file: { path: string; name: string; size: number }) => void;
  removeFile: (path: string) => void;
  removeFiles: (paths: string[]) => void;
  toggleStar: (path: string) => void;
  clearUnstarred: () => void;
  markMissing: (path: string) => void;
  clearMissing: (path: string) => void;
}

const MAX_RECENT_FILES = 50;

export const useRecentFiles = create<RecentFilesState>()(
  persist(
    (set) => ({
      files: [],
      missingPaths: [],

      addFile: (newFile) => set((state) => {
        const existingIndex = state.files.findIndex(f => f.path === newFile.path);
        let updatedFiles = [...state.files];

        if (existingIndex >= 0) {
          // If it exists, update timestamp and keep star status, then move to top
          const existing = updatedFiles[existingIndex];
          updatedFiles.splice(existingIndex, 1);
          updatedFiles.unshift({
            ...existing,
            size: newFile.size, // update size just in case it changed
            timestamp: Date.now(),
          });
        } else {
          // Add new file at top
          updatedFiles.unshift({
            path: newFile.path,
            name: newFile.name,
            size: newFile.size,
            timestamp: Date.now(),
            isStarred: false,
          });
        }

        // Enforce max size but keep all starred files
        const unstarred = updatedFiles.filter(f => !f.isStarred);
        const starred = updatedFiles.filter(f => f.isStarred);

        if (unstarred.length > MAX_RECENT_FILES) {
          const keptUnstarred = unstarred.slice(0, MAX_RECENT_FILES);
          updatedFiles = [...starred, ...keptUnstarred].sort((a, b) => b.timestamp - a.timestamp);
        }

        // Mở lại được = file đã có mặt → bỏ cờ mất.
        return {
          files: updatedFiles,
          missingPaths: state.missingPaths.filter(p => p !== newFile.path),
        };
      }),

      removeFile: (path) => set((state) => ({
        files: state.files.filter(f => f.path !== path),
        missingPaths: state.missingPaths.filter(p => p !== path),
      })),

      removeFiles: (paths) => set((state) => ({
        files: state.files.filter(f => !paths.includes(f.path)),
        missingPaths: state.missingPaths.filter(p => !paths.includes(p)),
      })),

      toggleStar: (path) => set((state) => ({
        files: state.files.map(f =>
          f.path === path ? { ...f, isStarred: !f.isStarred } : f
        )
      })),

      clearUnstarred: () => set((state) => {
        const kept = state.files.filter(f => f.isStarred);
        const keptPaths = new Set(kept.map(f => f.path));
        return {
          files: kept,
          missingPaths: state.missingPaths.filter(p => keptPaths.has(p)),
        };
      }),

      markMissing: (path) => set((state) => (
        state.missingPaths.includes(path)
          ? state
          : { missingPaths: [...state.missingPaths, path] }
      )),

      clearMissing: (path) => set((state) => (
        state.missingPaths.includes(path)
          ? { missingPaths: state.missingPaths.filter(p => p !== path) }
          : state
      )),
    }),
    {
      name: 'prynx-recent-files',
      // CHỈ persist danh sách file. `missingPaths` là trạng thái của phiên hiện tại —
      // nếu lưu lại thì lần sau mở app file đã đưa về chỗ cũ vẫn bị đánh dấu mất.
      partialize: (state) => ({ files: state.files }) as unknown as RecentFilesState,
    }
  )
);

interface OpenPayloadWithSources {
  file?: File | null;
  officeSourceFile?: File | null;
  officeSourceFiles?: File[];
}

/** Ghi mọi file nguồn vật lý của một lần mở, gồm cả batch Office, vào Recent. */
export function addOpenPayloadToRecent(payload?: OpenPayloadWithSources | null): number {
  if (!payload) return 0;
  const candidates = [
    payload.file,
    payload.officeSourceFile,
    ...(payload.officeSourceFiles || []),
  ];
  const seenPaths = new Set<string>();
  let added = 0;

  for (const candidate of candidates) {
    if (!candidate) continue;
    const path = (candidate as File & { path?: string }).path;
    if (!path || seenPaths.has(path)) continue;
    seenPaths.add(path);
    if (
      isOutputFile(candidate.name || '')
      || (candidate as File & { isBlank?: boolean }).isBlank
      || (candidate as File & { isGenerated?: boolean }).isGenerated
    ) {
      continue;
    }
    useRecentFiles.getState().addFile({
      path,
      name: candidate.name,
      size: candidate.size || 0,
    });
    added += 1;
  }
  return added;
}
/**
 * Probe giữ nguyên trạng thái native để thumbnail không biến timeout/NAS offline
 * thành một request tile chắc chắn lỗi. Chỉ `missing` mới cập nhật cờ mất file.
 */
export async function probeRecentFile(path: string): Promise<NativeFileStatResult> {
  if (!('__TAURI_INTERNALS__' in window)) {
    return { status: 'available', size: 0 };
  }
  // FILEIO (audit 2026-08-02 §OPEN.2): plugin-fs mất scope sau restart và từ chối
  // ổ D/USB/UNC; dùng cùng contract native với Open With/Home.
  const info = await statNativeSystemFile(path);
  if (info.status === 'available') {
    useRecentFiles.getState().clearMissing(path);
    return info;
  }
  if (info.status === 'missing') {
    useRecentFiles.getState().markMissing(path);
  }
  return info;
}

/**
 * Contract cho thao tác Mở: timeout/quyền/NAS offline vẫn được thử bằng native path
 * và không bị xóa nhầm khỏi Recent; chỉ `missing` chắc chắn mới trả `null`.
 */
export async function statRecentFile(path: string): Promise<{ size: number } | null> {
  const info = await probeRecentFile(path);
  if (info.status === 'missing') return null;
  return { size: info.status === 'available' ? info.size : 0 };
}
