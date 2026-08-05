// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePrintDialog } from './usePrintDialog';
import { calculateSizePreview } from '../../lib/printPreviewLayout';

const mocks = vi.hoisted(() => ({
    listPrinters: vi.fn(),
    resolvePrintableFilePath: vi.fn(),
    printPdfDirect: vi.fn(),
    printPdfPath: vi.fn(),
    deletePrintTemp: vi.fn(),
    logPrintEvent: vi.fn(),
    getPrinterGeometry: vi.fn(),
    openPrinterProperties: vi.fn(),
    cancelPrintJob: vi.fn(),
    choosePrinterOutputPath: vi.fn(),
    getFileArrayBuffer: vi.fn(),
}));

vi.mock('../../lib/nativePrint', () => ({
    listPrinters: mocks.listPrinters,
    resolvePrintableFilePath: mocks.resolvePrintableFilePath,
    printPdfDirect: mocks.printPdfDirect,
    printPdfPath: mocks.printPdfPath,
    deletePrintTemp: mocks.deletePrintTemp,
    logPrintEvent: mocks.logPrintEvent,
    getPrinterGeometry: mocks.getPrinterGeometry,
    openPrinterProperties: mocks.openPrinterProperties,
    cancelPrintJob: mocks.cancelPrintJob,
    choosePrinterOutputPath: mocks.choosePrinterOutputPath,
}));

vi.mock('../../lib/utils', () => ({
    getFileArrayBuffer: mocks.getFileArrayBuffer,
}));

vi.mock('@tauri-apps/api/event', () => ({
    listen: vi.fn(async () => () => undefined),
}));

vi.mock('react-pdf', () => ({
    pdfjs: {
        GlobalWorkerOptions: { workerSrc: '' },
        getDocument: vi.fn(),
    },
}));

vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string, options?: Record<string, unknown>) => {
            const name = key.split(':').pop() || key;
            if (name === 'job_failed') return `job_failed:${String(options?.error || '')}`;
            return name;
        },
    }),
}));

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function Harness() {
    const { openPrintDialog, printDialog } = usePrintDialog();
    const [result, setResult] = useState('pending');
    return (
        <>
            <button
                type="button"
                onClick={() => {
                    void openPrintDialog({
                        source: new Blob(['pdf'], { type: 'application/pdf' }),
                        numPages: 1,
                    }).then(value => setResult(String(value)));
                }}
            >
                open
            </button>
            <output data-testid="result">{result}</output>
            {printDialog}
        </>
    );
}

describe('usePrintDialog lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
        mocks.resolvePrintableFilePath.mockResolvedValue({
            filePath: 'C:\\Temp\\prynx-print.pdf',
            deleteAfter: true,
        });
        mocks.listPrinters.mockResolvedValue([{ name: 'Test Printer', is_default: true }]);
        mocks.deletePrintTemp.mockResolvedValue(undefined);
        mocks.logPrintEvent.mockResolvedValue(undefined);
        mocks.getPrinterGeometry.mockResolvedValue(null);
        mocks.openPrinterProperties.mockResolvedValue(null);
        mocks.cancelPrintJob.mockResolvedValue(undefined);
        mocks.choosePrinterOutputPath.mockResolvedValue(null);
        // Tái hiện PDF.js lỗi: engine native vẫn phải cho phép nhấn In.
        mocks.getFileArrayBuffer.mockRejectedValue(new Error('preview failed'));
    });

    afterEach(() => {
        cleanup();
        delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    });

    it('giữ dialog khi driver lỗi và chỉ mở fallback khi người dùng chủ động chọn', async () => {
        const direct = deferred<boolean>();
        mocks.printPdfDirect.mockReturnValue(direct.promise);
        mocks.printPdfPath.mockResolvedValue(true);

        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'open' }));

        const printButton = await screen.findByRole('button', { name: 'print' });
        await waitFor(() => expect(screen.getByText('preview_failed')).toBeTruthy());
        expect((printButton as HTMLButtonElement).disabled).toBe(false);

        fireEvent.click(printButton);
        expect(await screen.findByRole('button', { name: 'printing' })).toBeTruthy();
        expect(screen.getByRole('dialog', { name: 'title' })).toBeTruthy();
        expect(mocks.printPdfPath).not.toHaveBeenCalled();

        await act(async () => {
            direct.reject(new Error('driver stopped'));
            try {
                await direct.promise;
            } catch { /* lỗi được UI tiếp nhận */ }
        });

        expect(await screen.findByText('job_failed:driver stopped')).toBeTruthy();
        expect(screen.getByRole('dialog', { name: 'title' })).toBeTruthy();
        expect(mocks.printPdfPath).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: 'try_system_dialog' }));

        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'title' })).toBeNull());
        expect(mocks.printPdfPath).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('result').textContent).toBe('true');
        expect(mocks.deletePrintTemp).toHaveBeenCalledTimes(1);
    });

    it('chỉ đóng và dọn file tạm sau khi lệnh in trực tiếp hoàn tất', async () => {
        const direct = deferred<boolean>();
        mocks.printPdfDirect.mockReturnValue(direct.promise);

        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'open' }));
        fireEvent.click(await screen.findByRole('button', { name: 'print' }));

        expect(screen.getByRole('dialog', { name: 'title' })).toBeTruthy();
        expect(mocks.deletePrintTemp).not.toHaveBeenCalled();

        await act(async () => {
            direct.resolve(true);
            await direct.promise;
        });

        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'title' })).toBeNull());
        expect(screen.getByTestId('result').textContent).toBe('true');
        expect(mocks.deletePrintTemp).toHaveBeenCalledTimes(1);
    });

    it('yêu cầu file đích trước khi gửi job tới Microsoft Print to PDF', async () => {
        mocks.listPrinters.mockResolvedValue([{
            name: 'Microsoft Print to PDF',
            is_default: true,
            port_name: 'PORTPROMPT:',
            requires_output_path: true,
            output_extension: 'pdf',
        }]);
        mocks.choosePrinterOutputPath.mockResolvedValue('D:\\output\\job.pdf');
        mocks.printPdfDirect.mockResolvedValue(true);

        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'open' }));
        fireEvent.click(await screen.findByRole('button', { name: 'print' }));

        await waitFor(() => expect(mocks.printPdfDirect).toHaveBeenCalledTimes(1));
        expect(mocks.choosePrinterOutputPath).toHaveBeenCalledWith(expect.objectContaining({
            name: 'Microsoft Print to PDF',
        }));
        expect(mocks.printPdfDirect).toHaveBeenCalledWith(expect.objectContaining({
            outputPath: 'D:\\output\\job.pdf',
        }));
    });

    it('không tạo job nếu người dùng hủy chọn file đích', async () => {
        mocks.listPrinters.mockResolvedValue([{
            name: 'Microsoft Print to PDF',
            is_default: true,
            requires_output_path: true,
            output_extension: 'pdf',
        }]);
        mocks.choosePrinterOutputPath.mockResolvedValue(null);

        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'open' }));
        fireEvent.click(await screen.findByRole('button', { name: 'print' }));

        await waitFor(() => expect(mocks.choosePrinterOutputPath).toHaveBeenCalledTimes(1));
        expect(mocks.printPdfDirect).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog', { name: 'title' })).toBeTruthy();
    });

    it('gửi tín hiệu hủy kèm đúng mã job của dialog hiện tại', async () => {
        const direct = deferred<boolean>();
        mocks.printPdfDirect.mockReturnValue(direct.promise);

        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'open' }));
        fireEvent.click(await screen.findByRole('button', { name: 'print' }));
        fireEvent.click(await screen.findByRole('button', { name: 'cancel_job' }));

        await waitFor(() => expect(mocks.cancelPrintJob).toHaveBeenCalledTimes(1));
        expect(mocks.cancelPrintJob).toHaveBeenCalledWith(expect.stringMatching(/^print-/));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'title' })).toBeNull());
        expect(screen.getByTestId('result').textContent).toBe('false');

        await act(async () => {
            direct.resolve(true);
            await direct.promise;
        });
    });
});

describe('mixed-size print preview', () => {
    it('tính riêng kích thước và tỷ lệ của từng trang', () => {
        const a4Portrait = calculateSizePreview(
            { w: 595.28, h: 841.89 },
            {
                printable_w_mm: 200,
                printable_h_mm: 287,
            },
            'fit',
            100,
        );
        const square = calculateSizePreview(
            { w: 283.46, h: 283.46 },
            {
                printable_w_mm: 200,
                printable_h_mm: 287,
            },
            'fit',
            100,
        );

        expect(a4Portrait.widthMm).toBeCloseTo(210, 1);
        expect(square.widthMm).toBeCloseTo(100, 1);
        expect(a4Portrait.scale).not.toBeCloseTo(square.scale, 3);
    });
});
