import fs from 'node:fs';
const VI = 'desktop/src/i18n/locales/vi.json', EN = 'desktop/src/i18n/locales/en.json';
const vi = JSON.parse(fs.readFileSync(VI, 'utf8')), en = JSON.parse(fs.readFileSync(EN, 'utf8'));
const add = (ns, k, v, e) => {
  vi[ns] = vi[ns] || {}; en[ns] = en[ns] || {};
  if (vi[ns][k] !== undefined && vi[ns][k] !== v) { console.warn('WARN existing differs', ns, k, '->', vi[ns][k]); }
  vi[ns][k] = v; en[ns][k] = e;
};
// App.tsx menu bar — self-contained shell keys
add('shell', 'tai_lieu_moi', 'Tài liệu mới', 'New document');
add('shell', 'mo_file', 'Mở file…', 'Open file…');
add('shell', 'luu_thanh', 'Lưu thành…', 'Save as…');
add('shell', 'dong_tab', 'Đóng tab', 'Close tab');
add('shell', 'thoat', 'Thoát', 'Exit');
add('shell', 'lam_lai', 'Làm lại', 'Redo');
add('shell', 'cat_kho_crop', 'Cắt khổ (Crop)', 'Crop');
add('shell', 'xoa_trang', 'Xóa trang…', 'Delete pages…');
add('shell', 've_100', 'Về 100%', 'Zoom to 100%');
add('shell', 'thuoc_do_rulers', 'Thước đo (Rulers)', 'Rulers');
add('shell', 'giao_dien_toi', 'Giao diện Tối', 'Dark theme');
add('shell', 'chi_co_tab_home', 'Chỉ có tab Home', 'Home tab only');
add('shell', 'cai_dat_cau_hinh', 'Cài đặt & Cấu hình', 'Settings & Configuration');
add('shell', 'phim_tat', 'Phím tắt', 'Keyboard shortcuts');
add('shell', 'trang_chu_printsolutions', 'Trang chủ PrintSolutions.vn', 'PrintSolutions.vn homepage');
add('shell', 'xem_hai_trang', 'Xem hai trang', 'Two-page view');
fs.writeFileSync(VI, JSON.stringify(vi, null, 2) + '\n', 'utf8');
fs.writeFileSync(EN, JSON.stringify(en, null, 2) + '\n', 'utf8');
console.log('added App menu shell keys');
