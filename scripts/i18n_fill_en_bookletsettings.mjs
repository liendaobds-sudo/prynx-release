import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(process.cwd());
const EN = path.join(ROOT, 'desktop/src/i18n/locales/en.json');
const en = JSON.parse(fs.readFileSync(EN, 'utf8'));

const T = {
  'imposition.bookletSettings': {
    '1_cuon_to_100': '1 booklet / sheet (100%)',
    '1_cuon_to_bop_vua_kho': '1 booklet / sheet (scale to fit)',
    '2_nua_cuon_tren_1_to_xen_doi_rap_lai': '2 half-booklets on 1 sheet, cut in half and assembled into 1 complete booklet.',
    '2_truoc_sau': '2 (front + back)',
    '2_up_classic_mac_dinh': '2-Up Classic (Default)',
    '4_truoc_01_n_1_sau': '4 (front, 01, N-1, back)',
    bam_kim_giua_saddle_stitched: 'Saddle stitched',
    binh_thuong: 'Normal',
    boi_so_cua_4: 'Multiple of 4',
    bu_phan_bi_keo_chi_che: 'Compensate for glue/thread coverage',
    cac_trang_xep_noi_tiep_lien_mach_1_2_3: 'Pages laid out sequentially (1-2, 3-4). For milled perfect-bound or coil-bound spines.',
    cat_doi_rap_xap_half_split: 'Half-Split assembly',
    cat_giua_to_in_lam_doi_de_rap_up_len: 'Cut the sheet in half then stack face-to-face into standard order (tickets, vouchers).',
    chia_file_thanh_nhieu_tep_nho_bang_nhau: 'Split the file into equal signatures then stack them. Suitable for thread-sewn spine binding.',
    co_che_mac_dinh: 'Default mechanism',
    co_che_rap_xap_cut_stack: 'CUT & STACK MECHANISM',
    cut_stack_cat_doi_rap_xap: 'Cut & Stack (cut in half, stack):',
    dan_deu_2_ben_chia_deu_tao_khoang_ho: 'Spread evenly to both sides (even split, larger gap at center) instead of pulling tight to the spine',
    dan_doi_lung_flush_mount: 'Flush Mount',
    ghep_nua_cuon_cut_stack: 'Half-booklet assembly (Cut & Stack)',
    giong_tro_nhip_nhung_cong_them_xoay: 'Same as Work & Tumble but with an added 180° rotation on the back.',
    giu_nguyen_kich_thuoc_trang_khong_vua: 'Keep original page size. If it does not fit the sheet → error (no auto-scaling).',
    ho_doc_gap_y: 'Vertical Gap (Gap Y)',
    hut_gay_xen_up: 'Pull to spine & face-up trim',
    hut_gay_xen_up_doi_xung_180: 'Pull to spine & face-up trim (180° symmetric)',
    in_1_bo_tu_tro_lat_nhip_work_tumble: 'Print one set self-turning (Work & Tumble). For large books printed on a small plate.',
    keo_gay_lo_xo_perfect_bound: 'Perfect Bound / Coil',
    khau_chi_chia_tep_thread_sewn: 'Thread sewn / Signatures',
    khoang_cach_gay_gap_x: 'Spine gap (Gap X)',
    khoang_ho_cum_trang_gap: 'PAGE CLUSTER GAP',
    kieu_dong_sach: 'BINDING STYLE',
    le_gay_mm: 'Spine margin (mm):',
    long_toan_bo_trang_thanh_1_cuon_duy: 'Nest all pages into a single booklet. The outermost cover shares the sheet.',
    luoi_2_2_spreads_8_con_mat_in_2_tay_4: 'Grid of 2×2 spreads (8-up/side). Prints two 4-page signatures on one plate.',
    luoi_2_2_spreads_8_con_mat_tieu_chuan: 'Grid of 2×2 spreads (8-up/side). Industry standard.',
    luoi_2_2_spreads_8_con_mat_tu_tro_lat: 'Grid of 2×2 spreads (8-up/side). Self work-and-turn, 1 plate = one 8-page signature.',
    mat_truoc_binh_thuong_mat_sau_lon_nguoc: 'Front normal, back flipped in sheet order.',
    nhan_ban_booklet_2_up_len_kho_lon_khong: 'Step & repeat a 2-up booklet onto a large sheet. No offset fold scheme.',
    nhan_ban_nhieu_cuon_giong_het_nhau_lap: 'Step & repeat identical booklets to fill a large sheet. Trim into multiple booklets.',
    nhieu_cuon_to_step_repeat: 'Multiple booklets / sheet (Step & Repeat)',
    ra_het_mat_truoc_roi_den_mat_sau: 'All fronts first, then all backs.',
    sach_mo_phang_180_do_in_1_mat_moi_to: 'Book lies flat at 180°. Single-sided print, each sheet holds one continuous spread (1-2, 3-4...).',
    se_tu_dong_xoay_180_coc_ben_phai_de_dam: 'will automatically rotate the right stack 180° so that when the two stacks are placed face-to-face, the trim margins are perfectly symmetric and the crop marks match 100%. No manual flipping needed!',
    so_cuon_tren_to_in: 'BOOKLETS PER SHEET',
    so_do_gap_offset_fold_pattern: 'OFFSET FOLD SCHEME (FOLD PATTERN)',
    so_trang_bia: 'Cover page count:',
    so_trang_moi_tep_tay_sach: 'Pages per signature:',
    tach_bia_rieng: 'Separate cover',
    tach_rieng: 'Separate',
    tan_deu_cac_trang_tren_mat_giay_khong: 'Spread pages evenly across the sheet, no rotation. Suitable for cut-apart trimming.',
    tay_16_trang_in_2_mat: '16-Page Signature (Double-sided)',
    tay_4_trang_1_bo_kho_lon: '4-Page Signature (1 set, large format)',
    tay_4_trang_nhan_ban_2_up: '4-Page Signature (2-Up step & repeat)',
    tay_8_trang_tu_tro: '8-Page Signature (Work & Turn)',
    the_phoi_sap_trang: 'Layout scheme / Page ordering',
    thu_noi_dung_cho_vua_kho_giay_da_chon: 'Scale content to fit the selected sheet, centered.',
    trai_deu_giu_nguyen_chieu: 'Spread evenly (keep orientation)',
    trai_deu_truoc_sau_xen_ke: 'Spread evenly, front-back interleaved.',
    tro_dau_tro_lat: 'Work & Tumble',
    tro_nhip_tro_ngang: 'Work & Turn',
    tu_chon_so_do_gap_phu_hop_nhat_cho_tung: 'Automatically pick the best fold scheme for each signature (4p/8p/16p).',
    tu_dong_theo_tay_sach: 'Auto by signature',
    tu_dong_xoay_nguoc_coc_phai_180_giup_2: 'Automatically rotate the right stack 180°. Keeps the two halves margin-symmetric when placed together.',
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
