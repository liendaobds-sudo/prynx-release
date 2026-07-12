import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(process.cwd());
const VI = path.join(ROOT, 'desktop/src/i18n/locales/vi.json');
const EN = path.join(ROOT, 'desktop/src/i18n/locales/en.json');
const vi = JSON.parse(fs.readFileSync(VI, 'utf8'));
const en = JSON.parse(fs.readFileSync(EN, 'utf8'));

// App.tsx close/quit dialogs (ConfirmCloseModal + app-close) — codemod bỏ sót hoàn toàn.
const ADD = {
  'shell': {
    thoat_ung_dung: ['Thoát ứng dụng?', 'Quit application?'],
    van_thoat: ['Vẫn thoát', 'Quit anyway'],
    neu_thoat_ban_se_mat_toan_bo_thanh_qua: [
      'Nếu thoát, bạn sẽ mất toàn bộ thành quả chưa lưu. Bạn có chắc chắn muốn thoát?',
      'If you quit, you will lose all unsaved work. Are you sure you want to quit?',
    ],
    co: ['Có', 'There are'],
    tai_lieu_chua_luu: ['tài liệu CHƯA LƯU', 'unsaved document(s)'],
    chua_ro_ten: ['Chưa rõ tên', 'Unknown name'],
    canh_bao_chua_luu: ['Cảnh báo chưa lưu', 'Unsaved changes warning'],
    file_chua_duoc_luu_vao_may_neu_dong: [
      'chưa được lưu vào máy. Nếu đóng, bạn sẽ mất thành quả file này.',
      'has not been saved to disk. If you close, you will lose this file’s work.',
    ],
    ban_co_chac_chan_muon_dong_tab_nay: [
      'Bạn có chắc chắn muốn đóng tab này không?',
      'Are you sure you want to close this tab?',
    ],
    van_dong: ['Vẫn Đóng', 'Close anyway'],
    file_label: ['File', 'File'],
  },
  'imposition.advancedSettings': {
    so_coc_label: ['Số cọc', 'Number of stacks'],
  },
};

let filled = 0;
for (const [ns, dict] of Object.entries(ADD)) {
  if (!vi[ns] || !en[ns]) { console.log('NS MISSING', ns); continue; }
  for (const [k, [v, e]] of Object.entries(dict)) {
    vi[ns][k] = v;
    en[ns][k] = e;
    filled++;
  }
}
fs.writeFileSync(VI, JSON.stringify(vi, null, 2) + '\n', 'utf8');
fs.writeFileSync(EN, JSON.stringify(en, null, 2) + '\n', 'utf8');
console.log('ADDED', filled, 'keys');
