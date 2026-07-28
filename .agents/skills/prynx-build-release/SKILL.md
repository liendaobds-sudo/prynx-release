---
name: prynx-build-release
description: "Vòng dev (run_dev.bat) và pipeline đóng gói phát hành PrynX (build_production.ps1: Nuitka sidecar, maturin, tauri, LTO qua env). Đọc khi build lỗi, khi sửa script build, khi đóng gói/phát hành bản mới, hoặc khi thay đổi cấu trúc sidecar. Use when building, packaging, releasing, debugging build errors, Nuitka, maturin, tauri bundle, đóng gói, phát hành."
---

# Build & phát hành PrynX

## Vòng dev — `run_dev.bat`

Một lệnh dựng đủ môi trường, theo thứ tự: tạo `backend/venv` + pip install nếu thiếu → set POPPLER_PATH (từ `poppler/`) vào `backend/.env` → môi trường Node → build native (`maturin develop --release`) → bundle dieline sidecar → chạy backend uvicorn + vite dev + app Tauri. Sửa Rust native xong phải để maturin chạy lại (hoặc tự chạy `maturin develop --release` trong `native/`) thì backend mới nhận.

Vì sao dev vẫn dùng `--release` cho native: PDFium/render debug chậm không dùng nổi. Đây là lý do **cấm LTO trong Cargo.toml** — nó sẽ đội thời gian mỗi vòng sửa-thử (xem `prynx-performance`).

## Đóng gói — `build_production.ps1`

Các bước chính: build frontend (vite) → build native maturin (bánh wheel nhúng) → **đóng gói backend bằng Nuitka** thành sidecar .exe → tauri build ra installer. Điểm dễ hỏng:

1. **LTO qua env, hai chỗ đối xứng**: script set rồi restore `CARGO_PROFILE_RELEASE_LTO=thin`, `CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1`, `CARGO_PROFILE_RELEASE_STRIP=symbols` + `RUSTFLAGS=-C target-cpu=x86-64-v2` quanh bước maturin VÀ quanh bước tauri build. Sửa giá trị phải sửa cả hai chỗ; thêm bước build Rust mới thì bọc env tương tự.
2. **Nuitka**: thêm thư viện Python mới cho backend → kiểm tra nó được Nuitka gom đủ (data files, binary phụ như poppler); thiếu sẽ chỉ lộ ra ở bản đóng gói, dev không thấy.
3. **Sidecar dieline**: bundle `build:dieline-sidecar` phải được build lại trước khi đóng gói nếu có sửa `lib/dieline` — bản trong installer là bản đã bundle, không phải source.
4. x86-64-v2: bản phát hành yêu cầu CPU từ ~2009+; đừng nâng lên v3 khi chưa hỏi chủ dự án (loại máy khách cũ).

## Phát hành

`PHAT_HANH.bat` / `release_update.ps1` / `quanly_phathanh.ps1` + `publisher.config.json`, sản phẩm vào `Ban_Phat_Hanh/`. Đọc script trước khi đổi quy trình; không hardcode đường dẫn máy cá nhân vào script phát hành.

## Chẩn đoán build lỗi nhanh

- `cargo ... key with no value` → Cargo.toml dính rác/merge hỏng; so với `git show HEAD:<file>`.
- vite PARSE_ERROR giữa file TS → file bị ghi cụt (kiểm md5/độ dài so với git; xem `prynx-safe-write-cowork`).
- Backend đóng gói chạy khác dev → nghi Nuitka thiếu data/hidden import trước tiên.
- Sạch triệt để: xóa `desktop/dist`, `desktop/node_modules/.vite`, `target/` của crate liên quan rồi build lại — đừng xóa `backend/venv` trừ khi hỏng thật.
