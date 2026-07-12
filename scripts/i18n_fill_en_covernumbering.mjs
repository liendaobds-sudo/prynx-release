import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(process.cwd());
const EN = path.join(ROOT, 'desktop/src/i18n/locales/en.json');
const en = JSON.parse(fs.readFileSync(EN, 'utf8'));

const T = {
  'preprocess.coverNumbering': {
    '1_cau_hinh_bia': '1. Cover configuration',
    '2_keo_truong_vao_mau_bia': '2. Drag fields onto the cover template',
    '3_nguon_trang_bia': '3. Cover page source',
    bia_ruot_nam_chung_1_file_gan_trang_bia: 'Cover & inner pages in the same file — assign cover page',
    cat_chong: 'Cut & stack',
    cau_hinh_chua_hop_le_xem_canh_bao: 'Configuration is not valid — see the warning.',
    che_do_chay: 'Run mode',
    chua_chon_trang_bia_hop_le: 'No valid cover page selected.',
    chua_co_file_pdf_goc: 'No source PDF yet.',
    chua_co_truong_x_y_z_nao_hay_keo_cac: 'No {X}/{Y}/{Z} fields yet. Drag the chips from section 2 onto the cover.',
    cuon_1_first_y_first_z_cuon_v: 'Booklet 1: ${first.Y}–${first.Z} · Booklet ${v.bookletCount}: ${last.Y}–${last.Z}.',
    dai_so_hoac_so_cuon_khong_hop_le: '⚠️ Number range or booklet count is not valid.',
    dai_so_qua_lon_vuot_gioi_han_an_toan: '⚠️ Number range too large (exceeds the safety limit).',
    dai_trang_bia_khong_hop_le_nhap_so: 'Cover page range is not valid. Enter the cover page number (e.g. 1 or 1-2).',
    dang_day_len_may_chu_csvdata_length_to: 'Uploading to server (${csvData.length} sheets)...',
    dang_tinh_ke_hoach_danh_so_bia: 'Computing the cover numbering plan...',
    dang_trich_trang_bia_khoi_file: 'Extracting cover page from the file...',
    dang_xu_ly: 'Processing...',
    derived_totalnumbers_so_khong_chia_het: '⚠️ ${derived.totalNumbers} numbers are not divisible by ${v.bookletCount} booklets.',
    derived_totalnumbers_so_v_bookletcount: '✅ ${derived.totalNumbers} numbers ÷ ${v.bookletCount} booklets = ${derived.perBooklet} sets/booklet.',
    dung_chung_dai_so_voi_mec_so_ruot_hai: 'Share the number range with the inner numbering series — the two tabs always match.',
    file_co_totalpages_trang: 'The file has ${totalPages} pages.',
    goi_y_dung_derived_suggestion_cuon_chia: 'Suggestion: use ${derived.suggestion} booklets (divides evenly).',
    hay_keo_it_nhat_1_cum_bia_x_y_z_vao_pdf: 'Drag at least 1 cover group ({X}/{Y}/{Z}) onto the PDF.',
    hoan_thanh: 'Done!',
    hoan_thanh_da_tao_tab_moi: 'Done! A new tab has been created.',
    keo_3_truong_vao_moi_o_bia_roi_group: 'Drag 3 fields into each cover cell, then Group them into one group.',
    khong_nhan_duoc_file_ket_qua: 'No result file received.',
    kieu_danh_ruot: 'Inner numbering style',
    kieu_xep: 'Stacking style',
    lien_ket_mec_so: '🔗 Link numbering series',
    lien_tuc: 'Continuous',
    loi: 'Error:',
    mec_bia_chay_so_bia: 'COVER NUMBERING (RUN COVER NUMBERS)',
    mo_ket_qua_o_tab_moi: 'Open result in a new tab',
    quay_lai: 'Back',
    ran_bo_u: 'Snake / U-shape (U)',
    reset_moi_cuon: 'Reset each booklet',
    se_dung_coverpageidx_length_trang_bia: 'Will use ${coverPageIdx.length} cover pages: ${coverPageIdx.map(i => i + 1).join(\', \')}. The remaining pages are inner pages (use the numbering series).',
    tao_bia_derived_valid_v_bookletcount_0: 'Create covers (${derived.valid ? v.bookletCount : 0} booklets)',
    theo_canh_c_nguoc: 'By edge (C reversed)',
    theo_cot_n_nguoc: 'By column (N reversed)',
    theo_hang_z: 'By row (Z)',
    tuan_tu: 'Sequential',
    vd_1_hoac_1_2: 'e.g. 1 or 1-2',
    x_so_cuon: '{X} Booklet number',
    xoa: 'Delete',
    y_ruot_dau: '{Y} First inner number',
    z_ruot_cuoi: '{Z} Last inner number',
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
