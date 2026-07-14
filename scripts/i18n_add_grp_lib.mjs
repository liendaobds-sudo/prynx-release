import fs from 'node:fs';

// ─────────────────────────────────────────────────────────────────────────
// i18n_add_grp_lib.mjs — Thêm key cho các sink động (setStatus/throw/toast/
// setError/setReportMsg/setProcessStatus) trong lib/*.ts + engine.
//
// Nhiều key stale dạng ${...} do codemod cũ sinh (i18next KHÔNG nội suy được)
// → GHI ĐÈ bằng giá trị {{var}} mới, DÙNG LẠI đúng slug đó. Guard bên dưới in
// "WARN existing differs" khi ghi đè — bình thường ở đây.
//
// KHÔNG chạy tự động. Chạy thủ công từ REPO ROOT: node scripts/i18n_add_grp_lib.mjs
// ─────────────────────────────────────────────────────────────────────────

const VI = 'desktop/src/i18n/locales/vi.json';
const EN = 'desktop/src/i18n/locales/en.json';
const vi = JSON.parse(fs.readFileSync(VI, 'utf8'));
const en = JSON.parse(fs.readFileSync(EN, 'utf8'));

const add = (ns, k, v, e) => {
  vi[ns] = vi[ns] || {};
  en[ns] = en[ns] || {};
  if (vi[ns][k] !== undefined && vi[ns][k] !== v) {
    console.warn('WARN existing differs', ns, k, '\n   old:', vi[ns][k], '\n   new:', v);
  }
  vi[ns][k] = v;
  en[ns][k] = e;
};

// ═══════════════════════════════════════════════════════════════════════
//  lib.pdfImposer
// ═══════════════════════════════════════════════════════════════════════
add('lib.pdfImposer', 'dang_phan_tich_va_nap_tep_pdf',
  'Đang phân tích và nạp tệp PDF...', 'Analyzing and loading PDF file...');
add('lib.pdfImposer', 'trang_khong_dong_kich_thuoc_n_sizelist',
  '⚠ Trang không đồng kích thước:\n{{sizeList}}\nBình sách sẽ dùng kích thước lớn nhất.\n',
  '⚠ Pages have inconsistent sizes:\n{{sizeList}}\nImposition will use the largest size.\n');
add('lib.pdfImposer', 'count_trang_paren',
  '({{count}} trang)', '({{count}} pages)');
add('lib.pdfImposer', 'tach_bia_coverindices_length_trang_bia',
  'Tách bìa: {{coverCount}} trang bìa sẽ xuất riêng cuối file. Ruột: {{bodyCount}} trang.\n',
  'Cover separation: {{coverCount}} cover pages will be exported separately at the end. Body: {{bodyCount}} pages.\n');
add('lib.pdfImposer', 'da_bo_qua_tach_bia_rieng_sach_can_toi',
  '⚠ Đã bỏ qua "Tách bìa riêng": sách cần tối thiểu {{minPages}} trang để tách {{coverCount}} trang bìa (hiện có {{current}}).\n',
  '⚠ Skipped "Separate cover": book needs at least {{minPages}} pages to separate {{coverCount}} cover pages (currently {{current}}).\n');
add('lib.pdfImposer', 'giai_doan_1_dang_thiet_lap_so_do_trang',
  'Giai đoạn 1: Đang thiết lập sơ đồ trang...', 'Stage 1: Setting up page map...');
add('lib.pdfImposer', 'giai_doan_2_dang_tinh_toan_kich_thuoc',
  'Giai đoạn 2: Đang tính toán kích thước tự động...', 'Stage 2: Auto-computing dimensions...');
add('lib.pdfImposer', 'kho_giay_nho_hon_kho_trai_trang_noi',
  '⚠ Khổ giấy nhỏ hơn khổ trải trang: nội dung sẽ bị tràn/cắt ở mép. Hãy chọn khổ lớn hơn hoặc thu nhỏ file còn ~{{pct}}%.',
  '⚠ Sheet size smaller than spread size: content will overflow/clip at edges. Choose a larger sheet or scale the file down to ~{{pct}}%.');
add('lib.pdfImposer', 'giai_doan_3_dang_sap_xep_du_lieu',
  'Giai đoạn 3: Đang sắp xếp dữ liệu...', 'Stage 3: Arranging data...');
add('lib.pdfImposer', 'dang_tai_du_lieu_hinh_anh',
  'Đang tải dữ liệu hình ảnh...', 'Loading image data...');
add('lib.pdfImposer', 'giai_doan_4_dang_xu_ly_hinh_anh_va_do',
  'Giai đoạn 4: Đang xử lý hình ảnh và đồ hoạ...', 'Stage 4: Processing images and graphics...');
add('lib.pdfImposer', 'giai_doan_5_dang_nap_trang_vao_khuon',
  'Giai đoạn 5: Đang nạp trang vào khuôn...', 'Stage 5: Loading pages into the frame...');
add('lib.pdfImposer', 'auto_detect_chon_so_do_foldpattern_name',
  'Auto-detect: Chọn sơ đồ {{name}} ({{pagesPerSig}} trang/tay)',
  'Auto-detect: Selected pattern {{name}} ({{pagesPerSig}} pages/signature)');
add('lib.pdfImposer', 'tay_sach_pagespersig_trang_khong_co_so',
  '⚠ Tay sách {{pagesPerSig}} trang không có sơ đồ gấp khớp; tạm dùng "{{name}}" ({{patternPages}} trang). Hãy chia tép theo bội số 4/8/16 để khớp sơ đồ.',
  '⚠ Signature of {{pagesPerSig}} pages has no matching fold pattern; using "{{name}}" ({{patternPages}} pages) instead. Split into multiples of 4/8/16 to match a pattern.');
add('lib.pdfImposer', 'giai_doan_6_dang_xep_trang_len_kho_in',
  'Giai đoạn 6: Đang xếp trang lên khổ in theo sơ đồ...', 'Stage 6: Placing pages onto the sheet per pattern...');
add('lib.pdfImposer', 'giai_doan_6_dang_ghep_to_booklet_xen',
  'Giai đoạn 6: Đang ghép tờ booklet (Xén Chồng)...', 'Stage 6: Assembling booklet sheets (Cut & Stack)...');
add('lib.pdfImposer', 'giai_doan_6_dang_nhan_ban_trang_in_step',
  'Giai đoạn 6: Đang nhân bản trang in (Step & Repeat)...', 'Stage 6: Duplicating print pages (Step & Repeat)...');
add('lib.pdfImposer', 'dang_them_coverindices_length_trang_bia',
  'Đang thêm {{count}} trang bìa vào cuối file...', 'Adding {{count}} cover pages to the end of the file...');
add('lib.pdfImposer', 'don_dep_bo_nho_va_dong_tep_pdf',
  'Dọn dẹp bộ nhớ và Đóng tệp PDF...', 'Cleaning up memory and closing the PDF file...');
add('lib.pdfImposer', 'phat_hien_pdf_bi_khoa_dang_giai_ma_tap',
  'Phát hiện PDF bị khóa - Đang giải mã tập tin...', 'Locked PDF detected - Decrypting file...');
add('lib.pdfImposer', 'loi_tu_backend_response_status',
  'Lỗi từ Backend: {{status}} - {{errorText}}', 'Backend error: {{status}} - {{errorText}}');
add('lib.pdfImposer', 'giai_ma_thanh_cong_dang_nap_lai_tai',
  'Giải mã thành công. Đang nạp lại tài liệu...', 'Decryption successful. Reloading document...');
add('lib.pdfImposer', 'xu_ly_tap_tin_that_bai_e_message',
  'Xử lý tập tin thất bại: {{message}}', 'File processing failed: {{message}}');
add('lib.pdfImposer', 'dang_tai_va_xu_ly_khung_pdf_vao',
  'Đang tải và xử lý khung PDF vào pipeline...', 'Loading and processing the PDF into the pipeline...');
add('lib.pdfImposer', 'loi_giai_ma', 'Lỗi giải mã:', 'Decryption error:');
add('lib.pdfImposer', 'loi_boc_tach_pdf', 'Lỗi bóc tách PDF:', 'PDF extraction error:');
add('lib.pdfImposer', 'bat_dau_xu_ly_jobs_length_tam_kem',
  'Bắt đầu xử lý {{count}} tấm kẽm...', 'Starting processing of {{count}} plates...');
add('lib.pdfImposer', 'dang_xu_ly_kem_i_1_jobs_length_job',
  'Đang xử lý kẽm {{current}}/{{total}}: {{label}}...', 'Processing plate {{current}}/{{total}}: {{label}}...');
add('lib.pdfImposer', 'kem_i_1_jobs_length_msg',
  '[Kẽm {{current}}/{{total}}] {{msg}}', '[Plate {{current}}/{{total}}] {{msg}}');
add('lib.pdfImposer', 'job_label_loi_err_message',
  '❌ {{label}} (Lỗi: {{message}})', '❌ {{label}} (Error: {{message}})');
add('lib.pdfImposer', 'loi_err_message', 'Lỗi: {{message}}', 'Error: {{message}}');
add('lib.pdfImposer', 'hoan_tat_results_filter_r_r_blob_size_0',
  'Hoàn tất: {{done}}/{{total}} kẽm thành công.', 'Done: {{done}}/{{total}} plates succeeded.');
add('lib.pdfImposer', 'dang_tinh_toan_so_do_binh_trang',
  'Đang tính toán sơ đồ bình trang...', 'Computing imposition layout...');
add('lib.pdfImposer', 'dang_trich_xuat_du_lieu_tap_tin',
  'Đang trích xuất dữ liệu tập tin...', 'Extracting file data...');
add('lib.pdfImposer', 'dang_thiet_lap_so_do_trang',
  'Đang thiết lập sơ đồ trang...', 'Setting up page map...');
add('lib.pdfImposer', 'dang_tinh_toan_kich_thuoc_tu_dong',
  'Đang tính toán kích thước tự động...', 'Auto-computing dimensions...');
add('lib.pdfImposer', 'trang_trai_khong_vua_kho_100',
  '⚠ Trang trải {{spreadW}}×{{spreadH}}mm KHÔNG vừa khổ {{sheetW}}×{{sheetH}}mm ở 100% (dù đã xoay khổ). Hãy chọn khổ lớn hơn, hoặc dùng "1 cuốn/tờ (bóp vừa khổ)" để thu nội dung cho vừa. Hệ thống KHÔNG tự co ở chế độ 100%.',
  '⚠ Spread {{spreadW}}×{{spreadH}}mm does NOT fit sheet {{sheetW}}×{{sheetH}}mm at 100% (even after rotating the sheet). Choose a larger sheet, or use "1 booklet/sheet (fit to sheet)" to shrink content to fit. The system does NOT auto-shrink in 100% mode.');
add('lib.pdfImposer', 'dang_xuat_thong_so_ky_thuat',
  'Đang xuất thông số kỹ thuật...', 'Exporting technical specifications...');
add('lib.pdfImposer', 'dang_gui_ke_hoach_xu_ly',
  'Đang gửi kế hoạch xử lý...', 'Sending processing plan...');
add('lib.pdfImposer', 'he_thong_xu_ly_that_bai_response_status',
  'Hệ thống xử lý thất bại: {{status}} - {{errText}}', 'Processing system failed: {{status}} - {{errText}}');
add('lib.pdfImposer', 'hoan_tat_file_kem_da_duoc_xuat_thanh',
  '✅ Hoàn tất! File kẽm đã được xuất thành công.', '✅ Done! The plate file was exported successfully.');
add('lib.pdfImposer', 'kem_i_1_jobs_length_job_label',
  '[Kẽm {{current}}/{{total}}] {{label}}...', '[Plate {{current}}/{{total}}] {{label}}...');
add('lib.pdfImposer', 'hoan_tat_results_filter_r_r_label',
  '✅ Hoàn tất: {{done}}/{{total}} kẽm thành công.', '✅ Done: {{done}}/{{total}} plates succeeded.');

// ═══════════════════════════════════════════════════════════════════════
//  lib.nupRenderer
// ═══════════════════════════════════════════════════════════════════════
add('lib.nupRenderer', 'nhan_ban', 'Nhân bản', 'Repeat');
add('lib.nupRenderer', 'dang_phan_tich_cau_truc_ma_tran_jobname',
  'Đang phân tích cấu trúc ma trận {{jobName}}...', 'Analyzing {{jobName}} matrix structure...');
add('lib.nupRenderer', 'khoi_tao_luoi_jobname_cols_cot_x_rows',
  'Khởi tạo lưới {{jobName}} ({{cols}} cột x {{rows}} dòng) - Chế độ: {{mode}}...',
  'Initializing {{jobName}} grid ({{cols}} cols x {{rows}} rows) - Mode: {{mode}}...');
add('lib.nupRenderer', 'che_do_cat_xep_chong', 'Cắt xếp chồng', 'Cut & Stack');
add('lib.nupRenderer', 'che_do_trai_tuan_tu', 'Trải tuần tự', 'Sequential');
add('lib.nupRenderer', 'dang_xuat_mam_in_to_s_1_sheetstorender',
  'Đang xuất mâm in tờ {{current}}/{{total}}...', 'Exporting print sheet {{current}}/{{total}}...');

// ═══════════════════════════════════════════════════════════════════════
//  lib.renderer
// ═══════════════════════════════════════════════════════════════════════
add('lib.renderer', 'mat_truoc', 'Trước', 'Front');
add('lib.renderer', 'mat_sau', 'Sau', 'Back');
add('lib.renderer', 'dang_render_mat_isfront_truoc_sau_to',
  'Đang Render mặt {{side}} tờ {{sheet}} ({{current}}/{{total}})...',
  'Rendering {{side}} side of sheet {{sheet}} ({{current}}/{{total}})...');

// ═══════════════════════════════════════════════════════════════════════
//  recipe.recipeRunners
// ═══════════════════════════════════════════════════════════════════════
add('recipe.recipeRunners', 'dang_xu_ly_prepress',
  'Đang xử lý (prepress)...', 'Processing (prepress)...');
add('recipe.recipeRunners', 'buoc_prepress_that_bai',
  'Bước prepress thất bại', 'Prepress step failed');
add('recipe.recipeRunners', 'loi_prepress', 'Lỗi prepress:', 'Prepress error:');
add('recipe.recipeRunners', 'dang_nen_toi_uu_pdf',
  'Đang nén / tối ưu PDF...', 'Compressing / optimizing PDF...');
add('recipe.recipeRunners', 'nen_pdf_that_bai_res_status',
  'Nén PDF thất bại ({{status}})', 'PDF compression failed ({{status}})');
add('recipe.recipeRunners', 'loi_nen_pdf', 'Lỗi nén PDF:', 'PDF compression error:');
add('recipe.recipeRunners', 'dang_do_lai_hinh_tem_tren_file_moi',
  'Đang dò lại hình tem trên file mới...', 'Re-detecting sticker shapes on the new file...');
add('recipe.recipeRunners', 'loi_binh_tem_phat_lai',
  'Lỗi bình tem (phát lại):', 'Sticker imposition error (playback):');
add('recipe.recipeRunners', 'dang_tao_duong_cat_bu_xen',
  'Đang tạo đường cắt / bù xén...', 'Creating cut line / bleed...');
add('recipe.recipeRunners', 'loi_xoa_le_trang', 'Lỗi xóa lề trắng', 'White-edge trim error');
add('recipe.recipeRunners', 'loi_tao_bu_xen_vector',
  'Lỗi tạo bù xén Vector', 'Vector bleed creation error');
add('recipe.recipeRunners', 'loi_server_response_status',
  'Lỗi server ({{status}})', 'Server error ({{status}})');
add('recipe.recipeRunners', 'loi_tao_duong_cat', 'Lỗi tạo đường cắt:', 'Cut line creation error:');

// ═══════════════════════════════════════════════════════════════════════
//  lib.vdpTemplate
// ═══════════════════════════════════════════════════════════════════════
add('lib.vdpTemplate', 'chua_co_truong_vdp_nao_de_luu_mau',
  'Chưa có trường VDP nào để lưu mẫu.', 'No VDP fields to save as a template.');
add('lib.vdpTemplate', 'luu_mau_bo_cuc_vdp', 'Lưu mẫu bố cục VDP', 'Save VDP layout template');
add('lib.vdpTemplate', 'da_luu_mau_path_split_pop',
  'Đã lưu mẫu: {{name}}', 'Template saved: {{name}}');
add('lib.vdpTemplate', 'da_tai_mau_xuong', 'Đã tải mẫu xuống.', 'Template downloaded.');
add('lib.vdpTemplate', 'loi_luu_mau', 'Lỗi lưu mẫu:', 'Template save error:');
add('lib.vdpTemplate', 'tai_mau_bo_cuc_vdp', 'Tải mẫu bố cục VDP', 'Load VDP layout template');
add('lib.vdpTemplate', 'file_mau_khong_hop_le_hoac_rong',
  'File mẫu không hợp lệ hoặc rỗng.', 'Template file is invalid or empty.');
add('lib.vdpTemplate', 'da_tai_mau_remapped_length_truong',
  'Đã tải mẫu: {{count}} trường.', 'Template loaded: {{count}} fields.');
add('lib.vdpTemplate', 'loi_tai_mau', 'Lỗi tải mẫu:', 'Template load error:');

// ═══════════════════════════════════════════════════════════════════════
//  cutExport
// ═══════════════════════════════════════════════════════════════════════
add('cutExport', 'khong_tai_duoc_danh_sach_may_be',
  'Không tải được danh sách máy bế ({{status}})', 'Could not load cutter list ({{status}})');
add('cutExport', 'loi_may_chu_res_status_text',
  'Lỗi máy chủ ({{status}}): {{text}}', 'Server error ({{status}}): {{text}}');
add('cutExport', 'loi_may_chu_res_status',
  'Lỗi máy chủ ({{status}})', 'Server error ({{status}})');

// ═══════════════════════════════════════════════════════════════════════
//  lib.exportNestingPDF
// ═══════════════════════════════════════════════════════════════════════
add('lib.exportNestingPDF', 'result_countpersheet_khuon_to_result',
  '{{count}} khuôn / tờ — {{label}} — {{utilization}}%',
  '{{count}} dies / sheet — {{label}} — {{utilization}}%');
add('lib.exportNestingPDF', 'can_nhip_config_grippermargin_mm',
  'Cắn nhíp ({{gripper}}mm)', 'Gripper ({{gripper}}mm)');
add('lib.exportNestingPDF', 'day_giay_t_params_t_mm',
  'Dày giấy (T): {{value}} mm', 'Paper thickness (T): {{value}} mm');
add('lib.exportNestingPDF', 'dam_g_params_g_mm',
  'Dầm (G): {{value}} mm', 'Beam (G): {{value}} mm');
add('lib.exportNestingPDF', 'mi_dan_vo_params_sleeveglue_mm',
  'Mí dán vỏ: {{value}} mm', 'Sleeve glue flap: {{value}} mm');
add('lib.exportNestingPDF', 'mi_gap_th_params_th_mm',
  'Mí gập (TH): {{value}} mm', 'Fold flap (TH): {{value}} mm');
add('lib.exportNestingPDF', 'to_actualsheet_width_actualsheet_height',
  'Tờ: {{width}}×{{height}} mm', 'Sheet: {{width}}×{{height}} mm');
add('lib.exportNestingPDF', 'khuon_to_result_countpersheet_result',
  'Khuôn/tờ: {{count}} ({{cols}}×{{rows}})', 'Dies/sheet: {{count}} ({{cols}}×{{rows}})');
add('lib.exportNestingPDF', 'su_dung_result_utilization',
  'Sử dụng: {{utilization}}%', 'Utilization: {{utilization}}%');
add('lib.exportNestingPDF', 'ho_dao_be_config_gutter_config_diegap',
  'Hở dao bế: {{value}} mm', 'Die gap: {{value}} mm');
add('lib.exportNestingPDF', 'nesting_model_name_params_l_x_params_w',
  'Nesting {{name}} - {{L}}x{{W}}x{{D}} - {{count}} khuôn/tờ',
  'Nesting {{name}} - {{L}}x{{W}}x{{D}} - {{count}} dies/sheet');
add('lib.exportNestingPDF', 'binh_ban_result_label_result',
  'Bình bản {{label}} — {{utilization}}%', 'Nesting {{label}} — {{utilization}}%');
add('lib.exportNestingPDF', 'da_xuat_pdf_xep_khuon_result',
  'Đã xuất PDF xếp khuôn ({{count}} khuôn/tờ)', 'Nesting PDF exported ({{count}} dies/sheet)');
add('lib.exportNestingPDF', 'loi_khi_tao_pdf', 'Lỗi khi tạo PDF:', 'Error creating PDF:');

// ═══════════════════════════════════════════════════════════════════════
//  lib.processHandlers
// ═══════════════════════════════════════════════════════════════════════
add('lib.processHandlers', 'dang_chuan_bi_du_lieu',
  'Đang chuẩn bị dữ liệu...', 'Preparing data...');
add('lib.processHandlers', 'nhan_ban_s_r', 'Nhân bản (S&R)', 'Repeat (S&R)');
add('lib.processHandlers', 'dang_tai_file_ket_qua_ve',
  'Đang tải file kết quả về...', 'Downloading result file...');
add('lib.processHandlers', 'dang_tu_dong_luu_file_in',
  '🖨️ Đang tự động lưu file in...', '🖨️ Auto-saving print files...');
add('lib.processHandlers', 'da_tu_dong_luu_ok_file_in_vao_sp_folder',
  '🖨️ Đã tự động lưu {{ok}} file in vào: {{folder}}', '🖨️ Auto-saved {{ok}} print files to: {{folder}}');
add('lib.processHandlers', 'binh_xong_nhung_tu_dong_luu_file_in_loi',
  'Bình xong nhưng tự động lưu file in lỗi:', 'Imposition done but auto-save of print files failed:');
add('lib.processHandlers', 'loi_xu_ly_he_thong', 'Lỗi xử lý hệ thống', 'System processing error');
add('lib.processHandlers', 'dang_xu_ly_prog_trang_da_binh',
  '⚡ Đang xử lý: {{prog}} trang đã bình...', '⚡ Processing: {{prog}} pages imposed...');
add('lib.processHandlers', 'dang_xu_ly_du_lieu_qua_backend_unified',
  'Đang xử lý dữ liệu qua backend (unified engine)...', 'Processing data via backend (unified engine)...');
add('lib.processHandlers', 'file_da_duoc_luu_tren_server_result',
  '✅ File đã được lưu trên server: {{outputPath}}\n{{report}}',
  '✅ File saved on the server: {{outputPath}}\n{{report}}');
add('lib.processHandlers', 'loi_he_thong_khi_xu_ly_binh_trang',
  'Lỗi hệ thống khi xử lý Bình trang.', 'System error while processing imposition.');
add('lib.processHandlers', 'dang_phan_tich_cau_truc_catalog',
  'Đang phân tích cấu trúc Catalog...', 'Analyzing catalog structure...');
add('lib.processHandlers', 'loi_phan_tich_verifyerrors_join',
  'Lỗi phân tích: {{errors}}', 'Analysis error: {{errors}}');
add('lib.processHandlers', 'dang_binh_planresult_jobs_length_tam',
  'Đang bình {{count}} tấm kẽm...', 'Imposing {{count}} plates...');
add('lib.processHandlers', 'loi_khi_xu_ly_catalog_auto_plan',
  'Lỗi khi xử lý Catalog Auto Plan.', 'Error while processing Catalog Auto Plan.');
add('lib.processHandlers', 'dang_xao_tron_trang', 'Đang xáo trộn trang...', 'Shuffling pages...');
add('lib.processHandlers', 'loi_xao_tron_trang', 'Lỗi xáo trộn trang:', 'Page shuffle error:');
add('lib.processHandlers', 'dang_doi_kho_trang', 'Đang đổi khổ trang...', 'Resizing pages...');
add('lib.processHandlers', 'loi_doi_kho', 'Lỗi đổi khổ:', 'Resize error:');
add('lib.processHandlers', 'dang_cat_xen_doi_noi_dung',
  'Đang cắt xén & dời nội dung...', 'Trimming & shifting content...');
add('lib.processHandlers', 'loi_cat_xen_doi', 'Lỗi cắt xén & dời:', 'Trim & shift error:');
add('lib.processHandlers', 'dang_tach_pdf', 'Đang tách PDF...', 'Splitting PDF...');
add('lib.processHandlers', 'da_tach_file_thanh_cong', 'Đã tách file thành công.', 'File split successfully.');
add('lib.processHandlers', 'da_tao_results_length_tab_moi',
  'Đã tạo {{count}} tab mới.', 'Created {{count}} new tabs.');
add('lib.processHandlers', 'da_tach_thanh_results_length_file',
  'Đã tách thành {{count}} file.', 'Split into {{count}} files.');
add('lib.processHandlers', 'loi_tach_pdf', 'Lỗi tách PDF:', 'PDF split error:');
add('lib.processHandlers', 'dang_ghep_pdf', 'Đang ghép PDF...', 'Merging PDF...');
add('lib.processHandlers', 'loi_ghep_pdf', 'Lỗi ghép PDF:', 'PDF merge error:');

fs.writeFileSync(VI, JSON.stringify(vi, null, 2) + '\n', 'utf8');
fs.writeFileSync(EN, JSON.stringify(en, null, 2) + '\n', 'utf8');
console.log('added grp lib sink keys');
