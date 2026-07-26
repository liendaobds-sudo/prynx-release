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

// --- Auto-Bottom (Đáy dán tự động / Crash-Lock đã dán keo) ---
//
// Thân + nắp giống Snap-Lock Bottom; chỉ khác phần đáy: 4 mảnh đáy được
// DÁN KEO sẵn theo cặp chéo nhau (mặt trước↔hông phải, mặt sau↔hông trái).
//
// Tỉ lệ đo từ mẫu: Custom Dimensions Tuck End Boxes Double Tray Dieline
// 100010-01 (SVG) — mọi kích thước dẫn xuất theo W/L, không hardcode mm.
// Junction giữa flap: copy nguyên approach D5 của SnapLockBottom
// (lineIntersect V-peak + pointedFillet).
//
/** Chiều sâu mảnh đáy chính / W — mẫu ≈ 0.760 */
export const AB_DEEP_DEPTH_RATIO = 0.76;
/** Chiều sâu tai hông / W — mẫu ≈ 0.507 */
export const AB_WING_DEPTH_RATIO = 0.5;
/** Cạnh 45° vùng dán (glueLeg) / W — mẫu ≈ 0.412; step+glueLeg ≈ hWing */
export const AB_GLUE_LEG_RATIO = 0.412;
/** Bước vát 45° trước glueLeg / W — mẫu ≈ 0.091 */
export const AB_STEP_RATIO = 0.091;
/** Rộng tai khóa (male ear) / W — mẫu ≈ 0.106 */
export const AB_EAR_WIDTH_RATIO = 0.106;
/** Tai khóa thụt vào từ mép góc dán / W — mẫu ≈ 0.040 */
export const AB_EAR_INSET_RATIO = 0.04;
/** Kệ ngang sau đường 45° / W — mẫu ≈ 0.501 */
export const AB_SHELF_RATIO = 0.5;
/** Nấc dưới kệ / W — mẫu ≈ 0.039 */
export const AB_NOTCH_RATIO = 0.039;
/** Vai chéo 45° từ nấc xuống đáy / W — mẫu ≈ 0.215 */
export const AB_SHOULDER_RATIO = 0.215;
/** Thụt mép trái đáy / bề rộng panel L — mẫu ≈ 0.036 */
export const AB_BOT_INSET_RATIO = 0.036;
/** Vát phía góc dán tai hông / W — mẫu ≈ 0.184 */
export const AB_WING_INNER_TAPER_RATIO = 0.184;
/** Vát mép tự do tai hông / W — mẫu ≈ 0.500 */
export const AB_WING_OUTER_TAPER_RATIO = 0.5;
/** @deprecated tương thích cũ */
export const AB_SHELF_SPAN_RATIO = 0.25;
/** @deprecated */
export const AB_WING_TAPER_RATIO = 0.4;
/** @deprecated */
export const AB_RELIEF_W_RATIO = 0.15;
/** @deprecated */
export const AB_RELIEF_H_RATIO = 0.25;
/** @deprecated */
export const AB_RELIEF_W_MAX = 8;
/** @deprecated */
export const AB_RELIEF_H_MAX = 4;

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
