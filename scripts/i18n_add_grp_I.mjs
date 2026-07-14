import fs from 'node:fs';
const VI = 'desktop/src/i18n/locales/vi.json', EN = 'desktop/src/i18n/locales/en.json';
const vi = JSON.parse(fs.readFileSync(VI,'utf8')), en = JSON.parse(fs.readFileSync(EN,'utf8'));
const add = (ns,k,v,e) => { vi[ns]=vi[ns]||{}; en[ns]=en[ns]||{}; if(vi[ns][k]!==undefined && vi[ns][k]!==v){console.warn('WARN differs',ns,k);} vi[ns][k]=v; en[ns][k]=e; };

// ── imposition.advancedSettings ──
add('imposition.advancedSettings','file_co_n_trang_le_binh_2_mat_can_so_trang_chan',
  '⚠️ File có {{n}} trang (lẻ) — bình 2 mặt cần số trang CHẴN.',
  '⚠️ File has {{n}} pages (odd) — double-sided imposition needs an EVEN page count.');
add('imposition.advancedSettings','moi_loai_nam_1_coc_rieng_coc_rong_hep',
  'Mỗi loại nằm 1 cọc riêng, cọc rộng hẹp theo số lượng, có bộ dấu xén riêng.',
  'Each type goes in its own stack, stack width scaled by quantity, with its own trim marks.');
add('imposition.advancedSettings','xem_truoc_se_in_o',
  '📋 Xem trước — sẽ in ở {{pos}}',
  '📋 Preview — will print at {{pos}}');
add('imposition.advancedSettings','xong','Xong','Done');

// ── imposition.autoCatalog ──
add('imposition.autoCatalog','in_nhanh_digital','⚡ In Nhanh (Digital)','⚡ Quick Print (Digital)');
add('imposition.autoCatalog','in_offset','🏭 In Offset','🏭 Offset Print');
add('imposition.autoCatalog','tay_toi_uu_hieu_suat',
  '✓ Tay tối ưu: {{label}} (Hiệu suất: {{pct}}%)',
  '✓ Optimal signature: {{label}} (Efficiency: {{pct}}%)');

// ── imposition.cutExport ──
add('imposition.cutExport','con','con','pcs');
add('imposition.cutExport','con_to_x_to','({{perSheet}} con/tờ × {{sheets}} tờ)','({{perSheet}} pcs/sheet × {{sheets}} sheets)');
add('imposition.cutExport','da_gui_detail_bytes','Đã gửi: {{detail}} ({{bytes}} bytes)','Sent: {{detail}} ({{bytes}} bytes)');
add('imposition.cutExport','dang_gui_to_k_total','Đang gửi tờ {{k}}/{{total}}...','Sending sheet {{k}}/{{total}}...');
add('imposition.cutExport','gui_tat_ca_n','Gửi tất cả ({{n}})','Send all ({{n}})');
add('imposition.cutExport','lop','Lớp: {{l}}','Layer: {{l}}');
add('imposition.cutExport','n_trang_khuon_suffix',' — {{n}} trang khuôn',' — {{n}} die pages');
add('imposition.cutExport','to_k_loi','Tờ {{k}} lỗi','Sheet {{k}} failed');
add('imposition.cutExport','to_x_y','Tờ {{x}} / {{y}}','Sheet {{x}} / {{y}}');
add('imposition.cutExport','xong_ok_total_to','Xong: {{ok}}/{{total}} tờ.','Done: {{ok}}/{{total}} sheets.');

// ── imposition.cutterMachines ──
add('imposition.cutterMachines','cau_hinh_ket_noi_kenh_gui_ip_thu_muc_cho_tung_may',
  'Cấu hình kết nối (kênh gửi / IP / thư mục) cho từng máy. Thêm máy mới cho các dòng máy khác nhau (Trung Quốc, HPGL...). Khi bấm "Gửi Máy Bế", chọn máy là tự dùng cấu hình ở đây.',
  'Configure the connection (send channel / IP / folder) for each machine. Add new machines for different machine lines (China, HPGL...). When you click "Send to Cutter", picking a machine automatically uses the config here.');
add('imposition.cutterMachines','sua_may','Sửa máy: {{model}}','Edit machine: {{model}}');
add('imposition.cutterMachines','xoa_may_x','Xóa máy "{{id}}"?','Delete machine "{{id}}"?');

// ── imposition.gridPreview ──
add('imposition.gridPreview','suc_chua','Sức chứa:','Capacity:');
add('imposition.gridPreview','tem_to','tem/tờ','labels/sheet');
add('imposition.gridPreview','can_in','Cần in:','To print:');
add('imposition.gridPreview','to','tờ','sheets');
add('imposition.gridPreview','1_to_mau_x_ban','(1 tờ mẫu × {{n}} bản)','(1 master sheet × {{n}} copies)');
add('imposition.gridPreview','hang_ngang','hàng ngang','rows');
add('imposition.gridPreview','cot_doc','cột dọc','columns');
add('imposition.gridPreview','n_loai_moi_loai_1_coc_rieng_in_to',
  '{{n}} loại · mỗi loại 1 cọc riêng ({{dir}}, bề rộng theo số lượng) · in {{sheets}} tờ',
  '{{n}} types · each in its own stack ({{dir}}, width by quantity) · print {{sheets}} sheets');
add('imposition.gridPreview','n_loai_tron_theo_ty_le_in_to',
  '{{n}} loại trộn theo tỷ lệ số lượng · in {{sheets}} tờ',
  '{{n}} types mixed by quantity ratio · print {{sheets}} sheets');
add('imposition.gridPreview','khong_du_cho_tren_to_cho_trang_tach',
  'Không đủ chỗ trên tờ cho trang {{pages}} — nên tách sang bài in khác.',
  'Not enough room on the sheet for page {{pages}} — should split into another print job.');

// ── imposition.gridSettings ──
add('imposition.gridSettings','da_dien_n_trang','Đã điền {{n}} trang.','Filled {{n}} pages.');
add('imposition.gridSettings','trang_hien_tai','Trang hiện tại: {{n}}','Current page: {{n}}');
add('imposition.gridSettings','nhan_ban_mot_mau_thiet_ke_lap_lai',
  'Nhân bản một mẫu thiết kế lặp lại nhiều lần trên cùng một tờ in (VD: in 1 loại tem, 1 loại card visit lấp đầy tờ in).',
  'Duplicate one design repeated many times on the same sheet (e.g. print 1 label type or 1 business card filling the sheet).');
add('imposition.gridSettings','ghep_nhieu_mau_thiet_ke_hoac_nhieu_trang',
  'Ghép nhiều mẫu thiết kế hoặc nhiều trang tài liệu khác nhau vào cùng một tờ in (VD: in ghép nhiều loại card visit của nhiều người khác nhau).',
  'Combine several designs or different document pages onto the same sheet (e.g. gang-print business cards for several different people).');
add('imposition.gridSettings','trang_1_2_3_lien_tiep_theo_sl_het_loai',
  'trang 1, 2, 3… liên tiếp theo SL (hết loại này mới sang loại kia). Trống = lấp đầy 1 tờ.',
  'pages 1, 2, 3… in sequence by quantity (finish one type before the next). Blank = fill 1 sheet.');
add('imposition.gridSettings','moi_san_pham_cap_trang_cung_o_mat_truoc',
  'mỗi sản phẩm = cặp trang (1–2, 3–4…). Cùng một ô: mặt trước tờ chẵn, mặt sau tờ lẻ (lật gương). File nên có số trang',
  'each product = a page pair (1–2, 3–4…). Same slot: front on even sheet, back on odd sheet (mirror flip). File should have a page count of');
add('imposition.gridSettings','bo_tri_cut_stack_cung_mot_vi_tri_o_tren',
  'Bố trí cut-stack: cùng một vị trí ô trên mọi tờ tạo một cọc. Xén rời cọc rồi úp chồng → đúng thứ tự trang 1, 2, 3… (collation sách/sổ).',
  'Cut-stack layout: the same slot position across all sheets forms a stack. Trim the stacks apart then pile them → correct page order 1, 2, 3… (book/notebook collation).');
add('imposition.gridSettings','nhieu_mau_cung_co_so_luong_khac_nhau_moi',
  'Nhiều mẫu cùng cỡ, số lượng khác nhau: mỗi mẫu chiếm số ô theo tỷ lệ số lượng. Mọi tờ giống hệt nhau → xén cả chồng ra mỗi loại một xấp sạch. File xuất 1 tờ mẫu; in đúng số tờ hiển thị.',
  'Several same-size designs with different quantities: each takes a slot count proportional to its quantity. Every sheet is identical → trim the whole pile into one clean stack per type. File exports 1 master sheet; print the number of sheets shown.');
add('imposition.gridSettings','tool_se_tu_dong_nhan_dien_da_so_cac_loai',
  'Tool sẽ tự động nhận diện đa số các loại hình dạng tem từ file thiết kế PDF của bạn.',
  'The tool automatically detects most label shapes from your PDF design file.');
add('imposition.gridSettings','neu_thay_hinh_dang_tu_nhan_dien_chua',
  'Nếu thấy hình dạng tự nhận diện chưa chính xác, bạn có thể tự chọn lại trong danh sách này để quá trình bình trang hoạt động chính xác nhất.',
  'If the auto-detected shape looks wrong, you can reselect it from this list so imposition works as accurately as possible.');
add('imposition.gridSettings','file_hien_n_trang_le_them_xoa_1_trang',
  '. File hiện {{n}} trang (lẻ) — thêm/xóa 1 trang ở thumbnail, hoặc chọn 1 Mặt.',
  '. File currently has {{n}} pages (odd) — add/remove 1 page in the thumbnails, or choose Single-sided.');
add('imposition.gridSettings','boi_cot_so_luong_trong_excel_ctrlc_dan_vao_day',
  'Bôi cột số lượng trong Excel → Ctrl+C → dán vào đây\n(mỗi dòng 1 số, theo đúng thứ tự trang)',
  'Highlight the quantity column in Excel → Ctrl+C → paste here\n(one number per line, in page order)');
add('imposition.gridSettings','de_trong_de_dung_chung_so_luong',
  'Để trống để dùng chung số lượng',
  'Leave blank to use the shared quantity');
add('imposition.gridSettings','trang','Trang','Page');
add('imposition.gridSettings','sp_n_trang_m','SP {{n}} (trang {{m}})','Item {{n}} (page {{m}})');
add('imposition.gridSettings','sp_n_mat_a_b','SP {{n}} (mặt {{a}}–{{b}})','Item {{n}} (side {{a}}–{{b}})');
add('imposition.gridSettings','trang_n','Trang {{n}}','Page {{n}}');

// ── imposition.imposerDashboard ──
add('imposition.imposerDashboard','binh_2_mat_bat_buoc_so_trang_chan_file_hien_le',
  'Bình 2 mặt bắt buộc số trang chẵn. File hiện {{n}} trang (lẻ) — thêm/xóa 1 trang ở thumbnail, hoặc chọn 1 Mặt.',
  'Double-sided imposition requires an even page count. File currently has {{n}} pages (odd) — add/remove 1 page in the thumbnails, or choose Single-sided.');

// ── imposition.nupSettings ──
add('imposition.nupSettings','xen_coc_roi_up_dung_thu_tu_trang_1_mat',
  'Xén cọc rồi úp đúng thứ tự trang (1 mặt). Không dùng với 2 mặt.',
  'Trim the stacks then pile them in page order (single-sided). Not for double-sided.');

// ── imposition.paperSettingsUI ──
add('imposition.paperSettingsUI','ten_kho_giay_label','Tên Khổ Giấy','Paper Size Name');

// ── imposition.presetSelector ──
add('imposition.presetSelector','da_cap_nhat_preset_x_bang_thiet_lap_hien_tai',
  'Đã cập nhật preset "{{name}}" bằng thiết lập hiện tại.',
  'Updated preset "{{name}}" with the current settings.');

// ── imposition.productFirst ──
add('imposition.productFirst','cao','cao','height');

fs.writeFileSync(VI, JSON.stringify(vi,null,2)+'\n','utf8');
fs.writeFileSync(EN, JSON.stringify(en,null,2)+'\n','utf8');
console.log('added grp_I keys');
