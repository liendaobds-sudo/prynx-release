// ============================================================
// Engine Constants — Named values for common magic numbers
//
// Thay thế các magic numbers rải rác trong engine code để
// dễ đọc, dễ bảo trì, và sửa 1 chỗ áp dụng mọi nơi.
// ============================================================

// --- Glue Flap ---
/** Tỷ lệ chiều vát mép keo (60% chiều rộng G) */
export const GLUE_TAPER_RATIO = 0.6;

// --- Tuck Flap ---
/** Tỷ lệ bo tròn góc tai đút so với chiều rộng (max 3mm) */
export const TUCK_CORNER_RATIO = 0.05;
/** Bán kính bo tròn tối đa cho tai đút (mm) */
export const TUCK_CORNER_MAX_R = 3;

// --- Slit (rãnh gài / friction lock) ---
/** Khoảng cách rãnh gài từ mép panel (mm) */
export const SLIT_OFFSET_MM = 7;
/** Chiều sâu rãnh gài (mm) */
export const SLIT_DEPTH_MM = 2;
/** Bán kính bo góc tại khe gài (mm) */
export const SLIT_FILLET_R = 0.5;

// --- Crash-Lock Bottom ---
/** Tỷ lệ tổng chiều sâu female receiver so với W (3/4) */
export const FEMALE_DEPTH_RATIO = 3 / 4;
/** Tỷ lệ chiều sâu khe slot so với W (1/2) */
export const SLOT_DEPTH_RATIO = 1 / 2;
/** Tỷ lệ chiều cao bước (step) dust flap so với W */
export const DUST_STEP_H_RATIO = 0.3;
/** Chiều rộng tab phụ dust flap (mm) */
export const DUST_TAB_W = 5;

// --- Fillet chung ---
/** Bán kính bo tròn tối thiểu (mm) */
export const FILLET_R_MIN = 2;
/** Bán kính bo tròn tối đa (mm) */
export const FILLET_R_MAX = 5;
/** Tỷ lệ fillet radius so với W */
export const FILLET_W_RATIO = 0.05;

// --- Kappa (Bezier quarter-circle approximation) ---
/** Hệ số kappa chuẩn cho Bezier xấp xỉ 1/4 đường tròn */
export const KAPPA = 4 * (Math.sqrt(2) - 1) / 3; // ≈ 0.5522847498

// --- Dust Flap (shared) ---
/** Tỷ lệ fillet radius dust flap so với chiều cao */
export const DUST_FLAP_FILLET_RATIO = 0.1;
/** Hệ số kéo giãn control points Bezier tại bo góc dust flap */
export const DUST_FLAP_BEZIER_SCALE = 1.5;

// --- Snap-Lock Auto Pair Thresholds ---
/** Ngưỡng chênh lệch L−W cho 1 cặp (mm) */
export const SLP_THRESHOLD_1 = 150;
/** Ngưỡng chênh lệch L−W cho 2 cặp (mm) */
export const SLP_THRESHOLD_2 = 250;

// --- Paper Bag (Túi giấy SOS) ---
/** Bán kính lỗ xỏ dây quai mặc định (mm) */
export const HANDLE_HOLE_RADIUS = 2.5;
/** Khoảng cách lỗ quai từ mép trên mặc định (mm) */
export const HANDLE_HOLE_MARGIN = 25;
/** Phần overlap đáy thêm vào W/2 (mm) */
export const BOTTOM_OVERLAP = 10;
/** Tỷ lệ vát mép top flap đáy */
export const BOTTOM_FLAP_TAPER = 0.15;

// --- Pizza Box (FEFCO 0426) ---
/** Slot offset: khe slot cách mép bottom thêm n mm ngoài D */
export const PIZZA_SLOT_OFFSET_MM = 5;
/** Tỷ lệ chiều dài slot so với W */
export const PIZZA_SLOT_LENGTH_RATIO = 0.15;
/** Tỷ lệ fillet radius tai quạt so với tabR */
export const PIZZA_FAN_FILLET_RATIO = 0.15;
/** Fillet radius tối đa tai quạt (mm) */
export const PIZZA_FAN_FILLET_MAX = 5;
/** Tỷ lệ xiên vào của lid flap so với D */
export const PIZZA_LID_FLAP_INSET_RATIO = 0.2;
/** Tỷ lệ xiên dust flap pizza so với chiều cao panel */
export const PIZZA_DUST_SKEW_RATIO = 0.05;
