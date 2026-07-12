import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(process.cwd());
const EN = path.join(ROOT, 'desktop/src/i18n/locales/en.json');
const en = JSON.parse(fs.readFileSync(EN, 'utf8'));

const T = {
  'preprocess.pageTools': {
    '180_nguoc': '180° (Upside down)',
    '270_90_cw_phai': '270° / 90° CW (Right)',
    '90_ccw_trai': '90° CCW (Left)',
    ap_dung_cho_trang_nao: 'Apply to which pages?',
    ban_sao_copies: 'Copies:',
    cac_trang_trong_dai_se_duoc_tach_ra: 'Pages in the range will be extracted into a new document.',
    canh_bao: 'Warning:',
    chen_trang: 'Insert blank',
    chen_trang_trang: 'Insert Blank Page',
    chen_vao_vi_tri_nao: 'Insert at which position?',
    chi_trang_chan_even: 'Even pages only (Even)',
    chi_trang_le_odd: 'Odd pages only (Odd)',
    chia_bo_collate: 'Collate:',
    chuyen_den_vi_tri_nao: 'Move to which position?',
    co_1_2_3_1_2_3: 'Yes (1 2 3... 1 2 3...)',
    dai_trang_can_di_chuyen: 'Page range to move?',
    dai_trang_can_trich_xuat: 'Page range to extract?',
    den: 'to',
    den_2: 'To:',
    di_chuyen: 'Move',
    goc_xoay_rotate: 'Rotation angle (Rotate)',
    khong_1_1_1_2_2_2: 'No (1 1 1... 2 2 2...)',
    len_truoc_trang_dau_tien: 'Before the first page',
    nhan_ban: 'Duplicate',
    ra_sau_trang_cuoi_cung: 'After the last page',
    sau_trang_cuoi_cung: 'After the last page',
    sau_trang_so: 'After page number',
    so_ban_sao: 'Number of copies',
    so_luong: 'Quantity:',
    so_trang_trang: 'Number of blank pages',
    tat_ca: 'All',
    thuc_thi_di_chuyen: 'Run Move',
    thuc_thi_nhan_ban: 'Run Duplicate',
    thuc_thi_xoay_trang: 'Run Page Rotation',
    toan_bo_tai_lieu: 'Entire document',
    trang_da_xoa_se_khong_the_phuc_hoi_sau: 'Deleted pages cannot be recovered after saving the file. You can use Undo (Ctrl+Z) to revert.',
    trang_so: 'page number',
    trich_xuat: 'Extract',
    trich_xuat_dai_trang: 'Extract Page Range',
    truoc: 'Before',
    truoc_trang_dau_tien: 'Before the first page',
    tu: 'From:',
    tu_trang: 'From page',
    xoa_cac_trang_nay_khoi_tai_lieu_sau_khi: 'Delete these pages from the document after extraction',
    xoa_trang: 'Delete pages',
    xoa_trang_2: 'Delete Pages',
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
