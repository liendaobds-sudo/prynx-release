---
name: prynx-safe-write-cowork
description: "Quy trình ghi file AN TOÀN vào D:\\pdfcompare khi agent chạy trong phiên cloud (Claude Cowork remote, có device bridge mnt/pdfcompare). BẮT BUỘC đọc trước khi ghi/sửa bất kỳ file nào của repo từ phiên cloud — kênh ghi mặc định từng làm hỏng file. KHÔNG áp dụng cho Codex/Claude Code chạy trực tiếp trên máy Windows (ghi file bình thường). Use when writing files from a remote cloud session, device bridge, staging, md5 verify, file corruption, ghi file về máy user."
---

# Ghi file an toàn từ phiên cloud (Cowork remote)

## Vì sao phải có quy trình này

Kênh đồng bộ file mặc định của bridge (`device_stage_files`/`device_commit_files`) từng: trả bản CŨ (stale) khi đọc, và flush TRỄ đè lên file sau khi đã ghi — làm `api.ts` cụt giữa chừng và `Cargo.toml` dính rác, vỡ cả vite lẫn cargo build. Gõ tay nội dung dài qua heredoc cũng đã lệch byte. Mọi thao tác vì vậy phải kết thúc bằng **so md5 với hash chuẩn qua `device_bash`** — không có md5 khớp thì coi như chưa ghi.

## Quy trình chuẩn (đã kiểm chứng)

Ghi file bất kỳ (nhất là >1KB):

1. Tạo file chuẩn trong workspace cloud, tính `md5sum` — đây là hash chuẩn.
2. `SendUserFile` file đó → lấy `file_uuid`.
3. `device_commit_files` vào thư mục **ĐỆM** `D:\pdfcompare\_claude_transfer\` — **không bao giờ commit thẳng vào file đích**.
4. Một lệnh `device_bash` duy nhất: `md5sum` bản đệm → **chỉ khi khớp hash chuẩn** mới `cp` backup file đích cũ ra `/tmp/bak_*` rồi `cp` đệm → đích → `md5sum` đích lần cuối.
5. `mv _claude_transfer` vào `_to_delete/` (mount cấm rm — user tự xóa). Flush trễ nếu xảy ra chỉ chạm bản đệm đã bỏ, không chạm đích.

Nhiều file: gói `tar.gz` một lần, commit vào đệm, bung tar ra /tmp của VM rồi `cp` đè từng file vào repo (tar KHÔNG tự đè được file đã tồn tại trên mount — fallback của nó là unlink, bị cấm; chỉ file MỚI là giải thẳng được), verify md5 từng file theo manifest.

## Các ràng buộc của mount

- `rm`/`rmdir`/`unlink` bị cấm → muốn xóa: `mv` vào `_to_delete/` rồi nhờ user xóa.
- Khôi phục file về bản gốc: `git show HEAD:<path> > <path>` (ghi đè được, không cần unlink).
- Patch nhỏ tại chỗ: dùng `python3` có sẵn trên VM qua `device_bash`, chú ý file có thể là CRLF — match chuỗi phải thử cả hai EOL; xong vẫn phải `md5sum` so hash chuẩn.
- Sửa file xong LUÔN kiểm tra nhanh tính hợp lệ: file .py → `py_compile`; .json/.toml → parse; .ts → đếm dòng/md5 so bản chuẩn.

## Điều tuyệt đối tránh

- Ghi đè file đích rồi mới kiểm tra ("hy vọng đúng").
- Tin kết quả `device_stage_files` là bản mới nhất mà không so mtime/md5.
- Heredoc/gõ tay nội dung >~2KB hoặc nội dung lặp ký tự (base64, `======`) — dùng đường commit-đệm ở trên.
- Kết luận "file trên đĩa đã đổi/mất" chỉ dựa trên kênh stage — phải xác nhận bằng `device_bash` (`md5sum`, `wc -c`) trước khi báo user.
