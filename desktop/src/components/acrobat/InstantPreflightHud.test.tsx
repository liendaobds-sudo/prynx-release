// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { InstantPreflightHud } from './InstantPreflightHud';
import type { InstantPreflightResult } from '../../lib/instantPreflight';

describe('InstantPreflightHud — Thanh cảnh báo lỗi chế bản tức thì', () => {
    const cleanResult: InstantPreflightResult = {
        hasErrors: false,
        hasWarnings: false,
        issues: [],
        summary: {
            colorMode: 'CMYK',
            hasRgb: false,
            spotColors: ['DieCut'],
            hairlineCount: 0,
            minHairlineWidthPt: null,
            richBlackCount: 0,
            lowResImageCount: 0,
            minImageDpi: 300,
            hasOverprint: false,
            totalImagesChecked: 1,
        },
        scanDurationMs: 15,
        scannedPages: [1],
    };

    const warningResult: InstantPreflightResult = {
        hasErrors: false,
        hasWarnings: true,
        issues: [
            {
                type: 'rich_black',
                severity: 'warning',
                title: 'Chữ đen 4 màu (Rich Black)',
                description: 'Phát hiện 2 cụm chữ dùng màu phối C+M+Y+K.',
                page: 1,
            },
            {
                type: 'hairline',
                severity: 'warning',
                title: 'Nét vẽ mảnh (Hairline)',
                description: 'Phát hiện 3 nét mảnh <= 0.1pt.',
                page: 1,
                metric: '0.05 pt',
            },
        ],
        summary: {
            colorMode: 'CMYK',
            hasRgb: false,
            spotColors: [],
            hairlineCount: 3,
            minHairlineWidthPt: 0.05,
            richBlackCount: 2,
            lowResImageCount: 0,
            minImageDpi: 300,
            hasOverprint: false,
            totalImagesChecked: 1,
        },
        scanDurationMs: 25,
        scannedPages: [1],
    };

    it('Không render gì khi result là null', () => {
        const { container } = render(
            <InstantPreflightHud result={null} onDismiss={vi.fn()} />
        );
        expect(container.firstChild).toBeNull();
    });

    it('Không hiển thị HUD khi file đạt chuẩn (0 lỗi, 0 cảnh báo) để tránh che khuất giao diện', () => {
        const { container } = render(<InstantPreflightHud result={cleanResult} onDismiss={vi.fn()} />);
        expect(container.firstChild).toBeNull();
    });

    it('Hiển thị cảnh báo và cho phép bấm mở rộng xem chi tiết', () => {
        const onOpenTool = vi.fn();
        render(
            <InstantPreflightHud
                result={warningResult}
                onDismiss={vi.fn()}
                onOpenTool={onOpenTool}
            />
        );

        expect(screen.getByText('Cảnh báo in ấn')).toBeDefined();

        // Mở rộng chi tiết
        fireEvent.click(screen.getByTitle('Xem chi tiết'));

        // Kiểm tra thấy các dòng thông tin chi tiết
        expect(screen.getByText('Chữ Rich Black')).toBeDefined();
        expect(screen.getByText('Nét mảnh <0.1pt')).toBeDefined();
        expect(screen.getByText('3 nét (min 0.05 pt)')).toBeDefined();

        // Nút mở công cụ sửa nét mảnh
        const fixHairlineBtn = screen.getByText('Sửa nét mảnh');
        expect(fixHairlineBtn).toBeDefined();
        fireEvent.click(fixHairlineBtn);
        expect(onOpenTool).toHaveBeenCalledWith('hairlines');
    });

    it('Bấm nút đóng gọi callback onDismiss khi có cảnh báo', () => {
        const onDismiss = vi.fn();
        render(<InstantPreflightHud result={warningResult} onDismiss={onDismiss} />);
        const closeBtn = screen.getByTitle('Đóng thông báo');
        fireEvent.click(closeBtn);
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });
});
