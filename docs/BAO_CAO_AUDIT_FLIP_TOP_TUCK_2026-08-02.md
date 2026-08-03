# BÁO CÁO THIẾT KẾ — HỘP NẮP LẬT TỰ KHÓA, GÀI MẶT TRƯỚC

Ngày: 2026-08-02  
Phạm vi: generator khuôn bế 2D, cây panel gấp 3D, catalog, validation TS/Python/Rust, test và bundle sidecar.

## 1. Tóm tắt điều hành

Mẫu nguồn `khuon-01.svg` là một hộp một mảnh có khay tự khóa, nắp lật bản lề và mép gài mặt trước. Hình học và cây panel khác generator `pizza`, vì vậy phải đăng ký một `boxType` mới; không được mô hình hóa thành biến thể của generator cũ.

Tên kỹ thuật được chốt cho đợt triển khai:

- `boxType`: `flip_top_tuck`
- generator: `generateFlipTopTuckBox`
- biến thể: `ftt_self_lock`
- mã catalog: `PRYNX-FTT-01`
- tên UI: **Hộp nắp lật tự khóa, gài mặt trước**

Không gán mã FEFCO vì tài liệu nguồn không chứng minh một mã tiêu chuẩn cụ thể.

## 2. Bằng chứng mẫu nguồn

### §FTT.1 — Lưới kích thước vật lý đã được xác nhận

Mức: P0 · Effort: M

- SVG nguồn: `C:\Users\Khanh Pham\Desktop\khuon-01.svg`.
- SHA-256: `D3DD50F7EE847179ECBED34C5247435E861EB20C1FB4A4946FFCC69222920B96`.
- Ảnh kích thước do người dùng cung cấp xác nhận mẫu thành phẩm `L = 200 mm`, `W = 200 mm`, `D = 60 mm`.
- Tọa độ SVG dùng hệ số `1,00969 raw unit / mm`; generator mới phải dựng trực tiếp bằng mm, không chép tọa độ Illustrator.
- CUT gồm một contour ngoài và bảy đường cắt hở có chủ đích. CREASE trong SVG đã outline thành hàng nghìn dash nhỏ; khi port phải dựng lại thành 12 nếp liên tục.

Các quan hệ đo được và được phép tổng quát hóa:

| Chi tiết | Mẫu 200×200×60 | Công thức generator |
|---|---:|---:|
| Nửa thành | 30 mm | `D / 2` |
| Mép gài trước | 20 mm | `D / 3` |
| Relief cut góc | 12 mm | `D / 5` |
| Đoạn thẳng khe khóa cạnh | 140 mm | `W - D` |
| Đầu chéo khe khóa | 3 mm | `D / 20` |
| Bề ngang thân/đáy | 201 mm | `L + 2T` |
| Chiều sâu đáy | 199,5 mm | `W - T` |
| Kích thước panel nắp | 200 × 200 mm | `L × W` |
| Tràn lề tham chiếu | 5 mm | cấu hình BLEED khi xuất, không hardcode vào CUT |

Không khóa `W = L` và không suy `D = 0,3L`; đây chỉ là tỷ lệ của fixture chuẩn.

### §FTT.2 — Cần một generator và cây panel mới

Mức: P0 · Effort: L

- Union loại hộp hiện nằm tại `desktop/src/lib/dieline/types.ts:163`.
- Dispatch nguồn hình học nằm tại `desktop/src/lib/dieline/engine.ts:23`.
- Generator gần nhất là `PizzaBox.ts`, nhưng mẫu mới có mép trước thấp, khe khóa cạnh dài, bốn relief cut và contour khóa riêng.

Cây panel đã triển khai và được khóa bằng test cấu trúc:

```text
bottom
├─ front_lip
├─ base_side_left
├─ base_side_right
└─ back_wall
   ├─ back_lock_left
   ├─ back_lock_right
   └─ lid
      ├─ lid_side_left
      ├─ lid_side_right
      └─ lid_front
         ├─ lid_front_lock_left
         └─ lid_front_lock_right
```

Mọi `pivotEdge` phải là cạnh chung hình học thật; trình tự gập chi tiết khóa trước, vách khay sau, rồi nắp ở pha cuối.

### §FTT.3 — Ba allow-list bắt buộc phải đồng bộ

Mức: P0 · Effort: S

- TypeScript runtime: `desktop/src/lib/dieline/runtimeValidation.ts:15`.
- FastAPI: `backend/app/api/routes/dieline_validation.py:32`.
- Rust/native trước Boa: `native/src/dieline_request.rs` trong `validate_request_json`.

Thiếu một trong ba nơi sẽ làm loại hộp hoạt động ở một tầng nhưng bị từ chối ở tầng khác.

### §FTT.4 — Catalog và mặc định phải giữ tham số chỉnh độc lập

Mức: P1 · Effort: S

- Catalog biến thể nằm tại `desktop/src/lib/dieline/variants.ts:139`.
- Mặc định theo loại hộp nằm tại `desktop/src/stores/useBoxStore.ts:117`.

Preset chuẩn: `L=200`, `W=200`, `D=60`, `T=0,5`, `C=0,5`. Người dùng được chỉnh độc lập cả `L`, `W`, `D`, `T`, `C`.

### §FTT.5 — Nghĩa vụ kiểm thử và sidecar

Mức: P0 · Effort: L

Phải có đủ:

1. Test cấu trúc panel, pivot, CUT/CREASE đặc thù.
2. Property test trên dải kích thước chữ nhật, kiểm hữu hạn và không suy biến.
3. Contour/bleed test; bảy đường cắt nội bộ không bị ép thành contour kín.
4. Golden master riêng cho fixture `200 × 200 × 60` và chỉ cập nhật snapshot mới của loại này.
5. Validation mirror TS/Python/Rust.
6. Build lại bundle TypeScript nhúng vào native trước khi kiểm Rust/backend.
7. Kiểm tay canvas 2D, fold progress 0→100% và PDF đo thật.

## 3. Kế hoạch sửa theo lô

Mỗi lô tối đa 5 file; hết lô phải chạy verify hẹp trước khi tiếp tục.

| Lô | Phạm vi | File dự kiến |
|---|---|---|
| A | Hợp đồng + generator 2D/3D | `types.ts`, `constants.ts`, `FlipTopTuckBox.ts`, `engine.ts`, `index.ts` |
| B | Catalog + mặc định + runtime TS | `variants.ts`, `useBoxStore.ts`, `runtimeValidation.ts`, `validateParams.ts`, `variants.test.ts` |
| C | Biên Python/Rust | `dieline_validation.py`, `dieline_request.rs`, test mirror backend, test route/native liên quan |
| D | Test hình học cốt lõi | `generators.test.ts`, `arbitraries.ts`, `geometry.test.ts`, `contourValidator.test.ts`, `bleedContours.test.ts` |
| E | Test parity và hồi quy | `goldenMaster.test.ts`, `regression.test.ts`, `legend.test.ts`, `sharedGeometry.test.ts`, `geometryHelpers.test.ts` |
| F | UI/i18n/ảnh catalog | `vi.json`, `en.json`, SVG catalog sinh từ generator và test giao diện/store cần thiết |
| G | 3D mở rộng + bundle | test mockup3d cần thiết, bundle sidecar sinh lại, log triển khai |

## 4. Rủi ro và giới hạn

- Repo đang có nhiều thay đổi ngoài phạm vi; riêng `vi.json` và `en.json` cũng đang được chỉnh. Chỉ chèn khóa mới, không định dạng lại toàn file.
- Chưa có video gấp hộp. Cây panel sẽ bám tuyệt đối vào 12 CREASE và cạnh chung trong SVG; trạng thái khóa vật lý cuối phải được kiểm mắt trong ứng dụng.
- Nesting thông minh riêng chưa cần thiết ở phiên bản đầu; loại mới được phép dùng đường lùi grid an toàn, không kém grid.

## 5. Chốt duyệt

Người dùng đã xác nhận “ok làm đi” ngày 2026-08-02 sau khi được thông báo preset, tham số chỉnh độc lập và quy trình theo lô. Đợt triển khai được phép bắt đầu trong đúng phạm vi báo cáo này.

## 6. Kết quả triển khai

- [VERIFIED] Generator `generateFlipTopTuckBox` sinh 13 panel, 12 CREASE, một contour CUT ngoài kín và bảy CUT hở có chủ đích. Fixture chuẩn có bbox `(-60, -20) → (261, 519,5)`, tức `321 × 539,5 mm`.
- [VERIFIED] Catalog/i18n/form/store đã nhận `flip_top_tuck`; preset là `200 × 200 × 60 mm`, `T=C=0,5 mm`, panel gốc nằm ngang và `L/W` chỉnh độc lập.
- [VERIFIED] Mặt in 3D dùng cap âm Z. Property test đã phát hiện outline `lid_front` thu sai theo bù nắp ở ca biên; outline được sửa về đúng bề rộng vách `0→B`, mọi pivot lại nằm trên biên cha.
- [VERIFIED] Xuất PDF có nhánh chú thích riêng chỉ ghi `L/W/D`; không rơi vào chú thích mép keo `G` của hộp nắp cài.
- [VERIFIED] Thumbnail `PRYNX-FTT-01.svg`, hai golden master và bundle `native/src/generated/dieline_engine.bundle.js` đã được sinh từ generator; diff snapshot chỉ thêm baseline của loại mới.
- [VERIFIED] Typecheck, 574 test khuôn bế, 86 test UI/store/3D, 16 pytest validation, `cargo check`, 5 test Rust và kiểm tra WebView sidecar đều đạt.
- [VERIFIED] Thumbnail 2D đã được raster hóa và đối chiếu trực quan với ảnh mẫu: thứ tự mép trước thấp → đáy → vách sau → nắp → vách trước nắp và các khóa hai bên khớp.
- [LIMITATION] Phiên web localhost đang yêu cầu đăng nhập bản quyền nên chưa mở được công cụ PRO để kéo fold progress và xuất PDF trực tiếp trong app. Không bypass đăng nhập; bước kiểm tay runtime vẫn cần chạy trong phiên đã đăng nhập.
- [BASELINE] Lint toàn repo vẫn vượt ngân sách do backlog ngoài phạm vi (`1461` lỗi, `106` cảnh báo; rule budget `react-refresh/only-export-components`). Generator mới tự thân đạt lint; typecheck và test liên quan đều xanh.
