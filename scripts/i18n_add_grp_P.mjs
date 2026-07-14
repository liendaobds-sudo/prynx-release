import fs from 'node:fs';
const VI = 'desktop/src/i18n/locales/vi.json', EN = 'desktop/src/i18n/locales/en.json';
const vi = JSON.parse(fs.readFileSync(VI, 'utf8')), en = JSON.parse(fs.readFileSync(EN, 'utf8'));
const add = (ns, k, v, e) => {
  vi[ns] = vi[ns] || {}; en[ns] = en[ns] || {};
  if (vi[ns][k] !== undefined && vi[ns][k] !== v) { console.warn('WARN differs', ns, k); }
  vi[ns][k] = v; en[ns][k] = e;
};

// ─── preprocess.bgRemover ───
add('preprocess.bgRemover', 'luu_tat_ca', 'Lưu tất cả', 'Save all');

// ─── preprocess.upscale ───
add('preprocess.upscale', 'luu_tat_ca', 'Lưu tất cả', 'Save all');

// ─── preprocess.coverNumbering ───
add('preprocess.coverNumbering', 'so_khong_chia_het_goi_y', '⚠️ {{total}} số không chia hết cho {{count}} cuốn. Gợi ý: dùng {{suggestion}} cuốn (chia hết).', '⚠️ {{total}} numbers do not divide evenly into {{count}} booklets. Suggestion: use {{suggestion}} booklets (divides evenly).');
add('preprocess.coverNumbering', 'so_chia_lien_cuon', '✅ {{total}} số ÷ {{count}} cuốn = {{per}} liên/cuốn.', '✅ {{total}} numbers ÷ {{count}} booklets = {{per}} sheets/booklet.');
add('preprocess.coverNumbering', 'dai_cuon_dau_cuoi', ' Cuốn 1: {{firstY}}–{{firstZ}} · Cuốn {{count}}: {{lastY}}–{{lastZ}}.', ' Booklet 1: {{firstY}}–{{firstZ}} · Booklet {{count}}: {{lastY}}–{{lastZ}}.');
add('preprocess.coverNumbering', 'dang_day_len_may_chu_to_in', 'Đang đẩy lên máy chủ ({{n}} tờ in)...', 'Uploading to server ({{n}} sheets)...');
add('preprocess.coverNumbering', 'so_ruot_bat_dau', 'Số ruột bắt đầu', 'Start inner number');
add('preprocess.coverNumbering', 'so_ruot_ket_thuc', 'Số ruột kết thúc', 'End inner number');
add('preprocess.coverNumbering', 'tong_so_cuon', 'Tổng số cuốn', 'Total booklets');
add('preprocess.coverNumbering', 'so_cuon_bat_dau', 'Số cuốn bắt đầu (→{{x}})', 'Start booklet number (→{{x}})');
add('preprocess.coverNumbering', 'dem_0_do_dai', 'Đệm 0 (độ dài)', 'Zero pad (length)');
add('preprocess.coverNumbering', 'so_cuon', 'Số cuốn', 'Booklet no.');
add('preprocess.coverNumbering', 'ruot_dau', 'Ruột đầu', 'First inner');
add('preprocess.coverNumbering', 'ruot_cuoi', 'Ruột cuối', 'Last inner');
add('preprocess.coverNumbering', 'n_cum_n_truong', '{{clusters}} cụm · {{fields}} trường', '{{clusters}} clusters · {{fields}} fields');
add('preprocess.coverNumbering', 'trang_bia_to_da_binh', 'Trang bìa (tờ đã bình)', 'Cover pages (imposed sheet)');
add('preprocess.coverNumbering', 'file_co_n_trang', 'File có {{n}} trang.', 'File has {{n}} pages.');
add('preprocess.coverNumbering', 'se_dung_n_trang_bia', 'Sẽ dùng {{n}} trang bìa: {{list}}. Trang còn lại là ruột (dùng Mẹc Số).', 'Will use {{n}} cover pages: {{list}}. Remaining pages are inner (use Numbering).');
add('preprocess.coverNumbering', 'tao_bia_n_cuon', 'Tạo bìa ({{n}} cuốn)', 'Create covers ({{n}} booklets)');
add('preprocess.coverNumbering', 'loi', 'Lỗi:', 'Error:');

// ─── preprocess.inkManager ───
add('preprocess.inkManager', 'da_chuyen_x_cmyk', 'Đã chuyển {{x}} → CMYK', 'Converted {{x}} → CMYK');
add('preprocess.inkManager', 'tat_ca_spot', 'tất cả Spot', 'all Spot');
add('preprocess.inkManager', 'loi', 'Lỗi', 'Error');
add('preprocess.inkManager', 'chuyen_x_cmyk', 'Chuyển {{x}} → CMYK', 'Convert {{x}} → CMYK');

// ─── preprocess.numbering ───
add('preprocess.numbering', 'dang_day_du_lieu_len_may_chu', 'Đang đẩy dữ liệu lên máy chủ ({{n}} trang)...', 'Uploading data to server ({{n}} pages)...');
add('preprocess.numbering', 'trang', 'Trang {{n}}:', 'Page {{n}}:');
add('preprocess.numbering', 'dung_b_cho_bo_va_t_cho_stt', 'Dùng {{b}} cho Bộ và {{t}} cho Số thứ tự.', 'Use {{b}} for Set and {{t}} for Sequence number.');
add('preprocess.numbering', 'dinh_dang', 'Định dạng', 'Format');
add('preprocess.numbering', 'n_truong', '{{n}} trường', '{{n}} fields');
add('preprocess.numbering', 'xem_truoc_ket_qua_slots', 'Xem trước kết quả ({{n}} Slots)', 'Preview result ({{n}} Slots)');
add('preprocess.numbering', 'tao_file_nhay_so_slots', 'Tạo file Nhảy số ({{n}} Slots)', 'Create Numbering file ({{n}} Slots)');

// ─── preprocess.optimize ───
add('preprocess.optimize', 'giam_dung_luong_file_bang_cach_nen', '— Giảm dung lượng file bằng cách nén ảnh, subset font, gỡ rác.', '— Reduce file size by compressing images, subsetting fonts, removing junk.');
add('preprocess.optimize', 'chat_luong_in', 'Chất lượng in', 'Print quality');
add('preprocess.optimize', 'sau', 'Sau', 'After');

// ─── preprocess.preflight ───
add('preprocess.preflight', 'thuc_thi', 'Thực thi', 'Execute');

// ─── preprocess.savePdfx ───
add('preprocess.savePdfx', 'da_xuat_x_thanh_cong', 'Đã xuất {{x}} thành công', 'Exported {{x}} successfully');
add('preprocess.savePdfx', 'loi_xuat_pdf_x', 'Lỗi xuất PDF/X', 'PDF/X export error');
add('preprocess.savePdfx', 'file_dat_chuan_x', 'File đạt chuẩn {{x}}!', 'File meets {{x}} standard!');
add('preprocess.savePdfx', 'x_dat_xuat_pdfx_se_tu_dong_sua', '{{p}}/{{tot}} đạt — Xuất PDF/X sẽ tự động sửa', '{{p}}/{{tot}} passed — Exporting PDF/X will fix automatically');
add('preprocess.savePdfx', 'x_dat_can_xu_ly_thu_cong_truoc', '{{p}}/{{tot}} đạt — Cần xử lý thủ công trước: {{list}} (bấm ? để xem cách). Các mục còn lại sẽ tự sửa khi xuất.', '{{p}}/{{tot}} passed — Needs manual handling first: {{list}} (click ? for how). The rest will be fixed on export.');
add('preprocess.savePdfx', 'xuat_x', 'Xuất {{x}}', 'Export {{x}}');

// ─── preprocess.shuffle ───
add('preprocess.shuffle', 'xoay', 'Xoay', 'Rotate');
add('preprocess.shuffle', 'mo_phong_cho_tai_lieu_mau_n_trang', '* Mô phỏng cho tài liệu mẫu có {{n}} trang.', '* Simulation for a sample document with {{n}} pages.');

// ─── preprocess.split ───
add('preprocess.split', 'vd_dai_trang_tao_ra_2_file', 'VD: "1-4, 5-8" → Tạo ra 2 file (file chứa tr1-tr4, file chứa tr5-tr8).', 'E.g.: "1-4, 5-8" → Creates 2 files (one with pages 1-4, one with pages 5-8).');

// ─── preprocess.vdpAlign ───
add('preprocess.vdpAlign', 'can_chinh', 'Căn chỉnh', 'Align');
add('preprocess.vdpAlign', 'theo_trang', '(theo trang)', '(by page)');
add('preprocess.vdpAlign', 'n_doi_tuong', '({{n}} đối tượng)', '({{n}} objects)');

// ─── preprocess.watermark ───
add('preprocess.watermark', 'chen_hinh_nen_file_pdf_anh_ben_duoi', 'Chèn hình nền (File PDF/Ảnh) bên dưới hoặc đóng dấu văn bản/logo đè lên trên trang PDF.', 'Insert a background (PDF/Image file) underneath, or stamp text/logo on top of the PDF page.');
add('preprocess.watermark', 'xu_ly_truc_tiep_tren_trinh_duyet_bao_mat', 'Xử lý trực tiếp trên trình duyệt, bảo mật 100%.', 'Processed directly in the browser, 100% private.');

// ─── preprocess.dataMerge ───
add('preprocess.dataMerge', 'da_tai_n_dong_cot_trung_ten', 'Đã tải {{n}} dòng. Lưu ý: cột trùng tên ({{cols}}) đã tự đổi tên.', 'Loaded {{n}} rows. Note: duplicate column names ({{cols}}) were auto-renamed.');
add('preprocess.dataMerge', 'da_tai_n_dong_du_lieu', 'Đã tải {{n}} dòng dữ liệu.', 'Loaded {{n}} data rows.');
add('preprocess.dataMerge', 'da_chon_n_file_map_truong', 'Đã chọn {{n}} file. Map trường với cột rồi bấm "Chạy {{n}} file".', 'Selected {{n}} files. Map fields to columns then click "Run {{n}} files".');
add('preprocess.dataMerge', 'nguon_rong_0_ban_ghi', 'nguồn rỗng (0 bản ghi).', 'source empty (0 records).');
add('preprocess.dataMerge', 'n_ban_ghi_m_cot', '{{n}} bản ghi, {{m}} cột.', '{{n}} records, {{m}} columns.');
add('preprocess.dataMerge', 'dang_doc_sheet_x', 'Đang đọc sheet "{{x}}"...', 'Reading sheet "{{x}}"...');
add('preprocess.dataMerge', 'nhap_tay_x_ban_ghi_cot_y', 'Nhập tay: {{x}} bản ghi (cột "{{y}}").', 'Manual entry: {{x}} records (column "{{y}}").');
add('preprocess.dataMerge', 'dang_doc', 'đang đọc...', 'reading...');
add('preprocess.dataMerge', 'rong_bo_qua', 'rỗng, bỏ qua.', 'empty, skipped.');
add('preprocess.dataMerge', 'dang_kiem_tra_du_lieu_2', 'đang kiểm tra dữ liệu...', 'validating data...');
add('preprocess.dataMerge', 'co_n_loi_chan_bo_qua_file', 'có {{n}} lỗi chặn — bỏ qua file này.', '{{n}} blocking errors — skipping this file.');
add('preprocess.dataMerge', 'n_canh_bao_vd_anh_thieu_van_tiep_tuc', '{{n}} cảnh báo (vd ảnh thiếu).\nVẫn tiếp tục sinh file này?', '{{n}} warnings (e.g. missing images).\nStill generate this file?');
add('preprocess.dataMerge', 'da_bo_qua_do_con_canh_bao', 'đã bỏ qua do còn cảnh báo.', 'skipped due to remaining warnings.');
add('preprocess.dataMerge', 'loi_kiem_tra_du_lieu_bo_qua', 'lỗi kiểm tra dữ liệu — {{e}}. Bỏ qua.', 'data validation error — {{e}}. Skipped.');
add('preprocess.dataMerge', 'dang_sinh_n_ban_ghi', 'đang sinh {{n}} bản ghi...', 'generating {{n}} records...');
add('preprocess.dataMerge', 'loi_khong_co_ket_qua', 'lỗi không có kết quả.', 'error: no result.');
add('preprocess.dataMerge', 'loi_x', 'lỗi {{e}}', 'error {{e}}');
add('preprocess.dataMerge', 'hoan_thanh_ok_tren_tong_file_csv', 'Hoàn thành {{ok}}/{{total}} file CSV.', 'Completed {{ok}}/{{total}} CSV files.');
add('preprocess.dataMerge', 'loi_xu_ly_hang_loat', 'Lỗi xử lý hàng loạt: {{e}}', 'Batch processing error: {{e}}');
add('preprocess.dataMerge', 'kiem_tra_xong_n_canh_bao_can_xac_nhan', 'Kiểm tra xong: {{n}} cảnh báo — cần xác nhận trước khi sinh lô.', 'Check done: {{n}} warnings — confirmation needed before batch generation.');
add('preprocess.dataMerge', 'kiem_tra_xong_n_loi_chan_phai_khac_phuc', 'Kiểm tra xong: {{n}} lỗi chặn — phải khắc phục trước khi sinh lô.', 'Check done: {{n}} blocking errors — must fix before batch generation.');
add('preprocess.dataMerge', 'loi_kiem_tra_du_lieu_x', 'Lỗi kiểm tra dữ liệu: {{x}}', 'Data validation error: {{x}}');
add('preprocess.dataMerge', 'co_n_loi_chan_khong_the_sinh_lo', 'Có {{n}} lỗi chặn — không thể sinh lô. Mở mục "Kiểm tra trước khi chạy" để xem chi tiết.', '{{n}} blocking errors — cannot generate batch. Open "Check before running" for details.');
add('preprocess.dataMerge', 'phat_hien_n_canh_bao_vi_du_anh_thieu', 'Phát hiện {{n}} cảnh báo (ví dụ: ảnh biến đổi thiếu file).', 'Found {{n}} warnings (e.g. rule images missing files).');
add('preprocess.dataMerge', 'loi_xuat_bao_cao_loi_x', 'Lỗi xuất báo cáo lỗi: {{x}}', 'Error exporting error report: {{x}}');
add('preprocess.dataMerge', 'dang_mo_file_ket_qua_n_ban_ghi', 'Đang mở file kết quả ({{n}} bản ghi)...', 'Opening result file ({{n}} records)...');
add('preprocess.dataMerge', 'loi_sinh_file_pdf_x', 'Lỗi sinh file PDF: {{x}}', 'PDF generation error: {{x}}');
add('preprocess.dataMerge', 'placeholder_nhap_tay_moi_dong_1_ban_ghi', 'Mỗi dòng = 1 bản ghi.\nVí dụ:\nĐây là sản phẩm chính hãng của thương hiệu CCK\nMã 002\nMã 003', 'Each line = 1 record.\nExample:\nThis is a genuine product of the CCK brand\nCode 002\nCode 003');
add('preprocess.dataMerge', 'nhieu_dong_nhieu_trang', ', nhiều dòng → nhiều trang.', ', more lines → more pages.');
add('preprocess.dataMerge', 'field_can_dung_thi_gan_vao_cot', 'Field cần dùng thì gán vào cột', 'Assign the field you need to the column');
add('preprocess.dataMerge', 'muon_cung_1_noi_dung_co_dinh', '(Muốn cùng 1 nội dung cố định trên mọi trang thì gõ thẳng nội dung vào ô text của field.)', '(To keep the same fixed content on every page, type the content directly into the field text box.)');
add('preprocess.dataMerge', 'chon_sheet_n', 'Chọn sheet ({{n}})', 'Select sheet ({{n}})');
add('preprocess.dataMerge', 'sheet_phai_duoc_chia_se_cong_khai', 'Sheet phải được chia sẻ ở chế độ "Bất kỳ ai có đường liên kết". Dữ liệu được lấy qua đường export CSV của Google.', 'The sheet must be shared as "Anyone with the link". Data is fetched via Google\'s CSV export.');
add('preprocess.dataMerge', 'cac_cot_n', 'Các cột ({{n}}):', 'Columns ({{n}}):');
add('preprocess.dataMerge', 'cot_lay_tu_file_dau_de_map', 'Cột lấy từ file đầu để map. Map xong bấm nút "Chạy {{n}} file" ở dưới — mỗi file ra 1 tab đặt tên theo tên file CSV.', 'Columns are taken from the first file for mapping. When done, click "Run {{n}} files" below — each file opens a tab named after its CSV file.');
add('preprocess.dataMerge', 'moi_dong_mot_tem_binh_thuong_giong_khuon', '(mỗi dòng = một tem/thẻ/vé). Bình thường mọi bản giống khuôn, chỉ khác chữ điền vào. Phần này dùng khi', '(each line = one label/card/ticket). Normally every copy follows the same template, only the filled-in text differs. Use this part when');
add('preprocess.dataMerge', 'vi_du_ve_san_dau_vip', 'Ví dụ: vẽ sẵn dấu "VIP" lên thẻ → đặt', 'Example: pre-draw a "VIP" mark on the card → set');
add('preprocess.dataMerge', 'chi_khach_vip_moi_in_dau', 'Chỉ khách VIP mới in dấu; khách khác bỏ trống.', 'Only VIP guests print the mark; others leave it blank.');
add('preprocess.dataMerge', 'in_vang_bac', '... → in "Vàng" / "Bạc".', '... → print "Gold" / "Silver".');
add('preprocess.dataMerge', 'an_hien_co_in_khong_rule_in_cai_gi', 'Ẩn/hiện = "có in không?" · Rule = "in cái gì vào?". Không cần thì cứ để trống — field in bình thường.', 'Show/hide = "print or not?" · Rule = "print what?". If not needed, leave blank — the field prints normally.');
add('preprocess.dataMerge', 'gia_tri_cot_nay_se_duoc_in_vao_o', 'Giá trị cột này sẽ được in vào ô (mỗi bản in lấy theo dòng của nó).', 'This column value will be printed into the box (each copy takes its own row).');
add('preprocess.dataMerge', 'hoac_go_thang', 'Hoặc gõ thẳng', 'Or type');
add('preprocess.dataMerge', 'vao_vung_noi_dung_ben_duoi', 'vào vùng Nội dung bên dưới.', 'into the Content area below.');

// ─── tv() data fragments (bgRemover/upscale toast) ───
add('preprocess.bgRemover', '__tv_dang_tach_nen', 'Đang tách nền', 'Removing background');
add('preprocess.bgRemover', '__tv_loi_server', 'Lỗi Server', 'Server Error');
add('preprocess.bgRemover', '__tv_da_luu_thanh_cong', 'Đã lưu thành công', 'Saved successfully');
add('preprocess.bgRemover', '__tv_anh', 'ảnh!', 'images!');
add('preprocess.upscale', '__tv_dang_phong_to', 'Đang phóng to', 'Upscaling');

// ─── OcrTool missing tv() data label ───
add('preprocess.ocr', '__tv_khmer_anh', 'Khmer + Anh', 'Khmer + English');

fs.writeFileSync(VI, JSON.stringify(vi, null, 2) + '\n', 'utf8');
fs.writeFileSync(EN, JSON.stringify(en, null, 2) + '\n', 'utf8');
console.log('added grp_P keys');
