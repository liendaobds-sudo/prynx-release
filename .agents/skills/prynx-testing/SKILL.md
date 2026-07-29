---
name: prynx-testing
description: "Ma trận test + quy trình verify của PrynX trước khi báo hoàn thành bất kỳ thay đổi code nào: vitest/tsc (chỉ Windows), pytest golden, cargo check, chính sách snapshot golden master, checklist kiểm tay 2D/3D. Use when running tests, verifying changes, before declaring done, CI, typecheck, snapshot updates, kiểm thử, chạy test."
---

# Kiểm thử & verify PrynX

## Ma trận test theo tầng

| Tầng | Lệnh | Ghi chú |
|---|---|---|
| TS types | `cd desktop && npm run typecheck` | `tsc --noEmit -p tsconfig.app.json` |
| Unit/test TS | `cd desktop && npm run test` | vitest toàn bộ |
| Riêng khuôn bế | `npx vitest run src/lib/dieline` | nhanh hơn khi chỉ sửa dieline |
| Lint | `npm run lint` + `npm run lint:budget` | budget = giới hạn kích thước bundle |
| Backend | `backend\venv\Scripts\python -m pytest tests` | có `conftest.py` + bộ `golden/` |
| Cú pháp Python nhanh | `python -m py_compile <file>` | khi chưa tiện chạy full pytest |
| Rust | `cargo check` / `cargo test` trong `native/`, `imposition_core/`, `print_engine/` | native cần `maturin develop --release` để backend nhận bản mới |
| Sidecar dieline | `npm run build:dieline-sidecar && npm run check:dieline-webview` | bắt buộc sau khi đổi `lib/dieline` |

## Ràng buộc môi trường — quan trọng

- **vitest/tsc/eslint chỉ chạy trên máy Windows thật của dự án.** `node_modules` cài binary Windows (esbuild, vitest…) — chạy trong VM/CI Linux với node_modules đó sẽ fail giả. Agent làm việc từ xa: giao user chạy và dán kết quả.
- Backend chạy bằng venv trong `backend/venv` (run_dev.bat tự tạo); poppler lấy từ `poppler/` qua PATH — test tự chạy ngoài run_dev cần set tương tự.

## Chính sách snapshot golden master

- `goldenMaster.test.ts` (dieline) và `backend/tests/golden/` là chốt chống trôi kết quả. Snapshot FAIL sau khi sửa hình học/render là TÍN HIỆU, không phải phiền phức.
- Chỉ cập nhật (`npx vitest -u src/lib/dieline/goldenMaster.test.ts`) khi: (1) thay đổi là chủ đích, (2) đã soi diff snapshot và giải thích được từng khác biệt. Không bao giờ `-u` cả bộ cho "xanh".

## Trình tự verify chuẩn trước khi báo xong

1. typecheck xanh → 2. vitest phạm vi liên quan xanh (snapshot xử lý đúng chính sách) → 3. pytest/py_compile nếu chạm backend → 4. cargo check nếu chạm Rust (+ maturin rebuild) → 5. build sidecar nếu chạm dieline → 6. chạy `run_dev.bat`, thao tác thật tính năng vừa sửa.

Kiểm tay khi chạm khuôn bế: 2D — chuỗi CUT kín, crease chạm đỉnh, chú thích đúng chỗ; 3D — kéo foldProgress 0→100%, panel gập đúng giai đoạn, không xuyên/bay (chi tiết trong `prynx-dieline`).

Báo kết quả trung thực: liệt kê test đã chạy + kết quả, test chưa chạy được (và vì sao), snapshot nào đã `-u` với lý do.

## Ma trận bắt buộc cho điều hướng tab và file

Khi sửa routing, drag/drop, picker, Back hoặc trạng thái công cụ, kiểm tra tối thiểu:

- Mở công cụ trực tiếp từ Home/registry.
- Chuyển sang công cụ từ một tab PDF đã tồn tại.
- Nhận file bằng picker, DOM drop và Tauri native drop nếu các đường này cùng tồn tại.
- Công cụ cùng loại đang nằm ở tab nền không được nhận sự kiện.
- Chuyển khỏi công cụ rồi mới gửi file: intent lúc mở tab không được hút file.
- Đóng tab rồi gửi file: registry/listener cũ không được nuốt file.
- Nhiều tab cùng loại: chỉ `activeTabId` đúng đích được thay đổi.

DOM test không chứng minh được Tauri native drop. Với lỗi chỉ xuất hiện trong app desktop, phải chạy `run_dev.bat` và thao tác thật; nếu chưa chạy được thì ghi rõ là chưa xác minh runtime.

## Mức bằng chứng khi báo kết quả

- **Mức 1 — tĩnh:** code review, lint/typecheck đạt.
- **Mức 2 — tự động:** unit/integration/regression test đúng ca đạt.
- **Mức 3 — runtime:** chạy lại chính chuỗi thao tác của user trên ứng dụng thật đạt.
- Không dùng “đã OK hoàn toàn” cho lỗi runtime khi mới có Mức 1–2. Báo đúng mức đã đạt và bước còn thiếu.
