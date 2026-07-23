import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { relaunch } from '@tauri-apps/plugin-process';
import { open } from '@tauri-apps/plugin-dialog';

import { useAppSettingsStore } from '../stores/appSettingsStore';
import { TOOL_CATEGORIES, getToolsByCategory, getToolUniqueKey } from '../lib/toolRegistry';
import { Button } from './Button';

import CutterMachinesPanel from './imposition-tools/cut-export/CutterMachinesPanel';
import { Star, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { tv } from '../i18n';
import { KEYBOARD_SHORTCUTS, SHORTCUT_GROUPS } from '../lib/keyboardShortcuts';

type SettingsTab = 'tools' | 'export' | 'workspace' | 'shortcuts' | 'cutter';

interface SettingsModalProps {
  onClose: () => void;
  /** Tab mở sẵn khi vào (VD từ menu Help > Phím tắt). Mặc định 'tools'. */
  initialTab?: SettingsTab;
}

export default function SettingsModal({ onClose, initialTab = 'tools' }: SettingsModalProps) {
  const { t } = useTranslation();
  const { 
    hiddenTools, toggleToolVisibility, favoriteTools, toggleFavoriteTool,
    defaultExportPath, setDefaultExportPath,
    autoRenameFormat, setAutoRenameFormat,
    measurementUnit, setMeasurementUnit,
    previewQuality, setPreviewQuality,
    showMenuBar, setShowMenuBar
  } = useAppSettingsStore();

  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-modal bg-slate-900/40 dark:bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div role="dialog" aria-modal="true" aria-label={t('settings:cai_dat')} className="glass-card w-full max-w-4xl h-[600px] flex flex-row rounded-2xl shadow-2xl relative border border-slate-200 animate-fade-in transition-colors overflow-hidden">
        
        {/* Left Sidebar */}
        <div className="w-64 bg-slate-50 dark:bg-zinc-800/80 border-r border-slate-200 dark:border-white/10 flex flex-col z-10 flex-shrink-0">
          <div className="p-5 border-b border-slate-200 dark:border-white/10 flex items-center justify-between">
             <h2 className="text-lg font-bold text-slate-900 dark:text-white transition-colors">⚙️ Preferences</h2>
          </div>
          <div className="flex-1 py-4 flex flex-col gap-1 px-3">
             <button onClick={() => setActiveTab('tools')} className={`text-left px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${activeTab === 'tools' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300' : 'text-slate-600 hover:bg-slate-200/50 dark:text-zinc-400 dark:hover:bg-zinc-700/50 dark:hover:text-zinc-200'}`}>{t('settings:quan_ly_cong_cu')}</button>
             <button onClick={() => setActiveTab('export')} className={`text-left px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${activeTab === 'export' ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300' : 'text-slate-600 hover:bg-slate-200/50 dark:text-zinc-400 dark:hover:bg-zinc-700/50 dark:hover:text-zinc-200'}`}>{t('settings:luu_tru_dau_ra')}</button>
             <button onClick={() => setActiveTab('workspace')} className={`text-left px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${activeTab === 'workspace' ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300' : 'text-slate-600 hover:bg-slate-200/50 dark:text-zinc-400 dark:hover:bg-zinc-700/50 dark:hover:text-zinc-200'}`}>{t('settings:khong_gian_lam_viec')}</button>
             <button onClick={() => setActiveTab('shortcuts')} className={`text-left px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${activeTab === 'shortcuts' ? 'bg-cyan-100 text-cyan-700 dark:bg-cyan-500/20 dark:text-cyan-300' : 'text-slate-600 hover:bg-slate-200/50 dark:text-zinc-400 dark:hover:bg-zinc-700/50 dark:hover:text-zinc-200'}`}>{t('settings:phim_tat_he_thong')}</button>
             {/* Tab "Máy bế" (kết nối TCP/serial) ĐÃ ẨN — kênh chưa kiểm chứng end-to-end;
                 workflow thay thế = mở trang khuôn bằng AI/Corel. Giữ code CutterMachinesPanel,
                 chỉ bỏ lối vào. Bật lại: khôi phục nút này + phần render bên dưới.
             <button onClick={() => setActiveTab('cutter')} className={`text-left px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${activeTab === 'cutter' ? 'bg-pink-100 text-pink-700 dark:bg-pink-500/20 dark:text-pink-300' : 'text-slate-600 hover:bg-slate-200/50 dark:text-zinc-400 dark:hover:bg-zinc-700/50 dark:hover:text-zinc-200'}`}>{t('settings:may_be')}</button> */}
          </div>
        </div>

        {/* Right Content */}
        <div className="flex-1 flex flex-col bg-white dark:bg-zinc-900/90 relative">
          <button 
            onClick={onClose}
            className="absolute top-4 right-4 text-slate-400 dark:text-zinc-500 hover:text-slate-900 dark:hover:text-white w-8 h-8 rounded-full bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 flex items-center justify-center transition-colors z-20"
            title={t('settings:dong')}
            aria-label={t('settings:dong')}
          >
            <X className="w-4 h-4" />
          </button>
          
          <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">

            {activeTab === 'tools' && (
              <div className="animate-fade-in flex flex-col h-full">
                <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2 transition-colors">{t('settings:quan_ly_hien_thi_cong_cu')}</h3>
                <p className="text-sm text-slate-500 dark:text-zinc-400 mb-8 leading-relaxed transition-colors shrink-0">
                  {t('settings:bat_tat_cac_cong_cu_khong_su_dung_de')}
                </p>

                <div className="space-y-6 flex-1 pr-4">
                  {TOOL_CATEGORIES.map(category => {
                    const tools = getToolsByCategory(category.id as any);
                    if (tools.length === 0) return null;
                    
                    return (
                      <div key={category.id} className="mb-6">
                        <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-3">
                          {tv(category.title)}
                        </div>
                        <div className="flex flex-col gap-1">
                          {tools.map(tool => {
                            const uniqueKey = getToolUniqueKey(tool);
                            const isHidden = hiddenTools.includes(uniqueKey);
                            
                            return (
                              <div key={uniqueKey} className="flex items-center p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-default transition-colors border border-transparent hover:border-slate-200 dark:hover:border-zinc-700">
                                <div className="text-[20px] w-8 flex justify-center opacity-80">{tool.icon}</div>
                                <div className="flex-1 min-w-0 ml-2">
                                  <div className={`text-[14px] font-medium ${isHidden ? 'text-slate-400' : 'text-slate-800 dark:text-zinc-200'}`}>
                                    {tv(tool.title)}
                                  </div>
                                </div>
                                <div className="flex items-center gap-3 ml-3">
                                  <button
                                    onClick={() => toggleFavoriteTool(uniqueKey)}
                                    className={`flex items-center justify-center transition-all duration-200 hover:scale-110 active:scale-95 ${
                                      favoriteTools.includes(uniqueKey)
                                        ? 'text-amber-400'
                                        : 'text-slate-300 dark:text-zinc-600 hover:text-amber-400'
                                    }`}
                                    title={favoriteTools.includes(uniqueKey) ? t('settings:bo_yeu_thich') : t('settings:them_vao_yeu_thich')}
                                  >
                                    <Star className="w-5 h-5" fill={favoriteTools.includes(uniqueKey) ? 'currentColor' : 'none'} />
                                  </button>
                                  <label className="relative flex items-center cursor-pointer group flex-shrink-0">
                                    <input 
                                      type="checkbox" 
                                      className="sr-only peer" 
                                      checked={!isHidden}
                                      onChange={() => toggleToolVisibility(uniqueKey)}
                                    />
                                    <div className="w-11 h-6 bg-slate-200 dark:!bg-zinc-700 border border-slate-300 dark:!border-white/10 rounded-lg peer-checked:bg-emerald-500 peer-checked:border-emerald-600 shadow-inner transition-all duration-300"></div>
                                    <div className="absolute left-[3px] top-[3px] bg-white dark:bg-zinc-200 rounded-md h-[18px] w-[18px] shadow-sm transform transition-transform duration-300 peer-checked:translate-x-[20px]"></div>
                                  </label>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {activeTab === 'export' && (
              <div className="animate-fade-in flex flex-col h-full">
                <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">{t('settings:luu_tru_dau_ra_2')}</h3>
                <p className="text-sm text-slate-500 dark:text-zinc-400 mb-8 leading-relaxed shrink-0">
                  {t('settings:cau_hinh_duong_dan_xuat_file_mac_dinh')}
                </p>

                <div className="space-y-6 flex-1 pr-4">
                  <div className="bg-slate-50 dark:bg-zinc-800/40 border border-slate-200 dark:border-white/10 rounded-xl p-5">
                    <h4 className="text-sm font-bold text-slate-800 dark:text-zinc-200 mb-4">{t('settings:vi_tri_luu_mac_dinh')}</h4>
                    <div className="flex gap-2">
                      <div className="flex-1 bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-lg px-3 py-2 text-sm text-slate-600 dark:text-zinc-300 flex items-center overflow-hidden text-ellipsis whitespace-nowrap">
                        {defaultExportPath || t('settings:chua_thiet_lap_luon_hoi_khi_luu')}
                      </div>
                      <Button 
                        variant="secondary"
                        onClick={async () => {
                          const selected = await open({
                            directory: true,
                            multiple: false,
                            title: t('settings:chon_thu_muc_luu_mac_dinh')
                          });
                          if (selected && typeof selected === 'string') {
                            setDefaultExportPath(selected);
                          }
                        }}
                      >
                        {t('settings:chon_thu_muc')}
                      </Button>
                      {defaultExportPath && (
                        <Button 
                          variant="destructive" 
                          onClick={() => setDefaultExportPath(null)}
                          title={t('settings:xoa_mac_dinh')}
                          aria-label={t('settings:xoa_mac_dinh')}
                        >
                          <X className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </div>

                  <div className="bg-slate-50 dark:bg-zinc-800/40 border border-slate-200 dark:border-white/10 rounded-xl p-5">
                    <h4 className="text-sm font-bold text-slate-800 dark:text-zinc-200 mb-4">{t('settings:quy_tac_tu_doi_ten_file_auto_rename')}</h4>
                    <input 
                      type="text" 
                      value={autoRenameFormat}
                      onChange={(e) => setAutoRenameFormat(e.target.value)}
                      placeholder="{original}_PrynX"
                      className="w-full bg-white dark:!bg-zinc-900 text-slate-900 dark:!text-white text-sm rounded-lg border border-slate-300 dark:!border-white/20 px-3 py-2 outline-none focus:border-indigo-500 shadow-sm transition-colors mb-3"
                    />
                    <div className="text-xs text-slate-500 dark:text-zinc-400 bg-slate-200/50 dark:bg-zinc-800/50 p-3 rounded-lg border border-slate-200 dark:border-white/5">
                      <span className="font-semibold block mb-1">{t('settings:vi_du')}</span>
                      {t('settings:file_goc')} <code className="text-slate-700 dark:text-zinc-300">BaoBi_KhachHang.pdf</code><br/>
                      {t('settings:sau_khi_xu_ly')} <code className="text-indigo-600 dark:text-indigo-400">{autoRenameFormat.replace('{original}', 'BaoBi_KhachHang')}.pdf</code>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'workspace' && (
              <div className="animate-fade-in flex flex-col h-full">
                <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">{t('settings:khong_gian_lam_viec_2')}</h3>
                <p className="text-sm text-slate-500 dark:text-zinc-400 mb-8 leading-relaxed shrink-0">
                  {t('settings:cau_hinh_he_do_luong_va_chat_luong_hien')}
                </p>

                <div className="space-y-6 flex-1 pr-4">
                  <div className="bg-slate-50 dark:bg-zinc-800/40 border border-slate-200 dark:border-white/10 rounded-xl p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <h4 className="text-sm font-bold text-slate-800 dark:text-zinc-200">{t('settings:thanh_menu_file_edit_view')}</h4>
                        <p className="text-[12px] text-slate-500 dark:text-zinc-400 mt-1 leading-snug">
                          {t('settings:hien_thanh_menu_ngang_kieu_acrobat_cho')}
                        </p>
                      </div>
                      <label className="relative flex items-center cursor-pointer group shrink-0 mt-0.5">
                        <input
                          type="checkbox"
                          className="sr-only peer"
                          checked={showMenuBar}
                          onChange={() => setShowMenuBar(!showMenuBar)}
                        />
                        <div className="w-11 h-6 bg-slate-200 dark:!bg-zinc-700 border border-slate-300 dark:!border-white/10 rounded-lg peer-checked:bg-emerald-500 peer-checked:border-emerald-600 shadow-inner transition-all duration-300"></div>
                        <div className="absolute left-[3px] top-[3px] bg-white dark:bg-zinc-200 rounded-md h-[18px] w-[18px] shadow-sm transform transition-transform duration-300 peer-checked:translate-x-[20px]"></div>
                      </label>
                    </div>
                  </div>

                  <div className="bg-slate-50 dark:bg-zinc-800/40 border border-slate-200 dark:border-white/10 rounded-xl p-5">
                    <h4 className="text-sm font-bold text-slate-800 dark:text-zinc-200 mb-4">{t('settings:don_vi_do_luong_mac_dinh')}</h4>
                    <div className="flex gap-4">
                      {['mm', 'cm', 'inch'].map(unit => (
                        <label 
                          key={unit} 
                          className="flex items-center gap-2 cursor-pointer group"
                          onClick={() => setMeasurementUnit(unit as any)}
                        >
                          <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${measurementUnit === unit ? 'border-amber-500' : 'border-slate-300 dark:border-zinc-600 group-hover:border-amber-400'}`}>
                            {measurementUnit === unit && <div className="w-2.5 h-2.5 rounded-full bg-amber-500" />}
                          </div>
                          <span className={`text-sm font-medium uppercase ${measurementUnit === unit ? 'text-slate-900 dark:text-white' : 'text-slate-600 dark:text-zinc-400'}`}>
                            {unit}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="bg-slate-50 dark:bg-zinc-800/40 border border-slate-200 dark:border-white/10 rounded-xl p-5">
                    <h4 className="text-sm font-bold text-slate-800 dark:text-zinc-200 mb-4">{t('settings:chat_luong_preview_pdf')}</h4>
                    <div className="flex flex-col gap-3">
                      <label 
                        className="flex items-start gap-3 cursor-pointer group p-3 rounded-lg hover:bg-slate-100 dark:hover:bg-zinc-800/50 transition-colors border border-transparent hover:border-slate-200 dark:hover:border-zinc-700"
                        onClick={() => setPreviewQuality('high')}
                      >
                        <div className={`mt-0.5 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors shrink-0 ${previewQuality === 'high' ? 'border-amber-500' : 'border-slate-300 dark:border-zinc-600 group-hover:border-amber-400'}`}>
                          {previewQuality === 'high' && <div className="w-2.5 h-2.5 rounded-full bg-amber-500" />}
                        </div>
                        <div>
                          <div className={`text-sm font-bold ${previewQuality === 'high' ? 'text-slate-900 dark:text-white' : 'text-slate-700 dark:text-zinc-300'}`}>{t('settings:chat_luong_cao_net_cang')}</div>
                          <div className="text-[11px] text-slate-500 mt-0.5">{t('settings:render_sac_net_tung_vector_dung_cho_soi')}</div>
                        </div>
                      </label>
                      <label 
                        className="flex items-start gap-3 cursor-pointer group p-3 rounded-lg hover:bg-slate-100 dark:hover:bg-zinc-800/50 transition-colors border border-transparent hover:border-slate-200 dark:hover:border-zinc-700"
                        onClick={() => setPreviewQuality('fast')}
                      >
                        <div className={`mt-0.5 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors shrink-0 ${previewQuality === 'fast' ? 'border-amber-500' : 'border-slate-300 dark:border-zinc-600 group-hover:border-amber-400'}`}>
                          {previewQuality === 'fast' && <div className="w-2.5 h-2.5 rounded-full bg-amber-500" />}
                        </div>
                        <div>
                          <div className={`text-sm font-bold ${previewQuality === 'fast' ? 'text-slate-900 dark:text-white' : 'text-slate-700 dark:text-zinc-300'}`}>{t('settings:toc_do_nhanh_low_res')}</div>
                          <div className="text-[11px] text-slate-500 mt-0.5">{t('settings:giam_chat_luong_render_de_xem_truoc_pdf')}</div>
                        </div>
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'shortcuts' && (
              <div className="animate-fade-in flex flex-col h-full">
                <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">{t('settings:phim_tat_he_thong_2')}</h3>
                <p className="text-sm text-slate-500 dark:text-zinc-400 mb-8 leading-relaxed shrink-0">
                  {t('settings:bang_tra_cuu_nhanh_cac_phim_tat_lam')}
                </p>

                <div className="space-y-2 flex-1 pr-4 overflow-y-auto custom-scrollbar pb-10">
                  {SHORTCUT_GROUPS.map((group) => (
                    <section key={group.id} className="space-y-2 pb-3">
                      <h4 className="sticky top-0 z-10 py-2 bg-white/95 dark:bg-zinc-900/95 backdrop-blur text-xs font-bold uppercase tracking-wider text-cyan-700 dark:text-cyan-300">
                        {t(`settings:${group.labelKey}`)}
                      </h4>
                      {KEYBOARD_SHORTCUTS.filter((shortcut) => shortcut.group === group.id).map((shortcut) => (
                        <div key={shortcut.id} className="flex items-center justify-between gap-4 p-3 rounded-lg bg-slate-50 dark:bg-zinc-800/40 border border-slate-200 dark:border-white/5 hover:border-cyan-500/30 transition-colors">
                          <span className="text-sm font-medium text-slate-700 dark:text-zinc-300">
                            {t(`settings:${shortcut.descriptionKey}`)}
                          </span>
                          <div className="flex gap-1.5 flex-wrap justify-end shrink-0">
                            {shortcut.keys.map((key) => (
                              <kbd key={key} className="px-2 py-1 bg-white dark:bg-zinc-700 border border-slate-300 dark:border-zinc-600 rounded text-xs font-bold text-slate-600 dark:text-zinc-300 shadow-sm">
                                {key}
                              </kbd>
                            ))}
                          </div>
                        </div>
                      ))}
                    </section>
                  ))}
                </div>
              </div>
            )}

            {activeTab === 'cutter' && <CutterMachinesPanel />}
          </div>

          {/* Footer */}
          <div className="p-4 border-t border-slate-200 dark:border-white/10 flex justify-end gap-3 flex-shrink-0 bg-slate-50 dark:bg-zinc-900/50">
            <Button 
              onClick={onClose}
              variant="primary"
            >
              {t('settings:dong')}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
