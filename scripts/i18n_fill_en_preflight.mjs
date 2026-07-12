import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(process.cwd());
const EN = path.join(ROOT, 'desktop/src/i18n/locales/en.json');
const en = JSON.parse(fs.readFileSync(EN, 'utf8'));

const T = {
  'preflight.preflight': {
    anh: 'Images',
    anh_chua_embed: 'Non-embedded images',
    anh_dpi_qua_cao: 'Image DPI too high',
    anh_gif_indexed: 'GIF/Indexed images',
    anh_jpeg_progressive_gay_loi_rip: 'Progressive JPEG images cause RIP errors',
    ben_duoi_he_thong_co_the_tu_thay_bang: 'below, the system may substitute the default font, distorting letterforms. Please consider carefully.',
    bleed_tran_le: 'Bleed',
    canh_bao: 'Warning',
    canh_bao_che_do_de_mau_chong_overprint: 'Warn on overprint mode',
    canh_bao_font_chua_nhung: 'Warn on non-embedded fonts',
    canh_bao_khi_co_anh_vector_dung_rgb: 'Warn when images/vectors use RGB',
    canh_bao_khi_co_mau_pha_pantone_devicen: 'Warn when spot colors are present (Pantone/DeviceN)',
    canh_bao_rui_ro_sai_font: 'Warn on font substitution risk',
    chon_cac_quy_tac_kiem_tra_ben_duoi_va: 'Select the check rules below and run Preflight to analyze the PDF.',
    chon_quy_tac_rules: '⚙️ Select Rules',
    chu_chua_outline: 'Non-outlined text',
    chu_vector_an_toan_100: 'Text → Vector (100% safe)',
    dang_chay_pipeline_sua_loi: 'Running fix pipeline...',
    dang_kiem_tra: 'Checking',
    dang_sua_loi: 'Fixing',
    do_phan_giai: 'Resolution',
    do_trong_suot: 'Transparency',
    dong_file: 'Close file',
    file_da_duoc_cap_nhat_tren_viewer_ban: '✅ File updated in the viewer. You can review and save it.',
    file_san_sang_dua_in: 'File is ready for print.',
    file_thieu_font_goc_neu_dung_lenh: 'File is missing the original font. If you use command',
    font_chu: 'Fonts',
    giam_dpi_anh: 'Downsample image DPI',
    he_mau: 'Color space',
    he_mau_rgb: 'RGB color space',
    he_thong_dang_phan_tich_cau_truc_pdf: 'The system is analyzing the PDF structure...',
    he_thong_xu_ly_actions_find_a_a_id: 'System processing: ${ACTIONS.find(a => a.id === fixingAction)?.title || fixingAction}...',
    hoac: 'or',
    keo_tha_pdf_can_kiem_tra: 'Drag & drop the PDF to check',
    kho_trang: 'Page size',
    khoa_font: 'Lock Fonts',
    khong_co: 'None',
    khong_co_van_de: 'No issues!',
    khong_ro_vector: 'Unknown/Vector',
    kiem_tra_anh_duoi_200_dpi: 'Check for images below 200 DPI',
    kiem_tra_kich_thuoc_cac_trang_khong: 'Check for unequal page sizes',
    kiem_tra_thieu_trimbox_bleedbox: 'Check for missing TrimBox/BleedBox',
    kiem_tra_tuong_thich_pdf_version: 'Check PDF version compatibility',
    loi: 'Error',
    loi_kiem_tra: 'Check error',
    mau_spot: 'Spot color',
    mo_bang_preflight: 'Open Preflight panel',
    nhung_font: 'Embed Fonts',
    object_ngoai_trang: 'Off-page objects',
    phan_tich_8_quy_tac_chuan_in_offset_tu: 'Analyzes 8 offset-print standard rules + automatic error fixing',
    phan_tich_cau_truc_pdf_he_mau_rgb_cmyk: 'Analyzes PDF structure: RGB/CMYK color space, embedded fonts, low-res images, transparency, bleed. Auto-fixes errors like PitStop.',
    phat_hien_anh_600_dpi_gay_nang_file: 'Detected images > 600 DPI bloating the file',
    phat_hien_anh_palette_256_mau: 'Detected 256-color palette images',
    phat_hien_bong_do_transparency_group: 'Detected drop shadows, Transparency Groups',
    phat_hien_doi_tuong_nam_hoan_toan_ngoai: 'Detected objects entirely outside the print area',
    phat_hien_live_text_chua_khoa_font: 'Detected Live Text with unlocked fonts',
    phat_hien_opi_link_ao_xmp_linked: 'Detected phantom OPI link / XMP linked',
    phien_ban_pdf: 'PDF version',
    preflight_chuan_in: 'PRINT PREFLIGHT',
    preflight_kiem_tra_chuan_in: '🩺 Preflight — Print standard check',
    quet_lai: '🔄 Rescan',
    report_font_summary_not_embedded_report: '❌ ${report.font_summary.not_embedded}/${report.font_summary.total} not embedded',
    report_font_summary_total_da_nhung: '✅ ${report.font_summary.total} embedded',
    report_image_summary_total_anh_ok_min: '✅ ${report.image_summary.total} images OK (min ${report.image_summary.min_dpi} DPI)',
    sua_loi_tu_dong: '🛠️ Auto-fix errors',
    sua_metadata: 'Fix Metadata',
    tac_vuot_nguong: 'TAC over threshold',
    thanh_cong: '✅ Success!',
    that_bai: '❌ Failed',
    thong_tin: 'Info',
    thu_gon: 'Collapse',
    thu_nhung_font_it_an_toan_hon: 'Try embedding fonts (Less safe)',
    tong_muc_cmyk_spot_vuot_nguong_mac_dinh: 'Total CMYK+Spot ink over threshold (default 300%)',
    upload_that_bai: 'Upload failed',
    xoa_bong_do_cho_ctp: 'Remove drop shadows for CTP',
    xoa_metadata_nhay_cam: 'Remove sensitive metadata',
    xu_ly_tren_server_noi_bo: '* Processed on internal server *',
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
