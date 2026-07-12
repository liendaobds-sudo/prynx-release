import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(process.cwd());
const EN = path.join(ROOT, 'desktop/src/i18n/locales/en.json');
const en = JSON.parse(fs.readFileSync(EN, 'utf8'));

// Final batch — small leftover namespaces. Skips code-fragment keys (catalogPlanner,
// printFileNaming, acrobatViewer CSS, shell) which are tokenizer noise and stay empty.
const T = {
  'dieline.mockupCanvas': {
    dang_kiem_tra_ho_tro_do_hoa: 'Checking graphics support…',
  },
  'dieline.nestingCanvas': {
    nhap_thong_so_de_xem_xep_khuon: 'Enter parameters to preview nesting',
  },
  'dieline.webGLFallback': {
    hay_thu_bat_tang_toc_phan_cung_cap_nhat: 'Try enabling hardware acceleration, updating your browser, or use the\n                "2D Drawing" tab to keep working.',
    trinh_duyet_cua_ban_khong_ho_tro_webgl: 'Your browser does not support WebGL, so the 3D preview cannot be displayed.',
  },
  'hooks.useEditSession': {
    open_thieu_session_id: 'open: missing session_id',
  },
  'lib.arbitraries': {
    arbboxparams_boxtype_khong_ho_tro: 'arbBoxParams: unsupported boxType: ${_exhaustive}',
  },
  'lib.foldCompensation': {
    panel_panel_name_thieu_pivotedge_parent: 'Panel ${panel.name} missing pivotEdge/parent/depth',
  },
  'lib.instructionSerializer': {
    to_depth_1_mat_a: 'Sheet ${depth + 1} - Side A',
    to_depth_1_mat_b: 'Sheet ${depth + 1} - Side B',
  },
  'lib.presetManager': {
    preset_khong_doc_duoc_thu_muc_preset: '[preset] Could not read preset folder, falling back to localStorage:',
  },
  'lib.renderer': {
    dang_render_mat_isfront_truoc_sau_to: 'Rendering ${isFront ? "front" : "back"} side of sheet ${sheetIndex + 1} (${currentRenderIndex}/${surfaces.length})...',
  },
  'misc.confirmDialog': {
    huy_bo: 'Cancel',
    xac_nhan: 'Confirm',
  },
  'misc.dualPDFViewer': {
    dang_tai_pdf_viewer: 'Loading PDF viewer...',
  },
  'misc.flipBook': {
    trang_bia: 'Cover page',
    trang_trong: 'Blank page',
  },
  'misc.menuBar': {
    trong: 'Blank',
  },
  'misc.themeToggle': {
    chuyen_sang_giao_dien_sang: 'Switch to Light theme',
    chuyen_sang_giao_dien_toi: 'Switch to Dark theme',
  },
  'misc.toast': {
    dong: 'Close',
    dong_thong_bao: 'Dismiss notification',
  },
  'misc.toolHelp': {
    dong_esc: 'Close (Esc)',
  },
  'misc.useBoxStore': {
    vo_best_sleeverot_best_sleevecols_best: 'Sleeve ${best.sleeveRot}° ${best.sleeveCols}×${best.sleeveRows}',
  },
  'misc.viewerHelpers': {
    dang_tai: 'Loading...',
    loi_preview_vdp: 'VDP preview error:',
  },
  'preprocess.fontSelector': {
    go_de_tim_font: 'Type to search fonts...',
    khong_tim_thay_font: 'No font found',
  },
  'preprocess.helpers': {
    chon_anh_co_the_chon_nhieu: 'Select images (multiple allowed)',
    chon_thu_muc_luu_anh: 'Choose image save folder',
  },
  'preprocess.imageBatchPreview': {
    anh_goc: 'Original image',
    ket_qua: 'Result',
  },
  'recipe.recipeRecorder': {
    recipe_commit_khi_dang_ghi_nhung_khong: '[recipe] commit while recording but NO operation was published (noteOperation) — skipping. This tool may be missing its record hook.',
  },
  'recipe.recipeStore': {
    recipe_khong_doc_duoc_thu_muc_recipe: '[recipe] Could not read recipe folder, falling back to localStorage:',
  },
  'recipe.recipeTypes': {
    du_lieu_khong_dung_cau_truc_recipe: 'Data does not match the Recipe structure.',
    recipe_json_khong_hop_le: 'Invalid Recipe JSON:',
  },
};

let filled = 0, miss = 0;
for (const [ns, dict] of Object.entries(T)) {
  if (!en[ns]) { console.log('NS MISSING', ns); continue; }
  for (const k of Object.keys(dict)) {
    if (k in en[ns]) { en[ns][k] = dict[k]; filled++; }
    else { miss++; console.log('  EXTRA (not in vi)', ns, k); }
  }
}
fs.writeFileSync(EN, JSON.stringify(en, null, 2) + '\n', 'utf8');
console.log(`\nDIEN ${filled}; thieu ${miss}.`);
