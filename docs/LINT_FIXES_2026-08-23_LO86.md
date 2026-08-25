# Lint fixes 2026-08-23 — Lô 86

## Phạm vi

- `desktop/src/components/preprocess-tools/VdpAlignPanel.tsx`
- Mục tiêu: loại hai lỗi `@typescript-eslint/no-explicit-any` ở contract VDP, giữ nguyên luồng căn chỉnh của Data Merge và Numbering.

## Thay đổi

- Dùng `VdpToolField` và `SetVdpFields` từ `useVdpTool` thay cho mảng/state setter `any` cục bộ.
- Narrow các tọa độ/kích thước optional bằng giá trị mặc định `0` khi tính bounding box, căn phải/giữa và phân bố; field hợp lệ có số liệu giữ nguyên kết quả cũ, field thiếu dữ liệu không còn tạo phép tính `NaN`.
- Một thay đổi bỏ `vdpFields` khỏi destructuring component đã có sẵn trong working tree trước lô LO86; lô này không tạo/hoàn tác thay đổi đó.

## Kết quả

- Giảm 2 lỗi lint: `667 -> 665`.
- Cảnh báo toàn kho giữ nguyên: `103`.

## Xác nhận

- npx vitest run src/components/preprocess-tools/VdpAlignPanel.test.tsx: 2/2 test đạt.
- `npx eslint src/components/preprocess-tools/VdpAlignPanel.tsx`: đạt.
- `npm run typecheck`: đạt.
- `git diff --check -- desktop/src/components/preprocess-tools/VdpAlignPanel.tsx`: đạt.
- `npm run lint:budget`: đạt (`665 errors`, `103 warnings`).

## Bất biến đã giữ

- Không đổi danh sách nút, mode căn chỉnh, đơn vị mm/CSS-mm, event hoặc state store.
- Không chạm backend/PDFium, không build release, commit hoặc push trong lô này.
