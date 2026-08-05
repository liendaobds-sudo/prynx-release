// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import OpenInDesignModal from './OpenInDesignModal';

const mocks = vi.hoisted(() => ({
    invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/path', () => ({
    tempDir: vi.fn(async () => 'C:\\Temp'),
    join: vi.fn(async (...parts: string[]) => parts.join('\\')),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string, options?: { n?: number }) => {
            const name = key.split(':').pop() || key;
            return name === 'to_so' ? `Tờ ${options?.n}` : name;
        },
    }),
}));

const ILLUSTRATOR = 'C:\\Program Files\\Adobe\\Adobe Illustrator 2025\\Illustrator.exe';

function renderModal(overrides: Partial<React.ComponentProps<typeof OpenInDesignModal>> = {}) {
    const props: React.ComponentProps<typeof OpenInDesignModal> = {
        open: true,
        onClose: vi.fn(),
        resultFilePath: 'D:\\jobs\\Imposed_order.pdf',
        resultBlob: null,
        separateCut: true,
        originalName: 'Imposed_order.pdf',
        currentPage: 1,
        ...overrides,
    };
    return { ...render(<OpenInDesignModal {...props} />), props };
}

describe('OpenInDesignModal', () => {
    beforeEach(() => {
        mocks.invoke.mockReset();
        localStorage.clear();
        Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    });

    afterEach(() => {
        cleanup();
        delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    });

    it('không báo thiếu ứng dụng khi bộ dò vẫn đang chạy', async () => {
        let resolveDetection!: (value: { illustrator: string | null; corel: string | null }) => void;
        const pending = new Promise<{ illustrator: string | null; corel: string | null }>(resolve => {
            resolveDetection = resolve;
        });
        mocks.invoke.mockImplementation((command: string) => {
            if (command === 'detect_design_apps') return pending;
            return Promise.resolve();
        });

        renderModal();

        expect(screen.getAllByText('dang_tim_ung_dung').length).toBeGreaterThan(0);
        expect(screen.queryByText('khong_tim_thay_tren_may')).toBeNull();
        expect(screen.queryByText('chon_thu_cong')).toBeNull();

        await act(async () => {
            resolveDetection({ illustrator: ILLUSTRATOR, corel: null });
            await pending;
        });

        expect(await screen.findByText(ILLUSTRATOR)).toBeTruthy();
        expect(screen.getByText('khong_tim_thay_tren_may')).toBeTruthy();
        expect(screen.getByText('chon_lai')).toBeTruthy();
        expect(screen.getByText('chon_thu_cong')).toBeTruthy();
    });

    it('mở nguyên file kết quả bằng Illustrator khi chọn cả khuôn và in', async () => {
        mocks.invoke.mockImplementation((command: string) => {
            if (command === 'detect_design_apps') {
                return Promise.resolve({ illustrator: ILLUSTRATOR, corel: null });
            }
            return Promise.resolve();
        });
        const { props } = renderModal();

        await screen.findByText(ILLUSTRATOR);
        fireEvent.click(screen.getByLabelText('ca_khuon_va_in'));
        fireEvent.click(screen.getByRole('button', { name: /Adobe Illustrator/ }));

        await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('launch_external_app', {
            appPath: ILLUSTRATOR,
            filePath: 'D:\\jobs\\Imposed_order.pdf',
        }));
        expect(props.onClose).toHaveBeenCalledOnce();
    });

    it('trích đúng trang bế của tờ đang xem trước khi mở ứng dụng', async () => {
        const source = await PDFDocument.create();
        source.addPage([100, 110]);
        source.addPage([200, 210]); // Trang bế tờ 1.
        source.addPage([300, 310]);
        source.addPage([400, 410]); // Trang bế tờ 2.
        const sourceBytes = await source.save();
        const resultBlob = {
            arrayBuffer: async () => sourceBytes.buffer.slice(
                sourceBytes.byteOffset,
                sourceBytes.byteOffset + sourceBytes.byteLength,
            ),
        } as Blob;

        mocks.invoke.mockImplementation((command: string) => {
            if (command === 'detect_design_apps') {
                return Promise.resolve({ illustrator: ILLUSTRATOR, corel: null });
            }
            return Promise.resolve();
        });
        renderModal({ resultBlob });

        await screen.findByText(ILLUSTRATOR);
        await screen.findAllByText('Tờ 1');
        fireEvent.click(screen.getByRole('button', { name: /Adobe Illustrator/ }));

        await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith(
            'launch_external_app',
            expect.objectContaining({ appPath: ILLUSTRATOR }),
        ));
        const writeCall = mocks.invoke.mock.calls.find(([command]) => command === 'write_file_atomic');
        expect(writeCall).toBeTruthy();
        const output = await PDFDocument.load((writeCall?.[1] as { contents: Uint8Array }).contents);
        expect(output.getPageCount()).toBe(1);
        expect(output.getPage(0).getSize()).toEqual({ width: 200, height: 210 });
    });
});
