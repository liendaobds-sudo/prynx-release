# Báo cáo audit thử nghiệm preview đường bao ảnh AI — 2026-08-09

## Mục tiêu

Cho phép người dùng chủ động phân tích ảnh nhiều tem, xem đường bao trước khi xác nhận và điều chỉnh các tham số xử lý mà không làm preview khác file xuất hoặc làm biến dạng quỹ đạo dao.

Phạm vi khảo sát đi từ `StickerSheetPanel` → store/API desktop → session/detect backend → mask preview → `StickerEngine` tạo CutContour lúc xuất. Phần “Bằng chứng hiện trạng” bên dưới ghi lại trạng thái trước khi sửa.

## Trạng thái triển khai sau khi duyệt

Đã hoàn tất lô preview mask thật đầu tiên (lô 1–2):

- Tab `Ảnh AI nhiều tem` luôn chạy đúng nhánh AI sau thao tác chủ động `Phân tích ảnh và tạo bản xem trước`; chọn ảnh vẫn chỉ dựng preview gốc.
- Session lưu bất biến `raw_alpha.png`, `shadow_exclusion.png` và `reference_labels.npy`. Mỗi lần kéo chỉ hậu xử lý lại các dữ liệu này, không gọi mô hình lần hai.
- `Khử bóng` có hai trạng thái trung thực: `Giữ nguyên` / `Tự động`.
- Ngưỡng Alpha 128–176 vẫn tồn tại trong hợp đồng refine cũ nhưng đã được bỏ khỏi UI chính; nó không còn bị gọi sai là công cụ làm mượt CutContour.
- Mọi revision mới phải giữ số tem, ánh xạ ID một-một và số lỗ của từng tem so với mask detect gốc; candidate nguy hiểm bị từ chối và UI quay về mức đã áp dụng.
- Request slider được debounce và xếp hàng tuần tự theo `mask_revision`; không hủy một thread backend đang chạy và không để response cũ ghi đè lựa chọn cuối.
- Asset có `?v=revision` được đọc trọn dưới `operation_lock`; URL revision cũ nhận 409 thay vì có thể trộn preview/labels giữa hai lần ghi.
- Nếu backend đã commit nhưng desktop không tải đủ ba asset sau một lần retry, session cũ được đóng và UI quay về `Phân tích lại`, không tiếp tục gửi `baseRevision` lỗi thời.
- Khi đang cập nhật preview, xác nhận, cọ sửa mask và canvas edit đều bị khóa. Manual edits cũ chỉ bị xóa sau khi tuning mới áp dụng thành công; candidate bị từ chối vẫn giữ nguyên edits.

### Lô 3 — CutContour live dùng chung với file xuất

Đã hoàn tất sau khi người dùng duyệt triển khai:

- Bỏ slider `Bám biên AI` và đoạn giải thích mask kỹ thuật khỏi panel.
- Thêm bốn điều khiển trực tiếp: `Độ mượt`, `Sức căng`, `Bám sát hình gốc`, `Lọc chi tiết rời (mm²)`; `Khử bóng` vẫn là điều khiển mask độc lập.
- Backend dựng ring Bézier từ đúng Alpha/mask/edit hiện tại. Frontend chỉ vẽ kết quả bằng SVG, không có thuật toán smooth thứ hai.
- Slider debounce 160 ms, chỉ một request geometry chạy tại một thời điểm; lựa chọn mới được xếp hàng và response cũ không thể ghi đè.
- Export dựng lại cùng path groups bằng cùng helper rồi truyền thẳng chúng vào `StickerEngine` qua `alpha_path_overrides`; content stream PDF dùng đúng các lệnh cubic đã preview.
- Mỗi thumbnail giữ tuning, preview, edit và revision riêng; export nhiều trang gửi tuning theo từng trang.
- Fitter live thử C2 trước, G1 machine-safe sau; mọi candidate phải giữ topology/Hausdorff, không hở node, không khớp gãy quá 1° và không có lệnh ngắn dưới 0,25 mm.
- Khi mức `Bám sát` quá chặt mâu thuẫn với đường máy-safe, engine giữ candidate an toàn gần nhất trong envelope tuyệt đối và hiển thị chính candidate đó, không quay về polyline dày node.

### Kiểm thực tế trên ảnh khách hàng

Chạy lại đúng file Desktop `1d1e06e0-dc9c-4aeb-a579-a3096baf37bf.jpg` sau triển khai:

| Mức bám biên | Số tem | Pixel labels | Lồng trong mức trước | Thời gian hậu xử lý |
|---:|---:|---:|:---:|---:|
| 128 | 9 | 933.859 | Có; giống baseline tuyệt đối | 0,229 s |
| 136 | 9 | 933.836 | Có | 0,214 s |
| 144 | 9 | 933.792 | Có | 0,235 s |
| 152 | 9 | 933.750 | Có | 0,240 s |
| 160 | 9 | 933.701 | Có | 0,247 s |
| 168 | 9 | 933.647 | Có | 0,229 s |
| 176 | 9 | 933.585 | Có | 0,225 s |

Lần chạy AI đầu mất khoảng 11 giây trên máy kiểm thử; các lần kéo không gọi lại AI. Ở mức 128, `Tự động` giữ 933.859 pixel còn `Giữ nguyên` giữ 959.226 pixel, chứng minh nút khử bóng đang điều khiển artifact thật. Guard lỗ bỏ qua nhiễu JPEG dưới 64 px nhưng vẫn từ chối lỗ artwork đủ lớn.

### Kiểm thực tế CutContour live trên cùng ảnh 9 tem

Đo lại sau lô 3 trên file `1d1e06e0-dc9c-4aeb-a579-a3096baf37bf.jpg` (1313 × 1198 px, quy ước 72 DPI):

| Cấu hình `mượt / căng / bám sát` | Thời gian geometry 9 tem | Tổng cubic |
|---:|---:|---:|
| `50 / 50 / 50` | 0,61–0,65 s | 915 |
| `82 / 78 / 72` | 0,70 s | 937 |
| `100 / 100 / 100` | 1,67 s | 1.626 |
| `20 / 25 / 90` | 1,50 s | 1.915 |

Ở cấu hình mặc định, mỗi tem có 58–176 cubic; đoạn ngắn nhất đo được 0,656 mm, số đoạn dưới 0,25 mm bằng 0, số node hở bằng 0 và góc nối lớn nhất 0°. Lần xuất PDF thật tạo 9 trang trong 8,03 giây; 915 lệnh cubic trong spot color `CutContour` khớp chính xác 915 lệnh của preview. Test tự động còn so từng dòng lệnh `c`, không chỉ so số lượng.

### Kết quả verify mã

- Vòng hồi quy backend geometry/preview/export/API/engine tem: 181 test đạt.
- Toàn bộ nhóm frontend `preprocess-tools` + API tem: 17 file, 136 test đạt.
- Toàn bộ Vitest desktop: 216 file đạt; 2.073 test đạt, 2 test skip có chủ đích.
- TypeScript typecheck, ESLint phạm vi thay đổi và JSON i18n Việt/Anh đạt.
- Production frontend build đạt; chỉ còn các cảnh báo chunk/dynamic import đã có của dự án.
- `git diff --check` phạm vi thay đổi không có lỗi whitespace.

## Bằng chứng hiện trạng

### §PV.1 — Preview hiện tại chưa phải đường chạy dao cuối

- Workspace chỉ vẽ biên của `preview_labels.png` qua `stickerMask.worker.ts`.
- Bước xác nhận chỉ đổi stage `mask-review → mask-ready`, không dựng CutContour.
- CutContour C2, Offset, corner policy và fitter có guard Hausdorff chỉ chạy trong `StickerEngine.process_pdf()` khi export.

Hệ quả: thêm thanh `Độ mượt` chỉ vào overlay hiện tại sẽ tạo preview giả; PDF cuối có thể khác thứ người dùng đã duyệt.

### §PV.2 — Không thể chỉnh khử bóng tức thời từ dữ liệu session hiện có

- `analyze_sticker_sheet()` có `raw_alpha` của model trong biến cục bộ.
- Session chỉ lưu Alpha đã làm sạch, labels cuối và uncertainty nhị phân; `raw_alpha` bị bỏ.
- Sau khi promote, session ở `mask-review`; gọi `/detect` lần hai bị từ chối. Muốn đổi ngưỡng hiện tại phải chạy model lại từ đầu.

Hướng đúng là lưu `raw_alpha` 8-bit một lần, rồi hậu xử lý lại mask trên cùng session mà không chạy ONNX lần nữa.

### §PV.3 — `alpha_threshold` không phải thanh “Khử bóng” đơn điệu

Đo trên đúng ảnh `1d1e06e0-dc9c-4aeb-a579-a3096baf37bf.jpg`, dùng cùng một kết quả BiRefNet-lite để loại thời gian inference khỏi phép đo:

| Ngưỡng Alpha | Số tem | Pixel labels |
|---:|---:|---:|
| 80 | 9 | 933.825 |
| 104 | 9 | 933.830 |
| 128 | 9 | 933.859 |
| 152 | 9 | 933.870 |
| 176 | 9 | 935.335 |
| 200 | 9 | 939.132 |

Diện tích mask tăng khi kéo ngưỡng lên do threshold thay component trước, còn bộ bóc bóng xám có các guard phụ thuộc chính component đó. Vì vậy không được đổi tên `alpha_threshold` thành “Khử bóng mạnh/yếu”.

### §PV.4 — “Độ mượt” và “Độ bám sát” là cùng một trade-off

Ghi chú sau phản hồi người dùng: UI cuối cùng giữ hai thanh độc lập để người dùng quan sát trực tiếp. Backend giải quyết tổ hợp mâu thuẫn bằng guard chung và candidate machine-safe gần nhất, thay vì để hai thanh nới geometry vô hạn.

Fitter hiện chọn nhiều candidate trong safe-envelope, giữ topology và chặn sai lệch bằng ngân sách Hausdorff thích nghi theo kích thước thật/pixel nguồn. Hai slider độc lập có thể đưa ra tổ hợp mâu thuẫn.

UI nên có một điều khiển chính, ví dụ `Mượt ↔ Bám sát`; backend chỉ nhận một hệ số quanh policy tự động. Không expose node count, kernel, Catmull tension hoặc tolerance nội bộ.

### §PV.5 — Lọc chi tiết nhỏ phải dùng mm²

Ngưỡng hiện tại kết hợp pixel tối thiểu và tỷ lệ diện tích cả tờ. Đưa trực tiếp tỷ lệ này ra UI có thể xóa tem nhỏ trên tờ lớn. Điều khiển đúng là diện tích component rời theo mm², không áp vào notch/râu còn nối với tem và không tự xóa lỗ khi người dùng giữ lỗ.

## Thiết kế được đề xuất

### Luồng người dùng

1. Chọn ảnh: chỉ xem ảnh gốc, không tự quét.
2. Bấm `Phân tích ảnh và tạo bản xem trước`.
3. Chạy AI một lần, lưu raw Alpha + mask nền.
4. Hiện đường bao và bộ điều khiển; thay đổi chỉ hậu xử lý lại mask/path, không chạy model lại.
5. Bấm `Xác nhận đường bao`.
6. Export dùng đúng fingerprint của mask/path đã duyệt.

### Điều khiển đã chốt cho phiên bản đầu

- `Khử bóng`: `Giữ nguyên` / `Tự động`; candidate bóng cố định từ lần detect đầu.
- `Bám biên AI`: ngưỡng mask 128–176, có guard số tem/ID/lỗ và luôn xem trước lại trước khi xác nhận.
- `Mượt ↔ Bám sát CutContour`, `Chi tiết rời` và preset được hoãn sang lô 3.

## Kế hoạch theo lô

### Lô 1 — Mask preview có thể tinh chỉnh, không chạy lại AI

Backend, tối đa 4 file:

1. `backend/app/workers/sticker_sheet_engine.py`: tách inference và hậu xử lý; giữ raw Alpha/candidate bóng.
2. `backend/app/core/sticker_sheet_session.py`: lưu raw Alpha và cập nhật artifact preview atomically khi đang review.
3. `backend/app/schemas/sticker_sheet.py`: hợp đồng refine có range rõ ràng.
4. `backend/app/api/routes/sticker_sheet.py`: endpoint refine cùng session, có khóa stage/race.

Verify lô 1: engine tests + API/session tests trên bóng Alpha thấp/cao, artwork xám, sao lõm và ảnh 9 tem.

### Lô 2 — UI và state review

Desktop, tối đa 3 file sản xuất:

1. `desktop/src/lib/stickerSheetApi.ts`: gọi refine và tải lại asset có version.
2. `desktop/src/components/preprocess-tools/stickerSheetStore.ts`: tuning state, abort/generation guard, thu hồi blob cũ.
3. `desktop/src/components/preprocess-tools/StickerSheetPanel.tsx`: CTA preview và hai điều khiển review an toàn.

Workspace hiện tự đọc blob URL mới, nên chưa cần đổi worker ở lô này. Verify bằng Vitest store/panel, typecheck và build.

### Lô 3 — Preview đúng CutContour C2 cuối (đã hoàn tất)

Chỉ làm sau khi lô 1–2 được kiểm tay. Trích helper dựng path từ `StickerEngine` để endpoint preview và export dùng cùng một geometry/fingerprint. Không viết một bộ smooth thứ hai ở frontend.

## Điều kiện chấp nhận

- Không thao tác nào chạy AI trước nút chủ động của người dùng.
- Kéo điều khiển không chạy lại model; chỉ hậu xử lý dữ liệu đã cache.
- Số tem/thứ tự/topology không âm thầm thay đổi; nếu thay đổi phải cảnh báo hoặc từ chối candidate.
- Preview và export dùng cùng mask/path fingerprint.
- Giữ các chốt đã đo: không đoạn `<0,25 mm`, không khớp gãy `>1°`, giữ topology; IoU và Hausdorff không vượt policy theo kích thước/DPI.
- Test 72/150/300 DPI, kích thước 20/50/500/1600 mm, sao/lõm/lỗ treo và ảnh khách hàng 9 tem.

## Khuyến nghị chốt

Không làm bản UI-only. Tiến hành lô 1–2 trước với preview mask thật; chỉ mở slider mượt khi lô 3 dùng chung geometry cuối với export. Đây là đường ngắn nhất không đánh đổi tính trung thực của đường bế.
