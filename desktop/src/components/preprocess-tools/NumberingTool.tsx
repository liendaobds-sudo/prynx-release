import React, { useState, useEffect, useRef } from 'react';
import { startVdpJobBackend, getVdpJobStatus, downloadVdpJob, pollVdpJob } from '@/lib/api';
import { CmykColorPicker } from './DataMergeTool';
import { ToolNumberInput } from './ToolUI';
import { FontSelector } from './FontSelector';
import { useVdpTool } from '@/hooks/useVdpTool';
import { startVdpDrag } from '../../utils/vdpDrag';
import { sortFieldsGeometrically, VdpSortMethod } from '@/lib/vdpUtils';
import { VdpAlignPanel } from './VdpAlignPanel';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import { useNumberingJobStore } from '@/stores/useNumberingJobStore';

interface Props {
  pdfFile: File | null;
  getWorkingFile?: () => Promise<File>;
  vdpFields?: any[];
  setVdpFields?: React.Dispatch<React.SetStateAction<any[]>>;
  selectedFieldIds?: string[];
  onSelectField?: (ids: string[]) => void;
  onBack?: () => void;
  onSpawnTab?: (blob: Blob, name: string) => void;
  onApplyResult?: (blob: Blob, name: string) => void;
  isActive?: boolean;
}

export default function NumberingTool({
  pdfFile,
  getWorkingFile,
  vdpFields = [],
  setVdpFields,
  selectedFieldIds = [],
  onSelectField,
  onBack,
  onSpawnTab,
  onApplyResult,
  isActive = true
}: Props) {
    const [statusMessage, setStatusMessage] = useState("");
    const [isGenerating, setIsGenerating] = useState(false);
    const [spawnNewTab, setSpawnNewTab] = useState(true);

    // Hủy polling VDP khi unmount để không poll vô hạn nền (#13).
    const pollAbortRef = useRef<AbortController | null>(null);
    useEffect(() => () => { pollAbortRef.current?.abort(); }, []);

    // Generation State
    const [genMethod, setGenMethod] = useState<'range' | 'set'>('range');
    
    // Range State
    const [startNum, setStartNum] = useState<number>(1);
    const [endNum, setEndNum] = useState<number>(100);
    const [increment, setIncrement] = useState<number>(1);
    const [padZero, setPadZero] = useState<boolean>(true);
    const [padLength, setPadLength] = useState<number>(3);
    const [prefix, setPrefix] = useState<string>('');
    const [suffix, setSuffix] = useState<string>('');
    const [isShuffle, setIsShuffle] = useState<boolean>(false);

    // Set State
    const [setTotal, setSetTotal] = useState<number>(1);
    const [setStartStr, setSetStartStr] = useState<string>('A');
    const [seqTotal, setSeqTotal] = useState<number>(50);
    const [seqStart, setSeqStart] = useState<number>(1);
    const [formatTemplate, setFormatTemplate] = useState<string>('{%b}-{%t}');

    // Application Style & Sorting
    const [sortMethod, setSortMethod] = useState<VdpSortMethod>('rows');
    const [applyStyle, setApplyStyle] = useState<'linear' | 'stack'>('linear');

    const viewerPageDimMm = useWorkspaceStore(s => s.viewerPageDimMm);

    // PA1: khi liên kết với Mẹc Bìa, công bố dải số ruột lên job dùng chung để bìa khớp.
    const jobLinked = useNumberingJobStore(s => s.linked);
    const setSharedJob = useNumberingJobStore(s => s.setJob);
    useEffect(() => {
        if (jobLinked && genMethod === 'range') {
            setSharedJob({ startNum, endNum, padding: padZero ? padLength : 0 });
        }
    }, [jobLinked, genMethod, startNum, endNum, padZero, padLength, setSharedJob]);

    const {
        updateSelectedField,
        deleteSelectedField,
        handleGroupFields,
        handleUngroupFields
    } = useVdpTool(vdpFields, setVdpFields as any, selectedFieldIds, onSelectField, isActive);

    // Sync vdpFields names to "Slot 1", "Slot 2" automatically
    useEffect(() => {
        if (!setVdpFields || vdpFields.length === 0) return;
        // Optional: Ensure fields are named logically for numbering
        let needsUpdate = false;
        const updated = vdpFields.map((f, idx) => {
            if (!f.name || !f.name.startsWith('Slot')) {
                needsUpdate = true;
                return { ...f, name: `Slot${idx + 1}`, textContent: `{Slot${idx + 1}}` };
            }
            return f;
        });
        if (needsUpdate) setVdpFields(updated);
    }, [vdpFields.length]); // Only run when field count changes



    const generateSequence = () => {
        // Trần an toàn số phần tử để preview/sinh không làm đơ app với range/bộ quá lớn.
        const MAX_SEQUENCE = 200000;
        let rawSequence: string[] = [];
        
        if (genMethod === 'range') {
            // GUARD chống TREO APP: hàm này chạy LIVE trong preview (useMemo) nên một
            // bước nhảy ≤ 0 (vd người dùng gõ 0 hoặc xoá trống → Number('')===0) sẽ làm
            // vòng for chạy VÔ HẠN → đơ toàn ứng dụng. Bước nhảy không hợp lệ → trả rỗng.
            const step = Number(increment);
            if (Number.isFinite(step) && step > 0 && Number.isFinite(startNum) && Number.isFinite(endNum)) {
                for (let i = startNum; i <= endNum; i += step) {
                    // Chặn TRÊN: range quá lớn (vd 1..1_000_000) cũng làm đơ preview.
                    if (rawSequence.length >= MAX_SEQUENCE) break;
                    let numStr = i.toString();
                    if (padZero) {
                        numStr = numStr.padStart(padLength, '0');
                    }
                    rawSequence.push(`${prefix}${numStr}${suffix}`);
                }
            }
        } else {
            // Set Mode
            const isAlphaSet = isNaN(Number(setStartStr)) && setStartStr.length > 0;
            const isLower = isAlphaSet && setStartStr.charCodeAt(0) >= 97;
            
            const lettersToNumber = (letters: string) => {
                let num = 0;
                for (let i = 0; i < letters.length; i++) {
                    num = num * 26 + (letters.toUpperCase().charCodeAt(i) - 64);
                }
                return num;
            };

            const numberToLetters = (num: number, lower = false) => {
                let str = "";
                while (num > 0) {
                    let rem = (num - 1) % 26;
                    str = String.fromCharCode(rem + (lower ? 97 : 65)) + str;
                    num = Math.floor((num - 1) / 26);
                }
                return str;
            };

            const startSetNum = isAlphaSet ? lettersToNumber(setStartStr) : (parseInt(setStartStr) || 1);
            
            for (let s = 0; s < setTotal; s++) {
                if (rawSequence.length >= MAX_SEQUENCE) break;
                let setValStr = "";
                if (isAlphaSet) {
                    setValStr = numberToLetters(startSetNum + s, isLower);
                } else {
                    let sNum = startSetNum + s;
                    setValStr = padZero ? sNum.toString().padStart(setStartStr.length > 1 ? setStartStr.length : padLength, '0') : sNum.toString();
                }

                for (let q = 0; q < seqTotal; q++) {
                    if (rawSequence.length >= MAX_SEQUENCE) break;
                    let qNum = seqStart + q;
                    let seqValStr = padZero ? qNum.toString().padStart(padLength, '0') : qNum.toString();
                    
                    let resultStr = formatTemplate.replace(/\{\%b\}/g, setValStr).replace(/\{\%t\}/g, seqValStr);
                    rawSequence.push(`${prefix}${resultStr}${suffix}`);
                }
            }
        }

        if (rawSequence.length === 0) {
            return [];
        }

        if (isShuffle) {
            for (let i = rawSequence.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [rawSequence[i], rawSequence[j]] = [rawSequence[j], rawSequence[i]];
            }
        }
        return rawSequence;
    };

    const generateDataMatrix = () => {
        if (vdpFields.length === 0) throw new Error("Vui lòng kéo ít nhất 1 trường Nhảy số vào PDF.");
        const rawSequence = generateSequence();
        if (rawSequence.length === 0) throw new Error("Dãy số trống. Vui lòng kiểm tra lại thiết lập.");
        
        // Group fields into Slots
        const slots: any[] = [];
        const groupMap = new Map<string, any[]>();
        
        vdpFields.forEach(f => {
            if (f.groupId) {
                if (!groupMap.has(f.groupId)) groupMap.set(f.groupId, []);
                groupMap.get(f.groupId)!.push(f);
            } else {
                slots.push({ ...f, isSlot: true, fields: [f] });
            }
        });
        
        groupMap.forEach((fieldsInGroup, groupId) => {
            // Representative coordinate is the top-left-most field
            let minX = fieldsInGroup[0].x || fieldsInGroup[0].position?.x;
            let minY = fieldsInGroup[0].y || fieldsInGroup[0].position?.y;
            fieldsInGroup.forEach(f => {
                const fx = f.x || f.position?.x;
                const fy = f.y || f.position?.y;
                if (fx < minX) minX = fx;
                if (fy < minY) minY = fy;
            });
            slots.push({
                id: `slot_${groupId}`,
                name: `Group_${groupId}`,
                position: { x: minX, y: minY },
                isSlot: true,
                fields: fieldsInGroup
            });
        });

        // Ensure all slots have position for sorting
        slots.forEach(s => {
            if (!s.position) s.position = { x: s.x, y: s.y };
        });

        const sortedSlots = sortFieldsGeometrically(slots, sortMethod);
        const numSlots = sortedSlots.length;
        const totalPages = Math.ceil(rawSequence.length / numSlots);
        
        const csvData: Record<string, string>[] = [];
        
        for (let p = 0; p < totalPages; p++) {
            const row: Record<string, string> = {};
            for (let s = 0; s < numSlots; s++) {
                let indexInSequence = 0;
                if (applyStyle === 'linear') {
                    indexInSequence = p * numSlots + s;
                } else {
                    // Stacked
                    indexInSequence = s * totalPages + p;
                }
                
                // Assign the same sequence number to ALL fields in this Slot
                const slotValue = rawSequence[indexInSequence] || "";
                sortedSlots[s].fields.forEach((originalField: any) => {
                    row[originalField.name] = slotValue;
                });
            }
            csvData.push(row);
        }
        
        return csvData;
    };

    const handleGenerate = async () => {
        try {
            setIsGenerating(true);
            setStatusMessage("Đang tính toán ma trận số...");
            const csvData = generateDataMatrix();
            
            if (!pdfFile) throw new Error("Chưa có file PDF gốc.");
            
            setStatusMessage(`Đang đẩy dữ liệu lên máy chủ (${csvData.length} trang)...`);
            // Tuân thủ kết quả cuối cùng: dùng file đã áp dụng sửa đổi trang làm template.
            const templateFile = getWorkingFile ? await getWorkingFile() : pdfFile;
            const jobId = await startVdpJobBackend(templateFile, vdpFields, csvData);
            
            pollAbortRef.current = new AbortController();
            const result = await pollVdpJob(jobId, setStatusMessage, false, pollAbortRef.current.signal);
            const blob = result.blob;
            if (!blob) throw new Error('Không nhận được file kết quả từ máy chủ');
            const outName = `Numbered_${pdfFile.name}`;
            
            if (spawnNewTab && onSpawnTab) {
                onSpawnTab(blob, outName);
                setStatusMessage(`Hoàn thành! Đã tạo Tab PDF mới.`);
            } else if (onApplyResult) {
                onApplyResult(blob, outName);
                setStatusMessage(`Hoàn thành! Đã ghi đè file hiện tại.`);
            }
        } catch (error: any) {
            if (error?.name === 'AbortError') return;
            console.error(error);
            setStatusMessage(`Lỗi: ${error.message}`);
        } finally {
            setIsGenerating(false);
        }
    };

    const previewLines = React.useMemo(() => {
        try {
            if (vdpFields.length === 0) return ["Kéo thả ít nhất 1 Slot lên màn hình để xem trước."];
            const rawSequence = generateSequence();
            if (rawSequence.length === 0) return ["Dãy số trống."];
            
            const numSlots = vdpFields.length;
            const totalPages = Math.ceil(rawSequence.length / numSlots);
            const lines: string[] = [];
            
            const maxPreviewPages = Math.min(totalPages, 3);
            
            for (let p = 0; p < maxPreviewPages; p++) {
                let pageStr = `Trang ${p + 1}: `;
                let itemsAdded = 0;
                for (let s = 0; s < numSlots; s++) {
                    let indexInSequence = applyStyle === 'linear' ? (p * numSlots + s) : (s * totalPages + p);
                    if (indexInSequence < rawSequence.length) {
                        pageStr += (itemsAdded > 0 ? ', ' : '') + rawSequence[indexInSequence];
                        itemsAdded++;
                        if (pageStr.length > 50) {
                            pageStr += ', ...';
                            break;
                        }
                    }
                }
                if (itemsAdded < numSlots && !pageStr.endsWith('...')) pageStr += ', ...';
                lines.push(pageStr);
            }
            if (totalPages > maxPreviewPages) lines.push('...');
            return lines;
        } catch (err) {
            return ["Lỗi cấu hình dãy số."];
        }
    }, [genMethod, startNum, endNum, increment, padZero, padLength, prefix, suffix, setTotal, setStartStr, seqTotal, seqStart, formatTemplate, isShuffle, applyStyle, vdpFields.length]);

    return (
        <div className="flex flex-col h-full bg-white dark:bg-zinc-900 border-l border-slate-200 dark:border-zinc-800 p-4 gap-4 overflow-y-auto scroller-thin">
            {/* Header */}
            <div className="flex items-center gap-2 pb-3 border-b border-slate-200 dark:border-zinc-700 shrink-0">
                <button 
                    onClick={onBack}
                    className="p-1.5 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-md text-slate-500 transition-colors"
                    title="Quay lại"
                >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
                </button>
                <div className="flex-1 min-w-0 text-center pr-8">
                    <h2 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center justify-center gap-2">
                        <span>🔢</span>
                        <span>NHẢY SỐ TỰ ĐỘNG</span>
                    </h2>
                    <p className="text-[11px] text-slate-500 mt-1">Numbering & Ticket Generator</p>
                </div>
            </div>

            {/* Step 1: Configuration */}
            <div className="shrink-0 space-y-3">
                <span className="text-sm font-bold text-slate-800 dark:text-zinc-200">1. Cấu hình Dãy Số</span>
                
                <div className="flex bg-slate-100 dark:bg-zinc-800 p-1 rounded-md">
                    <button 
                        className={`flex-1 text-xs py-1.5 rounded font-bold transition-all ${genMethod === 'range' ? 'bg-white dark:bg-zinc-700 shadow text-indigo-600 dark:text-indigo-400' : 'text-slate-500 hover:bg-slate-200 dark:hover:bg-zinc-700/50'}`}
                        onClick={() => setGenMethod('range')}
                    >
                        Dãy số (1, 2, 3...)
                    </button>
                    <button 
                        className={`flex-1 text-xs py-1.5 rounded font-bold transition-all ${genMethod === 'set' ? 'bg-white dark:bg-zinc-700 shadow text-indigo-600 dark:text-indigo-400' : 'text-slate-500 hover:bg-slate-200 dark:hover:bg-zinc-700/50'}`}
                        onClick={() => setGenMethod('set')}
                    >
                        Theo bộ (A-01, B-01)
                    </button>
                </div>

                <div className="p-3 border border-slate-200 dark:border-zinc-700 rounded-lg space-y-3 bg-slate-50/50 dark:bg-zinc-800/20">
                    {genMethod === 'range' ? (
                        <div className="space-y-3">
                            <div className="flex flex-col gap-1 pb-3 border-b border-slate-200 dark:border-zinc-700">
                                <label className="text-[10px] font-bold text-indigo-600 dark:text-indigo-400 uppercase">Trích xuất tự động (Smart Extract)</label>
                                <div className="flex gap-2">
                                    <input 
                                        type="text" 
                                        placeholder="Ví dụ: No.00123-VIP"
                                        className="flex-1 h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded bg-white dark:bg-zinc-900"
                                        onChange={(e) => {
                                            const val = e.target.value;
                                            const match = val.match(/^(.*?)(\d+)(.*?)$/);
                                            if (match) {
                                                setPrefix(match[1]);
                                                setStartNum(parseInt(match[2], 10) || 1);
                                                if (match[2].startsWith('0')) {
                                                    setPadZero(true);
                                                    setPadLength(match[2].length);
                                                } else {
                                                    setPadZero(false);
                                                }
                                                setSuffix(match[3]);
                                            }
                                        }}
                                    />
                                </div>
                                <span className="text-[9px] text-slate-500">Nhập chuỗi mẫu, phần mềm sẽ tự tách Tiền tố, Số và Hậu tố.</span>
                            </div>
                            <div className="grid grid-cols-3 gap-2">
                                <div className="flex flex-col gap-1">
                                    <label className="text-[10px] font-medium text-slate-500">Bắt đầu từ</label>
                                    <input type="number" value={startNum} onChange={e => setStartNum(Number(e.target.value))} className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-[10px] font-medium text-slate-500">Đến số</label>
                                    <input type="number" value={endNum} onChange={e => setEndNum(Number(e.target.value))} className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-[10px] font-medium text-slate-500">Bước nhảy</label>
                                    <input type="number" min={1} value={increment} onChange={e => setIncrement(Number(e.target.value))} className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            <div className="grid grid-cols-2 gap-2">
                                <div className="flex flex-col gap-1">
                                    <label className="text-[10px] font-medium text-slate-500">Số lượng bộ</label>
                                    <input type="number" value={setTotal} onChange={e => setSetTotal(Number(e.target.value))} className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-[10px] font-medium text-slate-500">Bộ bắt đầu (Ký tự/Số)</label>
                                    <input type="text" value={setStartStr} onChange={e => setSetStartStr(e.target.value)} className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-[10px] font-medium text-slate-500">Số lượng vé/bộ</label>
                                    <input type="number" value={seqTotal} onChange={e => setSeqTotal(Number(e.target.value))} className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-[10px] font-medium text-slate-500">Bắt đầu từ số</label>
                                    <input type="number" value={seqStart} onChange={e => setSeqStart(Number(e.target.value))} className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                                </div>
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="text-[10px] font-medium text-slate-500">Cấu trúc hiển thị</label>
                                <input type="text" value={formatTemplate} onChange={e => setFormatTemplate(e.target.value)} placeholder="{%b}-{%t}" className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded font-mono" />
                                <span className="text-[9px] text-slate-400">Dùng {'{%b}'} cho Bộ và {'{%t}'} cho Số thứ tự.</span>
                            </div>
                        </div>
                    )}
                    
                    <div className="border-t border-slate-200 dark:border-zinc-700 pt-3 grid grid-cols-2 gap-2">
                        <div className="flex flex-col gap-1">
                            <label className="text-[10px] font-medium text-slate-500">Tiền tố</label>
                            <input type="text" value={prefix} onChange={e => setPrefix(e.target.value)} placeholder="VD: No." className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="text-[10px] font-medium text-slate-500">Hậu tố</label>
                            <input type="text" value={suffix} onChange={e => setSuffix(e.target.value)} className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                        </div>
                        <div className="flex flex-col gap-1 col-span-2">
                            <div className="flex items-center gap-2 mb-1">
                                <input type="checkbox" checked={padZero} onChange={e => setPadZero(e.target.checked)} id="padZero" />
                                <label htmlFor="padZero" className="text-[11px] font-medium text-slate-600 dark:text-zinc-300 cursor-pointer">Đệm số 0 vào đầu</label>
                            </div>
                            {padZero && (
                                <div className="flex items-center gap-2">
                                    <span className="text-[10px] text-slate-500">Chiều dài cố định:</span>
                                    <input type="number" min={1} value={padLength} onChange={e => setPadLength(Number(e.target.value))} className="w-16 h-7 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                                </div>
                            )}
                            <div className="flex items-center gap-2 mt-1">
                                <input type="checkbox" checked={isShuffle} onChange={e => setIsShuffle(e.target.checked)} id="isShuffle" />
                                <label htmlFor="isShuffle" className="text-[11px] font-medium text-slate-600 dark:text-zinc-300 cursor-pointer">Xáo trộn ngẫu nhiên (Làm vé bốc thăm)</label>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div className="h-px bg-slate-200 dark:bg-zinc-700 w-full shrink-0" />

            {/* Step 2: Placement & Drag */}
            <div className="shrink-0 space-y-3">
                <span className="text-sm font-bold text-slate-800 dark:text-zinc-200">2. Kéo thả lên trang PDF</span>
                <p className="text-[11px] text-slate-500">Kéo công cụ dưới đây thả vào các vị trí cần đánh số trên màn hình PDF.</p>
                <div 
                    onPointerDown={(e) => startVdpDrag(e, 'text', 'Vị trí Nhảy số (Slot)')}
                    className="bg-indigo-50 border-2 border-indigo-200 dark:bg-indigo-900/20 dark:border-indigo-800 p-3 rounded-lg cursor-grab active:cursor-grabbing hover:border-indigo-400 flex items-center justify-center gap-2 transition-colors shadow-sm"
                >
                    <svg className="w-5 h-5 text-indigo-600 dark:text-indigo-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" /></svg>
                    <span className="text-xs font-bold text-indigo-700 dark:text-indigo-300">Vị trí Nhảy số (Slot)</span>
                </div>
            </div>

            <div className="h-px bg-slate-200 dark:bg-zinc-700 w-full shrink-0" />

            {/* Step 3: Application Style */}
            <div className="shrink-0 space-y-3">
                <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-slate-800 dark:text-zinc-200">3. Phương thức phân bổ</span>
                    <span className="text-[11px] font-bold text-indigo-600 bg-indigo-100 dark:bg-indigo-900/50 px-2 py-0.5 rounded-full">{vdpFields.length} Slots</span>
                </div>
                
                <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-bold text-slate-500 uppercase">Thứ tự đọc (Sorting)</label>
                        <select 
                            value={sortMethod} 
                            onChange={e => setSortMethod(e.target.value as 'rows'|'cols'|'ushape'|'clockwise')}
                            className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded bg-white dark:bg-zinc-800"
                        >
                            <option value="rows">Quét theo Hàng (Z)</option>
                            <option value="cols">Quét theo Cột (N)</option>
                            <option value="ushape">Chữ U (U-Shape)</option>
                            <option value="clockwise">Vòng Tròn (Clockwise)</option>
                        </select>
                    </div>
                    <div className="flex flex-col gap-1">
                        <label className="text-[10px] font-bold text-slate-500 uppercase">Phân bổ trang</label>
                        <select 
                            value={applyStyle} 
                            onChange={e => setApplyStyle(e.target.value as 'linear'|'stack')}
                            className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded bg-white dark:bg-zinc-800"
                        >
                            <option value="linear">Theo thứ tự (Linear)</option>
                            <option value="stack">Xếp chồng (Stacked)</option>
                        </select>
                    </div>
                </div>
                
                <p className="text-[10px] text-slate-500 bg-slate-50 dark:bg-zinc-800 p-2 rounded">
                    {applyStyle === 'stack' 
                        ? "Chế độ Xếp chồng (Cut & Stack): Số sẽ nhảy xuyên qua các trang. Sau khi in xong, cắt cọc giấy làm đôi và chồng lên nhau thì số sẽ chạy liên tục." 
                        : "Chế độ Tuyến tính: Đánh số từ trái sang phải, từ trang này sang trang khác một cách bình thường."}
                </p>
            </div>

            {/* Tool settings for selected slot */}
            {selectedFieldIds.length >= 1 && (
                <div className="shrink-0 pt-3 border-t border-slate-200 dark:border-zinc-700">
                    <VdpAlignPanel
                        vdpFields={vdpFields}
                        setVdpFields={setVdpFields}
                        selectedFieldIds={selectedFieldIds}
                        pageDimMm={viewerPageDimMm}
                    />
                </div>
            )}
            {selectedFieldIds.length > 0 && (
                <div className="shrink-0 space-y-3 pt-3 border-t border-slate-200 dark:border-zinc-700">
                    <div className="flex items-center justify-between">
                        <span className="text-[12px] font-bold text-slate-700 dark:text-zinc-300">
                            Định dạng {selectedFieldIds.length > 1 ? `${selectedFieldIds.length} trường` : vdpFields.find(f=>f.id===selectedFieldIds[0])?.name}
                        </span>
                        {selectedFieldIds.length > 1 && (
                            <button onClick={handleGroupFields} className="text-[10px] bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 px-2 py-1 rounded text-slate-600 dark:text-zinc-300 font-medium">
                                Group (Nhóm)
                            </button>
                        )}
                        {selectedFieldIds.length > 0 && vdpFields.find(f=>f.id===selectedFieldIds[0])?.groupId && (
                            <button onClick={handleUngroupFields} className="text-[10px] bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 px-2 py-1 rounded text-red-500 font-medium">
                                Ungroup (Bỏ nhóm)
                            </button>
                        )}
                        {selectedFieldIds.length > 0 && (
                            <button 
                                onClick={deleteSelectedField}
                                className="text-red-500 hover:text-red-700 bg-red-50 hover:bg-red-100 dark:bg-red-500/10 dark:hover:bg-red-500/20 p-1.5 rounded transition-colors"
                                title="Xóa trường này"
                            >
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                            </button>
                        )}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div className="flex flex-col gap-1 col-span-2">
                            <span className="text-[10px] font-medium text-slate-500 block mb-1">Font chữ (Font Family)</span>
                            <FontSelector 
                                value={vdpFields.find(f=>f.id===selectedFieldIds[0])?.fontName || 'Helvetica'}
                                fontFile={vdpFields.find(f=>f.id===selectedFieldIds[0])?.fontFile}
                                onChange={(fontName, fontFile) => updateSelectedField({ fontName, fontFile })}
                            />
                        </div>
                        <div className="flex flex-col gap-1 col-span-2">
                            <span className="text-[10px] font-medium text-slate-500 block mb-1">Nét font (Font Style)</span>
                            <select 
                                value={vdpFields.find(f=>f.id===selectedFieldIds[0])?.fontStyle || 'normal'}
                                onChange={(e) => updateSelectedField({ fontStyle: e.target.value })}
                                className="w-full h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                            >
                                <option value="normal">Regular</option>
                                <option value="bold">Bold</option>
                                <option value="italic">Italic</option>
                                <option value="bolditalic">Bold Italic</option>
                            </select>
                        </div>
                        
                        <ToolNumberInput 
                            label="Cỡ chữ"
                            value={vdpFields.find(f=>f.id===selectedFieldIds[0])?.fontSize || 13}
                            onChange={(val) => updateSelectedField({ fontSize: val })}
                            suffix="pt" step={1}
                        />
                        <ToolNumberInput 
                            label="Dòng (Leading)"
                            value={vdpFields.find(f=>f.id===selectedFieldIds[0])?.lineHeight || 1}
                            onChange={(val) => updateSelectedField({ lineHeight: val })}
                            suffix="em" step={0.1}
                        />
                        <ToolNumberInput 
                            label="Khoảng cách (Tracking)"
                            value={vdpFields.find(f=>f.id===selectedFieldIds[0])?.characterSpacing || 0}
                            onChange={(val) => updateSelectedField({ characterSpacing: val })}
                            suffix="pt" step={0.5}
                        />
                        <div>
                            <span className="text-[11px] font-medium text-slate-500 block mb-1">Căn lề</span>
                            <div className="flex items-center gap-1.5">
                                <select 
                                    value={vdpFields.find(f=>f.id===selectedFieldIds[0])?.alignment || 'left'}
                                    onChange={(e) => updateSelectedField({ alignment: e.target.value })}
                                    className="flex-1 min-w-0 h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                >
                                    <option value="left">Trái</option>
                                    <option value="center">Giữa</option>
                                    <option value="right">Phải</option>
                                </select>
                            </div>
                        </div>
                        <div className="col-span-2">
                            <span className="text-[10px] font-medium text-slate-500 block mb-1">Màu chữ</span>
                            <CmykColorPicker
                                label="Màu CMYK"
                                value={vdpFields.find(f=>f.id===selectedFieldIds[0])?.fontColor || '#000000'}
                                onChange={(hex: string) => updateSelectedField({ fontColor: hex })}
                            />
                        </div>
                    </div>
                </div>
            )}

            {/* Preview Section */}
            <div className="shrink-0 space-y-2 mt-2">
                <span className="text-[12px] font-bold text-slate-800 dark:text-zinc-200 flex items-center gap-2">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                    Xem trước kết quả ({vdpFields.length} Slots)
                </span>
                <div className="bg-slate-100 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 rounded-md p-2.5 min-h-[60px] font-mono text-[10px] text-slate-600 dark:text-zinc-400 whitespace-pre-wrap leading-relaxed shadow-inner">
                    {previewLines.join('\n')}
                </div>
            </div>

            {/* Run Button */}
            <div className="mt-auto pt-4 shrink-0 border-t border-slate-200 dark:border-zinc-700">
                {statusMessage && (
                    <div className="mb-3 p-2 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 text-[11px] rounded animate-pulse text-center font-medium">
                        {statusMessage}
                    </div>
                )}
                
                <div className="mb-3 flex items-center gap-2 px-1">
                    <input
                        type="checkbox"
                        id="spawnNewTabNum"
                        checked={spawnNewTab}
                        onChange={(e) => setSpawnNewTab(e.target.checked)}
                        className="w-3.5 h-3.5 rounded text-blue-600 focus:ring-blue-500 bg-white dark:bg-zinc-900 border-slate-300 dark:border-zinc-600 cursor-pointer"
                    />
                    <label htmlFor="spawnNewTabNum" className="text-[11px] text-slate-600 dark:text-zinc-400 cursor-pointer select-none">
                        Mở kết quả sang Tab mới (thay vì đè file hiện tại)
                    </label>
                </div>
                
                <button
                    onClick={handleGenerate}
                    disabled={isGenerating || vdpFields.length === 0}
                    className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-bold rounded-lg transition-colors flex items-center justify-center gap-2 shadow-sm"
                >
                    {isGenerating ? (
                        <>
                            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                            Đang xử lý...
                        </>
                    ) : (
                        <>Tạo file Nhảy số ({vdpFields.length} Slots)</>
                    )}
                </button>
            </div>
        </div>
    );
}
