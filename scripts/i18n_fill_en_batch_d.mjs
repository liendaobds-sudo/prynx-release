import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(process.cwd());
const EN = path.join(ROOT, 'desktop/src/i18n/locales/en.json');
const en = JSON.parse(fs.readFileSync(EN, 'utf8'));

const T = {
  'dieline.environmentRig': {
    khong_nap_duoc_moi_truong_hdri_da: '⚠ Could not load HDRI environment — switched to default studio lighting.',
    studio_am: 'Warm studio',
    studio_mem: 'Soft studio',
    studio_trung_tinh_lanh: 'Cool neutral studio',
    studio_tuong_phan: 'High-contrast studio',
  },
  'lib.maskValidation': {
    be_mat_ap_dung_surface_width_surface: 'applied surface (${surface.width}×${surface.height}).',
    dinh_dang_mat_na_khong_hop_le_mask: 'Invalid mask format: "${mask.format}". Only PNG, JPEG or WebP are accepted.',
    kich_thuoc_mat_na_hoac_be_mat_khong_hop: 'Invalid mask or surface dimensions (must be finite positive numbers).',
    kich_thuoc_mat_na_mask_width_mask: 'Mask dimensions (${mask.width}×${mask.height}) do not match',
    mat_na_khong_ton_tai_null: 'Mask does not exist (null).',
  },
  'lib.matchboxSleeve': {
    hong_1_vo: 'Side 1 (sleeve)',
    hong_2_vo: 'Side 2 (sleeve)',
    mat_sau_vo: 'Back (sleeve)',
    mat_truoc_vo: 'Front (sleeve)',
    mi_dan_keo_vo: 'Glue flap (sleeve)',
  },
  'lib.nupRenderer': {
    dang_phan_tich_cau_truc_ma_tran_jobname: 'Analyzing matrix structure of ${jobName}...',
    dang_xuat_mam_in_to_s_1_sheetstorender: 'Exporting print sheet ${s + 1}/${sheetsToRender.length}...',
    kho_giay_hoac_cum_chia_qua_nho_so_luong: 'Paper size or cluster spacing too small. Computed quantity <= 0. Please recheck paper size, margins, or cluster spacing.',
    khoi_tao_luoi_jobname_cols_cot_x_rows: "Initializing grid ${jobName} (${cols} cols x ${rows} rows) - Mode: ${layoutType === 'cut_stacks' ? 'Cut & stack' : (layoutType === 'repeat' ? 'Step & repeat' : 'Sequential')}...",
    nhan_ban: 'Step & repeat',
  },
  'lib.pdfMerger': {
    dai_trang_chen_khong_hop_le_hoac_file: 'Insert page range is invalid or the file is empty.',
    khong_tim_thay_file_pdf_chinh_dang_mo: 'Could not find the main open PDF file.',
    vui_long_chon_du_2_file_nguon: 'Please select both source files.',
    vui_long_chon_file_chua_trang_can_chen: 'Please select the file containing the pages to insert.',
    vui_long_chon_it_nhat_1_file_de_ghep: 'Please select at least 1 file to merge.',
  },
  'lib.reportPreview': {
    data_gangcount_mau: '${data.gangCount} designs',
    lamination_lamsides_mat: '${lamination} ${lamSides} side(s)',
    sl_thuc_actualqty: 'Actual qty: ${actualQty}',
    sl_to_ips: 'Qty/sheet: ${ips}',
    so_to_sheetcount: 'Sheets: ${sheetCount}',
  },
  'lib.stampFormat': {
    chu_hoa_a_b: 'Uppercase (A, B)',
    chu_thuong_a_b: 'Lowercase (a, b)',
    la_ma_hoa_i_ii: 'Uppercase Roman (I, II)',
    la_ma_thuong_i_ii: 'Lowercase Roman (i, ii)',
    so_1_2_3: 'Numbers (1, 2, 3)',
  },
  'misc.updateChecker': {
    cap_nhat_khoi_dong_lai: 'Update & restart',
    cap_nhat_that_bai_thu_lai_sau_hoac_tai: 'Update failed. Try again later or download the new build manually.',
    da_tai_xong_dang_khoi_dong_lai: 'Download complete, restarting...',
    de_sau: 'Later',
    dong: 'Close',
  },
  'misc.viewerContextMenu': {
    chen_trang_trang_insert: 'Insert blank page (Insert)',
    nhan_ban_duplicate: 'Duplicate',
    quan_ly_trang_xoay_nhan_ban: 'Manage Pages (Rotate, Duplicate...)',
    trich_xuat_trang: 'Extract pages',
    xoa_trang_nhanh: 'Quick delete page',
  },
  'preprocess.setPageBoxesUtils': {
    gia_tri_nhap_khong_phai_so_hop_le: 'Input value is not a valid number',
    trang_bat_dau_phai_trang_ket_thuc: 'Start page must be ≤ end page',
    trang_hop_le_1_total: 'Valid pages: 1–${total}',
    x1_phai_lon_hon_x0: 'x1 must be greater than x0',
    y1_phai_lon_hon_y0: 'y1 must be greater than y0',
  },
  'dieline.shadowFloor': {
    nen_am: 'Warm Background',
    studio_toi: 'Dark Studio',
    studio_trang: 'White Studio',
    xam_trung_tinh: 'Neutral Gray',
  },
  'imposition.outputSettings': {
    duong_cat: 'CUT LINE',
    kc_cum_phu: 'FILLER CLUSTER GAP',
    khoang_cach_giua_cum_chinh_va_cum_phu: 'Distance between the main cluster and the filler cluster.&#10;Only applies when using Optimal packing + Single-blade die.&#10;Set > 0 so the single-blade die line has safe overhang room,&#10;without cutting into another cluster’s labels.',
    mac_dinh: 'Default',
  },
  'imposition.sharedUI': {
    bo_khoi_yeu_thich: 'Remove from Favorites',
    gioi_thieu_cong_cu: 'About this tool',
    sap_ra_mat: '(coming soon)',
    them_vao_yeu_thich: 'Add to Favorites',
  },
  'lib.sharedGeometry': {
    dielinemodel_khong_hop_le_chuoi_cat: 'Invalid DielineModel: cut path is not closed',
    dielinemodel_khong_hop_le_segment_tag: 'Invalid DielineModel: segment (tag=${seg.tag}) is missing points',
    dielinemodel_khong_hop_le_thieu_segment: 'Invalid DielineModel: missing segment (allPaths empty or nonexistent)',
    khoang_ho_gap_tofixed_4_mm_snap: '(gap ${gap.toFixed(4)}mm > ${SNAP_TOLERANCE}mm)',
  },
  'misc.barcodeWorker': {
    dang_nen_zip: 'Compressing ZIP...',
    dang_tao_hinh: 'Generating images...',
    du_lieu_khong_hop_le: 'Invalid data',
    nen_zip_meta_percent_tofixed_0: 'Compressing ZIP ${meta.percent.toFixed(0)}%',
  },
  'misc.progressTracker': {
    chuan_bi: 'Preparing...',
    co_loi_xay_ra: 'An error occurred',
    dang_so_sanh: 'Comparing...',
    hoan_thanh: 'Done!',
  },
  'misc.qrLogos': {
    dien_thoai: 'Phone',
    mang_xa_hoi: 'Social media',
    nen_tang: 'Platform',
    tien_ich: 'Utilities',
  },
  'misc.trialExpiryBanner': {
    con_remainingdays_ngay: '${remainingDays} days left',
    de_sau: 'Later',
    gia_han_ngay: 'Renew now',
    hom_nay: 'today',
  },
  'imposition.api': {
    khong_tai_duoc_danh_sach_may_be_res: 'Could not load cutter list (${res.status})',
    loi_may_chu_res_status: 'Server error (${res.status})',
    loi_may_chu_res_status_text: 'Server error (${res.status}): ${text}',
  },
  'imposition.toolMenuList': {
    cong_cu_yeu_thich: '⭐ FAVORITE TOOLS',
    tim_cong_cu: 'Search tools...',
    xoa_tim_kiem: 'Clear search',
  },
  'lib.cupSleeve': {
    khuon_boc_ly_giay_hinh_quat_cung: 'Paper cup sleeve die — Fan/arc shape',
    mi_dan_keo: 'Glue flap',
    than_boc_ly: 'Sleeve body',
  },
  'lib.exportSizing': {
    kich_thuoc_khung_xem_khong_hop_le_phai: 'Invalid viewport dimensions (must be finite positive numbers).',
    kich_thuoc_xuat_width_height_px_vuot: 'Export size (${width}×${height} px) exceeds the limit',
    max_export_px_px_o_chieu_rong_hoac: '${MAX_EXPORT_PX} px in width or height.',
  },
  'lib.spreadPlacer': {
    bia: 'Cover',
    kem_platecount_baselabel_tu_tro: 'Plate ${plateCount} - ${baseLabel} - Work & Turn',
    kem_platecount_tay_sig_1_plateside: "Plate ${plateCount} - Signature ${sig + 1}${plateSide === 'front' ? 'A' : 'B'} (${plateSide === 'front' ? 'Front' : 'Back'}) - Sheetwise A-B",
  },
  'lib.virtualMap': {
    bao_cao_chia_tep_tong_cong_details: 'Signature split report: Total ${details}.',
    he_thong_da_tu_dong_gop_4_trang_du_cuoi: '(The system automatically merged the last 4 leftover pages into the preceding signature to avoid thread tearing when clamped on the sewing machine).',
    sigcounts_number_size_tep_size_trang: '${sigCounts[Number(size)]} signatures of ${size} pages',
  },
  'misc.errorBoundary': {
    da_xay_ra_loi: 'An error occurred',
    tai_lai: 'Reload',
    ung_dung_gap_su_co_ngoai_y_muon_vui: 'The app hit an unexpected error. Please reload to continue.',
  },
  'misc.flipbookDialog': {
    dang_nap_du_lieu: 'Loading data...',
    dong_esc: 'Close (ESC)',
    trang_logical1based_tep_signatureindex: 'Page ${logical1Based} | Signature ${signatureIndex}',
  },
  'misc.qrWorker': {
    dang_nen_zip: 'Compressing ZIP...',
    dang_tao_hinh: 'Generating images...',
    nen_zip_meta_percent_tofixed_0: 'Compressing ZIP ${meta.percent.toFixed(0)}%',
  },
  'misc.systemIntegrations': {
    get_file_size_loi_van_mo_size_0: 'get_file_size error (still opening, size=0):',
    khong_the_doc_file: 'Could not read file:',
    nloi: '\\nError:',
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
