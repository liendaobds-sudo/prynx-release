/**
 * Processing handlers extracted from ImpositionTab.tsx
 * 
 * These are pure async functions that receive all dependencies as parameters,
 * eliminating closure dependency on component state.
 */

import { PDFDocument, PDFName, PDFString } from 'pdf-lib';

import {
    addOptionalContentSource,
    createOptionalContentTransfer,
    finishOptionalContentTransfer,
} from './pdfOptionalContent';
import { imposeCatalogBatchViaBackend, ImpositionMode, type DieCutSettings, type GuillotineSettings, type OffsetSettings, type ProcessingSettings } from '../lib/pdfImposer';
import { planCatalog, verifyCatalogPlan, type PlanConfig } from '../lib/imposerEngine/CatalogPlanner';
import { getImposerCapability, type SavePrintConfig } from '../components/imposition-tools/types';
import { DEFAULT_PONT_CONFIG } from '../components/imposition-tools/pontConfigDefaults';
// NEST (audit 2026-08-29 §GRIDSTRATEGY-LEAK): chuẩn hoá gridStrategy trước khi gửi backend
// để giá trị `true_shape_nesting` (canary die-cut/CNC) đã lưu không rò sang Bình cắt xén.
import { TRUE_SHAPE_NESTING_ENABLED, resolveGridStrategy } from '../components/imposition-tools/trueShapeNestingRollout';
import { applyRule, executeShuffle, parseRule, reversePages, shuffleEvenOdd, type PageMapping } from '../lib/preprocessEngine/ShuffleEngine';
import { resizePages } from '../lib/preprocessEngine/PageResizer';
import { splitPdf, parseRanges } from '../lib/preprocessEngine/PdfSplitter';
import { mergePdf } from '../lib/preprocessEngine/PdfMerger';import type { PageResizerSettings } from '../components/preprocess-tools/pageResizerViewLogic';
import type { ShuffleSettings } from '../components/preprocess-tools/ShuffleTool';
import type { SplitSettings } from '../components/preprocess-tools/SplitTool';
import type { TrimShiftSettings } from '../components/preprocess-tools/TrimShiftTool';
import type { MergeSettings } from '../components/preprocess-tools/MergeTool';
import i18n, { tv } from '../i18n';
// UIUX (audit 2026-07-27 §D-15/§D-11): lỗi kỹ thuật → câu Việt + hướng khắc phục; toast có nút hành động
import { formatError, isCanceled } from './errorMessages';
import { toast } from '../components/ui/Toast';
import { waitForAppForegroundDelay } from './appVisibility';
import { tagArtifactLeaseToken } from './artifactLease';
import { previewPerfLog } from './previewPerfLog';
import type { BackendSplitPdfResult, PdfPathMetadata } from './api';

// UIUX (audit 2026-07-27 §D-09): tác vụ nặng chạy lâu — trấn an để user không tưởng app treo.
// (KHÔNG thêm nút hủy: backend chưa có endpoint cancel cho các route preprocess.)
const LONG_TASK_HINT = () =>
    i18n.t('lib.processHandlers:file_lon_co_the_mat_vai_phut', { defaultValue: '… (file lớn có thể mất vài phút — đừng đóng tab)' });

const NUP_SHEET_TOO_SMALL_ERROR = 'Sheet too small for source pages. Cannot fit any items.';
const NUP_PAGE_CANNOT_FIT_ERROR = /^Trang\s+(\d+)\s+không thể xếp vào vùng giấy sử dụng\.$/u;
type LegacyCompatibleSavePrintConfig = Omit<SavePrintConfig, 'autoSave'> & {
    /** Caller cũ thiếu field này sẽ fallback sang autoSavePrint đúng một chu kỳ. */
    autoSave?: boolean;
};

/** Các field chỉ dùng ở biên serialize backend, không thuộc engine ProcessingSettings. */
type ProcessEngineSettings = ProcessingSettings & {
    splitGap?: number;
    diagnosticTraceId?: string;
    diagnosticPreviewRequestId?: string;
    diagnosticPendingRequestId?: string;
    diagnosticPreviewCapacity?: number;
    diagnosticPreviewState?: 'none' | 'pending' | 'applied' | 'failed';
    forceLegacyGrid?: boolean;
    mixedExcessPercent?: number;
    reportDisplay?: unknown;
    reportMaterial?: string;
    reportLamination?: number;
    reportLaminationSides?: number;
    reportOrderCode?: string;
    /** @deprecated MAP-NEST-11: no-op, chỉ giữ để caller cũ không vỡ kiểu. */
    saveByReport?: boolean;
    exportUniqueSheets?: boolean;
    /** @deprecated Chỉ fallback khi savePrintConfig.autoSave chưa tồn tại. */
    autoSavePrint?: boolean;
    savePrintConfig?: LegacyCompatibleSavePrintConfig;
    clusterMode?: 'none' | 'row' | 'column';
    clusterCount?: number;
    clusterGap?: number;
    clusterDistribution?: 'default' | 'type';
    clusterTileW?: number;
    clusterTileH?: number;
    clusterCols?: number;
    clusterRows?: number;
    clusterSizingMode?: 'dims' | 'split_cols' | 'split_rows';
    clusterCombineMode?: 'replicate_mixed' | 'zone_per_type' | 'zone_ratio';
    clusterNesting?: boolean;
    tileGapX?: number;
    tileGapY?: number;
    separateCutPage?: boolean;
    pontsOnCutFile?: boolean;
    hiddenOcgLayerIds?: number[];    gripperMargin?: number;
    markType?: 'none' | 'corners' | 'guillotine';
    markLength?: number;
    markOffset?: number;
    markThickness?: number;
    markStyle?: 'default' | 'japanese';
    dieSizeMode?: 'die' | 'page';
    dieOffsetMm?: number;
    pontType?: 'none' | 'corner' | '5mm' | 'custom';
    pontConfig?: DieCutSettings['pontConfig'];
    targetQuantity?: number;
    targetQuantitiesByPage?: Record<number, number>;
    groupingStrategy?: 'free_gang' | 'maximize_area' | 'strict_ratio' | 'cluster_tile' | 'none';
    cncTwoSided?: boolean;
};

/**
 * CONTRACT (audit 2026-08-29 §MAP-NEST-11): chuẩn hóa quyền ghi cục bộ một lần.
 * Canonical false luôn thắng alias true; folder rỗng không được tạo side effect.
 */
function resolveActiveSavePrintConfig(
    settings: Pick<ProcessEngineSettings, 'autoSavePrint' | 'savePrintConfig'>,
): SavePrintConfig | undefined {
    const config = settings.savePrintConfig;
    if (!config) return undefined;

    const autoSave = config.autoSave === undefined
        ? settings.autoSavePrint === true
        : config.autoSave === true;
    const folder = config.folder.trim();
    if (!autoSave || !folder) return undefined;

    return { ...config, autoSave: true, folder };
}

type LoosePontConfig = {
    shape: 'circle' | 'l_inverted' | 'l_corner';
    size: number;
    [key: string]: unknown;
};
type DieCutProcessInput = Omit<DieCutSettings, 'pontConfig'> & { pontConfig?: LoosePontConfig };
type ProcessEngineInput = GuillotineSettings | DieCutProcessInput | OffsetSettings;

type ProcessHandlerSettings<T extends object> = Partial<T> & { spawnNewTab?: boolean };

type BatchOutput = {
    docs: { blob: Blob; filename: string; report?: string }[];
    mergedBlob: Blob;
};

type FileWithPath = File & { path?: string };

function asBlobPart(bytes: Uint8Array | ArrayBuffer): BlobPart {
    return bytes instanceof ArrayBuffer ? bytes : bytes as unknown as BlobPart;
}

function readPdfString(value: unknown): string {
    if (value instanceof PDFString) return value.decodeText();
    if (value && typeof value === 'object') {
        const candidate = value as { decodeText?: () => string; value?: string };
        if (typeof candidate.decodeText === 'function') return candidate.decodeText();
        if (typeof candidate.value === 'string') return candidate.value;
    }
    return String(value);
}

/**
 * UIUX (audit 2026-08-04 §NUP-ERR): backend N-Up còn trả hai lỗi sức chứa
 * bằng chuỗi cố định. Dịch ngay tại ranh giới handler để UI theo đúng ngôn ngữ
 * đang chọn; giữ lỗi gốc trong `cause` cho log kỹ thuật.
 */
function localizeNupCapacityError(error: unknown): unknown {
    const raw = error instanceof Error
        ? error.message.trim()
        : (typeof error === 'string' ? error.trim() : '');

    if (raw === NUP_SHEET_TOO_SMALL_ERROR) {
        return new Error(
            i18n.t('lib.processHandlers:vung_giay_su_dung_qua_nho_khong_xep_duoc_trang_nguon', {
                defaultValue: 'Vùng giấy sử dụng quá nhỏ, không xếp được trang nguồn nào. Hãy tăng khổ giấy, giảm lề hoặc kiểm tra TrimBox của file nguồn.',
            }),
            { cause: error },
        );
    }

    const pageMatch = NUP_PAGE_CANNOT_FIT_ERROR.exec(raw);
    if (pageMatch) {
        return new Error(
            i18n.t('lib.processHandlers:trang_page_khong_the_xep_vao_vung_giay_su_dung', {
                page: Number(pageMatch[1]),
                defaultValue: 'Trang {{page}} không thể xếp vào vùng giấy sử dụng. Hãy tăng khổ giấy, giảm lề hoặc kiểm tra TrimBox của file nguồn.',
            }),
            { cause: error },
        );
    }

    return error;
}


// ─── Shared context type for all handlers ───
export interface ProcessContext {
    file: File;
    onSpawnTab?: (file: File, extra?: Record<string, unknown>) => void;
    // async: playback chuỗi bytes qua commit (currentBytes cập nhật SAU await
    // blob.arrayBuffer()) → mọi call site PHẢI await, nếu không bước kế đọc bytes cũ.
    commitWorkingFile: (blob: Blob, name: string, existingPath?: string) => void | Promise<void>;
    setError: (msg: string) => void;
    setIsProcessing: (v: boolean) => void;
    setProcessStatus: (msg: string) => void;
    setReportMsg: (msg: string) => void;
    setBatchOutput: (v: BatchOutput | null) => void;
    setCancelHandler?: (handler: (() => Promise<void>) | null) => void;
    viewerNumPages?: number;
    getWorkingBytes: () => Promise<Uint8Array>;
    getWorkingSourcePath?: () => Promise<string | undefined>;
}

// RECIPE (audit 2026-08-15 §PLAY.6-7/§REC.1): `void` không phân biệt được
// hoàn tất, Hủy và lỗi đã bị handler giữ lại. Outcome tường minh là hợp đồng để
// recorder/playback chỉ đi tiếp sau khi commit thật sự hoàn tất.
export type ProcessOutcome =
    | { status: 'completed' }
    | { status: 'canceled' }
    | { status: 'error'; error: string };

export const PROCESS_COMPLETED: ProcessOutcome = Object.freeze({ status: 'completed' });
export const PROCESS_CANCELED: ProcessOutcome = Object.freeze({ status: 'canceled' });

function processError(error: string): ProcessOutcome {
    return { status: 'error', error };
}

// ═════════════════════════════════════════════
//  Main Imposition Engine (Booklet / N-Up)
// ═════════════════════════════════════════════

export async function runProcessEngine(
    ctx: ProcessContext,
    inputSettings: ProcessEngineInput,
    spawnNewTab: boolean
): Promise<ProcessOutcome> {
    const settings = inputSettings as ProcessEngineSettings;
    const { file, onSpawnTab, commitWorkingFile, setError, setIsProcessing, setProcessStatus, setReportMsg } = ctx;

    setError('');
    setIsProcessing(true);
    setProcessStatus(i18n.t('lib.processHandlers:dang_chuan_bi_du_lieu'));

    try {

        const isDieCut = settings.imposerMode === 'diecut';
        const isGuillotine = settings.imposerMode === 'guillotine';
        const isCnc = settings.imposerMode === 'cnc';
        const guillotineSettings = isGuillotine ? settings as GuillotineSettings : undefined;
        const dieCutSettings = isDieCut ? settings as DieCutSettings : undefined;
        const isPageSheet = isGuillotine && settings.pageSheetMode === true;
        const requestedAlternateRotation = isGuillotine
            ? guillotineSettings?.alternateRotation
            : dieCutSettings?.alternateRotation;
        const dieShapes = Object.values(dieCutSettings?.detectedShapesByPage || {});
        const rectangleStickerInking = isDieCut && !isCnc && (
            dieCutSettings?.cutType === 'one_dao'
            || (
                dieShapes.length > 0
                && dieShapes.every(shape => String(shape || '').trim().toUpperCase() === 'RECTANGLE')
            )
            || (dieShapes.length === 0 && String(dieCutSettings?.shapeType || '').trim().toUpperCase() === 'RECTANGLE')
        );
        const effectiveAlternateRotation = (
            (
                isGuillotine
                && !isPageSheet
                && guillotineSettings?.layoutType !== 'mixed_guillotine'
            ) || rectangleStickerInking
        ) && (
            requestedAlternateRotation === 'row' || requestedAlternateRotation === 'column'
        ) ? requestedAlternateRotation : 'none';
        // Page-sheet dùng capability guillotine để giữ marks; raw UI state không đi qua boundary này.
        const caps = getImposerCapability(isPageSheet ? 'guillotine' : settings.imposerMode);
        const pontSettingsMode = caps.supportsPont || isPageSheet;
        // FIX (audit 2026-08-29 §SR-MODE-1): `repeat` là tín hiệu S&R authoritative;
        // taskMode tường minh giữ nguyên ý định qua recipe/preset và biên frontend→backend.
        const normalizedTaskMode = (
            (isGuillotine || isDieCut || isCnc) && settings.layoutType === 'repeat'
        ) || settings.taskMode === 'step_repeat'
            ? 'step_repeat'
            : 'nup';

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
                const workingFile = new File([asBlobPart(workingBytes)], file.name, { type: 'application/pdf' });
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
                gripperMargin: (isDieCut || isCnc) ? 0 : (settings.gripperMargin || 0),
                marginMode: settings.marginMode || 'labels_only',
                markType: caps.supportsMarks ? (settings.markType || 'none') : 'none',
                markLength: settings.markLength || 5, markOffset: settings.markOffset || 3,
                markThickness: settings.markThickness || 0.25,
                markStyle: settings.markStyle || 'default',
                // CUT-BORDER (audit 2026-08-04 §CB.2): chỉ serialize cho Bình bài
                // cắt xén; dấu xén và đường viền hoạt động độc lập.
                ...(guillotineSettings && !isPageSheet ? {
                    cutBorderEnabled: guillotineSettings.cutBorderEnabled === true,
                    cutBorderPosition: guillotineSettings.cutBorderPosition || 'trim',
                    cutBorderColor: guillotineSettings.cutBorderColor || '#000000',
                    cutBorderThickness: Number(guillotineSettings.cutBorderThickness) || 0.3,
                } : {}),
                // §GRIDSTRATEGY-LEAK: guillotine (và taskMode ngoài 'nup') không được gửi
                // 'true_shape_nesting' — backend fail-closed. Chuẩn hoá về 'optimal_auto'.
                gridStrategy: isGuillotine || isDieCut || isCnc
                    ? resolveGridStrategy({
                        enabled: TRUE_SHAPE_NESTING_ENABLED,
                        activeTool: isCnc ? 'cnc_imposer' : isDieCut ? 'sticker_imposer' : 'guillotine_imposer',
                        taskMode: normalizedTaskMode,
                        gridStrategy: settings.gridStrategy || 'simple_auto',
                    })
                    : 'simple_auto',
                alternateRotation: effectiveAlternateRotation,
                taskMode: normalizedTaskMode,
                layoutType: isGuillotine || isDieCut || isCnc ? settings.layoutType || 'sequential' : 'sequential',
                align: settings.align || 'center',
                cols: settings.cols, rows: settings.rows,
                splitGap: settings.splitGap,
                diagnosticTraceId: settings.diagnosticTraceId,
                diagnosticPreviewRequestId: settings.diagnosticPreviewRequestId,
                diagnosticPendingRequestId: settings.diagnosticPendingRequestId,
                diagnosticPreviewCapacity: settings.diagnosticPreviewCapacity,
                diagnosticPreviewState: settings.diagnosticPreviewState,
                // PARITY (audit 2026-08-30 §B10-6): chỉ publication `applied` từ
                // GridPreview mới đặt true; backend dùng để giữ đúng layout lưới đã xem.
                forceLegacyGrid: settings.forceLegacyGrid === true,
                // CNC cũng là die-cut về bản chất → giữ cờ NHẤT QUÁN với UI (audit #C3).
                // Routing backend vẫn theo imposerMode='cnc' (ưu tiên trước isDieCutMode).
                isDieCutMode: isDieCut || isCnc,
                page_sheet_mode: isPageSheet,
                cutType: isDieCut ? settings.cutType : undefined,
                fillBlockGap: isDieCut ? settings.fillBlockGap : undefined,
                // 1 Dao: khuôn theo trang + offset co/mở (khớp resolve_one_dao_trim backend).
                dieSizeMode: isDieCut ? settings.dieSizeMode : undefined,
                dieOffsetMm: isDieCut ? settings.dieOffsetMm : undefined,
                pontType: pontSettingsMode ? (settings.pontType?.startsWith('preset_') ? 'custom' : settings.pontType) : undefined,
                pontConfig: (pontSettingsMode && settings.pontType && settings.pontType !== 'none' && settings.pontConfig)
                    ? { ...DEFAULT_PONT_CONFIG, ...settings.pontConfig }
                    : undefined,
                detectedShapesByPage: isDieCut || isCnc ? settings.detectedShapesByPage : undefined,
                detectedShapeParamsByPage: isDieCut || isCnc ? settings.detectedShapeParamsByPage : undefined,
                targetQuantity: settings.targetQuantity || 0,
                targetQuantitiesByPage: settings.targetQuantitiesByPage || {},
                // PARITY (audit 2026-08-29 MAP-NEST-04): Tem bế và CNC giữ nguyên
                // hai intent `free_gang`/`maximize_area`; guillotine chỉ nhận contract cũ.
                groupingStrategy: (isDieCut || isCnc)
                    ? settings.groupingStrategy || 'maximize_area'
                    : (settings.groupingStrategy === 'cluster_tile' ? 'cluster_tile' : 'maximize_area'),
                // ═══ Cluster layout (chia cụm trên tờ giấy) ═══
                clusterMode: settings.clusterMode || 'none',
                clusterCount: settings.clusterCount || 2,
                clusterGap: settings.clusterGap || 0,
                // 'type' = mỗi cọc 1 loại (chia cọc theo tỷ lệ SL); 'default' = ratio_stack trộn ô.
                clusterDistribution: settings.clusterDistribution || 'default',
                clusterTileW: (isDieCut || settings.groupingStrategy === 'cluster_tile') ? settings.clusterTileW || 148 : undefined,
                clusterTileH: (isDieCut || settings.groupingStrategy === 'cluster_tile') ? settings.clusterTileH || 210 : undefined,
                clusterCols: settings.clusterCols || 2,
                clusterRows: settings.clusterRows || 2,
                clusterSizingMode: settings.clusterSizingMode || 'dims',
                clusterCombineMode: settings.clusterCombineMode || 'replicate_mixed',
                clusterNesting: settings.clusterNesting !== false,
                tileGapX: settings.tileGapX || 0,
                tileGapY: settings.tileGapY || 0,
                separateCutPage: isPageSheet
                    ? true
                    : (isDieCut && settings.cutType === 'one_dao'
                        ? true
                        : (isDieCut ? settings.separateCutPage || false : false)),
                // FIX (audit 2026-08-05 §OC.3): CNC luôn Front + Cut; toggle này chỉ
                // thuộc Sticker/Page Sheet, không gửi field gây kỳ vọng giả sang CNC.
                ...((isDieCut || isPageSheet) ? {
                    pontsOnCutFile: settings.pontsOnCutFile !== false,
                } : {}),
                hiddenOcgLayerIds: isDieCut ? settings.hiddenOcgLayerIds || [] : [],
                duplexFlow: isPageSheet ? 'normal' : settings.duplexFlow,
                // MIXED-GUILLOTINE (audit 2026-07-30 §MG.5/§MG.8): planner materialize mặt sau theo cạnh này.
                duplexFlipEdge: isGuillotine && settings.layoutType === 'mixed_guillotine'
                    ? (settings.duplexFlipEdge || 'long')
                    : undefined,
                // MIXED-GUILLOTINE (audit 2026-07-30 §MG-A2): % in dư cho phép → tỉ lệ.
                // Gom nhiều bản kẽm về 1 khi dư còn trong ngưỡng; preview dùng CÙNG giá trị.
                mixedExcessTolerance: isGuillotine && settings.layoutType === 'mixed_guillotine'
                    ? Math.max(0, Number(settings.mixedExcessPercent ?? 0)) / 100
                    : undefined,
                // Report & xuất tờ duy nhất (spec: binh-tem-be-report) — gồm cả CNC
                // PARITY/FIX (audit 2026-08-29 §NEST-PARITY-1): comment ngay trên nói
                // gồm CNC nhưng điều kiện cũ bỏ `isCnc`, khiến export gửi false trong khi
                // bundle CNC bắt buộc true và preview gửi true. Kết quả vừa miss session,
                // vừa có thể bị validator từ chối trước render.
                exportUniqueSheets: (isDieCut || isCnc || isPageSheet || (isGuillotine && settings.layoutType === 'mixed_guillotine'))
                    ? settings.exportUniqueSheets !== false : false,
                reportDisplay: (isDieCut || isCnc || isGuillotine) ? settings.reportDisplay : undefined,
                reportMaterial: (isDieCut || isCnc || isGuillotine) ? settings.reportMaterial : undefined,
                reportLamination: (isDieCut || isCnc || isGuillotine) ? settings.reportLamination : undefined,
                reportLaminationSides: (isDieCut || isCnc || isGuillotine) ? settings.reportLaminationSides : undefined,
                reportOrderCode: (isDieCut || isCnc || isGuillotine) ? settings.reportOrderCode : undefined,
                // ═══ Bình Bế Rớt (CNC) — định tuyến renderer riêng ở backend ═══
                imposerMode: isCnc ? 'cnc' : undefined,
                cncTwoSided: isCnc ? settings.cncTwoSided : undefined,
                cncFlipEdge: isCnc ? settings.cncFlipEdge : undefined,
                cncDuplexMarks: isCnc ? settings.cncDuplexMarks : undefined,
            };

            void previewPerfLog('nup-export START', {
                trace_id: settings.diagnosticTraceId || '',
                preview_request_id: settings.diagnosticPreviewRequestId || '',
                pending_request_id: settings.diagnosticPendingRequestId || '',
                preview_capacity: Number(settings.diagnosticPreviewCapacity ?? -1),
                preview_state: settings.diagnosticPreviewState || 'none',
                sheet_w_mm: settings.sheetWidth,
                sheet_h_mm: settings.sheetHeight,
                gap_x_mm: settings.gapX || 0,
                gap_y_mm: settings.gapY || 0,
                bleed_mm: settings.bleed || 0,
                split_gap_mm: Number(settings.splitGap ?? 0),
            });
            const jobId = await startNupJobBackend(serverPath, backendSettings);
            void previewPerfLog('nup-export ACCEPTED', {
                trace_id: settings.diagnosticTraceId || '',
                job_id: jobId,
                preview_capacity: Number(settings.diagnosticPreviewCapacity ?? -1),
            });
            ctx.setCancelHandler?.(async () => {
                await cancelNupJobBackend(jobId);
            });

            let done = false;
            while (!done) {
                const status = await getNupJobStatus(jobId);

                if (status.status === 'completed') {
                    void previewPerfLog('nup-export COMPLETE', {
                        trace_id: settings.diagnosticTraceId || '',
                        job_id: jobId,
                    });
                    done = true;
                    const newFileName = `Imposed_${file.name.replace('.pdf', '')}_.pdf`;
                    const nativeOutputPath = (
                        typeof window !== 'undefined'
                        && (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
                        && status.output_path
                    ) ? status.output_path as string : undefined;
                    const artifactLease = typeof status.artifact_lease === 'string'
                        ? status.artifact_lease
                        : undefined;
                    const savePrintConfig = resolveActiveSavePrintConfig(settings);
                    let blob: Blob;
                    if (!nativeOutputPath || savePrintConfig) {
                        setProcessStatus(i18n.t('lib.processHandlers:dang_tai_file_ket_qua_ve'));
                        blob = await downloadNupJob(jobId);
                    } else {
                        blob = new Blob(['native-path'], { type: 'application/pdf' });
                    }
                    // LIFECYCLE (audit 2026-08-25 §REV.11): token phải đi cùng
                    // carrier trước khi tab/history nhận revision mới.
                    tagArtifactLeaseToken(blob, artifactLease);

                    if (spawnNewTab && onSpawnTab) {
                        const outputFile = tagArtifactLeaseToken(
                            new File([blob], newFileName, { type: 'application/pdf' }),
                            artifactLease,
                        );
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
                    if (savePrintConfig) {
                        try {
                            setProcessStatus(i18n.t('lib.processHandlers:dang_tu_dong_luu_file_in'));
                            const { savePrintFilesToFolder, pagesPerTypeFor } = await import('../lib/savePrintFiles');
                            const cncMode = settings.imposerMode === 'cnc';
                            const cncTwoSided = !!settings.cncTwoSided;
                            const separateCut = isPageSheet || !!settings.separateCutPage;
                            const { ok } = await savePrintFilesToFolder(blob, savePrintConfig.folder, {
                                nameMode: savePrintConfig.nameMode, folderMode: savePrintConfig.folderMode,
                                separateCut, includeOrderCode: savePrintConfig.includeOrderCode, includeDate: savePrintConfig.includeDate,
                                orderCode: savePrintConfig.orderCode, cncMode, cncTwoSided,
                            }, {
                                pagesPerType: pagesPerTypeFor({ cncMode, cncTwoSided, separateCut }),
                                labelName: savePrintConfig.labelName,
                            });
                            setReportMsg(i18n.t('lib.processHandlers:da_tu_dong_luu_ok_file_in_vao_sp_folder', { ok, folder: savePrintConfig.folder }));
                            // UIUX (audit 2026-07-27 §D-11): toast thành công kèm nút mở thư mục đã lưu
                            toast.success(
                                i18n.t('lib.processHandlers:da_luu_file_in', { defaultValue: 'Đã tự động lưu {{ok}} file in', ok }),
                                {
                                    label: i18n.t('lib.processHandlers:mo_thu_muc', { defaultValue: 'Mở thư mục' }),
                                    onClick: () => { import('@tauri-apps/plugin-shell').then(m => m.open(savePrintConfig.folder)).catch(() => {}); },
                                }
                            );
                        } catch (e: unknown) {
                            // UIUX (audit 2026-07-27 §D-15): câu Việt + hướng khắc phục thay vì e.message thô
                            setError(formatError(e, i18n.t('lib.processHandlers:binh_xong_nhung_luu_file_in_loi', { defaultValue: 'Bình xong nhưng tự động lưu file in lỗi' })));
                        }
                    }
                } else if (status.status === 'failed') {
                    void previewPerfLog('nup-export FAILED', {
                        trace_id: settings.diagnosticTraceId || '',
                        job_id: jobId,
                    });
                    throw new Error(status.error || i18n.t('lib.processHandlers:loi_xu_ly_he_thong'));
                } else if (status.status === 'cancelled') {
                    void previewPerfLog('nup-export CANCELLED', {
                        trace_id: settings.diagnosticTraceId || '',
                        job_id: jobId,
                    });
                    throw new Error("ABORT_BY_USER");
                } else {
                    const prog = status.progress || '';
                    // Only update display for numeric progress (e.g. "3/10"), ignore backend stage messages
                    if (prog.includes('/')) {
                        setProcessStatus(i18n.t('lib.processHandlers:dang_xu_ly_prog_trang_da_binh', { prog }));
                    }
                    await waitForAppForegroundDelay(500);
                }
            }
        } else {
            // P2-T01: Prefer backend (imposition_core + pikepdf) for imposition to keep client as dumb assembler.
            // Sticker and other modes may use activeDashboardTool or separate paths.
            setProcessStatus(i18n.t('lib.processHandlers:dang_xu_ly_du_lieu_qua_backend_unified'));
            const { imposePdfViaBackend } = await import('../lib/pdfImposer');
            let serverPath: string;
            const filePath = (file as FileWithPath).path;
            if ((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ && filePath) {
                // Desktop backend runs on the same machine, so use the physical file directly.
                // This avoids reading and uploading hundreds of MB before imposition.
                serverPath = filePath;
            } else {
                const { uploadFileForNup } = await import('../lib/api');
                serverPath = await uploadFileForNup(file);
            }
            const result = await imposePdfViaBackend(serverPath, settings, setProcessStatus);
            const newFileName = `Imposed_${file.name.replace('.pdf', '')}_.pdf`;

            const nativeOutputPath = (
                (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
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
                            Object.defineProperty(outputFile, 'size', { value: Number(info.size || 0) });
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
        return PROCESS_COMPLETED;
    } catch (e: unknown) {
        if (e instanceof Error && e.message === "ABORT_BY_USER") {
            // Silently abort, user cancelled
            return PROCESS_CANCELED;
        }
        // UIUX (audit 2026-07-27 §D-15): Hủy thì im lặng; lỗi khác dịch thành câu Việt + hướng khắc phục
        if (isCanceled(e)) return PROCESS_CANCELED;
        const localizedError = settings.impositionMode === ImpositionMode.NUp
            ? localizeNupCapacityError(e)
            : e;
        if (localizedError !== e) {
            console.warn('[N-Up] Lỗi sức chứa từ backend:', e);
        }
        const message = formatError(localizedError, i18n.t('lib.processHandlers:khong_binh_duoc_trang', { defaultValue: 'Không bình được trang' }));
        setError(message);
        return processError(message);
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
): Promise<ProcessOutcome> {
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
        const workingFile = new File([asBlobPart(workingBytes)], file.name, { type: 'application/pdf' });
        const { uploadFileForNup } = await import('../lib/api');
        const serverPath = await uploadFileForNup(workingFile);
        const batchResults = await imposeCatalogBatchViaBackend(serverPath, planResult.jobs, sheetSettings, setProcessStatus, 'results');
        const successCount = batchResults.filter(r => r.blob.size > 0).length;


        const mergedDoc = await PDFDocument.create();
        // [OCG FIX 2026-07-28] Kết quả bình bản từ backend có mang OCG (lớp dao cắt
        // Result_Cutline_*). copyPages bỏ /OCProperties → mất lớp, máy bế không dò được,
        // và lớp đã ẩn của file gốc hiện lại.
        const ocTransfer = createOptionalContentTransfer();
        for (const r of batchResults) {
            if (r.blob.size > 0) {
                const rBytes = await r.blob.arrayBuffer();
                const rDoc = await PDFDocument.load(rBytes, { ignoreEncryption: true });
                addOptionalContentSource(ocTransfer, rDoc);
                const copiedPages = await mergedDoc.copyPages(rDoc, rDoc.getPageIndices());
                copiedPages.forEach(p => mergedDoc.addPage(p));
            }
        }
        finishOptionalContentTransfer(ocTransfer, mergedDoc);

        // Renumber plates globally
        let globalPlateNum = 0;
        for (const pg of mergedDoc.getPages()) {
            const existingUri = pg.node.get(PDFName.of('PlateInfoURI'));
            if (existingUri) {
                globalPlateNum++;
                let rawStr = readPdfString(existingUri);
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
                    const oldStr = readPdfString(existing);
                    const renumbered = oldStr.replace(/^(Kẽm|Plate) \d+/, `$1 ${globalPlateNum}`);
                    pg.node.set(PDFName.of('PlateInfo'), PDFString.of(renumbered));
                }
            }
        }

        const mergedBytes = await mergedDoc.save();
        const mergedBlob = new Blob([asBlobPart(mergedBytes)], { type: 'application/pdf' });
        const baseName = file.name.replace(/\.[^/.]+$/, '');
        const mergedFileName = `Kem_Gop_${baseName}_[${successCount}_Kem].pdf`;

        const batchOutputPayload: BatchOutput = {
            docs: batchResults.filter(r => r.blob.size > 0).map(r => ({ blob: r.blob, filename: r.filename, report: r.report })),
            mergedBlob
        };

        if (sheetSettings.spawnNewTab && onSpawnTab) {
            onSpawnTab(new File([mergedBlob], mergedFileName, { type: 'application/pdf' }), { batchOutput: batchOutputPayload });
            setProcessStatus('');
        } else {
            setBatchOutput(batchOutputPayload);
            await commitWorkingFile(mergedBlob, mergedFileName);
        }
        return PROCESS_COMPLETED;
    } catch (e: unknown) {
        // UIUX (audit 2026-07-27 §D-15): dịch lỗi kỹ thuật, Hủy thì không báo đỏ
        if (isCanceled(e)) return PROCESS_CANCELED;
        const message = formatError(e, i18n.t('lib.processHandlers:khong_xu_ly_duoc_catalog', { defaultValue: 'Không xử lý được Catalog' }));
        setError(message);
        return processError(message);
    } finally {
        setIsProcessing(false);
        setProcessStatus('');
    }
}

// ═════════════════════════════════════════════
//  Preprocess Handlers
// ═════════════════════════════════════════════

export async function runShuffle(ctx: ProcessContext, settings: ProcessHandlerSettings<ShuffleSettings>): Promise<ProcessOutcome> {
    const { file, onSpawnTab, commitWorkingFile, setError, setIsProcessing, setProcessStatus, getWorkingBytes } = ctx;    const shufflePresetId = settings.presetId ?? '';
    const shuffleRule = settings.rule ?? '';
    const shuffleGroupSize = settings.groupSize ?? 1;
    const shuffleMode = settings.mode ?? 'normal';
    const shuffleSpecialAction = settings.specialAction ?? 'odd_first';
    const shuffleEvenOddAction = (['odd_first', 'even_first', 'interleave', 'reverse_even'] as const).includes(shuffleSpecialAction as 'odd_first' | 'even_first' | 'interleave' | 'reverse_even') ? shuffleSpecialAction as 'odd_first' | 'even_first' | 'interleave' | 'reverse_even' : 'odd_first';
    // UIUX (audit 2026-07-27 §D-09): thêm hậu tố trấn an cho tác vụ chạy dài
    setError(''); setIsProcessing(true); setProcessStatus(i18n.t('lib.processHandlers:dang_xao_tron_trang') + LONG_TASK_HINT());
    try {
        const buildBackendRequest = (totalPages: number) => {
            let action = 'reverse';
            let mapping: number[] = [];
            if (shufflePresetId === 'special') {
                if (shuffleSpecialAction === 'reverse') action = 'reverse';
                else if (shuffleSpecialAction === 'odd_first') action = 'odd_first';
                else action = 'even_first';
            } else {
                action = 'custom';
                const rules = parseRule(shuffleRule);
                mapping = applyRule(
                    rules,
                    totalPages,
                    Math.max(1, shuffleGroupSize),
                    shuffleMode,
                ).map((item) => item.srcPage + 1);
            }
            return { action, mapping };
        };

        let sourcePath: string | undefined;
        try { sourcePath = await ctx.getWorkingSourcePath?.(); }
        catch { sourcePath = undefined; }

        // PERF (audit 2026-08-15 §PLAY.PATH): ngưỡng backend đã tồn tại từ
        // trước; kiểm path TRƯỚC khi đọc bytes để PDF lớn không tạo bản sao V8.
        if (sourcePath) {
            const { backendShufflePages, getPdfPathMetadata } = await import('../lib/api');
            const exceedsSizeLimit = file.size > 300 * 1024 * 1024;
            const hasUnknownPathSize = !(file.size > 0);
            const mustUsePathBackend = exceedsSizeLimit || hasUnknownPathSize;
            const simpleSpecialAction = shufflePresetId === 'special'
                && ['reverse', 'odd_first', 'even_first'].includes(shuffleSpecialAction);
            let metadata: PdfPathMetadata | undefined;
            if (!mustUsePathBackend || !simpleSpecialAction) {
                try {
                    metadata = await getPdfPathMetadata(sourcePath);
                } catch (error) {
                    // Path lớn không được fallback đọc bytes vì sẽ tái tạo đúng OOM.
                    if (mustUsePathBackend) throw error;
                }
            }
            const shouldUsePathBackend = mustUsePathBackend
                || (metadata?.page_count ?? 0) > 1000;
            if (shouldUsePathBackend && shufflePresetId === 'special' && shuffleSpecialAction === 'split_odd_even') {
                if (!metadata) throw new Error(tv('Không đọc được số trang của file PDF.'));
                const oddPages = Array.from(
                    { length: Math.ceil(metadata.page_count / 2) },
                    (_, index) => index * 2 + 1,
                );
                const evenPages = Array.from(
                    { length: Math.floor(metadata.page_count / 2) },
                    (_, index) => index * 2 + 2,
                );
                // Scheduler sidecar tự gate theo RAM/phần cứng; không hard-cap máy mạnh ở UI.
                const [oddBlob, evenBlob] = await Promise.all([
                    backendShufflePages(file, 'custom', oddPages, sourcePath),
                    backendShufflePages(file, 'custom', evenPages, sourcePath),
                ]);
                if (!onSpawnTab) {
                    throw new Error(tv("Môi trường hiện tại không hỗ trợ mở nhiều Tab."));
                }
                onSpawnTab(new File([oddBlob], `TrangLe_${file.name}`, { type: 'application/pdf' }));
                onSpawnTab(new File([evenBlob], `TrangChan_${file.name}`, { type: 'application/pdf' }));
                ctx.setReportMsg('');
                return PROCESS_COMPLETED;
            }
            if (shouldUsePathBackend) {
                const { action, mapping } = buildBackendRequest(metadata?.page_count ?? 0);
                const blob = await backendShufflePages(file, action, mapping, sourcePath);
                const newFileName = `Shuffled_${file.name}`;
                if (settings.spawnNewTab && onSpawnTab) {
                    onSpawnTab(new File([blob], newFileName, { type: 'application/pdf' }));
                } else {
                    await commitWorkingFile(blob, newFileName);
                    ctx.setReportMsg('');
                }
                return PROCESS_COMPLETED;
            }
        }

        const inputBytes = await getWorkingBytes();
        const srcPdf = await PDFDocument.load(inputBytes);
        const totalPages = srcPdf.getPageCount();

        if ((totalPages > 1000 || file.size > 300 * 1024 * 1024) && shuffleSpecialAction !== 'split_odd_even') {
            // UIUX (audit 2026-07-27 §D-09)
            setProcessStatus(i18n.t('lib.processHandlers:dang_xao_tron_trang') + LONG_TASK_HINT());
            const { backendShufflePages } = await import('../lib/api');
            const { action, mapping } = buildBackendRequest(totalPages);
            const workingFile = new File([asBlobPart(inputBytes)], file.name, { type: 'application/pdf' });
            const blob = await backendShufflePages(workingFile, action, mapping);
            const newFileName = `Shuffled_${file.name}`;
            if (settings.spawnNewTab && onSpawnTab) { onSpawnTab(new File([blob], newFileName, { type: 'application/pdf' })); }
            else { await commitWorkingFile(blob, newFileName); }
        } else {
            if (shufflePresetId === 'special' && shuffleSpecialAction === 'split_odd_even') {
                const odds = Array.from({ length: totalPages }, (_, i) => i).filter(i => i % 2 === 0);
                const evens = Array.from({ length: totalPages }, (_, i) => i).filter(i => i % 2 === 1);

                const mappingOdd = odds.map(p => ({ srcPage: p, rotation: 0 }));
                const mappingEven = evens.map(p => ({ srcPage: p, rotation: 0 }));

                const outputBytesOdd = await executeShuffle(srcPdf, mappingOdd);
                const outputBytesEven = await executeShuffle(srcPdf, mappingEven);

                if (onSpawnTab) {
                    onSpawnTab(new File([new Blob([asBlobPart(outputBytesOdd)], { type: 'application/pdf' })], `TrangLe_${file.name}`, { type: 'application/pdf' }));
                    onSpawnTab(new File([new Blob([asBlobPart(outputBytesEven)], { type: 'application/pdf' })], `TrangChan_${file.name}`, { type: 'application/pdf' }));
                    ctx.setReportMsg('');
                } else {
                    throw new Error(tv("Môi trường hiện tại không hỗ trợ mở nhiều Tab."));
                }
                return PROCESS_COMPLETED;
            }

            let mapping: PageMapping[] = [];
            if (shufflePresetId === 'special') {
                if (shuffleSpecialAction === 'reverse') mapping = reversePages(totalPages);
                else mapping = shuffleEvenOdd(totalPages, shuffleEvenOddAction);
            } else {
                const rules = parseRule(shuffleRule);
                if (rules.length === 0) throw new Error(tv("Quy tắc trống hoặc không hợp lệ."));
                mapping = applyRule(rules, totalPages, Math.max(1, shuffleGroupSize), shuffleMode);
            }
            const outputBytes = await executeShuffle(srcPdf, mapping);
            const blob = new Blob([asBlobPart(outputBytes)], { type: 'application/pdf' });
            const newFileName = `Shuffled_${file.name}`;
            if (settings.spawnNewTab && onSpawnTab) { onSpawnTab(new File([blob], newFileName, { type: 'application/pdf' })); }
            else { await commitWorkingFile(blob, newFileName); ctx.setReportMsg(''); }
        }
        return PROCESS_COMPLETED;
    // UIUX (audit 2026-07-27 §D-15): formatError + im lặng khi user Hủy
    } catch (err: unknown) {
        if (isCanceled(err)) return PROCESS_CANCELED;
        const message = formatError(err, i18n.t('lib.processHandlers:khong_xao_tron_duoc_trang', { defaultValue: 'Không xáo trộn được trang' }));
        setError(message);
        return processError(message);
    }
    finally { setIsProcessing(false); setProcessStatus(''); }
}

export async function runResize(ctx: ProcessContext, rawSettings: unknown): Promise<ProcessOutcome> {
    const settings = rawSettings as ProcessHandlerSettings<PageResizerSettings>;
    const { file, onSpawnTab, commitWorkingFile, setError, setIsProcessing, setProcessStatus, getWorkingBytes } = ctx;
    // UIUX (audit 2026-08-01 §R.10): Resize chỉ dùng một thông báo chờ ổn định.
    const processingStatus = i18n.t('lib.processHandlers:dang_xu_ly', {
        defaultValue: 'Đang xử lý...',
    });
    setError(''); setIsProcessing(true); setProcessStatus(processingStatus);

    const MM_TO_PT = 2.83465;
    const targetW = settings.targetW ?? 0;
    const targetH = settings.targetH ?? 0;
    const scaleMode = settings.scaleMode ?? 'fit';
    const applyToStr = settings.applyToStr ?? 'all';
    const resizeMode: string = settings.resizeMode || 'auto';
    const pageSizeMode: 'fixed' | 'fixed_width' | 'fixed_height' = settings.pageSizeMode || 'fixed';
    const lockedAxis = pageSizeMode === 'fixed_width' || pageSizeMode === 'fixed_height';
    // RESIZE (audit 2026-08-06 §G.11): khổ khóa một chiều KHÔNG còn bị ép 'fit'.
    // 'center_no_scale' là ca thật: tem 5×10 đưa về chiều cao 15 → trang 7.5×15,
    // tem giữ nguyên 5×10 nằm giữa. Chỉ 'fill'/'stretch' mới phải hạ về 'fit'
    // vì khổ đích đã sinh ra đúng tỷ lệ nội dung nên không còn phần dư để xử lý.
    const effectiveScaleMode = lockedAxis && scaleMode !== 'center_no_scale'
        ? 'fit'
        : scaleMode;
    const newFileName = `Resized_${file.name}`;
    // pdf-lib nạp CẢ file vào RAM rồi embedPages (nhân bản nội dung trang thành Form
    // XObject) + save (dựng Uint8Array mới) → đỉnh RAM ~3-4× kích thước file. File
    // lớn/nhiều ảnh vượt trần cấp phát ArrayBuffer của V8 → "Array buffer allocation
    // failed". Vượt ngưỡng này BỎ QUA pdf-lib, đẩy thẳng backend (xử lý theo path
    // trên đĩa qua backend/PDFium, KHÔNG nạp vào WebView).
    const FE_SIZE_LIMIT = 50 * 1024 * 1024;

    const emit = async (blob: Blob) => {
        const destination = settings.spawnNewTab && onSpawnTab ? 'new_tab' : 'working_file';
        const nativeBlob = blob as Blob & { path?: string; nativeSize?: number };
        const nativeOutputPath = typeof nativeBlob.path === 'string' && nativeBlob.path
            ? nativeBlob.path
            : undefined;
        const outputBytes = Number.isFinite(nativeBlob.nativeSize)
            ? Number(nativeBlob.nativeSize)
            : blob.size;
        if (settings.spawnNewTab && onSpawnTab) {
            const outputFile = new File([blob], newFileName, { type: 'application/pdf' });
            if (nativeOutputPath) {
                Object.defineProperty(outputFile, 'path', { value: nativeOutputPath });
                if (outputBytes > 0) {
                    Object.defineProperty(outputFile, 'size', { value: outputBytes });
                }
            }
            onSpawnTab(outputFile);
        } else {
            await commitWorkingFile(blob, newFileName, nativeOutputPath);
            ctx.setReportMsg('');
        }
    };



    try {
        // RESIZE (audit 2026-08-01 §RT.11): nền động đi một backend job;
        // solid/không nền vẫn giữ fast-path frontend hiện có.
        const hasGapMode = !lockedAxis
            && (effectiveScaleMode === 'fit' || effectiveScaleMode === 'center_no_scale');
        const fillMode = settings.bgFillMode || 'mirror';
        const wantEdgeFill =
            ['mirror', 'trajectory', 'inpaint', 'image'].includes(fillMode) && hasGapMode;
        const wantSolidFill =
            fillMode === 'solid' && hasGapMode;
        // RESIZE (audit 2026-08-24 §RZ-STATE): state cũ không được kéo
        // Fill/Stretch vào worker nền động khi UI đã ẩn vùng trống.
        const contentAwareScale = effectiveScaleMode === 'fit' || effectiveScaleMode === 'center_no_scale';
        const wantResizeByContent = settings.resizeByContent === true && contentAwareScale;
        // RESIZE (audit 2026-08-01 §R.5): nền đã bị ẩn trong mode khóa một
        // chiều thì state cũ không được âm thầm đổi transparency/màu output.
        const effectiveFillMode = lockedAxis ? 'white' : fillMode;

        // RESIZE (audit 2026-08-06 §G.3): dò xem tác vụ có THU NHỎ khổ không, để
        // nhánh backend-only dùng chung heuristic "auto = 300 DPI khi thu nhỏ".
        // Chỉ soi trang đầu và chỉ khi file đủ nhỏ để nạp vào RAM an toàn — file
        // lớn giữ nguyên hành vi cũ (0 = không downsample) thay vì mạo hiểm OOM.
        let pathMetadataPromise: Promise<PdfPathMetadata> | null = null;
        const loadPathMetadata = (sourcePath: string) => {
            pathMetadataPromise ??= import('../lib/api').then(({ getPdfPathMetadata }) => (
                getPdfPathMetadata(sourcePath)
            ));
            return pathMetadataPromise;
        };
        const isDownsizingDimensions = (width: number, height: number): boolean => {
            if (!(width > 0 && height > 0)) return false;
            if (pageSizeMode === 'fixed_width') {
                return targetW * MM_TO_PT < width * 0.95;
            }
            if (pageSizeMode === 'fixed_height') {
                return targetH * MM_TO_PT < height * 0.95;
            }
            const srcArea = width * height;
            const dstArea = (targetW * MM_TO_PT) * (targetH * MM_TO_PT);
            return dstArea > 0 && dstArea < srcArea * 0.9;
        };
        const isDownsizingByProbe = async (sourcePath?: string): Promise<boolean> => {
            try {
                if (sourcePath) {
                    const metadata = await loadPathMetadata(sourcePath);
                    const firstPage = metadata.pages?.[0];
                    if (!firstPage) return false;
                    return isDownsizingDimensions(
                        Number(firstPage.media_width_pt ?? firstPage.width_pt),
                        Number(firstPage.media_height_pt ?? firstPage.height_pt),
                    );
                }
                if ((file.size || 0) > FE_SIZE_LIMIT) return false;
                const probeBytes = await getWorkingBytes();
                const probeDoc = await PDFDocument.load(probeBytes);
                const { width, height } = probeDoc.getPage(0).getSize();
                return isDownsizingDimensions(width, height);
            } catch (error) {
                if (sourcePath && (!(file.size > 0) || file.size > FE_SIZE_LIMIT)) throw error;
                return false;
            }
        };


        let sourcePath: string | undefined;
        try { sourcePath = await ctx.getWorkingSourcePath?.(); }
        catch { sourcePath = undefined; }

        if (wantEdgeFill || lockedAxis || wantResizeByContent) {
            // RESIZE (audit 2026-08-01 §RT.11): một backend job duy nhất tự dò
            // contentBox, fit, lấp vùng trống và đặt lại artwork vector.
            setProcessStatus(processingStatus);
            const { backendResizePages } = await import('../lib/api');

            let inputFile = file;
            let inputBytes: Uint8Array | undefined;
            if (!sourcePath) {
                inputBytes = await getWorkingBytes();
                inputFile = new File([inputBytes as BlobPart], file.name, {
                    type: 'application/pdf',
                });
            }
            // RESIZE (audit 2026-08-06 §G.3): nhánh nền động / khóa một chiều /
            // resize theo nội dung trước đây bỏ heuristic downsample mặc định →
            // A1→A5 vẫn ~300MB, mọi tác vụ sau đó chậm. Dùng chung heuristic
            // "auto = 300 DPI khi thu nhỏ" với nhánh thường bên dưới.
            let autoTargetDpi = 0;
            if (typeof settings.targetDpi !== 'number') {
                if (sourcePath) {
                    autoTargetDpi = await isDownsizingByProbe(sourcePath) ? 300 : 0;
                } else if (
                    inputBytes
                    && Math.max(file.size || 0, inputBytes.byteLength) <= FE_SIZE_LIMIT
                ) {
                    // PERF (audit 2026-08-22 §RESIZE.FE.1): tái dụng bytes đã
                    // materialize cho upload; gọi getWorkingBytes lần hai có thể bake
                    // lại toàn bộ chỉnh sửa Acrobat của tài liệu dirty. Vẫn giữ
                    // hàng rào 50 MB để không parse object graph lớn trong WebView.
                    try {
                        const probeDoc = await PDFDocument.load(inputBytes);
                        const { width, height } = probeDoc.getPage(0).getSize();
                        autoTargetDpi = isDownsizingDimensions(width, height) ? 300 : 0;
                    } catch { /* Giữ heuristic an toàn: không downsample khi probe lỗi. */ }
                }
            }
            const targetDpi = typeof settings.targetDpi === 'number'
                ? settings.targetDpi
                : autoTargetDpi;
            // RESIZE (audit 2026-08-06 §G.4): màu nền trơn người dùng chọn phải
            // đi theo cả nhánh này; ép cứng '#ffffff' làm "Đổ màu trơn + Resize
            // theo nội dung" luôn ra nền trắng. Mode khóa một chiều đã bị hạ về
            // 'white' ở effectiveFillMode (§R.5) nên không bị ảnh hưởng.
            const backendFillColor = effectiveFillMode === 'solid'
                ? (settings.bgFillColor || '#ffffff')
                : '#ffffff';
            await emit(await backendResizePages(
                inputFile, targetW, targetH, effectiveScaleMode,
                applyToStr || 'all', targetDpi, resizeMode,
                effectiveFillMode, backendFillColor, sourcePath,
                pageSizeMode,
                wantResizeByContent,
            ));
            return PROCESS_COMPLETED;
        }

        const pathMustUseBackend = !!sourcePath
            && (!(file.size > 0) || file.size > FE_SIZE_LIMIT);
        let pathMetadata: PdfPathMetadata | undefined;
        if (
            sourcePath
            && !(typeof settings.targetDpi === 'number' && settings.targetDpi > 0)
        ) {
            try { pathMetadata = await loadPathMetadata(sourcePath); }
            catch (error) {
                if (pathMustUseBackend) throw error;
                pathMetadata = undefined;
            }
        }
        const autoDownsizeFromPath = settings.targetDpi === undefined
            && !!pathMetadata?.pages?.[0]
            && isDownsizingDimensions(
                Number(pathMetadata.pages[0].media_width_pt ?? pathMetadata.pages[0].width_pt),
                Number(pathMetadata.pages[0].media_height_pt ?? pathMetadata.pages[0].height_pt),
            );
        const shouldUsePathBackend = !!sourcePath && (
            pathMustUseBackend
            || (typeof settings.targetDpi === 'number' && settings.targetDpi > 0)
            || (pathMetadata?.page_count ?? 0) > 1000
            || autoDownsizeFromPath
        );

        if (sourcePath && shouldUsePathBackend) {
            // PERF (audit 2026-08-15 §PLAY.PATH): đây vẫn là nhánh backend cũ,
            // chỉ quyết định trước khi gọi getWorkingBytes để tránh bản sao 50–500 MB.
            const { backendResizePages } = await import('../lib/api');
            const targetDpi = typeof settings.targetDpi === 'number'
                ? settings.targetDpi
                : ((autoDownsizeFromPath || await isDownsizingByProbe(sourcePath)) ? 300 : 0);
            await emit(await backendResizePages(
                file, targetW, targetH, effectiveScaleMode,
                applyToStr || 'all', targetDpi, resizeMode,
                wantSolidFill ? 'solid' : 'white',
                wantSolidFill ? (settings.bgFillColor || '#ffffff') : '#ffffff',
                sourcePath,
                pageSizeMode,
                wantResizeByContent,
            ));
            return PROCESS_COMPLETED;
        }

        // Đọc input bytes
        let inputBytes: Uint8Array;
        try {
            inputBytes = await getWorkingBytes();
        } catch {
            // REVISION (audit 2026-08-25 §REV.09): backing `file` không chứng
            // minh tương đương Viewer khi materialize order/rotation thất bại.
            // Dừng tường minh thay vì tạo output "thành công" từ revision cũ.
            const failure = new Error(i18n.t('lib.processHandlers:khong_doc_duoc_pdf_lam_viec', {
                defaultValue: 'Không thể tạo PDF làm việc từ thứ tự hoặc góc xoay trang hiện tại.',
            }));
            throw failure;
        }

        // Soi pdf-lib để lấy số trang + quyết định downsample
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
            canUseFrontend = false;
        }

        const workingBytes = inputBytes;

        // ── Bước 2: Resize ──────────────────────────────────────────────────
        setProcessStatus(processingStatus);

        // Giảm dữ liệu theo khổ mới (downsample)
        const targetArea = (targetW * MM_TO_PT) * (targetH * MM_TO_PT);
        const isDownsizing = sourceArea > 0 && targetArea > 0 && targetArea < sourceArea * 0.9;
        const targetDpi: number = typeof settings.targetDpi === 'number'
            ? settings.targetDpi
            : (isDownsizing ? 300 : 0);
        const wantDownsample = targetDpi > 0;

        const runBackend = async (): Promise<Blob> => {
            const { backendResizePages } = await import('../lib/api');
            const workingFile = new File([asBlobPart(workingBytes)], file.name, { type: 'application/pdf' });
            return backendResizePages(
                workingFile, targetW, targetH, effectiveScaleMode,
                applyToStr || 'all', targetDpi, resizeMode,
                wantSolidFill ? 'solid' : 'white',
                wantSolidFill ? (settings.bgFillColor || '#ffffff') : '#ffffff',
                undefined,
                pageSizeMode,
                wantResizeByContent,
            );
        };

        let resizedBlob: Blob;
        if (wantDownsample || !canUseFrontend || totalPages > 1000 || (file.size || workingBytes.byteLength) > FE_SIZE_LIMIT) {
            resizedBlob = await runBackend();
        } else {
            try {
                let applyToPages: 'all' | 'even' | 'odd' | number[] = 'all';
                if (applyToStr === 'even' || applyToStr === 'odd' || applyToStr === 'all') {
                    applyToPages = applyToStr;
                } else {
                    const ranges = parseRanges(applyToStr, totalPages);
                    applyToPages = ranges.flatMap(([start, end]: [number, number]) => Array.from({ length: end - start + 1 }, (_, i) => start + i));
                }
                const outputBytes = await resizePages(workingBytes, {
                    targetW: targetW,
                    targetH: targetH,
                    scaleMode: effectiveScaleMode,
                    applyTo: applyToPages,
                    bgFillMode: wantSolidFill ? 'solid' : undefined,
                    bgFillColor: wantSolidFill ? settings.bgFillColor : undefined,
                });
                resizedBlob = new Blob([asBlobPart(outputBytes)], { type: 'application/pdf' });
            } catch (feErr) {
                console.warn('[resize] pdf-lib thất bại, fallback backend:', feErr);
                resizedBlob = await runBackend();
            }
        }

        await emit(resizedBlob);
        return PROCESS_COMPLETED;
    } catch (err: unknown) {
        const canceled = isCanceled(err);
        // UIUX (audit 2026-07-27 §D-15): formatError + im lặng khi user Hủy
        if (canceled) return PROCESS_CANCELED;
        const message = formatError(err, i18n.t('lib.processHandlers:khong_doi_duoc_kho_trang', { defaultValue: 'Không đổi được khổ trang' }));
        setError(message);
        return processError(message);
    }
    finally { setIsProcessing(false); setProcessStatus(''); }
}

export async function runTrimShift(ctx: ProcessContext, settings: ProcessHandlerSettings<TrimShiftSettings>): Promise<ProcessOutcome> {
    const { file, onSpawnTab, commitWorkingFile, setError, setIsProcessing, setProcessStatus, getWorkingBytes } = ctx;
    // UIUX (audit 2026-07-27 §D-09): thêm hậu tố trấn an cho tác vụ chạy dài
    setError(''); setIsProcessing(true); setProcessStatus(i18n.t('lib.processHandlers:dang_cat_xen_doi_noi_dung') + LONG_TASK_HINT());
    try {
        const inputBytes = await getWorkingBytes();
        const { backendTrimShift } = await import('../lib/api');
        const { UNIT_TO_MM } = await import('../components/preprocess-tools/trimShiftUnits');
        const workingFile = new File([asBlobPart(inputBytes)], file.name, { type: 'application/pdf' });
        // Backend luôn nhận mm; quy đổi từ đơn vị người dùng chọn.
        const k = UNIT_TO_MM[settings.unit as keyof typeof UNIT_TO_MM] ?? 1;
        const splitSettings = settings.split;
        const splitCount = splitSettings?.count === 3 ? 3 : 2;
        const splitPieces = Array.from({ length: splitCount }, (_, index) => {
            const piece = splitSettings?.pieces?.[index] ?? { top: 0, bottom: 0, left: 0, right: 0 };
            return {
                top: (piece.top || 0) * k,
                bottom: (piece.bottom || 0) * k,
                left: (piece.left || 0) * k,
                right: (piece.right || 0) * k,
            };
        });
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
            ...(splitSettings?.enabled ? {
                split: {
                    enabled: true,
                    axis: splitSettings.axis === 'horizontal' ? 'horizontal' : 'vertical',
                    count: splitCount,
                    pieces: splitPieces,
                },
            } : {}),
        };
        const blob = await backendTrimShift(workingFile, settings.applyToStr || 'all', config);
        const newFileName = `TrimShift_${file.name}`;
        if (settings.spawnNewTab && onSpawnTab) { onSpawnTab(new File([blob], newFileName, { type: 'application/pdf' })); }
        else { await commitWorkingFile(blob, newFileName); }
        return PROCESS_COMPLETED;
    // UIUX (audit 2026-07-27 §D-15): formatError + im lặng khi user Hủy
    } catch (err: unknown) {
        if (isCanceled(err)) return PROCESS_CANCELED;
        const message = formatError(err, i18n.t('lib.processHandlers:khong_cat_xen_doi_duoc', { defaultValue: 'Không cắt xén/dời được nội dung' }));
        setError(message);
        return processError(message);
    }
    finally { setIsProcessing(false); setProcessStatus(''); }
}

async function publishBackendSplitResult(
    ctx: ProcessContext,
    settings: ProcessHandlerSettings<SplitSettings>,
    result: BackendSplitPdfResult,
): Promise<ProcessOutcome> {
    if (result.kind === 'zip') {
        if (settings.mode === 'extract_pages') {
            const message = i18n.t('lib.processHandlers:split_extract_tra_zip_khong_hop_le', {
                defaultValue: 'Backend trả ZIP cho thao tác chỉ được phép tạo một PDF.',
            });
            ctx.setError(message);
            return processError(message);
        }
        // RECIPE (audit 2026-08-15 §PLAY.4): ZIP là bộ output rời, tuyệt đối không
        // đưa vào working PDF hoặc mở tab PDF giả. Người dùng chọn nơi lưu bộ file.
        const { saveBlob } = await import('./saveBlob');
        const saved = await saveBlob(result.blob, result.filename, {
            title: tv('Lưu file'),
            filterName: 'ZIP',
            extensions: ['zip'],
        });
        if (saved.kind === 'cancelled') return PROCESS_CANCELED;
        ctx.setReportMsg(`${tv('Đã lưu thành công')}: ${result.filename}`);
        return PROCESS_COMPLETED;
    }

    if (settings.spawnNewTab && ctx.onSpawnTab) {
        ctx.onSpawnTab(new File([result.blob], result.filename, { type: 'application/pdf' }));
    } else {
        await ctx.commitWorkingFile(result.blob, result.filename);
    }
    ctx.setReportMsg(i18n.t('lib.processHandlers:da_tach_file_thanh_cong'));
    return PROCESS_COMPLETED;
}

export async function runSplit(ctx: ProcessContext, settings: ProcessHandlerSettings<SplitSettings>): Promise<ProcessOutcome> {
    const { file, onSpawnTab, commitWorkingFile, setError, setIsProcessing, setProcessStatus, setReportMsg, getWorkingBytes } = ctx;
    // UIUX (audit 2026-07-27 §D-09): thêm hậu tố trấn an cho tác vụ chạy dài
    setError(''); setIsProcessing(true); setProcessStatus(i18n.t('lib.processHandlers:dang_tach_pdf') + LONG_TASK_HINT());    const splitMode = settings.mode ?? 'by_range';
    const splitRanges = settings.ranges ?? '';
    const splitPageListStr = settings.pageListStr ?? '';
    try {
        let pageList: number[] = [];
        if (splitMode === 'extract_pages') {
            pageList = splitPageListStr.split(',').map((s: string) => parseInt(s.trim())).filter((n: number) => !isNaN(n));
        }
        const pagesPerFile = Math.max(1, Math.trunc(Number(settings.pagesPerFile) || 1));
        const needsDetachedMultiOutput = !settings.spawnNewTab && splitMode !== 'extract_pages';

        let sourcePath: string | undefined;
        try { sourcePath = await ctx.getWorkingSourcePath?.(); }
        catch { sourcePath = undefined; }

        // PERF (audit 2026-08-15 §PLAY.PATH): route backend trước khi pdf-lib
        // mở file path lớn. Không đổi ngưỡng hay mức song song hiện có.
        let shouldUsePathBackend = !!sourcePath
            && (needsDetachedMultiOutput || !(file.size > 0) || file.size > 300 * 1024 * 1024);
        if (sourcePath && !shouldUsePathBackend) {
            try {
                const { getPdfPathMetadata } = await import('../lib/api');
                shouldUsePathBackend = (await getPdfPathMetadata(sourcePath)).page_count > 1000;
            } catch {
                // File dưới ngưỡng RAM vẫn có thể fallback engine frontend hiện có.
                shouldUsePathBackend = false;
            }
        }
        if (sourcePath && shouldUsePathBackend) {
            const { backendSplitPdf } = await import('../lib/api');
            const result = await backendSplitPdf(
                file,
                splitMode,
                { ranges: splitRanges, pagesPerFile, pageList },
                sourcePath,
            );
            return publishBackendSplitResult(ctx, settings, result);
        }

        // Tuân thủ kết quả cuối cùng: tách trên file đã áp dụng sửa đổi trang.
        const inputBytes = await getWorkingBytes();
        const quickDoc = await PDFDocument.load(inputBytes);
        const totalPages = quickDoc.getPageCount();

        if (totalPages > 1000 || file.size > 300 * 1024 * 1024 || needsDetachedMultiOutput) {

            const { backendSplitPdf } = await import('../lib/api');
            const workingFile = new File([asBlobPart(inputBytes)], file.name, { type: 'application/pdf' });
            const result = await backendSplitPdf(workingFile, splitMode, { ranges: splitRanges, pagesPerFile, pageList });
            return publishBackendSplitResult(ctx, settings, result);
        } else {
            const results = await splitPdf(inputBytes, splitMode, { ranges: splitRanges, pagesPerFile, pageList }, file.name.replace('.pdf', ''));
            if (results.length === 0) throw new Error(tv("Thao tác tách không tạo ra file nào."));
            if (settings.spawnNewTab && onSpawnTab) {
                for (const r of results) { onSpawnTab(new File([new Blob([asBlobPart(r.bytes)])], r.filename, { type: 'application/pdf' })); }
                setReportMsg(i18n.t('lib.processHandlers:da_tao_results_length_tab_moi', { count: results.length }));
            } else {
                const first = results[0];
                await commitWorkingFile(new Blob([asBlobPart(first.bytes)], { type: 'application/pdf' }), first.filename);
                setReportMsg(i18n.t('lib.processHandlers:da_tach_thanh_results_length_file', { count: results.length }));
            }
        }
        return PROCESS_COMPLETED;
    // UIUX (audit 2026-07-27 §D-15): formatError + im lặng khi user Hủy
    } catch (err: unknown) {
        if (isCanceled(err)) return PROCESS_CANCELED;
        const message = formatError(err, i18n.t('lib.processHandlers:khong_tach_duoc_pdf', { defaultValue: 'Không tách được PDF' }));
        setError(message);
        return processError(message);
    }
    finally { setIsProcessing(false); setProcessStatus(''); }
}

export async function runMerge(ctx: ProcessContext, settings: ProcessHandlerSettings<MergeSettings>): Promise<ProcessOutcome> {
    const {
        file, onSpawnTab, commitWorkingFile, setError, setIsProcessing,
        setProcessStatus, setCancelHandler, getWorkingBytes,
    } = ctx;
    // UIUX (audit 2026-07-27 §D-09): thêm hậu tố trấn an cho tác vụ chạy dài
    setError(''); setIsProcessing(true); setProcessStatus(i18n.t('lib.processHandlers:dang_ghep_pdf') + LONG_TASK_HINT());    const mergeMode = settings.mode ?? 'merge_files';

    try {
        const isInterleave = mergeMode === 'interleave';
        let workingBytes: Uint8Array | null = null;
        let workingBaseFile: File | null = null;
        let inputFiles: File[];

        if (isInterleave) {
            // FILEIO (audit 2026-08-02 §COMB.1): Interleave chỉ dùng đúng hai nguồn;
            // không đọc/bake file của tab hiện tại vì engine không sử dụng nó.
            inputFiles = [settings.oddFile, settings.evenFile]
                .filter((candidate: File | null | undefined): candidate is File => Boolean(candidate));
        } else {
            // Merge thường phải dùng bản working đã áp dụng mọi chỉnh sửa trang.
            workingBytes = await getWorkingBytes();
            workingBaseFile = new File(
                [new Uint8Array(workingBytes).buffer],
                file.name,
                { type: 'application/pdf' },
            );
            const extraFiles = Array.isArray(settings.filesToMerge)
                ? settings.filesToMerge.filter(
                    (candidate: unknown): candidate is File => candidate instanceof File,
                )
                : [];
            inputFiles = [workingBaseFile, ...extraFiles];
        }

        // COMBINE (audit 2026-08-02 §COMB.1): estimate và loại input phải dựa
        // đúng danh sách sẽ gửi, đặc biệt odd/even của Interleave.
        const totalPageEstimate = inputFiles.reduce(
            (estimate, input) => estimate + input.size / 5000,
            0,
        );
        const hasImages = inputFiles.some((input) => /\.(jpe?g|png)$/i.test(input.name));
        const canDelegate = totalPageEstimate > 1000
            && !hasImages
            && (!isInterleave || inputFiles.length === 2);

        if (canDelegate) {
            const { backendMergePdfsJob } = await import('../lib/api');
            const mode = isInterleave ? 'interleave' : 'merge_files';
            const controller = new AbortController();
            setCancelHandler?.(async () => controller.abort());
            const result = await backendMergePdfsJob(inputFiles, mode, {
                signal: controller.signal,
                onProgress: status => setProcessStatus(
                    `${i18n.t('lib.processHandlers:dang_ghep_pdf')} ${Math.round(status.progress)}%`,
                ),
            });
            controller.signal.throwIfAborted();
            const newFileName = isInterleave
                ? 'Interleaved_Document.pdf'
                : `Merged_${file.name}`;
            const blob = result.blob || new Blob([], { type: 'application/pdf' });
            if (settings.spawnNewTab && onSpawnTab) {
                const output = new File([blob], newFileName, { type: 'application/pdf' });
                if (result.path) Object.defineProperty(output, 'path', { value: result.path });
                onSpawnTab(output);
            } else if (result.path) {
                await commitWorkingFile(blob, newFileName, result.path);
            } else {
                await commitWorkingFile(blob, newFileName);
            }
            return PROCESS_COMPLETED;
        }

        const outputBytes = await mergePdf(workingBytes, settings as MergeSettings);
        const blob = new Blob(
            [new Uint8Array(outputBytes).buffer],
            { type: 'application/pdf' },
        );
        const newFileName = isInterleave
            ? 'Interleaved_Document.pdf'
            : `Merged_${file.name}`;
        if (settings.spawnNewTab && onSpawnTab) {
            onSpawnTab(new File([blob], newFileName, { type: 'application/pdf' }));
        } else {
            await commitWorkingFile(blob, newFileName);
            ctx.setReportMsg('');
        }
        return PROCESS_COMPLETED;
    // UIUX (audit 2026-07-27 §D-15): formatError + im lặng khi user Hủy
    } catch (error: unknown) {
        if (isCanceled(error)) return PROCESS_CANCELED;
        const message = formatError(
            error,
            i18n.t('lib.processHandlers:khong_ghep_duoc_pdf', {
                defaultValue: 'Không ghép được PDF',
            }),
        );
        setError(message);
        return processError(message);
    } finally {
        setCancelHandler?.(null);
        setIsProcessing(false);
        setProcessStatus('');
    }
}
