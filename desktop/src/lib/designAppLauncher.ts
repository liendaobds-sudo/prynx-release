// designAppLauncher.ts — Cầu nối khởi chạy Illustrator và CorelDRAW từ PrynX.
// Cung cấp logic dò app, lưu tuỳ chọn người dùng, chọn file .exe và mở tài liệu.

export interface CustomDesignApps {
    illustrator?: string;
    corel?: string;
}

export const DESIGN_APPS_LS_KEY = 'prynx.designApps.v1';

export function loadCustomDesignApps(): CustomDesignApps {
    try {
        return JSON.parse(localStorage.getItem(DESIGN_APPS_LS_KEY) || '{}');
    } catch {
        return {};
    }
}

export function saveCustomDesignApps(apps: CustomDesignApps): void {
    try {
        localStorage.setItem(DESIGN_APPS_LS_KEY, JSON.stringify(apps));
    } catch {
        /* ignore */
    }
}

/** Dò tìm Illustrator và CorelDRAW đã cài đặt trên hệ thống Windows */
export async function detectInstalledDesignApps(): Promise<CustomDesignApps> {
    const isTauri = typeof window !== 'undefined'
        && !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    if (!isTauri) return {};
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        const apps = await invoke<{ illustrator: string | null; corel: string | null }>('detect_design_apps');
        return {
            illustrator: apps.illustrator || undefined,
            corel: apps.corel || undefined,
        };
    } catch (e) {
        console.warn('Không thể tự động dò ứng dụng thiết kế:', e);
        return {};
    }
}

/** Mở hộp thoại chọn file thực thi (.exe) */
export async function pickDesignAppExe(
    which: 'illustrator' | 'corel',
    title?: string,
): Promise<string | undefined> {
    try {
        const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
        const defaultTitle = which === 'illustrator'
            ? 'Chọn file Illustrator.exe'
            : 'Chọn file CorelDRW.exe';
        const picked = await openDialog({
            multiple: false,
            title: title || defaultTitle,
            filters: [{ name: 'Application', extensions: ['exe'] }],
        });
        if (typeof picked === 'string') {
            const current = loadCustomDesignApps();
            const next = { ...current, [which]: picked };
            saveCustomDesignApps(next);
            return picked;
        }
    } catch (e) {
        console.error('Không thể mở hộp thoại chọn app:', e);
    }
    return undefined;
}

import { PDFName, type PDFDocument, type PDFPage } from 'pdf-lib';

/**
 * Chuẩn hoá toạ độ trang PDF về gốc (0, 0) nếu MediaBox hoặc CropBox bị offset.
 * Đảm bảo khi mở trong Adobe Illustrator hoặc CorelDRAW:
 * - Artboard được tạo khớp chính xác 1:1 với vùng hiển thị (viewport).
 * - Nội dung vẽ không bị trôi dạt/lệch xuống đáy Artboard.
 * - Xóa PieceInfo (Illustrator Private Data) cũ để Illustrator không khôi phục toạ độ lệch cũ.
 */
export function normalizePageBoxes(page: PDFPage): boolean {
    const mediaBox = page.getMediaBox();
    const hasCrop = page.node.has(PDFName.of('CropBox'));
    const cropBox = hasCrop ? page.getCropBox() : mediaBox;

    // Vùng nhìn thấy thực tế (effective visual box)
    const originX = cropBox.x;
    const originY = cropBox.y;
    const width = cropBox.width;
    const height = cropBox.height;

    // Kiểm tra xem toạ độ gốc có bị lệch khỏi (0, 0) hay không (ngưỡng 0.01 pt ~ 0.0035 mm)
    const isOffsetX = Math.abs(originX) > 0.01;
    const isOffsetY = Math.abs(originY) > 0.01;
    const mediaOffsetX = Math.abs(mediaBox.x) > 0.01;
    const mediaOffsetY = Math.abs(mediaBox.y) > 0.01;

    if (!isOffsetX && !isOffsetY && !mediaOffsetX && !mediaOffsetY) {
        return false;
    }

    // Tịnh tiến content stream về gốc (0, 0)
    page.translateContent(-originX, -originY);

    // Đặt lại MediaBox về gốc (0, 0)
    page.setMediaBox(0, 0, width, height);

    // Đặt lại CropBox nếu có
    if (hasCrop) {
        page.setCropBox(0, 0, width, height);
    }

    // Tịnh tiến các box khác nếu có
    if (page.node.has(PDFName.of('TrimBox'))) {
        const tb = page.getTrimBox();
        page.setTrimBox(tb.x - originX, tb.y - originY, tb.width, tb.height);
    }
    if (page.node.has(PDFName.of('BleedBox'))) {
        const bb = page.getBleedBox();
        page.setBleedBox(bb.x - originX, bb.y - originY, bb.width, bb.height);
    }
    if (page.node.has(PDFName.of('ArtBox'))) {
        const ab = page.getArtBox();
        page.setArtBox(ab.x - originX, ab.y - originY, ab.width, ab.height);
    }

    // Xóa PieceInfo trên trang vì dữ liệu private cũ của Illustrator chứa toạ độ offset cũ
    page.node.delete(PDFName.of('PieceInfo'));

    return true;
}

/**
 * Quét toàn bộ tài liệu PDF và chuẩn hoá tất cả các trang bị lệch gốc toạ độ.
 * Trả về true nếu có ít nhất một trang được chuẩn hoá.
 */
export function normalizePdfDocument(doc: PDFDocument): boolean {
    let anyModified = false;
    const pages = doc.getPages();
    for (const p of pages) {
        const modified = normalizePageBoxes(p);
        if (modified) {
            anyModified = true;
        }
    }
    if (anyModified) {
        if (doc.catalog.has(PDFName.of('PieceInfo'))) {
            doc.catalog.delete(PDFName.of('PieceInfo'));
        }
    }
    return anyModified;
}

/**
 * Đảm bảo tài liệu PDF có đường dẫn tệp thực tế trên đĩa (native path).
 * Nếu file chỉ ở dạng Blob/In-memory trong WebView, sẽ ghi nhanh vào thư mục tạm.
 * Tự động chuẩn hoá toạ độ trang về (0, 0) nếu phát hiện file bị offset MediaBox/CropBox.
 */
export async function ensurePathBackedPdf(file: File | Blob, originalName?: string): Promise<string> {
    const candidatePath = (file as File & { path?: string }).path;
    if (candidatePath && typeof candidatePath === 'string') {
        try {
            const { getFileArrayBuffer } = await import('./utils');
            const { PDFDocument } = await import('pdf-lib');
            const { invoke } = await import('@tauri-apps/api/core');
            const origBuffer = new Uint8Array(await getFileArrayBuffer(file, candidatePath));
            if (origBuffer.length > 0) {
                const doc = await PDFDocument.load(origBuffer, { ignoreEncryption: true });
                const modified = normalizePdfDocument(doc);
                if (modified) {
                    const normalizedBytes = await doc.save();
                    await invoke('write_file_atomic', { path: candidatePath, contents: normalizedBytes });
                }
            }
        } catch (checkErr) {
            console.warn('[DesignBridge][ensurePathBackedPdf] Bỏ qua chuẩn hoá toạ độ đĩa do lỗi:', checkErr);
        }
        return candidatePath;
    }

    const isTauri = typeof window !== 'undefined'
        && Boolean(window.__TAURI_INTERNALS__ || (window as Window & { __PRYNX_INVOKE__?: unknown }).__PRYNX_INVOKE__ || (window as Window & { __TAURI__?: unknown }).__TAURI__);
    if (!isTauri) {
        throw new Error('Môi trường trình duyệt không hỗ trợ mở ứng dụng ngoài.');
    }

    const { tempDir, join } = await import('@tauri-apps/api/path');
    const { invoke } = await import('@tauri-apps/api/core');
    const { getFileArrayBuffer } = await import('./utils');
    const tDir = await tempDir();
    const safeName = (originalName || (file as File).name || 'document.pdf')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\.pdf$/i, '');
    const fullPath = await join(tDir, `prynx_edit_${Date.now()}_${safeName}.pdf`);
    const buffer = new Uint8Array(await getFileArrayBuffer(file));
    if (buffer.length === 0) {
        throw new Error('Không thể chuẩn bị file: Dữ liệu PDF rỗng (0 bytes).');
    }

    let finalBuffer: Uint8Array<ArrayBufferLike> = buffer;
    try {
        const { PDFDocument } = await import('pdf-lib');
        const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
        const modified = normalizePdfDocument(doc);
        if (modified) {
            finalBuffer = await doc.save();
        }
    } catch (normErr) {
        console.warn('[DesignBridge][ensurePathBackedPdf] Không thể chuẩn hoá toạ độ buffer in-memory:', normErr);
    }

    await invoke('write_file_atomic', { path: fullPath, contents: finalBuffer });
    return fullPath;
}

/**
 * Khởi chạy Illustrator hoặc CorelDRAW với tệp được chỉ định.
 * Tự động dò đường dẫn, hỏi người dùng chọn .exe nếu chưa có và xử lý xin cấp quyền.
 */
export async function launchDesignApp(
    which: 'illustrator' | 'corel',
    filePath: string,
): Promise<void> {
    const isTauri = typeof window !== 'undefined'
        && Boolean(window.__TAURI_INTERNALS__ || (window as Window & { __PRYNX_INVOKE__?: unknown }).__PRYNX_INVOKE__ || (window as Window & { __TAURI__?: unknown }).__TAURI__);
    if (!isTauri) {
        throw new Error('Tính năng này chỉ khả dụng trên ứng dụng Desktop.');
    }

    const custom = loadCustomDesignApps();
    let appPath = custom[which];

    if (!appPath) {
        const detected = await detectInstalledDesignApps();
        appPath = detected[which];
    }

    if (!appPath) {
        appPath = await pickDesignAppExe(which);
    }

    if (!appPath) {
        return; // Người dùng hủy chọn
    }

    const { invoke } = await import('@tauri-apps/api/core');

    try {
        await invoke('launch_external_app', { appPath, filePath });
    } catch (launchError) {
        console.error('[DesignBridge][launchDesignApp] Lỗi khi launch_external_app:', launchError);
        const errStr = String(launchError ?? '');
        const needsReauthorization = /chưa được cấp quyền/i.test(errStr);
        if (needsReauthorization) {
            const repicked = await pickDesignAppExe(which);
            if (repicked) {
                await invoke('launch_external_app', { appPath: repicked, filePath });
                return;
            }
        }
        throw launchError;
    }
}

/**
 * Trích các trang được chọn thành một tệp PDF tạm riêng biệt để mở trong Illustrator/Corel.
 * Giữ nguyên OCG, Spot Color, Bleed và kích thước gốc.
 */
export async function extractPagesForExternalEdit(
    file: File | Blob,
    pageIndices: number[],
    originalName?: string,
    fallbackPath?: string,
): Promise<{ tempFilePath: string; pageIndices: number[] }> {
    if (pageIndices.length === 0) {
        throw new Error('Chưa chọn trang để sửa.');
    }

    const isTauri = typeof window !== 'undefined'
        && Boolean(window.__TAURI_INTERNALS__ || (window as Window & { __PRYNX_INVOKE__?: unknown }).__PRYNX_INVOKE__ || (window as Window & { __TAURI__?: unknown }).__TAURI__);
    if (!isTauri) {
        throw new Error('Môi trường trình duyệt không hỗ trợ mở ứng dụng ngoài.');
    }

    const { PDFDocument } = await import('pdf-lib');
    const {
        beginOptionalContentTransfer,
        finishOptionalContentTransfer,
    } = await import('./pdfOptionalContent');
    const { tempDir, join } = await import('@tauri-apps/api/path');
    const { invoke } = await import('@tauri-apps/api/core');
    const { getFileArrayBuffer } = await import('./utils');

    const effectivePath = (file as any)?.path || fallbackPath;
    const srcArrayBuffer = await getFileArrayBuffer(file, effectivePath);
    const srcBytes = new Uint8Array(srcArrayBuffer);

    if (srcBytes.length === 0) {
        throw new Error(`Dữ liệu PDF rỗng (0 bytes). Đường dẫn: ${effectivePath || 'không xác định'}.`);
    }

    const srcDoc = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
    const pageCount = srcDoc.getPageCount();

    const validIndices = pageIndices
        .filter(idx => Number.isInteger(idx) && idx >= 0 && idx < pageCount)
        .sort((a, b) => a - b);
    const invalidIndices = pageIndices.filter(idx => !Number.isInteger(idx) || idx < 0 || idx >= pageCount);
    if (invalidIndices.length > 0) {
        console.warn('[DesignBridge][extractPagesForExternalEdit] CẢNH BÁO: Có chỉ số trang yêu cầu vượt ngoài phạm vi PDF thật trên đĩa (tổng trang=' + pageCount + '):', {
            invalidIndices,
            requestedIndices: pageIndices,
        });
    }

    if (validIndices.length === 0) {
        const errMsg = `Các trang được chọn (${pageIndices.join(', ')}) không tồn tại trong tài liệu PDF thật trên đĩa (${pageCount} trang).`;
        console.error('[DesignBridge][extractPagesForExternalEdit] ' + errMsg);
        throw new Error(errMsg);
    }

    const outDoc = await PDFDocument.create();
    const ocTransfer = beginOptionalContentTransfer([srcDoc], { preserveUnreferencedOcgs: true });
    try {
        const copiedPages = await outDoc.copyPages(srcDoc, validIndices);
        const { PDFName } = await import('pdf-lib');
        // [LIVE-LINK AI FIX]: Chỉ xóa PieceInfo khi tài liệu gốc có nhiều trang (pageCount > 1)
        // để Adobe Illustrator khi mở file tạm không bị nạp ngược toàn bộ các artboards cũ của file gốc.
        // Với tài liệu đơn trang (pageCount === 1), giữ nguyên PieceInfo để Illustrator giữ Live Text và layer gốc.
        // Tuy nhiên, nếu trang có toạ độ bị offset và được chuẩn hoá về (0, 0), bắt buộc phải xóa PieceInfo
        // để Illustrator không phục hồi toạ độ artboard cũ.
        const shouldStripPieceInfo = pageCount > 1;
        let anyNormalized = false;
        copiedPages.forEach(p => {
            const normalized = normalizePageBoxes(p);
            if (normalized) {
                anyNormalized = true;
            }
            if (shouldStripPieceInfo || normalized) {
                p.node.delete(PDFName.of('PieceInfo'));
            }
            outDoc.addPage(p);
        });
        if ((shouldStripPieceInfo || anyNormalized) && outDoc.catalog.has(PDFName.of('PieceInfo'))) {
            outDoc.catalog.delete(PDFName.of('PieceInfo'));
        }
    } finally {
        finishOptionalContentTransfer(ocTransfer, outDoc);
    }

    const extractedBytes = await outDoc.save();

    const safeBase = (originalName || (file as File).name || 'document')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\.pdf$/i, '');
    const pageLabel = validIndices.length === 1
        ? `p${validIndices[0] + 1}`
        : `p${validIndices.map(i => i + 1).join('_')}`;

    const tDir = await tempDir();
    const tempFilePath = await join(tDir, `prynx_${safeBase}_${pageLabel}_${Date.now()}.pdf`);
    await invoke('write_file_atomic', { path: tempFilePath, contents: extractedBytes });

    return { tempFilePath, pageIndices: validIndices };
}

/**
 * Gộp các trang đã chỉnh sửa từ ứng dụng ngoài vào lại đúng vị trí trong tài liệu gốc.
 */
export async function mergeEditedPagesIntoDocument(
    originalBytes: Uint8Array,
    editedBytes: Uint8Array,
    pageIndices: number[],
): Promise<Uint8Array> {
    const { PDFDocument, PDFName } = await import('pdf-lib');
    const {
        beginOptionalContentTransfer,
        finishOptionalContentTransfer,
    } = await import('./pdfOptionalContent');

    let mainDoc: any;
    let editedDoc: any;
    try {
        mainDoc = await PDFDocument.load(originalBytes, { ignoreEncryption: true });
    } catch (loadOrigErr) {
        console.error('[DesignBridge][mergeEditedPagesIntoDocument] Lỗi đọc PDF tài liệu gốc:', loadOrigErr);
        throw new Error('Không thể đọc dữ liệu PDF gốc để gộp trang: ' + String(loadOrigErr));
    }
    try {
        editedDoc = await PDFDocument.load(editedBytes, { ignoreEncryption: true });
    } catch (loadEditedErr) {
        console.error('[DesignBridge][mergeEditedPagesIntoDocument] Lỗi đọc PDF từ Illustrator/Corel (có thể file chưa lưu xong hoặc bị khóa):', loadEditedErr);
        throw new Error('Không thể đọc dữ liệu PDF đã sửa từ ứng dụng thiết kế: ' + String(loadEditedErr));
    }

    const editedPageCount = editedDoc.getPageCount();
    const sortedIndices = [...pageIndices].sort((a, b) => a - b);

    if (editedPageCount !== sortedIndices.length) {
        console.warn(`[DesignBridge][mergeEditedPagesIntoDocument] CẢNH BÁO: Số trang file sửa (${editedPageCount}) không khớp số trang đích cần gộp (${sortedIndices.length})!`);
    }

    const ocTransfer = beginOptionalContentTransfer([editedDoc], { preserveUnreferencedOcgs: true });

    try {
        const copied = await mainDoc.copyPages(editedDoc, editedDoc.getPageIndices());
        for (let i = 0; i < sortedIndices.length && i < copied.length; i++) {
            const targetIdx = sortedIndices[i];
            const newPage = copied[i];
            newPage.node.delete(PDFName.of('PieceInfo'));
            if (targetIdx < mainDoc.getPageCount()) {
                mainDoc.insertPage(targetIdx, newPage);
                mainDoc.removePage(targetIdx + 1);
            } else {
                console.error(`[DesignBridge][mergeEditedPagesIntoDocument] LỖI: targetIdx ${targetIdx} vượt quá số trang tài liệu chính ${mainDoc.getPageCount()}!`);
            }
        }
        // Xóa PieceInfo ở cấp Catalog của tài liệu gốc vì đã có trang được cập nhật độc lập
        if (mainDoc.catalog.has(PDFName.of('PieceInfo'))) {
            mainDoc.catalog.delete(PDFName.of('PieceInfo'));
        }
    } finally {
        finishOptionalContentTransfer(ocTransfer, mainDoc);
    }

    const savedBytes = await mainDoc.save();
    return savedBytes;
}

