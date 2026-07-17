import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(process.cwd());
const EN = path.join(ROOT, 'desktop/src/i18n/locales/en.json');
const en = JSON.parse(fs.readFileSync(EN, 'utf8'));

const T = {
  'preprocess.numbering': {
    '1_cau_hinh_day_so': '1. Configure number sequence',
    '2_keo_tha_len_trang_pdf': '2. Drag & drop onto the PDF page',
    '3_phuong_thuc_phan_bo': '3. Distribution method',
    bat_dau_tu: 'Start from',
    bat_dau_tu_so: 'Start from number',
    bo_bat_dau_ky_tu_so: 'Starting set (character/number)',
    buoc_nhay: 'Step',
    can_le: 'Alignment',
    cau_truc_hien_thi: 'Display structure',
    che_do_tuyen_tinh_danh_so_tu_trai_sang: 'Linear mode: number from left to right, page after page in the normal way.',
    che_do_xep_chong_cut_stack_so_se_nhay: 'Cut & Stack mode: numbers jump across pages. After printing, cut the stack in half and pile the halves — the numbers then run continuously.',
    chieu_dai_co_dinh: 'Fixed length:',
    chu_u_u_shape: 'U-Shape',
    chua_co_file_pdf_goc: 'No source PDF file.',
    co_chu: 'Font size',
    dang_day_du_lieu_len_may_chu_csvdata: 'Uploading data to the server (${csvData.length} pages)...',
    dang_tinh_toan_ma_tran_so: 'Computing number matrix...',
    dang_xu_ly: 'Processing...',
    day_so_1_2_3: 'Number sequence (1, 2, 3...)',
    day_so_trong: 'Number sequence is empty.',
    day_so_trong_vui_long_kiem_tra_lai: 'Number sequence is empty. Please check the settings.',
    dem_so_0_vao_dau: 'Zero-pad at the start',
    den_so: 'To number',
    dong_leading: 'Line (Leading)',
    font_chu_font_family: 'Font (Font Family)',
    giua: 'Center',
    group_nhom: 'Group',
    hau_to: 'Suffix',
    hoan_thanh_da_ghi_de_file_hien_tai: 'Done! Overwrote the current file.',
    hoan_thanh_da_tao_tab_pdf_moi: 'Done! Created a new PDF tab.',
    keo_cong_cu_duoi_day_tha_vao_cac_vi_tri: 'Drag the tool below and drop it at the positions you want to number on the PDF screen.',
    keo_tha_it_nhat_1_slot_len_man_hinh_de: 'Drag & drop at least 1 slot onto the screen to preview.',
    khoang_cach_tracking: 'Spacing (Tracking)',
    khong_nhan_duoc_file_ket_qua_tu_may_chu: 'No result file received from the server',
    loi_cau_hinh_day_so: 'Number sequence configuration error.',
    loi_error_message: 'Error: ${error.message}',
    mau_chu: 'Text color',
    mau_cmyk: 'CMYK color',
    mo_ket_qua_sang_tab_moi_thay_vi_de_file: 'Open result in a new tab (instead of overwriting the current file)',
    net_font_font_style: 'Font weight (Font Style)',
    nhap_chuoi_mau_phan_mem_se_tu_tach_tien: 'Enter a sample string; the software will auto-split prefix, number and suffix.',
    nhay_so_tu_dong: 'AUTO NUMBERING',
    phai: 'Right',
    phan_bo_trang: 'Page distribution',
    quay_lai: 'Back',
    quet_theo_cot_n: 'Scan by column (N)',
    quet_theo_hang_z: 'Scan by row (Z)',
    selectedfieldids_length_truong: '${selectedFieldIds.length} fields',
    so_luong_bo: 'Number of sets',
    so_luong_ve_bo: 'Tickets per set',
    theo_bo_a_01_b_01: 'By set (A-01, B-01)',
    theo_thu_tu_linear: 'In order (Linear)',
    thu_tu_doc_sorting: 'Reading order (Sorting)',
    tien_to: 'Prefix',
    trai: 'Left',
    trich_xuat_tu_dong_smart_extract: 'Auto extraction (Smart Extract)',
    ungroup_bo_nhom: 'Ungroup',
    vi_du_no_00123_vip: 'Example: No.00123-VIP',
    vi_tri_nhay_so_slot: 'Numbering position (Slot)',
    vong_tron_clockwise: 'Circular (Clockwise)',
    vui_long_keo_it_nhat_1_truong_nhay_so: 'Please drag at least 1 numbering field onto the PDF.',
    xao_tron_ngau_nhien_lam_ve_boc_tham: 'Random shuffle (for raffle tickets)',
    xep_chong_stacked: 'Stacked',
    xoa_truong_nay: 'Delete this field',
    huong_dan_su_dung: 'How to use',
    huong_dan_nhay_so: 'Numbering guide',
    dong: 'Close',
    da_hieu: 'Got it',
    help_intro: 'Auto Numbering fills a sequence of numbers/tickets onto the positions you place on the PDF page, then prints many sheets. Use it for lottery tickets, gift vouchers, serial-numbered stamps, invoices...',
    help_slot_tieu_de: 'What is a Slot?',
    help_slot_noi_dung: 'Each box you drop onto the page is a Slot. A single sheet can hold many Slots (many tickets/stamps at once). The software spreads the number sequence into the Slots by reading order, then moves to the next sheet. You can Group several fields into one Slot so they all receive the same number.',
    help_che_do_tieu_de: 'Two generation modes',
    help_che_do_range: 'Count continuously from a start number to an end number by a step. Example 1 → 1000. Add prefix/suffix and zero-padding if needed (No.0001).',
    help_che_do_set: 'Split into multiple sets, each set restarting from the beginning. Example A-01…A-50, B-01…B-50. Use the display structure {%b} for the set and {%t} for the sequence number.',
    help_sort_tieu_de: 'Reading order (Sorting)',
    help_sort_noi_dung: 'Decides which direction the numbers run when there are many Slots on a sheet: by Row (Z), by Column (N), U-shape, or circular. Pick the right one so numbers increase in the direction you want on the printed sheet.',
    help_phanbo_tieu_de: 'Linear vs Stacked — IMPORTANT',
    help_phanbo_linear: 'Numbers run in order on each sheet: sheet 1 carries 1,2,3…; sheet 2 carries the next numbers. After printing, stack in sheet order and it reads correctly right away.',
    help_phanbo_stack: 'For cut & stack machines: numbers jump across sheets so that after printing, when you cut the paper stack and pile the halves, the numbers run continuously within each pile. Choosing this mode wrongly will make the numbers jump around after cutting.',
    help_ghi_chu: 'Tip: check the Preview panel below to verify the first few sheets before creating the file. Enable Random shuffle for raffle tickets.',
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
