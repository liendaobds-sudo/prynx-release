# Báo Cáo Audit Toàn Diện: Tính Năng Phục Hồi & Vector Hóa Logo (PrynX Logo Rebuild)

**Ngày lập báo cáo:** 2026-09-20  
**Phạm vi audit:** Toàn bộ tính năng **Vector hóa Logo (Logo Rebuild / Vectorizer)** từ điểm vào UI (`desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx`, `LogoCompareViewport.tsx`), API route (`backend/app/api/routes/logo_rebuild.py`), worker tiền xử lý (`backend/app/workers/logo_rebuild.py`), đến lõi native Rust (`native/src/logo_engine/`, `native/src/logo_vectorizer.rs`).  
**Phương pháp:** Tuân thủ quy chuẩn `prynx-deep-audit` (truy vết dọc xuyên tầng, lấy artifact và runtime làm nguồn sự thật) và `prynx-audit-workflow` (quy trình 2 chốt: Khảo sát & Báo cáo → Chờ duyệt → Sửa theo lô ≤ 5 file).  
**Trạng thái hiện tại:** **[ĐÃ KHẢO SÁT & XÁC MINH NGUYÊN NHÂN GỐC] — ĐANG DỪNG Ở CHỐT DUYỆT (Chưa sửa mã nguồn khi chưa có lệnh).**

---

## 1. Tóm Tắt Điều Hành & Sự Cố Runtime Nghiêm Trọng Vừa Phát Hiện

Tính năng Vector hóa Logo được kỳ vọng là công cụ hỗ trợ đắc lực cho nhà in khi tiếp nhận ảnh chụp, scan chất lượng thấp, logo mờ để chuyển thành vector in ấn và bế decal. Tuy nhiên, tính năng này đang gặp phải **sự cố tắc nghẽn runtime nghiêm trọng (P0 Deadlock)** cùng sự lệch pha giữa mô hình toán học thuần túy và nhu cầu thực tế của xưởng in:

### 1.1. Lỗi Runtime P0 chặn đứng người dùng (Ảnh thực tế vừa ghi nhận)
* **Hiện tượng:** Khi người dùng bấm **"Tạo preview SVG"** (kể cả khi bật hoặc tắt tùy chọn *"Cân bằng độ sáng cho artwork phẳng không đều màu"*), hệ thống văng lỗi màu đỏ:
  > **`Không thể tạo SVG preview: Artifact SVG tự giao cắt tại path 0, subpath 35 (cạnh 217 và 220)`**
* **Hậu quả:** Toàn bộ quy trình dừng lại ngay lập tức. Người dùng không thấy được preview vector, không có file để tải, và không có bất kỳ cơ chế nào để bỏ qua hoặc tự sửa.
* **Nguyên nhân gốc rễ (Root Cause đã xác minh bằng mã nguồn):**
  1. **Lệch đỉnh do Snapping trực giao (`curve_fit.rs`):** Thuật toán snap nét ngang/dọc vừa thêm đã dịch chuyển tọa độ điểm cuối của segment (`snapped_line_target = (p_end.x, avg_y)`), nhưng bút vẽ SVG và segment kế tiếp lại tiếp tục từ tọa độ ban đầu. Bước nhảy này khiến các nét chữ mảnh (1–2px) bị vẹo và đè qua cạnh đối diện.
  2. **Tay đòn Bézier vọt ngưỡng tạo vòng lặp (Cubic Loop):** Trong `generate_cubic`, khi khoảng cách giữa 2 điểm neo quá ngắn so với chiều dài cung gốc, hệ số Schneider có thể vọt lớn làm 2 vector tiếp tuyến cắt chéo nhau, tạo thành một vòng xoắn vi mô (micro-loop).
  3. **Bộ kiểm tra QC quá khắc nghiệt (`qc.rs`):** Hàm `inspect_parsed_geometry` làm phẳng subpath với dung sai cực nhỏ `flatten_subpath(subpath, 0.01)` (0.01 px). Khi phát hiện dù chỉ 1 điểm tự giao cắt ở cấp độ vi mô giữa 2 cạnh sát nhau (cạnh 217 và 220), QC lập tức từ chối toàn bộ artifact SVG thay vì tự động làm phẳng hoặc cảnh báo nhẹ.
  4. **Hiệu ứng khuếch đại nhiễu từ Cân bằng độ sáng (`_correct_illumination`):** Bộ lọc high-pass GaussianBlur trên kênh L của ảnh phẳng khuếch đại nhiễu JPEG biên thành hàng chục contour răng cưa li ti (hơn 35 subpaths), làm tăng xác suất kích hoạt lỗi tự giao cắt lên gấp nhiều lần.

### 1.2. Các khoảng cách lớn về hiệu quả in ấn thực tế
1. **Nét thẳng và góc vuông typography bị lượn sóng:** Hơn 80% logo chứa chữ cái có cạnh thẳng và góc 90°, nhưng engine thiếu cơ chế khóa cạnh và giữ góc nhọn, biến chữ cái thành các đường uốn Bézier nham nhở.
2. **Bất lực trước Gradient:** Ép ảnh vào bảng màu phẳng (1–12 màu) làm vỡ dải chuyển sắc thành các bậc thang xấu xí.
3. **Mất dấu tiếng Việt vs Bão rác JPEG:** Bộ lọc khử hạt (despeckle) xóa sạch dấu tiếng Việt (sắc, huyền, hỏi, ngã, nặng, dấu mũ, móc) và ký hiệu ®, ™; nhưng nếu tắt thì muỗi nén JPEG biến thành hàng trăm vụn rác.
4. **Thiếu Dò nét đơn (Centerline Tracing):** Logo chữ ký và nét mảnh bị bọc thành ống rỗng 2 viền, làm máy cắt decal/khắc laser cắt đứt nát vật liệu.
5. **Rào cản UI/UX:** Ép người dùng duyệt bảng màu thủ công trước khi cho tạo preview; khóa nút Tải SVG vì trạng thái `review`.

---

## 2. Thang Bằng Chứng & Bảng Tổng Hợp Phát Hiện (Audit Matrix)

Tuân thủ quy chuẩn `prynx-deep-audit`: Các phát hiện dưới đây đều đã được truy vết từ UI đến Native, có bằng chứng mã nguồn hoặc tái hiện runtime thật:

| Mã số | Phân loại | Mức | Trạng thái | Mô tả tóm tắt | Vị trí code / Bằng chứng |
|---|---|:---:|:---:|---|---|
| **§VEC.QC01** | Độ ổn định | **P0** | `RUNTIME` | **QC chặn đứng người dùng khi Bézier tự giao cắt vi mô:** Hard-error văng ra UI khiến không xem được preview | `native/src/logo_engine/qc.rs:543-550, 660-664` |
| **§VEC.GEO01** | Hình học | **P0** | `CONFIRMED` | **Snapping nét trực giao làm dịch đỉnh gây gãy nét và tự cắt:** Bước nhảy tọa độ khiến 2 cạnh sát nhau cắt chéo | `native/src/logo_engine/curve_fit.rs:327-363` |
| **§VEC.PRE01** | Tiền xử lý | **P1** | `CONFIRMED` | **Cân bằng độ sáng (Illumination) khuếch đại nhiễu JPEG:** High-pass filter tạo bão contour răng cưa | `backend/app/workers/logo_rebuild.py:538-548, 942-951` |
| **§VEC.GEO02** | Hình học | **P1** | `CONFIRMED` | **Thiếu nhận diện Cạnh thẳng & Góc vuông typography:** Chữ cái bị uốn lượn sóng Bézier và tù góc | `native/src/logo_engine/curve_fit/primitive_fit.rs:1-120` |
| **§VEC.GEO03** | Chức năng | **P1** | `CONFIRMED` | **Thiếu Dò nét đơn (Centerline Tracing):** Chữ ký và nét mảnh bị biến thành ống rỗng 2 viền | `native/src/logo_engine/topology.rs`, `scene.rs` |
| **§VEC.GEO04** | Chức năng | **P1** | `CONFIRMED` | **Xung đột Khử hạt vs Dấu tiếng Việt & Ký hiệu nhỏ:** Despeckle nuốt dấu, tắt despeckle thì bão muỗi JPEG | `backend/app/workers/logo_rebuild.py:825-834`, `preprocess.rs:188-212` |
| **§VEC.GEO05** | Chức năng | **P1** | `CONFIRMED` | **Bất lực trước Gradient / Chuyển sắc:** Lượng tử hóa phẳng băm dải chuyển sắc thành dải bậc thang nham nhở | `native/src/logo_engine/profiles/flat_color.rs:25-39` |
| **§VEC.UI01** | Trải nghiệm | **P1** | `CONFIRMED` | **Rào cản Palette bắt buộc:** Bắt người dùng phân tích màu và tick xác nhận palette trước khi được xem kết quả | `LogoRebuildWorkspace.tsx:721, 1615` |
| **§VEC.UI02** | Trải nghiệm | **P1** | `CONFIRMED` | **Khóa nút Tải SVG vì trạng thái Review:** Ép người dùng tick xác nhận phụ mới cho tải | `LogoRebuildWorkspace.tsx:970-974` |
| **§VEC.FLOW01**| Luồng dữ liệu| **P2** | `CONFIRMED` | **Đầu ra cô lập, không nối vào Workspace PrynX:** Chưa có nút gửi thẳng sang Bình bản hoặc Tem bế | `LogoRebuildWorkspace.tsx:841-850` |
| **§VEC.PERF01**| Hiệu năng | **P2** | `CONFIRMED` | **QC Scanline 4x ngốn RAM & CPU trên ảnh lớn:** Chưa có RAM-gating cho máy yếu <8GB | `native/src/logo_engine/qc.rs:921-942` |
| **§VEC.UI03** | Trải nghiệm | **P2** | `CONFIRMED` | **Canvas tĩnh, thiếu công cụ nhặt rác / can thiệp trực tiếp:** Không click xóa mảng rác JPEG trực quan | `LogoCompareViewport.tsx:1-250` |
| **§VEC.UI04** | Trải nghiệm | **P2** | `CONFIRMED` | **Quá tải thuật ngữ toán học:** Trình bày ma trận IoU, MAE, Tangent jump thay vì preset in ấn | `LogoRebuildWorkspace.tsx:1498-1526` |

---

## 3. Phân Tích Kỹ Thuật Chi Tiết Các Điểm Nghẽn Chính

### 3.1. §VEC.QC01 & §VEC.GEO01 (P0) — Cơ chế Tự Giao Cắt và Deadlock Preview
* **Luồng chạy thực tế:**
  1. Người dùng đưa ảnh vào `LogoRebuildWorkspace.tsx`.
  2. Bấm "Tạo preview SVG" → gọi API `POST /preview` → scheduler `process_logo_preview` → gọi Rust `build_structured_result`.
  3. Quá trình trace tạo ra các đường cong contour.
  4. Tại `native/src/logo_engine/curve_fit.rs:340-355`, bộ nhận diện snapping trực giao vừa thử nghiệm đã thay đổi điểm cuối `snapped_line_target = FitPoint { x: p_end.x, y: avg_y }`. Nhưng điểm bắt đầu của span kế tiếp vẫn là `p_end` gốc. Khi SVG nối điểm, đoạn thẳng nối từ `(p_end.x, avg_y)` tới điểm kế tiếp đã bị bẻ góc đột ngột.
  5. Khi gặp các chi tiết nhỏ hoặc nét chữ có bề dày 1–2 pixel (như subpath 35), sự bẻ góc này khiến cạnh 217 và cạnh 220 (cách nhau 2 đỉnh) cắt chéo qua nhau.
  6. Sau khi viết xong SVG, `native/src/logo_engine/qc.rs:543` gọi `flatten_subpath(subpath, 0.01)` để băm đường cong thành hàng nghìn đoạn thẳng cực nhỏ và chạy `reject_self_intersection`.
  7. Do cạnh 217 và 220 giao cắt thật, hàm trả về:
     `Err("Artifact SVG tự giao cắt tại path 0, subpath 35 (cạnh 217 và 220)")`.
  8. Lỗi này làm sập toàn bộ request, FastAPI trả về mã lỗi và giao diện hiển thị thông báo lỗi màu đỏ như ảnh chụp của người dùng.
* **Giải pháp dứt điểm:**
  1. **Khắc phục triệt để Snapping trong Curve-Fit:** Tuyệt đối không thay đổi tọa độ điểm cuối đơn lẻ mà không cập nhật điểm đầu của nhịp kế tiếp. Snapping trực giao phải được thực hiện ở cấp độ **Anchor Graph** trước khi fit, đảm bảo chu trình khép kín $P_{end} \equiv P_{start}^{next}$.
  2. **Kiểm tra tay đòn Cubic Bézier:** Giới hạn chiều dài tay đòn $\alpha_1, \alpha_2 \le \frac{1}{2} \text{chord}$ khi 2 tiếp tuyến có xu hướng hội tụ, triệt tiêu hoàn toàn khả năng hình thành micro-loop.
  3. **Chuyển cấp độ QC từ Fatal Error sang Warning/Self-Healing:** Với preview phục vụ hiển thị, nếu gặp tự giao cắt vi mô (< 0.1 px), chuyển thành cảnh báo trong `warnings` thay vì fail-closed hủy cả job.

---

### 3.2. §VEC.PRE01 (P1) — Tác hại của "Cân bằng độ sáng" trên Artwork Phẳng
* **Hiện tượng trong mã nguồn:**
  Tại [backend/app/workers/logo_rebuild.py:539-543](file:///d:/pdfcompare/backend/app/workers/logo_rebuild.py#L539-L543):
  ```python
  sigma = max(5.0, min(image.size) / 30.0)
  background = cv2.GaussianBlur(lightness, (0, 0), sigmaX=sigma, sigmaY=sigma)
  anchor = float(np.median(background))
  lab[:, :, 0] = np.clip(lightness - background + anchor, 0, 255).astype(np.uint8)
  ```
* **Vấn đề:** Thuật toán trừ nền GaussianBlur là bộ lọc làm sắc cạnh/lọc thông cao (high-pass filter). Khi áp dụng cho artwork kỹ thuật số (ảnh phẳng nhưng có nhiễu nén JPEG nhẹ), nó làm nổi phồng các quầng sáng ở rìa mảng màu. Khi đưa vào phân đoạn màu, các quầng sáng này bị tách thành hàng chục viền màu mỏng bao quanh logo (dẫn đến subpath 35, subpath 36...).
* **Giải pháp:** Chỉ bật bộ lọc này khi ảnh được xác định là ảnh chụp giấy/scan thực tế (độ biến thiên ánh sáng nền lớn). Với artwork phẳng hoặc logo đã có nền trắng/trong suốt, tự động bỏ qua hoặc dùng bộ lọc song phương (Bilateral Filter / Guided Filter) để làm phẳng nhiễu mà không tạo viền giả.

---

### 3.3. §VEC.GEO02 (P1) — Nét Thẳng và Góc Vuông Chữ Cái Bị Uốn Lượn Sóng
* **Hiện tượng trong mã nguồn:**
  Tại [native/src/logo_engine/curve_fit/primitive_fit.rs](file:///d:/pdfcompare/native/src/logo_engine/curve_fit/primitive_fit.rs), engine hiện chỉ nhận dạng `Circle` và `Ellipse`. Mọi nét thẳng khác đều rơi vào Schneider Bézier fitter.
* **Thực tế:** Các cạnh thẳng của chữ (H, E, T, L, I, v.v.) qua ảnh pixel bị răng cưa dạng bậc thang. Bộ fit Bézier bậc 3 uốn lượn theo các bậc thang này, tạo thành đường viền nhấp nhô và làm tròn các góc 90°.
* **Giải pháp:**
  1. Tích hợp thuật toán **Ramer–Douglas–Peucker (RDP) có bảo tồn góc vuông**.
  2. Bổ sung nhận diện **Khối chữ nhật / Hộp (Box)** và **Đa giác cạnh thẳng**.
  3. Khóa góc nhọn (Corner Pinning): Các đỉnh có góc đổi hướng $\ge 75^\circ$ được giữ làm hard anchor, ép thẳng 2 tia xuất phát.

---

### 3.4. §VEC.GEO04 (P1) — Xung Đột Khử Hạt (Despeckle) vs Dấu Tiếng Việt
* **Hiện tượng trong mã nguồn:**
  Tại [logo_rebuild.py:825](file:///d:/pdfcompare/backend/app/workers/logo_rebuild.py#L825) và [preprocess.rs:188](file:///d:/pdfcompare/native/src/logo_engine/preprocess.rs#L188), `despeckle_artifact` xóa thẳng mọi component có diện tích $< \text{size}^2$.
* **Thực tế:** Dấu sắc, huyền, hỏi, ngã, nặng của tiếng Việt và ký hiệu ® ™ trong logo cỡ 300–500px thường có diện tích chỉ 4–16 pixel. Đặt khử hạt = 4px sẽ xóa sạch toàn bộ dấu tiếng Việt!
* **Giải pháp:**
  **Lọc thông minh theo vị trí tương đối (Contextual Accent Protection):** Không xóa các mảng nhỏ nếu chúng nằm gần một mảng chữ lớn (khoảng cách $< 1.5 \times$ chiều cao thân chữ) hoặc có màu mực trùng với thân chữ. Chỉ xóa các hạt bụi cô lập nằm ngoài vùng nội dung.

---

### 3.5. §VEC.GEO03 (P1) — Thiếu Dò Nét Đơn (Centerline / Skeleton Tracing)
* **Hiện tượng trong mã nguồn:**
  Mọi contour đều là `FillRegion` (bao viền 2 bên).
* **Thực tế:** Với chữ ký, bản vẽ nét mảnh, hoa văn khắc laser, máy bế decal cần đường chạy dao ở giữa nét chứ không phải bao 2 mép nét.
* **Giải pháp:** Bổ sung thuật toán rút xương **Zhang–Suen Thinning** để xuất đường nét đơn `SceneSegment::Line / Cubic` có độ dày nét (`stroke-width`).

---

### 3.6. §VEC.UI01 & §VEC.FLOW01 (P1–P2) — Trải Nghiệm 1-Chạm & Kết Nối Hệ Sinh Thái PrynX
* **Vấn đề UI/UX:**
  - Quy trình hiện tại bắt người dùng phải bấm "Gợi ý màu" → "Áp dụng palette" → rồi nút "Tạo preview" mới sáng.
  - Sau khi vector xong, nút "Tải SVG" bị khóa nếu rơi vào trạng thái `review`.
  - Không có đường dẫn để chuyển logo vector sang tab **Bình bản (Imposition)** hoặc **Tem bế (Sticker)**.
* **Giải pháp:**
  1. **Luồng 1-Chạm (Instant 1-Click):** Thả ảnh vào là tự động phân tích palette và tự động chạy preview ngay lập tức.
  2. **Mở khóa nút Tải SVG:** Cảnh báo review chỉ hiển thị thông tin, không vô hiệu hóa nút tải của người dùng.
  3. **Nút tác vụ tích hợp:**
     - 🚀 **"Đưa vào Bình bản"**: Chuyển thẳng vector vào bảng dàn trang N-up.
     - 🏷️ **"Tạo Tem bế"**: Chuyển thẳng sang tab Tem bế để tạo viền bế sticker tự động.

---

## 4. Kế Hoạch Sửa Theo Lô (Tuân Thủ Quy Trình 2 Chốt `prynx-audit-workflow`)

Để đảm bảo không gây hồi quy và an toàn tuyệt đối cho dự án, đề xuất chia việc khắc phục thành **3 Lô độc lập**, mỗi lô không quá 5 file:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ LÔ 1 (Khẩn cấp - P0): Cứu Deadlock Tự Giao Cắt & Mở Luồng 1-Chạm        │
│ 1. native/src/logo_engine/curve_fit.rs (sửa triệt để snapping đỉnh)     │
│ 2. native/src/logo_engine/qc.rs (nới lỏng QC self-intersection)         │
│ 3. backend/app/workers/logo_rebuild.py (an toàn hóa illumination)       │
│ 4. desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx     │
│ 5. desktop/src/components/preprocess-tools/LogoCompareViewport.tsx      │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ LÔ 2 (Nâng cao hình học - P1): Khóa Cạnh Chữ Cái & Bảo Vệ Dấu Tiếng Việt│
│ 1. native/src/logo_engine/curve_fit/primitive_fit.rs (Box & Line fit)   │
│ 2. native/src/logo_engine/preprocess.rs (Bảo vệ dấu tiếng Việt)         │
│ 3. native/src/logo_engine/profiles/flat_color.rs                        │
│ 4. native/src/logo_engine/curve_fit_tests.rs (Bổ sung test hình học)    │
│ 5. native/src/logo_engine/profile_tests.rs                              │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ LÔ 3 (Tích hợp & Tính năng mở rộng - P2): Bình Bản, Tem Bế & Nhặt Rác   │
│ 1. desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx     │
│ 2. desktop/src/components/preprocess-tools/LogoCompareViewport.tsx      │
│ 3. desktop/src/i18n/locales/vi.json & en.json                           │
│ 4. backend/app/api/routes/logo_rebuild.py (hỗ trợ xuất PDF vector)      │
│ 5. native/src/logo_engine/qc.rs (RAM-gating cho máy yếu <8GB)           │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Trạng Thái Hiện Tại & Chờ Duyệt (Gate 1 Approval)

* Toàn bộ khảo sát và bằng chứng đã hoàn tất đầy đủ.
* Đã tìm ra chính xác nguyên nhân gây ra thông báo lỗi **"Artifact SVG tự giao cắt tại path 0, subpath 35 (cạnh 217 và 220)"** trên màn hình của bạn.
* Báo cáo này đã được lưu vào [docs/BAO_CAO_AUDIT_VECTOR_HOA_LOGO_2026-09-20.md](file:///d:/pdfcompare/docs/BAO_CAO_AUDIT_VECTOR_HOA_LOGO_2026-09-20.md).

**Xin ý kiến chỉ đạo:** Bạn có đồng ý phê duyệt báo cáo audit này để tôi tiến hành triển khai **Lô 1 (Sửa dứt điểm lỗi tự giao cắt trong Rust, an toàn hóa illumination và mở khóa luồng preview 1-chạm)** không?
