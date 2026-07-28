---
name: prynx-architecture
description: "Bản đồ kiến trúc và luồng dữ liệu của PrynX — dùng NGAY khi bắt đầu tìm hiểu code, sửa bug, thêm tính năng, hoặc cần biết một chức năng nằm ở file/thư mục nào. Use when exploring the codebase, locating features, tracing data flow, onboarding, project structure, architecture map, 'code này nằm ở đâu'."
---

# Kiến trúc PrynX

## Tổng thể

```
desktop (Tauri v2 + React 19 + TS, vite)
   │  HTTP/WS → 127.0.0.1:8321
   ▼
backend (FastAPI + uvicorn, Python 3.11 — release đóng gói Nuitka thành sidecar)
   │  PyO3
   ▼
native (Rust: pdfcompare_native — PDFium, imposition, dieline engine, NFP solver)
+ imposition_core/ + print_engine/ (crate Rust riêng) + desktop/src-tauri/ (shell Tauri)
```

Frontend gọi backend qua `desktop/src/lib/**/api.ts`; backend route mỏng, engine nặng nằm ở `backend/app/core/`; phần cực nặng (render PDF, so sánh ảnh, NFP) đẩy xuống Rust qua `rust_bridge`.

## Bản đồ thư mục

**Backend** (`backend/app/`):
- `api/routes/`: `compare.py`, `dieline.py`, `dieline_validation.py`, `edit.py`, `export.py`, `imposition.py`, `pdf_tools.py`, `preflight.py`, `qc.py`, `report.py`, `results.py`, `system.py`, `upload.py`, `vdp.py`, `ws.py`.
- `core/`: engine thật — `imposition_engine.py`, `comparison_engine.py`, `heavy_job_scheduler.py` (hàng đợi việc nặng), `rust_bridge.py` (+ `PDFIUM_PY_LOCK`), `gpu_accelerator.py`, `geometry_reader.py`, `icc_profiles.py`, `ink_manager.py`, `action_engine.py`…
- `workers/`, `models/`, `schemas/`, `utils/`; test: `backend/tests/` (pytest, có `golden/`).

**Desktop** (`desktop/src/`):
- `components/` (UI), `store/` + `stores/` (state), `hooks/`, `engine/` (barcode…), `workers/`, `i18n/`, `styles/`.
- `lib/dieline/`: engine khuôn bế 2D bằng TS — generator từng loại hộp (`AutoBottomBox.ts`, `PizzaBox.ts`, `GableBox.ts`, `PaperBag.ts`, `Envelope.ts`, `CupSleeve.ts`, `MatchboxSleeve/Tray.ts`, `ReverseTuckEnd.ts`, `SnapLockBottom.ts`), `engine.ts` (`dispatchGenerator`), `constants.ts`, `geometryHelpers.ts`, `bleedContours.ts`, `contourValidator.ts`, export PDF/nesting. Bundle riêng cho sidecar qua `npm run build:dieline-sidecar`.
- `lib/mockup3d/`: dựng 3D + gấp hộp — `foldCompensation.ts`, `gussetFold.ts`, `panelSolid.ts`, `foldLive.ts`, `explodedView.ts`, `materialLibrary.ts`.

**Rust**: `native/src/`: `dieline_engine.rs`, `dieline_request.rs`, `nfp_solver.rs`, `image_compare.rs`, `imposition/`, `layers.rs`. Build dev bằng `maturin develop --release` (run_dev.bat tự làm).

**Gốc repo**: `run_dev.bat` (vòng dev), `build_production.ps1` (release), `PRYNX.bat`, `PHAT_HANH.bat`/`release_update.ps1` (phát hành), `audit-rules.md` (chuẩn hình học), `docs/` (báo cáo audit), `poppler/` (PATH cho backend).

## Luồng dữ liệu điển hình

1. **Bình tem bế**: UI form → `api.ts` → `routes/imposition.py` → `heavy_job_scheduler` (threadpool, giới hạn slot) → `imposition_engine` → `rust_bridge` (PDFium, khóa `PDFIUM_PY_LOCK`) → kết quả/preview → WS cập nhật tiến độ.
2. **Khuôn bế**: UI tham số hộp → `lib/dieline/engine.ts` sinh `DielineModel` (chạy ngay trong frontend/webview) → canvas 2D + `mockup3d` gấp 3D → export PDF; backend `routes/dieline*.py` phục vụ validate/nesting; `native/dieline_engine.rs` có bản Rust — parity test ở `nativeFixtureParity.test.ts`.

## Khi bắt đầu một việc

Xác định việc thuộc tầng nào (UI / backend route / core engine / Rust) rồi đọc skill chuyên sâu tương ứng (`prynx-dieline`, `prynx-imposition`, `prynx-performance`…). Sửa xuyên tầng (ví dụ đổi schema API) thì phải sửa đủ cả `api.ts` phía desktop lẫn `schemas/` + route phía backend trong cùng một lần — hai đầu này không có codegen chung, lệch là lỗi runtime im lặng.
