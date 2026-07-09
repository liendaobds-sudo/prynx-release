/**
 * wheelPageNav — logic thuần quyết định "lăn/vuốt để chuyển trang".
 *
 * Tách khỏi DOM để KIỂM THỬ được cả hai nguồn nhập mà KHÔNG cần phần cứng:
 *  - Chuột lăn: ít event, mỗi event `deltaY` lớn (~±100), thường deltaMode=0.
 *  - Trackpad:  rất nhiều event, mỗi event `deltaY` nhỏ (~±3–15), pixel-mode,
 *               kèm trễ pha smooth-scroll làm event lệch biên xen giữa.
 *
 * Bug cũ (useViewerZoom): ngưỡng tuyệt đối `>80` theo độ lớn nấc-chuột + `else`
 * reset accumulator về 0 mỗi khi event KHÔNG rơi đúng biên. Chuột vượt 80 trong
 * MỘT event nên miễn nhiễm; trackpad tích delta nhỏ nhưng bị reset liên tục bởi
 * các event lệch biên → không bao giờ đủ ngưỡng → "vuốt không chuyển trang".
 *
 * Cách sửa (module này):
 *  1. Chuẩn hoá delta theo `deltaMode` (LINE/PAGE → pixel) để ngưỡng nhất quán.
 *  2. BỎ reset-khi-lệch-biên; chỉ reset khi (a) nghỉ tay quá `IDLE_RESET_MS`,
 *     hoặc (b) đảo chiều tại biên. Nhờ đó chuỗi delta nhỏ của trackpad sống sót.
 *  3. Sau khi nhảy trang: cooldown `COOLDOWN_MS` nuốt phần momentum còn lại →
 *     một cú vuốt = đúng một trang (không nhảy 2).
 */

/** Chiều cao dòng ước lượng (px) để quy đổi deltaMode=LINE. */
export const LINE_HEIGHT_PX = 16;
/** Ngưỡng tích luỹ (px đã chuẩn hoá) để chuyển một trang. Một nấc chuột (~±100) vượt ngay. */
export const PAGE_FLIP_THRESHOLD = 60;
/** Không có event mới quá ngưỡng này ⇒ coi như cử chỉ mới, reset accumulator. */
export const IDLE_RESET_MS = 160;
/** Sau khi nhảy trang, bỏ qua event trong khoảng này để nuốt momentum trackpad. */
export const COOLDOWN_MS = 250;

export interface WheelNavInput {
    /** deltaY thô từ WheelEvent. */
    deltaY: number;
    /** deltaMode: 0=PIXEL, 1=LINE, 2=PAGE. Mặc định 0. */
    deltaMode?: number;
    /** Vùng cuộn nội dung đang ở đỉnh (còn có thể lăn lên để chuyển trang trước). */
    atTop: boolean;
    /** Vùng cuộn nội dung đang ở đáy (còn có thể lăn xuống để chuyển trang sau). */
    atBottom: boolean;
    /** Mốc thời gian event (ms), thường `performance.now()` hoặc `event.timeStamp`. */
    timestamp: number;
    /** Chiều cao viewport (px) để quy đổi deltaMode=PAGE. Mặc định 800. */
    viewportHeight?: number;
}

export interface WheelNavState {
    accumulator: number;
    lastTs: number;
    cooldownUntil: number;
}

export type WheelNavDirection = -1 | 0 | 1;

export interface WheelNavResult {
    state: WheelNavState;
    /** Hướng nhảy trang: -1 (trang trước), 1 (trang sau), 0 (chưa nhảy). */
    jump: WheelNavDirection;
}

export function createWheelNavState(): WheelNavState {
    return { accumulator: 0, lastTs: 0, cooldownUntil: 0 };
}

/** Quy đổi deltaY về pixel theo deltaMode để so ngưỡng nhất quán giữa các thiết bị. */
export function normalizeWheelDelta(
    deltaY: number,
    deltaMode = 0,
    viewportHeight = 800,
): number {
    if (deltaMode === 1) return deltaY * LINE_HEIGHT_PX; // LINE
    if (deltaMode === 2) return deltaY * viewportHeight; // PAGE
    return deltaY; // PIXEL
}

const sign = (n: number): WheelNavDirection => (n > 0 ? 1 : n < 0 ? -1 : 0);

/**
 * Reducer thuần: nhận state + một event wheel đã chuẩn hoá ngữ cảnh, trả state
 * mới + quyết định nhảy trang. KHÔNG side-effect, KHÔNG đọc DOM.
 *
 * Điều kiện tích luỹ: chỉ khi lăn VƯỢT biên vùng cuộn theo đúng hướng
 * ((xuống & đang ở đáy) hoặc (lên & đang ở đỉnh)). Event trong lòng trang
 * (chưa tới biên) KHÔNG cộng và cũng KHÔNG reset — để native scroll xử lý,
 * còn tiến trình tích luỹ của cử chỉ hiện tại được giữ (idle-reset lo phần cũ).
 */
export function reduceWheelNav(
    state: WheelNavState,
    input: WheelNavInput,
    threshold: number = PAGE_FLIP_THRESHOLD,
): WheelNavResult {
    const { deltaY, deltaMode = 0, atTop, atBottom, timestamp, viewportHeight } = input;

    // Trong thời gian cooldown: nuốt event, giữ mốc thời gian để idle-timer đúng.
    if (timestamp < state.cooldownUntil) {
        return { state: { ...state, accumulator: 0, lastTs: timestamp }, jump: 0 };
    }

    const nd = normalizeWheelDelta(deltaY, deltaMode, viewportHeight);
    const atBoundary = (nd > 0 && atBottom) || (nd < 0 && atTop);
    if (!atBoundary || nd === 0) {
        // Chưa tới biên (đang cuộn trong lòng trang) → không tích luỹ, không reset cứng.
        return { state: { ...state, lastTs: timestamp }, jump: 0 };
    }

    // Nghỉ tay quá lâu ⇒ cử chỉ mới; đảo chiều tại biên ⇒ bỏ tích luỹ cũ.
    let acc = state.accumulator;
    if (timestamp - state.lastTs > IDLE_RESET_MS) acc = 0;
    if (acc !== 0 && sign(nd) !== sign(acc)) acc = 0;

    acc += nd;

    if (Math.abs(acc) >= threshold) {
        return {
            state: { accumulator: 0, lastTs: timestamp, cooldownUntil: timestamp + COOLDOWN_MS },
            jump: sign(acc),
        };
    }

    return { state: { ...state, accumulator: acc, lastTs: timestamp }, jump: 0 };
}
