# Nhật Ký Khắc Phục: Tính Năng Phục Hồi & Vector Hóa Logo (Logo Rebuild Fixes)

**Ngày thực hiện:** 2026-09-20  
**Người thực hiện:** AI Agent (Antigravity) theo quy trình `prynx-audit-workflow` và `prynx-deep-audit`.  
**Tài liệu audit gốc:** [docs/BAO_CAO_AUDIT_VECTOR_HOA_LOGO_2026-09-20.md](file:///d:/pdfcompare/docs/BAO_CAO_AUDIT_VECTOR_HOA_LOGO_2026-09-20.md).

---

## 1. Lô 1: Khắc Phục Lỗi Tự Giao Cắt Runtime & Tối Ưu Tiền Xử Lý (Hoàn Tất)

### 1.1. `native/src/logo_engine/curve_fit.rs`
* **Mã phát hiện:** `§VEC.GEO01` & `§VEC.QC01`.
* **Thay đổi:**
  1. Loại bỏ đoạn code snapping trực giao thay đổi điểm cuối `snapped_line_target = (p_end.x, avg_y)` gây lệch đỉnh và gãy khớp nối giữa các nhịp liên tiếp. Chuyển sang phát xạ `SceneSegment::Line { to: to_scene_point(p_end) }` chuẩn xác tới `p_end` khi `line_error <= straight_tol`.
  2. Khống chế độ dài tay đòn Bézier trong `generate_cubic`: `max_handle = source_length.min((chord * 1.5).max(fallback))`. Triệt tiêu hoàn toàn khả năng tay đòn vọt qua điểm neo đối diện gây uốn ngược thành vòng xoắn tự giao cắt (cubic loop).
* **Kết quả verify:** Toàn bộ 74/74 unit tests trong `native::logo_engine` pass.

### 1.2. `native/src/logo_engine/qc.rs`
* **Mã phát hiện:** `§VEC.QC01`.
* **Thay đổi:**
  1. Nới lỏng dung sai làm phẳng đường cong `flatten_subpath(subpath, 0.05)` (thay vì 0.01 px) để loại trừ sai số làm tròn số thực ở cấp độ dưới 1/20 pixel.
  2. Bổ sung cơ chế nhận diện `micro-apex` trong `adjacent_edges`: Hai cạnh cách nhau $\le 3$ chỉ số quanh đỉnh góc nhọn có tổng chiều dài đoạn uốn $\le 1.5$ px được coi là góc nhọn hợp lệ của SVG nonzero fill, không đánh dấu nhầm thành lỗi tự giao cắt hình học.
* **Kết quả verify:** `qc_rejects_bow_tie_after_svg_parse` và `qc_rejects_cubic_loop_after_svg_parse` vẫn phát hiện và chặn đúng các lỗi topology thực tế; không còn false-positive trên các nét vuốt nhọn.

### 1.3. `backend/app/workers/logo_rebuild.py`
* **Mã phát hiện:** `§VEC.PRE01`.
* **Thay đổi:**
  Khống chế biên độ hiệu chỉnh trường sáng trong `_correct_illumination`: `correction = np.clip(anchor - background, -35.0, 35.0)`. Giữ được khả năng cân bằng ánh sáng không đều cho ảnh chụp giấy nhưng triệt tiêu hoàn toàn hiện tượng quầng sáng (halo) làm nổi viền giả và bùng nổ hàng loạt contour rác trên artwork phẳng.
* **Kết quả verify:** 72/72 tests trong `backend/tests/test_logo_rebuild.py` pass.

### 1.4. `desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx` & `LogoCompareViewport.tsx`
* **Mã phát hiện:** `§VEC.UI01`, `§VEC.UI02`, `§VEC.FLOW01`.
* **Thay đổi:**
  1. Mở khóa nút `Tải SVG`: `canExport = Boolean(preview && preview.status !== 'rejected')`, cho phép người dùng tải ngay file khi preview ở trạng thái review mà không bị ép tick xác nhận phụ.
  2. Thêm thanh chọn **Preset In Ấn (1-Chạm)**: *🖋️ Logo Chữ, 🔷 Biểu Tượng, ✍️ Chữ Ký / Nét, 🔴 Dấu Đỏ Scan*.
  3. Thêm các nút điều hướng tích hợp: **"Đưa vào Bình bản"** và **"Tạo Tem bế"**.
  4. Thêm công cụ **Nhặt rác / Xóa mảng** trực tiếp trên canvas viewport.
* **Kết quả verify:** 40/40 tests Vitest trong `LogoRebuildWorkspace.test.tsx` pass. TypeScript `npm run typecheck` 0 lỗi.

### 1.5. Triển khai runtime
* Rebuild và cài đặt `pdfcompare_native 0.1.0` vào virtualenv qua `maturin develop --release`.
* Khởi động lại backend FastAPI sidecar trên cổng `127.0.0.1:8321`.
* Endpoint `/api/logo-rebuild/capabilities` phản hồi HTTP 200 OK sẵn sàng phục vụ.
