import { useState } from 'react';
import {
    ToolSectionLabel, ToolDivider, ToolCardOption,
    ToolCheckboxOption, ToolNumberInput, ToolInfo
} from './ToolUI';

const inputCls = "w-full h-8 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500";

export type TrimUnit = 'mm' | 'cm' | 'pt' | 'inch';

/** Hệ số quy đổi 1 đơn vị → mm (backend luôn nhận mm). */
export const UNIT_TO_MM: Record<TrimUnit, number> = {
    mm: 1,
    cm: 10,
    pt: 25.4 / 72,
    inch: 25.4,
};

const UNIT_OPTIONS: { id: TrimUnit; label: string }[] = [
    { id: 'mm', label: 'mm' },
    { id: 'cm', label: 'cm' },
    { id: 'pt', label: 'pt' },
    { id: 'inch', label: 'inch' },
];

export type ContentMode = 'original' | 'clip';

export interface TrimShiftSettings {
    unit: TrimUnit;
    sameAllEdges: boolean;
    trimTop: number;
    trimBottom: number;
    trimLeft: number;
    trimRight: number;
    shiftX: number;
    shiftY: number;
    bindingEnabled: boolean;
    bindingMm: number;
    bindingInward: boolean;
    creepEnabled: boolean;
    creepMm: number;
    creepAxis: 'x' | 'y';
    mirrorFill: boolean;
    contentMode: ContentMode;
    keepBleed: boolean;
    applyToStr: string;
}

interface Props {
    settings: TrimShiftSettings;
    onChange: (settings: TrimShiftSettings) => void;
}

export default function TrimShiftTool({ settings, onChange }: Props) {

    const u = settings.unit || 'mm';
    const [advancedOpen, setAdvancedOpen] = useState(false);

    const handleApplyToChange = (val: string) => {
        onChange({ ...settings, applyToStr: val });
    };

    // Khi bật "đồng đều 4 cạnh": mọi ô trim dùng chung giá trị cạnh trên.
    const setEdge = (edge: 'trimTop' | 'trimBottom' | 'trimLeft' | 'trimRight', val: number) => {
        if (settings.sameAllEdges) {
            onChange({ ...settings, trimTop: val, trimBottom: val, trimLeft: val, trimRight: val });
        } else {
            onChange({ ...settings, [edge]: val });
        }
    };

    const toggleSameEdges = () => {
        const next = !settings.sameAllEdges;
        // Bật: đồng bộ cả 4 cạnh về giá trị cạnh trên để không nhảy giá trị bất ngờ.
        if (next) {
            onChange({ ...settings, sameAllEdges: true, trimBottom: settings.trimTop, trimLeft: settings.trimTop, trimRight: settings.trimTop });
        } else {
            onChange({ ...settings, sameAllEdges: false });
        }
    };

    // Đếm số tùy chọn nâng cao đang bật → hiện badge để người dùng biết có gì bên trong.
    const advancedActive =
        (settings.shiftX ? 1 : 0) + (settings.shiftY ? 1 : 0) +
        (settings.bindingEnabled ? 1 : 0) + (settings.creepEnabled ? 1 : 0) +
        (settings.mirrorFill ? 1 : 0) + (settings.contentMode === 'clip' ? 1 : 0) +
        (settings.keepBleed ? 1 : 0);

    return (
        <div className="flex flex-col gap-4 animate-in fade-in duration-200 relative z-[60]">

            {/* Đơn vị */}
            <div className="flex items-center justify-between">
                <span className="text-[13px] font-semibold text-slate-700 dark:text-zinc-200">Đơn vị</span>
                <div className="flex gap-1">
                    {UNIT_OPTIONS.map(opt => (
                        <button
                            key={opt.id}
                            onClick={() => onChange({ ...settings, unit: opt.id })}
                            className={`px-3 h-8 rounded text-[12.5px] font-semibold border transition-all
                                ${u === opt.id
                                    ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300'
                                    : 'border-slate-200 dark:border-white/10 text-slate-500 hover:bg-slate-50 dark:hover:bg-zinc-800'}`}
                        >
                            {opt.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* ══ CƠ BẢN: Cắt xén / thêm lề từng cạnh ══ */}
            <div className="flex flex-col gap-2">
                <ToolSectionLabel>Cắt xén / Thêm lề (± mỗi cạnh)</ToolSectionLabel>
                <ToolCheckboxOption
                    selected={settings.sameAllEdges}
                    onClick={toggleSameEdges}
                    label="Đồng đều cả 4 cạnh"
                    desc="Nhập một lần, áp cùng lượng cho trên/dưới/trái/phải."
                />
                <div className="grid grid-cols-2 gap-3 p-3 bg-white dark:bg-zinc-800/50 rounded-lg border border-black/5 dark:border-white/5">
                    <ToolNumberInput label="Cạnh trên" value={settings.trimTop} onChange={val => setEdge('trimTop', val)} suffix={u} step={0.1} />
                    <ToolNumberInput label="Cạnh dưới" value={settings.trimBottom} onChange={val => setEdge('trimBottom', val)} suffix={u} step={0.1} className={settings.sameAllEdges ? 'opacity-50 pointer-events-none' : ''} />
                    <ToolNumberInput label="Cạnh trái" value={settings.trimLeft} onChange={val => setEdge('trimLeft', val)} suffix={u} step={0.1} className={settings.sameAllEdges ? 'opacity-50 pointer-events-none' : ''} />
                    <ToolNumberInput label="Cạnh phải" value={settings.trimRight} onChange={val => setEdge('trimRight', val)} suffix={u} step={0.1} className={settings.sameAllEdges ? 'opacity-50 pointer-events-none' : ''} />
                </div>
                <div className="text-[11.5px] text-slate-500 dark:text-zinc-400 mt-1 ml-1 leading-relaxed">Dương = thêm khoảng trắng (nở khổ), âm = cắt bớt (thu khổ). Chỉ đổi khổ, không phá nội dung.</div>
            </div>

            <ToolDivider />

            {/* ══ CƠ BẢN: Phạm vi trang ══ */}
            <div className="flex flex-col gap-2">
                <ToolSectionLabel>Áp dụng cho</ToolSectionLabel>
                <div className="grid grid-cols-2 gap-2">
                    <ToolCardOption selected={settings.applyToStr === 'all'} onClick={() => handleApplyToChange('all')} label="Tất cả trang" />
                    <ToolCardOption selected={settings.applyToStr === 'even'} onClick={() => handleApplyToChange('even')} label="Trang chẵn" />
                    <ToolCardOption selected={settings.applyToStr === 'odd'} onClick={() => handleApplyToChange('odd')} label="Trang lẻ" />
                    <ToolCardOption selected={!['all', 'even', 'odd'].includes(settings.applyToStr)} onClick={() => handleApplyToChange('custom')} label="Tùy chỉnh" />
                </div>

                {!['all', 'even', 'odd'].includes(settings.applyToStr) && (
                    <div className="mt-3">
                        <input
                            type="text"
                            value={settings.applyToStr === 'custom' ? '' : settings.applyToStr}
                            onChange={e => handleApplyToChange(e.target.value)}
                            placeholder="VD: 1, 3, 5-10"
                            className={inputCls}
                        />
                        <div className="text-[11.5px] text-slate-500 dark:text-zinc-400 mt-1.5 ml-1">Nhập số trang cách nhau bằng dấu phẩy hoặc gạch ngang.</div>
                    </div>
                )}
            </div>

            {/* ══ NÂNG CAO (đóng sẵn) ══ */}
            <div className="border border-slate-200 dark:border-white/10 rounded-lg overflow-hidden">
                <button
                    onClick={() => setAdvancedOpen(v => !v)}
                    className="w-full flex items-center justify-between px-3 py-2.5 text-[12px] font-semibold text-slate-600 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800 transition-colors"
                >
                    <span className="flex items-center gap-2">
                        <span className={`transition-transform ${advancedOpen ? 'rotate-90' : ''}`}>▸</span>
                        Tùy chọn nâng cao
                        {advancedActive > 0 && (
                            <span className="px-1.5 h-4 flex items-center rounded-full bg-teal-500/15 text-teal-600 dark:text-teal-300 text-[9.5px] font-bold">{advancedActive}</span>
                        )}
                    </span>
                    <span className="text-[11px] text-slate-500 dark:text-zinc-400 font-normal">Dời nội dung · Bù gáy · Creep · Bù xén · Nội dung ẩn</span>
                </button>

                {advancedOpen && (
                    <div className="p-3 flex flex-col gap-4 border-t border-slate-200 dark:border-white/10 bg-slate-50/40 dark:bg-zinc-900/40">

                        {/* Dời nội dung */}
                        <div className="flex flex-col gap-2">
                            <ToolSectionLabel>Dời nội dung (Shift)</ToolSectionLabel>
                            <div className="grid grid-cols-2 gap-3 p-3 bg-white dark:bg-zinc-800/50 rounded-lg border border-black/5 dark:border-white/5">
                                <ToolNumberInput label="Ngang (X)" value={settings.shiftX} onChange={val => onChange({ ...settings, shiftX: val })} suffix={u} step={0.1} />
                                <ToolNumberInput label="Dọc (Y)" value={settings.shiftY} onChange={val => onChange({ ...settings, shiftY: val })} suffix={u} step={0.1} />
                            </div>
                            <div className="text-[11.5px] text-slate-500 dark:text-zinc-400 mt-1 ml-1">X dương = dịch phải, Y dương = dịch lên.</div>
                        </div>

                        <ToolDivider />

                        {/* Bù lề gáy */}
                        <div className="flex flex-col gap-2">
                            <ToolSectionLabel>Bù lề gáy (Binding)</ToolSectionLabel>
                            <ToolCheckboxOption
                                selected={settings.bindingEnabled}
                                onClick={() => onChange({ ...settings, bindingEnabled: !settings.bindingEnabled })}
                                label="Dời lề trong/ngoài theo trang lẻ-chẵn"
                                desc="Trang lẻ và chẵn dịch ngược chiều nhau để chừa khoảng đóng gáy."
                            />
                            {settings.bindingEnabled && (
                                <div className="grid grid-cols-2 gap-3 mt-1 p-3 bg-white dark:bg-zinc-800/50 rounded-lg border border-black/5 dark:border-white/5">
                                    <ToolNumberInput label="Lượng bù" value={settings.bindingMm} onChange={val => onChange({ ...settings, bindingMm: val })} suffix={u} step={0.1} min={0} />
                                    <div>
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">Hướng</span>
                                        <div className="grid grid-cols-2 gap-1">
                                            <ToolCardOption selected={settings.bindingInward} onClick={() => onChange({ ...settings, bindingInward: true })} label="Vào gáy" />
                                            <ToolCardOption selected={!settings.bindingInward} onClick={() => onChange({ ...settings, bindingInward: false })} label="Ra ngoài" />
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        <ToolDivider />

                        {/* Creep */}
                        <div className="flex flex-col gap-2">
                            <ToolSectionLabel>Bù gáy tăng dần (Creep)</ToolSectionLabel>
                            <ToolCheckboxOption
                                selected={settings.creepEnabled}
                                onClick={() => onChange({ ...settings, creepEnabled: !settings.creepEnabled })}
                                label="Dời nội dung tăng dần theo vị trí trang"
                                desc="Trang đầu dịch 0, tăng tuyến tính tới lượng đặt ở trang cuối (bù độ dày giấy khi gấp)."
                            />
                            {settings.creepEnabled && (
                                <div className="grid grid-cols-2 gap-3 mt-1 p-3 bg-white dark:bg-zinc-800/50 rounded-lg border border-black/5 dark:border-white/5">
                                    <ToolNumberInput label="Lượng tối đa" value={settings.creepMm} onChange={val => onChange({ ...settings, creepMm: val })} suffix={u} step={0.1} />
                                    <div>
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">Trục</span>
                                        <div className="grid grid-cols-2 gap-1">
                                            <ToolCardOption selected={settings.creepAxis === 'x'} onClick={() => onChange({ ...settings, creepAxis: 'x' })} label="Ngang" />
                                            <ToolCardOption selected={settings.creepAxis === 'y'} onClick={() => onChange({ ...settings, creepAxis: 'y' })} label="Dọc" />
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        <ToolDivider />

                        {/* Bù xén phản chiếu */}
                        <div className="flex flex-col gap-2">
                            <ToolSectionLabel>Bù xén phản chiếu (Mirror bleed)</ToolSectionLabel>
                            <ToolCheckboxOption
                                selected={settings.mirrorFill}
                                onClick={() => onChange({ ...settings, mirrorFill: !settings.mirrorFill })}
                                label="Lấp vùng lề mới bằng nội dung lật gương"
                                desc="Khi thêm lề (giá trị dương), phần trắng mới được lấp bằng nội dung sát mép phản chiếu ra — tránh lộ viền trắng khi xén. Chỉ áp cho trang không xoay."
                            />
                        </div>

                        <ToolDivider />

                        {/* Nội dung ẩn khi nới khổ */}
                        <div className="flex flex-col gap-2">
                            <ToolSectionLabel>Nội dung ẩn khi nới khổ</ToolSectionLabel>
                            <div className="grid grid-cols-1 gap-2">
                                <ToolCheckboxOption
                                    selected={settings.contentMode === 'original'}
                                    onClick={() => onChange({ ...settings, contentMode: 'original' })}
                                    label="Giữ nguyên — để nội dung ẩn lộ ra"
                                    desc="Khi nới khổ, phần nội dung nằm ngoài vùng crop cũ sẽ hiện ra. Giống chế độ Original của Quite."
                                />
                                <ToolCheckboxOption
                                    selected={settings.contentMode === 'clip'}
                                    onClick={() => onChange({ ...settings, contentMode: 'clip' })}
                                    label="Cắt sạch — vùng mới để trắng"
                                    desc="Cắt nội dung theo vùng nhìn cũ, phần khổ mới để trắng hoàn toàn. Giống chế độ Improved của Quite. Bỏ qua nếu đã bật bù xén phản chiếu."
                                />
                            </div>
                        </div>

                        <ToolDivider />

                        {/* Giữ lề bleed */}
                        <div className="flex flex-col gap-2">
                            <ToolCheckboxOption
                                selected={settings.keepBleed}
                                onClick={() => onChange({ ...settings, keepBleed: !settings.keepBleed })}
                                label="Giữ nguyên lề bleed khi cắt"
                                desc="Khi cắt/nới khổ, TrimBox & BleedBox co giãn cùng lượng để lượng bleed không đổi. Chỉ ảnh hưởng file đã có sẵn các box này."
                            />
                        </div>
                    </div>
                )}
            </div>

            <ToolInfo desc="Cơ bản: chỉ cần chọn lượng cắt/thêm lề và phạm vi trang. Mở 'Tùy chọn nâng cao' cho dời nội dung, bù gáy, creep và các tùy chọn xử lý file đã crop/có bleed." />
        </div>
    );
}
