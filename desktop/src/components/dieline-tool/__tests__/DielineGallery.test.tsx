// @vitest-environment jsdom
// ============================================================
// [VARIANT 2026-07-29]
// Test thư viện biến thể khuôn bế: sidebar nhóm có đếm số, lọc theo nhóm,
// tìm kiếm bỏ dấu, trạng thái rỗng, và onSelect trả về `variant.id`.
//
// Đây là bản thay thế cho bước "kiểm tay trong app" mà môi trường agent không
// làm được — logic lọc/đếm đã có unit test riêng ở variants.test.ts, tệp này
// khoá phần ĐẤU NỐI React (nút nào bấm ra cái gì).
// ============================================================

import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DielineGallery from '../DielineGallery';
import { BOX_VARIANTS, countByGroup, variantsInGroup } from '../../../lib/dieline/variants';

vi.mock('../../../i18n', () => ({ tv: (value: string) => value }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (value: string) => value }) }));

// `import.meta.glob` quét thư mục thật; mock để test không phụ thuộc việc thư mục
// `src/assets/dieline/variants` đang có ảnh nào.
const { thumbOverride } = vi.hoisted(() => ({
    thumbOverride: vi.fn<(code: string) => string | undefined>(() => undefined),
}));
vi.mock('../variantThumbs', () => ({
    variantThumbOverride: thumbOverride,
    variantThumbOverrideCount: () => 0,
}));

beforeEach(() => thumbOverride.mockReset());
afterEach(cleanup);

/** Số card đang hiển thị = số nút card (nút nhóm nằm trong <nav>). */
function cardCount(): number {
    return document.querySelectorAll('.dt-gallery-card').length;
}

describe('DielineGallery — thư viện biến thể', () => {
    it('hiện đủ mọi biến thể trong catalog khi chưa lọc', () => {
        render(<DielineGallery onSelect={vi.fn()} />);
        expect(cardCount()).toBe(BOX_VARIANTS.length);
    });

    it('mỗi card hiện mã khuôn để thợ đọc/gọi điện báo', () => {
        render(<DielineGallery onSelect={vi.fn()} />);
        for (const v of BOX_VARIANTS) {
            expect(screen.getAllByText(v.code).length).toBeGreaterThan(0);
        }
    });

    it('sidebar hiện số đếm lấy từ catalog, không phải hằng số nhập tay', () => {
        render(<DielineGallery onSelect={vi.fn()} />);
        const counts = countByGroup();
        const nav = screen.getByRole('navigation');
        // "Tất cả" = tổng số biến thể
        expect(nav.textContent).toContain(String(BOX_VARIANTS.length));
        for (const [group, n] of Object.entries(counts)) {
            expect(nav.textContent, `nhóm ${group}`).toContain(String(n));
        }
    });

    it('lọc theo nhóm chỉ hiện biến thể thuộc nhóm đó', () => {
        render(<DielineGallery onSelect={vi.fn()} />);
        // Phải giới hạn trong <nav>: tên nhóm cũng xuất hiện trong tên card
        const nav = screen.getByRole('navigation');
        const btn = within(nav).getByRole('button', { name: /Bì thư/ });
        fireEvent.click(btn);
        expect(cardCount()).toBe(variantsInGroup('bi_thu').length);
    });

    it('tìm kiếm khớp không dấu và khớp cả mã khuôn', () => {
        render(<DielineGallery onSelect={vi.fn()} />);
        const box = screen.getByRole('searchbox');

        fireEvent.change(box, { target: { value: 'hop treo' } });
        const hangingCount = cardCount();
        expect(hangingCount).toBeGreaterThan(0);
        expect(hangingCount).toBeLessThan(BOX_VARIANTS.length);

        fireEvent.change(box, { target: { value: 'PRYNX-SLB-02' } });
        expect(cardCount()).toBe(1);
    });

    it('không có kết quả: hiện thông báo rỗng và nút xem tất cả', () => {
        render(<DielineGallery onSelect={vi.fn()} />);
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'khong-co-thu-nay' } });
        expect(cardCount()).toBe(0);

        const reset = screen.getByRole('button', { name: /xem_tat_ca/ });
        fireEvent.click(reset);
        expect(cardCount()).toBe(BOX_VARIANTS.length);
    });

    it('onSelect trả về variant.id (không phải boxType)', () => {
        const onSelect = vi.fn();
        render(<DielineGallery onSelect={onSelect} />);
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'PRYNX-SLB-02' } });
        fireEvent.click(document.querySelector('.dt-gallery-card') as HTMLElement);
        expect(onSelect).toHaveBeenCalledWith('slb_lock');
    });



    // [VARIANT 2026-07-29] MỘT ảnh mỗi card, đặt tên theo MÃ KHUÔN — chính là tệp
    // người dùng ghi đè. Bộ ảnh theo boxType đã gồm cả nét khuôn lẫn hộp 3D nên
    // KHÔNG được vẽ thêm dải khuôn riêng (hiện nét khuôn hai lần).
    it('chưa thay ảnh: card dùng khuôn 2D SVG theo mã khuôn', () => {
        render(<DielineGallery onSelect={vi.fn()} />);
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'PRYNX-SLB-02' } });

        const imgs = document.querySelectorAll('.dt-gallery-card img');
        expect(imgs.length).toBe(1);
        expect(imgs[0].getAttribute('src')).toBe('/images/dieline/variants/PRYNX-SLB-02.svg');
    });

    it('đã thay ảnh: card ưu tiên ảnh trong src/assets, không phải SVG', () => {
        thumbOverride.mockImplementation((code: string) =>
            code === 'PRYNX-SLB-02' ? '/assets/PRYNX-SLB-02-hash.png' : undefined);

        render(<DielineGallery onSelect={vi.fn()} />);
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'PRYNX-SLB-02' } });
        expect(
            (document.querySelector('.dt-gallery-card-img') as HTMLImageElement).getAttribute('src'),
        ).toBe('/assets/PRYNX-SLB-02-hash.png');
    });

    it('ảnh lỗi thì hiện khung giữ chỗ mang mã khuôn', () => {
        render(<DielineGallery onSelect={vi.fn()} />);
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'PRYNX-SLB-02' } });

        fireEvent.error(document.querySelector('.dt-gallery-card-img') as HTMLImageElement);
        expect(document.querySelectorAll('.dt-gallery-card-placeholder').length).toBe(1);
        expect(cardCount()).toBe(1);
    });
});
