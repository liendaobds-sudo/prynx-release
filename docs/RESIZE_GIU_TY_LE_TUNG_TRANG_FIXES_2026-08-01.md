# NHẬT KÝ SỬA RESIZE GIỮ TỶ LỆ TỪNG TRANG

**Ngày:** 2026-08-01  
**Báo cáo gốc:** `BAO_CAO_AUDIT_RESIZE_GIU_TY_LE_TUNG_TRANG_2026-08-01.md`

## Lô 1 — Backend geometry theo contentBox

- `resize_background_engine.py` — §R.2/R.6: thêm ba mode
  `fixed/fixed_width/fixed_height`; khổ khóa một chiều được tính sau khi dò
  contentBox và chuẩn hóa `/Rotate` của từng trang. Chiều tự tính ngoài
  `1..5000 mm` bị từ chối có kèm số trang.
- Cả `mirror/image/inpaint/solid/white` dùng cùng nguồn tỷ lệ. Canvas khớp đúng
  tỷ lệ nên mode khóa một chiều không tạo Image/SMask; artwork vẫn là Form vector.
- `pdf_tools_engine.py` — §R.4: mode khóa một chiều luôn đi content-aware vector;
  nếu có giảm mẫu thì downsample sau geometry, không rơi vào raster canvas cố định.
- Route `/pdf-tools/resize` nhận `page_size_mode`, mặc định `fixed` tương thích
  request cũ; tổ hợp khóa một chiều với scale mode khác `fit` trả 422.
- Regression gồm tỷ lệ `2:1/1:2/1:1`, khóa rộng/cao, viền trắng gốc, bốn góc
  xoay, subset, khổ vượt giới hạn, route forwarding và yêu cầu raster.

**Verify:** regression mới `16 passed`; ma trận Resize backend
`75 passed, 1 skipped`; `py_compile` ba file backend đạt.

## Lô 2 — Desktop contract và routing

- `PageResizerTool.tsx`: thêm mode `Khổ cố định / Cùng chiều rộng / Cùng chiều cao`;
  khóa một chiều chỉ hiện input có ý nghĩa, tự chuyển scale mode về `fit`, ẩn preset
  giấy, kiểu scale và nền vùng trống.
- `processHandlers.ts`: mode khóa một chiều luôn gọi đúng một backend job
  content-aware; file sạch tiếp tục đi bằng local path, không đọc PDF lớn vào V8.
- `api.ts`: gửi `page_size_mode`; `preprocSlice.ts` mặc định `fixed` để state cũ
  không đổi hành vi.
- Regression handler khóa cả `fixed_width/fixed_height`, stale `stretch → fit`,
  source path và payload backend.

**Verify:** `13 passed` cho `processHandlers.test.ts`; `npm run typecheck` đạt.

## Lô 3–4 — i18n, state và UI regression

- Bổ sung text Việt/Anh cho ba mode, hai input tự động và cảnh báo PDF đầu ra có
  nhiều khổ trang; không quảng bá tính năng như cách sửa giới hạn dàn đồng khổ.
- `PageResizerTool.test.ts`: khóa việc ẩn nền ở `fixed_width/fixed_height`.
- Migration state cũ nhận `pageSizeMode=fixed`; mode mới được persist sau debounce.
- Snapshot chỉ thêm đúng field `pageSizeMode`; không nhận các drift có sẵn ngoài
  phạm vi (`mixedExcessPercent`, `autoTrimBefore`, `bgFillMode/bgFillColor`).

**Verify:** i18n JSON parse đạt; test UI/migration `9 passed`; typecheck đạt.
Characterization toàn bộ còn đỏ do các drift snapshot có sẵn nêu trên, không phải
do `pageSizeMode` sau khi snapshot của tính năng này đã được cập nhật có chọn lọc.

## Lô 5 — Hardening state ẩn

- Chuyển sang khóa một chiều đặt preset thành `Tùy chỉnh` và scale mode `fit`, giữ
  nguyên số W/H để quay lại khổ cố định không hiển thị preset sai kích thước.
- Nền vùng trống bị ẩn được gửi thành `white`; mode/màu cũ không còn âm thầm đổi
  transparency hay màu của output khóa một chiều.
- Bổ sung regression thuần cho chuyển mode và cập nhật kỳ vọng handler.

## Lô 6 — Hoàn thiện text trạng thái

- Bổ sung i18n Việt/Anh cho trạng thái “Đang chuẩn hóa tỷ lệ từng trang”, không
  chỉ dựa vào `defaultValue` trong handler.

## Xác minh tổng hợp cuối

- Backend Resize: `75 passed, 1 skipped`; `py_compile` đạt.
- Frontend Resize: `22 passed`; migration state mới `1 passed`; typecheck đạt.
- Fixture tích hợp thật đi qua `resize_pages_smart`, ba contentBox `2:1/1:2/1:1`,
  khóa rộng `50 mm` cho kết quả chính xác:

```text
sizes_mm=[(50,25),(50,100),(50,50)]
xobjects=[[/Form],[/Form],[/Form]]
```

- Không trang nào sinh Image/SMask trong mode khóa một chiều; artwork giữ Form vector.
- Kiểm giao diện tự động chưa chạy được vì browser controller lỗi Windows sandbox
  hai lần liên tiếp dù dev server `5173` đang hoạt động. Cần kiểm tay thao tác chọn
  mode và một file nhiều tem để đạt bằng chứng runtime UI mức 3.
