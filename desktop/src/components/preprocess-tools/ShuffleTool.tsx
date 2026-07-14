import { useState, useEffect, useRef } from 'react';
import { useAutoAnimate } from '@formkit/auto-animate/react';
import { SHUFFLE_PRESETS, getPresetById, RepeatMode, parseRule, applyRule, shuffleEvenOdd, reversePages, serializeRule, type ShuffleRule } from '../../lib/preprocessEngine/ShuffleEngine';
import { 
    ToolSectionLabel, ToolCardOption, 
    ToolNumberInput, ToolInfo 
} from './ToolUI';
import { ArrowLeft, ArrowRight, RotateCw, Trash2, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const inputCls = "w-full h-8 px-2.5 text-[12px] border border-slate-300 dark:border-white/20 rounded-md bg-white dark:bg-zinc-900 font-medium focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500/20 transition-all";

export interface ShuffleSettings {
    presetId: string;
    rule: string;
    groupSize: number;
    mode: RepeatMode;
    specialAction?: 'even_first' | 'odd_first' | 'interleave' | 'reverse_even' | 'reverse' | 'split_odd_even';
}

interface Props {
    settings: ShuffleSettings;
    onChange: (settings: ShuffleSettings) => void;
}

type TabId = 'quick' | 'preset' | 'custom';

export default function ShuffleTool({ settings, onChange }: Props) {
  const { t } = useTranslation();
    const [localRule, setLocalRule] = useState(settings.rule);
    const [parentRef] = useAutoAnimate<HTMLDivElement>({ duration: 150 });
    const [activeTab, setActiveTab] = useState<TabId>(() => {
        if (settings.presetId === 'special') return 'quick';
        if (settings.presetId === 'custom') return 'custom';
        return 'preset';
    });

    const [previewStr, setPreviewStr] = useState('');

    useEffect(() => {
        setLocalRule(settings.rule);
    }, [settings.rule]);

    useEffect(() => {
        try {
            const simulatedPages = Math.max(16, Math.ceil((settings.groupSize || 16) / 4) * 4);
            let mapping: any[] = [];
            
            if (activeTab === 'quick') {
                if (settings.specialAction === 'reverse') mapping = reversePages(simulatedPages);
                else if (settings.specialAction === 'split_odd_even') mapping = shuffleEvenOdd(simulatedPages, 'odd_first').filter(m => m.srcPage % 2 === 0);
                else mapping = shuffleEvenOdd(simulatedPages, settings.specialAction || 'odd_first');
            } else {
                const rules = parseRule(localRule || settings.rule);
                if (rules.length === 0) {
                    setPreviewStr(t('preprocess.shuffle:vui_long_nhap_chuoi_quy_tac_hop_le'));
                    return;
                }
                mapping = applyRule(rules, simulatedPages, settings.groupSize || 1, settings.mode);
            }
            
            const displayMapping = mapping.slice(0, 32).map(m => {
                if (m.srcPage === -1) return t('preprocess.shuffle:trong');
                let str = (m.srcPage + 1).toString();
                if (m.rotation === 180) str += '*';
                if (m.rotation === 90) str += '>';
                if (m.rotation === 270) str += '<';
                return str;
            });
            
            let res = displayMapping.join(', ');
            if (mapping.length > 32) res += '...';
            setPreviewStr(`[${res}]`);
        } catch (e) {
            setPreviewStr(t('preprocess.shuffle:quy_tac_khong_hop_le'));
        }
    }, [activeTab, settings, localRule]);

    useEffect(() => {
        if (settings.presetId === 'special') setActiveTab('quick');
        else if (settings.presetId === 'custom') setActiveTab('custom');
        else setActiveTab('preset');
    }, [settings.presetId]);

    const handleTabChange = (tab: TabId) => {
        setActiveTab(tab);
        if (tab === 'quick') {
            onChange({ ...settings, presetId: 'special', specialAction: 'reverse' });
        } else if (tab === 'preset') {
            const firstPreset = SHUFFLE_PRESETS[0];
            onChange({ ...settings, presetId: firstPreset.id, rule: firstPreset.rule, groupSize: firstPreset.groupSize, mode: firstPreset.mode, specialAction: undefined });
        } else if (tab === 'custom') {
            onChange({ ...settings, presetId: 'custom', specialAction: undefined });
        }
    };

    const handlePresetChange = (presetId: string) => {
        const preset = getPresetById(presetId);
        if (preset) {
            onChange({
                ...settings,
                presetId,
                rule: preset.rule,
                groupSize: preset.groupSize,
                mode: preset.mode,
                specialAction: undefined
            });
        }
    };

    const handleSpecialAction = (action: ShuffleSettings['specialAction']) => {
        onChange({ ...settings, presetId: 'special', specialAction: action });
    };

    return (
        <div className="flex flex-col gap-4 animate-in fade-in duration-200 relative z-[60]">
            
            {/* Tabs */}
            <div className="flex bg-slate-100 dark:bg-zinc-800/50 p-1 rounded-lg border border-slate-200 dark:border-white/5">
                {[
                    { id: 'quick', label: t('preprocess.shuffle:tac_vu_co_ban') },
                    { id: 'preset', label: t('preprocess.shuffle:mau_binh_bai') },
                    { id: 'custom', label: t('preprocess.shuffle:tuy_chinh') }
                ].map(tab => (
                    <button
                        key={tab.id}
                        onClick={() => handleTabChange(tab.id as TabId)}
                        className={`flex-1 text-[11px] font-bold py-1.5 rounded-md transition-all ${
                            activeTab === tab.id 
                            ? 'bg-white dark:bg-zinc-700 text-teal-600 dark:text-teal-400 shadow-sm' 
                            : 'text-slate-500 hover:text-slate-700 dark:hover:text-zinc-300'
                        }`}
                    >
                        {tab.label}
                    </button>
                ))}
            </div>

            {/* Content area */}
            <div className="min-h-[140px]">
                {activeTab === 'quick' && (
                    <div className="animate-in fade-in slide-in-from-top-1 duration-200 flex flex-col gap-2">
                        <ToolSectionLabel>{t('preprocess.shuffle:chon_tac_vu_nhanh')}</ToolSectionLabel>
                        <div className="grid grid-cols-2 gap-2">
                            <ToolCardOption 
                                selected={settings.specialAction === 'split_odd_even'} 
                                onClick={() => handleSpecialAction('split_odd_even')} 
                                label={t('preprocess.shuffle:tach_chan_le')} desc={t('preprocess.shuffle:tao_2_tab_moi_hoan_toan_doc_lap')}
                            />
                            <ToolCardOption 
                                selected={settings.specialAction === 'reverse'} 
                                onClick={() => handleSpecialAction('reverse')} 
                                label={t('preprocess.shuffle:dao_nguoc')} desc="1, 2, 3 ➔ 3, 2, 1"
                            />
                            <ToolCardOption 
                                selected={settings.specialAction === 'reverse_even'} 
                                onClick={() => handleSpecialAction('reverse_even')} 
                                label={t('preprocess.shuffle:dao_trang_chan')} desc={t('preprocess.shuffle:lat_mat_in_2_mat')}
                            />
                            <ToolCardOption 
                                selected={settings.specialAction === 'odd_first'} 
                                onClick={() => handleSpecialAction('odd_first')} 
                                label={t('preprocess.shuffle:le_truoc_chan_sau')} desc="1, 3, 5, 2, 4, 6"
                            />
                            <ToolCardOption 
                                selected={settings.specialAction === 'interleave'} 
                                onClick={() => handleSpecialAction('interleave')} 
                                label={t('preprocess.shuffle:tron_xen_ke')} desc={t('preprocess.shuffle:ghep_file_chan_le')}
                            />
                        </div>
                    </div>
                )}

                {activeTab === 'preset' && (
                    <div className="animate-in fade-in slide-in-from-top-1 duration-200 flex flex-col gap-2">
                        <ToolSectionLabel>{t('preprocess.shuffle:chon_mau_xao_tron')}</ToolSectionLabel>
                        <select
                            value={settings.presetId}
                            onChange={(e) => handlePresetChange(e.target.value)}
                            className={inputCls}
                        >
                            <optgroup label={t('preprocess.shuffle:saddle_stitch_bam_giua')}>
                                {SHUFFLE_PRESETS.filter(p => p.mode === 'saddle').map(p => (
                                    <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                            </optgroup>
                            <optgroup label={t('preprocess.shuffle:thread_boc_tep')}>
                                {SHUFFLE_PRESETS.filter(p => p.id.startsWith('thread')).map(p => (
                                    <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                            </optgroup>
                            <optgroup label={t('preprocess.shuffle:cut_stack_cat_xep_chong')}>
                                {SHUFFLE_PRESETS.filter(p => p.mode.startsWith('cut_stack')).map(p => (
                                    <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                            </optgroup>
                        </select>
                        <div className="text-[11px] text-slate-500 italic mt-2 ml-1">
                            * {getPresetById(settings.presetId)?.description || t('preprocess.shuffle:mau_cau_hinh_san_cho_cac_kieu_dong_cuon')}
                        </div>
                    </div>
                )}

                {activeTab === 'custom' && (
                    <div className="animate-in fade-in slide-in-from-top-1 duration-200 flex flex-col gap-3">
                        
                        <div className="grid grid-cols-2 gap-3 mt-1 p-3 bg-slate-50 dark:bg-zinc-800/30 rounded-lg border border-slate-200 dark:border-white/5">
                            <ToolNumberInput 
                                label={t('preprocess.shuffle:so_trang_nhom_group_size')}
                                value={settings.groupSize}
                                onChange={val => onChange({ ...settings, groupSize: val || 1 })}
                                step={1}
                            />
                            <div>
                                <span className="text-[10px] font-medium text-slate-500 block mb-1">{t('preprocess.shuffle:cach_lap')}</span>
                                <select
                                    value={settings.mode}
                                    onChange={(e) => onChange({ ...settings, mode: e.target.value as RepeatMode })}
                                    className={inputCls}
                                >
                                    <option value="normal">{t('preprocess.shuffle:normal_lap_group')}</option>
                                    <option value="saddle">{t('preprocess.shuffle:saddle_keo_gian')}</option>
                                    <option value="cut_stack_1side">{t('preprocess.shuffle:cut_stack_1_mat')}</option>
                                    <option value="cut_stack_2side">{t('preprocess.shuffle:cut_stack_2_mat')}</option>
                                </select>
                            </div>
                        </div>

                        <div className="flex flex-col gap-2">
                            <ToolSectionLabel>{t('preprocess.shuffle:quy_tac_xao_tron_thu_tu_moi')}</ToolSectionLabel>
                            
                            {/* Cards Area */}
                            <div 
                                ref={parentRef}
                                className="flex flex-wrap gap-2 p-3 min-h-[80px] bg-white dark:bg-zinc-900 rounded-lg border border-slate-200 dark:border-white/10"
                            >
                                {(() => {
                                    const parsedRules = parseRule(localRule || settings.rule);
                                    
                                    const updateRules = (newRules: ShuffleRule[]) => {
                                        const newStr = serializeRule(newRules);
                                        setLocalRule(newStr);
                                        onChange({ ...settings, rule: newStr });
                                    };

                                    if (parsedRules.length === 0) {
                                        return <div className="text-[11px] text-slate-400 italic flex items-center justify-center w-full h-full">{t('preprocess.shuffle:chua_co_trang_nao_hay_them_o_ben_duoi')}</div>;
                                    }

                                    return parsedRules.map((rule, idx) => {
                                        const isBlank = rule.pageIndex === 0;
                                        return (
                                            <div key={`${idx}-${rule.pageIndex}`} className="flex flex-col w-16 h-20 bg-slate-50 dark:bg-zinc-800 border border-slate-200 dark:border-white/10 rounded-md shadow-sm overflow-hidden group">
                                                {/* Header / Rotation */}
                                                <div className="h-5 bg-slate-100 dark:bg-zinc-700/50 flex justify-between items-center px-1">
                                                    <button 
                                                        onClick={() => {
                                                            const newRules = [...parsedRules];
                                                            newRules.splice(idx, 1);
                                                            updateRules(newRules);
                                                        }}
                                                        className="text-slate-400 hover:text-red-500 transition-colors"
                                                        title={t('preprocess.shuffle:xoa')}
                                                    ><Trash2 size={10} /></button>
                                                    <button 
                                                        onClick={() => {
                                                            const newRules = [...parsedRules];
                                                            const curr = newRules[idx].rotation;
                                                            newRules[idx].rotation = curr === 0 ? 90 : curr === 90 ? 180 : curr === 180 ? 270 : 0;
                                                            updateRules(newRules);
                                                        }}
                                                        className={`transition-colors ${rule.rotation !== 0 ? 'text-indigo-500' : 'text-slate-400 hover:text-indigo-500'}`}
                                                        title={t('preprocess.shuffle:xoay')}
                                                    ><RotateCw size={10} /></button>
                                                </div>
                                                
                                                {/* Main Content */}
                                                <div className="flex-1 flex items-center justify-center relative">
                                                    <div 
                                                        className="font-bold text-[14px] text-slate-700 dark:text-zinc-200 transition-transform duration-300"
                                                        style={{ transform: `rotate(${rule.rotation}deg)` }}
                                                    >
                                                        {isBlank ? t('preprocess.shuffle:trang') : rule.pageIndex}
                                                    </div>
                                                </div>

                                                {/* Footer / Reorder */}
                                                <div className="h-5 flex bg-slate-100 dark:bg-zinc-700/50 opacity-0 group-hover:opacity-100 transition-opacity">
                                                    <button 
                                                        onClick={() => {
                                                            if (idx === 0) return;
                                                            const newRules = [...parsedRules];
                                                            const temp = newRules[idx];
                                                            newRules[idx] = newRules[idx - 1];
                                                            newRules[idx - 1] = temp;
                                                            updateRules(newRules);
                                                        }}
                                                        className="flex-1 flex justify-center items-center text-slate-500 hover:bg-slate-200 dark:hover:bg-zinc-600 transition-colors disabled:opacity-30"
                                                        disabled={idx === 0}
                                                    ><ArrowLeft size={10} /></button>
                                                    <div className="w-[1px] bg-slate-200 dark:bg-zinc-600"></div>
                                                    <button 
                                                        onClick={() => {
                                                            if (idx === parsedRules.length - 1) return;
                                                            const newRules = [...parsedRules];
                                                            const temp = newRules[idx];
                                                            newRules[idx] = newRules[idx + 1];
                                                            newRules[idx + 1] = temp;
                                                            updateRules(newRules);
                                                        }}
                                                        className="flex-1 flex justify-center items-center text-slate-500 hover:bg-slate-200 dark:hover:bg-zinc-600 transition-colors disabled:opacity-30"
                                                        disabled={idx === parsedRules.length - 1}
                                                    ><ArrowRight size={10} /></button>
                                                </div>
                                            </div>
                                        );
                                    });
                                })()}
                            </div>

                            {/* Add Buttons */}
                            <div className="flex flex-wrap gap-1.5 mt-1">
                                {Array.from({ length: settings.groupSize || 1 }).map((_, i) => (
                                    <button
                                        key={i}
                                        onClick={() => {
                                            const parsedRules = parseRule(localRule || settings.rule);
                                            const newRules = [...parsedRules, { pageIndex: i + 1, rotation: 0 as const }];
                                            const newStr = serializeRule(newRules);
                                            setLocalRule(newStr);
                                            onChange({ ...settings, rule: newStr });
                                        }}
                                        className="h-6 px-2.5 bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-500/10 dark:hover:bg-indigo-500/20 text-indigo-600 dark:text-indigo-400 text-[11px] font-bold rounded flex items-center gap-1 transition-colors border border-indigo-100 dark:border-indigo-500/20 shadow-sm"
                                    >
                                        <Plus size={10} strokeWidth={3} /> T{i + 1}
                                    </button>
                                ))}
                                <button
                                    onClick={() => {
                                        const parsedRules = parseRule(localRule || settings.rule);
                                        const newRules = [...parsedRules, { pageIndex: 0, rotation: 0 as const }];
                                        const newStr = serializeRule(newRules);
                                        setLocalRule(newStr);
                                        onChange({ ...settings, rule: newStr });
                                    }}
                                    className="h-6 px-2.5 bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-slate-600 dark:text-zinc-300 text-[11px] font-bold rounded flex items-center gap-1 transition-colors border border-slate-200 dark:border-white/10 shadow-sm ml-auto"
                                >
                                    <Plus size={10} strokeWidth={3} /> {t('preprocess.shuffle:trang_trang_x')}
                                </button>
                            </div>
                            
                            <div className="mt-2">
                                <label className="text-[10px] text-slate-500 font-medium mb-1 block">{t('preprocess.shuffle:chuoi_quy_tac_noi_bo_doc_de_kiem_tra')}</label>
                                <input
                                    type="text"
                                    value={localRule}
                                    onChange={e => setLocalRule(e.target.value)}
                                    onBlur={() => onChange({ ...settings, rule: localRule })}
                                    className={inputCls + " font-mono text-slate-500 dark:text-zinc-400 text-[11px]"}
                                    placeholder="VD: 4 1 2 3"
                                />
                            </div>
                        </div>
                    </div>
                )}
            </div>
            
            {/* Live Preview */}
            <div className="mt-2 bg-indigo-50/50 dark:bg-indigo-900/10 border border-indigo-100 dark:border-indigo-500/20 rounded-lg p-3">
                <span className="text-[10px] font-bold text-indigo-600 dark:text-indigo-400 uppercase tracking-wider block mb-1">{t('preprocess.shuffle:live_preview_mo_phong')}</span>
                <div className="text-[11px] font-mono text-slate-700 dark:text-zinc-300 leading-relaxed break-words">
                    {previewStr}
                </div>
                <div className="text-[9px] text-indigo-400/80 mt-1.5 italic">
                    {t('preprocess.shuffle:mo_phong_cho_tai_lieu_mau_n_trang', { n: Math.max(16, Math.ceil((settings.groupSize || 16) / 4) * 4) })}
                </div>
            </div>
            
            <ToolInfo desc={
                <><strong>{t('preprocess.shuffle:ghi_chu')}</strong> {t('preprocess.shuffle:ap_dung_tac_vu_nay_se_tao_ra_mot_file')}</>
            } />
        </div>
    );
}
