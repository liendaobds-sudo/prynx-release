// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authenticatedFetch, uploadPDF } from '../../lib/api';
import {
    recipeRecorder,
    recipeRecorderStore,
    type RecipeOperationTicket,
} from '../../lib/recipe/RecipeRecorder';
import StickerTool from './StickerTool';

type OnFileFixed = (
    blob: Blob,
    filename: string,
    path?: string,
    ticket?: RecipeOperationTicket | null,
) => Promise<void>;


const previewApiMocks = vi.hoisted(() => ({
    inspectStickerSourceManifest: vi.fn(),
    detectStickerSourceManifest: vi.fn(),
    previewStickerCutline: vi.fn(),
    closeStickerSheetSession: vi.fn(),
    resolveWorkingPdf: Object.assign(vi.fn(async () => null), {
        prepare: vi.fn(async () => undefined),
        resolveUnprepared: vi.fn(async () => null),
    }),
}));

const workspaceMocks = vi.hoisted(() => ({
    setDetectedShapeType: vi.fn(),
    setDetectedShapeParams: vi.fn(),
    objectSelectionContext: null,
    isObjectEditMode: false,
    setIsObjectEditMode: vi.fn(),
    setIsCropMode: vi.fn(),
    setViewerToolMode: vi.fn(),
    viewerPageInstanceIds: ['viewer-instance-1'],
    viewerActivePagePhysical: null as {
        documentIdentity: string;
        viewerPage: number;
        sourcePage: number;
        pageInstanceId: string | null;
        rotation: number;
        widthPt: number;
        heightPt: number;
    } | null,
    setClassicCutlineViewerPreview: vi.fn(),
    clearClassicCutlineViewerPreview: vi.fn(),
}));

const CLASSIC_PREVIEW_SESSION_ID = '0123456789abcdef0123456789abcdef';
const CLASSIC_PREVIEW_FINGERPRINT = 'a'.repeat(64);

/** Gọi handler React trực tiếp để mô phỏng click đã lọt vào hàng đợi sự kiện
 * đúng lúc DOM vừa chuyển nút sang disabled. `fireEvent.click` tự bỏ qua nút
 * disabled nên không bao phủ được race này. */
function invokeReactClick(button: HTMLButtonElement): void {
    const propsKey = Object.keys(button).find(key => key.startsWith('__reactProps$'));
    const props = propsKey
        ? (button as unknown as Record<string, unknown>)[propsKey]
        : null;
    const onClick = props && typeof props === 'object' && 'onClick' in props
        ? (props as { onClick?: unknown }).onClick
        : null;
    if (typeof onClick !== 'function') throw new Error('Không tìm thấy handler React của nút');
    (onClick as () => void)();
}

function mockClassicPreviewArtifact(): void {
    previewApiMocks.inspectStickerSourceManifest.mockResolvedValue({
        session_id: CLASSIC_PREVIEW_SESSION_ID,
        stage: 'inspected',
        original_name: 'tem.pdf',
        source_kind: 'pdf',
        mime_type: 'application/pdf',
        boundary_source: 'vector',
        strategy_confidence: 0.96,
        needs_review: false,
        page_count: 1,
        source_width_px: 120,
        source_height_px: 80,
        dpi: [300, 300],
        physical_width_mm: 10,
        physical_height_mm: 8,
        preview_width_px: 120,
        preview_height_px: 80,
        has_existing_cut: false,
        has_vector: true,
        has_raster: false,
        has_alpha: false,
        cut_contour_count: 0,
        pages: [{
            page_number: 1,
            width_mm: 10,
            height_mm: 8,
            has_existing_cut: false,
            has_vector: true,
            has_raster: false,
            has_alpha: false,
            cut_contour_count: 0,
        }],
        warnings: [],
        preview_url: '/unused-preview.png',
    });
    previewApiMocks.detectStickerSourceManifest.mockResolvedValue({
        session_id: CLASSIC_PREVIEW_SESSION_ID,
        stage: 'mask-review',
        original_name: 'tem.pdf',
        source_kind: 'pdf',
        boundary_source: 'vector',
        strategy_confidence: 0.96,
        needs_review: false,
        page_count: 1,
        source_page: 1,
        original_width_px: 120,
        original_height_px: 80,
        analysis_width_px: 120,
        analysis_height_px: 80,
        preview_width_px: 120,
        preview_height_px: 80,
        dpi: [300, 300],
        model: 'birefnet-lite',
        model_seconds: 0,
        postprocess_seconds: 0,
        mask_revision: 1,
        refinement_available: false,
        alpha_threshold: 128,
        shadow_cleanup: 'auto',
        instances: [{
            id: 1,
            x: 10,
            y: 10,
            width: 100,
            height: 60,
            area_px: 6000,
            confidence: 0.96,
            uncertain_ratio: 0,
        }],
        warnings: [],
        vector_geometry_ref: null,
        preview_url: '/unused-preview.png',
        labels_url: '/unused-labels.png',
        uncertainty_url: '/unused-uncertainty.png',
    });
    previewApiMocks.previewStickerCutline.mockResolvedValue({
        page_number: 1,
        mask_revision: 1,
        preview_width_px: 120,
        preview_height_px: 80,
        paths: [{
            instance_id: 1,
            d: 'M 10 10 L 110 10 L 110 70 L 10 70 Z',
            segment_count: 4,
        }],
        fingerprint: CLASSIC_PREVIEW_FINGERPRINT,
        segment_count: 4,
    });
}


vi.mock('../../lib/api', () => ({
    authenticatedFetch: vi.fn(),
    getApiUrl: () => 'http://127.0.0.1:8321',
    uploadPDF: vi.fn(),
}));

vi.mock('../../lib/stickerSheetApi', () => previewApiMocks);

vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string, options?: Record<string, unknown>) => {
            const value = ({
            'preprocess.sticker:be_tem_nhan': 'Bế tem nhãn',
            'preprocess.sticker:xen_vuong_goc': 'Xén vuông góc',
            'preprocess.sticker:1_duong_cat_dieline': '1. Đường cắt (Dieline)',
            'preprocess.sticker:co_gian_vien': 'Co giãn viền',
            'preprocess.sticker:tao_duong_cat_cho_trang_dau_2': 'Chỉ tạo đường cắt trang đầu',
            'preprocess.sticker:file_nhieu_loai_tem_dung_chung_1_khuon': 'File nhiều loại tem dùng chung một khuôn',
            'preprocess.sticker:so_am_vd_0_5_ep_duong_cat_lun_vao_trong': 'Số âm ép đường cắt lún vào trong',
            'preprocess.sticker:2_tran_le_dac_ruot': '2. Tràn lề & Đặc ruột',
            'preprocess.sticker:hinh_hoc_duong_cat': 'Hình học đường cắt',
            'preprocess.sticker:hinh_hoc_duong_cat_hint': 'Mặc định an toàn: chỉ ép hình chuẩn khi biên khớp chặt.',
            'preprocess.sticker:hinh_hoc_duong_cat_auto': '🤖 Tự nhận dạng an toàn',
            'preprocess.sticker:hinh_hoc_duong_cat_auto_state': 'Tự nhận dạng',
            'preprocess.sticker:hinh_hoc_duong_cat_contour': '🖼️ Giữ mép ảnh',
            'preprocess.sticker:hinh_hoc_duong_cat_contour_state': 'Giữ contour',
            'preprocess.sticker:canh_bao_do_tin_cay_thap': 'Độ tin cậy nhận dạng hình chuẩn chỉ {{confidence}}%.',
            'preprocess.sticker:bu_xen_ngoai_duong_cat': 'Bù xén ngoài đường cắt',
            'preprocess.sticker:tran_mau': 'Tràn màu',
            'preprocess.sticker:bo_qua_cac_lo_rong_ben_trong_khoi_hinh': 'Bỏ qua các lỗ rỗng bên trong khối hình',
            'preprocess.sticker:dac_ruot': 'Đặc ruột',
            'preprocess.sticker:dac_ruot_2': 'Không đặc ruột',
            'preprocess.sticker:chi_do_vien_cua_chi_tiet_bo_qua_mang': 'Chỉ dò viền của chi tiết',
            'preprocess.sticker:bo_nen_trang': 'Bỏ nền trắng',
            'preprocess.sticker:bo_nen_trang_2': 'Giữ nền trắng',
            'preprocess.sticker:tom_tat_hinh_hoc_bu_xen': 'Tóm tắt hình học bù xén',
            'preprocess.sticker:mau_nen_bu_xen': 'Màu nền bù xén',
            // AUDIT (2026-08-16 §BX.F18): các chuỗi này trước đây hardcode trong JSX,
            // nay đã qua i18n nên mock phải khai báo cùng nội dung để test vẫn kiểm
            // đúng bố cục người dùng thấy.
            'preprocess.sticker:crop_trang_theo_tem': 'Crop trang theo tem',
            'preprocess.sticker:chon_sticker_can_bu_xen': 'Chọn sticker cần bù xén',
            'preprocess.sticker:bat_dau_chon': 'Bắt đầu chọn',
            'preprocess.sticker:chon_lai': 'Chọn lại',
            'preprocess.sticker:xong_chon': 'Xong chọn',
            'preprocess.stickerSheet:cutline_tension': 'Độ bo cong',
            'preprocess.stickerSheet:cutline_tension_aria': 'Độ bo cong đường bế',
            'preprocess.stickerSheet:cutline_tension_low': 'Ít bo',
            'preprocess.stickerSheet:cutline_tension_high': 'Bo tròn',
            'preprocess.stickerSheet:classic_preview_preparing': 'Đang nhận diện vùng tem để tạo preview…',
            'preprocess.stickerSheet:classic_preview_updating': 'Đang cập nhật đường bế xem trước… Vẫn giữ đường hiện tại.',
            'preprocess.common:run': 'Thực thi',
            'preprocess.sticker:da_tao_bu_xen_thanh_cong': 'Đã tạo bù xén thành công!',
            'preprocess.sticker:buoc_tiep_theo_chon_kieu_dan_trang': 'Bước tiếp theo: Chọn kiểu dàn trang (Imposition)',
            'preprocess.sticker:quay_lai_chinh_sua_bu_xen': 'Quay lại chỉnh sửa bù xén',
        }[key] || key);
            return options?.confidence === undefined
                ? value
                : value.replace('{{confidence}}', String(options.confidence));
        },
    }),
}));

vi.mock('../../hooks/useWorkingPdf', () => ({
    useWorkingPdf: () => previewApiMocks.resolveWorkingPdf,
}));

vi.mock('../../stores/useWorkspaceStore', () => ({
    useWorkspaceStore: () => workspaceMocks,
    workspaceDocumentIdentity: () => 'document-identity',
}));

vi.mock('../imposition-tools/useImposerSettingsStore', () => {
    const state = {
        setActiveDashboardTool: vi.fn(),
        setTaskMode: vi.fn(),
    };
    return {
        useImposerSettingsStore: (selector?: (value: typeof state) => unknown) => (
            selector ? selector(state) : state
        ),
    };
});

vi.mock('../../hooks/useToolActivationGuard', () => ({
    useToolActivationGuard: () => vi.fn(),
}));

describe('StickerTool — giao diện Bế tem nhãn trước hợp nhất', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Các test UI không nhắm preview giữ bước chuẩn bị đứng yên; test riêng bên
        // dưới cấp manifest/path đầy đủ. Như vậy không có request nền ngoài dự kiến.
        previewApiMocks.inspectStickerSourceManifest.mockImplementation(
            () => new Promise(() => undefined),
        );
        previewApiMocks.detectStickerSourceManifest.mockReset();
        previewApiMocks.previewStickerCutline.mockReset();
        previewApiMocks.closeStickerSheetSession.mockResolvedValue(undefined);
        window.localStorage.clear();
        workspaceMocks.viewerActivePagePhysical = null;
        recipeRecorderStore.setState({
            isRecording: false,
            ownerTabId: null,
            activeTabId: null,
            sessionId: 0,
            draftSteps: [],
            pendingNote: null,
        });
    });

    it('giữ đúng hai nhóm Đường cắt và Tràn lề của commit 89a9048', () => {
        render(
            <StickerTool
                pdfFile={new File(['pdf'], 'tem.pdf', { type: 'application/pdf' })}
                onFileFixed={vi.fn()}
            />,
        );

        expect(screen.getByText('1. Đường cắt (Dieline)')).toBeTruthy();
        expect(screen.getByText('2. Tràn lề & Đặc ruột')).toBeTruthy();
        expect(screen.getByText('Crop trang theo tem')).toBeTruthy();
        expect(screen.getByText('Chỉ tạo đường cắt trang đầu')).toBeTruthy();
        expect(screen.getByText('Đặc ruột')).toBeTruthy();
        expect(screen.getByText('Bỏ nền trắng')).toBeTruthy();

        const offsetInput = screen.getByText('Co giãn viền')
            .parentElement?.querySelector('input[type="number"]');
        expect(offsetInput?.getAttribute('step')).toBe('0.5');

        const bleedInput = screen.getByText('Bù xén ngoài đường cắt')
            .parentElement?.querySelector('input[type="number"]');
        expect(bleedInput).toBeTruthy();
        fireEvent.change(bleedInput!, { target: { value: '2' } });
        expect(screen.getByTestId('sticker-bleed-geometry-summary')).toBeTruthy();
    });

    it('hàng bù xén xuống dòng theo panel hẹp và giữ hoạt động của hai nút', () => {
        render(<StickerTool pdfFile={null} onFileFixed={vi.fn()} />);
        const removeBackground = screen.getByRole('button', { name: 'Bỏ nền trắng' });
        const fill = screen.getByRole('button', { name: 'Đặc ruột' });
        const toggles = removeBackground.parentElement!;
        const row = toggles.parentElement!;
        expect(row.classList.contains('flex-wrap')).toBe(true);
        expect(toggles.classList.contains('min-w-0')).toBe(true);
        for (const button of [fill, removeBackground]) {
            expect(button.classList.contains('whitespace-nowrap')).toBe(false);
            expect(button.classList.contains('overflow-hidden')).toBe(false);
        }
        const bleed = row.querySelector('input[type="number"]')!;
        fireEvent.change(bleed, { target: { value: '2.5' } });
        fireEvent.click(removeBackground);
        fireEvent.click(fill);
        expect(screen.getByRole('button', { name: 'Giữ nền trắng' }).getAttribute('aria-pressed')).toBe('false');
        expect(screen.getByRole('button', { name: 'Không đặc ruột' }).getAttribute('aria-pressed')).toBe('false');
        expect(window.localStorage.getItem('ps_sticker_bleedMm')).toBe('2.5');
        expect(window.localStorage.getItem('ps_sticker_removeWhiteBg')).toBe('false');
        expect(window.localStorage.getItem('ps_sticker_fillHoles')).toBe('false');
    });

    it('chỉ hiện Độ bo cong khi chọn Góc tròn và gửi đúng xuống backend', async () => {
        vi.mocked(uploadPDF).mockResolvedValue({ id: 'source-id' });
        vi.mocked(authenticatedFetch).mockResolvedValue({
            ok: true,
            headers: new Headers(),
            blob: vi.fn(async () => new Blob(['result'], { type: 'application/pdf' })),
        } as unknown as Response);
        window.localStorage.setItem('ps_sticker_removeWhiteBg', 'false');

        render(
            <StickerTool
                pdfFile={new File(['pdf'], 'tem.pdf', { type: 'application/pdf' })}
                onFileFixed={vi.fn()}
            />,
        );

        const roundButton = screen.getByRole('button', { name: /Góc tròn/ });
        expect(roundButton.getAttribute('aria-pressed')).toBe('false');
        expect(screen.queryByRole('slider', { name: 'Độ bo cong đường bế' })).toBeNull();

        fireEvent.click(roundButton);
        const slider = screen.getByRole('slider', { name: 'Độ bo cong đường bế' });
        expect(slider.getAttribute('value')).toBe('50');
        fireEvent.change(slider, { target: { value: '85' } });
        expect(roundButton.getAttribute('aria-pressed')).toBe('true');

        fireEvent.click(screen.getByRole('button', { name: /Góc nhọn/ }));
        expect(screen.queryByRole('slider', { name: 'Độ bo cong đường bế' })).toBeNull();
        fireEvent.click(roundButton);
        expect(screen.getByRole('slider', { name: 'Độ bo cong đường bế' }).getAttribute('value'))
            .toBe('85');
        fireEvent.click(screen.getByRole('button', { name: 'Thực thi' }));

        await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(1));
        const request = vi.mocked(authenticatedFetch).mock.calls[0][1] as RequestInit;
        const form = request.body as FormData;
        expect(form.get('corner_style')).toBe('round');
        expect(form.get('curve_tension')).toBe('85');
    });

    it('cho phép chọn giữ contour trước khi chạy và gửi shape_mode=contour', async () => {
        vi.mocked(uploadPDF).mockResolvedValue({ id: 'source-id' });
        vi.mocked(authenticatedFetch).mockResolvedValue({
            ok: true,
            headers: new Headers(),
            blob: vi.fn(async () => new Blob(['result'], { type: 'application/pdf' })),
        } as unknown as Response);
        window.localStorage.setItem('ps_sticker_removeWhiteBg', 'false');

        render(
            <StickerTool
                pdfFile={new File(['pdf'], 'tem.pdf', { type: 'application/pdf' })}
                onFileFixed={vi.fn()}
            />,
        );

        const control = screen.getByTestId('sticker-shape-recognition-control');
        const autoButton = screen.getByRole('button', { name: /Tự nhận dạng an toàn/ });
        const contourButton = screen.getByRole('button', { name: /Giữ mép ảnh/ });
        expect(control).toBeTruthy();
        expect(autoButton.getAttribute('aria-pressed')).toBe('true');
        expect(contourButton.getAttribute('aria-pressed')).toBe('false');

        fireEvent.click(screen.getByRole('button', { name: /Góc tròn/ }));
        expect(screen.getByRole('slider', { name: 'Độ bo cong đường bế' })).toBeTruthy();
        fireEvent.click(contourButton);
        expect(contourButton.getAttribute('aria-pressed')).toBe('true');
        expect(screen.queryByRole('slider', { name: 'Độ bo cong đường bế' })).toBeNull();
        expect(screen.getByRole('button', { name: /Giữ nguyên/ }).getAttribute('aria-pressed')).toBe('true');

        fireEvent.click(screen.getByRole('button', { name: 'Thực thi' }));
        await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(1));
        const request = vi.mocked(authenticatedFetch).mock.calls[0][1] as RequestInit;
        const form = request.body as FormData;
        expect(form.get('shape_mode')).toBe('contour');
        expect(form.get('corner_style')).toBe('preserve');
    });

    it('không hiển thị van nhận diện trong chế độ xén vuông góc', () => {
        render(
            <StickerTool
                productType="rectangle"
                showProductTypeSelector={false}
                pdfFile={new File(['pdf'], 'tem.pdf', { type: 'application/pdf' })}
                onFileFixed={vi.fn()}
            />,
        );

        expect(screen.queryByTestId('sticker-shape-recognition-control')).toBeNull();
    });

    it('hiện cảnh báo khi confidence hình chuẩn thấp sau lượt chạy', async () => {
        vi.mocked(uploadPDF).mockResolvedValue({ id: 'source-id' });
        const headers = new Headers({
            'X-Sticker-Cut-Kind': 'circle',
            'X-Sticker-Cut-Confidence': '0.38',
        });
        vi.mocked(authenticatedFetch).mockResolvedValue({
            ok: true,
            headers,
            blob: vi.fn(async () => new Blob(['result'], { type: 'application/pdf' })),
        } as unknown as Response);
        window.localStorage.setItem('ps_sticker_removeWhiteBg', 'false');

        render(
            <StickerTool
                pdfFile={new File(['pdf'], 'tem.pdf', { type: 'application/pdf' })}
                onFileFixed={vi.fn().mockResolvedValue(undefined)}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Thực thi' }));
        await waitFor(() => expect(screen.getByText(/Độ tin cậy nhận dạng hình chuẩn chỉ 38%/)).toBeTruthy());
    });

    it('preview nhẹ công bố SVG lên Viewer, không dựng thumbnail trong panel', async () => {
        previewApiMocks.inspectStickerSourceManifest.mockResolvedValue({
            session_id: '0123456789abcdef0123456789abcdef',
            stage: 'inspected',
            original_name: 'tem.pdf',
            source_kind: 'pdf',
            mime_type: 'application/pdf',
            boundary_source: 'vector',
            strategy_confidence: 0.96,
            needs_review: false,
            page_count: 1,
            source_width_px: 120,
            source_height_px: 80,
            dpi: [300, 300],
            physical_width_mm: 10,
            physical_height_mm: 8,
            preview_width_px: 120,
            preview_height_px: 80,
            has_existing_cut: false,
            has_vector: true,
            has_raster: false,
            has_alpha: false,
            cut_contour_count: 0,
            pages: [{
                page_number: 1,
                width_mm: 10,
                height_mm: 8,
                has_existing_cut: false,
                has_vector: true,
                has_raster: false,
                has_alpha: false,
                cut_contour_count: 0,
            }],
            warnings: [],
            preview_url: '/unused-preview.png',
        });
        previewApiMocks.detectStickerSourceManifest.mockResolvedValue({
            session_id: '0123456789abcdef0123456789abcdef',
            stage: 'mask-review',
            original_name: 'tem.pdf',
            source_kind: 'pdf',
            boundary_source: 'vector',
            strategy_confidence: 0.96,
            needs_review: false,
            page_count: 1,
            source_page: 1,
            original_width_px: 120,
            original_height_px: 80,
            analysis_width_px: 120,
            analysis_height_px: 80,
            preview_width_px: 120,
            preview_height_px: 80,
            dpi: [300, 300],
            model: 'birefnet-lite',
            model_seconds: 0,
            postprocess_seconds: 0,
            mask_revision: 1,
            refinement_available: false,
            alpha_threshold: 128,
            shadow_cleanup: 'auto',
            instances: [{
                id: 1, x: 10, y: 10, width: 100, height: 60,
                area_px: 6000, confidence: 0.96, uncertain_ratio: 0,
            }],
            warnings: [],
            vector_geometry_ref: null,
            preview_url: '/unused-preview.png',
            labels_url: '/unused-labels.png',
            uncertainty_url: '/unused-uncertainty.png',
        });
        previewApiMocks.previewStickerCutline.mockResolvedValue({
            page_number: 1,
            mask_revision: 1,
            preview_width_px: 120,
            preview_height_px: 80,
            paths: [{
                instance_id: 1,
                d: 'M 10 10 L 110 10 L 110 70 L 10 70 Z',
                segment_count: 4,
            }],
            fingerprint: 'a'.repeat(64),
            segment_count: 4,
        });

        const sourceFile = new File(['pdf'], 'tem.pdf', { type: 'application/pdf' });
        const view = render(
            <StickerTool
                pdfFile={sourceFile}
                onFileFixed={vi.fn()}
            />,
        );

        await waitFor(() => expect(workspaceMocks.setClassicCutlineViewerPreview)
            .toHaveBeenCalledWith(expect.objectContaining({
                viewerPage: 1,
                pageInstanceId: 'viewer-instance-1',
                documentIdentity: 'document-identity',
                preview: expect.objectContaining({
                    paths: [expect.objectContaining({
                        d: 'M 10 10 L 110 10 L 110 70 L 10 70 Z',
                    })],
                }),
            })), { timeout: 2000 });
        expect(screen.queryByTestId('classic-cutline-preview-card')).toBeNull();
        expect(screen.queryByTestId('classic-cutline-preview-svg')).toBeNull();
        expect(previewApiMocks.detectStickerSourceManifest).toHaveBeenCalledWith(
            '0123456789abcdef0123456789abcdef',
            expect.objectContaining({ strategy: 'vector', pageNumber: 1 }),
        );
        expect(previewApiMocks.previewStickerCutline).toHaveBeenCalledWith(
            '0123456789abcdef0123456789abcdef',
            expect.objectContaining({ cornerStyle: 'preserve', curveTension: 50 }),
        );

        const clearsBeforeBackground = workspaceMocks.clearClassicCutlineViewerPreview.mock.calls.length;
        view.rerender(
            <StickerTool
                pdfFile={sourceFile}
                onFileFixed={vi.fn()}
                isActive={false}
            />,
        );
        await waitFor(() => expect(
            workspaceMocks.clearClassicCutlineViewerPreview.mock.calls.length,
        ).toBeGreaterThan(clearsBeforeBackground));

        view.unmount();
        await waitFor(() => expect(previewApiMocks.closeStickerSheetSession)
            .toHaveBeenCalledWith('0123456789abcdef0123456789abcdef'));
        expect(workspaceMocks.clearClassicCutlineViewerPreview).toHaveBeenCalled();
    });

    it('Thực thi tái dùng đúng artifact preview và giữ session tới khi backend chụp xong', async () => {
        mockClassicPreviewArtifact();
        vi.mocked(uploadPDF).mockResolvedValue({ id: 'source-id' });
        let resolveExecute!: (response: Response) => void;
        const executePending = new Promise<Response>((resolve) => {
            resolveExecute = resolve;
        });
        vi.mocked(authenticatedFetch).mockImplementationOnce(() => executePending);
        const onFileFixed = vi.fn().mockResolvedValue(undefined);

        render(
            <StickerTool
                pdfFile={new File(['pdf'], 'tem.pdf', { type: 'application/pdf' })}
                onFileFixed={onFileFixed}
            />,
        );

        await waitFor(() => expect(previewApiMocks.previewStickerCutline)
            .toHaveBeenCalledTimes(1), { timeout: 2000 });
        expect(previewApiMocks.detectStickerSourceManifest).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole('button', { name: 'Thực thi' }));
        await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(1));

        const request = vi.mocked(authenticatedFetch).mock.calls[0][1] as RequestInit;
        const form = request.body as FormData;
        expect(form.get('cutline_preview_session_id')).toBe(CLASSIC_PREVIEW_SESSION_ID);
        expect(form.get('cutline_preview_revision')).toBe('1');
        expect(form.get('cutline_preview_fingerprint')).toBe(CLASSIC_PREVIEW_FINGERPRINT);
        // Việc bật isProcessing không được cleanup session trước khi request backend
        // đã có cơ hội snapshot artifact; nếu không execute sẽ rơi về detect/fit lần hai.
        expect(previewApiMocks.closeStickerSheetSession).not.toHaveBeenCalled();
        expect(previewApiMocks.detectStickerSourceManifest).toHaveBeenCalledTimes(1);
        expect(previewApiMocks.previewStickerCutline).toHaveBeenCalledTimes(1);

        resolveExecute({
            ok: true,
            headers: new Headers(),
            blob: vi.fn(async () => new Blob(['result'], { type: 'application/pdf' })),
        } as unknown as Response);
        await waitFor(() => expect(onFileFixed).toHaveBeenCalledTimes(1));
        expect(previewApiMocks.detectStickerSourceManifest).toHaveBeenCalledTimes(1);
        expect(previewApiMocks.previewStickerCutline).toHaveBeenCalledTimes(1);
    });

    it('khóa Thực thi trong khoảng detect xong nhưng canonical preview chưa fit xong', async () => {
        mockClassicPreviewArtifact();
        let resolvePreview!: (value: {
            page_number: number;
            mask_revision: number;
            preview_width_px: number;
            preview_height_px: number;
            paths: Array<{ instance_id: number; d: string; segment_count: number }>;
            fingerprint: string;
            segment_count: number;
        }) => void;
        previewApiMocks.previewStickerCutline.mockImplementationOnce(
            () => new Promise(resolve => { resolvePreview = resolve; }),
        );

        render(
            <StickerTool
                pdfFile={new File(['pdf'], 'tem.pdf', { type: 'application/pdf' })}
                onFileFixed={vi.fn()}
            />,
        );

        await waitFor(() => expect(previewApiMocks.previewStickerCutline)
            .toHaveBeenCalledTimes(1), { timeout: 2000 });
        const execute = screen.getByRole('button', { name: 'Thực thi' }) as HTMLButtonElement;
        expect(execute.disabled).toBe(true);
        invokeReactClick(execute);
        expect(authenticatedFetch).not.toHaveBeenCalled();
        // Nút có thể nhận click sát thời điểm chuyển sang disabled; đây là trạng
        // thái chờ, không được biến thành khung lỗi đỏ trùng với status teal.
        expect(screen.getByTestId('classic-cutline-preview-status').textContent)
            .toContain('Đang cập nhật đường bế xem trước…');
        expect(screen.queryByText(/❌ Đang cập nhật đường bế xem trước/)).toBeNull();

        resolvePreview({
            page_number: 1,
            mask_revision: 1,
            preview_width_px: 120,
            preview_height_px: 80,
            paths: [{
                instance_id: 1,
                d: 'M 10 10 L 110 10 L 110 70 L 10 70 Z',
                segment_count: 4,
            }],
            fingerprint: CLASSIC_PREVIEW_FINGERPRINT,
            segment_count: 4,
        });
        await waitFor(() => expect(execute.disabled).toBe(false));
    });

    it('báo rõ đang nhận diện trong lúc chuẩn bị preview lần đầu', () => {
        render(
            <StickerTool
                pdfFile={new File(['pdf'], 'tem.pdf', { type: 'application/pdf' })}
                onFileFixed={vi.fn()}
            />,
        );

        expect(screen.getByTestId('classic-cutline-preview-status').textContent)
            .toContain('Đang nhận diện vùng tem để tạo preview…');
    });

    it('giữ đường bế cũ trên Viewer khi lượt cập nhật đang chạy rồi báo lỗi', async () => {
        const sessionId = '0123456789abcdef0123456789abcdef';
        const firstPreview = {
            page_number: 1,
            mask_revision: 1,
            preview_width_px: 120,
            preview_height_px: 80,
            paths: [{
                instance_id: 1,
                d: 'M 10 10 L 110 10 L 110 70 L 10 70 Z',
                segment_count: 4,
            }],
            fingerprint: 'a'.repeat(64),
            segment_count: 4,
        };
        previewApiMocks.inspectStickerSourceManifest.mockResolvedValue({
            session_id: sessionId,
            stage: 'inspected',
            original_name: 'tem.pdf',
            source_kind: 'pdf',
            mime_type: 'application/pdf',
            boundary_source: 'vector',
            strategy_confidence: 0.96,
            needs_review: false,
            page_count: 1,
            source_width_px: 120,
            source_height_px: 80,
            dpi: [300, 300],
            physical_width_mm: 10,
            physical_height_mm: 8,
            preview_width_px: 120,
            preview_height_px: 80,
            has_existing_cut: false,
            has_vector: true,
            has_raster: false,
            has_alpha: false,
            cut_contour_count: 0,
            pages: [{
                page_number: 1,
                width_mm: 10,
                height_mm: 8,
                has_existing_cut: false,
                has_vector: true,
                has_raster: false,
                has_alpha: false,
                cut_contour_count: 0,
            }],
            warnings: [],
            preview_url: '/unused-preview.png',
        });
        previewApiMocks.detectStickerSourceManifest.mockResolvedValue({
            session_id: sessionId,
            stage: 'mask-review',
            original_name: 'tem.pdf',
            source_kind: 'pdf',
            boundary_source: 'vector',
            strategy_confidence: 0.96,
            needs_review: false,
            page_count: 1,
            source_page: 1,
            original_width_px: 120,
            original_height_px: 80,
            analysis_width_px: 120,
            analysis_height_px: 80,
            preview_width_px: 120,
            preview_height_px: 80,
            dpi: [300, 300],
            model: 'birefnet-lite',
            model_seconds: 0,
            postprocess_seconds: 0,
            mask_revision: 1,
            refinement_available: false,
            alpha_threshold: 128,
            shadow_cleanup: 'auto',
            instances: [{
                id: 1, x: 10, y: 10, width: 100, height: 60,
                area_px: 6000, confidence: 0.96, uncertain_ratio: 0,
            }],
            warnings: [],
            vector_geometry_ref: null,
            preview_url: '/unused-preview.png',
            labels_url: '/unused-labels.png',
            uncertainty_url: '/unused-uncertainty.png',
        });
        let rejectUpdate!: (reason?: unknown) => void;
        const pendingUpdate = new Promise((_, reject) => { rejectUpdate = reject; });
        previewApiMocks.previewStickerCutline
            .mockResolvedValueOnce(firstPreview)
            .mockImplementationOnce(() => pendingUpdate);

        render(
            <StickerTool
                pdfFile={new File(['pdf'], 'tem.pdf', { type: 'application/pdf' })}
                onFileFixed={vi.fn()}
            />,
        );

        await waitFor(() => expect(workspaceMocks.setClassicCutlineViewerPreview)
            .toHaveBeenCalledWith(expect.objectContaining({
                preview: firstPreview,
                isUpdating: false,
            })), { timeout: 2000 });

        fireEvent.click(screen.getByRole('button', { name: /Góc tròn/ }));
        await waitFor(() => expect(previewApiMocks.previewStickerCutline)
            .toHaveBeenCalledTimes(2));
        expect(screen.getByTestId('classic-cutline-preview-status').textContent)
            .toContain('Đang cập nhật đường bế xem trước…');
        expect(workspaceMocks.setClassicCutlineViewerPreview)
            .toHaveBeenLastCalledWith(expect.objectContaining({
                preview: firstPreview,
                isUpdating: true,
            }));

        const clearCountBeforeError = workspaceMocks.clearClassicCutlineViewerPreview.mock.calls.length;
        rejectUpdate(new Error('Không cập nhật được preview thử nghiệm'));
        await waitFor(() => expect(screen.getByText(/Không cập nhật được preview thử nghiệm/))
            .toBeTruthy());

        expect(workspaceMocks.clearClassicCutlineViewerPreview)
            .toHaveBeenCalledTimes(clearCountBeforeError);
        expect(workspaceMocks.setClassicCutlineViewerPreview)
            .toHaveBeenLastCalledWith(expect.objectContaining({
                preview: firstPreview,
                isUpdating: false,
            }));
    });

    it('tự thu thiết lập sau khi tạo đường cắt và cho xổ lại mà vẫn giữ kết quả', async () => {
        vi.mocked(uploadPDF).mockResolvedValue({ id: 'source-id' });
        vi.mocked(authenticatedFetch).mockResolvedValue({
            ok: true,
            headers: new Headers(),
            blob: vi.fn(async () => new Blob(['result'], { type: 'application/pdf' })),
        } as unknown as Response);
        const onFileFixed = vi.fn().mockResolvedValue(undefined);
        window.localStorage.setItem('ps_sticker_removeWhiteBg', 'false');
        workspaceMocks.viewerActivePagePhysical = {
            documentIdentity: 'document-identity',
            viewerPage: 1,
            sourcePage: 1,
            pageInstanceId: 'viewer-instance-1',
            rotation: 0,
            widthPt: 595.28,
            heightPt: 841.89,
        };

        render(
            <StickerTool
                pdfFile={new File(['pdf'], 'tem.pdf', { type: 'application/pdf' })}
                onFileFixed={onFileFixed}
            />,
        );

        const settingsToggle = screen.getByRole('button', { name: /Thiết lập bù xén/ });
        expect(settingsToggle.getAttribute('aria-expanded')).toBe('true');
        fireEvent.click(screen.getByRole('button', { name: 'Thực thi' }));

        await waitFor(() => expect(onFileFixed).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(settingsToggle.getAttribute('aria-expanded')).toBe('false'));
        expect(screen.queryByText('1. Đường cắt (Dieline)')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Thực thi' })).toBeNull();

        const resultCard = screen.getByRole('status');
        expect(resultCard.textContent).toContain('Đã tạo bù xén thành công!');
        expect(settingsToggle.compareDocumentPosition(resultCard) & Node.DOCUMENT_POSITION_FOLLOWING)
            .toBeTruthy();

        fireEvent.click(settingsToggle);
        expect(settingsToggle.getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByText('1. Đường cắt (Dieline)')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Thực thi' })).toBeTruthy();
        expect(screen.getByText('Đã tạo bù xén thành công!').closest('[role="status"]'))
            .toBe(resultCard);
    });

    it('giữ đúng ticket của tab cho tới callback commit', async () => {
        recipeRecorder.start('tab-a');
        const noteOperation = vi.spyOn(recipeRecorder, 'noteOperation');
        vi.mocked(uploadPDF).mockResolvedValue({ id: 'source-id' });
        vi.mocked(authenticatedFetch).mockResolvedValue({
            ok: true,
            headers: new Headers(),
            blob: vi.fn(async () => new Blob(['result'], { type: 'application/pdf' })),
        } as unknown as Response);
        let releaseCommit!: () => void;
        const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
        const onFileFixed = vi.fn<OnFileFixed>(() => commitGate);
        window.localStorage.setItem('ps_sticker_removeWhiteBg', 'false');

        render(
            <StickerTool
                tabId="tab-a"
                pdfFile={new File(['pdf'], 'tem.pdf', { type: 'application/pdf' })}
                onFileFixed={onFileFixed}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Thực thi' }));

        await waitFor(() => expect(onFileFixed).toHaveBeenCalledTimes(1));
        expect(onFileFixed.mock.calls[0][3]).toMatchObject({ ownerTabId: 'tab-a' });
        expect(previewApiMocks.resolveWorkingPdf.prepare).toHaveBeenCalledOnce();
        expect(previewApiMocks.resolveWorkingPdf.prepare.mock.invocationCallOrder[0])
            .toBeLessThan(noteOperation.mock.invocationCallOrder[0]);

        releaseCommit();
        await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
        noteOperation.mockRestore();
    });
});
