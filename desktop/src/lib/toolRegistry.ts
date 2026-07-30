/**
 * Tool Registry — Trung tâm đăng ký công cụ
 * 
 * Tất cả tools được khai báo tại đây. App.tsx và HomeTab.tsx 
 * chỉ đọc registry này để render, không hard-code gì cả.
 * 
 * Muốn thêm tool mới? Chỉ cần thêm 1 entry vào đây + tạo component.
 */

// UIUX (audit 2026-07-27 §A-04): bỏ createElement/CropIcon — icon Crop quy về emoji cùng hệ với dàn icon menu công cụ
import { lazy, type LazyExoticComponent, type ComponentType, type ReactNode } from 'react';
// [VARIANT 2026-07-29] Hàm chuẩn hoá tìm kiếm ở module thuần (không React)
import { normalizeSearch } from './textSearch';

// ─── Tool Category IDs ───
export type ToolCategoryId = 'file' | 'print' | 'vdp' | 'impo' | 'packaging' | 'util' | 'qc';

// ─── Tool App IDs (used as tab type) ───
export type AppToolId = 'compare_pdf' | 'compare_text' | 'ai_qc' | 'imposition' | 'preflight' | 'combine_pdf' | 'dieline' | 'nup' | 'diecut' | 'cnc' | 'booklet';

export interface ToolDefinition {
  /** Unique tool identifier, used as tab type */
  id: AppToolId;
  /** Display title in Vietnamese */
  title: string;
  /** Default tab title when opened */
  tabTitle: string;
  /** Tool icon */
  icon: ReactNode;
  /** Short description for compact sidebar */
  description: string;
  /** Long description for expanded card view */
  longDescription: string;
  /** Category grouping */
  category: ToolCategoryId;
  /** Lazy-loaded component */
  component: LazyExoticComponent<ComponentType<any>>;
  /** Is this tool currently available? false = "sắp ra mắt" */
  isEnabled: boolean;
  /** Max simultaneous tab instances. undefined = unlimited */
  maxInstances?: number;
  /** Payload to pass when opening this tool */
  defaultPayload?: any;
  /** Styling: hover border color class */
  hoverColor: string;
  /** Styling: expanded card hover border class */
  hoverBorder: string;
  /** Styling: expanded card hover shadow class */
  hoverShadow: string;
  /** Styling: icon background class */
  bgIcon: string;
  /** Styling: icon text color class */
  textIcon: string;
}

// ─── Lazy Component Imports ───
const CompareTab = lazy(() => import('../components/CompareTab'));
const TextCompareTab = lazy(() => import('../components/TextCompareTab'));
const AiQcTab = lazy(() => import('../components/AiQcTab')); // eslint-disable-line @typescript-eslint/no-unused-vars -- TẠM KHOÁ: entry ai_qc trong TOOL_REGISTRY đang bị comment (xem ghi chú). Giữ import để bật lại nhanh.
const ImpositionTab = lazy(() => import('../components/ImpositionTab'));
const CombineTab = lazy(() => import('../components/CombineTab'));
const DielineTool = lazy(() => import('../components/dieline-tool/DielineTool'));
const IMPOSITION_FAMILY_TOOL_IDS = new Set<AppToolId>(['imposition', 'nup', 'diecut', 'cnc', 'preflight']);

/** Các tab dùng chung workspace và menu công cụ của ImpositionTab. */
export function isImpositionFamilyTool(toolId: string): boolean {
  return IMPOSITION_FAMILY_TOOL_IDS.has(toolId as AppToolId);
}

export function getToolUniqueKey(tool: ToolDefinition): string {
  return tool.defaultPayload?.focusFeature || tool.defaultPayload?.lockedMode || tool.id;
}

// ─── Category Definitions ───
export interface ToolCategory {
  id: ToolCategoryId;
  title: string;
}

export const TOOL_CATEGORIES: ToolCategory[] = [
  { id: 'file',       title: 'XỬ LÝ FILE (File Prep)' },
  { id: 'print',      title: 'KỸ THUẬT IN (Prepress)' },
  { id: 'vdp',        title: 'DỮ LIỆU BIẾN ĐỔI (VDP)' },
  { id: 'impo',       title: 'BÌNH BÀI IN (Imposition)' },
  { id: 'packaging',   title: 'KHUÔN BAO BÌ (Packaging)' },
  { id: 'util',       title: 'TIỆN ÍCH KHÁC (Utilities)' },
  { id: 'qc',         title: 'KIỂM TRA CHẤT LƯỢNG (QC)' },
];

// ─── Tool Definitions ───
export const TOOL_REGISTRY: ToolDefinition[] = [
  // ── FILE PREP ──
  {
    id: 'imposition',
    title: 'Xáo trộn trang',
    tabTitle: 'Bình bài (Chưa có file)',
    icon: '🔀',
    description: 'Sắp xếp, đảo ngược, chẵn lẻ',
    longDescription: 'Sắp xếp lại thứ tự, đảo ngược, chỉ định trang chẵn lẻ cho khâu in tự động.',
    category: 'file',
    component: ImpositionTab,
    isEnabled: true,
    defaultPayload: { focusFeature: 'shuffle' },
    hoverColor: 'hover:border-amber-500 hover:text-amber-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-amber-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(245,158,11,0.15)]',
    bgIcon: 'bg-amber-100 dark:bg-amber-500/10',
    textIcon: 'text-amber-600',
  },
  {
    id: 'imposition',
    title: 'Co giãn trang (Resize)',
    tabTitle: 'Bình bài (Chưa có file)',
    icon: '📏',
    description: 'Thu phóng nội dung fit A4/A3',
    longDescription: 'Fit, fill, stretch tỷ lệ vàng khung A4/A3 hoặc Crop theo viền artboard.',
    category: 'file',
    component: ImpositionTab,
    isEnabled: true,
    defaultPayload: { focusFeature: 'resize' },
    hoverColor: 'hover:border-teal-500 hover:text-teal-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-teal-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(20,184,166,0.15)]',
    bgIcon: 'bg-teal-100 dark:bg-teal-500/10',
    textIcon: 'text-teal-600',
  },
  {
    id: 'imposition',
    title: 'Cắt khổ trang (Crop)',
    tabTitle: 'Bình bài (Chưa có file)',
    // UIUX (audit 2026-07-27 §A-04): icon lucide lọt giữa dàn emoji → emoji ✂️ đồng bộ
    icon: '✂️',
    description: 'Quét vùng và cắt theo kích thước, canh theo trang',
    longDescription: 'Quét một hoặc nhiều vùng trên trang PDF, nhập kích thước chính xác và canh vùng theo toàn bộ trang.',
    category: 'file',
    component: ImpositionTab,
    isEnabled: true,
    defaultPayload: { focusFeature: 'crop' },
    hoverColor: 'hover:border-orange-500 hover:text-orange-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-orange-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(249,115,22,0.15)]',
    bgIcon: 'bg-orange-100 dark:bg-orange-500/10',
    textIcon: 'text-orange-600',
  },
  {
    id: 'imposition',
    title: 'Trim & Shift',
    tabTitle: 'Bình bài (Chưa có file)',
    icon: '⇲',
    description: 'Chỉnh khổ từng cạnh, dời nội dung, bù gáy',
    longDescription: 'Cắt xén hoặc thêm lề từng cạnh (chỉnh box), dời nội dung theo X/Y, bù lề gáy trang lẻ-chẵn và bù nhảy trang (creep) tăng dần.',
    category: 'file',
    component: ImpositionTab,
    isEnabled: true,
    defaultPayload: { focusFeature: 'trim_shift' },
    hoverColor: 'hover:border-teal-500 hover:text-teal-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-teal-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(20,184,166,0.15)]',
    bgIcon: 'bg-teal-100 dark:bg-teal-500/10',
    textIcon: 'text-teal-600',
  },
  {
    id: 'imposition',
    title: 'Tách file PDF',
    tabTitle: 'Bình bài (Chưa có file)',
    icon: '✂️',
    description: 'Tách lẻ trang, chia theo dải hoặc theo nhóm',
    longDescription: 'Tách file PDF: cắt lẻ từng trang, trích xuất dải trang chỉ định, hoặc chia đều thành nhiều file theo số trang/nhóm.',
    category: 'file',
    component: ImpositionTab,
    isEnabled: true,
    defaultPayload: { focusFeature: 'split' },
    hoverColor: 'hover:border-amber-500 hover:text-amber-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-amber-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(245,158,11,0.15)]',
    bgIcon: 'bg-amber-100 dark:bg-amber-500/10',
    textIcon: 'text-amber-600',
  },
  {
    id: 'imposition',
    title: 'Quản lý trang',
    tabTitle: 'Bình bài (Chưa có file)',
    icon: '📄',
    description: 'Nhân bản, di chuyển, xóa, xoay trang',
    longDescription: 'Quản lý cấu trúc file PDF: nhân bản trang, di chuyển thứ tự, xóa trang, xoay trang (theo trang/dải/chẵn lẻ).',
    category: 'file',
    component: ImpositionTab,
    isEnabled: true,
    defaultPayload: { focusFeature: 'pages' },
    hoverColor: 'hover:border-blue-500 hover:text-blue-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-blue-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(59,130,246,0.15)]',
    bgIcon: 'bg-blue-100 dark:bg-blue-500/10',
    textIcon: 'text-blue-600',
  },

  // ── PREPRESS ──
  {
    id: 'preflight',
    title: 'Preflight chuẩn in',
    tabTitle: 'Preflight',
    icon: '🩺',
    description: 'Kiểm tra & sửa lỗi PDF tự động',
    longDescription: 'Phân tích cấu trúc PDF: hệ màu RGB/CMYK, font nhúng, ảnh low-res, transparency, bleed. Tự động sửa lỗi giống PitStop.',
    category: 'print',
    // UIUX (audit 2026-07-27 §WR.1): Preflight dùng cùng workspace/menu dù mở trước hay sau PDF.
    component: ImpositionTab,
    isEnabled: true,
    maxInstances: 1,
    defaultPayload: { focusFeature: 'preflight' },
    hoverColor: 'hover:border-teal-500 hover:text-teal-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-teal-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(20,184,166,0.15)]',
    bgIcon: 'bg-teal-100 dark:bg-teal-500/10',
    textIcon: 'text-teal-600',
  },
  {
    id: 'imposition',
    title: 'Chữ & Font',
    tabTitle: 'Bình bài (Chưa có file)',
    icon: '🔤',
    description: 'Kiểm tra font nhúng và khóa chữ an toàn',
    longDescription: 'Kiểm tra font nhúng, phát hiện chữ sống và chuyển chữ thành vector với hậu kiểm từng trang.',
    category: 'print',
    component: ImpositionTab,
    isEnabled: true,
    // UIUX (audit 2026-07-28 §F.2): công cụ chuyên dụng dùng chung workspace và backend Preflight.
    defaultPayload: { focusFeature: 'font_tools' },
    hoverColor: 'hover:border-indigo-500 hover:text-indigo-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-indigo-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(99,102,241,0.15)]',
    bgIcon: 'bg-indigo-100 dark:bg-indigo-500/10',
    textIcon: 'text-indigo-600',
  },
  {
    id: 'imposition',
    title: 'Chuyển hệ màu',
    tabTitle: 'Bình bài (Chưa có file)',
    icon: '🎨',
    description: 'RGB sang CMYK, gắn ICC Profile',
    longDescription: 'Chuyển đổi không gian màu sang CMYK an toàn cho in ấn.',
    category: 'print',
    component: ImpositionTab,
    isEnabled: true,
    defaultPayload: { focusFeature: 'convertcolors' },
    hoverColor: 'hover:border-pink-500 hover:text-pink-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-pink-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(236,72,153,0.15)]',
    bgIcon: 'bg-pink-100 dark:bg-pink-500/10',
    textIcon: 'text-pink-600',
  },
  {
    id: 'imposition',
    title: 'Sửa nét mảnh (Hairlines)',
    tabTitle: 'Bình bài (Chưa có file)',
    icon: '✏️',
    description: 'Xử lý nét siêu mảnh < 0.25pt',
    longDescription: 'Tự động làm dày các đường viền quá mảnh để tránh đứt nét khi in.',
    category: 'print',
    component: ImpositionTab,
    isEnabled: true,
    defaultPayload: { focusFeature: 'hairlines' },
    hoverColor: 'hover:border-orange-500 hover:text-orange-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-orange-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(249,115,22,0.15)]',
    bgIcon: 'bg-orange-100 dark:bg-orange-500/10',
    textIcon: 'text-orange-600',
  },
  {
    id: 'imposition',
    title: 'Chồng tràn (Trapping)',
    tabTitle: 'Bình bài (Chưa có file)',
    icon: '🔲',
    description: 'Tạo viền chồng màu, Overprint text',
    longDescription: 'Xử lý bù trừ lé trắng, tạo lớp overprint an toàn.',
    category: 'print',
    component: ImpositionTab,
    isEnabled: true,
    defaultPayload: { focusFeature: 'trapping' },
    hoverColor: 'hover:border-violet-500 hover:text-violet-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-violet-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(139,92,246,0.15)]',
    bgIcon: 'bg-violet-100 dark:bg-violet-500/10',
    textIcon: 'text-violet-600',
  },
  {
    id: 'imposition',
    title: 'Bù xén - Tạo đường cắt',
    tabTitle: 'Bình bài (Chưa có file)',
    icon: '🔪',
    description: 'Xóa nền trắng, offset tạo viền bế',
    longDescription: 'Quét hình ảnh, tự động offset viền và tạo khuôn bế (Cut contour) & tràn lề cho tem nhãn.',
    category: 'impo',
    component: ImpositionTab,
    isEnabled: true,
    defaultPayload: { focusFeature: 'sticker' },
    hoverColor: 'hover:border-rose-500 hover:text-rose-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-rose-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(244,63,94,0.15)]',
    bgIcon: 'bg-rose-100 dark:bg-rose-500/10',
    textIcon: 'text-rose-600',
  },

  // ── VDP ──
  {
    id: 'imposition',
    title: 'Trộn dữ liệu VDP',
    tabTitle: 'Bình bài (Chưa có file)',
    icon: '🔤',
    description: 'Mail merge, chèn chữ & hình',
    longDescription: 'Nạp dữ liệu CSV (xuất từ Excel/Google Sheets) vào Data fields, tự động sinh PDF lô siêu tốc.',
    category: 'vdp',
    component: ImpositionTab,
    isEnabled: true,
    defaultPayload: { focusFeature: 'datamerge' },
    hoverColor: 'hover:border-purple-500 hover:text-purple-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-purple-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(168,85,247,0.15)]',
    bgIcon: 'bg-purple-100 dark:bg-purple-500/10',
    textIcon: 'text-purple-600',
  },
  {
    id: 'imposition',
    title: 'Nhảy số tự động',
    tabTitle: 'Bình bài (Chưa có file)',
    icon: '🔢',
    description: 'Đánh số thứ tự vé, mã vạch, serial',
    longDescription: 'Nhảy số Serial thông minh theo tọa độ XY cố định.',
    category: 'vdp',
    component: ImpositionTab,
    isEnabled: true,
    defaultPayload: { focusFeature: 'numbering' },
    hoverColor: 'hover:border-indigo-500 hover:text-indigo-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-indigo-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(99,102,241,0.15)]',
    bgIcon: 'bg-indigo-100 dark:bg-indigo-500/10',
    textIcon: 'text-indigo-600',
  },
  {
    id: 'imposition',
    title: 'Mẹc Bìa (Chạy số bìa)',
    tabTitle: 'Bình bài (Chưa có file)',
    icon: '🔖',
    description: 'Đánh số bìa sổ/quyển nhiều liên (X/Y/Z)',
    longDescription: 'Đánh số bìa theo dải ruột mỗi cuốn — phối hợp với Nhảy số (mẹc số) dùng chung dải.',
    category: 'vdp',
    component: ImpositionTab,
    isEnabled: true,
    defaultPayload: { focusFeature: 'cover_numbering' },
    hoverColor: 'hover:border-indigo-500 hover:text-indigo-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-indigo-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(99,102,241,0.15)]',
    bgIcon: 'bg-indigo-100 dark:bg-indigo-500/10',
    textIcon: 'text-indigo-600',
  },
  {
    id: 'imposition',
    title: 'Header & Footer',
    tabTitle: 'Header & Footer',
    icon: '🔠',
    description: 'Đầu/chân trang: số trang, ngày, text',
    longDescription: 'Chèn Header/Footer cố định: số trang [page], ngày [date] và text vào 6 vị trí góc trang (giống Acrobat).',
    category: 'util',
    component: ImpositionTab,
    isEnabled: true,
    defaultPayload: { focusFeature: 'stick_text_number' },
    hoverColor: 'hover:border-sky-500 hover:text-sky-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-sky-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(14,165,233,0.15)]',
    bgIcon: 'bg-sky-100 dark:bg-sky-500/10',
    textIcon: 'text-sky-600',
  },

  // ── IMPOSITION ──
  {
    id: 'imposition',
    title: 'Bình Sách & Tạp chí',
    tabTitle: 'Bình bài (Chưa có file)',
    icon: '📚',
    description: 'Khâu chỉ, lồng đôi, tính bù gáy',
    longDescription: 'Chuyên dựng tay sách lồng đôi, khâu chỉ. Tự động tính toán độ bù gáy (Creep).',
    category: 'impo',
    component: ImpositionTab,
    isEnabled: true,
    defaultPayload: { lockedMode: 'booklet' },
    hoverColor: 'hover:border-emerald-500 hover:text-emerald-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-emerald-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(16,185,129,0.15)]',
    bgIcon: 'bg-emerald-100 dark:bg-emerald-500/10',
    textIcon: 'text-emerald-600',
  },
  {
    id: 'nup',
    title: 'Bình Cắt Xén (N-Up)',
    tabTitle: 'Bình bài (Chưa có file)',
    icon: '🎴',
    description: 'Nhân bản, ghép nhiều trang vô 1 tờ',
    longDescription: 'Chuyên rải nhiều trang biểu mẫu hoặc nhân bản tự động kín tờ in lớn (N-Up / S&R).',
    category: 'impo',
    component: ImpositionTab,
    isEnabled: true,
    defaultPayload: { lockedMode: 'nup' },
    hoverColor: 'hover:border-rose-500 hover:text-rose-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-rose-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(244,63,94,0.15)]',
    bgIcon: 'bg-rose-100 dark:bg-rose-500/10',
    textIcon: 'text-rose-600',
  },
  {
    id: 'diecut',
    title: 'Bình Tem Bế',
    tabTitle: 'Bình bài (Chưa có file)',
    icon: '🏷️',
    description: 'Xếp tem decal so le, xếp tổ ong',
    longDescription: 'Chuyên dụng bình bản tem bế: Hỗ trợ xếp so le tổ ong (Staggered Hex), chừa lề kẹp bế, ghép file nhiều loại kích thước.',
    category: 'impo',
    component: ImpositionTab,
    isEnabled: true,
    defaultPayload: { lockedMode: 'sticker_imposer' },
    hoverColor: 'hover:border-pink-500 hover:text-pink-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-pink-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(236,72,153,0.15)]',
    bgIcon: 'bg-pink-100 dark:bg-pink-500/10',
    textIcon: 'text-pink-600',
  },
  {
    id: 'cnc',
    title: 'Bình Bế Rớt (CNC)',
    tabTitle: 'Bình bài (Chưa có file)',
    icon: '🔻',
    description: 'Cắt rời CNC, bình 2 mặt',
    longDescription: 'Chuyên bình sản phẩm bế rớt / cắt rời trên máy CNC: hỗ trợ bình 2 mặt (lật gương mặt sau), dấu canh in 2 mặt để canh chồng, xuất 3 trang Mặt trước / Mặt sau / Khuôn.',
    category: 'impo',
    component: ImpositionTab,
    isEnabled: true,
    defaultPayload: { lockedMode: 'cnc_imposer' },
    hoverColor: 'hover:border-orange-500 hover:text-orange-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-orange-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(249,115,22,0.15)]',
    bgIcon: 'bg-orange-100 dark:bg-orange-500/10',
    textIcon: 'text-orange-600',
  },

  // ── PACKAGING (Khuôn Bao Bì) ──
  {
    id: 'dieline',
    title: 'Khuôn bế Bao bì',
    tabTitle: 'Khuôn bế',
    icon: '📦',
    description: 'Tạo khuôn bế tham số, 3D mockup, xếp khuôn',
    longDescription: 'Vẽ khuôn bao bì tham số cho 9 loại hộp: Nắp cài, Đáy gài, Đáy dán, Quai xách, Túi giấy, Bọc ly, Pizza, Bì thư, Hộp diêm. Mô phỏng gập 3D và xuất PDF chuẩn 1:1.',
    category: 'packaging',
    component: DielineTool,
    isEnabled: true,
    maxInstances: 1,
    hoverColor: 'hover:border-violet-500 hover:text-violet-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-violet-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(139,92,246,0.15)]',
    bgIcon: 'bg-violet-100 dark:bg-violet-500/10',
    textIcon: 'text-violet-600',
  },

  // ── UTILITIES ──
  {
    id: 'imposition',
    title: 'Tách nền ảnh AI',
    tabTitle: 'Bình bài (Chưa có file)',
    icon: '✨',
    description: 'Bóc tách nền độ nét cao bằng AI',
    longDescription: 'Sử dụng AI tiên tiến để tự động tách nền phức tạp, giữ nguyên chi tiết mảnh như tóc hay lông chó mèo.',
    category: 'util',
    component: ImpositionTab,
    isEnabled: true,
    defaultPayload: { focusFeature: 'bgremover' },
    hoverColor: 'hover:border-violet-500 hover:text-violet-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-violet-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(139,92,246,0.15)]',
    bgIcon: 'bg-violet-100 dark:bg-violet-500/10',
    textIcon: 'text-violet-600',
  },
  {
    id: 'imposition',
    title: 'Chèn Nền & Đóng Dấu',
    tabTitle: 'Bình bài (Chưa có file)',
    icon: '©️',
    description: 'Chèn phôi nền (Background), logo chìm (Watermark)',
    longDescription: 'Bảo vệ bản quyền hoặc chèn phôi thiết kế vector làm nền.',
    category: 'util',
    component: ImpositionTab,
    isEnabled: true,
    defaultPayload: { focusFeature: 'watermark' },
    hoverColor: 'hover:border-sky-500 hover:text-sky-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-sky-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(14,165,233,0.15)]',
    bgIcon: 'bg-sky-100 dark:bg-sky-500/10',
    textIcon: 'text-sky-600',
  },
  {
    id: 'imposition',
    title: 'Nén / Tối ưu PDF',
    tabTitle: 'Bình bài (Chưa có file)',
    icon: '📦',
    description: 'Giảm dung lượng file, nén ảnh, gỡ rác',
    longDescription: 'Downsample hình ảnh, xóa rác, gỡ profile màu thừa để tối ưu gửi nhà in.',
    category: 'util',
    component: ImpositionTab,
    isEnabled: true,
    defaultPayload: { focusFeature: 'optimize' },
    hoverColor: 'hover:border-emerald-500 hover:text-emerald-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-emerald-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(16,185,129,0.15)]',
    bgIcon: 'bg-emerald-100 dark:bg-emerald-500/10',
    textIcon: 'text-emerald-600',
  },
  {
    id: 'imposition',
    title: 'Khóa / Mở khóa PDF',
    tabTitle: 'Bình bài (Chưa có file)',
    icon: '🔐',
    description: 'Mật khẩu, hạn chế in/copy, gỡ khóa',
    longDescription: 'Khóa PDF bằng mật khẩu (AES), hạn chế in/sao chép/sửa; mở khóa khi biết mật khẩu. Dùng pikepdf — không đụng pipeline bình bài.',
    category: 'util',
    component: ImpositionTab,
    isEnabled: true,
    defaultPayload: { focusFeature: 'encrypt' },
    hoverColor: 'hover:border-amber-500 hover:text-amber-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-amber-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(245,158,11,0.15)]',
    bgIcon: 'bg-amber-100 dark:bg-amber-500/10',
    textIcon: 'text-amber-600',
  },
  {
    id: 'imposition',
    title: 'Metadata PDF',
    tabTitle: 'Bình bài (Chưa có file)',
    icon: '🏷️',
    description: 'Sửa Title, Author, xóa metadata',
    longDescription: 'Xem và chỉnh Info dictionary (Title, Author, Subject, Keywords…). Xóa hết metadata khi cần gửi file sạch. Không đụng nén / strip của Optimize.',
    category: 'util',
    component: ImpositionTab,
    isEnabled: true,
    defaultPayload: { focusFeature: 'metadata' },
    hoverColor: 'hover:border-violet-500 hover:text-violet-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-violet-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(139,92,246,0.15)]',
    bgIcon: 'bg-violet-100 dark:bg-violet-500/10',
    textIcon: 'text-violet-600',
  },
  {
    id: 'imposition',
    title: 'Word / Excel / Google → PDF',
    tabTitle: 'Bình bài (Chưa có file)',
    icon: '📝',
    description: 'Xuất PDF từ Office hoặc link Google',
    longDescription: 'Chuyển Word/Excel (cần MS Office hoặc LibreOffice trên máy) và link Google Docs/Sheets (chia sẻ Anyone with the link) sang PDF để bình bài / prepress.',
    category: 'file',
    component: ImpositionTab,
    isEnabled: true,
    defaultPayload: { focusFeature: 'office_convert' },
    hoverColor: 'hover:border-indigo-500 hover:text-indigo-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-indigo-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(99,102,241,0.15)]',
    bgIcon: 'bg-indigo-100 dark:bg-indigo-500/10',
    textIcon: 'text-indigo-600',
  },
  // ─── OCR (Nhận dạng chữ → Searchable PDF) — TẠM ẨN (phát triển lại sau) ───
  // Lý do (audit 2026-06-26): lớp text ẩn nhúng qua insert_text(render_mode=3) encode
  // bằng latin-1 + font base-14 Helvetica → KÝ TỰ TIẾNG VIỆT bị thay bằng '?' (đã chạy
  // chứng minh). ⇒ Ctrl+F / bôi đen / copy tiếng Việt KHÔNG hoạt động (chỉ chạy đúng cho
  // English/ASCII). Nhận diện (Tesseract vie+eng) thì OK — lỗi nằm ở khâu NHÚNG text.
  // Giữ nguyên: OcrTool.tsx, route /pdf-tools/ocr-searchable, OCREngine, routing
  // (WORKSPACE_TOOL_PANEL/PREPROCESS_ROUTER_TOOLS) để bật lại nhanh.
  // ĐỂ HIỆN LẠI: bỏ comment khối dưới SAU KHI nhúng font TrueType Unicode (DejaVuSans đã
  // có ở backend/app/assets/fonts) dạng CID + ToUnicode CMap thay cho latin-1/Helvetica.
  // {
  //   id: 'imposition',
  //   title: 'Nhận dạng chữ (OCR)',
  //   tabTitle: 'Bình bài (Chưa có file)',
  //   icon: '🔍',
  //   description: 'Nhúng text ẩn để tìm kiếm, copy chữ',
  //   longDescription: 'Chạy OCR nhận diện chữ trên ảnh scan, tạo lớp text ẩn giúp copy, tìm kiếm dễ dàng.',
  //   category: 'util',
  //   component: ImpositionTab,
  //   isEnabled: true,
  //   defaultPayload: { focusFeature: 'ocr' },
  //   hoverColor: 'hover:border-cyan-500 hover:text-cyan-600 text-slate-800 dark:text-white',
  //   hoverBorder: 'hover:border-cyan-500',
  //   hoverShadow: 'hover:shadow-[0_8px_30px_rgb(6,182,212,0.15)]',
  //   bgIcon: 'bg-cyan-100 dark:bg-cyan-500/10',
  //   textIcon: 'text-cyan-600',
  // },
  {
    id: 'imposition',
    title: 'Xuất PDF/X chuẩn',
    tabTitle: 'Bình bài (Chưa có file)',
    icon: '📄',
    description: 'Chuyển sang chuẩn in ấn PDF/X an toàn',
    longDescription: 'Flatten transparency, chuyển đổi chuẩn PDF/X-1a, PDF/X-4.',
    category: 'util',
    component: ImpositionTab,
    isEnabled: true,
    defaultPayload: { focusFeature: 'pdfx' },
    hoverColor: 'hover:border-emerald-500 hover:text-emerald-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-emerald-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(16,185,129,0.15)]',
    bgIcon: 'bg-emerald-100 dark:bg-emerald-500/10',
    textIcon: 'text-emerald-600',
  },
  {
    id: 'imposition',
    title: 'AI Upscale',
    tabTitle: 'Bình bài (Chưa có file)',
    icon: '🪄',
    description: 'Phóng to ảnh AI đúng kích thước (2x, 4x)',
    longDescription: 'Cải thiện độ nét cảm nhận khi phóng to 2x, 4x, xử lý hoàn toàn trên máy. AI có thể suy đoán chi tiết; cần kiểm tra chữ và logo ở mức zoom 1:1.',
    category: 'util',
    component: ImpositionTab,
    isEnabled: true,
    defaultPayload: { focusFeature: 'upscale' },
    hoverColor: 'hover:border-violet-500 hover:text-violet-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-violet-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(139,92,246,0.15)]',
    bgIcon: 'bg-violet-100 dark:bg-violet-500/10',
    textIcon: 'text-violet-600',
  },
  // UIUX (audit 2026-07-29 §LR.HOLD): tạm ẩn Logo Rebuild khỏi mọi menu.
  // Workspace/backend được giữ nguyên để bật lại sau khi màu và hình học đạt nghiệm thu.
  {
    id: 'combine_pdf',
    title: 'Ghép & Trộn PDF',
    tabTitle: 'Ghép & Trộn PDF',
    icon: '📑',
    description: 'Ghép nối, trộn xen kẽ lẻ/chẵn, chèn trang',
    longDescription: 'Sắp xếp trực quan và ghép nhiều tệp PDF thành 1: ghép nối tiếp, trộn xen kẽ lẻ/chẵn, chèn trang trắng/trang từ file khác.',
    category: 'file',
    component: CombineTab,
    isEnabled: true,
    hoverColor: 'hover:border-blue-500 hover:text-blue-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-blue-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(59,130,246,0.15)]',
    bgIcon: 'bg-blue-100 dark:bg-blue-500/10',
    textIcon: 'text-blue-600',
  },
  // ── QUALITY CONTROL (Standalone Apps) ──
  {
    id: 'compare_pdf',
    title: 'So sánh PDF (In ấn)',
    tabTitle: 'So sánh PDF',
    icon: '⚖️',
    description: 'So Pixel bản mẫu & bản bình',
    longDescription: 'So dò pixel bản mẫu và bản bình. Phân tích lỗi kỹ thuật tự động.',
    category: 'qc',
    component: CompareTab,
    isEnabled: true,
    maxInstances: 1,
    hoverColor: 'hover:border-blue-500 hover:text-blue-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-blue-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(59,130,246,0.15)]',
    bgIcon: 'bg-blue-100 dark:bg-blue-500/10',
    textIcon: 'text-blue-600',
  },
  {
    id: 'compare_text',
    title: 'So sánh Văn bản',
    tabTitle: 'So sánh Text',
    icon: '📝',
    description: 'So text Text thuần siêu tốc',
    longDescription: 'So sánh text thuần với tốc độ cao giữa 2 phiên bản Word/PDF độc lập.',
    category: 'qc',
    component: TextCompareTab,
    isEnabled: true,
    maxInstances: 1,
    hoverColor: 'hover:border-purple-500 hover:text-purple-600 text-slate-800 dark:text-white',
    hoverBorder: 'hover:border-purple-500',
    hoverShadow: 'hover:shadow-[0_8px_30px_rgb(168,85,247,0.15)]',
    bgIcon: 'bg-purple-100 dark:bg-purple-500/10',
    textIcon: 'text-purple-600',
  },
  // ─── AI QC (Soát lỗi AI) — TẠM KHOÁ & ẨN (phát triển lại sau) ───
  // Lý do: audit phát hiện rủi ro bảo mật (rò rỉ API key qua message lỗi/log khi
  // gọi Gemini), gửi nội dung file khách lên bên thứ ba không cảnh báo, thiếu giới
  // hạn kích thước/chi phí. Giữ nguyên component (AiQcTab.tsx) + backend (/qc/*)
  // để phát triển lại. Để HIỆN lại: bỏ comment khối dưới + import AiQcTab ở trên.
  // {
  //   id: 'ai_qc',
  //   title: 'Soát lỗi AI',
  //   tabTitle: 'Soát lỗi AI',
  //   icon: '🧬',
  //   description: 'Kiểm tra chính tả bằng AI',
  //   longDescription: 'LLM soát lỗi chính tả, phân biệt ngữ pháp địa phương, tư vấn an toàn cho in ấn.',
  //   category: 'qc',
  //   component: AiQcTab,
  //   isEnabled: true,
  //   hoverColor: 'hover:border-indigo-500 hover:text-indigo-600 text-slate-800 dark:text-white',
  //   hoverBorder: 'hover:border-indigo-500',
  //   hoverShadow: 'hover:shadow-[0_8px_30px_rgb(99,102,241,0.15)]',
  //   bgIcon: 'bg-indigo-100 dark:bg-indigo-500/10',
  //   textIcon: 'text-indigo-600',
  // },
];

// ─── Helper Functions ───

/** Get all tools for a specific category */
export function getToolsByCategory(categoryId: ToolCategoryId): ToolDefinition[] {
  return TOOL_REGISTRY.filter(t => t.category === categoryId);
}

/** Find the first tool definition matching an app ID (for tab title lookup etc.) */
export function findToolById(appId: AppToolId): ToolDefinition | undefined {
  return TOOL_REGISTRY.find(t => t.id === appId && t.isEnabled);
}

/** Get the tab title for a given tool app ID */
export function getTabTitle(appId: AppToolId): string {
  const tool = findToolById(appId);
  return tool?.tabTitle || 'Công cụ';
}

/** Check if a tool has reached its max instance limit */
export function canOpenNewInstance(appId: AppToolId, currentTabs: { type: string }[]): boolean {
  const tool = findToolById(appId);
  if (!tool?.maxInstances) return true;
  const count = currentTabs.filter(t => t.type === appId).length;
  return count < tool.maxInstances;
}

/** Get the existing tab for a single-instance tool */
export function getExistingInstance(appId: AppToolId, currentTabs: { id: string; type: string }[]): string | null {
  const tool = findToolById(appId);
  if (!tool?.maxInstances) return null;
  const existing = currentTabs.find(t => t.type === appId);
  return existing?.id || null;
}

// ─── Tool Search Helpers ───

// [VARIANT 2026-07-29] `normalizeSearch` đã chuyển sang `lib/textSearch.ts` để
// module không thuộc app shell (vd lib/dieline, bundle vào sidecar Boa không có
// DOM) dùng được mà không kéo React theo. Re-export để mọi chỗ gọi cũ giữ nguyên.
export { normalizeSearch };

/**
 * Khớp công cụ theo từ khoá: bỏ dấu + tách nhiều từ rời (mọi từ đều phải xuất
 * hiện trong tên/mô tả/từ khoá, KHÔNG cần đúng thứ tự). VD "binh be rot" / "cnc 2 mat".
 * Tìm được cả tiếng Anh lẫn tiếng Việt nhờ bảng TOOL_KEYWORDS.
 */
export function toolMatchesQuery(tool: ToolDefinition, query: string): boolean {
  const q = normalizeSearch(query).trim();
  if (!q) return true;
  const kw = TOOL_KEYWORDS[getToolUniqueKey(tool)] || '';
  const hay = normalizeSearch(`${tool.title} ${tool.longDescription || ''} ${tool.description || ''} ${kw}`);
  return q.split(/\s+/).every(tok => hay.includes(tok));
}

/**
 * Từ khoá tìm kiếm bổ sung (EN + VN, viết KHÔNG dấu) cho từng công cụ.
 * Key = getToolUniqueKey (focusFeature | lockedMode | id).
 */
export const TOOL_KEYWORDS: Record<string, string> = {
  // File prep
  shuffle: 'shuffle reorder reverse sort odd even xao tron dao nguoc sap xep chan le',
  resize: 'resize scale fit fill stretch a4 a3 co gian thu phong kho trang',
  trim_shift: 'trim shift crop margin creep binding gutter cat xen them le dich noi dung bu gay le trong ngoai quite imposing',
  split: 'split extract pages divide tach chia bo trang tach le trich xuat',
  merge: 'merge combine join concat ghep noi gop tron file interleave xen ke',
  pages: 'pages page manage delete rotate duplicate move quan ly xoa xoay nhan ban di chuyen sap xep trang',
  // Prepress
  preflight: 'preflight check fix verify pitstop kiem tra sua loi chuan in',
  convertcolors: 'color colour cmyk rgb icc profile convert chuyen he mau',
  hairlines: 'hairline thin line stroke weight net manh sieu manh',
  trapping: 'trap trapping overprint spread choke chong tran le vien chong mau',
  sticker: 'cutline cut contour dieline diecut bleed offset vien be khuon tem nhan cat be',
  // VDP
  datamerge: 'vdp variable data mail merge csv excel barcode qr tron du lieu bien doi',
  numbering: 'numbering number serial sequence ticket barcode nhay so danh so seri ma vach the ve',
  cover_numbering: 'cover booklet mec bia chay so bia quyen lien hoa don bien lai so cuon X Y Z',
  stick_text_number: 'header footer dau trang chan trang bates stamp text number stick dong dau chu so chen text co dinh ngay date page quite imposing',
  // Imposition
  booklet: 'booklet signature saddle stitch thread perfect bind creep imposition binh sach tap chi khau chi long doi bu gay tay sach',
  nup: 'nup n-up step repeat sr gang grid tile binh cat xen nhan ban ghep nhieu trang luoi',
  sticker_imposer: 'sticker label decal imposition nesting stagger hex gang binh tem be so le to ong nhieu mau',
  cnc_imposer: 'cnc drop cut die two sided duplex mirror binh be rot 2 mat cat roi lat guong khuon',
  // Packaging
  dieline: 'dieline die cut packaging box carton mockup 3d khuon be bao bi hop tui',
  // Utilities
  bgremover: 'background remover remove bg ai cutout tach nen bong tach phong',
  watermark: 'watermark background stamp logo overlay dong dau chen nen logo chim phoi nen',
  optimize: 'optimize compress reduce shrink downsample nen toi uu giam dung luong',
  ocr: 'ocr recognize text searchable scan nhan dang chu quet text an',
  pdfx: 'pdfx pdf-x export standard flatten xuat chuan in pdf x-1a x-4',
  upscale: 'upscale super resolution enlarge ai sr phong to net cang',
  // QC / standalone
  combine_pdf: 'combine merge join concat interleave insert ghep noi gop tron xen ke chen trang le chan file',
  compare_pdf: 'compare diff pixel difference so sanh do pixel ban mau ban binh kiem in khong ocr',
  compare_text: 'compare text diff so sanh van ban chu khong thay so pixel in',
  ai_qc: 'ai qc spell check grammar llm soat loi chinh ta ngu phap',
};
