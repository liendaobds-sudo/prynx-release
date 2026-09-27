import React, { useState, useEffect, useRef, useMemo } from 'react';
import { startVdpJobBackend, pollVdpJob, cancelVdpJobBackend, type VdpProgressInfo } from '@/lib/api'; // UIUX (audit 2026-07-27 §D-07)
import { ProgressBar } from '../ui/ProgressBar';
import { toast } from '../ui/Toast';
import { formatError, isCanceled } from '@/lib/errorMessages';
import { CmykColorPicker } from './DataMergeTool';
import { ToolNumberInput, VdpSection } from './ToolUI';
import { FontSelector } from './FontSelector';
import { useVdpTool, type SetVdpFields, type VdpToolField } from '@/hooks/useVdpTool';
import { startVdpDrag } from '../../utils/vdpDrag';
import { sortFieldsGeometrically, VdpSortMethod } from '@/lib/vdpUtils';
import { VdpAlignPanel } from './VdpAlignPanel';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import { useNumberingJobStore } from '@/stores/useNumberingJobStore';
import { useTranslation } from 'react-i18next';
import { tagArtifactLeaseToken } from '@/lib/artifactLease';

interface Props {
  pdfFile: File | null;
  getWorkingFile?: () => Promise<File>;
  vdpFields?: VdpToolField[];
  setVdpFields?: SetVdpFields;
  selectedFieldIds?: string[];
  onSelectField?: (ids: string[]) => void;
  onSpawnTab?: (blob: Blob, name: string, path?: string) => void;
  onApplyResult?: (blob: Blob, name: string, path?: string) => void | Promise<void>;
  isActive?: boolean;
}

interface NumberingSlot extends VdpToolField {
  isSlot: true;
  fields: VdpToolField[];
}

export interface FieldSequenceConfig {
  genMethod: 'range' | 'set';
  startNum: number;
  endNum: number;
  increment: number;
  padZero: boolean;
  padLength: number;
  prefix: string;
  suffix: string;
  isShuffle: boolean;
  setTotal: number;
  setStartStr: string;
  seqTotal: number;
  seqStart: number;
  formatTemplate: string;
}

export const SET_FORMAT_PRESETS = [
  { value: '{%b}-{%t}', label: 'A-01 (Ký tự - Số, gạch nối)' },
  { value: '{%b}/{%t}', label: 'A/01 (Ký tự / Số, gạch chéo)' },
  { value: '{%b}.{%t}', label: 'A.01 (Ký tự . Số, dấu chấm)' },
  { value: '{%b} {%t}', label: 'A 01 (Khoảng cách)' },
  { value: '{%b}{%t}', label: 'A01 (Viết liền)' },
  { value: '__custom__', label: '⚙️ Tùy chỉnh khác...' },
] as const;

function sequenceSeed(cfg: FieldSequenceConfig): number {
  // NUM (audit 2026-09-23 §NUM23.01): preview, live-view và output đều gọi
  // computeSequenceFromConfig nhiều lần. Seed phải phụ thuộc cấu hình, không phụ
  // thuộc Math.random(), nếu không bật Shuffle sẽ làm mỗi consumer có một dãy khác.
  const source = JSON.stringify([
    cfg.genMethod, cfg.startNum, cfg.endNum, cfg.increment, cfg.padZero,
    cfg.padLength, cfg.prefix, cfg.suffix, cfg.setTotal, cfg.setStartStr,
    cfg.seqTotal, cfg.seqStart, cfg.formatTemplate,
  ]);
  let hash = 2166136261;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export function computeSequenceFromConfig(cfg: FieldSequenceConfig): string[] {
  const MAX_SEQUENCE = 200000;
  const rawSequence: string[] = [];
  const step = Number(cfg.increment);

  if (cfg.genMethod === 'range') {
    if (Number.isFinite(step) && step > 0 && Number.isFinite(cfg.startNum) && Number.isFinite(cfg.endNum)) {
      for (let i = cfg.startNum; i <= cfg.endNum; i += step) {
        if (rawSequence.length >= MAX_SEQUENCE) break;
        let numStr = i.toString();
        if (cfg.padZero) {
          numStr = numStr.padStart(cfg.padLength, '0');
        }
        rawSequence.push(`${cfg.prefix}${numStr}${cfg.suffix}`);
      }
    }
  } else {
    const isAlphaSet = isNaN(Number(cfg.setStartStr)) && cfg.setStartStr.length > 0;
    const isLower = isAlphaSet && cfg.setStartStr.charCodeAt(0) >= 97;
    
    const lettersToNumber = (letters: string) => {
      let num = 0;
      for (let i = 0; i < letters.length; i++) {
        num = num * 26 + (letters.toUpperCase().charCodeAt(i) - 64);
      }
      return num;
    };

    const numberToLetters = (num: number, lower = false) => {
      let str = '';
      while (num > 0) {
        const rem = (num - 1) % 26;
        str = String.fromCharCode(rem + (lower ? 97 : 65)) + str;
        num = Math.floor((num - 1) / 26);
      }
      return str;
    };

    const startSetNum = isAlphaSet ? lettersToNumber(cfg.setStartStr) : (parseInt(cfg.setStartStr) || 1);
    
    for (let s = 0; s < cfg.setTotal; s++) {
      if (rawSequence.length >= MAX_SEQUENCE) break;
      let setValStr = '';
      if (isAlphaSet) {
        setValStr = numberToLetters(startSetNum + s, isLower);
      } else {
        const sNum = startSetNum + s;
        setValStr = cfg.padZero ? sNum.toString().padStart(cfg.setStartStr.length, '0') : sNum.toString();
      }

      const seqStep = Number.isFinite(step) && step > 0 ? step : 1;
      for (let q = 0; q < cfg.seqTotal; q++) {
        if (rawSequence.length >= MAX_SEQUENCE) break;
        const qNum = cfg.seqStart + q * seqStep;
        const seqValStr = cfg.padZero ? qNum.toString().padStart(cfg.padLength, '0') : qNum.toString();
        
        const resultStr = cfg.formatTemplate.replace(/\{%b\}/g, setValStr).replace(/\{%t\}/g, seqValStr);
        rawSequence.push(`${cfg.prefix}${resultStr}${cfg.suffix}`);
      }
    }
  }

  if (rawSequence.length === 0) return [];

  if (cfg.isShuffle) {
    const random = seededRandom(sequenceSeed(cfg));
    for (let i = rawSequence.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [rawSequence[i], rawSequence[j]] = [rawSequence[j], rawSequence[i]];
    }
  }
  return rawSequence;
}

/** Sơ đồ mini trực quan mô phỏng quy luật nhảy số trên tờ in */
function FinishingPreviewDiagram({
    applyStyle,
    sortMethod = 'rows',
    rawSequence = [],
    numSlots = 0,
    totalPages = 1,
}: {
    applyStyle: 'stack' | 'linear';
    sortMethod?: VdpSortMethod;
    rawSequence?: string[];
    numSlots?: number;
    totalPages?: number;
}) {
    const { t } = useTranslation();

    // Helper sinh giá trị số mẫu thực tế khớp với cấu hình của người dùng
    const getVal = (index: number): string => {
        if (rawSequence && rawSequence.length > index && rawSequence[index] !== undefined && rawSequence[index] !== '') {
            return rawSequence[index];
        }
        if (rawSequence && rawSequence.length > 0) {
            const first = rawSequence[0];
            const m = first.match(/^(.*?)(\d+)(\D*)$/);
            if (m) {
                const prefix = m[1];
                const numStr = m[2];
                const suffix = m[3];
                const baseNum = parseInt(numStr, 10) || 1;
                const targetNum = baseNum + index;
                const targetStr = numStr.startsWith('0') ? String(targetNum).padStart(numStr.length, '0') : String(targetNum);
                return `${prefix}${targetStr}${suffix}`;
            }
        }
        return `#${String(index + 1).padStart(3, '0')}`;
    };

    // Số slot tượng trưng hiển thị: nếu user đã đặt 1, 2, 3 vị trí thì hiện đúng số đó. Nếu chưa đặt hoặc >=4 thì hiện 4 (2x2).
    const displaySlotCount = (numSlots >= 1 && numSlots <= 3) ? numSlots : 4;
    const effectiveTotalPages = (totalPages && totalPages >= 2) ? totalPages : 50;

    const slotValuesSheet1: string[] = [];
    const slotValuesSheet2: string[] = [];

    for (let s = 0; s < displaySlotCount; s++) {
        if (applyStyle === 'linear') {
            slotValuesSheet1.push(getVal(s));
            slotValuesSheet2.push(getVal(displaySlotCount + s));
        } else {
            slotValuesSheet1.push(getVal(s * effectiveTotalPages + 0));
            slotValuesSheet2.push(getVal(s * effectiveTotalPages + 1));
        }
    }

    interface GridBox {
        orderLabel: string;
        val: string;
    }

    const arrange4Grid = (vals: string[], baseOrder: number = 1): { tl: GridBox; tr: GridBox; bl: GridBox; br: GridBox } => {
        const v0 = vals[0] || '';
        const v1 = vals[1] || '';
        const v2 = vals[2] || '';
        const v3 = vals[3] || '';

        const o1 = `${baseOrder}`;
        const o2 = `${baseOrder + 1}`;
        const o3 = `${baseOrder + 2}`;
        const o4 = `${baseOrder + 3}`;

        switch (sortMethod) {
            case 'cols': // Quét theo cột (N): Cột trái (1 -> 2), Cột phải (3 -> 4)
                return {
                    tl: { orderLabel: o1, val: v0 },
                    bl: { orderLabel: o2, val: v1 },
                    tr: { orderLabel: o3, val: v2 },
                    br: { orderLabel: o4, val: v3 },
                };
            case 'ushape': // Rắn bò (U): Hàng trên (1 -> 2), Hàng dưới lượn ngược (4 <- 3)
            case 'clockwise':
                return {
                    tl: { orderLabel: o1, val: v0 },
                    tr: { orderLabel: o2, val: v1 },
                    br: { orderLabel: o3, val: v2 },
                    bl: { orderLabel: o4, val: v3 },
                };
            case 'rows': // Quét theo hàng (Z): Hàng trên (1 -> 2), Hàng dưới (3 -> 4)
            default:
                return {
                    tl: { orderLabel: o1, val: v0 },
                    tr: { orderLabel: o2, val: v1 },
                    bl: { orderLabel: o3, val: v2 },
                    br: { orderLabel: o4, val: v3 },
                };
        }
    };

    const sheet1Grid = displaySlotCount === 4 ? arrange4Grid(slotValuesSheet1, 1) : null;
    const sheet2Grid = displaySlotCount === 4 ? arrange4Grid(slotValuesSheet2, applyStyle === 'linear' ? 5 : 1) : null;

    const renderBox = (box: GridBox) => (
        <div 
            className="p-1 rounded bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 flex items-center justify-between px-1.5"
            title={box.val}
        >
            <span className="text-[8px] font-sans font-normal opacity-50 bg-indigo-200/50 dark:bg-indigo-800/50 w-3.5 h-3.5 rounded-full flex items-center justify-center shrink-0">
                {box.orderLabel}
            </span>
            <span className="truncate font-mono font-bold text-[11px] flex-1 text-center">
                {box.val}
            </span>
        </div>
    );

    return (
        <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-zinc-800/50 border border-slate-200 dark:border-zinc-700/80 space-y-2">
            <div className="flex items-center justify-between text-[11px] font-bold text-slate-700 dark:text-zinc-300">
                <span className="flex items-center gap-1.5">
                    <span>{t('preprocess.numbering:so_do_minh_hoa', 'Sơ đồ mô phỏng thứ tự nhảy')}</span>
                    {numSlots > 0 && (
                        <span className="text-[9px] font-normal text-slate-400">
                            ({numSlots} vị trí/tờ)
                        </span>
                    )}
                </span>
                <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-semibold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/60 px-1.5 py-0.5 rounded border border-indigo-200 dark:border-indigo-800">
                        {applyStyle === 'stack' ? t('preprocess.numbering:dong_cuon_xen_chong', 'Đóng cuốn') : t('preprocess.numbering:tem_roi_thu_tu', 'Tem rời')}
                    </span>
                    <span className="text-[10px] font-medium text-slate-500 dark:text-zinc-400 bg-slate-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">
                        {sortMethod === 'rows' ? 'Hàng (Z)' : sortMethod === 'cols' ? 'Cột (N)' : sortMethod === 'ushape' ? 'Rắn bò (U)' : 'Kim đồng hồ'}
                    </span>
                </div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-center">
                {/* Tờ in 1 */}
                <div className="p-2 rounded border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-2xs">
                    <span className="text-[10px] font-bold text-slate-500 uppercase block mb-1">Tờ in 1</span>
                    {sheet1Grid ? (
                        <div className="grid grid-cols-2 gap-1 text-[11px] font-mono font-bold">
                            {renderBox(sheet1Grid.tl)}
                            {renderBox(sheet1Grid.tr)}
                            {renderBox(sheet1Grid.bl)}
                            {renderBox(sheet1Grid.br)}
                        </div>
                    ) : (
                        <div className={`grid gap-1 text-[11px] font-mono font-bold ${displaySlotCount === 1 ? 'grid-cols-1' : displaySlotCount === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
                            {slotValuesSheet1.map((val, idx) => (
                                <div key={idx} className="p-1 rounded bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 flex items-center justify-between px-1.5" title={val}>
                                    <span className="text-[8px] font-sans font-normal opacity-50 bg-indigo-200/50 dark:bg-indigo-800/50 w-3.5 h-3.5 rounded-full flex items-center justify-center shrink-0">
                                        {idx + 1}
                                    </span>
                                    <span className="truncate font-mono font-bold text-[11px] flex-1 text-center">{val}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
                {/* Tờ in 2 */}
                <div className="p-2 rounded border border-slate-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-2xs">
                    <span className="text-[10px] font-bold text-slate-500 uppercase block mb-1">Tờ in 2</span>
                    {sheet2Grid ? (
                        <div className="grid grid-cols-2 gap-1 text-[11px] font-mono font-bold">
                            {renderBox(sheet2Grid.tl)}
                            {renderBox(sheet2Grid.tr)}
                            {renderBox(sheet2Grid.bl)}
                            {renderBox(sheet2Grid.br)}
                        </div>
                    ) : (
                        <div className={`grid gap-1 text-[11px] font-mono font-bold ${displaySlotCount === 1 ? 'grid-cols-1' : displaySlotCount === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
                            {slotValuesSheet2.map((val, idx) => (
                                <div key={idx} className="p-1 rounded bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 flex items-center justify-between px-1.5" title={val}>
                                    <span className="text-[8px] font-sans font-normal opacity-50 bg-indigo-200/50 dark:bg-indigo-800/50 w-3.5 h-3.5 rounded-full flex items-center justify-center shrink-0">
                                        {applyStyle === 'linear' ? displaySlotCount + idx + 1 : idx + 1}
                                    </span>
                                    <span className="truncate font-mono font-bold text-[11px] flex-1 text-center">{val}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
            <p className="text-[10px] text-slate-500 dark:text-zinc-400 leading-snug">
                {applyStyle === 'stack' ? (
                    <>
                        💡 <strong>Đóng cuốn xén chồng:</strong> Số nhảy xuyên suốt giữa các tờ in (Tờ 1: <span className="font-mono text-indigo-600 dark:text-indigo-400 font-semibold">{slotValuesSheet1[0]}</span>, Tờ 2: <span className="font-mono text-indigo-600 dark:text-indigo-400 font-semibold">{slotValuesSheet2[0]}</span>...). In xong, xén từng cọc giấy rồi xếp chồng các cọc lên nhau theo thứ tự sẽ được các tập vé liền mạch.
                    </>
                ) : (
                    <>
                        💡 <strong>Tem rời liên tục:</strong> Số seri nhảy lần lượt trên từng tờ in theo {
                            sortMethod === 'rows' ? 'hàng ngang (từ trái qua phải, từ trên xuống dưới - chữ Z)' :
                            sortMethod === 'cols' ? 'cột dọc (từ trên xuống dưới, từ trái qua phải - chữ N)' :
                            sortMethod === 'ushape' ? 'kiểu rắn bò (hàng trên từ trái qua phải, hàng dưới lượn ngược lại)' :
                            'vòng tròn theo chiều kim đồng hồ'
                        }. Thích hợp in nhãn dán, decal hoặc vé rời.
                    </>
                )}
            </p>
        </div>
    );
}

export default function NumberingTool({
  pdfFile,
  getWorkingFile,
  vdpFields = [],
  setVdpFields,
  selectedFieldIds = [],
  onSelectField,
  onSpawnTab,
  onApplyResult,
  isActive = true
}: Props) {
  const { t } = useTranslation();
    const isPickingVdpText = useWorkspaceStore(s => s.isPickingVdpText);
    const setIsPickingVdpText = useWorkspaceStore(s => s.setIsPickingVdpText);
    const setVdpLivePreview = useWorkspaceStore(s => s.setVdpLivePreview);
    const [statusMessage, setStatusMessage] = useState("");
    const [isGenerating, setIsGenerating] = useState(false);
    const [progressInfo, setProgressInfo] = useState<VdpProgressInfo | null>(null);
    const [spawnNewTab, setSpawnNewTab] = useState(true);
    const [showHelp, setShowHelp] = useState(false);
    const [helpTab, setHelpTab] = useState<'hotkeys' | 'config' | 'cutstack'>('hotkeys');

    // Hủy polling VDP khi unmount
    const pollAbortRef = useRef<AbortController | null>(null);
    const activeVdpJobRef = useRef<string | null>(null);
    const [activeVdpJobId, setActiveVdpJobId] = useState<string | null>(null);
    useEffect(() => () => {
        pollAbortRef.current?.abort();
        const jobId = activeVdpJobRef.current;
        if (jobId) void cancelVdpJobBackend(jobId).catch(() => undefined);
    }, []);

    const cancelActiveVdp = async () => {
        const jobId = activeVdpJobRef.current;
        if (!jobId) return;
        await cancelVdpJobBackend(jobId);
        pollAbortRef.current?.abort();
    };

    // Đóng modal trợ giúp bằng phím ESC
    useEffect(() => {
        if (!showHelp || !isActive) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.stopPropagation(); setShowHelp(false); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [showHelp, isActive]);

    // Sequence Mode: 'shared' (chung 1 dãy cho tất cả slot) vs 'per_field' (dãy số riêng từng trường)
    const [sequenceMode, setSequenceMode] = useState<'shared' | 'per_field'>('shared');
    const [activeConfigSlotId, setActiveConfigSlotId] = useState<string | null>(null);
    const [fieldConfigs, setFieldConfigs] = useState<Record<string, FieldSequenceConfig>>({});

    // Generation State (cho slot hiện tại / chế độ chung)
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
    const [isCustomFormat, setIsCustomFormat] = useState<boolean>(false);

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
        duplicateSelectedFields,
        handleGroupFields,
        handleUngroupFields
    } = useVdpTool(vdpFields, setVdpFields, selectedFieldIds, onSelectField, isActive);

    // UIUX (audit 2026-09-27): Tự động nhận diện chuỗi số mẫu (Smart Extract) khi người dùng nhấp chọn từ PDF
    const extractedIdsRef = useRef<Set<string>>(new Set());

    // Sync vdpFields names to "Slot 1", "Slot 2" automatically
    useEffect(() => {
        if (!setVdpFields || vdpFields.length === 0) return;
        let needsUpdate = false;
        const seen = new Set<string>();

        // Auto-extract pattern if text is picked from PDF
        vdpFields.forEach(f => {
            if (f.textContent && !f.textContent.startsWith('{') && !extractedIdsRef.current.has(f.id)) {
                extractedIdsRef.current.add(f.id);
                const match = f.textContent.match(/^(.*?)(\d+)(\D*)$/);
                if (match) {
                    setPrefix(match[1]);
                    const sNum = parseInt(match[2], 10) || 1;
                    setStartNum(sNum);
                    if (match[2].startsWith('0')) {
                        setPadZero(true);
                        setPadLength(match[2].length);
                    } else {
                        setPadZero(false);
                    }
                    setSuffix(match[3]);
                    // Tự động trích xuất cấu hình vào Bước 2 mà không spam popup toast
                }
            }
        });

        const updated = vdpFields.map((f, idx) => {
            const isAuto = !f.name || /^Truong_\d+$/.test(f.name);
            if (isAuto || seen.has(f.name)) {
                needsUpdate = true;
                let n = idx + 1;
                let newName = `Slot${n}`;
                while (seen.has(newName)) { n++; newName = `Slot${n}`; }
                seen.add(newName);
                return { ...f, name: newName, textContent: `{${newName}}` };
            }
            seen.add(f.name);
            return f;
        });
        if (needsUpdate) setVdpFields(updated);
    }, [vdpFields.length, setVdpFields, t]);

    const currentSharedConfig: FieldSequenceConfig = useMemo(() => ({
        genMethod,
        startNum,
        endNum,
        increment,
        padZero,
        padLength,
        prefix,
        suffix,
        isShuffle,
        setTotal,
        setStartStr,
        seqTotal,
        seqStart,
        formatTemplate,
    }), [genMethod, startNum, endNum, increment, padZero, padLength, prefix, suffix, isShuffle, setTotal, setStartStr, seqTotal, seqStart, formatTemplate]);

    const generateSequence = React.useCallback(() => {
        return computeSequenceFromConfig(currentSharedConfig);
    }, [currentSharedConfig]);

    // Gom field thành slot (theo groupId) rồi SORT theo sortMethod
    const buildSortedSlots = React.useCallback(() => {
        const slots: NumberingSlot[] = [];
        const groupMap = new Map<string, VdpToolField[]>();

        vdpFields.forEach(f => {
            if (f.groupId) {
                if (!groupMap.has(f.groupId)) groupMap.set(f.groupId, []);
                groupMap.get(f.groupId)!.push(f);
            } else {
                slots.push({ ...f, isSlot: true, fields: [f] });
            }
        });

        groupMap.forEach((fieldsInGroup, groupId) => {
            let minX = (fieldsInGroup[0].x || fieldsInGroup[0].position?.x) ?? 0;
            let minY = (fieldsInGroup[0].y || fieldsInGroup[0].position?.y) ?? 0;
            fieldsInGroup.forEach(f => {
                const fx = (f.x || f.position?.x) ?? 0;
                const fy = (f.y || f.position?.y) ?? 0;
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

        slots.forEach(s => {
            if (!s.position) s.position = { x: s.x ?? 0, y: s.y ?? 0 };
        });

        return sortFieldsGeometrically(slots, sortMethod);
    }, [vdpFields, sortMethod]);

    const sortedSlots = useMemo(() => buildSortedSlots(), [buildSortedSlots]);
    const numSlots = sortedSlots.length;

    // Tự động đồng bộ form vào fieldConfigs khi đang ở chế độ per_field
    useEffect(() => {
        if (sequenceMode !== 'per_field' || !activeConfigSlotId) return;
        setFieldConfigs(prev => {
            const existing = prev[activeConfigSlotId];
            if (
                existing &&
                existing.genMethod === genMethod &&
                existing.startNum === startNum &&
                existing.endNum === endNum &&
                existing.increment === increment &&
                existing.padZero === padZero &&
                existing.padLength === padLength &&
                existing.prefix === prefix &&
                existing.suffix === suffix &&
                existing.isShuffle === isShuffle &&
                existing.setTotal === setTotal &&
                existing.setStartStr === setStartStr &&
                existing.seqTotal === seqTotal &&
                existing.seqStart === seqStart &&
                existing.formatTemplate === formatTemplate
            ) {
                return prev;
            }
            return {
                ...prev,
                [activeConfigSlotId]: { ...currentSharedConfig }
            };
        });
    }, [sequenceMode, activeConfigSlotId, currentSharedConfig, genMethod, startNum, endNum, increment, padZero, padLength, prefix, suffix, isShuffle, setTotal, setStartStr, seqTotal, seqStart, formatTemplate]);

    const handleSelectSlotConfig = (slotId: string) => {
        setActiveConfigSlotId(slotId);
        const slots = buildSortedSlots();
        const targetSlot = slots.find(s => s.id === slotId);
        if (targetSlot) {
            onSelectField?.(targetSlot.fields.map(f => f.id));
        }
        const cfg = fieldConfigs[slotId];
        if (cfg) {
            setGenMethod(cfg.genMethod);
            setStartNum(cfg.startNum);
            setEndNum(cfg.endNum);
            setIncrement(cfg.increment);
            setPadZero(cfg.padZero);
            setPadLength(cfg.padLength);
            setPrefix(cfg.prefix);
            setSuffix(cfg.suffix);
            setIsShuffle(cfg.isShuffle);
            setSetTotal(cfg.setTotal);
            setSetStartStr(cfg.setStartStr);
            setSeqTotal(cfg.seqTotal);
            setSeqStart(cfg.seqStart);
            setFormatTemplate(cfg.formatTemplate);
            setIsCustomFormat(!SET_FORMAT_PRESETS.some(p => p.value === cfg.formatTemplate && p.value !== '__custom__'));
        }
    };

    const handleCopyConfigToAllSlots = () => {
        const slots = buildSortedSlots();
        const updated: Record<string, FieldSequenceConfig> = {};
        slots.forEach(slot => {
            updated[slot.id] = { ...currentSharedConfig };
        });
        setFieldConfigs(updated);
        toast.success(t('preprocess.numbering:da_sao_chep_cai_dat'));
    };

    // Thao tác nhanh: Gộp tất cả các vị trí thành 1 số (cuống & thân vé)
    const handleQuickGroupAll = () => {
        if (!setVdpFields || vdpFields.length < 2) return;
        const newGroupId = `grp_${Date.now().toString(36)}`;
        const updated = vdpFields.map(f => ({ ...f, groupId: newGroupId }));
        setVdpFields(updated);
        toast.success(t('preprocess.numbering:da_gop_nhom_cung_so', 'Đã gộp tất cả vị trí mang cùng 1 số seri (Cuống & Thân vé)'));
    };

    // Thao tác nhanh: Tách các vị trí thành số độc lập
    const handleQuickUngroupAll = () => {
        if (!setVdpFields || vdpFields.length === 0) return;
        const updated = vdpFields.map(f => ({ ...f, groupId: undefined }));
        setVdpFields(updated);
        toast.info(t('preprocess.numbering:da_tach_rieng_vi_tri', 'Đã tách các vị trí thành số nhảy độc lập'));
    };

    // Tính toán số lượng của từng slot và phát hiện chênh lệch (Length Mismatch)
    const slotLengthStats = useMemo(() => {
        if (sequenceMode !== 'per_field' || sortedSlots.length <= 1) {
            return { isMismatch: false, minCount: 0, maxCount: 0, stats: [] };
        }

        const stats = sortedSlots.map(slot => {
            const cfg = fieldConfigs[slot.id] || currentSharedConfig;
            let count = 0;
            if (cfg.genMethod === 'range') {
                const step = Number(cfg.increment) > 0 ? Number(cfg.increment) : 1;
                if (cfg.endNum >= cfg.startNum) {
                    count = Math.floor((cfg.endNum - cfg.startNum) / step) + 1;
                }
            } else {
                count = (cfg.setTotal || 1) * (cfg.seqTotal || 1);
            }
            return {
                id: slot.id,
                name: slot.name,
                count,
                startNum: cfg.startNum,
                endNum: cfg.endNum,
                increment: cfg.increment,
                genMethod: cfg.genMethod,
            };
        });

        const counts = stats.map(s => s.count);
        const minCount = Math.min(...counts);
        const maxCount = Math.max(...counts);
        const isMismatch = minCount !== maxCount;

        return { isMismatch, minCount, maxCount, stats };
    }, [sequenceMode, sortedSlots, fieldConfigs, currentSharedConfig]);

    const handleSyncToMaxCount = () => {
        const targetCount = slotLengthStats.maxCount;
        if (targetCount <= 0) return;
        const updated: Record<string, FieldSequenceConfig> = { ...fieldConfigs };

        sortedSlots.forEach(slot => {
            const current = updated[slot.id] || { ...currentSharedConfig };
            if (current.genMethod === 'range') {
                const step = Number(current.increment) > 0 ? Number(current.increment) : 1;
                const newEnd = current.startNum + (targetCount - 1) * step;
                updated[slot.id] = { ...current, endNum: newEnd };
                if (slot.id === activeConfigSlotId) {
                    setEndNum(newEnd);
                }
            } else {
                const sTotal = Math.max(1, current.setTotal);
                const newSeqTotal = Math.ceil(targetCount / sTotal);
                updated[slot.id] = { ...current, seqTotal: newSeqTotal };
                if (slot.id === activeConfigSlotId) {
                    setSeqTotal(newSeqTotal);
                }
            }
        });

        setFieldConfigs(updated);
        toast.success(t('preprocess.numbering:da_dong_bo_so_luong', { count: targetCount }));
    };

    const handleSyncToMinCount = () => {
        const targetCount = slotLengthStats.minCount;
        if (targetCount <= 0) return;
        const updated: Record<string, FieldSequenceConfig> = { ...fieldConfigs };

        sortedSlots.forEach(slot => {
            const current = updated[slot.id] || { ...currentSharedConfig };
            if (current.genMethod === 'range') {
                const step = Number(current.increment) > 0 ? Number(current.increment) : 1;
                const newEnd = current.startNum + (targetCount - 1) * step;
                updated[slot.id] = { ...current, endNum: newEnd };
                if (slot.id === activeConfigSlotId) {
                    setEndNum(newEnd);
                }
            } else {
                const sTotal = Math.max(1, current.setTotal);
                const newSeqTotal = Math.max(1, Math.floor(targetCount / sTotal));
                updated[slot.id] = { ...current, seqTotal: newSeqTotal };
                if (slot.id === activeConfigSlotId) {
                    setSeqTotal(newSeqTotal);
                }
            }
        });

        setFieldConfigs(updated);
        toast.success(t('preprocess.numbering:da_cat_ngan_so_luong', { count: targetCount }));
    };

    const generateDataMatrix = React.useCallback(() => {
        if (vdpFields.length === 0) throw new Error(t('preprocess.numbering:vui_long_keo_it_nhat_1_truong_nhay_so'));
        const slots = buildSortedSlots();
        const numSlots = slots.length;

        if (sequenceMode === 'per_field') {
            const seqMap = new Map<string, string[]>();
            let maxLen = 0;
            slots.forEach(slot => {
                const cfg = fieldConfigs[slot.id] || currentSharedConfig;
                const seq = computeSequenceFromConfig(cfg);
                seqMap.set(slot.id, seq);
                if (seq.length > maxLen) maxLen = seq.length;
            });

            if (maxLen === 0) throw new Error(t('preprocess.numbering:day_so_trong_vui_long_kiem_tra_lai'));

            const csvData: Record<string, string>[] = [];
            for (let p = 0; p < maxLen; p++) {
                const row: Record<string, string> = {};
                for (let s = 0; s < numSlots; s++) {
                    const slot = slots[s];
                    const seq = seqMap.get(slot.id) || [];
                    const val = (seq[p] !== undefined && seq[p] !== '') ? seq[p] : ' ';
                    slot.fields.forEach(f => {
                        row[f.name] = val;
                    });
                }
                csvData.push(row);
            }
            return csvData;
        }

        const rawSequence = generateSequence();
        if (rawSequence.length === 0) throw new Error(t('preprocess.numbering:day_so_trong_vui_long_kiem_tra_lai'));

        const totalPages = Math.ceil(rawSequence.length / numSlots);
        const csvData: Record<string, string>[] = [];
        
        for (let p = 0; p < totalPages; p++) {
            const row: Record<string, string> = {};
            for (let s = 0; s < numSlots; s++) {
                let indexInSequence = 0;
                if (applyStyle === 'linear') {
                    indexInSequence = p * numSlots + s;
                } else {
                    indexInSequence = s * totalPages + p;
                }
                
                const slotValue = rawSequence[indexInSequence] || '';
                slots[s].fields.forEach((originalField) => {
                    row[originalField.name] = slotValue;
                });
            }
            csvData.push(row);
        }
        
        return csvData;
    }, [vdpFields.length, buildSortedSlots, sequenceMode, fieldConfigs, currentSharedConfig, generateSequence, t, applyStyle]);

    // ─── Đồng bộ Live Preview Vector trực tiếp lên Canvas chính ──────────────
    const [previewIndex, setPreviewIndex] = useState<number>(1);
    const rawSequence = useMemo(() => generateSequence(), [generateSequence]);

    const slotSequenceMap = useMemo(() => {
        const map = new Map<string, string[]>();
        if (sequenceMode === 'per_field') {
            sortedSlots.forEach(slot => {
                const cfg = fieldConfigs[slot.id] || currentSharedConfig;
                map.set(slot.id, computeSequenceFromConfig(cfg));
            });
        }
        return map;
    }, [sequenceMode, sortedSlots, fieldConfigs, currentSharedConfig]);

    const totalPages = useMemo(() => {
        if (sequenceMode === 'per_field') {
            let maxLen = 1;
            slotSequenceMap.forEach(seq => {
                if (seq.length > maxLen) maxLen = seq.length;
            });
            return Math.max(1, maxLen);
        }
        return Math.max(1, Math.ceil((rawSequence.length || 1) / (numSlots || 1)));
    }, [sequenceMode, slotSequenceMap, rawSequence.length, numSlots]);

    // Giá trị các Slots của trang đang xem (previewIndex)
    const currentSlotValues = useMemo(() => {
        if (numSlots === 0) return [];
        const p = Math.max(0, Math.min(totalPages - 1, previewIndex - 1));
        const list: { name: string; value: string }[] = [];

        if (sequenceMode === 'per_field') {
            for (let s = 0; s < numSlots; s++) {
                const slot = sortedSlots[s];
                const seq = slotSequenceMap.get(slot.id) || [];
                const val = seq[p] || '';
                list.push({ name: slot.name, value: val });
            }
            return list;
        }

        if (rawSequence.length === 0) return [];
        for (let s = 0; s < numSlots; s++) {
            const indexInSequence = applyStyle === 'linear' ? (p * numSlots + s) : (s * totalPages + p);
            const val = rawSequence[indexInSequence] || '';
            const slotName = sortedSlots[s]?.name || `Slot ${s + 1}`;
            list.push({ name: slotName, value: val });
        }
        return list;
    }, [numSlots, totalPages, previewIndex, sequenceMode, sortedSlots, slotSequenceMap, rawSequence, applyStyle]);

    // Tự động đẩy dữ liệu sang vdpLivePreview để hiển thị thanh điều hướng trên Canvas
    useEffect(() => {
        if (vdpFields.length === 0) {
            setVdpLivePreview(prev => {
                if (prev.totalRecords === 0 && prev.currentRecord === null) return prev;
                return { ...prev, totalRecords: 0, currentRecord: null };
            });
            return;
        }
        try {
            const matrix = generateDataMatrix();
            if (matrix && matrix.length > 0) {
                const safeIdx = Math.max(1, Math.min(matrix.length, previewIndex));
                setVdpLivePreview(prev => ({
                    ...prev,
                    enabled: true, // Tự động bật xem trước trên Canvas chính
                    totalRecords: matrix.length,
                    recordIndex: safeIdx,
                    currentRecord: matrix[safeIdx - 1] || null,
                    sourceTitle: `Số nhảy: Trang ${safeIdx}/${matrix.length}`,
                }));
            }
        } catch {
            // Đang chỉnh sửa dãy số
        }
    }, [vdpFields, generateDataMatrix, previewIndex, setVdpLivePreview]);

    // Lắng nghe sự kiện chuyển record từ thanh điều hướng Canvas về sidebar
    useEffect(() => {
        const handleIndexChange = (e: Event) => {
            const ce = e as CustomEvent<{ index: number }>;
            const idx = ce.detail?.index;
            if (typeof idx === 'number' && idx >= 1 && idx !== previewIndex) {
                setPreviewIndex(idx);
            }
        };
        window.addEventListener('vdp-preview-index-change', handleIndexChange);
        return () => window.removeEventListener('vdp-preview-index-change', handleIndexChange);
    }, [previewIndex]);

    // Đảm bảo activeConfigSlotId hợp lệ
    useEffect(() => {
        if (sortedSlots.length === 0) return;
        if (!activeConfigSlotId || !sortedSlots.some(s => s.id === activeConfigSlotId)) {
            setActiveConfigSlotId(sortedSlots[0].id);
        }
    }, [sortedSlots, activeConfigSlotId]);

    // Khi người dùng click chọn trường trên canvas, đồng bộ activeConfigSlotId
    useEffect(() => {
        if (sequenceMode !== 'per_field' || selectedFieldIds.length === 0) return;
        const matching = sortedSlots.find(s => s.fields.some(f => selectedFieldIds.includes(f.id)));
        if (matching && matching.id !== activeConfigSlotId) {
            handleSelectSlotConfig(matching.id);
        }
    }, [selectedFieldIds, sequenceMode, sortedSlots, activeConfigSlotId]);

    // Chạy tạo file kết quả PDF
    const handleGenerate = async () => {
        if (slotLengthStats.isMismatch) {
            const confirmMsg = `${t('preprocess.numbering:canh_bao_lech_so_luong')}:\n` +
                slotLengthStats.stats.map(s => `• ${s.name}: ${s.count} số`).join('\n') + 
                `\n\n${t('preprocess.numbering:trang_thieu_se_trong')}\n` +
                t('preprocess.numbering:xac_nhan_chay_lech', { min: slotLengthStats.minCount, max: slotLengthStats.maxCount });
            if (!window.confirm(confirmMsg)) {
                return;
            }
        }
        try {
            setIsGenerating(true);
            setStatusMessage(t('preprocess.numbering:dang_tinh_toan_ma_tran_so'));
            const csvData = generateDataMatrix();
            
            if (!pdfFile) throw new Error(t('preprocess.numbering:chua_co_file_pdf_goc'));
            
            setStatusMessage(t('preprocess.numbering:dang_day_du_lieu_len_may_chu', { n: csvData.length }));
            const templateFile = getWorkingFile ? await getWorkingFile() : pdfFile;

            const fieldsForJob = vdpFields.map(f => {
                const content = f.textContent;
                const hasToken = typeof content === 'string' && content.includes('{') && content.includes('}');
                return {
                    ...f,
                    textContent: hasToken ? content : `{${f.name}}`
                };
            });

            const jobId = await startVdpJobBackend(templateFile, fieldsForJob, csvData, 'vdp.numbering');
            activeVdpJobRef.current = jobId;
            setActiveVdpJobId(jobId);
            
            pollAbortRef.current = new AbortController();
            const result = await pollVdpJob(jobId, (m, info) => { setStatusMessage(m); setProgressInfo(info ?? null); }, true, pollAbortRef.current.signal);
            const blob = result.blob;
            const path = result.path;
            if (!blob) throw new Error(t('preprocess.numbering:khong_nhan_duoc_file_ket_qua_tu_may_chu'));
            const outputBlob = tagArtifactLeaseToken(blob, result.artifactLease);
            const outName = `Numbered_${pdfFile.name}`;
            
            if (spawnNewTab && onSpawnTab) {
                onSpawnTab(outputBlob, outName, path ?? undefined);
                setStatusMessage(t('preprocess.numbering:hoan_thanh_da_tao_tab_pdf_moi'));
            } else if (onApplyResult) {
                await onApplyResult(outputBlob, outName, path ?? undefined);
                setStatusMessage(t('preprocess.numbering:hoan_thanh_da_ghi_de_file_hien_tai'));
            }
        } catch (error: unknown) {
            if (isCanceled(error)) { setStatusMessage(t('preprocess.numbering:da_huy', 'Đã hủy')); return; }
            console.error(error);
            setStatusMessage(formatError(error, t('preprocess.numbering:khong_chay_duoc_vdp', 'Không chạy được VDP')));
        } finally {
            activeVdpJobRef.current = null;
            setActiveVdpJobId(null);
            setProgressInfo(null);
            setIsGenerating(false);
        }
    };

    const selectedField = selectedFieldIds.length > 0 ? vdpFields.find(f => f.id === selectedFieldIds[0]) : null;
    const hasGroupedFields = vdpFields.some(f => Boolean(f.groupId));

    return (
        <div className="flex w-full flex-col gap-3">
            {/* Header */}
            <div className="flex items-center gap-2 pt-1 pb-2.5 border-b border-slate-200 dark:border-zinc-700 shrink-0">
                <div className="flex-1 min-w-0">
                    <h2 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center gap-2">
                        <span>🔢</span>
                        <span>{t('preprocess.numbering:nhay_so_tu_dong', 'Nhảy số tự động')}</span>
                    </h2>
                    <p className="text-[11px] text-slate-500 mt-0.5">Numbering & Ticket Generator</p>
                </div>
                <button
                    type="button"
                    onClick={() => setShowHelp(true)}
                    className="shrink-0 inline-flex items-center gap-1 px-2 py-1 bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-500/10 dark:hover:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 rounded-md font-medium text-xs transition-colors cursor-pointer"
                    title={t('preprocess.numbering:huong_dan_su_dung')}
                >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="9" /><path strokeLinecap="round" strokeLinejoin="round" d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5v.2" /><path strokeLinecap="round" d="M12 16.5h.01" /></svg>
                    <span>Trợ giúp</span>
                </button>
            </div>

            {/* Modal Trợ giúp */}
            {showHelp && (
                <div
                    className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
                    onClick={() => setShowHelp(false)}
                >
                    <div
                        className="max-w-2xl w-full max-h-[85vh] flex flex-col bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-zinc-700 overflow-hidden"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800/80 shrink-0">
                            <div className="flex items-center gap-2.5">
                                <span className="text-xl">🔢</span>
                                <div>
                                    <h3 className="text-sm font-bold text-slate-800 dark:text-zinc-100">
                                        {t('preprocess.numbering:huong_dan_nhay_so', 'Hướng dẫn Nhảy số tự động')}
                                    </h3>
                                    <p className="text-[11px] text-slate-500 dark:text-zinc-400">
                                        Cẩm nang thao tác nhanh, quy cách thành phẩm & mẹo thợ in
                                    </p>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => setShowHelp(false)}
                                className="text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200 p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-zinc-700 transition-colors"
                            >
                                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>

                        {/* Navigation Tabs */}
                        <div className="flex items-center gap-1 px-5 pt-2.5 border-b border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shrink-0">
                            <button
                                type="button"
                                onClick={() => setHelpTab('hotkeys')}
                                className={`pb-2.5 px-3 text-xs font-semibold border-b-2 transition-colors flex items-center gap-1.5 cursor-pointer ${
                                    helpTab === 'hotkeys'
                                        ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400'
                                        : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-200'
                                }`}
                            >
                                <span>⚡</span>
                                <span>Phím tắt & Chuột (Illustrator)</span>
                            </button>
                            <button
                                type="button"
                                onClick={() => setHelpTab('config')}
                                className={`pb-2.5 px-3 text-xs font-semibold border-b-2 transition-colors flex items-center gap-1.5 cursor-pointer ${
                                    helpTab === 'config'
                                        ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400'
                                        : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-200'
                                }`}
                            >
                                <span>📋</span>
                                <span>Các bước cấu hình</span>
                            </button>
                            <button
                                type="button"
                                onClick={() => setHelpTab('cutstack')}
                                className={`pb-2.5 px-3 text-xs font-semibold border-b-2 transition-colors flex items-center gap-1.5 cursor-pointer ${
                                    helpTab === 'cutstack'
                                        ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 dark:border-indigo-400'
                                        : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-zinc-400 dark:hover:text-zinc-200'
                                }`}
                            >
                                <span>✂️</span>
                                <span>Cắt xén & Đóng cuốn (Quan trọng)</span>
                            </button>
                        </div>

                        {/* Content Area */}
                        <div className="p-5 overflow-y-auto space-y-4 text-xs text-slate-600 dark:text-zinc-300 scroller-thin leading-relaxed">
                            {helpTab === 'hotkeys' && (
                                <div className="space-y-3.5">
                                    <div className="rounded-xl border border-indigo-200 dark:border-indigo-900/50 bg-indigo-50/50 dark:bg-indigo-950/20 p-3.5">
                                        <div className="font-bold text-indigo-900 dark:text-indigo-300 text-[13px] flex items-center gap-2 mb-1.5">
                                            <span>🎯</span>
                                            <span>Nhân bản tức thì tại vị trí chuột (Alt-Drag)</span>
                                        </div>
                                        <p className="text-slate-600 dark:text-zinc-300 mb-2">
                                            Giữ phím <kbd className="px-1.5 py-0.5 text-[11px] font-mono font-bold bg-white dark:bg-zinc-800 border border-slate-300 dark:border-zinc-600 rounded shadow-2xs">Alt</kbd> và nhấp kéo chuột từ một ô số bất kỳ. Bản sao mới sẽ được tạo ngay lập tức dưới mũi tên chuột và bám dính chuyển động chuột chuẩn 100% như Adobe Illustrator.
                                        </p>
                                    </div>

                                    <div className="rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800/40 p-3.5">
                                        <div className="font-bold text-slate-800 dark:text-zinc-100 text-[13px] mb-2.5 flex items-center gap-2">
                                            <span>⌨️</span>
                                            <span>Bảng phím tắt bàn phím</span>
                                        </div>
                                        <div className="grid grid-cols-2 gap-2 text-[11px]">
                                            <div className="p-2 rounded bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 flex items-center justify-between">
                                                <span className="text-slate-700 dark:text-zinc-200 font-medium">Sao chép ô số</span>
                                                <div className="flex gap-1">
                                                    <kbd className="px-1.5 py-0.5 font-mono font-bold bg-slate-100 dark:bg-zinc-800 border border-slate-300 dark:border-zinc-600 rounded shadow-2xs">Ctrl</kbd>
                                                    <kbd className="px-1.5 py-0.5 font-mono font-bold bg-slate-100 dark:bg-zinc-800 border border-slate-300 dark:border-zinc-600 rounded shadow-2xs">C</kbd>
                                                </div>
                                            </div>
                                            <div className="p-2 rounded bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 flex items-center justify-between">
                                                <span className="text-slate-700 dark:text-zinc-200 font-medium">Dán ô số (+5mm)</span>
                                                <div className="flex gap-1">
                                                    <kbd className="px-1.5 py-0.5 font-mono font-bold bg-slate-100 dark:bg-zinc-800 border border-slate-300 dark:border-zinc-600 rounded shadow-2xs">Ctrl</kbd>
                                                    <kbd className="px-1.5 py-0.5 font-mono font-bold bg-slate-100 dark:bg-zinc-800 border border-slate-300 dark:border-zinc-600 rounded shadow-2xs">V</kbd>
                                                </div>
                                            </div>
                                            <div className="p-2 rounded bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 flex items-center justify-between">
                                                <span className="text-slate-700 dark:text-zinc-200 font-medium">Nhân bản tức thì</span>
                                                <div className="flex gap-1">
                                                    <kbd className="px-1.5 py-0.5 font-mono font-bold bg-slate-100 dark:bg-zinc-800 border border-slate-300 dark:border-zinc-600 rounded shadow-2xs">Ctrl</kbd>
                                                    <kbd className="px-1.5 py-0.5 font-mono font-bold bg-slate-100 dark:bg-zinc-800 border border-slate-300 dark:border-zinc-600 rounded shadow-2xs">D</kbd>
                                                </div>
                                            </div>
                                            <div className="p-2 rounded bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 flex items-center justify-between">
                                                <span className="text-slate-700 dark:text-zinc-200 font-medium">Chọn tất cả các ô</span>
                                                <div className="flex gap-1">
                                                    <kbd className="px-1.5 py-0.5 font-mono font-bold bg-slate-100 dark:bg-zinc-800 border border-slate-300 dark:border-zinc-600 rounded shadow-2xs">Ctrl</kbd>
                                                    <kbd className="px-1.5 py-0.5 font-mono font-bold bg-slate-100 dark:bg-zinc-800 border border-slate-300 dark:border-zinc-600 rounded shadow-2xs">A</kbd>
                                                </div>
                                            </div>
                                            <div className="p-2 rounded bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 flex items-center justify-between">
                                                <span className="text-slate-700 dark:text-zinc-200 font-medium">Xóa ô số đang chọn</span>
                                                <kbd className="px-1.5 py-0.5 font-mono font-bold bg-slate-100 dark:bg-zinc-800 border border-slate-300 dark:border-zinc-600 rounded shadow-2xs text-red-600">Delete</kbd>
                                            </div>
                                            <div className="p-2 rounded bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 flex items-center justify-between">
                                                <span className="text-slate-700 dark:text-zinc-200 font-medium">Vi chỉnh vị trí (0.5mm)</span>
                                                <span className="font-mono font-bold text-slate-500">Mũi tên ↑ ↓ ← →</span>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800/40 p-3.5">
                                        <div className="font-bold text-slate-800 dark:text-zinc-100 text-[13px] mb-2 flex items-center gap-2">
                                            <span>📐</span>
                                            <span>Cơ chế kéo co dãn 8 điểm viền (Illustrator Parity)</span>
                                        </div>
                                        <ul className="space-y-1.5 text-[11px] list-disc list-inside text-slate-600 dark:text-zinc-300">
                                            <li><strong className="text-slate-800 dark:text-zinc-100">Kéo thông thường (không giữ phím):</strong> Chỉ thay đổi kích thước khung viền bao quanh để vừa vặn vùng in; cỡ chữ <em>giữ nguyên 100%</em>.</li>
                                            <li><strong className="text-slate-800 dark:text-zinc-100">Giữ phím Ctrl khi kéo:</strong> Cả khung viền và cỡ chữ co dãn đồng thời theo chuyển động chuột.</li>
                                            <li><strong className="text-slate-800 dark:text-zinc-100">Giữ phím Shift khi kéo:</strong> Khóa cố định tỉ lệ khung hình (Aspect Ratio).</li>
                                            <li><strong className="text-slate-800 dark:text-zinc-100">Giữ Ctrl + Shift khi kéo:</strong> Vừa khóa tỉ lệ khung hình, vừa co dãn cỡ chữ theo đúng chuẩn Illustrator.</li>
                                        </ul>
                                    </div>
                                </div>
                            )}

                            {helpTab === 'config' && (
                                <div className="space-y-3.5">
                                    <div className="rounded-xl border border-teal-200 dark:border-teal-900/50 bg-teal-50/50 dark:bg-teal-950/20 p-3.5">
                                        <div className="font-bold text-teal-900 dark:text-teal-300 text-[13px] mb-1 flex items-center gap-2">
                                            <span>🎯</span>
                                            <span>Tự động nhận diện số mẫu (Smart Extract)</span>
                                        </div>
                                        <p className="text-slate-600 dark:text-zinc-300 text-[11px]">
                                            Bấm nút <strong>"Chọn số mẫu"</strong> rồi nhấp trực tiếp vào chuỗi số có sẵn trên thiết kế PDF (ví dụ <code className="px-1 py-0.5 bg-white dark:bg-zinc-800 rounded font-mono text-teal-700 dark:text-teal-400">No. 000125</code>). Phần mềm tự động xác định vị trí, kích thước, font chữ, màu sắc, đồng thời tự tách tiền tố <code className="px-1 py-0.5 bg-white dark:bg-zinc-800 rounded font-mono">No. </code>, số bắt đầu <code className="px-1 py-0.5 bg-white dark:bg-zinc-800 rounded font-mono">125</code> và số chữ số đệm <code className="px-1 py-0.5 bg-white dark:bg-zinc-800 rounded font-mono">6 chữ số</code> mà không cần gõ tay.
                                        </p>
                                    </div>

                                    <div className="rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800/40 p-3.5">
                                        <div className="font-bold text-slate-800 dark:text-zinc-100 text-[13px] mb-1.5 flex items-center gap-2">
                                            <span>🔗</span>
                                            <span>1-Click Gộp cuống và thân vé (Group)</span>
                                        </div>
                                        <p className="text-slate-600 dark:text-zinc-300 text-[11px]">
                                            Đối với các loại vé xe, biên lai có cả phần cuống lưu và thân giao khách: sau khi tạo 2 vị trí số, chỉ cần chọn cả 2 ô rồi bấm <strong>"Nhóm"</strong> (hoặc nút bấm tiện ích <em>"1-click gộp chung cuống & thân vé"</em>). Hai ô sẽ được liên kết và tự động nhận chung một con số giống hệt nhau trên mỗi tờ in.
                                        </p>
                                    </div>

                                    <div className="rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800/40 p-3.5">
                                        <div className="font-bold text-slate-800 dark:text-zinc-100 text-[13px] mb-2 flex items-center gap-2">
                                            <span>⚙️</span>
                                            <span>Hai chế độ sinh số</span>
                                        </div>
                                        <div className="space-y-2 text-[11px]">
                                            <div className="p-2.5 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 rounded-lg">
                                                <strong className="text-slate-800 dark:text-zinc-200 block mb-0.5">1. Dãy số liên tục (1, 2, 3...)</strong>
                                                <span className="text-slate-500 dark:text-zinc-400">Đếm tăng dần từ số Bắt đầu đến Đến số theo bước nhảy (mặc định 1). Hỗ trợ thêm Tiền tố (Prefix), Hậu tố (Suffix) và số lượng số 0 đệm đầu (ví dụ <code className="font-mono text-indigo-600 dark:text-indigo-400">No. 0001</code>).</span>
                                            </div>
                                            <div className="p-2.5 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 rounded-lg">
                                                <strong className="text-slate-800 dark:text-zinc-200 block mb-0.5">2. Theo bộ (A-01, B-01...)</strong>
                                                <span className="text-slate-500 dark:text-zinc-400">Chia nhỏ thành nhiều bộ ký tự, mỗi bộ tự động đếm lại từ đầu (ví dụ A-01 ➔ A-50, B-01 ➔ B-50...). Giao diện cung cấp sẵn các mẫu thông dụng như <code className="font-mono font-bold text-slate-700 dark:text-zinc-300">A-01</code>, <code className="font-mono font-bold text-slate-700 dark:text-zinc-300">A/01</code>, <code className="font-mono font-bold text-slate-700 dark:text-zinc-300">A.01</code>, <code className="font-mono font-bold text-slate-700 dark:text-zinc-300">A 01</code>.</span>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {helpTab === 'cutstack' && (
                                <div className="space-y-3.5">
                                    <div className="rounded-xl border border-amber-300 dark:border-amber-800/80 bg-amber-50 dark:bg-amber-950/25 p-4">
                                        <div className="font-bold text-amber-900 dark:text-amber-300 text-[13px] mb-1.5 flex items-center gap-2">
                                            <span>⚠️</span>
                                            <span>Đóng cuốn (Xén chồng / Cut & Stack) — BẮT BUỘC CHO VÉ XE & BIÊN LAI</span>
                                        </div>
                                        <p className="text-slate-700 dark:text-zinc-200 text-[11px] mb-2 leading-relaxed">
                                            Khi in vé đóng cuốn (ví dụ cuốn 50 vé) mà trên 1 tờ in có nhiều vé (ví dụ 4 vé/tờ):
                                        </p>
                                        <div className="p-3 bg-white dark:bg-zinc-900 border border-amber-200 dark:border-amber-800 rounded-lg text-[11px] space-y-1 mb-2">
                                            <div>• <strong>Tờ 1:</strong> mang số <code className="font-mono text-amber-700 dark:text-amber-400 font-bold">001, 051, 101, 151</code></div>
                                            <div>• <strong>Tờ 2:</strong> mang số <code className="font-mono text-amber-700 dark:text-amber-400 font-bold">002, 052, 102, 152</code></div>
                                            <div>• <strong>Tờ 50:</strong> mang số <code className="font-mono text-amber-700 dark:text-amber-400 font-bold">050, 100, 150, 200</code></div>
                                        </div>
                                        <p className="text-amber-900 dark:text-amber-300 text-[11px] font-semibold">
                                            💡 Lợi ích vượt trội: Sau khi in xong toàn bộ cọc giấy, đưa thẳng vào máy xén để xén rời thành 4 cọc nhỏ. Chồng cọc này lên cọc kia là có ngay dãy số liên tục từ 1 đến 200 mà KHÔNG CẦN CÔNG NHÂN PHẢI NHẶT TAY!
                                        </p>
                                    </div>

                                    <div className="rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800/40 p-3.5">
                                        <div className="font-bold text-slate-800 dark:text-zinc-100 text-[13px] mb-1 flex items-center gap-2">
                                            <span>🏷️</span>
                                            <span>Nhãn dán / Tem rời (Tuyến tính / Linear)</span>
                                        </div>
                                        <p className="text-slate-600 dark:text-zinc-300 text-[11px]">
                                            Số nhảy lần lượt từ trái sang phải, trên xuống dưới ngay trên từng tờ in (Tờ 1 mang số <code className="font-mono">1, 2, 3, 4</code>; Tờ 2 mang số <code className="font-mono">5, 6, 7, 8</code>). Dành riêng cho tem nhãn decal, sticker bóc dùng trực tiếp theo từng tờ in.
                                        </p>
                                    </div>

                                    <div className="rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800/40 p-3.5">
                                        <div className="font-bold text-slate-800 dark:text-zinc-100 text-[13px] mb-2 flex items-center gap-2">
                                            <span>🧭</span>
                                            <span>Hướng nhảy số trên trang</span>
                                        </div>
                                        <div className="grid grid-cols-2 gap-2 text-[11px]">
                                            <div className="p-2 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 rounded-lg">
                                                <strong className="block text-slate-700 dark:text-zinc-200">Quét theo hàng (Z)</strong>
                                                <span className="text-slate-500">Chạy ngang hàng trên từ trái qua phải, rồi xuống hàng dưới.</span>
                                            </div>
                                            <div className="p-2 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 rounded-lg">
                                                <strong className="block text-slate-700 dark:text-zinc-200">Quét theo cột (N)</strong>
                                                <span className="text-slate-500">Chạy dọc cột trái từ trên xuống dưới, rồi sang cột kế tiếp.</span>
                                            </div>
                                            <div className="p-2 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 rounded-lg">
                                                <strong className="block text-slate-700 dark:text-zinc-200">Rắn bò (U-Shape)</strong>
                                                <span className="text-slate-500">Chạy lượn vòng ziczac (hàng trên sang phải, hàng dưới quay về trái).</span>
                                            </div>
                                            <div className="p-2 bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 rounded-lg">
                                                <strong className="block text-slate-700 dark:text-zinc-200">Chiều kim đồng hồ</strong>
                                                <span className="text-slate-500">Chạy vòng tròn khép kín quanh các vị trí trên trang in.</span>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Footer */}
                        <div className="px-5 py-3 border-t border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800/80 flex items-center justify-between shrink-0">
                            <span className="text-[11px] text-slate-400">
                                Nhấn <kbd className="px-1 py-0.5 text-[10px] font-mono bg-white dark:bg-zinc-800 border border-slate-300 dark:border-zinc-600 rounded">ESC</kbd> để đóng
                            </span>
                            <button
                                type="button"
                                onClick={() => setShowHelp(false)}
                                className="text-[12px] px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-semibold transition-colors shadow-sm cursor-pointer"
                            >
                                {t('preprocess.numbering:da_hieu', 'Đã hiểu')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── BƯỚC 1: VỊ TRÍ NHẢY SỐ TRÊN TRANG ── */}
            <VdpSection
                step="1"
                title={t('preprocess.numbering:1_chi_dinh_vi_tri', 'Vị trí nhảy số')}
                defaultOpen={true}
                badge={
                    vdpFields.length > 0 ? (
                        <span className="text-[11px] font-bold text-indigo-700 dark:text-indigo-300 bg-indigo-100 dark:bg-indigo-900/50 px-2 py-0.5 rounded-full">
                            {vdpFields.length} vị trí {hasGroupedFields ? '· Đã nhóm' : ''}
                        </span>
                    ) : undefined
                }
            >
                {/* Hai nút hành động: Chọn số mẫu & Kéo thả vị trí */}
                <div className="grid grid-cols-2 gap-2">
                    <button
                        type="button"
                        onClick={() => {
                            const next = !isPickingVdpText;
                            setIsPickingVdpText(next);

                        }}
                        className={`p-2.5 rounded-lg border text-xs font-semibold flex items-center justify-center gap-2 transition-all shadow-sm ${
                            isPickingVdpText
                                ? 'bg-teal-600 text-white border-teal-700 ring-2 ring-teal-400 ring-offset-1 shadow-teal-500/20 shadow-md'
                                : 'bg-teal-50 hover:bg-teal-100 dark:bg-teal-950/40 dark:hover:bg-teal-900/50 text-teal-700 dark:text-teal-300 border-teal-300 dark:border-teal-700'
                        }`}
                        title={isPickingVdpText ? t('Hoàn tất chọn số mẫu (phím Esc)') : t('preprocess.numbering:chon_so_mau_btn')}
                    >
                        {isPickingVdpText ? (
                            <svg className="w-4 h-4 shrink-0 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                        ) : (
                            <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                            </svg>
                        )}
                        <span className="truncate">{isPickingVdpText ? t('✓ Xong chọn số mẫu') : t('preprocess.numbering:chon_so_mau_btn', 'Chọn số mẫu')}</span>
                    </button>

                    <div 
                        onPointerDown={(e) => startVdpDrag(e, 'text', t('preprocess.numbering:vi_tri_nhay_so_slot'))}
                        className="bg-indigo-50 border border-indigo-200 dark:bg-indigo-900/20 dark:border-indigo-800 p-2.5 rounded-lg cursor-grab active:cursor-grabbing hover:border-indigo-400 flex items-center justify-center gap-2 transition-colors shadow-sm select-none"
                        title={t('preprocess.numbering:keo_vi_tri_btn')}
                    >
                        <svg className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" /></svg>
                        <span className="text-xs font-bold text-indigo-700 dark:text-indigo-300 truncate">{t('preprocess.numbering:keo_vi_tri_btn', 'Kéo vị trí')}</span>
                    </div>
                </div>

                {/* Danh sách Slots & Thao tác gộp nhóm (Cuống & Thân vé) */}
                {vdpFields.length === 0 ? (
                    <div className="text-[11px] text-slate-400 dark:text-zinc-500 bg-slate-50 dark:bg-zinc-800/40 p-2.5 rounded border border-dashed border-slate-200 dark:border-zinc-700 flex items-center gap-2">
                        <svg className="w-4 h-4 shrink-0 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        <span>{t('preprocess.numbering:chua_co_slot_hint', 'Bấm "Chọn số mẫu" hoặc kéo nút bên phải vào trang PDF')}</span>
                    </div>
                ) : (
                    <div className="space-y-2">
                        {/* Nút hỗ trợ nhanh Gộp cùng số seri (cuống & thân vé) */}
                        {vdpFields.length >= 2 && (
                            <div className="flex items-center gap-2">
                                {hasGroupedFields ? (
                                    <button
                                        type="button"
                                        onClick={handleQuickUngroupAll}
                                        className="flex-1 py-1 px-2 bg-slate-100 hover:bg-slate-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-slate-700 dark:text-zinc-300 rounded text-[11px] font-medium transition-colors flex items-center justify-center gap-1"
                                    >
                                        ✂️ {t('preprocess.numbering:tach_rieng_tat_ca', 'Tách thành các số độc lập')}
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={handleQuickGroupAll}
                                        className="flex-1 py-1 px-2 bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 rounded text-[11px] font-semibold transition-colors flex items-center justify-center gap-1"
                                        title="Dành cho vé có cuống và thân vé cùng mang 1 số seri"
                                    >
                                        🔗 {t('preprocess.numbering:gop_cung_so_ve', 'Gộp chung số (Cuống & Thân vé)')}
                                    </button>
                                )}
                            </div>
                        )}

                        <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto p-1.5 bg-slate-50 dark:bg-zinc-800/40 rounded border border-slate-200 dark:border-zinc-700">
                            {vdpFields.map((f, idx) => {
                                const isSelected = selectedFieldIds.includes(f.id);
                                return (
                                    <button
                                        key={f.id}
                                        type="button"
                                        onClick={() => onSelectField?.([f.id])}
                                        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-medium transition-all ${
                                            isSelected 
                                                ? 'bg-indigo-600 text-white shadow-xs' 
                                                : 'bg-white dark:bg-zinc-700 text-slate-700 dark:text-zinc-200 hover:bg-slate-100 border border-slate-200 dark:border-zinc-600'
                                        }`}
                                    >
                                        <span className={`w-1.5 h-1.5 rounded-full ${f.groupId ? 'bg-amber-400' : 'bg-teal-400'} shrink-0`} />
                                        <span>{f.name || `Slot ${idx + 1}`}</span>
                                        {f.groupId && <span className="text-[9px] opacity-80">(Liên kết)</span>}
                                        <span className="text-[9px] opacity-60">({Math.round(f.x ?? 0)}, {Math.round(f.y ?? 0)})</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}
            </VdpSection>

            {/* ── BƯỚC 2: CẤU HÌNH DẢI SỐ ── */}
            <VdpSection
                step="2"
                title={t('preprocess.numbering:2_cau_hinh_day_so', 'Cấu hình dải số')}
                defaultOpen={true}
                badge={
                    <span className="text-[11px] font-semibold text-slate-600 dark:text-zinc-400">
                        {genMethod === 'range' ? `${prefix}${padZero ? String(startNum).padStart(padLength, '0') : startNum}${suffix} → ${endNum}` : `${setTotal} bộ x ${seqTotal} số`}
                    </span>
                }
            >
                {/* Thông báo liên kết với Mẹc Bìa */}
                {jobLinked && (
                    <div className="flex items-center gap-1.5 p-2 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 rounded-md text-[11px] text-emerald-800 dark:text-emerald-300">
                        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                        <span className="font-semibold">Đang liên kết dải số ruột với Mẹc Bìa</span>
                    </div>
                )}

                {/* Chọn kiểu số và tùy chọn riêng từng ô (nếu có từ 2 ô trở lên) */}
                <div className="flex items-center justify-between gap-2 pb-1">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-zinc-300">
                        <span className="text-[11px] text-slate-500 font-normal">Kiểu số:</span>
                        <select
                            value={genMethod}
                            onChange={(e) => setGenMethod(e.target.value as 'range' | 'set')}
                            className="h-7 px-2 text-xs font-bold border border-slate-300 dark:border-zinc-600 rounded bg-white dark:bg-zinc-800 text-indigo-600 dark:text-indigo-400 focus:outline-none cursor-pointer"
                        >
                            <option value="range">Dãy số liên tục (1, 2, 3...)</option>
                            <option value="set">Theo bộ chữ &amp; số (A-01, B-01...)</option>
                        </select>
                    </div>

                    {vdpFields.length >= 2 && (
                        <button
                            type="button"
                            onClick={() => setSequenceMode(m => m === 'shared' ? 'per_field' : 'shared')}
                            className={`text-[11px] font-semibold px-2 py-1 rounded transition-colors flex items-center gap-1 cursor-pointer ${
                                sequenceMode === 'per_field'
                                    ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-300'
                                    : 'text-indigo-600 dark:text-indigo-400 hover:bg-slate-100 dark:hover:bg-zinc-800'
                            }`}
                            title="Bật khi muốn các ô số trên trang chạy các dải số khác nhau (ví dụ: Ô 1 là Số vé, Ô 2 là Số ghế)"
                        >
                            {sequenceMode === 'per_field' ? '✓ Đang chia dải số riêng' : '⚙️ Dải số riêng từng ô'}
                        </button>
                    )}
                </div>

                {/* Per-Field Slot Selector & Copy action (chỉ hiện khi người dùng chủ động chọn Dải số riêng từng ô) */}
                {sequenceMode === 'per_field' && sortedSlots.length > 0 && (
                    <div className="p-2 bg-indigo-50/60 dark:bg-indigo-950/30 rounded-lg border border-indigo-200 dark:border-indigo-800/60 space-y-1.5">
                        <div className="flex items-center justify-between text-[11px]">
                            <span className="font-semibold text-slate-700 dark:text-zinc-300">
                                {t('preprocess.numbering:dang_cau_hinh_cho')}{' '}
                                <span className="font-bold text-indigo-600 dark:text-indigo-400">
                                    {sortedSlots.find(s => s.id === activeConfigSlotId)?.name || sortedSlots[0]?.name}
                                </span>
                            </span>
                            <button
                                type="button"
                                onClick={handleCopyConfigToAllSlots}
                                className="text-[10px] text-indigo-600 dark:text-indigo-400 hover:underline font-semibold flex items-center gap-1 cursor-pointer"
                                title={t('preprocess.numbering:sao_chep_cho_tat_ca')}
                            >
                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" /></svg>
                                <span>{t('preprocess.numbering:sao_chep_cho_tat_ca')}</span>
                            </button>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                            {sortedSlots.map((slot) => {
                                const isCurrent = slot.id === (activeConfigSlotId || sortedSlots[0]?.id);
                                const cfg = fieldConfigs[slot.id] || currentSharedConfig;
                                const sample = cfg.prefix + (cfg.padZero ? String(cfg.startNum).padStart(cfg.padLength, '0') : String(cfg.startNum)) + cfg.suffix;
                                return (
                                    <button
                                        key={slot.id}
                                        type="button"
                                        onClick={() => handleSelectSlotConfig(slot.id)}
                                        className={`px-2 py-1 rounded text-[11px] font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
                                            isCurrent
                                                ? 'bg-indigo-600 text-white shadow-xs'
                                                : 'bg-white dark:bg-zinc-800 text-slate-700 dark:text-zinc-300 border border-slate-200 dark:border-zinc-700 hover:border-indigo-300'
                                        }`}
                                    >
                                        <span>{slot.name}</span>
                                        <span className={`text-[10px] px-1 rounded font-mono ${isCurrent ? 'bg-indigo-700 text-indigo-100' : 'bg-slate-100 dark:bg-zinc-700 text-slate-500'}`}>
                                            {sample}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* Warning Banner in Step 2 when slot lengths mismatch */}
                {slotLengthStats.isMismatch && (
                    <div className="p-2.5 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50/90 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200 space-y-2 text-xs shadow-xs">
                        <div className="flex items-start gap-2">
                            <svg className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                            </svg>
                            <div className="flex-1 min-w-0">
                                <div className="font-bold text-[12px] text-amber-800 dark:text-amber-300">
                                    {t('preprocess.numbering:canh_bao_lech_so_luong', 'Lệch số lượng giữa các trường')}
                                </div>
                                <div className="flex flex-wrap gap-1.5 mt-1.5 font-mono text-[10px]">
                                    {slotLengthStats.stats.map(s => (
                                        <span key={s.id} className={`px-1.5 py-0.5 rounded ${s.count === slotLengthStats.maxCount ? 'bg-amber-200/80 dark:bg-amber-900/60 font-bold' : 'bg-white dark:bg-zinc-800 border border-amber-200 dark:border-amber-800'}`}>
                                            {s.name}: <b>{s.count} số</b>
                                        </span>
                                    ))}
                                </div>
                            </div>
                        </div>
                        <div className="flex items-center gap-2 pt-1 border-t border-amber-200/70 dark:border-amber-800/50">
                            <button
                                type="button"
                                onClick={handleSyncToMaxCount}
                                className="flex-1 py-1 px-2 text-[10px] font-bold bg-amber-600 hover:bg-amber-700 text-white rounded shadow-xs transition-colors cursor-pointer"
                            >
                                ⚡ Đồng bộ lớn nhất ({slotLengthStats.maxCount})
                            </button>
                            <button
                                type="button"
                                onClick={handleSyncToMinCount}
                                className="py-1 px-2 text-[10px] font-medium bg-white dark:bg-zinc-800 hover:bg-amber-100 text-amber-800 rounded shadow-xs transition-colors cursor-pointer border border-amber-300"
                            >
                                ✂️ Cắt ngắn ({slotLengthStats.minCount})
                            </button>
                        </div>
                    </div>
                )}

                <div className="p-3 border border-slate-200 dark:border-zinc-700 rounded-lg space-y-3 bg-slate-50/50 dark:bg-zinc-800/20">
                    {genMethod === 'range' ? (
                        <div className="space-y-3">
                            {/* Smart Extract */}
                            <div className="flex flex-col gap-1 pb-3 border-b border-slate-200 dark:border-zinc-700">
                                <label className="text-[10px] font-bold text-indigo-600 dark:text-indigo-400 uppercase">
                                    {t('preprocess.numbering:trich_xuat_tu_dong_smart_extract', 'Trích xuất tự động từ chuỗi mẫu')}
                                </label>
                                <input 
                                    type="text" 
                                    placeholder={t('preprocess.numbering:vi_du_no_00123_vip', 'Ví dụ: No. 00123-VIP')}
                                    className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded bg-white dark:bg-zinc-900"
                                    onChange={(e) => {
                                        const val = e.target.value;
                                        const match = val.match(/^(.*?)(\d+)(\D*)$/);
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
                                <span className="text-[9px] text-slate-500">{t('preprocess.numbering:nhap_chuoi_mau_phan_mem_se_tu_tach_tien')}</span>
                            </div>

                            <div className="grid grid-cols-3 gap-2">
                                <div className="flex flex-col gap-1">
                                    <label className="text-[10px] font-medium text-slate-500">{t('preprocess.numbering:bat_dau_tu', 'Bắt đầu từ')}</label>
                                    <input type="number" value={startNum} onChange={e => setStartNum(Number(e.target.value))} className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-[10px] font-medium text-slate-500">{t('preprocess.numbering:den_so', 'Đến số')}</label>
                                    <input type="number" value={endNum} onChange={e => setEndNum(Number(e.target.value))} className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-[10px] font-medium text-slate-500">{t('preprocess.numbering:buoc_nhay', 'Bước nhảy')}</label>
                                    <input type="number" min={1} value={increment} onChange={e => setIncrement(Number(e.target.value))} className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            <div className="grid grid-cols-2 gap-2">
                                <div className="flex flex-col gap-1">
                                    <label className="text-[10px] font-medium text-slate-500">{t('preprocess.numbering:so_luong_bo', 'Số lượng bộ')}</label>
                                    <input type="number" value={setTotal} onChange={e => setSetTotal(Number(e.target.value))} className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-[10px] font-medium text-slate-500">{t('preprocess.numbering:bo_bat_dau_ky_tu_so', 'Ký tự bộ (A, B, C...)')}</label>
                                    <input type="text" value={setStartStr} onChange={e => setSetStartStr(e.target.value)} className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-[10px] font-medium text-slate-500">{t('preprocess.numbering:so_luong_ve_bo', 'Số vé mỗi bộ')}</label>
                                    <input type="number" value={seqTotal} onChange={e => setSeqTotal(Number(e.target.value))} className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-[10px] font-medium text-slate-500">{t('preprocess.numbering:bat_dau_tu_so', 'Bắt đầu từ số')}</label>
                                    <input type="number" value={seqStart} onChange={e => setSeqStart(Number(e.target.value))} className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                                </div>
                            </div>
                            <div className="flex flex-col gap-1.5">
                                <label className="text-[10px] font-medium text-slate-500">{t('preprocess.numbering:kieu_ghep_bo_so', 'Định dạng ghép bộ & số')}</label>
                                <select
                                    value={isCustomFormat || !SET_FORMAT_PRESETS.some(p => p.value === formatTemplate && p.value !== '__custom__') ? '__custom__' : formatTemplate}
                                    onChange={(e) => {
                                        const val = e.target.value;
                                        if (val === '__custom__') {
                                            setIsCustomFormat(true);
                                        } else {
                                            setIsCustomFormat(false);
                                            setFormatTemplate(val);
                                        }
                                    }}
                                    className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded bg-white dark:bg-zinc-800 text-slate-800 dark:text-zinc-200 font-medium"
                                >
                                    {SET_FORMAT_PRESETS.map(p => (
                                        <option key={p.value} value={p.value}>{p.label}</option>
                                    ))}
                                </select>
                                {(isCustomFormat || !SET_FORMAT_PRESETS.some(p => p.value === formatTemplate && p.value !== '__custom__')) && (
                                    <div className="space-y-1 pt-1">
                                        <input
                                            type="text"
                                            value={formatTemplate}
                                            onChange={e => setFormatTemplate(e.target.value)}
                                            placeholder="{%b}-{%t}"
                                            className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded font-mono"
                                        />
                                        <span className="text-[9px] text-slate-400">
                                            {t('preprocess.numbering:dung_b_cho_bo_va_t_cho_stt', { b: '{%b}', t: '{%t}' })}
                                        </span>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                    
                    {/* Tiền tố, Hậu tố & Đệm số 0 */}
                    <div className="border-t border-slate-200 dark:border-zinc-700 pt-3 grid grid-cols-2 gap-2">
                        <div className="flex flex-col gap-1">
                            <label className="text-[10px] font-medium text-slate-500">{t('preprocess.numbering:tien_to', 'Tiền tố')}</label>
                            <input type="text" value={prefix} onChange={e => setPrefix(e.target.value)} placeholder="VD: No." className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="text-[10px] font-medium text-slate-500">{t('preprocess.numbering:hau_to', 'Hậu tố')}</label>
                            <input type="text" value={suffix} onChange={e => setSuffix(e.target.value)} className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                        </div>
                        <div className="flex flex-col gap-1 col-span-2">
                            <div className="flex items-center gap-2 mb-1">
                                <input type="checkbox" checked={padZero} onChange={e => setPadZero(e.target.checked)} id="padZero" />
                                <label htmlFor="padZero" className="text-[11px] font-medium text-slate-600 dark:text-zinc-300 cursor-pointer">{t('preprocess.numbering:dem_so_0_vao_dau', 'Đệm số 0 vào đầu (001, 002...)')}</label>
                            </div>
                            {padZero && (
                                <div className="flex items-center gap-2">
                                    <span className="text-[10px] text-slate-500">{t('preprocess.numbering:chieu_dai_co_dinh', 'Chiều dài cố định:')}</span>
                                    <input type="number" min={1} value={padLength} onChange={e => setPadLength(Number(e.target.value))} className="w-16 h-7 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                                </div>
                            )}
                            <div className="flex items-center gap-2 mt-1">
                                <input type="checkbox" checked={isShuffle} onChange={e => setIsShuffle(e.target.checked)} id="isShuffle" />
                                <label htmlFor="isShuffle" className="text-[11px] font-medium text-slate-600 dark:text-zinc-300 cursor-pointer">{t('preprocess.numbering:xao_tron_ngau_nhien_lam_ve_boc_tham', 'Xáo trộn ngẫu nhiên (Làm vé bốc thăm)')}</label>
                            </div>
                        </div>
                    </div>

                    {/* Mẫu số xem trước trực quan */}
                    <div className="border-t border-slate-200 dark:border-zinc-700/80 pt-2.5 flex items-center justify-between text-xs bg-indigo-50/50 dark:bg-indigo-950/20 -mx-3 -mb-3 px-3 py-2 rounded-b-lg">
                        <span className="text-[11px] text-slate-500 dark:text-zinc-400 font-medium flex items-center gap-1">
                            <span>🔍</span> {t('preprocess.numbering:mau_so_tao_ra', 'Mẫu số:')}
                        </span>
                        <span className="font-mono text-xs font-semibold text-indigo-600 dark:text-indigo-400 truncate max-w-[210px]" title={rawSequence.slice(0, 5).join(', ')}>
                            {rawSequence.length > 0 
                                ? `${rawSequence.slice(0, 3).join(', ')}${rawSequence.length > 3 ? ', ...' : ''}`
                                : t('preprocess.numbering:day_so_trong', 'Dãy số trống')}
                        </span>
                    </div>
                </div>
            </VdpSection>

            {/* ── BƯỚC 3: QUY CÁCH THÀNH PHẨM ── */}
            <VdpSection
                step="3"
                title={t('preprocess.numbering:3_cach_ra_thanh_pham', 'Quy cách thành phẩm')}
                defaultOpen={true}
                badge={
                    <span className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400">
                        {applyStyle === 'stack' ? 'Đóng cuốn (Stack)' : 'Tem rời (Linear)'}
                    </span>
                }
            >
                <div className="grid grid-cols-2 gap-2">
                    {/* Card 1: Cut & Stack (Đóng cuốn xén chồng) */}
                    <button
                        type="button"
                        onClick={() => setApplyStyle('stack')}
                        className={`p-2.5 rounded-lg border text-left transition-all relative flex flex-col justify-between ${
                            applyStyle === 'stack'
                                ? 'border-indigo-600 bg-indigo-50/70 dark:bg-indigo-950/40 ring-2 ring-indigo-500/30'
                                : 'border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 hover:border-slate-300 dark:hover:border-zinc-600'
                        }`}
                    >
                        <div>
                            <div className="flex items-center gap-1.5 mb-1">
                                <span className="text-base">📚</span>
                                <span className="text-xs font-bold text-slate-800 dark:text-zinc-200">
                                    {t('preprocess.numbering:dong_cuon_xen_chong', 'Đóng cuốn xén chồng')}
                                </span>
                            </div>
                            <p className="text-[10px] text-slate-500 dark:text-zinc-400 leading-snug">
                                {t('preprocess.numbering:dong_cuon_desc', 'Cắt xén theo cọc rồi xếp chồng')}
                            </p>
                        </div>
                        {applyStyle === 'stack' && (
                            <div className="mt-2 text-[10px] font-bold text-indigo-600 dark:text-indigo-400 flex items-center gap-1">
                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                                <span>{t('Đang chọn')}</span>
                            </div>
                        )}
                    </button>

                    {/* Card 2: Linear (Tem rời / Nhãn dán) */}
                    <button
                        type="button"
                        onClick={() => setApplyStyle('linear')}
                        className={`p-2.5 rounded-lg border text-left transition-all relative flex flex-col justify-between ${
                            applyStyle === 'linear'
                                ? 'border-indigo-600 bg-indigo-50/70 dark:bg-indigo-950/40 ring-2 ring-indigo-500/30'
                                : 'border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 hover:border-slate-300 dark:hover:border-zinc-600'
                        }`}
                    >
                        <div>
                            <div className="flex items-center gap-1.5 mb-1">
                                <span className="text-base">🏷️</span>
                                <span className="text-xs font-bold text-slate-800 dark:text-zinc-200">
                                    {t('preprocess.numbering:tem_roi_thu_tu', 'Tem rời liên tục')}
                                </span>
                            </div>
                            <p className="text-[10px] text-slate-500 dark:text-zinc-400 leading-snug">
                                {t('preprocess.numbering:tem_roi_desc', 'Nhảy số thứ tự từng con trên tờ in')}
                            </p>
                        </div>
                        {applyStyle === 'linear' && (
                            <div className="mt-2 text-[10px] font-bold text-indigo-600 dark:text-indigo-400 flex items-center gap-1">
                                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                                <span>{t('Đang chọn')}</span>
                            </div>
                        )}
                    </button>
                </div>

                {/* Thứ tự quét trên trang */}
                <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-200 dark:border-zinc-700/60">
                    <label className="text-[11px] font-medium text-slate-600 dark:text-zinc-400 shrink-0">
                        {t('preprocess.numbering:thu_tu_tren_trang', 'Thứ tự trên trang')}
                    </label>
                    <select 
                        value={sortMethod} 
                        onChange={e => setSortMethod(e.target.value as 'rows'|'cols'|'ushape'|'clockwise')}
                        className="h-7 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded bg-white dark:bg-zinc-800 text-slate-700 dark:text-zinc-200"
                    >
                        <option value="rows">{t('preprocess.numbering:quet_theo_hang_z', 'Quét theo hàng (Z)')}</option>
                        <option value="cols">{t('preprocess.numbering:quet_theo_cot_n', 'Quét theo cột (N)')}</option>
                        <option value="ushape">{t('preprocess.numbering:chu_u_u_shape', 'Rắn bò (U-Shape)')}</option>
                        <option value="clockwise">{t('preprocess.numbering:vong_tron_clockwise', 'Theo chiều kim đồng hồ')}</option>
                    </select>
                </div>

                {/* Sơ đồ trực quan */}
                <FinishingPreviewDiagram 
                    applyStyle={applyStyle} 
                    sortMethod={sortMethod}
                    rawSequence={rawSequence}
                    numSlots={numSlots}
                    totalPages={totalPages}
                />
            </VdpSection>

            {/* ── BƯỚC 4: ĐỊNH DẠNG CHỮ & CĂN CHỈNH ── */}
            <VdpSection
                step="4"
                title={t('preprocess.numbering:4_dinh_dang_chu_can_le', 'Định dạng chữ & Căn chỉnh')}
                defaultOpen={selectedFieldIds.length > 0}
                badge={
                    selectedField ? (
                        <span className="text-[10px] font-semibold text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/60 px-2 py-0.5 rounded border border-indigo-200 dark:border-indigo-800">
                            {selectedField.name || 'Slot'} · {selectedField.fontSize || 13}pt
                        </span>
                    ) : undefined
                }
            >
                {selectedFieldIds.length >= 1 ? (
                    <div className="space-y-3">
                        <VdpAlignPanel
                            vdpFields={vdpFields}
                            setVdpFields={setVdpFields}
                            selectedFieldIds={selectedFieldIds}
                            pageDimMm={viewerPageDimMm}
                        />

                        <div className="flex items-center justify-between pt-1 border-t border-slate-200 dark:border-zinc-700">
                            <span className="text-[12px] font-bold text-slate-700 dark:text-zinc-300">
                                {t('preprocess.numbering:dinh_dang', 'Định dạng:')} {selectedFieldIds.length > 1 ? `${selectedFieldIds.length} trường` : selectedField?.name}
                            </span>
                            <div className="flex items-center gap-1.5">
                                {selectedFieldIds.length > 1 && (
                                    <button onClick={handleGroupFields} className="text-[10px] bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 px-2 py-1 rounded text-slate-600 dark:text-zinc-300 font-medium">
                                        {t('preprocess.numbering:group_nhom', 'Nhóm')}
                                    </button>
                                )}
                                {selectedField?.groupId && (
                                    <button onClick={handleUngroupFields} className="text-[10px] bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 px-2 py-1 rounded text-red-500 font-medium">
                                        {t('preprocess.numbering:ungroup_bo_nhom', 'Bỏ nhóm')}
                                    </button>
                                )}
                                <button 
                                    type="button"
                                    onClick={duplicateSelectedFields}
                                    className="text-blue-600 hover:text-blue-700 bg-blue-50 hover:bg-blue-100 dark:bg-blue-500/10 dark:hover:bg-blue-500/20 p-1.5 rounded transition-colors"
                                    title={`${t('preprocess.numbering:nhan_ban', 'Nhân bản')} (Ctrl+D)`}
                                >
                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                    </svg>
                                </button>
                                <button 
                                    type="button"
                                    onClick={deleteSelectedField}
                                    className="text-red-500 hover:text-red-700 bg-red-50 hover:bg-red-100 dark:bg-red-500/10 dark:hover:bg-red-500/20 p-1.5 rounded transition-colors"
                                    title={t('preprocess.numbering:xoa_truong_nay')}
                                >
                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                </button>
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <div className="flex flex-col gap-1 col-span-2">
                                <span className="text-[10px] font-medium text-slate-500 block mb-1">{t('preprocess.numbering:font_chu_font_family')}</span>
                                <FontSelector 
                                    value={selectedField?.fontName || 'Helvetica'}
                                    fontFile={selectedField?.fontFile}
                                    onChange={(fontName, fontFile) => updateSelectedField({ fontName, fontFile })}
                                />
                            </div>
                            <div className="flex flex-col gap-1 col-span-2">
                                <span className="text-[10px] font-medium text-slate-500 block mb-1">{t('preprocess.numbering:net_font_font_style')}</span>
                                <select 
                                    value={selectedField?.fontStyle || 'normal'}
                                    onChange={(e) => updateSelectedField({ fontStyle: e.target.value })}
                                    className="w-full h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-indigo-500 transition-all"
                                >
                                    <option value="normal">Regular</option>
                                    <option value="bold">Bold</option>
                                    <option value="italic">Italic</option>
                                    <option value="bolditalic">Bold Italic</option>
                                </select>
                            </div>
                            
                            <ToolNumberInput 
                                label={t('preprocess.numbering:co_chu', 'Cỡ chữ')}
                                value={selectedField?.fontSize || 13}
                                onChange={(val) => updateSelectedField({ fontSize: val })}
                                suffix="pt" step={1}
                            />
                            <ToolNumberInput 
                                label={t('preprocess.numbering:dong_leading', 'Dòng')}
                                value={selectedField?.lineHeight || 1}
                                onChange={(val) => updateSelectedField({ lineHeight: val })}
                                suffix="em" step={0.1}
                            />
                            <ToolNumberInput 
                                label={t('preprocess.numbering:khoang_cach_tracking', 'Khoảng cách')}
                                value={selectedField?.characterSpacing || 0}
                                onChange={(val) => updateSelectedField({ characterSpacing: val })}
                                suffix="pt" step={0.5}
                            />
                            <div>
                                <span className="text-[11px] font-medium text-slate-500 block mb-1">{t('preprocess.numbering:can_le', 'Căn lề')}</span>
                                <div className="flex items-center gap-1.5">
                                    <select 
                                        value={selectedField?.alignment || 'left'}
                                        onChange={(e) => updateSelectedField({ alignment: e.target.value })}
                                        className="flex-1 min-w-0 h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-indigo-500 transition-all"
                                    >
                                        <option value="left">{t('preprocess.numbering:trai', 'Trái')}</option>
                                        <option value="center">{t('preprocess.numbering:giua', 'Giữa')}</option>
                                        <option value="right">{t('preprocess.numbering:phai', 'Phải')}</option>
                                    </select>
                                </div>
                            </div>
                            <div className="col-span-2">
                                <span className="text-[10px] font-medium text-slate-500 block mb-1">{t('preprocess.numbering:mau_chu', 'Màu in')}</span>
                                <CmykColorPicker
                                    label={t('preprocess.numbering:mau_cmyk', 'Màu CMYK')}
                                    value={selectedField?.fontColor || '#000000'}
                                    onChange={(hex: string) => updateSelectedField({ fontColor: hex })}
                                />
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="text-[11px] text-slate-400 dark:text-zinc-500 p-3 bg-slate-50 dark:bg-zinc-800/40 rounded border border-dashed border-slate-200 dark:border-zinc-700 text-center">
                        {t('preprocess.numbering:nhap_chon_truong_de_dinh_dang', 'Nhấp chọn một trường nhảy số trên bản vẽ để chỉnh Font chữ, Cỡ chữ, Căn lề và Màu in CMYK')}
                    </div>
                )}
            </VdpSection>

            {/* ── THANH TỔNG KẾT LIVE PREVIEW VÀ NÚT CHẠY ── */}
            <div className="mt-auto pt-3 shrink-0 border-t border-slate-200 dark:border-zinc-700 space-y-2.5">
                {/* Chip xem nhanh số nhảy trên trang hiện tại */}
                {currentSlotValues.length > 0 && (
                    <div className="flex flex-col gap-1 p-2 rounded-lg bg-indigo-50/60 dark:bg-indigo-950/30 border border-indigo-200/80 dark:border-indigo-800/60">
                        <div className="flex items-center justify-between text-[11px]">
                            <span className="font-semibold text-indigo-900 dark:text-indigo-300">
                                👁️ {t('preprocess.numbering:trang_hien_tai', 'Số nhảy trang')} {previewIndex}/{totalPages}
                            </span>
                            <span className="text-[10px] text-slate-500 dark:text-zinc-400">
                                {t('preprocess.numbering:xem_truc_tiep_tren_canvas', 'Đang hiển thị trên Canvas')}
                            </span>
                        </div>
                        <div className="flex flex-wrap gap-1.5 pt-0.5">
                            {currentSlotValues.map((sv, idx) => (
                                <div key={idx} className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-white dark:bg-zinc-800 border border-indigo-200 dark:border-indigo-700 text-[11px] shadow-2xs">
                                    <span className="font-semibold text-indigo-700 dark:text-indigo-300">{sv.name}:</span>
                                    <span className="font-mono text-slate-800 dark:text-zinc-100 font-bold">{sv.value}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Tiến độ job và thông báo */}
                {statusMessage && (
                    isGenerating ? (
                        <ProgressBar
                            message={statusMessage}
                            processed={progressInfo?.processed}
                            total={progressInfo?.total}
                            onCancel={activeVdpJobId ? () => void cancelActiveVdp().catch((err) => setStatusMessage(formatError(err))) : undefined}
                            className="mb-2"
                        />
                    ) : (
                        <div className="p-2 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 text-[11px] rounded text-center font-medium">
                            {statusMessage}
                        </div>
                    )
                )}
                
                {/* Mở kết quả tab mới */}
                <div className="flex items-center gap-2 px-1">
                    <input
                        type="checkbox"
                        id="spawnNewTabNum"
                        checked={spawnNewTab}
                        onChange={(e) => setSpawnNewTab(e.target.checked)}
                        className="w-3.5 h-3.5 rounded text-indigo-600 focus:ring-indigo-500 bg-white dark:bg-zinc-900 border-slate-300 dark:border-zinc-600 cursor-pointer"
                    />
                    <label htmlFor="spawnNewTabNum" className="text-[11px] text-slate-600 dark:text-zinc-400 cursor-pointer select-none">
                        {t('preprocess.numbering:mo_ket_qua_sang_tab_moi_thay_vi_de_file')}
                    </label>
                </div>
                
                {/* Nút bấm Chạy */}
                <button
                    onClick={handleGenerate}
                    disabled={isGenerating || vdpFields.length === 0}
                    className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-bold rounded-lg transition-colors flex items-center justify-center gap-2 shadow-sm cursor-pointer"
                >
                    {isGenerating ? (
                        <>
                            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                            {t('preprocess.common:run')}…
                        </>
                    ) : (
                        <>{t('preprocess.common:run')}</>
                    )}
                </button>
                {isGenerating && activeVdpJobId && (
                    <button
                        type="button"
                        onClick={() => void cancelActiveVdp().catch((err) => setStatusMessage(err?.message || String(err)))}
                        className="w-full rounded-lg bg-red-600 py-2 text-sm font-bold text-white hover:bg-red-700 transition-colors"
                    >
                        {t('tabs.imposition:huy_bo_cancel')}
                    </button>
                )}
            </div>
        </div>
    );
}
