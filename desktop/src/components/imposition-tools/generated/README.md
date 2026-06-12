# Generated TS types (từ `imposition_core`)

Các file `*.ts` ở đây được **sinh tự động** từ struct Rust trong `imposition_core/src/model.rs`
bằng `ts-rs`. **Không sửa tay.** Đây là nguồn kiểu duy nhất cho hợp đồng bình bài
(Task 7, Requirements 4.1/4.2) — field client gửi mà lõi không có sẽ thành lỗi biên dịch.

## Regenerate

```powershell
cd imposition_core
$env:TS_RS_EXPORT_DIR = "../desktop/src/components/imposition-tools"
cargo test --features ts-export
```

(Trên bash: `TS_RS_EXPORT_DIR=../desktop/src/components/imposition-tools cargo test --features ts-export`)

Sau khi đổi `model.rs`, chạy lại lệnh trên để cập nhật. `index.ts` là barrel tiện dụng,
cập nhật tay khi thêm/bớt type.
