import { useState } from 'react';
import { SplitMode } from '../../lib/preprocessEngine/PdfSplitter';
import { 
    ToolSectionLabel, ToolDivider, ToolCheckboxOption, 
    ToolNumberInput, ToolInfo 
} from './ToolUI';

const inputCls = "w-full h-8 px-2.5 text-[12px] border border-slate-300 dark:border-white/20 rounded-md bg-white dark:bg-zinc-900 font-medium focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500/20 transition-all";

export interface SplitSettings {
    mode: SplitMode;
    ranges: string;
    pagesPerFile: number;
    pageListStr: string;
}

interface Props {
    settings: SplitSettings;
    onChange: (settings: SplitSettings) => void;
}

export default function SplitTool({ settings, onChange }: Props) {
    return (
        <div className="flex flex-col gap-4 animate-in fade-in duration-200 relative z-[60]">
            
            <div className="flex flex-col gap-2">
                <ToolSectionLabel>1. Chế độ tách</ToolSectionLabel>
                <div className="flex flex-col gap-2">
                    <ToolCheckboxOption 
                        selected={settings.mode === 'by_range'}
                        onClick={() => onChange({...settings, mode: 'by_range'})}
                        label="Tách theo Dải trang"
                        desc="Tách PDF thành nhiều file tùy chỉnh dựa theo dải trang nhập vào."
                    />
                    <ToolCheckboxOption 
                        selected={settings.mode === 'by_count'}
                        onClick={() => onChange({...settings, mode: 'by_count'})}
                        label="Chia đều số lượng trang"
                        desc="Chia đều PDF thành các file nhỏ có cùng số trang (vd: 4 trang một file)."
                    />
                    <ToolCheckboxOption 
                        selected={settings.mode === 'extract_pages'}
                        onClick={() => onChange({...settings, mode: 'extract_pages'})}
                        label="Trích xuất trang"
                        desc="Trích xuất các trang được chỉ định ra thành 1 file duy nhất."
                    />
                </div>
            </div>

            <ToolDivider />

            <div className="flex flex-col gap-2 min-h-[90px]">
                {settings.mode === 'by_range' && (
                    <div className="animate-in fade-in slide-in-from-top-1 duration-200 p-3 bg-white dark:bg-zinc-800/50 rounded-lg border border-black/5 dark:border-white/5">
                        <ToolSectionLabel>Cú pháp dải trang</ToolSectionLabel>
                        <input
                            type="text"
                            value={settings.ranges}
                            onChange={e => onChange({ ...settings, ranges: e.target.value })}
                            placeholder="VD: 1-4, 5-8, 10, 12-20"
                            className={inputCls}
                        />
                        <div className="text-[10px] text-slate-500 mt-2 leading-relaxed">
                            Mỗi dải phân cách bởi dấu phẩy tương ứng 1 file output.<br/>
                            VD: "1-4, 5-8" → Tạo ra 2 file (file chứa tr1-tr4, file chứa tr5-tr8).
                        </div>
                    </div>
                )}

                {settings.mode === 'by_count' && (
                    <div className="animate-in fade-in slide-in-from-top-1 duration-200 p-3 bg-white dark:bg-zinc-800/50 rounded-lg border border-black/5 dark:border-white/5">
                        <ToolSectionLabel>Số trang mỗi file</ToolSectionLabel>
                        <ToolNumberInput 
                            label=""
                            value={settings.pagesPerFile}
                            onChange={val => onChange({ ...settings, pagesPerFile: val || 1 })}
                            step={1}
                        />
                        <div className="text-[10px] text-slate-500 mt-2 leading-relaxed">
                            Chia tài liệu gốc thành nhiều file con, số trang mỗi file được chia làm tròn.
                        </div>
                    </div>
                )}

                {settings.mode === 'extract_pages' && (
                    <div className="animate-in fade-in slide-in-from-top-1 duration-200 p-3 bg-white dark:bg-zinc-800/50 rounded-lg border border-black/5 dark:border-white/5">
                        <ToolSectionLabel>Trang cần trích xuất</ToolSectionLabel>
                        <input
                            type="text"
                            value={settings.pageListStr}
                            onChange={e => onChange({ ...settings, pageListStr: e.target.value })}
                            placeholder="VD: 1, 3, 5, 10"
                            className={inputCls}
                        />
                        <div className="text-[10px] text-slate-500 mt-2 leading-relaxed">
                            Nhập các số trang riêng biệt, cách nhau bằng dấu phẩy. Chúng sẽ được gộp chung vào 1 file PDF mới.
                        </div>
                    </div>
                )}
            </div>
            
            <ToolInfo desc={
                <><strong>Ghi chú:</strong> Tác vụ Split sẽ tạo ra nhiều file PDF hoặc một file PDF tùy theo chế độ, bạn sẽ tải xuống toàn bộ dưới định dạng tệp ZIP hoặc xuất ra các tab mới tương ứng.</>
            } />
        </div>
    );
}
