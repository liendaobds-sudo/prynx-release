// @vitest-environment jsdom

import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const systemMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: systemMocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: systemMocks.listen }));
vi.mock('../components/ui/Toast', () => ({
  toast: { error: vi.fn() },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
import { dispatchSupportedSystemFiles } from '../lib/nativeFileAccess';
import {
  registerActiveTabFeature,
  type NavigationTabLike,
} from '../lib/tabNavigation';
import SystemIntegrations from '../components/SystemIntegrations';
import {
  EXPLICIT_INTENT_FALLBACK_MS,
  INCOMING_FILES_DEBOUNCE_MS,
  SYSTEM_FILES_POLL_SETTLED_EVENT,
  SYSTEM_FILES_RECEIVED_EVENT,
  useIncomingFileDispatcher,
} from './useIncomingFileDispatcher';

function file(name: string): File {
  return new File(['fixture'], name);
}

const OFFICE_EXTENSION_ORACLE = [
  'doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'csv', 'ppt', 'pptx', 'odp',
] as const;
const IMAGE_EXTENSION_ORACLE = [
  'png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff',
] as const;
function emitFiles(files: File[], action = ''): void {
  window.dispatchEvent(new CustomEvent(SYSTEM_FILES_RECEIVED_EVENT, {
    detail: { files, action },
  }));
}

describe('useIncomingFileDispatcher', () => {
  const disposers: Array<() => void> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    systemMocks.invoke.mockReset();
    systemMocks.listen.mockReset();
    systemMocks.listen.mockResolvedValue(() => undefined);
  });

  afterEach(() => {
    while (disposers.length > 0) disposers.pop()?.();
    cleanup();
    vi.useRealTimers();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  function renderDispatcher(
    activeTabId = 'home',
    tabs: NavigationTabLike[] = [
      { id: 'home', type: 'home' },
      { id: 'pdf', type: 'imposition', payload: { file: 'working.pdf' } },
    ],
  ) {
    const onOpenApp = vi.fn();
    const tabsRef = { current: tabs };
    const activeTabIdRef = { current: activeTabId };
    const hook = renderHook(() => useIncomingFileDispatcher({
      onOpenApp,
      tabsRef,
      activeTabIdRef,
    }));
    return { ...hook, onOpenApp, tabsRef, activeTabIdRef };
  }

  function listenForLegacyStickerSources() {
    const listener = vi.fn();
    const handle = () => listener();
    window.addEventListener('prynx-sticker-source-files', handle);
    disposers.push(() => window.removeEventListener('prynx-sticker-source-files', handle));
    return listener;
  }

  function registerFeature(tabId: string, feature: string): void {
    disposers.push(registerActiveTabFeature(tabId, feature));
  }

  const stickerTabs: NavigationTabLike[] = [
    { id: 'home', type: 'home' },
    { id: 'pdf', type: 'imposition', payload: { file: 'working.pdf' } },
    { id: 'tem', type: 'imposition', payload: { focusFeature: 'sticker' } },
  ];

  it.each([
    ['PDF', 'mau.pdf'],
    ['ảnh', 'mau.png'],
  ])('vẫn mở một %s theo luồng tài liệu khi tab tem đang active', (_label, name) => {
    registerFeature('tem', 'sticker');
    const legacyEvent = listenForLegacyStickerSources();
    const { onOpenApp } = renderDispatcher('tem', stickerTabs);
    const source = file(name);

    act(() => emitFiles([source]));
    act(() => vi.advanceTimersByTime(INCOMING_FILES_DEBOUNCE_MS));

    expect(legacyEvent).not.toHaveBeenCalled();
    expect(onOpenApp).toHaveBeenCalledWith('imposition', { file: source });
  });

  it('giữ hành vi batch nhiều file khi tab tem đang active', () => {
    registerFeature('tem', 'sticker');
    const { onOpenApp } = renderDispatcher('tem', stickerTabs);
    const first = file('01.png');
    const second = file('02.jpg');

    act(() => emitFiles([first, second]));
    act(() => vi.advanceTimersByTime(INCOMING_FILES_DEBOUNCE_MS));

    expect(onOpenApp).toHaveBeenCalledWith('combine_pdf', { files: [first, second] });
  });

  it.each([
    ['combine', 'mau.pdf'],
    ['convert', 'mau.png'],
  ])('giữ nguyên intent %s thay vì chuyển vào nguồn tem', (intent, name) => {
    registerFeature('tem', 'sticker');
    const { onOpenApp } = renderDispatcher('tem', stickerTabs);
    const source = file(name);

    act(() => emitFiles([source], intent));
    act(() => window.dispatchEvent(new Event(SYSTEM_FILES_POLL_SETTLED_EVENT)));

    expect(onOpenApp).toHaveBeenCalledWith('combine_pdf', { files: [source] });
  });

  it('giữ nguyên hành vi Convert đối với một PDF', () => {
    registerFeature('tem', 'sticker');
    const { onOpenApp } = renderDispatcher('tem', stickerTabs);
    const source = file('mau.pdf');

    act(() => emitFiles([source], 'convert'));
    act(() => window.dispatchEvent(new Event(SYSTEM_FILES_POLL_SETTLED_EVENT)));

    expect(onOpenApp).toHaveBeenCalledWith('imposition', { file: source });
  });

  it('đường picker/Recent dùng event chung và vẫn debounce batch mặc định', () => {
    const { onOpenApp } = renderDispatcher();
    const first = file('10-ruot.pdf');
    const second = file('2-bia.pdf');

    act(() => {
      dispatchSupportedSystemFiles([first]);
      vi.advanceTimersByTime(INCOMING_FILES_DEBOUNCE_MS - 1);
      dispatchSupportedSystemFiles([second]);
      vi.advanceTimersByTime(INCOMING_FILES_DEBOUNCE_MS);
    });

    expect(onOpenApp).toHaveBeenCalledTimes(2);
    expect(onOpenApp.mock.calls.map(([, payload]) => payload.file.name)).toEqual([
      '2-bia.pdf',
      '10-ruot.pdf',
    ]);
  });

  it('giữ Combine cold-start qua poll đầu và chỉ mở một tab với đủ file', () => {
    const { onOpenApp } = renderDispatcher();
    const first = file('01-bia.pdf');
    const second = file('02-ruot.pdf');

    act(() => emitFiles([first], 'combine'));
    act(() => vi.advanceTimersByTime(1_000));
    expect(onOpenApp).not.toHaveBeenCalled();

    act(() => emitFiles([second], 'combine'));
    expect(onOpenApp).not.toHaveBeenCalled();

    act(() => window.dispatchEvent(new Event(SYSTEM_FILES_POLL_SETTLED_EVENT)));
    expect(onOpenApp).toHaveBeenCalledTimes(1);
    expect(onOpenApp).toHaveBeenCalledWith('combine_pdf', { files: [first, second] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('giữ Convert cold-start qua poll và không lẫn PDF vào nhánh ảnh', () => {
    const { onOpenApp } = renderDispatcher();
    const imageOne = file('01-anh.jpg');
    const imageTwo = file('02-anh.png');

    act(() => emitFiles([imageOne], 'convert'));
    act(() => emitFiles([imageTwo], 'convert'));
    act(() => window.dispatchEvent(new Event(SYSTEM_FILES_POLL_SETTLED_EVENT)));

    expect(onOpenApp).toHaveBeenCalledTimes(1);
    expect(onOpenApp).toHaveBeenCalledWith('combine_pdf', {
      files: [imageOne, imageTwo],
    });
  });

  it('fallback vẫn kết thúc explicit intent nếu nguồn legacy không phát poll-settled', () => {
    const { onOpenApp } = renderDispatcher();
    const image = file('anh.jpeg');

    act(() => emitFiles([image], 'convert'));
    act(() => vi.advanceTimersByTime(EXPLICIT_INTENT_FALLBACK_MS));

    expect(onOpenApp).toHaveBeenCalledWith('combine_pdf', { files: [image] });
  });

  it('gom startup và pending process thật qua poll trước khi mở tab Combine', async () => {
    let pendingCalls = 0;
    systemMocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_startup_args') {
        return ['pdf-inspector.exe', '--prynx-action=combine', 'D:\\viec\\01-bia.pdf'];
      }
      if (command === 'get_pending_system_files') {
        pendingCalls += 1;
        return pendingCalls === 1
          ? ['pdf-inspector.exe', '--prynx-action=combine', 'D:\\viec\\02-ruot.pdf']
          : [];
      }
      if (command === 'stat_system_file') return { status: 'available', size: 123 };
      return null;
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });

    const { onOpenApp } = renderDispatcher();
    render(<SystemIntegrations />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onOpenApp).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(onOpenApp).toHaveBeenCalledTimes(1);
    const [appId, payload] = onOpenApp.mock.calls[0];
    expect(appId).toBe('combine_pdf');
    expect(payload.files.map((item: File) => item.name)).toEqual([
      '01-bia.pdf',
      '02-ruot.pdf',
    ]);
  });
  it('định tuyến oracle đủ PDF, 7 ảnh và 11 Office kể cả đuôi viết hoa', () => {
    const { onOpenApp } = renderDispatcher();
    const pdf = file('mẫu.PDF');
    const officeFiles = OFFICE_EXTENSION_ORACLE.map(extension => file(`office.${extension.toUpperCase()}`));
    const imageFiles = IMAGE_EXTENSION_ORACLE.map(extension => file(`image.${extension.toUpperCase()}`));
    let accepted = 0;

    act(() => {
      accepted = dispatchSupportedSystemFiles([
        pdf,
        ...officeFiles,
        ...imageFiles,
        file('khong-ho-tro.gif'),
      ]);
      vi.advanceTimersByTime(INCOMING_FILES_DEBOUNCE_MS);
    });

    expect(accepted).toBe(19);
    expect(onOpenApp).toHaveBeenCalledTimes(3);
    expect(onOpenApp).toHaveBeenCalledWith('imposition', { file: pdf });
    const officeCall = onOpenApp.mock.calls.find(([, payload]) => payload?.focusFeature === 'office_convert');
    expect(officeCall?.[1].officeSourceFiles.map((item: File) => item.name).sort()).toEqual(
      officeFiles.map(item => item.name).sort(),
    );
    const combineCall = onOpenApp.mock.calls.find(([appId]) => appId === 'combine_pdf');
    expect(combineCall?.[1].files.map((item: File) => item.name).sort()).toEqual(
      imageFiles.map(item => item.name).sort(),
    );
  });

  it('một ảnh TIFF mặc định đi thẳng viewer thay vì tab Combine rỗng', () => {
    const { onOpenApp } = renderDispatcher();
    const image = file('scan.TIFF');

    act(() => emitFiles([image]));
    act(() => vi.advanceTimersByTime(INCOMING_FILES_DEBOUNCE_MS));

    expect(onOpenApp).toHaveBeenCalledWith('imposition', { file: image });
  });

  it('gửi cả PDF và ảnh vào đúng Document Cleanup đang active', () => {
    const tabs: NavigationTabLike[] = [
      { id: 'home', type: 'home' },
      { id: 'cleanup', type: 'imposition', payload: { file: 'working.pdf' } },
    ];
    registerFeature('cleanup', 'document_cleanup');
    const received = vi.fn();
    const receiveCleanupFiles = (event: Event) => received((event as CustomEvent).detail);
    window.addEventListener('prynx-document-cleanup-add-files', receiveCleanupFiles);
    disposers.push(() => window.removeEventListener('prynx-document-cleanup-add-files', receiveCleanupFiles));
    const { onOpenApp } = renderDispatcher('cleanup', tabs);
    const pdf = file('01-scan.pdf');
    const image = file('02-mat-the.png');

    act(() => emitFiles([image, pdf]));
    act(() => vi.advanceTimersByTime(INCOMING_FILES_DEBOUNCE_MS));

    expect(received).toHaveBeenCalledTimes(1);
    expect(received).toHaveBeenCalledWith({
      tabId: 'cleanup',
      files: [pdf, image],
    });
    expect(onOpenApp).not.toHaveBeenCalled();
  });

  it('receiver ảnh khác vẫn không hút PDF khỏi luồng tài liệu mặc định', () => {
    const tabs: NavigationTabLike[] = [
      { id: 'home', type: 'home' },
      { id: 'upscale', type: 'imposition', payload: { file: 'working.pdf' } },
    ];
    registerFeature('upscale', 'upscale');
    const received = vi.fn();
    const receiveUpscaleFiles = (event: Event) => received((event as CustomEvent).detail);
    window.addEventListener('prynx-upscale-add-files', receiveUpscaleFiles);
    disposers.push(() => window.removeEventListener('prynx-upscale-add-files', receiveUpscaleFiles));
    const { onOpenApp } = renderDispatcher('upscale', tabs);
    const pdf = file('01-scan.pdf');
    const image = file('02-anh.png');

    act(() => emitFiles([image, pdf]));
    act(() => vi.advanceTimersByTime(INCOMING_FILES_DEBOUNCE_MS));

    expect(onOpenApp).toHaveBeenCalledTimes(1);
    expect(onOpenApp).toHaveBeenCalledWith('imposition', { file: pdf });
    expect(received).toHaveBeenCalledTimes(1);
    expect(received).toHaveBeenCalledWith({
      tabId: 'upscale',
      files: [image],
    });
  });

  it('phân PDF thành tab riêng và gom đủ Office trong cùng batch', () => {
    const { onOpenApp } = renderDispatcher();
    const pdf = file('mau.pdf');
    const docx = file('hop-dong.docx');
    const xlsx = file('so-luong.xlsx');

    act(() => emitFiles([xlsx, pdf, docx]));
    act(() => vi.advanceTimersByTime(INCOMING_FILES_DEBOUNCE_MS));

    expect(onOpenApp).toHaveBeenNthCalledWith(1, 'imposition', { file: pdf });
    expect(onOpenApp).toHaveBeenNthCalledWith(2, 'imposition', {
      focusFeature: 'office_convert',
      officeSourceFile: docx,
      officeSourceFiles: [docx, xlsx],
    });
  });
});
