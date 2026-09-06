// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentType, PropsWithChildren } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    confirmStickerSource,
    detectStickerSource,
    exportStickerSheet,
    inspectStickerSource,
    previewStickerCutline,
    type StickerSourceDetectionPayload,
    type StickerSourceInspectPayload,
} from '../../lib/stickerSheetApi';
import StickerCutlineTool from './StickerCutlineTool';
import { useStickerSheetStore } from './stickerSheetStore';
import { createWorkspaceStore, WorkspaceContext } from '../../stores/useWorkspaceStore';
import { createImposerSettingsStore, ImposerSettingsContext } from '../imposition-tools/useImposerSettingsStore';


const workingPdfMock = vi.hoisted(() => ({
    prepare: vi.fn(),
    capture: vi.fn(),
    materialize: vi.fn(),
    isCurrent: vi.fn(),
}));

vi.mock('./StickerTool', () => ({
    default: ({
        pdfFile,
        onProcessingChange,
        pageNumber,
    }: {
        pdfFile: File | null;
        onProcessingChange?: (processing: boolean) => void;
        pageNumber?: number;
    }) => (
        <div>
            <div>direct-engine:{pdfFile?.name || 'none'}</div>
            <div>direct-preview-page:{pageNumber ?? 1}</div>
            <button type="button" onClick={() => onProcessingChange?.(true)}>start-direct</button>
            <button type="button" onClick={() => onProcessingChange?.(false)}>finish-direct</button>
        </div>
    ),
}));
vi.mock('../../lib/stickerSheetApi', () => ({
    closeStickerSheetSession: vi.fn(async () => undefined),
    confirmStickerSource: vi.fn(async () => true),
    detectStickerSource: vi.fn(),
    exportStickerSheet: vi.fn(),
    inspectStickerSource: vi.fn(),
    previewStickerCutline: vi.fn(),
}));
vi.mock('./StickerObjectSelectionControl', () => ({
    default: () => <button type="button">Chọn tem</button>,
}));
vi.mock('../../hooks/useWorkingPdf', () => ({
    useWorkingPdf: () => workingPdfMock,
}));

function inspection(): StickerSourceInspectPayload {
    return {
        inspection: {
            session_id: 'a'.repeat(32), stage: 'inspected', original_name: 'current.png',
            source_kind: 'raster', mime_type: 'image/png', boundary_source: 'alpha',
            strategy_confidence: 0.98, needs_review: false, page_count: 1,
            source_width_px: 100, source_height_px: 80, dpi: null,
            physical_width_mm: null, physical_height_mm: null,
            preview_width_px: 100, preview_height_px: 80,
            has_existing_cut: false, has_vector: false, has_raster: true, has_alpha: true,
            cut_contour_count: 0,
            pages: [{
                page_number: 1, width_mm: null, height_mm: null,
                has_existing_cut: false, has_vector: false, has_raster: true,
                has_alpha: true, cut_contour_count: 0,
            }],
            warnings: [], preview_url: '/source-preview',
        },
        previewBlob: new Blob(),
    };
}

function detection(needsReview = false): StickerSourceDetectionPayload {
    return {
        manifest: {
            session_id: 'a'.repeat(32), stage: 'mask-review', original_name: 'current.png',
            source_kind: 'raster', boundary_source: needsReview ? 'ai' : 'alpha',
            strategy_confidence: 0.98, needs_review: needsReview, page_count: 1,
            source_page: 1, vector_geometry_ref: null,
            original_width_px: 100, original_height_px: 80,
            analysis_width_px: 100, analysis_height_px: 80,
            preview_width_px: 100, preview_height_px: 80,
            dpi: null, model: 'birefnet-lite', model_seconds: 0, postprocess_seconds: 0.1,
            instances: [{
                id: 1, x: 0, y: 0, width: 100, height: 80,
                area_px: 8000, confidence: 1, uncertain_ratio: 0,
            }],
            warnings: [], preview_url: '/preview', labels_url: '/labels', uncertainty_url: '/uncertainty',
        },
        previewBlob: new Blob(), labelsBlob: new Blob(), uncertaintyBlob: new Blob(),
    };
}

describe('StickerCutlineTool — một workspace, giữ adapter tương thích', () => {
    const renderRecognizedShell = async (tabId: string, wrapper?: ComponentType<PropsWithChildren>) => {
        const source = new File(['pdf'], `${tabId}.pdf`, { type: 'application/pdf' });
        const props = { tabId, pdfFile: source, isActive: true, onFileFixed: vi.fn() };
        const view = render(<StickerCutlineTool {...props} />, { wrapper });
        fireEvent.click(screen.getByRole('button', { name: 'Nhận diện tự động' }));
        await waitFor(() => expect(useStickerSheetStore.getState().getTab(tabId).status).toBe('mask-ready'));
        await waitFor(() => expect(useStickerSheetStore.getState().getTab(tabId).cutlinePreview?.fingerprint).toBe('b'.repeat(64)));
        return { view, props };
    };

    beforeEach(() => {
        window.localStorage.clear();
        useStickerSheetStore.setState({ tabs: {} });
        vi.clearAllMocks();
        const revision = {
            file: new File(['working'], 'working.pdf', { type: 'application/pdf' }),
        };
        workingPdfMock.prepare.mockResolvedValue(undefined);
        workingPdfMock.capture.mockReturnValue(revision);
        workingPdfMock.materialize.mockImplementation(async (
            snapshot: { file: File },
        ) => snapshot.file);
        workingPdfMock.isCurrent.mockReturnValue(true);
        Object.defineProperty(URL, 'createObjectURL', {
            configurable: true,
            value: vi.fn(() => 'blob:asset'),
        });
        Object.defineProperty(URL, 'revokeObjectURL', {
            configurable: true,
            value: vi.fn(),
        });
        vi.mocked(inspectStickerSource).mockResolvedValue(inspection());
        vi.mocked(detectStickerSource).mockResolvedValue(detection());
        vi.mocked(previewStickerCutline).mockResolvedValue({
            page_number: 1,
            mask_revision: 1,
            preview_width_px: 100,
            preview_height_px: 80,
            paths: [{
                instance_id: 1,
                d: 'M 1 1 C 2 2 3 3 4 4 Z',
                segment_count: 1,
            }],
            fingerprint: 'b'.repeat(64),
            segment_count: 1,
        });
    });

    it('mở workspace không có thẻ tóm tắt, giữ đủ bù xén và không tự nhận diện', async () => {
        const pdf = new File(['pdf'], 'current.pdf', { type: 'application/pdf' });
        render(
            <StickerCutlineTool
                tabId="direct-tab"
                pdfFile={pdf}
                sourceImageFile={null}
                isActive
                onFileFixed={vi.fn()}
            />,
        );

        // UIUX (feedback 2026-09-06): bỏ thẻ tóm tắt, không bỏ state hay control xử lý.
        expect(screen.queryByLabelText('Bù xén và tạo đường cắt')).toBeNull();
        expect(screen.queryByText('Một quy trình cho tem đã có biên và ảnh nhiều tem.')).toBeNull();
        expect(screen.queryByText('Tùy chọn PDF nâng cao')).toBeNull();
        expect(screen.queryByText('Quay lại workspace tem')).toBeNull();
        expect(screen.getByRole('button', { name: 'Chọn tem' })).toBeTruthy();
        expect(screen.getByRole('group', { name: 'Mục tiêu gia công' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Đổi file nguồn' })).toBeNull();
        const state = useStickerSheetStore.getState().getTab('direct-tab');
        expect(state.sourceFile).toBe(pdf);
        expect(state.outputSettings.cropToSticker).toBe(false);
        expect(screen.getByRole('button', { name: 'Nhận diện tự động' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'PDF/PNG đã có biên' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Tách nhiều tem' })).toBeNull();
        expect(screen.getByRole('spinbutton', { name: 'Bù xén ngoài đường cắt (mm)' })).toBeTruthy();
        expect(screen.getByRole('spinbutton', { name: 'Co giãn đường cắt (mm)' })).toBeTruthy();
        expect(screen.queryByText('direct-engine:current.pdf')).toBeNull();
        expect(inspectStickerSource).not.toHaveBeenCalled();
        expect(detectStickerSource).not.toHaveBeenCalled();
    });

    it('mở pipeline tự động từ một hành động duy nhất', async () => {
        const image = new File(['image'], 'current.png', { type: 'image/png' });
        const pdf = new File(['pdf'], 'current.pdf', { type: 'application/pdf' });
        render(
            <StickerCutlineTool
                tabId="ai-tab"
                pdfFile={pdf}
                sourceImageFile={image}
                isActive
                onFileFixed={vi.fn()}
            />,
        );

        expect(inspectStickerSource).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: 'Nhận diện tự động' }));
        await waitFor(() => expect(detectStickerSource).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(confirmStickerSource).toHaveBeenCalledTimes(1));
        expect(useStickerSheetStore.getState().getTab('ai-tab').status).toBe('mask-ready');
        expect(screen.queryByLabelText('Bù xén và tạo đường cắt')).toBeNull();
        expect(screen.getByRole('button', { name: 'Giữ nguyên tấm' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Tách từng tem' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'PDF/PNG đã có biên' })).toBeNull();
    });

    it('Ctrl+Z bỏ nhận diện; Ctrl+Y và Ctrl+Shift+Z khôi phục đúng kết quả mà không chạy AI lần nữa', async () => {
        await renderRecognizedShell('detect-history');
        const detected = useStickerSheetStore.getState().getTab('detect-history');

        expect(fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })).toBe(false);
        const undone = useStickerSheetStore.getState().getTab('detect-history');
        expect(undone.status).toBe('source-ready');
        expect(undone.manifest).toBeNull();
        expect(undone.cutlinePreview).toBeNull();
        expect(undone.sourceFile).toBe(detected.sourceFile);
        expect(undone.sourceRevision).toBe(detected.sourceRevision);
        expect(undone.inspection).toBe(detected.inspection);
        expect(undone.outputSettings).toEqual(detected.outputSettings);
        // Không còn kết quả để hoàn tác: Viewer phải được nhận phím kế tiếp.
        expect(fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })).toBe(true);

        // Overlay đã biến mất, nhưng shell vẫn phải nhận Làm lại.
        expect(fireEvent.keyDown(document.body, { key: 'y', ctrlKey: true })).toBe(false);
        const redone = useStickerSheetStore.getState().getTab('detect-history');
        expect(redone.status).toBe(detected.status);
        expect(redone.manifest).toBe(detected.manifest);
        expect(redone.cutlinePreview).toBe(detected.cutlinePreview);
        expect(redone.previewUrl).toBe(detected.previewUrl);
        expect(redone.labelsUrl).toBe(detected.labelsUrl);
        expect(redone.uncertaintyUrl).toBe(detected.uncertaintyUrl);

        fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
        expect(fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true, shiftKey: true })).toBe(false);
        expect(useStickerSheetStore.getState().getTab('detect-history').cutlinePreview?.fingerprint)
            .toBe(detected.cutlinePreview?.fingerprint);
        expect(detectStickerSource).toHaveBeenCalledTimes(1);
        expect(inspectStickerSource).toHaveBeenCalledTimes(1);
        expect(confirmStickerSource).toHaveBeenCalledTimes(1);
    });

    it('ưu tiên hoàn tác và làm lại nét sửa trước kết quả nhận diện', async () => {
        await renderRecognizedShell('edit-history');
        const manifest = useStickerSheetStore.getState().getTab('edit-history').manifest;
        act(() => useStickerSheetStore.getState().addStroke('edit-history', {
            tool: 'erase', points: [{ x: 10, y: 10 }], radius: 2, instanceId: 1,
        }));
        expect(useStickerSheetStore.getState().getTab('edit-history').edits).toHaveLength(1);

        expect(fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })).toBe(false);
        expect(useStickerSheetStore.getState().getTab('edit-history').edits).toHaveLength(0);
        expect(useStickerSheetStore.getState().getTab('edit-history').manifest).toBe(manifest);
        expect(fireEvent.keyDown(document.body, { key: 'y', ctrlKey: true })).toBe(false);
        expect(useStickerSheetStore.getState().getTab('edit-history').edits).toHaveLength(1);
        expect(useStickerSheetStore.getState().getTab('edit-history').manifest).toBe(manifest);
    });

    it('tab nền không nhận hoàn tác hoặc làm lại nhận diện', async () => {
        const { view, props } = await renderRecognizedShell('inactive-history');
        const detected = useStickerSheetStore.getState().getTab(props.tabId).manifest;
        view.rerender(<StickerCutlineTool {...props} isActive={false} />);
        expect(fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })).toBe(true);
        expect(useStickerSheetStore.getState().getTab(props.tabId).manifest).toBe(detected);

        view.rerender(<StickerCutlineTool {...props} />);
        fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
        view.rerender(<StickerCutlineTool {...props} isActive={false} />);
        expect(fireEvent.keyDown(document.body, { key: 'y', ctrlKey: true })).toBe(true);
        expect(useStickerSheetStore.getState().getTab(props.tabId).manifest).toBeNull();
    });

    it('không lấy Ctrl+Z của ô nhập liệu, dropdown hoặc nội dung đang soạn', async () => {
        await renderRecognizedShell('input-history');
        const detected = useStickerSheetStore.getState().getTab('input-history').manifest;
        const fields = render(<>
            <textarea aria-label="ghi chú" />
            <select aria-label="chọn mục"><option>Một</option></select>
            <div contentEditable suppressContentEditableWarning><span data-testid="editable-child">Nội dung</span></div>
        </>);
        for (const target of [
            screen.getByRole('spinbutton', { name: 'Bù xén ngoài đường cắt (mm)' }),
            screen.getByLabelText('ghi chú'), screen.getByLabelText('chọn mục'), screen.getByTestId('editable-child'),
        ]) {
            expect(fireEvent.keyDown(target, { key: 'z', ctrlKey: true })).toBe(true);
            expect(useStickerSheetStore.getState().getTab('input-history').manifest).toBe(detected);
        }
        fields.unmount();
    });

    it('không chiếm phím trong chọn đối tượng, xén trang, công cụ khác hoặc dialog của tab', async () => {
        const workspace = createWorkspaceStore();
        const settings = createImposerSettingsStore('history-guards');
        settings.getState().setActiveDashboardTool('sticker');
        const wrapper = ({ children }: PropsWithChildren) => (
            <WorkspaceContext.Provider value={workspace}>
                <ImposerSettingsContext.Provider value={settings}>
                    <div data-prynx-tab-id="guard-history">{children}</div>
                </ImposerSettingsContext.Provider>
            </WorkspaceContext.Provider>
        );
        const { view } = await renderRecognizedShell('guard-history', wrapper);
        const detected = useStickerSheetStore.getState().getTab('guard-history').manifest;
        const assertNotHandled = () => {
            expect(fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })).toBe(true);
            expect(useStickerSheetStore.getState().getTab('guard-history').manifest).toBe(detected);
        };
        act(() => workspace.getState().setIsObjectEditMode(true));
        assertNotHandled();
        act(() => workspace.getState().setIsCropMode(true));
        assertNotHandled();
        act(() => workspace.getState().setIsCropMode(false));
        act(() => settings.getState().setActiveDashboardTool('datamerge'));
        assertNotHandled();
        act(() => settings.getState().setActiveDashboardTool('sticker'));
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        view.container.querySelector('[data-prynx-tab-id]')!.appendChild(dialog);
        assertNotHandled();
        dialog.remove();
        expect(fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })).toBe(false);
    });

    it('revision đã đổi không được hoàn tác hoặc khôi phục nhận diện cũ', async () => {
        await renderRecognizedShell('stale-history');
        const detected = useStickerSheetStore.getState().getTab('stale-history').manifest;
        workingPdfMock.isCurrent.mockReturnValue(false);
        expect(fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })).toBe(true);
        expect(useStickerSheetStore.getState().getTab('stale-history').manifest).toBe(detected);

        workingPdfMock.isCurrent.mockReturnValue(true);
        fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
        workingPdfMock.isCurrent.mockReturnValue(false);
        expect(fireEvent.keyDown(document.body, { key: 'y', ctrlKey: true })).toBe(true);
        expect(useStickerSheetStore.getState().getTab('stale-history').manifest).toBeNull();
    });

    it('không có lịch sử nhận diện hoặc ở Xén vuông góc thì nhường phím cho Viewer', () => {
        const pdf = new File(['pdf'], 'no-history.pdf', { type: 'application/pdf' });
        render(<StickerCutlineTool tabId="no-history" pdfFile={pdf} isActive onFileFixed={vi.fn()} />);
        expect(fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })).toBe(true);
        expect(fireEvent.keyDown(document.body, { key: 'y', ctrlKey: true })).toBe(true);
        fireEvent.click(screen.getByRole('button', { name: 'Xén vuông góc' }));
        expect(fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })).toBe(true);
    });

    it('chuyển sang Xén vuông góc không còn nhận phím của kết quả cũ', async () => {
        await renderRecognizedShell('rectangle-history');
        const detected = useStickerSheetStore.getState().getTab('rectangle-history').manifest;
        fireEvent.click(screen.getByRole('button', { name: 'Xén vuông góc' }));
        expect(fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })).toBe(true);
        expect(useStickerSheetStore.getState().getTab('rectangle-history').manifest).toBe(detected);
    });

    it('đóng shell đang nhận phím phải dọn listener nhận diện', async () => {
        const { view } = await renderRecognizedShell('closed-history');
        const detected = useStickerSheetStore.getState().getTab('closed-history').manifest;
        view.unmount();
        expect(fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })).toBe(true);
        expect(useStickerSheetStore.getState().getTab('closed-history').manifest).toBe(detected);
    });

    it('materialize Working PDF trước khi inspect và khóa kết quả vào đúng revision', async () => {
        const source = new File(['source'], 'source.pdf', { type: 'application/pdf' });
        const materialized = new File(['rotated'], 'working-rotated.pdf', {
            type: 'application/pdf',
        });
        const revision = { file: source, viewerPageRotations: { 1: 90 } };
        workingPdfMock.capture.mockReturnValue(revision);
        workingPdfMock.materialize.mockResolvedValue(materialized);

        render(
            <StickerCutlineTool
                tabId="revision-tab"
                pdfFile={source}
                sourceImageFile={null}
                isActive
                onFileFixed={vi.fn()}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Nhận diện tự động' }));

        await waitFor(() => expect(detectStickerSource).toHaveBeenCalledTimes(1));
        expect(workingPdfMock.prepare).toHaveBeenCalledTimes(1);
        expect(workingPdfMock.materialize).toHaveBeenCalledWith(revision);
        expect(inspectStickerSource).toHaveBeenCalledWith(
            materialized,
            expect.any(AbortSignal),
            { preview: 'defer' },
        );
        expect(workingPdfMock.materialize.mock.invocationCallOrder[0])
            .toBeLessThan(vi.mocked(inspectStickerSource).mock.invocationCallOrder[0]);
        const tab = useStickerSheetStore.getState().getTab('revision-tab');
        expect(tab.sourceFile).toBe(materialized);
        expect(tab.sourceRevision).toBe(revision);
    });

    it('AI giữ trạng thái cần xem lại nhưng cho phép sửa trực tiếp trên Viewer', async () => {
        vi.mocked(detectStickerSource).mockResolvedValueOnce(detection(true));
        const image = new File(['image'], 'photo.jpg', { type: 'image/jpeg' });
        render(
            <StickerCutlineTool
                tabId="review-tab"
                pdfFile={null}
                sourceImageFile={image}
                isActive
                onFileFixed={vi.fn()}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Nhận diện tự động' }));
        await waitFor(() => expect(
            useStickerSheetStore.getState().getTab('review-tab').status,
        ).toBe('mask-review'));
        expect(confirmStickerSource).not.toHaveBeenCalled();
        expect(screen.queryByRole('button', { name: 'Xác nhận vùng tem' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Tinh chỉnh đường cắt và sửa vùng tem' }));
        expect(screen.getByText('Sửa nhanh vùng tem')).toBeTruthy();
    });

    it('tab nền không nhận file đang mở', async () => {
        const source = new File(['image'], 'background.png', { type: 'image/png' });
        useStickerSheetStore.getState().initTab('background-tab');
        useStickerSheetStore.getState().setMode('background-tab', 'ai-sheet');
        render(
            <StickerCutlineTool
                tabId="background-tab"
                pdfFile={null}
                sourceImageFile={source}
                isActive={false}
                onFileFixed={vi.fn()}
            />,
        );
        await Promise.resolve();
        expect(useStickerSheetStore.getState().getTab('background-tab').sourceFile).toBeNull();
        expect(inspectStickerSource).not.toHaveBeenCalled();
    });

    it('trang AI bám vị trí working khi một source page được nhân bản', async () => {
        const document = new File(['pdf'], '2_anh_nhieu_tem.pdf', { type: 'application/pdf' });
        useStickerSheetStore.getState().initTab('page-tab');
        useStickerSheetStore.getState().setMode('page-tab', 'ai-sheet');
        useStickerSheetStore.getState().selectSource('page-tab', document, 'explicit', 2);

        render(
            <StickerCutlineTool
                tabId="page-tab"
                pdfFile={document}
                sourceImageFile={null}
                activeSourcePage={1}
                activeWorkingPage={2}
                pageOrder={[1, 1]}
                isActive
                onFileFixed={vi.fn()}
            />,
        );

        await waitFor(() => expect(
            useStickerSheetStore.getState().getTab('page-tab').activeSourcePage,
        ).toBe(2));
        expect(inspectStickerSource).not.toHaveBeenCalled();
        expect(detectStickerSource).not.toHaveBeenCalled();
    });

    it('preview trực tiếp dùng vị trí trang trong working PDF sau reorder', async () => {
        const pdf = new File(['pdf'], 'reordered.pdf', { type: 'application/pdf' });
        render(
            <StickerCutlineTool
                tabId="direct-reorder-tab"
                pdfFile={pdf}
                sourceImageFile={null}
                activeSourcePage={3}
                activeWorkingPage={1}
                pageOrder={[3, 1, 2]}
                isActive
                onFileFixed={vi.fn()}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Xén vuông góc' }));
        await waitFor(() => expect(screen.getByText('direct-preview-page:1')).toBeTruthy());
    });

    it('workspace hợp nhất không để lộ bộ chọn mode', async () => {
        const image = new File(['image'], 'source.png', { type: 'image/png' });
        const pdf = new File(['pdf'], 'source.pdf', { type: 'application/pdf' });
        render(
            <StickerCutlineTool
                tabId="switch-tab"
                pdfFile={pdf}
                sourceImageFile={image}
                isActive
                onFileFixed={vi.fn()}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Nhận diện tự động' }));
        expect(screen.queryByRole('button', { name: 'Chọn ảnh khác' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'source.png' })).toBeNull();
        expect(useStickerSheetStore.getState().getTab('switch-tab').mode).toBe('ai-sheet');
        await waitFor(() => expect(detectStickerSource).toHaveBeenCalledTimes(1));
        expect(screen.queryByRole('button', { name: 'PDF/PNG đã có biên' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Tách nhiều tem' })).toBeNull();
    });

    it('nguồn chọn riêng không bị tài liệu Viewer ghi đè', async () => {
        const oldSource = new File(['old'], 'old.png', { type: 'image/png' });
        const viewerDocument = new File(['pdf'], 'viewer.pdf', { type: 'application/pdf' });
        useStickerSheetStore.getState().initTab('viewer-source-tab');
        useStickerSheetStore.getState().setMode('viewer-source-tab', 'ai-sheet');
        useStickerSheetStore.getState().selectSource('viewer-source-tab', oldSource, 'explicit');

        render(
            <StickerCutlineTool
                tabId="viewer-source-tab"
                pdfFile={viewerDocument}
                sourceImageFile={null}
                isActive
                onFileFixed={vi.fn()}
            />,
        );

        await waitFor(() => expect(
            useStickerSheetStore.getState().getTab('viewer-source-tab').sourceFile,
        ).toBe(oldSource));
        expect(useStickerSheetStore.getState().getTab('viewer-source-tab').sourceOrigin)
            .toBe('explicit');
        expect(inspectStickerSource).not.toHaveBeenCalled();
        expect(detectStickerSource).not.toHaveBeenCalled();
    });

    it('Undo về path-stub của nguồn PDF không reset phiên AI hoặc mở nguồn lần hai', async () => {
        const source = new File(['pdf'], 'sheet-source.pdf', { type: 'application/pdf' });
        const historyFile = new File([], 'sheet-source.pdf', { type: 'application/pdf' });
        Object.defineProperty(historyFile, '__prynxStickerSourceFile', {
            value: source,
            configurable: true,
        });
        useStickerSheetStore.getState().initTab('undo-source-tab');
        const current = useStickerSheetStore.getState().getTab('undo-source-tab');
        useStickerSheetStore.setState({
            tabs: {
                'undo-source-tab': {
                    ...current,
                    mode: 'ai-sheet',
                    status: 'mask-ready',
                    sourceFile: source,
                    inspection: inspection().inspection,
                    manifest: detection().manifest,
                },
            },
        });

        render(
            <StickerCutlineTool
                tabId="undo-source-tab"
                pdfFile={historyFile}
                sourceImageFile={null}
                isActive
                onFileFixed={vi.fn()}
            />,
        );

        await waitFor(() => expect(
            useStickerSheetStore.getState().getTab('undo-source-tab').sourceFile,
        ).toBe(source));
        expect(useStickerSheetStore.getState().getTab('undo-source-tab').status).toBe('mask-ready');
        expect(useStickerSheetStore.getState().getTab('undo-source-tab').manifest).not.toBeNull();
    });

    it('khóa đổi luồng nguồn trong lúc công cụ trực tiếp đang chạy', async () => {
        const pdf = new File(['pdf'], 'current.pdf', { type: 'application/pdf' });
        render(
            <StickerCutlineTool
                tabId="busy-tab"
                pdfFile={pdf}
                sourceImageFile={null}
                isActive
                onFileFixed={vi.fn()}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Xén vuông góc' }));
        await waitFor(() => expect(screen.getByText('direct-engine:current.pdf')).toBeTruthy());
        fireEvent.click(screen.getByRole('button', { name: 'start-direct' }));
        const aiButton = screen.getByRole('button', { name: 'Bế tem nhãn' }) as HTMLButtonElement;
        expect(aiButton.disabled).toBe(true);
        fireEvent.click(aiButton);
        expect(screen.getByText('direct-engine:current.pdf')).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: 'finish-direct' }));
        fireEvent.click(aiButton);
        await waitFor(() => expect(useStickerSheetStore.getState().getTab('busy-tab').mode).toBe('ai-sheet'));
    });

    it('AI giữ nguyên luồng sau export và mở đúng hai công cụ bình tem', async () => {
        useStickerSheetStore.getState().initTab('export-tab');
        const source = new File(['pdf'], 'current.pdf', { type: 'application/pdf' });
        const current = useStickerSheetStore.getState().getTab('export-tab');
        useStickerSheetStore.setState({
            tabs: {
                'export-tab': {
                    ...current,
                    mode: 'ai-sheet',
                    status: 'mask-ready',
                    sourceFile: source,
                    sourceOrigin: 'explicit',
                    inspection: inspection().inspection,
                    manifest: detection().manifest,
                },
            },
        });
        vi.mocked(exportStickerSheet).mockResolvedValue({
            blob: new Blob(['pdf']),
            filename: 'tem.pdf',
            outputPath: 'D:\\results\\tem.pdf',
            stickerCount: 1,
        });
        let resolveCommit!: () => void;
        const onFileFixed = vi.fn(() => new Promise<void>(resolve => {
            resolveCommit = resolve;
        }));
        const onOpenTool = vi.fn();
        const pdf = source;

        const { rerender } = render(
            <StickerCutlineTool
                tabId="export-tab"
                pdfFile={pdf}
                sourceImageFile={null}
                isActive
                onOpenTool={onOpenTool}
                onFileFixed={onFileFixed}
            />,
        );
        const exportButton = screen.getByRole('button', { name: 'Tạo PDF có đường cắt' }) as HTMLButtonElement;
        await waitFor(() => expect(exportButton.disabled).toBe(false));
        fireEvent.click(exportButton);
        await waitFor(() => expect(onFileFixed).toHaveBeenCalledTimes(1));
        expect(useStickerSheetStore.getState().getTab('export-tab').status).toBe('exporting');
        expect(screen.queryByRole('button', { name: 'PDF/PNG đã có biên' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Tách nhiều tem' })).toBeNull();

        const generatedPdf = new File(['generated'], 'tem.pdf', { type: 'application/pdf' });
        rerender(
            <StickerCutlineTool
                tabId="export-tab"
                pdfFile={generatedPdf}
                sourceImageFile={null}
                isActive
                onOpenTool={onOpenTool}
                onFileFixed={onFileFixed}
            />,
        );
        resolveCommit();
        await waitFor(() => expect(screen.getByRole('button', { name: 'Bình tem bế' })).toBeTruthy());
        const settingsToggle = screen.getByRole('group', { name: 'Thiết lập đường bế tem' });
        const resultCard = screen.getByRole('status');
        expect(settingsToggle.compareDocumentPosition(resultCard) & Node.DOCUMENT_POSITION_FOLLOWING)
            .toBeTruthy();
        expect(screen.getByRole('spinbutton', { name: 'Bù xén ngoài đường cắt (mm)' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Tạo PDF có đường cắt' })).toBeTruthy();
        expect(screen.getByText('Đã tạo bù xén thành công!')).toBeTruthy();
        const finished = useStickerSheetStore.getState().getTab('export-tab');
        expect(finished.mode).toBe('ai-sheet');
        expect(finished.status).toBe('mask-ready');
        expect(finished.manifest).not.toBeNull();
        expect(finished.sourceFile).toBe(source);
        expect(screen.queryByText('direct-engine:tem.pdf')).toBeNull();
        expect(screen.queryByText(/tem\.pdf/)).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Bình tem bế' }));
        fireEvent.click(screen.getByRole('button', { name: 'Bình bế rớt (CNC)' }));
        expect(onOpenTool).toHaveBeenNthCalledWith(1, 'sticker_imposer');
        expect(onOpenTool).toHaveBeenNthCalledWith(2, 'cnc_imposer');
    });

    it('duplicate source page được xuất theo hai vị trí độc lập của Working PDF', async () => {
        useStickerSheetStore.getState().initTab('order-tab');
        const source = new File(['image'], 'current.png', { type: 'image/png' });
        const current = useStickerSheetStore.getState().getTab('order-tab');
        useStickerSheetStore.setState({
            tabs: {
                'order-tab': {
                    ...current,
                    mode: 'ai-sheet',
                    status: 'mask-ready',
                    sourceFile: source,
                    manifest: detection().manifest,
                },
            },
        });
        useStickerSheetStore.getState().setActivePage('order-tab', 1);
        const prepared = useStickerSheetStore.getState().getTab('order-tab');
        const pageOne = prepared.pages[1];
        if (!pageOne?.manifest) throw new Error('Thiếu fixture trang 1');
        useStickerSheetStore.setState({
            tabs: {
                'order-tab': {
                    ...prepared,
                    sourceImageCount: 2,
                    pages: {
                        1: pageOne,
                        2: {
                            ...pageOne,
                            manifest: {
                                ...pageOne.manifest,
                                page_count: 2,
                                source_page: 2,
                            },
                        },
                    },
                },
            },
        });
        const exportAction = vi.spyOn(
            useStickerSheetStore.getState(),
            'exportFile',
        ).mockResolvedValue(null);

        render(
            <StickerCutlineTool
                tabId="order-tab"
                pdfFile={null}
                sourceImageFile={null}
                activeSourcePage={1}
                pageOrder={[1, 1]}
                isActive
                onFileFixed={vi.fn()}
            />,
        );
        const exportButton = screen.getByRole('button', { name: 'Tạo PDF có đường cắt' }) as HTMLButtonElement;
        await waitFor(() => expect(exportButton.disabled).toBe(false));
        fireEvent.click(exportButton);

        await waitFor(() => expect(exportAction).toHaveBeenCalledWith(
            'order-tab',
            'pdf',
            [1, 2],
            expect.any(Function),
        ));
        exportAction.mockRestore();
    });
});
