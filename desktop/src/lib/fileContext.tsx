/**
 * FileContext — Quản lý vòng đời file tập trung
 * 
 * Mục đích: Tập trung quản lý tất cả Blob URLs và file references
 * tại 1 nơi duy nhất. Khi đóng tab → tự động cleanup tất cả blob URLs
 * thuộc tab đó, ngăn memory leak.
 */

import React, { useCallback, useRef } from 'react';
import { FileContext, type FileContextAPI, type ManagedFile } from './fileContextCore';

// ─── Provider ───

export function FileProvider({ children }: { children: React.ReactNode }) {
  const filesRef = useRef<Map<string, ManagedFile>>(new Map());
  const blobUrlsRef = useRef<Map<string, string>>(new Map()); // blobUrl → tabId

  const generateId = () => Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 6);

  const registerBlobUrl = useCallback((tabId: string, blobUrl: string, name?: string, size?: number): string => {
    const id = generateId();
    const managed: ManagedFile = {
      id,
      name: name || 'unknown',
      blobUrl,
      size: size || 0,
      tabId,
      createdAt: Date.now(),
    };
    filesRef.current.set(id, managed);
    blobUrlsRef.current.set(blobUrl, tabId);
    return id;
  }, []);

  const registerFile = useCallback((tabId: string, file: File): ManagedFile => {
    const blobUrl = URL.createObjectURL(file);
    const id = generateId();
    const managed: ManagedFile = {
      id,
      name: file.name,
      blobUrl,
      size: file.size,
      tabId,
      createdAt: Date.now(),
    };
    filesRef.current.set(id, managed);
    blobUrlsRef.current.set(blobUrl, tabId);
    return managed;
  }, []);

  const getFilesForTab = useCallback((tabId: string): ManagedFile[] => {
    return Array.from(filesRef.current.values()).filter(f => f.tabId === tabId);
  }, []);

  const releaseTab = useCallback((tabId: string) => {
    const toRemove: string[] = [];
    for (const [id, file] of filesRef.current.entries()) {
      if (file.tabId === tabId) {
        try {
          URL.revokeObjectURL(file.blobUrl);
        } catch {
          // URL đã được giải phóng hoặc không còn hợp lệ.
        }
        blobUrlsRef.current.delete(file.blobUrl);
        toRemove.push(id);
      }
    }
    for (const id of toRemove) {
      filesRef.current.delete(id);
    }
    if (toRemove.length > 0) {
      // Removed debug log
    }
  }, []);

  const releaseBlobUrl = useCallback((blobUrl: string) => {
    try {
      URL.revokeObjectURL(blobUrl);
    } catch {
      // URL đã được giải phóng hoặc không còn hợp lệ.
    }
    blobUrlsRef.current.delete(blobUrl);
    // Remove from files map
    for (const [id, file] of filesRef.current.entries()) {
      if (file.blobUrl === blobUrl) {
        filesRef.current.delete(id);
        break;
      }
    }
  }, []);

  const releaseAll = useCallback(() => {
    for (const file of filesRef.current.values()) {
      try {
        URL.revokeObjectURL(file.blobUrl);
      } catch {
        // URL đã được giải phóng hoặc không còn hợp lệ.
      }
    }
    const count = filesRef.current.size;
    filesRef.current.clear();
    blobUrlsRef.current.clear();
    if (count > 0) {
      // Removed debug log
    }
  }, []);

  const getStats = useCallback(() => {
    const tabCounts: Record<string, number> = {};
    for (const file of filesRef.current.values()) {
      tabCounts[file.tabId] = (tabCounts[file.tabId] || 0) + 1;
    }
    return {
      totalFiles: filesRef.current.size,
      totalBlobUrls: blobUrlsRef.current.size,
      tabCounts,
    };
  }, []);

  const api: FileContextAPI = {
    registerBlobUrl,
    registerFile,
    getFilesForTab,
    releaseTab,
    releaseBlobUrl,
    releaseAll,
    getStats,
  };

  return (
    <FileContext.Provider value={api}>
      {children}
    </FileContext.Provider>
  );
}
