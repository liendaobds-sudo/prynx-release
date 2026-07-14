import fs from 'node:fs';
const VI = 'desktop/src/i18n/locales/vi.json', EN = 'desktop/src/i18n/locales/en.json';
const vi = JSON.parse(fs.readFileSync(VI,'utf8')), en = JSON.parse(fs.readFileSync(EN,'utf8'));
const add = (ns,k,v,e) => { vi[ns]=vi[ns]||{}; en[ns]=en[ns]||{}; if(vi[ns][k]!==undefined && vi[ns][k]!==v){console.warn('WARN differs',ns,k);} vi[ns][k]=v; en[ns][k]=e; };

// ── ParamPanel.tsx (ns dieline.param) ──
add('dieline.param','ngang','Ngang','Horizontal');
add('dieline.param','thong_so_nang_cao','Thông số nâng cao','Advanced settings');
add('dieline.param','thong_so_tui_giay','Thông số túi giấy','Paper bag settings');

// ── MockupArtworkPanel.tsx (ns dieline.mockupArtwork) ──
add('dieline.mockupArtwork','xoay','Xoay','Rotate');
add('dieline.mockupArtwork','ngang','⇋ Ngang','⇋ Horizontal');
add('dieline.mockupArtwork','label_keo_tha_anh_vao_day','{{label}}: kéo-thả ảnh vào đây hoặc bấm để chọn','{{label}}: drag & drop an image here or click to select');
add('dieline.mockupArtwork','keo_tha_bam_de_tai','Kéo-thả hoặc bấm để tải {{label}}','Drag & drop or click to upload {{label}}');
add('dieline.mockupArtwork','xoa_label','Xoá {{label}}','Delete {{label}}');
add('dieline.mockupArtwork','mat_na_se_duoc_co_gian','Mặt nạ {{iw}}×{{ih}}px sẽ được co giãn về bề mặt {{sw}}×{{sh}}px.','The {{iw}}×{{ih}}px mask will be scaled to the {{sw}}×{{sh}}px surface.');
add('dieline.mockupArtwork','kich_thuoc_mat_na_phai_khop','Kích thước mặt nạ phải khớp bề mặt {{w}}×{{h}} px.','Mask size must match the surface {{w}}×{{h}} px.');

// ── DielineCanvas2D.tsx (ns dieline.dielineCanvas2D) ── (an/hien đã có)
add('dieline.dielineCanvas2D','kich_thuoc','kích thước','dimensions');
add('dieline.dielineCanvas2D','kho_trai','Khổ trải:','Unfolded size:');
add('dieline.dielineCanvas2D','anh','Ảnh','Image');
add('dieline.dielineCanvas2D','ten_mat','Tên mặt','Face names');
add('dieline.dielineCanvas2D','doan_cat','Đoạn cắt','Cut segments');
add('dieline.dielineCanvas2D','chu_thich_diem','Chú thích điểm','Point annotations');

// ── NestingCanvas.tsx (ns dieline.nestingCanvas) ──
add('dieline.nestingCanvas','to_giay','Tờ giấy:','Sheet:');
add('dieline.nestingCanvas','khay_vo','Khay: {{khay}} · Vỏ: {{vo}}','Tray: {{khay}} · Sleeve: {{vo}}');
add('dieline.nestingCanvas','khay_kich_thuoc','🧱 Khay · {{w}}×{{h}}','🧱 Tray · {{w}}×{{h}}');
add('dieline.nestingCanvas','vo_bao_kich_thuoc','📦 Vỏ bao · {{w}}×{{h}}','📦 Sleeve · {{w}}×{{h}}');
add('dieline.nestingCanvas','to_giay_kich_thuoc','Tờ giấy: {{w}} × {{h}} mm','Sheet: {{w}} × {{h}} mm');
add('dieline.nestingCanvas','khuon_to_su_dung','{{n}} khuôn / tờ · {{u}}%','{{n}} dies / sheet · {{u}}%');
add('dieline.nestingCanvas','can_nhip_mm','Cắn nhíp ({{n}}mm)','Gripper ({{n}}mm)');

// ── NestingPanel.tsx (ns dieline.nesting) ──
add('dieline.nesting','cao','Cao','Height');
add('dieline.nesting','xoay_90','↰ Xoay 90°','↰ Rotate 90°');
add('dieline.nesting','ngang','▭ Ngang','▭ Landscape');
add('dieline.nesting','khay','Khay','Tray');
add('dieline.nesting','vo_bao_kich_thuoc','📊 Vỏ bao ({{w}}×{{h}})','📊 Sleeve ({{w}}×{{h}})');
add('dieline.nesting','to_2','{{n}} tờ','{{n}} sheets');
add('dieline.nesting','du_thua_hop','+{{n}} hộp ({{pct}}%)','+{{n}} boxes ({{pct}}%)');

// ── FlipbookDialog.tsx (ns misc.flipbookDialog) ──
add('misc.flipbookDialog','xem_truoc_thanh_pham','📖 Xem Trước Thành Phẩm','📖 Product Preview');
add('misc.flipbookDialog','trang_tep','Trang {{trang}} | Tép {{tep}}','Page {{trang}} | Signature {{tep}}');
add('misc.flipbookDialog','trang_n','Trang {{n}}','Page {{n}}');

// ── FlipBook.tsx (tv reverse-map cần chuỗi "Trang" đơn) — 'Trang bìa' đã có ──
add('misc.flipBook','trang','Trang','Page');

// ── SheetViewerDialog.tsx (ns misc.sheetViewerDialog) ── (trong/to_bia/tep_2 đã có)
add('misc.sheetViewerDialog','nhip_in_mm','Nhíp in: {{n}}mm','Gripper: {{n}}mm');
add('misc.sheetViewerDialog','can_nhip_mm','Cắn nhíp ({{n}}mm)','Gripper ({{n}}mm)');
add('misc.sheetViewerDialog','to_x_y','Tờ {{x}}/{{y}}','Sheet {{x}}/{{y}}');
add('misc.sheetViewerDialog','tep_sig_to_x_y','Tép {{sig}} — Tờ {{x}}/{{y}}','Signature {{sig}} — Sheet {{x}}/{{y}}');
add('misc.sheetViewerDialog','tep_sig','Tép {{n}}','Signature {{n}}');
add('misc.sheetViewerDialog','to_in_n','Tờ in {{n}}','Plate {{n}}');
add('misc.sheetViewerDialog','trang_n','Trang {{n}}','Page {{n}}');

fs.writeFileSync(VI, JSON.stringify(vi,null,2)+'\n','utf8');
fs.writeFileSync(EN, JSON.stringify(en,null,2)+'\n','utf8');
console.log('added grp_D keys');
