# Design Document — Mẹc Số ⇄ Mẹc Bìa

## Overview

Một **engine sinh số dùng chung** (pure TS, không phụ thuộc UI/PDF) + hai chế độ áp dụng
(Ruột / Bìa) + lớp đầu vào (2-tab-link hoặc 1-file-assign). Render tái dùng **VDP engine**
backend đã verify (`run_vdp_engine`): mỗi vị trí = 1 record dữ liệu, engine thay `{token}`.

Mục tiêu "ăn ý": bìa và ruột đọc **CÙNG một Numbering Job** → dải bìa `{Y..Z}` luôn khớp số
ruột thật, không nhập tay hai lần. Nguyên tắc: **engine thuần + test trước** (verify mọi tổ hợp).

## Architecture

```
NumberingJob (config dùng chung)
      │  deriveJob() → validate + perBooklet
      ├── generateInnerAssignments(job, clusterCount)  → số cho từng cụm RUỘT
      └── generateCoverData(job)                       → {X,Y,Z} cho từng cuốn BÌA
              │
              ├─ sortFieldsGeometrically (đã có) → thứ tự cụm theo vị trí (Z/N/U/C)
              └─ VDP render (đã verify) → PDF (1 record = 1 trang)
```

Lớp đầu vào (chung engine):
- **PA1 (2 tab):** `useNumberingJobStore` xuyên-tab; tab Ruột & tab Bìa cùng bind `jobId`.
- **PA2 (1 file):** gán role theo range trang (coverPages/innerPages); gợi ý theo khổ (xác nhận).

## Components and Interfaces

- `coverNumberingEngine.ts` (mới, pure TS):
  - `deriveJob(job): JobDerived` — validate + tính `perBooklet`.
  - `generateCoverData(job): CoverRow[]` — `{X,Y,Z}` mỗi cuốn theo `innerMode`.
  - `distributionIndex(pos, sheet, sheets, perSheet, mode): number` — stack/sequential (dùng chung).
  - `generateInnerAssignments(job, clusterCount): InnerAssign[]` — số cho từng cụm.
- `vdpUtils.sortFieldsGeometrically(fields, method)` — TÁI DÙNG (rows/cols/ushape/clockwise).
- `run_vdp_engine` (backend) — TÁI DÙNG render; tokens `{X}/{Y}/{Z}` (bìa), `{N}` (ruột).
- UI: tool "Mẹc Số & Bìa" tái dùng shell `NumberingTool` (tabs [Ruột]|[Bìa] + panel Job).

## Data Models

```ts
type SortMethod = 'rows' | 'cols' | 'snake' | 'clockwise';   // Z / N / U / C
type Distribution = 'stack' | 'sequential';                  // cắt chồng / tuần tự
type InnerMode = 'continuous' | 'reset';

interface NumberingJob {
  startNum: number; endNum: number; padding: number;
  prefix?: string; suffix?: string;
  bookletCount: number; bookletOffset: number;
  innerMode: InnerMode; distribution: Distribution; sortMethod: SortMethod;
}
interface JobDerived {
  totalNumbers: number; perBooklet: number; valid: boolean;
  error?: 'bad_range' | 'not_divisible' | 'too_large';
  suggestion?: number;            // bookletCount hợp lệ gần nhất
}
interface CoverRow { X: string; Y: string; Z: string; bookletIndex: number; }
interface InnerAssign { clusterPos: number; sheet: number; value: string; }
```

Bảng mapping JSX → app:

| JSX (mẹc bìa) | App |
|---|---|
| `rows`(Z) / `cols`(N) / `snake`(U) / `reverse-c`(C) | `rows` / `cols` / `snake` / `clockwise` |
| `bookletIndex = itemIndex*totalSheets + sheetIndex` | `distribution='stack'` |
| (mới) | `distribution='sequential'` |
| `{%X%}/{%Y%}/{%Z%}` | tokens `{X}/{Y}/{Z}` |
| `paddingLength = startStr.length` | `padding` |

## Correctness Properties

### Property 1: Đồng bộ ruột ↔ bìa
Với mọi cuốn i, dải số ruột thực tế == `[Y(i) .. Z(i)]` của bìa cuốn i.
**Validates: Requirements 6.1**

### Property 2: Chia cuốn đúng
`continuous` → `Y(i) = startNum + i*perBooklet`, `Z(i) = Y(i)+perBooklet-1`, và `Z(i)+1 = Y(i+1)`. `reset` → `Y/Z` hằng cho mọi cuốn, chỉ `X` đổi.
**Validates: Requirements 3.2, 3.3**

### Property 3: Cắt chồng (stack)
`stack` → chồng các tờ in rồi cắt theo vị trí ⇒ mỗi chồng con là dải liên tiếp.
**Validates: Requirements 2.4, 6.4**

### Property 4: Đồng nhất thứ tự
Ruột & bìa cùng `sortMethod` + `distribution` ⇒ vị trí khớp nhau.
**Validates: Requirements 4.2, 3.4**

### Property 5: Padding
Mọi số được đệm 0 đúng `padding`.
**Validates: Requirements 2.6**

## Error Handling

- `bad_range` (`start>end` hoặc `bookletCount<=0`) → từ chối sinh, báo lỗi rõ.
- `not_divisible` (`totalNumbers % bookletCount != 0`) → lỗi + `suggestion` (ước số gần nhất).
- `too_large` (`totalNumbers > CAP`) → dừng có kiểm soát (không treo) — tái dùng guard chạy số.
- PA1 hai tab lệch tham số → cảnh báo trước khi sinh.
- Field/record lỗi khi render → cô lập (VDP engine đã vẽ nhãn lỗi, không sập job).

## Testing Strategy

- Engine thuần: vitest phủ **16 tổ hợp** `innerMode{2} × distribution{2} × sortMethod{4}`.
- Ca biên: not_divisible(+suggestion), bad_range, too_large, bookletCount<=0, padding, prefix/suffix.
- Bất biến P1 (đồng bộ ruột↔bìa) + P3 (mô phỏng chồng-cắt) test riêng.
- Render: smoke end-to-end (raster) 1 ca bìa + 1 ca ruột.
