// ============================================================
// Box Variant Catalog — Thư viện biến thể khuôn bế
// [VARIANT 2026-07-29]
//
// LỚP DỮ LIỆU THUẦN nằm TRÊN engine khuôn bế. Mỗi biến thể = một
// `boxType` CÓ THẬT + một bộ thuộc tính đã chốt sẵn. Người dùng chọn
// hình giống cái hộp mình cần, nhập số đo, xong — không phải mò công tắc.
//
// ── BẤT BIẾN SỐNG CÒN ──────────────────────────────────────
// Tệp này KHÔNG được import generator, KHÔNG tính hình học, KHÔNG giới
// thiệu `boxType` mới. Thêm biến thể = thêm một object ở đây, KHÔNG phải:
//   • sửa generator hay engine.ts
//   • chạy `vitest -u` golden master
//   • sửa allow-list boxType ở BA tầng (runtimeValidation.ts,
//     dieline_validation.py, dieline_request.rs)
//   • build lại bundle sidecar Rust
// Snapshot golden master đổi sau khi sửa tệp này ⇒ đã chạm hình học
// ngoài ý muốn, dừng lại soi diff.
//
// ── QUY TẮC TÁCH CARD ──────────────────────────────────────
// TÁCH thành biến thể riêng khi thuộc tính ĐỔI HÌNH KHUÔN THẤY ĐƯỢC
// trên ảnh minh hoạ VÀ là quyết định "chọn kiểu hộp".
//   ví dụ: `lockTab` (có/không lưỡi khoá nắp), `hgbWindow` (có/không
//   cửa sổ), `gableStyle` (mái dốc/mái bằng).
// GIỮ TRONG FORM khi là số đo hoặc trang trí trên CÙNG một kiểu hộp.
//   ví dụ: `glueSide`, `panelOrder`, `handleShape`, `handleY`, `SLP`,
//   `ABD`, `DFH`, và mọi số đo mm.
// Lý do: nổ hết tổ hợp (gable 8, pizza 8, envelope 12) thì thư viện lại
// rối đúng bằng một cách khác. Chỉ tách trục mang nghĩa thương mại.
// ============================================================

import { BoxParams } from './types';
import { normalizeSearch } from '../textSearch';

// ─── Nhóm ngành hàng ─────────────────────────────────────────

/** Nhóm để gom card trong thư viện.
 *
 *  QUY TẮC GÁN NHÓM (sửa 2026-07-29 sau phản hồi "xếp lung tung"):
 *  mỗi biến thể có ĐÚNG MỘT nhóm HỌ HỘP, cộng thêm nhóm CẮT NGANG nếu có.
 *    • Nhóm họ hộp (loại trừ nhau): `nap_cai`, `day_gai_dan`, `khay_hai_manh`,
 *      `treo_ke`, `thuc_pham`, `tui_boc`, `bi_thu`.
 *    • Nhóm cắt ngang (được chồng lấn): `cua_so`.
 *
 *  Bài học: ban đầu tôi cho hộp đáy gài / đáy dán / hộp treo mang THÊM nhóm
 *  `nap_cai` vì thân chúng giống Reverse Tuck End. Kết quả: "Hộp nắp cài" có 7
 *  mục lẫn cả đáy gài, đáy dán, hộp treo ⇒ nhóm mất nghĩa, thư viện trông lung
 *  tung. Giống về kết cấu thân KHÔNG có nghĩa là cùng họ hộp khi đi mua hàng. */
export type BoxGroup =
    | 'nap_cai'
    | 'nap_lat'
    | 'day_gai_dan'
    | 'khay_hai_manh'
    | 'cua_so'
    | 'treo_ke'
    | 'thuc_pham'
    | 'tui_boc'
    | 'bi_thu';

export interface BoxGroupInfo {
    id: BoxGroup;
    /** Nhãn tiếng Việt ngành in (fallback — hiển thị đi qua i18n). */
    nameVi: string;
    /** Thuật ngữ Anh để tra chéo khi khách gửi mã nước ngoài. */
    nameEn: string;
}

/** Thứ tự hiển thị ở sidebar: các họ hộp trước, nhóm cắt ngang xuống cuối. */
export const BOX_GROUPS: readonly BoxGroupInfo[] = [
    { id: 'nap_cai', nameVi: 'Hộp nắp cài', nameEn: 'Tuck End' },
    { id: 'nap_lat', nameVi: 'Hộp nắp lật', nameEn: 'Flip-Top Boxes' },
    { id: 'day_gai_dan', nameVi: 'Hộp đáy gài & đáy dán', nameEn: 'Auto / Snap-Lock Bottom' },
    { id: 'khay_hai_manh', nameVi: 'Khay & hộp hai mảnh', nameEn: 'Tray & Lid' },
    { id: 'thuc_pham', nameVi: 'Hộp thực phẩm', nameEn: 'Food' },
    { id: 'tui_boc', nameVi: 'Túi & bọc', nameEn: 'Bag & Sleeve' },
    { id: 'bi_thu', nameVi: 'Bì thư', nameEn: 'Envelope' },
    { id: 'treo_ke', nameVi: 'Hộp treo kệ', nameEn: 'Hanging / Display' },
    // ─ nhóm CẮT NGANG: được xuất hiện cùng một họ hộp khác ─
    { id: 'cua_so', nameVi: 'Hộp có cửa sổ', nameEn: 'Window' },
] as const;

/** Nhóm cắt ngang — được phép chồng lấn với nhóm họ hộp. Mọi nhóm còn lại là
 *  họ hộp và LOẠI TRỪ NHAU (test tầng 1 chốt điều này). */
export const CROSS_CUT_GROUPS: readonly BoxGroup[] = ['cua_so'] as const;

// ─── Hợp đồng biến thể ───────────────────────────────────────

export interface BoxVariant {
    /** Khoá kỹ thuật ổn định — dùng cho khoá i18n và tên tệp ảnh. */
    id: string;
    /** Mã khuôn cho người dùng đọc / gọi điện báo, vd 'PRYNX-SLB-02'.
     *  Dạng có chữ (không phải 6 chữ số) để đọc mã là biết họ hộp. */
    code: string;
    /** Trỏ về generator CÓ THẬT — không bao giờ là giá trị mới. */
    boxType: BoxParams['boxType'];
    groups: BoxGroup[];
    /** Nhãn/mô tả tiếng Việt — FALLBACK, hiển thị thật đi qua i18n. */
    nameVi: string;
    descVi: string;
    /** Từ đồng nghĩa & phương ngữ cho ô tìm kiếm, viết KHÔNG dấu. */
    aliases: string[];
    // Không có trường ảnh: đường dẫn ảnh là hàm thuần của `code`
    // (`variantThumb` / `variantDielineSvg`). Lưu vào từng mục chỉ tạo ra 21 chỗ
    // có thể lệch nhau.
    /** THUỘC TÍNH CHỐT — nguồn DUY NHẤT cho cả hai việc:
     *  (1) áp giá trị khi chọn biến thể, (2) ẩn control khỏi form.
     *  KHÔNG được có danh sách "tham số ẩn" thứ hai song song: hai danh
     *  sách song song chắc chắn lệch nhau sau vài tháng. */
    lockedParams: Partial<BoxParams>;
    /** Số đo khởi đầu; người dùng sửa tự do. Bỏ trống = dùng mặc định
     *  theo boxType trong `applyBoxTypeDefaults`. */
    preset?: Partial<BoxParams>;
}

// ─── Catalog ─────────────────────────────────────────────────

// ─── Ảnh minh hoạ ────────────────────────────────────────────
//
// Mọi tệp ảnh của biến thể đặt tên theo MÃ KHUÔN (`code`), không theo `id`:
// mã khuôn là thứ hiện trên card nên người thay ảnh thủ công nhìn card là biết
// cần ghi đè tệp nào, không phải tra bảng id.
//
//     public/images/dieline/variants/PRYNX-SLB-02.png   ← ảnh thumb (thay được)
//     public/images/dieline/variants/PRYNX-SLB-02.svg   ← khuôn 2D (sinh tự động)

/** Khuôn 2D sinh tự động từ engine — ảnh MẶC ĐỊNH của card, luôn tồn tại.
 *
 *  Sinh bởi `npm run gen:variant-thumbs`. Dùng SVG vì: không cần rasteriser trong
 *  Node, nét vector sắc ở mọi cỡ, tệp nhẹ (~1–10 KB), và là văn bản nên `git diff`
 *  đọc được — đổi hình học là thấy diff ngay.
 *
 *  Muốn dùng ảnh đẹp hơn thì bỏ ảnh vào `src/assets/dieline/variants/<mã>.png`;
 *  Vite quét thư mục đó và giao diện tự ưu tiên ảnh của bạn (xem
 *  `components/dieline-tool/variantThumbs.ts`). */
export function variantDielineSvg(variant: BoxVariant): string {
    return `/images/dieline/variants/${variant.code}.svg`;
}

// ─── Catalog ─────────────────────────────────────────────────

export const BOX_VARIANTS: readonly BoxVariant[] = [
    // ── Hộp nắp cài so le (Reverse Tuck End) ──
    // Không có trục hình học nào để tách: `glueSide`/`panelOrder`/`DFH` là số đo
    // và trang trí, không đổi kiểu hộp ⇒ một biến thể duy nhất.
    {
        id: 'rte_std',
        code: 'PRYNX-RTE-01',
        boxType: 'rte',
        groups: ['nap_cai'],
        nameVi: 'Hộp nắp cài so le',
        descVi: 'Reverse Tuck End — khuôn hộp phổ biến nhất, nắp trên/dưới cài so le',
        aliases: ['reverse tuck end', 'rte', 'hop nap cai sole', 'hop nap gai', 'a20.20'],
        lockedParams: {},
    },

    // ── Hộp đáy gài (Snap-Lock Bottom) ──
    // Trục tách: `lockTab`. Lưỡi khoá nắp đổi hẳn hình mép nắp trên nên
    // thấy rõ trên ảnh; đa số đơn hàng không cần, nên tách để người dùng
    // chọn thẳng thay vì tìm ô tích trong mục nâng cao.
    {
        id: 'slb_plain',
        code: 'PRYNX-SLB-01',
        boxType: 'slb',
        groups: ['day_gai_dan'],
        nameVi: 'Hộp đáy gài',
        descVi: 'Snap-Lock Bottom — đáy tự khoá, nắp gài trơn',
        aliases: ['snap lock bottom', 'hop day gai', 'day khoa', 'day tu khoa', '1-2-3 bottom'],
        lockedParams: { lockTab: false },
    },
    {
        id: 'slb_lock',
        code: 'PRYNX-SLB-02',
        boxType: 'slb',
        groups: ['day_gai_dan'],
        nameVi: 'Hộp đáy gài có lưỡi khoá nắp',
        descVi: 'Snap-Lock Bottom — thêm lưỡi khoá giữ nắp không tự bung',
        aliases: ['snap lock bottom lock tab', 'hop day gai luoi khoa', 'khoa nap', 'lock tab'],
        lockedParams: { lockTab: true },
    },

    // ── Hộp đáy dán tự động (Auto-Bottom) ──
    // Trục tách: `lockTab`, cùng lý do như đáy gài.
    {
        id: 'ab_plain',
        code: 'PRYNX-AB-01',
        boxType: 'auto_bottom',
        groups: ['day_gai_dan'],
        nameVi: 'Hộp đáy dán tự động',
        descVi: 'Auto-Bottom — đáy dán keo sẵn, tự bung khi dựng hộp',
        aliases: ['auto bottom', 'crash lock bottom', 'hop day dan', 'day dan tu dong'],
        lockedParams: { lockTab: false },
    },
    {
        id: 'ab_lock',
        code: 'PRYNX-AB-02',
        boxType: 'auto_bottom',
        groups: ['day_gai_dan'],
        nameVi: 'Hộp đáy dán có lưỡi khoá nắp',
        descVi: 'Auto-Bottom — thêm lưỡi khoá giữ nắp không tự bung',
        aliases: ['auto bottom lock tab', 'hop day dan luoi khoa', 'lock tab'],
        lockedParams: { lockTab: true },
    },

    // ── Túi giấy SOS (Paper Bag) ──
    // [PAPER-BAG FIX 2026-08-03 §PB.1] Túi có quai cần mí miệng gia cường;
    // túi trơn không quai dùng miệng cắt thẳng, không sinh panel `lip_*`.
    // Khóa cả TH để đổi hai card cùng boxType không giữ nhầm hình của card trước.
    {
        id: 'bag_holes',
        code: 'PRYNX-PB-01',
        boxType: 'paper_bag',
        groups: ['tui_boc'],
        nameVi: 'Túi giấy có lỗ xỏ quai',
        descVi: 'Túi giấy SOS — đáy gấp vuông, có lỗ xỏ dây quai',
        aliases: ['paper bag', 'sos bag', 'tui giay co quai', 'tui xach giay', 'lo xo day'],
        lockedParams: { handleHoles: true, TH: 30 },
    },
    {
        id: 'bag_plain',
        code: 'PRYNX-PB-02',
        boxType: 'paper_bag',
        groups: ['tui_boc'],
        nameVi: 'Túi giấy trơn không quai',
        descVi: 'Túi giấy SOS — miệng trơn, dùng đựng bánh mì, thực phẩm',
        aliases: ['paper bag no handle', 'tui giay tron', 'tui banh mi', 'tui dung thuc pham'],
        lockedParams: { handleHoles: false, TH: 0 },
    },

    // ── Hộp quai xách (Gable Box) ──
    // Trục tách: `gableStyle`. Mái dốc và mái bằng là hai dáng hộp khác nhau rõ rệt.
    // `handleShape`/`handleY` KHÔNG tách — đó là trang trí lỗ quai, để trong form.
    {
        id: 'gable_pitched',
        code: 'PRYNX-GB-01',
        boxType: 'gable',
        groups: ['thuc_pham'],
        nameVi: 'Hộp quai xách mái dốc',
        descVi: 'Gable Box — mái dốc hai bên, quai xách liền thân',
        aliases: ['gable box', 'hop quai xach mai doc', 'hop banh', 'hop qua tang'],
        lockedParams: { gableStyle: 'pitched' },
    },
    {
        id: 'gable_flat',
        code: 'PRYNX-GB-02',
        boxType: 'gable',
        groups: ['thuc_pham'],
        nameVi: 'Hộp quai xách mái bằng',
        descVi: 'Gable Box — mái bằng, quai xách liền thân',
        aliases: ['gable box flat top', 'hop quai xach mai bang'],
        lockedParams: { gableStyle: 'flat' },
    },

    // ── Bọc ly (Cup Sleeve) ──
    // Trục tách: có mí dán hay không. Bản rời (không mí) dùng cho loại lồng ngoài
    // ly rồi dán tại quán; bản dán vòng là thành phẩm khép kín.
    {
        id: 'sleeve_glued',
        code: 'PRYNX-CS-01',
        boxType: 'cup_sleeve',
        groups: ['tui_boc'],
        nameVi: 'Bọc ly dán vòng',
        descVi: 'Cup Sleeve — bao giấy bọc ly, có mí dán khép vòng',
        aliases: ['cup sleeve', 'boc ly', 'sleeve ly', 'bao ly ca phe', 'ly giay'],
        lockedParams: { cupFlapPosition: 'right' },
    },
    {
        id: 'sleeve_open',
        code: 'PRYNX-CS-02',
        boxType: 'cup_sleeve',
        groups: ['tui_boc'],
        nameVi: 'Bọc ly rời không mí dán',
        descVi: 'Cup Sleeve — dải giấy rời, tự dán khi lồng vào ly',
        aliases: ['cup sleeve no flap', 'boc ly roi', 'sleeve ly khong mi dan'],
        lockedParams: { cupFlapPosition: 'none' },
    },

    // ── Hộp pizza (FEFCO 0426) ──
    // Trục tách: GÓI tính năng, không tách từng công tắc. 3 công tắc rời cho 8 tổ
    // hợp — nổ hết thì thư viện lại rối. Hai gói có nghĩa thương mại: bản tiêu
    // chuẩn đủ khoá + thông hơi, và bản trơn cho đơn giá rẻ.
    {
        id: 'pizza_full',
        code: 'PRYNX-PZ-01',
        boxType: 'pizza',
        groups: ['thuc_pham'],
        nameVi: 'Hộp pizza tiêu chuẩn',
        descVi: 'FEFCO 0426 — đủ lỗ thông hơi, khoá nắp trước và chấu khoá góc',
        aliases: ['pizza box', 'hop pizza', 'fefco 0426', 'hop banh pizza'],
        lockedParams: { pizzaVent: true, pizzaFrontLock: true, pizzaCornerLock: true },
        preset: { L: 300, W: 300, D: 40, T: 1.5, C: 1, TH: 15 },
    },
    {
        id: 'pizza_plain',
        code: 'PRYNX-PZ-02',
        boxType: 'pizza',
        groups: ['thuc_pham'],
        nameVi: 'Hộp pizza trơn',
        descVi: 'FEFCO 0426 — không lỗ thông hơi, không khoá, khuôn gọn nhất',
        aliases: ['pizza box plain', 'hop pizza tron', 'fefco 0426'],
        lockedParams: { pizzaVent: false, pizzaFrontLock: false, pizzaCornerLock: false },
        preset: { L: 300, W: 300, D: 40, T: 1.5, C: 1, TH: 15 },
    },

    // ── Bì thư & bì lì xì (Envelope) ──
    // Trục tách: `envStyle` (nắp dọc/ngang) và `envWindow`. `envFlapShape` tách
    // hai dáng hay dùng nhất (nhọn/thẳng); bản có cửa sổ để dáng nắp trong form
    // vì lúc đó cửa sổ mới là điểm phân biệt chính.
    {
        id: 'env_wallet_pointed',
        code: 'PRYNX-EV-01',
        boxType: 'envelope',
        groups: ['bi_thu'],
        nameVi: 'Bì thư ngang nắp nhọn',
        descVi: 'Bì thư kiểu wallet — nắp dán hình nhọn, dáng bì lì xì truyền thống',
        aliases: ['envelope wallet pointed', 'bi thu ngang nap nhon', 'bi li xi', 'phong bi'],
        lockedParams: { envStyle: 'wallet', envFlapShape: 'pointed', envWindow: false },
    },
    {
        id: 'env_wallet_straight',
        code: 'PRYNX-EV-02',
        boxType: 'envelope',
        groups: ['bi_thu'],
        nameVi: 'Bì thư ngang nắp thẳng',
        descVi: 'Bì thư kiểu wallet — nắp dán thẳng, dáng bì thư công văn',
        aliases: ['envelope wallet straight', 'bi thu ngang nap thang', 'bi thu cong van', 'phong bi'],
        lockedParams: { envStyle: 'wallet', envFlapShape: 'straight', envWindow: false },
    },
    {
        id: 'env_pocket',
        code: 'PRYNX-EV-03',
        boxType: 'envelope',
        groups: ['bi_thu'],
        nameVi: 'Bì thư dọc (bì lì xì)',
        descVi: 'Bì thư kiểu pocket — nắp ở cạnh ngắn, dáng bì lì xì đứng',
        aliases: ['envelope pocket', 'bi thu doc', 'bi li xi dung', 'phong bi doc'],
        lockedParams: { envStyle: 'pocket', envFlapShape: 'pointed', envWindow: false },
    },
    {
        id: 'env_window',
        code: 'PRYNX-EV-04',
        boxType: 'envelope',
        groups: ['bi_thu', 'cua_so'],
        nameVi: 'Bì thư có cửa sổ',
        descVi: 'Bì thư kiểu wallet — khoét cửa sổ dán màng, hiện địa chỉ bên trong',
        aliases: ['envelope window', 'bi thu cua so', 'bi thu co cua so', 'window envelope'],
        lockedParams: { envStyle: 'wallet', envWindow: true },
    },

    // ── Hộp nắp lật tự khóa, gài mặt trước ──
    {
        id: 'ftt_self_lock',
        code: 'PRYNX-FTT-01',
        boxType: 'flip_top_tuck',
        groups: ['nap_lat'],
        nameVi: 'Hộp nắp lật tự khóa, gài mặt trước',
        descVi: 'Hộp một mảnh — thành tự khóa, nắp lật liền thân và lưỡi gài mặt trước',
        aliases: [
            'self-locking flip top', 'flip top tuck', 'front tuck box',
            'hop nap lat tu khoa', 'hop gai mat truoc',
        ],
        lockedParams: {},
        preset: { L: 200, W: 200, D: 60, T: 0.5, C: 0.5 },
    },
    // ── Khay & hộp hai mảnh ──
    {
        id: 'tray_std',
        code: 'PRYNX-TR-01',
        boxType: 'tray',
        groups: ['khay_hai_manh'],
        nameVi: 'Hộp khay 4 góc dán',
        descVi: 'Khay giấy 4 góc dán kèm vỏ bao — hộp diêm, khay đựng thực phẩm',
        aliases: ['matchbox tray', 'hop diem', 'khay giay', 'khay 4 goc dan', 'tray sleeve'],
        lockedParams: {},
        preset: { L: 200, W: 150, D: 40, T: 1, G: 10, TH: 15, sleeveGlue: 15 },
    },
    {
        id: 'dtray_std',
        code: 'PRYNX-DT-01',
        boxType: 'double_tray',
        groups: ['khay_hai_manh'],
        nameVi: 'Hộp âm dương (khay + nắp chụp)',
        descVi: 'Khay thành kép và nắp chụp rời — hộp quà, hộp bánh cao cấp',
        aliases: ['double tray', 'hop am duong', 'hop nap chup', 'khay nap roi', 'hop 2 manh'],
        lockedParams: {},
        preset: { L: 361, W: 261, D: 52, T: 1.5, C: 1, G: 5, TH: 15, lidD: 0, lidGap: 1 },
    },

    // ── Hộp treo có cửa sổ (Hanging Window Box) ──
    // Trục tách: `hgbWindow`. Cửa sổ là lỗ khoét trên mặt trước — khác
    // biệt lớn nhất có thể thấy trên ảnh. Bản kín dùng cho hàng không cần
    // trưng bày sản phẩm nhưng vẫn treo kệ.
    {
        id: 'hgb_window',
        code: 'PRYNX-HW-01',
        boxType: 'hanging_window',
        groups: ['treo_ke', 'cua_so'],
        nameVi: 'Hộp treo có cửa sổ',
        descVi: 'Hộp treo kệ siêu thị — cửa sổ mặt trước, tai treo euro gập đôi',
        aliases: ['hanging window box', 'hop treo cua so', 'euro slot', 'hop treo ke', 'hop hang dien tu'],
        lockedParams: { hgbWindow: true },
        preset: { L: 80, W: 30, D: 140, T: 0.5, C: 0.5, G: 15, TH: 15 },
    },
    {
        id: 'hgb_solid',
        code: 'PRYNX-HW-02',
        boxType: 'hanging_window',
        groups: ['treo_ke'],
        nameVi: 'Hộp treo kín không cửa sổ',
        descVi: 'Hộp treo kệ siêu thị — mặt trước kín, in phủ toàn bộ',
        aliases: ['hanging box no window', 'hop treo kin', 'euro slot', 'hop treo ke'],
        lockedParams: { hgbWindow: false },
        preset: { L: 80, W: 30, D: 140, T: 0.5, C: 0.5, G: 15, TH: 15 },
    },
] as const;

// ─── Tra cứu ─────────────────────────────────────────────────

/** Biến thể theo id; undefined nếu không có trong catalog. */
export function getVariant(id: string): BoxVariant | undefined {
    return BOX_VARIANTS.find(v => v.id === id);
}

/** Biến thể theo mã khuôn (PRYNX-…) — dùng khi khách báo mã. */
export function getVariantByCode(code: string): BoxVariant | undefined {
    const c = code.trim().toUpperCase();
    return BOX_VARIANTS.find(v => v.code.toUpperCase() === c);
}

/** Biến thể MẶC ĐỊNH của một boxType = mục đầu tiên khai boxType đó.
 *  Dùng làm đường lùi khi variantId không hợp lệ, và để đồng bộ state khi
 *  code cũ vẫn gọi setParam('boxType', …). */
export function defaultVariantFor(boxType: BoxParams['boxType']): BoxVariant | undefined {
    return BOX_VARIANTS.find(v => v.boxType === boxType);
}

/** Khoá này có bị biến thể CHỐT không → quyết định ẩn control trong form.
 *  Nguồn duy nhất là `lockedParams`, không có danh sách ẩn thứ hai. */
export function isParamLocked(variantId: string | null, key: keyof BoxParams): boolean {
    if (!variantId) return false;
    const v = getVariant(variantId);
    if (!v) return false;
    return Object.prototype.hasOwnProperty.call(v.lockedParams, key);
}

/** Cả cụm khoá đều bị chốt → ẩn luôn tiêu đề section, tránh nhãn rỗng. */
export function isSectionLocked(variantId: string | null, keys: (keyof BoxParams)[]): boolean {
    if (keys.length === 0) return false;
    return keys.every(k => isParamLocked(variantId, k));
}

/** Params hiện tại đã LỆCH khỏi thuộc tính chốt của biến thể chưa.
 *  Dùng cho chip "đã tuỳ chỉnh" khi người dùng bật chế độ nâng cao rồi
 *  sửa một khoá bị chốt — cho phép, nhưng phải nói rõ hộp đã lệch chuẩn. */
export function isDeviated(variantId: string | null, params: BoxParams): boolean {
    if (!variantId) return false;
    const v = getVariant(variantId);
    if (!v) return false;
    if (params.boxType !== v.boxType) return true;
    return (Object.keys(v.lockedParams) as (keyof BoxParams)[])
        .some(k => params[k] !== v.lockedParams[k]);
}

/** Đếm biến thể mỗi nhóm cho sidebar. Tổng các nhóm LỚN HƠN tổng "Tất cả"
 *  là ĐÚNG — nhóm chồng lấn có chủ ý. */
export function countByGroup(): Record<BoxGroup, number> {
    const counts = Object.fromEntries(
        BOX_GROUPS.map(g => [g.id, 0]),
    ) as Record<BoxGroup, number>;
    for (const v of BOX_VARIANTS) {
        for (const g of v.groups) counts[g] += 1;
    }
    return counts;
}

/** Biến thể thuộc một nhóm. */
export function variantsInGroup(group: BoxGroup): BoxVariant[] {
    return BOX_VARIANTS.filter(v => v.groups.includes(group));
}

/** Khớp biến thể với từ khoá: bỏ dấu, tách nhiều từ rời (mọi từ đều phải
 *  xuất hiện, KHÔNG cần đúng thứ tự). Tìm được cả tên, mô tả, mã khuôn,
 *  alias và tên nhóm.
 *  Dùng lại `normalizeSearch` ở `lib/textSearch.ts` (module thuần, không
 *  React) — repo đã có nhiều hàm bỏ dấu, không thêm cái nữa. */
export function variantMatchesQuery(v: BoxVariant, query: string): boolean {
    const q = normalizeSearch(query).trim();
    if (!q) return true;
    const groupNames = v.groups
        .map(g => BOX_GROUPS.find(info => info.id === g))
        .map(info => `${info?.nameVi ?? ''} ${info?.nameEn ?? ''}`)
        .join(' ');
    const hay = normalizeSearch(
        `${v.nameVi} ${v.descVi} ${v.code} ${v.aliases.join(' ')} ${groupNames}`,
    );
    return q.split(/\s+/).every(tok => hay.includes(tok));
}
