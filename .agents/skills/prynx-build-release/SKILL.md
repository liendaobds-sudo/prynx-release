---
name: prynx-build-release
description: "Vòng dev và pipeline đóng gói/phát hành PrynX: preflight, maturin, QA, Nuitka, Tauri, manifest, provenance, log và cứu artifact sau lỗi cuối lượt. Đọc khi build, packaging, release, debug build, sửa script build hoặc thay đổi sidecar."
---

# Build & phát hành PrynX

## Bất biến trước khi chạy

- Không tự khởi động build chỉ vì đang điều tra hoặc sửa script; chỉ chạy khi user yêu cầu rõ.
- Trước build nội bộ/phát hành, commit và push toàn bộ source hợp lệ; xác nhận worktree sạch và HEAD khớp remote.
- Build không được ghi lại tracked source. File sinh tự động như `THIRD_PARTY_NOTICES.md` phải được tạo, review, commit trước; pipeline chỉ dùng `--check` rồi copy sang staging.
- Lỗi cấu hình dự đoán được phải fail trước native/QA/Nuitka: version, Python ABI, dependency, khóa, dung lượng, NOTICE và trạng thái Git.
- Số dòng vật lý chỉ là báo cáo kiến trúc (`python scripts/report_architecture_debt.py`), không phải test chặn build. Giữ hard gate cho hành vi, typecheck, endpoint, bảo mật và provenance.

## Vòng dev — `run_dev.bat`

Một lệnh dựng đủ môi trường, theo thứ tự: tạo `backend/venv` + pip install nếu thiếu → set POPPLER_PATH (từ `poppler/`) vào `backend/.env` → môi trường Node → build native (`maturin develop --release`) → bundle dieline sidecar → chạy backend uvicorn + vite dev + app Tauri. Sửa Rust native xong phải để maturin chạy lại (hoặc tự chạy `maturin develop --release` trong `native/`) thì backend mới nhận.

Vì sao dev vẫn dùng `--release` cho native: PDFium/render debug chậm không dùng nổi. Đây là lý do **cấm LTO trong Cargo.toml** — nó sẽ đội thời gian mỗi vòng sửa-thử (xem `prynx-performance`).

## Đóng gói — `build_production.ps1`

Bản nội bộ dùng `powershell.exe -NoProfile -ExecutionPolicy Bypass -File build_production.ps1 -NoOpenExplorer`; không thêm `-Release`. Luồng chính: preflight → bundle dieline → native wheel → full QA trên wheel staged → Nuitka sidecar → frontend → Tauri/NSIS → installer → manifest. Điểm dễ hỏng:

1. **LTO qua env, hai chỗ đối xứng**: script set rồi restore `CARGO_PROFILE_RELEASE_LTO=thin`, `CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1`, `CARGO_PROFILE_RELEASE_STRIP=symbols` + `RUSTFLAGS=-C target-cpu=x86-64-v2` quanh bước maturin VÀ quanh bước tauri build. Sửa giá trị phải sửa cả hai chỗ; thêm bước build Rust mới thì bọc env tương tự.
2. **Nuitka**: thêm thư viện Python mới cho backend → kiểm tra nó được Nuitka gom đủ (data files, binary phụ như poppler); thiếu sẽ chỉ lộ ra ở bản đóng gói, dev không thấy.
3. **Sidecar dieline**: bundle `build:dieline-sidecar` phải được build lại trước khi đóng gói nếu có sửa `lib/dieline` — bản trong installer là bản đã bundle, không phải source.
4. x86-64-v2: bản phát hành yêu cầu CPU từ ~2009+; đừng nâng lên v3 khi chưa hỏi chủ dự án (loại máy khách cũ).
5. Terminal log phải hiện cho cả nội bộ và phát hành. Status JSON phải chịu được atomic replace/file lock Windows; không suy “mất trạng thái” từ một lần đọc tạm thất bại.
6. Không kill theo tên process khi điều tra. Chỉ dừng đúng process tree do lượt chạy tạo.

## Mức hoàn thành và cứu artifact

- **Build/compile xong**: sidecar, frontend, Tauri và installer đã được tạo.
- **Finalize xong**: manifest có hash và provenance khớp đúng artifact.
- **Runtime verified**: installer được cài/smoke trong profile sạch và manifest ghi `RUNTIME_VERIFIED=yes`.

Không gọi “phát hành hoàn tất” nếu mới đạt mức thấp hơn. Verifier không ghi đè profile đã có PrynX; dùng Windows Sandbox, VM hoặc user sạch.

Nếu installer đã tồn tại mà manifest/finalize lỗi, không build lại theo phản xạ. Xác minh hash installer/build EXE/sidecar/frontend và lấy native identity từ đúng artifact. Chỉ cứu bản nội bộ khi provenance ghi được trung thực; public release luôn fail-closed. Không đoán timestamp/hash/identity. Nếu thiếu bằng chứng từ đúng artifact thì phải rebuild.

Checkpoint/resume content-addressed theo từng tầng là mục tiêu dài hạn, chưa được giả định là đã có. Không reuse chỉ vì file tồn tại.

## Phát hành

`PHAT_HANH.bat` / `release_update.ps1` / `quanly_phathanh.ps1` + `publisher.config.json`, sản phẩm vào `Ban_Phat_Hanh/`. Đọc script trước khi đổi quy trình; không hardcode đường dẫn máy cá nhân vào script phát hành.

Không tự upload, ký updater, bump version hoặc tạo public release khi user chưa yêu cầu.

## Chẩn đoán build lỗi nhanh

- `cargo ... key with no value` → Cargo.toml dính rác/merge hỏng; so với `git show HEAD:<file>`.
- vite PARSE_ERROR giữa file TS → file bị ghi cụt (kiểm md5/độ dài so với git; xem `prynx-safe-write-cowork`).
- Backend đóng gói chạy khác dev → nghi Nuitka thiếu data/hidden import trước tiên.
- Provenance đổi cuối lượt → tìm tracked file bị chính pipeline sửa; không nới chốt để cho xanh.
- Sạch triệt để: xóa `desktop/dist`, `desktop/node_modules/.vite`, `target/` của crate liên quan rồi build lại — đừng xóa `backend/venv` trừ khi hỏng thật.
