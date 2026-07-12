import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(process.cwd());
const EN = path.join(ROOT, 'desktop/src/i18n/locales/en.json');
const en = JSON.parse(fs.readFileSync(EN, 'utf8'));

const T = {
  'dieline.dieline': {
    ban_ve_2d: '2D drawing',
    chia_doi: 'Split view',
    dang_tai_mo_phong_3d: 'Loading 3D preview...',
    loi_hien_thi_3d: '3D rendering error',
    mo_phong_3d: '3D preview',
    pdf_xep_khuon: '⬇ Nesting PDF',
    thu_lai: 'Retry',
    xem_dong_thoi_ban_ve_2d_va_mo_phong_3d: 'View 2D drawing and 3D preview side by side',
    xep_khuon: 'Nesting',
    xuat_pdf_binh_ban_xep_khuon: 'Export nesting layout PDF',
  },
  'imposition.gridPreview': {
    chua_co_du_lieu_bo_cuc: 'No layout data yet',
    dang_nhan_dien_hinh_dang_tem: '🔍 Detecting sticker shape...',
    dang_tinh_toan_bo_cuc: 'Computing layout...',
    gridpreview_ratio_stack_backend_uniq: '[GridPreview] ratio_stack backend ${uniq.size} types > viewer ${viewerPageCount} — reassigning client-side',
    mat_sau: 'BACK',
    mat_truoc: 'FRONT',
    phong_to: '⊕ Zoom in',
    phong_to_xem_chi_tiet: 'Zoom in for detail',
    thu_gon: 'Collapse',
    thu_gon_2: '⊖ Collapse',
  },
  'imposition.nupSettings': {
    '1_mat': '1 Side',
    '1_mat_trang_1_2_3_lien_tiep_theo_sl_2': '1 side: pages 1,2,3… sequentially by quantity. 2 sides: each product = a front/back page pair in the same cell; odd sheets mirror-flip to align the back (even page count).',
    '2_mat': '2 Sides',
    cach_thuc_rap_thanh_pham: 'FINISHING / ASSEMBLY METHOD',
    chia_ty_le_xep_chong: 'Ratio split + stacking',
    cut_stack_collation_1_mat_xen_coc_roi: 'Cut-stack collation (1 side). Cut the stacks then place them in page order. Not for 2-sided.',
    nhieu_mau_cung_co_sl_khac_nhau_moi_to: 'Multiple designs of the same size, different quantities; every sheet is identical. 1 side: one master sheet. 2 sides: each design = front/back page pair (quantity by odd pages 1,3,5…), even page count.',
    so_mat: 'SIDES',
    xep_chong: 'Stacking',
    xep_lan_luot: 'Sequential',
  },
  'misc.acrobatViewer': {
    // acro_scroll_webkit_scrollbar_width_14px: CSS fragment — bo qua (khong dich)
    chua_co_file_de_cat_kho: 'No file to crop',
    chua_co_file_de_xuat_anh: 'No file to export images.',
    dang_sao_chep_trang: 'Copying pages...',
    dang_tai_file_pdf: 'Loading PDF file...',
    khong_chuan_bi_duoc_file_de_xuat_anh: 'Could not prepare file for image export:',
    loi_tai_pdf: 'PDF load error',
    tai_lai_trang: 'Reload page',
    xuat_anh: 'Export images',
    xuat_anh_png_jpeg_tiff: 'Export images (PNG/JPEG/TIFF)',
  },
  'lib.paperBag': {
    day_mi_dan: 'Bottom glue flap',
    day_p_label: 'Bottom ${p.label}',
    hong_1: 'Side 1',
    hong_2: 'Side 2',
    mat_sau: 'Back',
    mat_truoc: 'Front',
    mi_dan: 'Glue flap',
    mi_mieng_p_label: 'Top flap ${p.label}',
    tui_giay_sos_cua_hang_f_b_qua_tang: 'SOS paper bag — Retail, F&B, Gifts',
  },
  'lib.vdpTemplate': {
    chua_co_truong_vdp_nao_de_luu_mau: 'No VDP fields to save as a template.',
    da_luu_mau_path_split_pop: 'Template saved: ${path.split(/[\\\\/]/).pop()}',
    da_tai_mau_remapped_length_truong: 'Template loaded: ${remapped.length} fields.',
    da_tai_mau_xuong: 'Template downloaded.',
    file_mau_khong_hop_le_hoac_rong: 'Template file is invalid or empty.',
    loi_luu_mau: 'Error saving template:',
    loi_tai_mau: 'Error loading template:',
    luu_mau_bo_cuc_vdp: 'Save VDP layout template',
    tai_mau_bo_cuc_vdp: 'Load VDP layout template',
  },
  'dieline.dielineScene3D': {
    chay_hoat_anh_gap: 'Play fold animation',
    dung: 'Stop',
    gap: '⟰ Fold',
    gap_hoan_tat_100: 'Fold complete (100%)',
    nhap_gap_chinh_xac: 'Enter exact fold %',
    nhap_thong_so_de_xem_mo_phong_3d: 'Enter parameters to see the 3D preview',
    trai: '⟱ Unfold',
    trai_phang_0: 'Flat (0%)',
  },
  'lib.sheetOptimizer': {
    kem_con_du_nhieu_recommended_gapwidthmm: '💡 Plate has a lot of spare room (${recommended.gapWidthMm}mm across). You could reduce the paper size to save material.',
    kho_kem_chi_vua_tay_4_co_the_toi_uu_hon: '⚠ Plate size only fits a 4-page signature — could optimize further with a larger sheet.',
    kho_kem_sheet_width_sheet_height_mm_qua: '⚠ Plate size ${sheet.width}×${sheet.height}mm is too small for a ${pageMm.w}×${pageMm.h}mm page! Does not fit even a 4-page signature.',
    sat_le: '(edge-tight)',
    sat_le_2: 'edge-tight',
    tay_4_trang_1_bo: '4-page signature (1 set)',
    tay_4_trang_2_bo: '4-page signature (2 sets)',
    tay_recommended_pagespersig_trang_fit: '⚠ ${recommended.pagesPerSig}-page signature fits tight to the plate edge. Narrow tolerance — recheck gripper and bite margins.',
  },
  'misc.useAuthStore': {
    ban_quyen_da_bi_thu_hoi_vui_long_lien: 'License has been revoked. Please contact support for assistance.',
    ban_quyen_da_het_han_vui_long_gia_han: 'License has expired. Please renew to continue using the app.',
    can_ket_noi_mang_de_tool_hoat_dong_tot: 'An internet connection is required for the tool to work properly.',
    khoa_ban_quyen_da_duoc_su_dung_tren: 'This license key is already used on ${maxDevices} other devices. Contact support to add more.',
    phat_hien_dong_ho_he_thong_bi_thay_doi: 'System clock change detected. Please set the correct time and connect to the internet.',
    phat_hien_dong_ho_he_thong_bi_thay_doi_2: 'System clock change detected.',
    phat_hien_may_chu_xac_minh_bi_chan_vui: 'Verification server appears to be blocked. Please check again.',
    phien_hoat_dong_qua_lau_khong_ket_noi: 'Session has run too long without connecting. Please connect to the internet to verify the license.',
  },
  'imposition.types': {
    can_bong: 'Gloss lamination',
    can_mo: 'Matte lamination',
    decal_be_tem_vo: 'Destructible decal (tamper-evident)',
    decal_de_vang: 'Yellow-liner decal',
    decal_nhua_mo: 'Matte vinyl decal',
    decal_nhua_trong: 'Clear vinyl decal',
    khong_can: 'No lamination',
  },
  'lib.exportPDF': {
    da_xuat_file_pdf: 'PDF file exported',
    dang_tao_pdf: 'Generating PDF...',
    exportpdf_kho_trai_lon_math_round_pagew: '[exportPDF] Large spread size: ${Math.round(pageW)}×${Math.round(pageH)}mm — may take a while',
    khuon_be_model_standardcode: 'Dieline ${model.standardCode}',
    loi_khi_tao_pdf: 'Error generating PDF:',
    phat_hien_warnings_length_bien_dang_cat: 'Detected ${warnings.length} open cut contours:\\n${detail}',
    w_panellabel_w_panelname_ho_w_gapmm: '• ${w.panelLabel || w.panelName}: gap ${w.gapMm.toFixed(3)}mm',
  },
  'lib.materialLibrary': {
    can_mang_bong: 'Gloss lamination',
    can_mang_mo: 'Matte lamination',
    dap_noi_emboss: 'Emboss',
    ep_kim_metallic: 'Foil stamping / metallic',
    giay_kraft: 'Kraft paper',
    giay_sbs_trang: 'White SBS board',
    phu_uv_dinh_vi_spot_uv: 'Spot-UV coating',
  },
  'lib.foldPatterns': {
    bu_8_trang_tu_tro_lat_ngang_work_and: '8-page self-turning signature (Work and Turn).',
    in_1_bo_tu_tro_lat_nhip_work_and_tumble: 'Single-set self-turning (Work and Tumble). For large-format books.',
    nhan_2_bo_tu_tro_lat_ngang_work_and: '2-up self-turning (Work and Turn). For small-format books.',
    tay_4_trang_1_bo: '4-page signature (1 set)',
    tay_4_trang_2_bo: '4-page signature (2 sets)',
    tieu_chuan_xuong_4_to_long_16_trang_kem: 'Shop standard. 4 nested sheets = 16 pages. Plates A/B.',
  },
  'lib.parsePastedQuantities': {
    chua_co_du_lieu_dan_cot_so_luong_tu: 'No data — paste the quantity column from Excel into the box above.',
    dan_quantities_length_dong_nhung_co: 'Pasted ${quantities.length} rows but there are ${expectedCount} pages — recheck and paste again.',
    dong_lineno_bi_trong_dien_du_so_luong: 'Row ${lineNo} is empty — fill in the quantity and paste again (empty cells misalign pages).',
    dong_lineno_cell_khong_doc_duoc_thanh: 'Row ${lineNo} ("${cell}") could not be read as a number.',
    dong_lineno_cell_khong_phai_so_nguyen: 'Row ${lineNo} ("${cell}") is not a valid integer — you may have pasted the wrong column (e.g. size "5x10cm").',
    dong_lineno_co_nhieu_cot_chi_boi_cot_so: 'Row ${lineNo} has multiple columns — select ONLY the QUANTITY COLUMN in Excel and paste again.',
  },
  'misc.diffSidebar': {
    canh_bao_chinh_ta_ai: 'AI Spelling Warning',
    ket_qua_so_sanh: '📋 Comparison result',
    lech_nhe: 'Minor difference',
    nhan_de_xem_toan_man_hinh: 'Click to view fullscreen',
    thay_doi: 'Changed',
    y_het: 'Identical',
  },
  'misc.dualPDFViewerInner': {
    dang_tai_pdf: 'Loading PDF...',
    dong_esc: 'Close (Esc)',
    khong_the_tai_pdf: 'Could not load PDF',
    loi_hien_thi_pdf_react_pdf_vui_long_tai: 'PDF rendering error (react-pdf). Please reload the app.',
    pdf_goc_truoc_khi_sua: '📄 ORIGINAL PDF (Before edits)',
    toan_man_hinh: 'Fullscreen',
  },
  'misc.pDFUploader': {
    click_de_chon_file_khac: 'Click to choose another file',
    dang_upload: 'Uploading...',
    file_qua_lon_toi_da_500mb: 'File too large. Maximum 500MB.',
    keo_tha_file_pdf_vao_day_hoac_click_de: 'Drag & drop a PDF file here or click to choose',
    toi_da_500mb: 'Max 500MB',
    vui_long_chon_hoac_tha_file_pdf: 'Please choose or drop a PDF file',
  },
};

let filled = 0, miss = 0;
for (const [ns, dict] of Object.entries(T)) {
  if (!en[ns]) { console.log('NS MISSING', ns); continue; }
  for (const k of Object.keys(dict)) {
    if (!(k in en[ns])) { console.log('  EXTRA', ns, k); continue; }
    en[ns][k] = dict[k]; filled++;
  }
}
fs.writeFileSync(EN, JSON.stringify(en, null, 2) + '\n', 'utf8');
console.log(`\nDIEN ${filled}; thieu ${miss}.`);
