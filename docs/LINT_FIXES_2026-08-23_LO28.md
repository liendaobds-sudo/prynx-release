# Lô lint P2.24 — 2026-08-23

## Phạm vi

Dọn block rỗng trong 4 miền UI/viewer:

- desktop/src/components/imposition-tools/ImposerDashboard.tsx — bỏ nhánh else không có hành động sau metadata backend.
- desktop/src/components/imposition-tools/sections/AdvancedSettingsSection.tsx — ghi rõ fallback khi preset localStorage hỏng.
- desktop/src/components/workspace/LivePageFrame.tsx — ghi rõ bỏ qua DataTransfer/JSON VDP không hợp lệ.
- desktop/src/hooks/viewer/usePdfLoader.ts — ghi rõ bỏ qua lỗi plate metadata/kích thước trang tùy chọn.

Không thay đổi fallback nghiệp vụ hoặc luồng request.

## Verify

- Rule no-empty hẹp: sạch trong 4 file.
- Regression: 4 test files viewer/dashboard, 61/61 đạt.
- npm run typecheck: đạt.
- npm run lint:budget: errors 1.333 → 1.324, warnings 103 → 103; budget gate đạt.
- Không build release, không commit, không push.

## Kết luận

Các catch/nhánh bỏ qua lỗi đều có lý do rõ ràng, không còn block rỗng gây mơ hồ khi audit.
