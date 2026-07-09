import { describe, it, expect } from 'vitest';
import {
    reduceWheelNav,
    createWheelNavState,
    normalizeWheelDelta,
    type WheelNavInput,
    type WheelNavState,
    type WheelNavDirection,
    PAGE_FLIP_THRESHOLD,
    COOLDOWN_MS,
    IDLE_RESET_MS,
} from './wheelPageNav';

/** Chạy một chuỗi event qua reducer, trả tổng số lần nhảy + hướng từng lần. */
function runStream(
    events: WheelNavInput[],
    initial: WheelNavState = createWheelNavState(),
): { jumps: WheelNavDirection[]; state: WheelNavState } {
    let state = initial;
    const jumps: WheelNavDirection[] = [];
    for (const ev of events) {
        const res = reduceWheelNav(state, ev);
        state = res.state;
        if (res.jump !== 0) jumps.push(res.jump);
    }
    return { jumps, state };
}

/** Sinh chuỗi "kiểu trackpad": nhiều event delta nhỏ, cách đều, tại một biên. */
function trackpadStream(opts: {
    count: number;
    delta: number;      // deltaY mỗi event (dương = xuống)
    stepMs?: number;
    atBottom?: boolean;
    atTop?: boolean;
    startTs?: number;
}): WheelNavInput[] {
    const { count, delta, stepMs = 16, atBottom = delta > 0, atTop = delta < 0, startTs = 0 } = opts;
    return Array.from({ length: count }, (_, i) => ({
        deltaY: delta,
        deltaMode: 0,
        atTop,
        atBottom,
        timestamp: startTs + i * stepMs,
    }));
}

describe('normalizeWheelDelta', () => {
    it('giữ nguyên pixel-mode (deltaMode=0)', () => {
        expect(normalizeWheelDelta(100, 0)).toBe(100);
    });
    it('quy đổi LINE-mode (deltaMode=1) sang pixel', () => {
        expect(normalizeWheelDelta(3, 1)).toBe(48); // 3 * 16
    });
    it('quy đổi PAGE-mode (deltaMode=2) theo chiều cao viewport', () => {
        expect(normalizeWheelDelta(1, 2, 720)).toBe(720);
    });
});

describe('reduceWheelNav — CHUỘT (ít event, delta lớn)', () => {
    it('một nấc lăn xuống tại đáy → nhảy đúng 1 trang tới', () => {
        const { jumps } = runStream([
            { deltaY: 100, deltaMode: 0, atTop: false, atBottom: true, timestamp: 0 },
        ]);
        expect(jumps).toEqual([1]);
    });

    it('một nấc lăn lên tại đỉnh → nhảy đúng 1 trang lùi', () => {
        const { jumps } = runStream([
            { deltaY: -100, deltaMode: 0, atTop: true, atBottom: false, timestamp: 0 },
        ]);
        expect(jumps).toEqual([-1]);
    });

    it('lăn khi CHƯA tới biên (giữa trang) → không nhảy', () => {
        const { jumps } = runStream([
            { deltaY: 100, deltaMode: 0, atTop: false, atBottom: false, timestamp: 0 },
            { deltaY: 100, deltaMode: 0, atTop: false, atBottom: false, timestamp: 50 },
        ]);
        expect(jumps).toEqual([]);
    });
});

describe('reduceWheelNav — TRACKPAD (nhiều event, delta nhỏ)', () => {
    it('vuốt nhẹ liên tục tại đáy → nhảy (bản chất bug cũ: không bao giờ nhảy)', () => {
        // 10 event × 8px = 80 ≥ ngưỡng 60 ⇒ phải nhảy.
        const { jumps } = runStream(trackpadStream({ count: 10, delta: 8 }));
        expect(jumps.length).toBeGreaterThanOrEqual(1);
        expect(jumps[0]).toBe(1);
    });

    it('một cú vuốt gọn (trong ~250ms) → đúng MỘT trang, không nhảy đôi', () => {
        // 10 event ×8px cách 16ms (kết thúc ts=144, < cooldown 250ms) ⇒ đúng 1 lần nhảy.
        const { jumps } = runStream(trackpadStream({ count: 10, delta: 8, stepMs: 16 }));
        expect(jumps).toEqual([1]);
    });

    it('SỐNG SÓT qua event lệch biên (trễ pha smooth-scroll) — chính là lỗi cũ', () => {
        // Bug cũ: bất kỳ event không-đúng-biên nào cũng reset accumulator về 0.
        // Ở đây chèn 1 event atBottom=false vào giữa chuỗi; tổng phần tại-biên vẫn
        // đủ ngưỡng ⇒ với logic mới PHẢI nhảy (với logic cũ sẽ KHÔNG).
        const stream: WheelNavInput[] = [
            ...trackpadStream({ count: 6, delta: 8, startTs: 0 }),                 // 48px
            { deltaY: 8, deltaMode: 0, atTop: false, atBottom: false, timestamp: 96 }, // lệch biên: bỏ qua, KHÔNG reset
            ...trackpadStream({ count: 6, delta: 8, startTs: 112 }),              // +48px = 96px tổng
        ];
        const { jumps } = runStream(stream);
        expect(jumps).toEqual([1]);
    });

    it('rung lắc nhỏ dưới ngưỡng (không vuốt thật) → không nhảy', () => {
        const { jumps } = runStream(trackpadStream({ count: 5, delta: 5 })); // 25px < 60
        expect(jumps).toEqual([]);
    });
});

describe('reduceWheelNav — reset theo thời gian & đảo chiều', () => {
    it('hai nấc cách nhau QUÁ lâu (> idle) không cộng dồn → không nhảy', () => {
        const { jumps } = runStream([
            { deltaY: 40, deltaMode: 0, atTop: false, atBottom: true, timestamp: 0 },
            { deltaY: 40, deltaMode: 0, atTop: false, atBottom: true, timestamp: IDLE_RESET_MS + 50 },
        ]);
        expect(jumps).toEqual([]); // mỗi lần 40 < 60, idle đã reset giữa chừng
    });

    it('hai nấc GẦN nhau (trong idle) cộng dồn → nhảy', () => {
        const { jumps } = runStream([
            { deltaY: 40, deltaMode: 0, atTop: false, atBottom: true, timestamp: 0 },
            { deltaY: 40, deltaMode: 0, atTop: false, atBottom: true, timestamp: 20 },
        ]);
        expect(jumps).toEqual([1]); // 80 ≥ 60
    });

    it('đảo chiều tại trang vừa khít viewport (atTop & atBottom cùng true) → bỏ tích luỹ cũ', () => {
        // Trang fit trong viewport: cả hai biên đều đúng. +40 rồi -40 phải triệt tiêu,
        // cần thêm -40 nữa mới đủ ngưỡng lùi.
        const fit = (deltaY: number, ts: number): WheelNavInput => ({
            deltaY, deltaMode: 0, atTop: true, atBottom: true, timestamp: ts,
        });
        const { jumps } = runStream([fit(40, 0), fit(-40, 20), fit(-40, 40)]);
        expect(jumps).toEqual([-1]);
    });
});

describe('reduceWheelNav — LINE-mode (chuẩn hoá deltaMode)', () => {
    it('một event LINE nhỏ chưa đủ; hai event thì đủ ngưỡng', () => {
        const line = (ts: number): WheelNavInput => ({
            deltaY: 3, deltaMode: 1, atTop: false, atBottom: true, timestamp: ts,
        });
        expect(runStream([line(0)]).jumps).toEqual([]);          // 48 < 60
        expect(runStream([line(0), line(20)]).jumps).toEqual([1]); // 96 ≥ 60
    });
});

describe('hằng số cấu hình hợp lệ', () => {
    it('ngưỡng < một nấc chuột điển hình (100px) để chuột nhảy trong 1 event', () => {
        expect(PAGE_FLIP_THRESHOLD).toBeLessThan(100);
    });
    it('cooldown đủ dài để nuốt momentum trackpad', () => {
        expect(COOLDOWN_MS).toBeGreaterThanOrEqual(200);
    });
});
