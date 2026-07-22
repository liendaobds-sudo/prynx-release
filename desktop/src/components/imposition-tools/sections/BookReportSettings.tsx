// @ts-nocheck
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { buildBookReportText } from '../../../lib/bookReport';
import { Checkbox, inputCls, SectionLabel } from '../SharedUI';
import { PREDEFINED_SIZES, type BookReportFieldKey } from '../types';
import { useImposerSettingsStore } from '../useImposerSettingsStore';

const FIELD_CONTROLS: Array<[BookReportFieldKey, string, string]> = [
    ['orderCode', 'showOrderCode', 'Mã đơn hàng'],
    ['title', 'showTitle', 'Tên sản phẩm'],
    ['finishedSize', 'showFinishedSize', 'Khổ thành phẩm'],
    ['pageCount', 'showPageCount', 'Tổng số trang'],
    ['quantity', 'showQuantity', 'Số lượng cuốn'],
    ['binding', 'showBinding', 'Kiểu đóng cuốn'],
    ['bodyPaper', 'showBodyPaper', 'Giấy ruột'],
    ['coverPaper', 'showCoverPaper', 'Giấy bìa'],
    ['coverFinish', 'showCoverFinish', 'Gia công bìa'],
    ['colorMode', 'showColorMode', 'Màu in'],
    ['printSides', 'showPrintSides', 'Số mặt in'],
    ['paperSize', 'showPaperSize', 'Khổ giấy in'],
    ['notes', 'showNotes', 'Ghi chú'],
];

const BINDING_LABELS: Record<string, string> = {
    saddle: 'Bấm kim giữa',
    thread: 'Khâu chỉ',
    cut_stacks: 'Cắt đôi ráp xấp',
    continuous: 'Keo gáy / lò xo',
    flush_mount: 'Dán đôi lưng',
};

const POSITIONS = [
    ['top', 'Mép trên'],
    ['bottom', 'Mép dưới'],
    ['left', 'Mép trái'],
    ['right', 'Mép phải'],
];

export default function BookReportSettings({ sourceTotalPages = 0 }: { sourceTotalPages?: number }) {
    const { t } = useTranslation();
    const s = useImposerSettingsStore(useShallow(state => ({
        bookReportDisplay: state.bookReportDisplay,
        setBookReportDisplay: state.setBookReportDisplay,
        sourcePageDim: state.sourcePageDim,
        signatureMode: state.signatureMode,
        formsize: state.formsize,
        customSheetWidth: state.customSheetWidth,
        customSheetHeight: state.customSheetHeight,
        bleed: state.bleed,
    })));
    const cfg = s.bookReportDisplay;
    const tr = (key: string, fallback: string) => t(`imposition.bookReport:${key}`, { defaultValue: fallback });

    const preset = PREDEFINED_SIZES[s.formsize];
    const sheetWidth = (preset?.w ?? Number(s.customSheetWidth)) || 0;
    const sheetHeight = (preset?.h ?? Number(s.customSheetHeight)) || 0;
    const paperSizeLabel = sheetWidth > 0 && sheetHeight > 0
        ? `${preset ? `${s.formsize} ` : ''}${Math.round(sheetWidth)} × ${Math.round(sheetHeight)} mm`
        : '';
    const rawWidth = s.sourcePageDim ? Number(s.sourcePageDim.w) * 0.352778 : 0;
    const rawHeight = s.sourcePageDim ? Number(s.sourcePageDim.h) * 0.352778 : 0;
    const trimReduction = Math.max(0, Number(s.bleed) || 0) * 2;
    const previewData = {
        pageCount: sourceTotalPages || 0,
        finishedWidthMm: Math.max(0, rawWidth - trimReduction),
        finishedHeightMm: Math.max(0, rawHeight - trimReduction),
        bindingLabel: BINDING_LABELS[s.signatureMode] || '',
        paperSizeLabel,
    };
    const preview = buildBookReportText(cfg, previewData);
    const update = (patch: Record<string, unknown>) => s.setBookReportDisplay(prev => ({ ...prev, ...patch }));

    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
                <label className="text-[10px] text-slate-400 italic">
                    {tr('description', 'In thông tin sản phẩm lên từng mặt tờ in đầu ra')}
                </label>
                <label className="inline-flex items-center gap-2 cursor-pointer shrink-0">
                    <input
                        type="checkbox"
                        checked={cfg.enabled}
                        onChange={e => update({ enabled: e.target.checked })}
                        className="w-4 h-4 accent-indigo-600"
                    />
                    <span className="text-xs font-bold text-indigo-600 dark:text-indigo-300">
                        {tr('enable', 'Vẽ report sách/tạp chí')}
                    </span>
                </label>
            </div>

            {cfg.enabled && (
                <>
                    <div className="grid grid-cols-2 gap-2">
                        <label className="space-y-1">
                            <SectionLabel>{tr('orderCode', 'Mã đơn hàng')}</SectionLabel>
                            <input className={inputCls} value={cfg.orderCode} onChange={e => update({ orderCode: e.target.value })} placeholder="VD: DH-001" />
                        </label>
                        <label className="space-y-1">
                            <SectionLabel>{tr('title', 'Tên sản phẩm')}</SectionLabel>
                            <input className={inputCls} value={cfg.titleText} onChange={e => update({ titleText: e.target.value })} placeholder={tr('titlePlaceholder', 'VD: Tạp chí tháng 7')} />
                        </label>
                        <label className="space-y-1 col-span-2">
                            <SectionLabel>{tr('quantity', 'Số lượng cuốn')}</SectionLabel>
                            <input className={inputCls} type="number" min={0} step={1} value={cfg.quantity || ''} onChange={e => update({ quantity: Math.max(0, Number(e.target.value) || 0) })} placeholder="0" />
                        </label>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                        <label className="space-y-1">
                            <SectionLabel>{tr('bodyPaper', 'Giấy ruột / định lượng')}</SectionLabel>
                            <input className={inputCls} value={cfg.bodyPaper} onChange={e => update({ bodyPaper: e.target.value })} placeholder={tr('bodyPaperPlaceholder', 'VD: Fort 80 gsm')} />
                        </label>
                        <label className="space-y-1">
                            <SectionLabel>{tr('coverPaper', 'Giấy bìa / định lượng')}</SectionLabel>
                            <input className={inputCls} value={cfg.coverPaper} onChange={e => update({ coverPaper: e.target.value })} placeholder={tr('coverPaperPlaceholder', 'VD: C300 gsm')} />
                        </label>
                        <label className="space-y-1 col-span-2">
                            <SectionLabel>{tr('coverFinish', 'Gia công / cán bìa')}</SectionLabel>
                            <input className={inputCls} value={cfg.coverFinish} onChange={e => update({ coverFinish: e.target.value })} placeholder={tr('coverFinishPlaceholder', 'VD: Cán mờ 1 mặt')} />
                        </label>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                        <label className="space-y-1">
                            <SectionLabel>{tr('colorMode', 'Màu in')}</SectionLabel>
                            <select className={inputCls} value={cfg.colorMode} onChange={e => update({ colorMode: e.target.value })}>
                                <option>4/4 màu</option><option>4/1 màu</option><option>1/1 đen trắng</option><option>4/0 màu</option>
                            </select>
                        </label>
                        <label className="space-y-1">
                            <SectionLabel>{tr('printSides', 'Số mặt in')}</SectionLabel>
                            <select className={inputCls} value={cfg.printSides} onChange={e => update({ printSides: e.target.value })}>
                                <option>In 2 mặt</option><option>In 1 mặt</option>
                            </select>
                        </label>
                    </div>

                    <label className="space-y-1">
                        <SectionLabel>{tr('notes', 'Ghi chú sản xuất')}</SectionLabel>
                        <textarea
                            value={cfg.notes}
                            onChange={e => update({ notes: e.target.value })}
                            rows={2}
                            className="w-full px-2 py-1.5 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 resize-y"
                            placeholder={tr('notesPlaceholder', 'Thông tin cần lưu ý khi in và thành phẩm')}
                        />
                    </label>

                    <div>
                        <SectionLabel>{tr('fields', 'Trường hiển thị trên report')}</SectionLabel>
                        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 mt-2">
                            {FIELD_CONTROLS.map(([field, flag, label]) => (
                                <Checkbox
                                    key={field}
                                    checked={cfg[flag] !== false}
                                    onChange={checked => update({ [flag]: checked })}
                                    label={tr(`field_${field}`, label)}
                                />
                            ))}
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                        <label className="space-y-1">
                            <SectionLabel>{tr('position', 'Vị trí trên tờ')}</SectionLabel>
                            <select className={inputCls} value={cfg.position} onChange={e => update({ position: e.target.value })}>
                                {POSITIONS.map(([value, label]) => <option key={value} value={value}>{tr(`position_${value}`, label)}</option>)}
                            </select>
                        </label>
                        <label className="space-y-1">
                            <SectionLabel>{tr('fontSize', 'Cỡ chữ (pt)')}</SectionLabel>
                            <input className={inputCls} type="number" min={4} max={24} step={0.5} value={cfg.fontSize} onChange={e => update({ fontSize: Math.max(4, Number(e.target.value) || 7) })} />
                        </label>
                    </div>
                    <Checkbox checked={cfg.centered} onChange={checked => update({ centered: checked })} label={tr('centered', 'Canh giữa theo mép')} />
                    <div className="grid grid-cols-2 gap-2">
                        <label className="space-y-1">
                            <SectionLabel>{tr('offsetX', 'Khoảng cách X (mm)')}</SectionLabel>
                            <input className={inputCls} type="number" min={0} step={0.5} value={cfg.offsetX} onChange={e => update({ offsetX: Math.max(0, Number(e.target.value) || 0) })} />
                        </label>
                        <label className="space-y-1">
                            <SectionLabel>{tr('offsetY', 'Khoảng cách Y (mm)')}</SectionLabel>
                            <input className={inputCls} type="number" min={0} step={0.5} value={cfg.offsetY} onChange={e => update({ offsetY: Math.max(0, Number(e.target.value) || 0) })} />
                        </label>
                    </div>
                    <Checkbox checked={cfg.removeDiacritics} onChange={checked => update({ removeDiacritics: checked })} label={tr('removeDiacritics', 'Bỏ dấu tiếng Việt khi in report')} />

                    <div className="rounded-md border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50/60 dark:bg-indigo-500/10 px-2.5 py-2">
                        <div className="text-[10px] font-bold uppercase tracking-wide text-indigo-600 dark:text-indigo-300 mb-1">
                            {tr('preview', 'Xem trước nội dung sẽ in')}
                        </div>
                        <div className="whitespace-pre-line text-[11px] leading-relaxed text-slate-700 dark:text-zinc-200 break-words">
                            {preview || tr('emptyPreview', 'Chưa có nội dung. Hãy nhập thông tin hoặc bật trường hiển thị.')}
                        </div>
                    </div>
                    <p className="text-[10px] leading-relaxed text-amber-600 dark:text-amber-300">
                        {tr('marginWarning', 'Report được đặt trong vùng lề của tờ in. Hãy chừa đủ lề tại mép đã chọn để chữ không đè lên sản phẩm.')}
                    </p>
                </>
            )}
        </div>
    );
}
