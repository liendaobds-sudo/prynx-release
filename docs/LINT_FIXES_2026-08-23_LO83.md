# Lint fixes 2026-08-23 — Lô 83

## Phạm vi

- `desktop/src/lib/toolRegistry.ts`
- Mục tiêu: loại hai lỗi `@typescript-eslint/no-explicit-any` trong registry, không đổi lựa chọn component, routing, capability hoặc từ khóa tìm kiếm.

## Thay đổi

- Thêm `ToolRuntimeProps` cho các props shell thực tế truyền vào lazy component: tab/active, dirty/title, file/recovery, batch/combine callbacks và điều hướng.
- Thêm `ToolLaunchPayload` và `ToolBatchOutput` cho payload mở công cụ, giữ các trường focus/locked, file, recovery, Office và Combine; vẫn mở rộng được bằng `unknown` cho payload phát sinh.
- Khai báo rõ hint legacy initialFeature mà Combine có thể gửi, không thay đổi cách shell định tuyến.
- Dùng các contract này thay cho `ComponentType<any>` và `defaultPayload?: any`.

## Kết quả

- Giảm 2 lỗi lint: `675 -> 673`.
- Cảnh báo toàn kho giữ nguyên: `103`.

## Xác nhận

- `npx eslint src/lib/toolRegistry.ts`: đạt.
- `npm run typecheck`: đạt.
- `npx vitest run src/lib/toolRegistry.routing.test.ts src/lib/toolRegistry.search.test.ts src/lib/license/features.test.ts src/hooks/useToolActivationGuard.test.ts`: 36/36 test đạt.
- `git diff --check -- desktop/src/lib/toolRegistry.ts`: đạt.
- `npm run lint:budget`: đạt (`673 errors`, `103 warnings`).

## Bất biến đã giữ

- Không đổi registry entry, component lazy import, key routing `focusFeature/lockedMode`, capability/Pro gate hoặc bảng từ khóa song ngữ.
- Không đổi backend, Tauri, PDFium, worker pool hoặc payload runtime đã gửi từ App.
- Không build release, commit hoặc push trong lô này.
