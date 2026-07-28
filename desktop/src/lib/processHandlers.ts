/**
 * Processing handlers extracted from ImpositionTab.tsx
 * 
 * These are pure async functions that receive all dependencies as parameters,
 * eliminating closure dependency on component state.
 */

import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { imposeCatalogBatchViaBackend, ImpositionMode, type ProcessingSettings } from '../lib/pdfImposer';
import { planCatalog, verifyCatalogPlan, type PlanConfig } from '../lib/imposerEngine/CatalogPlanner';
import { getImposerCapability } from '../components/imposition-tools/types';
import { applyRule, executeShuffle, parseRule, reversePages, shuffleEvenOdd } from '../lib/preprocessEngine/ShuffleEngine';
import { resizePages } from '../lib/preprocessEngine/PageResizer';
import { splitPdf, parseRanges } from '../lib/preprocessEngine/PdfSplitter';
import { mergePdf } from '../lib/preprocessEngine/PdfMerger';
import i18n, { tv } from '../i18n';
// UIUX (audit 2026-07-27 §D-15/§D-11): lỗi kỹ thuật → câu Việt + hướng khắc phục; toast có nút hành động
import { formatError, isCanceled } from './errorMessages';
import { toast } from '../components/ui/Toast';

// UIUX (audit 2026-07-27 §D-09): tác vụ nặng chạy lâu — trấn an để user không tưởng app treo.
// (KHÔNG thêm nút hủy: backend chưa có endpoint cancel cho các route preprocess.)
const LONG_TASK_HINT = () =>
    i18n.t('lib.processHandlers:file_lon_co_the_mat_vai_phut', { defaultValue: '… (file lớn có thể mất vài phút — đừng đóng tab)' });

// ─── Shared context type for all handlers ───
export interface ProcessContext {
    file: File;
    onSpawnTab?: (file: File, extra?: any) => void;
    // async: playback chuỗi bytes qua commit (currentBytes cập nhật SAU await
    // blob.arrayBuffer()) → mọi call site PHẢI await, nếu không bước kế đọc bytes cũ.
    commitWorkingFile: (blob: Blob, name: string, existingPath?: string) => void | Promise<void>;
    setError: (msg: string) => void;
    setIsProcessing: (v: boolean) => void;
    setProcessStatus: (msg: string) => void;
    setReportMsg: (msg: string) => void;
    setBatchOutput: (v: any) => void;
    setCancelHandler?: (handler: (() => Promise<void>) | null) => void;
    viewerNumPages?: number;
    getWorkingBytes: () => Promise<Uint8Array>;
    getWorkingSourcePath?: () => Promise<string | undefined>;
}

// ═════════════════════════════════════════════
//  Main Imposition Engine (Booklet / N-Up)
// ═════════════════════════════════════════════

export async function runProcessEngine(
    ctx: ProcessContext,
    settings: ProcessingSettings,
    spawnNewTab: boolean
) {
    const { file, onSpawnTab, commitWorkingFile, setError, setIsProcessing, setProcessStatus, setReportMsg } = ctx;

    setError('');
    setIsProcessing(true);
    setProcessStatus(i18n.t('lib.processHandlers:dang_chuan_bi_du_lieu'));

    try {

        const isDieCut = settings.imposerMode === 'diecut';
        const isGuillotine = settings.imposerMode === 'guillotine';
        const isCnc = settings.imposerMode === 'cnc';
        const isPageSheet = isGuillotine && settings.pageSheetMode === true;
        // Page-sheet dùng capability guillotine để giữ marks; raw UI state không đi qua boundary này.
        const caps = getImposerCapability(isPageSheet ? 'guillotine' : settings.imposerMode);
        const pontSettingsMode = caps.supportsPont || isPageSheet;

        // Task 11: MỌI job N-up (cắt xén + die-cut) đi backend → output dùng chung
        // solver với preview (nup_engine == /preview-layout, sau Task 10). Không còn
        // tính layout phía TS cho đường output (NupGridSolver chỉ còn phục vụ booklet).
        if (settings.impositionMode === ImpositionMode.NUp) {


            const { uploadFileForNup, startNupJobBackend, getNupJobStatus, downloadNupJob, cancelNupJobBackend } = await import('../lib/api');


            // A clean on-disk PDF can go straight to the local backend. Edited or
            // in-memory documents deliberately keep the existing bake/upload path.
            let serverPath = await ctx.getWorkingSourcePath?.();
            if (!serverPath) {
                const workingBytes = await ctx.getWorkingBytes();
                const workingFile = new File([workingBytes as any], file.name, { type: 'application/pdf' });
                serverPath = await uploadFileForNup(workingFile);
            }

            // Watermark: backend tự lấy license từ header X-License-Key đã verify
            // (imposition.py inject _license_key) nên frontend không cần gửi watermarkKey.
            const backendSettings = {
                sheetWidth: settings.sheetWidth, sheetHeight: settings.sheetHeight,
                bleed: settings.bleed, gapX: settings.gapX || 0, gapY: settings.gapY || 0,
                marginTop: settings.marginTop || 0, marginBottom: settings.marginBottom || 0,
                marginLeft: settings.marginLeft || 0, marginRight: settings.marginRight || 0,
                // Gripper/nhíp chỉ N-Up offset — tem bế/CNC không cắn nhíp (tránh rò lề đáy).
                gripperMargin: (isDieCut || isCnc) ? 0 : ((settings as any).gripperMargin || 0),
                marginMode: settings.marginMode || 'labels_only',
                markType: caps.supportsMarks ? ((settings as any).markType || 'none') : 'none',
                markLength: (settings as any).markLength || 5, markOffset: (settings as any).markOffset || 3,
                markThickness: (settings as any).markThickness || 0.25,
                markStyle: (settings as any).markStyle || 'default',
                gridStrategy: isGuillotine || isDieCut || isCnc ? (settings as any).gridStrategy || 'simple_auto' : 'simple_auto',
                layoutType: isGuillotine || isDieCut || isCnc ? (settings as any).layoutType || 'sequential' : 'sequential',
                align: settings.align || 'center',
                cols: settings.cols, rows: settings.rows,
                splitGap: (settings as any).splitGap,
                // CNC cũng là die-cut về bản chất → giữ cờ NHẤT QUÁN với UI (audit #C3).
                // Routing backend vẫn theo imposerMode='cnc' (ưu tiên trước isDieCutMode).
                isDieCutMode: isDieCut || isCnc,
                page_sheet_mode: isPageSheet,
                cutType: isDieCut ? (settings as any).cutType : undefined,
                fillBlockGap: isDieCut ? (settings as any).fillBlockGap : undefined,
                // 1 Dao: khuôn theo trang + offset co/mở (khớp resolve_one_dao_trim backend).
                dieSizeMode: isDieCut ? (settings as any).dieSizeMode : undefined,
                dieOffsetMm: isDieCut ? (settings as any).dieOffsetMm : undefined,
                pontType: pontSettingsMode ? (settings as any).pontType : undefined,
                pontConfig: pontSettingsMode ? (settings as any).pontConfig : undefined,
                detectedShapesByPage: isDieCut || isCnc ? (settings as any).detectedShapesByPage : undefined,
                detectedShapeParamsByPage: isDieCut || isCnc ? (settings as any).detectedShapeParamsByPage : undefined,
                targetQuantity: (settings as any).targetQuantity || 0,
                targetQuantitiesByPage: (settings as any).targetQuantitiesByPage || {},
                // Guillotine (KHÔNG die-cut) chỉ nhận 'cluster_tile' (chia cụm) hoặc
                // 'maximize_area' (lưới đều mặc định) — cho phép cluster_tile đi qua.
                groupingStrategy: isDieCut
                    ? (settings as any).groupingStrategy || 'maximize_area'
                    : ((settings as any).groupingStrategy === 'cluster_tile' ? 'cluster_tile' : 'maximize_area'),
                // ═══ Cluster layout (chia cụm trên tờ giấy) ═══
                clusterMode: (settings as any).clusterMode || 'none',
                clusterCount: (settings as any).clusterCount || 2,
                clusterGap: (settings as any).clusterGap || 0,
                // 'type' = mỗi cọc 1 loại (chia cọc theo tỷ lệ SL); 'default' = ratio_stack trộn ô.
                clusterDistribution: (settings as any).clusterDistribution || 'default',
                clusterTileW: (isDieCut || (settings as any).groupingStrategy === 'cluster_tile') ? (settings as any).clusterTileW || 148 : undefined,
                clusterTileH: (isDieCut || (settings as any).groupingStrategy === 'cluster_tile') ? (settings as any).clusterTileH || 210 : undefined,
                clusterCols: (settings as any).clusterCols || 2,
                clusterRows: (settings as any).clusterRows || 2,
                clusterSizingMode: (settings as any).clusterSizingMode || 'dims',
                clusterCombineMode: (settings as any).clusterCombineMode || 'replicate_mixed',
                clusterNesting: (settings as any).clusterNesting !== false,
                tileGapX: (settings as any).tileGapX || 0,
                tileGapY: (settings as any).tileGapY || 0,
                separateCutPage: isPageSheet
                    ? true
                    : (isDieCut && (settings as any).cutType === 'one_dao'
                        ? true
                        : (isDieCut ? (settings as any).separateCutPage || false : false)),
                pontsOnCutFile: pontSettingsMode ? (settings as any).pontsOnCutFile !== false : undefined,
                hiddenOcgLayerIds: isDieCut ? (settings as any).hiddenOcgLayerIds || [] : [],
                duplexFlow: isPageSheet ? 'normal' : (settings as any).duplexFlow,
                // Report & xuất tờ duy nhất (spec: binh-tem-be-report) — gồm cả CNC
                exportUniqueSheets: (isDieCut || isPageSheet) ? (settings as any).exportUniqueSheets !== false : false,
                reportDisplay: (isDieCut || isCnc || isGuillotine) ? (settings as any).reportDisplay : undefined,
                reportMaterial: (isDieCut || isCnc || isGuillotine) ? (settings as any).reportMaterial : undefined,
                reportLamination: (isDieCut || isCnc || isGuillotine) ? (settings as any).reportLamination : undefined,
                reportLaminationSides: (isDieCut || isCnc || isGuillotine) ? (settings as any).reportLaminationSides : undefined,
                reportOrderCode: (isDieCut || isCnc || isGuillotine) ? (settings as any).reportOrderCode : undefined,
                saveByReport: (isDieCut || isPageSheet) ? (settings as any).saveByReport : undefined,
                // ═══ Bình Bế Rớt (CNC) — định tuyến renderer riêng ở backend ═══
                imposerMode: isCnc ? 'cnc' : undefined,
                cncTwoSided: isCnc ? (settings as any).cncTwoSided : undefined,
                cncFlipEdge: isCnc ? (settings as any).cncFlipEdge : undefined,
                cncDuplexMarks: isCnc ? (settings as any).cncDuplexMarks : undefined,
            };

            const jobId = await startNupJobBackend(serverPath, backendSettings);
            ctx.setCancelHandler?.(async () => {
                await cancelNupJobBackend(jobId);
            });

            let done = false;
            while (!done) {
                const status = await getNupJobStatus(jobId);

                if (status.status === 'completed') {
                    done = true;
                    const newFileName = `Imposed_${file.name.replace('.pdf', '')}_.pdf`;
                    const nativeOutputPath = (
                        typeof window !== 'undefined'
                        && (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
                        && status.output_path
                    ) ? status.output_path as string : undefined;
                    const sp = (settings as any).savePrintConfig;
                    const autoSavePrint = !!((settings as any).autoSavePrint && sp?.folder);
                    let blob: Blob;
                    if (!nativeOutputPath || autoSavePrint) {
                        setProcessStatus(i18n.t('lib.processHandlers:dang_tai_file_ket_qua_ve'));
                        blob = await downloadNupJob(jobId);
                    } else {
                        blob = new Blob(['native-path'], { type: 'application/pdf' });
                    }

                    if (spawnNewTab && onSpawnTab) {
                        const outputFile = new File([blob], newFileName, { type: 'application/pdf' });
                        if (nativeOutputPath) {
                            Object.defineProperty(outputFile, 'path', { value: nativeOutputPath });
                            try {
                                const { stat } = await import('@tauri-apps/plugin-fs');
                                const info = await stat(nativeOutputPath);
                                Object.defineProperty(outputFile, 'size', { value: Number(info.size || 0) });
                            } catch {
                                // Native rendering only needs the physical path.
                            }
                        }
                        onSpawnTab(outputFile, { report: status.report });
                        setProcessStatus('');
                    } else {
                        await commitWorkingFile(blob, newFileName, nativeOutputPath);
                        if (status.report) setReportMsg(status.report);
                    }

                    // ═══ Tự động lưu file in (đã cài trước khi bình) ═══
                    if (autoSavePrint) {
                        try {
                            setProcessStatus(i18n.t('lib.processHandlers:dang_tu_dong_luu_file_in'));
                            const { savePrintFilesToFolder, pagesPerTypeFor } = await import('../lib/savePrintFiles');
                            const cncMode = settings.imposerMode === 'cnc';
                            const cncTwoSided = !!(settings as any).cncTwoSided;
                            const separateCut = isPageSheet || !!(settings as any).separateCutPage;
                            const { ok } = await savePrintFilesToFolder(blob, sp.folder, {
                                nameMode: sp.nameMode, folderMode: sp.folderMode,
                                separateCut, includeOrderCode: sp.includeOrderCode, includeDate: sp.includeDate,
                                orderCode: sp.orderCode, cncMode, cncTwoSided,
                            }, {
                                pagesPerType: pagesPerTypeFor({ cncMode, cncTwoSided, separateCut }),
                                labelName: sp.labelName,
                            });
                            setReportMsg(i18n.t('lib.processHandlers:da_tu_dong_luu_ok_file_in_vao_sp_folder', { ok, folder: sp.folder }));
                            // UIUX (audit 2026-07-27 §D-11): toast thành công kèm nút mở thư mục đã lưu
                            toast.success(
                                i18n.t('lib.processHandlers:da_luu_file_in', { defaultValue: 'Đã tự động lưu {{ok}} file in', ok }),
                                {
                                    label: i18n.t('lib.processHandlers:mo_thu_muc', { defaultValue: 'Mở thư mục' }),
                                    onClick: () => { import('@tauri-apps/plugin-shell').then(m => m.open(sp.folder)).catch(() => {}); },
                                }
                            );
                        } catch (e: any) {
                            // UIUX (audit 2026-07-27 §D-15): câu Việt + hướng khắc phục thay vì e.message thô
                            setError(formatError(e, i18n.t('lib.processHandlers:binh_xong_nhung_luu_file_in_loi', { defaultValue: 'Bình xong nhưng tự động lưu file in lỗi' })));
                        }
                    }
                } else if (status.status === 'failed') {
                    throw new Error(status.error || i18n.t('lib.processHandlers:loi_xu_ly_he_thong'));
                } else if (status.status === 'cancelled') {
                    throw new Error("ABORT_BY_USER");
                } else {
                    const prog = status.progress || '';
                    // Only update display for numeric progress (e.g. "3/10"), ignore backend stage messages
                    if (prog.includes('/')) {
                        setProcessStatus(i18n.t('lib.processHandlers:dang_xu_ly_prog_trang_da_binh', { prog }));
                    }
                    await new Promise(r => setTimeout(r, 500));
                }
            }
        } else {
            // P2-T01: Prefer backend (imposition_core + pikepdf) for imposition to keep client as dumb assembler.
            // Sticker and other modes may use activeDashboardTool or separate paths.
            setProcessStatus(i18n.t('lib.processHandlers:dang_xu_ly_du_lieu_qua_backend_unified'));
            const { imposePdfViaBackend } = await import('../lib/pdfImposer');
            let serverPath: string;
            if ((window as any).__TAURI_INTERNALS__ && (file as any)?.path) {
                // Desktop backend runs on the same machine, so use the physical file directly.
                // This avoids reading and uploading hundreds of MB before imposition.
                serverPath = (file as any).path;
            } else {
                const { uploadFileForNup } = await import('../lib/api');
                serverPath = await uploadFileForNup(file);
            }
            const result = await imposePdfViaBackend(serverPath, settings, setProcessStatus);
            const newFileName = `Imposed_${file.name.replace('.pdf', '')}_.pdf`;

            const nativeOutputPath = (
                (window as any).__TAURI_INTERNALS__
                && result.outputPath
                && result.outputPath !== 'results'
            ) ? result.outputPath : undefined;

            if ((result.blob && result.blob.size > 0) || nativeOutputPath) {
                if (spawnNewTab && onSpawnTab) {
                    const outputFile = new File([result.blob], newFileName, { type: 'application/pdf' });
                    if (nativeOutputPath) {
                        Object.defineProperty(outputFile, 'path', { value: nativeOutputPath });
                        try {
                            const { stat } = await import('@tauri-apps/plugin-fs');
                            const info = await stat(nativeOutputPath);
                            Object.defineProperty(outputFile, 'size', { value: Number((info as any).size || 0) });
                        } catch {
                            // The physical path is sufficient for rendering even if size metadata is unavailable.
                        }
                    }
                    onSpawnTab(outputFile);
                    setProcessStatus('');
                } else {
                    await commitWorkingFile(result.blob, newFileName, nativeOutputPath);
                    if (result.report) setReportMsg(result.report);
                }
            } else {
                setReportMsg(i18n.t('lib.processHandlers:file_da_duoc_luu_tren_server_result', { outputPath: result.outputPath, report: result.report }));
            }
        }
    } catch (e: any) {
        if (e.message === "ABORT_BY_USER") {
            // Silently abort, user cancelled
            return;
        }
        // UIUX (audit 2026-07-27 §D-15): Hủy thì im lặng; lỗi khác dịch thành câu Việt + hướng khắc phục
        if (isCanceled(e)) return;
        setError(formatError(e, i18n.t('lib.processHandlers:khong_binh_duoc_trang', { defaultValue: 'Không bình được trang' })));
    } finally {
        ctx.setCancelHandler?.(null);
        setIsProcessing(false);
    }
}

// ═════════════════════════════════════════════
//  Catalog Auto Plan Handler
// ═════════════════════════════════════════════

export async function runCatalogPlan(
    ctx: ProcessContext,
    planConfig: PlanConfig,
    sheetSettings: Partial<ProcessingSettings> & { spawnNewTab?: boolean }
) {
    const { file, onSpawnTab, commitWorkingFile, setError, setIsProcessing, setProcessStatus, setBatchOutput } = ctx;

    setError('');
    setIsProcessing(true);
    setProcessStatus(i18n.t('lib.processHandlers:dang_phan_tich_cau_truc_catalog'));

    try {
        const planResult = planCatalog({ ...planConfig, sourceFileName: file.name });
        const verifyErrors = verifyCatalogPlan(planConfig, planResult);
        if (verifyErrors.length > 0) {
            throw new Error(i18n.t('lib.processHandlers:loi_phan_tich_verifyerrors_join', { errors: verifyErrors.join('; ') }));
        }

        setProcessStatus(i18n.t('lib.processHandlers:dang_binh_planresult_jobs_length_tam', { count: planResult.jobs.length }));

        // Tuân thủ kết quả cuối cùng: bình catalog trên file đã áp dụng sửa đổi trang.
        const workingBytes = await ctx.getWorkingBytes();
        const workingFile = new File([workingBytes as any], file.name, { type: 'application/pdf' });
        const { uploadFileForNup } = await import('../lib/api');
        const serverPath = await uploadFileForNup(workingFile);
        const batchResults = await imposeCatalogBatchViaBackend(serverPath, planResult.jobs, sheetSettings, setProcessStatus, 'results');
        const successCount = batchResults.filter(r => r.blob.size > 0).length;


        const mergedDoc = await PDFDocument.create();
        for (const r of batchResults) {
            if (r.blob.size > 0) {
                const rBytes = await r.blob.arrayBuffer();
                const rDoc = await PDFDocument.load(rBytes, { ignoreEncryption: true });
                const copiedPages = await mergedDoc.copyPages(rDoc, rDoc.getPageIndices());
                copiedPages.forEach(p => mergedDoc.addPage(p));
            }
        }

        // Renumber plates globally
        let globalPlateNum = 0;
        for (const pg of mergedDoc.getPages()) {
            const existingUri = pg.node.get(PDFName.of('PlateInfoURI'));
            if (existingUri) {
                globalPlateNum++;
                let rawStr = (existingUri as any).decodeText?.() || (existingUri as any).value || String(existingUri);
                rawStr = rawStr.replace(/^\(|\)$/g, '');
                try {
                    const decoded = decodeURIComponent(rawStr);
                    // Nhãn kẽm có thể là "Kẽm N" (vi) hoặc "Plate N" (en) tuỳ ngôn ngữ lúc bình.
                    // Giữ nguyên tiền tố đã bồi, chỉ đánh lại SỐ để merge nhiều bài không vỡ.
                    const renumbered = decoded.replace(/^(Kẽm|Plate) \d+/, `$1 ${globalPlateNum}`);
                    pg.node.set(PDFName.of('PlateInfoURI'), PDFString.of(encodeURIComponent(renumbered)));
                } catch (e) { console.warn('Failed to decode PlateInfoURI', e); }
            } else {
                const existing = pg.node.get(PDFName.of('PlateInfo'));
                if (existing) {
                    globalPlateNum++;
                    const oldStr = (existing as any).decodeText?.() || (existing as any).value || String(existing);
                    const renumbered = oldStr.replace(/^(Kẽm|Plate) \d+/, `$1 ${globalPlateNum}`);
                    pg.node.set(PDFName.of('PlateInfo'), PDFString.of(renumbered));
                }
            }
        }

        const mergedBytes = await mergedDoc.save();
        const mergedBlob = new Blob([mergedBytes as any], { type: 'application/pdf' });
        const baseName = file.name.replace(/\.[^/.]+$/, '');
        const mergedFileName = `Kem_Gop_${baseName}_[${successCount}_Kem].pdf`;

        const batchOutputPayload = {
            docs: batchResults.filter(r => r.blob.size > 0).map(r => ({ blob: r.blob, filename: r.filename, report: r.report })),
            mergedBlob
        };

        if (sheetSettings.spawnNewTab && onSpawnTab) {
            onSpawnTab(new File([mergedBlob], mergedFileName, { type: 'application/pdf' }), { batchOutput: batchOutputPayload });
            setProcessStatus('');
        } else {
            setBatchOutput(batchOutputPayload);
            commitWorkingFile(mergedBlob, mergedFileName);
        }
    } catch (e: any) {
        // UIUX (audit 2026-07-27 §D-15): dịch lỗi kỹ thuật, Hủy thì không báo đỏ
        if (!isCanceled(e)) setError(formatError(e, i18n.t('lib.processHandlers:khong_xu_ly_duoc_catalog', { defaultValue: 'Không xử lý được Catalog' })));
    } finally {
        setIsProcessing(false);
        setProcessStatus('');
    }
}

// ═════════════════════════════════════════════
//  Preprocess Handlers
// ═════════════════════════════════════════════

export async function runShuffle(ctx: ProcessContext, settings: any) {
    const { file, onSpawnTab, commitWorkingFile, setError, setIsProcessing, setProcessStatus, getWorkingBytes } = ctx;
    // UIUX (audit 2026-07-27 §D-09): thêm hậu tố trấn an cho tác vụ chạy dài
    setError(''); setIsProcessing(true); setProcessStatus(i18n.t('lib.processHandlers:dang_xao_tron_trang') + LONG_TASK_HINT());
    try {
        const inputBytes = await getWorkingBytes();
        const srcPdf = await PDFDocument.load(inputBytes);
        const totalPages = srcPdf.getPageCount();

        if ((totalPages > 1000 || file.size > 300 * 1024 * 1024) && settings.specialAction !== 'split_odd_even') {
            // UIUX (audit 2026-07-27 §D-09)
            setProcessStatus(i18n.t('lib.processHandlers:dang_xao_tron_trang') + LONG_TASK_HINT());
            const { backendShufflePages } = await import('../lib/api');
            let action = 'reverse'; let mapping: number[] = [];
            if (settings.presetId === 'special') {
                if (settings.specialAction === 'reverse') action = 'reverse';
                else if (settings.specialAction === 'odd_first') action = 'odd_first';
                else action = 'even_first';
            } else {
                action = 'custom';
                const rules = parseRule(settings.rule);
                // applyRule trả PageMapping[] = {srcPage (0-based), rotation}.
                // Backend /shuffle custom cần danh sách SỐ TRANG 1-based; trang trắng
                // (srcPage = -1) → 0 và bị backend lọc bỏ (điều kiện 0 < p <= total).
                mapping = applyRule(rules, totalPages, Math.max(1, settings.groupSize), settings.mode).map((m: any) => m.srcPage + 1);
            }
            const workingFile = new File([inputBytes as any], file.name, { type: 'application/pdf' });
            const blob = await backendShufflePages(workingFile, action, mapping);
            const newFileName = `Shuffled_${file.name}`;
            if (settings.spawnNewTab && onSpawnTab) { onSpawnTab(new File([blob], newFileName, { type: 'application/pdf' })); }
            else { await commitWorkingFile(blob, newFileName); }
        } else {
            if (settings.presetId === 'special' && settings.specialAction === 'split_odd_even') {
                const odds = Array.from({ length: totalPages }, (_, i) => i).filter(i => i % 2 === 0);
                const evens = Array.from({ length: totalPages }, (_, i) => i).filter(i => i % 2 === 1);

                const mappingOdd = odds.map(p => ({ srcPage: p, rotation: 0 }));
                const mappingEven = evens.map(p => ({ srcPage: p, rotation: 0 }));

                const outputBytesOdd = await executeShuffle(srcPdf, mappingOdd);
                const outputBytesEven = await executeShuffle(srcPdf, mappingEven);

                if (onSpawnTab) {
                    onSpawnTab(new File([new Blob([outputBytesOdd as any], { type: 'application/pdf' })], `TrangLe_${file.name}`, { type: 'application/pdf' }));
                    onSpawnTab(new File([new Blob([outputBytesEven as any], { type: 'application/pdf' })], `TrangChan_${file.name}`, { type: 'application/pdf' }));
                    ctx.setReportMsg('');
                } else {
                    throw new Error(tv("Môi trường hiện tại không hỗ trợ mở nhiều Tab."));
                }
                return;
            }

            let mapping: any[] = [];
            if (settings.presetId === 'special') {
                if (settings.specialAction === 'reverse') mapping = reversePages(totalPages);
                else mapping = shuffleEvenOdd(totalPages, settings.specialAction);
            } else {
                const rules = parseRule(settings.rule);
                if (rules.length === 0) throw new Error(tv("Quy tắc trống hoặc không hợp lệ."));
                mapping = applyRule(rules, totalPages, Math.max(1, settings.groupSize), settings.mode);
            }
            const outputBytes = await executeShuffle(srcPdf, mapping);
            const blob = new Blob([outputBytes as any], { type: 'application/pdf' });
            const newFileName = `Shuffled_${file.name}`;
            if (settings.spawnNewTab && onSpawnTab) { onSpawnTab(new File([blob], newFileName, { type: 'application/pdf' })); }
            else { await commitWorkingFile(blob, newFileName); ctx.setReportMsg(''); }
        }
    // UIUX (audit 2026-07-27 §D-15): formatError + im lặng khi user Hủy
    } catch (err: any) { if (!isCanceled(err)) setError(formatError(err, i18n.t('lib.processHandlers:khong_xao_tron_duoc_trang', { defaultValue: 'Không xáo trộn được trang' }))); }
    finally { setIsProcessing(false); setProcessStatus(''); }
}

export async function runResize(ctx: ProcessContext, settings: any) {
    const { file, onSpawnTab, commitWorkingFile, setError, setIsProcessing, setProcessStatus, getWorkingBytes } = ctx;
    // UIUX (audit 2026-07-27 §D-09): thêm hậu tố trấn an cho tác vụ chạy dài
    setError(''); setIsProcessing(true); setProcessStatus(i18n.t('lib.processHandlers:dang_doi_kho_trang') + LONG_TASK_HINT());

    const MM_TO_PT = 2.83465;
    const resizeMode: string = settings.resizeMode || 'auto';
    const newFileName = `Resized_${file.name}`;
    // pdf-lib nạp CẢ file vào RAM rồi embedPages (nhân bản nội dung trang thành Form
    // XObject) + save (dựng Uint8Array mới) → đỉnh RAM ~3-4× kích thước file. File
    // lớn/nhiều ảnh vượt trần cấp phát ArrayBuffer của V8 → "Array buffer allocation
    // failed". Vượt ngưỡng này BỎ QUA pdf-lib, đẩy thẳng backend (xử lý theo path
    // trên đĩa qua Ghostscript/pypdfium2, KHÔNG nạp vào WebView).
    const FE_SIZE_LIMIT = 50 * 1024 * 1024;

    const emit = async (blob: Blob) => {
        if (settings.spawnNewTab && onSpawnTab) { onSpawnTab(new File([blob], newFileName, { type: 'application/pdf' })); }
        else { await commitWorkingFile(blob, newFileName); ctx.setReportMsg(''); }
    };

    try {
        // ── Backend theo PATH (không giữ file trong RAM) ─────────────────────
        // Dùng khi: không đọc nổi bytes vào RAM (RangeError). prepareFileForUpload
        // (trong backendResizePages) đọc lại nội dung THẬT từ đĩa qua file.path →
        // KHÔNG nhân bản bytes trong WebView. Mất phần bake edit-ảo (order/rotation)
        // nhưng còn hơn crash cứng — file cỡ này bake trong JS cũng sẽ crash.
        const runBackendByPath = async (): Promise<Blob> => {
            const { backendResizePages } = await import('../lib/api');
            return backendResizePages(file, settings.targetW, settings.targetH, settings.scaleMode, settings.applyToStr || 'all', 0, resizeMode);
        };

        let inputBytes: Uint8Array;
        try {
            inputBytes = await getWorkingBytes();
        } catch (readErr) {
            // Không giữ nổi file trong RAM (RangeError / bake edit crash) → backend theo path.
            console.warn('[resize] không đọc được bytes vào RAM, fallback backend theo path:', readErr);
            await emit(await runBackendByPath());
            return;
        }

        // Thử soi bằng pdf-lib để lấy số trang + quyết định downsample. File do
        // BACKEND sinh (bù xén/downsample qua pikepdf/QPDF, Ghostscript) có thể
        // dùng object stream/xref nén mà pdf-lib (pako) KHÔNG giải nén được →
        // ném "Invalid header in flate stream". Khi đó không dùng được đường
        // frontend, phải đẩy sang backend (đọc bytes trực tiếp, không qua pdf-lib).
        let totalPages = 0;
        let sourceArea = 0;
        let canUseFrontend = true;
        try {
            const quickDoc = await PDFDocument.load(inputBytes);
            totalPages = quickDoc.getPageCount();
            try {
                const { width, height } = quickDoc.getPage(0).getSize();
                sourceArea = width * height;
            } catch { /* ignore */ }
        } catch {
            canUseFrontend = false;  // pdf-lib không parse được → chỉ còn backend
        }

        // ── Giảm dữ liệu theo khổ mới (giống PDF Optimizer) ──────────────────
        // resize kiểu XObject giữ NGUYÊN độ phân giải ảnh gốc → A1→A5 mà file vẫn
        // ~dung lượng gốc → tác vụ sau chậm. Khổ đích NHỎ HƠN khổ gốc → bật
        // downsample (mặc định 300 DPI) qua backend (Ghostscript/pypdfium2).
        const targetArea = (settings.targetW * MM_TO_PT) * (settings.targetH * MM_TO_PT);
        const isDownsizing = sourceArea > 0 && targetArea > 0 && targetArea < sourceArea * 0.9;
        const targetDpi: number = typeof settings.targetDpi === 'number'
            ? settings.targetDpi
            : (isDownsizing ? 300 : 0);
        const wantDownsample = targetDpi > 0;

        const runBackend = async (): Promise<Blob> => {
            const { backendResizePages } = await import('../lib/api');
            const workingFile = new File([inputBytes as any], file.name, { type: 'application/pdf' });
            return backendResizePages(workingFile, settings.targetW, settings.targetH, settings.scaleMode, settings.applyToStr || 'all', targetDpi, resizeMode);
        };

        // Backend bắt buộc khi: cần downsample, pdf-lib không parse được, hoặc file lớn.
        if (wantDownsample || !canUseFrontend || totalPages > 1000 || (file.size || inputBytes.byteLength) > FE_SIZE_LIMIT) {
            await emit(await runBackend());
            return;
        }

        // Đường frontend pdf-lib (nhanh, không round-trip). Nếu ném lỗi (vd flate
        // stream do file backend-sinh, hoặc RangeError khi embed/save file nặng),
        // TỰ fallback sang backend thay vì báo lỗi.
        try {
            let applyToPages: 'all' | 'even' | 'odd' | number[] = 'all';
            if (settings.applyToStr === 'even' || settings.applyToStr === 'odd' || settings.applyToStr === 'all') {
                applyToPages = settings.applyToStr;
            } else {
                const ranges = parseRanges(settings.applyToStr, totalPages);
                applyToPages = ranges.flatMap(([start, end]: [number, number]) => Array.from({ length: end - start + 1 }, (_, i) => start + i));
            }
            const outputBytes = await resizePages(inputBytes, { targetW: settings.targetW, targetH: settings.targetH, scaleMode: settings.scaleMode, applyTo: applyToPages });
            await emit(new Blob([outputBytes as any], { type: 'application/pdf' }));
        } catch (feErr) {
            console.warn('[resize] pdf-lib thất bại, fallback backend:', feErr);
            await emit(await runBackend());
        }
    // UIUX (audit 2026-07-27 §D-15): formatError + im lặng khi user Hủy
    } catch (err: any) { if (!isCanceled(err)) setError(formatError(err, i18n.t('lib.processHandlers:khong_doi_duoc_kho_trang', { defaultValue: 'Không đổi được khổ trang' }))); }
    finally { setIsProcessing(false); setProcessStatus(''); }
}

export async function runTrimShift(ctx: ProcessContext, settings: any) {
    const { file, onSpawnTab, commitWorkingFile, setError, setIsProcessing, setProcessStatus, getWorkingBytes } = ctx;
    // UIUX (audit 2026-07-27 §D-09): thêm hậu tố trấn an cho tác vụ chạy dài
    setError(''); setIsProcessing(true); setProcessStatus(i18n.t('lib.processHandlers:dang_cat_xen_doi_noi_dung') + LONG_TASK_HINT());
    try {
        const inputBytes = await getWorkingBytes();
        const { backendTrimShift } = await import('../lib/api');
        const { UNIT_TO_MM } = await import('../components/preprocess-tools/TrimShiftTool');
        const workingFile = new File([inputBytes as any], file.name, { type: 'application/pdf' });
        // Backend luôn nhận mm; quy đổi từ đơn vị người dùng chọn.
        const k = UNIT_TO_MM[settings.unit as keyof typeof UNIT_TO_MM] ?? 1;
        const config = {
            trimTop: (settings.trimTop || 0) * k,
            trimBottom: (settings.trimBottom || 0) * k,
            trimLeft: (settings.trimLeft || 0) * k,
            trimRight: (settings.trimRight || 0) * k,
            shiftX: (settings.shiftX || 0) * k,
            shiftY: (settings.shiftY || 0) * k,
            bindingEnabled: !!settings.bindingEnabled,
            bindingMm: (settings.bindingMm || 0) * k,
            bindingInward: settings.bindingInward !== false,
            creepEnabled: !!settings.creepEnabled,
            creepMm: (settings.creepMm || 0) * k,
            creepAxis: settings.creepAxis === 'y' ? 'y' : 'x',
            mirrorFill: !!settings.mirrorFill,
            contentMode: settings.contentMode === 'clip' ? 'clip' : 'original',
            keepBleed: !!settings.keepBleed,
        };
        const blob = await backendTrimShift(workingFile, settings.applyToStr || 'all', config);
        const newFileName = `TrimShift_${file.name}`;
        if (settings.spawnNewTab && onSpawnTab) { onSpawnTab(new File([blob], newFileName, { type: 'application/pdf' })); }
        else { commitWorkingFile(blob, newFileName); }
    // UIUX (audit 2026-07-27 §D-15): formatError + im lặng khi user Hủy
    } catch (err: any) { if (!isCanceled(err)) setError(formatError(err, i18n.t('lib.processHandlers:khong_cat_xen_doi_duoc', { defaultValue: 'Không cắt xén/dời được nội dung' }))); }
    finally { setIsProcessing(false); setProcessStatus(''); }
}

export async function runSplit(ctx: ProcessContext, settings: any) {
    const { file, onSpawnTab, commitWorkingFile, setError, setIsProcessing, setProcessStatus, setReportMsg, getWorkingBytes } = ctx;
    // UIUX (audit 2026-07-27 §D-09): thêm hậu tố trấn an cho tác vụ chạy dài
    setError(''); setIsProcessing(true); setProcessStatus(i18n.t('lib.processHandlers:dang_tach_pdf') + LONG_TASK_HINT());
    try {
        // Tuân thủ kết quả cuối cùng: tách trên file đã áp dụng sửa đổi trang.
        const inputBytes = await getWorkingBytes();
        const quickDoc = await PDFDocument.load(inputBytes);
        const totalPages = quickDoc.getPageCount();

        let pageList: number[] = [];
        if (settings.mode === 'extract_pages') {
            pageList = settings.pageListStr.split(',').map((s: string) => parseInt(s.trim())).filter((n: number) => !isNaN(n));
        }

        if (totalPages > 1000 || file.size > 300 * 1024 * 1024) {

            const { backendSplitPdf } = await import('../lib/api');
            const workingFile = new File([inputBytes as any], file.name, { type: 'application/pdf' });
            const blob = await backendSplitPdf(workingFile, settings.mode, { ranges: settings.ranges, pagesPerFile: settings.pagesPerFile, pageList });
            const newFileName = `Split_${file.name}`;
            if (settings.spawnNewTab && onSpawnTab) { onSpawnTab(new File([blob], newFileName, { type: blob.type })); }
            else { await commitWorkingFile(blob, newFileName); }
            setReportMsg(i18n.t('lib.processHandlers:da_tach_file_thanh_cong'));
        } else {
            const results = await splitPdf(inputBytes, settings.mode, { ranges: settings.ranges, pagesPerFile: settings.pagesPerFile, pageList }, file.name.replace('.pdf', ''));
            if (results.length === 0) throw new Error(tv("Thao tác tách không tạo ra file nào."));
            if (settings.spawnNewTab && onSpawnTab) {
                for (const r of results) { onSpawnTab(new File([new Blob([r.bytes as any])], r.filename, { type: 'application/pdf' })); }
                setReportMsg(i18n.t('lib.processHandlers:da_tao_results_length_tab_moi', { count: results.length }));
            } else {
                const first = results[0];
                commitWorkingFile(new Blob([first.bytes as any], { type: 'application/pdf' }), first.filename);
                setReportMsg(i18n.t('lib.processHandlers:da_tach_thanh_results_length_file', { count: results.length }));
            }
        }
    // UIUX (audit 2026-07-27 §D-15): formatError + im lặng khi user Hủy
    } catch (err: any) { if (!isCanceled(err)) setError(formatError(err, i18n.t('lib.processHandlers:khong_tach_duoc_pdf', { defaultValue: 'Không tách được PDF' }))); }
    finally { setIsProcessing(false); setProcessStatus(''); }
}

export async function runMerge(ctx: ProcessContext, settings: any) {
    const { file, onSpawnTab, commitWorkingFile, setError, setIsProcessing, setProcessStatus, getWorkingBytes } = ctx;
    // UIUX (audit 2026-07-27 §D-09): thêm hậu tố trấn an cho tác vụ chạy dài
    setError(''); setIsProcessing(true); setProcessStatus(i18n.t('lib.processHandlers:dang_ghep_pdf') + LONG_TASK_HINT());
    try {
        // Tuân thủ kết quả cuối cùng: file nền (tab hiện tại) dùng bản đã áp dụng sửa đổi trang.
        const workingBaseFile = file
            ? new File([await getWorkingBytes() as any], file.name, { type: 'application/pdf' })
            : null;

        let totalPageEstimate = 0;
        if (file) totalPageEstimate += file.size / 5000;
        if (settings.mode === 'merge_files' && settings.filesToMerge?.length > 0) {
            for (const f of settings.filesToMerge) totalPageEstimate += f.size / 5000;
        }

        const allMergeFiles = workingBaseFile ? [workingBaseFile, ...(settings.filesToMerge || [])] : (settings.filesToMerge || []);
        const hasImages = allMergeFiles.some((f: any) => {
            const n = f.name.toLowerCase();
            return n.endsWith('.jpg') || n.endsWith('.jpeg') || n.endsWith('.png');
        });

        if (settings.mode === 'merge_files' && totalPageEstimate > 1000 && !hasImages) {

            const { backendMergePdfs } = await import('../lib/api');
            const allFiles = workingBaseFile ? [workingBaseFile, ...(settings.filesToMerge || [])] : (settings.filesToMerge || []);
            const blob = await backendMergePdfs(allFiles, 'merge_files');
            const newFileName = file ? `Merged_${file.name}` : 'Merged_Document.pdf';
            if (settings.spawnNewTab && onSpawnTab) { onSpawnTab(new File([blob], newFileName, { type: 'application/pdf' })); }
            else { await commitWorkingFile(blob, newFileName); }
        } else if (settings.mode === 'interleave' && totalPageEstimate > 1000 && !hasImages) {

            const { backendMergePdfs } = await import('../lib/api');
            const allFiles = [settings.oddFile, settings.evenFile].filter(Boolean);
            const blob = await backendMergePdfs(allFiles, 'interleave');
            const newFileName = 'Interleaved_Document.pdf';
            if (settings.spawnNewTab && onSpawnTab) { onSpawnTab(new File([blob], newFileName, { type: 'application/pdf' })); }
            else { await commitWorkingFile(blob, newFileName); }
        } else {
            const inputBytes = workingBaseFile ? new Uint8Array(await workingBaseFile.arrayBuffer()) : null;
            const outputBytes = await mergePdf(inputBytes, settings);
            const blob = new Blob([outputBytes as any], { type: 'application/pdf' });
            const newFileName = file ? `Merged_${file.name}` : `Merged_Document.pdf`;
            if (settings.spawnNewTab && onSpawnTab) { onSpawnTab(new File([blob], newFileName, { type: 'application/pdf' })); }
            else { await commitWorkingFile(blob, newFileName); ctx.setReportMsg(''); }
        }
    // UIUX (audit 2026-07-27 §D-15): formatError + im lặng khi user Hủy
    } catch (err: any) { if (!isCanceled(err)) setError(formatError(err, i18n.t('lib.processHandlers:khong_ghep_duoc_pdf', { defaultValue: 'Không ghép được PDF' }))); }
    finally { setIsProcessing(false); setProcessStatus(''); }
}
