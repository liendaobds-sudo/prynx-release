# Báo cáo characterization Lô 0 - Hợp nhất Bù xén / Tạo đường cắt

**Ngày:** 2026-09-06

**Kế hoạch:** `KE_HOACH_HOP_NHAT_BU_XEN_TAO_DUONG_CAT_LAN2_2026-09-06.md`

**Trạng thái:** `CHARACTERIZATION-PARTIAL · ĐÃ DUYỆT TRIỂN KHAI · CÒN GATE RUNTIME/ARTIFACT`

**Production code:** Lô 0 không sửa production; các lô sau đã triển khai và commit, xem mục 7.

Mục 1–6 ghi nhận khảo sát tại thời điểm Lô 0, không mô tả toàn bộ trạng thái code hiện tại.
Người dùng đã duyệt tiếp tục toàn bộ kế hoạch, không yêu cầu dừng xin duyệt lại sau từng lô.

## 1. Kết luận

Hai nút hiện tại không chỉ khác tên UI:

| Luồng | UI/state | Backend/writer |
|---|---|---|
| PDF/PNG đã có biên | `StickerTool`, Working PDF, canonical classic | `/pdf-tools/sticker-dieline`, preserve/object selection/Xén vuông góc |
| Tách nhiều tem | `StickerSheetPanel`/`StickerSheetWorkspace`, Zustand page/mask/revision | `/api/sticker-sheet/*`, mask edits, PDF từng tem/ZIP |

Backend đã có các primitive dùng chung: inspect/detect, `StickerSheetSession`, preview CUT và
canonical fingerprint. Tuy nhiên output adapter, recipe, page ownership và capability vẫn tách.

Kết luận Lô 0: **đủ bằng chứng để bắt đầu Lô 1 theo hướng một workspace + hai adapter**, chưa đủ
bằng chứng để xóa mode cũ hoặc khẳng định parity runtime/Tauri.

## 2. Baseline test đã chạy

Trên Windows thật, không cập nhật snapshot:

```powershell
cd D:\pdfcompare\desktop
npx vitest run `
  src/components/preprocess-tools/StickerCutlineTool.test.tsx `
  src/components/preprocess-tools/StickerTool.ui.test.tsx `
  src/components/preprocess-tools/StickerSheetPanel.test.tsx `
  src/components/preprocess-tools/StickerSheetWorkspace.test.tsx `
  src/components/preprocess-tools/stickerSheetStore.test.ts `
  src/components/preprocess-tools/StickerOutputSettingsPanel.test.tsx `
  src/components/preprocess-tools/stickerOutputSettings.test.ts `
  src/lib/stickerSheetApi.test.ts `
  src/components/preprocess-tools/useClassicCutlinePreview.test.tsx
# 9 file, 106 passed
```

`stickerToolPolicy.test.ts` không tồn tại trong worktree nên không tính vào baseline.

Baseline backend/native từ các lượt verify Lô A/B:

- Sticker/Lô A-B + regression liên quan: 197 passed.
- Regression source pipeline/sheet engine/cutline preview/API: 122 passed, 0 fail/error/skip.
- Rust `imposition_core`: cargo test đạt.

## 3. Ma trận U0

| Mã | Entry → consumer/artifact | Đã có bằng chứng | Khoảng trống cần khóa |
|---|---|---|---|
| U0-01 | Inspect existing-cut → classic/sheet preserve → PDF content/page box | API/source tests preserve CutContour, page boxes và nguyên bytes | Chưa chạy cùng fixture qua cả hai adapter rồi so `/Contents`, Media/Crop/Trim/UserUnit |
| U0-02 | PDF vector/raster không CUT → vector/Alpha proposal | Tests vector multi-page/5 artwork và classification | Generic decoration vs true CUT chưa có expected artifact chung với classic |
| U0-03 | PNG/JPG một tem, nền trắng/Alpha → mask/CUT/bleed/crop | Tests Alpha/simple-bg, e2e CUT/bleed/crop và UI settings | Thiếu một fixture chạy cả hai mode với pixel ROI, CUT topology, mm offset/bleed |
| U0-04 | Nhiều tem + bóng → labels/Alpha → preview/export | Lô A/B trên PDF khách, shadow/white-shell/composite tests, 650px ROI giữ nguyên | Chưa có checked-in fixture/hash cho cả classic keep-sheet và sheet split cùng artifact |
| U0-05 | Multi-page/reorder/duplicate → page/session/export | API/store tests page assets, stale revision, page order | Chưa runtime smoke classic-vs-sheet với reorder/duplicate và pageInstance owner |
| U0-06 | Xén vuông góc → edge bite/sides/mirror/crop/n-up | Classic UI/payload/recipe/engine tests | Chưa kiểm khi đổi strategy trong workspace chung; phải giữ contract riêng |
| U0-07 | Recipe record/playback → runner → commit artifact | Classic recipe tests/settings migration | Sticker-sheet mask edits, output intent, page order/warnings chưa có vé playback; hiện đang bị chặn có chủ đích |
| U0-08 | Picker/DOM/native drop → active tab/session | Unit tests SystemIntegrations/dispatcher/inactive tab/DOM drop | Chưa Tauri click-smoke hai tab, tab nền/đã đóng và đổi mode sau khi mở |
| U0-09 | True-shape ring 11 đỉnh → `diePolylines` → GridPreview | Có test 11-point cubic hở legacy | Chưa có test ring kín đúng 11 điểm; `GridPreview.tsx:1316-1324` vẫn dùng magic length 11 |

### Hợp đồng fixture bắt buộc

Mỗi fixture Lô 0 phải lưu: `source_revision`, `source_page`, `working_page`, `page_order`,
`boundary_source`, `strategy_confidence`, `needs_review`, `mask_revision`, `instances[id,bbox]`,
geometry settings (cut/offset/bleed/corner/fill/color/crop), `output_intent`, CUT count/topology,
page boxes và SHA-256 của ROI render.

U0-09 phải có hai payload riêng:

1. ring kín 11 điểm, không lặp điểm đầu;
2. cubic hở 11 điểm legacy.

Hai payload phải tạo hai kết quả preview khác nhau theo metadata/contract, không theo độ dài mảng.

## 4. Khoảng trống parity phát hiện từ characterization

1. `useClassicCutlinePreview` và `stickerSheetStore` đều gửi preview request chung nhưng loại
   canonical reference khác nhau; cần contract/type chung ở Lô 1.
2. Multi page export hiện lưu `cutlineDenoise` ở page state nhưng schema/API/export fallback chưa
   truyền đầy đủ như classic; đây là parity gap thực tế cần Lô 1 riêng.
3. Classic preserve vector và sheet preserve existing-cut có điều kiện khác nhau; không route
   ngược một writer để “đơn giản hóa”.
4. `Bế tem nhãn` và `Xén vuông góc` dùng settings/route khác; không gộp trong Lô 1.
5. Recipe của sheet/mask edit chưa có contract commit/playback; chỉ characterization trong Lô 0,
   không tự mở khóa bằng cách đổi UI.
6. True-shape ring 11 điểm là `[SUSPECTED]`, chưa có artifact backend xác nhận; phải xử lý bằng
   metadata `closed/kind` hoặc bác bỏ bằng fixture trước khi xóa heuristic frontend.

## 5. Gate Lô 1

Lô 1 được phép tập trung vào contract/session, không đổi UX:

- thêm shared `StickerSourceSessionRef`/canonical preview type cho classic và sheet;
- giữ route/writer cũ làm adapter;
- truyền `cutline_denoise` đầy đủ qua schema → route → document export/cache key;
- không đổi output file khi settings cũ giữ nguyên;
- thêm tests canonical reference/stale/revision/denoise key parity;
- giữ `StickerSourceMode` và UI hiện tại để rollback được.

Gate dự kiến tại thời điểm Lô 0: verify typecheck/Vitest backend/tests, parse artifact và user test
backend dev trước khi thay UI. Trạng thái thực tế sau triển khai được ghi riêng ở mục 7; test tự động
không được tính thay cho phần runtime/artifact chưa chạy.

## 6. Quyết định characterization

Lô 0 **đạt characterization ở mức code/test**, còn thiếu runtime Tauri và U0-09 artifact. Không
đụng production ở Lô 0; các thay đổi docs/evidence khác trong worktree không thuộc lô này.

Theo `prynx-audit-workflow`, báo cáo này là chốt chuyển lô. Khi lập bản gốc Lô 0, Lô 1 chưa được sửa.

## 7. Cập nhật sau các lô triển khai 2026-09-06

Chi tiết commit và lệnh verify nằm trong `HOP_NHAT_BU_XEN_FIXES_2026-09-06.md`.

| Phạm vi | Bằng chứng mới | Giới hạn còn lại |
|---|---|---|
| Canonical preview/export | `ef9d025`, `38d6c2a`: denoise/fingerprint xuyên schema, route, cache và export; stale trả 409, không output | Chưa so toàn bộ corpus classic/sheet qua artifact render |
| U0-01/02/03/04 | Giữ adapter PDF nâng cao, workspace mask chung, bù xén/offset/màu xuyên suốt; regression nguồn/ảnh/guard đạt | Chưa có toàn bộ bộ đôi artifact preserve/raster/keep/split với đủ hash/page box/ROI |
| U0-05/06 | Store giữ tuning/owner khi nhận diện lại; Xén vuông góc tách adapter, có shell regression | Reorder/duplicate và chuyển công cụ chưa smoke trong desktop thật |
| U0-07 | `7bc80a3`: recipe unified-v2, preview fingerprint, cancel/warning, commit bytes trước cleanup được test | Không playback mask edits/trang tùy biến; transport mock không chứng minh record-save-playback Tauri |
| U0-08 | `15ea61d`: registry theo tab, dispatcher, cleanup, explicit intent được test | Chưa native drop thật, tab nền/đã đóng và điều hướng trên app |
| U0-09 | `86d976a`: backend phát kind ring, frontend phân biệt với cubic hở legacy; backend 9 / GridPreview 51 tests đạt | Hợp đồng code/test đã sửa; không suy diễn thành tất cả layout thật đã được xem |

Verify cuối: typecheck đạt; frontend 44 file / 446 tests đạt; backend 240 tests đạt; ESLint phạm vi
module mới và form/shell đạt; `git diff --check` đạt. Các số baseline ở mục 2 là lịch sử, không cộng
dồn thành số test độc lập mới.

Lần thử Vite không qua màn license và không có Tauri IPC. Không vượt xác thực, không tuyên bố đạt
runtime; đã đóng tab/server tự tạo. Vì vậy characterization vẫn **một phần**, các route/adapter cũ
và migration reader tiếp tục được giữ. Không đóng ma trận U0 bằng cách chỉ đổi nhãn trạng thái.
