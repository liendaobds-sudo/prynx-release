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
