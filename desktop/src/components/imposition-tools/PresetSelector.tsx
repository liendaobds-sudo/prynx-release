/**
 * PresetSelector — Modal quản lý Preset bình bài
 * 
 * Style: createPortal + backdrop blur giống MarksSettingsDialog
 * Nhưng KHÔNG dùng Button component (quá to) — custom inline buttons
 */

import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../Button';
import { 
  type ImpositionPreset, 
  loadPresets, 
  savePreset, 
  deletePreset, 
  createPreset, 
  exportPresetAsFile, 
  importPresetFromFile 
} from '../../lib/presetManager';
import { toast } from '../ui/Toast';
import { useTranslation } from 'react-i18next';

// Hiển thị read-only 1 nhóm thiết lập (paper/marks/booklet/nup).
function DetailSection({ title, obj }: { title: string; obj?: Record<string, any> }) {
  if (!obj) return null;
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (entries.length === 0) return null;
  return (
    <div className="mb-2 last:mb-0">
      <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-1">{title}</div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        {entries.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-2 text-[11px]">
            <span className="font-mono text-slate-400 dark:text-zinc-500 truncate" title={k}>{k}</span>
            <span className="text-slate-700 dark:text-zinc-200 text-right truncate" title={String(v)}>{String(v)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PresetDetails({ preset }: { preset: ImpositionPreset }) {
  const { t } = useTranslation();
  return (
    <div className="mt-2 p-2.5 rounded-lg bg-slate-50 dark:bg-zinc-900/60 border border-slate-200 dark:border-white/10">
      <div className="text-[11px] mb-2"><span className="text-slate-400">{t('imposition.presetSelector:che_do')} </span>
        <span className="font-semibold text-slate-700 dark:text-zinc-200">{preset.taskMode === 'booklet' ? t('imposition.presetSelector:binh_sach_booklet') : t('imposition.presetSelector:binh_n_up')}</span>
      </div>
      <DetailSection title={t('imposition.presetSelector:giay')} obj={preset.paper} />
      <DetailSection title={t('imposition.presetSelector:dau_cat')} obj={preset.marks} />
      {preset.taskMode === 'booklet' && <DetailSection title="Booklet" obj={preset.booklet} />}
      {preset.taskMode === 'nup' && <DetailSection title="N-Up" obj={preset.nup} />}
    </div>
  );
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onLoadPreset: (preset: ImpositionPreset) => void;
  onGetCurrentSettings: () => Omit<ImpositionPreset, 'id' | 'name' | 'description' | 'createdAt' | 'updatedAt'>;
}

export default function PresetSelector({ isOpen, onClose, onLoadPreset, onGetCurrentSettings }: Props) {
  const { t } = useTranslation();
  const [presets, setPresets] = useState<ImpositionPreset[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [mode, setMode] = useState<'list' | 'save'>('list');
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmUpdateId, setConfirmUpdateId] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setIsLoading(true);
      loadPresets().then(list => {
        setPresets(list);
        setIsLoading(false);
      });
      setMode('list');
      setNewName('');
      setNewDesc('');
      setEditingId(null);
      setConfirmDeleteId(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (mode === 'save') setTimeout(() => nameInputRef.current?.focus(), 100);
  }, [mode]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isOpen && e.key === 'Escape') {
        if (mode === 'save') { setMode('list'); }
        else onClose();
      }
    };
    if (isOpen) document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, mode]);

  const handleSaveNew = async () => {
    if (!newName.trim()) return;
    const settings = onGetCurrentSettings();
    const preset = createPreset(newName.trim(), newDesc.trim(), settings);
    await savePreset(preset);
    setPresets(await loadPresets());
    setMode('list');
    setNewName('');
    setNewDesc('');
  };

  const handleDelete = async (id: string) => {
    await deletePreset(id);
    setPresets(await loadPresets());
    setConfirmDeleteId(null);
  };

  const handleRename = async (preset: ImpositionPreset) => {
    if (!editName.trim()) return;
    preset.name = editName.trim();
    preset.updatedAt = new Date().toISOString();
    await savePreset(preset);
    setPresets(await loadPresets());
    setEditingId(null);
  };

  // Cập nhật TẠI CHỖ: ghi đè thiết lập của preset bằng thiết lập hiện tại trên form
  // (giữ id/tên/ghi chú/ngày tạo). Khác "Lưu thiết lập" (tạo preset mới).
  const handleUpdateFromCurrent = async (preset: ImpositionPreset) => {
    const settings = onGetCurrentSettings();
    const updated: ImpositionPreset = {
      ...preset, ...settings, updatedAt: new Date().toISOString(),
    };
    await savePreset(updated);
    setPresets(await loadPresets());
    setConfirmUpdateId(null);
    toast.success(`Đã cập nhật preset "${preset.name}" bằng thiết lập hiện tại.`);
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await importPresetFromFile(file);
    setPresets(await loadPresets());
    e.target.value = '';
  };

  if (!isOpen) return null;

  const inputCls = "w-full h-10 px-3 border border-slate-300 dark:border-white/20 rounded-lg bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 transition-colors";
  const labelCls = "block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5";

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white dark:bg-zinc-800 rounded-xl shadow-2xl w-full max-w-md p-6 flex flex-col gap-5 animate-in fade-in zoom-in-95 duration-200 max-h-[85vh] overflow-hidden">
        
        {/* ── Header ── */}
        <div className="flex items-center justify-between shrink-0">
          <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <span className="text-xl">💾</span> {t('imposition.presetSelector:preset_san_pham')}
          </h3>
          <button onClick={onClose} className="p-1.5 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-700 transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>

        {/* ── Content ── */}
        <div className="flex-1 overflow-y-auto pr-1 -mr-1 min-h-[150px]">
          
          {mode === 'save' ? (
            /* ── SAVE MODE ── */
            <div className="space-y-4">
              <div>
                <label className={labelCls}>{t('imposition.presetSelector:ten_preset')}</label>
                <input 
                  ref={nameInputRef}
                  value={newName} 
                  onChange={e => setNewName(e.target.value)}
                  placeholder={t('imposition.presetSelector:vd_catalog_a5_ghim_2_day')}
                  className={inputCls}
                  onKeyDown={e => { if (e.key === 'Enter') handleSaveNew(); }}
                />
              </div>
              <div>
                <label className={labelCls}>{t('imposition.presetSelector:ghi_chu_tuy_chon')}</label>
                <input 
                  value={newDesc} 
                  onChange={e => setNewDesc(e.target.value)}
                  placeholder={t('imposition.presetSelector:vd_in_offset_sra3_ghim_2_day')}
                  className={inputCls}
                  onKeyDown={e => { if (e.key === 'Enter') handleSaveNew(); }}
                />
              </div>
            </div>
          ) : (
            /* ── LIST MODE ── */
            isLoading ? (
              <div className="flex items-center justify-center py-12">
                <div className="w-6 h-6 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : presets.length === 0 ? (
              <div className="text-center py-12 text-slate-400">
                <div className="text-4xl mb-3">📋</div>
                <div className="text-sm font-semibold text-slate-500">{t('imposition.presetSelector:chua_co_preset_nao')}</div>
                <div className="text-[12px] mt-1.5">{t('imposition.presetSelector:bam_luu_thiet_lap_hien_tai_de_tao_moi')}</div>
              </div>
            ) : (
              <div className="space-y-2 pb-1">
                {presets.map(preset => (
                  <div 
                    key={preset.id} 
                    className="group border border-slate-200 dark:border-white/10 rounded-lg p-3 hover:border-indigo-400 dark:hover:border-indigo-500/50 hover:bg-indigo-50/40 dark:hover:bg-indigo-500/5 transition-all cursor-pointer"
                    onClick={() => {
                      if (editingId !== preset.id && confirmDeleteId !== preset.id) {
                        onLoadPreset(preset);
                        onClose();
                      }
                    }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        {editingId === preset.id ? (
                          <div className="flex gap-2" onClick={e => e.stopPropagation()}>
                            <input 
                              value={editName} 
                              onChange={e => setEditName(e.target.value)}
                              className="flex-1 h-8 px-2 text-sm border border-indigo-400 rounded bg-white dark:bg-zinc-900 focus:outline-none"
                              autoFocus
                              onKeyDown={e => { 
                                if (e.key === 'Enter') handleRename(preset);
                                if (e.key === 'Escape') setEditingId(null);
                              }}
                            />
                            <button onClick={() => handleRename(preset)} className="text-indigo-600 font-bold text-sm px-2">✓</button>
                            <button onClick={() => setEditingId(null)} className="text-slate-400 text-sm px-1">✗</button>
                          </div>
                        ) : (
                          <>
                            <div className="font-bold text-[14px] text-slate-800 dark:text-white truncate">{preset.name}</div>
                            {preset.description && <div className="text-[12px] text-slate-500 truncate mt-0.5">{preset.description}</div>}
                            <div className="flex items-center gap-2.5 mt-2">
                              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-slate-100 dark:bg-zinc-700 text-slate-500 dark:text-zinc-400">
                                {preset.taskMode === 'booklet' ? t('imposition.presetSelector:sach') : '🎴 N-Up'}
                              </span>
                              <span className="text-[11px] text-slate-500">{preset.paper.formsize} • {preset.paper.bleed}mm bleed</span>
                            </div>
                          </>
                        )}
                      </div>

                      {/* Action icons */}
                      {editingId !== preset.id && (
                        <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                          <button
                            onClick={() => setExpandedId(expandedId === preset.id ? null : preset.id)}
                            className="w-7 h-7 rounded-md hover:bg-slate-200 dark:hover:bg-zinc-600 flex items-center justify-center text-slate-500 hover:text-indigo-600 transition-colors" title={expandedId === preset.id ? t('imposition.presetSelector:thu_gon') : t('imposition.presetSelector:xem_chi_tiet_thiet_lap')}
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`transition-transform ${expandedId === preset.id ? 'rotate-90' : ''}`}><polyline points="9 18 15 12 9 6"/></svg>
                          </button>
                          <button 
                            onClick={() => { setEditingId(preset.id); setEditName(preset.name); }}
                            className="w-7 h-7 rounded-md hover:bg-slate-200 dark:hover:bg-zinc-600 flex items-center justify-center text-slate-500 hover:text-blue-600 transition-colors" title={t('imposition.presetSelector:doi_ten')}
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                          </button>
                          {confirmUpdateId === preset.id ? (
                            <div className="flex items-center gap-1.5 ml-1">
                              <button onClick={() => handleUpdateFromCurrent(preset)} className="px-2 py-1 text-[11px] font-bold bg-indigo-600 text-white rounded-md whitespace-nowrap">{t('imposition.presetSelector:ghi_de')}</button>
                              <button onClick={() => setConfirmUpdateId(null)} className="px-2 py-1 text-[11px] font-medium bg-slate-200 dark:bg-zinc-700 text-slate-700 dark:text-zinc-300 rounded-md">{t('imposition.presetSelector:huy')}</button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setConfirmUpdateId(preset.id)}
                              className="w-7 h-7 rounded-md hover:bg-slate-200 dark:hover:bg-zinc-600 flex items-center justify-center text-slate-500 hover:text-indigo-600 transition-colors" title={t('imposition.presetSelector:cap_nhat_preset_bang_thiet_lap_hien_tai')}
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
                            </button>
                          )}
                          <button 
                            onClick={() => exportPresetAsFile(preset)}
                            className="w-7 h-7 rounded-md hover:bg-slate-200 dark:hover:bg-zinc-600 flex items-center justify-center text-slate-500 hover:text-emerald-600 transition-colors" title={t('imposition.presetSelector:xuat_file_json')}
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                          </button>
                          {confirmDeleteId === preset.id ? (
                            <div className="flex items-center gap-1.5 ml-1">
                              <button onClick={() => handleDelete(preset.id)} className="px-2 py-1 text-[11px] font-bold bg-red-500 text-white rounded-md">{t('imposition.presetSelector:xoa')}</button>
                              <button onClick={() => setConfirmDeleteId(null)} className="px-2 py-1 text-[11px] font-medium bg-slate-200 dark:bg-zinc-700 text-slate-700 dark:text-zinc-300 rounded-md">{t('imposition.presetSelector:huy')}</button>
                            </div>
                          ) : (
                            <button 
                              onClick={() => setConfirmDeleteId(preset.id)}
                              className="w-7 h-7 rounded-md hover:bg-red-100 dark:hover:bg-red-500/20 flex items-center justify-center text-slate-500 hover:text-red-500 transition-colors" title={t('imposition.presetSelector:xoa')}
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    {expandedId === preset.id && (
                      <div onClick={e => e.stopPropagation()}>
                        <PresetDetails preset={preset} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )
          )}
        </div>

        {/* ── Footer ── */}
        <div className="flex items-center gap-3 pt-4 border-t border-slate-200 dark:border-white/10 shrink-0">
          {mode === 'save' ? (
            <>
              <div className="flex-1" />
              <Button variant="secondary" onClick={() => setMode('list')}>{t('imposition.presetSelector:huy')}</Button>
              <Button variant="primary" onClick={handleSaveNew} disabled={!newName.trim()}>{t('imposition.presetSelector:luu_preset')}</Button>
            </>
          ) : (
            <>
              <input ref={importInputRef} type="file" accept=".json" className="hidden" onChange={handleImport} />
              <button 
                className="text-[13px] font-semibold text-slate-500 hover:text-slate-800 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-zinc-700 px-3 py-2 rounded-lg transition-colors flex items-center gap-2" 
                onClick={() => importInputRef.current?.click()}
              >
                {t('imposition.presetSelector:nhap_file_json')}
              </button>
              <div className="flex-1" />
              <Button variant="secondary" onClick={onClose}>{t('imposition.presetSelector:dong')}</Button>
              <Button variant="primary" onClick={() => setMode('save')} className="whitespace-nowrap">
                <span className="mr-1.5">+</span> {t('imposition.presetSelector:luu_thiet_lap')}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
