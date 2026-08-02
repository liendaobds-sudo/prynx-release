# Nhật ký sửa Logo Rebuild — 2026-08-01

**Báo cáo được duyệt:** BAO_CAO_AUDIT_LOGO_REBUILD_2026-07-30.md
**Phạm vi giữ nguyên:** logo/artwork phẳng đã bị raster hóa; không mở rộng sang logo chụp trên áo,
vải nhăn hoặc ảnh có phối cảnh phức tạp.

## Baseline trước sửa

- pytest backend/tests/test_logo_rebuild.py -q: **13 passed**.
- gt_bench.py, cấu hình fixed_palette + smoothing 0:
  - PNG 1200 px: bF2 1,000;
  - PNG 600 px: bF2 0,995;
  - PNG 300 px: bF2 0,917;
  - JPEG 600 px q75: bF2 0,997.
- Benchmark gốc gọi native trực tiếp nên không chứng minh được ICC, upscale hoặc metadata SVG của
  worker sản phẩm.

## Lô 1 — §LG.02, §LG.03, §LG.05, §LG.06

Phạm vi: 3 file code/test.

- backend/app/schemas/logo_rebuild.py
  - hạ mặc định smoothing của fixed_palette từ 1,0 xuống 0,0;
  - giữ nguyên giá trị tường minh của request/project cũ.
- backend/app/workers/logo_rebuild.py
  - áp ICC trực tiếp trên ảnh nguồn trước khi convert RGB, dùng relative colorimetric;
  - warning fallback nói rõ màu có thể sai;
  - ảnh có cạnh ngắn dưới 600 px được upscale bằng NEAREST;
  - mục tiêu 1200 px trên máy mạnh, máy 8–16 GB hạ 900 px, máy dưới 8 GB hạ 600 px;
  - thêm viewBox; khi có DPI, SVG mang kích thước vật lý theo mm tính trước upscale;
  - mask khoét nền lấy kích thước từ viewBox, không phụ thuộc width mang đơn vị mm.
- backend/tests/test_logo_rebuild.py
  - khóa tương thích smoothing, RAM gate, NEAREST, thứ tự ICC, viewBox/mm và mask.

### Xác minh

- py_compile: đạt.
- pytest backend/tests/test_logo_rebuild.py -q: **21 passed**, 3 warning dependency có sẵn.
- git diff --check phạm vi Lô 1: đạt.
- Benchmark xuyên process_logo_preview, 8 logo PNG 300 px:
  - mọi ảnh trace ở 1200×1200 px trên máy hiện tại;
  - bF2 từng ca 0,971–1,000;
  - bF2 trung bình **0,990**, đạt tiêu chí §LG.03.

Mức bằng chứng: **Mức 2 — tự động**. Chưa thử Illustrator/CorelDRAW và runtime Tauri thật.

### Ghi chú cổng chất lượng

Tiêu chí “node không vượt 3× so với 600 px” trong báo cáo mâu thuẫn với chính bảng số đo
(1.108 / 59 ≈ 18,8×). Không dùng tiêu chí này làm gate cho tới khi chủ dự án chốt lại đánh đổi
giữa độ trung thực và độ gọn của SVG.

## Lô 2 — §LG.04: gợi ý palette backend

Phạm vi: 4 file code/test; nhật ký này là file thứ 5.

- Schema preflight trả danh sách màu cùng tỷ lệ phủ.
- Worker dùng cùng pipeline EXIF → ICC/sRGB → perspective/crop với preview, nhưng trích màu trước
  upscale để không nhân dữ liệu vô ích.
- Pixel alpha bằng 0 bị loại; pixel bán trong suốt được tính coverage theo alpha.
- K-means dùng tối đa 12 cụm, bỏ cụm dưới 1% và gộp tâm màu gần nhau. Đây là chiến lược auto-k
  thực tế của sản phẩm, không dùng số màu ground-truth như harness ngày 30/7.
- Preflight chạy clustering trong threadpool, không chặn event loop.
- Hợp đồng auto_color_enabled vẫn false: gợi ý không tự áp dụng và không được gọi là màu in gốc.

### Xác minh

- py_compile: đạt.
- pytest backend/tests/test_logo_rebuild.py -q: **26 passed**, 3 warning dependency có sẵn.
- Fixture mới khóa bốn màu phẳng, RGB ẩn trong alpha, ảnh nhiễu, crop và ảnh hoàn toàn trong suốt.
- git diff --check phạm vi code Lô 1–2: đạt.
- Benchmark end-to-end bằng chính suggest_logo_palette + process_logo_preview, PNG 600 px:
  - đủ màu ở cả 8 logo, gồm fixture bốn màu;
  - bF2 trung bình **0,995**;
  - ΔE50 trung bình **0,00**.

Mức bằng chứng: **Mức 2 — tự động**. Kết quả chỉ áp dụng cho artwork phẳng trong phạm vi báo cáo;
người dùng vẫn phải bấm Áp dụng ở frontend trong Lô 3.

## Lô 3 — §LG.01, §LG.02, §LG.04: frontend

Phạm vi đúng 5 file:

- desktop/src/lib/logoRebuildApi.ts;
- desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx;
- desktop/src/components/preprocess-tools/LogoRebuildWorkspace.test.tsx;
- desktop/src/i18n/locales/vi.json;
- desktop/src/i18n/locales/en.json.

Thay đổi:

- mặc định workspace là Logo màu với smoothing 0;
- gọi preflight ngay khi chọn ảnh, có AbortController và revision chống response file cũ;
- palette gợi ý nằm riêng, không tự ghi vào editor;
- người dùng phải bấm Áp dụng hoặc tự sửa màu trước khi preview;
- áp dụng palette tham gia history nên Undo khôi phục trạng thái trước đó;
- đổi nhãn thành Bảng màu logo, không gọi gợi ý pixel là màu in gốc;
- nhãn Độ mượt đường cong nói rõ đánh đổi trung thực nét ↔ đường gọn hơn;
- thêm namespace dịch riêng cho tiếng Việt và tiếng Anh.

### Xác minh

- desktop typecheck: đạt.
- ESLint riêng 3 file TS/TSX: đạt.
- 6 suite Logo/save/routing/quyền/i18n: **42 passed**.
- git diff --check đúng 5 file Lô 3: đạt.

Mức bằng chứng: **Mức 2 — tự động**. Tính năng vẫn HOLD và LOGO_REBUILD_ENABLED=false.
Theo cổng báo cáo, phải thử runtime Tauri thật trước khi mở Lô 4 hoặc bật lại cho người dùng.

## Cổng runtime dev — §LG.RUNTIME

Phạm vi: 4 file code/test:

- `desktop/src/components/imposition-tools/sections/preprocessRouterTools.ts`;
- `desktop/src/lib/toolRegistry.ts`;
- `desktop/src/components/imposition-tools/toolPanel.test.ts`;
- `desktop/src/lib/toolRegistry.routing.test.ts`.

Thay đổi:

- `LOGO_REBUILD_ENABLED` lấy từ `import.meta.env.DEV`;
- card Phục hồi & Vector hóa Logo chỉ được thêm vào registry trong vòng dev;
- production tiếp tục khóa cả đường mở trực tiếp lẫn card trên Home;
- test khóa riêng hành vi dev và production để tránh vô tình phát hành tính năng trước nghiệm thu.

### Xác minh

- desktop typecheck: đạt;
- routing/workspace/license trong dev: **36 passed**;
- routing ở production mode: **20 passed**;
- production frontend build: đạt;
- git diff --check phạm vi bật dev: đạt;
- runtime Tauri thật: backend `127.0.0.1:8321`, Vite `localhost:5173` và cửa sổ PrynX đều hoạt động;
- trên Home đã thấy card **Phục hồi & Vector hóa Logo**; mở card thành công và workspace hiển thị
  tiêu đề, nút **Chọn ảnh có logo**, chế độ **Logo màu** và **Bảng màu logo**.

Mức bằng chứng: **Mức 3 — runtime** cho đường Home → Logo Rebuild. Chưa nghiệm thu end-to-end
với logo thật, preview và SVG tải xuống; production vẫn giữ khóa.
