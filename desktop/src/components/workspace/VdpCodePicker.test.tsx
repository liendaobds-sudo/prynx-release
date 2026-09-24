// @vitest-environment jsdom

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VdpCodePicker, type VdpPickerObject } from './VdpCodePicker';

// Mock i18next
vi.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string, fallback?: string) => fallback || key,
    }),
}));

// Mock sonner toast
vi.mock('sonner', () => ({
    toast: {
        warning: vi.fn(),
        success: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
    },
}));

// Polyfill PointerEvent cho môi trường JSDOM
if (typeof window !== 'undefined' && !window.PointerEvent) {
    class MockPointerEvent extends MouseEvent {
        pointerId: number;
        constructor(type: string, params: any = {}) {
            super(type, params);
            this.pointerId = params.pointerId ?? 0;
        }
    }
    window.PointerEvent = MockPointerEvent as any;
}
if (typeof window !== 'undefined' && window.HTMLElement) {
    window.HTMLElement.prototype.setPointerCapture = vi.fn();
    window.HTMLElement.prototype.releasePointerCapture = vi.fn();
}

describe('VdpCodePicker', () => {
    const mockObjects: VdpPickerObject[] = [
        {
            id: 'qr-1',
            drawIndex: 10,
            type: 'image',
            bbox: [100, 100, 50, 50], // vuông vắn -> QR
            label: 'QR Code',
        },
        {
            id: 'barcode-1',
            drawIndex: 20,
            type: 'vector',
            bbox: [100, 200, 120, 30], // dẹt ngang -> Barcode
            label: 'Barcode',
        },
    ];

    it('không hiển thị bất kỳ thanh công cụ hay banner hướng dẫn nổi nào trên view chính', () => {
        render(
            <VdpCodePicker
                objects={mockObjects}
                scale={1}
                pageSize={{ width: 595, height: 842 }}
                onPick={vi.fn()}
            />
        );

        // Khung picker tồn tại để bắt tương tác nhấp/quét
        expect(screen.getByTestId('vdp-code-picker')).toBeTruthy();

        // Không có thanh công cụ nổi "mã", dropdown, input hay instruction badge
        expect(screen.queryByText('misc.vdpPicker:title')).toBeNull();
        expect(screen.queryByLabelText('misc.vdpPicker:kind_label')).toBeNull();
        expect(screen.queryByLabelText('misc.vdpPicker:name_label')).toBeNull();
        expect(screen.queryByText('misc.vdpPicker:instruction')).toBeNull();
    });

    it('render các vùng highlight đối tượng với tooltip rõ ràng', () => {
        render(
            <VdpCodePicker
                objects={mockObjects}
                scale={1}
                pageSize={{ width: 595, height: 842 }}
                onPick={vi.fn()}
            />
        );

        const obj1 = screen.getByTestId('vdp-object-10');
        const obj2 = screen.getByTestId('vdp-object-20');
        expect(obj1).toBeTruthy();
        expect(obj2).toBeTruthy();
    });

    it('khi click vào đối tượng vuông vắn thì tự động nhận diện và gọi onPick qrcode', async () => {
        const onPick = vi.fn();
        render(
            <VdpCodePicker
                objects={mockObjects}
                scale={1}
                pageSize={{ width: 595, height: 842 }}
                onPick={onPick}
            />
        );

        const surface = screen.getByTestId('vdp-code-picker');
        // Giả lập click tại tọa độ (120, 120) trúng mockObjects[0]
        vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({
            left: 0,
            top: 0,
            right: 500,
            bottom: 500,
            width: 500,
            height: 500,
            x: 0,
            y: 0,
            toJSON: () => {},
        });

        fireEvent.pointerDown(surface, { clientX: 120, clientY: 120, button: 0 });

        expect(onPick).toHaveBeenCalledWith(
            expect.objectContaining({
                drawIndices: [10],
                fieldType: 'qrcode',
            })
        );
    });

    it('khi click vào đối tượng dẹt ngang thì tự động ước lượng barcode', async () => {
        const onPick = vi.fn();
        render(
            <VdpCodePicker
                objects={mockObjects}
                scale={1}
                pageSize={{ width: 595, height: 842 }}
                onPick={onPick}
            />
        );

        const surface = screen.getByTestId('vdp-code-picker');
        vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({
            left: 0,
            top: 0,
            right: 500,
            bottom: 500,
            width: 500,
            height: 500,
            x: 0,
            y: 0,
            toJSON: () => {},
        });

        fireEvent.pointerDown(surface, { clientX: 150, clientY: 215, button: 0 });

        expect(onPick).toHaveBeenCalledWith(
            expect.objectContaining({
                drawIndices: [20],
                fieldType: 'barcode',
                barcodeType: 'code128',
            })
        );
    });

    it('áp dụng phong cách Hover-to-Reveal (viền trong suốt mặc định, không che tài liệu)', () => {
        render(
            <VdpCodePicker
                objects={mockObjects}
                scale={1}
                pageSize={{ width: 595, height: 842 }}
                onPick={vi.fn()}
            />
        );

        const obj1 = screen.getByTestId('vdp-object-10');
        expect(obj1.className).toContain('border-transparent');
        expect(obj1.className).toContain('bg-transparent');
        expect(obj1.className).toContain('hover:border-indigo-400');
    });

    it('khi click vào cụm mã vạch thì chọn toàn bộ các thanh thành viên (memberDrawIndices)', async () => {
        const onPick = vi.fn();
        const clusterObject: VdpPickerObject = {
            id: 'barcode-cluster-1',
            drawIndex: 100,
            type: 'vector',
            bbox: [50, 50, 120, 40],
            label: 'Mã vạch (10 thanh)',
            memberDrawIndices: [100, 101, 102, 103, 104, 105],
        };

        render(
            <VdpCodePicker
                objects={[clusterObject]}
                scale={1}
                pageSize={{ width: 595, height: 842 }}
                onPick={onPick}
            />
        );

        const surface = screen.getByTestId('vdp-code-picker');
        vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({
            left: 0,
            top: 0,
            right: 500,
            bottom: 500,
            width: 500,
            height: 500,
            x: 0,
            y: 0,
            toJSON: () => {},
        });

        fireEvent.pointerDown(surface, { clientX: 70, clientY: 70, button: 0 });

        expect(onPick).toHaveBeenCalledWith(
            expect.objectContaining({
                drawIndices: [100, 101, 102, 103, 104, 105],
                fieldType: 'barcode',
            })
        );
    });
});

