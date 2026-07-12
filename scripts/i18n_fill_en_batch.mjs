#!/usr/bin/env node
/**
 * Điền bản dịch EN cho nhiều namespace vào en.json.
 * CHỈ dịch chuỗi UI thật; key nào không có trong map EN → để TRỐNG (fallback vi).
 * Rác code-fragment (shell) cố tình bỏ trống vì không bao giờ render.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EN_PATH = path.join(ROOT, 'desktop', 'src', 'i18n', 'locales', 'en.json');
const VI_PATH = path.join(ROOT, 'desktop', 'src', 'i18n', 'locales', 'vi.json');

const EN = {
  shell: {
    cai_dat_he_thong_cau_hinh_api_mo_hinh: 'System Settings & Language Model API Configuration (⚙️)',
    dong_alt_f4: 'Close (Alt+F4)',
    dong_cua_so: 'Close window',
    phong_to: 'Maximize',
    phong_to_cua_so: 'Maximize window',
    thu_nho: 'Minimize',
    thu_nho_cua_so: 'Minimize window',
    // Các key còn lại của shell là mảnh code do tokenizer bắt nhầm → để trống.
  },
  settings: {
    bang_tra_cuu_nhanh_cac_phim_tat_lam: 'Quick reference for PrynX keyboard shortcuts. Custom key remapping is coming in a future update.',
    bat_tat_cac_cong_cu_khong_su_dung_de: 'Toggle unused tools on/off to keep your workspace tidy.',
    bo_yeu_thich: 'Remove from favorites',
    cai_dat: 'Settings',
    cau_hinh_duong_dan_xuat_file_mac_dinh: 'Configure the default export path and customize the auto-rename suffix for processed files.',
    cau_hinh_he_do_luong_va_chat_luong_hien: 'Configure the measurement system and preview image quality.',
    chat_luong_cao_net_cang: 'High Quality (Sharp)',
    chat_luong_preview_pdf: 'PDF Preview Quality',
    chon_thu_muc: 'Choose folder',
    chon_thu_muc_luu_mac_dinh: 'Choose default save folder',
    chua_thiet_lap_luon_hoi_khi_luu: 'Not set (Always ask when saving)',
    don_vi_do_luong_mac_dinh: 'Default measurement unit',
    dong: 'Close',
    dong_tab_cong_cu_dang_mo: 'Close the open tool tab',
    file_goc: 'Original file:',
    giam_chat_luong_render_de_xem_truoc_pdf: 'Lower render quality for ultra-smooth previewing of thousand-page PDFs.',
    hien_thanh_menu_ngang_kieu_acrobat_cho: 'Show the Acrobat-style horizontal menu bar for mouse-driven users. Turn off for a cleaner, minimal UI.',
    khong_gian_lam_viec: '📏 Workspace',
    khong_gian_lam_viec_2: 'Workspace',
    luu_de_file_save_as: 'Save As',
    luu_tru_dau_ra: '📁 Storage & Output',
    luu_tru_dau_ra_2: 'Storage & Output',
    luu_xuat_file_pdf_hien_tai: 'Save / Export the current PDF',
    may_be: '✂️ Cutter',
    mo_dong_bang_cai_dat_nay: 'Open / Close this Settings panel',
    phim_tat_he_thong: '⌨️ System Shortcuts',
    phim_tat_he_thong_2: 'System Shortcuts',
    quan_ly_cong_cu: '🛠 Manage Tools',
    quan_ly_hien_thi_cong_cu: 'Manage tool visibility',
    quy_tac_tu_doi_ten_file_auto_rename: 'Auto-rename rule',
    render_sac_net_tung_vector_dung_cho_soi: 'Render every vector crisply, for technical inspection. Needs more RAM.',
    sau_khi_xu_ly: 'After processing:',
    them_vao_yeu_thich: 'Add to favorites',
    thoat_phan_mem: 'Quit the app',
    toc_do_nhanh_low_res: 'Fast (Low-res)',
    vi_du: 'Example:',
    vi_tri_luu_mac_dinh: 'Default save location',
    xoa_mac_dinh: 'Clear default',
  },
  'tabs.home': {
    bo_khoi_yeu_thich: 'Remove from Favorites',
    click_chon_hoac_keo_tha_file_pdf_vao: 'Click or drag & drop a PDF file here to start.',
    cong_cu_yeu_thich: '⭐ FAVORITE TOOLS',
    de_tao_trang_trang_moi: 'to create a new blank page.',
    gioi_thieu_cong_cu: 'Tool info',
    mo_file_pdf: 'Open PDF File',
    nhan: 'Press',
    sap_ra: '(coming soon)',
    tai_lieu_hinh_anh: 'Documents & Images',
    them_vao_yeu_thich: 'Add to Favorites',
    tim_cong_cu: 'Search tools...',
    tim_cong_cu_2: 'Search tools',
    tool_title_sap_ra: '${tool.title} (Coming soon)',
    xoa_tim_kiem: 'Clear search',
    yeu_thich: '⭐ FAVORITES',
  },
};

const en = JSON.parse(fs.readFileSync(EN_PATH, 'utf8'));
const vi = JSON.parse(fs.readFileSync(VI_PATH, 'utf8'));

let filled = 0, junkLeftEmpty = 0;
for (const [ns, map] of Object.entries(EN)) {
  if (!en[ns]) { console.error('THIẾU ns trong en.json:', ns); process.exit(1); }
  for (const key of Object.keys(vi[ns])) {
    if (map[key] !== undefined) { en[ns][key] = map[key]; filled++; }
    else { junkLeftEmpty++; }  // để trống → fallback vi
  }
}

fs.writeFileSync(EN_PATH, JSON.stringify(en, null, 2), 'utf8');
console.log(`✓ Điền ${filled} chuỗi UI thật; để trống ${junkLeftEmpty} key (rác code / fallback vi).`);
