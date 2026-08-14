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
 * PERF (audit 2026-08-14 §VIEW.FIRST.2): pre-render trước khi App tạo tab. Nhờ vậy
 * tab hiện tại vẫn giữ nguyên trong lúc PPE dựng trang 1; khi chuyển tab, pixel thật
 * đã nằm trong cache/first-frame và không cần hiển thị màn "Đang mở file".
 */
function dispatchIncomingFileBatchWhenReady(
  files: readonly File[],
  intent: string,
  dispatch: () => void,
): void {
  if (!intent && files.length === 1 && isPathBackedPdf(files[0])) {
    void primeViewerFirstFrame(files[0]).then(dispatch, dispatch);
    return;
  }
  dispatch();
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
  for (const pdfFile of pdfFiles) {
    onOpenApp('imposition', { file: pdfFile });
  }

  if (officeFiles.length > 0) {
    onOpenApp('imposition', {
      focusFeature: 'office_convert',
      officeSourceFile: officeFiles[0],
      officeSourceFiles: officeFiles,
    });
  }

  if (otherFiles.length === 0) return;
  if (intent === 'convert') {
    onOpenApp('combine_pdf', { files: otherFiles });
    return;
  }

  const imageBatchReceiver = resolveActiveImageBatchReceiver(tabs, activeTabId);
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
  const filesRef = useRef<File[]>([]);
  const actionRef = useRef('');
  const waitingForPollRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposedRef = useRef(false);

  useEffect(() => {
    onOpenAppRef.current = onOpenApp;
  }, [onOpenApp]);

  useEffect(() => {
    disposedRef.current = false;
    const clearTimer = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };

    const flush = () => {
      clearTimer();
      const files = filesRef.current;
      const action = actionRef.current;
      filesRef.current = [];
      actionRef.current = '';
      waitingForPollRef.current = false;
      dispatchIncomingFileBatchWhenReady(files, action, () => {
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

    const scheduleFallback = (delayMs: number) => {
      clearTimer();
      timerRef.current = setTimeout(flush, delayMs);
    };

    const handleSystemFiles = (event: Event) => {
      const detail = (event as CustomEvent<IncomingFilesDetail>).detail;
      if (!detail?.files?.length) return;

      const incomingAction = detail.action || '';
      if (incomingAction && actionRef.current && actionRef.current !== incomingAction) {
        flush();
      }

      filesRef.current = [...filesRef.current, ...detail.files];
      if (incomingAction) actionRef.current = incomingAction;

      if (actionRef.current) {
        // Context-menu Explorer luôn đi qua SystemIntegrations. Fallback chỉ bảo vệ
        // event test/legacy nếu nguồn đó không phát được mốc poll-settled.
        waitingForPollRef.current = true;
        scheduleFallback(EXPLICIT_INTENT_FALLBACK_MS);
      } else {
        scheduleFallback(INCOMING_FILES_DEBOUNCE_MS);
      }
    };

    const handlePollSettled = () => {
      if (waitingForPollRef.current && filesRef.current.length > 0) flush();
    };

    window.addEventListener(SYSTEM_FILES_RECEIVED_EVENT, handleSystemFiles);
    window.addEventListener(SYSTEM_FILES_POLL_SETTLED_EVENT, handlePollSettled);
    return () => {
      disposedRef.current = true;
      clearTimer();
      filesRef.current = [];
      actionRef.current = '';
      waitingForPollRef.current = false;
      window.removeEventListener(SYSTEM_FILES_RECEIVED_EVENT, handleSystemFiles);
      window.removeEventListener(SYSTEM_FILES_POLL_SETTLED_EVENT, handlePollSettled);
    };
  }, [activeTabIdRef, tabsRef]);
}
