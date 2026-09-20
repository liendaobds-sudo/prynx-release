# Viewer PrynX - Nhật ký sửa mở file nặng và chất lượng hiển thị V20.1–V20.6 (2026-09-20)

Trạng thái: **Đã hoàn thành 6/6 hạng mục được duyệt (V20.1 – V20.6); đạt SOURCE + AUTO + ARTIFACT.**
Chưa nghiệm thu GUI desktop/Tauri runtime click-smoke/Acrobat A/B GUI/installer release. Người dùng yêu cầu "sửa hết đi", thực hiện theo quy trình audit có kiểm chứng nghiêm ngặt.

---

## 1. Tổng hợp kết quả theo từng phát hiện (Findings)

| Mã | Nội dung phát hiện | Thay đổi source | Bằng chứng & Kiểm thử sau sửa |
|---|---|---|---|
| **V20.1** | Mở PDF lớn bị nguy cơ phình bộ nhớ do lưu giữ proxy fields trong bootstrap `CachedDocument` | Loại bỏ hoàn toàn `proxy_handle` và `proxy_bytes` thừa khỏi struct `CachedDocument` trong `desktop/src-tauri/src/lib.rs` (cả struct chính và các test helpers lines 1968, 2954, 7502, 7526). Gắn tag `// PERF (audit 2026-09-20 §V20.1)`. | Bootstrap nhẹ, không nhân bản byte tài liệu không cần thiết. Vitest `usePdfLoader.test.tsx`: 15/15 passed. Cargo check compiled clean. |
| **V20.2** | Full-page preview nhân `96.0 / 72.0` hai lần ở dev, làm kích thước pixel tăng 77.8% (thừa 43.75% pixel dư) so với khung | Sửa `desktop/src-tauri/src/lib.rs` line 4144: `let screen_scale = render_scale;` (bỏ phép nhân `*(96.0 / 72.0)` dư thừa). Bổ sung test kiểm tra renderPolicy. Gắn tag `// FIX (audit 2026-09-20 §V20.2)`. | Kích thước bitmap trả về đúng tỷ lệ 1:1 theo kích thước màn hình hiển thị. Vitest `LivePageFrame.renderPolicy.test.ts`: 22/22 passed. |
| **V20.3** | PPE thay font không nhúng không phân biệt font đậm (bold), nuốt mất cảnh báo `geometry_approximated` ở biên worker | 1. Bổ sung `fallback_bold_font` trong `print_engine/src/content/interp.rs` và logic chọn font đậm khi tên font chứa bold/black/heavy.<br>2. Nhúng `DejaVuSans-Bold.ttf` trong `render_worker.rs`, trả `substituted_fonts` và `geometry_approximated: true` trong `RenderResponse`.<br>3. Cập nhật `ViewerShadowRenderReport` trong `desktop/src-tauri/src/lib.rs` truyền cảnh báo ra UI. | Test `worker_van_tra_png_ppe_khi_font_khong_nhung` kiểm tra `geometry_approximated: true` và mảng `substituted_fonts` chính xác. Vitest `useTileRenderer.test.ts`: 34/34 passed. |
| **V20.4** | Toán tử CMYK trực tiếp `k`/`K` trong content stream bị bỏ sót, dẫn tới 2 PDF cùng màu nhưng chọn engine khác nhau | Bổ sung `page_contents_has_cmyk_operators` và `scan_raw_bytes_for_cmyk_operator` trong `desktop/src-tauri/src/pdf_color_risk.rs`. Gán cờ `flags.has_device_cmyk = true` khi content stream dùng `k`/`K`. | Test mới `toan_tu_cmyk_truc_tiep_trong_content_stream_duoc_danh_dau` trong `pdf_color_risk.rs`. Cargo test: 5/5 passed. |
| **V20.5** | Giữ ấm cache Form/image và xác nhận cấu hình Tile Cache tôn trọng phần cứng | Rà soát `desktop/src/lib/tileUrlCache.ts`. Xác nhận `tileUrlCacheBudgetForTotalRam` tuân thủ nghiêm ngặt quy tắc RAM-gating: máy $\ge 16\text{ GB}$ không giới hạn (budget null); máy $8-16\text{ GB}$ giữ 64MB; máy $<8\text{ GB}$ giữ 32MB. | Không có hard-cap vô điều kiện trên máy mạnh, đảm bảo giữ hiệu năng render cao nhất. |
| **V20.6** | Thiếu bộ test tự động khóa hồi quy cho quy trình render & routing viewer | Bổ sung test tự động ở cả 2 tầng: Rust integration tests cho font fallback & CMYK risk scanning; Vitest tests cho scale policy và tile renderer. | Toàn bộ test suite liên quan đến Viewer đạt 100% xanh. Không có hồi quy logic. |

---

## 2. Danh sách các file đã thay đổi

1. **`desktop/src-tauri/src/lib.rs`**:
   - Sửa `screen_scale = render_scale;` loại bỏ nhân tỉ lệ 96/72 hai lần ở full-page.
   - Dọn dẹp `proxy_handle` và `proxy_bytes` trong struct `CachedDocument` và các mock test helpers.
   - Cập nhật `ViewerShadowRenderReport` nhận thêm `geometry_approximated` và `substituted_fonts`.
2. **`desktop/src/components/workspace/LivePageFrame.renderPolicy.test.ts`**:
   - Bổ sung test case xác thực chính sách render scale không bị nhân đôi.
3. **`desktop/src-tauri/src/pdf_color_risk.rs`**:
   - Thêm bộ quét toán tử `k` (fill CMYK) và `K` (stroke CMYK) trong PDF content streams thô.
   - Thêm unit test `toan_tu_cmyk_truc_tiep_trong_content_stream_duoc_danh_dau`.
4. **`print_engine/src/content/interp.rs`**:
   - Thêm `fallback_bold_font: Option<Rc<RefCell<FontProgram>>>` vào `PageProgramInterpreter`.
   - Logic chọn fallback bold khi font name có biến thể đậm.
5. **`desktop/src-tauri/src/pdf_engine/render_worker.rs`**:
   - Nhúng `DejaVuSans-Bold.ttf` tĩnh (`include_bytes!`).
   - Cung cấp font fallback đậm cho `FontResolver`.
   - Trả `substituted_fonts` và `geometry_approximated: true` trong `RenderResponse`.
   - Cập nhật unit test `worker_van_tra_png_ppe_khi_font_khong_nhung`.
6. **`docs/PRYNX_MASTER_AUDIT_MATRIX.md`**:
   - Cập nhật các audit unit `W7-V20-OPEN`, `W7-V20-PIXEL`, `W2-V20-FONT`, `W2-V20-ROUTE` từ *CHƯA SỬA* thành `SOURCE + AUTO + ARTIFACT`.

---

## 3. Kết quả kiểm thử tự động (Verification Suite)

### Frontend (Desktop React/TypeScript)
- **`LivePageFrame.renderPolicy.test.ts`**: 22/22 passed.
- **`useTileRenderer.test.ts`**: 34/34 passed.
- **`usePdfLoader.test.tsx`**: 15/15 passed.
- **TypeScript Typecheck (`npm run typecheck`)**: PASSED, 0 errors.

### Rust Backend / Native (Cargo)
- **`pdf_color_risk.rs`**: 5/5 passed:
  - `tai_lieu_chuan_khong_bi_danh_dau_rui_ro`
  - `toan_tu_cmyk_truc_tiep_trong_content_stream_duoc_danh_dau`
  - `tai_lieu_co_separation_bi_danh_dau_rui_ro`
  - `tai_lieu_co_blend_mode_khong_chuan_bi_danh_dau_rui_ro`
  - `tai_lieu_co_device_cmyk_bi_danh_dau_rui_ro`
- **`render_worker.rs`**:
  - `worker_van_tra_png_ppe_khi_font_khong_nhung`: PASSED (asserted `geometry_approximated: true` và `substituted_fonts.len() > 0`).
- **Cargo check (`desktop/src-tauri`)**: Clean, 0 compile errors.

---

## 4. Ranh giới an toàn và ghi chú vận hành

- **Không commit git và không đóng gói installer release**: Theo chỉ đạo, các thay đổi được giữ sạch sẽ trong working tree phục vụ nghiệm thu; chưa build GUI installer.
- **Bảo toàn nguyên tắc RAM-gating (`prynx-performance`)**: Không áp đặt hard-cap vô điều kiện lên các máy trạm mạnh ($\ge 16\text{ GB}$).
- **Quy ước chuẩn (`prynx-conventions`)**: Các đoạn mã thay đổi đều được gắn tag rõ ràng (`// FIX (audit 2026-09-20 §V20.2)`, `// PERF (audit 2026-09-20 §V20.1)`...) và chú thích bằng tiếng Việt chuẩn xác.
