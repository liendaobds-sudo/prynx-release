import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(process.cwd());
const VI = path.join(ROOT, 'desktop/src/i18n/locales/vi.json');
const EN = path.join(ROOT, 'desktop/src/i18n/locales/en.json');
const vi = JSON.parse(fs.readFileSync(VI, 'utf8'));
const en = JSON.parse(fs.readFileSync(EN, 'utf8'));

// Các fragment JSX bị codemod bỏ sót (text node lẫn <strong>/<code>, class component,
// hoặc chuỗi chứa dấu ngoặc kép). Thêm key vào cả vi + en.
const ADD = {
  'tabs.combine': {
    bam_add_files_de_them_pdf_hoac_anh: [
      'Bấm "Add Files..." để thêm PDF hoặc Ảnh vào danh sách ghép.',
      'Click "Add Files..." to add PDFs or images to the merge list.',
    ],
  },
  'misc.savePrintFiles': {
    de_tach_file_be_rieng_bat_tach_trang: [
      'Để tách file bế riêng, bật "Tách trang khuôn bế" ở thiết lập bình bài trước khi chạy.',
      'To split the die file separately, enable "Separate die pages" in imposition settings before running.',
    ],
  },
  'imposition.presetSelector': {
    bam_luu_thiet_lap_hien_tai_de_tao_moi: [
      'Bấm "Lưu thiết lập hiện tại" để tạo mới',
      'Click "Save current settings" to create a new one',
    ],
  },
  'preprocess.stickTextNumber': {
    meo_go_trang_page_total: [
      'Mẹo: gõ "Trang [page]/[total]" để ra "Trang 1/20". Kiểu La Mã/chữ cái bỏ qua "Độ dài số".',
      'Tip: type "Page [page]/[total]" to get "Page 1/20". Roman/letter styles ignore "Number length".',
    ],
  },
  'preprocess.dataMerge': {
    bo_chon_neu_file_khong_co_dong_tieu_de: [
      'Bỏ chọn nếu file không có dòng tiêu đề — cột sẽ tự đặt tên "Cột 1", "Cột 2"…',
      'Uncheck if the file has no header row — columns will be auto-named "Column 1", "Column 2"…',
    ],
    ten_cot_trong_nhu_du_lieu_file_co_the: [
      'Tên cột trông như dữ liệu? File có thể KHÔNG có dòng tiêu đề — hãy bỏ chọn "Hàng đầu là tiêu đề cột" ở trên.',
      'Column names look like data? The file may NOT have a header row — uncheck "First row is column header" above.',
    ],
    b4_bam_chen: [
      '4. Bấm "Chèn"',
      '4. Click "Insert"',
    ],
  },
  'imposition.advancedSettings': {
    chia_coc_xen_title: ['Chia cọc xén', 'Guillotine batching'],
    tu_dong_tach_to_in_thanh_cac_coc_rieng: [
      'Tự động tách tờ in thành các cọc riêng biệt, chừa sẵn rãnh dao giữa các cọc để máy xén chém an toàn mà không phạm vào thiết kế.',
      'Automatically split the sheet into separate stacks, leaving knife gutters between stacks so the guillotine can cut safely without touching the design.',
    ],
  },
  'imposition.gridSettings': {
    xep_chong_chua_ho_tro_2_mat_chon: [
      '⚠️ «Xếp chồng» chưa hỗ trợ 2 mặt — chọn',
      '⚠️ "Stacking" does not support double-sided yet — choose',
    ],
    hoac_doi_sang: [', hoặc đổi sang', ', or switch to'],
    chia_ty_le: ['Chia tỷ lệ', 'Ratio split'],
  },
  'preprocess.sticker': {
    ra_vung_bu_xen_vd_chu_n_m: [
      'ra vùng bù xén (vd chữ "n" → "m"). Nếu xén lệch vào trim, phần soi gương có thể lộ ra gây',
      'into the bleed area (e.g. "n" → "m"). If the trim shifts inward, the mirrored part may show, causing',
    ],
    keo_gian_mep_anh_quoted: ['"Kéo giãn mép ảnh"', '"Stretch image edge"'],
  },
};

let filled = 0;
for (const [ns, dict] of Object.entries(ADD)) {
  if (!vi[ns]) { console.log('NS MISSING in vi', ns); continue; }
  if (!en[ns]) { console.log('NS MISSING in en', ns); continue; }
  for (const [k, [v, e]] of Object.entries(dict)) {
    vi[ns][k] = v;
    en[ns][k] = e;
    filled++;
  }
}
fs.writeFileSync(VI, JSON.stringify(vi, null, 2) + '\n', 'utf8');
fs.writeFileSync(EN, JSON.stringify(en, null, 2) + '\n', 'utf8');
console.log('ADDED', filled, 'keys to vi+en');
