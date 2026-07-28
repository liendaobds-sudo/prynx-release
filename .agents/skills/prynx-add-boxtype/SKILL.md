---
name: prynx-add-boxtype
description: "Checklist end-to-end để thêm một LOẠI HỘP/khuôn bế mới vào PrynX (generator 2D → panel 3D → test → golden master → sidecar → i18n). Dùng khi user muốn thêm mẫu hộp mới, kiểu khuôn mới, dạng bao bì mới, hoặc port một template SVG thành generator. Use when adding a new box type, new dieline template, new packaging style, box generator scaffold, thêm loại hộp, thêm mẫu khuôn."
---

# Thêm loại hộp mới (end-to-end)

Đọc `prynx-dieline` trước — mọi bất biến ở đó áp dụng cho generator mới. Làm theo thứ tự; mỗi bước có sản phẩm kiểm được.

## 1. Chuẩn bị hình học

- Xin user file mẫu (SVG template/bản vẽ khuôn thật, ví dụ mã kiểu `100010-01`) + các tham số hình học (L, W, D, dày giấy T, hệ số…). Không dựng "theo trí nhớ".
- Xác định danh sách panel + quan hệ cha-con + nếp gấp, đặt tên điểm chuẩn (A, B, C… theo mẫu) ngay từ bản phân tích. Vẽ sơ đồ ASCII vào comment đầu file generator.

## 2. Khai báo

- `types.ts`: thêm `boxType` mới + tham số riêng vào `BoxParams`, kèm doc tiếng Việt từng tham số (ý nghĩa, đơn vị mm, ràng buộc, giá trị mặc định là bao nhiêu % của W/L).
- `constants.ts`: mọi hệ số hình học thành hằng có tiền tố riêng (vd `PB_` cho paper bag) — RATIO hay mm ghi rõ trong tên.

## 3. Generator 2D — `<TenHop>.ts`

- Xuất `generate<TenHop>(params): DielineModel`. Tính kích thước dẫn xuất trong một hàm `.<ten>Dims()` có clamp min/max (tham khảo `autoBottomDims`).
- Dựng theo hợp đồng: chuỗi CUT ngoài kín từng panel, CREASE chạm đỉnh, bezier đồng bộ points/controlPoints, guard suy biến khi tham số biên, cảnh báo sản xuất vào `model.warnings`.
- Đăng ký vào `engine.ts` → `dispatchGenerator`, cập nhật `index.ts` export.

## 4. Panel & 3D

- Mỗi panel khai `parent`, `pivotEdge` (biên chung THẬT với parent), `foldAngle`, `foldDirection`, `foldPhase` — chia giai đoạn: chi tiết con gập trước, thân sau; kết ở ~0.95 để nhìn rõ trạng thái cuối.
- Lớp giấy chồng nhau: `renderZShift` bội số của độ dày T; màng chéo góc dùng gusset (xem `gussetFold.ts`), không giả lập bằng panel thường.
- Kiểm trong app: kéo foldProgress 0→100%, không panel nào xuyên/bay/quay ngược.

## 5. Test — đủ 4 tầng, viết cùng lúc với code

1. `generators.test.ts`: describe mới — số panel theo tổ hợp tham số, parent/pivot đúng, các nét đặc thù (nếp chéo, khe, nick) đếm được.
2. `contourValidator` + `bleedContours.test.ts`: thêm case cho loại hộp mới (outline hợp lệ, bleed đủ panel).
3. Property test `arbitraries.ts`: thêm arbitrary sinh tham số hợp lệ cho loại mới → chạy qua bất biến chung (không NaN, không self-intersect, CUT kín) trên dải kích thước rộng.
4. `goldenMaster.test.ts`: thêm case chuẩn (một bộ tham số điển hình) → chạy `-u` MỘT lần đầu để sinh snapshot, từ đó snapshot là chốt.

## 6. Hoàn thiện

- i18n: label loại hộp + tên tham số trong `desktop/src/i18n/`; form UI thêm mục chọn.
- `npm run build:dieline-sidecar` + `check:dieline-webview`; nếu cần parity với engine Rust (`native/src/dieline_engine.rs`) thì port hoặc đánh dấu loại hộp là TS-only trong `nativeFixtureParity`.
- Chạy verify chuẩn (`prynx-testing`) + xuất thử PDF khuôn, đo kích thước thật bằng thước trong app so với tham số nhập.

## Định nghĩa xong

Đủ: generator + test 4 tầng xanh + snapshot chuẩn + 3D gập đúng + i18n + sidecar build lại + xuất PDF đo đúng kích thước. Thiếu bất kỳ mục nào = chưa xong, ghi rõ còn thiếu gì.
