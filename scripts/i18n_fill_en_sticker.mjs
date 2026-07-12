import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(process.cwd());
const EN = path.join(ROOT, 'desktop/src/i18n/locales/en.json');
const en = JSON.parse(fs.readFileSync(EN, 'utf8'));

const T = {
  'preprocess.sticker': {
    '1_duong_cat_dieline': '1. Cut line (Dieline)',
    '2_tran_le_dac_ruot': '2. Bleed & Solid fill',
    be_tem_nhan: 'DIE-CUT LABELS',
    binh_bai_be_tem: 'Die-cut label imposition',
    binh_bai_xen_n_up: 'Guillotine imposition (N-Up)',
    binh_sach_tap_chi: 'Book & Magazine imposition',
    bo_nen_trang: '✅ Remove white background',
    bo_nen_trang_2: 'Remove white background',
    bo_qua_cac_lo_rong_ben_trong_khoi_hinh: 'Ignore inner holes within the shape. The cutter only cuts the outermost contour.',
    bo_vien_nen_bang_he_mau_in_an_chuyen: 'Extend the background border using a professional print color space (CMYK).',
    buoc_tiep_theo_chon_kieu_dan_trang: 'Next step: Choose an imposition layout',
    cat_bam_theo_vien_anh_hoac_vector: 'Cut along the image or vector contour.',
    cat_bao_luon_phan_le_bu_xen_neu_co: 'Also cut around the bleed margin (if any).',
    chi_do_vien_cua_chi_tiet_bo_qua_mang: 'Trace only the detail contour, skipping the white background area.',
    chi_hop_mep_anh_chup_gradient_mem_khong: 'ONLY suits photo edges / soft gradients. NOT for flat color bands (logos, text labels) — they will bleed and lose sharpness. For flat color bands, choose "Sample sticker border color".',
    chi_hop_mep_anh_chup_gradient_mem_khong_2: 'ONLY suits photo edges / soft gradients. NOT for flat color bands (banners, cards, color blocks) — they will bleed and become indistinguishable. For flat color bands, choose "Stretch image edge".',
    chi_mo_nen_tran_mau: 'Extend background only (color bleed).',
    chi_nen_dung_cho_nen_truu_tuong_hoa_van: '. Only recommended for abstract/patterned backgrounds. For images with text/details, choose',
    co_gian_vien: 'Shrink/Grow border',
    da_tao_bu_xen_thanh_cong: 'Bleed created successfully!',
    da_xay_ra_loi_khong_xac_dinh: 'An unknown error occurred.',
    dac_ruot: '✅ Solid fill',
    dac_ruot_2: 'Solid fill',
    dang_xu_ly: '⏳ Processing...',
    do_day_bleed: 'Bleed width',
    do_lem_mep: 'Edge inset',
    do_mau_tron: '🎨 Solid color fill',
    doa_vien_trang_manh: 'trim thin white borders',
    file_nhieu_loai_tem_dung_chung_1_khuon: 'File with multiple sticker types SHARING 1 die: only the first page draws the cut line (as the master die), later pages get bleed only. Send to Die-cut / CNC imposition to impose multiple types on the same die.',
    goc_nhon: '🔺 Sharp corner',
    goc_tron: '🟢 Rounded corner',
    keo_gian_mep_anh: '🖼️ Stretch image edge',
    keo_gian_mep_anh_2: 'Stretch image edge',
    khau_chi_long_doi_bu_gay: 'Thread sewing, nesting, creep compensation',
    khi_file_khong_tran_le_dat: 'when the file has no bleed. Set',
    khong_ve_duong_cat: '🚫 No cut line',
    lam_muot_thong_minh: '✨ Smart smoothing',
    lat_guong: 'Mirror',
    lat_guong_tu_dong: '🪞 Auto mirror',
    lat_nguoc_mep_anh_sieu_toc_giu_nguyen: 'Flip the image edge outward, ultra-fast. Keeps 100% of the original sharpness.',
    lay_theo_mau_vien_tem: '🖼️ Sample sticker border color',
    lem_nhe_vao_trong_de: 'Slight inset to',
    loi_server_response_status: 'Server error (${response.status})',
    loi_tao_bu_xen_vector: 'Error creating vector bleed',
    loi_xoa_le_trang: 'Error removing white margin',
    mau_nen_bu_xen: 'Bleed background color',
    n_up_nhan_ban_s_r: 'N-Up, Step & Repeat',
    neu_co_chu_chi_tiet_sat_mep: 'if there is text/detail near the edge.',
    nhieu_loai_tem_chung_khuon_chi_trang: 'Multiple sticker types SHARING a die: only the first page has the cut line (master die), later pages get bleed only → send to Die-cut / CNC imposition.',
    quay_lai_chinh_sua_bu_xen: 'Back to editing bleed',
    sai_noi_dung: 'wrong content',
    so_am_vd_0_5_ep_duong_cat_lun_vao_trong: 'A negative value (e.g. -0.5) pushes the cut line inward, avoiding exposed white borders.',
    soi_nguoc_noi_dung_sat_mep: 'mirror content near the edge',
    tao_duong_cat_cho_trang_dau: '✅ Create cut line for the first page',
    tao_duong_cat_cho_trang_dau_2: 'Create cut line for the first page',
    theo_hinh_goc: '✂️ Follow original shape',
    theo_mep_tran_le: '🩸 Follow bleed edge',
    tran_mau: 'Color bleed',
    tu_dong_bu_xen_hinh_vuong: '🔲 Auto square bleed',
    tu_dong_bu_xen_tao_vien_cat: '✂️ Auto bleed & create cut contour',
    tu_dong_keo_gian_dai_mau_sat_mep_anh_ra: 'Automatically stretch the color band near the image edge outward into the margin.',
    tu_dong_keo_gian_dai_mau_sat_mep_tem_ra: 'Automatically stretch the color band near the sticker edge outward to fill the cut area.',
    tu_dong_thu_gon_cac_khoang_trang_vo: 'Automatically trim useless whitespace around the shape before adding bleed. Preserves the original vector quality of the file.',
    xen_vuong_goc: 'RIGHT-ANGLE CUT',
    xep_tem_be_to_ong: 'Die-cut sticker / honeycomb nesting',
    xoa_le_trang_bu_xen: 'Remove white margin & Bleed',
    xoa_le_trang_thua: '✅ Remove excess white margin',
    xoa_le_trang_thua_2: 'Remove excess white margin',
  },
};

let filled = 0, miss = 0;
for (const [ns, dict] of Object.entries(T)) {
  if (!en[ns]) { console.log('NS MISSING', ns); continue; }
  const viKeys = Object.keys(en[ns]);
  for (const k of viKeys) {
    if (dict[k] !== undefined) { en[ns][k] = dict[k]; filled++; }
    else { miss++; console.log('  MISS key', ns, k); }
  }
  for (const k of Object.keys(dict)) if (!(k in en[ns])) console.log('  EXTRA', ns, k);
}
fs.writeFileSync(EN, JSON.stringify(en, null, 2) + '\n', 'utf8');
console.log(`\nDIEN ${filled}; thieu ${miss}.`);
