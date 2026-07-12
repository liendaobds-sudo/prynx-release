// src/lib/pdfImposer.ts
import { PDFDocument } from 'pdf-lib';
import type { PlateJob } from './imposerEngine/CatalogPlanner';
import { generateBindingMap } from './imposerEngine/VirtualMap';
import { solveGeometry } from './imposerEngine/GeometricSolver';
import { renderBooklet } from './imposerEngine/Renderer';
import { renderNup } from './imposerEngine/NupRenderer';
import { getSpreadPatternById, getPatternForPageCount } from './imposerEngine/FoldPatterns';
import { placeSpreadsByFoldPattern } from './imposerEngine/SpreadPlacer';
import { serializeBookletPlan } from './imposerEngine/InstructionSerializer';
import type { InstructionSet } from './imposerEngine/InstructionSerializer';
import { getFileArrayBuffer } from './utils';

export const MM_TO_POINTS = 2.83465;

import { ImpositionMode } from './imposerEngine/SettingsTypes';
import type { ProcessingSettings, BaseSettings, GuillotineSettings, DieCutSettings, OffsetSettings } from './imposerEngine/SettingsTypes';
import { tv } from '../i18n';
export type { ProcessingSettings, BaseSettings, GuillotineSettings, DieCutSettings, OffsetSettings };
export { ImpositionMode };

const sanitizeNumber = (value: any, defaultValue = 0): number => {
    const num = Number(value);
    return isNaN(num) ? defaultValue : num;
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
    setStatus('Đang phân tích và nạp tệp PDF...');
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
            
            // MediaBox-first (KHỚP backend pikepdf ép Box=MediaBox): bình theo TRANG VẬT LÝ.
            // CropBox-first sẽ cắt lề trắng khi trang có CropBox chặt hơn MediaBox (vd sau
            // auto-trim hoặc PDF vẽ CropBox ôm nội dung) → mất nền trắng, chỉ bình phần có mực.
            const { x, y, width, height } = p.getMediaBox() || p.getCropBox();
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
            const sizeList = Array.from(sizeMap.entries()).map(([size, count]) => `  • ${size} (${count} trang)`).join('\n');
            reportMsg += `⚠ Trang không đồng kích thước:\n${sizeList}\nBình sách sẽ dùng kích thước lớn nhất.\n`;
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
                reportMsg += `Tách bìa: ${coverIndices.length} trang bìa sẽ xuất riêng cuối file. Ruột: ${bodyOrderedIndices.length} trang.\n`;
            } else if (wantSeparateCover) {
                reportMsg += `⚠ Đã bỏ qua "Tách bìa riêng": sách cần tối thiểu ${coverCount + 4} trang để tách ${coverCount} trang bìa (hiện có ${orderedIndices.length}).\n`;
            }

            setStatus('Giai đoạn 1: Đang thiết lập sơ đồ trang...');
            const bMode = (settings as any).bindingMode || 'saddle';
            const orderedLen = bodyOrderedIndices.length;
            const mapResult = generateBindingMap(orderedLen, bMode, (settings as any).foliosize, (settings as any).blankPlacement || 'end');
            const virtualMap = mapResult.sheets;
            if (mapResult.report) reportMsg += (reportMsg ? '\n' : '') + mapResult.report;

            setStatus('Giai đoạn 2: Đang tính toán kích thước tự động...');
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
                reportMsg += (reportMsg ? '\n' : '') + `⚠ Khổ giấy nhỏ hơn khổ trải trang: nội dung sẽ bị tràn/cắt ở mép. Hãy chọn khổ lớn hơn hoặc thu nhỏ file còn ~${pct}%.`;
            }

            const isSaddleOrThread = bMode === 'saddle' || bMode === 'thread';
            
            if ((settings as any).chainNup) {
                setStatus('Giai đoạn 3: Đang sắp xếp dữ liệu...');
                const tempPdf = await PDFDocument.create();
                
                setStatus('Đang tải dữ liệu hình ảnh...');
                const tempEmbeddedPages = [];
                for (let i = 0; i < orderedIndices.length; i++) {
                    const pOriginalIndex = orderedIndices[i];
                    if (pOriginalIndex === -1) {
                        tempEmbeddedPages.push(null);
                        continue;
                    }
                    const p = srcPagesTemp[pOriginalIndex];
                    // MediaBox-first: giữ nguyên lề trắng (xem chú thích ở embed chính).
                    const { x, y, width, height } = p.getMediaBox() || p.getCropBox();
                    const ep = await tempPdf.embedPage(p, { left: x, bottom: y, right: x + width, top: y + height });
                    tempEmbeddedPages.push(ep);
                }

                // Offset: disable creep (paperThickness=0) — signatures are die-cut after folding,
                // so creep compensation would cause misaligned fold axes between signatures on the same press sheet.
                await renderBooklet(
                    virtualMap, tempEmbeddedPages, srcPageDetails, geoContext, tempPdf,
                    bleed, 0, isSaddleOrThread, 'none', settings.interleave || 'normal', setStatus, settings as any, gutterPt
                );
                
                setStatus('Giai đoạn 4: Đang xử lý hình ảnh và đồ hoạ...');
                const tempBytes = await tempPdf.save();
                const tempSrcPdf = await PDFDocument.load(tempBytes, { ignoreEncryption: true });
                const tempPages = tempSrcPdf.getPages();
                
                const chainEmbeddedPages = [];
                setStatus('Giai đoạn 5: Đang nạp trang vào khuôn...');
                for (let i=0; i<tempPages.length; i++) {
                    const ep = await outputPdf.embedPage(tempPages[i]);
                    chainEmbeddedPages.push(ep);
                }
                
                const cw = geoContext.finalSheetWidth;
                const ch = geoContext.finalSheetHeight;
                const chainSourceDetails = tempPages.map(() => ({ visualW: cw, visualH: ch, angle: 0, x: 0, y: 0 }));

                // Route: Fold Pattern → SpreadPlacer, otherwise → NupRenderer
                let foldPattern = (settings as any).foldPattern && (settings as any).foldPattern !== 'auto'
                    ? getSpreadPatternById((settings as any).foldPattern)
                    : null;
                
                // Auto-detect: pick best pattern based on signature page count
                if ((settings as any).foldPattern === 'auto' && virtualMap.length > 0) {
                    // Detect pages per signature from the first sig
                    const firstSigSheets = virtualMap[0].sigTotalSheets ?? virtualMap.length;
                    const pagesPerSig = firstSigSheets * 4;
                    foldPattern = getPatternForPageCount(pagesPerSig) ?? null;
                    if (foldPattern) {
                        setStatus(`Auto-detect: Chọn sơ đồ ${foldPattern.name} (${pagesPerSig} trang/tay)`);
                        if (foldPattern.pagesPerSig !== pagesPerSig) {
                            reportMsg += (reportMsg ? '\n' : '') + `⚠ Tay sách ${pagesPerSig} trang không có sơ đồ gấp khớp; tạm dùng "${foldPattern.name}" (${foldPattern.pagesPerSig} trang). Hãy chia tép theo bội số 4/8/16 để khớp sơ đồ.`;
                        }
                    }
                }
                if (foldPattern) {
                    setStatus('Giai đoạn 6: Đang xếp trang lên khổ in theo sơ đồ...');
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
                        ? 'Giai đoạn 6: Đang ghép tờ booklet (Xén Chồng)...'
                        : 'Giai đoạn 6: Đang nhân bản trang in (Step & Repeat)...'
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
                setStatus(`Đang thêm ${coverIndices.length} trang bìa vào cuối file...`);
                for (const idx of coverIndices) {
                    if (idx === -1) continue;
                    const [copiedPage] = await outputPdf.copyPages(srcPdf, [idx]);
                    outputPdf.addPage(copiedPage);
                }
            }
        }

        setStatus('Dọn dẹp bộ nhớ và Đóng tệp PDF...');
        const pdfBytes = await outputPdf.save(); // THIS is where lazy flate decoding fails!
        return { 
            blob: new Blob([pdfBytes as any], { type: 'application/pdf' }), 
            report: reportMsg 
        };
    };

    const decryptPdfViaBackend = async (buffer: ArrayBuffer, setStatus: (msg: string) => void): Promise<ArrayBuffer> => {
        setStatus('Phát hiện PDF bị khóa - Đang giải mã tập tin...');
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
                throw new Error(`Lỗi từ Backend: ${response.status} - ${errorText}`);
            }

            setStatus('Giải mã thành công. Đang nạp lại tài liệu...');
            return await response.arrayBuffer();
        } catch (e: any) {
            if (e.name === 'AbortError') {
                throw new Error(tv('Hệ thống giải mã không phản hồi sau 30 giây (Vui lòng thử lại sau).'));
            }
            throw new Error(`Xử lý tập tin thất bại: ${e.message}`);
        }
    };

    try {
        setStatus('Đang tải và xử lý khung PDF vào pipeline...');
        return await runPipeline(arrayBuffer);
    } catch (err: any) {
        console.error("Pipeline failed:", err);
        if (isEncryptionError(err)) {
            try {
                const cleanBuffer = await decryptPdfViaBackend(arrayBuffer, setStatus);
                return await runPipeline(cleanBuffer);
            } catch (decryptErr: any) {
                console.error("Backend Decryption failed:", decryptErr);
                throw new Error("Lỗi giải mã: " + (decryptErr.message || decryptErr));
            }
        } else {
            throw new Error("Lỗi bóc tách PDF: " + (err.message || err));
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
    
    setStatus(`Bắt đầu xử lý ${jobs.length} tấm kẽm...`);

    for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        setStatus(`Đang xử lý kẽm ${i + 1}/${jobs.length}: ${job.label}...`);

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
            paperClassification: (baseSettings as any).paperClassification || 'offset'
        } as any;

        // Bước 3: Chạy pipeline
        try {
            const result = await imposePdf(subFile, jobSettings, (msg) => {
                setStatus(`[Kẽm ${i + 1}/${jobs.length}] ${msg}`);
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
                label: `❌ ${job.label} (Lỗi: ${err.message})`,
                report: `Lỗi: ${err.message}`,
                jobId: job.id,
            });
        }
    }

    setStatus(`Hoàn tất: ${results.filter(r => r.blob.size > 0).length}/${jobs.length} kẽm thành công.`);
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

    setStatus('Đang tính toán sơ đồ bình trang...');

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
        setStatus('Đang trích xuất dữ liệu tập tin...');
        const buffer = await (await fetch(sourcePdfPath)).arrayBuffer();
        const srcPdf = await PDFDocument.load(buffer, { ignoreEncryption: true });
        pageCount = srcPdf.getPageCount();
        const pages = srcPdf.getPages();
        for (const p of pages) {
            // MediaBox-first (xem chú thích ở nhánh embed chính): dùng khổ trang vật lý
            // cho phép tính scale, tránh cắt lề trắng khi CropBox chặt hơn MediaBox.
            const { width, height } = p.getMediaBox() || p.getCropBox() || p.getSize();
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
    setStatus('Đang thiết lập sơ đồ trang...');
            const bMode = (settings as any).bindingMode || 'saddle';
    // pageOrder (thứ tự trang do người dùng sắp trong viewer, 1-based; -1 = trang trắng
    // đã chèn) là NGUỒN SỰ THẬT — GIỐNG HỆT "Xem Bài In" (SheetViewer dùng pageOrder.length).
    // Trước đây nhánh này dựng map từ pageCount THÔ của file gốc → generateBindingMap tự pad
    // + tự nhét trang trắng ở CUỐI, BỎ QUA trang trắng người dùng chèn giữa sách → trang
    // trắng rơi nhầm mặt (vd cùng mặt trang 1). Nay map theo pageOrder rồi remap srcIndex
    // (index logic vào pageOrder) → index TRANG THẬT trong file gốc, hoặc null nếu là slot
    // trắng. source_page/backend giữ nguyên; slot null được backend skip (fix trang trắng
    // lệch mặt 2026-07-07).
    const pageOrder: number[] | undefined = Array.isArray((settings as any).pageOrder)
        ? (settings as any).pageOrder : undefined;
    const effectiveCount = pageOrder ? pageOrder.length : pageCount;
    const mapResult = generateBindingMap(effectiveCount, bMode, (settings as any).foliosize, (settings as any).blankPlacement || 'end');
    const virtualMap = mapResult.sheets;
    if (pageOrder) {
        const remapSlot = (slot: { srcIndex: number | null }) => {
            if (slot.srcIndex === null) return; // padding do map tự thêm → giữ trắng
            const realPage = pageOrder[slot.srcIndex]; // 1-based trang gốc, hoặc -1 = trắng
            slot.srcIndex = (realPage == null || realPage === -1) ? null : realPage - 1;
        };
        for (const sheet of virtualMap) {
            remapSlot(sheet.front.left); remapSlot(sheet.front.right);
            remapSlot(sheet.back.left); remapSlot(sheet.back.right);
        }
    }
    let report = mapResult.report;

    setStatus('Đang tính toán kích thước tự động...');
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
                const warn = `⚠ Trang trải ${Math.round(spreadWmm)}×${Math.round(spreadHmm)}mm KHÔNG vừa khổ ${Math.round(reqSheetW)}×${Math.round(reqSheetH)}mm ở 100% (dù đã xoay khổ). Hãy chọn khổ lớn hơn, hoặc dùng "1 cuốn/tờ (bóp vừa khổ)" để thu nội dung cho vừa. Hệ thống KHÔNG tự co ở chế độ 100%.`;
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
    setStatus('Đang xuất thông số kỹ thuật...');
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
    );


    // ──── STEP 4: Gửi JSON cho Backend Python thực thi ────
    setStatus('Đang gửi kế hoạch xử lý...');
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
        throw new Error(`Hệ thống xử lý thất bại: ${response.status} - ${errText}`);
    }

    // ──── STEP 5: Nhận file output ────
    const outputBlob = await response.blob();
    // Backend đặt tên file UNIQUE (audit #C1) → KHÔNG suy đường dẫn theo tên cố định.
    // `outputBlob` (nội dung trả về) mới là nguồn chuẩn; outputPath chỉ còn mang tính
    // thông tin (output_dir). Caller hiện dùng blob/report, không đọc lại theo path.
    const outputPath = instructionSet.output_dir || 'results';

    setStatus('✅ Hoàn tất! File kẽm đã được xuất thành công.');
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

    setStatus(`Bắt đầu xử lý ${jobs.length} tấm kẽm...`);

    for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        const sheetSettings = { ...baseSettings } as any;
        setStatus(`[Kẽm ${i + 1}/${jobs.length}] ${job.label}...`);

        const jobSettings: ProcessingSettings = {
            impositionMode: ImpositionMode.Booklet,
            bindingMode: job.bindingMode === 'saddle' ? 'saddle' : 'thread',
            foliosize: job.pageIndices.length,
            paperThickness: baseSettings.paperThickness || 0,
            bleed: baseSettings.bleed || 0,
            paperClassification: (sheetSettings as any).paperClassification || 'offset',
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
                (msg) => setStatus(`[Kẽm ${i + 1}/${jobs.length}] ${msg}`),
                outputDir,
            );

            results.push({
                blob: new Blob(), // Không giữ Blob trong RAM — file đã ở ổ cứng
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
                label: `❌ ${job.label} (Lỗi: ${err.message})`,
                report: `Lỗi: ${err.message}`,
                jobId: job.id,
            });
        }
    }

    setStatus(`✅ Hoàn tất: ${results.filter(r => !r.label.startsWith('❌')).length}/${jobs.length} kẽm thành công.`);
    return results;
};
