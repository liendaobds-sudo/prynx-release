# Lô lint P2.63 — 2026-08-23

## Phạm vi

Loại 18 lỗi `no-explicit-any` tại boundary phát lại Recipe và thêm regression
cho dữ liệu backend hỏng, trong đúng 2 file:

- `recipeRunners.ts`: parse response qua `unknown` + record guard, dùng contract
  `ProcessingSettings`, params Optimize/Bế tem cục bộ và cầu nối `BlobPart` giữ
  nguyên `Uint8Array` view.
- `recipeRunners.test.ts`: khóa ba trường hợp fail-closed: upload thiếu ID,
  preflight thiếu `output_filename`, và detect trả `shapeParams` sai contract.

Giữ nguyên endpoint, tên field JSON/FormData, fallback nghiệp vụ, thứ tự runner,
bytes working PDF, output path và semantics Recipe legacy. Diff LO18 trong runner
và phần dọn type test LO61 được giữ nguyên.

## Chốt contract

- Upload phải trả ID chuỗi trước khi gọi endpoint kế tiếp.
- Preflight chỉ hoàn tất sau khi có tên artifact để tải và commit.
- `/imposition/detect-shape` thành công phải trả `shapes: string[]` và
  `shapeParams: object[]` cùng số phần tử. Guard khớp route/backend property test;
  nhánh lỗi backend có `success: false` và dừng trước engine bình.
- `Uint8Array` được đưa nguyên view vào `File`, không dùng `.buffer` nên không
  kéo theo bytes ngoài `byteOffset`/`byteLength`.

## Verify

- ESLint hẹp 2 file: 0 lỗi, 0 cảnh báo.
- `npm run typecheck`: đạt.
- Test đích `recipeRunners`: 34/34 đạt.
- Toàn bộ `src/lib/recipe`: 12 file, 119/119 test đạt.
- Smoke `Uint8Array` subview → `File`: giữ đúng bytes `1,2,3`.
- `git diff --check`: đạt.
- `npm run lint:budget`: 826 → 808 errors; warnings giữ 103; gate đạt.
- Review độc lập: không có finding P0–P2 hoặc valid-path drift.

## Rủi ro còn lại

- Chưa chạy Tauri/sidecar thật. Guard upload được test qua helper dùng chung ở
  prepress; ba consumer sticker/mirror/dieline chưa có test thiếu ID riêng.
- Persisted recipe params vẫn được tin tại boundary `ProcessingSettings`; lô này
  không thêm validation nghiệp vụ để tránh làm hỏng Recipe legacy.

## Kết luận

Lô contract/boundary hoàn tất ở mức kiểm thử tự động. Chưa commit, push hoặc
build release.
