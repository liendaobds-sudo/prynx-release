# Fixes đặt tên boong/ốc và layer khi mở Illustrator

> Ngày sửa: 2026-08-07  
> Audit nguồn: `BAO_CAO_AUDIT_DAT_TEN_BOONG_LAYER_ILLUSTRATOR_2026-08-07.md`  
> Findings: `§PONTLAYER.1`, `§PONTLAYER.2`  
> Mức bằng chứng: code + regression artifact; chưa smoke Illustrator/Graphtec thật

## 1. Kết quả

Đã sửa đường mặc định **Bế → Chỉ trang khuôn** để PDF tạm giữ:

- `/OCProperties` và danh sách `/OCGs`;
- Graphtec info layer;
- layer cha và group chứa nét ốc;
- cây lồng `/D/Order`;
- ref OCG mà content trang thực sự dùng;
- `Item Name` dưới dạng `/NM`.

Ca nhiều tờ cũng được khóa: trích tờ 1 chỉ giữ context OCG của tờ 1, không kéo Graphtec/layer/group rỗng của tờ 2 vào PDF tạm.

## 2. Bằng chứng trước sửa

Regression được thêm trước code fix và đã đỏ đúng lỗi:

- `OpenInDesignModal.test.tsx`: PDF tạm có `OCGs=[]` thay vì ba tên cấu hình;
- helper theo hành vi cũ chỉ giữ `MarkLine_AUDIT`, làm mất Graphtec info và `Marks_Model_AUDIT` vì hai OCG này không được content trang tham chiếu;
- thử giữ toàn bộ OCG rỗng kéo cả sáu OCG của hai tờ vào file chỉ trích tờ 1.

Ba kết quả trên lần lượt khóa nguyên nhân gốc, edge case OCG rỗng và ranh giới nhiều tờ.

## 3. Thay đổi

| File | Thay đổi |
|---|---|
| `desktop/src/components/imposition-tools/OpenInDesignModal.tsx` | Bọc `copyPages()` bằng lượt chuyển optional content và bật giữ OCG rỗng liên quan trước khi lưu PDF tạm. |
| `desktop/src/components/imposition-tools/OpenInDesignModal.test.tsx` | Dựng artifact kiểu CNC thật; assert ba tên OCG, `/Order`, ref group và `/NM`. |
| `desktop/src/lib/pdfOptionalContent.ts` | Thêm tùy chọn `preserveUnreferencedOcgs`; chọn context theo nhánh `/Order`, copy riêng OCG rỗng còn thiếu và giữ ref content hiện hữu. |
| `desktop/src/lib/pdfOptionalContent.test.ts` | Thêm regression OCG metadata rỗng và ca nhiều tờ không lẫn nhánh. |

Tùy chọn mới mặc định tắt, nên các caller hiện hữu của helper không đổi hành vi.

## 4. Verify

| Kiểm tra | Kết quả |
|---|---|
| Test đích `OpenInDesignModal` + `pdfOptionalContent` | **23/23 passed** |
| Frontend typecheck | **PASS** |
| Frontend full Vitest | **203 file passed; 1.952 passed, 2 skipped** |
| ESLint bốn file thay đổi | **0 error**; 1 warning `react-hooks/exhaustive-deps` có sẵn tại effect ngoài vùng sửa |
| `git diff --check` | **PASS** |

Không chạm backend, Rust, hình học bình hoặc snapshot/golden.

## 5. Kiểm runtime còn lại

Chưa mở artifact bằng Illustrator/Graphtec Studio trong phiên này. Cần kiểm tay đúng chuỗi:

1. Bình CNC hoặc tem bế có bật boong Graphtec và đặt tên tùy chỉnh.
2. Bấm **Bế** → giữ **Chỉ trang khuôn** → mở Illustrator.
3. Xác nhận bảng layer có Graphtec info, layer cha và group đúng tên.
4. Xác nhận plugin máy bế nhận layer như quy trình xưởng.
5. Kiểm xem `/NM` có được Illustrator ánh xạ thành native item name hay chỉ còn metadata PDF.

Vì bước 5 phụ thuộc hành vi nhập PDF của Illustrator/plugin, finding `§PONTLAYER.3` vẫn ở trạng thái `RUNTIME UNVERIFIED`.
