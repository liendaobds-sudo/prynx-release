# Implementation Plan — Mẹc Số ⇄ Mẹc Bìa

## Overview

TDD: engine thuần + test TRƯỚC (verify mọi tổ hợp), UI sau. Render tái dùng VDP (đã verify).
Trục dễ sai nhất = thứ tự đánh số theo vị trí + chế độ chạy → phải có test đầy đủ.

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1"], "description": "Engine sinh số dùng chung + test (không phụ thuộc)" },
    { "wave": 2, "tasks": ["2", "3"], "description": "Sort vị trí & render VDP — phụ thuộc 1" },
    { "wave": 3, "tasks": ["4"], "description": "UI tool — phụ thuộc 1,2,3" },
    { "wave": 4, "tasks": ["5"], "description": "Đầu vào PA1/PA2 — phụ thuộc 4" },
    { "wave": 5, "tasks": ["6"], "description": "Hoàn thiện — phụ thuộc 1–5" }
  ]
}
```

## Tasks

- [x] 1. Engine sinh số dùng chung (pure TS) + test
  - [x] 1.1 `coverNumberingEngine.ts`: types + `deriveJob(job)` (validate bad_range/not_divisible/too_large + suggestion + perBooklet).
  - [x] 1.2 `generateCoverData(job)` → `{X,Y,Z}[]` theo innerMode + padding + prefix/suffix.
  - [x] 1.3 `distributionIndex(...)` stack/sequential (dùng chung ruột & bìa).
  - [x] 1.4 `generateInnerAssignments(job, clusterCount)` → số cho từng cụm. (qua `assignBooklets` + `innerRange`)
  - [x] 1.5 Test vitest — phủ 16 tổ hợp + ca biên + bất biến P1/P3. (32 test pass)
  - _Requirements: 1, 2, 3, 6_

- [x] 2. Tích hợp sort vị trí
  - [x] 2.1 Nối `vdpUtils.sortFieldsGeometrically` làm bước sort cụm trước khi gán index. (`coverNumberingPlanner.ts`)
  - [x] 2.2 Test: 4 sortMethod → thứ tự gán khớp (Z/N/U/C). (lưới 2×2, dự đoán khớp output thật)
  - _Requirements: 4_

- [x] 3. Render qua VDP (tái dùng)
  - [x] 3.1 Map cover `{X,Y,Z}` + inner `{N}` → field tokens. (`buildCoverRecords` — 1 tờ = 1 record, token `${id}.X/.Y/.Z`)
  - [x] 3.2 Smoke end-to-end (raster): 2 cụm/6 token DUY NHẤT trên 1 tờ → 6 giá trị riêng (0001/0100/0101/0200), KHÔNG sập token, KHÔNG rò `{cov_}`. [VERIFIED qua run_vdp_engine + trích text pypdfium2]
  - _Requirements: 3.5, 2_

- [x] 4. UI — tool "Mẹc Số & Bìa" (tái dùng NumberingTool shell)
  - [x] 4.1 Đăng ký tool (toolRegistry `cover_numbering`), mount ImpositionTab + AcrobatViewer isVdpMode.
  - [x] 4.2 Panel Job + banner validation/gợi ý (deriveJob → validationMsg).
  - [x] 4.3 Kéo cụm field {X}/{Y}/{Z} + group/ungroup + preview live (clusters useMemo).
  - [x] 4.4 Guard input (min, chống treo) — MAX_NUMBERS cap, min trên input số.
  - _Requirements: 2, 3, 4_

- [x] 5. Đầu vào (PA1 + PA2)
  - [x] 5.1 PA1: `useNumberingJobStore` (persist) xuyên-tab + cờ "linked". Bìa đọc/ghi job dùng chung; Mẹc Số công bố dải [startNum,endNum,padding] khi linked → hai tab luôn khớp. Helper `jobMismatch` + test.
  - [x] 5.2 PA2: 1 file → gán dải trang bìa (`resolveCoverPageIndices` + test). Trích trang bìa bằng pdf-lib làm template trước khi render (vì VDP áp mọi field cho từng trang template). KHÔNG auto-detect — người dùng nhập dải trang. [VERIFIED end-to-end: file 3 trang RUOT/COVER/RUOT → trích trang 2 → output chỉ có COVERMARK + giá trị bìa, ruột KHÔNG rò]
  - _Requirements: 5_

- [x] 6. Hoàn thiện
  - [x] 6.1 typecheck xanh + vitest 268 pass; cleanup harness smoke.
  - [x] 6.2 Spec cập nhật (Task 1–6 đánh dấu xong).

## Notes

- Render & sort & guard: TÁI DÙNG (VDP engine, sortFieldsGeometrically, guard chạy số).
- Phần làm mới chính: `coverNumberingEngine.ts` + UI tab Bìa + lớp liên kết Job.
- CAP số phần tử (vd 1_000_000) để chống treo — đồng bộ ngưỡng với NumberingTool.
