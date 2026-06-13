import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { startVdpDrag } from '../../utils/vdpDrag';
import Papa from 'papaparse';
import { startVdpJobBackend, getVdpJobStatus, downloadVdpJob, pollVdpJob, getSystemFonts } from '@/lib/api';
import { getQRBlob, DEFAULT_QR_STYLE } from '@/engine/barcode/qrEngine';
import { generateBarcodeDataURL } from '@/engine/barcode/barcodeEngine';
import { FontSelector } from './FontSelector';
import { ToolSectionLabel, ToolDivider, ToolNumberInput } from './ToolUI';
import { useVdpTool } from '@/hooks/useVdpTool';
import { sortFieldsGeometrically } from '@/lib/vdpUtils';
import { VdpAlignPanel } from './VdpAlignPanel';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';

// ─── CMYK ↔ Hex Conversion Helpers ──────────────────────
function hexToCmyk(hex: string): { c: number; m: number; y: number; k: number } {
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16) / 255;
    const g = parseInt(h.substring(2, 4), 16) / 255;
    const b = parseInt(h.substring(4, 6), 16) / 255;
    const k = 1 - Math.max(r, g, b);
    if (k === 1) return { c: 0, m: 0, y: 0, k: 100 };
    return {
        c: Math.round(((1 - r - k) / (1 - k)) * 100),
        m: Math.round(((1 - g - k) / (1 - k)) * 100),
        y: Math.round(((1 - b - k) / (1 - k)) * 100),
        k: Math.round(k * 100),
    };
}

function cmykToHex(c: number, m: number, y: number, k: number): string {
    const r = Math.round(255 * (1 - c / 100) * (1 - k / 100));
    const g = Math.round(255 * (1 - m / 100) * (1 - k / 100));
    const b = Math.round(255 * (1 - y / 100) * (1 - k / 100));
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// ─── CMYK Color Picker Component ────────────────────────
export function CmykColorPicker({ label, value, onChange, disabled }: { label?: string; value: string; onChange: (hex: string) => void; disabled?: boolean }) {
    const [isOpen, setIsOpen] = useState(false);
    const popoverRef = useRef<HTMLDivElement>(null);
    const cmyk = hexToCmyk(value || '#000000');
    const inputClass = "w-full bg-white dark:bg-zinc-800 border border-slate-300 dark:border-zinc-600 rounded p-1 text-xs text-center font-mono";

    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        }
        if (isOpen) document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [isOpen]);

    const presets = [
        { c: 0, m: 0, y: 0, k: 100 }, // Black
        { c: 0, m: 0, y: 0, k: 0 },   // White
        { c: 100, m: 0, y: 0, k: 0 }, // Cyan
        { c: 0, m: 100, y: 0, k: 0 }, // Magenta
        { c: 0, m: 0, y: 100, k: 0 }, // Yellow
        { c: 0, m: 100, y: 100, k: 0 }, // Red
        { c: 100, m: 0, y: 100, k: 0 }, // Green
        { c: 100, m: 100, y: 0, k: 0 }, // Blue
        { c: 0, m: 50, y: 100, k: 0 }, // Orange
        { c: 0, m: 0, y: 0, k: 50 },  // Gray
    ];

    return (
        <div className="flex flex-col gap-1 relative" ref={popoverRef}>
            <label className="text-[10px] text-slate-600 dark:text-zinc-400 font-medium">{label}</label>
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    disabled={disabled}
                    className="w-8 h-8 rounded border border-slate-300 shadow-sm shrink-0 cursor-pointer hover:scale-105 transition-transform"
                    style={{ backgroundColor: value || '#000000' }}
                    onClick={() => setIsOpen(!isOpen)}
                />
                <span className="text-[12px] font-mono text-slate-500 uppercase tracking-tight">
                    C{cmyk.c} M{cmyk.m} Y{cmyk.y} K{cmyk.k}
                </span>
            </div>
            
            {isOpen && (
                <div className="absolute z-50 top-full left-0 mt-1 p-3 bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded-lg shadow-xl w-48 animate-fade-in origin-top-left">
                    <div className="text-[10px] font-bold text-slate-600 dark:text-zinc-400 mb-2 uppercase tracking-wider">Thông số CMYK</div>
                    <div className="flex gap-1">
                        {(['c', 'm', 'y', 'k'] as const).map(ch => (
                            <div key={ch} className="flex flex-col items-center flex-1 min-w-0">
                                <input
                                    type="number" min={0} max={100}
                                    value={cmyk[ch]}
                                    onChange={(e) => {
                                        const v = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                                        const next = { ...cmyk, [ch]: v };
                                        onChange(cmykToHex(next.c, next.m, next.y, next.k));
                                    }}
                                    className={inputClass}
                                    disabled={disabled}
                                />
                                <span className="text-[8px] text-slate-400 font-bold uppercase mt-1">{ch}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── Section thu/xổ (accordion) cho panel VDP ───
function VdpSection({ step, title, badge, defaultOpen = true, accent, children }: { step?: string; title: string; badge?: React.ReactNode; defaultOpen?: boolean; accent?: boolean; children: React.ReactNode }) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <div className={`shrink-0 rounded-lg border overflow-hidden ${accent ? 'border-blue-300 dark:border-blue-700' : 'border-slate-200 dark:border-zinc-700'}`}>
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                className={`w-full flex items-center justify-between px-3 py-2 transition-colors ${accent ? 'bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/30' : 'bg-slate-50 dark:bg-zinc-800/60 hover:bg-slate-100 dark:hover:bg-zinc-800'}`}
            >
                <span className="text-[13px] font-bold text-slate-700 dark:text-zinc-200 flex items-center gap-2">
                    {step && <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[11px] text-white ${accent ? 'bg-blue-500' : 'bg-slate-400 dark:bg-zinc-600'}`}>{step}</span>}
                    {title}
                    {badge}
                </span>
                <svg className={`w-4 h-4 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
            </button>
            {open && <div className="p-3 space-y-3">{children}</div>}
        </div>
    );
}

// ─── Icon căn chỉnh kiểu Illustrator ───
interface Props {
  pdfFile: File | null;
  getWorkingFile?: () => Promise<File>;
  vdpFields?: any[];
  setVdpFields?: React.Dispatch<React.SetStateAction<any[]>>;
  selectedFieldIds?: string[];
  onSelectField?: (ids: string[]) => void;
  onBack?: () => void;
  onSpawnTab?: (blob: Blob, name: string, path?: string) => void;
  onApplyResult?: (blob: Blob, name: string, path?: string) => void;
  isActive?: boolean;
}
export default function DataMergeTool({
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
    const [csvData, setCsvData] = useState<Record<string, string>[]>([]);
    const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
    const [statusMessage, setStatusMessage] = useState("");
    const [isGenerating, setIsGenerating] = useState(false);
    const [systemFonts, setSystemFonts] = useState<{name: string, path: string}[]>([]);
    const [fontDropdownOpen, setFontDropdownOpen] = useState(false);
    const [fontSearch, setFontSearch] = useState('');

    useEffect(() => {
        getSystemFonts().then(setSystemFonts).catch(console.error);
    }, []);

    // Hủy polling VDP khi component unmount để không poll vô hạn nền (#13).
    const pollAbortRef = useRef<AbortController | null>(null);
    useEffect(() => () => { pollAbortRef.current?.abort(); }, []);

    const openBatchInfo = async () => {
        setShowBatchInfo(true);
        if (batchInfo.length === batchFiles.length && batchInfo.length > 0) return;
        setBatchInfoLoading(true);
        try {
            const info: { name: string; records: number }[] = [];
            for (const f of batchFiles) {
                try {
                    const { data } = await parseCsv(f, csvHasHeader);
                    info.push({ name: f.name, records: data.length });
                } catch {
                    info.push({ name: f.name, records: -1 });
                }
            }
            setBatchInfo(info);
        } finally {
            setBatchInfoLoading(false);
        }
    };

    const loadCsvIntoState = (file: File, hasHeader: boolean) => {
        setStatusMessage("Đang đọc file CSV...");
        parseCsv(file, hasHeader).then(({ headers, data, duplicated }) => {
            if (data.length > 0) {
                setCsvHeaders(headers);
                setCsvData(data);
                if (duplicated.length > 0) setStatusMessage(`Đã tải ${data.length} dòng. Lưu ý: cột trùng tên (${duplicated.join(', ')}) đã tự đổi tên.`);
                else setStatusMessage(`Đã tải ${data.length} dòng dữ liệu.`);
            } else {
                setCsvHeaders([]); setCsvData([]);
                setStatusMessage("File CSV rỗng hoặc lỗi định dạng.");
            }
        }).catch((err) => { console.error("CSV Parse Error:", err); setStatusMessage("Lỗi đọc file CSV."); });
    };

    const handleCsvFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []).filter(f => /\.csv$/i.test(f.name));
        e.currentTarget.value = '';
        if (!files.length) return;
        setBatchFiles(files);
        lastCsvFileRef.current = files[0];
        loadCsvIntoState(files[0], csvHasHeader);
        if (files.length > 1) {
            setStatusMessage(`Đã chọn ${files.length} file. Map trường với cột rồi bấm "Chạy ${files.length} file".`);
        }
    };

    const updateSelectedField = (changes: any) => {
        if (!setVdpFields || selectedFieldIds.length === 0) return;

        // When rotation changes on a barcode, swap width↔height so the box rotates with it
        if (changes.rotation !== undefined) {
            const field = vdpFields.find(f => f.id === selectedFieldIds[0]);
            if (field && (field.type === 'barcode' || field.type === 'qrcode')) {
                const oldRot = field.rotation || 0;
                const newRot = changes.rotation;
                const oldIsVertical = (oldRot === 90 || oldRot === 270);
                const newIsVertical = (newRot === 90 || newRot === 270);
                if (oldIsVertical !== newIsVertical) {
                    // Swap width ↔ height
                    changes.width = field.height;
                    changes.height = field.width;
                }
            }
        }
        // When name (CSV column) changes on a text field, auto-update textContent
        // so the placeholder references the correct column
        if (changes.name !== undefined) {
            const field = vdpFields.find(f => f.id === selectedFieldIds[0]);
            if (field && field.type === 'text') {
                const oldName = field.name || '';
                const newName = changes.name;
                const currentText = field.textContent;
                if (currentText && currentText.includes(`{${oldName}}`)) {
                    // Replace old column reference with new one
                    changes.textContent = currentText.replace(`{${oldName}}`, `{${newName}}`);
                } else if (!currentText || currentText === `{${oldName}}`) {
                    // Default: set textContent to just the column reference
                    changes.textContent = `{${newName}}`;
                }
            }
        }

        setVdpFields(prev => prev.map(f => selectedFieldIds.includes(f.id) ? { ...f, ...changes } : f));
        
        // Auto-fit barcode frame using aspect ratio
        const barcodeTriggers = ['barcodeType', 'barHeight', 'quietZone', 'showText', 'fontSize', 'textAlign', 'data'];
        const isBarcodeUpdate = barcodeTriggers.some(key => changes[key] !== undefined);
        
        if (isBarcodeUpdate) {
            const field = vdpFields.find(f => f.id === selectedFieldIds[0]);
            if (field && field.type === 'barcode') {
                const updatedField = { ...field, ...changes };
                const sampleData: Record<string, string> = {
                    code128: 'SAMPLE-12345', ean13: '4006381333931', upca: '012345678905',
                    ean8: '96385074', code39: 'SAMPLE39', itf14: '10012345000017', codabar: 'A12345B',
                };
                const bt = updatedField.barcodeType || 'code128';
                generateBarcodeDataURL({
                    type: bt,
                    data: updatedField.data || sampleData[bt] || 'SAMPLE-12345',
                    height: updatedField.barHeight || 12,
                    showText: updatedField.showText !== false,
                    quietZone: updatedField.quietZone ?? 2,
                    fontSize: updatedField.fontSize,
                    textAlign: updatedField.textAlign,
                }).then(dataUrl => {
                    const img = new Image();
                    img.onload = () => {
                        const aspect = img.width / img.height;
                        const h = updatedField.height || 15;
                        const newWidth = Math.round(h * aspect * 10) / 10;
                        setVdpFields(prev => prev.map(f => f.id === selectedFieldIds[0] ? { ...f, width: newWidth } : f));
                    };
                    img.src = dataUrl;
                }).catch(() => {});
            }
        }
    };

    const {
        deleteSelectedField,
        handleGroupFields,
        handleUngroupFields
    } = useVdpTool(vdpFields, setVdpFields as any, selectedFieldIds, onSelectField, isActive);

    const selectedFieldId = selectedFieldIds[0];
    const selectedField = vdpFields.find(f => f.id === selectedFieldId);
    const viewerPageDimMm = useWorkspaceStore(s => s.viewerPageDimMm);
    const [isMultiUp, setIsMultiUp] = useState(false);
    // Trình tách cột (chèn nhanh placeholder, không phải gõ cú pháp tay)
    const [splitCol, setSplitCol] = useState('');
    const [splitMode, setSplitMode] = useState('whole'); // whole | ws | - | , | ; | / | custom
    const [splitCustom, setSplitCustom] = useState('');
    const [splitPart, setSplitPart] = useState(1);
    const [csvHasHeader, setCsvHasHeader] = useState(true);
    const lastCsvFileRef = useRef<File | null>(null);
    const [batchFiles, setBatchFiles] = useState<File[]>([]);
    const [showBatchInfo, setShowBatchInfo] = useState(false);
    const [batchInfo, setBatchInfo] = useState<{ name: string; records: number }[]>([]);
    const [batchInfoLoading, setBatchInfoLoading] = useState(false);

    const buildSplitToken = (): string => {
        if (!splitCol) return '';
        if (splitMode === 'whole') return `{${splitCol}}`;
        if (splitMode === 'ws') return `{${splitCol}[${splitPart}]}`;
        const d = splitMode === 'custom' ? splitCustom : splitMode;
        if (!d) return `{${splitCol}[${splitPart}]}`;
        return `{${splitCol}[${splitPart}|${d}]}`;
    };

    const insertSplitToken = (target: any) => {
        const tok = buildSplitToken();
        if (!tok || !target) return;
        const cur = target.textContent !== undefined ? target.textContent : '';
        const isDefault = cur === '' || cur === `{${target.name}}`;
        updateSelectedField({ textContent: isDefault ? tok : cur + tok });
    };

    // ─── Thu gọn chiều cao khung text vừa khít nội dung (ở cỡ chữ hiện tại) ───
    const fitHeightToText = () => {
        if (!setVdpFields || !selectedField || selectedField.type !== 'text') return;
        const f = selectedField;
        const text = (f.textContent !== undefined ? f.textContent : `{${f.name}}`) || '';
        const fontPt = f.fontSize || 13;
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const weight = (f.fontStyle === 'bold' || f.fontStyle === 'bolditalic') ? 'bold ' : '';
        const italic = (f.fontStyle === 'italic' || f.fontStyle === 'bolditalic') ? 'italic ' : '';
        const family = f.fontName === 'Times-Roman' ? '"Times New Roman", serif' : f.fontName === 'Courier' ? 'Courier, monospace' : (f.fontName ? `"${f.fontName}", sans-serif` : 'Arial, sans-serif');
        ctx.font = `${italic}${weight}${fontPt}px ${family}`;
        const MM_TO_PT = 72 / 25.4;
        const boxWpt = f.width * MM_TO_PT;
        let totalLines = 0;
        for (const ln of text.split('\n')) {
            const words = ln.split(' ');
            let cur = '';
            let lines = 1;
            for (const w of words) {
                const test = cur ? cur + ' ' + w : w;
                if (ctx.measureText(test).width > boxWpt && cur) { lines++; cur = w; }
                else cur = test;
            }
            totalLines += Math.max(1, lines);
        }
        const heightPt = totalLines * fontPt * 1.2;
        const heightMm = Math.max(3, heightPt / MM_TO_PT);
        updateSelectedField({ height: Math.round(heightMm * 10) / 10 });
    };



    // Xây dựng (fields, data) cho 1 job từ dữ liệu CSV — hỗ trợ chế độ Multi-up.
    const buildJobInput = (sourceData: Record<string, string>[]): { fields: any[]; data: Record<string, string>[] } => {
        if (!isMultiUp) return { fields: vdpFields, data: sourceData };
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
            let minX = fieldsInGroup[0].x || fieldsInGroup[0].position?.x;
            let minY = fieldsInGroup[0].y || fieldsInGroup[0].position?.y;
            fieldsInGroup.forEach(f => {
                const fx = f.x || f.position?.x;
                const fy = f.y || f.position?.y;
                if (fx < minX) minX = fx;
                if (fy < minY) minY = fy;
            });
            slots.push({ id: `slot_${groupId}`, name: `Group_${groupId}`, position: { x: minX, y: minY }, isSlot: true, fields: fieldsInGroup });
        });
        slots.forEach(s => { if (!s.position) s.position = { x: s.x, y: s.y }; });
        const sortedSlots = sortFieldsGeometrically(slots, 'rows');
        const numSlots = sortedSlots.length;
        const totalPages = Math.ceil(sourceData.length / numSlots);
        const multiUpVdpFields: any[] = [];
        for (let s = 0; s < numSlots; s++) {
            sortedSlots[s].fields.forEach((originalField: any) => {
                const newFieldName = `${originalField.name}_slot${s}`;
                multiUpVdpFields.push({ ...originalField, name: newFieldName, textContent: originalField.textContent?.replace(new RegExp(`\\{${originalField.name}\\}`, 'g'), `{${newFieldName}}`) });
            });
        }
        const data: Record<string, string>[] = [];
        for (let p = 0; p < totalPages; p++) {
            const pageRow: Record<string, string> = {};
            for (let s = 0; s < numSlots; s++) {
                const rowIndex = p * numSlots + s;
                const srcRow = sourceData[rowIndex] || {};
                sortedSlots[s].fields.forEach((originalField: any) => {
                    pageRow[`${originalField.name}_slot${s}`] = srcRow[originalField.name] || '';
                });
            }
            data.push(pageRow);
        }
        return { fields: multiUpVdpFields, data };
    };

    // Đọc 1 file CSV → { headers, data }. Hỗ trợ file KHÔNG có hàng tiêu đề:
    // khi đó tự đặt tên cột theo vị trí "Cột 1", "Cột 2"... để map theo cột.
    const parseCsv = (file: File, hasHeader: boolean): Promise<{ headers: string[]; data: Record<string, string>[]; duplicated: string[] }> =>
        new Promise((resolve, reject) => {
            const seen = new Set<string>();
            const dup = new Set<string>();
            Papa.parse(file, {
                header: hasHeader,
                skipEmptyLines: true,
                ...(hasHeader ? {
                    transformHeader: (h: string) => {
                        const name = (h ?? '').trim();
                        if (seen.has(name)) dup.add(name); else seen.add(name);
                        return name;
                    }
                } : {}),
                complete: (res: any) => {
                    if (hasHeader) {
                        const data = ((res.data as any[]) || []).filter(Boolean) as Record<string, string>[];
                        const headers = data.length ? Object.keys(data[0]) : (res.meta?.fields || []);
                        resolve({ headers, data, duplicated: Array.from(dup) });
                    } else {
                        const rows = ((res.data as any[]) || []).filter((r: any) => Array.isArray(r) && r.some((c: any) => c !== '' && c != null)) as string[][];
                        const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
                        const headers = Array.from({ length: colCount }, (_, i) => `Cột ${i + 1}`);
                        const data = rows.map(r => {
                            const o: Record<string, string> = {};
                            headers.forEach((h, i) => { o[h] = r[i] ?? ''; });
                            return o;
                        });
                        resolve({ headers, data, duplicated: [] });
                    }
                },
                error: reject,
            });
        });

    // Chạy hàng loạt nhiều file CSV: mỗi file → 1 tab kết quả riêng, đặt tên theo tên file CSV.
    const handleBatchGenerate = async (fileList: File[] | FileList) => {
        if (vdpFields.length === 0) { setStatusMessage("Chưa có trường dữ liệu (VDP Field) nào."); return; }
        if (!pdfFile) { setStatusMessage("Chưa có file PDF gốc."); return; }
        if (!onSpawnTab) { setStatusMessage("Không thể mở tab kết quả (thiếu onSpawnTab)."); return; }
        const files = Array.from(fileList).filter(f => /\.csv$/i.test(f.name));
        if (files.length === 0) { setStatusMessage("Không có file CSV hợp lệ."); return; }

        setIsGenerating(true);
        try {
            const templateFile = getWorkingFile ? await getWorkingFile() : pdfFile;
            let ok = 0;
            for (let i = 0; i < files.length; i++) {
                const csvFile = files[i];
                const tag = `(${i + 1}/${files.length}) ${csvFile.name}`;
                try {
                    setStatusMessage(`${tag}: đang đọc...`);
                    const data = (await parseCsv(csvFile, csvHasHeader)).data;
                    if (data.length === 0) { setStatusMessage(`${tag}: rỗng, bỏ qua.`); continue; }
                    const { fields, data: jobData } = buildJobInput(data);
                    setStatusMessage(`${tag}: đang sinh ${data.length} bản ghi...`);
                    const jobId = await startVdpJobBackend(templateFile, fields, jobData);
                    pollAbortRef.current = new AbortController();
                    const result = await pollVdpJob(jobId, (m) => setStatusMessage(`${tag}: ${m}`), true, pollAbortRef.current.signal);
                    if (!result.blob) { setStatusMessage(`${tag}: lỗi không có kết quả.`); continue; }
                    const baseName = csvFile.name.replace(/\.[^/.]+$/, '') || `VDP_${i + 1}`;
                    onSpawnTab(result.blob, `${baseName}.pdf`, result.path ?? undefined);
                    ok++;
                    // Nhường UI một nhịp giữa các file
                    await new Promise(r => setTimeout(r, 50));
                } catch (err: any) {
                    if (err?.name === 'AbortError') return;
                    setStatusMessage(`${tag}: lỗi ${err.message}`);
                }
            }
            setStatusMessage(`Hoàn thành ${ok}/${files.length} file CSV.`);
        } catch (e: any) {
            if (e?.name === 'AbortError') return;
            setStatusMessage(`Lỗi xử lý hàng loạt: ${e.message}`);
        } finally {
            setIsGenerating(false);
        }
    };

    const handleGenerate = async () => {
        if (vdpFields.length === 0) {
            setStatusMessage("Chưa có trường dữ liệu (VDP Field) nào.");
            return;
        }
        if (!pdfFile) {
            setStatusMessage("Chưa có file PDF gốc.");
            return;
        }

        setIsGenerating(true);
        try {
            setStatusMessage(`Đang đẩy dữ liệu lên máy chủ...`);

            // Tuân thủ kết quả cuối cùng: dùng file đã áp dụng sửa đổi trang
            // (xóa/xoay/sắp xếp) làm template, không dùng file gốc.
            const templateFile = getWorkingFile ? await getWorkingFile() : pdfFile;

            const { fields: jobFields, data: jobData } = buildJobInput(csvData);
            const jobId = await startVdpJobBackend(templateFile, jobFields, jobData);
            
            // Poll
            pollAbortRef.current = new AbortController();
            const result = await pollVdpJob(jobId, setStatusMessage, true, pollAbortRef.current.signal);
            const blob = result.blob;
            const path = result.path;
            if (!blob) throw new Error('Không nhận được file kết quả từ máy chủ');
            
            const originalName = pdfFile.name.replace(/\.[^/.]+$/, "") || "Document";
            const outName = `VDP_${originalName}_${csvData.length || 1}records.pdf`;
            
            if (spawnNewTab && onSpawnTab) {
                setStatusMessage(`Đang mở file kết quả (${csvData.length} bản ghi)...`);
                // Small delay so the UI updates with the message before the heavy tab creation
                await new Promise(r => setTimeout(r, 100));
                onSpawnTab(blob, outName, path ?? undefined);
                setStatusMessage(`Hoàn thành! Đã tạo Tab PDF mới.`);
            } else if (onApplyResult) {
                setStatusMessage(`Đang mở file kết quả...`);
                await new Promise(r => setTimeout(r, 100));
                onApplyResult(blob, outName, path ?? undefined);
                setStatusMessage(`Hoàn thành! Đã đè dữ liệu lên file hiện tại.`);
            }
        } catch (error: any) {
            if (error?.name === 'AbortError') return;
            console.error("PDF Generation Error:", error);
            setStatusMessage(`Lỗi sinh file PDF: ${error.message}`);
        } finally {
            setIsGenerating(false);
        }
    };

    const [spawnNewTab, setSpawnNewTab] = useState(true);

    return (
        <div className="flex flex-col h-full bg-white dark:bg-zinc-900 border-l border-slate-200 dark:border-zinc-800 p-4 gap-4 overflow-y-auto scroller-thin">
            {/* Header */}
            <div className="flex items-center gap-2 pb-3 border-b border-slate-200 dark:border-zinc-700">
                <button 
                    onClick={onBack}
                    className="p-1.5 hover:bg-slate-100 dark:hover:bg-zinc-800 rounded-md text-slate-500 transition-colors"
                    title="Quay lại"
                >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
                </button>
                <div className="flex-1 min-w-0 text-center pr-8">
                    <h2 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center justify-center gap-2">
                        <span>🔤</span>
                        <span>TRỘN DỮ LIỆU VDP</span>
                    </h2>
                    <p className="text-[11px] text-slate-500 mt-1">Vẽ vùng dữ liệu trực tiếp trên PDF</p>
                </div>
            </div>

            {/* CSV Data Section */}
            <VdpSection step="1" title="Dữ liệu CSV" defaultOpen>
                <label className="flex items-center justify-center w-full p-3 border-2 border-dashed border-blue-300 dark:border-blue-700/50 rounded-md cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors">
                    <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400">
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                        <span className="text-sm font-medium">Tải file CSV (1 hoặc nhiều)</span>
                    </div>
                    <input type="file" accept=".csv" multiple onChange={handleCsvFiles} className="hidden" />
                </label>

        <label className="flex items-center gap-2 mt-2 cursor-pointer select-none">
            <input
                type="checkbox"
                checked={csvHasHeader}
                onChange={(e) => {
                    const v = e.target.checked;
                    setCsvHasHeader(v);
                    if (lastCsvFileRef.current) loadCsvIntoState(lastCsvFileRef.current, v);
                }}
                className="w-4 h-4 accent-blue-500"
            />
            <span className="text-[12px] font-medium text-slate-600 dark:text-zinc-300">Hàng đầu là tiêu đề cột</span>
        </label>
        <p className="text-[10px] text-slate-400 leading-snug -mt-1">Bỏ chọn nếu file không có dòng tiêu đề — cột sẽ tự đặt tên "Cột 1", "Cột 2"…</p>

        {csvHeaders.length > 0 && (
            <div className="text-[13px] text-slate-600 dark:text-zinc-400 space-y-2">
                {batchFiles.length < 2 && (
                <div className="flex items-center justify-between">
                    <span>Số bản ghi:</span>
                    <span className="font-bold">{csvData.length}</span>
                </div>
                )}
                <div className="flex items-center justify-between">
                    <span>Các cột ({csvHeaders.length}):</span>
                    {!csvHasHeader && <span className="text-[10px] text-amber-600 dark:text-amber-400">tên theo vị trí</span>}
                </div>
                <div className="flex flex-wrap gap-1.5">
                    {csvHeaders.map(h => (
                        <span key={h} title={h} className="px-2 py-1 max-w-[140px] truncate bg-slate-100 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded-md text-[11px] font-medium">{h}</span>
                    ))}
                </div>
                {csvHasHeader && csvHeaders.some(h => h.length > 25) && (
                    <p className="text-[10px] text-amber-600 dark:text-amber-400 leading-snug">Tên cột trông như dữ liệu? File có thể KHÔNG có dòng tiêu đề — hãy bỏ chọn "Hàng đầu là tiêu đề cột" ở trên.</p>
                )}
            </div>
        )}

        {/* Khi chọn nhiều file: hiện danh sách + nút chạy hàng loạt (mỗi file → 1 tab) */}
        {batchFiles.length >= 2 && (
        <div className="mt-3 pt-3 border-t border-dashed border-slate-200 dark:border-zinc-700">
                <div className="mt-2 flex flex-col gap-2">
                    <div className="text-[11px] text-slate-500 dark:text-zinc-400 leading-snug flex items-center justify-between gap-2">
                        <span>Đã chọn <b>{batchFiles.length}</b> file</span>
                        <button onClick={openBatchInfo} className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline shrink-0">Chi tiết</button>
                    </div>
                    <button
                        onClick={() => setBatchFiles([])}
                        disabled={isGenerating}
                        className="self-start h-8 px-3 text-[12px] font-semibold text-slate-600 dark:text-zinc-300 border border-slate-300 dark:border-white/20 rounded-md hover:bg-slate-100 dark:hover:bg-zinc-800 disabled:opacity-40 transition-colors"
                    >
                        Bỏ chọn
                    </button>
                </div>
            <p className="text-[10px] text-slate-400 mt-1.5 leading-snug">Cột lấy từ file đầu để map. Map xong bấm nút "Chạy {batchFiles.length} file" ở dưới — mỗi file ra 1 tab đặt tên theo tên file CSV.</p>
        </div>
        )}
            </VdpSection>

            {/* Drag and Drop Toolbar */}
            <VdpSection step="2" title="Kéo thả vào PDF" defaultOpen>
        <div className="grid grid-cols-2 gap-2">
            <div 
                onPointerDown={(e) => startVdpDrag(e, 'text', 'Chữ (Text)')}
                className="bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 p-3 rounded-lg cursor-grab active:cursor-grabbing hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 flex items-center justify-center gap-2 transition-colors shadow-sm"
            >
                <svg className="w-5 h-5 text-slate-600 dark:text-zinc-400 shrink-0 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 12h16M4 18h7"/></svg>
                <span className="text-xs font-medium text-slate-700 dark:text-zinc-300 pointer-events-none">Chữ (Text)</span>
            </div>
            <div 
                onPointerDown={(e) => startVdpDrag(e, 'qrcode', 'Mã QR')}
                className="bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 p-3 rounded-lg cursor-grab active:cursor-grabbing hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 flex items-center justify-center gap-2 transition-colors shadow-sm"
            >
                <svg className="w-5 h-5 text-slate-600 dark:text-zinc-400 shrink-0 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm14 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"/></svg>
                <span className="text-xs font-medium text-slate-700 dark:text-zinc-300 pointer-events-none">Mã QR</span>
            </div>
            <div 
                onPointerDown={(e) => startVdpDrag(e, 'barcode', 'Mã vạch')}
                className="bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 p-3 rounded-lg cursor-grab active:cursor-grabbing hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 flex items-center justify-center gap-2 transition-colors shadow-sm"
            >
                <svg className="w-5 h-5 text-slate-600 dark:text-zinc-400 shrink-0 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 10H4zM4 14h16M4 18h16" strokeDasharray="2 2" /></svg>
                <span className="text-xs font-medium text-slate-700 dark:text-zinc-300 pointer-events-none">Mã vạch</span>
            </div>
            <div 
                onPointerDown={(e) => startVdpDrag(e, 'image', 'Hình ảnh')}
                className="bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 p-3 rounded-lg cursor-grab active:cursor-grabbing hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 flex items-center justify-center gap-2 transition-colors shadow-sm"
            >
                <svg className="w-5 h-5 text-slate-600 dark:text-zinc-400 shrink-0 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                <span className="text-xs font-medium text-slate-700 dark:text-zinc-300 pointer-events-none">Hình ảnh</span>
            </div>
        </div>
            </VdpSection>

            {/* Field List */}
            <VdpSection step="3" title="Danh sách trường" badge={<span className="text-[11px] px-2 py-0.5 bg-slate-100 dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded-full font-medium text-slate-600 dark:text-zinc-400">{vdpFields.length}</span>}>
        <div className="max-h-[250px] overflow-y-auto space-y-2 pr-1 scroller-thin">
            {vdpFields.length === 0 ? (
                <div className="text-center text-xs text-slate-400 py-4 flex flex-col items-center gap-3">
                    <span>Kéo (drag) một công cụ từ trên vào trang PDF để tạo trường.</span>
                </div>
            ) : (
                vdpFields.map(field => {
                    const isSelected = selectedFieldId === field.id;
                    return (
                        <div
                            key={field.id}
                            onClick={() => onSelectField?.([field.id])}
                            className={`w-full text-left p-2.5 rounded border transition-colors cursor-pointer ${isSelected ? 'bg-blue-50 border-blue-200 dark:bg-blue-900/30 dark:border-blue-700' : 'bg-white border-slate-200 hover:bg-slate-100 dark:bg-zinc-800 dark:border-zinc-700 dark:hover:bg-zinc-700'}`}
                        >
                            <div className="flex items-center justify-between">
                                {isSelected ? (
                                    <div className="flex-1 mr-2 relative" onClick={e => e.stopPropagation()}>
                                        <input 
                                            list="csv-headers-list"
                                            value={field.name}
                                            onChange={(e) => {
                                                if (selectedFieldId === field.id) {
                                                    updateSelectedField({ name: e.target.value });
                                                }
                                            }}
                                            className="w-full h-8 px-2 text-[13px] font-semibold bg-white dark:bg-zinc-900 border border-blue-300 dark:border-blue-600 rounded focus:outline-none focus:border-teal-500 transition-all shadow-sm"
                                            placeholder="Tên trường (Khớp header CSV)..."
                                            autoFocus
                                        />
                                        <datalist id="csv-headers-list">
                                            {csvHeaders.map(h => <option key={h} value={h} />)}
                                        </datalist>
                                    </div>
                                ) : (
                                    <span className="font-semibold text-sm text-slate-800 dark:text-zinc-200 truncate pr-2">{field.name || 'Chưa đặt tên'}</span>
                                )}
                                <div className="flex items-center gap-1.5 shrink-0">
                                    <span className="text-[11px] px-1.5 py-0.5 bg-slate-100 dark:bg-zinc-700 rounded uppercase">{field.type}</span>
                                    {isSelected && (
                                        <button 
                                            onClick={(e) => { e.stopPropagation(); deleteSelectedField(); }}
                                            className="text-red-500 hover:text-red-700 bg-red-50 hover:bg-red-100 dark:bg-red-500/10 dark:hover:bg-red-500/20 p-1.5 rounded transition-colors"
                                            title="Xóa trường này"
                                        >
                                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })
            )}
        </div>
            </VdpSection>

            {/* Field Settings Editor */}
            {selectedField && (
                <VdpSection step="4" title="Cài đặt trường" accent defaultOpen>
                    <div className="flex flex-col gap-3">
                        <div className="flex flex-col gap-1 p-2.5 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                            <span className="text-[12px] font-bold text-blue-700 dark:text-blue-400 block mb-1">Nguồn dữ liệu (Cột CSV)</span>
                            <select 
                                value={csvHeaders.includes(selectedField.name) ? selectedField.name : ""}
                                onChange={(e) => updateSelectedField({ name: e.target.value })}
                                className="w-full h-9 px-2 text-[13px] font-semibold bg-white dark:bg-zinc-900 border border-blue-300 dark:border-blue-600 rounded focus:outline-none focus:border-blue-500 transition-all text-blue-900 dark:text-blue-100"
                            >
                                <option value="" disabled>-- Chọn cột dữ liệu để ghép --</option>
                                {csvHeaders.map(h => (
                                    <option key={h} value={h}>{h}</option>
                                ))}
                            </select>
                            {selectedField.type === 'text' && (
                                <span className="text-[10px] text-blue-600/80 mt-1 italic">Mẹo: Hoặc dùng ngoặc nhọn {'{Tên Cột}'} chèn thẳng vào vùng Text bên dưới.</span>
                            )}
                        </div>
                    
                        <div className="flex flex-col gap-1">
                            <span className="text-[11px] font-medium text-slate-500 block mb-1">Loại công cụ</span>
                            <select 
                                value={selectedField.type}
                                onChange={(e) => updateSelectedField({ type: e.target.value })}
                                className="w-full h-9 px-2 text-[13px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                            >
                                <option value="text">Chữ (Text)</option>
                                <option value="qrcode">Mã QR (QRCode)</option>
                                <option value="barcode">Mã vạch (Barcode)</option>
                                <option value="image">Hình ảnh (Image)</option>
                            </select>
                        </div>
                        
                        {selectedField.type !== 'text' && (
                            <div className="grid grid-cols-2 gap-3 mt-1">
                                <ToolNumberInput 
                                    label="Rộng W"
                                    value={selectedField.width || 0}
                                    onChange={(val) => updateSelectedField({ width: val })}
                                    suffix="mm" step={0.1}
                                />
                                <ToolNumberInput 
                                    label="Cao H"
                                    value={selectedField.height || 0}
                                    onChange={(val) => updateSelectedField({ height: val })}
                                    suffix="mm" step={0.1}
                                />
                            </div>
                        )}
                        {selectedFieldIds.length >= 1 && (
                            <VdpAlignPanel
                                vdpFields={vdpFields}
                                setVdpFields={setVdpFields}
                                selectedFieldIds={selectedFieldIds}
                                pageDimMm={viewerPageDimMm}
                            />
                        )}
                        {['text', 'qrcode', 'barcode'].includes(selectedField.type) && (
                            <div className="flex flex-col gap-3 mt-1">
                                <div className="flex flex-col gap-1">
                                    <span className="text-[10px] font-medium text-slate-500 block mb-1">
                                        Nội dung {selectedField.type === 'text' ? 'Text' : selectedField.type === 'qrcode' ? 'QR Code' : 'Mã vạch'} 
                                        <span className="text-slate-400 font-normal"> (dùng "Chèn cột nhanh" bên dưới, hoặc gõ {'{Tên_Cột}'})</span>
                                    </span>
                                    <input 
                                        type="text" 
                                        value={selectedField.textContent !== undefined ? selectedField.textContent : `{${selectedField.name}}`}
                                        onChange={(e) => updateSelectedField({ textContent: e.target.value })}
                                        placeholder={`Ví dụ: ${selectedField.type === 'qrcode' ? 'https://example.com/?id=' : 'Mã '}{${selectedField.name || 'Cột'}}`}
                                        className="w-full h-8 px-2.5 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                    />
                                </div>

                                {csvHeaders.length > 0 && (
                                    <div className="flex flex-col gap-1.5 p-2 rounded-md bg-slate-50 dark:bg-zinc-800/50 border border-slate-200 dark:border-zinc-700">
                                        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">Chèn cột nhanh</span>
                                        <div className="grid grid-cols-2 gap-1.5">
                                            <select value={splitCol} onChange={e => setSplitCol(e.target.value)} className="h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500">
                                                <option value="">— Chọn cột —</option>
                                                {csvHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                                            </select>
                                            <select value={splitMode} onChange={e => setSplitMode(e.target.value)} className="h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500">
                                                <option value="whole">Cả cột (không tách)</option>
                                                <option value="ws">Tách: khoảng trắng</option>
                                                <option value="-">Tách: gạch ngang (-)</option>
                                                <option value=",">Tách: phẩy (,)</option>
                                                <option value=";">Tách: chấm phẩy (;)</option>
                                                <option value="/">Tách: gạch chéo (/)</option>
                                                <option value="custom">Tách: dấu khác…</option>
                                            </select>
                                        </div>
                                        {splitMode !== 'whole' && (
                                            <div className="grid grid-cols-2 gap-1.5">
                                                <div className="flex items-center gap-1.5">
                                                    <span className="text-[11px] text-slate-500 shrink-0">Phần</span>
                                                    <input type="number" min={1} value={splitPart} onChange={e => setSplitPart(Math.max(1, parseInt(e.target.value) || 1))} className="w-full h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500" />
                                                </div>
                                                {splitMode === 'custom' && (
                                                    <input value={splitCustom} onChange={e => setSplitCustom(e.target.value)} placeholder="Nhập dấu phân cách" className="h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500" />
                                                )}
                                            </div>
                                        )}
                                        <div className="flex items-center justify-between gap-2">
                                            <code className="text-[11px] text-teal-600 dark:text-teal-400 font-mono truncate" title="Cú pháp sẽ được chèn">{buildSplitToken() || '—'}</code>
                                            <button onClick={() => insertSplitToken(selectedField)} disabled={!splitCol} className="shrink-0 h-7 px-3 text-[11px] font-semibold bg-teal-500 text-white rounded-md hover:bg-teal-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">Chèn</button>
                                        </div>
                                    </div>
                                )}
                                {selectedField.type === 'text' && (
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="flex flex-col gap-1 col-span-2">
                                        <span className="text-[10px] font-medium text-slate-500 block mb-1">Font chữ (Font Family)</span>
                                        <FontSelector 
                                            value={selectedField.fontName || 'Helvetica'}
                                            fontFile={selectedField.fontFile}
                                            onChange={(fontName, fontFile) => updateSelectedField({ fontName, fontFile })}
                                        />
                                    </div>
                                    <div className="flex flex-col gap-1 col-span-2">
                                        <span className="text-[10px] font-medium text-slate-500 block mb-1">Nét font (Font Style)</span>
                                        <select 
                                            value={selectedField.fontStyle || 'normal'}
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
                                        value={selectedField.fontSize || 13}
                                        onChange={(val) => updateSelectedField({ fontSize: val })}
                                        suffix="pt" step={1}
                                    />
                                    <ToolNumberInput 
                                        label="Dòng (Leading)"
                                        value={selectedField.lineHeight || 1}
                                        onChange={(val) => updateSelectedField({ lineHeight: val })}
                                        suffix="em" step={0.1}
                                    />
                                    <ToolNumberInput 
                                        label="Khoảng cách (Tracking)"
                                        value={selectedField.characterSpacing || 0}
                                        onChange={(val) => updateSelectedField({ characterSpacing: val })}
                                        suffix="pt" step={0.5}
                                    />
                                    <div>
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">Căn lề</span>
                                        <div className="flex items-center gap-1.5">
                                            <select 
                                                value={selectedField.alignment || 'left'}
                                                onChange={(e) => updateSelectedField({ alignment: e.target.value })}
                                                className="flex-1 min-w-0 h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                            >
                                                <option value="left">Trái</option>
                                                <option value="center">Giữa</option>
                                                <option value="right">Phải</option>
                                            </select>
                                        </div>
                                    </div>
                                    <div className="col-span-2 flex items-center justify-between gap-2 py-1">
                                        <label className="flex items-center gap-2 text-[12px] font-semibold text-slate-600 dark:text-zinc-300 cursor-pointer select-none">
                                            <input
                                                type="checkbox"
                                                checked={selectedField.autoFit !== false}
                                                onChange={(e) => updateSelectedField({ autoFit: e.target.checked })}
                                                className="w-4 h-4 accent-teal-500"
                                            />
                                            Tự bóp chữ vừa khung
                                        </label>
                                        <button
                                            title="Thu chiều cao khung vừa khít nội dung text"
                                            onClick={fitHeightToText}
                                            className="h-8 px-2 text-[11px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md hover:border-teal-500 hover:text-teal-600 transition-all"
                                        >
                                            Thu khung theo chữ
                                        </button>
                                    </div>
                                    <div className="col-span-2">
                                        <span className="text-[10px] font-medium text-slate-500 block mb-1">Màu chữ</span>
                                        <CmykColorPicker
                                            value={selectedField.fontColor || '#000000'}
                                            onChange={(hex) => updateSelectedField({ fontColor: hex })}
                                        />
                                    </div>
                                </div>
                                )}
                            </div>
                        )}

                        {selectedField.type === 'qrcode' && selectedField.qrStyle && (
                            <div className="flex flex-col gap-3 mt-1 pt-3 border-t border-slate-200 dark:border-white/10">
                                <span className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 uppercase tracking-wider">Tuỳ chỉnh QR Code</span>
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">Kiểu chấm</span>
                                        <select 
                                            value={selectedField.qrStyle.dotType || 'square'}
                                            onChange={(e) => updateSelectedField({ qrStyle: { ...selectedField.qrStyle, dotType: e.target.value } })}
                                            className="w-full h-9 px-2 text-[13px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                        >
                                            <option value="square">Vuông</option>
                                            <option value="rounded">Bo tròn</option>
                                            <option value="dots">Chấm tròn</option>
                                            <option value="classy">Classy</option>
                                            <option value="classy-rounded">Classy bo</option>
                                            <option value="extra-rounded">Siêu tròn</option>
                                        </select>
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">Sửa lỗi (Mức)</span>
                                        <select 
                                            value={selectedField.errorCorrection || 'M'}
                                            onChange={(e) => updateSelectedField({ errorCorrection: e.target.value })}
                                            className="w-full h-9 px-2 text-[13px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                        >
                                            <option value="L">L (7%)</option>
                                            <option value="M">M (15%)</option>
                                            <option value="Q">Q (25%)</option>
                                            <option value="H">H (30%)</option>
                                        </select>
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">Màu chấm</span>
                                        <CmykColorPicker
                                            value={selectedField.qrStyle.dotColor || '#000000'}
                                            onChange={(hex) => updateSelectedField({ qrStyle: { ...selectedField.qrStyle, dotColor: hex } })}
                                        />
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">Màu nền</span>
                                        <CmykColorPicker
                                            value={selectedField.qrStyle.bgColor || '#FFFFFF'}
                                            onChange={(hex) => updateSelectedField({ qrStyle: { ...selectedField.qrStyle, bgColor: hex } })}
                                            disabled={selectedField.qrStyle.transparentBg}
                                        />
                                    </div>
                                    <div className="flex flex-col gap-1 col-span-2 mt-1">
                                        <label className="flex items-center gap-2 cursor-pointer">
                                            <input 
                                                type="checkbox"
                                                checked={selectedField.qrStyle.transparentBg || false}
                                                onChange={(e) => updateSelectedField({ qrStyle: { ...selectedField.qrStyle, transparentBg: e.target.checked } })}
                                                className="w-4 h-4 rounded border-slate-300 text-teal-500 focus:ring-teal-500"
                                            />
                                            <span className="text-[11px] text-slate-600 dark:text-zinc-400 font-medium">Nền trong suốt (Transparent)</span>
                                        </label>
                                    </div>
                                </div>
                            </div>
                        )}

                        {selectedField.type === 'barcode' && (
                            <div className="flex flex-col gap-3 mt-1 pt-3 border-t border-slate-200 dark:border-zinc-700">
                                <span className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 uppercase tracking-wider">Tuỳ chỉnh Mã Vạch</span>
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="flex flex-col gap-1 col-span-2">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">Loại mã vạch</span>
                                        <select 
                                            value={selectedField.barcodeType || 'code128'}
                                            onChange={(e) => updateSelectedField({ barcodeType: e.target.value })}
                                            className="w-full h-9 px-2 text-[13px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                        >
                                            <option value="code128">Code 128 (Đa năng, mọi ký tự)</option>
                                            <option value="ean13">EAN-13 (Bán lẻ, 13 số)</option>
                                            <option value="upca">UPC-A (Bán lẻ Mỹ, 12 số)</option>
                                            <option value="ean8">EAN-8 (Gọn, 8 số)</option>
                                            <option value="code39">Code 39 (Công nghiệp, A-Z + số)</option>
                                            <option value="itf14">ITF-14 (Thùng carton, 14 số)</option>
                                            <option value="codabar">Codabar (Y tế, thư viện)</option>
                                        </select>
                                    </div>
                                    <ToolNumberInput 
                                        label="Độ cao vạch"
                                        value={selectedField.barHeight || 12}
                                        onChange={(val) => updateSelectedField({ barHeight: val })}
                                        suffix="mm" step={0.5}
                                    />
                                    <ToolNumberInput 
                                        label="Lề trắng (mm)"
                                        value={selectedField.quietZone ?? 2}
                                        onChange={(val) => updateSelectedField({ quietZone: val })}
                                        suffix="mm" step={0.5}
                                    />
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">Màu vạch</span>
                                        <CmykColorPicker
                                            value={selectedField.barColor || '#000000'}
                                            onChange={(hex) => updateSelectedField({ barColor: hex })}
                                        />
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">Màu nền</span>
                                        <CmykColorPicker
                                            value={selectedField.bgColor || '#FFFFFF'}
                                            onChange={(hex) => updateSelectedField({ bgColor: hex })}
                                            disabled={selectedField.transparentBg}
                                        />
                                    </div>
                                    <div className="flex flex-col gap-1 col-span-2 mt-1">
                                        <label className="flex items-center gap-2 cursor-pointer">
                                            <input 
                                                type="checkbox"
                                                checked={selectedField.transparentBg || false}
                                                onChange={(e) => updateSelectedField({ transparentBg: e.target.checked })}
                                                className="w-4 h-4 rounded border-slate-300 text-teal-500 focus:ring-teal-500"
                                            />
                                            <span className="text-[11px] text-slate-600 dark:text-zinc-400 font-medium">Nền trong suốt (Transparent)</span>
                                        </label>
                                    </div>
                                    <div className="flex flex-col gap-2 col-span-2 mt-1">
                                        <label className="flex items-center gap-2 cursor-pointer">
                                            <input 
                                                type="checkbox"
                                                checked={selectedField.showText !== false}
                                                onChange={(e) => updateSelectedField({ showText: e.target.checked })}
                                                className="w-4 h-4 rounded border-slate-300 text-teal-500 focus:ring-teal-500"
                                            />
                                            <span className="text-[11px] text-slate-600 dark:text-zinc-400 font-medium">Hiển thị số bên dưới mã</span>
                                        </label>
                                        
                                        {selectedField.showText !== false && (
                                            <div className="grid grid-cols-2 gap-3 mt-1">
                                                <ToolNumberInput 
                                                    label="Cỡ chữ"
                                                    value={selectedField.fontSize || 10}
                                                    onChange={(val) => updateSelectedField({ fontSize: val })}
                                                    suffix="pt" step={1}
                                                />
                                                <div>
                                                    <span className="text-[11px] font-medium text-slate-500 block mb-1">Căn chữ</span>
                                                    <div className="flex items-center gap-1.5">
                                                        <select 
                                                            value={selectedField.textAlign || 'center'}
                                                            onChange={(e) => updateSelectedField({ textAlign: e.target.value })}
                                                            className="flex-1 min-w-0 h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                                        >
                                                            <option value="left">Trái</option>
                                                            <option value="center">Giữa</option>
                                                            <option value="right">Phải</option>
                                                        </select>
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                    <div className="flex flex-col gap-1 col-span-2 mt-1">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">Xoay (độ)</span>
                                        <select 
                                            value={selectedField.rotation || 0}
                                            onChange={(e) => updateSelectedField({ rotation: Number(e.target.value) })}
                                            className="w-full h-9 px-2 text-[13px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                        >
                                            <option value={0}>0°</option>
                                            <option value={90}>90°</option>
                                            <option value={180}>180°</option>
                                            <option value={270}>270°</option>
                                        </select>
                                    </div>
                                </div>
                            </div>
                        )}

                        {selectedField.type === 'image' && (
                            <div className="flex flex-col gap-3 mt-1 pt-3 border-t border-slate-200 dark:border-zinc-700">
                                <span className="text-[11px] font-bold text-slate-600 dark:text-zinc-400 uppercase tracking-wider">Tuỳ chỉnh Hình ảnh</span>
                                <div className="flex flex-col gap-3">
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">Hình dáng khung (Shape)</span>
                                        <select 
                                            value={selectedField.imageShape || 'rectangle'}
                                            onChange={(e) => updateSelectedField({ imageShape: e.target.value })}
                                            className="w-full h-9 px-2 text-[13px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                        >
                                            <option value="rectangle">Hình chữ nhật / Vuông</option>
                                            <option value="rounded">Bo góc (Rounded Rectangle)</option>
                                            <option value="circle">Hình tròn / Oval</option>
                                            <option value="polygon">Đa giác (Polygon)</option>
                                            <option value="star">Hình ngôi sao (Star)</option>
                                        </select>
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[11px] font-medium text-slate-500 block mb-1">Chế độ căn chỉnh (Fit)</span>
                                        <select 
                                            value={selectedField.imageFit || 'cover'}
                                            onChange={(e) => updateSelectedField({ imageFit: e.target.value })}
                                            className="w-full h-9 px-2 text-[13px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                        >
                                            <option value="cover">Vừa khung, cắt phần thừa (Cover)</option>
                                            <option value="fill">Bóp méo vừa khít khung (Fill)</option>
                                            <option value="contain">Giữ tỷ lệ, thấy toàn bộ ảnh (Contain)</option>
                                        </select>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </VdpSection>
            )}

            {/* Action Buttons */}
            <div className="pt-2">
                {statusMessage && (
                    <div className="text-[11px] text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 p-2 rounded mb-3 text-center">
                        {statusMessage}
                    </div>
                )}
                
                <button
                    onClick={() => batchFiles.length >= 2 ? handleBatchGenerate(batchFiles) : handleGenerate()}
                    disabled={isGenerating || vdpFields.length === 0 || csvData.length === 0}
                    className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-400 disabled:cursor-not-allowed text-white text-sm font-bold rounded-lg shadow-sm transition-colors flex items-center justify-center gap-2"
                >
                    {isGenerating ? (
                        <>
                            <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                            Đang xử lý...
                        </>
                    ) : (
                        <>
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
                            {batchFiles.length >= 2 ? `Chạy ${batchFiles.length} file` : 'Chạy dữ liệu (Run)'}
                        </>
                    )}
                </button>
                <div className="mt-2 flex items-center gap-2 px-1">
                    <input
                        type="checkbox"
                        id="spawnNewTabVdp"
                        checked={spawnNewTab}
                        onChange={(e) => setSpawnNewTab(e.target.checked)}
                        className="w-3.5 h-3.5 rounded text-blue-600 focus:ring-blue-500 bg-white dark:bg-zinc-900 border-slate-300 dark:border-zinc-600 cursor-pointer"
                    />
                    <label htmlFor="spawnNewTabVdp" className="text-[11px] text-slate-600 dark:text-zinc-400 cursor-pointer select-none">
                        Mở kết quả sang Tab mới (thay vì đè file hiện tại)
                    </label>
                </div>
            </div>

            {showBatchInfo && createPortal(
                <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => setShowBatchInfo(false)} onKeyDown={e => { if (e.key === 'Escape') setShowBatchInfo(false); }} tabIndex={-1} ref={el => el?.focus()}>
                    <div className="bg-white dark:bg-zinc-800 rounded-lg shadow-2xl w-full max-w-md max-h-[40vh] flex flex-col border border-slate-200 dark:border-zinc-700" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-zinc-700">
                            <h3 className="text-sm font-bold text-slate-800 dark:text-white">Danh sách file CSV ({batchFiles.length})</h3>
                            <button onClick={() => setShowBatchInfo(false)} className="p-1 rounded hover:bg-slate-100 dark:hover:bg-zinc-700 text-slate-500">
                                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-2 scroller-thin">
                            {batchInfoLoading ? (
                                <div className="flex items-center justify-center gap-2 py-8 text-slate-500 text-sm">
                                    <div className="w-5 h-5 border-2 border-slate-300 border-t-indigo-500 rounded-full animate-spin" />
                                    Đang đọc {batchFiles.length} file…
                                </div>
                            ) : (
                                <table className="w-full text-[12px]">
                                    <thead>
                                        <tr className="text-left text-slate-400 border-b border-slate-200 dark:border-zinc-700">
                                            <th className="py-1.5 px-2 font-semibold w-6">#</th>
                                            <th className="py-1.5 px-2 font-semibold">Tên file</th>
                                            <th className="py-1.5 px-2 font-semibold text-right">Bản ghi</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {batchInfo.map((it, i) => (
                                            <tr key={i} className="border-b border-slate-100 dark:border-zinc-700/50">
                                                <td className="py-1.5 px-2 text-slate-400">{i + 1}</td>
                                                <td className="py-1.5 px-2 text-slate-700 dark:text-zinc-200 break-all">{it.name}</td>
                                                <td className="py-1.5 px-2 text-right font-bold text-slate-800 dark:text-white">{it.records < 0 ? 'Lỗi' : it.records.toLocaleString('vi-VN')}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>
                        {!batchInfoLoading && batchInfo.length > 0 && (
                            <div className="px-4 py-2.5 border-t border-slate-200 dark:border-zinc-700 flex items-center justify-between text-[12px]">
                                <span className="text-slate-500">Tổng cộng</span>
                                <span className="font-bold text-slate-800 dark:text-white">{batchInfo.reduce((s, it) => s + (it.records > 0 ? it.records : 0), 0).toLocaleString('vi-VN')} bản ghi</span>
                            </div>
                        )}
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
}