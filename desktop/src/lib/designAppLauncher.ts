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

/**
 * Đảm bảo tài liệu PDF có đường dẫn tệp thực tế trên đĩa (native path).
 * Nếu file chỉ ở dạng Blob/In-memory trong WebView, sẽ ghi nhanh vào thư mục tạm.
 */
export async function ensurePathBackedPdf(file: File | Blob, originalName?: string): Promise<string> {
    const candidatePath = (file as File & { path?: string }).path;
    if (candidatePath && typeof candidatePath === 'string') {
        return candidatePath;
    }

    const isTauri = typeof window !== 'undefined'
        && !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    if (!isTauri) {
        throw new Error('Môi trường trình duyệt không hỗ trợ mở ứng dụng ngoài.');
    }

    const { tempDir, join } = await import('@tauri-apps/api/path');
    const { invoke } = await import('@tauri-apps/api/core');
    const tDir = await tempDir();
    const safeName = (originalName || (file as File).name || 'document.pdf')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\.pdf$/i, '');
    const fullPath = await join(tDir, `prynx_edit_${Date.now()}_${safeName}.pdf`);
    const buffer = new Uint8Array(await file.arrayBuffer());
    await invoke('write_file_atomic', { path: fullPath, contents: buffer });
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
        && !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
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
): Promise<{ tempFilePath: string; pageIndices: number[] }> {
    if (pageIndices.length === 0) {
        throw new Error('Chưa chọn trang để sửa.');
    }

    const isTauri = typeof window !== 'undefined'
        && !!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
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

    const srcBytes = new Uint8Array(await file.arrayBuffer());
    const srcDoc = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
    const pageCount = srcDoc.getPageCount();

    const validIndices = pageIndices
        .filter(idx => Number.isInteger(idx) && idx >= 0 && idx < pageCount)
        .sort((a, b) => a - b);

    if (validIndices.length === 0) {
        throw new Error('Các trang được chọn không tồn tại trong tài liệu.');
    }

    const outDoc = await PDFDocument.create();
    const ocTransfer = beginOptionalContentTransfer([srcDoc], { preserveUnreferencedOcgs: true });
    try {
        const copiedPages = await outDoc.copyPages(srcDoc, validIndices);
        copiedPages.forEach(p => outDoc.addPage(p));
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
    const { PDFDocument } = await import('pdf-lib');
    const {
        beginOptionalContentTransfer,
        finishOptionalContentTransfer,
    } = await import('./pdfOptionalContent');

    const mainDoc = await PDFDocument.load(originalBytes, { ignoreEncryption: true });
    const editedDoc = await PDFDocument.load(editedBytes, { ignoreEncryption: true });

    const sortedIndices = [...pageIndices].sort((a, b) => a - b);
    const ocTransfer = beginOptionalContentTransfer([editedDoc], { preserveUnreferencedOcgs: true });

    try {
        const copied = await mainDoc.copyPages(editedDoc, editedDoc.getPageIndices());
        for (let i = 0; i < sortedIndices.length && i < copied.length; i++) {
            const targetIdx = sortedIndices[i];
            const newPage = copied[i];
            if (targetIdx < mainDoc.getPageCount()) {
                mainDoc.insertPage(targetIdx, newPage);
                mainDoc.removePage(targetIdx + 1);
            }
        }
    } finally {
        finishOptionalContentTransfer(ocTransfer, mainDoc);
    }

    return await mainDoc.save();
}

