// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFString } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import OpenInDesignModal from './OpenInDesignModal';

const mocks = vi.hoisted(() => ({
    invoke: vi.fn(),
    openDialog: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/path', () => ({
    tempDir: vi.fn(async () => 'C:\\Temp'),
    join: vi.fn(async (...parts: string[]) => parts.join('\\')),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.openDialog }));
vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string, options?: { n?: number }) => {
            const name = key.split(':').pop() || key;
            return name === 'to_so' ? `Tờ ${options?.n}` : name;
        },
    }),
}));

const ILLUSTRATOR = 'C:\\Program Files\\Adobe\\Adobe Illustrator 2025\\Illustrator.exe';
const CUSTOM_ILLUSTRATOR = 'D:\\Design Apps\\Adobe Illustrator 2026\\Illustrator.exe';
const COREL = 'C:\\Program Files\\Corel\\CorelDRAW Graphics Suite\\CorelDRW.exe';
const CUSTOM_COREL = 'E:\\Design Apps\\CorelDRAW\\CorelDRW.exe';
const DESIGN_APPS_LS_KEY = 'prynx.designApps.v1';
const GRAPH_INFO_NAME = 'SA info AUDIT GRAPH';
const LAYER_NAME = 'Marks_Model_AUDIT';
const GROUP_NAME = 'MarkLine_AUDIT';
const ITEM_NAME = 'MKLINE_AUDIT';

/** Dựng đúng kiểu artifact CNC: layer Graphtec/layer cha rỗng, group con chứa nét ốc. */
function attachPontLayerTree(doc: PDFDocument, pageIndex: number): void {
    const graphInfoRef = doc.context.register(
        doc.context.obj({ Type: 'OCG', Name: PDFString.of(GRAPH_INFO_NAME) }),
    );
    const layerRef = doc.context.register(
        doc.context.obj({ Type: 'OCG', Name: PDFString.of(LAYER_NAME) }),
    );
    const groupRef = doc.context.register(
        doc.context.obj({ Type: 'OCG', Name: PDFString.of(GROUP_NAME) }),
    );
    const page = doc.getPage(pageIndex);
    page.node.set(
        PDFName.of('Contents'),
        doc.context.register(doc.context.stream(
            '/OC /MarkGroup BDC /Span /MarkItem BDC 0 0 0 RG 10 10 20 20 re S EMC EMC',
        )),
    );
    page.node.set(PDFName.of('Resources'), doc.context.obj({
        Properties: {
            MarkGroup: groupRef,
            MarkItem: { NM: PDFString.of(ITEM_NAME) },
        },
    }));
    doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({
        OCGs: [graphInfoRef, layerRef, groupRef],
        D: {
            BaseState: PDFName.of('ON'),
            ON: [graphInfoRef, layerRef, groupRef],
            Order: [graphInfoRef, layerRef, [groupRef]],
        },
    }));
}

function optionalContentProps(doc: PDFDocument): PDFDict | undefined {
    return doc.catalog.lookupMaybe(PDFName.of('OCProperties'), PDFDict);
}

function ocgNames(doc: PDFDocument): string[] {
    const ocgs = optionalContentProps(doc)?.lookupMaybe(PDFName.of('OCGs'), PDFArray);
    const names: string[] = [];
    for (let i = 0; ocgs && i < ocgs.size(); i += 1) {
        const dict = ocgs.lookupMaybe(i, PDFDict);
        const name = dict?.lookupMaybe(PDFName.of('Name'), PDFString)?.decodeText();
        if (name) names.push(name);
    }
    return names;
}

function orderNames(doc: PDFDocument, order: PDFArray | undefined): Array<string | unknown[]> {
    const names: Array<string | unknown[]> = [];
    for (let i = 0; order && i < order.size(); i += 1) {
        const raw = order.get(i);
        if (raw instanceof PDFRef) {
            const name = doc.context
                .lookupMaybe(raw, PDFDict)
                ?.lookupMaybe(PDFName.of('Name'), PDFString)
                ?.decodeText();
            if (name) names.push(name);
            continue;
        }
        const nested = order.lookupMaybe(i, PDFArray);
        if (nested) names.push(orderNames(doc, nested));
    }
    return names;
}

function pageProperties(doc: PDFDocument): PDFDict | undefined {
    return doc.getPage(0).node
        .lookupMaybe(PDFName.of('Resources'), PDFDict)
        ?.lookupMaybe(PDFName.of('Properties'), PDFDict);
}

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
        mocks.openDialog.mockReset();
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

    it.each([
        {
            name: 'Illustrator',
            which: 'illustrator' as const,
            label: /Adobe Illustrator/,
            detectedPath: ILLUSTRATOR,
            selectedPath: CUSTOM_ILLUSTRATOR,
            detectedApps: { illustrator: ILLUSTRATOR, corel: null },
        },
        {
            name: 'CorelDRAW',
            which: 'corel' as const,
            label: /CorelDRAW/,
            detectedPath: COREL,
            selectedPath: CUSTOM_COREL,
            detectedApps: { illustrator: null, corel: COREL },
        },
    ])('ưu tiên đường dẫn $name vừa chọn hơn kết quả tự dò', async ({
        which, label, detectedPath, selectedPath, detectedApps,
    }) => {
        mocks.openDialog.mockResolvedValue(selectedPath);
        mocks.invoke.mockImplementation((command: string) => {
            if (command === 'detect_design_apps') return Promise.resolve(detectedApps);
            return Promise.resolve();
        });

        renderModal();

        await screen.findByText(detectedPath);
        fireEvent.click(screen.getByText('chon_lai'));
        await waitFor(() => {
            const saved = JSON.parse(localStorage.getItem(DESIGN_APPS_LS_KEY) || '{}');
            expect(saved[which]).toBe(selectedPath);
        });
        expect(await screen.findByText(selectedPath)).toBeTruthy();

        fireEvent.click(screen.getByLabelText('ca_khuon_va_in'));
        fireEvent.click(screen.getByRole('button', { name: label }));

        await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('launch_external_app', {
            appPath: selectedPath,
            filePath: 'D:\\jobs\\Imposed_order.pdf',
        }));
    });

    it('giữ đường dẫn thủ công đã lưu sau khi bộ dò chạy lại', async () => {
        localStorage.setItem(DESIGN_APPS_LS_KEY, JSON.stringify({ illustrator: CUSTOM_ILLUSTRATOR }));
        let resolveDetection!: (value: { illustrator: string | null; corel: string | null }) => void;
        const pending = new Promise<{ illustrator: string | null; corel: string | null }>(resolve => {
            resolveDetection = resolve;
        });
        mocks.invoke.mockImplementation((command: string) => {
            if (command === 'detect_design_apps') return pending;
            return Promise.resolve();
        });

        renderModal();
        expect(await screen.findByText(CUSTOM_ILLUSTRATOR)).toBeTruthy();

        await act(async () => {
            resolveDetection({ illustrator: ILLUSTRATOR, corel: null });
            await pending;
        });

        expect(screen.getByText(CUSTOM_ILLUSTRATOR)).toBeTruthy();
        expect(screen.queryByText(ILLUSTRATOR)).toBeNull();
        fireEvent.click(screen.getByLabelText('ca_khuon_va_in'));
        fireEvent.click(screen.getByRole('button', { name: /Adobe Illustrator/ }));
        await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('launch_external_app', {
            appPath: CUSTOM_ILLUSTRATOR,
            filePath: 'D:\\jobs\\Imposed_order.pdf',
        }));
    });

    it('vẫn dùng được đường dẫn thủ công khi bộ dò không tìm thấy ứng dụng', async () => {
        mocks.openDialog.mockResolvedValue(CUSTOM_ILLUSTRATOR);
        mocks.invoke.mockImplementation((command: string) => {
            if (command === 'detect_design_apps') {
                return Promise.resolve({ illustrator: null, corel: null });
            }
            return Promise.resolve();
        });

        renderModal();
        await screen.findAllByText('khong_tim_thay_tren_may');
        fireEvent.click(screen.getAllByText('chon_thu_cong')[0]);
        expect(await screen.findByText(CUSTOM_ILLUSTRATOR)).toBeTruthy();

        fireEvent.click(screen.getByLabelText('ca_khuon_va_in'));
        fireEvent.click(screen.getByRole('button', { name: /Adobe Illustrator/ }));
        await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('launch_external_app', {
            appPath: CUSTOM_ILLUSTRATOR,
            filePath: 'D:\\jobs\\Imposed_order.pdf',
        }));
    });

    it('giữ nguyên đường dẫn tự dò khi người dùng hủy hộp chọn lại', async () => {
        mocks.openDialog.mockResolvedValue(null);
        mocks.invoke.mockImplementation((command: string) => {
            if (command === 'detect_design_apps') {
                return Promise.resolve({ illustrator: ILLUSTRATOR, corel: null });
            }
            return Promise.resolve();
        });

        renderModal();
        await screen.findByText(ILLUSTRATOR);
        fireEvent.click(screen.getByText('chon_lai'));
        await waitFor(() => expect(mocks.openDialog).toHaveBeenCalledOnce());

        expect(screen.getByText(ILLUSTRATOR)).toBeTruthy();
        expect(localStorage.getItem(DESIGN_APPS_LS_KEY)).toBeNull();
        fireEvent.click(screen.getByLabelText('ca_khuon_va_in'));
        fireEvent.click(screen.getByRole('button', { name: /Adobe Illustrator/ }));
        await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('launch_external_app', {
            appPath: ILLUSTRATOR,
            filePath: 'D:\\jobs\\Imposed_order.pdf',
        }));
    });

    it('đánh dấu thumbnail khuôn là render nền', async () => {
        const source = await PDFDocument.create();
        source.addPage([100, 110]);
        source.addPage([200, 210]);
        source.addPage([300, 310]);
        source.addPage([400, 410]);
        attachPontLayerTree(source, 1);
        attachPontLayerTree(source, 3);
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

        const thumbnail = await screen.findByAltText('Tờ 1') as HTMLImageElement;
        expect(thumbnail.src).toContain('purpose=background');
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
        attachPontLayerTree(source, 1);
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

        // OCG FIX (audit 2026-08-07 §PONTLAYER.1-.2): trích riêng trang khuôn không được
        // làm mất Graphtec info/layer cha rỗng, group chứa nét hoặc tên item `/NM`.
        expect(ocgNames(output)).toEqual([GRAPH_INFO_NAME, LAYER_NAME, GROUP_NAME]);
        const config = optionalContentProps(output)?.lookupMaybe(PDFName.of('D'), PDFDict);
        expect(orderNames(output, config?.lookupMaybe(PDFName.of('Order'), PDFArray))).toEqual([
            GRAPH_INFO_NAME,
            LAYER_NAME,
            [GROUP_NAME],
        ]);
        const properties = pageProperties(output);
        const groupRef = properties?.get(PDFName.of('MarkGroup'));
        expect(groupRef).toBeInstanceOf(PDFRef);
        expect(
            optionalContentProps(output)
                ?.lookupMaybe(PDFName.of('OCGs'), PDFArray)
                ?.asArray()
                .some(ref => ref instanceof PDFRef && ref.tag === (groupRef as PDFRef).tag),
        ).toBe(true);
        expect(
            properties
                ?.lookupMaybe(PDFName.of('MarkItem'), PDFDict)
                ?.lookupMaybe(PDFName.of('NM'), PDFString)
                ?.decodeText(),
        ).toBe(ITEM_NAME);
    });
});
