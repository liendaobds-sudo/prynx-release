# BÁO CÁO AUDIT — RESIZE GIỮ TỶ LỆ TỪNG TRANG

**Ngày:** 2026-08-01  
**Phạm vi:** `PageResizerTool` → `runResize` → `/pdf-tools/resize` →
`resize_pages_smart` / `resize_background_engine`.  
**Trạng thái:** Giai đoạn 2 — chờ duyệt thiết kế trước khi sửa.

## 1. Mục tiêu nghiệp vụ

PDF có nhiều loại tem khác tỷ lệ cần được chuẩn hóa theo **một chiều**, không ép
mọi trang vào cùng khổ W × H:

- `fixed`: hành vi hiện tại, mọi trang về cùng `W × H`.
- `fixed_width`: mọi trang được chọn có cùng chiều rộng; chiều cao tự tính theo
  tỷ lệ nội dung thật của chính trang đó.
- `fixed_height`: mọi trang được chọn có cùng chiều cao; chiều rộng tự tính theo
  tỷ lệ nội dung thật của chính trang đó.

Ví dụ khóa chiều rộng `100 mm`:

| Tỷ lệ tem sau khi dò viền | Khổ đầu ra |
|---|---:|
| `2:1` | `100 × 50 mm` |
| `1:2` | `100 × 200 mm` |
| `1:1` | `100 × 100 mm` |

Tỷ lệ phải lấy từ `contentBox` sau bước dò/xén viền trắng của từng trang. Nếu lấy
thẳng `MediaBox`, viền giấy trắng cũ sẽ bị coi là một phần kích thước tem và cho
ra tỷ lệ sai với pipeline Resize vừa được duyệt ở Lô 11–12.

## 2. Baseline đã xác minh

Fixture ba trang có tỷ lệ `2:1`, `1:2`, `1:1`, gọi Resize hiện tại với khổ đích
`100 × 100 mm` và mode `fit`:

```text
source_ratio=[2:1,1:2,1:1]
target_mm=[(100,100),(100,100),(100,100)]
```

Kết quả này đúng hợp đồng cũ nhưng không đáp ứng trường hợp cùng chiều rộng.

## 3. Thiết kế đề xuất

### 3.1 Hợp đồng API

Thêm field tương thích ngược:

```text
page_size_mode = fixed | fixed_width | fixed_height
```

Mặc định `fixed`, nên preset và request cũ không đổi kết quả.

Hai mode khóa một chiều luôn dùng phép scale đồng đều tương đương `fit`; backend
từ chối tổ hợp `fixed_width/fixed_height` với `fill`, `stretch` hoặc
`center_no_scale` thay vì âm thầm diễn giải khác ý người dùng.

### 3.2 Hình học theo từng trang

Sau khi engine đã:

```text
dò contentBox → physical crop → chuẩn hóa /Rotate
```

thì tính khổ trang đích:

```text
fixed_width:
  scale_i  = target_width / content_width_i
  page_w_i = target_width
  page_h_i = content_height_i × scale_i

fixed_height:
  scale_i  = target_height / content_height_i
  page_h_i = target_height
  page_w_i = content_width_i × scale_i
```

Artwork tiếp tục được đặt bằng Form XObject vector. Vì tỷ lệ canvas trùng đúng tỷ
lệ content, không phát sinh vùng trống mới và không cần tạo lớp nền raster.

Chiều tự tính phải nằm trong `1..5000 mm`. Trang dị thường vượt giới hạn phải báo
rõ số trang; không clamp vì clamp sẽ làm sai tỷ lệ.

### 3.3 Đường xử lý

- Mode khóa một chiều luôn đi backend content-aware; không dùng fast-path pdf-lib.
- Không đi `_raster_resize`, vì nhánh này đang dựng một canvas W × H cố định cho
  toàn tài liệu và không biết contentBox theo trang.
- Nếu người dùng bật giảm mẫu, vẫn đổi hình học vector trước rồi downsample ảnh ở
  object-level/GS như đường `vector` hiện tại.
- `apply_to` giữ hợp đồng cũ: trang được chọn đổi khổ, trang ngoài phạm vi giữ
  nguyên hoàn toàn.

### 3.4 UI đề xuất

Trong mục **Kích thước trang đích**, thêm lựa chọn:

1. `Khổ cố định (W × H)` — UI hiện tại.
2. `Cùng chiều rộng` — chỉ nhập chiều rộng; hiển thị “Chiều cao: tự động theo từng trang”.
3. `Cùng chiều cao` — chỉ nhập chiều cao; hiển thị “Chiều rộng: tự động theo từng trang”.

Khi chọn hai mode tự động:

- tự chuyển `scaleMode` về `fit`;
- ẩn preset giấy và lựa chọn nền vùng trống vì không có gap mới;
- giữ lại giá trị W/H cũ trong state để khi quay về `Khổ cố định` không mất cài đặt;
- hiển thị chú thích rằng PDF đầu ra chủ đích có nhiều khổ trang.

## 4. Bảng phát hiện và bằng chứng

| Mã | Mức | Effort | Phát hiện |
|---|---|---:|---|
| §R.1 | P1 | M | Engine hiện tính một `target_w/target_h` ngoài vòng trang, nên mọi trang bắt buộc cùng khổ |
| §R.2 | P1 | M | Engine content-aware đã có đúng `content_width_pt/content_height_pt`, nhưng chưa dùng chúng để tính canvas riêng |
| §R.3 | P1 | S | Route và API desktop chưa có field mô tả cách đặt khổ |
| §R.4 | P1 | M | Fast-path frontend và `_raster_resize` đều giả định một canvas cố định; nếu chỉ sửa backend vector sẽ tạo parity lỗi |
| §R.5 | P2 | S | UI hiện luôn yêu cầu cả W/H và vẫn cho chọn các scale mode mâu thuẫn với khóa một chiều |
| §R.6 | P2 | M | Tỷ lệ phải tính sau canonicalize `/Rotate`, nếu không trang 90° sẽ đảo W/H |
| §R.7 | P2 | S | Giá trị mới phải có default/persist tương thích state cũ |
| §R.8 | P2 | S | Output vẫn là PDF mixed-size; một số chế độ dàn nhiều mẫu hiện từ chối trang không cùng kích thước |
| §R.9 | P1 | M | Chưa có regression cho khổ đích thay đổi theo từng trang |

### §R.1 / §R.2 — Hình học đang cố định toàn tài liệu

- `pdf_tools_engine.py:152-154` đổi W/H đích thành point một lần trước vòng trang.
- `pdf_tools_engine.py:226-236` chỉ có ngoại lệ đổi ngang/dọc, không có chiều tự động.
- `resize_background_engine.py:360-361` cũng tính canvas đích trước vòng trang.
- `resize_background_engine.py:421-431` đã có contentBox thật theo từng trang — đây
  là điểm đúng để tính chiều còn lại.

### §R.3 / §R.4 — Hợp đồng xuyên tầng chưa tồn tại

- `desktop/src/lib/api.ts:714-738` chỉ gửi `target_w`, `target_h`, `scale_mode`.
- `backend/app/api/routes/pdf_tools.py:483-493` nhận đúng các field cũ.
- `processHandlers.ts:630-649` có thể chọn fast-path pdf-lib.
- `_raster_resize` tại `pdf_tools_engine.py:486-489` dựng `px_w/px_h` cố định một
  lần cho mọi trang.

### §R.5 / §R.7 — UI và state

- `PageResizerTool.tsx` hiện chỉ có preset W × H và hai ô nhập cố định.
- `preprocSlice.ts` chưa có mode đặt khổ; persist merge cần default `fixed` để dữ
  liệu localStorage cũ không đổi hành vi.

### §R.8 — Ảnh hưởng downstream

Khóa một chiều không làm mọi trang thành cùng kích thước: chiều còn lại vẫn khác
nhau theo tem. Vì vậy lỗi nghiệp vụ “Dàn nhiều mẫu cắt xén chỉ hỗ trợ các trang
cùng kích thước” sẽ vẫn đúng ở những chế độ đang yêu cầu đồng khổ. UI Resize cần
nói rõ điều này; không được quảng bá tính năng mới như cách sửa lỗi 422 đó.

## 5. Ma trận regression bắt buộc

### Backend

- Ba contentBox `2:1`, `1:2`, `1:1`, khóa rộng `100 mm` → cao `50/200/100 mm`.
- Cùng fixture khóa cao `100 mm` → rộng `200/50/100 mm`.
- `/Rotate=0/90/180/270` và CropBox lệch gốc.
- Viền trắng gốc được dò bỏ trước khi lấy tỷ lệ.
- Form vector gốc còn nguyên; không có Image/SMask khi canvas khớp tỷ lệ.
- `apply_to="2"`: trang 1/3 byte-hình học giữ nguyên, chỉ trang 2 đổi.
- Chiều tự tính ngoài `1..5000 mm` báo lỗi có số trang.
- Route chuyển đúng `page_size_mode`; request cũ không gửi field vẫn là `fixed`.
- `target_dpi=0/>0`, `mode=auto/vector/raster`: khóa một chiều không rơi vào
  `_raster_resize`; downsample sau geometry vẫn hoạt động.

### Frontend

- UI ba lựa chọn; mỗi mode chỉ hiện input có ý nghĩa.
- Chuyển sang khóa một chiều đặt `scaleMode=fit`, ẩn nền; quay lại fixed giữ W/H cũ.
- Handler luôn gọi backend đúng một lần và gửi `page_size_mode`.
- Không gọi `resizePages` pdf-lib trong mode khóa một chiều.
- State cũ không có field được merge thành `fixed`; persist/restore giữ mode mới.
- Typecheck và i18n Việt/Anh đầy đủ.

## 6. Thứ tự sửa theo lô

### Lô 1 — Backend geometry, 4 file

1. `backend/app/workers/resize_background_engine.py`
2. `backend/app/workers/pdf_tools_engine.py`
3. `backend/app/api/routes/pdf_tools.py`
4. `backend/tests/test_resize_edge_background.py`

Verify: pytest Resize hẹp + `py_compile`.

### Lô 2 — Desktop contract và routing, 5 file

1. `desktop/src/components/preprocess-tools/PageResizerTool.tsx`
2. `desktop/src/lib/processHandlers.ts`
3. `desktop/src/lib/api.ts`
4. `desktop/src/components/imposition-tools/store/slices/preprocSlice.ts`
5. `desktop/src/lib/processHandlers.test.ts`

Verify: vitest Resize + typecheck.

### Lô 3 — UI regression, i18n và nhật ký, tối đa 5 file

1. `desktop/src/components/preprocess-tools/PageResizerTool.test.ts`
2. `desktop/src/i18n/locales/vi.json`
3. `desktop/src/i18n/locales/en.json`
4. `desktop/src/components/imposition-tools/useImposerSettingsStore.characterization.test.ts`
5. `docs/RESIZE_GIU_TY_LE_TUNG_TRANG_FIXES_2026-08-01.md`

Verify: vitest liên quan + typecheck + ma trận backend cuối.

## 7. Tiêu chí nghiệm thu

- Cùng chiều rộng/cao đúng theo contentBox riêng của từng tem, sai số khổ ≤`0,02 pt`.
- Không méo, không crop mất artwork, không thêm viền trắng mới.
- Artwork vector/CMYK/spot giữ theo đường Form hiện tại.
- Request và preset cũ cho output không đổi.
- Trang ngoài `apply_to` giữ nguyên.
- Không hạ DPI hoặc thêm cap trên máy mạnh.
- Backend + frontend regression xanh; sau đó chạy thật PDF nhiều loại tem để đạt
  bằng chứng runtime mức 3.

## 8. Chốt duyệt

Theo workflow audit của PrynX, báo cáo dừng tại đây. Chưa sửa mã nguồn tính năng.
Sau khi chủ dự án duyệt, triển khai Lô 1 trước và verify xong mới sang Lô 2.
