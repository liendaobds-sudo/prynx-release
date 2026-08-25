# Lô lint P2.60 — 2026-08-23

## Phạm vi

Loại 36 lỗi `no-explicit-any` và gỡ một `@ts-nocheck` khỏi 5 file thuộc store
bình bản:

- `workspaceSlice.ts`: khai báo contract cho thiết lập xác nhận booklet và
  profile theo công cụ; dùng truy cập state có kiểu mà không đổi key snapshot.
- `preprocSlice.ts`: nối store với contract thật của Shuffle, Co giãn trang,
  Tách trang và Dịch xén.
- `catalogSlice.ts`: dùng `OptimizationResult | null` cho kết quả tối ưu tờ.
- `types.ts`: bật lại TypeScript checking, dùng `PlanConfig`, các contract
  preprocess và shape params dạng record.
- `persist.ts`: nhận dữ liệu migration qua `unknown`, guard JSON object, giữ
  nguyên thứ tự migration v1→v11 và tập key được partialize.

Không đổi giá trị mặc định, key localStorage, payload, công thức bình bản, đơn
vị, nhánh migration hay hành vi chuyển profile công cụ.

## Verify

- ESLint hẹp 5 file: 0 lỗi, 0 cảnh báo.
- `npm run typecheck`: đạt.
- Characterization store/persist: 1 file, 20/20 test đạt.
- `git diff --check`: đạt; chỉ còn cảnh báo chuẩn hóa LF/CRLF ở ba file cũ.
- `npm run lint:budget`: 944 → 908 errors; warnings giữ 103; gate đạt.
- Review độc lập không phát hiện hồi quy semantics trong phạm vi lô.

## Proof gap còn lại

- `PARTIALIZE_KEYS` vẫn khai báo `readonly string[]`, nên TypeScript chưa bắt
  được typo key; snapshot/characterization test đang là chốt hành vi.
- Một số producer thượng nguồn còn `@ts-nocheck`/`any`, nên contract mới của
  `PlanConfig` và shape params chưa được kiểm xuyên suốt. Đây là nợ cũ, không
  mở rộng LO64 quá giới hạn 5 file.

## Kết luận

Lô contract/type-only hoàn tất ở mức kiểm thử tự động. Chưa chạy runtime GUI,
chưa commit, push hoặc build release.
