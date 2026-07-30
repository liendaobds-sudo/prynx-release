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
- `api/routes/`: `compare.py`, `dieline.py`, `dieline_validation.py` (helper cho `dieline.py`, không phải router), `edit.py`, `export.py`, `imposition.py`, `pdf_tools.py`, `preflight.py`, `qc.py`, `results.py`, `system.py`, `upload.py`, `vdp.py`, `ws.py` + `workers/cut_export/api.py`. Router được đăng ký ở `main.py` — file nào không có `include_router` ở đó là **không chạy** (đã xoá `report.py` vì vậy, audit 2026-07-29 §C.2).
- `core/`: engine thật — `imposition_engine.py`, `comparison_engine.py`, `heavy_job_scheduler.py` (hàng đợi việc nặng, `max_active_heavy_jobs()` dùng để chia ngân sách RAM theo slot), `pdfium_lock.py` (`PDFIUM_PY_LOCK` / `pdfium_guard()` — khóa PDFium duy nhất, re-export qua `rust_bridge.py`), `gpu_accelerator.py`, `geometry_reader.py`, `icc_profiles.py`, `ink_manager.py`, `action_engine.py`…
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

## Bất biến điều hướng desktop

- `App.tsx` giữ mọi tab đã mở ở trạng thái mounted; tab nền chỉ bị ẩn bằng CSS. Effect/listener của tab nền vẫn sống nếu không tự kiểm tra `isActive` hoặc `tabId`.
- `payload.focusFeature`/`lockedMode` mô tả **ý định lúc tạo tab**, không phải công cụ runtime sau khi user đổi menu.
- `activeDashboardTool` trong store được scope theo tab mới là nguồn trạng thái công cụ đang hiển thị; shell cần đồng bộ theo `tabId` khi định tuyến file/lệnh.
- File kéo từ Windows Explorer đi qua `SystemIntegrations` và sự kiện Tauri native trước khi tới App; WebView có thể không phát `dataTransfer.files`/React `onDrop`.
- Vì vậy test DOM drop không thay thế test native drop, và sửa dropzone cục bộ không đủ nếu shell đã định tuyến file sang tab khác.
- Mọi event tài liệu toàn cục phải mang `tabId`/session id; listener phải từ chối tab nền và đích không tồn tại.
- Không dùng boolean toàn cục kiểu `__isUpscalerActive`: nhiều tab cùng mounted làm cờ sai chủ sở hữu và cleanup của tab này có thể ghi đè tab khác.
- Khi truy vết lỗi “đúng giao diện nhưng sai luồng”, đối chiếu đủ ba lớp: launch intent → runtime tool theo tab → tuyến sự kiện native/DOM.
