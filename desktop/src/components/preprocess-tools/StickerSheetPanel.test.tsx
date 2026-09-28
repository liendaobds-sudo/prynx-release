// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    confirmStickerSource,
    detectStickerSource,
    inspectStickerSource,
    previewStickerCutline,
    refineStickerSource,
    type StickerCutlinePreview,
} from '../../lib/stickerSheetApi';
import { imageFilesToPdfFile } from '../../lib/imageNormalizer';
import StickerSheetPanel from './StickerSheetPanel';
import { useStickerSheetStore, type StickerSheetTabState } from './stickerSheetStore';

function patchTab(patch: Partial<StickerSheetTabState>): void {
    useStickerSheetStore.setState(state => ({
        tabs: { ...state.tabs, tab: { ...state.tabs.tab, ...patch } },
    }));
}

function simplifiedPreview(patch: Partial<StickerCutlinePreview> = {}): StickerCutlinePreview {
    return {
        page_number: 1, mask_revision: 1, preview_width_px: 1200, preview_height_px: 900,
        paths: [{ instance_id: 1, d: 'M 1 1 C 2 2 3 3 4 4 Z', segment_count: 76,
            quality: { simplification: { before_segments: 99, after_segments: 40,
                maximum_error_bound_mm: 0.05, changed: true } } }],
        fingerprint: 'b'.repeat(64), segment_count: 76,
        quality: { simplification: { before_segments: 200, after_segments: 76,
            maximum_error_bound_mm: 0.099001, changed: true } },
        ...patch,
    };
}


vi.mock('../../lib/stickerSheetApi', async importOriginal => {
    const actual = await importOriginal<typeof import('../../lib/stickerSheetApi')>();
    return {
        ...actual,
        confirmStickerSource: vi.fn(async () => true),
        detectStickerSource: vi.fn(),
        inspectStickerSource: vi.fn(),
        previewStickerCutline: vi.fn(),
        refineStickerSource: vi.fn(),
    };
});
vi.mock('../../lib/imageNormalizer', async importOriginal => {
    const actual = await importOriginal<typeof import('../../lib/imageNormalizer')>();
    return {
        ...actual,
        imageFilesToPdfFile: vi.fn(),
    };
});

describe('StickerSheetPanel', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            value: vi.fn(() => 'blob:source'),
        });
        vi.mocked(previewStickerCutline).mockResolvedValue({
            page_number: 1, mask_revision: 1,
            preview_width_px: 1200, preview_height_px: 900,
            paths: [{ instance_id: 1, d: 'M 1 1 C 2 2 3 3 4 4 Z', segment_count: 1 }],
            fingerprint: 'a'.repeat(64), segment_count: 1,
        });
        useStickerSheetStore.setState({
            tabs: {
                tab: {
                    ...useStickerSheetStore.getState().getTab('new'),
                    status: 'mask-review',
                    sourceFile: new File(['image'], 'sheet.png', { type: 'image/png' }),
                    manifest: {
                        session_id: 'a'.repeat(32), original_name: 'sheet.png',
                        stage: 'mask-review', source_kind: 'raster', boundary_source: 'ai',
                        strategy_confidence: 0.98, needs_review: true, page_count: 1, source_page: 1,
                        vector_geometry_ref: null,
                        original_width_px: 1200, original_height_px: 900,
                        analysis_width_px: 1200, analysis_height_px: 900,
                        preview_width_px: 1200, preview_height_px: 900,
                        dpi: null, model: 'birefnet-lite', model_seconds: 2,
                        postprocess_seconds: 0.2,
                        mask_revision: 1, refinement_available: true,
                        alpha_threshold: 128, shadow_cleanup: 'auto',
                        instances: [
                            { id: 1, x: 0, y: 0, width: 50, height: 50, area_px: 2000, confidence: 0.9, uncertain_ratio: 0.1 },
                            { id: 2, x: 60, y: 0, width: 50, height: 50, area_px: 2000, confidence: 0.5, uncertain_ratio: 0.5 },
                        ],
                        warnings: [], preview_url: '/preview', labels_url: '/labels', uncertainty_url: '/uncertainty',
                    },
                    previewUrl: 'blob:preview', labelsUrl: 'blob:labels', uncertaintyUrl: 'blob:uncertainty',
                    selectedInstanceId: 1,
                },
            },
        });
    });

    describe('AUTO Simplify', () => {
        it('ẩn số đo cũ lúc chờ, hiển thị tổng preview rồi bỏ số đo khi đổi thông số', () => {
            patchTab({ isCutlinePreviewing: true, cutlinePreview: simplifiedPreview() });
            render(<StickerSheetPanel tabId="tab" />);
            const status = screen.getByTestId('sticker-sheet-cutline-quality');
            expect(within(status).getByText('Tự động')).toBeTruthy();
            expect(within(status).getByText('Đang cập nhật đường đơn giản hóa…')).toBeTruthy();
            expect(within(status).queryByText(/Điểm neo:/)).toBeNull();

            act(() => patchTab({ isCutlinePreviewing: false, cutlinePreview: simplifiedPreview() }));
            expect(within(status).getByText('Điểm neo: 200 → 76 · Cận sai lệch thêm: 0.100 mm')).toBeTruthy();
            expect(within(status).queryByText(/99 → 40/)).toBeNull();
            fireEvent.change(screen.getByRole('slider', { name: 'Mức khử răng cưa đường bế' }), {
                target: { value: '45' },
            });
            expect(within(status).getByText('Đang cập nhật đường đơn giản hóa…')).toBeTruthy();
            expect(within(status).queryByText(/Điểm neo:/)).toBeNull();
            act(() => useStickerSheetStore.getState().disposeTab('tab'));
        });

        it.each(['refining', 'error', 'missing-quality', 'revision', 'page', 'manifest-page', 'dimensions'] as const)(
            'không công bố số đo thành công với %s', reason => {
                const current = useStickerSheetStore.getState().getTab('tab');
                if (!current.manifest) throw new Error('Thiếu fixture manifest');
                const preview = simplifiedPreview();
                const patch: Partial<StickerSheetTabState> = { cutlinePreview: preview };
                if (reason === 'refining') patch.isRefining = true;
                if (reason === 'error') patch.error = 'Không cập nhật được preview.';
                if (reason === 'missing-quality') preview.quality = null;
                if (reason === 'revision') patch.manifest = { ...current.manifest, mask_revision: 2 };
                if (reason === 'page') patch.activeSourcePage = 2;
                if (reason === 'manifest-page') patch.manifest = { ...current.manifest, source_page: 2 };
                if (reason === 'dimensions') preview.preview_width_px = 1199;
                patchTab(patch);
                render(<StickerSheetPanel tabId="tab" />);
                const status = screen.getByTestId('sticker-sheet-cutline-quality');
                expect(within(status).queryByText(/Điểm neo:/)).toBeNull();
                expect(within(status).queryByText('Giữ nguyên đường cắt.')).toBeNull();
                expect(within(status).getByText(reason === 'refining'
                    ? 'Đang cập nhật đường đơn giản hóa…'
                    : 'Chưa có số đo đường mới; hãy chờ xem trước hoàn tất.')).toBeTruthy();
            },
        );

        it('giữ nguyên chỉ được hiển thị sau khi có số đo hợp lệ của đúng lượt', () => {
            patchTab({ cutlinePreview: simplifiedPreview({ quality: { simplification: {
                before_segments: 76, after_segments: 76, maximum_error_bound_mm: 0, changed: false,
            } } }) });
            render(<StickerSheetPanel tabId="tab" />);
            const status = screen.getByTestId('sticker-sheet-cutline-quality');
            expect(within(status).getByText('Điểm neo: 76 → 76 · Cận sai lệch thêm: 0.000 mm')).toBeTruthy();
            expect(within(status).getByText('Giữ nguyên đường cắt.')).toBeTruthy();
        });

        it('chuyển trang lấy đúng số đo đã chốt của trang đó và bỏ số đo khi revision đổi', () => {
            const current = useStickerSheetStore.getState().getTab('tab');
            if (!current.manifest) throw new Error('Thiếu fixture manifest');
            const first = simplifiedPreview();
            const second = simplifiedPreview({ page_number: 2, quality: { simplification: {
                before_segments: 300, after_segments: 90, maximum_error_bound_mm: 0.081001, changed: true,
            } } });
            patchTab({ sourceImageCount: 2, cutlinePreview: first, pages: {
                1: { ...current, cutlinePreview: first },
                2: { ...current, manifest: { ...current.manifest, source_page: 2 }, cutlinePreview: second },
            } });
            render(<StickerSheetPanel tabId="tab" pageOrder={[1, 2]} />);
            const status = screen.getByTestId('sticker-sheet-cutline-quality');
            expect(within(status).getByText(/200 → 76/)).toBeTruthy();
            act(() => useStickerSheetStore.getState().setActivePage('tab', 2));
            expect(within(status).queryByText(/200 → 76/)).toBeNull();
            expect(within(status).getByText('Điểm neo: 300 → 90 · Cận sai lệch thêm: 0.082 mm')).toBeTruthy();
            act(() => patchTab({ manifest: { ...current.manifest!, source_page: 2, mask_revision: 2 } }));
            expect(within(status).queryByText(/Điểm neo:/)).toBeNull();
            expect(within(status).getByText('Chưa có số đo đường mới; hãy chờ xem trước hoàn tất.')).toBeTruthy();
        });

        it.each(['nonfinite', 'negative', 'increased', 'empty'] as const)('không trình bày metadata %s thành thành công', reason => {
            const preview = simplifiedPreview();
            const stats = preview.quality!.simplification!;
            if (reason === 'nonfinite') stats.maximum_error_bound_mm = Number.NaN;
            if (reason === 'negative') stats.maximum_error_bound_mm = -0.1;
            if (reason === 'increased') stats.after_segments = stats.before_segments + 1;
            if (reason === 'empty') stats.before_segments = stats.after_segments = 0;
            patchTab({ cutlinePreview: preview });
            render(<StickerSheetPanel tabId="tab" />);
            const status = screen.getByTestId('sticker-sheet-cutline-quality');
            expect(within(status).queryByText(/Điểm neo:/)).toBeNull();
            expect(within(status).getByText('Chưa có số đo đường mới; hãy chờ xem trước hoàn tất.')).toBeTruthy();
        });

        it.each(['alpha', 'simple-bg', 'ai', 'manual'] as const)('hiển thị tự động cho nguồn %s đã nhận diện', boundarySource => {
            const current = useStickerSheetStore.getState().getTab('tab');
            if (!current.manifest) throw new Error('Thiếu fixture manifest');
            patchTab({ manifest: { ...current.manifest, boundary_source: boundarySource } });
            render(<StickerSheetPanel tabId="tab" />);
            expect(screen.getByTestId('sticker-sheet-cutline-quality')).toBeTruthy();
        });

        it.each(['existing-cut', 'vector', 'page-box', 'preserved', 'none', 'undetected'] as const)(
            'không bày AUTO cho nhánh cần bảo toàn %s', reason => {
                const current = useStickerSheetStore.getState().getTab('tab');
                if (!current.manifest) throw new Error('Thiếu fixture manifest');
                if (reason === 'none') patchTab({ outputSettings: { ...current.outputSettings, cutMode: 'none' } });
                else if (reason === 'undetected') patchTab({ status: 'source-ready', manifest: null });
                else patchTab({ manifest: { ...current.manifest,
                    boundary_source: reason === 'preserved' ? 'alpha' : reason,
                    vector_geometry_ref: reason === 'preserved' ? { preserve_original: true } : null,
                } });
                render(<StickerSheetPanel tabId="tab" />);
                expect(screen.queryByTestId('sticker-sheet-cutline-quality')).toBeNull();
            },
        );
    });

    it('hiển thị số tem và chuyển công cụ mà không bày nút rà soát mơ hồ', () => {
        render(<StickerSheetPanel tabId="tab" />);
        expect(screen.getByText(/Đã nhận diện/).textContent).toContain('Đã nhận diện 2 tem');
        expect(screen.queryByText('Cần kiểm tra đường cắt')).toBeNull();
        expect(screen.queryByText(/Độ tin cậy/)).toBeNull();
        expect(screen.queryByText(/BiRefNet|OpenCV/i)).toBeNull();
        expect(screen.queryByRole('button', { name: 'Điểm cần kiểm tra tiếp theo' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Hoàn tác' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Làm lại' })).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Giữ lại' }));
        expect(useStickerSheetStore.getState().getTab('tab').activeTool).toBe('restore');
    });

    it('nguồn vector vẫn giữ thanh chỉnh đường bế và không hiện cảnh báo kỹ thuật', () => {
        const current = useStickerSheetStore.getState().getTab('tab');
        if (!current.manifest) throw new Error('Thiếu fixture manifest');
        useStickerSheetStore.setState({
            tabs: {
                tab: {
                    ...current,
                    manifest: {
                        ...current.manifest,
                        boundary_source: 'vector',
                        refinement_available: false,
                        strategy_confidence: 0.72,
                        needs_review: true,
                        instances: current.manifest.instances.slice(0, 1),
                        warnings: [
                            'round-sticker-contour-inferred',
                            'vector-mask-raster-preview',
                            'Chỉ nhận diện được một tem trong nguồn.',
                        ],
                    },
                },
            },
        });

        render(<StickerSheetPanel tabId="tab" />);

        expect(screen.getByText(/Đã nhận diện/).textContent).toContain('Đã nhận diện 1 tem');
        expect(screen.queryByText('Cần kiểm tra đường cắt')).toBeNull();
        expect(screen.queryByText(/Độ tin cậy/)).toBeNull();
        expect(screen.queryByText(/Đã phát hiện tem tròn bên trong nền ảnh vuông/)).toBeNull();
        expect(screen.queryByText(/Vùng tem được suy ra từ nội dung vector/)).toBeNull();
        expect(screen.queryByText(/Chỉ nhận diện được một tem trong nguồn/)).toBeNull();
        expect(screen.getByRole('slider', { name: 'Mức bám sát hình gốc' })).toBeTruthy();
        expect(screen.getByRole('slider', { name: 'Độ bo cong đường bế' })).toBeTruthy();
        expect(screen.getByRole('slider', { name: 'Mức lọc chi tiết rời' })).toBeTruthy();
        expect(screen.queryByText('Khử bóng')).toBeNull();
    });

    it('gom cả nút xuất vào cùng khung thiết lập sau khi vùng tem sẵn sàng', async () => {
        render(<StickerSheetPanel tabId="tab" onExport={vi.fn()} onExportPng={vi.fn()} />);

        const settingsToggle = screen.getByRole('button', { name: /Thiết lập bù xén/ });
        expect(settingsToggle.getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByText('Kích thước và đường cắt')).toBeTruthy();
        const settingsRegion = document.getElementById('sticker-settings-tab');
        expect(settingsRegion).not.toBeNull();
        expect(within(settingsRegion as HTMLElement).getByRole('button', { name: 'Lưu bộ PNG' })).toBeTruthy();
        expect(within(settingsRegion as HTMLElement).getByRole('button', { name: 'Tạo PDF có đường cắt' })).toBeTruthy();

        const current = useStickerSheetStore.getState().getTab('tab');
        useStickerSheetStore.setState({
            tabs: {
                tab: {
                    ...current,
                    status: 'mask-ready',
                    pages: {
                        1: {
                            ...(current.pages[1] || current),
                            status: 'mask-ready',
                        },
                    },
                },
            },
        });

        await waitFor(() => expect(
            screen.getByRole('button', { name: /Thiết lập bù xén/ }).getAttribute('aria-expanded'),
        ).toBe('false'));
        expect(screen.queryByRole('button', { name: 'Lưu bộ PNG' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Tạo PDF có đường cắt' })).toBeNull();
    });

    it('cho xổ lại cả thiết lập lẫn nút xuất sau khi đã thu gọn', async () => {
        const current = useStickerSheetStore.getState().getTab('tab');
        useStickerSheetStore.setState({
            tabs: {
                tab: {
                    ...current,
                    status: 'mask-ready',
                    pages: {
                        1: {
                            ...(current.pages[1] || current),
                            status: 'mask-ready',
                        },
                    },
                },
            },
        });

        render(<StickerSheetPanel tabId="tab" onExport={vi.fn()} onExportPng={vi.fn()} />);
        const settingsToggle = screen.getByRole('button', { name: /Thiết lập bù xén/ });
        expect(settingsToggle.getAttribute('aria-expanded')).toBe('false');
        expect(screen.queryByText('Kích thước và đường cắt')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Lưu bộ PNG' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Tạo PDF có đường cắt' })).toBeNull();

        fireEvent.click(settingsToggle);

        await waitFor(() => expect(
            screen.getByRole('button', { name: /Thiết lập bù xén/ }).getAttribute('aria-expanded'),
        ).toBe('true'));
        expect(screen.getByText('Kích thước và đường cắt')).toBeTruthy();
        expect(screen.getByText('Cách tạo PDF')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Lưu bộ PNG' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Tạo PDF có đường cắt' })).toBeTruthy();
    });

    it('chỉ hiện hai nút lịch sử dạng gọn sau khi có chỉnh sửa', () => {
        const current = useStickerSheetStore.getState().getTab('tab');
        useStickerSheetStore.setState({
            tabs: {
                tab: {
                    ...current,
                    edits: [{
                        kind: 'stroke', id: 'stroke-1', tool: 'erase', instanceId: 1,
                        radius: 0.015, points: [{ x: 0.25, y: 0.25 }],
                    }],
                    redoEdits: [],
                },
            },
        });

        render(<StickerSheetPanel tabId="tab" />);

        const undo = screen.getByRole('button', { name: 'Hoàn tác' }) as HTMLButtonElement;
        const redo = screen.getByRole('button', { name: 'Làm lại' }) as HTMLButtonElement;
        expect(undo.disabled).toBe(false);
        expect(redo.disabled).toBe(true);
        expect(undo.textContent).toBe('');
        expect(redo.textContent).toBe('');
        expect(screen.queryByRole('button', { name: 'Điểm cần kiểm tra tiếp theo' })).toBeNull();
    });

    it('sau nhận diện cho xuất ngay và chọn giữ nguyên tấm hoặc tách từng tem', () => {
        render(<StickerSheetPanel tabId="tab" onExport={vi.fn()} />);
        expect(screen.queryByRole('group', { name: 'Thiết lập đường bế tem' })).toBeNull();
        expect(screen.getByText('Kích thước và đường cắt')).toBeTruthy();
        expect(screen.getByText('Offset')).toBeTruthy();
        expect(screen.getByText('Tràn lề')).toBeTruthy();
        expect(screen.queryByText('Chế độ đường cắt')).toBeNull();
        expect(screen.queryByText('Bù xén ngoài đường cắt')).toBeNull();
        expect(screen.queryByText(/Ảnh không có DPI|300 DPI/)).toBeNull();
        expect(screen.queryByText('DPI X')).toBeNull();
        expect(screen.queryByText('DPI Y')).toBeNull();
        expect(screen.queryByText(/Khổ toàn ảnh/)).toBeNull();
        expect(screen.queryByText(/Ảnh gốc/)).toBeNull();
        expect(screen.queryByText(/Không giảm độ phân giải/)).toBeNull();
        expect(screen.queryByRole('button', { name: 'Xác nhận vùng tem' })).toBeNull();
        expect(screen.queryByText('Vùng tem đã được xác nhận')).toBeNull();
        expect(screen.getByRole('group', { name: 'Cách tạo PDF' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Tách từng tem' }).getAttribute('aria-pressed')).toBe('true');
        fireEvent.click(screen.getByRole('button', { name: 'Giữ nguyên tấm' }));
        expect(useStickerSheetStore.getState().getTab('tab').outputSettings.cropToSticker).toBe(false);
        expect((screen.getByRole('button', { name: 'Tạo PDF có đường cắt' }) as HTMLButtonElement).disabled).toBe(false);
    });

    it('cho ảnh nhiều tem chọn đủ cách tạo màu tràn lề và nhập CMYK màu trơn', async () => {
        render(<StickerSheetPanel tabId="tab" onExport={vi.fn()} />);

        const bleedColorGroup = screen.getByRole('group', { name: 'Màu bù xén' });
        fireEvent.click(within(bleedColorGroup).getByRole('button', { name: /Lấy theo màu viền tem/ }));
        expect(within(bleedColorGroup).getAllByRole('button')).toHaveLength(5);
        expect(within(bleedColorGroup).getByRole('button', { name: /Theo quỹ đạo dải màu/ })).toBeTruthy();
        expect(within(bleedColorGroup).getByRole('button', { name: /Làm mượt thông minh/ })).toBeTruthy();
        fireEvent.click(within(bleedColorGroup).getByRole('button', { name: /Đổ màu trơn/ }));

        await waitFor(() => expect(
            useStickerSheetStore.getState().getTab('tab').outputSettings.bleedColorType,
        ).toBe('solid'));
        expect(useStickerSheetStore.getState().getTab('tab').isCutlinePreviewing).toBe(false);
        expect(previewStickerCutline).not.toHaveBeenCalled();

        const cmykGroup = await screen.findByRole('group', { name: 'Màu bù xén CMYK' });
        const cyan = within(cmykGroup).getByRole('spinbutton', { name: 'C (%)' }) as HTMLInputElement;
        await waitFor(() => expect(cyan.disabled).toBe(false));
        fireEvent.change(cyan, { target: { value: '35' } });

        expect(useStickerSheetStore.getState().getTab('tab').outputSettings.solidBleedCmyk)
            .toEqual([35, 0, 0, 0]);
        expect(useStickerSheetStore.getState().getTab('tab').isCutlinePreviewing).toBe(false);
        expect(previewStickerCutline).not.toHaveBeenCalled();
    });

    it.each(['image', 'trajectory', 'inpaint', 'solid'] as const)(
        'ẩn toàn bộ lựa chọn màu %s khi tràn lề bằng 0', bleedColorType => {
            const current = useStickerSheetStore.getState().getTab('tab');
            useStickerSheetStore.setState({ tabs: { tab: { ...current,
                outputSettings: { ...current.outputSettings, bleedMm: 0, bleedColorType },
            } } });
            render(<StickerSheetPanel tabId="tab" />);
            expect(screen.getByText('Tràn lề')).toBeTruthy();
            expect(screen.queryByRole('group', { name: 'Màu bù xén' })).toBeNull();
            expect(screen.queryByRole('group', { name: 'Màu bù xén CMYK' })).toBeNull();
            expect(screen.queryByText('Màu bù xén')).toBeNull();
        },
    );

    it('đổi tràn lề 2 → 0 → 0,5 ẩn rồi hiện lại màu đã chọn, không tự nhận diện', () => {
        const current = useStickerSheetStore.getState().getTab('tab');
        useStickerSheetStore.setState({ tabs: { tab: { ...current,
            outputSettings: { ...current.outputSettings, bleedMm: 2, bleedColorType: 'solid',
                solidBleedCmyk: [35, 20, 0, 10] },
        } } });
        render(<StickerSheetPanel tabId="tab" />);
        const bleedInput = within(screen.getByText('Tràn lề').parentElement!).getByRole('spinbutton');
        expect(screen.getByRole('group', { name: 'Màu bù xén CMYK' })).toBeTruthy();
        fireEvent.change(bleedInput, { target: { value: '0' } });
        expect(useStickerSheetStore.getState().getTab('tab').outputSettings.bleedMm).toBe(0);
        expect(screen.queryByRole('group', { name: 'Màu bù xén' })).toBeNull();
        expect(screen.queryByRole('group', { name: 'Màu bù xén CMYK' })).toBeNull();
        fireEvent.change(bleedInput, { target: { value: '0.5' } });
        expect(screen.getByRole('group', { name: 'Màu bù xén' })).toBeTruthy();
        expect((screen.getByRole('spinbutton', { name: 'C (%)' }) as HTMLInputElement).value).toBe('35');
        expect(useStickerSheetStore.getState().getTab('tab').outputSettings).toMatchObject({
            bleedMm: 0.5, bleedColorType: 'solid', solidBleedCmyk: [35, 20, 0, 10],
        });
        expect(detectStickerSource).not.toHaveBeenCalled();
        expect(inspectStickerSource).not.toHaveBeenCalled();
        expect(previewStickerCutline).not.toHaveBeenCalled();
    });

    it('khóa xuất theo đúng danh sách thumbnail hiện tại, không bắt trang đã xóa', async () => {
        useStickerSheetStore.getState().setActivePage('tab', 1);
        const current = useStickerSheetStore.getState().getTab('tab');
        const pageOne = current.pages[1];
        if (!pageOne) throw new Error('Thiếu fixture trang 1');
        useStickerSheetStore.setState({
            tabs: {
                tab: {
                    ...current,
                    status: 'mask-ready',
                    sourceImageCount: 2,
                    pages: {
                        1: { ...pageOne, status: 'mask-ready' },
                        2: {
                            ...pageOne,
                            status: 'source-ready',
                            manifest: null,
                            previewUrl: '',
                            labelsUrl: '',
                            uncertaintyUrl: '',
                        },
                    },
                },
            },
        });

        const { rerender } = render(
            <StickerSheetPanel tabId="tab" pageOrder={[1]} onExport={vi.fn()} />,
        );
        fireEvent.click(screen.getByRole('button', { name: /Thiết lập bù xén/ }));
        await waitFor(() => expect(
            (screen.getByRole('button', { name: 'Tạo PDF có đường cắt' }) as HTMLButtonElement).disabled,
        ).toBe(false));
        expect(screen.queryByText(/trang sẵn sàng/)).toBeNull();

        rerender(<StickerSheetPanel tabId="tab" pageOrder={[1, 2]} onExport={vi.fn()} />);
        expect((screen.getByRole('button', { name: 'Tạo PDF có đường cắt' }) as HTMLButtonElement).disabled)
            .toBe(true);
        expect(screen.getByText('1 trang còn cần nhận diện trước khi xuất.')).toBeTruthy();
        expect(screen.queryByText(/trang sẵn sàng/)).toBeNull();
    });

    it('một lần bấm tự chốt mask rồi gọi export, không có bước xác nhận riêng', async () => {
        const onExport = vi.fn();
        render(<StickerSheetPanel tabId="tab" onExport={onExport} />);
        expect(screen.queryByRole('button', { name: 'Xác nhận vùng tem' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Tạo PDF có đường cắt' }));
        await waitFor(() => expect(confirmStickerSource).toHaveBeenCalledWith(
            'a'.repeat(32),
            {
                pageNumber: 1,
                signal: expect.any(AbortSignal),
            },
        ));
        await waitFor(() => expect(
            useStickerSheetStore.getState().getTab('tab').status,
        ).toBe('mask-ready'));
        await waitFor(() => expect(onExport).toHaveBeenCalledTimes(1));
    });

    it('tách Bám sát và Độ bo cong, đồng thời khóa xuất lúc cập nhật', () => {
        render(<StickerSheetPanel tabId="tab" onExport={vi.fn()} />);
        const fidelity = screen.getByRole('slider', { name: 'Mức bám sát hình gốc' });
        const roundness = screen.getByRole('slider', { name: 'Độ bo cong đường bế' });
        const detail = screen.getByRole('slider', { name: 'Mức lọc chi tiết rời' });
        expect(screen.getByText('Xem và chỉnh đường bế')).toBeTruthy();
        expect(screen.getByText('1.50 mm')).toBeTruthy();
        expect(screen.queryByRole('slider', { name: 'Độ mượt đường bế' })).toBeNull();
        expect(screen.queryByRole('slider', { name: 'Sức căng đường cong' })).toBeNull();
        expect(screen.queryByText('Bám biên AI')).toBeNull();
        expect(screen.queryByText(/mask sẽ dùng khi xuất/)).toBeNull();

        fireEvent.change(fidelity, { target: { value: '82' } });
        fireEvent.change(roundness, { target: { value: '70' } });
        fireEvent.change(detail, { target: { value: '1.6' } });

        const state = useStickerSheetStore.getState().getTab('tab');
        expect(state.cutlineSmoothness).toBe(50);
        expect(state.curveTension).toBe(70);
        expect(state.cutlineFidelity).toBe(82);
        expect(state.minDetailAreaMm2).toBe(1.6);
        expect(state.outputSettings.cornerStyle).toBe('round');
        expect(screen.getByText('2.10 mm')).toBeTruthy();
        expect(state.isCutlinePreviewing).toBe(true);
        expect(screen.getByText('Đang cập nhật đường bế…')).toBeTruthy();
        expect((screen.getByRole('button', { name: 'Tạo PDF có đường cắt' }) as HTMLButtonElement).disabled).toBe(true);
        expect(refineStickerSource).not.toHaveBeenCalled();

        useStickerSheetStore.getState().disposeTab('tab');
    });

    it('điều khiển Co / giãn viền và Kiểu góc hiển thị trên mặt tiền và cập nhật thiết lập', () => {
        render(<StickerSheetPanel tabId="tab" onExport={vi.fn()} />);
        expect(screen.getByText('Co / giãn viền')).toBeTruthy();
        const offsetInput = screen.getByRole('spinbutton', { name: 'Co / giãn viền' });
        expect(offsetInput).toBeTruthy();

        // Nhập offset thu vào -0.8mm
        fireEvent.change(offsetInput, { target: { value: '-0.8' } });
        expect(useStickerSheetStore.getState().getTab('tab').outputSettings.offsetMm).toBe(-0.8);
        expect(screen.getByText('-0.8 mm (thu vào)')).toBeTruthy();

        // Bấm nút Đặt lại về 0mm
        const resetBtn = screen.getByRole('button', { name: 'Đặt lại' });
        fireEvent.click(resetBtn);
        expect(useStickerSheetStore.getState().getTab('tab').outputSettings.offsetMm).toBe(0);

        // Bấm chọn Kiểu góc tròn và góc nhọn
        const roundBtn = screen.getByRole('button', { name: '🟢 Góc tròn' });
        fireEvent.click(roundBtn);
        expect(useStickerSheetStore.getState().getTab('tab').outputSettings.cornerStyle).toBe('round');

        const miterBtn = screen.getByRole('button', { name: '🔺 Góc nhọn' });
        fireEvent.click(miterBtn);
        expect(useStickerSheetStore.getState().getTab('tab').outputSettings.cornerStyle).toBe('miter');

        useStickerSheetStore.getState().disposeTab('tab');
    });

    it('chọn ảnh chỉ tạo preview và nút nhận diện, không hiện thiết lập trước khi quét', () => {
        useStickerSheetStore.setState({ tabs: {} });
        const detectAction = vi.spyOn(
            useStickerSheetStore.getState(),
            'detectStickers',
        ).mockResolvedValue();
        const { container } = render(<StickerSheetPanel tabId="source-tab" />);
        const input = container.querySelector('input[type="file"]') as HTMLInputElement;
        const file = new File(['image'], 'source.png', { type: 'image/png' });

        fireEvent.change(input, { target: { files: [file] } });

        const state = useStickerSheetStore.getState().getTab('source-tab');
        expect(state.status).toBe('source-ready');
        expect(state.sourceFile).toBe(file);
        expect(state.sourcePreviewUrl).toBe('blob:source');
        expect(inspectStickerSource).not.toHaveBeenCalled();
        expect(detectStickerSource).not.toHaveBeenCalled();
        expect(state.outputSettings.offsetMm).toBe(0);
        expect(state.outputSettings.bleedMm).toBe(2);
        expect(screen.queryByText('Ảnh nhiều tem')).toBeNull();
        expect(screen.queryByRole('button', { name: 'source.png' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Chọn ảnh khác' })).toBeNull();
        expect(screen.queryByText(/Ảnh mới chỉ được nạp để xem trước/)).toBeNull();
        expect(screen.queryByRole('group', { name: 'Thiết lập đường bế tem' })).toBeNull();
        expect(screen.queryByText('Kích thước và đường cắt')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Xóa bóng' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Nhận diện trang hiện tại' }));
        expect(detectAction).toHaveBeenCalledWith('source-tab', 'auto', 1, undefined);
        detectAction.mockRestore();
    });

    it('PDF nhiều trang từ Viewer hiện nhận diện tất cả ngay trước bước inspect', () => {
        useStickerSheetStore.setState({ tabs: {} });
        const pdf = new File(['pdf'], 'hai_trang.pdf', { type: 'application/pdf' });
        useStickerSheetStore.getState().selectSource('viewer-pdf-tab', pdf, 'workspace');
        const detectAllAction = vi.spyOn(
            useStickerSheetStore.getState(),
            'detectAllStickers',
        ).mockResolvedValue();
        const detectPageAction = vi.spyOn(
            useStickerSheetStore.getState(),
            'detectStickers',
        ).mockResolvedValue();

        render(
            <StickerSheetPanel
                tabId="viewer-pdf-tab"
                pageOrder={[1, 2]}
            />,
        );

        const state = useStickerSheetStore.getState().getTab('viewer-pdf-tab');
        expect(state.sourceImageCount).toBe(1);
        expect(state.inspection).toBeNull();
        fireEvent.click(screen.getByRole('button', {
            name: 'Nhận diện tất cả trang (2)',
        }));

        expect(detectAllAction).toHaveBeenCalledWith('viewer-pdf-tab', 'auto', undefined);
        expect(detectPageAction).not.toHaveBeenCalled();
        detectAllAction.mockRestore();
        detectPageAction.mockRestore();
    });

    it('chọn nhiều ảnh tạo một PDF nhiều trang và vẫn chưa tự nhận diện', async () => {
        useStickerSheetStore.setState({ tabs: {} });
        const detectAllAction = vi.spyOn(
            useStickerSheetStore.getState(),
            'detectAllStickers',
        ).mockResolvedValue();
        const combined = new File(['pdf'], '3_anh_nhieu_tem.pdf', { type: 'application/pdf' });
        vi.mocked(imageFilesToPdfFile).mockResolvedValue(combined);
        const { container } = render(<StickerSheetPanel tabId="multi-tab" />);
        const input = container.querySelector('input[type="file"]') as HTMLInputElement;
        const files = [
            new File([], 'mot.jpg', { type: 'image/jpeg' }),
            new File([], 'hai.png', { type: 'image/png' }),
            new File([], 'ba.jpg', { type: 'image/jpeg' }),
        ];

        expect(input.multiple).toBe(true);
        fireEvent.change(input, { target: { files } });

        await waitFor(() => expect(
            useStickerSheetStore.getState().getTab('multi-tab').sourceFile,
        ).toBe(combined));
        expect(screen.queryByRole('button', { name: '3 ảnh · tài liệu 3 trang' })).toBeNull();
        expect(screen.queryByText('Ảnh nhiều tem')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Chọn ảnh khác' })).toBeNull();
        expect(screen.queryByText(/Ảnh mới chỉ được nạp để xem trước/)).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Nhận diện tất cả trang (3)' }));
        expect(detectAllAction).toHaveBeenCalledWith('multi-tab', 'auto', undefined);
        expect(inspectStickerSource).not.toHaveBeenCalled();
        expect(detectStickerSource).not.toHaveBeenCalled();
        detectAllAction.mockRestore();
    });
});
