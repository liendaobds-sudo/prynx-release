# PrynX — Hướng dẫn cho AI agent (Claude Code / Codex / Cursor…)

PrynX là phần mềm desktop chế bản – bình bản – khuôn bế cho nhà in Việt Nam.
Stack: **Tauri v2 + React 19 + TypeScript** (`desktop/`) ⇄ **FastAPI sidecar** Python 3.11 (`backend/`, chạy `127.0.0.1:8321`, đóng gói bằng Nuitka khi release) ⇄ **Rust**: `native/` (pdfcompare_native, PyO3 + PDFium), `imposition_core/`, `print_engine/`, `desktop/src-tauri/`.

## Bộ skill của dự án

Kiến thức chi tiết được tách thành các skill trong `.agents/skills/` (bản sao cho Claude Code: `.claude/skills/`). **Trước khi làm việc thuộc nhóm nào, đọc SKILL.md tương ứng** — chúng chứa các bất biến và bài học đã trả giá, làm sai sẽ gây hồi quy:

| Việc đang làm | Skill |
|---|---|
| Tìm hiểu code, sửa bug, thêm tính năng bất kỳ | `prynx-architecture` |
| Sửa bug hoặc làm tính năng nhỏ–vừa theo vòng lặp có bằng chứng | `prynx-task-loop` |
| Khuôn bế bao bì 2D/3D + xếp khuôn vào tờ (`desktop/src/lib/dieline`, `mockup3d`) | `prynx-dieline` |
| Bình tem bế / nup / VDP / backend nặng | `prynx-imposition` |
| Tối ưu hiệu năng, thêm cap/limit/worker pool | `prynx-performance` |
| Review diff/PR, audit bảo mật, threat model hoặc re-audit bản vá | `prynx-security-review` |
| Chạy test, verify trước khi báo xong | `prynx-testing` |
| run_dev, build production, đóng gói phát hành | `prynx-build-release` |
| Viết code mới, đặt tên, comment, text UI | `prynx-conventions` |
| Ghi file từ phiên Claude cloud (Cowork remote) | `prynx-safe-write-cowork` |
| Audit toàn dự án rồi sửa theo lô | `prynx-audit-workflow` |
| Thêm loại hộp/khuôn bế mới | `prynx-add-boxtype` |

Codex: skill tự nạp theo description, hoặc gọi tường minh `$prynx-dieline`. Claude Code: tự nạp, hoặc `/security-review`, `/audit`, `/add-boxtype`, `/verify` (xem `.claude/commands/`).

## Quy tắc bất di bất dịch

1. **Máy yếu mới điều chỉnh — máy mạnh chạy hết công suất.** Mọi cap/limit (worker, RAM, chất lượng) phải gate theo RAM máy: `<8GB` và `<16GB` mới được giảm; `≥16GB` giữ nguyên full. Không bao giờ hard-cap vô điều kiện (đã từng gây chậm 2× trên máy mạnh).
2. **Không đặt `[profile.release]` (LTO/codegen-units) vào Cargo.toml.** LTO chỉ bật qua biến môi trường `CARGO_PROFILE_RELEASE_*` trong `build_production.ps1` — để `maturin develop --release` trong vòng dev vẫn nhanh.
3. **PDFium không thread-safe.** Khóa thật là `PDFIUM_PY_LOCK` + context manager `pdfium_guard()` định nghĩa ở `backend/app/core/pdfium_lock.py` (module nhẹ, không kéo theo extension Rust) và re-export qua `backend/app/core/rust_bridge.py` — RLock, phạm vi MỘT process, bao cả `pdfcompare_native` lẫn `pypdfium2`. Mọi code mới chạm PDFium trong **thread** (`asyncio.to_thread`, `run_in_threadpool`, `ThreadPoolExecutor`) phải bọc `pdfium_guard()`; giữ vùng khóa ngắn (chỉ lời gọi PDFium, không bao encode ảnh/ghi đĩa/subprocess). Việc **nặng** thì đi `ProcessPoolExecutor`/`multiprocessing.Process` — mỗi process có PDFium riêng nên vẫn song song thật. Sửa `pdf_processor` thì sửa `rust_bridge` cùng lúc. Việc áp `pdfium_guard()` cho các module cũ đang làm theo lô (xem `docs/KIEN_TRUC_FIXES_2026-07-29.md`) — file nào chưa bọc thì bọc khi chạm tới.
4. **Comment và text UI bằng tiếng Việt**, thuật ngữ ngành in chuẩn (xem `prynx-conventions`). Mỗi chỗ sửa lớn gắn tag truy vết: `PERF (audit ...)`, `[AUTO-BOTTOM FIX ...]`, `UIUX (audit ...)`.
5. **vitest/tsc chỉ chạy trên Windows thật** — `node_modules` chứa binary Windows, không chạy được trong VM/CI Linux. Golden master snapshot chỉ `-u` khi thay đổi hình học là chủ đích và đã soi diff.
6. **Audit lớn theo quy trình 2 chốt**: báo cáo `docs/BAO_CAO_AUDIT_*.md` → chờ duyệt → sửa theo lô ≤5 file, mỗi lô verify xong mới sang lô kế.

## Lệnh thường dùng

```
run_dev.bat                          # vòng dev đầy đủ (venv, poppler, maturin, sidecar dieline, vite, backend)
cd desktop && npm run typecheck      # tsc --noEmit
cd desktop && npm run test           # vitest run (toàn bộ)
cd desktop && npx vitest run src/lib/dieline   # riêng khuôn bế
cd desktop && npm run build:dieline-sidecar    # bundle lại engine dieline cho sidecar
cd desktop && npm run lint && npm run lint:budget
backend: venv + pytest (backend/tests, có golden/)
powershell build_production.ps1      # đóng gói release (Nuitka + maturin + tauri)
```

## Tài liệu gốc trong repo

`audit-rules.md` (chuẩn đánh giá hình học khuôn bế), `docs/BAO_CAO_AUDIT_HIEU_NANG_*.md` + `docs/PERF_FIXES_*.md` (danh mục tối ưu đã audit), `docs/` nói chung. Đọc trước khi kết luận điều gì "là bug".
