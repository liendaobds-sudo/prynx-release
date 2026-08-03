// @ts-nocheck
/**
 * ImposerDashboard — Thin Controller for Imposition Settings.
 * 
 * REFACTORED: Previously 1897 lines → now ~480 lines.
 * All UI sections are extracted to dedicated components under ./sections/.
 * All state is managed via useImposerSettingsStore (Zustand).
 * 
 * This file retains:
 *   - Side effects (paper presets, auto-detection, batch capacities, persistence)
 *   - Execute handler (builds settings → calls parent callbacks)
 *   - Preset callbacks (save/load/update/delete)
 *   - Layout composition (conditionally renders sections)
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { useShallow } from 'zustand/react/shallow';
import { usePaperPresets, PaperSettingsDialog } from './PaperSettingsUI';
import PaperSizeSelect from './PaperSizeSelect';
import {
    formUsages,
    paperContextFromTool,
    showsPredefinedSheets,
    defaultUsagesForContext,
    resolveSheetDimsMm,
    resolvePressSheetDimsMm,
    fallbackFormsizeForContext,
    isCustomPresetId,
    isKnownPredefined,
    isFreeFormsize,
    type PaperUsage,
} from './paperUtils';
import { MarksSettingsDialog } from './MarksSettingsDialog';
import { PontSettingsDialog } from './PontSettingsDialog';
import { Divider, Checkbox } from './SharedUI';
import ToolMenuList from './ToolMenuList';
import PresetSelector from './PresetSelector';
import { FlipbookDialog } from '../flipbook/FlipbookDialog';
import { SheetViewerDialog } from '../flipbook/SheetViewerDialog';
import { authenticatedFetch, getApiUrl, uploadPDF } from '../../lib/api';
import { previewPerfLog } from '../../lib/previewPerfLog';
import { MergeSettings, defaultMergeSettings } from '../preprocess-tools/MergeTool';
import MergeTool from '../preprocess-tools/MergeTool';

// Section components
import BookletSettingsSection from './sections/BookletSettingsSection';
import AutoCatalogSection from './sections/AutoCatalogSection';
import PreprocessingRouter from './sections/PreprocessingRouter';
import GridSettingsSection from './sections/GridSettingsSection';
import AdvancedSettingsSection from './sections/AdvancedSettingsSection';
import GridPreview from './sections/GridPreview';
import ProductFirstPanel from './ProductFirstPanel';
import { HIDE_PRODUCT_FIRST } from '../../lib/featureFocus';

// Store & Types
import { useImposerSettingsStore } from './useImposerSettingsStore';
import { PREDEFINED_SIZES, DEFAULT_FORMSIZE, getImposerCapability, WORKSPACE_TOOL_PANEL, isWorkspaceTool, type ActiveToolType, type TaskMode, type ImposerDashboardProps } from './types';
export type { BookletSettings, NupSettings } from './types';
export { PREDEFINED_SIZES, DEFAULT_FORMSIZE } from './types';

import type { ImpositionPreset } from '../../lib/presetManager';
import { toast } from '../ui/Toast';
import { useTranslation } from 'react-i18next';
import {
    batchCapacityDetectionReady,
    buildPageSizedShapeState,
    inheritedSingleMoldMaster,
    shapeDetectionSourceKey,
    projectPageRecordToViewer,
    projectShapeParamsToViewer,
    resolvePreviewItemDimension,
    usesPageSizedStickerShape,
} from './shapeDetectionPolicy';
import { toBookReportRenderConfig } from '../../lib/bookReport';
import { resolveImpositionModes, resolveImpositionSplitGap } from './pageSheetPolicy';

const BOOK_REPORT_BINDING_LABELS: Record<string, string> = {
    saddle: 'Bấm kim giữa',
    thread: 'Khâu chỉ',
    cut_stacks: 'Cắt đôi ráp xấp',
    continuous: 'Keo gáy / lò xo',
    flush_mount: 'Dán đôi lưng',
};

type SameSizeNupLayoutType = 'sequential' | 'cut_stacks' | 'ratio_stack';
type GuillotineSizeClass = 'unknown' | 'uniform' | 'mixed';
interface ImpositionPdfMetaPage {
    width_pt: number;
    height_pt: number;
    media_width_pt?: number;
    media_height_pt?: number;
    guillotine_width_pt?: number;
    guillotine_height_pt?: number;
}

function isSameSizeNupLayoutType(value: string): value is SameSizeNupLayoutType {
    return value === 'sequential' || value === 'cut_stacks' || value === 'ratio_stack';
}

function classifyGuillotinePageSizes(
    dimensionsByPage: Record<number, { w: number; h: number }>,
    pageCount: number,
    tolerancePt = 0.5,
): GuillotineSizeClass {
    if (!Number.isInteger(pageCount) || pageCount <= 0) return 'unknown';

    const tolerance = Math.max(0, tolerancePt);
    let first: { w: number; h: number } | null = null;
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
        const dimension = dimensionsByPage[pageIndex];
        if (
            !dimension
            || !Number.isFinite(dimension.w)
            || !Number.isFinite(dimension.h)
            || dimension.w <= 0
            || dimension.h <= 0
        ) {
            return 'unknown';
        }
        if (!first) {
            first = dimension;
            continue;
        }
        if (
            Math.abs(dimension.w - first.w) > tolerance
            || Math.abs(dimension.h - first.h) > tolerance
        ) {
            return 'mixed';
        }
    }
    return 'uniform';
}

export default function ImposerDashboard({ tabId, onStartBooklet, onStartNup, onStartShuffle, onStartResize, onStartTrimShift, onStartSplit, onStartMerge, onStartCatalogPlan, initialFeature, lockedMode, onBleedUpdate, onFileFixed, systemMergeFiles, officeSourceFile, officeSourceFiles, getWorkingFile, ensureCropFileId, onCropApplied, onCropClose }: ImposerDashboardProps) {
  const { t } = useTranslation();

    // ═══ Workspace State ═══
    const {
        isProcessing, error: globalError, file: pdfFile, viewerPageOrder, viewerPageInstanceIds, viewerPageRotations, viewerNumPages,
        setHighlightedIssue: onIssueSelect, setShowOutputPreview,
        detectedShapeType, detectedShapeParams, setDetectedShapeType, setDetectedShapeParams,
        detectedShapesByPage, setDetectedShapesByPage,
        detectedDimensionsByPage, setDetectedDimensionsByPage,
        detectedShapeParamsByPage, setDetectedShapeParamsByPage, viewerActivePage, pdfUrl,
        selectionFileId, setSelectionFileId, hiddenOcgLayerIds
    } = useWorkspaceStore(useShallow(state => ({
        isProcessing: state.isProcessing, error: state.error, file: state.file, viewerPageOrder: state.viewerPageOrder, viewerPageInstanceIds: state.viewerPageInstanceIds, viewerPageRotations: state.viewerPageRotations, viewerNumPages: state.viewerNumPages,
        setHighlightedIssue: state.setHighlightedIssue, setShowOutputPreview: state.setShowOutputPreview,
        detectedShapeType: state.detectedShapeType, detectedShapeParams: state.detectedShapeParams, setDetectedShapeType: state.setDetectedShapeType, setDetectedShapeParams: state.setDetectedShapeParams,
        detectedShapesByPage: state.detectedShapesByPage, setDetectedShapesByPage: state.setDetectedShapesByPage,
        detectedDimensionsByPage: state.detectedDimensionsByPage, setDetectedDimensionsByPage: state.setDetectedDimensionsByPage,
        detectedShapeParamsByPage: state.detectedShapeParamsByPage, setDetectedShapeParamsByPage: state.setDetectedShapeParamsByPage, viewerActivePage: state.viewerActivePage, pdfUrl: state.pdfUrl,
        selectionFileId: state.selectionFileId,
        setSelectionFileId: state.setSelectionFileId,
        hiddenOcgLayerIds: state.hiddenOcgLayerIds
    })));

    // P1-T03: activeDashboardTool from dedicated imposer store (migration in progress, dupe in workspace for now)
    const { activeDashboardTool: currentTool, setActiveDashboardTool: onActiveToolChange } = useImposerSettingsStore();
    // Duplication updates the order and page counter through separate UI paths.
    // Taking the larger value prevents preview from remaining stuck at the old count.
    const sourceTotalPages = Math.max(viewerPageOrder?.length || 0, viewerNumPages || 0);
    // The report describes the edited document, so prefer the current page order after deletes.
    const bookReportPageCount = viewerPageOrder?.length || sourceTotalPages;
    const onOpenOutputPreview = () => setShowOutputPreview(true);

    // ═══ Imposition Settings Store ═══
    const s = useImposerSettingsStore();
    const [guillotineMetadata, setGuillotineMetadata] = useState<{
        source: File | null;
        dimensions: Array<{ w: number; h: number }>;
        complete: boolean;
    }>({ source: null, dimensions: [], complete: false });

    // Quantities follow stable thumbnail instances, not numeric positions.
    // Reordering/deleting pages therefore moves the entered quantity with the
    // product instead of assigning it to whichever page lands at that index.
    const quantityPageIdsRef = useRef<string[] | undefined>(undefined);
    useEffect(() => {
        const current = viewerPageInstanceIds;
        const previous = quantityPageIdsRef.current;
        quantityPageIdsRef.current = current ? [...current] : undefined;
        if (!current?.length || !previous?.length) return;
        if (current.length === previous.length && current.every((id, idx) => id === previous[idx])) return;

        const oldQuantities = s.targetQuantitiesByPage || {};
        const nextQuantities: Record<number, number> = {};
        current.forEach((id, newIdx) => {
            const oldIdx = previous.indexOf(id);
            if (oldIdx >= 0 && Object.prototype.hasOwnProperty.call(oldQuantities, oldIdx)) {
                nextQuantities[newIdx] = oldQuantities[oldIdx];
            }
        });

        const oldKeys = Object.keys(oldQuantities);
        const nextKeys = Object.keys(nextQuantities);
        const changed = oldKeys.length !== nextKeys.length || nextKeys.some((key) => {
            const idx = Number(key);
            return oldQuantities[idx] !== nextQuantities[idx];
        });
        if (changed) s.setTargetQuantitiesByPage(nextQuantities);
    }, [viewerPageInstanceIds, s.targetQuantitiesByPage, s.setTargetQuantitiesByPage]);

    // NAV (audit điều hướng tab 2026-07-28): store theo tab là nguồn trạng thái duy nhất.
    // Không giữ bản sao useState cục bộ vì hai nguồn từng lệch nhau khi Back/restore.
    const activeTool: ActiveToolType = isWorkspaceTool(currentTool) ? currentTool : 'none';
    const setActiveTool = useCallback((tool: ActiveToolType) => {
        onActiveToolChange(tool);
    }, [onActiveToolChange]);

    const {
        pageSheetMode,
        stickerGeometryMode,
        dieGeometryMode,
        pontSettingsMode,
        stickerToolIdentity,
    } = resolveImpositionModes(activeTool, s.impositionUnit);
    const stickerProductMode = stickerToolIdentity || activeTool === 'cnc_imposer';
    const sourcePageDimForGeometry = pageSheetMode
        ? (s.sourceMediaPageDim || s.sourcePageDim)
        : s.sourcePageDim;

    // UIUX (audit 2026-07-27 §B-13/§B-21): chọn tool mới → focus vào panel cấu hình
    // để Tab đi thẳng vào field đầu của form (không phải Tab xuyên qua toolbar).
    // Guard: chỉ khi đổi thật, không cướp focus lúc mount đầu.
    const panelFocusRef = useRef<HTMLDivElement>(null);
    const prevFocusToolRef = useRef<string | null>(null);
    useEffect(() => {
        const prev = prevFocusToolRef.current;
        prevFocusToolRef.current = activeTool;
        if (prev !== null && prev !== activeTool && activeTool !== 'none') {
            panelFocusRef.current?.focus();
        }
    }, [activeTool]);


    // Tool Profiles: khi đổi công cụ, lưu thiết lập thuật toán của tool cũ và nạp tool mới
    // (chống rò rỉ state giữa N-up / Bế tem / Booklet — Task 15/Req 5).
    // taskMode (Bình trang / Dàn nhiều mẫu) cũng nằm trong profile → mỗi tool nhớ riêng.
    const prevActiveToolRef = useRef<string>(activeTool);
    useEffect(() => {
        const prev = prevActiveToolRef.current;
        if (prev !== activeTool) {
            s.switchToolProfile(prev, activeTool);
            prevActiveToolRef.current = activeTool;
        }
    }, [activeTool]);

    // Dao cắt + clusterMode: mỗi lần vào tem bế / CNC → mặc định an toàn
    // (kể cả mở tab lockedMode lần đầu, khi switchToolProfile không chạy vì prev === next).
    useEffect(() => {
        if (activeTool !== 'sticker_imposer' && activeTool !== 'cnc_imposer') return;
        if (s.cutType !== 'default') s.setCutType('default');
        if (s.dieSizeMode !== 'die') s.setDieSizeMode('die');
        if ((s.dieOffsetMm ?? 0) !== 0) s.setDieOffsetMm(0);
        // Chặn rò chia cọc N-Up → tem chỉ lấp 1 dải tờ.
        if (s.clusterMode && s.clusterMode !== 'none') s.setClusterMode('none');
        // Chỉ phụ thuộc activeTool — không re-reset khi user đang chọn 1 Dao.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeTool]);

    // ═══ Merge Settings (stays local — complex sub-component) ═══
    const [mergeSettings, setMergeSettings] = useState<MergeSettings>(defaultMergeSettings);
    const [isDetectingShape, setIsDetectingShape] = useState(false);
    const [completedShapeDetectionKey, setCompletedShapeDetectionKey] = useState('');

    const isTauriRuntime = !!(window as any).__TAURI_INTERNALS__;
    const shapeLocalPath = (pdfFile as any)?.path as string | undefined;
    const pageSizedOneDao = stickerGeometryMode
        && usesPageSizedStickerShape(activeTool, s.cutType, s.dieSizeMode);
    const detectionSourceKey = shapeDetectionSourceKey(
        isTauriRuntime,
        shapeLocalPath,
        selectionFileId,
        pdfFile,
    );
    // Chỉ thay đổi khóa này ở page-mode. Metadata đến sau không được làm nhận diện
    // đường khuôn thật bị hủy rồi chạy lại.
    const pageSizedShapeStateKey = useMemo(
        () => pageSizedOneDao
            ? JSON.stringify({ dims: s.sourcePageDims, fallback: s.sourcePageDim, count: sourceTotalPages })
            : '',
        [pageSizedOneDao, s.sourcePageDims, s.sourcePageDim, sourceTotalPages],
    );
    const expectedShapeDetectionKey = `${activeTool}|${detectionSourceKey}|${pageSizedOneDao ? pageSizedShapeStateKey : 'vector'}`;
    const previewDetectedShapesByPage = useMemo(
        () => projectPageRecordToViewer(detectedShapesByPage, viewerPageOrder),
        [detectedShapesByPage, viewerPageOrder],
    );
    const previewDetectedDimensionsByPage = useMemo(
        () => projectPageRecordToViewer(detectedDimensionsByPage, viewerPageOrder),
        [detectedDimensionsByPage, viewerPageOrder],
    );
    const sourceDimensionsByPage = useMemo(
        () => Object.fromEntries(
            ((pageSheetMode && s.sourceMediaPageDims.length > 0
                ? s.sourceMediaPageDims
                : s.sourcePageDims) || []).map((dim, index) => [index, dim]),
        ),
        [pageSheetMode, s.sourcePageDims, s.sourceMediaPageDims],
    );
    const previewSourceDimensionsByPage = useMemo(
        () => projectPageRecordToViewer(sourceDimensionsByPage, viewerPageOrder),
        [sourceDimensionsByPage, viewerPageOrder],
    );
    const guillotineDimensionsByPage = useMemo(
        () => Object.fromEntries(
            (guillotineMetadata.source === pdfFile ? guillotineMetadata.dimensions : [])
                .map((dimension, index) => [index, dimension]),
        ),
        [guillotineMetadata, pdfFile],
    );
    const previewGuillotineDimensionsByPage = useMemo(
        () => projectPageRecordToViewer(guillotineDimensionsByPage, viewerPageOrder),
        [guillotineDimensionsByPage, viewerPageOrder],
    );
    const guillotinePageCount = viewerPageOrder?.length || sourceTotalPages;
    const guillotineSizeClass = useMemo(
        () => classifyGuillotinePageSizes(
            previewGuillotineDimensionsByPage,
            guillotinePageCount,
        ),
        [previewGuillotineDimensionsByPage, guillotinePageCount],
    );
    const autoGuillotineSizeApplies = activeTool === 'nup'
        && s.taskMode === 'nup'
        && !pageSheetMode;
    const waitingForGuillotineSize = autoGuillotineSizeApplies
        && !!pdfFile
        && (
            guillotineMetadata.source !== pdfFile
            || !guillotineMetadata.complete
        );
    const currentLayoutType = s.layoutType;
    const setLayoutType = s.setLayoutType;
    const lastSameSizeLayoutRef = useRef<SameSizeNupLayoutType>(
        isSameSizeNupLayoutType(currentLayoutType) ? currentLayoutType : 'sequential',
    );
    const lastGuillotineSizeClassRef = useRef<GuillotineSizeClass>('unknown');
    const layoutSourceRef = useRef<File | null | undefined>(undefined);

    useEffect(() => {
        if (isSameSizeNupLayoutType(currentLayoutType)) {
            lastSameSizeLayoutRef.current = currentLayoutType;
        }
    }, [currentLayoutType]);

    useEffect(() => {
        if (layoutSourceRef.current === pdfFile) return;
        layoutSourceRef.current = pdfFile;
        lastGuillotineSizeClassRef.current = 'unknown';
        // UIUX (audit 2026-08-03 §MG-AUTO): mixed là trạng thái suy ra theo tài liệu,
        // không phải sở thích được mang sang file kế tiếp.
        if (currentLayoutType === 'mixed_guillotine') {
            setLayoutType(lastSameSizeLayoutRef.current);
        }
    }, [currentLayoutType, pdfFile, setLayoutType]);

    useEffect(() => {
        if (!autoGuillotineSizeApplies) {
            lastGuillotineSizeClassRef.current = 'unknown';
            return;
        }
        if (guillotineSizeClass === 'unknown') return;

        const sizeClassChanged = lastGuillotineSizeClassRef.current !== guillotineSizeClass;
        lastGuillotineSizeClassRef.current = guillotineSizeClass;
        if (guillotineSizeClass === 'mixed' && currentLayoutType !== 'mixed_guillotine') {
            setLayoutType('mixed_guillotine');
            return;
        }
        // Backend preview vẫn là chốt dự phòng và có thể tự promote khi metadata cũ.
        // Chỉ tự hạ mixed → mode cùng khổ khi chính tập kích thước vừa đổi sang uniform,
        // tránh hai effect giằng co trong lúc working PDF đang được materialize.
        if (
            guillotineSizeClass === 'uniform'
            && sizeClassChanged
            && currentLayoutType === 'mixed_guillotine'
        ) {
            setLayoutType(lastSameSizeLayoutRef.current);
        }
    }, [autoGuillotineSizeApplies, currentLayoutType, guillotineSizeClass, setLayoutType]);
    const previewDetectedShapeParamsByPage = useMemo(
        () => projectShapeParamsToViewer(detectedShapeParamsByPage, viewerPageOrder),
        [detectedShapeParamsByPage, viewerPageOrder],
    );
    const previewDetectedShapeParamStringsByPage = useMemo(
        () => Object.fromEntries(
            Object.entries(previewDetectedShapeParamsByPage)
                .map(([page, params]) => [page, params ? JSON.stringify(params) : null]),
        ),
        [previewDetectedShapeParamsByPage],
    );
    const previewSourceKey = useMemo(
        () => JSON.stringify({
            f: detectionSourceKey,
            o: viewerPageOrder,
            i: viewerPageInstanceIds,
            r: viewerPageRotations,
            d: previewSourceDimensionsByPage,
            n: sourceTotalPages,
        }),
        [detectionSourceKey, viewerPageOrder, viewerPageInstanceIds, viewerPageRotations, previewSourceDimensionsByPage, sourceTotalPages],
    );

    // ═══ Paper Presets ═══
    const { savedForms, handleSavePreset: _savePreset, handleUpdatePreset: _updatePreset, handleDeletePreset: _deletePreset } = usePaperPresets('printauto_saved_forms');

    // Nguyên tấm decal dùng CHUNG thư viện khổ với Từng tem ('diecut'): tuy layout
    // đi nhánh guillotine, người dùng vẫn chọn từ các khổ đã lưu cho tem. paperContext
    // chỉ lọc/heal khổ giấy — KHÔNG phải cờ routing (backend đọc page_sheet_mode riêng).
    const paperContext = paperContextFromTool(activeTool, s.paperClassification);

    const handleSavePreset = useCallback((name: string, w: number, h: number, mT: number, mB: number, mL: number, mR: number, mMode: 'labels_only' | 'include_marks', classification: 'offset' | 'in_nhanh', gripper: number, usages: PaperUsage[] = ['in_nhanh']) => {
        if (savedForms.some(f => f.name === name)) { toast.error(t('imposition.imposerDashboard:ten') + name + t('imposition.imposerDashboard:da_ton_tai')); return; }
        const newId = _savePreset(name, w, h, mT, mB, mL, mR, mMode, classification, gripper, usages);
        s.setFormsize(newId);
        s.setCustomSheetWidth(w); s.setCustomSheetHeight(h);
        s.setMarginTop(mT); s.setMarginBottom(mB); s.setMarginLeft(mL); s.setMarginRight(mR);
        s.setMarginMode(mMode);
        // Chỉ booklet (in_nhanh/offset) mới ghi paperClassification — tránh rò offset sang tem/N-up.
        if (paperContext === 'in_nhanh' || paperContext === 'offset') {
            s.setPaperClassification(classification);
        }
        s.setGripperMargin(gripper);
    }, [savedForms, _savePreset, s, paperContext, t]);

    const handleUpdatePreset = useCallback((id: string, name: string, w: number, h: number, mT: number, mB: number, mL: number, mR: number, mMode: 'labels_only' | 'include_marks', classification: 'offset' | 'in_nhanh', gripper: number, usages: PaperUsage[] = ['in_nhanh']) => {
        _updatePreset(id, name, w, h, mT, mB, mL, mR, mMode, classification, gripper, usages);
        s.setCustomSheetWidth(w); s.setCustomSheetHeight(h);
        s.setMarginTop(mT); s.setMarginBottom(mB); s.setMarginLeft(mL); s.setMarginRight(mR);
        s.setMarginMode(mMode);
        if (paperContext === 'in_nhanh' || paperContext === 'offset') {
            s.setPaperClassification(classification);
        }
        s.setGripperMargin(gripper);
    }, [_updatePreset, s, paperContext]);

    const handleDeletePreset = useCallback((id: string) => {
        const remaining = savedForms.filter(f => f.id !== id);
        _deletePreset(id);
        if (s.formsize === id) {
            s.setFormsize(fallbackFormsizeForContext(paperContext, remaining));
        }
        s.setShowSettings(false);
    }, [_deletePreset, s, savedForms, paperContext]);

    // ═══ Resolve khổ giấy ĐÍCH (SSOT) ═══
    const resolveSheetDims = useCallback((): { w: number; h: number } => {
        return resolveSheetDimsMm(s.formsize, savedForms, s.customSheetWidth, s.customSheetHeight);
    }, [s.formsize, savedForms, s.customSheetWidth, s.customSheetHeight]);

    // Swap ngang CHỈ booklet+offset — không rò sang N-up/tem/CNC.
    const resolvePressSheetDims = useCallback((): { w: number; h: number } => {
        return resolvePressSheetDimsMm(resolveSheetDims(), {
            activeTool,
            paperClassification: s.paperClassification,
            taskMode: s.taskMode,
        });
    }, [resolveSheetDims, activeTool, s.paperClassification, s.taskMode]);

    // ═══ Paper dimension sync ═══
    const prevFormsizeRef = useRef(s.formsize);
    useEffect(() => {
        const formsizeChanged = prevFormsizeRef.current !== s.formsize;
        prevFormsizeRef.current = s.formsize;
        if (isCustomPresetId(s.formsize)) {
            const preset = savedForms.find(f => f.id === s.formsize);
            if (preset && (preset.w !== s.customSheetWidth || preset.h !== s.customSheetHeight)) {
                s.setCustomSheetWidth(preset.w); s.setCustomSheetHeight(preset.h);
                if (formsizeChanged) {
                    s.setMarginTop(preset.marginTop); s.setMarginBottom(preset.marginBottom);
                    s.setMarginLeft(preset.marginLeft); s.setMarginRight(preset.marginRight);
                    if (preset.marginMode) s.setMarginMode(preset.marginMode);
                    // Chỉ sync classification khi đang booklet (in_nhanh/offset).
                    const ctx = paperContext;
                    if ((ctx === 'in_nhanh' || ctx === 'offset') && preset.classification) {
                        s.setPaperClassification(preset.classification);
                    }
                    if (preset.gripperMargin !== undefined) s.setGripperMargin(preset.gripperMargin);
                }
            }
        } else if (!isFreeFormsize(s.formsize)) {
            const ps = PREDEFINED_SIZES[s.formsize];
            if (ps && (ps.w !== s.customSheetWidth || ps.h !== s.customSheetHeight)) {
                s.setCustomSheetWidth(ps.w); s.setCustomSheetHeight(ps.h);
                if (formsizeChanged) {
                    const ctx = paperContext;
                    if (ctx === 'in_nhanh' || ctx === 'offset') {
                        s.setPaperClassification(ps.classification);
                    }
                    s.setGripperMargin(ps.gripperMargin);
                }
            }
        }
    }, [s.formsize, savedForms, s.customSheetWidth, s.customSheetHeight, activeTool, paperContext]);

    // ═══ formsize phải hợp context tool + migrate legacy id (SRA3/…) ═══
    useEffect(() => {
        const ctx = paperContext;
        const showsDefault = showsPredefinedSheets(ctx);

        // Legacy predefined đã gỡ (SRA3, B, Ledger…) → map về A3 / custom.
        if (!isFreeFormsize(s.formsize) && !isCustomPresetId(s.formsize) && !isKnownPredefined(s.formsize)) {
            s.setFormsize(showsDefault ? DEFAULT_FORMSIZE : 'custom');
            return;
        }

        let belongs: boolean | null = null;
        if (isCustomPresetId(s.formsize)) {
            const f = savedForms.find(x => x.id === s.formsize);
            belongs = f ? formUsages(f).includes(ctx) : null;
        } else if (isKnownPredefined(s.formsize)) {
            belongs = showsDefault;
        }
        if (belongs === false) {
            s.setFormsize(fallbackFormsizeForContext(ctx, savedForms));
        }
    }, [s.paperClassification, s.formsize, savedForms, activeTool, paperContext]);

    const handleSettingsApply = useCallback((w: number, h: number, mT: number, mB: number, mL: number, mR: number, mMode: 'labels_only' | 'include_marks', classification: 'offset' | 'in_nhanh', gripper: number) => {
        s.setCustomSheetWidth(w); s.setCustomSheetHeight(h);
        s.setMarginTop(mT); s.setMarginBottom(mB); s.setMarginLeft(mL); s.setMarginRight(mR);
        s.setMarginMode(mMode);
        if (paperContext === 'in_nhanh' || paperContext === 'offset') {
            s.setPaperClassification(classification);
        }
        s.setGripperMargin(gripper);
        if (!isFreeFormsize(s.formsize) && !isCustomPresetId(s.formsize)) {
            const ps = PREDEFINED_SIZES[s.formsize];
            if (ps && (ps.w !== w || ps.h !== h)) s.setFormsize('custom');
        }
    }, [s, paperContext]);

    // ═══ Side Effects ═══
    useEffect(() => { onBleedUpdate?.(s.showBleedView, s.bleed); }, [s.showBleedView, s.bleed, onBleedUpdate]);

    useEffect(() => {
        if (s.taskMode === 'booklet') {
            s.setMarkType(s.scaleMode !== '100' ? 'guillotine' : 'none');
        }
    }, [s.scaleMode, s.taskMode]);

    // Safety net: setTaskMode / restoreTaskModeForTool / switchToolProfile đã
    // đồng bộ layoutType ngay. Effect này chỉ vá state lệch (profile cũ, hot-reload).
    useEffect(() => {
        if (s.taskMode === 'step_repeat') {
            if (s.layoutType !== 'repeat') s.setLayoutType('repeat');
        } else if (
            (s.taskMode === 'nup' || s.taskMode === 'sticker_imposer')
            && s.layoutType === 'repeat'
        ) {
            s.setLayoutType('sequential');
        }
    }, [s.taskMode, s.layoutType]);

    useEffect(() => {
        // BOOKLET (audit 2026-07-31 §A.1): hai kiểu này không hỗ trợ Cut & Stack
        // phase-2; dán đối lưng phải giữ đúng bất biến in một mặt.
        if ((s.signatureMode === 'cut_stacks' || s.signatureMode === 'flush_mount') && s.scaleMode === 'cut_stack') {
            s.setScaleMode('100');
        }
    }, [s.signatureMode, s.scaleMode]);

    // Persistence is now handled automatically by Zustand persist middleware in useImposerSettingsStore.ts

    // Auto shape detection — chạy khi đổi file/công cụ.
    // QUAN TRỌNG: nếu chưa có selectionFileId (vd file > 20MB không được pre-upload
    // nền ở ImpositionTab), TỰ upload tại đây — không phụ thuộc kích thước — để nhận
    // diện luôn chạy. Trước đây file lớn không upload → detect-shape không gọi →
    // mọi trang hiển thị "Đặc biệt".
    useEffect(() => {
        if (!dieGeometryMode) {
            setIsDetectingShape(false);
            return;
        }

        setCompletedShapeDetectionKey('');

        // 1 Dao + theo kích thước trang: đường cắt là hình chữ nhật full trang.
        // Không gọi detect-shape vì không dùng đường khuôn; lấy kích thước đã đọc từ pdf-meta.
        if (pageSizedOneDao) {
            const pageState = buildPageSizedShapeState(
                s.sourcePageDims,
                s.sourcePageDim,
                sourceTotalPages,
            );
            setDetectedShapesByPage(pageState.shapes);
            setDetectedDimensionsByPage(pageState.dimensions);
            setDetectedShapeParamsByPage(pageState.params);
            setDetectedShapeType('RECTANGLE');
            setDetectedShapeParams(null);
            setCompletedShapeDetectionKey(expectedShapeDetectionKey);
            setIsDetectingShape(false);
            return;
        }

        let cancelled = false;
        const controller = new AbortController();

        const run = async () => {
            // Chọn cách gửi: desktop (Tauri) → đọc TRỰC TIẾP theo path (KHÔNG upload,
            // nhanh hơn nhiều với file lớn). Web → cần fileId (upload nếu chưa có).
            const isPdf = pdfFile && (pdfFile.type === 'application/pdf' || pdfFile.name?.toLowerCase().endsWith('.pdf'));

            let reqBody: any = null;
            if (isTauriRuntime && shapeLocalPath && isPdf) {
                reqBody = { path: shapeLocalPath };
            } else if (selectionFileId) {
                reqBody = { fileId: selectionFileId };
            } else {
                // Web mode chưa có fileId → upload rồi để effect chạy lại để nhận diện.
                if (isPdf) {
                    try {
                        setIsDetectingShape(true);
                        const up = await uploadPDF(pdfFile);
                        if (!cancelled && up?.id) setSelectionFileId(up.id);
                    } catch (e) {
                        console.error('Upload for shape detection failed:', e);
                    } finally {
                        if (!cancelled) setIsDetectingShape(false);
                    }
                }
                return;
            }

            // Reset shapes truoc de tranh giu shapes cu khi doi file
            setDetectedShapesByPage({});
            setDetectedDimensionsByPage({});
            setDetectedShapeParamsByPage({});
            setIsDetectingShape(true);
            const _tDetect = performance.now();
            void previewPerfLog('detect-shape START', {
                tool: activeTool,
                via: reqBody.path ? 'path' : 'fileId',
            });
            try {
                const res = await authenticatedFetch(`${getApiUrl()}/imposition/detect-shape`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(reqBody),
                    signal: controller.signal,
                });
                const data = await res.json();
                // SSOT (die-shape-detection-ssot — R4.6): cập nhật ngay cả khi
                // một số trang là CUSTOM. Backend chỉ trả success=false khi lỗi
                // cấp file; còn lại luôn có mảng shapes (trang lỗi → 'CUSTOM').
                if (!cancelled && res.ok && Array.isArray(data.shapes) && data.shapes.length > 0) {
                    const newShapes: Record<number, string> = {};
                    data.shapes.forEach((s: string, i: number) => { newShapes[i] = s; });
                    if (data.dimensions) {
                        const newDims: Record<number, { w: number, h: number }> = {};
                        data.dimensions.forEach((d: any, i: number) => { newDims[i] = d; });
                        setDetectedDimensionsByPage(newDims);
                    }
                    const newParams: Record<number, any> = {};
                    if (data.shapeParams) {
                        data.shapeParams.forEach((p: any, i: number) => { newParams[i] = p; });
                        setDetectedShapeParamsByPage(newParams);
                    }
                    setDetectedShapesByPage(newShapes);
                    setCompletedShapeDetectionKey(expectedShapeDetectionKey);
                    const activeIdx = (viewerPageOrder?.length
                        ? (viewerPageOrder[(viewerActivePage || 1) - 1] ?? 1) - 1
                        : (viewerActivePage || 1) - 1);
                    if (newShapes[activeIdx]) setDetectedShapeType(newShapes[activeIdx]);
                    if (newParams[activeIdx]) setDetectedShapeParams(newParams[activeIdx]);
                    if (Array.isArray(data.perPage)) {
                        const failed = data.perPage.filter((p: any) => p && p.ok === false);
                        if (failed.length > 0) {
                            console.warn(t('imposition.imposerDashboard:detect_shape_trang_loi_custom'), failed);
                        }
                    }
                    void previewPerfLog('detect-shape OK', {
                        ms: Math.round(performance.now() - _tDetect),
                        pages: data.shapes.length,
                        shapes: data.shapes.slice(0, 12).join(','),
                    });
                } else if (!cancelled) {
                    void previewPerfLog('detect-shape EMPTY/FAIL', {
                        ms: Math.round(performance.now() - _tDetect),
                        status: res.status,
                        ok: res.ok,
                    });
                }
            } catch (err: any) {
                if (err?.name !== 'AbortError') {
                    console.error('Auto shape detection failed:', err);
                    void previewPerfLog('detect-shape ERROR', { err: String(err?.message || err).slice(0, 120) });
                }
            }
            finally { if (!cancelled) setIsDetectingShape(false); }
        };

        run();
        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [
        activeTool,
        detectionSourceKey,
        pdfFile,
        pageSizedOneDao,
        pageSizedShapeStateKey,
        dieGeometryMode,
    ]);

    // Auto Catalog: fetch page dimensions + plan
    useEffect(() => {
        setGuillotineMetadata({ source: pdfFile, dimensions: [], complete: false });
        if (!pdfFile) return;
        let isActive = true;
        s.setSourcePageDim(null); // Clear old cache immediately
        s.setSourcePageDims([]);
        s.setSourceMediaPageDim(null);
        s.setSourceMediaPageDims([]);
        const loadPdfMetadata = async () => {
            if (pdfFile && !(pdfFile.type === 'application/pdf' || pdfFile.name.toLowerCase().endsWith('.pdf'))) {
                if (isActive) {
                    setGuillotineMetadata({ source: pdfFile, dimensions: [], complete: true });
                }
                return; // Do not attempt to load metadata for non-PDFs (like images)
            }
            try {
                if ((window as any).__TAURI_INTERNALS__ && (pdfFile as any).path && (pdfFile.type === 'application/pdf' || pdfFile.name.toLowerCase().endsWith('.pdf'))) {
                    // Use Python backend to fetch metadata (handles TrimBox, UserUnit, and doesn't load file into RAM)
                    try {
                        const filePath = (pdfFile as any).path;
                        const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8321';
                        const res = await fetch(`${apiUrl}/api/imposition/pdf-meta`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ path: filePath })
                        });
                        
                        if (res.ok) {
                            const meta = await res.json() as { pages?: ImpositionPdfMetaPage[] };
                            if (isActive && meta.pages && meta.pages.length > 0) {
                                const pages = meta.pages;
                                // meta.pages[0].width_pt is already TrimBox & UserUnit adjusted by Python backend
                                s.setSourcePageDim({ w: pages[0].width_pt, h: pages[0].height_pt });
                                s.setSourcePageDims(pages.map((p) => ({ w: p.width_pt, h: p.height_pt })));
                                const mediaDims = pages.map((p) => ({
                                    w: p.media_width_pt ?? p.width_pt,
                                    h: p.media_height_pt ?? p.height_pt,
                                }));
                                s.setSourceMediaPageDim(mediaDims[0]);
                                s.setSourceMediaPageDims(mediaDims);
                                setGuillotineMetadata({
                                    source: pdfFile,
                                    dimensions: pages.map((p) => ({
                                        w: p.guillotine_width_pt ?? p.media_width_pt ?? p.width_pt,
                                        h: p.guillotine_height_pt ?? p.media_height_pt ?? p.height_pt,
                                    })),
                                    complete: true,
                                });
                                return; // Success, skip fallback
                            }
                        } else {
                        }
                    } catch (err) {
                        console.warn("Failed to fetch pdf-meta from Python backend", err);
                    }
                    
                    // Fallback to Rust (will get MediaBox without TrimBox, but better than crashing)
                    const { invoke } = await import('@tauri-apps/api/core');
                    const metadata: any = await invoke('get_pdf_metadata', { filePath: (pdfFile as any).path });
                    if (isActive && metadata.widthPt && metadata.heightPt) {
                        s.setSourcePageDim({ w: metadata.widthPt, h: metadata.heightPt });
                        s.setSourceMediaPageDim({ w: metadata.widthPt, h: metadata.heightPt });
                        if (metadata.allDims) {
                            const dimsArr = [];
                            for (let i = 1; i <= Object.keys(metadata.allDims).length; i++) {
                                const d = metadata.allDims[i.toString()];
                                if (d) dimsArr.push({ w: d.widthPt, h: d.heightPt });
                            }
                            const resolvedDims = dimsArr.length > 0 ? dimsArr : [{ w: metadata.widthPt, h: metadata.heightPt }];
                            s.setSourcePageDims(resolvedDims);
                            s.setSourceMediaPageDims(resolvedDims);
                            setGuillotineMetadata({ source: pdfFile, dimensions: resolvedDims, complete: true });
                        } else {
                            const resolvedDims = [{ w: metadata.widthPt, h: metadata.heightPt }];
                            s.setSourcePageDims(resolvedDims);
                            s.setSourceMediaPageDims(resolvedDims);
                            setGuillotineMetadata({ source: pdfFile, dimensions: resolvedDims, complete: true });
                        }
                    } else if (isActive) {
                        setGuillotineMetadata({ source: pdfFile, dimensions: [], complete: true });
                    }
                    return; // DO NOT run pdf-lib on dummy File objects, it will crash!
                }
                
                // Only run pdf-lib if we actually have a real File buffer (e.g. web version)
                if (pdfFile.size > 0) {
                    const { PDFDocument } = await import('pdf-lib');
                    const buf = await pdfFile.arrayBuffer();
                    const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
                    if (isActive && doc.getPageCount() > 0) {
                        const { PDFName, PDFArray, PDFNumber } = await import('pdf-lib');
                        const mediaPageDims: Array<{ w: number; h: number }> = [];
                        const pageDims = doc.getPages().map((page) => {
                            const trimNode = page.node.lookupMaybe(PDFName.of('TrimBox'), PDFArray);
                            const userUnitNode = page.node.lookupMaybe(PDFName.of('UserUnit'), PDFNumber);
                            const userUnit = userUnitNode ? userUnitNode.value() : 1.0;
                            let w = page.getSize().width;
                            let h = page.getSize().height;
                            const media = page.getMediaBox();
                            mediaPageDims.push({ w: media.width * userUnit, h: media.height * userUnit });
                            if (trimNode) {
                                const rect = trimNode.asRectangle();
                                w = rect.width;
                                h = rect.height;
                            }
                            return { w: w * userUnit, h: h * userUnit };
                        });
                        s.setSourcePageDim(pageDims[0]);
                        s.setSourcePageDims(pageDims);
                        s.setSourceMediaPageDim(mediaPageDims[0]);
                        s.setSourceMediaPageDims(mediaPageDims);
                        setGuillotineMetadata({ source: pdfFile, dimensions: mediaPageDims, complete: true });
                    } else if (isActive) {
                        setGuillotineMetadata({ source: pdfFile, dimensions: [], complete: true });
                    }
                } else if (isActive) {
                    setGuillotineMetadata({ source: pdfFile, dimensions: [], complete: true });
                }
            } catch (e) {
                console.error('Failed to load PDF dimensions', e);
                if (isActive) {
                    // Giữ đường preview/backend cũ làm fallback; không khóa nút Bình vĩnh viễn.
                    setGuillotineMetadata({ source: pdfFile, dimensions: [], complete: true });
                }
            }
        };
        loadPdfMetadata();
        return () => { isActive = false; };
    }, [pdfFile]);

    // ═══ Tự nhận bleed từ file (TrimBox vs MediaBox) → điền sẵn vào ô bleed UI ═══
    // Chỉ điền 1 lần khi MỞ FILE MỚI; người dùng vẫn tự sửa lại bleed mong muốn sau đó.
    const _bleedAutoFileRef = useRef<string | null>(null);
    useEffect(() => {
        if (!pdfFile) return;
        if (activeTool === 'sticker_imposer' || activeTool === 'cnc_imposer') return;
        const isPdf = pdfFile.type === 'application/pdf' || pdfFile.name?.toLowerCase().endsWith('.pdf');
        if (!isPdf) return;
        const filePath = (pdfFile as any).path;
        if (!filePath) return;
        const fileKey = String(filePath);
        if (_bleedAutoFileRef.current === fileKey) return; // đã auto-điền cho file này
        let active = true;
        (async () => {
            try {
                const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:8321';
                const res = await fetch(`${apiUrl}/api/imposition/pdf-meta`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: filePath }),
                });
                if (!res.ok || !active) return;
                const meta = await res.json();
                if (!active) return;
                _bleedAutoFileRef.current = fileKey; // đánh dấu đã xử lý file này
                if (typeof meta.detected_bleed_mm === 'number' && meta.detected_bleed_mm > 0) {
                    s.setBleed(meta.detected_bleed_mm);
                }
            } catch { /* bỏ qua: giữ bleed UI hiện tại */ }
        })();
        return () => { active = false; };
    }, [pdfFile, activeTool]);

    // Auto Catalog: recalculate optimizer + planner
    useEffect(() => {
        if (!s.autoCatalog || !s.sourcePageDim || !sourceTotalPages || sourceTotalPages < 4) {
            s.setOptimalData(null); s.setCatalogPreview(''); s.setCatalogJobsState(null);
            return;
        }
        // Resolve khổ ĐÍCH từ formsize + savedForms (SSOT) — không phụ thuộc mirror có thể lệch.
        const _press = resolvePressSheetDims();
        const sheetW = _press.w;
        const sheetH = _press.h;

        import('../../lib/imposerEngine/SheetOptimizer').then(({ optimizeMasterSig }) => {
            const optResult = optimizeMasterSig(
                { width: s.sourcePageDim.w, height: s.sourcePageDim.h },
                { width: sheetW, height: sheetH },
                { gripperMargin: s.gripperMargin, marginTop: s.marginTop, marginLeft: s.marginLeft, marginRight: s.marginRight, bleed: s.bleed, gapX: s.gapX, gapY: s.gapY }
            );
            s.setOptimalData(optResult);
            if (optResult.recommended) {
                import('../../lib/imposerEngine/CatalogPlanner').then(({ planCatalog }) => {
                    let targetMasterSig = optResult.recommended!.pagesPerSig;
                    if (s.catalogMasterSigOverride !== 'auto') targetMasterSig = parseInt(s.catalogMasterSigOverride, 10);
                    const planRes = planCatalog({
                        totalPages: sourceTotalPages,
                        bindingMode: s.signatureMode === 'thread' ? 'perfect' : 'saddle',
                        hasSeparateCover: s.catalogHasCover,
                        masterSig: targetMasterSig as any,
                        remainderPlacement: s.catalogRemainderPlacement,
                    });
                    s.setCatalogPreview(planRes.report);
                    s.setCatalogJobsState(planRes.jobs);
                });
            } else {
                s.setCatalogPreview(t('imposition.imposerDashboard:loi_kho_giay_qua_be'));
                s.setCatalogJobsState(null);
            }
        });
    }, [s.autoCatalog, s.sourcePageDim, sourceTotalPages, s.formsize, savedForms, s.customSheetWidth, s.customSheetHeight, s.gripperMargin, s.marginTop, s.marginLeft, s.marginRight, s.bleed, s.gapX, s.gapY, s.signatureMode, s.catalogHasCover, s.catalogMasterSigOverride, s.catalogRemainderPlacement]);

    // Batch layout reset + fetch
    useEffect(() => {
        s.setPreviewCapacities({});
        s.setFetchEpoch(e => e + 1);
    }, [s.formsize, s.customSheetWidth, s.customSheetHeight, s.marginLeft, s.marginRight, s.marginTop, s.marginBottom, s.gapX, s.gapY, s.gridStrategy, s.columns, s.rows, activeTool, detectedDimensionsByPage, detectedShapesByPage, detectedShapeParamsByPage, s.pontType, s.pontConfig,
        // Ảnh hưởng SỐ ô/tờ per-type (secondary_gap / bleed / cụm) → phải tính lại capacity.
        s.bleed, s.cutType, s.dieSizeMode, s.dieOffsetMm, s.fillBlockGap, s.splitGap, s.marginMode, s.markType, s.groupingStrategy, s.impositionUnit,
        s.clusterSizingMode, s.clusterCols, s.clusterRows, s.clusterTileW, s.clusterTileH, s.tileGapX, s.tileGapY,
        pdfFile, sourceTotalPages, viewerPageOrder, s.sourcePageDim, s.sourcePageDims, isDetectingShape, completedShapeDetectionKey, expectedShapeDetectionKey]);

    // ═══ BATCH CAPACITY: SỐ TEM/TỜ cho MỌI trang (cột "Tem/tờ" bảng nhập SL) ═══
    // Live preview (GridPreview) chỉ chạy 1 trang đang xem → previewCapacities chỉ có
    // key trang đó, các trang khác rơi về previewCapacity chung ("chọn loại nào thì số
    // đó áp cho hết"). Effect này gọi /preview-layouts-batch (dùng CHÍNH hàm export
    // compute_sticker_layout_for_page) để điền SỐ RIÊNG của TỪNG loại (đầy 1 tờ loại đó),
    // KHỚP output. Key theo cùng chỉ số trang single-preview dùng (previewCapacities[X]).
    const batchCapAbortRef = useRef<AbortController | null>(null);
    useEffect(() => {
        const isNupLike = s.taskMode === 'nup' || s.taskMode === 'step_repeat';
        const effectiveGrouping = dieGeometryMode || s.markType === 'guillotine'
            ? s.groupingStrategy : 'none';
        if ((!dieGeometryMode && !isNupLike) || sourceTotalPages <= 1 || !pdfFile) return;
        if (!batchCapacityDetectionReady(
            pageSheetMode ? 'nup' : activeTool,
            isDetectingShape,
            sourceTotalPages,
            previewDetectedShapesByPage,
            completedShapeDetectionKey === expectedShapeDetectionKey,
        )) return;

        let cancelled = false;
        const MM_TO_PT = 2.83465;
        const timer = setTimeout(async () => {
            try {
                // ── Nguồn file: working file (bake sửa viewer) — .path khi không sửa (Tauri). ──
                const isTauri = !!(window as any).__TAURI_INTERNALS__;
                let srcPath: string | undefined;
                let srcFileId: string | undefined;
                try {
                    const wf = await getWorkingFile();
                    if (isTauri && (wf as any)?.path) {
                        srcPath = (wf as any).path;
                    } else {
                        const bytes = new Uint8Array(await wf.arrayBuffer());
                        if (isTauri) {
                            const { tempDir, join } = await import('@tauri-apps/api/path');
                            const { writeFile } = await import('@tauri-apps/plugin-fs');
                            const tPath = await join(await tempDir(), `prynx_batchcap_${Date.now()}.pdf`);
                            await writeFile(tPath, bytes);
                            srcPath = tPath;
                        } else {
                            const up = await uploadPDF(new File([bytes], 'batchcap.pdf', { type: 'application/pdf' }));
                            if (up?.id) srcFileId = up.id;
                        }
                    }
                } catch (e) {
                    console.warn('[BatchCapacity] resolve source failed:', e);
                    return;
                }
                if (cancelled || (!srcPath && !srcFileId)) return;

                // ── Lề hiệu dụng (mirror khối GridPreview 972-991) ──
                let effMarginTop = s.marginTop || 0;
                let effMarginBottom = s.marginBottom || 0;
                let effMarginLeft = s.marginLeft || 0;
                let effMarginRight = s.marginRight || 0;
                // Gripper chỉ N-up offset — không rò sang tem/CNC.
                if (
                    s.gripperMargin > 0
                    && !dieGeometryMode
                    && s.paperClassification === 'offset'
                    && s.taskMode !== 'booklet'
                ) {
                    effMarginBottom += s.gripperMargin;
                }
                const effMarginMode = dieGeometryMode ? 'labels_only' : s.marginMode;
                if (effMarginMode === 'include_marks' && s.markType && s.markType !== 'none') {
                    const markSpace = (s.marksConfig?.length ?? 5.0) + (s.marksConfig?.distance ?? 3.0);
                    effMarginTop += markSpace; effMarginBottom += markSpace;
                    effMarginLeft += markSpace; effMarginRight += markSpace;
                }

                const splitGapMm = resolveImpositionSplitGap({
                    dieGeometryMode,
                    gapX: s.gapX,
                    gapY: s.gapY,
                    clusterGap: s.clusterGap,
                    clusterGapMode: s.clusterGapMode,
                    markType: s.markType,
                    markLength: s.marksConfig?.length,
                    markOffset: s.marksConfig?.distance,
                });

                const press = resolvePressSheetDims();
                const usableWmm = Math.max(0, press.w - effMarginLeft - effMarginRight);
                const usableHmm = Math.max(0, press.h - effMarginTop - effMarginBottom);
                if (usableWmm <= 0 || usableHmm <= 0) return;

                // ── pages: mỗi trang gửi shape/props/dims đã nhận diện (key theo CHỈ SỐ
                // TRANG GỐC — GIỐNG single preview safePageIdx). Populate MỌI trang. ──
                const pages = [];
                for (let X = 0; X < sourceTotalPages; X++) {
                    const dim = resolvePreviewItemDimension(
                        pageSheetMode ? 'nup' : activeTool,
                        X,
                        previewDetectedDimensionsByPage,
                        previewSourceDimensionsByPage,
                        sourcePageDimForGeometry,
                    );
                    pages.push({
                        page_idx: X,
                        shape_type: (dieGeometryMode ? (previewDetectedShapesByPage[X] || 'CUSTOM') : 'RECTANGLE'),
                        shape_props: dieGeometryMode ? (previewDetectedShapeParamsByPage[X] || {}) : {},
                        // item_w/h là kích thước trang đầy đủ; backend trừ bleed đúng một lần.
                        item_w: (typeof dim?.w === 'number' ? dim.w : (sourcePageDimForGeometry?.w || 0)),
                        item_h: (typeof dim?.h === 'number' ? dim.h : (sourcePageDimForGeometry?.h || 0)),
                    });
                }
                if (!dieGeometryMode && pages.some((p) =>
                    !Number.isFinite(p.item_w) || !Number.isFinite(p.item_h)
                    || p.item_w <= 0 || p.item_h <= 0
                )) return;


                const body = {
                    usable_w: usableWmm * MM_TO_PT,
                    usable_h: usableHmm * MM_TO_PT,
                    gap_x: (s.gapX || 0) * MM_TO_PT,
                    gap_y: (s.gapY || 0) * MM_TO_PT,
                    strategy: s.gridStrategy || 'optimal_auto',
                    pages,
                    ...(srcPath ? { path: srcPath } : { file_id: srcFileId }),
                    cols: s.columns || 0,
                    rows: s.rows || 0,
                    bleed: (s.bleed || 0) * MM_TO_PT,
                    task_mode: s.taskMode,
                    is_die_cut: dieGeometryMode,
                    page_sheet_mode: pageSheetMode,
                    pont_config: pontSettingsMode && s.pontType !== 'none' ? s.pontConfig : null,
                    sheet_w: press.w * MM_TO_PT,
                    sheet_h: press.h * MM_TO_PT,
                    margin_left: effMarginLeft * MM_TO_PT,
                    margin_right: effMarginRight * MM_TO_PT,
                    margin_top: effMarginTop * MM_TO_PT,
                    margin_bottom: effMarginBottom * MM_TO_PT,
                    imposer_mode: activeTool === 'cnc_imposer' ? 'cnc' : undefined,
                    cut_type: dieGeometryMode ? (s.cutType || 'default') : undefined,
                    die_size_mode: dieGeometryMode ? (s.dieSizeMode || 'die') : undefined,
                    die_offset_mm: dieGeometryMode ? (s.dieOffsetMm ?? 0) : undefined,
                    fill_block_gap: dieGeometryMode ? (s.fillBlockGap ?? 0) : undefined,
                    split_gap: splitGapMm * MM_TO_PT,
                    grouping_strategy: effectiveGrouping,
                    cluster_combine_mode: s.clusterCombineMode,
                    cluster_sizing_mode: s.clusterSizingMode,
                    cluster_cols: s.clusterCols,
                    cluster_rows: s.clusterRows,
                    cluster_w: s.clusterTileW ? s.clusterTileW * MM_TO_PT : 0,
                    cluster_h: s.clusterTileH ? s.clusterTileH * MM_TO_PT : 0,
                    tile_gap_x: (s.tileGapX || 0) * MM_TO_PT,
                    tile_gap_y: (s.tileGapY || 0) * MM_TO_PT,
                };

                if (batchCapAbortRef.current) batchCapAbortRef.current.abort();
                const controller = new AbortController();
                batchCapAbortRef.current = controller;

                const _tBatch = performance.now();
                void previewPerfLog('batch-capacity START', { pages: pages.length });
                const res = await authenticatedFetch(`${getApiUrl()}/imposition/preview-layouts-batch`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: controller.signal,
                });
                if (cancelled || !res.ok) {
                    void previewPerfLog('batch-capacity FAIL', {
                        ms: Math.round(performance.now() - _tBatch),
                        status: res.status,
                    });
                    return;
                }
                const data = await res.json();
                if (cancelled || !data?.success || !data.capacities) return;
                void previewPerfLog('batch-capacity OK', {
                    ms: Math.round(performance.now() - _tBatch),
                    keys: Object.keys(data.capacities || {}).length,
                });

                // Merge (không đè key trang đang xem do single preview vừa ghi — cùng hàm
                // nên KHỚP; merge để không mất số đã có nếu batch trang nào lỗi = 0).
                const caps: Record<number, number> = {};
                Object.keys(data.capacities).forEach((k) => {
                    const v = Number(data.capacities[k]) || 0;
                    if (v > 0) caps[Number(k)] = v;
                });
                if (Object.keys(caps).length > 0) {
                    s.setPreviewCapacities({ ...s.previewCapacities, ...caps });
                }
            } catch (e: any) {
                if (e?.name !== 'AbortError') console.warn('[BatchCapacity] fetch failed:', e);
            }
        }, 350);

        return () => { cancelled = true; clearTimeout(timer); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [s.fetchEpoch]);

    // System merge files
    useEffect(() => {
        if (systemMergeFiles?.length > 0) {
            setActiveTool('merge');
            setMergeSettings(prev => ({ ...prev, mode: 'merge_files', filesToMerge: [...(prev.filesToMerge || []), ...systemMergeFiles] }));
        }
    }, [systemMergeFiles]);


    // ═══ Execute Handler ═══
    const handleExecute = async () => {
        // UIUX (audit 2026-07-27 §B-21) fix-verify: Enter từ ô SL (onRequestExecute)
        // từng bypass guard disabled của nút Bình — chặn cùng điều kiện với nút.
        if (isProcessing || !pdfFile) return;
        if (waitingForGuillotineSize) {
            toast.info(t('lib.pdfImposer:dang_tinh_toan_kich_thuoc_tu_dong'));
            return;
        }
        if (s.taskMode === 'booklet') {
            const buildActiveBookReport = (sheetWidth: number, sheetHeight: number) => toBookReportRenderConfig(
                s.bookReportDisplay,
                {
                    pageCount: bookReportPageCount || 0,
                    finishedWidthMm: s.sourcePageDim
                        ? Math.max(0, s.sourcePageDim.w * 0.352778 - 2 * (s.bleed || 0)) : undefined,
                    finishedHeightMm: s.sourcePageDim
                        ? Math.max(0, s.sourcePageDim.h * 0.352778 - 2 * (s.bleed || 0)) : undefined,
                    bindingLabel: BOOK_REPORT_BINDING_LABELS[s.signatureMode] || '',
                    paperSizeLabel: sheetWidth > 0 && sheetHeight > 0
                        ? `${Math.round(sheetWidth)} × ${Math.round(sheetHeight)} mm` : '',
                },
            );
            if (s.autoCatalog && onStartCatalogPlan && s.optimalData?.recommended) {
                // Khổ ĐÍCH = SSOT (resolve theo formsize + swap offset) — đồng nhất optimizer.
                const _press = resolvePressSheetDims();
                const sheetW = _press.w;
                const sheetH = _press.h;
                let targetMasterSig = s.optimalData.recommended.pagesPerSig;
                if (s.catalogMasterSigOverride !== 'auto') targetMasterSig = parseInt(s.catalogMasterSigOverride, 10);
                onStartCatalogPlan(
                    { totalPages: sourceTotalPages || 0, bindingMode: s.signatureMode === 'thread' ? 'perfect' : 'saddle', hasSeparateCover: s.catalogHasCover, masterSig: targetMasterSig, remainderPlacement: s.catalogRemainderPlacement },
                    { sheetWidth: sheetW, sheetHeight: sheetH, bleed: s.bleed, markType: s.markType, markOffset: s.marksConfig?.distance, markLength: s.marksConfig?.length, markThickness: s.marksConfig?.thickness, markStyle: s.marksConfig?.style === 2 ? 'japanese' : 'default', gripperMargin: s.gripperMargin, marginTop: s.marginTop, marginLeft: s.marginLeft, marginRight: s.marginRight, paperThickness: s.paperThickness, gapX: s.gapX, gapY: s.gapY, spreadDistribution: s.spreadDistribution, bookReport: buildActiveBookReport(sheetW, sheetH), spawnNewTab: s.spawnNewTabByTool[activeTool] ?? true } as any
                );
                return;
            }
            
            // Khổ ĐÍCH = SSOT (resolve theo formsize + swap offset). KHÔNG đọc mirror thô
            // (có thể lệch). Truyền formsize='custom' + dims đã resolve để handleStartBooklet
            // dùng thẳng, tránh re-resolve lệch (bug: khổ predefined offset không được swap).
            const _press = resolvePressSheetDims();
            const effSheetW = _press.w;
            const effSheetH = _press.h;

            onStartBooklet({
                paperClassification: s.paperClassification,
                signatureMode: s.signatureMode, foliosize: s.foliosize,
                formsize: (s.scaleMode === '100') ? 'auto_100' : 'custom',
                customSheetWidth: effSheetW, customSheetHeight: effSheetH,
                bleed: s.bleed, paperThickness: s.paperThickness, markType: s.markType,
                markOffset: s.marksConfig.distance, markLength: s.marksConfig.length, markThickness: s.marksConfig.thickness,
                markStyle: s.marksConfig.style === 2 ? 'japanese' : 'default',
                spawnNewTab: s.spawnNewTabByTool[activeTool] ?? true,
                // Fold-pattern registry được định nghĩa theo surface F,B,F,B. Digital không được
                // nhận bất kỳ knob Offset nào; Offset có pattern cũng phải dùng thứ tự normal.
                interleave: s.paperClassification === 'in_nhanh' || !!s.foldPattern ? 'normal' : s.interleave,
                scaleMode: s.paperClassification === 'offset' ? 'chain_nup' : (s.scaleMode === 'cut_stack' ? 'cut_stack' : s.scaleMode),
                foldPattern: s.paperClassification === 'offset' && s.foldPattern ? s.foldPattern : undefined,
                gripperMargin: s.paperClassification === 'offset' ? s.gripperMargin : undefined,
                marginTop: s.marginTop, marginBottom: s.marginBottom, marginLeft: s.marginLeft, marginRight: s.marginRight,
                marginMode: s.marginMode, gapX: s.gapX, gapY: s.gapY,
                spreadDistribution: s.spreadDistribution,
                gutterMargin: (s.signatureMode === 'continuous' || s.signatureMode === 'thread') ? s.gutterMargin : undefined,
                separateCover: s.separateCover && (s.signatureMode === 'continuous' || s.signatureMode === 'thread') ? true : undefined,
                coverPageCount: s.separateCover ? s.coverPageCount : undefined,
                blankPlacement: s.blankPlacement,
                bookReport: buildActiveBookReport(effSheetW, effSheetH),
            });
        } else {
            // 2 mặt N-Up cắt xén — chặn sớm các case không hợp lệ (tránh user bấm Bình rồi lỗi backend).
            if (
                s.duplexFlow === 'double'
                && activeTool !== 'sticker_imposer'
                && activeTool !== 'cnc_imposer'
            ) {
                const _lt = s.taskMode === 'step_repeat' ? 'repeat' : s.layoutType;
                if (_lt === 'cut_stacks') {
                    toast.error(
                        t('imposition.imposerDashboard:che_do_xep_chong_chua_ho_tro_2_mat_chon'),
                    );
                    return;
                }
                if (sourceTotalPages > 0 && sourceTotalPages % 2 !== 0) {
                    toast.error(
                        t('imposition.imposerDashboard:binh_2_mat_bat_buoc_so_trang_chan_file_hien_le', { n: sourceTotalPages }),
                    );
                    return;
                }
            }

            let finalFormsize = s.formsize;
            if (s.formsize.startsWith('custom_') || s.formsize === 'custom') finalFormsize = 'custom';
            
            const _pressNup = resolvePressSheetDims();
            const effSheetW = _pressNup.w;
            const effSheetH = _pressNup.h;

            // Gripper chỉ cộng lề dưới khi N-up + classification offset (máy offset).
            // Không cộng cho bế tem/CNC — tránh rò nhíp từ session booklet offset.
            let effMarginBottom = s.marginBottom;
            const _isDieCutOrCncExec = dieGeometryMode;
            if (
                s.gripperMargin > 0
                && !_isDieCutOrCncExec
                && s.paperClassification === 'offset'
                && s.taskMode !== 'booklet'
            ) {
                effMarginBottom += s.gripperMargin;
            }

            // splitGap (khe khối chính↔khối phụ của L-shape).
            //  - Bình bài XÉN (guillotine N-Up): 2×markClearance (đỉnh dấu cắt 2 cụm chạm) / clusterGap.
            //  - Tem bế / bế rớt (die-cut/CNC): = HỞ TEM. KHÔNG dùng clusterGap (mặc định 10mm của
            //    cluster-tile) và KHÔNG dùng khe dấu cắt guillotine → tránh rò 6/10mm sang tem bế.
            const splitGap = resolveImpositionSplitGap({
                dieGeometryMode,
                gapX: s.gapX,
                gapY: s.gapY,
                clusterGap: s.clusterGap,
                clusterGapMode: s.clusterGapMode,
                markType: s.markType,
                markLength: s.marksConfig?.length,
                markOffset: s.marksConfig?.distance,
            });

            // Tự động lưu: nếu đã tick nhưng CHƯA chọn thư mục → hỏi ngay (không im lặng).
            let autoFolder = s.savePrint.lastFolder;
            if (stickerProductMode && s.savePrint.autoSave && !autoFolder) {
                try {
                    const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
                    const dir = await openDialog({ directory: true, multiple: false, title: t('imposition.imposerDashboard:da_bat_tu_dong_luu_chon_thu_muc_luu') });
                    if (typeof dir === 'string') { autoFolder = dir; s.setSavePrint({ lastFolder: dir }); }
                } catch { /* ignore */ }
            }

            // Chia cọc row/column CHỈ cho N-Up xén (guillotine).
            // Tem bế/CNC: LUÔN 'none' — clusterMode rò từ N-Up sẽ khiến engine chia
            // usable_h/w đôi → tem chỉ nằm 1 dải trên tờ (không lấp đầy).
            // (cluster_tile die-cut là groupingStrategy riêng, không dùng clusterMode.)
            const _clusterAppliesNup = !dieGeometryMode && s.markType === 'guillotine' && (
                (s.taskMode === 'nup' && s.layoutType === 'ratio_stack')
                || s.taskMode === 'step_repeat'
            );
            const effClusterMode = _clusterAppliesNup ? s.clusterMode : 'none';

            onStartNup({
                layoutType: s.taskMode === 'step_repeat'
                    ? 'repeat'
                    : (s.layoutType === 'repeat' ? 'sequential' : s.layoutType),
                formsize: finalFormsize, customSheetWidth: effSheetW, customSheetHeight: effSheetH,
                bleed: s.bleed, columns: s.columns, rows: s.rows, gridStrategy: s.gridStrategy,
                groupingStrategy: s.taskMode === 'step_repeat'
                    ? 'none'
                    : (dieGeometryMode || s.markType === 'guillotine' ? s.groupingStrategy : 'none'),
                clusterMode: effClusterMode, clusterCount: s.clusterCount, clusterGap: s.clusterGap,
                clusterGapMode: s.clusterGapMode, clusterDistribution: s.clusterDistribution, clusterBorder: s.clusterBorder,
                splitGap: splitGap,
                gapX: s.gapX, gapY: s.gapY, marginTop: s.marginTop, marginBottom: effMarginBottom, marginLeft: s.marginLeft, marginRight: s.marginRight,
                marginMode: dieGeometryMode ? 'labels_only' : s.marginMode,
                duplexFlow: pageSheetMode ? 'normal' : s.duplexFlow, align: s.align, mirrorAlign: true,
                duplexFlipEdge: s.duplexFlipEdge,
                // §MG-A2: ngưỡng in dư cho phép gom bản kẽm (Dàn nhiều kích thước).
                mixedExcessPercent: s.mixedExcessPercent,
                markType: getImposerCapability(pageSheetMode ? 'guillotine' : activeTool === 'sticker_imposer' ? 'diecut' : activeTool === 'cnc_imposer' ? 'cnc' : 'guillotine').supportsMarks ? s.markType : 'none',
                markOffset: s.marksConfig.distance, markLength: s.marksConfig.length, markThickness: s.marksConfig.thickness,
                markStyle: s.marksConfig.style === 2 ? 'japanese' : 'default',
                cutType: dieGeometryMode ? s.cutType : undefined,
                dieSizeMode: dieGeometryMode ? s.dieSizeMode : undefined,
                dieOffsetMm: dieGeometryMode ? s.dieOffsetMm : undefined,
                fillBlockGap: dieGeometryMode ? s.fillBlockGap : undefined,
                pontType: pontSettingsMode ? s.pontType : 'none',
                pontConfig: pontSettingsMode ? s.pontConfig : undefined,
                separateCutPage: pageSheetMode ? true : (stickerGeometryMode ? s.separateCutPage : false),
                pontsOnCutFile: pontSettingsMode ? s.pontsOnCutFile : false,
                isDieCutMode: dieGeometryMode,
                pageSheetMode,
                shapeType: dieGeometryMode ? detectedShapeType : 'RECTANGLE',
                shapeParams: dieGeometryMode ? detectedShapeParams : null,
                targetQuantity: s.targetQuantity, targetQuantitiesByPage: s.targetQuantitiesByPage,
                // UI hiển thị ?? true khi chưa tick; PHẢI dùng cùng fallback lúc chạy
                // (trước đây !!undefined = false → checkbox tick nhưng vẫn đè tab hiện tại).
                detectedShapesByPage: dieGeometryMode ? detectedShapesByPage : undefined,
                detectedShapeParamsByPage: dieGeometryMode ? detectedShapeParamsByPage : undefined,
                spawnNewTab: s.spawnNewTabByTool[activeTool] ?? true,
                // Report & xuất tờ duy nhất (spec: binh-tem-be-report) — luôn bật cho sticker & CNC
                exportUniqueSheets: s.layoutType === 'mixed_guillotine'
                    ? s.exportUniqueSheets
                    : stickerProductMode,
                reportDisplay: s.reportDisplay,
                reportMaterial: s.reportMaterial,
                reportLamination: s.reportLamination,
                reportLaminationSides: s.reportLaminationSides,
                reportOrderCode: s.reportOrderCode,
                saveByReport: s.saveByReport,
                // ═══ Bình Bế Rớt (CNC) — spec: binh-be-rot-cnc ═══
                cncMode: activeTool === 'cnc_imposer',
                cncTwoSided: s.duplexFlow === 'double',
                cncFlipEdge: s.cncFlipEdge,
                cncDuplexMarks: s.cncDuplexMarks,
                // Tự động lưu file in (cài trước khi bình)
                autoSavePrint: stickerProductMode && s.savePrint.autoSave && !!autoFolder,
                savePrintConfig: {
                    folder: autoFolder,
                    nameMode: s.savePrint.nameMode,
                    folderMode: s.savePrint.folderMode,
                    includeOrderCode: s.savePrint.includeOrderCode,
                    includeDate: s.savePrint.includeDate,
                    orderCode: s.reportOrderCode,
                    labelName: s.reportDisplay?.labelNameText || '',
                },
                clusterTileW: s.clusterTileW, clusterTileH: s.clusterTileH,
                clusterCombineMode: s.clusterCombineMode,
                clusterSizingMode: s.clusterSizingMode, clusterCols: s.clusterCols,
                clusterRows: s.clusterRows, tileGapX: s.tileGapX, tileGapY: s.tileGapY,
                clusterNesting: s.clusterNesting,
                hiddenOcgLayerIds: hiddenOcgLayerIds,
            });
        }
    };

    // ═══ Preset Callbacks ═══
    const getCurrentSettings = useCallback(() => ({
        taskMode: s.taskMode as 'booklet' | 'nup' | 'sticker_imposer',
        paper: { formsize: s.formsize, customSheetWidth: s.customSheetWidth, customSheetHeight: s.customSheetHeight, bleed: s.bleed, gapX: s.gapX, gapY: s.gapY, spreadDistribution: s.spreadDistribution, marginTop: s.marginTop, marginBottom: s.marginBottom, marginLeft: s.marginLeft, marginRight: s.marginRight, marginMode: s.marginMode },
        marks: { markType: s.markType, markOffset: s.marksConfig.distance, markLength: s.marksConfig.length, markThickness: s.marksConfig.thickness, markStyle: s.marksConfig.style === 2 ? 'style2' as const : 'style1' as const },
        booklet: s.taskMode === 'booklet' ? { signatureMode: s.signatureMode, foliosize: s.foliosize, paperThickness: s.paperThickness, gutterMargin: s.gutterMargin, blankPlacement: s.blankPlacement, scaleMode: s.paperClassification === 'offset' ? 'chain_nup' : s.scaleMode, interleave: s.interleave, foldPattern: s.paperClassification === 'offset' ? (s.foldPattern || undefined) : undefined, gripperMargin: s.paperClassification === 'offset' ? s.gripperMargin : undefined } : undefined,
        nup: s.taskMode !== 'booklet' ? {
            // UIUX (audit 2026-08-03 §MG-AUTO): preset nhớ ý định ráp cùng khổ;
            // mixed được suy lại từ file lúc nạp, không trở thành sở thích dính lâu dài.
            layoutType: s.layoutType === 'mixed_guillotine'
                ? lastSameSizeLayoutRef.current
                : s.layoutType,
            columns: s.columns, rows: s.rows, gridStrategy: s.gridStrategy,
            groupingStrategy: s.groupingStrategy, duplexFlow: s.duplexFlow,
            align: s.align, clusterMode: s.clusterMode, clusterCount: s.clusterCount,
            clusterGap: s.clusterGap, clusterGapMode: s.clusterGapMode,
        } : undefined,
    }), [s]);

    const handleLoadPreset = useCallback((preset: ImpositionPreset) => {
        s.setTaskMode(preset.taskMode);
        setActiveTool(preset.taskMode);
        const p = preset.paper;
        s.setFormsize(p.formsize); s.setCustomSheetWidth(p.customSheetWidth); s.setCustomSheetHeight(p.customSheetHeight);
        s.setBleed(p.bleed); s.setGapX(p.gapX); s.setGapY(p.gapY); s.setSpreadDistribution(p.spreadDistribution || 'clustered');
        s.setMarginTop(p.marginTop); s.setMarginBottom(p.marginBottom); s.setMarginLeft(p.marginLeft); s.setMarginRight(p.marginRight); s.setMarginMode(p.marginMode);
        s.setMarkType(preset.marks.markType);
        if (preset.booklet) {
            s.setSignatureMode(preset.booklet.signatureMode); s.setFoliosize(preset.booklet.foliosize);
            s.setPaperThickness(preset.booklet.paperThickness); s.setScaleMode(preset.booklet.scaleMode);
            // BOOKLET (audit 2026-07-31 §B.1): preset cũ thiếu field thì giữ mặc định hiện tại.
            if (preset.booklet.gutterMargin !== undefined) s.setGutterMargin(preset.booklet.gutterMargin);
            if (preset.booklet.blankPlacement !== undefined) s.setBlankPlacement(preset.booklet.blankPlacement);
            s.setInterleave(preset.booklet.interleave);
            if (preset.booklet.foldPattern) s.setFoldPattern(preset.booklet.foldPattern);
            if (preset.booklet.gripperMargin) s.setGripperMargin(preset.booklet.gripperMargin);
        }
        if (preset.nup) {
            s.setLayoutType(
                preset.nup.layoutType === 'mixed_guillotine'
                    ? 'sequential'
                    : preset.nup.layoutType,
            );
            s.setColumns(preset.nup.columns); s.setRows(preset.nup.rows);
            s.setGridStrategy(preset.nup.gridStrategy || 'optimal_auto'); s.setDuplexFlow(preset.nup.duplexFlow);
            s.setAlign(preset.nup.align as any);
            s.setClusterMode(preset.nup.clusterMode); s.setClusterCount(preset.nup.clusterCount);
            s.setClusterGap(preset.nup.clusterGap); s.setClusterGapMode(preset.nup.clusterGapMode);
        }
    }, [s]);

    // ═══ Computed Values ═══
    const panelKind = WORKSPACE_TOOL_PANEL[activeTool as ActiveToolType] ?? 'external';
    const isPreprocessing = panelKind === 'preprocess';
    // Panel thiết lập BÌNH BÀI chỉ dành cho 4 chế độ bình thật (kind 'imposition').
    // Trước đây dùng `!isPreprocessing` khiến tool 'merge' lòi cả panel "Bình trang (S&R)".
    // Nay lấy TỪ WORKSPACE_TOOL_PANEL (nguồn chân lý duy nhất) — không thể drift.
    const isImpositionMode = panelKind === 'imposition';
    // ProductFirst (đề xuất theo sản phẩm — Phase 1: chỉ in nhanh).
    const [showProductFirst, setShowProductFirst] = useState(false);
    // CNC dùng chung render/preview die-cut với Bế tem (trừ pont — CNC dùng dấu canh riêng).
    const stickerLike = dieGeometryMode;
    const showPaperSection = s.taskMode !== 'booklet' || (s.taskMode === 'booklet' && s.scaleMode !== '100');
    // ═══ RENDER ═══
    if (activeTool === 'none') {
        // UIUX (audit 2026-07-27 §B-12) fix-verify: B-12 rút lại — menu chỉ render khi
        // activeTool==='none' nên prop activeTool là dead code; mini-toolbar đã highlight.
        return <ToolMenuList setActiveTool={t => setActiveTool(t as ActiveToolType)} setTaskMode={m => {
            s.setTaskMode(m as TaskMode);
        }} onActiveToolChange={onActiveToolChange} />;
    }

    const paperSectionJSX = (
        <>
            <div className={`space-y-1 transition-opacity ${showPaperSection ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>

                <div className="flex items-center gap-3">
                    <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]" title={t('imposition.imposerDashboard:kho_giay_paper')}>
                        {t('imposition.imposerDashboard:kho_giay')}
                    </label>
                    <div className="flex flex-1 items-center gap-2 min-w-0">
                        <PaperSizeSelect
                            value={s.formsize}
                            onChange={(v) => s.setFormsize(v)}
                            paperContext={paperContext}
                            savedForms={savedForms}
                        />
                        <button onClick={() => s.setShowSettings(true)} className="shrink-0 w-8 h-8 rounded border border-slate-300 dark:border-white/20 flex items-center justify-center text-slate-500 hover:text-indigo-600 hover:border-indigo-400 transition-colors bg-white dark:bg-zinc-900" title={t('imposition.imposerDashboard:thiet_lap_le_giay')}>
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                        </button>
                    </div>
                </div>
            </div>
            <PaperSettingsDialog
                isOpen={s.showSettings}
                onClose={() => s.setShowSettings(false)}
                width={s.customSheetWidth}
                height={s.customSheetHeight}
                marginTop={s.marginTop}
                marginBottom={s.marginBottom}
                marginLeft={s.marginLeft}
                marginRight={s.marginRight}
                marginMode={s.marginMode}
                classification={s.paperClassification}
                gripperMargin={s.gripperMargin}
                onApply={handleSettingsApply}
                savedForms={savedForms}
                onSavePreset={handleSavePreset}
                onUpdatePreset={handleUpdatePreset}
                onDeletePreset={handleDeletePreset}
                currentFormsize={s.formsize}
                defaultUsages={defaultUsagesForContext(paperContext)}
            />
        </>
    );

    return (
        // UIUX (audit 2026-07-27 §B-13/§B-21): tabIndex=-1 + ref → nhận focus khi đổi tool
        <div className="flex flex-col gap-5 pb-4 transition-all outline-none" ref={panelFocusRef} tabIndex={-1}>
            {/* ═══ PREPROCESSING TOOLS ═══ */}
            {isPreprocessing && (
                <PreprocessingRouter
                    tabId={tabId} activeTool={activeTool} pdfFile={pdfFile || null} isProcessing={isProcessing}
                    onStartShuffle={onStartShuffle} onStartResize={onStartResize}
                    onStartTrimShift={onStartTrimShift}
                    onStartSplit={onStartSplit} onStartMerge={onStartMerge}
                    onIssueSelect={onIssueSelect} onOpenOutputPreview={onOpenOutputPreview} onOpenTool={(tool) => setActiveTool(tool as ActiveToolType)} onFileFixed={onFileFixed}
                    officeSourceFile={officeSourceFile}
                    officeSourceFiles={officeSourceFiles} ensureCropFileId={ensureCropFileId} onCropApplied={onCropApplied} onCropClose={onCropClose}
                />
            )}

            {/* ═══ MERGE (special — keeps local state) ═══ */}
            {activeTool === 'merge' && (
                <div>
                    <div className="pt-2 text-center pb-2">
                        <h2 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center justify-center gap-2">
                            <span>🔗</span>
                            <span>{t('imposition.imposerDashboard:ghep_file_chen_trang')}</span>
                        </h2>
                        <p className="text-[11px] text-slate-500 mt-1">{t('imposition.imposerDashboard:gop_nhieu_pdf_tron_xen_ke_le_chan_chen')}</p>
                    </div>
                    <MergeTool settings={mergeSettings} onChange={setMergeSettings} />
                    <div className="mt-4 mb-2">
                        <Checkbox checked={s.spawnNewTabByTool['merge'] ?? true} onChange={(v) => s.setSpawnNewTab('merge', v)} label={t('imposition.imposerDashboard:mo_ket_qua_sang_tab_moi')} />
                    </div>
                    <button onClick={() => onStartMerge && onStartMerge({ ...mergeSettings, spawnNewTab: s.spawnNewTabByTool['merge'] ?? true })} disabled={isProcessing}
                        className="mt-2 w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded font-bold shadow-sm transition-colors disabled:opacity-50">
                        {t('preprocess.common:run')}{isProcessing ? '…' : ''}
                    </button>
                </div>
            )}

            {/* ═══ IMPOSITION SETTINGS ═══ */}
            {isImpositionMode && (
                <>
                    {/* ═══ IMPOSITION HEADER ═══ */}
                    {activeTool === 'booklet' && (
                        <div className="pt-2 text-center pb-2">
                            <h2 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center justify-center gap-2">{t('imposition.imposerDashboard:binh_sach_tap_chi')}</h2>
                            <p className="text-[11px] text-slate-500 mt-1">{t('imposition.imposerDashboard:dung_tay_sach_long_doi_tinh_do_bu_gay')}</p>
                        </div>
                    )}
                    
                    {activeTool === 'nup' && (
                        <div className="pt-2 text-center pb-2">
                            <h2 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center justify-center gap-2">{t('imposition.imposerDashboard:binh_bai_xen')}</h2>
                            <p className="text-[11px] text-slate-500 mt-1">{t('imposition.imposerDashboard:sap_xep_tu_dong_nhieu_doi_tuong_hoac')}</p>
                        </div>
                    )}

                    {activeTool === 'sticker_imposer' && (
                        <div className="pt-2 text-center pb-2">
                            <h2 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center justify-center gap-2">{t('imposition.imposerDashboard:binh_bai_be_tem')}</h2>
                            <p className="text-[11px] text-slate-500 mt-1">{t('imposition.imposerDashboard:sap_xep_toi_uu_tem_nhan_va_tu_dong_nhan')}</p>
                        </div>
                    )}

                    {activeTool === 'cnc_imposer' && (
                        <div className="pt-2 text-center pb-2">
                            <h2 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center justify-center gap-2">{t('imposition.imposerDashboard:binh_be_rot_cnc')}</h2>
                            <p className="text-[11px] text-slate-500 mt-1">{t('imposition.imposerDashboard:cat_roi_cnc_binh_2_mat_lat_guong_dau')}</p>
                        </div>
                    )}

                    <Divider />

                    {/* ✨ Đề xuất theo sản phẩm — chỉ booklet + in nhanh (Phase 1) */}
                    {!HIDE_PRODUCT_FIRST && s.taskMode === 'booklet' && s.paperClassification === 'in_nhanh' && (
                        <button
                            onClick={() => setShowProductFirst(v => !v)}
                            className={`w-full text-left px-3 py-2 rounded-lg border transition-colors ${showProductFirst
                                ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-500/10'
                                : 'border-slate-200 dark:border-white/10 hover:border-indigo-400'}`}
                        >
                            <span className="text-[13px] font-semibold text-indigo-700 dark:text-indigo-400">{t('imposition.imposerDashboard:de_xuat_theo_san_pham')}</span>
                            <span className="block text-[11px] text-slate-500">
                                {showProductFirst ? t('imposition.imposerDashboard:dang_bat_chon_san_pham_de_he_thong_tu') : t('imposition.imposerDashboard:chon_san_pham_kho_giay_tu_de_xuat_1_to')}
                            </span>
                        </button>
                    )}

                    {(!HIDE_PRODUCT_FIRST && s.taskMode === 'booklet' && s.paperClassification === 'in_nhanh' && showProductFirst) ? (
                        <ProductFirstPanel
                            pageCount={sourceTotalPages}
                            finishedWidthMm={s.sourcePageDim ? Math.round(s.sourcePageDim.w * 0.352778 - 2 * (s.bleed || 0)) : undefined}
                            finishedHeightMm={s.sourcePageDim ? Math.round(s.sourcePageDim.h * 0.352778 - 2 * (s.bleed || 0)) : undefined}
                            onApplied={() => setShowProductFirst(false)}
                            onOpenAdvanced={() => setShowProductFirst(false)}
                        />
                    ) : (
                        <>
                            <AutoCatalogSection />
                            <BookletSettingsSection />

                            {s.taskMode === 'booklet' && (
                                <div className="mt-2">{paperSectionJSX}</div>
                            )}
                        </>
                    )}

                    {/* Grid Settings + Preview (N-Up / Step&Repeat / Sticker) */}
                    {(s.taskMode === 'nup' || s.taskMode === 'step_repeat' || s.taskMode === 'sticker_imposer') && (
                        <>
                            <GridSettingsSection
                                taskMode={s.taskMode} setTaskMode={s.setTaskMode as any} activeTool={activeTool}
                                duplexFlow={s.duplexFlow} setDuplexFlow={s.setDuplexFlow as any}
                                gridStrategy={s.gridStrategy} setGridStrategy={s.setGridStrategy as any}
                                targetQuantity={s.targetQuantity} setTargetQuantity={s.setTargetQuantity}
                                targetQuantitiesByPage={s.targetQuantitiesByPage} setTargetQuantitiesByPage={s.setTargetQuantitiesByPage}
                                previewCapacity={s.previewCapacity} previewCapacities={s.previewCapacities}
                                mixedPlacedByPage={s.mixedPlacedByPage}
                                sourceTotalPages={sourceTotalPages}
                                columns={s.columns} setColumns={s.setColumns} rows={s.rows} setRows={s.setRows}
                                gapX={s.gapX} setGapX={s.setGapX} gapY={s.gapY} setGapY={s.setGapY}
                                showGapSettings={s.showGapSettings} setShowGapSettings={s.setShowGapSettings}
                                detectedShapesByPage={detectedShapesByPage} setDetectedShapesByPage={setDetectedShapesByPage}
                                viewerActivePage={viewerActivePage} viewerPageOrder={viewerPageOrder || null}
                                paperSectionJSX={paperSectionJSX}
                                // UIUX (audit 2026-07-27 §B-09): Enter trong form số lượng → chạy Bình luôn
                                onRequestExecute={handleExecute}
                            />
                        </>
                    )}

                    <AdvancedSettingsSection activeTool={activeTool} sourceTotalPages={bookReportPageCount} />

                    {/* Grid preview for all modes */}
                    {(s.taskMode === 'nup' || s.taskMode === 'step_repeat' || s.taskMode === 'sticker_imposer') && (
                        <>
                            {(() => {
                                // Preview source is materialized in current thumbnail order, so
                                // backend page indices must use viewer positions, not source numbers.
                                const safePageIdx = Math.max(0, (viewerActivePage || 1) - 1);
                                // Shape props cho preview:
                                // • 1 khuôn (mọi trang cùng type, hoặc chỉ 1 trang có khuôn) → master
                                // • Mỗi tem 1 khuôn khác nhau → trang đang xem (safePageIdx)
                                const shapePageIdx = (() => {
                                    if (!stickerLike
                                        || (s.cutType === 'one_dao' && s.dieSizeMode === 'page')
                                        || sourceTotalPages <= 1) {
                                        return safePageIdx;
                                    }
                                    const master = inheritedSingleMoldMaster(
                                        previewDetectedShapeParamsByPage,
                                        sourceTotalPages,
                                    );
                                    return master ?? safePageIdx;
                                })();

                                let effMarginTop = s.marginTop || 0;
                                let effMarginBottom = s.marginBottom || 0;
                                let effMarginLeft = s.marginLeft || 0;
                                let effMarginRight = s.marginRight || 0;
                                
                                if (
                                    s.gripperMargin > 0
                                    && !stickerLike
                                    && s.paperClassification === 'offset'
                                    && s.taskMode !== 'booklet'
                                ) {
                                    effMarginBottom += s.gripperMargin;
                                }
                                
                                const effectiveMarginMode = stickerLike ? 'labels_only' : s.marginMode;
                                if (effectiveMarginMode === 'include_marks' && s.markType && s.markType !== 'none') {
                                    const len = s.marksConfig?.length ?? 5.0;
                                    const off = s.marksConfig?.distance ?? 3.0;
                                    const markSpace = len + off;
                                    
                                    effMarginTop += markSpace;
                                    effMarginBottom += markSpace;
                                    effMarginLeft += markSpace;
                                    effMarginRight += markSpace;
                                }

                                const splitGap = resolveImpositionSplitGap({
                                    dieGeometryMode,
                                    gapX: s.gapX,
                                    gapY: s.gapY,
                                    clusterGap: s.clusterGap,
                                    clusterGapMode: s.clusterGapMode,
                                    markType: s.markType,
                                    markLength: s.marksConfig?.length,
                                    markOffset: s.marksConfig?.distance,
                                });

                                // Cùng gate execute: tem bế/CNC không bao giờ chia cọc row/column.
                                const _clusterAppliesPv = !stickerLike && s.markType === 'guillotine' && (
                                    (s.taskMode === 'nup' && s.layoutType === 'ratio_stack')
                                    || s.taskMode === 'step_repeat'
                                );
                                const _effClusterModePv = _clusterAppliesPv ? s.clusterMode : 'none';
                                const _effGroupingPv = stickerLike || s.markType === 'guillotine'
                                    ? s.groupingStrategy : 'none';
                                const itemDim = resolvePreviewItemDimension(
                                    pageSheetMode ? 'nup' : activeTool,
                                    shapePageIdx,
                                    previewDetectedDimensionsByPage,
                                    previewSourceDimensionsByPage,
                                    sourcePageDimForGeometry,
                                );
                                return (
                            <GridPreview
                                taskMode={s.taskMode} gridStrategy={s.gridStrategy} columns={s.columns} rows={s.rows}
                                isDieCut={stickerLike}
                                pageSheetMode={pageSheetMode}
                                // Defensive: không bao giờ gửi layoutType='repeat' khi
                                // Tác vụ là dàn nhiều mẫu (preview sẽ nhầm Bình trang).
                                layoutType={
                                    s.taskMode === 'step_repeat'
                                        ? 'repeat'
                                        : (s.layoutType === 'repeat' ? 'sequential' : s.layoutType)
                                }
                                duplexFlow={activeTool === 'sticker_imposer' ? 'normal' : s.duplexFlow}
                                duplexFlipEdge={s.duplexFlipEdge}
                                mixedExcessPercent={s.mixedExcessPercent}
                                splitGap={splitGap}
                                gapX={s.gapX} gapY={s.gapY}
                                groupingStrategy={_effGroupingPv}
                                clusterCombineMode={s.clusterCombineMode}
                                clusterNesting={s.clusterNesting}
                                clusterSizingMode={s.clusterSizingMode}
                                clusterCols={s.clusterCols} clusterRows={s.clusterRows}
                                clusterTileW={s.clusterTileW} clusterTileH={s.clusterTileH}
                                tileGapX={s.tileGapX} tileGapY={s.tileGapY}
                                clusterMode={_effClusterModePv} clusterCount={s.clusterCount}
                                clusterGap={s.clusterGap} clusterDistribution={s.clusterDistribution}
                                sheetWidth={resolvePressSheetDims().w}
                                sheetHeight={resolvePressSheetDims().h}
                                marginTop={effMarginTop} marginBottom={effMarginBottom} marginLeft={effMarginLeft} marginRight={effMarginRight}
                                align={s.align}
                                // 1 Dao: luôn chữ nhật. Multi tem: shape/kích thước MASTER (shapePageIdx).
                                shapeType={
                                    stickerLike
                                        ? (s.cutType === 'one_dao'
                                            ? 'RECTANGLE'
                                            : (previewDetectedShapesByPage[shapePageIdx] || 'CUSTOM'))
                                        : 'RECTANGLE'
                                }
                                itemW={(() => {
                                    if (stickerLike && s.cutType === 'one_dao' && s.dieSizeMode === 'page') {
                                        const off = (s.dieOffsetMm || 0) * 2;
                                        const w = itemDim?.w;
                                        return (typeof w === 'number' && !isNaN(w)) ? w * 0.352778 + off : 90;
                                    }
                                    const w = itemDim?.w;
                                    return (typeof w === 'number' && !isNaN(w)) ? w * 0.352778 : 90;
                                })()}
                                itemH={(() => {
                                    if (stickerLike && s.cutType === 'one_dao' && s.dieSizeMode === 'page') {
                                        const off = (s.dieOffsetMm || 0) * 2;
                                        const h = itemDim?.h;
                                        return (typeof h === 'number' && !isNaN(h)) ? h * 0.352778 + off : 55;
                                    }
                                    const h = itemDim?.h;
                                    return (typeof h === 'number' && !isNaN(h)) ? h * 0.352778 : 55;
                                })()}
                                targetQuantity={s.targetQuantity}
                                // N-Up cắt xén (ratio_stack/sequential) cũng cần SL từng trang cho preview ≡ output.
                                targetQuantitiesByPage={s.targetQuantitiesByPage}
                                sourceTotalPages={sourceTotalPages}
                                imposerMode={activeTool === 'cnc_imposer' ? 'cnc' : undefined}
                                cncTwoSided={activeTool === 'cnc_imposer' && s.duplexFlow === 'double'}
                                cncFlipEdge={s.cncFlipEdge}
                                shapeParams={
                                    !stickerLike || s.cutType === 'one_dao'
                                        ? null
                                        : previewDetectedShapeParamStringsByPage[shapePageIdx] ?? null
                                }
                                shapesByPage={
                                    stickerLike
                                        && !(s.cutType === 'one_dao' && s.dieSizeMode === 'page')
                                        ? previewDetectedShapesByPage : undefined
                                }
                                shapeParamsByPage={
                                    stickerLike
                                        && !(s.cutType === 'one_dao' && s.dieSizeMode === 'page')
                                        ? previewDetectedShapeParamsByPage : undefined
                                }
                                isDetectingShape={stickerLike && isDetectingShape}
                                pontType={pontSettingsMode ? s.pontType : 'none'} pontConfig={(pontSettingsMode && s.pontType !== 'none') ? s.pontConfig : null}
                                onCapacityChange={(cap) => {
                                    s.setPreviewCapacity(cap);
                                    const master = stickerLike
                                        ? inheritedSingleMoldMaster(
                                            previewDetectedShapeParamsByPage, sourceTotalPages,
                                        )
                                        : null;
                                    if (master !== null) {
                                        const all: Record<number, number> = {};
                                        for (let i = 0; i < sourceTotalPages; i++) all[i] = cap;
                                        s.setPreviewCapacities(all);
                                    } else {
                                        s.setPreviewCapacities({ ...s.previewCapacities, [safePageIdx]: cap });
                                    }
                                }}
                                onMixedPlacedByPage={(m) => s.setMixedPlacedByPage(m)}
                                fileId={stickerLike ? selectionFileId : undefined}
                                filePath={((window as any).__TAURI_INTERNALS__) ? ((pdfFile as any)?.path || undefined) : undefined}
                                pageIdx={shapePageIdx}
                                bleed={s.bleed}
                                cutType={stickerLike ? s.cutType : undefined}
                                dieSizeMode={stickerLike ? s.dieSizeMode : undefined}
                                dieOffsetMm={stickerLike ? s.dieOffsetMm : undefined}
                                fillBlockGap={stickerLike ? s.fillBlockGap : undefined}
                                getWorkingFile={getWorkingFile}
                                previewSourceKey={previewSourceKey}
                            />
                            );
                            })()}
                        </>
                    )}

                    {/* OutputSettingsSection đã gộp hết vào THIẾT LẬP MỞ RỘNG (boong + đường cắt) */}
                    <Divider />

                    {/* Execute Buttons */}
                    <div className="pt-4 mt-auto flex flex-col gap-3">
                        {s.taskMode === 'booklet' && (
                            <div className="flex gap-3">
                                <button onClick={() => s.setShowFlipbook(true)} disabled={isProcessing || !pdfFile}
                                    className="flex-1 h-11 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-semibold transition-colors disabled:opacity-50 flex items-center justify-center gap-2">{t('imposition.imposerDashboard:xem_thanh_pham')}</button>
                                <button onClick={() => s.setShowSheetViewer(true)} disabled={isProcessing || !pdfFile}
                                    className="flex-1 h-11 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm font-semibold transition-colors disabled:opacity-50 flex items-center justify-center gap-2 border border-slate-600">{t('imposition.imposerDashboard:xem_bai_in')}</button>
                            </div>
                        )}
                        {/* UIUX (audit 2026-07-27 §B-22): chưa mở file → khóa nút Bình + title giải thích */}
                        <button onClick={handleExecute} disabled={isProcessing || !pdfFile || waitingForGuillotineSize}
                            title={!pdfFile
                                ? t('imposition.imposerDashboard:mo_file_pdf_truoc_khi_binh', 'Mở file PDF trước khi bình')
                                : waitingForGuillotineSize
                                    ? t('lib.pdfImposer:dang_tinh_toan_kich_thuoc_tu_dong')
                                    : undefined}
                            className="w-full h-11 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-semibold transition-colors disabled:opacity-50 flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1">
                            {t('preprocess.common:run')}{isProcessing ? '…' : ''}
                        </button>
                    </div>
                </>
            )}

            {/* Error */}
            {/* UIUX (audit 2026-07-27 §B-23): lỗi đã được formatError hóa khi SET (ImpositionTab) — pre-line để dòng hướng khắc phục xuống hàng */}
            {globalError && (
                <div className="p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800/50 rounded text-sm whitespace-pre-line">{globalError}</div>
            )}

            {/* ═══ DIALOGS ═══ */}
            <MarksSettingsDialog isOpen={s.showMarksModal} onClose={() => s.setShowMarksModal(false)} config={s.marksConfig} onSave={(cfg) => { s.setMarksConfig(cfg); }} />
            <PontSettingsDialog isOpen={s.showPontModal} onClose={() => s.setShowPontModal(false)} config={s.pontConfig} onSave={(cfg) => { s.setPontConfig(cfg); }} />
            <PresetSelector isOpen={s.isPresetOpen} onClose={() => s.setIsPresetOpen(false)} onLoadPreset={handleLoadPreset} onGetCurrentSettings={getCurrentSettings} />
            <FlipbookDialog isOpen={s.showFlipbook} onClose={() => s.setShowFlipbook(false)} pdfUrl={pdfUrl} pdfFile={pdfFile} pageOrder={viewerPageOrder || []} pageRotations={viewerPageRotations || []} bindingMode={s.signatureMode} foliosize={s.foliosize} bleed={s.bleed} blankPlacement={s.blankPlacement} />
            <SheetViewerDialog isOpen={s.showSheetViewer} onClose={() => s.setShowSheetViewer(false)} pdfFile={pdfFile} pageOrder={viewerPageOrder || []} pageRotations={viewerPageRotations || []} bindingMode={s.signatureMode} foliosize={(s.paperClassification === 'offset' && s.foldPattern?.startsWith('sig_')) ? parseInt(s.foldPattern.split('_')[1]) : s.foliosize} sheetWidth={s.customSheetWidth} sheetHeight={s.customSheetHeight} scaleMode={s.paperClassification === 'offset' ? 'chain_nup' : s.scaleMode} foldPattern={s.paperClassification === 'offset' ? s.foldPattern : ''} catalogJobs={s.autoCatalog && s.catalogJobsState ? s.catalogJobsState : undefined} isDigital={s.paperClassification === 'in_nhanh'} gripperMargin={s.paperClassification === 'offset' ? s.gripperMargin : 0} pageWpt={s.sourcePageDim?.w} pageHpt={s.sourcePageDim?.h} bleed={s.bleed} gapX={s.gapX} gapY={s.gapY} marginLeft={s.marginLeft} marginRight={s.marginRight} marginTop={s.marginTop} blankPlacement={s.blankPlacement} separateCover={s.separateCover && (s.signatureMode === 'continuous' || s.signatureMode === 'thread')} coverPageCount={s.coverPageCount} />
        </div>
    );
}
