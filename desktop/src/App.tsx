import { useState, useCallback, useEffect, useRef, Suspense } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import HomeTab from './components/HomeTab';
import { ThemeToggle } from './components/ThemeToggle';
import SettingsModal from './components/SettingsModal';
import NewDocumentModal from './components/NewDocumentModal';
import { createBlankPdfFile } from './lib/createBlankPdf';
import { scheduleWarmupPdfjs } from './lib/pdfWarmup';
import SystemIntegrations from './components/SystemIntegrations';
import UpdateChecker from './components/UpdateChecker';
import { TOOL_REGISTRY, getTabTitle, getExistingInstance, type AppToolId } from './lib/toolRegistry';
import { FileProvider, useFileContext } from './lib/fileContext';
import { isOutputFile } from './lib/constants';
import { useAuthStore } from './stores/useAuthStore';
import LoginScreen from './components/auth/LoginScreen';
import LicenseLockOverlay from './components/auth/LicenseLockOverlay';
import TrialExpiryBanner from './components/auth/TrialExpiryBanner';
import { supabase } from './lib/supabase';

type AppTabType = 'home' | AppToolId;

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
            title="Cài đặt hệ thống & Cấu hình API mô hình ngôn ngữ (⚙️)"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
          </button>
          <ThemeToggle />
          <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-1"></div>
        </div>

        {/* WINDOW CONTROLS */}
        <div
          className="w-12 h-full flex items-center justify-center hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer group text-slate-700 dark:text-zinc-300"
          onClick={() => {
            getCurrentWindow().minimize().catch((e: any) => alert("Min Error: " + (e.message || e)));
          }}
          title="Thu nhỏ"
        >
          <svg width="10" height="1" viewBox="0 0 10 1" fill="none" className="opacity-50 group-hover:opacity-100 transition-opacity pointer-events-none">
            <rect width="10" height="1" fill="currentColor" />
          </svg>
        </div>
        <div
          className="w-12 h-full flex items-center justify-center hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer group text-slate-700 dark:text-zinc-300"
          onClick={() => {
            getCurrentWindow().toggleMaximize().catch((e: any) => alert("Max Error: " + (e.message || e)));
          }}
          title="Phóng to"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="opacity-50 group-hover:opacity-100 transition-opacity pointer-events-none">
            <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" />
          </svg>
        </div>
        <div
          className="w-12 h-full flex items-center justify-center hover:bg-red-500 text-slate-700 dark:text-zinc-300 hover:text-white transition-colors cursor-pointer group"
          onClick={() => {
            getCurrentWindow().close().catch((e: any) => alert("Close Error: " + (e.message || e)));
          }}
          title="Đóng (Alt+F4)"
        >
          <svg width="10" height="10" viewBox="0 0 14 14" fill="none" className="opacity-50 group-hover:opacity-100 transition-opacity pointer-events-none">
            <path d="M1 1L13 13M1 13L13 1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const { user, licenseKey, isChecking, checkSession, setUser, isLicenseLocked } = useAuthStore();

  useEffect(() => {
    checkSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user || null, session);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [checkSession, setUser]);

  if (isChecking) {
    return <SplashScreen />;
  }

  const isAuthenticated = user && licenseKey;

  return (
    <FileProvider>
      {!isAuthenticated && <LoginScreen />}
      <LicenseLockOverlay />
      {isAuthenticated && <TrialExpiryBanner />}
      <AppInner />
    </FileProvider>
  );
}

function SplashScreen() {
  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center bg-[#1a1a1a] overflow-hidden relative select-none">

      {/* Main Content */}
      <div className="relative z-10 flex flex-col items-center animate-in fade-in zoom-in-95 duration-1000 ease-out fill-mode-both">
        <div className="w-24 h-24 mb-8 rounded-3xl bg-gradient-to-br from-white via-slate-100 to-slate-300 flex items-center justify-center shadow-[0_0_70px_rgba(255,255,255,0.25)] ring-1 ring-white/40 relative overflow-hidden">
           <div className="absolute inset-0 bg-black/5"></div>
           <img 
              src="/logo.png" 
              alt="Logo" 
              className="relative z-10 w-16 h-16 object-contain drop-shadow-md"
              onError={(e) => {
                (e.target as HTMLElement).outerHTML = '<span class="text-[52px] drop-shadow-md relative z-10">📄</span>';
              }}
           />
        </div>
        
        <h1 className="text-5xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-white via-slate-100 to-slate-400 tracking-tight mb-2">
          Hi, I'm PrynX
        </h1>
        
        <p className="text-slate-400 text-xs font-semibold tracking-[0.2em] uppercase mt-8 flex items-center gap-3">
          <span className="w-3.5 h-3.5 border-[2px] border-slate-500/30 border-t-slate-300 rounded-full animate-spin inline-block"></span>
          GETTING READY...
        </p>
      </div>
    </div>
  );
}

function AppInner() {
  const [tabs, setTabs] = useState<AppTab[]>([
    { id: 'home', type: 'home', title: 'Home', isClosable: false }
  ]);
  const [activeTabId, setActiveTabId] = useState<string>('home');
  const [tabToConfirmClose, setTabToConfirmClose] = useState<string | null>(null);
  const [isGlobalSettingsOpen, setIsGlobalSettingsOpen] = useState(false);
  const [isNewDocOpen, setIsNewDocOpen] = useState(false);
  const fileCtx = useFileContext();

  // Warm-up pdfjs worker lúc app rảnh để loại bỏ cold-start vài giây ở lần
  // mở/tạo PDF đầu tiên (qua pdfjs). Chạy nền, không chặn UI.
  useEffect(() => {
    const cancel = scheduleWarmupPdfjs();
    return cancel;
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
    // Check single-instance tools
    const existingId = getExistingInstance(appId, tabs);
    if (existingId) {
      setActiveTabId(existingId);
      return;
    }

    const title = getTabTitle(appId);

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

  // Sync refs safely
  tabsRef.current = tabs;
  activeTabIdRef.current = activeTabId;

  const commitCloseTab = useCallback((id: string) => {
    // Release all blob URLs associated with this tab
    fileCtx.releaseTab(id);

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
        if ((window as any).__TAURI_INTERNALS__) {
          import('@tauri-apps/plugin-dialog').then(async ({ open }) => {
            try {
              const selected = await open({
                multiple: false,
                filters: [{ name: 'Tài liệu & Hình ảnh', extensions: ['pdf', 'png', 'jpg', 'jpeg'] }]
              });
              if (selected && typeof selected === 'string') {
                const { stat } = await import('@tauri-apps/plugin-fs');
                const fileStat = await stat(selected);
                const name = selected.split('\\').pop() || selected.split('/').pop() || 'unknown';
                const lower = name.toLowerCase();
                const type = lower.endsWith('.pdf') ? 'application/pdf' : lower.endsWith('.png') ? 'image/png' : 'image/jpeg';
                const fileObj = new File([], name, { type });
                Object.defineProperty(fileObj, 'path', { value: selected });
                Object.defineProperty(fileObj, 'size', { value: fileStat.size });
                handleOpenApp('imposition', { file: fileObj });
              }
            } catch (err) {
              console.error(err);
            }
          });
        } else {
            document.getElementById('home-generic-pdf-input')?.click();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleCloseTab, handleOpenApp]);

  const accumulatedFiles = useRef<File[]>([]);
  const sysTimeoutRef = useRef<any>(null);

  useEffect(() => {
    const handleSystemFiles = (e: any) => {
      if (e.detail && e.detail.files && e.detail.files.length > 0) {
        accumulatedFiles.current = [...accumulatedFiles.current, ...e.detail.files];

        if (sysTimeoutRef.current) clearTimeout(sysTimeoutRef.current);
        sysTimeoutRef.current = setTimeout(() => {
          const filesToProcess = [...accumulatedFiles.current];
          accumulatedFiles.current = [];
          if (filesToProcess.length > 0) {
            if (filesToProcess.length > 1) {
              if ((window as any).__isBgRemoverActive) {
                  // If BgRemover is active, intercept the drop and send directly to the tool
                  window.dispatchEvent(new CustomEvent('prynx-bgremover-add-files', { detail: { files: filesToProcess } }));
              } else {
                  handleOpenApp('combine_pdf' as AppToolId, {
                    files: filesToProcess
                  });
              }
            } else if ((window as any).__isBgRemoverActive) {
              // Single file dropped while BgRemover is active — route through same event
              window.dispatchEvent(new CustomEvent('prynx-bgremover-add-files', { detail: { files: filesToProcess } }));
            } else {
              // Get current active tab
              const activeTab = tabsRef.current.find(t => t.id === activeTabIdRef.current);
              if (activeTab && activeTab.type !== 'home' && activeTab.type !== 'combine_pdf') {
                // Route the single file to the currently active tab natively
                window.dispatchEvent(new CustomEvent(`send-file-to-tab-${activeTab.id}`, {
                  detail: { file: filesToProcess[0] }
                }));
              } else {
                handleOpenApp('imposition', {
                  file: filesToProcess[0],
                });
              }
            }
          }
        }, 50); // Reduced delay for drag-and-drop snappiness
      }
    };
    window.addEventListener('system-files-received', handleSystemFiles);
    return () => window.removeEventListener('system-files-received', handleSystemFiles);
  }, [handleOpenApp]);

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-[#e6e8eb] dark:bg-[#1a1a1a] select-none text-slate-800 dark:text-zinc-200 relative">
      <SystemIntegrations />
      <UpdateChecker />

      <TitleBar onOpenSettings={() => setIsGlobalSettingsOpen(true)} />

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
                  : 'bg-transparent border-transparent text-slate-600 dark:text-zinc-400 hover:bg-[#e0e2e5] dark:hover:bg-[#1f2937] z-0'}
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
              onClick={() => setActiveTabId(tab.id)}
              className={`
                group relative flex items-center justify-between min-w-[140px] max-w-[200px] h-[30px] pl-3 pr-2 
                rounded-t-lg transition-colors cursor-default border border-b-0
                ${isActive
                  ? 'bg-[#e6e8eb] dark:bg-[#1a1a1a] border-black/10 dark:border-white/10 shadow-[0_-2px_6px_rgba(0,0,0,0.03)] text-slate-900 dark:text-white font-semibold z-10'
                  : 'bg-[#e6e8eb]/50 dark:bg-[#1a1a1a]/50 border-black/5 dark:border-white/5 text-slate-500 dark:text-zinc-400 hover:bg-[#e0e2e5] dark:hover:bg-[#1f2937] z-0'}
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
            {tab.type === 'home' && <HomeTab onOpenApp={handleOpenApp} />}
            {tab.type !== 'home' && (() => {
              const toolDef = TOOL_REGISTRY.find(t => t.id === tab.type && t.isEnabled);
              if (!toolDef) return <div className="flex items-center justify-center h-full text-slate-400">Công cụ không tìm thấy</div>;
              const ToolComponent = toolDef.component;
              // Imposition tabs get special props
              if (tab.type === 'imposition') {
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
                      batchOutput={tab.payload?.batchOutput}
                      systemMergeFiles={tab.payload?.systemMergeFiles}
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
                    />
                  </Suspense>
                );
              }
              return (
                <Suspense fallback={<div className="flex items-center justify-center h-full"><div className="w-8 h-8 border-3 border-indigo-400 border-t-transparent rounded-full animate-spin" /></div>}>
                  <ToolComponent />
                </Suspense>
              );
            })()}
          </div>
        ))}
      </div>

      <ConfirmCloseModal
        isOpen={tabToConfirmClose !== null}
        fileName={tabs.find(t => t.id === tabToConfirmClose)?.title || 'Chưa rõ tên'}
        onConfirm={() => {
          if (tabToConfirmClose) commitCloseTab(tabToConfirmClose);
        }}
        onCancel={() => setTabToConfirmClose(null)}
      />

      {isGlobalSettingsOpen && (
        <SettingsModal onClose={() => setIsGlobalSettingsOpen(false)} />
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

function ConfirmCloseModal({ isOpen, fileName, onConfirm, onCancel }: { isOpen: boolean, fileName: string, onConfirm: () => void, onCancel: () => void }) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isOpen && e.key === 'Escape') onCancel();
    };
    if (isOpen) document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-zinc-800 p-6 rounded-lg shadow-2xl max-w-sm w-full mx-4 border border-rose-500/30">
        <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2">Cảnh báo chưa lưu</h3>
        <p className="text-sm text-slate-600 dark:text-zinc-300 mb-6 font-medium">
          File <span className="text-rose-500 font-bold px-1 break-all">{fileName}</span> chưa được lưu vào máy. Nếu đóng, bạn sẽ mất thành quả file này.
          <br /><br />
          Bạn có chắc chắn muốn đóng tab này không?
        </p>
        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-6 py-2.5 min-w-[100px] text-[15px] font-semibold rounded bg-slate-100 hover:bg-slate-200 dark:bg-zinc-700 dark:hover:bg-zinc-600 text-slate-700 dark:text-zinc-200 transition-colors focus:outline-none"
          >
            Hủy bỏ
          </button>
          <button
            onClick={onConfirm}
            className="px-6 py-2.5 min-w-[100px] text-[15px] font-bold rounded bg-rose-500 hover:bg-rose-600 text-white transition-colors shadow-sm focus:outline-none"
          >
            Vẫn Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
