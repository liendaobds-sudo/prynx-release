import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

export type DocumentWindowFitMode = 'width' | 'page' | 'custom' | 'smart';
export type DocumentWindowPageDisplayMode =
  | 'single_fit'
  | 'single_scroll'
  | 'two_fit'
  | 'two_scroll';

export interface DocumentWindowViewState {
  activePage: number;
  zoom: number;
  fitMode: DocumentWindowFitMode;
  pageDisplayMode: DocumentWindowPageDisplayMode;
}

export interface DocumentWindowBootstrap {
  documentSessionId: string;
  windowLabel: string;
  windowNumber: number;
  fileName: string;
  documentTitle: string;
  snapshotPath: string;
  saveAsOnly: true;
  viewState: DocumentWindowViewState;
}

export interface PreparedDocumentWindow {
  sourcePath: string;
  fileName: string;
  documentTitle: string;
  viewState: DocumentWindowViewState;
  dispose: () => Promise<void>;
}

export interface DocumentWindowTabApi {
  prepareNewWindow: () => Promise<PreparedDocumentWindow>;
}

interface DocumentWindowCreated {
  windowLabel: string;
  windowNumber: number;
}

type PathBackedFile = File & { path?: string };

function nativeRuntimeAvailable(): boolean {
  return typeof window !== 'undefined'
    && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

function newStagingNonce(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID().replaceAll('-', '').toLowerCase();
  }
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function pdfDisplayName(name: string): string {
  const trimmed = name.trim() || 'Document.pdf';
  return trimmed.toLocaleLowerCase().endsWith('.pdf') ? trimmed : `${trimmed}.pdf`;
}

/**
 * Materialize Working PDF vào `$TEMP` bằng đường disk→disk. PDF trong RAM đi qua
 * upload HTTP hiện có trước, tránh nhồi một `Vec<u8>` lớn vào JSON IPC của Tauri.
 * File staging được xóa ngay sau khi Rust đã sao chép sang snapshot riêng của child.
 */
export async function prepareDocumentWindowSource(
  workingFile: File,
  documentTitle: string,
  viewState: DocumentWindowViewState,
): Promise<PreparedDocumentWindow> {
  if (!nativeRuntimeAvailable()) {
    throw new Error('Cửa sổ mới chỉ dùng được trong ứng dụng PrynX desktop.');
  }

  let sourcePath = (workingFile as PathBackedFile).path?.trim() || '';
  if (!sourcePath) {
    const { uploadFileForNup } = await import('./api');
    sourcePath = await uploadFileForNup(workingFile);
  }
  if (!sourcePath) {
    throw new Error('Không materialize được PDF đang làm việc.');
  }

  const [{ tempDir, join }] = await Promise.all([
    import('@tauri-apps/api/path'),
  ]);
  const stagingPath = await join(
    await tempDir(),
    `prynx_print_new_window_${newStagingNonce()}.pdf`,
  );

  await invoke('copy_file_atomic', { source: sourcePath, path: stagingPath });
  let disposed = false;
  return {
    sourcePath: stagingPath,
    fileName: pdfDisplayName(workingFile.name),
    documentTitle: documentTitle.trim() || pdfDisplayName(workingFile.name),
    viewState,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      try {
        await invoke('delete_print_temp', { path: stagingPath });
      } catch {
        // File app-owned trong TEMP; native startup/cleanup hệ thống sẽ dọn nếu cần.
      }
    },
  };
}

export async function createDocumentWindow(
  documentSessionId: string,
  prepared: PreparedDocumentWindow,
): Promise<DocumentWindowCreated> {
  return invoke<DocumentWindowCreated>('create_document_window', {
    request: {
      documentSessionId,
      fileName: prepared.fileName,
      documentTitle: prepared.documentTitle,
      sourcePath: prepared.sourcePath,
      viewState: prepared.viewState,
    },
  });
}

export function isDocumentWindowLabel(label: string): boolean {
  return label.startsWith('document-');
}

export async function takeDocumentWindowBootstrap(): Promise<DocumentWindowBootstrap | null> {
  if (!nativeRuntimeAvailable()) return null;
  const label = getCurrentWindow().label;
  if (!isDocumentWindowLabel(label)) return null;
  return invoke<DocumentWindowBootstrap>('take_document_window_bootstrap');
}

export async function showDocumentWindowReady(): Promise<void> {
  await invoke('show_document_window_ready');
}

export function createDocumentWindowBootstrapFile(
  bootstrap: DocumentWindowBootstrap,
): File {
  const file = new File([], bootstrap.fileName, { type: 'application/pdf' });
  Object.defineProperty(file, 'path', { value: bootstrap.snapshotPath });
  Object.defineProperty(file, 'isTempUploadPath', { value: true, configurable: true });
  return file;
}
