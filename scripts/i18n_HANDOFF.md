# Bàn giao: Song ngữ hoá Việt/Anh (i18n) — PrynX/pdfcompare

> File này để chuyển tiếp công việc sang một phiên làm việc mới. Đọc hết trước khi làm.

## Mục tiêu tổng thể
Song ngữ hoá toàn bộ frontend desktop (Tauri + React 19 + Vite) sang Việt/Anh.
Quyết định đã chốt với người dùng từ đầu:
- Thư viện: **react-i18next** (đã cài).
- Phạm vi: **CHỈ frontend** (`desktop/src`). KHÔNG đụng backend Python.
- Bản dịch EN: **AI gõ bản nháp**, người dùng duyệt sau bằng cách đọc `en.json`.
- Tiêu chí: **an toàn & triệt để** — mỗi bước verify được, không phá hành vi tiếng Việt hiện có.

## Trạng thái hiện tại (tính đến commit `093f13f` trên nhánh `main`, đã push)

### ĐÃ XONG 100% — Wiring (hạ tầng + thay chuỗi)
- Hạ tầng i18next: `desktop/src/i18n/index.ts` (init + helper `tv()`).
  - Cấu hình: `fallbackLng:'vi'`, `returnEmptyString:false`, `nsSeparator:':'`, `keySeparator:false`.
  - **Namespace chứa dấu chấm** (vd `preprocess.dataMerge`) → gọi `t('preprocess.dataMerge:key')`.
  - **en rỗng → tự fallback về vi** (UI KHÔNG BAO GIỜ VỠ, kể cả khi chưa dịch).
- `main.tsx`: import `./i18n` sớm trước render.
- `appSettingsStore.ts`: có `language` + `setLanguage`, persist ra file Tauri, `onRehydrateStorage` đẩy ngôn ngữ vào i18n.
- `SettingsModal.tsx`: card chọn ngôn ngữ (Tiếng Việt / English) trong tab workspace.
- `tsconfig.app.json`: đã bật `resolveJsonModule`.
- `vitest.config.ts` + `src/test/setup.ts`: init i18n cho test (nếu không, component render ra key thay vì text → test vỡ).
- **2655 chuỗi UI** trong 104 file component → `t('ns:key')` (qua codemod AST).
- **~285 catalog + ~50 error/toast + dieline/preflight/recipe const-label** → `tv()` render site.
- Verify: `tsc` sạch, `vite build` EXIT 0, **791/791 test pass**. ĐÓNG GÓI ĐƯỢC.

### ĐÃ XONG — Dịch EN (486/3772 key)
- `catalog` (202) — commit `4e44ab8`
- `shell`+`settings`+`tabs.home` (60) — commit `1e3a02a`
- 6 tab: imposition/combine/compare/textCompare/outputPreview/aiQc (224) — commit `093f13f`

### CÒN LẠI — Dịch EN: **3286 key rỗng** (đây là TOÀN BỘ việc còn lại)
`en.json` các key này đang rỗng → app fallback tiếng Việt. **KHÔNG chặn release** — chỉ là phần bồi thêm.
Không cần wiring gì nữa; wiring đã xong hết. Chỉ điền chuỗi EN vào `desktop/src/i18n/locales/en.json`.

Top namespace còn rỗng (empty/total):
```
317  preprocess.dataMerge      110  dieline.param            77  preflight.preflight
193  imposition.advancedSettings  76  imposition.gridSettings  76  recipe.recipe
68  preprocess.sticker        64  preprocess.numbering       63  imposition.bookletSettings
58  preprocess.preflight      55  dieline.mockupArtwork      53  preprocess.watermark
... (còn ~130 namespace nhỏ hơn, xem lệnh đếm bên dưới)
```

## CÁCH LÀM TIẾP (quy trình đã kiểm chứng, lặp lại y hệt)

### Công cụ
- **CWD lưu ý**: shell hay ở sẵn `d:\pdfcompare\desktop`. Kiểm bằng `pwd` trước khi chạy path tương đối.
- Script mẫu đã có: `scripts/i18n_fill_en_tabs.mjs`, `i18n_fill_en_batch.mjs`, `i18n_fill_en_catalog.mjs`.
  - Chúng đọc `desktop/src/i18n/locales/en.json`, merge thêm bản dịch cho 1 số namespace, ghi lại. **CHỈ đụng key được cung cấp, giữ nguyên phần còn lại.**

### Vòng lặp cho mỗi batch namespace
1. Đọc chuỗi vi của namespace cần dịch:
   ```
   node -e 'const vi=require("./desktop/src/i18n/locales/vi.json"); console.log(JSON.stringify(vi["preprocess.sticker"],null,1))'
   ```
2. Tạo/sửa 1 script `.mjs` theo mẫu `i18n_fill_en_tabs.mjs`: map `{ns: {key: "bản dịch EN"}}`, merge vào en.json.
3. Chạy script, rồi verify:
   ```
   node -e 'const en=require("./desktop/src/i18n/locales/en.json"),vi=require("./desktop/src/i18n/locales/vi.json"); const ns="preprocess.sticker"; let e=0; for(const k in vi[ns]) if(!en[ns]?.[k])e++; console.log("empty",e)'
   ```
4. `cd desktop && npm run build` (phải EXIT 0).
5. Commit theo nhóm: `git add desktop/src/i18n/locales/en.json scripts/... && git commit` rồi `git push`.

### Đếm tiến độ bất cứ lúc nào
```
node -e 'const en=require("./desktop/src/i18n/locales/en.json"),vi=require("./desktop/src/i18n/locales/vi.json"); let tot=0,emp=0; for(const ns in vi){for(const k in vi[ns]){tot++; if(!en[ns]||!en[ns][k])emp++;}} console.log("dich",tot-emp,"/",tot,"| rong",emp)'
```

## QUY TẮC DỊCH (quan trọng — giữ nhất quán với 486 key đã làm)
- Dùng **thuật ngữ in ấn chuẩn tiếng Anh**: imposition, bleed, trapping, die-cut/dieline, overprint, knockout, spot color, preflight, saddle stitch, creep, N-Up, step & repeat, TrimBox/BleedBox, Output Intent, PDF/X.
- **GIỮ NGUYÊN** phần nội suy `${...}` trong chuỗi (vd `"Đang tách nền ${processed} / ${items.length}..."` → `"Removing background ${processed} / ${items.length}..."`). Có script verify `tplMismatch` — đảm bảo số lượng `${...}` khớp trước/sau.
- **GIỮ NGUYÊN** emoji và ký tự đầu chuỗi (🚀, ✅, ⚠️, 📄...) — chúng là 1 phần UI.
- **GIỮ NGUYÊN** placeholder dạng `[page]`, `[date]`, `[total]`, `{X}`, `{Y}`, `{Z}` (token người dùng chèn).
- Giữ nguyên các token kỹ thuật đã là tiếng Anh: PDF/X-1a, CMYK, RGB, DPI, ICC, FOGRA39, Ctrl+Z, Zalo...
- Với chuỗi 2 ngôn ngữ sẵn (vd `"Ghép nối tiếp (Merge)"`) → dịch phần Việt, giữ phần Anh: `"Sequential merge (Merge)"` hoặc gọn hơn.

## RÁC CẦN BỎ QUA (KHÔNG dịch, để rỗng — fallback vô hại)
- Namespace **`shell`**: 26/33 key là **mảnh code** bị tokenizer bắt nhầm từ template literal đa dòng trong App.tsx (key kiểu `const_...`, `handle...`, `onclick_...`, `chi_tab_active_...`). Chúng KHÔNG render (không nằm trong `t()`/`tv()`). ĐÃ cố ý để rỗng. Chỉ 7 key UI thật đã dịch.
- Khi gặp namespace khác có key mà **value vi trông như code/JSX/comment** (chứa `=>`, `className=`, `//`, `const `, `return`) → BỎ QUA, để rỗng. Đây là nhiễu tokenizer, không phải chuỗi UI.
- `misc.qrFrames` (30 key): phần lớn là **dead data** (`name`/`ctaText` của khung QR — không có picker render, `ctaText` vẽ vào ảnh QR chứ không phải UI). Kiểm lại trước khi dịch; nếu không render thì bỏ qua.

## KIẾN TRÚC tv() vs t() (để hiểu, KHÔNG cần sửa nữa)
- `t('ns:key')`: dùng trong React component (hook `useTranslation`). Đã wire xong.
- `tv(viString)`: helper trong `i18n/index.ts`, dịch **data hằng module-level** (mảng option, TOOL_REGISTRY, label...) qua reverse-map `vi→key`. Dùng ở render site. Đã wire xong.
- Cả hai đọc cùng `en.json` → **điền en.json là đủ để cả hai chạy tiếng Anh**. Không cần đụng code component nữa.
- Chi tiết đầy đủ: xem memory `project_i18n_architecture.md`.

## KỶ LUẬT ĐÃ HỌC (người dùng nhấn mạnh)
- **Chỉ dịch chuỗi UI thật.** Trước khi dịch 1 namespace lạ, liếc value vi: nếu là code fragment → bỏ. Đừng dịch máy móc cho đủ số.
- **Commit theo nhóm + build gate mỗi nhóm.** Không đổ 3286 key 1 lần rồi mới build.
- **luôn `npm run build` trước khi commit** (bài học: từng để lọt lỗi typecheck chặn đóng gói).
- Không dùng lệnh git phá huỷ để undo; commit sớm.

## THỨ TỰ ĐỀ XUẤT (ưu tiên theo mức người dùng thấy)
1. `preprocess.*` — công cụ dùng nhiều (dataMerge 317 để riêng vì lớn nhất).
2. `imposition.*` — advancedSettings 193, gridSettings 76, bookletSettings 63...
3. `dieline.*` (param 110, mockupArtwork 55...), `recipe.*`, `preflight.preflight` 77.
4. `misc.*` + `lib.*` — nhiều namespace nhỏ, phần lớn toast/label/report.
5. Verify tổng cuối: build + đếm key rỗng còn lại (còn lại nên chỉ là rác code fragment).

## FILE THAM CHIẾU
- Source of truth VN: `desktop/src/i18n/locales/vi.json` (đã đầy đủ, KHÔNG sửa).
- Đích EN: `desktop/src/i18n/locales/en.json` (điền vào đây).
- Keymap: `scripts/i18n_keymap.json` (ns → key → {vi, files, kind}).
- Script mẫu: `scripts/i18n_fill_en_*.mjs`.
- Memory: `project_i18n_architecture.md`, `feedback_build_gate_before_commit.md`.
