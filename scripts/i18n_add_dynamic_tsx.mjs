import fs from 'node:fs';
const VI = 'desktop/src/i18n/locales/vi.json', EN = 'desktop/src/i18n/locales/en.json';
const vi = JSON.parse(fs.readFileSync(VI, 'utf8')), en = JSON.parse(fs.readFileSync(EN, 'utf8'));
const add = (ns, k, v, e) => { vi[ns] = vi[ns] || {}; en[ns] = en[ns] || {}; if (vi[ns][k] !== undefined && vi[ns][k] !== v) { console.warn('WARN differs', ns, k, '::', vi[ns][k], '=>', v); } vi[ns][k] = v; en[ns][k] = e; };

// ── OutputPreviewTab (tabs.outputPreview) — toast.error động ──────────────────
add('tabs.outputPreview', 'loi_chuyen_spot_cmyk', 'Lỗi chuyển Spot → CMYK: {{msg}}', 'Spot → CMYK conversion error: {{msg}}');
add('tabs.outputPreview', 'chuyen_spot_cmyk_khong_thanh_cong', 'Chuyển Spot → CMYK không thành công: {{msg}}', 'Spot → CMYK conversion failed: {{msg}}');
add('tabs.outputPreview', 'loi_msg', 'Lỗi: {{msg}}', 'Error: {{msg}}');

// ── App / shell — toast.error khôi phục ──────────────────────────────────────
add('shell', 'khong_khoi_phuc_duoc', 'Không khôi phục được "{{title}}": file gốc không còn.', 'Could not restore "{{title}}": source file no longer exists.');

// ── AiQcTab (tabs.aiQc) — throw / toast động ─────────────────────────────────
add('tabs.aiQc', 'loi_may_chu', 'Lỗi máy chủ ({{status}})', 'Server error ({{status}})');
add('tabs.aiQc', 'loi_trich_xuat', 'Lỗi trích xuất: {{msg}}', 'Extraction error: {{msg}}');

// ── NumberingTool (preprocess.numbering) — setStatusMessage động ─────────────
add('preprocess.numbering', 'loi_msg', 'Lỗi: {{msg}}', 'Error: {{msg}}');

// ── OptimizeTool (preprocess.optimize) — throw server error ──────────────────
add('preprocess.optimize', 'loi_server', 'Lỗi server ({{status}})', 'Server error ({{status}})');

// ── StickerTool (preprocess.sticker) — throw server error ────────────────────
add('preprocess.sticker', 'loi_server', 'Lỗi server ({{status}})', 'Server error ({{status}})');

// ── TrapPresetsTool (preprocess.trapPresets) — setStatus lỗi ─────────────────
add('preprocess.trapPresets', 'loi_x', '❌ {{msg}}', '❌ {{msg}}');

// ── Recipe (recipe.recipe) — toast import/save ───────────────────────────────
add('recipe.recipe', 'da_nhap_quy_trinh', 'Đã nhập quy trình "{{name}}".', 'Imported recipe "{{name}}".');
add('recipe.recipe', 'da_luu_quy_trinh', 'Đã lưu quy trình "{{name}}" ({{count}} bước).', 'Saved recipe "{{name}}" ({{count}} steps).');
add('recipe.recipe', 'luu_that_bai', 'Lưu thất bại: {{msg}}', 'Save failed: {{msg}}');

// ── PageToolsPanel (preprocess.pageTools) — UI tĩnh ──────────────────────────
add('preprocess.pageTools', 'trang_hien_tai', 'Trang hiện tại ({{n}})', 'Current page ({{n}})');

// ── DataMergeTool (preprocess.dataMerge) — UI tĩnh ───────────────────────────
add('preprocess.dataMerge', 'danh_sach_file_csv', 'Danh sách file CSV ({{n}})', 'CSV file list ({{n}})');
add('preprocess.dataMerge', 'dang_doc_n_file', 'Đang đọc {{n}} file…', 'Reading {{n}} files…');
add('preprocess.dataMerge', 'ban_ghi_2', 'bản ghi', 'records');

// ── SavePrintFilesModal (misc.savePrintFiles) — UI tĩnh ──────────────────────
add('misc.savePrintFiles', 'n_loai_tong_to_file', '⇒ {{types}} loại · tổng {{sheets}} tờ · {{files}} file', '⇒ {{types}} types · {{sheets}} sheets total · {{files}} files');

fs.writeFileSync(VI, JSON.stringify(vi, null, 2) + '\n', 'utf8');
fs.writeFileSync(EN, JSON.stringify(en, null, 2) + '\n', 'utf8');
console.log('added dynamic tsx keys');
