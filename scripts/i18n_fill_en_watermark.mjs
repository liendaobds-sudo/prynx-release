import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(process.cwd());
const EN = path.join(ROOT, 'desktop/src/i18n/locales/en.json');
const en = JSON.parse(fs.readFileSync(EN, 'utf8'));

const T = {
  'preprocess.watermark': {
    '1_chi_trang_le': '1️⃣ Odd pages only',
    '2_chi_trang_chan': '2️⃣ Even pages only',
    ap_dung_cho_trang: 'Apply to pages',
    ap_dung_thay_doi: '©️ Apply Changes',
    bates_bat_dau: 'Bates start',
    canh_duoi: '⬇️ Bottom edge',
    canh_phai: '➡️ Right edge',
    canh_trai: '⬅️ Left edge',
    canh_tren: '⬆️ Top edge',
    che_do_scale: 'Scale mode',
    chen_hinh_nen_file_pdf_anh_ben_duoi: 'Insert a background (PDF/image) beneath the page, or stamp text/logo over the PDF page.\n                        Processed entirely in the browser — 100% secure.',
    chen_nen_dong_dau_background_watermark: 'Insert Background & Stamp (Background/Watermark)',
    chen_thanh_cong: 'Inserted successfully!',
    chinh_giua: '↔️ Center',
    chinh_giua_2: '↕️ Center',
    chu_text: '📝 Text',
    co_chu: 'Font size',
    da_xay_ra_loi_khong_xac_dinh: 'An unknown error occurred.',
    dang_dong_dau_ban_quyen: 'Stamping copyright...',
    dang_xu_ly: '⏳ Processing...',
    de_len_tren: '⬆️ Overlay on top',
    den: 'To',
    dich_chuyen_doc: 'Vertical offset',
    dich_chuyen_ngang: 'Horizontal offset',
    do_dai_so_padding: 'Number length (Padding)',
    do_mo_opacity: 'Opacity',
    file_pdf_da_duoc_xu_ly_hoan_tat: 'The PDF file has been fully processed.',
    gio: '+ Time',
    goc_toa_do_doc: 'Vertical origin',
    goc_toa_do_ngang: 'Horizontal origin',
    goc_xoay: 'Rotation angle',
    hinh_anh_phoi_pdf: '🖼️ Image / PDF template',
    khoang_cach_giua_cac_mat_luoi: 'Spacing between grid cells',
    khoang_tu_chon: '🔢 Custom range...',
    lap_kin_trang_canvas_wrap: 'Tile the page (Canvas Wrap)',
    lap_lai_noi_dung_phu_kin_toan_bo_be_mat: 'Repeat the content to cover the entire PDF page surface as a diagonal grid.',
    lop_hien_thi_z_index: 'Display layer (Z-Index)',
    lot_duoi_cung: '⬇️ Send to bottom',
    ma_bates: '+ Bates number',
    mau_chu: 'Text color',
    ngay: '+ Date',
    noi_dung_van_ban: 'Text content',
    phu_kin_trang_ep_meo: '🪟 Cover page (Stretch)',
    so_trang: '+ Page number',
    tai_len_file_nen_pdf_png_jpg: 'Upload background file (PDF/PNG/JPG)',
    tat_ca_trang: '📄 All pages',
    tong_so: '+ Total count',
    tu: 'From',
    tuyet_doi: '📐 Absolute (%)',
    ty_le_kich_thuoc: 'Size scale',
    vd_ban_nhap_khong_in: 'e.g. DRAFT - DO NOT PRINT',
    vua_khit_trang_giu_ty_le: '🖼️ Fit page (Keep ratio)',
    xu_ly_mot_file_khac: 'Process another file',
  },
};

let filled = 0, miss = 0;
for (const [ns, dict] of Object.entries(T)) {
  if (!en[ns]) { console.log('NS MISSING', ns); continue; }
  for (const k of Object.keys(en[ns])) {
    if (dict[k] !== undefined) { en[ns][k] = dict[k]; filled++; }
    else { miss++; console.log('  MISS key', ns, k); }
  }
  for (const k of Object.keys(dict)) if (!(k in en[ns])) console.log('  EXTRA', ns, k);
}
fs.writeFileSync(EN, JSON.stringify(en, null, 2) + '\n', 'utf8');
console.log(`\nDIEN ${filled}; thieu ${miss}.`);
