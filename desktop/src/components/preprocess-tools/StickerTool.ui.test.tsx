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


vi.mock('../../lib/api', () => ({
    authenticatedFetch: vi.fn(),
    getApiUrl: () => 'http://127.0.0.1:8321',
    uploadPDF: vi.fn(),
}));

vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string) => ({
            'preprocess.sticker:be_tem_nhan': 'Bế tem nhãn',
            'preprocess.sticker:xen_vuong_goc': 'Xén vuông góc',
            'preprocess.sticker:1_duong_cat_dieline': '1. Đường cắt (Dieline)',
            'preprocess.sticker:co_gian_vien': 'Co giãn viền',
            'preprocess.sticker:tao_duong_cat_cho_trang_dau_2': 'Chỉ tạo đường cắt trang đầu',
            'preprocess.sticker:file_nhieu_loai_tem_dung_chung_1_khuon': 'File nhiều loại tem dùng chung một khuôn',
            'preprocess.sticker:so_am_vd_0_5_ep_duong_cat_lun_vao_trong': 'Số âm ép đường cắt lún vào trong',
            'preprocess.sticker:2_tran_le_dac_ruot': '2. Tràn lề & Đặc ruột',
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
            'preprocess.common:run': 'Thực thi',
            'preprocess.sticker:da_tao_bu_xen_thanh_cong': 'Đã tạo bù xén thành công!',
            'preprocess.sticker:buoc_tiep_theo_chon_kieu_dan_trang': 'Bước tiếp theo: Chọn kiểu dàn trang (Imposition)',
            'preprocess.sticker:quay_lai_chinh_sua_bu_xen': 'Quay lại chỉnh sửa bù xén',
        }[key] || key),
    }),
}));

vi.mock('../../hooks/useWorkingPdf', () => ({
    useWorkingPdf: () => vi.fn(async () => null),
}));

vi.mock('../../stores/useWorkspaceStore', () => ({
    useWorkspaceStore: () => ({
        setDetectedShapeType: vi.fn(),
        setDetectedShapeParams: vi.fn(),
        objectSelectionContext: null,
        isObjectEditMode: false,
        setIsObjectEditMode: vi.fn(),
        setIsCropMode: vi.fn(),
        setViewerToolMode: vi.fn(),
    }),
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
        window.localStorage.clear();
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

    it('tự thu thiết lập sau khi tạo đường cắt và cho xổ lại mà vẫn giữ kết quả', async () => {
        vi.mocked(uploadPDF).mockResolvedValue({ id: 'source-id' });
        vi.mocked(authenticatedFetch).mockResolvedValue({
            ok: true,
            headers: new Headers(),
            blob: vi.fn(async () => new Blob(['result'], { type: 'application/pdf' })),
        } as unknown as Response);
        const onFileFixed = vi.fn().mockResolvedValue(undefined);

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
        expect(screen.getByRole('status')).toBe(resultCard);
    });

    it('giữ đúng ticket của tab cho tới callback commit', async () => {
        recipeRecorder.start('tab-a');
        vi.mocked(uploadPDF).mockResolvedValue({ id: 'source-id' });
        vi.mocked(authenticatedFetch).mockResolvedValue({
            ok: true,
            headers: new Headers(),
            blob: vi.fn(async () => new Blob(['result'], { type: 'application/pdf' })),
        } as unknown as Response);
        let releaseCommit!: () => void;
        const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
        const onFileFixed = vi.fn((
            _blob: Blob,
            _name: string,
            _path?: string,
            _ticket?: RecipeOperationTicket | null,
        ) => commitGate);

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

        releaseCommit();
        await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    });
});
