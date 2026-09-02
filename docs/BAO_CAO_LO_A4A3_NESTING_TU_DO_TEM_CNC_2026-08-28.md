# BÁO CÁO LÔ A4a-3 — HIỆN OPTION "CÁCH XẾP" DƯỚI CỜ RIÊNG

**Ngày:** 2026-08-28
**Chặng:** A — lô thứ sáu
**Quyết định của chủ dự án:** cờ **riêng** `VITE_TRUE_SHAPE_NESTING_ENABLED`, tách khỏi cờ Mixed Nesting standalone
**Trạng thái:** **PASS** — chờ duyệt

---

## 1. Mã lô và mục tiêu

Đóng nửa còn lại của **C0-3**: hiện option "Nesting tối ưu theo đường bế" trong dropdown **Cách xếp**, chỉ ở `taskMode = nup` của Tem bế/CNC, dưới internal flag. Không đổi default, không thêm ô nhập góc.

Tách hai bước vì tính đủ nơi chứa test thì thành 6 file:

| Lô | Nội dung | Số file |
|---|---|---:|
| **A4a-3** | cờ + quy tắc phạm vi + nối vào dropdown + i18n + test quy tắc | 5 |
| **A4a-3b** | test DOM trong file test sẵn có của component | 1 |

---

## 2. File đã đổi — chính xác 6 file

### A4a-3 (5 file)

| File | Loại | Thay đổi |
|---|---|---|
| `desktop/src/components/imposition-tools/trueShapeNestingRollout.ts` | **mới** | cờ riêng + `shouldShowTrueShapeNestingOption` |
| `desktop/src/components/imposition-tools/sections/GridSettingsSection.tsx` | tracked | thêm option, gate bằng đúng một biến |
| `desktop/src/i18n/locales/vi.json` | tracked | key `nesting_theo_duong_be` |
| `desktop/src/i18n/locales/en.json` | tracked | key tương ứng |
| `desktop/src/components/imposition-tools/trueShapeNestingRollout.test.tsx` | **mới** | 10 test quy tắc |

### A4a-3b (1 file)

| File | Thay đổi |
|---|---|
| `desktop/src/components/imposition-tools/sections/GridSettingsSection.mixedGuillotine.test.tsx` | +5 test DOM (31 → 36) |

Không chạm store slice, `processHandlers`, `GridPreview`, `ImposerDashboard`, route hay backend. Không stage, không commit.

---

## 3. Vì sao cờ riêng, không dùng chung

`MIXED_NESTING_ENABLED` gác công cụ **Bình lồng ghép tự do standalone**. Chiến lược này là đường **khác**: nó nằm bên trong Bình tem bế/CNC hiện hữu. Dùng chung cờ thì khi cần kill switch cho một đường sẽ phải tắt luôn đường kia — có test khoá đúng điều này:

```ts
expect(TRUE_SHAPE_NESTING_FLAG_NAME).not.toBe(MIXED_NESTING_FLAG_NAME);
```

Đặt sẵn `PRYNX_TRUE_SHAPE_NESTING_ENABLED` cho phía backend để lô route sau có cặp cờ khớp chính tả — cùng khuôn `build_production.ps1` đang nung cho Mixed Nesting.

Mặc định ở bản phát hành là **HOLD**: `isDevelopment || releaseEnabled`. Dev mở như mọi tính năng đang làm; bản phát hành phải bật tường minh. Lý do giữ HOLD: số đo Lô 0 cho thấy free-angle **kém** cardinal ở 8/9 ca và Cổng Chặng B chưa đóng.

---

## 4. Quy tắc phạm vi — một điểm chặn duy nhất

`shouldShowTrueShapeNestingOption` yêu cầu **ba điều kiện đồng thời**: cờ bật, công cụ thuộc `{sticker_imposer, cnc_imposer}`, và `taskMode === 'nup'`.

Component gọi đúng một lần, gán vào một biến, dùng một chỗ. Không có nhánh thứ hai quyết định phạm vi.

**Chưa mở cho `step_repeat` (Bình trang/S&R)** — đây là quyết định có số đo: kernel còn kém baseline rất xa ở S&R hình tam giác, **77–84 so với 152 con/tờ**. Hiện option ở đó là mời người dùng chọn phương án tệ hơn đường hiện hữu.

Cũng khoá ca legacy: `sticker_imposer`/`cnc_imposer` từng bị dùng như **taskMode**; giá trị legacy đó ở ô taskMode không được coi là nhánh gang. Có test riêng cho ca này.

---

## 5. Lệnh test và kết quả

| Phạm vi | Kết quả |
|---|---|
| `trueShapeNestingRollout.test.tsx` (quy tắc) | **10 passed** |
| `GridSettingsSection.mixedGuillotine.test.tsx` (DOM) | **36 passed** (trước lô: 31) |
| vitest imposition-tools + imposerEngine + mixed-nesting + stores | **46 file, 606 passed** |
| `npm run typecheck` | **exit 0** |
| `npm run lint` | **exit 0** (2 warning có sẵn ở `useIncomingFileDispatcher.ts`, không thuộc lô) |
| i18n JSON parse + key ở cả hai ngôn ngữ | vi/en đều **189 namespace**, key mới có ở cả hai |

### 5.1. Mutation test — cả hai chiều

Test hiển thị rất dễ xanh vô nghĩa, nên tôi kiểm cả hai hướng sai.

| Mutation | Kết quả |
|---|---|
| `{true && (` — luôn hiện option | **3 failed**: hai ca âm của tôi, **cộng một test có sẵn** (`Đổi đầu xen kẽ (Inking) > là thiết lập riêng, giữ nguyên Cách xếp…`) vốn khoá đúng tập option |
| `{false && (` — không bao giờ hiện | **1 failed**: ca dương |

Lượt mutation thứ nhất còn cho một thông tin có giá trị: tập option của dropdown **đã** được một test cũ bảo vệ, nên nếu tôi thêm option vô điều kiện thì hồi quy bị bắt ngay cả khi không có test mới. Đã hoàn nguyên, kiểm lại còn đúng 1 chỗ `showTrueShapeNesting && (`, chạy lại: 36 passed.

### 5.2. Hai tầng test, hai mục đích khác nhau

- `trueShapeNestingRollout.test.tsx` khoá **quy tắc**.
- Test DOM khoá việc component **đã nối** quy tắc đó vào dropdown.

Thiếu tầng hai thì quy tắc có thể đúng mà component quên gọi, hoặc gọi với tham số sai — và đó chính là ca mutation `{true && (` bắt được.

Ngoài ra test DOM còn khoá hai điều mà quy tắc không nói được:

- **không đổi default**: tập option cũ vẫn đúng `[optimal_auto, simple_auto, manual]` theo thứ tự, và giá trị đang chọn vẫn là `optimal_auto`;
- **không có ô nhập góc**: `queryByLabelText(/góc|angle|rotation/i)` phải là `null`. Đích cuối là solver tự tìm góc; UI tuyệt đối không có control góc.

---

## 6. Trạng thái người dùng thấy

Ở bản phát hành hiện tại, người dùng **không thấy gì thay đổi**: cờ HOLD nên option không xuất hiện. Trong dev, option xuất hiện ở đúng bốn ô Tem bế/CNC × gang.

Chọn option lúc này **chưa** đi tới kernel: `processHandlers` vẫn gửi contract cũ (lô A4b). Nhưng nếu giá trị lọt xuống solver lưới thì guard của lô A4a-2 sẽ **ném lỗi ồn ào** thay vì âm thầm trả lưới cũ. Nghĩa là trạng thái trung gian này an toàn theo nghĩa "không im lặng làm sai", dù chưa hoàn chỉnh.

---

## 7. Finding

**C0-3 đã ĐÓNG hoàn toàn:** giá trị có ở nguồn chân lý Rust, union viết tay đã xoá, option đã hiện đúng phạm vi dưới cờ riêng.

| Mã | Phát hiện | Mức | Thuộc lô |
|---|---|---:|---|
| A4a-1 | **ĐÃ ĐÓNG ở lô F1.** Nguyên nhân thật là timeout 5000ms dưới tranh CPU, không phải ô nhiễm state như tôi đoán ban đầu | đóng | F1 |
| A4a-2 | Nửa 2 của phương án (a): wire format vẫn chuỗi thuần, chưa tagged `{kind}` | P3 (nợ) | lô riêng sau Cổng A |
| A4a-3 | Cờ backend `PRYNX_TRUE_SHAPE_NESTING_ENABLED` đã đặt tên nhưng **chưa được nung** trong `build_production.ps1`, và chưa có consumer backend | P3 | lô A4b/route |
| A3-1 | `cutStyle.stroke` thiếu alternate cho separation | P2 | lô contract sau |
| A2-1 | `cnc_render.py:360` còn nén `gap = max(gap_x, gap_y)` | P2 | lô nối route |
| C0-6 | Kernel chưa nhận worker/RAM grant | P2 | Chặng B |
| C0-7 | Ngân sách work dùng chung cả run | `[SUSPECTED]` | Chặng B, đo trước |
| A1-1 | `imposition_pdf_form.py.rej` an toàn để xoá | P3 | dọn scratch |
| A1-2 | Toàn suite pytest có thể crash native trong PDFium | P2, `[SUSPECTED]` | đợt `pdfium_guard()` |

---

## 8. Kết luận

**PASS.**

- Option đã hiện đúng bốn ô Tem bế/CNC × gang, dưới cờ riêng, mặc định HOLD ở bản phát hành.
- Phạm vi nằm trong một hàm thuần, một điểm chặn; ca âm được khoá đầy đủ gồm S&R, công cụ khác, cờ tắt và giá trị taskMode legacy.
- Hai tầng test (quy tắc + DOM) với mutation test cả hai chiều.
- Không đổi default, không bỏ option cũ, không thêm ô nhập góc — có test khoá từng điều.
- Trạng thái trung gian an toàn: nếu giá trị lọt xuống solver lưới thì guard A4a-2 ném lỗi ồn ào.

---

## 9. Lô tiếp theo — A4b

**Lô A4b (≤5 file):** nối `processHandlers` → route.

- `processHandlers.ts`: khi `gridStrategy === 'true_shape_nesting'`, dựng payload đi đường production nesting thay vì contract lưới cũ.
- `GridPreview.tsx` / `ImposerDashboard.tsx`: hai callsite preview còn lại (đơn và batch) phải đi cùng một đường; tuyệt đối không để preview solve riêng.
- Route Imposition phía backend: nhận strategy mới, gọi `solve_production_nesting` **trong** job N-Up đã có grant, không gọi `/mixed-nesting/jobs` lồng.
- Test API.

Rủi ro chính của A4b là ba callsite payload lệch nhau — báo cáo Lô 0 §3.3 đã đo: EXECUTE dùng camelCase + mm, PREVIEW dùng snake_case + point, và có callsite thứ ba là `preview-layouts-batch`. Tôi sẽ trace đủ ba đường trước khi sửa và báo lại nếu phạm vi vượt 5 file.

Sau A4b mới tới **Cổng Chặng A**: bốn ô gang không overlap/clearance/obstacle/boundary violation, đủ quantity, preview và export cùng `manifestId`, solver call count = 1, legacy không hồi quy.
