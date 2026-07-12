import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(process.cwd());
const EN = path.join(ROOT, 'desktop/src/i18n/locales/en.json');
const en = JSON.parse(fs.readFileSync(EN, 'utf8'));

const T = {
  'dieline.mockupArtwork': {
    anh_da_tai: 'Loaded image',
    anh_mat_ngoai: 'Outer face image',
    anh_mat_trong: 'Inner face image',
    bat: 'On',
    bat_de_keo_anh_truc_tiep_tren_mat_3d: 'Enable to DRAG the artwork directly on the 3D face (orbit rotation temporarily off)',
    bat_in_mat_trong: 'Enable inner-face printing',
    can_co_khuon_be_de_xac_dinh_kich_thuoc: 'A dieline is required to determine the mask size.',
    canh_anh_theo_toa_do_khuon_be_bien_anh: 'Align artwork to dieline coordinates — image edges match the face position.',
    canh_anh_ve_giua_mat: 'Center artwork on the face',
    canh_theo_khuon: 'Align to dieline',
    che_do_dat_anh: 'Artwork placement mode',
    chieu_cao_dap_noi_mo_phong_theo_mat_na: 'Emboss height simulated from the emboss mask',
    chua_co_khuon_be_de_xac_dinh_kich_thuoc: 'No dieline yet to determine the surface size for applying the mask.',
    dang_bat_keo_chuot_tren_mat_hop_de_doi: 'Enabled: drag on the box face to move the artwork; orbit rotation temporarily off. Turn off to rotate the model.',
    dat_lai: '↺ Reset',
    dat_lai_toan_bo_transform: 'Reset all transforms',
    dat_ti_le_ve_100: 'Set scale to 100%',
    dich_anh_theo_truc_doc: 'Move artwork along the vertical axis',
    dich_anh_theo_truc_ngang: 'Move artwork along the horizontal axis',
    do_cao_emboss: 'Emboss height',
    doc: '⇅ Vertical',
    giua: '⌖ Center',
    hien_bleed_safe_area: 'Show bleed / safe-area',
    hien_duong_bien_vung_tran_le_bleed_va: 'Show the bleed boundary and safe-area boundary',
    hoan_tac: '↶ Undo',
    hoan_tac_ctrl_z: 'Undo (Ctrl+Z)',
    in_anh_rieng_cho_mat_trong_hop_doc_dung: 'Print a separate artwork for the box inner face (reads correctly from the inside)',
    in_mat_trong: 'Print inner face',
    keo_anh_tren_mo_hinh_3d: '✋ Drag artwork on the 3D model',
    keo_tha_hoac_bam_de_tai_label: 'Drag & drop or click to load ${label.toLowerCase()}',
    khong_nap_duoc_anh_be_mat_giu_vat_lieu: 'Could not load the image. The surface keeps the current material; scale/position are preserved.',
    khong_nap_duoc_mat_na_anh_hong_hoac_sai: 'Could not load the mask (corrupt image or wrong format).',
    kich_thuoc_mat_na_phai_khop_be_mat: 'Mask size must match the surface ${surface.width}×${surface.height} px.',
    label_keo_tha_anh_vao_day_hoac_bam_de: '${label}: drag & drop an image here or click to select',
    lam_lai: '↷ Redo',
    lam_lai_ctrl_y: 'Redo (Ctrl+Y)',
    lat_doc_anh: 'Flip artwork vertically',
    lat_ngang_anh: 'Flip artwork horizontally',
    lech_doc_y: 'Vertical offset (Y)',
    lech_ngang_x: 'Horizontal offset (X)',
    mat_na_gia_cong: 'Finishing mask',
    mat_na_info_width_info_height_px_se: 'The ${info.width}×${info.height}px mask will be scaled to the ${surface.width}×${surface.height}px surface.',
    mat_na_khong_hop_le: 'Invalid mask.',
    moi_mat_anh_xa_anh_doc_lap_theo_bbox: 'Each face maps its artwork independently by its own bbox.',
    phong_to_thu_nho_anh_quanh_tam_mat: 'Zoom the artwork in/out around the face center',
    tai_mat_na_dap_noi_emboss: 'Load emboss mask',
    tai_mat_na_phu_uv_cuc_bo_spot_uv: 'Load local UV coating mask (spot-UV)',
    theo_tung_mat: 'Per face',
    ti_le: 'Scale',
    xoa_anh: '🗑️ Remove image',
    xoa_label_tolowercase: 'Remove ${label.toLowerCase()}',
    xoa_mask_emboss: 'Remove emboss mask',
    xoa_mask_spot_uv: 'Remove spot-UV mask',
    xoay_anh_quanh_tam: 'Rotate artwork around center',
    xoay_them_90: 'Rotate +90°',
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
