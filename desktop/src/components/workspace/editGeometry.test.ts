import { describe, it, expect } from 'vitest';
import {
    pageWidthPtFromDim,
    pageHeightPtFromDim,
    editScale,
    objectBboxNativeToCanvas,
    clipRectPdfToCanvas,
    addBboxCanvasToNative,
    moveDeltaCanvasToPdf,
    snapRotation,
    rotationScreenToPdf,
    normalizeFontName,
    pickFontForName,
    type BBox,
} from './editGeometry';

describe('px@96 ↔ point', () => {
    it('pageWidthPtFromDim: px@96 → point (×72/96)', () => {
        expect(pageWidthPtFromDim(800)).toBeCloseTo(600, 6); // 800*72/96
        expect(pageHeightPtFromDim(1123)).toBeCloseTo(842.25, 2);
    });
    it('fallback khi thiếu pageDim', () => {
        expect(pageWidthPtFromDim(undefined)).toBeCloseTo(595 * 72 / 96, 6);
        expect(pageHeightPtFromDim(null)).toBeCloseTo(842 * 72 / 96, 6);
    });
    it('editScale = px / point', () => {
        expect(editScale(600, 600)).toBeCloseTo(1, 6);
        expect(editScale(1200, 600)).toBeCloseTo(2, 6);
    });
});

describe('objectBboxNativeToCanvas (lật y + offset CropBox)', () => {
    const pageHpt = 800;
    it('không offset (CropBox gốc 0,0): lật trục y đúng', () => {
        // native [10, 700, 60, 720] (yb=700,yt=720) → top=800-720=80, bottom=800-700=100
        const out = objectBboxNativeToCanvas([10, 700, 60, 720], pageHpt, 0, 0);
        expect(out).toEqual([10, 80, 60, 100]);
    });
    it('có offset CropBox (bx0,by0): trừ gốc trước khi lật', () => {
        // CropBox gốc (50,50). native x bị +50, y bị +50.
        // x: 110-50=60..160-50=110; y: top=800-(720-50)=130, bottom=800-(700-50)=150
        const out = objectBboxNativeToCanvas([110, 700, 160, 720], pageHpt, 50, 50);
        expect(out).toEqual([60, 130, 110, 150]);
    });
    it('đảm bảo y0<=y1 (min/max) bất kể thứ tự', () => {
        const out = objectBboxNativeToCanvas([0, 100, 10, 200], 1000, 0, 0);
        expect(out[1]).toBeLessThanOrEqual(out[3]);
    });
});

describe('clipRectPdfToCanvas (clip PDF point → canvas px, lật y + offset Page_Box + scale)', () => {
    const pageHpt = 800;
    it('không offset (bx0=by0=0), scale=1: quy đổi cơ bản + lật y đúng (Yêu cầu 4.1)', () => {
        // clipRect native [x0=10, yb=700, x1=60, yt=720]
        // left=10, right=60; top=800-720=80, bottom=800-700=100
        const out = clipRectPdfToCanvas([10, 700, 60, 720], pageHpt, 0, 0, 1);
        expect(out).toEqual([10, 80, 60, 100]);
    });

    it('CropBox lệch gốc (bx0,by0 != 0): trừ gốc TRƯỚC khi lật (Yêu cầu 4.2 — chống regression)', () => {
        // Page_Box gốc (50,50). clip ở native [110,700,160,720].
        // left=110-50=60, right=160-50=110
        // top=800-(720-50)=130, bottom=800-(700-50)=150
        const out = clipRectPdfToCanvas([110, 700, 160, 720], pageHpt, 50, 50, 1);
        expect(out).toEqual([60, 130, 110, 150]);
    });

    it('scale != 1 (2.0): nhân scale đúng sau khi quy đổi (Yêu cầu 4.3)', () => {
        // không offset; sau quy đổi [10,80,60,100] rồi ×2
        const out = clipRectPdfToCanvas([10, 700, 60, 720], pageHpt, 0, 0, 2);
        expect(out).toEqual([20, 160, 120, 200]);
    });

    it('offset CropBox + scale cùng lúc: trừ gốc rồi nhân scale (Yêu cầu 4.2, 4.3)', () => {
        // Page_Box gốc (50,50), scale=2. clip native [110,700,160,720].
        // left=(110-50)*2=120, right=(160-50)*2=220
        // top=(800-(720-50))*2=260, bottom=(800-(700-50))*2=300
        const out = clipRectPdfToCanvas([110, 700, 160, 720], pageHpt, 50, 50, 2);
        expect(out).toEqual([120, 260, 220, 300]);
    });

    it('đảm bảo top<=bottom và left<=right bất kể thứ tự cạnh đầu vào', () => {
        // Cạnh đảo ngược: x0>x1, yb>yt
        const out = clipRectPdfToCanvas([60, 720, 10, 700], pageHpt, 0, 0, 1);
        expect(out[0]).toBeLessThanOrEqual(out[2]); // left <= right
        expect(out[1]).toBeLessThanOrEqual(out[3]); // top <= bottom
        // Kết quả chuẩn hoá khớp với thứ tự đúng [10,80,60,100]
        expect(out).toEqual([10, 80, 60, 100]);
    });

    it('round-trip xấp xỉ: objectBboxNativeToCanvas (point) khớp clipRect khi scale=1', () => {
        // Cùng quy ước lật y + trừ gốc; với scale=1 hai hàm cho cùng hình học (point=px).
        const bbox: BBox = [110, 700, 160, 720];
        const viaObject = objectBboxNativeToCanvas(bbox, pageHpt, 50, 50);
        const viaClip = clipRectPdfToCanvas(bbox, pageHpt, 50, 50, 1);
        for (let i = 0; i < 4; i++) {
            expect(viaClip[i]).toBeCloseTo(viaObject[i], 6);
        }
    });
});

describe('addBboxCanvasToNative (canvas → PDF native + offset CropBox)', () => {
    it('round-trip với objectBboxNativeToCanvas (offset 0)', () => {        const pageHpt = 800;
        // Thêm tại canvas (x=30,yTop=120), kích thước 200x20.
        const nat = addBboxCanvasToNative(30, 120, 200, 20, pageHpt, 0, 0);
        // native bottom = 800-(120+20)=660 ; top = 800-120=680
        expect(nat).toEqual([30, 660, 230, 680]);
    });
    it('cộng lại gốc CropBox', () => {
        const nat = addBboxCanvasToNative(30, 120, 200, 20, 800, 50, 50);
        // x +50; y: 800-140+50=710 ; 800-120+50=730
        expect(nat).toEqual([80, 710, 280, 730]);
    });
});

describe('moveDeltaCanvasToPdf', () => {
    it('dx giữ, dy đảo dấu, chia scale', () => {
        expect(moveDeltaCanvasToPdf(100, 60, 2)).toEqual({ dx: 50, dy: -30 });
        expect(moveDeltaCanvasToPdf(-40, -20, 1)).toEqual({ dx: -40, dy: 20 });
    });
});

describe('rotation', () => {
    it('snap 45° khi giữ Shift', () => {
        expect(snapRotation(40, true)).toBe(45);
        expect(snapRotation(23, true)).toBe(45);
        expect(snapRotation(22, true)).toBe(0);
        expect(snapRotation(91, true)).toBe(90);
    });
    it('không snap khi không Shift', () => {
        expect(snapRotation(37.3, false)).toBe(37.3);
    });
    it('góc gửi backend đảo dấu', () => {
        expect(rotationScreenToPdf(45)).toBe(-45);
        expect(rotationScreenToPdf(-90)).toBe(90);
    });
});

describe('font name matching', () => {
    const fonts = [
        { name: 'Arial', path: 'C:/arial.ttf' },
        { name: 'Montserrat', path: 'C:/mont.ttf' },
        { name: 'Montserrat Bold', path: 'C:/mont-bold.ttf' },
        { name: 'Times New Roman', path: 'C:/times.ttf' },
    ];
    it('normalize bỏ ký tự đặc biệt', () => {
        expect(normalizeFontName('Montserrat-Bold')).toBe('montserratbold');
        expect(normalizeFontName('Times New Roman')).toBe('timesnewroman');
    });
    it('khớp tuyệt đối (chuẩn hoá)', () => {
        expect(pickFontForName('arial', fonts)?.path).toBe('C:/arial.ttf');
        expect(pickFontForName('Times-New-Roman', fonts)?.path).toBe('C:/times.ttf');
    });
    it('khớp chứa lẫn nhau (variant)', () => {
        // 'Montserrat-Bold' (gốc) → khớp 'Montserrat Bold' hoặc 'Montserrat'
        const m = pickFontForName('Montserrat-Bold', fonts);
        expect(m).not.toBeNull();
        expect(m!.path).toMatch(/mont/);
    });
    it('không có font / không khớp → null', () => {
        expect(pickFontForName('Comic Sans', fonts)).toBeNull();
        expect(pickFontForName('arial', [])).toBeNull();
        expect(pickFontForName(undefined, fonts)).toBeNull();
    });
});
