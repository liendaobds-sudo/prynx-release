import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatSizeMm } from '../lib/measurementFormat';

interface Preset {
    id: string;
    label: string;
    w: number; // mm
    h: number; // mm
}

// Chỉ series ISO A (+ custom). Khổ máy đặc thù tạo bằng "Tùy chỉnh".
const PRESETS: Preset[] = [
    { id: 'a7', label: 'A7 (74 × 105)', w: 74, h: 105 },
    { id: 'a6', label: 'A6 (105 × 148)', w: 105, h: 148 },
    { id: 'a5', label: 'A5 (148 × 210)', w: 148, h: 210 },
    { id: 'a4', label: 'A4 (210 × 297)', w: 210, h: 297 },
    { id: 'a3', label: 'A3 (297 × 420)', w: 297, h: 420 },
    { id: 'a2', label: 'A2 (420 × 594)', w: 420, h: 594 },
    { id: 'a1', label: 'A1 (594 × 841)', w: 594, h: 841 },
    { id: 'a0', label: 'A0 (841 × 1189)', w: 841, h: 1189 },
    { id: 'custom', label: 'Tùy chỉnh...', w: 0, h: 0 },
];

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onCreate: (widthMm: number, heightMm: number, pageCount: number, name: string) => void;
}

export default function NewDocumentModal({ isOpen, onClose, onCreate }: Props) {
  const { t } = useTranslation();
    const [presetId, setPresetId] = useState('a4');
    const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');
    const [customW, setCustomW] = useState(210);
    const [customH, setCustomH] = useState(297);
    const [pageCount, setPageCount] = useState(1);
    const [name, setName] = useState('');

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!isOpen) return;
            if (e.key === 'Escape') onClose();
            // UIUX (audit 2026-07-27 §D-19) fix-verify: Enter=Tạo chỉ khi KHÔNG đứng trong
            // select/textarea/BUTTON (đang mở dropdown chọn khổ giấy, hoặc Tab tới nút Hủy
            // rồi Enter thì không được tạo nhầm); input text tên tài liệu vẫn giữ Enter=Tạo.
            if (e.key === 'Enter') {
                const tag = (e.target as HTMLElement | null)?.tagName;
                if (tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;
                handleCreate();
            }
        };
        if (isOpen) window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, presetId, orientation, customW, customH, pageCount, name]);

    if (!isOpen) return null;

    const preset = PRESETS.find(p => p.id === presetId)!;
    const isCustom = presetId === 'custom';
    let w = isCustom ? customW : preset.w;
    let h = isCustom ? customH : preset.h;
    if (orientation === 'landscape' && w < h) { const t = w; w = h; h = t; }
    if (orientation === 'portrait' && w > h) { const t = w; w = h; h = t; }

    const handleCreate = () => {
        const fw = Math.max(1, Number(w) || 0);
        const fh = Math.max(1, Number(h) || 0);
        onCreate(fw, fh, Math.max(1, Math.round(pageCount) || 1), name);
        onClose();
    };

    return (
        <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/50 backdrop-blur-sm" onMouseDown={onClose}>
            <div
                role="dialog"
                aria-modal="true"
                aria-label={t('misc.newDocument:tao_tai_lieu_trang_moi')}
                className="bg-white dark:bg-zinc-800 p-6 rounded-xl shadow-2xl w-[420px] max-w-[92vw] border border-slate-200 dark:border-white/10"
                onMouseDown={(e) => e.stopPropagation()}
            >
                <h3 className="text-base font-bold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                    <span>📄</span> {t('misc.newDocument:tao_tai_lieu_trang_moi')}
                </h3>

                <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 mb-1">{t('misc.newDocument:ten_tai_lieu')}</label>
                <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Untitled"
                    className="w-full h-9 px-2.5 mb-4 text-[13px] bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500"
                />

                <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 mb-1">{t('misc.newDocument:kho_giay')}</label>
                <select
                    value={presetId}
                    onChange={(e) => setPresetId(e.target.value)}
                    className="w-full h-9 px-2 mb-4 text-[13px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500"
                >
                    {/* UIUX (audit 2026-07-27 §D-19): nhãn 'Tùy chỉnh...' đi qua i18n lúc render (PRESETS là const module-level) */}
                    {PRESETS.map(p => <option key={p.id} value={p.id}>{p.id === 'custom' ? t('misc.newDocument:tuy_chinh', 'Tùy chỉnh...') : p.label}</option>)}
                </select>

                {isCustom && (
                    <div className="grid grid-cols-2 gap-3 mb-4">
                        <div>
                            <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 mb-1">{t('misc.newDocument:rong_mm')}</label>
                            <input type="number" min={1} value={customW}
                                onChange={(e) => setCustomW(Number(e.target.value) || 0)}
                                className="w-full h-9 px-2 text-[13px] bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500" />
                        </div>
                        <div>
                            {/* UIUX (audit 2026-07-27 §D-19): nhãn hardcode → i18n */}
                            <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 mb-1">{t('misc.newDocument:cao_mm', 'Cao (mm)')}</label>
                            <input type="number" min={1} value={customH}
                                onChange={(e) => setCustomH(Number(e.target.value) || 0)}
                                className="w-full h-9 px-2 text-[13px] bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500" />
                        </div>
                    </div>
                )}

                <div className="flex items-center gap-4 mb-4">
                    <div className="flex-1">
                        <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 mb-1">{t('misc.newDocument:huong')}</label>
                        <div className="flex gap-2">
                            <button
                                onClick={() => setOrientation('portrait')}
                                className={`flex-1 h-9 rounded-md text-[12px] font-semibold border transition-colors ${orientation === 'portrait' ? 'bg-teal-500 text-white border-teal-500' : 'bg-white dark:bg-zinc-900 text-slate-600 dark:text-zinc-300 border-slate-300 dark:border-white/20'}`}
                            >{t('misc.newDocument:doc')}</button>
                            <button
                                onClick={() => setOrientation('landscape')}
                                className={`flex-1 h-9 rounded-md text-[12px] font-semibold border transition-colors ${orientation === 'landscape' ? 'bg-teal-500 text-white border-teal-500' : 'bg-white dark:bg-zinc-900 text-slate-600 dark:text-zinc-300 border-slate-300 dark:border-white/20'}`}
                            >{/* UIUX (audit 2026-07-27 §D-19): nhãn hardcode → i18n */}
                            {t('misc.newDocument:ngang', 'Ngang')}</button>
                        </div>
                    </div>
                    <div className="w-24">
                        <label className="block text-[11px] font-semibold text-slate-500 dark:text-zinc-400 mb-1">{t('misc.newDocument:so_trang')}</label>
                        <input type="number" min={1} value={pageCount}
                            onChange={(e) => setPageCount(Number(e.target.value) || 1)}
                            className="w-full h-9 px-2 text-[13px] bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500" />
                    </div>
                </div>

                <p className="text-[11px] text-slate-400 mb-4">
                    {t('misc.newDocument:kich_thuoc')}{' '}
                    {/* UIUX (audit 2026-08-04 §DIM.3): giữ 0,1 mm có nghĩa để tóm tắt khớp kích thước PDF thật. */}
                    <span className="font-semibold text-slate-600 dark:text-zinc-300">{formatSizeMm(w, h)}</span>
                </p>

                <div className="flex justify-end gap-2">
                    <button onClick={onClose} className="px-4 py-2 text-[13px] font-medium rounded-md bg-slate-100 dark:bg-zinc-700 text-slate-600 dark:text-zinc-300 hover:bg-slate-200 dark:hover:bg-zinc-600 transition-colors">{t('misc.newDocument:huy')}</button>
                    <button onClick={handleCreate} className="px-4 py-2 text-[13px] font-bold rounded-md bg-teal-600 hover:bg-teal-700 text-white shadow-sm transition-colors">{t('misc.newDocument:tao_tai_lieu')}</button>
                </div>
            </div>
        </div>
    );
}
