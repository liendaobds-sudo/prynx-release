import { describe, expect, it } from 'vitest';
import {
    clusterBarcodeBars,
    isBackgroundImage,
    isDecorativeOrContainer,
    normalizeRect,
    rectFromBbox,
    rectFullyContains,
    rectsIntersect,
    type VdpPickerObject,
} from './VdpCodePicker.geometry';

describe('VdpCodePicker geometry', () => {
    it('normalizes negative bbox dimensions and applies canvas scale', () => {
        expect(rectFromBbox([10, 20, -4, 8], 2)).toEqual({ x: 12, y: 40, width: 8, height: 16 });
        expect(normalizeRect(20, 10, 2, 4)).toEqual({ x: 2, y: 4, width: 18, height: 6 });
    });

    it('requires a complete object inside marquee', () => {
        const marquee = normalizeRect(10, 10, 100, 100);
        expect(rectFullyContains(marquee, { x: 20, y: 20, width: 10, height: 10 })).toBe(true);
        expect(rectFullyContains(marquee, { x: 0, y: 20, width: 15, height: 10 })).toBe(false);
        expect(rectsIntersect(marquee, { x: 0, y: 20, width: 15, height: 10 })).toBe(true);
    });

    it('identifies a page sized image as a background to protect artwork', () => {
        expect(isBackgroundImage({ x: 0, y: 0, width: 595, height: 842 }, { width: 595, height: 842 })).toBe(true);
        expect(isBackgroundImage({ x: 20, y: 20, width: 100, height: 100 }, { width: 595, height: 842 })).toBe(false);
    });

    it('lọc bỏ các khung nền, card lớn và đường kẻ phân cách cực mảnh', () => {
        const pageSize = { width: 595, height: 842 }; // diện tích ~500.000 pt²

        // Card container lớn chiếm > 12% diện tích trang
        expect(isDecorativeOrContainer({ x: 20, y: 20, width: 300, height: 250 }, pageSize)).toBe(true);

        // Đường kẻ ngang phân cách (dài 300pt, dày 1pt)
        expect(isDecorativeOrContainer({ x: 50, y: 100, width: 300, height: 1 }, pageSize)).toBe(true);

        // Đường kẻ dọc phân cách (dài 400pt, dày 1pt)
        expect(isDecorativeOrContainer({ x: 100, y: 50, width: 1, height: 400 }, pageSize)).toBe(true);

        // Khung QR code bình thường (60x60pt) -> Không phải rác
        expect(isDecorativeOrContainer({ x: 100, y: 100, width: 60, height: 60 }, pageSize)).toBe(false);

        // Khung Barcode bình thường (120x40pt) -> Không phải rác
        expect(isDecorativeOrContainer({ x: 100, y: 100, width: 120, height: 40 }, pageSize)).toBe(false);
    });

    it('tự động gom cụm nhóm thanh vector thành một đối tượng mã vạch duy nhất', () => {
        const pageSize = { width: 595, height: 842 };
        const bars: VdpPickerObject[] = [];

        // Tạo 10 thanh vector song song (dày 1-2pt, cao 40pt, x từ 100 đến 125)
        for (let i = 0; i < 10; i++) {
            bars.push({
                id: `bar-${i}`,
                drawIndex: i + 1,
                type: 'vector',
                bbox: [100 + i * 2.5, 200, 1.2, 40],
                label: `Thanh ${i}`,
            });
        }

        // Thêm một khung clipmask/nền kề sát quanh mã vạch
        const clipmask: VdpPickerObject = {
            id: 'barcode-bg',
            drawIndex: 11,
            type: 'vector',
            bbox: [98, 198, 28, 44],
            label: 'Khung nền mã vạch',
        };

        // Thêm một đối tượng ảnh QR và một card container lớn
        const qrImage: VdpPickerObject = {
            id: 'qr-img',
            drawIndex: 20,
            type: 'image',
            bbox: [300, 100, 70, 70],
            label: 'QR Code Image',
        };

        const largeCard: VdpPickerObject = {
            id: 'card-container',
            drawIndex: 30,
            type: 'vector',
            bbox: [10, 10, 400, 300],
            label: 'Card nền lớn',
        };

        const objects: VdpPickerObject[] = [...bars, clipmask, qrImage, largeCard];
        const clustered = clusterBarcodeBars(objects, pageSize);

        // Kỳ vọng:
        // 1. Toàn bộ 10 thanh vector và khung nền clipmask được gộp thành 1 đối tượng mã vạch composite
        // 2. Card lớn bị lọc bỏ
        // 3. QR code được giữ nguyên
        // Tổng số đối tượng chỉ còn 2 (Barcode + QR), thay vì 13 đối tượng gây rối mắt!
        expect(clustered.length).toBe(2);

        const barcode = clustered.find((o) => o.id.startsWith('barcode-cluster-'));
        expect(barcode).toBeDefined();
        expect(barcode?.type).toBe('vector');
        expect(barcode?.memberDrawIndices).toHaveLength(11); // 10 bars + 1 clipmask
        expect(barcode?.memberDrawIndices).toEqual(expect.arrayContaining([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]));

        const qr = clustered.find((o) => o.id === 'qr-img');
        expect(qr).toBeDefined();
        expect(qr?.type).toBe('image');
    });

    it('giữ nguyên mã QR dạng ảnh chiếm tỷ lệ lớn (~47%) trên nhãn nhỏ (như file scis_link- file in.pdf)', () => {
        // Nhãn nhỏ: 65.2 x 99.2 pt, QR chiếm 55.3 x 55.3 pt (~47% diện tích)
        const labelSize = { width: 65.2, height: 99.2 };
        const qrImage: VdpPickerObject = {
            id: 'qr-label-image',
            drawIndex: 4,
            type: 'image',
            bbox: [4.93, 29.77, 55.33, 55.33],
            label: 'QR Code scis_link',
        };
        const bgVector: VdpPickerObject = {
            id: 'bg-card',
            drawIndex: 0,
            type: 'vector',
            bbox: [0, 0, 65.2, 99.2],
            label: 'Nền bo góc',
        };

        const clustered = clusterBarcodeBars([bgVector, qrImage], labelSize);

        // Vector nền toàn trang bị lọc, ảnh mã QR được giữ nguyên vẹn
        expect(clustered.length).toBe(1);
        expect(clustered[0].id).toBe('qr-label-image');
        expect(clustered[0].type).toBe('image');
    });

    it('loại bỏ hoàn toàn các khung nền, card, và dòng kẻ chấm vector không phải mã vạch', () => {
        const pageSize = { width: 595, height: 842 };
        const cardBox: VdpPickerObject = {
            id: 'card-box',
            drawIndex: 1,
            type: 'vector',
            bbox: [100, 200, 300, 150],
            label: 'Khung card bo góc',
        };
        const dottedLine1: VdpPickerObject = {
            id: 'dotted-line-1',
            drawIndex: 2,
            type: 'vector',
            bbox: [120, 240, 260, 2],
            label: 'Dòng kẻ chấm 1',
        };
        const dottedLine2: VdpPickerObject = {
            id: 'dotted-line-2',
            drawIndex: 3,
            type: 'vector',
            bbox: [120, 280, 260, 2],
            label: 'Dòng kẻ chấm 2',
        };

        const clustered = clusterBarcodeBars([cardBox, dottedLine1, dottedLine2], pageSize);
        // Không có thanh mã vạch song song hay ảnh QR nào -> không được gợi ý mã vạch bừa bãi
        expect(clustered).toHaveLength(0);
    });
});

