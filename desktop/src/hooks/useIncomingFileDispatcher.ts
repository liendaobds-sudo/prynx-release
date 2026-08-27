import { useEffect, useRef, type RefObject } from 'react';
import type { AppToolId } from '../lib/toolRegistry';
import {
  planIncomingFiles,
  resolveActiveImageBatchReceiver,
  type NavigationTabLike,
} from '../lib/tabNavigation';
import { primeViewerFirstFrame } from '../lib/viewerFirstFrame';

export const SYSTEM_FILES_RECEIVED_EVENT = 'system-files-received';
export const SYSTEM_FILES_POLL_SETTLED_EVENT = 'prynx-system-files-poll-settled';
export const INCOMING_FILES_DEBOUNCE_MS = 50;
export const EXPLICIT_INTENT_FALLBACK_MS = 3_000;

interface IncomingFilesDetail {
  files?: File[];
  action?: string;
  batchId?: string;
}

interface UseIncomingFileDispatcherOptions {
  onOpenApp: (appId: AppToolId, payload?: Record<string, unknown>) => void;
  tabsRef: RefObject<readonly NavigationTabLike[]>;
  activeTabIdRef: RefObject<string>;
}

function sortIncomingFiles(files: File[]): File[] {
  return [...files].sort((a, b) => (
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  ));
}

function isPathBackedPdf(file: File): boolean {
  const nativePath = (file as File & { path?: string }).path;
  return Boolean(
    nativePath
    && (file.type === 'application/pdf' || file.name.toLocaleLowerCase().endsWith('.pdf'))
    && typeof window !== 'undefined'
    && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__),
  );
}

/**
 * PERF (audit 2026-08-26 §FILE.E1): tạo tab trước rồi mới prime frame nền.
 * Render PPE chậm không được giữ người dùng ở tab cũ; request vẫn tiếp tục
 * để Viewer có thể nhận cache nếu frame hoàn tất muộn.
 */
function dispatchIncomingFileBatchAndPrime(
  files: readonly File[],
  intent: string,
  dispatch: () => void,
): void {
  dispatch();
  if (!intent && files.length === 1 && isPathBackedPdf(files[0])) {
    void primeViewerFirstFrame(files[0]).catch(() => undefined);
  }
}

/** Định tuyến một batch đã đóng; mọi cửa vào đều hội tụ tại đây. */
export function dispatchIncomingFileBatch(
  files: readonly File[],
  intent: string,
  onOpenApp: UseIncomingFileDispatcherOptions['onOpenApp'],
  tabs: readonly NavigationTabLike[],
  activeTabId: string,
): void {
  if (files.length === 0) return;
  const sortedFiles = sortIncomingFiles([...files]);
  const incomingPlan = planIncomingFiles(sortedFiles, intent);

  if (incomingPlan.mode === 'combine') {
    onOpenApp('combine_pdf', { files: incomingPlan.files });
    return;
  }

  const { pdfFiles, officeFiles, otherFiles } = incomingPlan;
  const imageBatchReceiver = resolveActiveImageBatchReceiver(tabs, activeTabId);
  // DOC-CLEANUP UIUX (feedback 2026-08-21 §DROP.01): công cụ này hỗ trợ cả
  // PDF scan lẫn ảnh. Khi chính nó đang active, giữ toàn bộ tài liệu phù hợp trong
  // đúng workspace thay vì mở PDF thành tab mới trước khi receiver có cơ hội nhận.
  // Các receiver ảnh khác vẫn chỉ nhận `otherFiles` như hợp đồng cũ.
  const documentCleanupOwnsIncoming = !intent
    && imageBatchReceiver?.feature === 'document_cleanup';
  if (documentCleanupOwnsIncoming) {
    const cleanupFileSet = new Set<File>([...pdfFiles, ...otherFiles]);
    const cleanupFiles = sortedFiles.filter(file => cleanupFileSet.has(file));
    if (cleanupFiles.length > 0) {
      window.dispatchEvent(new CustomEvent(imageBatchReceiver.eventName, {
        detail: { tabId: imageBatchReceiver.tabId, files: cleanupFiles },
      }));
    }
  } else {
    for (const pdfFile of pdfFiles) {
      onOpenApp('imposition', { file: pdfFile });
    }
  }

  if (officeFiles.length > 0) {
    onOpenApp('imposition', {
      focusFeature: 'office_convert',
      officeSourceFile: officeFiles[0],
      officeSourceFiles: officeFiles,
    });
  }

  if (documentCleanupOwnsIncoming) return;

  if (otherFiles.length === 0) return;
  if (intent === 'convert') {
    onOpenApp('combine_pdf', { files: otherFiles });
    return;
  }

  if (imageBatchReceiver) {
    window.dispatchEvent(new CustomEvent(imageBatchReceiver.eventName, {
      detail: { tabId: imageBatchReceiver.tabId, files: otherFiles },
    }));
  } else if (otherFiles.length > 1) {
    onOpenApp('combine_pdf', { files: otherFiles });
  } else {
    onOpenApp('imposition', { file: otherFiles[0] });
  }
}

/**
 * FILEIO (audit 2026-08-02 §TEST.1): gom mọi event file vào một dispatcher testable.
 * Intent Explorer chờ poll đầu tiên đóng batch để nhiều process/file không bị tách tab.
 */
export function useIncomingFileDispatcher({
  onOpenApp,
  tabsRef,
  activeTabIdRef,
}: UseIncomingFileDispatcherOptions): void {
  const onOpenAppRef = useRef(onOpenApp);
  const defaultBatchesRef = useRef<Map<string, File[]>>(new Map());
  const explicitBatchesRef = useRef<Map<string, File[]>>(new Map());
  const defaultTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const explicitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposedRef = useRef(false);

  useEffect(() => {
    onOpenAppRef.current = onOpenApp;
  }, [onOpenApp]);

  useEffect(() => {
    disposedRef.current = false;
    const clearTimer = (timerRef: { current: ReturnType<typeof setTimeout> | null }) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };

    const dispatchClosedBatch = (files: File[], action: string) => {
      dispatchIncomingFileBatchAndPrime(files, action, () => {
        if (disposedRef.current) return;
        dispatchIncomingFileBatch(
          files,
          action,
          onOpenAppRef.current,
          tabsRef.current ?? [],
          activeTabIdRef.current ?? '',
        );
      });
    };

    const flushDefault = () => {
      clearTimer(defaultTimerRef);
      const batches = Array.from(defaultBatchesRef.current.values());
      defaultBatchesRef.current.clear();
      for (const files of batches) dispatchClosedBatch(files, '');
    };

    const flushExplicit = () => {
      clearTimer(explicitTimerRef);
      const batches = Array.from(explicitBatchesRef.current.entries());
      explicitBatchesRef.current.clear();
      for (const [action, files] of batches) dispatchClosedBatch(files, action);
    };

    const appendBatchFiles = (batches: Map<string, File[]>, key: string, files: File[]) => {
      batches.set(key, [...(batches.get(key) ?? []), ...files]);
    };

    const scheduleDefault = () => {
      clearTimer(defaultTimerRef);
      defaultTimerRef.current = setTimeout(flushDefault, INCOMING_FILES_DEBOUNCE_MS);
    };

    const scheduleExplicitFallback = () => {
      clearTimer(explicitTimerRef);
      explicitTimerRef.current = setTimeout(flushExplicit, EXPLICIT_INTENT_FALLBACK_MS);
    };

    const handleSystemFiles = (event: Event) => {
      const detail = (event as CustomEvent<IncomingFilesDetail>).detail;
      if (!detail?.files?.length) return;

      const incomingAction = detail.action || '';
      if (incomingAction) {
        // FILEIO (audit 2026-08-26 §FILE.A2): mỗi intent có lane riêng. Nhiều
        // process do Explorer tạo cho cùng một thao tác vẫn được gom tới poll-settled.
        appendBatchFiles(explicitBatchesRef.current, incomingAction, detail.files);
        // Context-menu Explorer luôn đi qua SystemIntegrations. Fallback chỉ bảo vệ
        // event test/legacy nếu nguồn đó không phát được mốc poll-settled.
        scheduleExplicitFallback();
        return;
      }

      // Batch có identity không được nhập với drop/picker khác. Event legacy không
      // có ID vẫn giữ debounce cũ để hai lần dispatch picker/Recent sát nhau ổn định.
      const batchKey = detail.batchId || 'legacy-default';
      appendBatchFiles(defaultBatchesRef.current, batchKey, detail.files);
      scheduleDefault();
    };

    const handlePollSettled = () => {
      if (explicitBatchesRef.current.size > 0) flushExplicit();
    };

    window.addEventListener(SYSTEM_FILES_RECEIVED_EVENT, handleSystemFiles);
    window.addEventListener(SYSTEM_FILES_POLL_SETTLED_EVENT, handlePollSettled);
    return () => {
      disposedRef.current = true;
      clearTimer(defaultTimerRef);
      clearTimer(explicitTimerRef);
      defaultBatchesRef.current.clear();
      explicitBatchesRef.current.clear();
      window.removeEventListener(SYSTEM_FILES_RECEIVED_EVENT, handleSystemFiles);
      window.removeEventListener(SYSTEM_FILES_POLL_SETTLED_EVENT, handlePollSettled);
    };
  }, [activeTabIdRef, tabsRef]);
}
