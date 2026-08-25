// ─────────────────────────────────────────────────────────────────────────
// vdpTemplate.ts — Lưu / Tải MẪU bố cục VDP (.json)
//
// Field VDP (vị trí, kích thước, kiểu text/QR/barcode, font, style, tên trường...)
// là lớp phủ đang soạn, KHÔNG nằm trong PDF. Util này xuất/nạp bố cục đó ra file
// JSON để dùng lại — dùng chung cho Trộn VDP, Chạy số, Chạy bìa.
// ─────────────────────────────────────────────────────────────────────────

import i18n from '../i18n';

const FILTERS = [{ name: 'PrynX VDP Template', extensions: ['json'] }];

/**
 * Field trong mẫu VDP có tập thuộc tính mở theo loại text/QR/barcode/ảnh.
 * Các key hình học và style được giữ nguyên để tương thích mẫu từ phiên bản cũ.
 */
export interface VdpTemplateField {
    [key: string]: unknown;
    id?: string | number;
    name?: string;
    type?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    pageNum?: number;
    position?: { x: number; y: number };
}

export interface VdpTemplate {
    app: 'PrynX';
    kind: 'vdp-template';
    version: 1;
    savedAt: string;
    sourcePdf: string | null;
    fields: readonly VdpTemplateField[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isVdpTemplateFieldList(value: unknown): value is VdpTemplateField[] {
    // Chỉ kiểm hợp đồng cấu trúc tối thiểu: mẫu cũ và từng loại field có thể mang
    // các key riêng; siết giá trị ở đây sẽ làm mất tương thích hoặc đổi đơn vị.
    return Array.isArray(value) && value.every(isRecord);
}

function isTauriRuntime(): boolean {
    return Boolean(window.__TAURI_INTERNALS__);
}

function describeError(error: unknown): string {
    if (isRecord(error) && error.message) return String(error.message);
    return String(error);
}

/** Lưu danh sách field VDP ra file .json (hỏi vị trí lưu). */
export async function saveVdpTemplate(
    fields: readonly VdpTemplateField[] | null | undefined,
    pdfName: string | undefined,
    setStatus: (s: string) => void,
): Promise<void> {
    if (!fields || fields.length === 0) {
        setStatus(i18n.t('lib.vdpTemplate:chua_co_truong_vdp_nao_de_luu_mau'));
        return;
    }
    const template: VdpTemplate = {
        app: 'PrynX', kind: 'vdp-template', version: 1,
        savedAt: new Date().toISOString(),
        sourcePdf: pdfName || null,
        fields,
    };
    const payload = JSON.stringify(template, null, 2);
    const defaultName = (pdfName?.replace(/\.[^/.]+$/, '') || 'mau') + '_vdp.json';
    try {
        if (isTauriRuntime()) {
            const { save } = await import('@tauri-apps/plugin-dialog');
            const { writeTextFile } = await import('@tauri-apps/plugin-fs');
            const path = await save({ defaultPath: defaultName, filters: FILTERS, title: i18n.t('lib.vdpTemplate:luu_mau_bo_cuc_vdp') });
            if (path) {
                await writeTextFile(path, payload);
                setStatus(i18n.t('lib.vdpTemplate:da_luu_mau_path_split_pop', { name: path.split(/[\\/]/).pop() }));
            }
        } else {
            const blob = new Blob([payload], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = defaultName;
            document.body.appendChild(a); a.click();
            setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
            setStatus(i18n.t('lib.vdpTemplate:da_tai_mau_xuong'));
        }
    } catch (error: unknown) {
        setStatus(i18n.t('lib.vdpTemplate:loi_luu_mau') + ' ' + describeError(error));
    }
}

/** Nạp field VDP từ file .json. Trả về mảng field (đã gán ID mới) hoặc null. */
export async function loadVdpTemplate(
    setStatus: (s: string) => void,
): Promise<VdpTemplateField[] | null> {
    try {
        let text = '';
        if (isTauriRuntime()) {
            const { open } = await import('@tauri-apps/plugin-dialog');
            const { readTextFile } = await import('@tauri-apps/plugin-fs');
            const path = await open({ multiple: false, filters: FILTERS, title: i18n.t('lib.vdpTemplate:tai_mau_bo_cuc_vdp') });
            if (!path || typeof path !== 'string') return null;
            text = await readTextFile(path);
        } else {
            text = await new Promise<string>((resolve, reject) => {
                const inp = document.createElement('input');
                inp.type = 'file'; inp.accept = '.json,application/json';
                inp.onchange = () => {
                    const f = inp.files?.[0];
                    if (!f) { reject(new Error('no file')); return; }
                    const r = new FileReader();
                    r.onload = () => resolve(String(r.result));
                    r.onerror = () => reject(r.error);
                    r.readAsText(f);
                };
                inp.click();
            });
        }
        const data: unknown = JSON.parse(text);
        // Hỗ trợ cả định dạng legacy là mảng trực tiếp và envelope { fields }.
        const fields = Array.isArray(data) ? data : (isRecord(data) ? data.fields : undefined);
        if (!isVdpTemplateFieldList(fields) || fields.length === 0) {
            setStatus(i18n.t('lib.vdpTemplate:file_mau_khong_hop_le_hoac_rong'));
            return null;
        }
        // Gán ID mới (tránh trùng với field hiện có / phiên trước). Giữ NGUYÊN
        // name/textContent/kích thước/style → lần sau chỉ cần gán lại cột/cấu hình.
        const stamp = Date.now();
        const remapped = fields.map((field, index) => ({
            ...field,
            id: `field_${stamp}_${index}_${Math.random().toString(36).slice(2, 6)}`,
        }));
        setStatus(i18n.t('lib.vdpTemplate:da_tai_mau_remapped_length_truong', { count: remapped.length }));
        return remapped;
    } catch (error: unknown) {
        setStatus(i18n.t('lib.vdpTemplate:loi_tai_mau') + ' ' + describeError(error));
        return null;
    }
}
