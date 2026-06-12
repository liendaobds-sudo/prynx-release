import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface RecentFile {
  path: string;
  name: string;
  size: number;
  timestamp: number;
  isStarred: boolean;
}

interface RecentFilesState {
  files: RecentFile[];
  addFile: (file: { path: string; name: string; size: number }) => void;
  removeFile: (path: string) => void;
  removeFiles: (paths: string[]) => void;
  toggleStar: (path: string) => void;
  clearUnstarred: () => void;
}

const MAX_RECENT_FILES = 50;

export const useRecentFiles = create<RecentFilesState>()(
  persist(
    (set) => ({
      files: [],
      
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
        
        return { files: updatedFiles };
      }),
      
      removeFile: (path) => set((state) => ({
        files: state.files.filter(f => f.path !== path)
      })),
      
      removeFiles: (paths) => set((state) => ({
        files: state.files.filter(f => !paths.includes(f.path))
      })),
      
      toggleStar: (path) => set((state) => ({
        files: state.files.map(f => 
          f.path === path ? { ...f, isStarred: !f.isStarred } : f
        )
      })),
      
      clearUnstarred: () => set((state) => ({
        files: state.files.filter(f => f.isStarred)
      }))
    }),
    {
      name: 'prynx-recent-files',
    }
  )
);
