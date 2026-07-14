import fs from 'node:fs';
const VI = 'desktop/src/i18n/locales/vi.json', EN = 'desktop/src/i18n/locales/en.json';
const vi = JSON.parse(fs.readFileSync(VI, 'utf8')), en = JSON.parse(fs.readFileSync(EN, 'utf8'));
const add = (ns, k, v, e) => { vi[ns] = vi[ns] || {}; en[ns] = en[ns] || {}; if (vi[ns][k] !== undefined && vi[ns][k] !== v) { console.warn('WARN differs', ns, k); } vi[ns][k] = v; en[ns][k] = e; };

// ── CropDialog (misc.cropDialog) ─────────────────────────────────────────────
add('misc.cropDialog', 'khong_doc_duoc_kho_trang_http', 'Không đọc được khổ trang (HTTP {{status}})', 'Failed to read page boxes (HTTP {{status}})');
add('misc.cropDialog', 'khong_doc_duoc_kho_trang', 'Không đọc được khổ trang: {{msg}}', 'Failed to read page boxes: {{msg}}');
add('misc.cropDialog', 'vung_cat_khong_hop_le', 'Vùng cắt không hợp lệ: {{err}}', 'Invalid crop region: {{err}}');

// ── AcrobatToolbar (misc.acrobatToolbar) ─────────────────────────────────────
add('misc.acrobatToolbar', 'xem_hai_trang', 'Xem hai trang', 'Two-page view');

// ── ThumbSidebar (misc.thumbSidebar) ─────────────────────────────────────────
add('misc.thumbSidebar', 'trang_kich_thuoc_tooltip', 'Trang {{page}}\nKích thước: {{w}} x {{h}} mm', 'Page {{page}}\nSize: {{w}} x {{h}} mm');
add('misc.thumbSidebar', 'trang_trong', 'Trang Trống', 'Blank Page');
add('misc.thumbSidebar', 'dang_an_n_thumbnails_con_lai', 'Đang ẩn {{n}} thumbnails còn lại để tránh treo máy.', 'Hiding the remaining {{n}} thumbnails to avoid freezing.');

// ── TrialExpiryBanner (misc.trialExpiryBanner) ───────────────────────────────
add('misc.trialExpiryBanner', 'con_n_ngay', 'còn {{n}} ngày', '{{n}} days left');
add('misc.trialExpiryBanner', 'sap_het_han', 'Bản quyền của bạn sắp hết hạn ({{dayText}}). Gia hạn sớm để không gián đoạn công việc.', 'Your license is about to expire ({{dayText}}). Renew soon to avoid interruption.');

// ── RecentFilesGrid (misc.recentFilesGrid) ───────────────────────────────────
add('misc.recentFilesGrid', 'da_chon_n_muc', 'Đã chọn {{n}} mục', '{{n}} items selected');

// ── LivePageFrame (misc.livePageFrame) ───────────────────────────────────────
add('misc.livePageFrame', 'di_chuyen_that_bai', 'Di chuyển thất bại: {{msg}}', 'Move failed: {{msg}}');
add('misc.livePageFrame', 'khong_doi_duoc_font_thieu_glyph', 'Không đổi được: font đã chọn THIẾU GLYPH cho một số ký tự. ', 'Cannot change: the selected font is MISSING GLYPHS for some characters. ');
add('misc.livePageFrame', 'da_khoa_obj', '🔒 ĐÃ KHÓA — {{type}}: {{id}}', '🔒 LOCKED — {{type}}: {{id}}');
add('misc.livePageFrame', 'anh', 'ảnh', 'image');
add('misc.livePageFrame', 'bam_len_trang_de_dat', 'Bấm lên trang để đặt {{what}}…', 'Click on the page to place {{what}}…');
add('misc.livePageFrame', 'xoay_khung', 'Xoay khung', 'Rotate frame');

// ── SelectionLayersPanel (misc.selectionLayers) ──────────────────────────────
add('misc.selectionLayers', 'anh_2', 'ảnh', 'image');
add('misc.selectionLayers', 'bam_len_trang_de_dat', 'Bấm lên trang để đặt {{obj}}…', 'Click on the page to place {{obj}}…');
add('misc.selectionLayers', 'xoa_n_thanh_phan_da_chon', 'Xóa {{n}} Thành phần Đã Chọn', 'Delete {{n}} Selected Components');

// ── SaveModal (misc.save) ────────────────────────────────────────────────────
add('misc.save', 'giu_nguyen_dinh_dang_gop_tam_kem', 'Giữ nguyên định dạng gộp {{n}} tấm kẽm để dễ gửi khách duyệt.', 'Keep the merged format of {{n}} plates for easy client review.');
add('misc.save', 'da_gui_lenh_tai_roi_nhieu_file', '📥 Đã gửi lệnh tải rời nhiều file thành công!', '📥 Successfully queued downloads for multiple files!');
add('misc.save', 'tai_roi_tung_kem_download_files', 'Tải rời từng kẽm (Download {{n}} files)', 'Download each plate separately (Download {{n}} files)');

// ── SavePrintFilesModal (misc.savePrintFiles) ────────────────────────────────
add('misc.savePrintFiles', 'khong_mo_duoc_hop_thoai_chon_thu_muc', 'Không mở được hộp thoại chọn thư mục: {{msg}}', 'Could not open the folder picker dialog: {{msg}}');
add('misc.savePrintFiles', 'da_ghi_done_total_file', 'Đã ghi {{done}}/{{total}} file...', 'Wrote {{done}}/{{total}} files...');
add('misc.savePrintFiles', 'da_luu_ok_file_vao', '✅ Đã lưu {{ok}} file vào: {{folder}}', '✅ Saved {{ok}} files to: {{folder}}');
add('misc.savePrintFiles', 'loi_khi_luu', 'Lỗi khi lưu: {{msg}}', 'Error while saving: {{msg}}');
add('misc.savePrintFiles', 'cnc_moi_don_vi_tach_ra_file_rieng', 'CNC: mỗi đơn vị tách {{mode}} ra file riêng.', 'CNC: each unit splits {{mode}} into a separate file.');

// ── ExportImageModal (misc.exportImage) ──────────────────────────────────────
add('misc.exportImage', 'khong_mo_duoc_hop_thoai_chon_thu_muc', 'Không mở được hộp thoại chọn thư mục: {{msg}}', 'Could not open the folder picker dialog: {{msg}}');
add('misc.exportImage', 'da_xuat_file_anh_vao', 'Đã xuất {{count}} file ảnh vào:\n{{dir}}', 'Exported {{count}} image files to:\n{{dir}}');
add('misc.exportImage', 'loi_xuat_anh', 'Lỗi xuất ảnh: {{msg}}', 'Image export error: {{msg}}');
add('misc.exportImage', 'tat_ca_n', 'Tất cả ({{n}})', 'All ({{n}})');
add('misc.exportImage', 'trang_hien_tai_n', 'Trang hiện tại ({{n}})', 'Current page ({{n}})');
add('misc.exportImage', '1_file_tiff_n_trang', '1 file TIFF ({{n}} trang)', '1 TIFF file ({{n}} pages)');
add('misc.exportImage', 'n_file_anh', '{{n}} file ảnh', '{{n}} image files');

// ── LoginScreen (misc.login) ─────────────────────────────────────────────────
add('misc.login', 'loi_xu_ly_dang_nhap_tu_trinh_duyet', 'Lỗi xử lý đăng nhập từ trình duyệt: {{msg}}', 'Error processing browser login: {{msg}}');

// ── AboutModal (misc.about) ──────────────────────────────────────────────────
add('misc.about', 'co_ban_moi', 'Có bản mới', 'New version available');
add('misc.about', 'dang_tai_cai_dat', 'Đang tải & cài đặt… {{percent}}%', 'Downloading & installing… {{percent}}%');
add('misc.about', 'loi_msg', 'Lỗi: {{msg}}', 'Error: {{msg}}');

// ── UpdateChecker (misc.updateChecker) ───────────────────────────────────────
add('misc.updateChecker', 'dang_tai_ban_cap_nhat', 'Đang tải bản cập nhật... {{percent}}%', 'Downloading update... {{percent}}%');

// ── TextCompareTab (tabs.textCompare) ────────────────────────────────────────
add('tabs.textCompare', 'van_ban_lon_ky_tu_nen_chon_so_theo_dong', '⚠️ Văn bản lớn (~{{n}}K ký tự) — nên chọn "So theo Dòng" cho nhanh.', '⚠️ Large text (~{{n}}K characters) — choose "Compare by Line" for speed.');
add('tabs.textCompare', 'vui_long_nhan_tien_hanh_so_sanh_text', 'Vui lòng nhấn "Tiến hành so sánh Text" để hiển thị kết quả...', 'Please click "Compare Text" to show results...');

// ── PreflightTab (preflight.preflight) ───────────────────────────────────────
add('preflight.preflight', 'he_thong_xu_ly', 'Hệ thống xử lý: {{name}}...', 'System processing: {{name}}...');
add('preflight.preflight', 'chay_preflight_rules', '🔍 Chạy Preflight ({{n}} rules)', '🔍 Run Preflight ({{n}} rules)');
add('preflight.preflight', 'font_chua_nhung', '❌ {{n}}/{{total}} chưa nhúng', '❌ {{n}}/{{total}} not embedded');
add('preflight.preflight', 'font_da_nhung', '✅ {{total}} đã nhúng', '✅ {{total}} embedded');
add('preflight.preflight', 'anh_low_res', '⚠️ {{n}}/{{total}} low-res', '⚠️ {{n}}/{{total}} low-res');
add('preflight.preflight', 'anh_ok_min_dpi', '✅ {{total}} ảnh OK (min {{dpi}} DPI)', '✅ {{total}} images OK (min {{dpi}} DPI)');
add('preflight.preflight', 'van_de_n', 'Vấn đề ({{n}})', 'Issues ({{n}})');
add('preflight.preflight', 'tr_page', 'Tr.{{page}}', 'Pg.{{page}}');
add('preflight.preflight', 'thuc_thi_n', '🚀 Thực thi ({{n}})', '🚀 Execute ({{n}})');

// ── CombineTab (tabs.combine) ────────────────────────────────────────────────
add('tabs.combine', 'loi_khi_dan_xen', 'Lỗi khi đan xen: {{msg}}', 'Error while interleaving: {{msg}}');
add('tabs.combine', 'da_chia_nhom_tren_view_bam_combine', 'Đã chia {{n}} nhóm trên view — bấm Combine để ghép từng nhóm', 'Split into {{n}} groups on view — click Combine to merge each group');
add('tabs.combine', 'khong_do_duoc_kich_thuoc', 'Không đo được kích thước: {{msg}}', 'Could not measure size: {{msg}}');
add('tabs.combine', 'dang_ghep_label_progress', 'Đang ghép {{label}} ({{cur}}/{{total}})...', 'Combining {{label}} ({{cur}}/{{total}})...');
add('tabs.combine', 'ghep_label_n_trang', 'Ghép {{label}} ({{n}} trang)', 'Combine {{label}} ({{n}} pages)');
add('tabs.combine', 'da_ghep_label', 'Đã ghép {{label}}', 'Combined {{label}}');
add('tabs.combine', 'da_ghep_n_nhom_tab_combine', 'Đã ghép {{n}} nhóm → tab này + {{rest}} tab Combine', 'Combined {{n}} groups → this tab + {{rest}} Combine tabs');
add('tabs.combine', 'loi_khi_ghep_file', 'Lỗi khi ghép file: {{msg}}', 'Error while combining files: {{msg}}');
add('tabs.combine', 'nhom_n_trang', 'Nhóm {{n}} trang', 'Group of {{n}} pages');
add('tabs.combine', 'xoay_90_rotate', 'Xoay 90° (Rotate)', 'Rotate 90°');

// ── ImpositionTab (tabs.imposition) ──────────────────────────────────────────
add('tabs.imposition', 'loi_tai_object_trang_n', 'Lỗi tải object trang {{n}}', 'Error loading objects for page {{n}}');
add('tabs.imposition', 'tai_working_file_moi_that_bai_http', 'Tải Working_File mới thất bại (HTTP {{status}})', 'Failed to download new Working_File (HTTP {{status}})');
add('tabs.imposition', 'phat_lai_progress_step', 'Phát lại {{cur}}/{{total}}: {{step}}', 'Replaying {{cur}}/{{total}}: {{step}}');
add('tabs.imposition', 'phat_lai_xong', 'Phát lại xong: {{n}} bước', 'Replay done: {{n}} steps');
add('tabs.imposition', 'bo_qua_n_suffix', ', bỏ qua {{n}}', ', skipped {{n}}');
add('tabs.imposition', 'dung_o_buoc_n', 'Dừng ở bước {{n}}: {{err}}', 'Stopped at step {{n}}: {{err}}');
add('tabs.imposition', 'loi', 'lỗi', 'error');
add('tabs.imposition', 'loi_khi_ap_dung_sua_doi', 'Lỗi khi áp dụng sửa đổi: ', 'Error applying edits: ');
add('tabs.imposition', 'khong_the_luu_file', 'Không thể lưu file: ', 'Cannot save file: ');
add('tabs.imposition', 'ban_dang_mo_cong_cu_chon_file_pdf', 'Bạn đang mở công cụ: {{tool}}. Vui lòng chọn một file PDF để bắt đầu.', 'You are opening the tool: {{tool}}. Please select a PDF file to start.');
add('tabs.imposition', 'trang', 'trang', 'pages');
add('tabs.imposition', 'can_them_n_trang_trang_lam_tron', '(Cần thêm {{add}} trang trắng để làm tròn thành {{total}} trang chẵn theo quy tắc gấp tay sách).', '(Need to add {{add}} blank pages to round up to {{total}} even pages per booklet folding rule).');
add('tabs.imposition', 'dat_n_trang_trang_o_dau', 'Đặt {{n}} trang trắng ở đâu?', 'Where to place {{n}} blank pages?');
add('tabs.imposition', 'thong_so', 'THÔNG SỐ', 'PARAMETERS');

fs.writeFileSync(VI, JSON.stringify(vi, null, 2) + '\n', 'utf8');
fs.writeFileSync(EN, JSON.stringify(en, null, 2) + '\n', 'utf8');
console.log('added grp_W keys');
