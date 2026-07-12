import fs from 'node:fs';
import path from 'node:path';
const ROOT = path.resolve(process.cwd());
const EN = path.join(ROOT, 'desktop/src/i18n/locales/en.json');
const en = JSON.parse(fs.readFileSync(EN, 'utf8'));

const T = {
  'preprocess.preflight': {
    anh_chua_embed_mat_link: 'Image not embedded (broken link)',
    anh_dpi_qua_cao: 'Image DPI too high',
    anh_gif_indexed: 'GIF/Indexed image',
    anh_low_res: 'Low-res image',
    bo_chon_het: 'Deselect all',
    canh_bao_an_toan_phat_hien_co_text_song: 'Safety warning: Live Text detected on the sheet. Even with fonts embedded, locking fonts on a machine without the source fonts can still cause text-shifting errors. Recommended.',
    canh_bao_rui_ro_sai_font: 'Warn about font substitution risk',
    chan_doan_tuy_chon: '🔍 DIAGNOSTICS (OPTIONAL)',
    chon_tat_ca: 'Select all',
    chu_chua_outline: 'Text not outlined',
    chua_co_file_pdf: 'No PDF file yet',
    co_gang_nhung_cac_font_chu_con_thieu: 'Attempts to embed the missing fonts into the PDF. Only succeeds if the source fonts are available on the server. Changes the file structure less than Lock Fonts.',
    co_the_thay_bang_font_mac_dinh: 'may be replaced by a default font.',
    convert_toan_bo_text_thanh_duong_path: 'Convert all text to vector paths (Create Outlines). Definitively solves missing-font issues and is 100% safe, but the text can no longer be edited.',
    dang_quet: 'Scanning...',
    dang_sua: 'Fixing...',
    danh_dau_cac_trang_chua_doi_tuong_su: 'Flags pages containing objects that use transparency effects (Transparency, Drop Shadow). Some older RIP systems mishandle these, causing lost detail or white edges.',
    danh_sach_loi: 'Error list',
    file_da_duoc_cap_nhat_tren_viewer: '✅ File updated in the Viewer.',
    file_thieu_font_goc: 'File is missing source fonts.',
    font_chua_nhung: 'Font not embedded',
    giam_dpi_anh: 'Reduce image DPI',
    he_mau_rgb: 'RGB color space',
    kho_trang: 'Page size',
    khoa_font: 'Lock Fonts',
    khong_phat_hien_loi_nao_trong_cac_muc: '✅ No errors detected in the selected checks!',
    kiem_tra_kich_thuoc_cac_trang_khong: 'Checks for pages of inconsistent size. Off-size pages can cause imposition or registration errors on the press.',
    kiem_tra_phien_ban_pdf_co_tuong_thich: 'Checks whether the PDF version is compatible with print standards. Too old (<1.3) lacks ICC/Transparency support; too new (>1.7) may be incompatible with the RIP.',
    kiem_tra_xem_file_pdf_co_duoc_thiet_lap: 'Checks whether the PDF has valid TrimBox and BleedBox set. Missing bleed leads to white paper edges showing after trimming the finished product.',
    kiem_tra_xem_tat_ca_font_chu_da_duoc: 'Checks whether all fonts are fully embedded in the PDF. Non-embedded fonts may be substituted by the RIP’s default font, causing text-shifting and accent errors.',
    lam_phang_flatten_toan_bo_hieu_ung: 'Flattens all transparency and drop-shadow effects into static vector/bitmap. Ensures the file is fully safe for CTP plate output on any system.',
    loi: 'Error',
    loi_kiem_tra: 'Check error',
    mau: 'Color',
    mo_output_preview_phan_tach_kem_mau: 'Open Output Preview (color plate separation)',
    nhung_font: 'Embed Fonts',
    object_ngoai_trang: 'Off-page object',
    phan_tich_va_liet_ke_cac_kenh_mau_pha: 'Analyzes and lists existing spot color channels (Spot Color / Pantone). Helps avoid outputting extra plates or mis-costing the print job.',
    phat_hien_anh_co_dpi_vuot_qua_600_gay: 'Detects images over 600 DPI. Causes unnecessary file size and slow RIP processing. Reduce to 300 DPI with Downscale.',
    phat_hien_anh_dang_indexed_gif_palette: 'Detects Indexed (GIF/palette) images limited to 256 colors. Very poor print quality, banding, lost gradient detail. Replace with TIFF or high-quality JPEG.',
    phat_hien_anh_jpeg_su_dung_progressive: 'Detects JPEG images using Progressive encoding. Some older RIP systems (especially PostScript Level 2) cannot process these, causing print errors or blank images.',
    phat_hien_cac_doi_tuong_cai_dat: 'Detects objects with incorrect Overprint settings (e.g. white text set to overprint becomes invisible when printed). Warns about knockout mechanism errors.',
    phat_hien_cac_hinh_anh_bitmap_co_do: 'Detects low-resolution bitmap images (under 200 DPI). Low-res images become pixelated and jagged, failing to reach sharp quality in actual printing.',
    phat_hien_doi_tuong_text_anh_vector_net: 'Detects objects (text, image, vector, stroke) lying entirely outside the print area (TrimBox/MediaBox). May cause RIP errors or unnecessary processing time. Best removed.',
    phat_hien_file_pdf_duoc_xuat_tu: 'Detects a PDF (exported from Illustrator/Corel) containing virtual paths instead of embedded images. Opening it in design software will drop the images.',
    phat_hien_vung_co_tong_muc_c_m_y_k_spot: 'Detects areas where Total Area Coverage (C+M+Y+K + spot) exceeds the configured threshold (default 300%). Causes slow drying and set-off when printing.',
    phien_ban_pdf: 'PDF version',
    quet_preflight: '🔍 Run Preflight',
    quet_toan_bo_tai_lieu_de_tim_cac_doi: 'Scans the whole document for image, vector or text objects using RGB/Lab color. These color spaces can cause severe color shifts in offset (CMYK) printing.',
    sua_loi_chay_truc_tiep: '🛠️ FIX ERRORS (RUN DIRECTLY)',
    sua_metadata: 'Fix Metadata',
    tac_vuot_nguong: 'TAC over threshold',
    thanh_cong: '✅ Success!',
    that_bai: '❌ Failed',
    toi_uu_hoa_dung_luong_bang_cach_giam_do: 'Optimizes file size by downsampling over-detailed images (>600 DPI) to the 300 DPI print standard. Makes the file lighter and the RIP faster.',
    tu_dong_chuyen_doi_toan_bo_doi_tuong: 'Automatically converts all RGB/Lab objects to standard print CMYK. Uses the FOGRA39 (Coated) ICC profile for the highest color accuracy.',
    xem_truoc_ban_in: '👁️ Print preview',
    xoa_bo_cac_du_lieu_an_metadata_thua: 'Removes hidden data, excess metadata, comments, forms, or unnecessary XML tags in the PDF structure. Cleans the file and prevents compatibility errors.',
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
