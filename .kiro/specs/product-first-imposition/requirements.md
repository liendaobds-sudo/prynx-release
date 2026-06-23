# Requirements Document

## Introduction

Hiện tại tính năng bình sách rất mạnh nhưng **kén người**: người dùng phải tự chọn
hàng loạt thiết lập mang tính kỹ thuật (kiểu đóng, cỡ tay, sơ đồ gấp, số cuốn/tờ,
lề nhíp, bù gáy…). Việc này tốn thời gian và đòi hỏi am hiểu nghề in.

Tính năng này **đảo luồng**: người dùng khai báo **sản phẩm** (loại đóng, khổ thành
phẩm) + một vài dữ kiện kinh doanh (phương pháp in, khổ giấy/kẽm, số lượng), hệ
thống **tự suy ra và đề xuất** bộ thiết lập tối ưu (ví dụ: "1 tờ SRA3 bình được 2
con A5, Tay 16, 3 tờ kẽm, hao ~8%"), kèm giải thích, cho phép áp dụng 1 chạm hoặc
mở "Nâng cao" để chỉnh tay.

Lõi tính toán phần lớn **đã có sẵn** (`SheetOptimizer.optimizeMasterSig`,
`CatalogPlanner.planCatalog/planCatalogFull`, `ProductionCalculator`,
`FoldPatterns.getPatternForPageCount`). Tính năng này là **lớp điều phối + tri thức
sản phẩm + UX** đặt lên trên, KHÔNG viết lại engine.

### Ràng buộc cốt lõi (bất biến xuyên suốt)
> **TÁCH HOÀN TOÀN IN NHANH (digital) và OFFSET.** Hai phương pháp có khổ giấy,
> chiến lược bình, kiểu gấp, lề nhíp và đầu ra khác hẳn nhau. Đề xuất, danh sách
> lựa chọn, và khổ giấy của một phương pháp KHÔNG được xuất hiện/áp dụng cho phương
> pháp kia. Dữ liệu hiện có đã phân loại qua `PREDEFINED_SIZES[*].classification`
> và state `paperClassification: 'offset' | 'in_nhanh'`.

### Phạm vi theo giai đoạn
- **Phase 1 (spec này tập trung) — CHỈ IN NHANH (digital):** người dùng chọn sản
  phẩm + 1 khổ giấy in nhanh + file → đề xuất bộ thiết lập + "1 tờ mấy con" + Apply.
  Chủ yếu wiring engine sẵn có. **Offset TẠM HOÃN** (làm sau vì cần thợ kinh nghiệm
  vận hành; nguyên tắc tách bạch ở Requirement 2 giữ nguyên để khi thêm offset không
  lẫn vào in nhanh).
- **Phase 2**: xếp hạng đa khổ từ danh sách khổ xưởng (in nhanh), rank theo yield/chi phí.
- **Phase 3**: mở rộng sang Offset (fold pattern, nhíp, thớ giấy) + hồ sơ xưởng + mô hình chi phí.

## Glossary
- **Phương pháp in**: `in_nhanh` (kỹ thuật số, khổ nhỏ A4/A3/SRA3, không gripper)
  hoặc `offset` (khổ kẽm lớn, có nhíp, gấp tay).
- **Sản phẩm/kiểu đóng**: bấm kim giữa (saddle), khâu chỉ chia tép (thread), keo
  gáy/lò xo (perfect/continuous), cắt-ráp-xấp (cut&stack), dán đối lưng (flush mount).
- **Đề xuất (recommendation)**: một bộ thiết lập hoàn chỉnh + giải thích + chỉ số
  sản xuất (số tờ, số kẽm, % hao, n-up/tờ).
- **Khổ thành phẩm**: kích thước trang sau khi cắt thành phẩm (từ file hoặc người chọn).

## Requirements

### Requirement 1: Khai báo sản phẩm thay cho thông số kỹ thuật
**User Story:** Là người dùng không rành kỹ thuật bình, tôi muốn chỉ chọn loại sản
phẩm và khổ thành phẩm, để hệ thống tự lo các thông số kỹ thuật còn lại.

#### Acceptance Criteria
1. WHEN người dùng mở luồng "theo sản phẩm" THEN hệ thống SHALL yêu cầu tối thiểu:
   (a) phương pháp in (`in_nhanh`/`offset`), (b) kiểu đóng/sản phẩm, (c) khổ thành
   phẩm, (d) khổ giấy/kẽm để bình.
2. WHEN file PDF đã nạp THEN hệ thống SHALL tự lấy số trang và kích thước trang làm
   khổ thành phẩm mặc định (cho phép người dùng ghi đè).
3. WHEN người dùng chọn kiểu đóng là bấm kim giữa hoặc khâu chỉ THEN hệ thống SHALL
   tự xác định `impositionMode = Booklet` mà không cần người dùng chọn thủ công.
4. IF người dùng chưa nạp file THEN hệ thống SHALL cho phép nhập số trang + khổ thành
   phẩm thủ công để vẫn xem được đề xuất.

### Requirement 2: Tách hoàn toàn In nhanh và Offset (ràng buộc cốt lõi)
**User Story:** Là chủ xưởng, tôi muốn quy trình in nhanh và offset tách bạch, để
không bao giờ nhận thiết lập của phương pháp này lẫn sang phương pháp kia.

#### Acceptance Criteria
1. WHEN người dùng chọn phương pháp in THEN hệ thống SHALL chỉ hiển thị khổ giấy có
   `classification` khớp phương pháp đó (in_nhanh chỉ thấy khổ in_nhanh; offset chỉ
   thấy khổ offset).
2. WHEN phương pháp = `in_nhanh` THEN đề xuất SHALL chỉ dùng chiến lược của in nhanh
   (1 cuốn/tờ, nhiều cuốn/tờ step&repeat, cắt-ráp-xấp) và SHALL KHÔNG đề xuất sơ đồ
   gấp offset (Tay 4/8/16) hay lề nhíp gripper.
3. WHEN phương pháp = `offset` THEN đề xuất SHALL dùng sơ đồ gấp tay (4/8/16),
   work&turn/tumble/sheetwise và lề nhíp; và SHALL KHÔNG đề xuất chế độ riêng của in nhanh.
4. WHEN đổi phương pháp in THEN hệ thống SHALL reset/ẩn các lựa chọn không hợp lệ của
   phương pháp trước (không giữ state lẫn lộn).
5. WHERE một kiểu đóng tồn tại ở cả hai phương pháp (vd bấm kim giữa) THE đề xuất kỹ
   thuật (gấp, nhíp, n-up) SHALL khác nhau theo phương pháp và không dùng chung tham số.

### Requirement 3: Đề xuất "1 tờ bình được mấy con" theo khổ giấy
**User Story:** Là người dùng, tôi chọn khổ giấy muốn bình và muốn hệ thống cho biết
ngay 1 tờ bình được mấy con / cỡ tay nào là tối ưu.

#### Acceptance Criteria
1. WHEN có khổ thành phẩm + khổ giấy + phương pháp THEN hệ thống SHALL tính số con
   trên mỗi tờ và (với offset) cỡ tay tối ưu, tái dùng `SheetOptimizer.optimizeMasterSig`.
2. WHEN tính fit THEN hệ thống SHALL tự cân nhắc xoay khổ 90° để tối ưu lấp đầy.
3. WHEN khổ giấy còn dư nhiều hoặc fit sát lề THEN hệ thống SHALL hiện cảnh báo/gợi ý
   (tái dùng `warnings` của SheetOptimizer), ví dụ "kẽm dư nhiều → có thể giảm khổ".
4. IF khổ giấy quá nhỏ không bình được THEN hệ thống SHALL báo rõ và (nếu có) gợi ý
   khổ tối thiểu cần thiết (`SheetOptimizer.suggestMinimumSheet`).
5. WHEN hiển thị kết quả THEN hệ thống SHALL diễn đạt bằng ngôn ngữ người dùng hiểu
   ("1 tờ = 2 con A5/mặt", "Tay 16", "3 tờ kẽm") chứ không chỉ con số kỹ thuật.

### Requirement 4: Đề xuất nhiều phương án kèm đánh đổi (xếp hạng)
**User Story:** Là người dùng, tôi muốn xem vài phương án bình kèm đánh đổi (tiết
kiệm giấy / ít kẽm / nhanh) để chọn theo ưu tiên của đơn hàng.

#### Acceptance Criteria
1. WHEN có đủ dữ kiện + số lượng THEN hệ thống SHALL tạo danh sách phương án khả thi
   và xếp hạng theo chỉ số sản xuất (số tờ, số kẽm, % hao) qua `ProductionCalculator`.
2. WHEN hiển thị THEN hệ thống SHALL nêu top phương án (ví dụ 2–3) kèm chỉ số đánh đổi,
   KHÔNG ép một "đáp án thần kỳ" duy nhất.
3. IF chỉ có 1 phương án khả thi THEN hệ thống SHALL hiển thị phương án đó và nêu rõ
   không có lựa chọn thay thế.
4. WHEN chưa nhập số lượng THEN hệ thống SHALL vẫn xếp hạng theo proxy "số tờ + % hao"
   (chưa cần mô hình chi phí tiền tệ).

### Requirement 5: Áp dụng đề xuất + giữ quyền chỉnh tay (không hộp đen)
**User Story:** Là người dùng, tôi muốn áp dụng đề xuất bằng 1 chạm, nhưng vẫn xem
được vì sao và chỉnh tay khi cần.

#### Acceptance Criteria
1. WHEN người dùng chọn một phương án và bấm "Dùng thiết lập này" THEN hệ thống SHALL
   đổ đầy đủ thiết lập tương ứng vào store hiện có (`useImposerSettingsStore`) để chạy
   được ngay engine bình hiện tại.
2. WHEN một đề xuất được tạo THEN hệ thống SHALL hiển thị diễn giải "vì sao" (khổ, cỡ
   tay, n-up, số kẽm) — KHÔNG được là hộp đen.
3. WHEN đã áp dụng đề xuất THEN hệ thống SHALL cho phép mở giao diện "Nâng cao" (UI
   hiện tại) để chỉnh tay mà không mất các giá trị đã đề xuất.
4. The luồng nâng cao hiện tại (power-user) SHALL được giữ nguyên như một chế độ ghi đè,
   KHÔNG bị gỡ bỏ.

### Requirement 6: Chỉ đề xuất thiết lập HỢP LỆ (fail-loud, chống "ra sai âm thầm")
**User Story:** Là chủ xưởng, tôi muốn hệ thống chỉ đề xuất các tổ hợp đã được kiểm
tra hợp lệ, để không lặp lại lỗi "chọn bừa → ra file sai mà không báo".

#### Acceptance Criteria
1. WHEN tạo đề xuất THEN mỗi phương án SHALL đã qua kiểm tra fit + ràng buộc kiểu đóng
   (saddle→1 cuốn lớn; thread→chia tép; perfect→tuần tự; cut&stack→cặp nửa) trước khi hiển thị.
2. IF một tổ hợp không khả thi THEN hệ thống SHALL loại khỏi danh sách HOẶC hiển thị
   rõ lý do không khả thi, KHÔNG được đề xuất rồi xuất sai.
3. WHEN áp dụng đề xuất rồi chạy bình THEN bộ thiết lập SHALL khớp với những gì engine
   thực thi (đường viaBackend phase-2) — không có thông số bị bỏ rơi âm thầm.
4. WHEN số trang không là bội số yêu cầu (vd không bội 4 cho saddle) THEN hệ thống
   SHALL nêu rõ số trang trắng sẽ chèn và vị trí (đầu/cuối/giữa).

### Requirement 7: Tái dùng engine sẵn có, không viết lại
**User Story:** Là người bảo trì, tôi muốn lớp đề xuất dựa trên các module tính toán
hiện có để tránh trùng lặp logic và phân kỳ kết quả.

#### Acceptance Criteria
1. WHEN tính fit/cỡ tay THEN hệ thống SHALL gọi `SheetOptimizer`, KHÔNG tự cài lại.
2. WHEN tính phân tách tay/kẽm và chỉ số sản xuất THEN hệ thống SHALL gọi
   `CatalogPlanner` (`planCatalog`/`planCatalogFull`) và `ProductionCalculator`.
3. WHEN chọn sơ đồ gấp (offset) THEN hệ thống SHALL dùng `FoldPatterns.getPatternForPageCount`.
4. The lớp đề xuất SHALL chỉ thêm phần điều phối + tri thức sản phẩm + diễn giải, không
   nhân bản thuật toán hình học/sản xuất.

### Requirement 8: Hồ sơ xưởng & danh sách khổ (Phase 2/3, định hướng)
**User Story:** Là chủ xưởng, tôi muốn khai báo các khổ giấy/kẽm xưởng đang có để hệ
thống tự thử và chọn khổ tối ưu, theo từng phương pháp in.

#### Acceptance Criteria
1. WHEN có danh sách khổ khả dụng theo phương pháp THEN hệ thống SHOULD thử nhiều khổ
   và xếp hạng (Phase 2), vẫn tôn trọng tách in_nhanh/offset (Yêu cầu 2).
2. The danh sách khổ SHALL kế thừa phân loại sẵn có (`PREDEFINED_SIZES.classification`
   + preset người dùng lưu kèm `classification`).
3. WHERE chưa có hồ sơ xưởng THE hệ thống SHALL hoạt động với một khổ do người dùng chọn
   (Phase 1) mà không bắt buộc cấu hình.

---

## Ngoài phạm vi (Non-goals) — giai đoạn này
- Mô hình chi phí tiền tệ chi tiết (giá giấy/kẽm/cú click) — Phase 3.
- Ràng buộc hướng thớ giấy (grain) cho gấp offset — Phase 3 (chỉ ghi nhận, chưa chặn).
- Press marks đầy đủ cho phase-2 (đang là trim 4 góc) — xử lý ở hạng mục engine riêng.
- Hợp nhất hai bộ render (Auto Catalog local vs backend) — hạng mục kỹ thuật riêng,
  không thuộc spec này nhưng nên làm song song để tránh phân kỳ.
