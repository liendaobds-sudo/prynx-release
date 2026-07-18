import React, { useState } from 'react';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { useTranslation } from 'react-i18next';

export type PageToolsTab = 'duplicate' | 'move' | 'delete' | 'rotate' | 'insert' | 'extract';

export default function PageToolsPanel() {
  const { t } = useTranslation();
    const { viewerNumPages, viewerActivePage } = useWorkspaceStore();
    const numPages = viewerNumPages || 1;
    const activePage = viewerActivePage || 1;

    const [activeTab, setActiveTab] = useState<PageToolsTab>('duplicate');

    // Common state
    const [targetType, setTargetType] = useState<'current' | 'all' | 'range'>('current');
    const [rangeStart, setRangeStart] = useState(activePage);
    const [rangeEnd, setRangeEnd] = useState(activePage);
    const [filter, setFilter] = useState<'all' | 'odd' | 'even'>('all');

    // Duplicate state
    const [copies, setCopies] = useState(1);
    const [collate, setCollate] = useState(true);

    // Move state
    const [moveStart, setMoveStart] = useState(activePage);
    const [moveEnd, setMoveEnd] = useState(activePage);
    const [moveTarget, setMoveTarget] = useState<'before_first' | 'after_last' | 'after_page'>('after_last');
    const [moveTargetPage, setMoveTargetPage] = useState(activePage);

    // Rotate state
    const [rotateDegrees, setRotateDegrees] = useState<number>(90);

    // Insert blank state
    const [insertTarget, setInsertTarget] = useState<'first' | 'last' | 'page'>('last');
    const [insertLocation, setInsertLocation] = useState<'before' | 'after'>('after');
    const [insertTargetPage, setInsertTargetPage] = useState(activePage);
    const [insertCount, setInsertCount] = useState(1);

    // Extract state
    const [extractStart, setExtractStart] = useState(activePage);
    const [extractEnd, setExtractEnd] = useState(activePage);
    const [extractDeleteAfter, setExtractDeleteAfter] = useState(false);

    const dispatchAction = (action: string, payload: any) => {
        window.dispatchEvent(new CustomEvent('prynx-pagetools-action', { detail: { action, payload } }));
    };

    const handleSubmit = () => {
        if (activeTab === 'duplicate') {
            dispatchAction('duplicate', { targetType, range: [rangeStart, rangeEnd], copies, collate });
        } else if (activeTab === 'move') {
            dispatchAction('move', { startPage: moveStart, endPage: moveEnd, targetType: moveTarget, targetPage: moveTargetPage });
        } else if (activeTab === 'delete') {
            dispatchAction('delete', { targetType: targetType === 'all' ? 'range' : targetType, range: targetType === 'all' ? [1, numPages] : [rangeStart, rangeEnd], filter });
        } else if (activeTab === 'rotate') {
            dispatchAction('rotate', { targetType, range: [rangeStart, rangeEnd], filter, degrees: rotateDegrees });
        } else if (activeTab === 'insert') {
            dispatchAction('insert_blank', { location: insertLocation, target: insertTarget, targetPage: insertTargetPage, count: insertCount });
        } else if (activeTab === 'extract') {
            dispatchAction('extract', { range: [extractStart, extractEnd], deleteAfter: extractDeleteAfter });
        }
    };

    const renderTargetSelection = (showAll: boolean = true) => (
        <div className="mb-4 border border-slate-200 dark:border-zinc-700 rounded p-3">
            <h3 className="text-xs font-semibold text-slate-600 dark:text-zinc-400 mb-2">{t('preprocess.pageTools:ap_dung_cho_trang_nao')}</h3>
            <div className="flex flex-col gap-2 text-sm">
                <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" checked={targetType === 'current'} onChange={() => setTargetType('current')} className="text-blue-600 focus:ring-blue-500" />
                    <span>{t('preprocess.pageTools:trang_hien_tai', { n: activePage })}</span>
                </label>
                {showAll && (
                    <label className="flex items-center gap-2 cursor-pointer">
                        <input type="radio" checked={targetType === 'all'} onChange={() => setTargetType('all')} className="text-blue-600 focus:ring-blue-500" />
                        <span>{t('preprocess.pageTools:toan_bo_tai_lieu')}</span>
                    </label>
                )}
                <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" checked={targetType === 'range'} onChange={() => setTargetType('range')} className="text-blue-600 focus:ring-blue-500" />
                    <span className="flex items-center gap-2 flex-wrap">
                        {t('preprocess.pageTools:tu_trang')} 
                        <input type="number" min={1} max={numPages} value={rangeStart} onChange={e => setRangeStart(Number(e.target.value) || 1)} disabled={targetType !== 'range'} className="w-14 h-7 px-2 border rounded dark:bg-zinc-800 disabled:opacity-50" />
                        {t('preprocess.pageTools:den')} 
                        <input type="number" min={1} max={numPages} value={rangeEnd} onChange={e => setRangeEnd(Number(e.target.value) || 1)} disabled={targetType !== 'range'} className="w-14 h-7 px-2 border rounded dark:bg-zinc-800 disabled:opacity-50" />
                    </span>
                </label>
            </div>
        </div>
    );

    const renderFilterSelection = (disabled: boolean = false) => (
        <div className={`mb-4 border rounded p-2 flex flex-col gap-2 justify-center text-sm transition-opacity duration-200 ${disabled ? 'border-slate-200 dark:border-zinc-700 bg-slate-50/50 dark:bg-zinc-800/20 opacity-50 pointer-events-none' : 'border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800/50'}`}>
            <label className={`flex items-center gap-2 ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                <input type="radio" checked={filter === 'all'} onChange={() => setFilter('all')} disabled={disabled} className="text-blue-600 focus:ring-blue-500 disabled:opacity-50" />
                <span>{t('preprocess.pageTools:tat_ca')}</span>
            </label>
            <label className={`flex items-center gap-2 ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                <input type="radio" checked={filter === 'odd'} onChange={() => setFilter('odd')} disabled={disabled} className="text-blue-600 focus:ring-blue-500 disabled:opacity-50" />
                <span>{t('preprocess.pageTools:chi_trang_le_odd')}</span>
            </label>
            <label className={`flex items-center gap-2 ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                <input type="radio" checked={filter === 'even'} onChange={() => setFilter('even')} disabled={disabled} className="text-blue-600 focus:ring-blue-500 disabled:opacity-50" />
                <span>{t('preprocess.pageTools:chi_trang_chan_even')}</span>
            </label>
        </div>
    );

    const tabs: { id: PageToolsTab, label: string }[] = [
        { id: 'duplicate', label: t('preprocess.pageTools:nhan_ban') },
        { id: 'move', label: t('preprocess.pageTools:di_chuyen') },
        { id: 'delete', label: t('preprocess.pageTools:xoa_trang') },
        { id: 'rotate', label: t('preprocess.pageTools:xoay_trang') },
        { id: 'insert', label: t('preprocess.pageTools:chen_trang') },
        { id: 'extract', label: t('preprocess.pageTools:trich_xuat') },
    ];

    return (
        <div className="flex flex-col font-sans w-full">
            <p className="text-[11px] text-slate-500 dark:text-zinc-400 mb-2 px-0.5">
                {t('preprocess.pageTools:help_b7')}
            </p>
            {/* Tabs */}
            <div className="flex px-1 pt-1 border-b border-slate-200 dark:border-zinc-700 relative">
                <div className="absolute bottom-[0px] left-0 w-full h-[1px] bg-slate-200 dark:bg-zinc-700"></div>
                <div className="flex gap-1 relative z-10 w-full flex-wrap">
                    {tabs.map(tab => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className={`px-3 py-1.5 text-xs font-medium border rounded-t-md -mb-[1px] transition-colors ${
                                activeTab === tab.id 
                                ? 'bg-white dark:bg-zinc-900 border-slate-300 dark:border-zinc-600 border-b-transparent dark:border-b-transparent text-blue-600 dark:text-blue-400'
                                : 'bg-slate-50 dark:bg-zinc-800 border-transparent text-slate-600 dark:text-zinc-400 hover:bg-slate-100 dark:hover:bg-zinc-700'
                            }`}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Body */}
            <div className="pt-4 flex-1">
                {/* DUPLICATE TAB */}
                {activeTab === 'duplicate' && (
                    <div className="flex flex-col animate-in fade-in duration-200">
                        {renderTargetSelection(true)}
                        <div className="border border-slate-200 dark:border-zinc-700 rounded p-3">
                            <h3 className="text-xs font-semibold text-slate-600 dark:text-zinc-400 mb-2">{t('preprocess.pageTools:so_ban_sao')}</h3>
                            <div className="flex items-center gap-2 text-sm mb-3">
                                <span>{t('preprocess.pageTools:ban_sao_copies')}</span>
                                <input type="number" min={1} max={999} value={copies} onChange={e => setCopies(Number(e.target.value) || 1)} className="w-16 h-7 px-2 border rounded dark:bg-zinc-800" />
                            </div>
                            <div className="flex flex-col gap-2 text-sm">
                                <span className="text-slate-600 dark:text-zinc-400">{t('preprocess.pageTools:chia_bo_collate')}</span>
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input type="radio" checked={collate} onChange={() => setCollate(true)} className="text-blue-600 focus:ring-blue-500" />
                                    <span>{t('preprocess.pageTools:co_1_2_3_1_2_3')}</span>
                                </label>
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input type="radio" checked={!collate} onChange={() => setCollate(false)} className="text-blue-600 focus:ring-blue-500" />
                                    <span>{t('preprocess.pageTools:khong_1_1_1_2_2_2')}</span>
                                </label>
                            </div>
                        </div>
                        <button onClick={handleSubmit} className="mt-4 w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded font-bold shadow-sm transition-colors">
                            {t('preprocess.pageTools:thuc_thi_nhan_ban')}
                        </button>
                    </div>
                )}

                {/* MOVE TAB */}
                {activeTab === 'move' && (
                    <div className="flex flex-col animate-in fade-in duration-200">
                        <div className="mb-4 border border-slate-200 dark:border-zinc-700 rounded p-3 text-sm flex flex-col gap-2">
                            <span className="font-semibold text-slate-600 dark:text-zinc-400">{t('preprocess.pageTools:dai_trang_can_di_chuyen')}</span>
                            <div className="flex items-center gap-2">
                                <span>{t('preprocess.pageTools:tu')}</span>
                                <input type="number" min={1} max={numPages} value={moveStart} onChange={e => setMoveStart(Number(e.target.value) || 1)} className="w-16 h-7 px-2 border rounded dark:bg-zinc-800" />
                                <span>{t('preprocess.pageTools:den_2')}</span>
                                <input type="number" min={1} max={numPages} value={moveEnd} onChange={e => setMoveEnd(Number(e.target.value) || 1)} className="w-16 h-7 px-2 border rounded dark:bg-zinc-800" />
                            </div>
                        </div>
                        <div className="border border-slate-200 dark:border-zinc-700 rounded p-3">
                            <h3 className="text-xs font-semibold text-slate-600 dark:text-zinc-400 mb-2">{t('preprocess.pageTools:chuyen_den_vi_tri_nao')}</h3>
                            <div className="flex flex-col gap-2 text-sm">
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input type="radio" checked={moveTarget === 'before_first'} onChange={() => setMoveTarget('before_first')} className="text-blue-600 focus:ring-blue-500" />
                                    <span>{t('preprocess.pageTools:len_truoc_trang_dau_tien')}</span>
                                </label>
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input type="radio" checked={moveTarget === 'after_last'} onChange={() => setMoveTarget('after_last')} className="text-blue-600 focus:ring-blue-500" />
                                    <span>{t('preprocess.pageTools:ra_sau_trang_cuoi_cung')}</span>
                                </label>
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input type="radio" checked={moveTarget === 'after_page'} onChange={() => setMoveTarget('after_page')} className="text-blue-600 focus:ring-blue-500" />
                                    <span className="flex items-center gap-2 flex-wrap">
                                        {t('preprocess.pageTools:sau_trang_so')}
                                        <input type="number" min={1} max={numPages} value={moveTargetPage} onChange={e => setMoveTargetPage(Number(e.target.value) || 1)} disabled={moveTarget !== 'after_page'} className="w-14 h-7 px-2 border rounded dark:bg-zinc-800 disabled:opacity-50" />
                                    </span>
                                </label>
                            </div>
                        </div>
                        <button onClick={handleSubmit} className="mt-4 w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded font-bold shadow-sm transition-colors">
                            {t('preprocess.pageTools:thuc_thi_di_chuyen')}
                        </button>
                    </div>
                )}

                {/* DELETE TAB */}
                {activeTab === 'delete' && (
                    <div className="flex flex-col animate-in fade-in duration-200">
                        {renderTargetSelection(false)}
                        {renderFilterSelection(targetType === 'current')}
                        <div className="text-amber-600 bg-amber-50 dark:bg-amber-900/20 p-2 rounded text-xs border border-amber-200 dark:border-amber-700/30">
                            <b>{t('preprocess.pageTools:canh_bao')}</b> {t('preprocess.pageTools:trang_da_xoa_se_khong_the_phuc_hoi_sau')}
                        </div>
                        <button onClick={handleSubmit} className="mt-4 w-full py-2.5 bg-red-600 hover:bg-red-700 text-white rounded font-bold shadow-sm transition-colors">
                            {t('preprocess.pageTools:xoa_trang_2')}
                        </button>
                    </div>
                )}

                {/* ROTATE TAB */}
                {activeTab === 'rotate' && (
                    <div className="flex flex-col animate-in fade-in duration-200">
                        <div className="mb-4 border border-slate-200 dark:border-zinc-700 rounded p-3">
                            <h3 className="text-xs font-semibold text-slate-600 dark:text-zinc-400 mb-2">{t('preprocess.pageTools:goc_xoay_rotate')}</h3>
                            <div className="flex flex-col gap-2 text-sm">
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input type="radio" checked={rotateDegrees === 270} onChange={() => setRotateDegrees(270)} className="text-blue-600 focus:ring-blue-500" />
                                    <span>{t('preprocess.pageTools:90_ccw_trai')}</span>
                                </label>
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input type="radio" checked={rotateDegrees === 180} onChange={() => setRotateDegrees(180)} className="text-blue-600 focus:ring-blue-500" />
                                    <span>{t('preprocess.pageTools:180_nguoc')}</span>
                                </label>
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input type="radio" checked={rotateDegrees === 90} onChange={() => setRotateDegrees(90)} className="text-blue-600 focus:ring-blue-500" />
                                    <span>{t('preprocess.pageTools:270_90_cw_phai')}</span>
                                </label>
                            </div>
                        </div>
                        {renderTargetSelection(true)}
                        {renderFilterSelection(targetType === 'current')}
                        <button onClick={handleSubmit} className="mt-4 w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded font-bold shadow-sm transition-colors">
                            {t('preprocess.pageTools:thuc_thi_xoay_trang')}
                        </button>
                    </div>
                )}

                {/* INSERT BLANK TAB */}
                {activeTab === 'insert' && (
                    <div className="flex flex-col animate-in fade-in duration-200">
                        <div className="mb-4 border border-slate-200 dark:border-zinc-700 rounded p-3">
                            <h3 className="text-xs font-semibold text-slate-600 dark:text-zinc-400 mb-2">{t('preprocess.pageTools:chen_vao_vi_tri_nao')}</h3>
                            <div className="flex flex-col gap-2 text-sm">
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input type="radio" checked={insertTarget === 'first'} onChange={() => { setInsertTarget('first'); setInsertLocation('before'); }} className="text-blue-600 focus:ring-blue-500" />
                                    <span>{t('preprocess.pageTools:truoc_trang_dau_tien')}</span>
                                </label>
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input type="radio" checked={insertTarget === 'last'} onChange={() => { setInsertTarget('last'); setInsertLocation('after'); }} className="text-blue-600 focus:ring-blue-500" />
                                    <span>{t('preprocess.pageTools:sau_trang_cuoi_cung')}</span>
                                </label>
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input type="radio" checked={insertTarget === 'page'} onChange={() => setInsertTarget('page')} className="text-blue-600 focus:ring-blue-500" />
                                    <span className="flex items-center gap-2 flex-wrap">
                                        <select value={insertLocation} onChange={e => setInsertLocation(e.target.value as 'before' | 'after')} disabled={insertTarget !== 'page'} className="h-7 px-1 border rounded dark:bg-zinc-800 disabled:opacity-50">
                                            <option value="after">Sau</option>
                                            <option value="before">{t('preprocess.pageTools:truoc')}</option>
                                        </select>
                                        {t('preprocess.pageTools:trang_so')}
                                        <input type="number" min={1} max={numPages} value={insertTargetPage} onChange={e => setInsertTargetPage(Number(e.target.value) || 1)} disabled={insertTarget !== 'page'} className="w-14 h-7 px-2 border rounded dark:bg-zinc-800 disabled:opacity-50" />
                                    </span>
                                </label>
                            </div>
                        </div>
                        <div className="border border-slate-200 dark:border-zinc-700 rounded p-3">
                            <h3 className="text-xs font-semibold text-slate-600 dark:text-zinc-400 mb-2">{t('preprocess.pageTools:so_trang_trang')}</h3>
                            <div className="flex items-center gap-2 text-sm">
                                <span>{t('preprocess.pageTools:so_luong')}</span>
                                <input type="number" min={1} max={999} value={insertCount} onChange={e => setInsertCount(Number(e.target.value) || 1)} className="w-16 h-7 px-2 border rounded dark:bg-zinc-800" />
                            </div>
                        </div>
                        <button onClick={handleSubmit} className="mt-4 w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded font-bold shadow-sm transition-colors">
                            {t('preprocess.pageTools:chen_trang_trang')}
                        </button>
                    </div>
                )}

                {/* EXTRACT TAB */}
                {activeTab === 'extract' && (
                    <div className="flex flex-col animate-in fade-in duration-200">
                        <div className="mb-4 border border-slate-200 dark:border-zinc-700 rounded p-3 text-sm flex flex-col gap-2">
                            <span className="font-semibold text-slate-600 dark:text-zinc-400">{t('preprocess.pageTools:dai_trang_can_trich_xuat')}</span>
                            <div className="flex items-center gap-2">
                                <span>{t('preprocess.pageTools:tu')}</span>
                                <input type="number" min={1} max={numPages} value={extractStart} onChange={e => setExtractStart(Number(e.target.value) || 1)} className="w-16 h-7 px-2 border rounded dark:bg-zinc-800" />
                                <span>{t('preprocess.pageTools:den_2')}</span>
                                <input type="number" min={1} max={numPages} value={extractEnd} onChange={e => setExtractEnd(Number(e.target.value) || 1)} className="w-16 h-7 px-2 border rounded dark:bg-zinc-800" />
                            </div>
                            <button onClick={() => { setExtractStart(activePage); setExtractEnd(activePage); }} className="self-start text-xs text-blue-600 hover:underline">
                                Dùng trang hiện tại ({activePage})
                            </button>
                        </div>
                        <label className="flex items-center gap-2 cursor-pointer text-sm mb-2 px-1">
                            <input type="checkbox" checked={extractDeleteAfter} onChange={e => setExtractDeleteAfter(e.target.checked)} className="text-blue-600 focus:ring-blue-500" />
                            <span>{t('preprocess.pageTools:xoa_cac_trang_nay_khoi_tai_lieu_sau_khi')}</span>
                        </label>
                        <div className="text-slate-500 dark:text-zinc-400 bg-slate-50 dark:bg-zinc-800/50 p-2 rounded text-xs border border-slate-200 dark:border-zinc-700">
                            {t('preprocess.pageTools:cac_trang_trong_dai_se_duoc_tach_ra')}
                        </div>
                        <button onClick={handleSubmit} className="mt-4 w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded font-bold shadow-sm transition-colors">
                            {t('preprocess.pageTools:trich_xuat_dai_trang')}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
