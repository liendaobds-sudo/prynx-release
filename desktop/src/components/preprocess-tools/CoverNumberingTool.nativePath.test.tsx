// @vitest-environment jsdom
// Hồi quy FILEIO (audit 2026-08-06 §5, lô 3): file làm việc của tab theo "đường native" là
// File RỖNG/sentinel chỉ mang `.path` — Mẹc Bìa phải đọc bytes THẬT từ đĩa, nếu không:
//   - `:94` đếm số trang ra 0 → UI không hiện "File có N trang", nút Chạy bị khoá;
//   - `:198` trích trang bìa ném "No PDF header found".
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CoverNumberingTool from './CoverNumberingTool';

const mocks = vi.hoisted(() => ({
    fetchLocalFileBuffer: vi.fn(),
    startVdpJobBackend: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'job-1'),
}));

vi.mock('@/lib/localFileTransport', () => ({ fetchLocalFileBuffer: mocks.fetchLocalFileBuffer }));
vi.mock('@/lib/api', () => ({
    startVdpJobBackend: mocks.startVdpJobBackend,
    pollVdpJob: vi.fn(() => new Promise(() => undefined)),
    cancelVdpJobBackend: vi.fn(async () => undefined),
}));
vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string, options?: Record<string, unknown>) => {
            const name = key.split(':').pop() || key;
            // Chỉ cần đúng key mang số trang để test đọc được con số.
            return name === 'file_co_n_trang' ? `File có ${options?.n} trang` : name;
        },
    }),
}));
vi.mock('@/i18n', () => ({ tv: (s: string) => s }));

type TauriWindow = Window & { __TAURI_INTERNALS__?: Record<string, never> };
const tauriWindow = window as TauriWindow;

/** PDF thật 6 trang (bìa + ruột). */
async function makeRealPdf(pages = 6): Promise<Uint8Array<ArrayBuffer>> {
    const doc = await PDFDocument.create();
    for (let i = 0; i < pages; i++) doc.addPage([595, 842]);
    const saved = await doc.save();
    return new Uint8Array(saved.slice()) as Uint8Array<ArrayBuffer>;
}

/** Y hệt createPathBackedFile: File RỖNG bytes, chỉ mang tên + `.path`. */
function makePathBackedFile(name: string, path: string): File {
    const f = new File([], name, { type: 'application/pdf' });
    Object.defineProperty(f, 'path', { value: path });
    return f;
}

/** Bật ô "bìa & ruột nằm chung 1 file" để lộ dòng hiển thị số trang. */
function enableSingleFileMode() {
    const label = screen.getByText(/bia_ruot_nam_chung_1_file_gan_trang_bia/);
    const box = label.closest('label')?.querySelector('input[type="checkbox"]');
    fireEvent.click(box as HTMLInputElement);
}

describe('CoverNumberingTool — đường native (File rỗng + path)', () => {
    beforeEach(() => {
        tauriWindow.__TAURI_INTERNALS__ = {};
        mocks.fetchLocalFileBuffer.mockReset();
    });

    afterEach(() => {
        cleanup();
        delete tauriWindow.__TAURI_INTERNALS__;
    });

    it('đếm đúng số trang bằng cách đọc đĩa qua .path, không dùng bytes rỗng của File', async () => {
        const bytes = await makeRealPdf(6);
        mocks.fetchLocalFileBuffer.mockResolvedValue(bytes.buffer);

        const pdfFile = makePathBackedFile('Ruot_va_bia.pdf', 'D:\\jobs\\Ruot_va_bia.pdf');
        render(<CoverNumberingTool pdfFile={pdfFile} />);

        // Bật "bìa & ruột nằm chung 1 file" để lộ dòng hiển thị số trang.
        enableSingleFileMode();

        await waitFor(() => {
            expect(mocks.fetchLocalFileBuffer).toHaveBeenCalledWith('D:\\jobs\\Ruot_va_bia.pdf');
            expect(screen.getByText(/File có 6 trang/)).toBeTruthy();
        });
    });

    it('không đọc đĩa khi File không có path (web / in-memory)', async () => {
        const bytes = await makeRealPdf(3);
        const blobFile = new File([bytes], 'web.pdf', { type: 'application/pdf' });
        // jsdom chưa có File.prototype.arrayBuffer.
        Object.defineProperty(blobFile, 'arrayBuffer', { value: async () => bytes.buffer });

        render(<CoverNumberingTool pdfFile={blobFile} />);
        enableSingleFileMode();

        await waitFor(() => {
            expect(screen.getByText(/File có 3 trang/)).toBeTruthy();
        });
        expect(mocks.fetchLocalFileBuffer).not.toHaveBeenCalled();
    });

    it('trích trang bìa từ bytes đọc trên đĩa (không ném "No PDF header found")', async () => {
        const bytes = await makeRealPdf(6);
        // Cả `pdfFile` (đếm trang) lẫn `getWorkingFile()` (template) đều path-backed.
        mocks.fetchLocalFileBuffer.mockResolvedValue(bytes.buffer);
        mocks.startVdpJobBackend.mockClear();

        const pdfFile = makePathBackedFile('Ruot_va_bia.pdf', 'D:\\jobs\\Ruot_va_bia.pdf');
        const working = makePathBackedFile('Ruot_va_bia.pdf', 'D:\\jobs\\Ruot_va_bia.pdf');

        // 1 cụm bìa với 3 field X/Y/Z (textContent mang token) → clusters.length = 1.
        const vdpFields = ['X', 'Y', 'Z'].map((r, i) => ({
            id: `f${i}`, groupId: 'g1', x: 10, y: 10, textContent: `{${r}}`, name: r,
        }));

        render(
            <CoverNumberingTool
                pdfFile={pdfFile}
                getWorkingFile={async () => working}
                vdpFields={vdpFields}
            />,
        );
        enableSingleFileMode();
        await waitFor(() => expect(screen.getByText(/File có 6 trang/)).toBeTruthy());

        // coverPagesStr mặc định '1' → trích trang 1 làm template.
        fireEvent.click(screen.getByRole('button', { name: /run/i }));

        await waitFor(() => expect(mocks.startVdpJobBackend).toHaveBeenCalled());
        const template = mocks.startVdpJobBackend.mock.calls[0][0] as File;
        expect(template.name).toBe('cover_Ruot_va_bia.pdf');
        // Template phải là PDF THẬT 1 trang, không phải rác sentinel.
        // jsdom chưa có Blob.prototype.arrayBuffer → đọc bytes qua FileReader.
        const buf = await new Promise<ArrayBuffer>((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result as ArrayBuffer);
            fr.onerror = () => reject(fr.error);
            fr.readAsArrayBuffer(template);
        });
        const outDoc = await PDFDocument.load(new Uint8Array(buf));
        expect(outDoc.getPageCount()).toBe(1);
    });
});
