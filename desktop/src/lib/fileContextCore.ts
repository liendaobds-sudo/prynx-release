import { createContext, useContext } from 'react';

export interface ManagedFile {
  id: string;
  name: string;
  blobUrl: string;
  size: number;
  tabId: string;
  createdAt: number;
}

export interface FileContextAPI {
  /** Register a new blob URL owned by a specific tab */
  registerBlobUrl: (tabId: string, blobUrl: string, name?: string, size?: number) => string;
  /** Register a File object, creating a blob URL, owned by a specific tab */
  registerFile: (tabId: string, file: File) => ManagedFile;
  /** Get all files for a specific tab */
  getFilesForTab: (tabId: string) => ManagedFile[];
  /** Release all resources associated with a tab (call when tab closes) */
  releaseTab: (tabId: string) => void;
  /** Release a specific blob URL */
  releaseBlobUrl: (blobUrl: string) => void;
  /** Cleanup all resources (call on app shutdown) */
  releaseAll: () => void;
  /** Get stats for debugging */
  getStats: () => { totalFiles: number; totalBlobUrls: number; tabCounts: Record<string, number> };
}

export const FileContext = createContext<FileContextAPI | null>(null);

export function useFileContext(): FileContextAPI {
  const ctx = useContext(FileContext);
  if (!ctx) {
    // Trả về implementation rỗng khi hook được dùng ngoài Provider.
    return {
      registerBlobUrl: () => '',
      registerFile: (_tabId: string, file: File) => ({
        id: '', name: file.name, blobUrl: URL.createObjectURL(file),
        size: file.size, tabId: '', createdAt: Date.now(),
      }),
      getFilesForTab: () => [],
      releaseTab: () => {},
      releaseBlobUrl: () => {},
      releaseAll: () => {},
      getStats: () => ({ totalFiles: 0, totalBlobUrls: 0, tabCounts: {} }),
    };
  }
  return ctx;
}
