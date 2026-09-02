# BÁO CÁO AUDIT CĂN CỤM TRUE-SHAPE NESTING — 2026-08-29

## Phạm vi và tiêu chí

Rà luồng `align` từ thiết lập Bình tem bế/CNC đến manifest production. Kết quả phải:

- căn toàn bộ cụm đúng một lần theo từng `sheetIndex` trong vùng usable đã trừ lề và clearance mép tờ;
- giữ nguyên góc, khoảng cách tương đối, source revision và đăng ký Front/Back/Cut;
- dùng cùng manifest cho preview và export;
- không dịch fixed obstacle và không công bố layout không qua final validator;
- mọi giá trị `align` ảnh hưởng pose phải tham gia identity/cache.

## Phát hiện đã xác nhận

| Mã | Mức | Bằng chứng | Kết luận |
|---|---|---|---|
| §NEST-CENTER-1 | P1 | `backend/app/core/nesting_production_orchestrator.py` dựng lại rigid transform bằng Python sau khi Rust đã solve | Có hai seam hình học; manifest native chưa phải artifact authoritative cuối cùng. |
| §NEST-CENTER-2 | P1 | Orchestrator thử `fraction = 1, 1/2, ...` khi obstacle chặn | Tính khả thi theo đoạn dịch không đơn điệu với obstacle rời rạc; phép chia đôi không chứng minh được “dịch xa nhất hợp lệ”. |
| §NEST-CENTER-3 | P1 | `alignment` chỉ được ký ngoài `engineRequest`; reload phải thử cả chín giá trị để đoán lại | Production contract chưa tự mô tả đầy đủ output pose mà nó cam kết. |
| §NEST-CENTER-4 | P1 | `_manifest_id()` chưa chứa `align` | Cùng job/khổ/số lượng nhưng đổi căn có thể dùng cùng manifest ID. |

## Hướng sửa đã duyệt

1. Đưa `alignment` thành field server-owned của `ProductionContractV1`, tăng production schema.
2. Rust dịch candidate đã chọn theo từng tờ trước khi tính stats và final validation.
3. Nếu phép căn chính xác va obstacle, giữ nguyên candidate đã hợp lệ; không nội suy theo `fraction` và không làm hỏng job sản xuất chỉ vì căn trang trí không khả thi.
4. Cho alignment vào `inputHash`, `layoutFingerprint`, session key và manifest ID.
5. Giữ duplex canonical-front: writer tiếp tục tự áp `SheetFrame`; tuyệt đối không căn mặt back riêng.

## Lô triển khai

- Lô A (Rust core, tối đa 5 file): contract/normalize/envelope/publication + test solver.
- Lô B (backend, tối đa 5 file): schema/adapter/orchestrator/worker + test identity.
- Lô C: verify Rust, backend và test parity liên quan; không cập nhật golden ngoài chủ đích.

## Trạng thái verify cuối

Đã xác nhận đường production hiện dùng Rust làm nguồn sự thật duy nhất cho phép căn cụm:

- Rust căn authoritative theo từng `sheetIndex` trong usable area đã trừ lề và clearance mép tờ.
- Nếu fixed obstacle chặn vị trí căn chính xác, engine giữ candidate gốc đã hợp lệ; artifact cuối vẫn đi qua final validator.
- Backend Python không dựng rigid transform hoặc căn manifest lần thứ hai.
- Production contract đã tăng `productionSchemaVersion = 2` và mang field server-owned `alignment`.

Artifact kiểm thực tế có **44 tem**. Khoảng hở đo được theo thứ tự trái/phải/dưới/trên là
**0,104674 / 0,169896 / 4,074998 / 4,221251 mm**; sai lệch tâm `dx/dy` là
**0,032611 / 0,073127 mm**.

Preview và export dùng cùng manifest `cec3e885f6e7045dbb62d1b810ecde0f`, cùng
fingerprint `sha256:45382db3482f950ac3301e785eb3ad33f3edd5e91083a252cc76282c4084ebe2`.
Acceptance source cuối còn so từng cell cold/warm, native revalidate manifest và khóa
`renderBundleHash`. QA trực quan Front/Cut 2 trang ở 120 dpi đạt; cả **4 ốc** đều sạch,
không bị artwork/CUT giao hoặc chồng.

## Finding hiệu năng còn mở

Correctness căn cụm đã đạt nhưng tốc độ cold vẫn là finding riêng: source cuối mất
**23,778 giây** (warm **0,101 giây**, render **2,707 giây**), giảm `68,2%` so với baseline
`74,736 giây` nhưng vẫn trượt KPI cold `<=5 giây`. Không gộp vấn đề này vào kết luận hình
học; cần tiếp tục lô hardware grant/parallel trial và incremental NFP.
