import React from 'react';
import { ToolSectionLabel, ToolCardOption, ToolCheckboxOption, ToolNumberInput } from './ToolUI';

export interface BgRemoverOptionsState {
    aiEngine: 'fast' | 'general' | 'hair';
    edgeShift: number;
    bgColor: 'transparent' | 'white' | 'black' | 'custom';
    customHex: string;
    autoCrop: boolean;
}

interface Props {
    options: BgRemoverOptionsState;
    onChange: (opts: BgRemoverOptionsState) => void;
}

export default function BgRemoverOptions({ options, onChange }: Props) {
    const update = (key: keyof BgRemoverOptionsState, val: any) => {
        onChange({ ...options, [key]: val });
    };

    return (
        <div className="flex flex-col gap-4 mt-2">
            {/* AI Engine Selection */}
            <div>
                <ToolSectionLabel>Mô hình Phân tích</ToolSectionLabel>
                <div className="grid grid-cols-1 gap-1.5">
                    <ToolCardOption
                        label="Chất lượng cao (Khuyên dùng)"
                        desc="Viền sắc nét, bám chi tiết tốt. Cân bằng đẹp/nhanh (~vài giây). Dùng cho hầu hết sản phẩm, tem, người, vật thể."
                        selected={options.aiEngine === 'general'}
                        onClick={() => update('aiEngine', 'general')}
                    />
                    <ToolCardOption
                        label="Nhanh (xử lý hàng loạt)"
                        desc="Tách gần như tức thì, nhẹ. Chất lượng khá — hợp khi cần nhanh nhiều ảnh hoặc nền đơn giản."
                        selected={options.aiEngine === 'fast'}
                        onClick={() => update('aiEngine', 'fast')}
                    />
                    <ToolCardOption
                        label="Tối đa — Lông, Tóc & Kính"
                        desc="Chất lượng cao nhất cho tóc rối, lông thú, lưới, kính bán trong suốt. CHẬM (GPU yếu sẽ chạy CPU, có thể ~10–15s/ảnh)."
                        selected={options.aiEngine === 'hair'}
                        onClick={() => update('aiEngine', 'hair')}
                    />
                </div>
            </div>

            {/* Edge Shift */}
            <div>
                <div className="flex justify-between items-end mb-1">
                    <ToolSectionLabel>Khử viền rác (Edge Shift)</ToolSectionLabel>
                </div>
                <div className="flex items-center gap-3">
                    <input 
                        type="range" 
                        min="-5" max="5" step="1"
                        value={options.edgeShift}
                        onChange={(e) => update('edgeShift', parseInt(e.target.value))}
                        className="flex-1 accent-teal-500"
                    />
                    <div className="w-12 text-center text-[12px] font-bold text-slate-700 dark:text-zinc-300 bg-slate-100 dark:bg-zinc-800 rounded py-1 border border-slate-200 dark:border-zinc-700">
                        {options.edgeShift > 0 ? `+${options.edgeShift}` : options.edgeShift}px
                    </div>
                </div>
                <p className="text-[10px] text-slate-400 mt-1.5">
                    Kéo âm (-) để ăn lẹm vào trong, cắt bỏ viền trắng mờ rác bao quanh chủ thể. Kéo dương (+) để mở rộng vùng chọn.
                </p>
            </div>

            {/* Auto Crop */}
            <div>
                <ToolSectionLabel>Tùy chọn Khung ảnh</ToolSectionLabel>
                <ToolCheckboxOption
                    label="Tự động cắt cúp (Auto-Crop)"
                    desc="Phần mềm tự động xén bỏ tất cả các khoảng trống vô ích xung quanh chủ thể. Rất tiện để dồn file bình bài N-Up giúp tiết kiệm giấy."
                    selected={options.autoCrop}
                    onClick={() => update('autoCrop', !options.autoCrop)}
                />
            </div>
        </div>
    );
}
