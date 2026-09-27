# Tái sử dụng hình học CUT trong cùng job — 27/09/2026

## Phạm vi được duyệt

Người dùng chỉ duyệt mục 1: cùng hình học/thông số thì tính một lần; không
thêm chế độ nhanh, không đánh đổi chất lượng để lấy thời gian. Lô này giữ
nguyên solver QR, seed, số vòng, dung sai, verifier, fitter, DPI, màu và writer.
Không phục hồi AUTO-skip-fitted trước ngày 25/09.

Baseline của lô này là **source sau tối ưu QR, trước thêm reuse**, không phải
bản trước nâng cấp 25/09. Giữ nguyên mọi thay đổi khác trong workspace.
Phạm vi 5 file: hai module production, một bộ test, harness benchmark có sẵn
và báo cáo này. Không stage/commit, không build release, không cập nhật golden.

## Bằng chứng trước sửa

`with_simplify_memo` cũ chỉ tạo scope khi được truyền snapshot. Job không có
snapshot thì `_MEMO=None`; mỗi worker gọi solver lại trên từng trang. Memo
cục bộ cũng không phối hợp các process để tránh cùng lúc tính một khuôn.

Probe trên PDF VDP 123 trang ghi đủ 123 input Simplify, tất cả cùng một hash
control-points/options. Không suy đoán trùng khuôn từ tên file hoặc kích thước
trang. PDF nguồn giữ nguyên SHA-256:
`5b25ccbd63f7b278aea32109ea12f6777fdfaee91a3eb1a951fd33e2c1956804`.

## §CUT.REUSE — cách xử lý

- `cutline_simplify_memo.py`: job engine tự có scope memo; giữ scope ngoài
  của preview nếu đã có để không mất kết quả dùng bàn giao.
- Process pool dùng một broker RAM riêng cho đúng lượt chạy. Một worker
  nhận quyền giải một key; các worker cùng key chờ kết quả đã kiểm. Khóa
  broker chỉ bao thao tác claim/publish, không bao solver. Các key khác nhau
  tiếp tục chạy song song.
- Key cũ được giữ nguyên: phiên bản thuật toán, tất cả điểm điều khiển mọi
  ring/lỗ, toàn bộ options sau áp default, đơn vị và frame writer. Không làm
  tròn tọa độ để tăng hit rate; khác 1e-12 cũng là key khác trong test.
- Chỉ lưu rings và stats; metadata thuộc trang/caller hiện tại được giữ lại.
  Không chia sẻ ảnh, nội dung VDP hoặc trang PDF. Kết quả đọc ra được sao chép
  độc lập; sửa kết quả của caller không làm hỏng memo.
- Thành công mới publish; lỗi/cancel nhả claim, không cache kết quả tính dở.
  Worker process crash làm pool lỗi; broker đóng trước retry, nên claim cũ
  không làm kẹt pool mới. Broker/IPC lỗi thì giải trực tiếp bằng cùng solver.
  Nếu broker tiếp tục trả trạng thái chờ quá 120 giây, consumer tự giải đầy
  đủ; đây chỉ là đường thoát chờ memo mồ côi, không timeout/cắt vòng solver
  và không xóa claim của producer khác. Có test riêng cho trường hợp này.
- Không giữ dữ liệu qua job hoặc đọc cache từ đĩa/HTTP. Snapshot preview vẫn
  chỉ đến từ RAM backend đã được kiểm source/revision/fingerprint như trước.
- Máy >=16 GB không bị cap memo hay giảm worker. Máy <8 GB dùng budget
  16 MiB, 8–16 GB dùng 64 MiB cho memo mới; đầy thì không nhận thêm cache và
  tính lại, không giảm chất lượng. Snapshot preview đã duyệt ở scope cục bộ
  vẫn giữ nguyên, không xóa vì hết budget. Đây là budget dữ liệu memo, không
  phải cam kết giới hạn toàn bộ working set của Python/process.
- Không mở broker khi chỉ chạy một worker, chỉ cắt trang đầu, không có CUT,
  xén chữ nhật hoặc nhánh không gọi Simplify. Scope cục bộ vẫn tái sử dụng
  được giữa các trang trong chunk/luồng tuần tự.

Consumer đã rà: StickerEngine tuần tự/pool/fallback; classic whole-page
preview thu memo; snapshot preview chuyển vào Execute; Simplify của preview
Alpha; cancellation và việc giữ metadata riêng theo caller.

## Benchmark backend và artifact

Harness: `scripts/benchmark_cutline_runtime.py`; artifacts riêng:
`.tmp/cutline-reuse-20260927/`. Không sửa PDF nguồn, không khởi động lại app
đang mở. Harness chuyển log worker sang thư mục benchmark.

VDP: `test/test PPE/VDP_Tem Trung Thu chi cuc thue 2026 Auto Tem 10x16cm Auto_123records.pdf`.
300 DPI, mode bleed, bleed=0, offset=0, preserve, tension50, denoise30,
solid trắng, remove_white_bg=false, AUTO/.1 mm, tạo CUT mọi trang. Benchmark
không truyền canonical preview; **không phải thao tác GUI hoặc đầy đủ các
thiết lập đã lưu trong phiên người dùng**. Không đem thời gian này thay cho
log GUI 58 giây đã đọc trước đó.

| Cấu hình | Trước reuse | Sau reuse | Bằng chứng |
|---|---:|---:|---|
| VDP 123 trang, 15 worker | 212,135 s | 29,253 s | 123 lần giải → 1 compute, 122 hit |
| VDP 123 trang, override 2 worker | 383,322 s | 39,756 s | 1 compute, 122 hit, pending=0 |
| Binder2, 13 khuôn/13 worker | 20,125 s | 18,813 s | 13 compute, 0 hit, 0 wait |

VDP nhanh khoảng 7,25× trong cặp đo này; N=1 mỗi phía, không coi là SLA hoặc
tỷ lệ áp dụng mọi file. Binder2 không có hình trùng nên không lấy chênh lệch
nhỏ đó làm công trạng của cache; quan trọng là không tuần tự hóa solver và
không quan sát hồi quy đáng kể trong lượt kiểm này.

Baseline VDP được chạy trước khi sửa production. Baseline Binder2 dùng
`--memo-off` để khôi phục đúng việc không tự mở scope/chia sẻ job, chỉ trong
process benchmark, vẫn giữ QR hiện tại. Không sửa/rollback file production
để đo. Lượt 2 worker cũng dùng đúng đối chứng này, nhanh khoảng 9,64×; chỉ
giả lập hạn chế worker bằng env, không gọi là máy RAM thấp vật lý. Cả các
lượt timing chạy riêng, không song song với test/so pixel.

### Chất lượng

- VDP: **123/123 trang có toàn bộ tọa độ/lệnh CUT và stats khớp hoàn toàn**
  trước/sau ở cả cấu hình 15 và 2 worker. Không chỉ so số node hoặc hình trông
  gần giống.
- `verify/vdp-parity.json`: 123/123 trang khớp pixel PDFium ở 150 DPI,
  **bao gồm cả đường CUT**, khổ trang và stream ảnh giữ nguyên. Đã soi các
  trang đầu/cuối; tên/số VDP khác nhau vẫn được giữ, không copy artwork của
  trang đầu sang trang khác.
- `verify-two/vdp-two-parity.json`: 123/123 trang ở 2 worker cũng khớp toàn
  bộ pixel bao gồm CUT, không chỉ metadata/cận sai số.
- Binder2: toàn bộ CUT và stats của 13 trang khớp đối chứng cùng cấu hình.
- SHA-256 PDF nguồn được kiểm trước/sau từng lượt benchmark; không thay file
  nguồn hoặc artifact baseline.

## Verify

- Test mới bắt đúng lỗi trước sửa: hai lần cùng hình học trong một job vẫn
  gọi solver hai lần. Sau sửa có test thread và Windows spawn process thật.
- Phủ: cùng key chỉ giải một lần; key khác song song; geometry/lỗ/frame/units/
  options/algorithm khác không hit; metadata/mutation isolation; job mới không
  giữ cache cũ; memo preview; lỗi solver; producer/waiter cancel; broker lỗi;
  mất response claim; worker crash; pool retry không giữ claim cũ; RAM gate và
  cache đầy không hạ chất lượng.
- Bộ tích hợp memo/jobs/cancel/pool/classic preview/AUTO/export contract:
  lần cuối **249 passed, 0 failed**, 87,85 s, có Windows ProcessPool. Bộ trước
  248 pass và bộ hẹp 105 pass nằm trong tổng này, không cộng lặp. Chỉ còn
  warning Pydantic/Starlette cũ.
- `py_compile` và `git diff --check` phạm vi sửa đạt; không cập nhật snapshot.
- Không sửa frontend/Rust nên không chạy lại Vitest/tsc/Cargo cho lô này.
- Chưa nghiệm thu thao tác Tauri hoặc binary Nuitka/bộ cài. Broker dùng
  multiprocessing tiêu chuẩn đã kiểm Windows source; cần smoke đóng gói khi
  release. App/sidecar đang mở phải nạp source mới để kiểm runtime UI.

## Giới hạn

Cache chỉ giúp khi **đầu vào hình học thật sự giống hệt**. Đường chỉ gần giống,
thay scale/frame, trang có khuôn khác hoặc tham số khác vẫn phải tính đủ.
Mỗi job vẫn cần đọc/render artwork từng trang và ghi PDF; không tuyên bố
mọi phần của VDP chỉ còn một lần xử lý. Lô này không tối ưu inpaint/bù màu.

Hash production khi chốt:

- `cutline_simplify_memo.py`: `8CD40782F867DBA6E0A17F66C43715496B2AFD0549A30A19EDABE655B19841AE`
- `sticker_engine.py`: `A7AA06B9B57E6DC56CCA5A3967580534F84BBDFEBEBC5A17F8FA0D93ED166CF7`
