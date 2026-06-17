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
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { useShallow } from 'zustand/react/shallow';
import { usePaperPresets, PaperSettingsDialog } from './PaperSettingsUI';
import { MarksSettingsDialog } from './MarksSettingsDialog';
import { PontSettingsDialog } from './PontSettingsDialog';
import { Divider, Checkbox } from './SharedUI';
import ToolMenuList from './ToolMenuList';
import PresetSelector from './PresetSelector';
import { FlipbookDialog } from '../flipbook/FlipbookDialog';
import { SheetViewerDialog } from '../flipbook/SheetViewerDialog';
import { authenticatedFetch, getApiUrl } from '../../lib/api';
import { MergeSettings, defaultMergeSettings } from '../preprocess-tools/MergeTool';
import MergeTool from '../preprocess-tools/MergeTool';

// Section components
import BookletSettingsSection from './sections/BookletSettingsSection';
import AutoCatalogSection from './sections/AutoCatalogSection';
import PreprocessingRouter from './sections/PreprocessingRouter';
import GridSettingsSection from './sections/GridSettingsSection';
import AdvancedSettingsSection from './sections/AdvancedSettingsSection';
import CncSettingsSection from './sections/CncSettingsSection';
import GridPreview from './sections/GridPreview';

// Store & Types
import { useImposerSettingsStore } from './useImposerSettingsStore';
import { PREDEFINED_SIZES, getImposerCapability, type ActiveToolType, type TaskMode, type ImposerDashboardProps } from './types';
export type { BookletSettings, NupSettings } from './types';
export { PREDEFINED_SIZES } from './types';

import type { ImpositionPreset } from '../../lib/presetManager';


export default function ImposerDashboard({ tabId, onStartBooklet, onStartNup, onStartShuffle, onStartResize, onStartSplit, onStartMerge, onStartCatalogPlan, initialFeature, lockedMode, onBleedUpdate, onFileFixed, systemMergeFiles }: ImposerDashboardProps) {

    // ═══ Workspace State ═══
    const {
        isProcessing, error: globalError, file: pdfFile, viewerPageOrder,
        setHighlightedIssue: onIssueSelect, setShowOutputPreview,
        detectedShapeType, detectedShapeParams, setDetectedShapeType,
        detectedShapesByPage, setDetectedShapesByPage,
        detectedDimensionsByPage, setDetectedDimensionsByPage,
        detectedShapeParamsByPage, setDetectedShapeParamsByPage, viewerActivePage, pdfUrl,
        selectionFileId, hiddenOcgLayerIds
    } = useWorkspaceStore(useShallow(state => ({
        isProcessing: state.isProcessing, error: state.error, file: state.file, viewerPageOrder: state.viewerPageOrder,
        setHighlightedIssue: state.setHighlightedIssue, setShowOutputPreview: state.setShowOutputPreview,
        detectedShapeType: state.detectedShapeType, detectedShapeParams: state.detectedShapeParams, setDetectedShapeType: state.setDetectedShapeType,
        detectedShapesByPage: state.detectedShapesByPage, setDetectedShapesByPage: state.setDetectedShapesByPage,
        detectedDimensionsByPage: state.detectedDimensionsByPage, setDetectedDimensionsByPage: state.setDetectedDimensionsByPage,
        detectedShapeParamsByPage: state.detectedShapeParamsByPage, setDetectedShapeParamsByPage: state.setDetectedShapeParamsByPage, viewerActivePage: state.viewerActivePage, pdfUrl: state.pdfUrl,
        selectionFileId: state.selectionFileId,
        hiddenOcgLayerIds: state.hiddenOcgLayerIds
    })));

    // P1-T03: activeDashboardTool from dedicated imposer store (migration in progress, dupe in workspace for now)
    const { activeDashboardTool: currentTool, setActiveDashboardTool: onActiveToolChange } = useImposerSettingsStore();
    const sourceTotalPages = viewerPageOrder ? viewerPageOrder.length : 0;
    const onOpenOutputPreview = () => setShowOutputPreview(true);

    // ═══ Imposition Settings Store ═══
    const s = useImposerSettingsStore();

    // ═══ Active Tool (local — synced with parent) ═══
    const [activeTool, setActiveTool] = useState<ActiveToolType>(() => {
        if (currentTool) return currentTool as any;
        if (lockedMode === 'booklet' || lockedMode === 'nup') return lockedMode;
        if (lockedMode === 'sticker_imposer') return 'sticker_imposer';
        if (lockedMode === 'cnc_imposer') return 'cnc_imposer';
        const allowedFeatures = ['shuffle', 'resize', 'split', 'merge', 'preflight', 'sticker', 'bgremover', 'optimize', 'numbering', 'datamerge', 'ocr'];
        if (initialFeature && allowedFeatures.includes(initialFeature)) return initialFeature as any;
        return 'none';
    });

    useEffect(() => {
        if (currentTool && currentTool !== activeTool) setActiveTool(currentTool as any);
    }, [currentTool]);

    useEffect(() => {
        if (onActiveToolChange) onActiveToolChange(activeTool);
    }, [activeTool, onActiveToolChange]);

    // Tool Profiles: khi đổi công cụ, lưu thiết lập thuật toán của tool cũ và nạp tool mới
    // (chống rò rỉ state giữa N-up / Bế tem / Booklet — Task 15/Req 5).
    const prevActiveToolRef = useRef<string>(activeTool);
    useEffect(() => {
        const prev = prevActiveToolRef.current;
        if (prev !== activeTool) {
            s.switchToolProfile(prev, activeTool);
            prevActiveToolRef.current = activeTool;
        }
    }, [activeTool]);

    // Restore the previous taskMode if we return from Sticker Imposer
    const prevNonStickerMode = useRef<TaskMode>(s.taskMode !== 'sticker_imposer' ? s.taskMode : 'nup');
    useEffect(() => {
        if (s.taskMode !== 'sticker_imposer') {
            prevNonStickerMode.current = s.taskMode;
        }
    }, [s.taskMode]);
    useEffect(() => {
        if (activeTool !== 'sticker_imposer' && activeTool !== 'cnc_imposer' && s.taskMode === 'sticker_imposer') {
            s.setTaskMode(prevNonStickerMode.current);
        }
    }, [activeTool]);

    // CNC dùng chung thuật toán xếp/preview với Bế tem → ép taskMode 'sticker_imposer'.
    useEffect(() => {
        if (activeTool === 'cnc_imposer' && s.taskMode !== 'sticker_imposer') {
            s.setTaskMode('sticker_imposer');
        }
    }, [activeTool]);

    // ═══ Merge Settings (stays local — complex sub-component) ═══
    const [mergeSettings, setMergeSettings] = useState<MergeSettings>(defaultMergeSettings);
    const [isDetectingShape, setIsDetectingShape] = useState(false);

    // ═══ Paper Presets ═══
    const { savedForms, handleSavePreset: _savePreset, handleUpdatePreset: _updatePreset, handleDeletePreset: _deletePreset } = usePaperPresets('printauto_saved_forms');

    const handleSavePreset = useCallback((name: string, w: number, h: number, mT: number, mB: number, mL: number, mR: number, mMode: 'labels_only' | 'include_marks', classification: 'offset' | 'in_nhanh', gripper: number) => {
        if (savedForms.some(f => f.name === name)) { alert('Tên "' + name + '" đã tồn tại.'); return; }
        const newId = _savePreset(name, w, h, mT, mB, mL, mR, mMode, classification, gripper);
        s.setFormsize(newId);
        s.setCustomSheetWidth(w); s.setCustomSheetHeight(h);
        s.setMarginTop(mT); s.setMarginBottom(mB); s.setMarginLeft(mL); s.setMarginRight(mR);
        s.setMarginMode(mMode); s.setPaperClassification(classification); s.setGripperMargin(gripper);
    }, [savedForms, _savePreset, s]);

    const handleUpdatePreset = useCallback((id: string, name: string, w: number, h: number, mT: number, mB: number, mL: number, mR: number, mMode: 'labels_only' | 'include_marks', classification: 'offset' | 'in_nhanh', gripper: number) => {
        _updatePreset(id, name, w, h, mT, mB, mL, mR, mMode, classification, gripper);
        s.setCustomSheetWidth(w); s.setCustomSheetHeight(h);
        s.setMarginTop(mT); s.setMarginBottom(mB); s.setMarginLeft(mL); s.setMarginRight(mR);
        s.setMarginMode(mMode); s.setPaperClassification(classification); s.setGripperMargin(gripper);
    }, [_updatePreset, s]);

    const handleDeletePreset = useCallback((id: string) => {
        _deletePreset(id);
        if (s.formsize === id) s.setFormsize('SRA3');
        s.setShowSettings(false);
    }, [_deletePreset, s]);

    // ═══ Paper dimension sync ═══
    // Only sync when formsize CHANGES, not on initial mount (persist already has the right values)
    const prevFormsizeRef = useRef(s.formsize);
    useEffect(() => {
        if (prevFormsizeRef.current === s.formsize) return; // skip initial mount & no-change
        prevFormsizeRef.current = s.formsize;

        if (s.formsize.startsWith('custom_')) {
            const preset = savedForms.find(f => f.id === s.formsize);
            if (preset) {
                s.setCustomSheetWidth(preset.w); s.setCustomSheetHeight(preset.h);
                s.setMarginTop(preset.marginTop); s.setMarginBottom(preset.marginBottom);
                s.setMarginLeft(preset.marginLeft); s.setMarginRight(preset.marginRight);
                if (preset.marginMode) s.setMarginMode(preset.marginMode);
                if (preset.classification) s.setPaperClassification(preset.classification);
                if (preset.gripperMargin !== undefined) s.setGripperMargin(preset.gripperMargin);
            }
        } else if (s.formsize !== 'custom' && s.formsize !== 'auto_100') {
            const ps = PREDEFINED_SIZES[s.formsize];
            if (ps) { s.setCustomSheetWidth(ps.w); s.setCustomSheetHeight(ps.h); s.setPaperClassification(ps.classification); s.setGripperMargin(ps.gripperMargin); }
        }
    }, [s.formsize, savedForms]);

    const handleSettingsApply = useCallback((w: number, h: number, mT: number, mB: number, mL: number, mR: number, mMode: 'labels_only' | 'include_marks', classification: 'offset' | 'in_nhanh', gripper: number) => {
        s.setCustomSheetWidth(w); s.setCustomSheetHeight(h);
        s.setMarginTop(mT); s.setMarginBottom(mB); s.setMarginLeft(mL); s.setMarginRight(mR);
        s.setMarginMode(mMode); s.setPaperClassification(classification); s.setGripperMargin(gripper);
        if (s.formsize !== 'custom' && !s.formsize.startsWith('custom_')) {
            const ps = PREDEFINED_SIZES[s.formsize];
            if (ps && (ps.w !== w || ps.h !== h)) s.setFormsize('custom');
        }
    }, [s]);

    // ═══ Side Effects ═══
    useEffect(() => { onBleedUpdate?.(s.showBleedView, s.bleed); }, [s.showBleedView, s.bleed, onBleedUpdate]);

    useEffect(() => {
        if (s.taskMode === 'booklet') {
            s.setMarkType(s.scaleMode !== '100' ? 'guillotine' : 'none');
        }
    }, [s.scaleMode, s.taskMode]);

    useEffect(() => {
        if (s.taskMode === 'step_repeat') s.setLayoutType('repeat');
        else if ((s.taskMode === 'nup' || s.taskMode === 'sticker_imposer') && s.layoutType === 'repeat') s.setLayoutType('sequential');
    }, [s.taskMode]);

    useEffect(() => {
        if (s.signatureMode === 'cut_stacks' && s.scaleMode === 'cut_stack') s.setScaleMode('100');
    }, [s.signatureMode]);

    // Persistence is now handled automatically by Zustand persist middleware in useImposerSettingsStore.ts

    // Auto shape detection — re-run whenever file changes
    useEffect(() => {
        if ((activeTool === 'sticker_imposer' || activeTool === 'cnc_imposer') && selectionFileId) {
            const detectShapes = async () => {
                // Reset shapes truoc de tranh giu shapes cu khi doi file
                setDetectedShapesByPage({});
                setDetectedDimensionsByPage({});
                setDetectedShapeParamsByPage({});
                setIsDetectingShape(true);
                try {
                    const res = await authenticatedFetch(`${getApiUrl()}/imposition/detect-shape`, { 
                        method: 'POST', 
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ fileId: selectionFileId }) 
                    });
                    const data = await res.json();
                    if (res.ok && data.success && data.shapes?.length > 0) {
                        const newShapes: Record<number, string> = {};
                        data.shapes.forEach((s: string, i: number) => { newShapes[i] = s; });
                        if (data.dimensions) {
                            const newDims: Record<number, { w: number, h: number }> = {};
                            data.dimensions.forEach((d: any, i: number) => { newDims[i] = d; });
                            setDetectedDimensionsByPage(newDims);
                        }
                        if (data.shapeParams) {
                            const newParams: Record<number, any> = {};
                            data.shapeParams.forEach((p: any, i: number) => { newParams[i] = p; });
                            setDetectedShapeParamsByPage(newParams);
                        }
                        setDetectedShapesByPage(newShapes);
                    }
                } catch (err) { console.error('Auto shape detection failed:', err); }
                finally { setIsDetectingShape(false); }
            };
            detectShapes();
        }
    }, [activeTool, selectionFileId]);

    // Auto Catalog: fetch page dimensions + plan
    useEffect(() => {
        if (!pdfFile || (!s.autoCatalog && s.taskMode !== 'booklet')) return;
        let isActive = true;
        s.setSourcePageDim(null); // Clear old cache immediately
        const loadPdfMetadata = async () => {
            if (pdfFile && !(pdfFile.type === 'application/pdf' || pdfFile.name.toLowerCase().endsWith('.pdf'))) {
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
                            const meta = await res.json();
                            if (isActive && meta.pages && meta.pages.length > 0) {
                                // meta.pages[0].width_pt is already TrimBox & UserUnit adjusted by Python backend
                                s.setSourcePageDim({ w: meta.pages[0].width_pt, h: meta.pages[0].height_pt });
                                s.setSourcePageDims(meta.pages.map((p: any) => ({ w: p.width_pt, h: p.height_pt })));
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
                        if (metadata.allDims) {
                            const dimsArr = [];
                            for (let i = 1; i <= Object.keys(metadata.allDims).length; i++) {
                                const d = metadata.allDims[i.toString()];
                                if (d) dimsArr.push({ w: d.widthPt, h: d.heightPt });
                            }
                            s.setSourcePageDims(dimsArr.length > 0 ? dimsArr : [{ w: metadata.widthPt, h: metadata.heightPt }]);
                        } else {
                            s.setSourcePageDims([{ w: metadata.widthPt, h: metadata.heightPt }]);
                        }
                    }
                    return; // DO NOT run pdf-lib on dummy File objects, it will crash!
                }
                
                // Only run pdf-lib if we actually have a real File buffer (e.g. web version)
                if (pdfFile.size > 0) {
                    const { PDFDocument } = await import('pdf-lib');
                    const buf = await pdfFile.arrayBuffer();
                    const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
                    if (isActive && doc.getPageCount() > 0) {
                        const page = doc.getPage(0);
                        const { PDFName, PDFArray, PDFNumber } = await import('pdf-lib');
                        
                        const trimNode = page.node.lookupMaybe(PDFName.of('TrimBox'), PDFArray);
                        const userUnitNode = page.node.lookupMaybe(PDFName.of('UserUnit'), PDFNumber);
                        const userUnit = userUnitNode ? userUnitNode.value() : 1.0;
                        
                        let w = page.getSize().width;
                        let h = page.getSize().height;
                        
                        if (trimNode) {
                            const rect = trimNode.asRectangle();
                            w = rect.width;
                            h = rect.height;
                        }
                        
                        s.setSourcePageDim({ w: w * userUnit, h: h * userUnit });
                    }
                }
            } catch (e) { console.error('Failed to load PDF dimensions', e); }
        };
        loadPdfMetadata();
        return () => { isActive = false; };
    }, [pdfFile, s.autoCatalog, s.taskMode]);

    // ═══ Tự nhận bleed từ file (TrimBox vs MediaBox) → điền sẵn vào ô bleed UI ═══
    // Chỉ điền 1 lần khi MỞ FILE MỚI; người dùng vẫn tự sửa lại bleed mong muốn sau đó.
    const _bleedAutoFileRef = useRef<string | null>(null);
    useEffect(() => {
        if (!pdfFile) return;
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
    }, [pdfFile]);

    // Auto Catalog: recalculate optimizer + planner
    useEffect(() => {
        if (!s.autoCatalog || !s.sourcePageDim || !sourceTotalPages || sourceTotalPages < 4) {
            s.setOptimalData(null); s.setCatalogPreview(''); s.setCatalogJobsState(null);
            return;
        }
        // Always use customSheetWidth/Height — already synced by formsize change effect
        let sheetW = s.customSheetWidth;
        let sheetH = s.customSheetHeight;

        if (s.paperClassification === 'offset') {
            const rawW = sheetW;
            const rawH = sheetH;
            sheetW = Math.max(rawW, rawH);
            sheetH = Math.min(rawW, rawH);
        }

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
                s.setCatalogPreview('--- Lỗi: Khổ giấy quá bé ---');
                s.setCatalogJobsState(null);
            }
        });
    }, [s.autoCatalog, s.sourcePageDim, sourceTotalPages, s.formsize, s.customSheetWidth, s.customSheetHeight, s.gripperMargin, s.marginTop, s.marginLeft, s.marginRight, s.bleed, s.gapX, s.gapY, s.signatureMode, s.catalogHasCover, s.catalogMasterSigOverride, s.catalogRemainderPlacement]);

    // Batch layout reset + fetch
    useEffect(() => {
        s.setPreviewCapacities({});
        s.setFetchEpoch(e => e + 1);
    }, [s.formsize, s.customSheetWidth, s.customSheetHeight, s.marginLeft, s.marginRight, s.marginTop, s.marginBottom, s.gapX, s.gapY, s.gridStrategy, activeTool, detectedDimensionsByPage, detectedShapesByPage, s.pontType]);

    // System merge files
    useEffect(() => {
        if (systemMergeFiles?.length > 0) {
            setActiveTool('merge');
            setMergeSettings(prev => ({ ...prev, mode: 'merge_files', filesToMerge: [...(prev.filesToMerge || []), ...systemMergeFiles] }));
        }
    }, [systemMergeFiles]);

    // Preset modal listener
    useEffect(() => {
        const h = () => s.setIsPresetOpen(true);
        window.addEventListener('open-preset-modal', h);
        return () => window.removeEventListener('open-preset-modal', h);
    }, []);

    // ═══ Execute Handler ═══
    const handleExecute = async () => {
        if (s.taskMode === 'booklet') {
            if (s.autoCatalog && onStartCatalogPlan && s.optimalData?.recommended) {
                // Always use customSheetWidth/Height — already synced by formsize change effect
                let sheetW = s.customSheetWidth;
                let sheetH = s.customSheetHeight;
                if (s.paperClassification === 'offset') {
                    const rawW = sheetW;
                    const rawH = sheetH;
                    sheetW = Math.max(rawW, rawH);
                    sheetH = Math.min(rawW, rawH);
                }
                let targetMasterSig = s.optimalData.recommended.pagesPerSig;
                if (s.catalogMasterSigOverride !== 'auto') targetMasterSig = parseInt(s.catalogMasterSigOverride, 10);
                onStartCatalogPlan(
                    { totalPages: sourceTotalPages || 0, bindingMode: s.signatureMode === 'thread' ? 'perfect' : 'saddle', hasSeparateCover: s.catalogHasCover, masterSig: targetMasterSig, remainderPlacement: s.catalogRemainderPlacement },
                    { sheetWidth: sheetW, sheetHeight: sheetH, bleed: s.bleed, markType: s.markType, markOffset: s.marksConfig?.distance, markLength: s.marksConfig?.length, markThickness: s.marksConfig?.thickness, markStyle: s.marksConfig?.style === 2 ? 'japanese' : 'default', gripperMargin: s.gripperMargin, marginTop: s.marginTop, marginLeft: s.marginLeft, marginRight: s.marginRight, paperThickness: s.paperThickness, gapX: s.gapX, gapY: s.gapY, spreadDistribution: s.spreadDistribution, spawnNewTab: s.spawnNewTab } as any
                );
                return;
            }
            
            let effSheetW = s.customSheetWidth;
            let effSheetH = s.customSheetHeight;
            if (s.paperClassification === 'offset') {
                effSheetW = Math.max(s.customSheetWidth, s.customSheetHeight);
                effSheetH = Math.min(s.customSheetWidth, s.customSheetHeight);
            }
            
            onStartBooklet({
                signatureMode: s.signatureMode, foliosize: s.foliosize,
                formsize: (s.scaleMode === '100') ? 'auto_100' : s.formsize,
                customSheetWidth: effSheetW, customSheetHeight: effSheetH,
                bleed: s.bleed, paperThickness: s.paperThickness, markType: s.markType,
                markOffset: s.marksConfig.distance, markLength: s.marksConfig.length, markThickness: s.marksConfig.thickness,
                markStyle: s.marksConfig.style === 2 ? 'japanese' : 'default',
                spawnNewTab: s.spawnNewTab,
                interleave: s.paperClassification === 'in_nhanh' ? 'normal' : s.interleave,
                scaleMode: s.paperClassification === 'offset' ? 'chain_nup' : (s.scaleMode === 'cut_stack' ? 'cut_stack' : s.scaleMode),
                foldPattern: (s.paperClassification === 'offset' && s.foldPattern) ? s.foldPattern : (s.scaleMode === 'chain_nup' && s.foldPattern) ? s.foldPattern : undefined,
                gripperMargin: (s.paperClassification === 'offset' && s.foldPattern) ? s.gripperMargin : (s.scaleMode === 'chain_nup' && s.foldPattern) ? s.gripperMargin : undefined,
                marginTop: s.marginTop, marginBottom: s.marginBottom, marginLeft: s.marginLeft, marginRight: s.marginRight,
                marginMode: s.marginMode, gapX: s.gapX, gapY: s.gapY,
                spreadDistribution: s.spreadDistribution,
                gutterMargin: (s.signatureMode === 'continuous' || s.signatureMode === 'thread') ? s.gutterMargin : undefined,
                separateCover: s.separateCover && (s.signatureMode === 'continuous' || s.signatureMode === 'thread') ? true : undefined,
                coverPageCount: s.separateCover ? s.coverPageCount : undefined,
            });
        } else {
            let finalFormsize = s.formsize;
            if (s.formsize.startsWith('custom_') || s.formsize === 'custom') finalFormsize = 'custom';
            
            let effSheetW = s.customSheetWidth;
            let effSheetH = s.customSheetHeight;
            if (s.paperClassification === 'offset') {
                effSheetW = Math.max(s.customSheetWidth, s.customSheetHeight);
                effSheetH = Math.min(s.customSheetWidth, s.customSheetHeight);
            }

            // ADD GRIPPER MARGIN TO BOTTOM MARGIN FOR N-UP
            let effMarginBottom = s.marginBottom;
            if (s.gripperMargin && s.gripperMargin > 0 && s.taskMode !== 'booklet') {
                effMarginBottom += s.gripperMargin;
            }

            let splitGap = s.clusterGap && s.clusterGap > 0 ? s.clusterGap : Math.max(s.gapX || 0, s.gapY || 0, 5);
            if ((s.markType === 'guillotine' || s.markType === 'corners') && 
                (!s.clusterGap || s.clusterGapMode === 'mark')) {
                const markClearance = (s.marksConfig?.length ?? 5.0) + (s.marksConfig?.distance ?? 3.0);
                // Gap = chính xác 2×markClearance để đỉnh mark 2 cụm CHẠM NHAU.
                splitGap = 2 * markClearance;
            }

            // Tự động lưu: nếu đã tick nhưng CHƯA chọn thư mục → hỏi ngay (không im lặng).
            let autoFolder = s.savePrint.lastFolder;
            if ((activeTool === 'sticker_imposer' || activeTool === 'cnc_imposer') && s.savePrint.autoSave && !autoFolder) {
                try {
                    const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
                    const dir = await openDialog({ directory: true, multiple: false, title: 'Đã bật Tự động lưu — chọn thư mục lưu file in' });
                    if (typeof dir === 'string') { autoFolder = dir; s.setSavePrint({ lastFolder: dir }); }
                } catch { /* ignore */ }
            }

            onStartNup({
                layoutType: s.taskMode === 'step_repeat' ? 'repeat' : s.layoutType,
                formsize: finalFormsize, customSheetWidth: effSheetW, customSheetHeight: effSheetH,
                bleed: s.bleed, columns: s.columns, rows: s.rows, gridStrategy: s.gridStrategy, groupingStrategy: s.groupingStrategy,
                clusterMode: s.clusterMode, clusterCount: s.clusterCount, clusterGap: s.clusterGap,
                clusterGapMode: s.clusterGapMode, clusterDistribution: s.clusterDistribution, clusterBorder: s.clusterBorder,
                splitGap: splitGap,
                gapX: s.gapX, gapY: s.gapY, marginTop: s.marginTop, marginBottom: effMarginBottom, marginLeft: s.marginLeft, marginRight: s.marginRight,
                marginMode: (activeTool === 'sticker_imposer' || activeTool === 'cnc_imposer') ? 'labels_only' : s.marginMode,
                duplexFlow: s.duplexFlow, align: s.align, mirrorAlign: true,
                markType: getImposerCapability(activeTool === 'sticker_imposer' ? 'diecut' : activeTool === 'cnc_imposer' ? 'cnc' : 'guillotine').supportsMarks ? s.markType : 'none',
                markOffset: s.marksConfig.distance, markLength: s.marksConfig.length, markThickness: s.marksConfig.thickness,
                markStyle: s.marksConfig.style === 2 ? 'japanese' : 'default',
                cutType: s.cutType, fillBlockGap: s.fillBlockGap, pontType: s.pontType, pontConfig: s.pontConfig,
                separateCutPage: s.separateCutPage, pontsOnCutFile: s.pontsOnCutFile,
                isDieCutMode: activeTool === 'sticker_imposer' || activeTool === 'cnc_imposer',
                shapeType: detectedShapeType, shapeParams: detectedShapeParams,
                targetQuantity: s.targetQuantity, targetQuantitiesByPage: s.targetQuantitiesByPage,
                detectedShapesByPage, detectedShapeParamsByPage, spawnNewTab: s.spawnNewTab,
                // Report & xuất tờ duy nhất (spec: binh-tem-be-report) — luôn bật cho sticker & CNC
                exportUniqueSheets: activeTool === 'sticker_imposer' || activeTool === 'cnc_imposer',
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
                autoSavePrint: stickerLike && s.savePrint.autoSave && !!autoFolder,
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
        booklet: s.taskMode === 'booklet' ? { signatureMode: s.signatureMode, foliosize: s.foliosize, paperThickness: s.paperThickness, scaleMode: s.paperClassification === 'offset' ? 'chain_nup' : s.scaleMode, interleave: s.interleave, foldPattern: s.foldPattern || undefined, gripperMargin: s.gripperMargin } : undefined,
        nup: s.taskMode !== 'booklet' ? { layoutType: s.layoutType, columns: s.columns, rows: s.rows, gridStrategy: s.gridStrategy, groupingStrategy: s.groupingStrategy, duplexFlow: s.duplexFlow, align: s.align, clusterMode: s.clusterMode, clusterCount: s.clusterCount, clusterGap: s.clusterGap, clusterGapMode: s.clusterGapMode } : undefined,
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
            s.setInterleave(preset.booklet.interleave);
            if (preset.booklet.foldPattern) s.setFoldPattern(preset.booklet.foldPattern);
            if (preset.booklet.gripperMargin) s.setGripperMargin(preset.booklet.gripperMargin);
        }
        if (preset.nup) {
            s.setLayoutType(preset.nup.layoutType); s.setColumns(preset.nup.columns); s.setRows(preset.nup.rows);
            s.setGridStrategy(preset.nup.gridStrategy || 'optimal_auto'); s.setDuplexFlow(preset.nup.duplexFlow);
            s.setAlign(preset.nup.align as any);
            s.setClusterMode(preset.nup.clusterMode); s.setClusterCount(preset.nup.clusterCount);
            s.setClusterGap(preset.nup.clusterGap); s.setClusterGapMode(preset.nup.clusterGapMode);
        }
    }, [s]);

    // ═══ Computed Values ═══
    const isPreprocessing = ['shuffle','resize','split','preflight','pageboxes','hairlines','convertcolors','trapping','pdfx','ocr','optimize','sticker','bgremover','watermark','upscale','pages'].includes(activeTool);
    // CNC dùng chung render/preview die-cut với Bế tem (trừ pont — CNC dùng dấu canh riêng).
    const stickerLike = activeTool === 'sticker_imposer' || activeTool === 'cnc_imposer';
    const showPaperSection = s.taskMode !== 'booklet' || (s.taskMode === 'booklet' && s.scaleMode !== '100');
    const requiredClassif = (s.taskMode === 'booklet' && s.foldPattern && s.foldPattern !== '' && s.foldPattern !== 'auto') ? 'offset' : null;
    const marginSummary = (s.marginTop === s.marginBottom && s.marginBottom === s.marginLeft && s.marginLeft === s.marginRight)
        ? (s.marginTop > 0 ? `Lề: ${s.marginTop}mm` : '') : `Lề: ${s.marginTop}/${s.marginBottom}/${s.marginLeft}/${s.marginRight}`;

    // ═══ RENDER ═══
    if (activeTool === 'none') {
        return <ToolMenuList setActiveTool={t => setActiveTool(t as ActiveToolType)} setTaskMode={m => {
            // When clicking "N-Up" tool (lockedMode='nup'), preserve 'step_repeat' if already set
            // (they're sub-modes of the same N-Up group)
            if (m === 'nup' && (s.taskMode === 'nup' || s.taskMode === 'step_repeat')) return;
            s.setTaskMode(m as TaskMode);
        }} onActiveToolChange={onActiveToolChange} />;
    }

    const paperSectionJSX = (
        <>
            <div className={`space-y-1 transition-opacity ${showPaperSection ? 'opacity-100' : 'opacity-40 pointer-events-none'}`}>

                <div className="flex items-center gap-3">
                    <label className="text-[11px] font-bold text-slate-600 uppercase tracking-wide shrink-0 w-[95px]" title="Khổ giấy (Paper)">
                        KHỔ GIẤY
                    </label>
                    <div className="flex flex-1 items-center gap-2 min-w-0">
                        <select value={s.formsize} onChange={(e) => s.setFormsize(e.target.value)}
                            className="flex-1 min-w-0 h-8 px-2 appearance-auto border border-slate-300 dark:border-white/20 rounded bg-white dark:bg-zinc-900 text-sm focus:outline-none focus:border-indigo-500 font-medium">
                            {s.paperClassification === 'in_nhanh' && (
                                <optgroup label="Khổ Mặc Định (In Nhanh)">
                                    <option value="A4">A4 (210 x 297 mm)</option><option value="A3">A3 (297 x 420 mm)</option>
                                    <option value="SRA3">SRA3 (320 x 450 mm)</option><option value="B">Khổ B (320 x 430 mm)</option>
                                    <option value="Ledger">Ledger (279 x 432 mm)</option>
                                </optgroup>
                            )}
                            {savedForms.length > 0 && s.paperClassification === 'offset' && (
                                <optgroup label="Khổ Đã Lưu (In Offset)">
                                    {savedForms.filter(f => f.classification === 'offset').map(f => (<option key={f.id} value={f.id}>{f.name} ({f.w}x{f.h}mm)</option>))}
                                </optgroup>
                            )}
                            {savedForms.length > 0 && s.paperClassification === 'in_nhanh' && (
                                <optgroup label="Khổ Đã Lưu (In Nhanh)">
                                    {savedForms.filter(f => !f.classification || f.classification === 'in_nhanh').map(f => (<option key={f.id} value={f.id}>{f.name} ({f.w}x{f.h}mm)</option>))}
                                </optgroup>
                            )}
                            <optgroup label="Khác"><option value="custom">+ Tạo khổ giấy mới (Custom)...</option></optgroup>
                        </select>
                        <button onClick={() => s.setShowSettings(true)} className="shrink-0 w-8 h-8 rounded border border-slate-300 dark:border-white/20 flex items-center justify-center text-slate-500 hover:text-indigo-600 hover:border-indigo-400 transition-colors bg-white dark:bg-zinc-900" title="Thiết lập Lề giấy">
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                        </button>
                    </div>
                </div>
            </div>
            <PaperSettingsDialog isOpen={s.showSettings} onClose={() => s.setShowSettings(false)} width={s.customSheetWidth} height={s.customSheetHeight} marginTop={s.marginTop} marginBottom={s.marginBottom} marginLeft={s.marginLeft} marginRight={s.marginRight} marginMode={s.marginMode} classification={s.paperClassification} gripperMargin={s.gripperMargin} onApply={handleSettingsApply} savedForms={savedForms} onSavePreset={handleSavePreset} onUpdatePreset={handleUpdatePreset} onDeletePreset={handleDeletePreset} currentFormsize={s.formsize} />
        </>
    );

    return (
        <div className="flex flex-col gap-5 pb-4 transition-all">
            {/* ═══ PREPROCESSING TOOLS ═══ */}
            {isPreprocessing && (
                <PreprocessingRouter
                    tabId={tabId} activeTool={activeTool} pdfFile={pdfFile || null} isProcessing={isProcessing}
                    onStartShuffle={onStartShuffle} onStartResize={onStartResize}
                    onStartSplit={onStartSplit} onStartMerge={onStartMerge}
                    onIssueSelect={onIssueSelect} onOpenOutputPreview={onOpenOutputPreview} onFileFixed={onFileFixed}
                />
            )}

            {/* ═══ MERGE (special — keeps local state) ═══ */}
            {activeTool === 'merge' && (
                <div>
                    <div className="pt-2 text-center pb-2">
                        <h2 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center justify-center gap-2">
                            <span>🔗</span>
                            <span>Ghép file & Chèn trang</span>
                        </h2>
                        <p className="text-[11px] text-slate-500 mt-1">Gộp nhiều PDF, trộn xen kẽ lẻ chẵn, chèn trang đệm.</p>
                    </div>
                    <MergeTool settings={mergeSettings} onChange={setMergeSettings} />
                    <div className="mt-4 mb-2">
                        <Checkbox checked={s.spawnNewTab} onChange={s.setSpawnNewTab} label="Mở kết quả sang Tab mới" />
                    </div>
                    <button onClick={() => onStartMerge && onStartMerge({ ...mergeSettings, spawnNewTab: s.spawnNewTab })} disabled={isProcessing}
                        className="mt-2 w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded font-bold shadow-sm transition-colors disabled:opacity-50">
                        {isProcessing ? 'Đang áp dụng...' : 'Thực Thi Ghép File'}
                    </button>
                </div>
            )}

            {/* ═══ IMPOSITION SETTINGS ═══ */}
            {!isPreprocessing && (
                <>
                    {/* ═══ IMPOSITION HEADER ═══ */}
                    {activeTool === 'booklet' && (
                        <div className="pt-2 text-center pb-2">
                            <h2 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center justify-center gap-2">📚 BÌNH SÁCH & TẠP CHÍ</h2>
                            <p className="text-[11px] text-slate-500 mt-1">Dựng tay sách lồng đôi, tính độ bù gáy (Creep).</p>
                        </div>
                    )}
                    
                    {activeTool === 'nup' && (
                        <div className="pt-2 text-center pb-2">
                            <h2 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center justify-center gap-2">🎴 BÌNH BÀI XÉN</h2>
                            <p className="text-[11px] text-slate-500 mt-1">Sắp xếp tự động nhiều đối tượng hoặc nhân bản chính xác trên khổ in.</p>
                        </div>
                    )}

                    {activeTool === 'sticker_imposer' && (
                        <div className="pt-2 text-center pb-2">
                            <h2 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center justify-center gap-2">🏷️ BÌNH BÀI BẾ TEM</h2>
                            <p className="text-[11px] text-slate-500 mt-1">Sắp xếp tối ưu tem nhãn và tự động nhận diện hình dạng.</p>
                        </div>
                    )}

                    {activeTool === 'cnc_imposer' && (
                        <div className="pt-2 text-center pb-2">
                            <h2 className="text-sm font-bold text-slate-800 dark:text-white uppercase tracking-wider flex items-center justify-center gap-2">🔻 BÌNH BẾ RỚT (CNC)</h2>
                            <p className="text-[11px] text-slate-500 mt-1">Cắt rời CNC: bình 2 mặt (lật gương), dấu canh CNC, xuất Trước/Sau/Khuôn.</p>
                        </div>
                    )}

                    {activeTool === 'cnc_imposer' && (
                        <CncSettingsSection
                            twoSided={s.duplexFlow === 'double'}
                            setTwoSided={(v) => s.setDuplexFlow(v ? 'double' : 'normal')}
                            cncFlipEdge={s.cncFlipEdge} setCncFlipEdge={s.setCncFlipEdge}
                            cncDuplexMarks={s.cncDuplexMarks} setCncDuplexMarks={s.setCncDuplexMarks}
                            sourceTotalPages={sourceTotalPages}
                        />
                    )}

                    <Divider />
                    <AutoCatalogSection />
                    <BookletSettingsSection />
                    
                    {s.taskMode === 'booklet' && (
                        <div className="mt-2">{paperSectionJSX}</div>
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
                            />
                        </>
                    )}

                    <AdvancedSettingsSection activeTool={activeTool} />

                    {/* Grid preview for all modes */}
                    {(s.taskMode === 'nup' || s.taskMode === 'step_repeat' || s.taskMode === 'sticker_imposer') && (
                        <>
                            {(() => {
                                const safeGetPageIdx = () => {
                                    if (viewerPageOrder && viewerPageOrder.length > 0) {
                                        const p = viewerPageOrder[viewerActivePage - 1];
                                        if (p !== undefined && p !== null) return p - 1;
                                    }
                                    return (viewerActivePage || 1) - 1;
                                };
                                const safePageIdx = safeGetPageIdx();
                                
                                let effMarginTop = s.marginTop || 0;
                                let effMarginBottom = s.marginBottom || 0;
                                let effMarginLeft = s.marginLeft || 0;
                                let effMarginRight = s.marginRight || 0;
                                
                                if (s.gripperMargin && s.gripperMargin > 0 && s.taskMode !== 'booklet') {
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

                                let splitGap = s.clusterGap && s.clusterGap > 0 ? s.clusterGap : Math.max(s.gapX || 0, s.gapY || 0, 5);
                                if ((s.markType === 'guillotine' || s.markType === 'corners') && 
                                    (!s.clusterGap || s.clusterGapMode === 'mark')) {
                                    const markClearance = (s.marksConfig?.length ?? 5.0) + (s.marksConfig?.distance ?? 3.0);
                                    // Gap = chính xác 2×markClearance để đỉnh mark 2 cụm CHẠM NHAU.
                                    splitGap = 2 * markClearance;
                                }

                                return (
                            <GridPreview
                                taskMode={s.taskMode} gridStrategy={s.gridStrategy} columns={s.columns} rows={s.rows}
                                duplexFlow={activeTool === 'sticker_imposer' ? 'single' : s.duplexFlow}
                                isDieCut={stickerLike}
                                splitGap={splitGap}
                                gapX={s.gapX} gapY={s.gapY}
                                groupingStrategy={s.groupingStrategy}
                                clusterSizingMode={s.clusterSizingMode}
                                clusterCols={s.clusterCols} clusterRows={s.clusterRows}
                                clusterTileW={s.clusterTileW} clusterTileH={s.clusterTileH}
                                tileGapX={s.tileGapX} tileGapY={s.tileGapY}
                                sheetWidth={s.formsize === 'custom' || s.formsize.startsWith('custom_') ? s.customSheetWidth : (PREDEFINED_SIZES[s.formsize]?.w || 320)}
                                sheetHeight={s.formsize === 'custom' || s.formsize.startsWith('custom_') ? s.customSheetHeight : (PREDEFINED_SIZES[s.formsize]?.h || 450)}
                                marginTop={effMarginTop} marginBottom={effMarginBottom} marginLeft={effMarginLeft} marginRight={effMarginRight}
                                align={s.align}
                                shapeType={stickerLike ? (detectedShapesByPage[safePageIdx] || 'CUSTOM') : 'RECTANGLE'}
                                itemW={(() => { const dim = detectedDimensionsByPage[safePageIdx]; const w = dim?.w ?? s.sourcePageDim?.w; return (typeof w === 'number' && !isNaN(w)) ? w * 0.352778 : 90; })()}
                                itemH={(() => { const dim = detectedDimensionsByPage[safePageIdx]; const h = dim?.h ?? s.sourcePageDim?.h; return (typeof h === 'number' && !isNaN(h)) ? h * 0.352778 : 55; })()}
                                targetQuantity={s.targetQuantity}
                                targetQuantitiesByPage={stickerLike ? s.targetQuantitiesByPage : undefined}
                                sourceTotalPages={sourceTotalPages}
                                imposerMode={activeTool === 'cnc_imposer' ? 'cnc' : undefined}
                                cncTwoSided={activeTool === 'cnc_imposer' && s.duplexFlow === 'double'}
                                cncFlipEdge={s.cncFlipEdge}
                                shapeParams={(() => { const params = detectedShapeParamsByPage[safePageIdx]; return params ? (typeof params === 'string' ? params : JSON.stringify(params)) : null; })()}
                                shapesByPage={stickerLike ? detectedShapesByPage : undefined}
                                shapeParamsByPage={stickerLike ? detectedShapeParamsByPage : undefined}
                                isDetectingShape={isDetectingShape}
                                pontType={s.pontType} pontConfig={(activeTool === 'sticker_imposer' && s.pontType !== 'none') ? s.pontConfig : null}
                                onCapacityChange={(cap) => { s.setPreviewCapacity(cap); s.setPreviewCapacities({ ...s.previewCapacities, [safePageIdx]: cap }); }}
                                onMixedPlacedByPage={(m) => s.setMixedPlacedByPage(m)}
                                fileId={stickerLike ? selectionFileId : undefined}
                                pageIdx={safePageIdx}
                                bleed={s.bleed}
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
                                    className="flex-1 h-11 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-semibold transition-colors disabled:opacity-50 flex items-center justify-center gap-2">📖 Xem Thành Phẩm</button>
                                <button onClick={() => s.setShowSheetViewer(true)} disabled={isProcessing || !pdfFile}
                                    className="flex-1 h-11 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm font-semibold transition-colors disabled:opacity-50 flex items-center justify-center gap-2 border border-slate-600">🖨️ Xem Bài In</button>
                            </div>
                        )}
                        <button onClick={handleExecute} disabled={isProcessing}
                            className="w-full h-11 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-semibold transition-colors disabled:opacity-50 flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1">
                            {isProcessing ? 'Đang xử lý...' : (activeTool === 'cnc_imposer' ? 'Thực thi Bình Bế Rớt (CNC)' : activeTool === 'sticker_imposer' ? 'Thực thi Bình Tem Bế' : s.taskMode === 'booklet' ? 'Thực thi Bình Sách (Booklet)' : s.taskMode === 'step_repeat' ? 'Thực thi Nhân bản (Step & Repeat)' : 'Thực thi Dàn trang (N-Up)')}
                        </button>
                    </div>
                </>
            )}

            {/* Error */}
            {globalError && (
                <div className="p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800/50 rounded text-sm">{globalError}</div>
            )}

            {/* ═══ DIALOGS ═══ */}
            <MarksSettingsDialog isOpen={s.showMarksModal} onClose={() => s.setShowMarksModal(false)} config={s.marksConfig} onSave={(cfg) => { s.setMarksConfig(cfg); }} />
            <PontSettingsDialog isOpen={s.showPontModal} onClose={() => s.setShowPontModal(false)} config={s.pontConfig} onSave={(cfg) => { s.setPontConfig(cfg); }} />
            <PresetSelector isOpen={s.isPresetOpen} onClose={() => s.setIsPresetOpen(false)} onLoadPreset={handleLoadPreset} onGetCurrentSettings={getCurrentSettings} />
            <FlipbookDialog isOpen={s.showFlipbook} onClose={() => s.setShowFlipbook(false)} pdfUrl={pdfUrl} pdfFile={pdfFile} pageOrder={viewerPageOrder || []} bindingMode={s.signatureMode} foliosize={s.foliosize} />
            <SheetViewerDialog isOpen={s.showSheetViewer} onClose={() => s.setShowSheetViewer(false)} pdfFile={pdfFile} pageOrder={viewerPageOrder || []} bindingMode={s.signatureMode} foliosize={(s.paperClassification === 'offset' && s.foldPattern?.startsWith('sig_')) ? parseInt(s.foldPattern.split('_')[1]) : s.foliosize} sheetWidth={s.customSheetWidth} sheetHeight={s.customSheetHeight} scaleMode={s.paperClassification === 'offset' ? 'chain_nup' : s.scaleMode} foldPattern={s.foldPattern} catalogJobs={s.autoCatalog && s.catalogJobsState ? s.catalogJobsState : undefined} isDigital={s.paperClassification === 'in_nhanh'} gripperMargin={s.gripperMargin} />
        </div>
    );
}
