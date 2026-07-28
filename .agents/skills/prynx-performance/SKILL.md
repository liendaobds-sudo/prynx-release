---
name: prynx-performance
description: "Nguyên tắc tối ưu hiệu năng PrynX: RAM-gating (máy yếu mới giảm, máy mạnh full công suất), quy tắc Cargo LTO, danh sách hồi quy và false-positive đã biết. BẮT BUỘC đọc trước khi thêm bất kỳ cap/limit/worker/cache nào hoặc 'tối ưu' bất kỳ chỗ nào. Use when optimizing performance, adding limits or caps, tuning worker pools, Cargo profiles, build speed, memory usage, tối ưu tốc độ, thân thiện phần cứng."
---

# Nguyên tắc hiệu năng PrynX

## Nguyên tắc VÀNG (lời chủ dự án — không thương lượng)

> "Chỉ điều chỉnh khi máy yếu, còn máy mạnh thì tất cả tính năng cho lút cán."

Mọi giới hạn tài nguyên (worker, số job đồng thời, độ phân giải preview, hiệu ứng UI…) phải **gate theo phần cứng**, thang chuẩn theo RAM:

| RAM máy | Được phép |
|---|---|
| < 8 GB | giảm mạnh (vd `min(cores, 2)`) |
| 8–16 GB | giảm nhẹ (vd `min(cores, 4)`) |
| ≥ 16 GB | **KHÔNG cap** — giữ full (`cores-1`/full, hiệu ứng đầy đủ) |

Một cap vô điều kiện từng làm bình tem bế chậm **2×** trên máy mạnh. Trước khi thêm limit, tự hỏi: "máy 32GB/16 nhân có bị chậm đi vì dòng này không?" — nếu có, phải gate.

Escape hatch cho user: env `PRYNX_MAX_HEAVY_JOBS`, `STICKER_MAX_WORKERS`, `PRYNX_NUP_WORKERS` luôn thắng auto-detect.

## Quy tắc Cargo / Rust build

- **KHÔNG thêm `[profile.release]` (lto, codegen-units, strip) vào bất kỳ Cargo.toml nào.** Vòng dev dùng `maturin develop --release` — LTO trong toml làm mỗi vòng sửa-thử chậm đi nhiều phút.
- LTO thin + codegen-units=1 + strip chỉ bật lúc đóng gói, qua env `CARGO_PROFILE_RELEASE_*` set/restore trong `build_production.ps1` (hai chỗ: quanh bước maturin và bước tauri build) cùng `RUSTFLAGS=-C target-cpu=x86-64-v2`. Sửa một chỗ phải sửa chỗ kia.

## Bài học đã trả giá — đừng lặp lại

1. **§3.14**: cap worker đồng loạt theo hồ sơ StickerEngine → nup/vdp chậm 2× máy mạnh. Sửa đúng: bảng RAM ở trên, ≥16GB giữ nguyên.
2. **§3.16 là FALSE POSITIVE**: các bản copy overlay trong UI trông "thừa" nhưng cần cho spotlight GIF — không được "tối ưu" xóa đi.
3. Preview khuôn bế từng bị xếp hàng sau heavy slot → dùng threadpool thường cho việc trung bình (xem `prynx-imposition`).
4. Danh mục ~60 phát hiện + trạng thái từng cái nằm ở `docs/BAO_CAO_AUDIT_HIEU_NANG_*.md` và `docs/PERF_FIXES_*.md` — **đọc trước khi tối ưu** để khỏi làm lại/làm ngược.

## Cách làm một thay đổi hiệu năng đúng

1. Đo trước (thời gian thật trên tác vụ thật — bình 1 file tem điển hình, preview khuôn) — ghi số vào báo cáo.
2. Sửa + gắn comment tag `PERF (audit <ngày> §x.y)` để truy vết/revert lẻ.
3. Đo lại trên CẢ hai kịch bản máy mạnh (không được chậm đi) và giả lập máy yếu (env cap) — hồi quy máy mạnh là lỗi chặn merge.
4. Việc I/O + CPU trộn lẫn: tách phần chặn ra threadpool đúng tầng (xem `prynx-imposition`), đừng tăng worker bừa.
