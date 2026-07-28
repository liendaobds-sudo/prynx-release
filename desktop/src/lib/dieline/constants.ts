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

// --- Double Tray (Hộp âm dương — khay đáy + nắp chụp) ---
// [DOUBLE-TRAY 2026-07-26]
// Tỉ lệ đo từ mẫu: Custom Dimensions Tuck End Boxes Double Tray Dieline
// 100010-01 (SVG) — thân đáy 361×261 thành 52, nắp 375×275 thành 55;
// mọi số đo khớp tròn số tuyệt đối với T = 1.5, C = 1 (double_tray_dossier.md).
/** Thành trong = D − (hệ số này × T) — mẫu 50.5 = 52 − 1.5 */
export const DT_INNER_WALL_DROP_T = 1;
/** Thân nắp = thân đáy + (hệ số này × T) + 2·lidGap — mẫu +14 = 8×1.5 + 2×1 */
export const DT_LID_BODY_DELTA_T = 8;
/** Thành nắp tự động = D + (hệ số này × T) — mẫu +3 = 2×1.5 */
export const DT_LID_WALL_DELTA_T = 2;
/** Rộng tai khóa = D − (hệ số này × T) — mẫu nắp 52 = 55 − 2×1.5 */
export const DT_DUST_W_DROP_T = 2;
/** Khoảng cách hai mảnh (đáy | nắp) trên bản vẽ (mm) — theo SLEEVE_DISPLAY_GAP */
export const DT_DISPLAY_GAP = 60;
/** (Chỉ 3D) Khe hở nắp lơ lửng trên miệng đáy ở cuối hoạt ảnh đậy nắp (mm) */
export const DT_LID_HOVER_MM = 2;

// --- Hanging Window Box (Hộp treo có cửa sổ) ---
// [HANGING-WINDOW 2026-07-27] Số đo rút từ mẫu "Hanging electronic product
// box with window dieline" (L=80, W=30, D=140): cửa sổ 40×71 căn giữa mặt
// trước (≈0.5L × 0.5D), một lớp tai treo 35mm (0.25D), lỗ euro rộng 28mm
// (0.35L) cao 6mm với gờ chống trượt giữa.
/** Rộng cửa sổ tự động = hệ số này × L */
export const HGB_WINDOW_W_RATIO = 0.5;
/** Cao cửa sổ tự động = hệ số này × D */
export const HGB_WINDOW_H_RATIO = 0.5;
/** Lề tối thiểu từ cửa sổ tới nếp gấp/mép panel (mm) — chừa chỗ dán màng PVC */
export const HGB_WINDOW_MARGIN_MM = 8;
/** Bán kính bo góc cửa sổ tối đa (mm) */
export const HGB_WINDOW_R_MAX = 8;
/** Cao MỘT lớp tai treo tự động = hệ số này × D */
export const HGB_TAB_H_RATIO = 0.25;
/** Kẹp cao một lớp tai treo (mm) */
export const HGB_TAB_H_MIN = 20;
export const HGB_TAB_H_MAX = 40;
/** Rộng lỗ treo euro = hệ số này × L (kẹp bởi HGB_SLOT_W_MIN/MAX) */
export const HGB_SLOT_W_RATIO = 0.35;
export const HGB_SLOT_W_MIN = 18;
export const HGB_SLOT_W_MAX = 40;
/** Cao khe lỗ treo euro (mm) — chuẩn treo thanh ngang */
export const HGB_SLOT_H_MM = 6;
/** Gờ chống trượt giữa lỗ euro (mm).
 *  [HANGING-WINDOW 2026-07-27] Gờ là NỬA VÒNG TRÒN nên chiều sâu = bán kính =
 *  `HGB_SLOT_NIB_W_MM / 2`; `HGB_SLOT_NIB_D_MM` giờ là TRẦN chiều sâu, dùng để
 *  kẹp lại bề rộng gờ (nibW ≤ 2 × trần) chứ không còn là số đo độc lập. */
export const HGB_SLOT_NIB_W_MM = 6;
export const HGB_SLOT_NIB_D_MM = 3;

/** [HANGING-WINDOW 2026-07-27] CỔ THU tại nếp gấp giữa hai lớp tai treo.
 *  Đo trên mẫu "…Dieline 100010.svg": cạnh bên mỗi lớp lượn vào bằng cung tròn
 *  bán kính 20,72pt trên tai treo rộng 163,7pt ⇒ 0,127 × bề rộng tai treo; cung
 *  tiếp tuyến ĐỨNG ở phía thân lớp và tiếp tuyến NGANG tại cổ. Cổ thu giúp hai
 *  lớp gập úp 180° không căng góc. */
export const HGB_TAB_NECK_R_RATIO = 0.127;
export const HGB_TAB_NECK_R_MIN = 3;
export const HGB_TAB_NECK_R_MAX = 12;
/** Nút bo nhỏ ở hai ĐẦU nét cấn = hệ số này × T (mẫu: 2,072pt với T = 1,036pt).
 *  Nút này là điểm kết thúc đường cấn — chống nứt/xé mép khi gập úp. */
export const HGB_TAB_NUB_R_T = 2;

/** Tâm lỗ treo cách nếp gấp giữa hai lớp = hệ số này × cao một lớp.
 *  Hai lớp dùng CÙNG hệ số nên sau khi gập úp 180° hai lỗ trùng khít. */
export const HGB_SLOT_POS_RATIO = 0.45;

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
