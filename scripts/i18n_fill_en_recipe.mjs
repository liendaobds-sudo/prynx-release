import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(process.cwd());
const EN = path.join(ROOT, 'desktop/src/i18n/locales/en.json');
const en = JSON.parse(fs.readFileSync(EN, 'utf8'));

const T = {
  'recipe.recipe': {
    an_mep_mm: 'Edge bite (mm)',
    bam: 'Click',
    bat_phat_lai_buoc_nay: 'Enable replay for this step',
    bo_nen_trang: 'Remove white background',
    bo_qua: 'skip',
    bu_xen_mm: 'Bleed (mm)',
    buoc_nay_khong_co_tham_so: 'This step has no parameters.',
    cac_phep_chuyen_mau: 'Color conversions',
    cach_chia_luoi: 'Grid split method',
    cach_doc_mm: 'Vertical spacing (mm)',
    cach_ngang_mm: 'Horizontal spacing (mm)',
    can_chinh: 'Alignment',
    cao_dich_mm: 'Target height (mm)',
    cao_to_in_mm: 'Sheet height (mm)',
    che_do: 'Mode',
    che_do_binh: 'Imposition mode',
    chua_co_quy_trinh_nao: 'No recipes yet.',
    chuan_pdf_x: 'PDF/X standard',
    chuyen_den_trang: 'Convert to grayscale',
    da_nhap_quy_trinh_imported_name: 'Imported recipe "${imported.name}".',
    da_xoa_quy_trinh: 'Recipe deleted.',
    dang_chay: 'Running...',
    dang_tai: 'Loading...',
    doi_mep_mm: 'Edge shift (mm)',
    dong: 'Close',
    dpi_anh: 'Image DPI',
    file_quy_trinh_khong_hop_le: 'Invalid recipe file.',
    ghi_quy_trinh: 'Record recipe',
    giu_den_thuan: 'Keep pure black',
    hay_mo_mot_file_pdf_truoc_khi_phat_lai: 'Open a PDF file before replaying.',
    ho_so_mau_icc: 'ICC color profile',
    json_khong_hop_le_sua_lai: 'Invalid JSON — please fix',
    khop_so_trang_file_dang_mo: 'Match page count of open file',
    kieu_co_gian: 'Scaling type',
    kieu_dan_trang: 'Imposition type',
    kieu_duong_cat: 'Cut line style',
    kieu_goc: 'Corner style',
    kieu_mau_bu_xen: 'Bleed color type',
    lap_lo_thung: 'Fill holes',
    le_duoi_mm: 'Bottom margin (mm)',
    le_phai_mm: 'Right margin (mm)',
    le_trai_mm: 'Left margin (mm)',
    le_tren_mm: 'Top margin (mm)',
    len: 'Up',
    loai_san_pham: 'Product type',
    luu_ten: 'Save name',
    luu_thay_doi_that_bai: 'Failed to save changes.',
    ma_thiet_lap: 'Preset code',
    mau_bu_xen: 'Bleed color',
    nhap_quy_trinh_tu_file: 'Import recipe from file',
    phat_lai: 'Replay',
    phat_lai_quy_trinh_tren_file_dang_mo: 'Replay recipe on the open file',
    phu_hop: 'suitable',
    quy_trinh_da_luu: 'Saved recipes',
    rong_dich_mm: 'Target width (mm)',
    rong_to_in_mm: 'Sheet width (mm)',
    so_cot: 'Columns',
    so_hang: 'Rows',
    so_luong_can_in: 'Quantity to print',
    sua_ten: 'Rename',
    sua_tham_so_nang_cao_nhap_sai_co_the: 'Edit advanced parameters — incorrect values may cause the replay step to fail.',
    tat_phat_lai_buoc_nay: 'Disable replay for this step',
    ten_mau_spot: 'Spot color name',
    thao_tac_dac_biet: 'Special operations',
    thiet_lap_san: 'Preset',
    thu_gon: 'Collapse',
    tren_thanh_cong_cu_de_tao: 'on the toolbar to create.',
    xem_sua_tham_so: 'View / edit parameters',
    xen_le_trang: 'Trim white margins',
    xoa: 'Delete',
    xoa_buoc: 'Delete step',
    xoa_metadata: 'Remove metadata',
    xoa_quy_trinh_r_name: 'Delete recipe "${r.name}"?',
    xuat_file: 'Export file',
    xuong: 'Down',
    y_do_tai_tao_mau: 'Rendering intent',
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
