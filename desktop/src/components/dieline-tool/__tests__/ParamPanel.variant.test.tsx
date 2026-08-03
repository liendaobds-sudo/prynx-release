// @vitest-environment jsdom
// ============================================================
// [VARIANT 2026-07-29]
// ParamPanel phải ẨN control của tham số mà biến thể đã CHỐT, và mở lại toàn
// bộ khi bật "Tuỳ chỉnh nâng cao".
//
// Bất biến quan trọng nhất ở đây (Property 7 — không mất tính năng): mọi control
// bị ẩn PHẢI hiện lại được ở chế độ chuyên gia. Ẩn vĩnh viễn = mất tính năng so
// với bản trước, không được phép.
// ============================================================

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ParamPanel from '../ParamPanel';
import { useBoxStore } from '../../../stores/useBoxStore';
import { DEFAULT_PARAMS } from '../../../lib/dieline/types';

// Không gọi sidecar trong test UI
vi.mock('../../../lib/dieline/api', () => ({ generateDielineRemote: vi.fn(() => new Promise(() => {})) }));
vi.mock('../MockupArtworkPanel', () => ({ default: () => <div>Mockup artwork</div> }));
vi.mock('../../../i18n', () => ({ tv: (value: string) => value }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (value: string) => value }) }));

beforeEach(() => {
    useBoxStore.setState({
        params: { ...DEFAULT_PARAMS },
        variantId: null,
        isAdvancedMode: false,
        dieline: null,
        clampVersion: 0,
    });
});

afterEach(cleanup);

/** Mở một mục thu gọn theo nhãn nút. */
function openSection(label: RegExp) {
    fireEvent.click(screen.getByRole('button', { name: label }));
}

/** Ô tích "Lưỡi khoá nắp" nằm trong mục "Thông số đáy/nắp" (showExtra),
 *  KHÔNG phải mục "Thông số nâng cao" — nhầm hai mục này làm test pass giả. */
const openBottomLidSection = () => openSection(/thong_so_day_nap/);
const openPaperBagSection = () => openSection(/thong_so_tui_giay/);

/** Chọn biến thể (store nằm ngoài React ⇒ phải bọc act để React kịp render). */
function pickVariant(id: string) {
    act(() => { useBoxStore.getState().setVariant(id); });
}

describe('ParamPanel — ẩn thuộc tính đã chốt theo biến thể', () => {
    // Khẳng định control CÓ khi chưa có biến thể chốt — nếu thiếu bước này thì
    // test "đã ẩn" pass giả mỗi khi mục thu gọn chưa được mở.
    it('không có biến thể: ô tích "Lưỡi khoá nắp" hiện bình thường', () => {
        act(() => { useBoxStore.getState().setParam('boxType', 'slb'); });
        act(() => { useBoxStore.setState({ variantId: null }); });
        render(<ParamPanel />);
        openBottomLidSection();
        expect(screen.getByText(/luoi_khoa_nap/)).toBeTruthy();
    });

    it('hộp đáy gài: biến thể chốt lockTab ⇒ ẩn ô tích "Lưỡi khoá nắp"', () => {
        pickVariant('slb_plain');
        render(<ParamPanel />);
        openBottomLidSection();
        expect(screen.queryByText(/luoi_khoa_nap/)).toBeNull();
    });

    // Property 7: không mất tính năng — bật chế độ chuyên gia là hiện lại
    it('bật "Tuỳ chỉnh nâng cao" thì ô tích bị ẩn hiện lại và sửa được', () => {
        pickVariant('slb_plain');
        render(<ParamPanel />);
        openBottomLidSection();
        expect(screen.queryByText(/luoi_khoa_nap/)).toBeNull();

        fireEvent.click(screen.getByText(/tuy_chinh_nang_cao/));
        expect(screen.getByText(/luoi_khoa_nap/)).toBeTruthy();

        // Sửa được thật: click vào ô tích đổi lockTab false → true
        expect(useBoxStore.getState().params.lockTab).toBe(false);
        fireEvent.click(screen.getByText(/luoi_khoa_nap/));
        expect(useBoxStore.getState().params.lockTab).toBe(true);
    });

    it('chip "đã tuỳ chỉnh" chỉ hiện sau khi sửa thuộc tính bị chốt', () => {
        pickVariant('slb_plain');
        render(<ParamPanel />);
        expect(screen.queryByText(/da_tuy_chinh/)).toBeNull();

        act(() => { useBoxStore.getState().setParam('lockTab', true); });
        expect(screen.getByText(/da_tuy_chinh/)).toBeTruthy();
    });

    it('hộp treo: biến thể chốt hgbWindow ⇒ ẩn công tắc cửa sổ, giữ số đo', () => {
        pickVariant('hgb_window');
        render(<ParamPanel />);
        expect(screen.queryByText(/cua_so_mat_truoc/)).toBeNull();
        // Số đo cửa sổ KHÔNG bị ẩn — đó là số đo, không phải quyết định kiểu hộp
        expect(screen.getByText(/rong_cua_so/)).toBeTruthy();
    });

    it('hộp pizza: cả gói 3 công tắc bị chốt ⇒ ẩn luôn tiêu đề section', () => {
        pickVariant('pizza_full');
        render(<ParamPanel />);
        expect(screen.queryByText(/tinh_nang_hop_pizza/)).toBeNull();
        expect(screen.queryByText(/lo_thong_hoi/)).toBeNull();
        expect(screen.queryByText(/khoa_goc_xep_chong/)).toBeNull();
    });

    it('bì thư nắp nhọn: ẩn dạng nắp, kiểu bì và công tắc cửa sổ', () => {
        pickVariant('env_wallet_pointed');
        render(<ParamPanel />);
        expect(screen.queryByText(/dang_nap_dan/)).toBeNull();
        expect(screen.queryByText(/kieu_bi_thu/)).toBeNull();
        expect(screen.queryByText(/cua_so_trong_suot/)).toBeNull();
    });

    it('bì thư có cửa sổ: ẩn kiểu bì + công tắc cửa sổ nhưng GIỮ dạng nắp', () => {
        // Biến thể này cố ý không chốt envFlapShape — lúc đó cửa sổ mới là điểm
        // phân biệt chính, dáng nắp vẫn để người dùng chọn (Req 7.3).
        pickVariant('env_window');
        render(<ParamPanel />);
        expect(screen.queryByText(/kieu_bi_thu/)).toBeNull();
        expect(screen.queryByText(/cua_so_trong_suot/)).toBeNull();
        expect(screen.getByText(/dang_nap_dan/)).toBeTruthy();
    });

    it('hộp quai xách: ẩn kiểu mái nhưng giữ dạng/vị trí lỗ quai', () => {
        pickVariant('gable_pitched');
        render(<ParamPanel />);
        expect(screen.queryByText(/kieu_mai/)).toBeNull();
        expect(screen.getByText(/dang_lo_quai/)).toBeTruthy();
        expect(screen.getByText(/vi_tri_lo/)).toBeTruthy();
    });

    it('túi giấy: ẩn công tắc lỗ xỏ quai, giữ cao đáy BF', () => {
        pickVariant('bag_holes');
        render(<ParamPanel />);
        openPaperBagSection();
        expect(screen.queryByText(/lo_xo_day/)).toBeNull();
        expect(screen.getByText(/cao_day_bf/)).toBeTruthy();
    });

    it('túi trơn không quai: tắt và ẩn mí gập miệng, chế độ chuyên gia mở lại được', () => {
        pickVariant('bag_plain');
        expect(useBoxStore.getState().params.TH).toBe(0);
        render(<ParamPanel />);

        openSection(/thong_so_nang_cao/);
        expect(screen.queryByText(/mi_gap_mieng/)).toBeNull();

        fireEvent.click(screen.getByText(/tuy_chinh_nang_cao/));
        expect(screen.getByText(/mi_gap_mieng/)).toBeTruthy();
    });

    it('bọc ly: ẩn vị trí vạt dán, giữ loại chiều cao', () => {
        pickVariant('sleeve_glued');
        render(<ParamPanel />);
        expect(screen.queryByText(/vi_tri_vat_dan/)).toBeNull();
        expect(screen.getByText(/loai_chieu_cao/)).toBeTruthy();
    });

    it('biến thể không chốt gì (nắp cài so le): không ẩn control nào, không có công tắc chuyên gia', () => {
        pickVariant('rte_std');
        render(<ParamPanel />);
        // rte không có ô lưỡi khoá nắp sẵn, nên kiểm bằng thứ nó CÓ
        expect(screen.getByText(/vi_tri_tai_dan_g/)).toBeTruthy();
        expect(screen.getByText(/thu_tu_mat/)).toBeTruthy();
        // Không chốt gì ⇒ không cần công tắc mở khoá
        expect(screen.queryByText(/tuy_chinh_nang_cao/)).toBeNull();
    });

    it('ô chọn mẫu khuôn đổi biến thể và hiện mã khuôn', () => {
        pickVariant('slb_plain');
        render(<ParamPanel />);
        expect(screen.getByText('PRYNX-SLB-01')).toBeTruthy();

        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'slb_lock' } });
        expect(useBoxStore.getState().variantId).toBe('slb_lock');
        expect(useBoxStore.getState().params.lockTab).toBe(true);
    });
    it('flip-top tuck chỉ hiện L/W/D/T và C, không hiện tham số keo/tai đút', () => {
        pickVariant('ftt_self_lock');
        render(<ParamPanel />);

        expect(screen.getByText('Dài (L)')).toBeTruthy();
        expect(screen.getByText('Rộng (W)')).toBeTruthy();
        expect(screen.getByText('Cao (D)')).toBeTruthy();
        expect(screen.getByText('Dày (T)')).toBeTruthy();
        expect(screen.queryByText(/vi_tri_tai_dan_g/)).toBeNull();
        expect(screen.queryByText(/thu_tu_mat/)).toBeNull();

        openSection(/thong_so_nang_cao/);
        expect(screen.getByText('Dung sai (C)')).toBeTruthy();
        expect(screen.queryByText('Mép keo (G)')).toBeNull();
        expect(screen.queryByText('Tai đút (TH)')).toBeNull();
    });

});
