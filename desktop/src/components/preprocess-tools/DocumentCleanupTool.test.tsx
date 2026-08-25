// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import DocumentCleanupTool, {
    buildDocumentCleanupBatchArtifact,
    copyDocumentCleanupResultIdentity,
    detectSelectedDocumentCard,
    DocumentCleanupDropReceiver,
    DocumentCleanupPreview,
    disposeDocumentCleanupTab,
    processDocumentCleanupBatch,
    shouldShowDocumentCleanupOverlay,
} from './DocumentCleanupTool';
import { useDocumentCleanupStore } from './useDocumentCleanupStore';
import { IMAGE_BATCH_DROP_EVENTS } from '../../lib/tabNavigation';

const apiMocks = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('../../lib/api', () => ({
    getApiUrl: () => 'http://localhost:8321/api',
    authenticatedFetch: apiMocks.authenticatedFetch,
}));
vi.mock('../../i18n', () => ({ tv: (text: string) => text }));
vi.mock('../ui/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function sourceItem() {
    const file = new File(['image'], 'the.png', { type: 'image/png' });
    return {
        id: 'card-1',
        path: 'browser-file',
        fileName: file.name,
        originalUrl: 'blob:source',
        status: 'pending' as const,
        fileObj: file,
    };
}

async function pdfFileWithPages(pageCount: number, name = 'scan.pdf'): Promise<File> {
    const pdf = await PDFDocument.create();
    for (let page = 0; page < pageCount; page += 1) pdf.addPage([100, 100]);
    const bytes = await pdf.save();
    const buffer = Uint8Array.from(bytes).buffer;
    const file = new File([buffer], name, { type: 'application/pdf' });
    Object.defineProperty(file, 'arrayBuffer', {
        value: async () => buffer.slice(0),
    });
    return file;
}

function readBlob(blob: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.readAsArrayBuffer(blob);
    });
}

const ONE_PIXEL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';

function pngResultBlob(): Blob {
    const binary = atob(ONE_PIXEL_PNG_BASE64);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'image/png' });
    Object.defineProperty(blob, 'arrayBuffer', {
        value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
    return blob;
}

describe('DocumentCleanupTool', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        useDocumentCleanupStore.setState({ tabs: {} });
        Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:result') });
        Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    });

    it('lưu bốn góc nhận diện theo đúng tab và item', async () => {
        apiMocks.authenticatedFetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                points: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.08 }, { x: 0.88, y: 0.9 }, { x: 0.12, y: 0.92 }],
                confidence: 0.91,
                needs_review: false,
                method: 'edges',
            }),
        });
        const store = useDocumentCleanupStore.getState();
        store.initTab('tab-card');
        store.addItems('tab-card', [sourceItem()]);

        await detectSelectedDocumentCard('tab-card');

        const detection = useDocumentCleanupStore.getState().getTab('tab-card').options.detections['card-1'];
        expect(detection.points).toHaveLength(4);
        expect(detection.confidence).toBe(0.91);
        expect(apiMocks.authenticatedFetch).toHaveBeenCalledWith(
            'http://localhost:8321/api/document-cleanup/detect-card',
            expect.objectContaining({ method: 'POST' }),
        );
    });

    it('không che AcrobatViewer khi nguồn đang mở là PDF', () => {
        expect(shouldShowDocumentCleanupOverlay(true, false)).toBe(false);
        expect(shouldShowDocumentCleanupOverlay(true, true)).toBe(true);
        expect(shouldShowDocumentCleanupOverlay(false, false)).toBe(true);
    });

    it('preview kết quả zoom được bằng con lăn', () => {
        const store = useDocumentCleanupStore.getState();
        store.initTab('tab-preview-wheel');
        store.addItems('tab-preview-wheel', [{
            ...sourceItem(),
            status: 'success',
            resultUrl: 'blob:straight-card',
            resultBlob: new Blob(['straight-card'], { type: 'image/png' }),
        }]);

        render(<DocumentCleanupPreview tabId="tab-preview-wheel" isActive />);
        const preview = screen.getByTestId('document-cleanup-preview');
        const canvas = screen.getByTestId('document-cleanup-canvas');
        const wheel = new WheelEvent('wheel', {
            deltaY: -100,
            bubbles: true,
            cancelable: true,
        });

        act(() => preview.dispatchEvent(wheel));

        expect(wheel.defaultPrevented).toBe(true);
        expect(canvas.style.transform).toBe('translate(0px, 0px) scale(1.15)');
        expect(screen.getByText('115%')).not.toBeNull();
    });

    it('kéo trực tiếp để pan ảnh kết quả', () => {
        const store = useDocumentCleanupStore.getState();
        store.initTab('tab-preview-pan');
        store.addItems('tab-preview-pan', [{
            ...sourceItem(),
            status: 'success',
            resultUrl: 'blob:straight-card',
            resultBlob: new Blob(['straight-card'], { type: 'image/png' }),
        }]);

        render(<DocumentCleanupPreview tabId="tab-preview-pan" isActive />);
        const preview = screen.getByTestId('document-cleanup-preview');
        const canvas = screen.getByTestId('document-cleanup-canvas');

        fireEvent.mouseDown(preview, { button: 0, clientX: 100, clientY: 120 });
        fireEvent.mouseMove(window, { clientX: 145, clientY: 150 });
        fireEvent.mouseUp(window);

        expect(canvas.style.transform).toBe('translate(45px, 30px) scale(1)');
    });

    it('double-click và nút reset đưa zoom/pan về 100%', () => {
        const store = useDocumentCleanupStore.getState();
        store.initTab('tab-preview-reset');
        store.addItems('tab-preview-reset', [{
            ...sourceItem(),
            status: 'success',
            resultUrl: 'blob:straight-card',
            resultBlob: new Blob(['straight-card'], { type: 'image/png' }),
        }]);

        render(<DocumentCleanupPreview tabId="tab-preview-reset" isActive />);
        const preview = screen.getByTestId('document-cleanup-preview');
        const canvas = screen.getByTestId('document-cleanup-canvas');

        fireEvent.wheel(preview, { deltaY: -100 });
        fireEvent.mouseDown(preview, { button: 0, clientX: 20, clientY: 30 });
        fireEvent.mouseMove(window, { clientX: 60, clientY: 70 });
        fireEvent.mouseUp(window);
        fireEvent.doubleClick(preview);
        expect(canvas.style.transform).toBe('translate(0px, 0px) scale(1)');

        fireEvent.click(screen.getByRole('button', { name: 'Phóng to' }));
        expect(canvas.style.transform).toContain('scale(1.15)');
        fireEvent.click(screen.getByRole('button', { name: 'Vừa khung' }));
        expect(canvas.style.transform).toBe('translate(0px, 0px) scale(1)');
    });

    it('reset khung xem khi resultUrl xuất hiện sau xử lý', () => {
        const store = useDocumentCleanupStore.getState();
        store.initTab('tab-preview-result-ready');
        store.addItems('tab-preview-result-ready', [sourceItem()]);

        render(<DocumentCleanupPreview tabId="tab-preview-result-ready" isActive />);
        const preview = screen.getByTestId('document-cleanup-preview');
        const canvas = screen.getByTestId('document-cleanup-canvas');
        fireEvent.wheel(preview, { deltaY: -100 });
        expect(canvas.style.transform).toContain('scale(1.15)');

        act(() => {
            store.setBatchItems('tab-preview-result-ready', items => items.map(item => ({
                ...item,
                status: 'success' as const,
                resultUrl: 'blob:clean-result',
                resultBlob: new Blob(['clean-result'], { type: 'image/png' }),
            })));
        });

        expect(canvas.style.transform).toBe('translate(0px, 0px) scale(1)');
        expect(screen.getByText('100%')).not.toBeNull();
        expect(screen.getByRole('img', { name: 'the.png' }).getAttribute('src')).toBe('blob:clean-result');
    });

    it('drop hai ảnh chỉ tạo một dải thumbnail ở panel và đổi đúng ảnh đang xem', async () => {
        vi.mocked(URL.createObjectURL).mockImplementation(blob => (
            `blob:${blob instanceof File ? blob.name : 'result'}`
        ));
        const first = new File(['first'], 'mat-truoc.png', { type: 'image/png' });
        const second = new File(['second'], 'mat-sau.jpg', { type: 'image/jpeg' });

        render(
            <>
                <DocumentCleanupTool tabId="tab-preview-drop" pdfFile={null} />
                <DocumentCleanupPreview tabId="tab-preview-drop" isActive />
            </>,
        );
        fireEvent.drop(screen.getByTestId('document-cleanup-preview'), {
            dataTransfer: { files: [first, second] },
        });

        const firstThumbnail = await screen.findByRole('button', { name: 'Chọn mat-truoc.png' });
        const secondThumbnail = screen.getByRole('button', { name: 'Chọn mat-sau.jpg' });
        expect(screen.getAllByLabelText('Danh sách ảnh')).toHaveLength(1);
        expect(within(screen.getByTestId('document-cleanup-preview')).queryByRole('button', { name: 'Chọn mat-truoc.png' })).toBeNull();
        expect(useDocumentCleanupStore.getState().getTab('tab-preview-drop').batchItems).toHaveLength(2);
        expect(screen.getByRole('img', { name: 'mat-truoc.png' }).getAttribute('src')).toBe('blob:mat-truoc.png');

        const preview = screen.getByTestId('document-cleanup-preview');
        fireEvent.wheel(preview, { deltaY: -100 });
        expect(screen.getByTestId('document-cleanup-canvas').style.transform).toContain('scale(1.15)');
        fireEvent.click(secondThumbnail);

        expect(screen.getByRole('img', { name: 'mat-sau.jpg' }).getAttribute('src')).toBe('blob:mat-sau.jpg');
        expect(screen.getByTestId('document-cleanup-canvas').style.transform).toBe('translate(0px, 0px) scale(1)');
        expect(firstThumbnail.className).not.toContain('border-violet-500');
        expect(secondThumbnail.className).toContain('border-violet-500');

        fireEvent.click(screen.getByRole('button', { name: 'Xóa mat-sau.jpg' }));
        expect(useDocumentCleanupStore.getState().getTab('tab-preview-drop').batchItems).toHaveLength(1);
        expect(screen.queryByRole('button', { name: 'Chọn mat-sau.jpg' })).toBeNull();
        expect(screen.getByRole('img', { name: 'mat-truoc.png' })).not.toBeNull();
    });

    it('drop thêm ảnh vẫn tạo thumbnail khi preview đang hiển thị kết quả', async () => {
        const store = useDocumentCleanupStore.getState();
        store.initTab('tab-preview-drop-result');
        store.addItems('tab-preview-drop-result', [{
            ...sourceItem(),
            status: 'success',
            resultUrl: 'blob:straight-card',
            resultBlob: new Blob(['straight-card'], { type: 'image/png' }),
        }]);
        const added = new File(['new-card'], 'the-moi.png', { type: 'image/png' });

        render(
            <>
                <DocumentCleanupTool tabId="tab-preview-drop-result" pdfFile={null} />
                <DocumentCleanupPreview tabId="tab-preview-drop-result" isActive />
            </>,
        );
        fireEvent.drop(screen.getByTestId('document-cleanup-preview'), {
            dataTransfer: { files: [added] },
        });

        expect(await screen.findByRole('button', { name: 'Chọn the-moi.png' })).not.toBeNull();
        expect(store.getTab('tab-preview-drop-result').batchItems).toHaveLength(2);
    });

    it('receiver của workspace nhận custom event đúng tab và bỏ qua event tab khác', async () => {
        render(
            <>
                <DocumentCleanupDropReceiver tabId="tab-preview-native" isActive />
                <DocumentCleanupPreview tabId="tab-preview-native" isActive />
            </>,
        );
        const wrong = new File(['wrong'], 'sai-tab.png', { type: 'image/png' });
        const correct = new File(['correct'], 'dung-tab.png', { type: 'image/png' });
        const emit = (tabId: string, files: File[]) => window.dispatchEvent(new CustomEvent(
            IMAGE_BATCH_DROP_EVENTS.document_cleanup,
            { detail: { tabId, files } },
        ));

        act(() => { emit('tab-khac', [wrong]); });
        expect(useDocumentCleanupStore.getState().getTab('tab-preview-native').batchItems).toHaveLength(0);

        act(() => { emit('tab-preview-native', [correct]); });
        await waitFor(() => expect(
            useDocumentCleanupStore.getState().getTab('tab-preview-native').batchItems,
        ).toHaveLength(1));
        expect(screen.getByRole('img', { name: 'dung-tab.png' })).not.toBeNull();
    });

    it('thay ảnh workspace cũ bằng PDF sau xoay nhưng giữ mọi item người dùng thêm', async () => {
        vi.mocked(URL.createObjectURL).mockImplementation(blob => (
            `blob:${blob instanceof File ? blob.name : 'result'}`
        ));
        const workspaceImage = new File(['workspace-image'], 'anh-tu-workspace.png', { type: 'image/png' });
        const explicitImage = new File(['explicit-image'], 'anh-them-tay.png', { type: 'image/png' });
        const workspacePdf = await pdfFileWithPages(3, 'scan-workspace.pdf');
        const workingPdf = await pdfFileWithPages(2, 'scan-working.pdf');
        const getWorkingFile = vi.fn().mockResolvedValue(workingPdf);
        const renderWorkspace = (sourceImageFile: File | null) => (
            <>
                <DocumentCleanupTool
                    tabId="tab-workspace-revision"
                    pdfFile={workspacePdf}
                    sourceImageFile={sourceImageFile}
                    getWorkingFile={getWorkingFile}
                />
                <DocumentCleanupPreview tabId="tab-workspace-revision" isActive />
            </>
        );

        const view = render(renderWorkspace(workspaceImage));
        const store = useDocumentCleanupStore.getState();
        await waitFor(() => expect(store.getTab('tab-workspace-revision').batchItems).toHaveLength(1));
        expect(store.getTab('tab-workspace-revision').batchItems[0]).toMatchObject({
            fileName: workspaceImage.name,
            sourceOrigin: 'workspace',
        });

        fireEvent.drop(screen.getByTestId('document-cleanup-preview'), {
            dataTransfer: { files: [explicitImage] },
        });
        await waitFor(() => expect(store.getTab('tab-workspace-revision').batchItems).toHaveLength(2));
        expect(store.getTab('tab-workspace-revision').batchItems.find(
            item => item.fileName === explicitImage.name,
        )?.sourceOrigin).toBe('explicit');

        // Sau rotate/edit, ImpositionTab vô hiệu sourceImageFile; Cleanup phải
        // theo PDF workspace mới mà không materialize nền trước khi người dùng chạy.
        view.rerender(renderWorkspace(null));

        await waitFor(() => {
            const items = store.getTab('tab-workspace-revision').batchItems;
            expect(items).toHaveLength(2);
            expect(items.some(item => item.fileName === workspaceImage.name)).toBe(false);
            expect(items.find(item => item.fileName === explicitImage.name)?.sourceOrigin).toBe('explicit');
            expect(items.find(item => item.fileName === workspacePdf.name)?.sourceOrigin).toBe('workspace');
        });
        expect(getWorkingFile).not.toHaveBeenCalled();
    });

    it('tự detect trước rồi chỉ gửi một request xử lý thẻ', async () => {
        const output = new Blob(['png'], { type: 'image/png' });
        apiMocks.authenticatedFetch.mockImplementation(async (url: string) => {
            if (url.endsWith('/detect-card')) return {
                ok: true,
                json: async () => ({
                    points: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }],
                    confidence: 0.95,
                    needs_review: false,
                    method: 'edges',
                }),
            };
            return { ok: true, blob: async () => output };
        });
        const store = useDocumentCleanupStore.getState();
        store.initTab('tab-process');
        store.addItems('tab-process', [sourceItem()]);

        await processDocumentCleanupBatch('tab-process');

        const urls = apiMocks.authenticatedFetch.mock.calls.map(([url]) => String(url));
        expect(urls.filter(url => url.endsWith('/detect-card'))).toHaveLength(1);
        expect(urls.filter(url => url.endsWith('/process'))).toHaveLength(1);
        expect(useDocumentCleanupStore.getState().getTab('tab-process').batchItems[0].status).toBe('success');
    });

    it('tự dùng ảnh nắn thẻ cho workspace, không cần lưu rồi mở lại', async () => {
        const output = new Blob(['straight-card'], { type: 'image/png' });
        apiMocks.authenticatedFetch.mockImplementation(async (url: string) => {
            if (url.endsWith('/detect-card')) return {
                ok: true,
                json: async () => ({
                    points: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }],
                    confidence: 0.95,
                    needs_review: false,
                    method: 'edges',
                }),
            };
            return { ok: true, blob: async () => output };
        });
        const source = new File(['source-card'], 'the.png', { type: 'image/png' });
        const onFileFixed = vi.fn().mockResolvedValue(true);
        const view = render(
            <DocumentCleanupTool
                tabId="tab-card-handoff"
                pdfFile={null}
                sourceImageFile={source}
                onFileFixed={onFileFixed}
            />,
        );

        await waitFor(() => expect(
            useDocumentCleanupStore.getState().getTab('tab-card-handoff').batchItems,
        ).toHaveLength(1));
        fireEvent.click(screen.getByRole('button', { name: 'Xử lý' }));
        await waitFor(() => expect(onFileFixed).toHaveBeenCalledWith(output, 'nan_thang_the.png'));
        await waitFor(() => expect(
            useDocumentCleanupStore.getState().getTab('tab-card-handoff').batchItems[0].status,
        ).toBe('success'));
        expect(screen.getByRole('button', { name: /Lưu bản sao/ })).not.toBeNull();
        expect(screen.getByText(/Có thể chuyển thẳng sang công cụ khác/)).not.toBeNull();

        const applied = new File([output], 'nan_thang_the.png', { type: 'image/png' });
        copyDocumentCleanupResultIdentity(output, applied);
        view.unmount();
        render(
            <DocumentCleanupTool
                tabId="tab-card-handoff"
                pdfFile={null}
                sourceImageFile={applied}
                onFileFixed={onFileFixed}
            />,
        );
        await waitFor(() => expect(
            useDocumentCleanupStore.getState().getTab('tab-card-handoff').batchItems,
        ).toHaveLength(1));

        fireEvent.click(screen.getByTitle('Hoàn tác'));
        await waitFor(() => expect(onFileFixed).toHaveBeenNthCalledWith(2, source, 'the.png', undefined));
        expect(useDocumentCleanupStore.getState().getTab('tab-card-handoff').batchItems[0].status).toBe('pending');
    });

    it('gộp toàn bộ batch nắn thẻ thành PDF nhiều trang cho Bình Cắt Xén', async () => {
        apiMocks.authenticatedFetch.mockImplementation(async (url: string) => {
            if (url.endsWith('/detect-card')) return {
                ok: true,
                json: async () => ({
                    points: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }],
                    confidence: 0.95,
                    needs_review: false,
                    method: 'edges',
                }),
            };
            return { ok: true, blob: async () => pngResultBlob() };
        });
        const store = useDocumentCleanupStore.getState();
        store.initTab('tab-card-batch-handoff');
        const frontFile = new File(['front'], 'mat-truoc.png', { type: 'image/png' });
        const backFile = new File(['back'], 'mat-sau.png', { type: 'image/png' });
        store.addItems('tab-card-batch-handoff', [
            { ...sourceItem(), id: 'front', fileName: frontFile.name, fileObj: frontFile, originalUrl: 'blob:front' },
            { ...sourceItem(), id: 'back', fileName: backFile.name, fileObj: backFile, originalUrl: 'blob:back' },
        ]);
        const onFileFixed = vi.fn().mockResolvedValue(true);

        render(<DocumentCleanupTool tabId="tab-card-batch-handoff" pdfFile={null} onFileFixed={onFileFixed} />);
        fireEvent.click(screen.getByRole('button', { name: 'Xử lý' }));

        await waitFor(() => expect(onFileFixed).toHaveBeenCalledTimes(1));
        const [artifact, name] = onFileFixed.mock.calls[0] as [Blob, string];
        expect(artifact.type).toBe('application/pdf');
        expect(name).toBe('nan_thang_2_trang.pdf');
        const pdf = await PDFDocument.load(await readBlob(artifact));
        expect(pdf.getPageCount()).toBe(2);
        expect(store.getTab('tab-card-batch-handoff').batchItems.every(item => item.status === 'success')).toBe(true);
        expect(store.getTab('tab-card-batch-handoff').batchItems.every(item => item.resultInfo?.includes('Có thể chuyển thẳng'))).toBe(true);
    });

    it('gộp đúng thứ tự kết quả ảnh và PDF nhiều trang', async () => {
        const sourcePdf = await PDFDocument.create();
        sourcePdf.addPage([100, 200]);
        sourcePdf.addPage([300, 400]);
        const sourcePdfBytes = await sourcePdf.save();
        const pdfBlob = new Blob([sourcePdfBytes as unknown as BlobPart], { type: 'application/pdf' });
        Object.defineProperty(pdfBlob, 'arrayBuffer', {
            value: async () => Uint8Array.from(sourcePdfBytes).buffer,
        });
        const imageBlob = pngResultBlob();
        const artifact = await buildDocumentCleanupBatchArtifact([
            { ...sourceItem(), id: 'image', fileName: 'anh.png', status: 'success', resultBlob: imageBlob },
            { ...sourceItem(), id: 'pdf', fileName: 'scan.pdf', status: 'success', resultBlob: pdfBlob },
        ], 'scan');

        const combined = await PDFDocument.load(await readBlob(artifact.blob));
        expect(artifact.pageCount).toBe(3);
        expect(combined.getPageCount()).toBe(3);
        expect(combined.getPage(1).getSize()).toEqual({ width: 100, height: 200 });
        expect(combined.getPage(2).getSize()).toEqual({ width: 300, height: 400 });
    });

    it('không bàn giao PDF thiếu trang nếu một item trong batch xử lý lỗi', async () => {
        let processCall = 0;
        apiMocks.authenticatedFetch.mockImplementation(async (url: string) => {
            if (url.endsWith('/detect-card')) return {
                ok: true,
                json: async () => ({
                    points: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }],
                    confidence: 0.95,
                    needs_review: false,
                    method: 'edges',
                }),
            };
            processCall += 1;
            return processCall === 1
                ? { ok: true, blob: async () => pngResultBlob() }
                : { ok: false, text: async () => JSON.stringify({ detail: 'Ảnh sau bị lỗi' }) };
        });
        const store = useDocumentCleanupStore.getState();
        store.initTab('tab-card-partial');
        store.addItems('tab-card-partial', [
            { ...sourceItem(), id: 'ok', fileName: 'ok.png' },
            { ...sourceItem(), id: 'failed', fileName: 'failed.png' },
        ]);
        const onFileFixed = vi.fn().mockResolvedValue(true);

        render(<DocumentCleanupTool tabId="tab-card-partial" pdfFile={null} onFileFixed={onFileFixed} />);
        fireEvent.click(screen.getByRole('button', { name: 'Xử lý' }));

        await waitFor(() => expect(store.getTab('tab-card-partial').isProcessing).toBe(false));
        expect(onFileFixed).not.toHaveBeenCalled();
        expect(store.getTab('tab-card-partial').batchItems.map(item => item.status)).toEqual(['success', 'error']);
    });

    it('tự dùng ảnh làm trắng scan cho công cụ kế tiếp', async () => {
        const output = new Blob(['clean-image'], { type: 'image/png' });
        apiMocks.authenticatedFetch.mockResolvedValue({ ok: true, blob: async () => output });
        const store = useDocumentCleanupStore.getState();
        store.initTab('tab-scan-image-handoff');
        store.setOptions('tab-scan-image-handoff', {
            ...store.getTab('tab-scan-image-handoff').options,
            operation: 'scan',
        });
        store.addItems('tab-scan-image-handoff', [sourceItem()]);
        const onResultReady = vi.fn().mockResolvedValue(true);

        await processDocumentCleanupBatch('tab-scan-image-handoff', onResultReady);

        expect(onResultReady).toHaveBeenCalledWith(expect.objectContaining({
            blob: output,
            name: 'scan_sach_the.png',
        }));
        expect(store.getTab('tab-scan-image-handoff').batchItems[0].status).toBe('success');
    });

    it('chỉ báo thành công sau khi workspace đã nhận ảnh kết quả', async () => {
        const output = new Blob(['clean-image'], { type: 'image/png' });
        apiMocks.authenticatedFetch.mockResolvedValue({ ok: true, blob: async () => output });
        const store = useDocumentCleanupStore.getState();
        store.initTab('tab-await-handoff');
        store.setOptions('tab-await-handoff', {
            ...store.getTab('tab-await-handoff').options,
            operation: 'scan',
        });
        store.addItems('tab-await-handoff', [sourceItem()]);
        let releaseCommit!: (committed: boolean) => void;
        const commitGate = new Promise<boolean>(resolve => { releaseCommit = resolve; });
        const onResultReady = vi.fn(() => commitGate);

        const processing = processDocumentCleanupBatch('tab-await-handoff', onResultReady);
        await waitFor(() => expect(onResultReady).toHaveBeenCalledTimes(1));
        expect(store.getTab('tab-await-handoff').batchItems[0].status).toBe('processing');

        releaseCommit(true);
        await processing;
        expect(store.getTab('tab-await-handoff').batchItems[0].status).toBe('success');
    });

    it('không commit response muộn sau khi đã chuyển khỏi công cụ', async () => {
        let resolveProcess!: (response: { ok: boolean; blob: () => Promise<Blob> }) => void;
        apiMocks.authenticatedFetch.mockImplementation(() => new Promise(resolve => {
            resolveProcess = resolve;
        }));
        const store = useDocumentCleanupStore.getState();
        store.initTab('tab-unmounted');
        store.setOptions('tab-unmounted', {
            ...store.getTab('tab-unmounted').options,
            operation: 'scan',
        });
        store.addItems('tab-unmounted', [sourceItem()]);
        const onFileFixed = vi.fn().mockResolvedValue(true);
        const view = render(
            <DocumentCleanupTool tabId="tab-unmounted" pdfFile={null} onFileFixed={onFileFixed} />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Xử lý' }));
        await waitFor(() => expect(resolveProcess).toBeTypeOf('function'));
        view.unmount();
        resolveProcess({ ok: true, blob: async () => new Blob(['late'], { type: 'image/png' }) });

        await waitFor(() => expect(store.getTab('tab-unmounted').isProcessing).toBe(false));
        expect(onFileFixed).not.toHaveBeenCalled();
    });

    it('hủy và dọn state theo tab khi đóng', () => {
        const store = useDocumentCleanupStore.getState();
        store.initTab('tab-close');
        store.addItems('tab-close', [sourceItem()]);

        disposeDocumentCleanupTab('tab-close');

        expect(useDocumentCleanupStore.getState().tabs['tab-close']).toBeUndefined();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:source');
    });

    it('gửi PDF scan thẳng tới process và giữ kết quả PDF', async () => {
        const output = new Blob(['pdf'], { type: 'application/pdf' });
        apiMocks.authenticatedFetch.mockImplementation(async (url: string) => {
            if (url.includes('/document-cleanup/jobs/')) return {
                ok: true,
                json: async () => ({ current: 1, total: 1, phase: 'complete', terminal: true }),
            };
            return { ok: true, blob: async () => output };
        });
        const onResultReady = vi.fn().mockResolvedValue(true);
        const file = new File(['%PDF-1.4'], 'scan.pdf', { type: 'application/pdf' });
        const store = useDocumentCleanupStore.getState();
        store.initTab('tab-pdf');
        store.setOptions('tab-pdf', {
            ...store.getTab('tab-pdf').options,
            operation: 'scan',
            scanMode: 'bw',
            strength: 1,
            removeShadows: true,
            deskew: false,
        });
        store.addItems('tab-pdf', [{
            id: 'pdf-1', path: 'browser-file', fileName: file.name,
            originalUrl: 'blob:pdf', status: 'pending', fileObj: file,
        }]);

        await processDocumentCleanupBatch('tab-pdf', onResultReady);

        const processCall = apiMocks.authenticatedFetch.mock.calls.find(([url]) => String(url).endsWith('/document-cleanup/process'));
        expect(processCall).toBeDefined();
        const request = processCall?.[1] as { body: FormData };
        expect(request.body.get('operation')).toBe('scan');
        expect(request.body.get('output_dpi')).toBe('300');
        expect(request.body.get('scan_mode')).toBe('bw');
        expect(request.body.get('strength')).toBe('1');
        expect(request.body.get('remove_shadows')).toBe('true');
        expect(request.body.get('deskew')).toBe('false');
        expect(String(request.body.get('job_id'))).toMatch(/^[A-Za-z0-9_-]{8,80}$/);
        expect(apiMocks.authenticatedFetch.mock.calls.some(([url]) => String(url).includes('/document-cleanup/jobs/'))).toBe(true);
        expect(useDocumentCleanupStore.getState().getTab('tab-pdf').batchItems[0].resultBlob?.type).toBe('application/pdf');
        expect(onResultReady).toHaveBeenCalledWith(expect.objectContaining({
            blob: output,
            name: 'scan_sach_scan.pdf',
        }));
    });

    it('bỏ response cũ nếu thiết lập đổi trong lúc request đang chạy', async () => {
        const output = new Blob(['png'], { type: 'image/png' });
        let resolveProcess: ((response: unknown) => void) | undefined;
        apiMocks.authenticatedFetch.mockImplementation(() => new Promise(resolve => {
            resolveProcess = resolve;
        }));
        const store = useDocumentCleanupStore.getState();
        store.initTab('tab-stale-options');
        store.setOptions('tab-stale-options', {
            ...store.getTab('tab-stale-options').options,
            operation: 'scan',
            scanMode: 'color',
            strength: 0.55,
        });
        store.addItems('tab-stale-options', [sourceItem()]);

        const processing = processDocumentCleanupBatch('tab-stale-options');
        await vi.waitFor(() => expect(resolveProcess).toBeTypeOf('function'));
        store.setOptions('tab-stale-options', {
            ...store.getTab('tab-stale-options').options,
            scanMode: 'bw',
            strength: 1,
        });
        resolveProcess?.({ ok: true, blob: async () => output });
        await processing;

        const tab = useDocumentCleanupStore.getState().getTab('tab-stale-options');
        expect(tab.batchItems[0].status).toBe('pending');
        expect(tab.batchItems[0].resultBlob).toBeUndefined();
        expect(tab.error).toContain('Thiết lập đã thay đổi');
        expect(tab.isProcessing).toBe(false);
    });

    it('khóa điều khiển thay đổi request khi đang xử lý', () => {
        const store = useDocumentCleanupStore.getState();
        store.initTab('tab-disabled-controls');
        store.setOptions('tab-disabled-controls', {
            ...store.getTab('tab-disabled-controls').options,
            operation: 'scan',
        });
        store.addItems('tab-disabled-controls', [sourceItem()]);
        store.setIsProcessing('tab-disabled-controls', true);

        render(<DocumentCleanupTool tabId="tab-disabled-controls" pdfFile={null} />);

        const controls = [
            screen.getByRole('button', { name: 'Nắn thẻ' }),
            screen.getByRole('button', { name: 'Làm trắng scan' }),
            screen.getByRole('button', { name: 'Thêm ảnh hoặc PDF' }),
            screen.getByRole('button', { name: 'Xóa the.png' }),
            screen.getByRole('spinbutton'),
            screen.getByRole('combobox'),
            screen.getByRole('slider'),
            ...screen.getAllByRole('checkbox'),
        ];
        expect(controls.every(control => (control as HTMLButtonElement | HTMLInputElement).disabled)).toBe(true);
    });

    it('gửi PDF workspace đã bake sau khi người dùng xóa trang trong viewer', async () => {
        const output = new Blob(['pdf'], { type: 'application/pdf' });
        apiMocks.authenticatedFetch.mockImplementation(async (url: string) => {
            if (url.includes('/document-cleanup/jobs/')) return {
                ok: true,
                json: async () => ({ current: 2, total: 2, phase: 'complete', terminal: true }),
            };
            return { ok: true, blob: async () => output };
        });
        const source = await pdfFileWithPages(3);
        const working = await pdfFileWithPages(2);
        const getWorkingFile = vi.fn().mockResolvedValue(working);
        const store = useDocumentCleanupStore.getState();
        store.initTab('tab-pdf-working');
        store.setOptions('tab-pdf-working', { ...store.getTab('tab-pdf-working').options, operation: 'scan' });
        store.addItems('tab-pdf-working', [{
            id: 'pdf-working', path: 'browser-file', fileName: source.name,
            originalUrl: 'blob:pdf-working', status: 'pending', fileObj: source,
        }]);

        await processDocumentCleanupBatch('tab-pdf-working', undefined, { sourceFile: source, getWorkingFile });

        expect(getWorkingFile).toHaveBeenCalledTimes(1);
        const processCall = apiMocks.authenticatedFetch.mock.calls.find(([url]) => String(url).endsWith('/document-cleanup/process'));
        const request = processCall?.[1] as { body: FormData };
        const uploaded = request.body.get('file');
        expect(uploaded).toBeInstanceOf(File);
        expect((await PDFDocument.load(await readBlob(uploaded as File))).getPageCount()).toBe(2);
    });

    it('giữ bytes đã nạp cho PDF workspace path-only khi chưa sửa trang', async () => {
        const output = new Blob(['pdf'], { type: 'application/pdf' });
        apiMocks.authenticatedFetch.mockImplementation(async (url: string) => {
            if (url.includes('/document-cleanup/jobs/')) return {
                ok: true,
                json: async () => ({ current: 3, total: 3, phase: 'complete', terminal: true }),
            };
            return { ok: true, blob: async () => output };
        });
        const pathOnlySource = new File([], 'scan.pdf', { type: 'application/pdf' });
        Object.defineProperty(pathOnlySource, 'path', { value: 'D:\\scan.pdf' });
        const loadedSource = await pdfFileWithPages(3);
        const getWorkingFile = vi.fn().mockResolvedValue(pathOnlySource);
        const store = useDocumentCleanupStore.getState();
        store.initTab('tab-pdf-path-only');
        store.setOptions('tab-pdf-path-only', { ...store.getTab('tab-pdf-path-only').options, operation: 'scan' });
        store.addItems('tab-pdf-path-only', [{
            id: 'pdf-path-only', path: 'D:\\scan.pdf', fileName: loadedSource.name,
            originalUrl: 'blob:pdf-path-only', status: 'pending', fileObj: loadedSource,
        }]);

        await processDocumentCleanupBatch('tab-pdf-path-only', undefined, { sourceFile: pathOnlySource, getWorkingFile });

        const processCall = apiMocks.authenticatedFetch.mock.calls.find(([url]) => String(url).endsWith('/document-cleanup/process'));
        const request = processCall?.[1] as { body: FormData };
        const uploaded = request.body.get('file');
        expect((await PDFDocument.load(await readBlob(uploaded as File))).getPageCount()).toBe(3);
    });

    it('không báo thành công khi viewer từ chối commit PDF kết quả', async () => {
        const output = new Blob(['pdf'], { type: 'application/pdf' });
        apiMocks.authenticatedFetch.mockImplementation(async (url: string) => {
            if (url.includes('/document-cleanup/jobs/')) return {
                ok: true,
                json: async () => ({ current: 1, total: 1, phase: 'complete', terminal: true }),
            };
            return { ok: true, blob: async () => output };
        });
        const file = new File(['%PDF-1.4'], 'scan.pdf', { type: 'application/pdf' });
        const store = useDocumentCleanupStore.getState();
        store.initTab('tab-pdf-blocked');
        store.setOptions('tab-pdf-blocked', { ...store.getTab('tab-pdf-blocked').options, operation: 'scan' });
        store.addItems('tab-pdf-blocked', [{
            id: 'pdf-2', path: 'browser-file', fileName: file.name,
            originalUrl: 'blob:pdf', status: 'pending', fileObj: file,
        }]);

        await processDocumentCleanupBatch('tab-pdf-blocked', vi.fn().mockResolvedValue(false));

        const item = useDocumentCleanupStore.getState().getTab('tab-pdf-blocked').batchItems[0];
        expect(item.status).toBe('error');
        expect(item.error).toContain('khung xem');
    });
});
