# Lô lint P2.21 — 2026-08-23

## Phạm vi

Hoàn thiện dependency contract của preview Watermark:

- desktop/src/components/preprocess-tools/WatermarkTool.tsx — thêm action setWatermarkPreview vào dependency array của effect đồng bộ preview.

Action Zustand ổn định nên không đổi hành vi; warning ref cleanup Output Preview được giữ riêng vì cần kiểm chứng thứ tự generation.

## Verify

- ESLint hẹp: sạch.
- npm run typecheck: đạt.
- npm run lint:budget: errors 1.335 → 1.335, warnings 105 → 104; budget gate đạt.
- Không build release, không commit, không push.

## Kết luận

Dependency graph của effect Watermark đầy đủ, không dùng suppression.
