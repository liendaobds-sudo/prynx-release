import { useState } from 'react';
import { ScaleMode, ResizeOptions } from '../../lib/preprocessEngine/PageResizer';
import { 
    ToolSectionLabel, ToolDivider, ToolCardOption, 
    ToolCheckboxOption, ToolNumberInput, ToolInfo 
} from './ToolUI';

const inputCls = "w-full h-8 px-2 border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500";

const COMMON_SIZES = [
    { id: 'A4', name: 'A4', desc: '210 x 297 mm', w: 210, h: 297 },
    { id: 'A3', name: 'A3', desc: '297 x 420 mm', w: 297, h: 420 },
    { id: 'A5', name: 'A5', desc: '148 x 210 mm', w: 148, h: 210 },
    { id: 'SRA3', name: 'SRA3', desc: '320 x 450 mm', w: 320, h: 450 },
    { id: 'B2', name: 'B2', desc: '500 x 707 mm', w: 500, h: 707 },
    { id: 'B3', name: 'B3', desc: '353 x 500 mm', w: 353, h: 500 },
    { id: 'Letter', name: 'Letter', desc: '216 x 279 mm', w: 216, h: 279 },
    { id: 'custom', name: 'Tùy chỉnh', desc: 'Nhập W x H', w: 0, h: 0 },
];

export interface PageResizerSettings extends ResizeOptions {
    sizePresetId: string;
    applyToStr: string;
}

interface Props {
    settings: PageResizerSettings;
    onChange: (settings: PageResizerSettings) => void;
}

export default function PageResizerTool({ settings, onChange }: Props) {
    
    const handlePresetChange = (presetId: string) => {
        const preset = COMMON_SIZES.find(p => p.id === presetId);
        if (preset) {
            onChange({
                ...settings,
                sizePresetId: presetId,
                targetW: preset.id === 'custom' ? settings.targetW : preset.w,
                targetH: preset.id === 'custom' ? settings.targetH : preset.h
            });
        }
    };

    const handleApplyToChange = (val: string) => {
        let applyTo: ResizeOptions['applyTo'] = 'all';
        if (val === 'all' || val === 'even' || val === 'odd') {
            applyTo = val;
        } else {
            // parse custom pages on execution, keep as 'all' for now in type but we use applyToStr
            applyTo = 'all'; 
        }

        onChange({
            ...settings,
            applyToStr: val,
            applyTo
        });
    };

    return (
        <div className="flex flex-col gap-4 animate-in fade-in duration-200 relative z-[60]">
            
            <div className="flex flex-col gap-2">
                <ToolSectionLabel>1. Kích thước trang đích</ToolSectionLabel>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                    {COMMON_SIZES.map(p => (
                        <ToolCardOption 
                            key={p.id}
                            selected={settings.sizePresetId === p.id}
                            onClick={() => handlePresetChange(p.id)}
                            label={p.name}
                            desc={p.desc}
                        />
                    ))}
                </div>
                
                {settings.sizePresetId === 'custom' && (
                    <div className="grid grid-cols-2 gap-3 mt-3 p-3 bg-white dark:bg-zinc-800/50 rounded-lg border border-black/5 dark:border-white/5">
                        <ToolNumberInput 
                            label="Chiều ngang"
                            value={settings.targetW}
                            onChange={val => onChange({ ...settings, targetW: val })}
                            suffix="mm" step={0.1}
                        />
                        <ToolNumberInput 
                            label="Chiều dọc"
                            value={settings.targetH}
                            onChange={val => onChange({ ...settings, targetH: val })}
                            suffix="mm" step={0.1}
                        />
                    </div>
                )}
            </div>

            <ToolDivider />

            <div className="flex flex-col gap-2">
                <ToolSectionLabel>2. Kiểu tỷ lệ</ToolSectionLabel>
                <div className="grid grid-cols-2 gap-2">
                    <ToolCheckboxOption 
                        selected={settings.scaleMode === 'fit'}
                        onClick={() => onChange({...settings, scaleMode: 'fit'})}
                        label="Thu vừa khít"
                        desc="Thu phóng nội dung vừa khít vào khổ giấy mới, phần thừa sẽ để trống (tạo lề trắng)."
                    />
                    <ToolCheckboxOption 
                        selected={settings.scaleMode === 'fill'}
                        onClick={() => onChange({...settings, scaleMode: 'fill'})}
                        label="Phóng lấp đầy"
                        desc="Phóng to nội dung lấp đầy khổ mới, phần dư thừa sẽ bị cắt xém."
                    />
                    <ToolCheckboxOption 
                        selected={settings.scaleMode === 'stretch'}
                        onClick={() => onChange({...settings, scaleMode: 'stretch'})}
                        label="Ép bóp méo"
                        desc="Ép nội dung vừa đúng khổ mới nhưng không giữ tỷ lệ gốc (ảnh có thể bị méo)."
                    />
                    <ToolCheckboxOption 
                        selected={settings.scaleMode === 'center_no_scale'}
                        onClick={() => onChange({...settings, scaleMode: 'center_no_scale'})}
                        label="Giữ nguyên ở giữa"
                        desc="Giữ nguyên kích thước nội dung gốc, chỉ đặt ở giữa khổ giấy mới."
                    />
                </div>
            </div>

            <ToolDivider />

            <div className="flex flex-col gap-2">
                <ToolSectionLabel>3. Áp dụng cho</ToolSectionLabel>
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
                        <div className="text-[10px] text-slate-400 mt-1.5 ml-1">Nhập số trang cách nhau bằng dấu phẩy hoặc gạch ngang.</div>
                    </div>
                )}
            </div>

        </div>
    );
}
