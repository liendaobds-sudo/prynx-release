import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { startVdpJobBackend, pollVdpJob, cancelVdpJobBackend, previewVdpRecord, type VdpProgressInfo } from '@/lib/api'; // UIUX (audit 2026-07-27 §D-07)
import { ProgressBar } from '../ui/ProgressBar';
import { toast } from '../ui/Toast'; // UIUX (audit 2026-07-27 §D-07)
import { formatError, isCanceled } from '@/lib/errorMessages'; // UIUX (audit 2026-07-27 §D-15)
import { CmykColorPicker } from './DataMergeTool';
import { ToolNumberInput } from './ToolUI';
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
    for (let i = rawSequence.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rawSequence[i], rawSequence[j]] = [rawSequence[j], rawSequence[i]];
    }
  }
  return rawSequence;
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
    const [statusMessage, setStatusMessage] = useState("");
    const [isGenerating, setIsGenerating] = useState(false);
    // UIUX (audit 2026-07-27 §D-07): tiến độ job VDP ({processed,total}) cho ProgressBar
    const [progressInfo, setProgressInfo] = useState<VdpProgressInfo | null>(null);
    const [spawnNewTab, setSpawnNewTab] = useState(true);
    const [showHelp, setShowHelp] = useState(false);

    // Hủy polling VDP khi unmount để không poll vô hạn nền (#13).
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

    // Đóng modal trợ giúp bằng phím ESC (chỉ gắn listener khi modal đang mở).
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
    } = useVdpTool(vdpFields, setVdpFields, selectedFieldIds, onSelectField, isActive);

    // Sync vdpFields names to "Slot 1", "Slot 2" automatically
    useEffect(() => {
        if (!setVdpFields || vdpFields.length === 0) return;
        let needsUpdate = false;
        const seen = new Set<string>();
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
    }, [vdpFields.length]);

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
                    // Dùng ký tự khoảng trắng ' ' cho trang bị thiếu số để không in lỗi MISSING đỏ lên bản in
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
            // Tuân thủ kết quả cuối cùng: dùng file đã áp dụng sửa đổi trang làm template.
            const templateFile = getWorkingFile ? await getWorkingFile() : pdfFile;

            // Đảm bảo tất cả các field gửi lên backend đều có textContent chứa token {fieldName}
            // để vdp_engine thực sự thay thế đúng số nhảy từ ma trận csvData
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
            // UIUX (audit 2026-07-27 §D-07): lưu thêm {processed,total} vào state cho ProgressBar
            const result = await pollVdpJob(jobId, (m, info) => { setStatusMessage(m); setProgressInfo(info ?? null); }, true, pollAbortRef.current.signal);
            const blob = result.blob;
            const path = result.path;
            if (!blob) throw new Error(t('preprocess.numbering:khong_nhan_duoc_file_ket_qua_tu_may_chu'));
            // LIFECYCLE (audit 2026-08-25 §REV.11): callback luôn nhận artifact kèm lease backend.
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
            // UIUX (audit 2026-07-27 §D-15): hủy → báo nhẹ; lỗi khác → câu Việt + hướng khắc phục
            if (isCanceled(error)) { setStatusMessage(t('preprocess.numbering:da_huy', 'Đã hủy')); return; }
            console.error(error);
            setStatusMessage(formatError(error, t('preprocess.numbering:khong_chay_duoc_vdp', 'Không chạy được VDP'))); // UIUX (audit 2026-07-27 §D-15)
        } finally {
            activeVdpJobRef.current = null;
            setActiveVdpJobId(null);
            setProgressInfo(null); // UIUX (audit 2026-07-27 §D-07)
            setIsGenerating(false);
        }
    };

    // ─── Xem trước trực quan (Visual Live Preview) chuẩn VDP ──────────────────
    const [previewIndex, setPreviewIndex] = useState<number>(1);
    const [previewImg, setPreviewImg] = useState<string | null>(null);
    const [previewLoading, setPreviewLoading] = useState<boolean>(false);
    const [previewMsg, setPreviewMsg] = useState<string>('');
    const [showSummaryText, setShowSummaryText] = useState<boolean>(false);
    const previewAbortRef = useRef<AbortController | null>(null);

    // Huỷ request preview khi unmount
    useEffect(() => () => { previewAbortRef.current?.abort(); }, []);

    const rawSequence = useMemo(() => generateSequence(), [generateSequence]);

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

    // Gọi /vdp/preview để kết xuất ảnh bản in thực tế có số nhảy
    const runPreview = useCallback(async (targetIndex: number) => {
        if (vdpFields.length === 0) {
            setPreviewImg(null);
            setPreviewMsg(t('preprocess.numbering:keo_tha_it_nhat_1_slot_len_man_hinh_de'));
            return;
        }

        let csvData: Record<string, string>[];
        try {
            csvData = generateDataMatrix();
        } catch {
            setPreviewImg(null);
            return;
        }

        if (csvData.length === 0) {
            setPreviewImg(null);
            return;
        }

        const templateFile = getWorkingFile ? await getWorkingFile() : pdfFile;
        if (!templateFile) return;

        const pIdx = Math.max(0, Math.min(csvData.length - 1, targetIndex - 1));
        const row = csvData[pIdx] || {};

        const fieldsForJob = vdpFields.map(f => {
            const content = f.textContent;
            const hasToken = typeof content === 'string' && content.includes('{') && content.includes('}');
            return {
                ...f,
                textContent: hasToken ? content : `{${f.name}}`
            };
        });

        previewAbortRef.current?.abort();
        const ac = new AbortController();
        previewAbortRef.current = ac;

        setPreviewLoading(true);
        setPreviewMsg('');
        try {
            const result = await previewVdpRecord({
                fields: fieldsForJob,
                requestedIndex: 1,
                template: templateFile,
                rows: [row],
                columns: Object.keys(row),
                hasHeader: true,
                signal: ac.signal,
            });
            if (ac.signal.aborted) return;
            if (result.image_png_base64) {
                setPreviewImg(`data:image/png;base64,${result.image_png_base64}`);
                setPreviewMsg('');
            } else {
                setPreviewImg(null);
                setPreviewMsg(result.message || '');
            }
        } catch (err: unknown) {
            if (ac.signal.aborted) return;
            console.error('Lỗi tạo bản xem trước số nhảy:', err);
            setPreviewMsg(formatError(err, 'Không thể tạo bản xem trước'));
        } finally {
            if (!ac.signal.aborted) setPreviewLoading(false);
        }
    }, [vdpFields, generateDataMatrix, getWorkingFile, pdfFile, t]);

    // Tự động kết xuất xem trước khi người dùng đổi trang hoặc sửa cấu hình (debounce 400ms)
    useEffect(() => {
        if (vdpFields.length === 0 || !pdfFile) {
            setPreviewImg(null);
            return;
        }
        const timer = setTimeout(() => {
            void runPreview(previewIndex);
        }, 400);
        return () => clearTimeout(timer);
    }, [
        previewIndex, vdpFields, runPreview, pdfFile, sequenceMode, fieldConfigs,
        startNum, endNum, increment, padZero, padLength, prefix, suffix,
        applyStyle, sortMethod, setStartStr, setTotal, seqTotal, seqStart, formatTemplate
    ]);

    const previewLines = useMemo(() => {
        try {
            if (vdpFields.length === 0) return [t('preprocess.numbering:keo_tha_it_nhat_1_slot_len_man_hinh_de')];
            const maxPreviewPages = Math.min(totalPages, 3);
            const lines: string[] = [];

            if (sequenceMode === 'per_field') {
                for (let p = 0; p < maxPreviewPages; p++) {
                    const items: string[] = [];
                    for (let s = 0; s < numSlots; s++) {
                        const slot = sortedSlots[s];
                        const seq = slotSequenceMap.get(slot.id) || [];
                        items.push(`${slot.name}: ${seq[p] || ''}`);
                    }
                    lines.push(`${t('preprocess.numbering:trang', { n: p + 1 })} ${items.join(' | ')}`);
                }
                return lines;
            }

            if (rawSequence.length === 0) return [t('preprocess.numbering:day_so_trong')];

            for (let p = 0; p < maxPreviewPages; p++) {
                let pageStr = `${t('preprocess.numbering:trang', { n: p + 1 })} `;
                let itemsAdded = 0;
                for (let s = 0; s < numSlots; s++) {
                    const indexInSequence = applyStyle === 'linear' ? (p * numSlots + s) : (s * totalPages + p);
                    if (indexInSequence < rawSequence.length) {
                        pageStr += (itemsAdded > 0 ? ', ' : '') + rawSequence[indexInSequence];
                        itemsAdded++;
                        if (pageStr.length > 50) {
                            pageStr += ', ...';
                            break;
                        }
                    }
                }
                lines.push(pageStr);
            }
            return lines;
        } catch {
            return [];
        }
    }, [vdpFields.length, totalPages, sequenceMode, numSlots, sortedSlots, slotSequenceMap, rawSequence, t, applyStyle]);

    return (
        <div className="flex w-full flex-col gap-4">
            {/* Header */}
            <div className="flex items-center gap-2 pt-2 pb-3 border-b border-slate-200 dark:border-zinc-700 shrink-0">
                <div className="flex-1 min-w-0 text-center">
                    <h2 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center justify-center gap-2">
                        <span>🔢</span>
                        <span>{t('preprocess.numbering:nhay_so_tu_dong')}</span>
                    </h2>
                    <p className="text-[11px] text-slate-500 mt-1">Numbering & Ticket Generator</p>
                </div>
                <button
                    type="button"
                    onClick={() => setShowHelp(true)}
                    className="shrink-0 inline-flex items-center gap-1 px-2 py-1.5 bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-500/10 dark:hover:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 rounded-md font-medium transition-colors cursor-pointer"
                    title={t('preprocess.numbering:huong_dan_su_dung')}
                >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="9" /><path strokeLinecap="round" strokeLinejoin="round" d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5v.2" /><path strokeLinecap="round" d="M12 16.5h.01" /></svg>
                </button>
            </div>

            {showHelp && (
                <div
                    className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4"
                    onClick={() => setShowHelp(false)}
                >
                    <div
                        className="max-w-lg w-full max-h-[80vh] overflow-auto bg-white dark:bg-zinc-900 rounded-xl shadow-2xl border border-slate-200 dark:border-zinc-700"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-zinc-700 sticky top-0 bg-white dark:bg-zinc-900">
                            <span className="text-[14px] font-bold text-slate-800 dark:text-zinc-100">{t('preprocess.numbering:huong_dan_nhay_so')}</span>
                            <button
                                type="button"
                                onClick={() => setShowHelp(false)}
                                className="text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200 p-1 rounded hover:bg-slate-100 dark:hover:bg-zinc-800 transition-colors"
                            >
                                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>
                        <div className="p-4 space-y-3 text-[12px] text-slate-600 dark:text-zinc-300">
                            <div className="rounded-lg border border-slate-200 dark:border-zinc-700 p-3 bg-slate-50 dark:bg-zinc-800/60">
                                <div className="font-bold text-slate-700 dark:text-zinc-200 mb-1">{t('preprocess.numbering:help_slot_tieu_de')}</div>
                                <div className="text-slate-500 dark:text-zinc-400">{t('preprocess.numbering:help_slot_noi_dung')}</div>
                            </div>

                            <div className="rounded-lg border border-slate-200 dark:border-zinc-700 p-3 bg-slate-50 dark:bg-zinc-800/60">
                                <div className="font-bold text-slate-700 dark:text-zinc-200 mb-1">{t('preprocess.numbering:help_che_do_tieu_de')}</div>
                                <div className="mb-1"><b>{t('preprocess.numbering:day_so_1_2_3')}</b> → {t('preprocess.numbering:help_che_do_range')}</div>
                                <div className="text-slate-500 dark:text-zinc-400"><b>{t('preprocess.numbering:theo_bo_a_01_b_01')}</b> → {t('preprocess.numbering:help_che_do_set')}</div>
                            </div>

                            <div className="rounded-lg border border-slate-200 dark:border-zinc-700 p-3 bg-slate-50 dark:bg-zinc-800/60">
                                <div className="font-bold text-slate-700 dark:text-zinc-200 mb-1">{t('preprocess.numbering:help_sort_tieu_de')}</div>
                                <div className="text-slate-500 dark:text-zinc-400">{t('preprocess.numbering:help_sort_noi_dung')}</div>
                            </div>

                            <div className="rounded-lg border border-amber-200 dark:border-amber-800 p-3 bg-amber-50 dark:bg-amber-900/20">
                                <div className="font-bold text-amber-700 dark:text-amber-300 mb-1">{t('preprocess.numbering:help_phanbo_tieu_de')}</div>
                                <div className="mb-1 text-amber-700/90 dark:text-amber-300/90"><b>{t('preprocess.numbering:theo_thu_tu_linear')}</b> → {t('preprocess.numbering:help_phanbo_linear')}</div>
                                <div className="text-amber-700/90 dark:text-amber-300/90"><b>{t('preprocess.numbering:xep_chong_stacked')}</b> → {t('preprocess.numbering:help_phanbo_stack')}</div>
                            </div>

                            <div className="text-[11px] text-slate-500 dark:text-zinc-400">{t('preprocess.numbering:help_ghi_chu')}</div>
                        </div>
                        <div className="px-4 py-3 border-t border-slate-200 dark:border-zinc-700 text-right">
                            <button
                                type="button"
                                onClick={() => setShowHelp(false)}
                                className="text-[12px] px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded font-medium transition-colors"
                            >
                                {t('preprocess.numbering:da_hieu')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Step 1: Number Placement on Page */}
            <div className="shrink-0 space-y-3">
                <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-slate-800 dark:text-zinc-200">{t('preprocess.numbering:1_chi_dinh_vi_tri')}</span>
                    {vdpFields.length > 0 && (
                        <span className="text-[11px] font-bold text-teal-700 dark:text-teal-300 bg-teal-100 dark:bg-teal-900/50 px-2 py-0.5 rounded-full">
                            {vdpFields.length} Slots
                        </span>
                    )}
                </div>

                <div className="grid grid-cols-2 gap-2">
                    <button
                        type="button"
                        onClick={() => {
                            const next = !isPickingVdpText;
                            setIsPickingVdpText(next);
                            if (next) {
                                toast.info(t('Nhấp vào con số mẫu trên bản thiết kế để tự động chọn làm Slot số nhảy.'));
                            }
                        }}
                        className={`p-2.5 rounded-lg border text-xs font-semibold flex items-center justify-center gap-2 transition-all shadow-sm ${
                            isPickingVdpText
                                ? 'bg-teal-500 text-white border-teal-600 ring-2 ring-teal-400 ring-offset-1 animate-pulse'
                                : 'bg-teal-50 hover:bg-teal-100 dark:bg-teal-950/40 dark:hover:bg-teal-900/50 text-teal-700 dark:text-teal-300 border-teal-300 dark:border-teal-700'
                        }`}
                        title={t('preprocess.numbering:chon_so_mau_btn')}
                    >
                        <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                        </svg>
                        <span className="truncate">{isPickingVdpText ? t('Đang chọn...') : t('preprocess.numbering:chon_so_mau_btn')}</span>
                    </button>

                    <div 
                        onPointerDown={(e) => startVdpDrag(e, 'text', t('preprocess.numbering:vi_tri_nhay_so_slot'))}
                        className="bg-indigo-50 border-2 border-indigo-200 dark:bg-indigo-900/20 dark:border-indigo-800 p-2.5 rounded-lg cursor-grab active:cursor-grabbing hover:border-indigo-400 flex items-center justify-center gap-2 transition-colors shadow-sm select-none"
                        title={t('preprocess.numbering:keo_vi_tri_btn')}
                    >
                        <svg className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" /></svg>
                        <span className="text-xs font-bold text-indigo-700 dark:text-indigo-300 truncate">{t('preprocess.numbering:keo_vi_tri_btn')}</span>
                    </div>
                </div>

                {/* Placed Slots Summary / Empty State */}
                {vdpFields.length === 0 ? (
                    <div className="text-[11px] text-slate-400 dark:text-zinc-500 bg-slate-50 dark:bg-zinc-800/40 p-2.5 rounded border border-dashed border-slate-200 dark:border-zinc-700 flex items-center gap-2">
                        <svg className="w-4 h-4 shrink-0 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        <span>{t('preprocess.numbering:chua_co_slot_hint')}</span>
                    </div>
                ) : (
                    <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-zinc-400">
                            <span>{t('preprocess.numbering:da_dat_slots', { n: vdpFields.length })}</span>
                            <span className="text-[10px] text-indigo-500">{t('preprocess.numbering:click_to_select')}</span>
                        </div>
                        <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto p-1.5 bg-slate-50 dark:bg-zinc-800/40 rounded border border-slate-200 dark:border-zinc-700">
                            {vdpFields.map((f, idx) => {
                                const isSelected = selectedFieldIds.includes(f.id);
                                return (
                                    <button
                                        key={f.id}
                                        type="button"
                                        onClick={() => onSelectField?.([f.id])}
                                        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium transition-all ${
                                            isSelected 
                                                ? 'bg-indigo-600 text-white shadow-xs' 
                                                : 'bg-white dark:bg-zinc-700 text-slate-700 dark:text-zinc-200 hover:bg-slate-100 border border-slate-200 dark:border-zinc-600'
                                        }`}
                                    >
                                        <span className="w-1.5 h-1.5 rounded-full bg-teal-400 shrink-0" />
                                        <span>{f.name || `Slot ${idx + 1}`}</span>
                                        <span className="text-[9px] opacity-70">({Math.round(f.x ?? 0)}, {Math.round(f.y ?? 0)})</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>

            <div className="h-px bg-slate-200 dark:bg-zinc-700 w-full shrink-0" />

            {/* Step 2: Numbering Sequence Rules */}
            <div className="shrink-0 space-y-3">
                <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-slate-800 dark:text-zinc-200">{t('preprocess.numbering:2_cau_hinh_day_so')}</span>
                </div>

                {/* Mode Switch: Shared Sequence vs Per-Field Sequence */}
                <div className="flex bg-slate-100 dark:bg-zinc-800 p-1 rounded-md">
                    <button 
                        type="button"
                        className={`flex-1 text-xs py-1.5 rounded font-bold transition-all ${sequenceMode === 'shared' ? 'bg-white dark:bg-zinc-700 shadow text-indigo-600 dark:text-indigo-400' : 'text-slate-500 hover:bg-slate-200 dark:hover:bg-zinc-700/50'}`}
                        onClick={() => setSequenceMode('shared')}
                    >
                        {t('preprocess.numbering:chung_mot_day_so')}
                    </button>
                    <button 
                        type="button"
                        className={`flex-1 text-xs py-1.5 rounded font-bold transition-all ${sequenceMode === 'per_field' ? 'bg-white dark:bg-zinc-700 shadow text-indigo-600 dark:text-indigo-400' : 'text-slate-500 hover:bg-slate-200 dark:hover:bg-zinc-700/50'}`}
                        onClick={() => setSequenceMode('per_field')}
                    >
                        {t('preprocess.numbering:rieng_tung_truong')}
                    </button>
                </div>

                {/* Per-Field Slot Selector & Copy action */}
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
                                    {t('preprocess.numbering:canh_bao_lech_so_luong')}
                                </div>
                                <p className="text-[11px] text-amber-700 dark:text-amber-300/90 mt-0.5 leading-snug">
                                    {t('preprocess.numbering:lech_so_luong_desc')}
                                </p>
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
                                className="flex-1 py-1 px-2 text-[10px] font-bold bg-amber-600 hover:bg-amber-700 text-white rounded shadow-xs transition-colors flex items-center justify-center gap-1 cursor-pointer"
                                title="Tự động tăng số kết thúc của các trường ít hơn"
                            >
                                ⚡ {t('preprocess.numbering:nut_dong_bo_max', { count: slotLengthStats.maxCount })}
                            </button>
                            <button
                                type="button"
                                onClick={handleSyncToMinCount}
                                className="py-1 px-2 text-[10px] font-medium bg-white dark:bg-zinc-800 hover:bg-amber-100 dark:hover:bg-zinc-700 text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-700 rounded shadow-xs transition-colors cursor-pointer"
                                title="Tự động giảm số kết thúc của các trường nhiều hơn"
                            >
                                ✂️ {t('preprocess.numbering:nut_cat_ngan_min', { count: slotLengthStats.minCount })}
                            </button>
                        </div>
                    </div>
                )}

                <div className="flex bg-slate-100 dark:bg-zinc-800 p-1 rounded-md">
                    <button 
                        className={`flex-1 text-xs py-1.5 rounded font-bold transition-all ${genMethod === 'range' ? 'bg-white dark:bg-zinc-700 shadow text-indigo-600 dark:text-indigo-400' : 'text-slate-500 hover:bg-slate-200 dark:hover:bg-zinc-700/50'}`}
                        onClick={() => setGenMethod('range')}
                    >
                        {t('preprocess.numbering:day_so_1_2_3')}
                    </button>
                    <button 
                        className={`flex-1 text-xs py-1.5 rounded font-bold transition-all ${genMethod === 'set' ? 'bg-white dark:bg-zinc-700 shadow text-indigo-600 dark:text-indigo-400' : 'text-slate-500 hover:bg-slate-200 dark:hover:bg-zinc-700/50'}`}
                        onClick={() => setGenMethod('set')}
                    >
                        {t('preprocess.numbering:theo_bo_a_01_b_01')}
                    </button>
                </div>

                <div className="p-3 border border-slate-200 dark:border-zinc-700 rounded-lg space-y-3 bg-slate-50/50 dark:bg-zinc-800/20">
                    {genMethod === 'range' ? (
                        <div className="space-y-3">
                            <div className="flex flex-col gap-1 pb-3 border-b border-slate-200 dark:border-zinc-700">
                                <label className="text-[10px] font-bold text-indigo-600 dark:text-indigo-400 uppercase">{t('preprocess.numbering:trich_xuat_tu_dong_smart_extract')}</label>
                                <div className="flex gap-2">
                                    <input 
                                        type="text" 
                                        placeholder={t('preprocess.numbering:vi_du_no_00123_vip')}
                                        className="flex-1 h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded bg-white dark:bg-zinc-900"
                                        onChange={(e) => {
                                            const val = e.target.value;
                                            // Bắt cụm số CUỐI (phần seri), không phải cụm số đầu:
                                            // đuôi \D* chỉ nhận ký-tự-không-số nên engine buộc
                                            // \d+ trườn tới cụm số cuối; "AB12-0045" → tiền tố
                                            // "AB12-", số "0045", hậu tố "".
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
                                </div>
                                <span className="text-[9px] text-slate-500">{t('preprocess.numbering:nhap_chuoi_mau_phan_mem_se_tu_tach_tien')}</span>
                            </div>
                            <div className="grid grid-cols-3 gap-2">
                                <div className="flex flex-col gap-1">
                                    <label className="text-[10px] font-medium text-slate-500">{t('preprocess.numbering:bat_dau_tu')}</label>
                                    <input type="number" value={startNum} onChange={e => setStartNum(Number(e.target.value))} className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-[10px] font-medium text-slate-500">{t('preprocess.numbering:den_so')}</label>
                                    <input type="number" value={endNum} onChange={e => setEndNum(Number(e.target.value))} className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-[10px] font-medium text-slate-500">{t('preprocess.numbering:buoc_nhay')}</label>
                                    <input type="number" min={1} value={increment} onChange={e => setIncrement(Number(e.target.value))} className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            <div className="grid grid-cols-2 gap-2">
                                <div className="flex flex-col gap-1">
                                    <label className="text-[10px] font-medium text-slate-500">{t('preprocess.numbering:so_luong_bo')}</label>
                                    <input type="number" value={setTotal} onChange={e => setSetTotal(Number(e.target.value))} className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-[10px] font-medium text-slate-500">{t('preprocess.numbering:bo_bat_dau_ky_tu_so')}</label>
                                    <input type="text" value={setStartStr} onChange={e => setSetStartStr(e.target.value)} className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-[10px] font-medium text-slate-500">{t('preprocess.numbering:so_luong_ve_bo')}</label>
                                    <input type="number" value={seqTotal} onChange={e => setSeqTotal(Number(e.target.value))} className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <label className="text-[10px] font-medium text-slate-500">{t('preprocess.numbering:bat_dau_tu_so')}</label>
                                    <input type="number" value={seqStart} onChange={e => setSeqStart(Number(e.target.value))} className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                                </div>
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="text-[10px] font-medium text-slate-500">{t('preprocess.numbering:cau_truc_hien_thi')}</label>
                                <input type="text" value={formatTemplate} onChange={e => setFormatTemplate(e.target.value)} placeholder="{%b}-{%t}" className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded font-mono" />
                                <span className="text-[9px] text-slate-400">{t('preprocess.numbering:dung_b_cho_bo_va_t_cho_stt', { b: '{%b}', t: '{%t}' })}</span>
                            </div>
                        </div>
                    )}
                    
                    <div className="border-t border-slate-200 dark:border-zinc-700 pt-3 grid grid-cols-2 gap-2">
                        <div className="flex flex-col gap-1">
                            <label className="text-[10px] font-medium text-slate-500">{t('preprocess.numbering:tien_to')}</label>
                            <input type="text" value={prefix} onChange={e => setPrefix(e.target.value)} placeholder="VD: No." className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="text-[10px] font-medium text-slate-500">{t('preprocess.numbering:hau_to')}</label>
                            <input type="text" value={suffix} onChange={e => setSuffix(e.target.value)} className="w-full h-8 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                        </div>
                        <div className="flex flex-col gap-1 col-span-2">
                            <div className="flex items-center gap-2 mb-1">
                                <input type="checkbox" checked={padZero} onChange={e => setPadZero(e.target.checked)} id="padZero" />
                                <label htmlFor="padZero" className="text-[11px] font-medium text-slate-600 dark:text-zinc-300 cursor-pointer">{t('preprocess.numbering:dem_so_0_vao_dau')}</label>
                            </div>
                            {padZero && (
                                <div className="flex items-center gap-2">
                                    <span className="text-[10px] text-slate-500">{t('preprocess.numbering:chieu_dai_co_dinh')}</span>
                                    <input type="number" min={1} value={padLength} onChange={e => setPadLength(Number(e.target.value))} className="w-16 h-7 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded" />
                                </div>
                            )}
                            <div className="flex items-center gap-2 mt-1">
                                <input type="checkbox" checked={isShuffle} onChange={e => setIsShuffle(e.target.checked)} id="isShuffle" />
                                <label htmlFor="isShuffle" className="text-[11px] font-medium text-slate-600 dark:text-zinc-300 cursor-pointer">{t('preprocess.numbering:xao_tron_ngau_nhien_lam_ve_boc_tham')}</label>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div className="h-px bg-slate-200 dark:bg-zinc-700 w-full shrink-0" />

            {/* Step 3: Finishing & Output Ordering */}
            <div className="shrink-0 space-y-3">
                <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-slate-800 dark:text-zinc-200">{t('preprocess.numbering:3_cach_ra_thanh_pham')}</span>
                </div>

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
                                    {t('preprocess.numbering:dong_cuon_xen_chong')}
                                </span>
                            </div>
                            <p className="text-[10px] text-slate-500 dark:text-zinc-400 leading-snug">
                                {t('preprocess.numbering:dong_cuon_desc')}
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
                                    {t('preprocess.numbering:tem_roi_thu_tu')}
                                </span>
                            </div>
                            <p className="text-[10px] text-slate-500 dark:text-zinc-400 leading-snug">
                                {t('preprocess.numbering:tem_roi_desc')}
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

                {/* Secondary order dropdown */}
                <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-200 dark:border-zinc-700/60">
                    <label className="text-[11px] font-medium text-slate-600 dark:text-zinc-400 shrink-0">
                        {t('preprocess.numbering:thu_tu_tren_trang')}
                    </label>
                    <select 
                        value={sortMethod} 
                        onChange={e => setSortMethod(e.target.value as 'rows'|'cols'|'ushape'|'clockwise')}
                        className="h-7 px-2 text-xs border border-slate-300 dark:border-zinc-600 rounded bg-white dark:bg-zinc-800 text-slate-700 dark:text-zinc-200"
                    >
                        <option value="rows">{t('preprocess.numbering:quet_theo_hang_z')}</option>
                        <option value="cols">{t('preprocess.numbering:quet_theo_cot_n')}</option>
                        <option value="ushape">{t('preprocess.numbering:chu_u_u_shape')}</option>
                        <option value="clockwise">{t('preprocess.numbering:vong_tron_clockwise')}</option>
                    </select>
                </div>
            </div>

            <div className="h-px bg-slate-200 dark:bg-zinc-700 w-full shrink-0" />

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
                            {t('preprocess.numbering:dinh_dang')} {selectedFieldIds.length > 1 ? t('preprocess.numbering:n_truong', { n: selectedFieldIds.length }) : vdpFields.find(f=>f.id===selectedFieldIds[0])?.name}
                        </span>
                        {selectedFieldIds.length > 1 && (
                            <button onClick={handleGroupFields} className="text-[10px] bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 px-2 py-1 rounded text-slate-600 dark:text-zinc-300 font-medium">
                                {t('preprocess.numbering:group_nhom')}
                            </button>
                        )}
                        {selectedFieldIds.length > 0 && vdpFields.find(f=>f.id===selectedFieldIds[0])?.groupId && (
                            <button onClick={handleUngroupFields} className="text-[10px] bg-slate-100 dark:bg-zinc-800 hover:bg-slate-200 px-2 py-1 rounded text-red-500 font-medium">
                                {t('preprocess.numbering:ungroup_bo_nhom')}
                            </button>
                        )}
                        {selectedFieldIds.length > 0 && (
                            <button 
                                onClick={deleteSelectedField}
                                className="text-red-500 hover:text-red-700 bg-red-50 hover:bg-red-100 dark:bg-red-500/10 dark:hover:bg-red-500/20 p-1.5 rounded transition-colors"
                                title={t('preprocess.numbering:xoa_truong_nay')}
                            >
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                            </button>
                        )}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div className="flex flex-col gap-1 col-span-2">
                            <span className="text-[10px] font-medium text-slate-500 block mb-1">{t('preprocess.numbering:font_chu_font_family')}</span>
                            <FontSelector 
                                value={vdpFields.find(f=>f.id===selectedFieldIds[0])?.fontName || 'Helvetica'}
                                fontFile={vdpFields.find(f=>f.id===selectedFieldIds[0])?.fontFile}
                                onChange={(fontName, fontFile) => updateSelectedField({ fontName, fontFile })}
                            />
                        </div>
                        <div className="flex flex-col gap-1 col-span-2">
                            <span className="text-[10px] font-medium text-slate-500 block mb-1">{t('preprocess.numbering:net_font_font_style')}</span>
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
                            label={t('preprocess.numbering:co_chu')}
                            value={vdpFields.find(f=>f.id===selectedFieldIds[0])?.fontSize || 13}
                            onChange={(val) => updateSelectedField({ fontSize: val })}
                            suffix="pt" step={1}
                        />
                        <ToolNumberInput 
                            label={t('preprocess.numbering:dong_leading')}
                            value={vdpFields.find(f=>f.id===selectedFieldIds[0])?.lineHeight || 1}
                            onChange={(val) => updateSelectedField({ lineHeight: val })}
                            suffix="em" step={0.1}
                        />
                        <ToolNumberInput 
                            label={t('preprocess.numbering:khoang_cach_tracking')}
                            value={vdpFields.find(f=>f.id===selectedFieldIds[0])?.characterSpacing || 0}
                            onChange={(val) => updateSelectedField({ characterSpacing: val })}
                            suffix="pt" step={0.5}
                        />
                        <div>
                            <span className="text-[11px] font-medium text-slate-500 block mb-1">{t('preprocess.numbering:can_le')}</span>
                            <div className="flex items-center gap-1.5">
                                <select 
                                    value={vdpFields.find(f=>f.id===selectedFieldIds[0])?.alignment || 'left'}
                                    onChange={(e) => updateSelectedField({ alignment: e.target.value })}
                                    className="flex-1 min-w-0 h-8 px-2 text-[12px] font-semibold bg-white dark:bg-zinc-900 border border-slate-300 dark:border-white/20 rounded-md focus:outline-none focus:border-teal-500 transition-all"
                                >
                                    <option value="left">{t('preprocess.numbering:trai')}</option>
                                    <option value="center">{t('preprocess.numbering:giua')}</option>
                                    <option value="right">{t('preprocess.numbering:phai')}</option>
                                </select>
                            </div>
                        </div>
                        <div className="col-span-2">
                            <span className="text-[10px] font-medium text-slate-500 block mb-1">{t('preprocess.numbering:mau_chu')}</span>
                            <CmykColorPicker
                                label={t('preprocess.numbering:mau_cmyk')}
                                value={vdpFields.find(f=>f.id===selectedFieldIds[0])?.fontColor || '#000000'}
                                onChange={(hex: string) => updateSelectedField({ fontColor: hex })}
                            />
                        </div>
                    </div>
                </div>
            )}

            {/* Preview Section — Trực quan chuẩn VDP */}
            <div className="shrink-0 space-y-2 mt-3 pt-2 border-t border-slate-200 dark:border-zinc-700">
                <div className="flex items-center justify-between">
                    <span className="text-[12px] font-bold text-slate-800 dark:text-zinc-200 flex items-center gap-1.5">
                        <svg className="w-4 h-4 text-indigo-600 dark:text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                        {t('preprocess.numbering:xem_truoc_ket_qua_slots', { n: vdpFields.length })}
                    </span>
                    <button
                        type="button"
                        onClick={() => setShowSummaryText(prev => !prev)}
                        className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-1 cursor-pointer"
                    >
                        <span>{showSummaryText ? 'Thu gọn' : 'Xem dạng danh sách'}</span>
                    </button>
                </div>

                {/* Thanh điều hướng trang (Prev, Input page, Next, Nút Xem) */}
                <div className="flex items-center gap-1.5">
                    <button
                        type="button"
                        onClick={() => {
                            const next = Math.max(1, previewIndex - 1);
                            setPreviewIndex(next);
                            void runPreview(next);
                        }}
                        disabled={previewLoading || previewIndex <= 1}
                        title="Trang trước"
                        className="shrink-0 h-8 w-8 flex items-center justify-center rounded border border-slate-300 dark:border-zinc-600 text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors shadow-sm"
                    >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                        </svg>
                    </button>

                    <div className="flex items-center gap-1 flex-1 min-w-0 justify-center bg-white dark:bg-zinc-900 border border-slate-300 dark:border-zinc-700 rounded h-8 px-2 shadow-inner">
                        <span className="text-[11px] text-slate-500 dark:text-zinc-400 shrink-0">Trang</span>
                        <input
                            type="number"
                            min={1}
                            max={totalPages || 1}
                            value={previewIndex}
                            onChange={(e) => setPreviewIndex(Math.max(1, Math.min(totalPages || 1, Number(e.target.value) || 1)))}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') void runPreview(previewIndex);
                            }}
                            className="w-14 text-center font-bold text-[12px] bg-transparent text-indigo-600 dark:text-indigo-400 focus:outline-none"
                        />
                        <span className="text-[11px] text-slate-500 dark:text-zinc-400 shrink-0">
                            / {totalPages.toLocaleString('vi-VN')}
                        </span>
                    </div>

                    <button
                        type="button"
                        onClick={() => {
                            const next = Math.min(totalPages, previewIndex + 1);
                            setPreviewIndex(next);
                            void runPreview(next);
                        }}
                        disabled={previewLoading || previewIndex >= totalPages}
                        title="Trang tiếp theo"
                        className="shrink-0 h-8 w-8 flex items-center justify-center rounded border border-slate-300 dark:border-zinc-600 text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors shadow-sm"
                    >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                        </svg>
                    </button>

                    <button
                        type="button"
                        onClick={() => void runPreview(previewIndex)}
                        disabled={previewLoading || vdpFields.length === 0}
                        className="shrink-0 h-8 px-3 text-[11px] font-bold bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-400 text-white rounded transition-colors flex items-center gap-1 shadow-sm cursor-pointer"
                    >
                        {previewLoading ? (
                            <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        ) : (
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                        )}
                        <span>{t('preprocess.dataMerge:nut_xem', 'Xem')}</span>
                    </button>
                </div>

                {/* Khung hiển thị ảnh xem trước trực quan (Live Render Preview) */}
                <div className="relative rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-800/40 overflow-hidden min-h-[140px] flex items-center justify-center shadow-inner">
                    {previewImg ? (
                        <div className="relative inline-block w-full">
                            <img
                                src={previewImg}
                                alt={`Xem trước trang ${previewIndex}`}
                                className="block w-full h-auto select-none rounded"
                                draggable={false}
                            />
                        </div>
                    ) : (
                        <div className="text-[12px] text-slate-400 dark:text-zinc-500 py-7 px-3 text-center flex flex-col items-center gap-2">
                            <svg className="w-8 h-8 opacity-35 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                            </svg>
                            <span>{vdpFields.length === 0 ? t('preprocess.numbering:keo_tha_it_nhat_1_slot_len_man_hinh_de') : 'Bấm "Xem" để kết xuất trực quan số nhảy trên bản in'}</span>
                        </div>
                    )}

                    {previewLoading && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-[1px] z-10">
                            <span className="w-5 h-5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
                            <span className="text-[11px] text-slate-700 dark:text-zinc-200 font-medium">Đang tạo bản xem trước...</span>
                        </div>
                    )}
                </div>

                {/* Thông báo lỗi hoặc thông tin nếu có */}
                {previewMsg && (
                    <div className="text-[11px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 px-2.5 py-1.5 rounded border border-amber-200 dark:border-amber-800/30 leading-snug">
                        {previewMsg}
                    </div>
                )}

                {/* Chip giá trị các Slot trên trang hiện tại */}
                {currentSlotValues.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                        {currentSlotValues.map((sv, idx) => (
                            <div key={idx} className="flex items-center gap-1.5 px-2 py-1 rounded bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800/40 text-[11px]">
                                <span className="font-semibold text-indigo-700 dark:text-indigo-300">{sv.name}:</span>
                                <span className="font-mono text-slate-800 dark:text-zinc-100 font-bold bg-white dark:bg-zinc-800 px-1.5 py-0.5 rounded shadow-xs">{sv.value}</span>
                            </div>
                        ))}
                    </div>
                )}

                {/* Danh sách text tóm tắt (thu gọn / mở rộng) */}
                {showSummaryText && (
                    <div className="bg-slate-100 dark:bg-zinc-900 border border-slate-200 dark:border-zinc-700 rounded-md p-2.5 font-mono text-[10px] text-slate-600 dark:text-zinc-400 whitespace-pre-wrap leading-relaxed shadow-inner mt-1.5">
                        {previewLines.join('\n')}
                    </div>
                )}
            </div>

            {/* Run Button */}
            <div className="mt-auto pt-4 shrink-0 border-t border-slate-200 dark:border-zinc-700">
                {/* Warning bar above Run Button when mismatch exists */}
                {slotLengthStats.isMismatch && (
                    <div className="mb-2.5 p-2 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 text-[11px] text-amber-800 dark:text-amber-300 flex items-center justify-between gap-2 shadow-2xs">
                        <span className="flex items-center gap-1.5 min-w-0">
                            <svg className="w-4 h-4 text-amber-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                            <span className="truncate">Lệch số lượng ({slotLengthStats.minCount} vs {slotLengthStats.maxCount} số).</span>
                        </span>
                        <button
                            type="button"
                            onClick={handleSyncToMaxCount}
                            className="text-[10px] font-bold text-amber-700 dark:text-amber-400 hover:underline shrink-0 cursor-pointer bg-amber-200/60 dark:bg-amber-900/60 px-2 py-0.5 rounded"
                        >
                            Đồng bộ ngay
                        </button>
                    </div>
                )}
                {/* UIUX (audit 2026-07-27 §D-07): đang chạy job → ProgressBar % thật + nút Hủy */}
                {statusMessage && (
                    isGenerating ? (
                        <ProgressBar
                            message={statusMessage}
                            processed={progressInfo?.processed}
                            total={progressInfo?.total}
                            onCancel={activeVdpJobId ? () => void cancelActiveVdp().catch((err) => setStatusMessage(formatError(err))) : undefined}
                            className="mb-3"
                        />
                    ) : (
                        <div className="mb-3 p-2 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 text-[11px] rounded animate-pulse text-center font-medium">
                            {statusMessage}
                        </div>
                    )
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
                        {t('preprocess.numbering:mo_ket_qua_sang_tab_moi_thay_vi_de_file')}
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
                        className="mt-2 w-full rounded-lg bg-red-600 py-2.5 text-sm font-bold text-white hover:bg-red-700"
                    >
                        {t('tabs.imposition:huy_bo_cancel')}
                    </button>
                )}
            </div>
        </div>
    );
}
