# Đối chiếu audit `W2-U09 / W7-U11` với cây mã hiện tại, và Lô A (một phần)

Ngày 2026-08-29. Nguồn: `BAO_CAO_AUDIT_HIEU_NANG_VA_SUC_MANH_NESTING_TEM_CNC_2026-08-29.md`
(CHỐT 1, read-only) và `PRYNX_MASTER_AUDIT_MATRIX.md` hàng `W2-U09 / W7-U11`.

## 1. Vì sao phải đối chiếu trước khi sửa

Ảnh chụp của audit là **trước** vài lô gần nhất: nó ghi "315 test Rust hiện xanh" (cây hiện
tại **325**) và xếp NEST-AUD-01 preview là chưa sửa. Bắt tay vào roadmap A1–A4 mà không đối
chiếu sẽ làm lại việc đã xong, và tệ hơn: bỏ sót một finding vừa **chuyển từ tiềm ẩn thành
lỗi thật** do chính các lô đó.

## 2. Bảng đối chiếu 17 finding

| Mã | Tình trạng trên cây hiện tại | Bằng chứng |
|---|---|---|
| **NEST-AUD-01** Preview không chạy solver mới | **ĐÃ ĐÓNG** trước báo cáo này | §NEST-PREVIEW-1: `nesting_preview_capacity.py` + nhánh nesting trong `/preview-layout`. Đo: `totalItems=46` khớp engine (lưới cũ 41). `BAO_CAO_NEST_PREVIEW_VA_XOAY_2026-08-28.md` |
| **NEST-AUD-06** Session identity thiếu spec render | **ĐÃ ĐÓNG trong lô này** — và là hạng mục **cấp bách nhất** | Xem §3 |
| **NEST-AUD-03** Boong/ốc không là fixed obstacle | **ĐÃ ĐÓNG trong lô này** | Xem §4 |
| **NEST-AUD-09** "Fast 3 giây" không phải SLA | **Đóng một nửa** | Deadline nay được nạp lại sau baseline (§NEST-BASELINE-UNBOUNDED). Nhưng baseline vẫn **không có ngân sách riêng**, nên tổng vẫn là `baseline + cửa sổ trial`. Finding gốc còn đúng phần này |
| **NEST-AUD-10** NFP/refine quét toàn blocker | **Còn mở**, đã định lượng | Trùng `NFP-INCREMENTAL-1`. Đo được: 1 trial ≈ 12× baseline vì `fast` thử 12 góc/chi tiết còn baseline thử 1, mỗi góc dựng lại miền từ đầu |
| **NEST-AUD-08** Máy mạnh chạy gần một lõi | **Còn mở** | Trùng `NFP-PARALLEL-1` |
| **NEST-AUD-11/12** Search semantics yếu, angle diversity sụp | **Còn mở**, một phần đã cải thiện | §NEST-BASELINE-ROTATE-ON-FAIL cho baseline xoay khi 0° không đặt được (đo: 3 và 9 con xoay, +9% orientEval, số tờ **không** giảm trên file này). Beam/restart/edge-midpoint vẫn như audit mô tả |
| **NEST-AUD-02** CNC hai mặt bị hạ thành simplex | **Còn mở** | Chưa chạm. Là Lô A2 |
| **NEST-AUD-04** Trần cứng 200 tờ | **Còn mở** | Chưa chạm. Là Lô A3b |
| **NEST-AUD-05** Strategy persisted lách gate gang-only | **Còn mở** | Chưa chạm. Là Lô A4 |
| **NEST-AUD-07** Pin cùng PDF lại 13 lần | **Còn mở** | Chưa chạm. Là Lô B1 |
| **NEST-AUD-13** Không có floor từ heuristic tốt nhất | **Còn mở** | Là Lô C1 |
| **NEST-AUD-14** Work budget không phản ánh chi phí | **Còn mở** | Là Lô B5 |
| **NEST-AUD-15** Clearance dị hướng nén thành `hypot` | **Còn mở** | Là Lô C2 |
| **NEST-AUD-16** Progress không phản ánh công việc | **Còn mở** | Là Lô B5 |
| **NEST-AUD-17** Benchmark chưa đo đúng production | **Còn mở** | Là mục benchmark của KPI |

Ngoài danh sách audit, ba lỗ khác đã đóng trong các lô trước và **không** có mã trong báo cáo
đó, vì audit không chạm tới writer: ốc bế không được vẽ, report không được vẽ, và năm lỗi ánh
xạ tên khoá (`guide{i}Pos`, `showX`, `reportLamination` float, vị trí report). Xem
`BAO_CAO_NEST_WRITER_PONT_VA_KHOA_GIA_CONG_2026-08-28.md` và
`BAO_CAO_NEST_WRITER_REPORT_VA_TRIM_2026-08-28.md`.

## 3. NEST-AUD-06 — lô preview của tôi làm nó thành lỗi thật

`job_identity_key` gồm hình học/gap/duplex/obstacle nhưng **thiếu**
`trim/pont/cut/cut_style/artifact_options`. Chúng không đổi *layout*, nhưng nằm trong
**RenderBundle**, tức trong `renderBundleHash` và `layoutFingerprint` của phiên.

Trước §NEST-PREVIEW-1 điều này còn tiềm ẩn: **không ai tạo phiên từ preview**, nên khoá thiếu
field không gây hại. Từ khi preview tạo phiên và export tái dùng theo khoá đó, kịch bản sau là
lỗi thật và **im lặng**:

1. Người dùng preview với ốc góc → phiên vào kho.
2. Đổi sang không ốc, hoặc đổi field report, hoặc bỏ tách trang CUT.
3. Khoá **không đổi** ⇒ export tái dùng phiên cũ ⇒ tờ giao ra mang gia công cũ.

### Bản vá

`backend/app/core/nesting_preview_session.py` — thêm `_render_spec_key(job)` vào khoá. Cố ý
dùng `dataclasses.asdict` + JSON sắp khoá chứ **không** liệt kê tay từng field: thêm một field
mới vào bất kỳ spec nào là tự động vào khoá. Liệt kê tay chính là cách sinh ra bug này.

`backend/tests/test_nesting_preview_session.py` — `_FakeJob` nay mang **kiểu thật** của năm
spec. Fake này tự khai "cùng bề mặt field với `ProductionNestingJobInput` ở phần khoá đọc
tới", nên để nó lệch là làm mất hiệu lực mọi test khoá. Thêm 9 test.

Đã kiểm test bắt lỗi:

| Đột biến | Kết quả |
|---|---|
| Bỏ `_render_spec_key(job)` khỏi khoá | **7 đỏ** |
| Khoá chỉ dùng `type(value).__name__` thay vì `asdict` | **7 đỏ** |

### Hệ quả cần nói rõ

Với khoá nghiêm ngặt, preview và export **chỉ** chia phiên khi hai bên khai giống nhau cả năm
spec. Nhưng `PreviewLayoutRequest` **không** mang report/cut/trim/cutStyle — frontend chưa gửi.
Nên hôm nay: bật report ⇒ export solve lại. Điều đó **an toàn** (không bao giờ giao bundle
cũ) nhưng mất phần tiết kiệm.

Đây là đánh đổi có chủ đích: thà solve lại còn hơn giao tờ thiếu ốc. Việc đóng hẳn cần
`GridPreview.tsx` gửi thêm các khoá gia công — ghi thành finding `NEST-PREVIEW-FINISHING`.

## 4. NEST-AUD-03 — ốc bế thành vật cản

`fixed_obstacles` của job **luôn rỗng**, kể cả khi `disable_collision=False`. Lề ốc thường
7mm còn lề tờ 5mm, nên ốc nằm **trong** vùng dùng được ⇒ tem được xếp đè lên dấu canh. Thợ
mất dấu canh là mất cả tờ. Lane lưới đã có việc này qua
`pont_collision.calculate_forbidden_zones`; lane nesting chưa có bản tương ứng.

Lô ốc bế trước đó làm lỗi này **nhìn thấy được**: writer nay vẽ ốc thật, nên chỗ chồng lộ ra
trên tờ.

### Bản vá

`backend/app/workers/nup_nesting_finishing.py` — `build_pont_obstacles()` dựng bốn ô vuông ở
bốn góc (vuông là **bao trên** an toàn cho cả ốc tròn và góc L) cộng vạch guide. Ring bị kẹp
về trong tờ. `disable_collision=True` là người dùng cố ý tắt — tôn trọng, không âm thầm bật.

`backend/app/workers/nup_true_shape_nesting.py` — gắn vào `ProductionNestingJobInput`.

`backend/app/core/nesting_preview_capacity.py` — preview phải mang ốc, vì ốc **đổi sức chứa**.
`PreviewLayoutRequest` không có `pontType` riêng: `GridPreview.tsx` gửi
`pont_config: pontType && pontType !== 'none' ? pontConfig : null`, nên sự có mặt của
`pont_config` chính là tín hiệu bật ốc.

### Bất biến quan trọng nhất, và cách khoá nó

Vật cản phải nằm **đúng chỗ writer vẽ ốc**. Lệch nhau là lỗi tệ nhất có thể: solver tránh một
vùng trống trong khi tem vẫn đè lên dấu canh thật, và không ai phát hiện tới khi in.

`test_vat_can_trung_cho_writer_ve_oc` so trực tiếp hai công thức — `_pont_corner_centers_mm`
(engine, mm) và `_pont_corner_centers_pt` (writer, point). Sửa một bên mà quên bên kia là đỏ.

### Đo trên file khách

`test/test nesting.pdf`, 13 mẫu, tờ 320×430mm, ốc Ø5mm lề 7mm, ngân sách 2000ms:

| Cấu hình | con/tờ | vật cản | tem giao vùng ốc |
|---|---:|---:|---:|
| Không ốc | 46 | 0 | 0 |
| Có ốc, va chạm bật | **44** | 4 | **0** |
| Có ốc, `disableCollision=true` | 46 | 0 | 0 |

Đọc: vật cản đổi **2 con** để giữ bốn dấu canh sạch — đúng đánh đổi, vì tờ mất dấu canh là tờ
không dùng được. Không một tem nào giao vùng ốc.

Ghi lại một bẫy đo: bản đầu của probe báo "1 tem giao vùng ốc". Nó so **bbox** với vùng ốc, mà
contour lõm thì bbox chồng không có nghĩa hình chồng. Đo lại bằng đa giác thật (`shapely`) cho
**0** ở cả ba ca. Kết luận từ bbox trên hình lõm là không dùng được.

## 5. Verify

| Hạng mục | Kết quả |
|---|---|
| `test_nesting_preview_session.py` | 54 passed (thêm 9) |
| `test_nesting_pont_obstacles.py` | 12 passed (mới) |
| `test_nesting_preview_capacity.py` | 19 passed (thêm 4) |
| `test_nesting_session_handover.py` | không đổi, xanh |
| Full backend | **4606 passed, 19 skipped = 4625**, khớp `--collect-only` 4625, EXITCODE=0 |
| Đối chiếu số nền | 4600 (trước lô) + 9 (identity) + 12 (vật cản) + 4 (preview ốc) = 4625 |
| `cargo test imposition_core` | 325 passed, không đổi (lô này không chạm Rust) |

## 6. Thứ tự đề xuất tiếp, đã cập nhật theo cây hiện tại

Roadmap của audit vẫn đúng, chỉ đổi thứ tự vì A1 và hai hạng mục A3/A4 đã đóng:

| Thứ tự | Mã | Việc | Ghi chú |
|---:|---|---|---|
| 1 | `NEST-AUD-02` | CNC hai mặt: map Front/Back, flip edge, duplex registration | Lô A2 nguyên vẹn |
| 2 | `NEST-AUD-04` | Bỏ trần 200 tờ vô điều kiện, hoặc preflight báo thiếu số lượng | Fail-closed |
| 3 | `NEST-AUD-05` | Reset strategy khi rời gang; backend chặn mọi spelling S&R | Nguy hiểm vì ca tam giác 152→86 |
| 4 | `NEST-PREVIEW-FINISHING` | `GridPreview.tsx` gửi khoá gia công để phiên tái dùng được | Sinh từ §3 lô này |
| 5 | `NEST-AUD-07` | Pin một PDF đúng một lần | Lô B1, thắng lợi I/O rẻ |
| 6 | `NEST-AUD-08` | Hardware grant + parallel trial | Lô B2/B3 |
| 7 | `NEST-AUD-10` | Miền hợp lệ tăng dần | Chỗ có 10–100× |
| 8 | `NEST-AUD-13` | Portfolio solver | Chặn hồi quy 43,4% ca tam giác |

Cờ release giữ `false` như audit yêu cầu. Lô này không cập nhật golden và không build.
