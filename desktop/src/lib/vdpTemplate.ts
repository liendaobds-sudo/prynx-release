// ─────────────────────────────────────────────────────────────────────────
// vdpTemplate.ts — Lưu / Tải MẪU bố cục VDP (.json)
//
// Field VDP (vị trí, kích thước, kiểu text/QR/barcode, font, style, tên trường...)
// là lớp phủ đang soạn, KHÔNG nằm trong PDF. Util này xuất/nạp bố cục đó ra file
// JSON để dùng lại — dùng chung cho Trộn VDP, Chạy số, Chạy bìa.
// ─────────────────────────────────────────────────────────────────────────

const FILTERS = [{ name: 'PrynX VDP Template', extensions: ['json'] }];

/** Lưu danh sách field VDP ra file .json (hỏi vị trí lưu). */
export async function saveVdpTemplate(
    fields: any[],
    pdfName: string | undefined,
    setStatus: (s: string) => void,
): Promise<void> {
    if (!fields || fields.length === 0) {
        setStatus('Chưa có trường VDP nào để lưu mẫu.');
        return;
    }
    const payload = JSON.stringify({
        app: 'PrynX', kind: 'vdp-template', version: 1,
        savedAt: new Date().toISOString(),
        sourcePdf: pdfName || null,
        fields,
    }, null, 2);
    const defaultName = (pdfName?.replace(/\.[^/.]+$/, '') || 'mau') + '_vdp.json';
    try {
        if ((window as any).__TAURI_INTERNALS__) {
            const { save } = await import('@tauri-apps/plugin-dialog');
            const { writeTextFile } = await import('@tauri-apps/plugin-fs');
            const path = await save({ defaultPath: defaultName, filters: FILTERS, title: 'Lưu mẫu bố cục VDP' });
            if (path) {
                await writeTextFile(path, payload);
                setStatus(`Đã lưu mẫu: ${path.split(/[\\/]/).pop()}`);
            }
        } else {
            const blob = new Blob([payload], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = defaultName;
            document.body.appendChild(a); a.click();
            setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
            setStatus('Đã tải mẫu xuống.');
        }
    } catch (e: any) {
        setStatus('Lỗi lưu mẫu: ' + (e?.message || e));
    }
}

/** Nạp field VDP từ file .json. Trả về mảng field (đã gán ID mới) hoặc null. */
export async function loadVdpTemplate(
    setStatus: (s: string) => void,
): Promise<any[] | null> {
    try {
        let text = '';
        if ((window as any).__TAURI_INTERNALS__) {
            const { open } = await import('@tauri-apps/plugin-dialog');
            const { readTextFile } = await import('@tauri-apps/plugin-fs');
            const path = await open({ multiple: false, filters: FILTERS, title: 'Tải mẫu bố cục VDP' });
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
        const data = JSON.parse(text);
        const fields = Array.isArray(data) ? data : data?.fields;
        if (!Array.isArray(fields) || fields.length === 0) {
            setStatus('File mẫu không hợp lệ hoặc rỗng.');
            return null;
        }
        // Gán ID mới (tránh trùng với field hiện có / phiên trước). Giữ NGUYÊN
        // name/textContent/kích thước/style → lần sau chỉ cần gán lại cột/cấu hình.
        const stamp = Date.now();
        const remapped = fields.map((f: any, i: number) => ({
            ...f,
            id: `field_${stamp}_${i}_${Math.random().toString(36).slice(2, 6)}`,
        }));
        setStatus(`Đã tải mẫu: ${remapped.length} trường.`);
        return remapped;
    } catch (e: any) {
        setStatus('Lỗi tải mẫu: ' + (e?.message || e));
        return null;
    }
}
