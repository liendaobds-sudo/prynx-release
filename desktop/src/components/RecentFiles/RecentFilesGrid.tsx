import React, { useState } from 'react';
import { useRecentFiles, statRecentFile, type RecentFile } from '../../lib/useRecentFiles';
import ThumbnailView from './ThumbnailView';
import { systemFileMime } from '../../lib/nativeFileAccess';
import { useAppSettingsStore } from '../../stores/appSettingsStore';
import { toast } from '../ui/Toast';
import { useTranslation } from 'react-i18next';

interface Props {
  onOpenFile: (file: File) => void;
  active?: boolean;
}

export default function RecentFilesGrid({ onOpenFile, active = true }: Props) {
  const { t } = useTranslation();
  const { files, toggleStar, removeFile, clearUnstarred, removeFiles } = useRecentFiles();
  const [activeTab, setActiveTab] = useState<'recent' | 'starred'>('recent');
  const { recentFilesViewMode, setRecentFilesViewMode } = useAppSettingsStore();
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

  const displayFiles = activeTab === 'recent' 
    ? files 
    : files.filter(f => f.isStarred);

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (isToday) return `Today, ${timeStr}`;
    return `${d.toLocaleDateString()}, ${timeStr}`;
  };

  const formatSize = (bytes: number) => {
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  };

  const handleToggleSelect = (path: string) => {
    const newPaths = new Set(selectedPaths);
    if (newPaths.has(path)) newPaths.delete(path);
    else newPaths.add(path);
    setSelectedPaths(newPaths);
  };

  const handleSelectAll = () => {
    if (selectedPaths.size === displayFiles.length) {
      setSelectedPaths(new Set());
    } else {
      setSelectedPaths(new Set(displayFiles.map(f => f.path)));
    }
  };

  const handleDeleteSelected = () => {
    if (selectedPaths.size === 0) return;
    removeFiles(Array.from(selectedPaths));
    setSelectedPaths(new Set());
    setIsSelectMode(false);
  };

  const handleItemClick = async (rf: RecentFile) => {
    if (isSelectMode) {
      handleToggleSelect(rf.path);
      return;
    }
    if (window.__TAURI_INTERNALS__) {
      // §RF.1 (audit menu 2026-07-28): stat qua helper dùng chung của store, không tự
      // import plugin-fs ở đây nữa — cờ "file đã mất" nhờ vậy dùng chung với thumbnail
      // và menu Mở gần đây.
      const info = await statRecentFile(rf.path);
      if (!info) {
        // UIUX (audit 2026-07-27 §D-13): câu Việt qua i18n thay chuỗi tiếng Anh hardcode
        toast.error(t('misc.recentFilesGrid:file_da_di_chuyen') + '\n' + rf.path);
        removeFile(rf.path);
        return;
      }
      const fileObj = new File([], rf.name, { type: systemFileMime(rf.name) });
      Object.defineProperty(fileObj, 'path', { value: rf.path });
      Object.defineProperty(fileObj, 'size', { value: info.size });

      onOpenFile(fileObj);
    }
  };

  if (files.length === 0) return null;

  return (
    <div className="w-full mt-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      
      {/* Header Tabs / Action Bar */}
      {isSelectMode ? (
        <div className="flex items-center justify-between mb-6 px-4 py-3 bg-indigo-50 dark:bg-indigo-950/30 rounded-xl border border-indigo-100 dark:border-indigo-900/50">
          <div className="flex items-center gap-4">
            <span className="text-sm font-bold text-indigo-700 dark:text-indigo-400">
              {t('misc.recentFilesGrid:da_chon_n_muc', { n: selectedPaths.size })}
            </span>
            <button onClick={handleSelectAll} className="text-sm font-medium text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300 transition-colors">
              {selectedPaths.size === displayFiles.length ? t('misc.recentFilesGrid:bo_chon_tat_ca') : t('misc.recentFilesGrid:chon_tat_ca')}
            </button>
          </div>
          <div className="flex items-center gap-3">
            <button 
              onClick={handleDeleteSelected}
              disabled={selectedPaths.size === 0}
              className={`px-4 py-1.5 rounded-lg text-sm font-bold transition-colors ${selectedPaths.size > 0 ? 'bg-rose-500 hover:bg-rose-600 text-white shadow-sm' : 'bg-slate-200 dark:bg-zinc-800 text-slate-400 cursor-not-allowed'}`}
            >
              {t('misc.recentFilesGrid:xoa_da_chon')}
            </button>
            <button 
              onClick={() => { setIsSelectMode(false); setSelectedPaths(new Set()); }}
              className="px-4 py-1.5 rounded-lg text-sm font-bold bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 text-slate-600 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-700 transition-colors shadow-sm"
            >
              {t('misc.recentFilesGrid:huy')}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between mb-6 border-b border-slate-200 dark:border-zinc-800">
          <div className="flex gap-6">
            <button 
              onClick={() => setActiveTab('recent')}
              className={`pb-3 text-[15px] font-bold border-b-2 transition-colors ${activeTab === 'recent' ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400' : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-zinc-300'}`}
            >
              {t('misc.recentFilesGrid:mo_gan_day')}
            </button>
            <button 
              onClick={() => setActiveTab('starred')}
              className={`pb-3 text-[15px] font-bold border-b-2 transition-colors flex items-center gap-1.5 ${activeTab === 'starred' ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400' : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-zinc-300'}`}
            >
              {t('misc.recentFilesGrid:da_gan_dau_sao')}
            </button>
          </div>
          
          <div className="flex items-center gap-2">
            <button 
              onClick={() => setIsSelectMode(true)}
              className="px-3 py-1.5 text-xs font-bold bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-slate-600 dark:text-zinc-300 rounded-md transition-colors mr-2 flex items-center gap-1.5"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>
              {t('misc.recentFilesGrid:chon_nhieu')}
            </button>
          <div className="flex bg-slate-100 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-lg p-0.5 mr-2">
            <button onClick={() => setRecentFilesViewMode('grid')} className={`p-1.5 rounded-md transition-colors ${recentFilesViewMode === 'grid' ? 'bg-white dark:bg-zinc-700 shadow-sm text-indigo-600 dark:text-indigo-400' : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-white'}`} title={t('misc.recentFilesGrid:dang_luoi_grid')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="14" width="7" height="7" rx="1"></rect><rect x="3" y="14" width="7" height="7" rx="1"></rect></svg>
            </button>
            <button onClick={() => setRecentFilesViewMode('list')} className={`p-1.5 rounded-md transition-colors ${recentFilesViewMode === 'list' ? 'bg-white dark:bg-zinc-700 shadow-sm text-indigo-600 dark:text-indigo-400' : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-white'}`} title={t('misc.recentFilesGrid:dang_danh_sach_list')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>
            </button>
            <button onClick={() => setRecentFilesViewMode('details')} className={`p-1.5 rounded-md transition-colors ${recentFilesViewMode === 'details' ? 'bg-white dark:bg-zinc-700 shadow-sm text-indigo-600 dark:text-indigo-400' : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-white'}`} title={t('misc.recentFilesGrid:dang_chi_tiet_details')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M4 6h16M4 12h16M4 18h16"></path></svg>
            </button>
          </div>
          {activeTab === 'recent' && (
            <button 
              onClick={clearUnstarred}
              className="text-xs font-medium text-slate-400 hover:text-rose-500 transition-colors"
            >
              {t('misc.recentFilesGrid:xoa_lich_su_giu_lai_sao')}
            </button>
          )}
        </div>
      </div>
      )}

      {/* Grid */}
      {displayFiles.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-slate-400">
          <div className="text-4xl mb-3 opacity-50">⭐</div>
          <p>{t('misc.recentFilesGrid:chua_co_tep_nao_duoc_gan_dau_sao')}</p>
        </div>
      ) : (
        <>
          {recentFilesViewMode === 'grid' && (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-5 pb-12">
              {displayFiles.map(file => {
                const isSelected = selectedPaths.has(file.path);
                return (
                <div 
                  key={file.path} 
                  className={`group relative bg-white dark:bg-zinc-900 rounded-xl border ${isSelected ? 'border-indigo-500 ring-1 ring-indigo-500 shadow-md bg-indigo-50/10' : 'border-slate-200 dark:border-white/10 shadow-sm hover:shadow-xl hover:shadow-indigo-500/10 hover:border-indigo-500/50'} transition-all cursor-pointer overflow-hidden flex flex-col`}
                  onClick={() => handleItemClick(file)}
                >
                  {isSelectMode && (
                    <div className="absolute top-2 left-2 z-10 pointer-events-none">
                      <div className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${isSelected ? 'bg-indigo-500 border-indigo-500 text-white' : 'bg-white/90 border-slate-300 dark:border-zinc-500'}`}>
                        {isSelected && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4"><polyline points="20 6 9 17 4 12"></polyline></svg>}
                      </div>
                    </div>
                  )}
                  <div className={`relative h-[160px] w-full bg-slate-50 dark:bg-zinc-800 flex items-center justify-center overflow-hidden border-b border-slate-100 dark:border-white/5 ${isSelected ? 'opacity-90' : ''}`}>
                    <ThumbnailView path={file.path} name={file.name} active={active} />
                    {!isSelectMode && (
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-start justify-between p-2">
                      <button 
                        onClick={(e) => { e.stopPropagation(); toggleStar(file.path); }}
                        className={`w-8 h-8 flex items-center justify-center rounded-full bg-white/20 backdrop-blur-md hover:bg-white/40 transition-colors ${file.isStarred ? 'text-amber-400' : 'text-white'}`}
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill={file.isStarred ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
                      </button>
                      <button 
                        onClick={(e) => { e.stopPropagation(); removeFile(file.path); }}
                        className="w-8 h-8 flex items-center justify-center rounded-full bg-white/20 backdrop-blur-md hover:bg-rose-500/80 transition-colors text-white"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12"></path></svg>
                      </button>
                    </div>
                    )}
                    {file.isStarred && !isSelectMode && (
                      <div className="absolute top-2 left-2 text-amber-400 drop-shadow-md group-hover:hidden">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
                      </div>
                    )}
                  </div>
                  <div className="p-3 flex flex-col gap-1">
                    <div className="text-sm font-bold text-slate-800 dark:text-white truncate" title={file.name}>{file.name}</div>
                    <div className="flex justify-between items-center text-[11px] text-slate-500 font-medium">
                      <span>{formatSize(file.size)}</span>
                      <span>{formatTime(file.timestamp)}</span>
                    </div>
                  </div>
                </div>
              )})}
            </div>
          )}

          {recentFilesViewMode === 'list' && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 pb-12">
              {displayFiles.map(file => {
                const isSelected = selectedPaths.has(file.path);
                return (
                <div 
                  key={file.path} 
                  className={`group flex items-center bg-white dark:bg-zinc-900 rounded-lg border ${isSelected ? 'border-indigo-500 ring-1 ring-indigo-500 shadow-md bg-indigo-50/10' : 'border-slate-200 dark:border-white/10 shadow-sm hover:shadow-md hover:border-indigo-500/50'} transition-all cursor-pointer p-2 gap-3 relative`} 
                  onClick={() => handleItemClick(file)}
                >
                  {isSelectMode && (
                    <div className="shrink-0 flex items-center pl-1">
                      <div className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${isSelected ? 'bg-indigo-500 border-indigo-500 text-white' : 'bg-white border-slate-300 dark:bg-zinc-800 dark:border-zinc-500'}`}>
                        {isSelected && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4"><polyline points="20 6 9 17 4 12"></polyline></svg>}
                      </div>
                    </div>
                  )}
                  <div className={`relative w-12 h-12 rounded bg-slate-50 dark:bg-zinc-800 flex items-center justify-center overflow-hidden shrink-0 border border-slate-100 dark:border-white/5 ${isSelected ? 'opacity-90' : ''}`}>
                      <ThumbnailView path={file.path} name={file.name} active={active} />
                  </div>
                  <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-bold text-slate-800 dark:text-white truncate" title={file.name}>{file.name}</div>
                      <div className="text-[11px] text-slate-500 font-medium truncate">{formatSize(file.size)} • {formatTime(file.timestamp)}</div>
                  </div>
                  {!isSelectMode && (
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={(e) => { e.stopPropagation(); toggleStar(file.path); }} className={`p-1.5 rounded hover:bg-slate-100 dark:hover:bg-zinc-800 ${file.isStarred ? 'text-amber-400' : 'text-slate-400'}`}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill={file.isStarred ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); removeFile(file.path); }} className="p-1.5 rounded hover:bg-rose-50 dark:hover:bg-rose-900/20 text-slate-400 hover:text-rose-500">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12"></path></svg>
                      </button>
                    </div>
                  )}
                  {/* Persistent star */}
                  {file.isStarred && !isSelectMode && (
                    <div className="absolute right-3 text-amber-400 drop-shadow-md group-hover:hidden">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
                    </div>
                  )}
                </div>
              )})}
            </div>
          )}

          {recentFilesViewMode === 'details' && (
            <div className="flex flex-col bg-white dark:bg-zinc-900 rounded-xl border border-slate-200 dark:border-white/10 shadow-sm overflow-hidden mb-12">
              <div className="flex items-center px-4 py-3 bg-slate-50 dark:bg-zinc-800/50 border-b border-slate-200 dark:border-white/10 text-xs font-bold text-slate-500 dark:text-zinc-400">
                <div className="flex-[3] min-w-0">{t('misc.recentFilesGrid:ten_file')}</div>
                <div className="flex-1 min-w-0 hidden sm:block">{t('misc.recentFilesGrid:kich_thuoc')}</div>
                <div className="flex-[1.5] min-w-0 hidden md:block">{t('misc.recentFilesGrid:thoi_gian_mo')}</div>
                <div className="w-20 shrink-0 text-right"></div>
              </div>
              <div className="flex flex-col divide-y divide-slate-100 dark:divide-white/5">
                {displayFiles.map(file => {
                  const isSelected = selectedPaths.has(file.path);
                  return (
                  <div key={file.path} className={`group relative flex items-center px-4 py-2 hover:bg-slate-50 dark:hover:bg-zinc-800/50 transition-colors cursor-pointer ${isSelected ? 'bg-indigo-50/30 dark:bg-indigo-900/10' : ''}`} onClick={() => handleItemClick(file)}>
                    <div className="flex-[3] min-w-0 flex items-center gap-3">
                      {isSelectMode && (
                        <div className="shrink-0 flex items-center">
                          <div className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${isSelected ? 'bg-indigo-500 border-indigo-500 text-white' : 'bg-white border-slate-300 dark:bg-zinc-800 dark:border-zinc-500'}`}>
                            {isSelected && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4"><polyline points="20 6 9 17 4 12"></polyline></svg>}
                          </div>
                        </div>
                      )}
                      <div className={`w-8 h-8 rounded bg-slate-100 dark:bg-zinc-800 flex items-center justify-center overflow-hidden shrink-0 border border-slate-200 dark:border-white/5 ${isSelected ? 'opacity-90' : ''}`}>
                          <ThumbnailView path={file.path} name={file.name} active={active} />
                      </div>
                      <span className={`text-sm font-semibold truncate ${isSelected ? 'text-indigo-700 dark:text-indigo-300' : 'text-slate-700 dark:text-zinc-200'}`} title={file.name}>{file.name}</span>
                    </div>
                    <div className="flex-1 min-w-0 text-[13px] text-slate-500 hidden sm:block">{formatSize(file.size)}</div>
                    <div className="flex-[1.5] min-w-0 text-[13px] text-slate-500 hidden md:block">{formatTime(file.timestamp)}</div>
                    
                    {!isSelectMode && (
                      <div className="w-20 shrink-0 flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button onClick={(e) => { e.stopPropagation(); toggleStar(file.path); }} className={`p-1.5 rounded hover:bg-slate-200 dark:hover:bg-zinc-700 ${file.isStarred ? 'text-amber-500' : 'text-slate-400'}`}>
                             <svg width="16" height="16" viewBox="0 0 24 24" fill={file.isStarred ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
                         </button>
                         <button onClick={(e) => { e.stopPropagation(); removeFile(file.path); }} className="p-1.5 rounded hover:bg-rose-100 dark:hover:bg-rose-900/30 text-slate-400 hover:text-rose-600">
                             <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12"></path></svg>
                         </button>
                      </div>
                    )}
                    {/* Persistent star */}
                    {file.isStarred && !isSelectMode && (
                      <div className="absolute right-6 text-amber-400 drop-shadow-md group-hover:hidden">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
                      </div>
                    )}
                  </div>
                )})}
              </div>
            </div>
          )}
        </>
      )}

    </div>
  );
}
