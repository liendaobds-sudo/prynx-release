import { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef, Suspense } from 'react';
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
import { TOOL_REGISTRY, TOOL_CATEGORIES, getToolsByCategory, getToolUniqueKey, getTabTitle, getExistingInstance, isImpositionFamilyTool, type AppToolId } from './lib/toolRegistry';
import { MenuBar, type MenuDef } from './components/MenuBar';
import AboutModal, { SUPPORT } from './components/AboutModal';
import { useAppSettingsStore } from './stores/appSettingsStore';
import { useActiveViewerStore } from './stores/useActiveViewerStore'; // UIUX (audit menu 2026-07-28 §MB.5)
import { useTheme } from './hooks/useTheme';
import { addOpenPayloadToRecent, useRecentFiles, statRecentFile } from './lib/useRecentFiles';
import { createPathBackedFile, dispatchSupportedSystemFiles, systemFileMime } from './lib/nativeFileAccess';
import { SUPPORTED_IMAGE_EXTENSIONS } from './lib/imageFileTypes';
import { FileProvider, useFileContext } from './lib/fileContext';
import { isOutputFile } from './lib/constants';
import { useAuthStore } from './stores/useAuthStore';
import LoginScreen from './components/auth/LoginScreen';
import LicenseLockOverlay from './components/auth/LicenseLockOverlay';
import TrialExpiryBanner from './components/auth/TrialExpiryBanner';
import SplashScreen from './components/SplashScreen';
import { supabase } from './lib/supabase';
import { ToastViewport, toast } from './components/ui/Toast';
// UIUX (audit 2026-07-27 §D-13): câu lỗi tiếng Việt + hướng khắc phục thay vì "Min/Max/Close Error"
import { formatError } from './lib/errorMessages';
import { ConfirmDialogHost } from './components/ui/confirmDialog';
import { listSnapshots, clearAllSnapshots, deleteSnapshot, type RecoverySnapshot } from './lib/recovery';
import { ZoomIn, ZoomOut, Maximize, MoveHorizontal, FileText, ScrollText, Columns2, Rows2, Ruler, Moon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { tv } from './i18n';
import { canUse, featureIdForFocus, FEATURE_CATALOG } from './lib/license/features';
import { getShortcutLabel, matchesShortcut } from './lib/keyboardShortcuts';
import { buildResultTabPayload } from './lib/tabNavigation';
import { useIncomingFileDispatcher } from './hooks/useIncomingFileDispatcher';

type AppTabType = 'home' | AppToolId;

// ── BẢNG NĂNG LỰC TAB (audit menu 2026-07-28 §MB.1/§MB.2) ──────────────────
// Menu bar phát lệnh bằng sự kiện window; tab nào KHÔNG có listener thì bấm menu
// hoàn toàn im lặng. Trước đây menu chỉ gate bằng "khác tab Home" nên 17 mục sáng
// giả trên tab Khuôn bế / Ghép & Trộn / So sánh. Ba Set dưới đây là danh sách tab
// THỰC SỰ xử lý được từng nhóm lệnh — sửa listener thì phải sửa Set tương ứng.

/** Tab có listener `app-trigger-print` + luồng in native. */
const NATIVE_PRINT_TOOL_TYPES = new Set<AppToolId>([
  'imposition', 'nup', 'diecut', 'cnc', 'preflight', 'combine_pdf', 'dieline',
  'compare_pdf',
]);

/**
 * Tab xử lý `prynx-menu-command` (toàn bộ menu Sửa + Xem).
 * Listener duy nhất trong dự án là AcrobatViewer, mà AcrobatViewer chỉ mount
 * trong ImpositionTab → đúng bằng họ tab bình bài.
 */
const VIEWER_COMMAND_TOOL_TYPES = new Set<AppToolId>([
  'imposition', 'nup', 'diecut', 'cnc', 'preflight',
]);

/** Tab có listener `app-trigger-save` (Lưu / Lưu thành…) — hiện chỉ ImpositionTab. */
const SAVE_TOOL_TYPES = new Set<AppToolId>([
  'imposition', 'nup', 'diecut', 'cnc', 'preflight',
]);

/**
 * Tab xử lý riêng nhóm lệnh ZOOM/FIT của menu Xem.
 * Rộng hơn VIEWER_COMMAND_TOOL_TYPES vì Khuôn bế có canvas zoom/pan riêng
 * (DielineCanvas2D + NestingCanvas) nhưng KHÔNG có khái niệm trang, hoàn tác trang,
 * chế độ xem một/hai trang — nên các nhóm đó vẫn phải mờ trên tab Khuôn bế.
 */
const ZOOM_COMMAND_TOOL_TYPES = new Set<AppToolId>([
  'imposition', 'nup', 'diecut', 'cnc', 'preflight', 'dieline',
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
  // UIUX (audit 2026-07-27 §A-10): theo dõi trạng thái phóng to để đổi icon + title nút maximize
  const [isMaximized, setIsMaximized] = useState(false);
  useEffect(() => {
    if (!(window as any).__TAURI_INTERNALS__) return; // chỉ áp cho desktop Tauri
    const win = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const sync = () => {
      win.isMaximized().then((v) => { if (!disposed) setIsMaximized(v); }).catch(() => {});
    };
    sync();
    win.onResized(() => sync())
      .then((fn) => { if (disposed) fn(); else unlisten = fn; })
      .catch(() => {});
    return () => { disposed = true; if (unlisten) unlisten(); };
  }, []);
  // UIUX §A-08 fix-verify: titlebar là chrome, phải nằm DƯỚI thang overlay z-modal/z-confirm/z-toast
  // (1000+ trong index.css) — z-[9999] cũ nổi trên backdrop modal, bấm xuyên được.
  return (
    <div
      data-tauri-drag-region
      className="h-10 w-full bg-[#f0f0f0] dark:bg-[#121212] flex items-center justify-between select-none z-[900] shrink-0 transition-colors"
    >
      <div
        onPointerDown={(e) => {
          // UIUX (audit 2026-07-27 §A-10) fix-verify: nhấn thứ 2 của double-click không được mở
          // move-loop startDragging (nuốt mouseup, race với toggle built-in của Tauri)
          if (e.detail > 1) return;
          if (e.buttons === 1 || e.button === 0) {
            getCurrentWindow().startDragging();
          }
        }}
        // UIUX (audit 2026-07-27 §A-10) fix-verify: BỎ onDoubleClick toggleMaximize — div này có
        // data-tauri-drag-region nên drag.js built-in của Tauri v2 đã bắt mousedown detail===2
        // và tự toggleMaximize; thêm handler JS nữa gây double-toggle race.
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
            // UIUX (audit 2026-07-27 §D-13): lỗi tiếng Việt qua formatError
            getCurrentWindow().minimize().catch((e: any) => toast.error(formatError(e, t('shell:khong_thu_nho_duoc_cua_so', 'Không thu nhỏ được cửa sổ'))));
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
            // UIUX (audit 2026-07-27 §D-13): lỗi tiếng Việt qua formatError
            getCurrentWindow().toggleMaximize().catch((e: any) => toast.error(formatError(e, t('shell:khong_phong_to_duoc_cua_so', 'Không phóng to được cửa sổ'))));
          }}
          // UIUX (audit 2026-07-27 §A-10): title + icon đổi theo trạng thái phóng to
          title={isMaximized ? t('shell:khoi_phuc', 'Khôi phục') : t('shell:phong_to')}
          role="button"
          aria-label={t('shell:phong_to_cua_so')}
        >
          {isMaximized ? (
            // UIUX (audit 2026-07-27 §A-10): đã phóng to → icon 2 ô chồng (Khôi phục)
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="opacity-50 group-hover:opacity-100 transition-opacity pointer-events-none">
              <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" />
              <path d="M2.5 2.5V0.5H9.5V7.5H7.5" stroke="currentColor" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="opacity-50 group-hover:opacity-100 transition-opacity pointer-events-none">
              <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" />
            </svg>
          )}
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
  /**
   * Hàng đợi hỏi-lưu: hỏi TỪNG file dirty (như Acrobat), không gộp 1 popup tất cả.
   *
   * UIUX (audit menu 2026-07-28 §MB.13b): dùng cho HAI việc, phân biệt bằng `mode`:
   *  - `'quit'`      thoát app → hết hàng đợi thì destroy() cửa sổ.
   *  - `'close-all'` menu Cửa sổ > Đóng tất cả tab → hết hàng đợi thì chỉ dọn state,
   *                  KHÔNG đụng cửa sổ. Mỗi tab được quyết định là đóng ngay tab đó
   *                  (giống Acrobat đóng nhiều tài liệu), Huỷ = dừng, giữ phần còn lại.
   */
  const [dirtyQueue, setDirtyQueue] = useState<string[]>([]);
  const [dirtyQueueMode, setDirtyQueueMode] = useState<'quit' | 'close-all'>('quit');
  const [quitBusy, setQuitBusy] = useState(false);
  const dirtyQueueRef = useRef<string[]>([]);
  const dirtyQueueModeRef = useRef<'quit' | 'close-all'>('quit');
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
    // UIUX (audit menu 2026-07-28 §WT.1): mở tool KHÔNG kèm file thì lấy tên CHÍNH tool
    // đó ("Cắt khổ (Crop)", "Bình tem bế") thay vì tiêu đề chung "Bình bài (Chưa có
    // file)" — trước đây mở 5 tool khác nhau ra 5 tab trùng y tên, thanh tab và menu
    // Cửa sổ không phân biệt được cái nào. Mở kèm file thì giữ nguyên đường cũ: tool
    // tự đổi tiêu đề thành tên file qua onTitleChange.
    const variantTool = toolKey !== appId
      ? TOOL_REGISTRY.find(tool => tool.isEnabled && getToolUniqueKey(tool) === toolKey)
      : undefined;
    const title = (payload && typeof payload.title === 'string' && payload.title.trim())
      ? payload.title.trim()
      : (variantTool && !payload?.file ? tv(variantTool.title) : getTabTitle(appId));

    // Add random suffix to allow extremely fast consecutive spawns
    const newId = appId + '-' + Date.now() + '-' + Math.random().toString(36).substring(2, 5);

    // Automatically mark spawned imposition files as dirty
    const isSpawnedDirty = payload && payload.file && payload.file.name && isOutputFile(payload.file.name);

    // FILEIO (audit 2026-08-02 §TEST.1): ghi cả nguồn Office/batch Office vào Recent.
    // Helper vẫn bỏ file kết quả tạm, blank và generated như chính sách cũ.
    addOpenPayloadToRecent(payload);

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

  const commitCloseTab = useCallback((id: string, preserveActiveTab = false) => {
    // Release all blob URLs associated with this tab
    fileCtx.releaseTab(id);
    // Đóng tab CHỦ ĐỘNG (có xác nhận nếu dirty) = thoát sạch tab này → xóa snapshot
    // recovery để lần mở sau không hỏi khôi phục nhầm.
    void deleteSnapshot(id);

    setTabs(prev => {
      const idx = prev.findIndex(t => t.id === id);
      if (idx === -1) return prev;
      const nextTabs = prev.filter(t => t.id !== id);
      if (!preserveActiveTab && activeTabIdRef.current === id && nextTabs.length > 0) {
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

  /** Đóng thật ứng dụng — dùng chung cho mọi đường kết thúc hàng đợi mode 'quit'. */
  const destroyAppWindow = useCallback(() => {
    forceCloseRef.current = true;
    clearAllSnapshots().finally(() => {
      // UIUX (audit 2026-07-27 §D-13) fix-verify: destroy() đóng ỨNG DỤNG, không phải tab → sửa câu lỗi
      getCurrentWindow().destroy().catch((e: any) => toast.error(formatError(e, t('shell:khong_dong_duoc_ung_dung', 'Không đóng được ứng dụng'))));
    });
  }, [t]);

  /** Mở hàng đợi hỏi-lưu cho danh sách tab dirty. Rỗng → gọi ngay onEmpty. */
  const beginDirtyQueue = useCallback((ids: string[], mode: 'quit' | 'close-all') => {
    dirtyQueueModeRef.current = mode;
    setDirtyQueueMode(mode);
    dirtyQueueRef.current = ids;
    setDirtyQueue(ids);
  }, []);

  /** Bắt đầu / chạy tiếp hàng đợi file dirty khi thoát app (mỗi file 1 dialog). */
  const beginQuitWithDirtyPrompt = useCallback(() => {
    const dirtyIds = tabsRef.current.filter(t => t.isDirty).map(t => t.id);
    if (dirtyIds.length === 0) {
      destroyAppWindow();
      return;
    }
    beginDirtyQueue(dirtyIds, 'quit');
  }, [beginDirtyQueue, destroyAppWindow]);

  /** Hết hàng đợi: 'quit' thì đóng app, 'close-all' thì chỉ dọn state. */
  const finishDirtyQueue = useCallback(() => {
    const mode = dirtyQueueModeRef.current;
    setDirtyQueue([]);
    dirtyQueueRef.current = [];
    setQuitBusy(false);
    if (mode === 'quit') destroyAppWindow();
  }, [destroyAppWindow]);

  const advanceDirtyQueue = useCallback(() => {
    const next = dirtyQueueRef.current.slice(1);
    dirtyQueueRef.current = next;
    setDirtyQueue(next);
    if (next.length === 0) finishDirtyQueue();
  }, [finishDirtyQueue]);

  const cancelDirtyQueue = useCallback(() => {
    setDirtyQueue([]);
    dirtyQueueRef.current = [];
    setQuitBusy(false);
  }, []);

  /**
   * Xử lý xong một tab trong hàng đợi. Mode 'close-all' thì đóng luôn tab đó — dù user
   * chọn Lưu hay Không lưu, ý định của họ là ĐÓNG. Mode 'quit' chỉ đi tiếp (cửa sổ sẽ
   * đóng cả ở cuối, không cần gỡ tab lẻ).
   */
  const resolveQueueTab = useCallback((tabId: string) => {
    if (dirtyQueueModeRef.current === 'close-all') commitCloseTab(tabId);
    advanceDirtyQueue();
  }, [advanceDirtyQueue, commitCloseTab]);

  /** Lưu tab đầu hàng đợi (chờ app-save-result từ ImpositionTab). */
  const saveCurrentQueueTab = useCallback(async () => {
    const tabId = dirtyQueueRef.current[0];
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
      // Tab đã lưu → coi như hết dirty; đóng (nếu đang Đóng tất cả) rồi sang file tiếp.
      resolveQueueTab(tabId);
    } else if (result === 'failed') {
      toast.info(tv('Không lưu được file này — hãy lưu thủ công (Ctrl+S) hoặc chọn Không lưu.'));
    }
    // cancelled: giữ dialog cùng file (user huỷ hộp thoại lưu)
  }, [quitBusy, resolveQueueTab]);

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
      // UIUX (audit 2026-07-27 §D-13) fix-verify: destroy() đóng ỨNG DỤNG, không phải tab → sửa câu lỗi
      getCurrentWindow().destroy().catch((e: any) => toast.error(formatError(e, t('shell:khong_dong_duoc_ung_dung', 'Không đóng được ứng dụng'))));
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
          const { OFFICE_EXTENSIONS } = await import('./lib/officeFileTypes');
          const selected = await open({
            multiple: false,
            filters: [
              { name: 'PDF, Office & Hình ảnh', extensions: ['pdf', ...SUPPORTED_IMAGE_EXTENSIONS, ...OFFICE_EXTENSIONS] },
              { name: 'PDF', extensions: ['pdf'] },
              { name: 'Word / Excel / PowerPoint', extensions: [...OFFICE_EXTENSIONS] },
              { name: 'Hình ảnh', extensions: [...SUPPORTED_IMAGE_EXTENSIONS] },
            ]
          });
          if (selected && typeof selected === 'string') {
            // FILEIO (audit 2026-08-02 §TEST.1): Ctrl+O dùng đúng transport và
            // dispatcher của Home/Open With/Recent; metadata timeout vẫn mở size=0.
            const { file } = await createPathBackedFile(selected);
            dispatchSupportedSystemFiles([file]);
          }
        } catch (err) {
          console.error(err);
        }
      });
    } else {
      document.getElementById('home-generic-pdf-input')?.click();
    }
  }, []);

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
        // UIUX (audit menu 2026-07-28 §MB.2): chỉ họ tab bình bài có listener
        // app-trigger-save. Trước đây Ctrl+S ở tab Khuôn bế/Ghép/So sánh phát sự
        // kiện vào hư không — user tưởng đã lưu. Nay nói rõ tab chưa hỗ trợ.
        const saveTab = tabsRef.current.find(tab => tab.id === activeTabIdRef.current);
        if (saveTab && saveTab.type !== 'home' && SAVE_TOOL_TYPES.has(saveTab.type)) {
          window.dispatchEvent(new CustomEvent('app-trigger-save', {
            detail: { tabId: activeTabIdRef.current, saveAs: e.shiftKey }
          }));
        } else if (saveTab && saveTab.type !== 'home') {
          toast.info(t('shell:tab_nay_chua_ho_tro_luu_bang_ctrl_s'));
        }
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
      // UIUX (audit menu 2026-07-28 §MB.13): Ctrl+Tab / Ctrl+Shift+Tab chuyển tab.
      if (matchesShortcut(e, 'global.next_tab') || matchesShortcut(e, 'global.prev_tab')) {
        e.preventDefault();
        const list = tabsRef.current;
        if (list.length > 1) {
          const cur = list.findIndex(tab => tab.id === activeTabIdRef.current);
          const step = matchesShortcut(e, 'global.prev_tab') ? -1 : 1;
          const next = ((cur < 0 ? 0 : cur) + step + list.length) % list.length;
          setActiveTabId(list[next].id);
        }
        return;
      }
      // UIUX (audit menu 2026-07-28 §MB.14): F1 = trợ giúp → mở bảng phím tắt.
      if (matchesShortcut(e, 'global.help')) {
        e.preventDefault();
        setSettingsInitialTab('shortcuts');
        setIsGlobalSettingsOpen(true);
        return;
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

  useIncomingFileDispatcher({
    onOpenApp: handleOpenApp,
    tabsRef,
    activeTabIdRef,
  });

  // ── MENU BAR (kiểu Acrobat) — lệnh viewer đi qua sự kiện 'prynx-menu-command'
  //    (chỉ tab active xử lý); lệnh app-level gọi handler trực tiếp. ─────────────
  const recentFiles = useRecentFiles((s) => s.files);
  const recentMissingPaths = useRecentFiles((s) => s.missingPaths); // §RF.1
  // UIUX (audit menu 2026-07-28 §MB.5/§MB.6): đọc TỪNG TRƯỜNG bằng selector riêng —
  // viewer publish lại cùng giá trị (vd zoom liên tục set fitMode='custom') sẽ không
  // làm shell render lại, tránh hồi quy hiệu năng khi cuộn file nhiều trang.
  const activeViewerPageDisplayMode = useActiveViewerStore((s) => s.pageDisplayMode);
  const activeViewerFitMode = useActiveViewerStore((s) => s.fitMode);
  const activeViewerNumPages = useActiveViewerStore((s) => s.numPages);
  const viewerCmd = useCallback((cmd: string) => {
    window.dispatchEvent(new CustomEvent('prynx-menu-command', { detail: { cmd } }));
  }, []);

  // UIUX (audit menu 2026-07-28 §MB.13): chuyển tab vòng tròn — dùng chung cho menu
  // Cửa sổ và phím Ctrl+Tab (một chỗ tính, không lệch hành vi).
  const stepActiveTab = useCallback((step: 1 | -1) => {
    const list = tabsRef.current;
    if (list.length < 2) return;
    const cur = list.findIndex(tab => tab.id === activeTabIdRef.current);
    const next = ((cur < 0 ? 0 : cur) + step + list.length) % list.length;
    setActiveTabId(list[next].id);
  }, []);

  /**
   * Đóng mọi tab công cụ. Tab sạch đóng ngay; tab chưa lưu đi qua **hàng đợi hỏi-lưu
   * dùng chung với luồng thoát app** (mode 'close-all') — mỗi file một hộp thoại
   * Lưu / Không lưu / Huỷ, quyết định xong là đóng luôn tab đó.
   *
   * UIUX (audit menu 2026-07-28 §MB.13b): bản đầu chỉ đóng tab sạch rồi báo còn mấy
   * tab dirty, vì hàng đợi lúc đó dính chặt với destroy() cửa sổ. Đã tách ra nên giờ
   * hỏi được từng file như Acrobat.
   */
  const closeAllTabs = useCallback(() => {
    const closable = tabsRef.current.filter(tab => tab.id !== 'home' && tab.isClosable);
    closable.filter(tab => !tab.isDirty).forEach(tab => commitCloseTab(tab.id));
    const dirtyIds = closable.filter(tab => tab.isDirty).map(tab => tab.id);
    if (dirtyIds.length > 0) beginDirtyQueue(dirtyIds, 'close-all');
  }, [commitCloseTab, beginDirtyQueue]);
  const isToolActive = activeTabId !== 'home';
  const activeTabType = tabs.find(t => t.id === activeTabId)?.type;
  const canNativePrint = !!(
    activeTabType
    && activeTabType !== 'home'
    && NATIVE_PRINT_TOOL_TYPES.has(activeTabType as AppToolId)
  );
  // UIUX (audit menu 2026-07-28 §MB.1/§MB.2): gate menu theo NĂNG LỰC THẬT của tab
  // đang xem, không phải "khác Home". Tab không có listener thì mục menu phải mờ
  // hẳn — thà thấy mờ còn hơn bấm vào không có gì xảy ra mà không hiểu vì sao.
  const canViewerCommand = !!(
    activeTabType
    && activeTabType !== 'home'
    && VIEWER_COMMAND_TOOL_TYPES.has(activeTabType as AppToolId)
  );
  const canSaveActiveTab = !!(
    activeTabType
    && activeTabType !== 'home'
    && SAVE_TOOL_TYPES.has(activeTabType as AppToolId)
  );
  const canZoomCommand = !!(
    activeTabType
    && activeTabType !== 'home'
    && ZOOM_COMMAND_TOOL_TYPES.has(activeTabType as AppToolId)
  );

  // UIUX (audit menu 2026-07-28 §MB.3): trước đây mở thẳng theo đường dẫn đã lưu —
  // file bị xóa/đổi tên thì tab mở ra rỗng, im lặng, chỉ có console.error. Nay stat()
  // trước như RecentFilesGrid (§D-13): còn thì lấy DUNG LƯỢNG THẬT (size lưu trong
  // store có thể cũ), mất thì báo tiếng Việt kèm đường dẫn và gỡ khỏi danh sách.
  const openRecentFile = useCallback(async (rf: { path: string; name: string; size: number }) => {
    if (!(window as any).__TAURI_INTERNALS__) return;
    // §RF.1: kiểm tồn tại qua helper dùng chung — nó tự đánh dấu/bỏ dấu "file đã mất"
    // trong store nên lưới Home và thumbnail thấy cùng một sự thật.
    const info = await statRecentFile(rf.path);
    if (!info) {
      toast.error(t('misc.recentFilesGrid:file_da_di_chuyen') + '\n' + rf.path);
      useRecentFiles.getState().removeFile(rf.path);
      return;
    }
    const fileObj = new File([], rf.name, { type: systemFileMime(rf.name) });
    Object.defineProperty(fileObj, 'path', { value: rf.path });
    Object.defineProperty(fileObj, 'size', { value: info.size || rf.size });
    // FILEIO (audit 2026-08-02 §TEST.1): menu Recent không đi tắt dispatcher.
    dispatchSupportedSystemFiles([fileObj]);
  }, [t]);

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

  // UIUX (audit menu 2026-07-28 §WT.1): danh sách tab trong menu Cửa sổ. Hai tab vẫn có
  // thể trùng tên (mở cùng một tool hai lần, hay cùng một file) → đánh số (1)(2) cho
  // NHÓM trùng để bấm đúng cái mình muốn; đánh dấu * cho tab chưa lưu (giống thanh tab)
  // để lúc Đóng tất cả biết trước cái nào sẽ hỏi.
  const windowTabItems = useMemo(() => {
    const total = new Map<string, number>();
    for (const tab of tabs) total.set(tab.title, (total.get(tab.title) ?? 0) + 1);
    const seen = new Map<string, number>();
    return tabs.map((tab) => {
      const n = (seen.get(tab.title) ?? 0) + 1;
      seen.set(tab.title, n);
      const suffix = (total.get(tab.title) ?? 0) > 1 ? ` (${n})` : '';
      return {
        label: `${tab.isDirty ? '* ' : ''}${tab.title}${suffix}`,
        title: tab.title,
        checked: tab.id === activeTabId,
        onClick: () => setActiveTabId(tab.id),
      };
    });
  }, [tabs, activeTabId]);

  // UIUX (audit menu 2026-07-28 §MB.8/§MB.11): nhóm "Công cụ" là phần đắt nhất của
  // thanh menu (~30 entry × lọc × tạo icon JSX) và trước đây dựng lại MỖI lần shell
  // render. Memo theo đúng những thứ nó phụ thuộc. Đồng thời gắn nhãn PRO/🔒 giống
  // HomeTab — trước đây menu không hé một dấu hiệu nào, bấm mới nhận toast từ chối.
  const licensePlan = useAuthStore((s) => s.licensePlan);
  const licenseFeatures = useAuthStore((s) => s.licenseFeatures);
  // Đổi ngôn ngữ vẫn dựng lại đúng: react-i18next tạo `t` MỚI mỗi lần đổi lng
  // (useTranslation → getSnapshot sinh snapshot mới), nên `t` trong deps là đủ —
  // không cần thêm i18n.language.
  const toolMenuItems = useMemo(() => TOOL_CATEGORIES.flatMap((cat) => {
    const tools = getToolsByCategory(cat.id).filter((tool) => tool.isEnabled && !hiddenTools.includes(getToolUniqueKey(tool)));
    if (tools.length === 0) return [];
    return [{
      label: tv(cat.title),
      submenu: tools.map((tool) => {
        const featureId = featureIdForFocus(getToolUniqueKey(tool));
        const locked = !!featureId && !canUse(featureId, licensePlan, licenseFeatures);
        return {
          label: locked ? `${tv(tool.title)}  🔒 PRO` : tv(tool.title),
          title: locked ? t('shell:can_key_prynx_pro', 'Cần key PrynX Pro') : tv(tool.title),
          icon: tool.icon,
          onClick: () => handleOpenApp(tool.id, tool.defaultPayload),
        };
      }),
    }];
  }), [hiddenTools, licensePlan, licenseFeatures, handleOpenApp, t]);

  const menus: MenuDef[] = [
    {
      label: t('shell:menu_file', 'Tệp'), // UIUX (audit 2026-07-27 §A-12)
      items: [
        // UIUX (audit menu 2026-07-28 §MB.12): nhãn phím tắt lấy từ bảng trung tâm,
        // không hardcode — đổi binding trong keyboardShortcuts là menu đổi theo.
        { label: tv('Tài liệu mới'), shortcut: getShortcutLabel('global.new_document'), onClick: () => setIsNewDocOpen(true) },
        { label: tv('Mở file…'), shortcut: getShortcutLabel('global.open'), onClick: handleOpenFile },
        // UIUX (audit menu 2026-07-28 §MB.15): thêm mục dọn danh sách (giữ file gắn sao)
        // — trước đây chỉ dọn được ở lưới Home.
        { label: tv('Mở gần đây'), disabled: recentFiles.length === 0,
          submenu: [
            // title = đường dẫn đầy đủ: hai file trùng tên khác thư mục phân biệt được khi hover.
            // §RF.1: file đã bị xác nhận mất (bởi bất kỳ UI nào) hiện dấu ⚠ ngay trong menu.
            ...recentFiles.slice(0, 12).map((rf) => {
              const missing = recentMissingPaths.includes(rf.path);
              return {
                label: missing ? `⚠ ${rf.name}` : rf.name,
                title: missing ? `${t('misc.recentFilesGrid:file_da_di_chuyen')} ${rf.path}` : rf.path,
                onClick: () => openRecentFile(rf),
              };
            }),
            { separator: true },
            { label: t('shell:menu_xoa_danh_sach_gan_day'), onClick: () => useRecentFiles.getState().clearUnstarred() },
          ] },
        { separator: true },
        // UIUX (audit menu 2026-07-28 §MB.2): chỉ tab có listener app-trigger-save mới bật.
        // §MB.2b: và phải ĐANG CÓ trang trong viewer — tab bình bài chưa nạp file thì
        // handleSaveFile dừng ở `if (!targetBlob) return false`, bấm vào không có gì.
        { label: tv('Lưu'), shortcut: getShortcutLabel('global.save'), disabled: !canSaveActiveTab || activeViewerNumPages === 0,
          onClick: () => window.dispatchEvent(new CustomEvent('app-trigger-save', { detail: { tabId: activeTabId, saveAs: false } })) },
        { label: tv('Lưu thành…'), shortcut: getShortcutLabel('global.save_as'), disabled: !canSaveActiveTab || activeViewerNumPages === 0,
          onClick: () => window.dispatchEvent(new CustomEvent('app-trigger-save', { detail: { tabId: activeTabId, saveAs: true } })) },
        { separator: true },
        {
          label: `${t('misc.exportImage:tab_xuat_anh')}…`,
          disabled: !canViewerCommand || activeViewerNumPages === 0,
          onClick: () => viewerCmd('export-image'),
        },
        {
          label: `${t('misc.exportImage:tab_xuat_cho_man_hinh')}…`,
          disabled: !canViewerCommand || activeViewerNumPages === 0,
          onClick: () => viewerCmd('export-for-screens'),
        },
        { separator: true },
        {
          // UIUX (audit menu 2026-07-28 §MB.10): bỏ nhánh else báo lỗi — item đã disabled
          // khi tab không in được nên nhánh đó là code chết (toast chỉ còn dùng cho Ctrl+P).
          // UIUX (audit menu 2026-07-28 §MB.4): 'In…' chưa có trong locale nên tv() trả
          // nguyên tiếng Việt ở bản English → dùng key shell:menu_in.
          label: t('shell:menu_in', 'In…'),
          shortcut: getShortcutLabel('global.print'),
          disabled: !canNativePrint,
          onClick: () => window.dispatchEvent(new CustomEvent('app-trigger-print', { detail: { tabId: activeTabId } })),
        },
        { separator: true },
        { label: tv('Đóng tab'), shortcut: getShortcutLabel('global.close_tab'), disabled: !isToolActive, onClick: () => handleCloseTab(activeTabId) },
        { label: tv('Thoát'), shortcut: getShortcutLabel('global.quit'), onClick: () => window.dispatchEvent(new CustomEvent('prynx-request-quit')) },
      ],
    },
    {
      label: t('shell:menu_edit', 'Sửa'), // UIUX (audit 2026-07-27 §A-12)
      // UIUX (audit menu 2026-07-28 §MB.1): mọi mục ở đây đi qua prynx-menu-command →
      // chỉ tab có AcrobatViewer xử lý được, gate bằng canViewerCommand.
      items: [
        { label: tv('Hoàn tác'), shortcut: getShortcutLabel('viewer.undo'), disabled: !canViewerCommand, onClick: () => viewerCmd('undo') },
        { label: tv('Làm lại'), shortcut: getShortcutLabel('viewer.redo'), disabled: !canViewerCommand, onClick: () => viewerCmd('redo') },
        { separator: true },
        { label: tv('Chỉnh sửa đối tượng'), shortcut: getShortcutLabel('viewer.object_edit'), disabled: !canViewerCommand, onClick: () => viewerCmd('toggle-object-edit') },
        { label: tv('Cắt khổ (Crop)'), shortcut: getShortcutLabel('viewer.crop'), disabled: !canViewerCommand, onClick: () => viewerCmd('crop') },
        { separator: true },
        // UIUX (audit menu 2026-07-28 §MB.6): các thao tác trang trước đây CHỈ có phím tắt
        // (R / Shift+R / Ctrl+A / E) — khách dùng chuột không có đường nào tới.
        { label: t('shell:menu_chon_tat_ca_trang'), shortcut: getShortcutLabel('pages.select_all'), disabled: !canViewerCommand || activeViewerNumPages === 0, onClick: () => viewerCmd('select-all-pages') },
        { label: t('shell:menu_bo_chon_trang'), shortcut: getShortcutLabel('pages.clear_selection'), disabled: !canViewerCommand || activeViewerNumPages === 0, onClick: () => viewerCmd('clear-page-selection') },
        { label: t('shell:menu_xoay_phai'), shortcut: getShortcutLabel('pages.rotate_right'), disabled: !canViewerCommand || activeViewerNumPages === 0, onClick: () => viewerCmd('rotate-right') },
        { label: t('shell:menu_xoay_trai'), shortcut: getShortcutLabel('pages.rotate_left'), disabled: !canViewerCommand || activeViewerNumPages === 0, onClick: () => viewerCmd('rotate-left') },
        { separator: true },
        { label: t('shell:menu_trich_xuat_trang'), shortcut: getShortcutLabel('viewer.extract_pages'), disabled: !canViewerCommand || activeViewerNumPages === 0, onClick: () => viewerCmd('extract-pages') },
        { label: tv('Xóa trang…'), shortcut: getShortcutLabel('viewer.delete_pages'), disabled: !canViewerCommand || activeViewerNumPages === 0, onClick: () => viewerCmd('delete-pages') },
        { separator: true },
        // UIUX (audit menu 2026-07-28 §MB.14): "Cài đặt & Cấu hình" chuyển từ Trợ giúp
        // sang cuối menu Sửa — đúng chỗ Preferences của Acrobat và chuẩn Windows. Mục
        // "Phím tắt" GIỮ ở Trợ giúp vì đó là nội dung tra cứu, không phải thiết lập.
        { label: t('shell:menu_tuy_chon'), shortcut: getShortcutLabel('global.settings'), onClick: () => { setSettingsInitialTab('tools'); setIsGlobalSettingsOpen(true); } },
      ],
    },
    {
      label: t('shell:menu_view', 'Xem'), // UIUX (audit 2026-07-27 §A-12)
      items: [
        // UIUX (audit menu 2026-07-28 §MB.1): nhóm lệnh viewer gate theo canViewerCommand;
        // riêng "Giao diện Tối" là cấp ứng dụng nên luôn bật (kể cả ở tab Home).
        // Nhóm zoom/fit dùng canZoomCommand → chạy cả trên tab Khuôn bế (canvas riêng).
        { label: t('shell:phong_to'), shortcut: getShortcutLabel('view.zoom_in'), icon: <ZoomIn className="w-3.5 h-3.5" />, disabled: !canZoomCommand, onClick: () => viewerCmd('zoom-in') },
        { label: t('shell:thu_nho'), shortcut: getShortcutLabel('view.zoom_out'), icon: <ZoomOut className="w-3.5 h-3.5" />, disabled: !canZoomCommand, onClick: () => viewerCmd('zoom-out') },
        { label: tv('Về 100%'), shortcut: getShortcutLabel('view.actual_size'), icon: <Maximize className="w-3.5 h-3.5" />, disabled: !canZoomCommand, onClick: () => viewerCmd('zoom-100') },
        { separator: true },
        // UIUX (audit menu 2026-07-28 §MB.5): tick chế độ fit / chế độ trang ĐANG dùng
        // (đọc từ useActiveViewerStore — bản sao toàn cục của viewer đang xem). Dấu ✓ chỉ
        // có nghĩa với viewer PDF; tab Khuôn bế fit theo khuôn nên không tick.
        { label: tv('Vừa chiều ngang'), shortcut: getShortcutLabel('view.fit_width'), icon: <MoveHorizontal className="w-3.5 h-3.5" />, checked: canViewerCommand && activeViewerFitMode === 'width', disabled: !canZoomCommand, onClick: () => viewerCmd('fit-width') },
        { label: tv('Vừa trọn trang'), shortcut: getShortcutLabel('view.fit_page'), icon: <Maximize className="w-3.5 h-3.5" />, checked: canViewerCommand && activeViewerFitMode === 'page', disabled: !canZoomCommand, onClick: () => viewerCmd('fit-page') },
        { separator: true },
        // UIUX (audit menu 2026-07-28 §MB.6): điều hướng trang — AcrobatViewer đã xử lý
        // sẵn 4 lệnh này từ trước, chỉ chưa có mục menu nào phát ra.
        { label: t('shell:menu_trang_dau'), shortcut: getShortcutLabel('pages.first'), disabled: !canViewerCommand || activeViewerNumPages === 0, onClick: () => viewerCmd('first-page') },
        { label: t('shell:menu_trang_truoc'), shortcut: getShortcutLabel('pages.previous'), disabled: !canViewerCommand || activeViewerNumPages === 0, onClick: () => viewerCmd('prev-page') },
        { label: t('shell:menu_trang_sau'), shortcut: getShortcutLabel('pages.next'), disabled: !canViewerCommand || activeViewerNumPages === 0, onClick: () => viewerCmd('next-page') },
        { label: t('shell:menu_trang_cuoi'), shortcut: getShortcutLabel('pages.last'), disabled: !canViewerCommand || activeViewerNumPages === 0, onClick: () => viewerCmd('last-page') },
        { separator: true },
        { label: tv('Xem một trang'), icon: <FileText className="w-3.5 h-3.5" />, checked: canViewerCommand && activeViewerPageDisplayMode === 'single_fit', disabled: !canViewerCommand, onClick: () => viewerCmd('layout-single-fit') },
        { label: tv('Cuộn trang dọc'), icon: <ScrollText className="w-3.5 h-3.5" />, checked: canViewerCommand && activeViewerPageDisplayMode === 'single_scroll', disabled: !canViewerCommand, onClick: () => viewerCmd('layout-single-scroll') },
        { label: tv('Xem hai trang'), icon: <Columns2 className="w-3.5 h-3.5" />, checked: canViewerCommand && activeViewerPageDisplayMode === 'two_fit', disabled: !canViewerCommand, onClick: () => viewerCmd('layout-two-fit') },
        { label: tv('Cuộn hai trang'), icon: <Rows2 className="w-3.5 h-3.5" />, checked: canViewerCommand && activeViewerPageDisplayMode === 'two_scroll', disabled: !canViewerCommand, onClick: () => viewerCmd('layout-two-scroll') },
        { separator: true },
        { label: tv('Thước đo (Rulers)'), shortcut: getShortcutLabel('viewer.toggle_rulers'), icon: <Ruler className="w-3.5 h-3.5" />, checked: showRulers, disabled: !canViewerCommand, onClick: () => viewerCmd('toggle-rulers') },
        { label: tv('Giao diện Tối'), icon: <Moon className="w-3.5 h-3.5" />, checked: theme === 'dark', onClick: toggleTheme },
      ],
    },
    {
      label: t('shell:menu_tools', 'Công cụ'), // UIUX (audit 2026-07-27 §A-12)
      // Mỗi category = 1 mục cha có ▶, rê chuột xổ ra tool con (tránh đổ hết ~25 tool ra 1 cột).
      items: toolMenuItems,
    },
    {
      label: t('shell:menu_window', 'Cửa sổ'), // UIUX (audit 2026-07-27 §A-12)
      items: [
        ...(tabs.length > 1 ? windowTabItems : [{ label: tv('Chỉ có tab Home'), disabled: true }]),
        // UIUX (audit menu 2026-07-28 §MB.13): trước đây menu Cửa sổ chỉ là danh sách tab.
        { separator: true },
        { label: t('shell:menu_tab_ke_tiep'), shortcut: getShortcutLabel('global.next_tab'), disabled: tabs.length < 2, onClick: () => stepActiveTab(1) },
        { label: t('shell:menu_tab_truoc'), shortcut: getShortcutLabel('global.prev_tab'), disabled: tabs.length < 2, onClick: () => stepActiveTab(-1) },
        { label: t('shell:menu_dong_tat_ca_tab'), disabled: tabs.length < 2, onClick: closeAllTabs },
      ],
    },
    {
      label: t('shell:menu_help', 'Trợ giúp'), // UIUX (audit 2026-07-27 §A-12)
      items: [
        { label: tv('Phím tắt'), shortcut: getShortcutLabel('global.help'), onClick: () => { setSettingsInitialTab('shortcuts'); setIsGlobalSettingsOpen(true); } },
        { separator: true },
        // UIUX (audit menu 2026-07-28 §MB.14): thêm mục hướng dẫn + phím F1 cho "Phím tắt".
        { label: t('shell:menu_huong_dan_su_dung'), onClick: () => openExternal(SUPPORT.product) },
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
      <div
        // UIUX (audit 2026-07-27 §A-06): lăn chuột dọc → cuộn ngang thanh tab (scrollbar đã ẩn).
        // KHÔNG preventDefault — listener React là passive, gọi sẽ lỗi console.
        onWheel={(e) => {
          if (e.deltaY !== 0 && e.deltaX === 0) {
            e.currentTarget.scrollLeft += e.deltaY;
          }
        }}
        className="flex items-end min-h-[34px] bg-[#f0f0f0] dark:bg-[#121212] shrink-0 overflow-x-auto overflow-y-hidden border-b border-black/10 dark:border-white/10 pl-6 pr-4 pt-1 gap-1.5 focus:outline-none [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">

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
              // UIUX (audit 2026-07-27 §WR.1): dùng một nguồn routing để shortcut Preflight
              // không rơi sang component/menu độc lập khi người dùng mở công cụ trước PDF.
              if (isImpositionFamilyTool(tab.type)) {
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
                      onSpawnTab={(file: any, extraPayload?: any) => handleOpenApp('imposition', buildResultTabPayload(file, extraPayload))}
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
                      onSpawnTab={(file: any, extraPayload?: any) => handleOpenApp('imposition', buildResultTabPayload(file, extraPayload))}
                      onResultsOpened={() => {
                        // UIUX (audit 2026-08-02 §COMB.UI): giữ active tab kết quả.
                        commitCloseTab(tab.id, true);
                      }}
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

      {/* Hàng đợi hỏi-lưu: 1 dialog / 1 file dirty (Acrobat-style), không gộp tất cả.
          Dùng chung cho thoát app và Đóng tất cả tab — chỉ khác tiêu đề và việc cuối. */}
      {(() => {
        const queueTabId = dirtyQueue[0];
        const queueTab = tabs.find(t => t.id === queueTabId);
        // UIUX (audit menu 2026-07-28 §MB.13b): trước đây danh sách tab được chào "Lưu"
        // hardcode ['imposition','nup','diecut','cnc'] — THIẾU 'preflight' dù tab đó có
        // listener save thật → tab Preflight dirty chỉ được chọn Không lưu. Dùng chung
        // SAVE_TOOL_TYPES để không bao giờ lệch nữa.
        const canSave = !!(queueTab && queueTab.type !== 'home' && SAVE_TOOL_TYPES.has(queueTab.type));
        const name = queueTab?.title || tv('Chưa rõ tên');
        const remain = dirtyQueue.length;
        return (
          <ConfirmCloseModal
            isOpen={remain > 0}
            fileName={name}
            title={dirtyQueueMode === 'close-all'
              ? t('shell:luu_thay_doi_truoc_khi_dong_tab')
              : t('shell:luu_thay_doi_truoc_khi_thoat')}
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
            onSecondary={canSave && !quitBusy ? () => { void saveCurrentQueueTab(); } : undefined}
            onConfirm={() => {
              if (quitBusy || !queueTabId) return;
              resolveQueueTab(queueTabId);
            }}
            onCancel={cancelDirtyQueue}
            busy={quitBusy}
          />
        );
      })()}

      {recoverySnaps && recoverySnaps.length > 0 && (
        // UIUX (audit 2026-07-27 §A-08): z số tay → class ngữ nghĩa z-modal
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/50 backdrop-blur-sm">
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
    // UIUX (audit 2026-07-27 §A-08): z số tay → class ngữ nghĩa z-confirm (nổi trên z-modal)
    <div className="fixed inset-0 z-confirm flex items-center justify-center bg-black/50 backdrop-blur-sm">
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
