import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(process.cwd());
const EN = path.join(ROOT, 'desktop/src/i18n/locales/en.json');
const en = JSON.parse(fs.readFileSync(EN, 'utf8'));

const T = {
  'imposition.gridSettings': {
    '0_xep_toi_da_tren_1_to': '0 = Max fit on 1 sheet',
    '1_mat': 'Single-sided:',
    '1_mat_2': 'Single-sided',
    '2_mat': 'Double-sided:',
    '2_mat_2': 'Double-sided',
    bat_xem_truoc_bleed: 'Enable Bleed Preview',
    binh_2_mat_bat_buoc_so_trang: '⚠️ Double-sided imposition requires page count',
    binh_hanh: 'Parallelogram',
    binh_trang_s_r: 'Step & Repeat (S&R)',
    bo_tri_cut_stack_cung_mot_vi_tri_o_tren: 'Cut-stack layout: the same cell position across all sheets forms one stack.\n                              Cut the stacks apart then stack them → correct page order 1, 2, 3… (book/notebook collation).',
    boi_cot_so_luong_trong_excel_ctrl_c_dan: 'Highlight the quantity column in Excel → Ctrl+C → paste here\\n(one number per line, matching page order)',
    bua: 'Hammer',
    cach_thuc_rap: 'ASSEMBLY METHOD',
    cach_thuc_rap_2: 'Assembly method',
    cach_xep: 'LAYOUT',
    cach_xep_2: 'Layout',
    cai_dat_so_luong_in_rieng_cho_tung: 'Set a separate print quantity for each page',
    chan: 'even',
    chia_coc_xen: '"Guillotine batching"',
    chia_ty_le_xep_chong: 'Proportional split + stacking',
    chia_ty_le_xep_chong_nhieu_mau_sl_rieng: 'Proportional split + stacking (multiple designs, per-design quantities)',
    cot: 'Columns',
    da_dien_parsed_quantities_length_trang: 'Filled ${parsed.quantities.length} pages.',
    da_hieu: 'Got it',
    dac_biet: 'Special',
    dan_nhieu_mau_n_up: 'Multi-design layout (N-Up)',
    dan_so_luong_tu_excel: 'Paste quantities from Excel',
    dien_so_luong: 'Enter quantities',
    dong: 'Rows',
    ghep_nhieu_mau_thiet_ke_hoac_nhieu: 'Combine multiple designs or different document pages\n                            onto the same print sheet (e.g. gang-printing several\n                            business card designs for different people).',
    hinh_dang_tem: 'LABEL SHAPE',
    hinh_dang_tem_2: 'Label shape',
    hinh_thang: 'Trapezoid',
    ho_tem: 'LABEL GAP',
    khac_voi: 'Different from',
    khoang_ho_giua_cac_nhan_gap: 'Gap between labels (Gap)',
    luc_giac: 'Hexagon',
    luoi_don_gian: 'Simple grid',
    mac_dinh: 'Default',
    moi_san_pham_cap_trang_1_2_3_4_cung_mot: 'each product = a page pair (1–2, 3–4…).\n                              Same cell: front on even sheet, back on odd sheet (mirror flip).\n                              File should have a page count',
    mui_ten: 'Arrow',
    neu_thay_hinh_dang_tu_nhan_dien_chua: 'If the auto-detected shape looks incorrect, you\n                            can re-select it in this list so imposition works\n                            as accurately as possible.',
    ngu_giac: 'Pentagon',
    nhan_ban_mot_mau_thiet_ke_lap_lai_nhieu: 'Duplicate one design repeatedly on the\n                            same print sheet (e.g. print one label type or one\n                            business card type to fill the sheet).',
    nhieu_mau_cung_co_so_luong_khac_nhau: 'Multiple designs of the same size, different quantities: each design takes cells proportional to its quantity.\n                              Every sheet is identical → cut the whole stack for one clean bundle per type. File exports 1 sample sheet; print the number of sheets shown.',
    o_thiet_lap_mo_rong_cai_do_chia_to: 'in Advanced settings: that splits the sheet into multiple stacks + leaves knife gutters so the cutter makes fewer cuts, and is UNRELATED to page order.',
    sl_moi_loai: 'QTY PER TYPE',
    sl_thuc: 'Actual qty',
    so_con_in_thuc_te_tem_to_so_to_in_luon: 'Actual printed count = labels/sheet × sheets printed (always exceeds ordered qty)',
    so_luong: 'QUANTITY',
    so_luong_2: 'Quantity',
    so_mat: 'SIDES',
    so_tem_san_pham_binh_duoc_tren_moi_to: 'Number of labels (products) imposed per print sheet',
    so_to: 'Sheets',
    sp_productidx_1_mat_idx_1_idx_2: 'Product ${productIdx + 1} (sides ${idx + 1}–${idx + 2})',
    ta_tay: 'Dumbbell',
    tac_vu: 'TASK',
    tac_vu_2: 'Task',
    tam_giac: 'Triangle',
    tat_xem_truoc_bleed: 'Disable Bleed Preview',
    tem_to: 'Labels/sheet',
    tong_so_to_du_kien: 'ESTIMATED TOTAL SHEETS:',
    tool_se_tu_dong_nhan_dien_da_so_cac: 'The tool auto-detects most label shapes\n                            from your PDF design file.',
    trang_1_2_3_lien_tiep_theo_sl_het_loai: 'pages 1, 2, 3… in sequence by quantity (finish one type before the next).\n                              Empty = fill 1 sheet.',
    trang_hien_tai_vieweractivepage: 'Current page: ${viewerActivePage}',
    tron_elip: 'Circle / Ellipse',
    trong_tu_dong_lap_day_1_to: 'Empty = Auto-fill 1 sheet',
    tu_dong_tinh_hang_cot_nhung_khong_xoay: 'Auto-computes rows and columns but does not rotate labels. Suits keeping the original design orientation.',
    tu_dong_tinh_toan_so_hang_cot_va_huong: 'Auto-computes the optimal rows, columns and rotation to fill the sheet with as many labels as possible.',
    tu_nhap_so_hang_va_cot_theo_y_muon: 'Manually enter rows and columns as desired.',
    tuy_chinh: 'Custom',
    vuong_chu_nhat: 'Square / Rectangle',
    xep_chong: 'Stacking',
    xep_chong_up_xap_dung_thu_tu: 'Stacking (collate in correct order)',
    xep_lan_luot: 'Sequential layout',
    xep_toi_uu: 'Optimal layout',
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
