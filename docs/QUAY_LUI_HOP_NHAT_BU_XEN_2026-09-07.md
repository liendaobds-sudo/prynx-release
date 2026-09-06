# Quay lui hợp nhất Bù xén - 2026-09-07

## Yêu cầu và kết quả

Người dùng yêu cầu quay về mốc trước hợp nhất `64129a6`. Hoàn tác29commit từ
`ef9d025` đến `97ded74` bằng `git revert --no-commit`, giữ lịch sử thay vì reset.
Toàn bộ code/test trong `backend` và `desktop` đã đối chiếu bằng Git và khớp chính xác `64129a6`.
Không tự vá thêm hay giữ lại một phần giao diện hợp nhất.

- Hai luồng `Bế tem nhãn` và `Tách nhiều tem` dùng lại panel/logic trước hợp nhất.
- Bản sửa bóng A/B `4f914f4` và các thay đổi trước mốc64129a6 còn nguyên.
- Các sửa phát sinh sau mốc này (zoom, khung/cung CUT, ring11điểm, custom unified, recipe/Undo
  unified) không còn trong code đang dùng. Chỉ lấy lại riêng khi có yêu cầu mới.
- 14file code/test và5tài liệu được thêm trong nhóm29commit đã được gỡ khỏi checkout;
  code chưa commit của lượt audit tiếp cũng được cất khỏi checkout. Có thể khôi phục từ checkpoint.

## Checkpoint trước khi quay lui

- Git: `6ffc1f4bf0682c14c4da694e5b485813d4bb801e`.
- Ref cố định: `codex/backup-unification-2026-09-07`; vẫn giữ stash cùng mốc, không drop.
- Snapshot stash lưu41file code/tài liệu trong phạm vi; file mới chưa tracked nằm ở parent thứ3.
- ZIP: `D:/pdfcompare/tmp/rollback_unification_20260907/all-uncommitted-files.zip`.
- ZIP có đủ49file chưa commit trước lượt quay lui, giữ cấu trúc thư mục; đã so SHA-256 từng entry
  với file gốc trước khi stash. Bao gồm cả8file master/nesting ngoài phạm vi để dự phòng.
- SHA-256 ZIP: `313C08DB50E54043B25B7833B307C1811E47B26FC6182BB0ADCAAB338BDB81E6`.

Các tài liệu nesting/master đang làm dở không đưa vào commit quay lui. Chỉ thêm ghi chú `STALE`
vào phần4.1 của master do lượt hợp nhất tạo, giữ toàn bộ thay đổi khác của người dùng.
Các PDF nguồn, session runtime, thư mục chẩn đoán và dữ liệu ignored không bị xóa.

## Verify

- `git diff --quiet 64129a6 -- backend desktop`: đạt, không khác source/test.
- `git merge-base --is-ancestor 4f914f4 64129a6`: đạt, giữ bản sửa bóng.
- Frontend:49file/561test đạt; không đổi snapshot. Có warningact/log ca âm có sẵn.
- Typecheck đạt. Backend330test/8suite đạt,53,56s,2warning Starlette/Pydantic có sẵn.
- `git diff --check` và `git diff --cached --check`: đạt.
- Chưa kiểm thao tác native Tauri; không build installer, push hoặc release.

Các báo cáo hợp nhất ngày06/09 là bằng chứng lịch sử của bản đã cất; không dùng chúng để khẳng
định hành vi của code sau quay lui. Khi cần lấy lại bản cũ, phải xem cả commit nền97ded74 và snapshot,
không áp mù các thay đổi unified lên nền64129a6.
