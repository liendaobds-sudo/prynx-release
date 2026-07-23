import { useState, useCallback, useEffect, useLayoutEffect, useRef, Suspense } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import HomeTab from './components/HomeTab';
import { ThemeToggle } from './components/ThemeToggle';
import { LanguageToggle } from './components/LanguageToggle';
import SettingsModal from './components/SettingsModal';
import NewDocumentModal from './components/NewDocumentModal';
import { createBlankPdfFile } from './lib/createBlankPdf';
import { scheduleWarmupPdfjs } from './lib/pdfWarmup';
import { appPerf } from './lib/perfMarks';
import SystemIntegrations from './components/SystemIntegrations';
import UpdateChecker from './components/UpdateChecker';
import { TOOL_REGISTRY, TOOL_CATEGORIES, getToolsByCategory, getToolUniqueKey, getTabTitle, getExistingInstance, type AppToolId } from './lib/toolRegistry';
import { isOfficePathOrName } from './lib/officeFileTypes';
import { MenuBar, type MenuDef } from './components/MenuBar';
import AboutModal, { SUPPORT } from './components/AboutModal';
import { useAppSettingsStore } from './stores/appSettingsStore';
import { useTheme } from './hooks/useTheme';
import { useRecentFiles } from './lib/useRecentFiles';
import { FileProvider, useFileContext } from './lib/fileContext';
import { isOutputFile } from './lib/constants';
import { useAuthStore } from './stores/useAuthStore';
import LoginScreen from './components/auth/LoginScreen';
import LicenseLockOverlay from './components/auth/LicenseLockOverlay';
import TrialExpiryBanner from './components/auth/TrialExpiryBanner';
import SplashScreen from './components/SplashScreen';
import { supabase } from './lib/supabase';
import { ToastViewport, toast } from './components/ui/Toast';
import { ConfirmDialogHost } from './components/ui/confirmDialog';
import { listSnapshots, clearAllSnapshots, deleteSnapshot, type RecoverySnapshot } from './lib/recovery';
import { ZoomIn, ZoomOut, Maximize, MoveHorizontal, FileText, ScrollText, Columns2, Rows2, Ruler, Moon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { tv } from './i18n';
import { canUse, featureIdForFocus, FEATURE_CATALOG } from './lib/license/features';
import { getShortcutLabel } from './lib/keyboardShortcuts';

type AppTabType = 'home' | AppToolId;

const NATIVE_PRINT_TOOL_TYPES = new Set<AppToolId>([
  'imposition', 'nup', 'diecut', 'cnc', 'preflight', 'combine_pdf', 'dieline',
  'compare_pdf',
]);

interface AppTab {
  id: string;
  type: AppTabType;
  title: string;
  isClosable: boolean;
  payload?: any;
  isDirty?: boolean;
}

// Custom Frameless Window Titlebar (OhMyShot style)
function TitleBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      data-tauri-drag-region
      className="h-10 w-full bg-[#f0f0f0] dark:bg-[#121212] flex items-center justify-between select-none z-[9999] shrink-0 transition-colors"
    >
      <div
        onPointerDown={(e) => {
          if (e.buttons === 1 || e.button === 0) {
            getCurrentWindow().startDragging();
          }
        }}
        data-tauri-drag-region
        className="flex items-center gap-2 pl-6 flex-1 h-full"
      >
        <span className="text-sm font-semibold text-slate-800 dark:text-zinc-200 tracking-wider flex items-center gap-2 pointer-events-none">
          <img 
            src="/logo.png" 
            alt="PrynX Logo" 
            className="w-5 h-5 object-contain dark:invert"
            onError={(e) => {
              (e.target as HTMLElement).outerHTML = '<span class="text-xl">📄</span>';
            }}
          />
          PrynX <span className="text-slate-500 dark:text-zinc-400 font-normal opacity-60 pointer-events-none">— by PrintSolutions.vn</span>
        </span>
      </div>

      <div className="flex h-full items-center">
        {/* GLOBAL SETTINGS AND THEME */}
        <div className="flex items-center gap-2 mr-4">
          <button
            onClick={onOpenSettings}
            className="w-[26px] h-[26px] rounded-md text-slate-500 hover:text-slate-800 hover:bg-black/5 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-white/10 flex items-center justify-center transition-colors border border-transparent hover:border-black/10 dark:hover:border-white/10"
            title={t('shell:cai_dat_he_thong_cau_hinh_api_mo_hinh')}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
          </button>
          <ThemeToggle />
          <LanguageToggle />
          <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1"></div>
        </div>

        {/* WINDOW CONTROLS */}
        <div
          className="w-12 h-full flex items-center justify-center hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer group text-slate-700 dark:text-zinc-300"
          onClick={() => {
            getCurrentWindow().minimize().catch((e: any) => toast.error("Min Error: " + (e.message || e)));
          }}
          title={t('shell:thu_nho')}
          role="button"
          aria-label={t('shell:thu_nho_cua_so')}
        >
          <svg width="10" height="1" viewBox="0 0 10 1" fill="none" className="opacity-50 group-hover:opacity-100 transition-opacity pointer-events-none">
            <rect width="10" height="1" fill="currentColor" />
          </svg>
        </div>
        <div
          className="w-12 h-full flex items-center justify-center hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer group text-slate-700 dark:text-zinc-300"
          onClick={() => {
            getCurrentWindow().toggleMaximize().catch((e: any) => toast.error("Max Error: " + (e.message || e)));
          }}
          title={t('shell:phong_to')}
          role="button"
          aria-label={t('shell:phong_to_cua_so')}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="opacity-50 group-hover:opacity-100 transition-opacity pointer-events-none">
            <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" />
          </svg>
        </div>
        <div
          className="w-12 h-full flex items-center justify-center hover:bg-red-500 text-slate-700 dark:text-zinc-300 hover:text-white transition-colors cursor-pointer group"
          onClick={() => {
            // Route qua AppInner để kiểm tra tab chưa lưu rồi force-close bằng destroy()
            // (close() không tự đóng WebView2 khi có listener close-requested — dùng destroy
            // như min/max, cùng họ lệnh window đang chạy tốt, bỏ qua vòng close-requested kẹt).
            window.dispatchEvent(new CustomEvent('prynx-request-quit'));
          }}
          title={t('shell:dong_alt_f4')}
          role="button"
          aria-label={t('shell:dong_cua_so')}
        >
          <svg width="10" height="10" viewBox="0 0 14 14" fill="none" className="opacity-50 group-hover:opacity-100 transition-opacity pointer-events-none">
            <path d="M1 1L13 13M1 13L13 1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </div>
      </div>
    </div>
  );
}

/** Minimum time to keep brand intro visible (~light animation + short hold). */
const SPLASH_MIN_MS = 3000;

export default function App() {
  const { user, licenseKey, isChecking, checkSession, setUser, isLicenseLocked } = useAuthStore();
  const [splashMinElapsed, setSplashMinElapsed] = useState(false);
  const [splashExiting, setSplashExiting] = useState(false);
  const [splashDone, setSplashDone] = useState(false);

  useEffect(() => {
    appPerf.mark('app-mounted');
    const t = window.setTimeout(() => setSplashMinElapsed(true), SPLASH_MIN_MS);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    appPerf.mark('warmup-scheduled');
    const cancelWarmup = scheduleWarmupPdfjs();

    return cancelWarmup;
  }, []);

  useEffect(() => {
    checkSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user || null, session);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [checkSession, setUser]);

  // When session is ready and min intro time elapsed → play exit cinematic.
  useEffect(() => {
    if (!isChecking && splashMinElapsed && !splashExiting && !splashDone) {
      setSplashExiting(true);
    }
  }, [isChecking, splashMinElapsed, splashExiting, splashDone]);

  const handleSplashExitComplete = useCallback(() => {
    appPerf.mark('splash-complete');
    appPerf.measure('startup-to-splash-complete', 'app-mounted', 'splash-complete');
    setSplashDone(true);
  }, []);

  if (!splashDone) {
    return (
      <SplashScreen
        exiting={splashExiting}
        onExitComplete={handleSplashExitComplete}
      />
    );
  }

  const isAuthenticated = user && licenseKey;

  return (
    <FileProvider>
      {!isAuthenticated && <LoginScreen />}
      <LicenseLockOverlay />
      {isAuthenticated && <TrialExpiryBanner />}
      <AppInner />
      <ToastViewport />
      <ConfirmDialogHost />
    </FileProvider>
  );
}

function AppInner() {
  const { t } = useTranslation();
  const [tabs, setTabs] = useState<AppTab[]>([
    { id: 'home', type: 'home', title: 'Home', isClosable: false }
  ]);
  const [activeTabId, setActiveTabId] = useState<string>('home');
  const [tabToConfirmClose, setTabToConfirmClose] = useState<string | null>(null);
  /** Thoát app: hỏi TỪNG file dirty (như Acrobat), không gộp 1 popup tất cả. */
  const [quitDirtyQueue, setQuitDirtyQueue] = useState<string[]>([]);
  const [quitBusy, setQuitBusy] = useState(false);
  const quitQueueRef = useRef<string[]>([]);
  const [recoverySnaps, setRecoverySnaps] = useState<RecoverySnapshot[] | null>(null);
  const [isGlobalSettingsOpen, setIsGlobalSettingsOpen] = useState(false);
  const [isNewDocOpen, setIsNewDocOpen] = useState(false);
  const [isAboutOpen, setIsAboutOpen] = useState(false);
  const [aboutAutoCheck, setAboutAutoCheck] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<'tools' | 'export' | 'workspace' | 'shortcuts' | 'cutter'>('tools');
  const fileCtx = useFileContext();
  const { showMenuBar, showRulers, hiddenTools } = useAppSettingsStore();
  const { theme, toggleTheme } = useTheme();

  // AppInner là mốc shell đã được mount sau splash. Warm-up được khởi động ở
  // App() để không đợi hết splash và không cần render toàn bộ tab tree.
  useEffect(() => {
    appPerf.mark('app-inner-mounted');
    appPerf.measure('startup-to-app-inner', 'app-mounted', 'app-inner-mounted');
  }, []);

  // ── CRASH RECOVERY: quét snapshot còn sót lúc khởi động (chỉ có nếu lần trước
  //    CRASH — thoát sạch đã xóa hết). Có → hỏi user khôi phục. ──────────────────
  useEffect(() => {
    if (!(window as any).__TAURI_INTERNALS__) return;
    let cancelled = false;
    (async () => {
      try {
        const snaps = await listSnapshots();
        if (!cancelled && snaps.length > 0) setRecoverySnaps(snaps);
      } catch { /* bỏ qua nếu lỗi */ }
    })();
    return () => { cancelled = true; };
  }, []);
  
  // Drag hover to switch tab logic
  const tabHoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleTabDragOver = useCallback((e: React.DragEvent, id: string) => {
    e.preventDefault(); // Necessary to allow dropping over the tab
    if (activeTabIdRef.current !== id) {
      if (!tabHoverTimeoutRef.current) {
        tabHoverTimeoutRef.current = setTimeout(() => {
          setActiveTabId(id);
        }, 500); // 500ms delay to switch tab
      }
    }
  }, []);

  const handleTabDragLeave = useCallback(() => {
    if (tabHoverTimeoutRef.current) {
      clearTimeout(tabHoverTimeoutRef.current);
      tabHoverTimeoutRef.current = null;
    }
  }, []);

  // ── Kéo-thả sắp xếp lại tab (mượt như Chrome) ──────────────────────────────
  // KHÔNG dùng HTML5 draggable (Tauri dragDropEnabled nuốt sự kiện). Dùng pointer
  // events + thao tác DOM TRỰC TIẾP để đạt 60fps: tab đang kéo bám con trỏ, các tab
  // khác TRƯỢT nhường chỗ bằng CSS transition, chỉ commit lại thứ tự mảng khi thả.
  const TAB_GAP = 6; // khớp gap-1.5 của thanh tab
  const dragRef = useRef<null | {
    id: string;
    pointerStartX: number;
    draggedEl: HTMLElement;
    els: { id: string; el: HTMLElement; center: number }[];
    d: number;          // vị trí gốc của tab kéo trong danh sách tab tool
    unit: number;       // bề rộng tab kéo + gap = quãng dịch của tab nhường chỗ
    targetIndex: number;
    moved: boolean;
  }>(null);
  const justDraggedRef = useRef(false);
  // FLIP: tab vừa thả sẽ trượt từ vị trí con trỏ về đúng ô của nó.
  const settleRef = useRef<null | { id: string; oldLeft: number }>(null);
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);

  const onTabPointerMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.pointerStartX;
    if (!d.moved && Math.abs(dx) < 5) return; // ngưỡng tránh nhầm click
    if (!d.moved) {
      d.moved = true;
      setDraggingTabId(d.id);
      for (const o of d.els) {
        o.el.style.transition = o.id === d.id ? 'none' : 'transform 180ms cubic-bezier(0.2,0,0,1)';
      }
      d.draggedEl.style.position = 'relative';
      d.draggedEl.style.zIndex = '50';
    }
    // Tab kéo bám con trỏ
    d.draggedEl.style.transform = `translateX(${dx}px)`;

    // Chỉ số đích = số tab (khác tab kéo) có tâm nằm trước tâm tab kéo hiện tại
    const draggedCenter = d.els[d.d].center + dx;
    let t = 0;
    for (let i = 0; i < d.els.length; i++) {
      if (i === d.d) continue;
      if (draggedCenter > d.els[i].center) t++;
    }
    d.targetIndex = t;

    // Dịch các tab nhường chỗ (move d → t kiểu mảng)
    for (let i = 0; i < d.els.length; i++) {
      if (i === d.d) continue;
      let shift = 0;
      if (d.d < t && i > d.d && i <= t) shift = -d.unit;
      else if (d.d > t && i >= t && i < d.d) shift = d.unit;
      d.els[i].el.style.transform = `translateX(${shift}px)`;
    }
  }, []);

  const onTabPointerUp = useCallback(() => {
    window.removeEventListener('pointermove', onTabPointerMove);
    const d = dragRef.current;
    if (!d) { return; }

    // Các tab nhường chỗ: xoá tức thì (sau khi commit, vị trí mới trùng vị trí đã dịch
    // nên không bị nhảy). Tab kéo xử lý riêng bên dưới để trượt mượt.
    for (const o of d.els) {
      if (o.id === d.id) continue;
      o.el.style.transition = ''; o.el.style.transform = '';
      o.el.style.zIndex = ''; o.el.style.position = '';
    }

    const dragged = d.draggedEl;
    const settleBack = () => {
      dragged.style.transition = 'transform 180ms cubic-bezier(0.2,0,0,1)';
      dragged.style.transform = '';
      const cleanup = () => {
        dragged.style.transition = ''; dragged.style.zIndex = ''; dragged.style.position = '';
        dragged.removeEventListener('transitionend', cleanup);
      };
      dragged.addEventListener('transitionend', cleanup);
    };

    if (d.moved) {
      justDraggedRef.current = true;
      setTimeout(() => { justDraggedRef.current = false; }, 0);
      const from = d.d;
      const to = d.targetIndex;
      if (from !== to) {
        // FLIP: ghi vị trí con trỏ hiện tại rồi commit thứ tự; useLayoutEffect sẽ
        // cho tab trượt từ đây về ô đích.
        settleRef.current = { id: d.id, oldLeft: dragged.getBoundingClientRect().left };
        dragged.style.transition = ''; dragged.style.transform = '';
        dragged.style.zIndex = ''; dragged.style.position = '';
        setTabs(prev => {
          const tools = prev.filter(tb => tb.id !== 'home');
          const home = prev.filter(tb => tb.id === 'home');
          const [moved] = tools.splice(from, 1);
          tools.splice(to, 0, moved);
          return [...home, ...tools];
        });
      } else {
        // Thả tại chỗ: trượt tab kéo về 0 thay vì snap.
        settleBack();
      }
    } else {
      dragged.style.transition = ''; dragged.style.transform = '';
      dragged.style.zIndex = ''; dragged.style.position = '';
    }
    dragRef.current = null;
    setDraggingTabId(null);
  }, [onTabPointerMove]);

  const handleTabPointerDown = useCallback((e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return; // chỉ chuột trái
    const nodes = Array.from(document.querySelectorAll<HTMLElement>('[data-tab-id]'))
      .filter(n => n.getAttribute('data-tab-id') !== 'home');
    const els = nodes.map(el => {
      const r = el.getBoundingClientRect();
      return { id: el.getAttribute('data-tab-id')!, el, center: r.left + r.width / 2 };
    });
    const d = els.findIndex(o => o.id === id);
    if (d < 0) return;
    const draggedRect = els[d].el.getBoundingClientRect();
    dragRef.current = {
      id, pointerStartX: e.clientX, draggedEl: els[d].el, els, d,
      unit: draggedRect.width + TAB_GAP, targetIndex: d, moved: false,
    };
    window.addEventListener('pointermove', onTabPointerMove);
    window.addEventListener('pointerup', onTabPointerUp, { once: true });
  }, [onTabPointerMove, onTabPointerUp]);

  // FLIP sau khi commit thứ tự: tab vừa thả trượt mượt từ vị trí con trỏ về ô đích.
  useLayoutEffect(() => {
    const s = settleRef.current;
    if (!s) return;
    settleRef.current = null;
    const el = document.querySelector<HTMLElement>(`[data-tab-id="${s.id}"]`);
    if (!el) return;
    const newLeft = el.getBoundingClientRect().left;
    const delta = s.oldLeft - newLeft;
    if (Math.abs(delta) < 0.5) return;
    el.style.transition = 'none';
    el.style.transform = `translateX(${delta}px)`;
    requestAnimationFrame(() => {
      el.style.transition = 'transform 180ms cubic-bezier(0.2,0,0,1)';
      el.style.transform = '';
      const cleanup = () => { el.style.transition = ''; el.style.transform = ''; el.removeEventListener('transitionend', cleanup); };
      el.addEventListener('transitionend', cleanup);
    });
  }, [tabs]);

  useEffect(() => {
    const handleTabHoverEvent = (e: any) => {
        const tabId = e.detail.tabId;
        if (activeTabIdRef.current !== tabId) {
            if (!tabHoverTimeoutRef.current) {
                tabHoverTimeoutRef.current = setTimeout(() => {
                    setActiveTabId(tabId);
                }, 500);
            }
        }
    };
    const handleTabHoverLeaveEvent = () => {
        if (tabHoverTimeoutRef.current) {
            clearTimeout(tabHoverTimeoutRef.current);
            tabHoverTimeoutRef.current = null;
        }
    };
    window.addEventListener('prynx-tab-hover', handleTabHoverEvent);
    window.addEventListener('prynx-tab-hover-leave', handleTabHoverLeaveEvent);
    return () => {
        window.removeEventListener('prynx-tab-hover', handleTabHoverEvent);
        window.removeEventListener('prynx-tab-hover-leave', handleTabHoverLeaveEvent);
    }
  }, []);

  const handleOpenApp = useCallback((appId: AppToolId, payload?: any) => {
    const toolKey = payload?.focusFeature || payload?.lockedMode || appId;
    const featureId = featureIdForFocus(toolKey);
    if (featureId) {
      const { licensePlan, licenseFeatures } = useAuthStore.getState();
      if (!canUse(featureId, licensePlan, licenseFeatures)) {
        toast.info('Tính năng ' + FEATURE_CATALOG[featureId].label + ' dành cho PrynX Pro.');
        return;
      }
    }

    // Check single-instance tools
    const existingId = getExistingInstance(appId, tabs);
    if (existingId) {
      setActiveTabId(existingId);
      return;
    }

    // payload.title: tab Combine theo nhóm kích thước, recovery, v.v.
    const title = (payload && typeof payload.title === 'string' && payload.title.trim())
      ? payload.title.trim()
      : getTabTitle(appId);

    // Add random suffix to allow extremely fast consecutive spawns
    const newId = appId + '-' + Date.now() + '-' + Math.random().toString(36).substring(2, 5);

    // Automatically mark spawned imposition files as dirty
    const isSpawnedDirty = payload && payload.file && payload.file.name && isOutputFile(payload.file.name);

    // Save to recent files history if it has a physical path.
    // Bỏ qua file kết quả chưa lưu (VDP_, Imposed_...): chúng trỏ tới file tạm
    // trên server (dung lượng ~0, sẽ bị dọn) nên xuất hiện dạng 0MB/"Missing".
    if (payload && payload.file && (payload.file as any).path && !isOutputFile(payload.file.name || '') && !(payload.file as any).isBlank && !(payload.file as any).isGenerated) {
      import('./lib/useRecentFiles').then(({ useRecentFiles }) => {
        useRecentFiles.getState().addFile({
          path: (payload.file as any).path,
          name: payload.file.name,
          size: payload.file.size || 0
        });
      });
    }

    setTabs(prev => [...prev, { id: newId, type: appId, title, isClosable: true, payload, isDirty: !!isSpawnedDirty }]);
    setActiveTabId(newId);
  }, [tabs]);

  const tabsRef = useRef(tabs);
  const activeTabIdRef = useRef(activeTabId);
  const forceCloseRef = useRef(false);  // true sau khi user xác nhận thoát app → cho phép đóng

  // Khôi phục các phiên chưa lưu từ snapshot (mở lại tab + áp thao tác sửa lên file gốc).
  const restoreSnapshots = useCallback(async (snaps: RecoverySnapshot[]) => {
    setRecoverySnaps(null);
    try {
      const { stat } = await import('@tauri-apps/plugin-fs');
      for (const snap of snaps) {
        try {
          const fileStat = await stat(snap.originalPath);
          const fileObj = new File([], snap.originalName || 'document.pdf', { type: 'application/pdf' });
          Object.defineProperty(fileObj, 'path', { value: snap.originalPath });
          Object.defineProperty(fileObj, 'size', { value: (fileStat as any).size || 0 });
          handleOpenApp('imposition', {
            file: fileObj,
            initialRecovery: snap,
            lockedMode: snap.lockedMode,
            focusFeature: snap.feature,
          });
        } catch {
          // Phương án A: file gốc không còn trên đĩa → không dựng lại được.
          toast.error(t('shell:khong_khoi_phuc_duoc', { title: snap.title }));
        }
      }
    } finally {
      // Tab khôi phục đang-sửa sẽ tự ghi snapshot MỚI → xóa snapshot cũ cho sạch.
      await clearAllSnapshots();
    }
  }, [handleOpenApp, t]);

  const dismissRecovery = useCallback(async () => {
    setRecoverySnaps(null);
    await clearAllSnapshots();
  }, []);

  // Sync refs safely
  tabsRef.current = tabs;
  activeTabIdRef.current = activeTabId;

  const commitCloseTab = useCallback((id: string) => {
    // Release all blob URLs associated with this tab
    fileCtx.releaseTab(id);
    // Đóng tab CHỦ ĐỘNG (có xác nhận nếu dirty) = thoát sạch tab này → xóa snapshot
    // recovery để lần mở sau không hỏi khôi phục nhầm.
    void deleteSnapshot(id);

    setTabs(prev => {
      const idx = prev.findIndex(t => t.id === id);
      if (idx === -1) return prev;
      const nextTabs = prev.filter(t => t.id !== id);
      if (activeTabIdRef.current === id && nextTabs.length > 0) {
        const nextActiveIdx = Math.max(0, idx - 1);
        setActiveTabId(nextTabs[nextActiveIdx].id);
      }
      return nextTabs;
    });
    setTabToConfirmClose(null);
  }, [fileCtx]);

  const handleCloseTab = useCallback((id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();

    const tabToClose = tabsRef.current.find(t => t.id === id);
    if (!tabToClose) return;

    const isSpawnedOrOutput = isOutputFile(tabToClose.title);

    // Chỉ dựa vào trạng thái dirty THẬT của tab (ImpositionTab đã tôn trọng việc đã lưu).
    // Không ép dirty theo tên file output nữa — nếu không, file đã lưu mà tên còn "VDP_"
    // vẫn bị báo "chưa lưu".
    const effectivelyDirty = tabToClose.isDirty;
    void isSpawnedOrOutput;

    if (effectivelyDirty) {
      setTabToConfirmClose(id);
      return;
    }

    commitCloseTab(id);
  }, [commitCloseTab]);

  const updateTabTitle = useCallback((id: string, title: string) => {
    setTabs(prev => {
      const hasChange = prev.some(t => t.id === id && t.title !== title);
      if (!hasChange) return prev;
      return prev.map(t => t.id === id ? { ...t, title } : t);
    });
  }, []);

  const updateTabDirty = useCallback((id: string, isDirty: boolean) => {
    setTabs(prev => {
      const hasChange = prev.some(t => t.id === id && t.isDirty !== isDirty);
      if (!hasChange) return prev;
      return prev.map(t => t.id === id ? { ...t, isDirty } : t);
    });
  }, []);
  useEffect(() => {
    const preventNavigation = (e: DragEvent) => {
      // Allow default behavior only for actual file inputs
      if (e.target instanceof HTMLInputElement && e.target.type === 'file') return;
      e.preventDefault();
    };

    window.addEventListener('dragover', preventNavigation);
    window.addEventListener('drop', preventNavigation);

    return () => {
      window.removeEventListener('dragover', preventNavigation);
      window.removeEventListener('drop', preventNavigation);
    };
  }, []);

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      // Check if any tab has unsaved changes
      const hasDirtyTabs = tabsRef.current.some(t => {
        return t.isDirty;
      });

      if (hasDirtyTabs) {
        e.preventDefault();
        e.returnValue = ''; // Shows generic warning preventing data loss
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  /** Bắt đầu / chạy tiếp hàng đợi file dirty khi thoát app (mỗi file 1 dialog). */
  const beginQuitWithDirtyPrompt = useCallback(() => {
    const dirtyIds = tabsRef.current.filter(t => t.isDirty).map(t => t.id);
    if (dirtyIds.length === 0) {
      forceCloseRef.current = true;
      clearAllSnapshots().finally(() => {
        getCurrentWindow().destroy().catch((e: any) => toast.error("Close Error: " + (e.message || e)));
      });
      return;
    }
    quitQueueRef.current = dirtyIds;
    setQuitDirtyQueue(dirtyIds);
  }, []);

  const finishAppQuit = useCallback(() => {
    forceCloseRef.current = true;
    setQuitDirtyQueue([]);
    quitQueueRef.current = [];
    setQuitBusy(false);
    clearAllSnapshots().finally(() => {
      getCurrentWindow().destroy().catch((e: any) => toast.error("Close Error: " + (e.message || e)));
    });
  }, []);

  const advanceQuitQueue = useCallback(() => {
    const next = quitQueueRef.current.slice(1);
    quitQueueRef.current = next;
    setQuitDirtyQueue(next);
    if (next.length === 0) finishAppQuit();
  }, [finishAppQuit]);

  const cancelQuitFlow = useCallback(() => {
    setQuitDirtyQueue([]);
    quitQueueRef.current = [];
    setQuitBusy(false);
  }, []);

  /** Lưu tab hiện tại trong hàng đợi thoát (chờ app-save-result từ ImpositionTab). */
  const quitSaveCurrent = useCallback(async () => {
    const tabId = quitQueueRef.current[0];
    if (!tabId || quitBusy) return;
    setQuitBusy(true);
    setActiveTabId(tabId);
    // Đợi tab active render xong (isActive=true) rồi mới bắn save.
    await new Promise<void>(r => setTimeout(r, 150));

    const requestId = `quit_save_${tabId}_${Date.now()}`;
    const result = await new Promise<'saved' | 'cancelled' | 'failed'>((resolve) => {
      const onDone = (e: Event) => {
        const d = (e as CustomEvent).detail;
        if (!d || d.requestId !== requestId) return;
        window.removeEventListener('app-save-result', onDone);
        resolve(d.result === 'saved' ? 'saved' : d.result === 'failed' ? 'failed' : 'cancelled');
      };
      window.addEventListener('app-save-result', onDone);
      window.dispatchEvent(new CustomEvent('app-trigger-save', {
        detail: { tabId, saveAs: false, requestId },
      }));
      // Timeout: không có handler save (tool khác) hoặc treo dialog quá lâu
      setTimeout(() => {
        window.removeEventListener('app-save-result', onDone);
        resolve('failed');
      }, 180_000);
    });

    setQuitBusy(false);
    if (result === 'saved') {
      // Tab đã lưu → coi như hết dirty; sang file tiếp theo
      advanceQuitQueue();
    } else if (result === 'failed') {
      toast.info(tv('Không lưu được file này — hãy lưu thủ công (Ctrl+S) hoặc chọn Không lưu.'));
    }
    // cancelled: giữ dialog cùng file (user huỷ hộp thoại lưu)
  }, [quitBusy, advanceQuitQueue]);

  // CHẶN ĐÓNG CỬA SỔ TAURI khi còn tab CHƯA LƯU. beforeunload KHÔNG bắt được nút X
  // native (Tauri đóng cửa sổ qua sự kiện riêng `close-requested`, không qua DOM
  // unload) → trước đây bấm X = mất sạch dữ liệu chưa lưu, KHÔNG cảnh báo. Đăng ký
  // onCloseRequested: nếu có tab dirty → preventDefault + hỏi TỪNG file. Bao
  // trùm cả nút X (gọi close()), Alt+F4, và đóng từ taskbar (đều phát close-requested).
  useEffect(() => {
    if (!(window as any).__TAURI_INTERNALS__) return;  // chỉ áp cho desktop Tauri
    let unlisten: (() => void) | undefined;
    let disposed = false;
    getCurrentWindow()
      .onCloseRequested((event) => {
        if (forceCloseRef.current) return;            // đã xác nhận thoát → cho đóng
        if (tabsRef.current.some(t => t.isDirty)) {
          event.preventDefault();          // giữ cửa sổ lại
          beginQuitWithDirtyPrompt();      // hỏi từng file dirty
        }
        // không dirty → để Tauri đóng bình thường
      })
      .then((fn) => {
        if (disposed) fn(); else unlisten = fn;
      })
      .catch(() => {});
    return () => { disposed = true; if (unlisten) unlisten(); };
  }, [beginQuitWithDirtyPrompt]);

  // Nút X (title bar) phát 'prynx-request-quit' → kiểm tra tab chưa lưu ở đây rồi
  // đóng bằng destroy() (đáng tin như min/max; close() không tự đóng WebView2 khi có
  // listener close-requested). Có tab dirty → hỏi từng file thay vì đóng thẳng.
  useEffect(() => {
    const onQuit = () => {
      if (!(window as any).__TAURI_INTERNALS__) return;
      if (!forceCloseRef.current && tabsRef.current.some(t => t.isDirty)) {
        beginQuitWithDirtyPrompt();
        return;
      }
      getCurrentWindow().destroy().catch((e: any) => toast.error("Close Error: " + (e.message || e)));
    };
    window.addEventListener('prynx-request-quit', onQuit);
    return () => window.removeEventListener('prynx-request-quit', onQuit);
  }, [beginQuitWithDirtyPrompt]);

  // Copy/Move trang sang file khác (menu thumbnail) → nhảy sang tab đích để thấy trang mới.
  useEffect(() => {
    const onActivate = (e: Event) => {
      const id = (e as CustomEvent).detail?.tabId as string | undefined;
      if (!id) return;
      if (tabsRef.current.some(t => t.id === id)) {
        setActiveTabId(id);
      }
    };
    window.addEventListener('prynx-activate-tab', onActivate);
    return () => window.removeEventListener('prynx-activate-tab', onActivate);
  }, []);

  // Mở file (PDF/ảnh/Office) — Ctrl+O và menu File > Mở.
  // Office → tab Word/Excel/Google convert; PDF/ảnh → viewer như cũ.
  const handleOpenFile = useCallback(() => {
    if ((window as any).__TAURI_INTERNALS__) {
      import('@tauri-apps/plugin-dialog').then(async ({ open }) => {
        try {
          const { OFFICE_EXTENSIONS, isOfficePathOrName, mimeForOfficeName } = await import('./lib/officeFileTypes');
          const selected = await open({
            multiple: false,
            filters: [
              { name: 'PDF, Office & Hình ảnh', extensions: ['pdf', 'png', 'jpg', 'jpeg', ...OFFICE_EXTENSIONS] },
              { name: 'PDF', extensions: ['pdf'] },
              { name: 'Word / Excel / PowerPoint', extensions: [...OFFICE_EXTENSIONS] },
              { name: 'Hình ảnh', extensions: ['png', 'jpg', 'jpeg'] },
            ]
          });
          if (selected && typeof selected === 'string') {
            const { stat } = await import('@tauri-apps/plugin-fs');
            let size = 0;
            try {
              size = (await stat(selected)).size;
            } catch {
              try {
                const { invoke } = await import('@tauri-apps/api/core');
                size = await invoke<number>('get_file_size', { path: selected });
              } catch { /* keep 0 */ }
            }
            const name = selected.split('\\').pop() || selected.split('/').pop() || 'unknown';
            const lower = name.toLowerCase();
            let type = 'application/octet-stream';
            if (lower.endsWith('.pdf')) type = 'application/pdf';
            else if (lower.endsWith('.png')) type = 'image/png';
            else if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) type = 'image/jpeg';
            else if (isOfficePathOrName(name)) type = mimeForOfficeName(name);
            const fileObj = new File([], name, { type });
            Object.defineProperty(fileObj, 'path', { value: selected });
            Object.defineProperty(fileObj, 'size', { value: size });
            if (isOfficePathOrName(name)) {
              handleOpenApp('imposition', {
                focusFeature: 'office_convert',
                officeSourceFile: fileObj,
              });
            } else {
              handleOpenApp('imposition', { file: fileObj });
            }
          }
        } catch (err) {
          console.error(err);
        }
      });
    } else {
      document.getElementById('home-generic-pdf-input')?.click();
    }
  }, [handleOpenApp]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Block F5 and Ctrl+R (reload) completely
      if (e.key === 'F5' || (e.ctrlKey && (e.code === 'KeyR' || e.key.toLowerCase() === 'r'))) {
        e.preventDefault();
        return;
      }
      if (e.ctrlKey && (e.code === 'KeyW' || e.key.toLowerCase() === 'w')) {
        e.preventDefault();
        if (activeTabIdRef.current !== 'home') {
          handleCloseTab(activeTabIdRef.current);
        }
      }
      if (e.ctrlKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('app-trigger-save', {
          detail: { tabId: activeTabIdRef.current, saveAs: e.shiftKey }
        }));
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsGlobalSettingsOpen(prev => !prev);
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setIsNewDocOpen(true);
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        handleOpenFile();
      }
      // Ctrl+P: in PDF đang xem qua hộp thoại máy in Windows (Rust print_pdf).
      // preventDefault() cũng chặn hành vi in DOM mặc định của WebView2 (in nguyên UI).
      if (e.ctrlKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        e.stopPropagation();
        void import('./lib/nativePrint').then(m => m.logPrintEvent('App: Ctrl+P keydown')).catch(() => undefined);
        const activeTab = tabsRef.current.find(tab => tab.id === activeTabIdRef.current);
        if (activeTab && activeTab.type !== 'home' && NATIVE_PRINT_TOOL_TYPES.has(activeTab.type)) {
          window.dispatchEvent(new CustomEvent('app-trigger-print', {
            detail: { tabId: activeTab.id }
          }));
        } else {
          toast.info(t('shell:ctrl_p_chi_ho_tro_trinh_xem_pdf'));
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleCloseTab, handleOpenApp, handleOpenFile, t]);

  const accumulatedFiles = useRef<File[]>([]);
  const sysTimeoutRef = useRef<any>(null);
  const sysActionRef = useRef<string>(''); // ý định từ menu chuột phải (vd 'convert')

  useEffect(() => {
    const handleSystemFiles = (e: any) => {
      if (e.detail && e.detail.files && e.detail.files.length > 0) {
        accumulatedFiles.current = [...accumulatedFiles.current, ...e.detail.files];
        // Giữ ý định menu (vd 'convert'). Menu gọi 1 tiến trình/file nên nhiều event
        // dồn vào cùng đợt debounce — chỉ cần 1 event mang cờ là đủ, không cho ''
        // ghi đè cờ đã bắt.
        if (e.detail.action) sysActionRef.current = e.detail.action;

        if (sysTimeoutRef.current) clearTimeout(sysTimeoutRef.current);
        sysTimeoutRef.current = setTimeout(() => {
          const filesToProcess = [...accumulatedFiles.current];
          accumulatedFiles.current = [];
          const intent = sysActionRef.current;
          sysActionRef.current = '';
          // Sắp theo SỐ dẫn đầu tên file (numeric): "10_" SAU "2_" (kiểu số, không
          // phải chữ cái). Quy ước người dùng đặt tên "1_...","2_..." để định thứ tự
          // trang → CombineTab gộp trang theo đúng thứ tự này → khớp cột số lượng
          // Excel khi dán. File không có số đầu vẫn sắp ổn định theo tên.
          if (filesToProcess.length > 1) {
            filesToProcess.sort((a, b) =>
              a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
            );
          }
          if (filesToProcess.length > 0) {
            // Office files → tool convert (không mở viewer PDF)
            const officeFiles = filesToProcess.filter(f => isOfficePathOrName(f.name));
            const otherFiles = filesToProcess.filter(f => !isOfficePathOrName(f.name));
            const pdfFiles = otherFiles.filter(f => /\.pdf$/i.test(f.name));
            const conversionFiles = officeFiles.length > 0 ? [...officeFiles, ...pdfFiles] : [];
            const remainingOtherFiles = officeFiles.length > 0
              ? otherFiles.filter(f => !/\.pdf$/i.test(f.name))
              : otherFiles;

            if (conversionFiles.length > 0) {
              handleOpenApp('imposition', {
                focusFeature: 'office_convert',
                officeSourceFile: conversionFiles[0],
                officeSourceFiles: conversionFiles,
              });
            }

            if (remainingOtherFiles.length === 0) return;
            const filesForOtherTools = remainingOtherFiles;

            if (intent === 'convert') {
              // Menu "Convert to PDF" (chỉ ảnh): mở tab Ghép để nhúng ảnh→PDF —
              // KỂ CẢ 1 file (khác luồng mặc định đẩy 1 file vào imposition).
              // CombineTab đã có sẵn logic ảnh→trang PDF; convert = combine 1 ảnh.
              handleOpenApp('combine_pdf' as AppToolId, { files: filesForOtherTools });
            } else if (filesForOtherTools.length > 1) {
              if ((window as any).__isBgRemoverActive) {
                  window.dispatchEvent(new CustomEvent('prynx-bgremover-add-files', { detail: { files: filesForOtherTools } }));
              } else {
                  handleOpenApp('combine_pdf' as AppToolId, {
                    files: filesForOtherTools
                  });
              }
            } else if ((window as any).__isBgRemoverActive) {
              window.dispatchEvent(new CustomEvent('prynx-bgremover-add-files', { detail: { files: filesForOtherTools } }));
            } else {
              // LUÔN mở tab MỚI (kiểu Acrobat). Trước đây khi tab hiện tại đã mở file thì
              // phát `send-file-to-tab-${id}` để "gửi vào tab đang xem" — NHƯNG không có
              // listener nào nhận sự kiện đó (ImpositionTab chỉ nạp qua prop initialFile,
              // mà prop này bị bỏ qua khi tab đã có file). Hệ quả: double-click / Open with
              // một file khi Prynx đang mở sẵn file → file rơi vào hư không, không mở được.
              handleOpenApp('imposition', {
                file: filesForOtherTools[0],
              });
            }
          }
        }, 50); // Reduced delay for drag-and-drop snappiness
      }
    };
    window.addEventListener('system-files-received', handleSystemFiles);
    return () => window.removeEventListener('system-files-received', handleSystemFiles);
  }, [handleOpenApp]);

  // ── MENU BAR (kiểu Acrobat) — lệnh viewer đi qua sự kiện 'prynx-menu-command'
  //    (chỉ tab active xử lý); lệnh app-level gọi handler trực tiếp. ─────────────
  const recentFiles = useRecentFiles((s) => s.files);
  const viewerCmd = useCallback((cmd: string) => {
    window.dispatchEvent(new CustomEvent('prynx-menu-command', { detail: { cmd } }));
  }, []);
  const isToolActive = activeTabId !== 'home';
  const activeTabType = tabs.find(t => t.id === activeTabId)?.type;
  const canNativePrint = !!(
    activeTabType
    && activeTabType !== 'home'
    && NATIVE_PRINT_TOOL_TYPES.has(activeTabType as AppToolId)
  );

  const openRecentFile = useCallback(async (rf: { path: string; name: string; size: number }) => {
    if (!(window as any).__TAURI_INTERNALS__) return;
    try {
      const lower = rf.name.toLowerCase();
      const type = lower.endsWith('.pdf') ? 'application/pdf' : lower.endsWith('.png') ? 'image/png' : 'image/jpeg';
      const fileObj = new File([], rf.name, { type });
      Object.defineProperty(fileObj, 'path', { value: rf.path });
      Object.defineProperty(fileObj, 'size', { value: rf.size });
      handleOpenApp('imposition', { file: fileObj });
    } catch (err) {
      console.error(err);
    }
  }, [handleOpenApp]);

  const openExternal = useCallback(async (url: string) => {
    try {
      if ((window as any).__TAURI_INTERNALS__) {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(url);
      } else {
        window.open(url, '_blank', 'noopener');
      }
    } catch (e) {
      console.error('[Link] open failed:', e);
    }
  }, []);

  const menus: MenuDef[] = [
    {
      label: 'File',
      items: [
        { label: tv('Tài liệu mới'), shortcut: 'Ctrl+N', onClick: () => setIsNewDocOpen(true) },
        { label: tv('Mở file…'), shortcut: 'Ctrl+O', onClick: handleOpenFile },
        { label: tv('Mở gần đây'), disabled: recentFiles.length === 0,
          submenu: recentFiles.slice(0, 12).map((rf) => ({ label: rf.name, onClick: () => openRecentFile(rf) })) },
        { separator: true },
        { label: tv('Lưu'), shortcut: 'Ctrl+S', disabled: !isToolActive,
          onClick: () => window.dispatchEvent(new CustomEvent('app-trigger-save', { detail: { tabId: activeTabId, saveAs: false } })) },
        { label: tv('Lưu thành…'), shortcut: 'Ctrl+Shift+S', disabled: !isToolActive,
          onClick: () => window.dispatchEvent(new CustomEvent('app-trigger-save', { detail: { tabId: activeTabId, saveAs: true } })) },
        { separator: true },
        {
          label: tv('In…'),
          shortcut: 'Ctrl+P',
          disabled: !canNativePrint,
          onClick: () => {
            if (canNativePrint) {
              window.dispatchEvent(new CustomEvent('app-trigger-print', { detail: { tabId: activeTabId } }));
            } else {
              toast.info(t('shell:ctrl_p_chi_ho_tro_trinh_xem_pdf'));
            }
          },
        },
        { separator: true },
        { label: tv('Đóng tab'), shortcut: 'Ctrl+W', disabled: !isToolActive, onClick: () => handleCloseTab(activeTabId) },
        { label: tv('Thoát'), shortcut: 'Alt+F4', onClick: () => window.dispatchEvent(new CustomEvent('prynx-request-quit')) },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: tv('Hoàn tác'), shortcut: 'Ctrl+Z', disabled: !isToolActive, onClick: () => viewerCmd('undo') },
        { label: tv('Làm lại'), shortcut: 'Ctrl+Y', disabled: !isToolActive, onClick: () => viewerCmd('redo') },
        { separator: true },
        { label: tv('Chỉnh sửa đối tượng'), shortcut: getShortcutLabel('viewer.object_edit'), disabled: !isToolActive, onClick: () => viewerCmd('toggle-object-edit') },
        { label: tv('Cắt khổ (Crop)'), shortcut: getShortcutLabel('viewer.crop'), disabled: !isToolActive, onClick: () => viewerCmd('crop') },
        { label: tv('Xóa trang…'), shortcut: getShortcutLabel('viewer.delete_pages'), disabled: !isToolActive, onClick: () => viewerCmd('delete-pages') },
      ],
    },
    {
      label: 'View',
      items: [
        { label: t('shell:phong_to'), shortcut: getShortcutLabel('view.zoom_in'), icon: <ZoomIn className="w-3.5 h-3.5" />, disabled: !isToolActive, onClick: () => viewerCmd('zoom-in') },
        { label: t('shell:thu_nho'), shortcut: getShortcutLabel('view.zoom_out'), icon: <ZoomOut className="w-3.5 h-3.5" />, disabled: !isToolActive, onClick: () => viewerCmd('zoom-out') },
        { label: tv('Về 100%'), shortcut: getShortcutLabel('view.actual_size'), icon: <Maximize className="w-3.5 h-3.5" />, disabled: !isToolActive, onClick: () => viewerCmd('zoom-100') },
        { separator: true },
        { label: tv('Vừa chiều ngang'), shortcut: getShortcutLabel('view.fit_width'), icon: <MoveHorizontal className="w-3.5 h-3.5" />, disabled: !isToolActive, onClick: () => viewerCmd('fit-width') },
        { label: tv('Vừa trọn trang'), shortcut: getShortcutLabel('view.fit_page'), icon: <Maximize className="w-3.5 h-3.5" />, disabled: !isToolActive, onClick: () => viewerCmd('fit-page') },
        { separator: true },
        { label: tv('Xem một trang'), icon: <FileText className="w-3.5 h-3.5" />, disabled: !isToolActive, onClick: () => viewerCmd('layout-single-fit') },
        { label: tv('Cuộn trang dọc'), icon: <ScrollText className="w-3.5 h-3.5" />, disabled: !isToolActive, onClick: () => viewerCmd('layout-single-scroll') },
        { label: tv('Xem hai trang'), icon: <Columns2 className="w-3.5 h-3.5" />, disabled: !isToolActive, onClick: () => viewerCmd('layout-two-fit') },
        { label: tv('Cuộn hai trang'), icon: <Rows2 className="w-3.5 h-3.5" />, disabled: !isToolActive, onClick: () => viewerCmd('layout-two-scroll') },
        { separator: true },
        { label: tv('Thước đo (Rulers)'), shortcut: getShortcutLabel('viewer.toggle_rulers'), icon: <Ruler className="w-3.5 h-3.5" />, checked: showRulers, disabled: !isToolActive, onClick: () => viewerCmd('toggle-rulers') },
        { label: tv('Giao diện Tối'), icon: <Moon className="w-3.5 h-3.5" />, checked: theme === 'dark', onClick: toggleTheme },
      ],
    },
    {
      label: 'Tools',
      // Mỗi category = 1 mục cha có ▶, rê chuột xổ ra tool con (tránh đổ hết ~25 tool ra 1 cột).
      items: TOOL_CATEGORIES.flatMap((cat) => {
        const tools = getToolsByCategory(cat.id).filter((t) => t.isEnabled && !hiddenTools.includes(getToolUniqueKey(t)));
        if (tools.length === 0) return [];
        return [{
          label: tv(cat.title),
          submenu: tools.map((t) => ({
            label: tv(t.title),
            icon: t.icon,
            onClick: () => handleOpenApp(t.id, t.defaultPayload),
          })),
        }];
      }),
    },
    {
      label: 'Window',
      items: tabs.length > 1
        ? tabs.map((t) => ({
            label: t.title,
            checked: t.id === activeTabId,
            onClick: () => setActiveTabId(t.id),
          }))
        : [{ label: tv('Chỉ có tab Home'), disabled: true }],
    },
    {
      label: 'Help',
      items: [
        { label: tv('Cài đặt & Cấu hình'), shortcut: 'Ctrl+K', onClick: () => { setSettingsInitialTab('tools'); setIsGlobalSettingsOpen(true); } },
        { label: tv('Phím tắt'), onClick: () => { setSettingsInitialTab('shortcuts'); setIsGlobalSettingsOpen(true); } },
        { separator: true },
        { label: tv('Trang chủ PrintSolutions.vn'), onClick: () => openExternal(SUPPORT.website) },
        { label: tv('Liên hệ hỗ trợ'), submenu: [
          { label: `Email: ${SUPPORT.email}`, onClick: () => openExternal(`mailto:${SUPPORT.email}`) },
          { label: `Điện thoại: ${SUPPORT.phone}`, onClick: () => openExternal(`tel:${SUPPORT.phone}`) },
          { label: `Zalo: ${SUPPORT.phone}`, onClick: () => openExternal(SUPPORT.zalo) },
        ] },
        { label: tv('Kiểm tra cập nhật'), onClick: () => { setAboutAutoCheck(true); setIsAboutOpen(true); } },
        { separator: true },
        { label: tv('Giới thiệu PrynX'), onClick: () => { setAboutAutoCheck(false); setIsAboutOpen(true); } },
      ],
    },
  ];

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-[#e6e8eb] dark:bg-[#1a1a1a] select-none text-slate-800 dark:text-zinc-200 relative">
      <SystemIntegrations />
      <UpdateChecker />

      <TitleBar onOpenSettings={() => setIsGlobalSettingsOpen(true)} />

      {/* MENU BAR (kiểu Acrobat) — bật/tắt trong Cài đặt > Không gian làm việc */}
      {showMenuBar && (
        <div className="h-7 w-full shrink-0 bg-[#f0f0f0] dark:bg-[#121212] border-b border-black/10 dark:border-white/10 flex items-center pl-4 z-[100] relative">
          <MenuBar menus={menus} />
        </div>
      )}

      {/* ACROBAT MDI TAB BAR */}
      <div className="flex items-end min-h-[34px] bg-[#f0f0f0] dark:bg-[#121212] shrink-0 overflow-x-auto overflow-y-hidden border-b border-black/10 dark:border-white/10 pl-6 pr-4 pt-1 gap-1.5 focus:outline-none [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">

        {/* Pinned Home Tab */}
        {tabs.filter(t => t.id === 'home').map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              onClick={() => setActiveTabId(tab.id)}
              className={`
                group relative flex items-center justify-between min-w-[120px] max-w-[160px] h-[30px] pl-3 pr-3 
                rounded-t-lg transition-colors cursor-default border border-b-0
                ${isActive
                  ? 'bg-[#e6e8eb] dark:bg-[#1a1a1a] border-black/10 dark:border-white/10 shadow-[0_-2px_6px_rgba(0,0,0,0.03)] text-slate-900 dark:text-white font-semibold z-10'
                  : 'bg-transparent border-transparent text-slate-600 dark:text-zinc-400 hover:bg-[#e0e2e5] dark:hover:bg-[#262626] z-0'}
              `}
            >
              {isActive && (
                <div className="absolute -bottom-[1px] left-0 right-0 h-[2px] bg-[#e6e8eb] dark:bg-[#1a1a1a] z-20"></div>
              )}
              <div className="flex-1 min-w-0 truncate text-center text-[11px] tracking-wide" title={tab.title}>
                {tab.isDirty ? <span className="text-rose-500 font-bold mr-1">*</span> : null}{tab.title}
              </div>
            </div>
          );
        })}

        {/* Separator */}
        {tabs.length > 1 && (
          <div className="w-[1px] h-5 bg-black/20 dark:bg-white/20 mx-1 mb-1 shrink-0"></div>
        )}

        {/* Dynamic Tool Tabs */}
        {tabs.filter(t => t.id !== 'home').map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              onPointerDown={(e) => handleTabPointerDown(e, tab.id)}
              onClick={() => { if (justDraggedRef.current) return; setActiveTabId(tab.id); }}
              className={`
                group relative flex items-center justify-between min-w-[140px] max-w-[200px] h-[30px] pl-3 pr-2 
                rounded-t-lg transition-[background-color,color] border border-b-0
                ${draggingTabId === tab.id ? 'cursor-grabbing shadow-lg shadow-black/20 dark:shadow-black/50' : 'cursor-default'}
                ${isActive
                  ? 'bg-[#e6e8eb] dark:bg-[#1a1a1a] border-black/10 dark:border-white/10 shadow-[0_-2px_6px_rgba(0,0,0,0.03)] text-slate-900 dark:text-white font-semibold z-10'
                  : 'bg-[#e6e8eb]/50 dark:bg-[#1a1a1a]/50 border-black/5 dark:border-white/5 text-slate-500 dark:text-zinc-400 hover:bg-[#e0e2e5] dark:hover:bg-[#262626] z-0'}
              `}
            >
              {isActive && (
                <div className="absolute -bottom-[1px] left-0 right-0 h-[2px] bg-[#e6e8eb] dark:bg-[#1a1a1a] z-20"></div>
              )}

              <div className="flex-1 min-w-0 flex items-center justify-center gap-1 truncate text-center text-[11px] tracking-wide" title={tab.title}>

                {tab.isDirty ? <span className="text-rose-500 font-bold">*</span> : null}
                <span className="truncate">{tab.title}</span>
              </div>

              <button
                onClick={(e) => handleCloseTab(tab.id, e)}
                className={`w-5 h-5 shrink-0 ml-1.5 flex items-center justify-center rounded transition-colors
                  ${isActive ? 'opacity-100 hover:bg-black/10 dark:hover:bg-white/10' : 'opacity-0 group-hover:opacity-100 hover:bg-black/10 dark:hover:bg-white/10'}
                `}
                title="Close Tab"
              >
                <svg width="8" height="8" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.5">
                  <path d="M1 1L9 9M1 9L9 1" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          );
        })}

        <div className="flex-1 min-w-[20px]"></div>
      </div>

      {/* MAIN VIEWPORT */}
      <div className="flex-1 relative w-full h-full bg-[#e6e8eb] dark:bg-[#1a1a1a]">
        {/* Render ALL tabs but use display:none or z-index to manage visibility */}
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`absolute inset-0 flex-col w-full h-full ${tab.id === activeTabId ? 'flex z-10' : 'flex z-[0] opacity-0 pointer-events-none overflow-hidden'}`}
          >
            {tab.type === 'home' && <HomeTab onOpenApp={handleOpenApp} isActive={tab.id === activeTabId} />}
            {tab.type !== 'home' && (() => {
              const toolDef = TOOL_REGISTRY.find(t => t.id === tab.type && t.isEnabled);
              if (!toolDef) return <div className="flex items-center justify-center h-full text-slate-400">{t('shell:cong_cu_khong_tim_thay')}</div>;
              const ToolComponent = toolDef.component;
              // Các tab dùng ImpositionTab (bình bài + N-Up/Tem bế/CNC khoá-mode) đều
              // cần ĐỦ props: tabId + onDirtyChange (theo dõi CHƯA LƯU → cảnh báo khi
              // đóng tab/app) + lockedMode + initialFile. Trước đây chỉ type==='imposition'
              // được props; nup/diecut/cnc rơi nhánh mặc định (KHÔNG onDirtyChange) →
              // đóng tab/app mất dữ liệu không cảnh báo (audit an toàn dữ liệu).
              const IMPOSITION_FAMILY = ['imposition', 'nup', 'diecut', 'cnc'];
              if (IMPOSITION_FAMILY.includes(tab.type)) {
                return (
                  <Suspense fallback={<div className="flex items-center justify-center h-full"><div className="w-8 h-8 border-3 border-indigo-400 border-t-transparent rounded-full animate-spin" /></div>}>
                    <ToolComponent
                      tabId={tab.id}
                      isActive={tab.id === activeTabId}
                      onTitleChange={(title: string) => updateTabTitle(tab.id, title)}
                      onDirtyChange={(isDirty: boolean) => updateTabDirty(tab.id, isDirty)}
                      initialFile={tab.payload?.file}
                      initialReport={tab.payload?.report}
                      initialFeature={tab.payload?.focusFeature}
                      lockedMode={tab.payload?.lockedMode}
                      initialRecovery={tab.payload?.initialRecovery}
                      batchOutput={tab.payload?.batchOutput} // Note: batchOutput now primarily from imposerStore in context, this is legacy payload
                      systemMergeFiles={tab.payload?.systemMergeFiles}
                      officeSourceFile={tab.payload?.officeSourceFile}
                      officeSourceFiles={tab.payload?.officeSourceFiles}
                      onSpawnTab={(file: any, extraPayload?: any) => handleOpenApp('imposition', { file, lockedMode: tab.payload?.lockedMode, ...extraPayload })}
                    />
                  </Suspense>
                );
              }
              if (tab.type === 'combine_pdf') {
                return (
                  <Suspense fallback={<div className="flex items-center justify-center h-full"><div className="w-8 h-8 border-3 border-indigo-400 border-t-transparent rounded-full animate-spin" /></div>}>
                    <ToolComponent
                      tabId={tab.id}
                      isActive={tab.id === activeTabId}
                      onTitleChange={(title: string) => updateTabTitle(tab.id, title)}
                      onDirtyChange={(isDirty: boolean) => updateTabDirty(tab.id, isDirty)}
                      initialFiles={tab.payload?.files}
                      onSpawnTab={(file: any, extraPayload?: any) => handleOpenApp('imposition', { file, ...extraPayload })}
                      onSpawnCombineTabs={(results: { file: File; title: string }[]) => {
                        // Mỗi nhóm kích thước → 1 tab Combine riêng (file đã ghép).
                        // Stagger timestamp nhẹ để id tab không trùng trong cùng ms.
                        results.forEach((r, i) => {
                          setTimeout(() => {
                            handleOpenApp('combine_pdf' as AppToolId, {
                              files: [r.file],
                              title: r.title,
                            });
                          }, i * 30);
                        });
                      }}
                    />
                  </Suspense>
                );
              }
              return (
                <Suspense fallback={<div className="flex items-center justify-center h-full"><div className="w-8 h-8 border-3 border-indigo-400 border-t-transparent rounded-full animate-spin" /></div>}>
                  <ToolComponent
                    tabId={tab.id}
                    isActive={tab.id === activeTabId}
                    onTitleChange={(title: string) => updateTabTitle(tab.id, title)}
                    onDirtyChange={(isDirty: boolean) => updateTabDirty(tab.id, isDirty)}
                  />
                </Suspense>
              );
            })()}
          </div>
        ))}
      </div>

      <ConfirmCloseModal
        isOpen={tabToConfirmClose !== null}
        fileName={tabs.find(t => t.id === tabToConfirmClose)?.title || tv('Chưa rõ tên')}
        onConfirm={() => {
          if (tabToConfirmClose) commitCloseTab(tabToConfirmClose);
        }}
        onCancel={() => setTabToConfirmClose(null)}
      />

      {/* Thoát app: 1 dialog / 1 file dirty (Acrobat-style), không gộp tất cả. */}
      {(() => {
        const quitTab = tabs.find(t => t.id === quitDirtyQueue[0]);
        const canSave = !!(quitTab && ['imposition', 'nup', 'diecut', 'cnc'].includes(quitTab.type));
        const name = quitTab?.title || tv('Chưa rõ tên');
        const remain = quitDirtyQueue.length;
        return (
          <ConfirmCloseModal
            isOpen={quitDirtyQueue.length > 0}
            fileName={name}
            title={t('shell:luu_thay_doi_truoc_khi_thoat')}
            body={(<>
              {t('shell:file_label')}{' '}
              <span className="text-rose-500 font-bold px-1 break-all">{name}</span>{' '}
              {t('shell:file_chua_duoc_luu_vao_may_neu_dong')}
              {remain > 1 && (
                <>
                  <br /><br />
                  <span className="text-slate-500 text-[12px]">
                    {t('shell:con_n_file_chua_xu_ly', { n: remain - 1 })}
                  </span>
                </>
              )}
            </>)}
            confirmText={t('shell:khong_luu')}
            secondaryText={canSave ? t('shell:luu') : undefined}
            onSecondary={canSave && !quitBusy ? () => { void quitSaveCurrent(); } : undefined}
            onConfirm={() => {
              if (quitBusy) return;
              advanceQuitQueue();
            }}
            onCancel={cancelQuitFlow}
            busy={quitBusy}
          />
        );
      })()}

      {recoverySnaps && recoverySnaps.length > 0 && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white dark:bg-zinc-800 p-6 rounded-lg shadow-2xl max-w-md w-full mx-4 border border-amber-500/40">
            <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2">{t('shell:khoi_phuc_phien_chua_luu')}</h3>
            <p className="text-sm text-slate-600 dark:text-zinc-300 mb-3 font-medium">
              {t('shell:phat_hien')} <span className="text-amber-600 font-bold">{recoverySnaps.length}</span> {t('shell:tai_lieu_chua_luu_tu_lan_chay_truoc')}
            </p>
            <ul className="text-[12px] text-slate-600 dark:text-zinc-300 mb-5 max-h-40 overflow-auto list-disc pl-5 space-y-0.5">
              {recoverySnaps.map((s) => (
                <li key={s.tabId} className="break-all">
                  <span className="font-semibold">{s.title}</span>
                  <span className="text-slate-400"> — {new Date(s.savedAt).toLocaleString()}</span>
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => { void dismissRecovery(); }}
                className="px-5 py-2.5 min-w-[100px] text-[14px] font-semibold rounded bg-slate-100 hover:bg-slate-200 dark:bg-zinc-700 dark:hover:bg-zinc-600 text-slate-700 dark:text-zinc-200 transition-colors"
              >
                {t('shell:bo_qua')}
              </button>
              <button
                onClick={() => { void restoreSnapshots(recoverySnaps); }}
                className="px-5 py-2.5 min-w-[100px] text-[14px] font-bold rounded bg-amber-500 hover:bg-amber-600 text-white transition-colors shadow-sm"
              >
                {t('shell:khoi_phuc')}
              </button>
            </div>
          </div>
        </div>
      )}

      {isGlobalSettingsOpen && (
        <SettingsModal initialTab={settingsInitialTab} onClose={() => setIsGlobalSettingsOpen(false)} />
      )}

      {isAboutOpen && (
        <AboutModal autoCheck={aboutAutoCheck} onClose={() => setIsAboutOpen(false)} />
      )}

      <NewDocumentModal
        isOpen={isNewDocOpen}
        onClose={() => setIsNewDocOpen(false)}
        onCreate={async (widthMm, heightMm, pageCount, name) => {
          try {
            const file = await createBlankPdfFile({ widthMm, heightMm, pageCount, name });
            handleOpenApp('imposition', { file });
          } catch (err) {
            console.error('Lỗi tạo tài liệu trắng:', err);
          }
        }}
      />
    </div>
  );
}

function ConfirmCloseModal({
  isOpen, fileName, onConfirm, onCancel, title, body, confirmText,
  secondaryText, onSecondary, busy,
}: {
  isOpen: boolean;
  fileName: string;
  onConfirm: () => void;
  onCancel: () => void;
  title?: string;
  body?: React.ReactNode;
  confirmText?: string;
  /** Nút phụ (vd Lưu) — đặt giữa Hủy và confirm (Không lưu). */
  secondaryText?: string;
  onSecondary?: () => void;
  busy?: boolean;
}) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isOpen && e.key === 'Escape' && !busy) onCancel();
    };
    if (isOpen) document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel, busy]);

  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-zinc-800 p-6 rounded-lg shadow-2xl max-w-md w-full mx-4 border border-rose-500/30">
        <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2">{title || tv('Cảnh báo chưa lưu')}</h3>
        <p className="text-sm text-slate-600 dark:text-zinc-300 mb-6 font-medium">
          {body || (<>
          {tv('File')} <span className="text-rose-500 font-bold px-1 break-all">{fileName}</span> {tv('chưa được lưu vào máy. Nếu đóng, bạn sẽ mất thành quả file này.')}
          <br /><br />
          {tv('Bạn có chắc chắn muốn đóng tab này không?')}
          </>)}
        </p>
        <div className="flex justify-end flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="px-5 py-2.5 min-w-[88px] text-[14px] font-semibold rounded bg-slate-100 hover:bg-slate-200 dark:bg-zinc-700 dark:hover:bg-zinc-600 text-slate-700 dark:text-zinc-200 transition-colors focus:outline-none disabled:opacity-50"
          >
            {tv('Hủy bỏ')}
          </button>
          {secondaryText && onSecondary && (
            <button
              type="button"
              disabled={busy}
              onClick={onSecondary}
              className="px-5 py-2.5 min-w-[88px] text-[14px] font-bold rounded bg-indigo-600 hover:bg-indigo-700 text-white transition-colors shadow-sm focus:outline-none disabled:opacity-50"
            >
              {busy ? '…' : secondaryText}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="px-5 py-2.5 min-w-[88px] text-[14px] font-bold rounded bg-rose-500 hover:bg-rose-600 text-white transition-colors shadow-sm focus:outline-none disabled:opacity-50"
          >
            {confirmText || tv('Vẫn Đóng')}
          </button>
        </div>
      </div>
    </div>
  );
}
