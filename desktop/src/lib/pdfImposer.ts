// src/lib/pdfImposer.ts
import { PDFDocument } from 'pdf-lib';
import type { PlateJob } from './imposerEngine/CatalogPlanner';
import { generateBindingMap } from './imposerEngine/VirtualMap';
import { solveGeometry } from './imposerEngine/GeometricSolver';
import { renderBooklet } from './imposerEngine/Renderer';
import { renderNup } from './imposerEngine/NupRenderer';
import { getSpreadPatternById, getExactPatternForPageCount } from './imposerEngine/FoldPatterns';
import { placeSpreadsByFoldPattern } from './imposerEngine/SpreadPlacer';
import { serializeBookletPlan } from './imposerEngine/InstructionSerializer';
import type { InstructionSet } from './imposerEngine/InstructionSerializer';
import { getFileArrayBuffer } from './utils';

export const MM_TO_POINTS = 2.83465;

import { ImpositionMode } from './imposerEngine/SettingsTypes';
import type { ProcessingSettings, BaseSettings, GuillotineSettings, DieCutSettings, OffsetSettings } from './imposerEngine/SettingsTypes';
import { tv } from '../i18n';
import i18n from '../i18n';
export type { ProcessingSettings, BaseSettings, GuillotineSettings, DieCutSettings, OffsetSettings };
export { ImpositionMode };

const sanitizeNumber = (value: any, defaultValue = 0): number => {
    const num = Number(value);
    return isNaN(num) ? defaultValue : num;
};

const effectivePdfLibPageBox = (page: any) => {
    const media = page.getMediaBox?.() || page.getSize?.();
    const crop = page.getCropBox?.();
    if (!media || !crop || media.width <= 0 || media.height <= 0 || crop.width <= 0 || crop.height <= 0) {
        return media || crop;
    }
    const widthRatio = crop.width / media.width;
    const heightRatio = crop.height / media.height;
    const areaRatio = (crop.width * crop.height) / (media.width * media.height);
    return widthRatio < 0.80 || heightRatio < 0.80 || areaRatio < 0.75 ? crop : media;
};

export const imposePdf = async (
    pdfFile: File,
    settings: ProcessingSettings,
    setStatus: (message: string) => void
): Promise<{ blob: Blob; report: string }> => {
    // DEPRECATION NOTE (P2 - Phase 2): This local TS layout math path is being phased out in favor of
    // imposePdfViaBackend (Planner in TS + Executor in backend via imposition_core + pikepdf).
    // Client should be dumb assembler only. Prefer viaBackend for imposition modes.
    // See PR Plan prynx-imposition-unification-v1.
    console.warn('[DEPRECATED] Local imposePdf used for imposition - migrate to viaBackend for unified engine.');
    setStatus(i18n.t('lib.pdfImposer:dang_phan_tich_va_nap_tep_pdf'));
    const arrayBuffer = await getFileArrayBuffer(pdfFile);
    let reportMsg = '';

    const isEncryptionError = (err: any) => {
        const msg = String(err?.message || err || '').toLowerCase();
        return msg.includes('compression') || msg.includes('encrypt') || msg.includes('flate') 
            || msg.includes('stream') || msg.includes('unknown') || msg.includes('invalid');
    };

    const runPipeline = async (buffer: ArrayBuffer) => {
        const srcPdf = await PDFDocument.load(buffer, { ignoreEncryption: true });
        const outputPdf = await PDFDocument.create();
        
        // Copy metadata safely
        const propsToCopy = ['getTitle', 'getAuthor', 'getSubject', 'getKeywords', 'getCreator', 'getCreationDate'] as const;
        const propsToSet = ['setTitle', 'setAuthor', 'setSubject', 'setKeywords', 'setCreator', 'setCreationDate'] as const;
        propsToCopy.forEach((getter, index) => {
            try {
                const value = srcPdf[getter]();
                if (value) (outputPdf as any)[propsToSet[index]](value);
            } catch { /* Skip garbled/encrypted metadata fields */ }
        });
        outputPdf.setProducer('PrintSolutions.vn - Super Imposer V2');
        outputPdf.setModificationDate(new Date());

        const pageCount = srcPdf.getPageCount();
        const embeddedPages: any[] = [];
        const srcPageDetails: { visualW: number, visualH: number, angle: number, x: number, y: number }[] = [];
        let maxSrcPageWidth = 0;
        let maxSrcPageHeight = 0;

        const srcPagesTemp = srcPdf.getPages();
        const orderedIndices = settings.pageOrder 
            ? settings.pageOrder.map(n => n === -1 ? -1 : n - 1) 
            : Array.from({length: pageCount}, (_, i) => i);

        for (let i = 0; i < orderedIndices.length; i++) {
            const pOriginalIndex = orderedIndices[i];
            if (pOriginalIndex === -1) {
                embeddedPages.push(null);
                srcPageDetails.push({ visualW: 0, visualH: 0, angle: 0, x: 0, y: 0 });
                continue;
            }

            const p = srcPagesTemp[pOriginalIndex];

            let angle = p.getRotation()?.angle || 0;
            // pageRotations là number[] THEO VỊ TRÍ (out[i] = góc trang ở vị trí i trong
            // pageOrder) → tra theo i, KHÔNG theo số trang gốc. Nhờ vậy 2 bản nhân bản cùng
            // số trang gốc nhưng khác vị trí nhận góc RIÊNG (per-instance rotation 2026-07-06).
            if (settings.pageRotations && settings.pageRotations[i]) {
                angle += settings.pageRotations[i];
            }
            
            // Giữ MediaBox cho bleed nhỏ; dùng CropBox khi MediaBox là canvas lớn
            // chứa nhiều trang logic đặt cạnh nhau.
            const { x, y, width, height } = effectivePdfLibPageBox(p);
            const ep = await outputPdf.embedPage(p, { left: x, bottom: y, right: x + width, top: y + height });
            embeddedPages.push(ep);

            const visualW = (angle % 180 !== 0) ? ep.height : ep.width;
            const visualH = (angle % 180 !== 0) ? ep.width : ep.height;
            srcPageDetails.push({ visualW, visualH, angle, x, y });
            
            if (visualW > maxSrcPageWidth) maxSrcPageWidth = visualW;
            if (visualH > maxSrcPageHeight) maxSrcPageHeight = visualH;
        }

        // Detect mixed page sizes — cảnh báo trang không đồng kích thước
        const sizeMap = new Map<string, number>();
        for (const d of srcPageDetails) {
            if (d.visualW === 0 && d.visualH === 0) continue; // blank
            const key = `${Math.round(d.visualW / 2.83465)}×${Math.round(d.visualH / 2.83465)}mm`;
            sizeMap.set(key, (sizeMap.get(key) || 0) + 1);
        }
        if (sizeMap.size > 1) {
            const sizeList = Array.from(sizeMap.entries()).map(([size, count]) => `  • ${size} ${i18n.t('lib.pdfImposer:count_trang_paren', { count })}`).join('\n');
            reportMsg += i18n.t('lib.pdfImposer:trang_khong_dong_kich_thuoc_n_sizelist', { sizeList });
        }

        let thicknessInput = sanitizeNumber(settings.paperThickness);
        if (thicknessInput > 10) thicknessInput = thicknessInput / 1000;
        const paperThickness = thicknessInput * MM_TO_POINTS;
        const bleed = sanitizeNumber(settings.bleed) * MM_TO_POINTS;
        const gutterPt = sanitizeNumber((settings as any).gutterMargin) * MM_TO_POINTS;
        let reqSheetW = sanitizeNumber(settings.sheetWidth);
        let reqSheetH = sanitizeNumber(settings.sheetHeight);

        // ĐỂ NGUYÊN KHỔ GIẤY DO NGƯỜI DÙNG NHẬP, KHÔNG TỰ ĐỘNG XOAY.
        // Vì SheetOptimizer đã tính toán fit trên khổ gốc (hoặc xoay).
        // Nếu tự động xoay ở đây, nó sẽ làm hỏng grid nếu grid chỉ vừa ở dạng Portrait.
        // (Offset printers usually want Landscape, but if it only fits Portrait, we must use Portrait).
        
        if (settings.impositionMode === ImpositionMode.NUp) {
            await renderNup(
                orderedIndices.length, embeddedPages, srcPageDetails, maxSrcPageWidth, maxSrcPageHeight,
                reqSheetW * MM_TO_POINTS, reqSheetH * MM_TO_POINTS, settings, outputPdf, setStatus
            );
        } else {
            // Cover separation: tách bìa ra khỏi phần bình ruột
            let coverIndices: number[] = [];
            let bodyOrderedIndices = orderedIndices;
            
            const wantSeparateCover = (settings as any).separateCover;
            const coverCount = (settings as any).coverPageCount || 4;
            if (wantSeparateCover && orderedIndices.length >= coverCount + 4) {
                const half = Math.floor(coverCount / 2);
                // Trang bìa: half đầu + half cuối
                const frontCover = orderedIndices.slice(0, half);
                const backCover = orderedIndices.slice(-half);
                coverIndices = [...frontCover, ...backCover];
                bodyOrderedIndices = orderedIndices.slice(half, orderedIndices.length - half);
                reportMsg += i18n.t('lib.pdfImposer:tach_bia_coverindices_length_trang_bia', { coverCount: coverIndices.length, bodyCount: bodyOrderedIndices.length });
            } else if (wantSeparateCover) {
                reportMsg += i18n.t('lib.pdfImposer:da_bo_qua_tach_bia_rieng_sach_can_toi', { coverCount, minPages: coverCount + 4, curPages: orderedIndices.length });
            }

            setStatus(i18n.t('lib.pdfImposer:giai_doan_1_dang_thiet_lap_so_do_trang'));
            const bMode = (settings as any).bindingMode || 'saddle';
            const orderedLen = bodyOrderedIndices.length;
            const mapResult = generateBindingMap(orderedLen, bMode, (settings as any).foliosize, (settings as any).blankPlacement || 'end');
            const virtualMap = mapResult.sheets;
            if (mapResult.report) reportMsg += (reportMsg ? '\n' : '') + mapResult.report;

            setStatus(i18n.t('lib.pdfImposer:giai_doan_2_dang_tinh_toan_kich_thuoc'));
            const pseudoSettings = {
                formsize: (reqSheetW === 0 || (settings as any).chainNup) ? 'auto_100' : 'custom',
                customSheetWidth: reqSheetW,
                customSheetHeight: reqSheetH,
                bleed: settings.bleed,
                signatureMode: bMode
            } as any;
            
            const geoContext = solveGeometry(maxSrcPageWidth, maxSrcPageHeight, pseudoSettings, {}, MM_TO_POINTS);

            // Cảnh báo tràn khổ: khổ giấy chọn nhỏ hơn khổ trải trang → nội dung sẽ bị cắt mép.
            if (geoContext.needsScaleDown) {
                const pct = Math.round(geoContext.suggestedScaleFactor * 100);
                reportMsg += (reportMsg ? '\n' : '') + i18n.t('lib.pdfImposer:kho_giay_nho_hon_kho_trai_trang_noi', { pct });
            }

            const isSaddleOrThread = bMode === 'saddle' || bMode === 'thread';
            
            if ((settings as any).chainNup) {
                setStatus(i18n.t('lib.pdfImposer:giai_doan_3_dang_sap_xep_du_lieu'));
                const tempPdf = await PDFDocument.create();

                setStatus(i18n.t('lib.pdfImposer:dang_tai_du_lieu_hinh_anh'));
                const tempEmbeddedPages = [];
                for (let i = 0; i < orderedIndices.length; i++) {
                    const pOriginalIndex = orderedIndices[i];
                    if (pOriginalIndex === -1) {
                        tempEmbeddedPages.push(null);
                        continue;
                    }
                    const p = srcPagesTemp[pOriginalIndex];
                    // Dùng cùng quy tắc effective box với backend.
                    const { x, y, width, height } = effectivePdfLibPageBox(p);
                    const ep = await tempPdf.embedPage(p, { left: x, bottom: y, right: x + width, top: y + height });
                    tempEmbeddedPages.push(ep);
                }

                // Offset: disable creep (paperThickness=0) — signatures are die-cut after folding,
                // so creep compensation would cause misaligned fold axes between signatures on the same press sheet.
                await renderBooklet(
                    virtualMap, tempEmbeddedPages, srcPageDetails, geoContext, tempPdf,
                    bleed, 0, isSaddleOrThread, 'none', settings.interleave || 'normal', setStatus, settings as any, gutterPt
                );
                
                setStatus(i18n.t('lib.pdfImposer:giai_doan_4_dang_xu_ly_hinh_anh_va_do'));
                const tempBytes = await tempPdf.save();
                const tempSrcPdf = await PDFDocument.load(tempBytes, { ignoreEncryption: true });
                const tempPages = tempSrcPdf.getPages();
                
                const chainEmbeddedPages = [];
                setStatus(i18n.t('lib.pdfImposer:giai_doan_5_dang_nap_trang_vao_khuon'));
                for (let i=0; i<tempPages.length; i++) {
                    const ep = await outputPdf.embedPage(tempPages[i]);
                    chainEmbeddedPages.push(ep);
                }
                
                const cw = geoContext.finalSheetWidth;
                const ch = geoContext.finalSheetHeight;
                const chainSourceDetails = tempPages.map(() => ({ visualW: cw, visualH: ch, angle: 0, x: 0, y: 0 }));

                // Route: Fold Pattern → SpreadPlacer, otherwise → NupRenderer
                const allowFoldPattern = (settings as any).paperClassification === 'offset'
                    || (settings as any).imposerMode === 'offset';
                let foldPattern = allowFoldPattern && (settings as any).foldPattern && (settings as any).foldPattern !== 'auto'
                    ? getSpreadPatternById((settings as any).foldPattern)
                    : null;
                
                // Auto-detect: pick best pattern based on signature page count
                if (allowFoldPattern && (settings as any).foldPattern === 'auto' && virtualMap.length > 0) {
                    // Detect pages per signature from the first sig
                    const firstSigSheets = virtualMap[0].sigTotalSheets ?? virtualMap.length;
                    const pagesPerSig = firstSigSheets * 4;
                    foldPattern = getExactPatternForPageCount(pagesPerSig) ?? null;
                    if (foldPattern) {
                        setStatus(i18n.t('lib.pdfImposer:auto_detect_chon_so_do_foldpattern_name', { name: foldPattern.name, pagesPerSig }));
                        if (foldPattern.pagesPerSig !== pagesPerSig) {
                            reportMsg += (reportMsg ? '\n' : '') + i18n.t('lib.pdfImposer:tay_sach_pagespersig_trang_khong_co_so', { pagesPerSig, name: foldPattern.name, patternPages: foldPattern.pagesPerSig });
                        }
                    }
                }
                if (foldPattern) {
                    setStatus(i18n.t('lib.pdfImposer:giai_doan_6_dang_xep_trang_len_kho_in'));
                    const spreadDetails = chainEmbeddedPages.map(ep => ({ width: ep.width, height: ep.height }));
                    const spreadReport = await placeSpreadsByFoldPattern(
                        chainEmbeddedPages, spreadDetails, foldPattern,
                        reqSheetW * MM_TO_POINTS, reqSheetH * MM_TO_POINTS,
                        outputPdf, settings as any, setStatus
                    );
                    if (spreadReport) reportMsg += (reportMsg ? '\n' : '') + spreadReport;
                } else {
                    // Phase 2: Place booklet spreads onto the final sheet via NupRenderer.
                    // Two modes:
                    //   - Step & Repeat (chain_nup): duplicate same spread → cut → multiple booklets
                    //   - Cut & Stack (cut_stack): pair different sheets → cut & stack → 1 booklet
                    const chainNupSettings: ProcessingSettings = {
                        ...settings,
                        layoutType: (settings as any).cutStack ? 'cut_stacks' : 'repeat',
                        duplexFlow: (settings as any).cutStack ? 'double' : 'normal',
                    } as any;
                    setStatus((settings as any).cutStack
                        ? i18n.t('lib.pdfImposer:giai_doan_6_dang_ghep_to_booklet_xen')
                        : i18n.t('lib.pdfImposer:giai_doan_6_dang_nhan_ban_trang_in_step')
                    );
                    await renderNup(
                        tempPages.length, chainEmbeddedPages, chainSourceDetails, cw, ch,
                        reqSheetW * MM_TO_POINTS, reqSheetH * MM_TO_POINTS,
                        chainNupSettings, outputPdf, setStatus
                    );
                }
            } else {
                await renderBooklet(
                    virtualMap, embeddedPages, srcPageDetails, geoContext, outputPdf,
                    bleed, paperThickness, isSaddleOrThread, (settings as any).markType, settings.interleave || 'normal', setStatus, settings as any, gutterPt
                );
            }

            // Append cover pages as raw pages at end of output
            if (coverIndices.length > 0) {
                setStatus(i18n.t('lib.pdfImposer:dang_them_coverindices_length_trang_bia', { count: coverIndices.length }));
                for (const idx of coverIndices) {
                    if (idx === -1) continue;
                    const [copiedPage] = await outputPdf.copyPages(srcPdf, [idx]);
                    outputPdf.addPage(copiedPage);
                }
            }
        }

        setStatus(i18n.t('lib.pdfImposer:don_dep_bo_nho_va_dong_tep_pdf'));
        const pdfBytes = await outputPdf.save(); // THIS is where lazy flate decoding fails!
        return { 
            blob: new Blob([pdfBytes as any], { type: 'application/pdf' }), 
            report: reportMsg 
        };
    };

    const decryptPdfViaBackend = async (buffer: ArrayBuffer, setStatus: (msg: string) => void): Promise<ArrayBuffer> => {
        setStatus(i18n.t('lib.pdfImposer:phat_hien_pdf_bi_khoa_dang_giai_ma_tap'));
        const formData = new FormData();
        const blob = new Blob([buffer], { type: 'application/pdf' });
        formData.append('file', blob, 'encrypted.pdf');

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout
            
            const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8321';
            const response = await fetch(`${API_BASE}/api/imposition/unlock-pdf`, {
                method: 'POST',
                body: formData,
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(i18n.t('lib.pdfImposer:loi_tu_backend_response_status', { status: response.status, errorText }));
            }

            setStatus(i18n.t('lib.pdfImposer:giai_ma_thanh_cong_dang_nap_lai_tai'));
            return await response.arrayBuffer();
        } catch (e: any) {
            if (e.name === 'AbortError') {
                throw new Error(tv('Hệ thống giải mã không phản hồi sau 30 giây (Vui lòng thử lại sau).'));
            }
            throw new Error(i18n.t('lib.pdfImposer:xu_ly_tap_tin_that_bai_e_message', { message: e.message }));
        }
    };

    try {
        setStatus(i18n.t('lib.pdfImposer:dang_tai_va_xu_ly_khung_pdf_vao'));
        return await runPipeline(arrayBuffer);
    } catch (err: any) {
        console.error("Pipeline failed:", err);
        if (isEncryptionError(err)) {
            try {
                const cleanBuffer = await decryptPdfViaBackend(arrayBuffer, setStatus);
                return await runPipeline(cleanBuffer);
            } catch (decryptErr: any) {
                console.error("Backend Decryption failed:", decryptErr);
                throw new Error(i18n.t('lib.pdfImposer:loi_giai_ma') + ' ' + (decryptErr.message || decryptErr));
            }
        } else {
            throw new Error(i18n.t('lib.pdfImposer:loi_boc_tach_pdf') + ' ' + (err.message || err));
        }
    }
};

// =========================================================================
//  Catalog Batch Imposition
//  Nhận file PDF gốc + PlateJob[] từ CatalogPlanner
//  Lặp qua từng job, trích trang, chạy pipeline, trả về mảng kết quả.
// =========================================================================

export interface CatalogBatchResult {
    blob: Blob;
    filename: string;
    label: string;
    report: string;
    jobId: string;
}

export const imposeCatalogBatch = async (
    pdfFile: File,
    jobs: PlateJob[],
    baseSettings: Partial<ProcessingSettings>,
    setStatus: (message: string) => void
): Promise<CatalogBatchResult[]> => {
    const results: CatalogBatchResult[] = [];
    const srcBuffer = await getFileArrayBuffer(pdfFile);
    const srcPdf = await PDFDocument.load(srcBuffer, { ignoreEncryption: true });
    
    setStatus(i18n.t('lib.pdfImposer:bat_dau_xu_ly_jobs_length_tam_kem', { count: jobs.length }));

    for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        setStatus(i18n.t('lib.pdfImposer:dang_xu_ly_kem_i_1_jobs_length_job', { current: i + 1, total: jobs.length, label: job.label }));

        // Bước 1: Tạo sub-PDF chỉ chứa các trang của job này
        const subPdf = await PDFDocument.create();
        for (const pageIdx of job.pageIndices) {
            if (pageIdx === -1 || pageIdx < 0 || pageIdx >= srcPdf.getPageCount()) {
                // Trang trắng (padding) — thêm trang trống có kích thước bằng trang đầu tiên
                const firstReal = job.pageIndices.find(idx => idx >= 0 && idx < srcPdf.getPageCount());
                if (firstReal !== undefined) {
                    const refPage = srcPdf.getPages()[firstReal];
                    const { width, height } = refPage.getSize();
                    subPdf.addPage([width, height]);
                } else {
                    subPdf.addPage([595.28, 841.89]); // Default A4
                }
            } else {
                const [copiedPage] = await subPdf.copyPages(srcPdf, [pageIdx]);
                subPdf.addPage(copiedPage);
            }
        }

        const subPdfBytes = await subPdf.save();
        const subFile = new File(
            [subPdfBytes as any],
            `sub_${job.id}.pdf`,
            { type: 'application/pdf' }
        );

        // Bước 2: Chuẩn bị settings riêng cho job này
        const jobSettings: ProcessingSettings = {
            impositionMode: ImpositionMode.Booklet,
            bindingMode: job.bindingMode === 'saddle' ? 'saddle' : 'thread',
            foliosize: job.pageIndices.length, // Tổng trang của tay này
            paperThickness: baseSettings.paperThickness || 0,
            bleed: baseSettings.bleed || 0,
            sheetWidth: baseSettings.sheetWidth || 0,
            sheetHeight: baseSettings.sheetHeight || 0,
            chainNup: true, // Luôn dùng chain_nup cho offset catalog
            markType: (baseSettings as any).markType,
            markOffset: (baseSettings as any).markOffset,
            markLength: (baseSettings as any).markLength,
            markThickness: (baseSettings as any).markThickness,
            markStyle: (baseSettings as any).markStyle,
            interleave: 'normal',
            foldPattern: job.foldPatternId,
            isCover: job.isCover,
            gripperMargin: (baseSettings as any).gripperMargin,
            marginTop: baseSettings.marginTop,
            marginBottom: baseSettings.marginBottom,
            marginLeft: baseSettings.marginLeft,
            marginRight: baseSettings.marginRight,
            marginMode: baseSettings.marginMode,
            gapX: baseSettings.gapX,
            gapY: baseSettings.gapY,
            spreadDistribution: (baseSettings as any).spreadDistribution || 'clustered',
            paperClassification: (baseSettings as any).paperClassification || 'in_nhanh'
        } as any;

        // Bước 3: Chạy pipeline
        try {
            const result = await imposePdf(subFile, jobSettings, (msg) => {
                setStatus(i18n.t('lib.pdfImposer:kem_i_1_jobs_length_msg', { current: i + 1, total: jobs.length, msg }));
            });

            results.push({
                blob: result.blob,
                filename: job.filename,
                label: job.label,
                report: result.report,
                jobId: job.id,
            });
        } catch (err: any) {
            console.error(`Job ${job.id} failed:`, err);
            results.push({
                blob: new Blob(),
                filename: job.filename,
                label: i18n.t('lib.pdfImposer:job_label_loi_err_message', { label: job.label, message: err.message }),
                report: i18n.t('lib.pdfImposer:loi_err_message', { message: err.message }),
                jobId: job.id,
            });
        }
    }

    const successCount = results.filter(r => r.blob.size > 0).length;
    setStatus(i18n.t('lib.pdfImposer:hoan_tat_results_filter_r_r_blob_size_0', { done: successCount, total: jobs.length }));
    return results;
};

// =========================================================================
//  SMART AUTO-ROUTING
//
//  Tự động chọn Client Mode (pdf-lib) hoặc Backend Mode (pypdfium2)
//  dựa trên DUNG LƯỢNG FILE (byte), không phải số trang.
//
//  Ví dụ:
//    - File 200 trang toàn text (2MB) → Client Mode (nhanh, không cần Backend)
//    - File 2 trang ảnh 300DPI (500MB) → Backend Mode (tránh tràn RAM Webview)
// =========================================================================

// =========================================================================
//  BACKEND-OFFLOADED IMPOSITION (Planner → Executor Architecture)
//
//  imposePdfViaBackend():
//    TypeScript chỉ tính toán tọa độ (Planner), xuất JSON Instruction Set
//    (~5KB), rồi gửi cho Backend Python (pypdfium2) thực thi.
//    RAM Webview: ~20-50MB thay vì 500MB-2GB.
//
//  imposeCatalogBatchViaBackend():
//    Lặp qua từng PlateJob, gọi imposePdfViaBackend() cho mỗi kẽm,
//    ghi file output xuống ổ cứng qua Tauri FS API, dọn RAM sau mỗi vòng.
// =========================================================================

const BACKEND_API = import.meta.env.VITE_API_URL || 'http://localhost:8321';

/**
 * Booklet imposition via Backend (Planner → Executor).
 * 
 * Chỉ chạy Planner modules (VirtualMap, GeometricSolver, FoldPatterns)
 * để tính toán tọa độ, rồi đẩy JSON cho Backend Python thực thi.
 * 
 * File PDF gốc KHÔNG được nạp vào RAM của Webview.
 * Backend dùng pypdfium2 (memory-mapped I/O) để đọc file trực tiếp từ ổ cứng.
 */
export const imposePdfViaBackend = async (
    sourcePdfPath: string,
    settings: ProcessingSettings,
    setStatus: (message: string) => void,
    outputDir?: string,
): Promise<{ outputPath: string; report: string; blob: Blob }> => {

    setStatus(i18n.t('lib.pdfImposer:dang_tinh_toan_so_do_binh_trang'));

    // Defense-in-depth: không cho knob Offset ẩn rò vào job Digital.
    const isOffsetBooklet = (settings as any).paperClassification === 'offset'
        || (settings as any).imposerMode === 'offset';
    settings = {
        ...settings,
        paperClassification: isOffsetBooklet ? 'offset' : 'in_nhanh',
        foldPattern: isOffsetBooklet ? (settings as any).foldPattern : undefined,
        gripperMargin: isOffsetBooklet ? (settings as any).gripperMargin : 0,
        interleave: !isOffsetBooklet || (settings as any).foldPattern ? 'normal' : (settings.interleave || 'normal'),
    } as ProcessingSettings;

    // ──── STEP 1: Đọc metadata cơ bản từ file (chỉ lấy số trang + kích thước) ────
    // Gọi Backend API để lấy thông tin file mà không cần nạp file vào Webview
    const metaRes = await fetch(`${BACKEND_API}/api/imposition/pdf-meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: sourcePdfPath }),
    }).catch(() => null);

    let pageCount = 0;
    let maxSrcW = 595.28;  // Default A4
    let maxSrcH = 841.89;
    const srcPageDetails: { visualW: number; visualH: number; angle: number }[] = [];

    if (metaRes && metaRes.ok) {
        const meta = await metaRes.json();
        pageCount = meta.page_count || 0;
        maxSrcW = meta.max_width_pt || maxSrcW;
        maxSrcH = meta.max_height_pt || maxSrcH;
        for (const pg of (meta.pages || [])) {
            srcPageDetails.push({
                visualW: pg.width_pt,
                visualH: pg.height_pt,
                angle: pg.rotation || 0,
            });
        }
    } else {
        // Fallback: nạp nhẹ bằng pdf-lib chỉ để lấy metadata (không embed)
        setStatus(i18n.t('lib.pdfImposer:dang_trich_xuat_du_lieu_tap_tin'));
        const buffer = await (await fetch(sourcePdfPath)).arrayBuffer();
        const srcPdf = await PDFDocument.load(buffer, { ignoreEncryption: true });
        pageCount = srcPdf.getPageCount();
        const pages = srcPdf.getPages();
        for (const p of pages) {
            // Dùng cùng quy tắc effective box với backend.
            const { width, height } = effectivePdfLibPageBox(p);
            const angle = p.getRotation()?.angle || 0;
            const vw = (angle % 180 !== 0) ? height : width;
            const vh = (angle % 180 !== 0) ? width : height;
            srcPageDetails.push({ visualW: vw, visualH: vh, angle });
            if (vw > maxSrcW) maxSrcW = vw;
            if (vh > maxSrcH) maxSrcH = vh;
        }
    }

    if (pageCount === 0) {
        throw new Error(tv('File PDF không có trang nào.'));
    }

    // ──── STEP 2: Chạy Planner modules (thuần toán, 0 byte PDF trong RAM) ────
    setStatus(i18n.t('lib.pdfImposer:dang_thiet_lap_so_do_trang'));
            const bMode = (settings as any).bindingMode || 'saddle';
    // pageOrder (thứ tự trang do người dùng sắp trong viewer, 1-based; -1 = trang trắng
    // đã chèn) là NGUỒN SỰ THẬT — GIỐNG HỆT "Xem Bài In" (SheetViewer dùng pageOrder.length).
    // Trước đây nhánh này dựng map từ pageCount THÔ của file gốc → generateBindingMap tự pad
    // + tự nhét trang trắng ở CUỐI, BỎ QUA trang trắng người dùng chèn giữa sách → trang
    // trắng rơi nhầm mặt (vd cùng mặt trang 1). Nay map theo pageOrder rồi remap srcIndex
    // (index logic vào pageOrder) → index TRANG THẬT trong file gốc, hoặc null nếu là slot
    // trắng. source_page/backend giữ nguyên; slot null được backend skip (fix trang trắng
    // lệch mặt 2026-07-07).
    const pageOrder: number[] = Array.isArray((settings as any).pageOrder)
        ? [...(settings as any).pageOrder]
        : Array.from({ length: pageCount }, (_, i) => i + 1);
    const pageRotations: number[] = Array.isArray((settings as any).pageRotations)
        ? [...(settings as any).pageRotations]
        : Array.from({ length: pageOrder.length }, () => 0);

    // Tách bìa trong chính pipeline backend đang hoạt động.
    let bodyOrder = pageOrder;
    let bodyRotations = pageRotations;
    const appendSourcePages: { source_page: number; rotation_deg?: number }[] = [];
    let separatedCoverCount = 0;
    const wantSeparateCover = !!(settings as any).separateCover;
    const coverCount = Math.max(2, Number((settings as any).coverPageCount) || 4);
    if (wantSeparateCover && pageOrder.length >= coverCount + 4) {
        const half = Math.floor(coverCount / 2);
        const coverPositions = [
            ...Array.from({ length: half }, (_, i) => i),
            ...Array.from({ length: half }, (_, i) => pageOrder.length - half + i),
        ];
        for (const pos of coverPositions) {
            const sourcePage = pageOrder[pos];
            if (sourcePage > 0) {
                appendSourcePages.push({ source_page: sourcePage - 1, rotation_deg: pageRotations[pos] || 0 });
            }
        }
        bodyOrder = pageOrder.slice(half, pageOrder.length - half);
        bodyRotations = pageRotations.slice(half, pageRotations.length - half);
        separatedCoverCount = appendSourcePages.length;
    }

    const effectiveCount = bodyOrder.length;
    const mapResult = generateBindingMap(effectiveCount, bMode, (settings as any).foliosize, (settings as any).blankPlacement || 'end');
    const virtualMap = mapResult.sheets;
    const remapSlot = (slot: { srcIndex: number | null; userRotation?: number }) => {
        if (slot.srcIndex === null) return;
        const orderIndex = slot.srcIndex;
        const realPage = bodyOrder[orderIndex];
        slot.userRotation = bodyRotations[orderIndex] || 0;
        slot.srcIndex = (realPage == null || realPage === -1) ? null : realPage - 1;
    };
    for (const sheet of virtualMap) {
        remapSlot(sheet.front.left); remapSlot(sheet.front.right);
        remapSlot(sheet.back.left); remapSlot(sheet.back.right);
    }
    let report = mapResult.report;
    if (separatedCoverCount > 0) {
        report += (report ? '\n' : '') + `Đã tách ${separatedCoverCount} trang bìa; bình ${bodyOrder.length} trang ruột.`;
    }

    // Chỉ dùng kích thước các trang thực sự nằm trong ruột, kể cả góc xoay riêng.
    let selectedMaxW = 0;
    let selectedMaxH = 0;
    for (let i = 0; i < bodyOrder.length; i++) {
        const sourcePage = bodyOrder[i];
        if (sourcePage <= 0) continue;
        const detail = srcPageDetails[sourcePage - 1];
        if (!detail) continue;
        const swapsAxes = Math.abs(bodyRotations[i] || 0) % 180 !== 0;
        const w = swapsAxes ? detail.visualH : detail.visualW;
        const h = swapsAxes ? detail.visualW : detail.visualH;
        selectedMaxW = Math.max(selectedMaxW, w);
        selectedMaxH = Math.max(selectedMaxH, h);
    }
    if (selectedMaxW > 0 && selectedMaxH > 0) {
        maxSrcW = selectedMaxW;
        maxSrcH = selectedMaxH;
    }

    setStatus(i18n.t('lib.pdfImposer:dang_tinh_toan_kich_thuoc_tu_dong'));
    let reqSheetW = sanitizeNumber(settings.sheetWidth);
    let reqSheetH = sanitizeNumber(settings.sheetHeight);

    // ĐỂ NGUYÊN KHỔ GIẤY DO NGƯỜI DÙNG NHẬP, KHÔNG TỰ ĐỘNG XOAY.
    // Vì SheetOptimizer đã tính toán fit trên khổ gốc (hoặc xoay).
    // Nếu tự động xoay ở đây, nó sẽ làm hỏng grid nếu grid chỉ vừa ở dạng Portrait.
    // (Offset printers usually want Landscape, but if it only fits Portrait, we must use Portrait).
    // Phase-2 (chain_nup / fold pattern): phase-1 PHẢI dựng spread ở khung auto_100
    // (khổ = 1 spread) rồi serializer sắp nhiều spread lên khổ kẽm lớn ở phase-2.
    const _fp = (settings as any).foldPattern;
    const _phase2 = !!(settings as any).chainNup || (!!_fp && _fp !== '');

    // ── Booklet 1-up (non-phase2): chọn HƯỚNG KHỔ GIẤY cho vừa spread (xoay KHỔ,
    // KHÔNG xoay nội dung — 2 trang luôn đứng đọc được). Hai chế độ:
    //   • 'fit' : BÓP nội dung cho vừa khổ (thu nhỏ nếu lớn hơn), canh giữa.
    //   • '100' : GIỮ NGUYÊN 100%. Nếu không vừa (kể cả xoay khổ) → CẢNH BÁO, không co.
    const _scaleMode = (settings as any).scaleMode || '100';
    if (!_phase2 && reqSheetW > 0 && reqSheetH > 0) {
        const spreadWmm = (maxSrcW * 2) / MM_TO_POINTS;
        const spreadHmm = maxSrcH / MM_TO_POINTS;
        const scaleAsIs = Math.min(reqSheetW / spreadWmm, reqSheetH / spreadHmm);
        const scaleRot = Math.min(reqSheetH / spreadWmm, reqSheetW / spreadHmm);
        const fitsAsIs = scaleAsIs >= 1 - 0.001;
        const fitsRot = scaleRot >= 1 - 0.001;
        if (fitsAsIs) {
            // vừa 100% ở hướng hiện tại → giữ nguyên, không xoay khổ.
        } else if (fitsRot) {
            const t = reqSheetW; reqSheetW = reqSheetH; reqSheetH = t; // xoay khổ để vừa 100%
        } else {
            // Không hướng nào vừa ở 100%.
            if (_scaleMode === 'fit') {
                if (scaleRot > scaleAsIs) { const t = reqSheetW; reqSheetW = reqSheetH; reqSheetH = t; } // chọn hướng ít phải co hơn
            } else {
                const warn = i18n.t('lib.pdfImposer:trang_trai_khong_vua_kho_100', { spreadW: Math.round(spreadWmm), spreadH: Math.round(spreadHmm), sheetW: Math.round(reqSheetW), sheetH: Math.round(reqSheetH) });
                report = report ? `${report}\n${warn}` : warn;
            }
        }
    }

    const pseudoSettings = {
        formsize: (reqSheetW === 0 || _phase2) ? 'auto_100' : 'custom',
        customSheetWidth: reqSheetW,
        customSheetHeight: reqSheetH,
        bleed: settings.bleed,
        signatureMode: bMode,
    } as any;

    const geoContext = solveGeometry(maxSrcW, maxSrcH, pseudoSettings, {}, MM_TO_POINTS);
    const isSaddleOrThread = bMode === 'saddle' || bMode === 'thread';

    // Không xoay nội dung: spread đặt bình thường (2 trang đứng cạnh nhau) trên khổ
    // giấy ĐÃ chọn hướng ở trên. (Tránh hẳn applyGridRotation lỗi cũ.)
    if (!_phase2) {
        geoContext.isRotated = false;
        // 'fit': BÓP nội dung cho vừa khổ (chỉ thu nhỏ, không phóng to). '100' giữ nguyên.
        if (_scaleMode === 'fit' && geoContext.suggestedScaleFactor < 1) {
            const sf = geoContext.suggestedScaleFactor;
            geoContext.scaleFactor = sf;
            geoContext.actualDrawnWidth = maxSrcW * sf;
            geoContext.actualDrawnHeight = maxSrcH * sf;
        }
    }

    let thicknessInput = sanitizeNumber(settings.paperThickness);
    if (thicknessInput > 10) thicknessInput = thicknessInput / 1000;
    const paperThicknessPt = thicknessInput * MM_TO_POINTS;
    const bleedPt = sanitizeNumber(settings.bleed) * MM_TO_POINTS;

    // ──── STEP 3: Serialize thành JSON Instruction Set (~5KB) ────
    setStatus(i18n.t('lib.pdfImposer:dang_xuat_thong_so_ky_thuat'));
    const instructionSet = serializeBookletPlan(
        virtualMap,
        srcPageDetails,
        geoContext,
        bleedPt,
        paperThicknessPt,
        isSaddleOrThread,
        (settings as any).markType || 'none',
        settings.interleave || 'normal',
        settings,
        sourcePdfPath,
        outputDir || 'results',
        pageCount,
        appendSourcePages,
    );

    if ((settings as any).foldPattern && instructionSet.phase2?.mode !== 'fold_pattern') {
        const warn = `Sơ đồ gấp ${(settings as any).foldPattern} không khớp toàn bộ tay sách; đã chuyển sang Step & Repeat an toàn.`;
        report += (report ? '\n' : '') + warn;
    }


    // ──── STEP 4: Gửi JSON cho Backend Python thực thi ────
    setStatus(i18n.t('lib.pdfImposer:dang_gui_ke_hoach_xu_ly'));
    const response = await fetch(`${BACKEND_API}/api/imposition/execute-plan-json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            plan: instructionSet,
            source_pdf_path: sourcePdfPath,
        }),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(i18n.t('lib.pdfImposer:he_thong_xu_ly_that_bai_response_status', { status: response.status, errText }));
    }

    // ──── STEP 5: Nhận file output ────
    const outputBlob = await response.blob();
    // Backend đặt tên file UNIQUE (audit #C1) → KHÔNG suy đường dẫn theo tên cố định.
    // `outputBlob` (nội dung trả về) mới là nguồn chuẩn; outputPath chỉ còn mang tính
    // thông tin (output_dir). Caller hiện dùng blob/report, không đọc lại theo path.
    const outputPath = instructionSet.output_dir || 'results';

    setStatus(i18n.t('lib.pdfImposer:hoan_tat_file_kem_da_duoc_xuat_thanh'));
    return { outputPath, report, blob: outputBlob };
};

/**
 * Catalog Batch Imposition via Backend (Planner → Executor).
 * 
 * Giống imposeCatalogBatch nhưng mỗi kẽm được xử lý bởi Backend.
 * Sau mỗi kẽm, file output được ghi xuống ổ cứng qua Tauri FS API
 * và RAM được giải phóng hoàn toàn.
 */
export const imposeCatalogBatchViaBackend = async (
    sourcePdfPath: string,
    jobs: PlateJob[],
    baseSettings: Partial<ProcessingSettings>,
    setStatus: (message: string) => void,
    outputDir: string,
): Promise<CatalogBatchResult[]> => {
    const results: CatalogBatchResult[] = [];

    setStatus(i18n.t('lib.pdfImposer:bat_dau_xu_ly_jobs_length_tam_kem', { count: jobs.length }));

    for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        const sheetSettings = { ...baseSettings } as any;
        setStatus(i18n.t('lib.pdfImposer:kem_i_1_jobs_length_job_label', { current: i + 1, total: jobs.length, label: job.label }));

        const jobSettings: ProcessingSettings = {
            impositionMode: ImpositionMode.Booklet,
            bindingMode: job.bindingMode === 'saddle' ? 'saddle' : 'thread',
            foliosize: job.pageIndices.length,
            paperThickness: baseSettings.paperThickness || 0,
            bleed: baseSettings.bleed || 0,
            paperClassification: (sheetSettings as any).paperClassification || 'in_nhanh',
            sheetWidth: baseSettings.sheetWidth || 0,
            sheetHeight: baseSettings.sheetHeight || 0,
            chainNup: true,
            markType: (baseSettings as any).markType,
            markOffset: (baseSettings as any).markOffset,
            markLength: (baseSettings as any).markLength,
            markThickness: (baseSettings as any).markThickness,
            markStyle: (baseSettings as any).markStyle,
            interleave: 'normal',
            foldPattern: job.foldPatternId,
            isCover: job.isCover,
            gripperMargin: (baseSettings as any).gripperMargin,
            marginTop: baseSettings.marginTop,
            marginBottom: baseSettings.marginBottom,
            marginLeft: baseSettings.marginLeft,
            marginRight: baseSettings.marginRight,
            marginMode: baseSettings.marginMode,
            gapX: baseSettings.gapX,
            gapY: baseSettings.gapY,
            spreadDistribution: (baseSettings as any).spreadDistribution || 'clustered',
            pageOrder: job.pageIndices.map(idx => idx + 1), // Convert 0-based → 1-based
        } as any;

        try {
            const result = await imposePdfViaBackend(
                sourcePdfPath,
                jobSettings,
                (msg) => setStatus(i18n.t('lib.pdfImposer:kem_i_1_jobs_length_msg', { current: i + 1, total: jobs.length, msg })),
                outputDir,
            );

            results.push({
                blob: result.blob,
                filename: job.filename,
                label: job.label,
                report: result.report,
                jobId: job.id,
            });
        } catch (err: any) {
            console.error(`Job ${job.id} failed:`, err);
            results.push({
                blob: new Blob(),
                filename: job.filename,
                label: i18n.t('lib.pdfImposer:job_label_loi_err_message', { label: job.label, message: err.message }),
                report: i18n.t('lib.pdfImposer:loi_err_message', { message: err.message }),
                jobId: job.id,
            });
        }
    }

    setStatus(i18n.t('lib.pdfImposer:hoan_tat_results_filter_r_r_label', { done: results.filter(r => !r.label.startsWith('❌')).length, total: jobs.length }));
    return results;
};
