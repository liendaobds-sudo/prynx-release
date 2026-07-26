# Kế hoạch: Engine thay thế Ghostscript (riêng cho PrynX)

**Mã tài liệu:** `PRYNX-GS-REPL-ENGINE`  
**Phiên bản:** 2.0
**Ngày:** 2026-07-26
**Phạm vi:** Desktop PrynX (Tauri + Python FastAPI sidecar + Rust native)  
**Mục tiêu:** Giảm / loại phụ thuộc Ghostscript (AGPL bundle) bằng **engine prepress nội bộ**, clean-room, không fork source GS.

> Đây là kế hoạch kỹ thuật sản phẩm. Không phải tư vấn pháp lý.  
> Không copy code Ghostscript (AGPL). Tham chiếu: ISO 32000, ICC, hành vi black-box (so output), lib permissive.

---

## 0. Tóm tắt điều hành

| | |
|---|---|
| **Vấn đề** | GS free AGPL khi **bundle** trong installer closed-source → rủi ro license; commercial Artifex tốn phí; user tự cài GS → UX xấu. |
| **Hướng** | Viết **PrynX Print Engine (PPE)** — mini-RIP/PDF prepress **đúng use-case PrynX**, không clone full GS. |
| **Ngôn ngữ** | **Rust** (lõi) + **Python** (API/orchestration) + **TS** (UI). |
| **Thời gian ước lượng** | 12–24 tháng tới mức “gỡ bundle GS” an toàn; 3–6 tháng có MVP separations/soft-proof/TAC. |
| **Song song** | Ship vẫn dùng GS (bundle hoặc commercial) cho đến khi PPE đạt gate chất lượng. |
| **Trạng thái 2026-07-26** | Đã có RGB sidecar cho DeviceRGB trực tiếp: facade chạy 129/129, 105/129 đủ tin cậy cho TAC (81,4%); 24 trang còn fail-loud; **chưa đạt gate unbundle**. |

---

## 1. Mục tiêu / Không làm

### 1.1 Mục tiêu (Goals)

1. **Separations** process CMYK (+ spot cơ bản) đủ tin xưởng tem/offset nhẹ.  
2. **Soft-proof** ICC (FOGRA39 + sRGB) đủ “xem trước in”, không bắt buộc ngang Acrobat.  
3. **TAC / ink limit** đo trên raster DeviceCMYK (ink-accurate), không false-clean.  
4. Thay dần **action list** đang `engine: ghostscript` (Convert CMYK, Flatten, Outline, Embed, Downscale, Black overprint).  
5. **PDF/X export** (X-1a / X-4 subset thực tế PrynX).  
6. **Không bundle GS** khi PPE cover ≥ ngưỡng job khách (metric §8).  
7. License stack: Rust crates + pdfium + LCMS2 + pikepdf — **permissive/MPL**, NOTICE ẩn OK.  

### 1.2 Không làm (Non-goals) — Phase 1–3

- Full PostScript Level 3 interpreter.  
- Ngang bit-exact Ghostscript / Adobe RIP.  
- Mọi blend mode / transparency ISO đầy đủ ngay từ đầu.  
- Thay pikepdf (vẫn là WRITE path cấu trúc PDF).  
- Fork / port source C của Ghostscript.  

### 1.3 Nguyên tắc thiết kế

| # | Nguyên tắc |
|---|---|
| P1 | **Clean-room:** spec ISO + golden vs GS output; không đọc/port code AGPL. |
| P2 | **Capability matrix:** mỗi feature có `engine=ppe|gs|fallback` + badge UI. |
| P3 | **Golden suite:** mọi path PPE so với GS trên bộ PDF xưởng (ΔE / plate MAE). |
| P4 | **Fail loud:** không im lặng “sạch TAC” khi engine không chạy. |
| P5 | **pikepdf WRITE, PPE/pdfium READ-raster** (bám invariant hiện tại). |

---

## 2. Bản đồ phụ thuộc GS hiện tại (PrynX)

### 2.1 Module backend

| Module / khu vực | Vai trò GS | Mức độ thay thế |
|---|---|---|
| `app/core/separations.py` | `tiffsep` plates + ICC | **P0** PPE |
| `app/core/softproof.py` | Render soft-proof ICC | **P0** PPE |
| `app/core/preflight_rules/ink.py` | TAC qua separations ink_accurate | **P0** PPE |
| `app/core/pdfx_export.py` | Xuất PDF/X | **P2** |
| `app/core/action_engine.py` | CONVERT_TO_CMYK, FLATTEN, OUTLINE, EMBED, DOWNSCALE, SET_BLACK_OVERPRINT | **P1–P2** |
| `app/core/ink_manager.py` | Spot → CMYK | **P2** |
| `app/core/layer_engine.py` | Một số convert/render GS | **P2** |
| `app/core/viewer_preview.py` | Preview path GS | **P1** |
| `app/api/routes/preflight.py` | Separations/soft-proof/convert API | Wire PPE |
| `app/api/routes/pdf_tools.py` | GS tools | **P1–P2** |
| `app/workers/pdf_tools_engine.py` | Downsample GS (skip nếu thiếu) | **P1** |
| `app/workers/sticker_engine.py` | Render RGB fallback GS | **P1** |
| `app/api/routes/imposition.py` | raster fallback `use_ghostscript=True` | **P1** |
| `app/config.py` | `_find_ghostscript()` | Giữ đến sunset |
| `build_production.ps1` | Copy `binaries/gs` | Gỡ khi PPE gate pass |

### 2.2 Action registry (`engine: ghostscript`)

| Action ID | UI | Ưu tiên PPE |
|---|---|---|
| `CONVERT_TO_CMYK` | Chuyển CMYK + ICC | P1 |
| `FLATTEN_TRANSPARENCY` | Flatten trong suốt | P2 (khó) |
| `OUTLINE_FONTS` | Khóa font | P2 |
| `EMBED_FONTS` | Nhúng font | P1 (có thể pikepdf-first) |
| `DOWNSCALE_IMAGES` | Giảm DPI ảnh | P1 (pikepdf/Pillow) |
| `SET_BLACK_OVERPRINT` | Overprint đen | P2 |

**Không qua GS (giữ nguyên):** `FIX_METADATA`, `FIX_HAIRLINES`, `REMOVE_CHANNELS` (channel_remover/pikepdf).

### 2.3 Feature **không** phụ thuộc GS (không đụng trong plan này)

Imposition N-up/S&R/booklet/page-sheet, sticker die/cut, edit object (pikepdf), compare PDF, OCR (Tesseract), dieline/mockup 3D, VDP/numbering (phần lớn).

---

## 3. Kiến trúc mục tiêu: PrynX Print Engine (PPE)

### 3.1 Sơ đồ

```
┌─────────────────────────────────────────────────────────────┐
│  Desktop (React)  SoftProof / Separations / Preflight / PDFX │
└────────────────────────────┬────────────────────────────────┘
                             │ HTTP / sidecar
┌────────────────────────────▼────────────────────────────────┐
│  Python FastAPI                                              │
│  separations.py | softproof.py | ink.py | pdfx | action_*    │
│  PrintEngineClient → prefer PPE, fallback GS if enabled      │
└────────────────────────────┬────────────────────────────────┘
                             │ PyO3 / FFI
┌────────────────────────────▼────────────────────────────────┐
│  Rust crate: prynx_print_engine (trong native/ hoặc crate mới)│
│  ┌──────────────┐ ┌─────────────┐ ┌──────────────┐          │
│  │ PDF open     │ │ Rasterizer  │ │ Color (LCMS) │          │
│  │ (pdfium /    │ │ CMYK buffer │ │ soft-proof   │          │
│  │  partial)    │ │ + plates    │ │ FOGRA↔sRGB   │          │
│  └──────────────┘ └─────────────┘ └──────────────┘          │
│  ┌──────────────┐ ┌─────────────┐                            │
│  │ TAC map      │ │ Export hooks│ (sau: pdfwrite subset)     │
│  └──────────────┘ └─────────────┘                            │
└─────────────────────────────────────────────────────────────┘
         ▲ read-only raster              pikepdf = WRITE PDF
```

### 3.2 Ranh giới trách nhiệm

| Thành phần | Việc |
|---|---|
| **PPE (Rust)** | Raster, plates, soft-proof pixels, TAC matrix, (sau) flatten/convert pipeline |
| **pikepdf** | Mọi ghi PDF cấu trúc, remove channels, metadata, hairlines, edit objects |
| **pdfium** | Render hỗ trợ / geometry read (đã có) |
| **GS** | Fallback đến khi PPE đạt gate; optional dev `PRYNX_FORCE_GS=1` |

### 3.3 API nội bộ (Python facade)

```python
# app/core/print_engine/facade.py  (mới)

class PrintEngineFacade:
    def separations(self, pdf, page, dpi, *, ink_accurate: bool, profile_id: str | None) -> SepResult: ...
    def softproof(self, pdf, page, dpi, intent, sim_paper, sim_ink) -> SoftproofResult: ...
    def tac_map(self, pdf, page, dpi, threshold) -> TacResult: ...
    def convert_to_cmyk(self, pdf_in, pdf_out, icc) -> None: ...  # Phase 1+
    def capabilities(self) -> CapabilityMatrix: ...
```

`SeparationEngine` / `SoftProofEngine` / `_check_tac` gọi facade; **không** gọi `gswin64c` trực tiếp sau Phase 0 refactor.

### 3.4 Vị trí code đề xuất

```
native/src/print_engine/          # hoặc crate prynx_print_engine/
  mod.rs
  raster.rs
  separations.rs
  softproof.rs
  tac.rs
  cmyk_buffer.rs
  error.rs
backend/app/core/print_engine/
  facade.py
  capabilities.py
  gs_fallback.py                  # chỉ còn bridge GS
backend/tests/print_engine/
  golden/                         # PDF + expected metrics
  test_sep_vs_gs.py
  test_tac_vs_gs.py
docs/PRYNX_GS_REPLACEMENT_ENGINE_PLAN.md  # tài liệu này
```

### 3.5 Ngôn ngữ & crate gợi ý

| Tầng | Công nghệ | License hướng |
|---|---|---|
| Lõi | **Rust** 2021+ | MIT/Apache crates |
| Bind Python | PyO3 (như `pdfcompare_native`) | |
| ICC | `lcms2` sys / `moxcms` (đánh giá) | MIT |
| Ảnh buffer | `image`, ndarray-style | |
| ~~PDF raster bootstrap~~ | ~~pdfium-render~~ → **SAI, đã bỏ** (xem §16.1) | |
| PDF object/xref/stream | `lopdf` | MIT |
| Coverage rasterizer | `tiny-skia` (chỉ sinh mặt nạ, không trộn màu) | BSD-3 |
| Glyph outline (Phase text) | `ttf-parser` | MIT |
| Write PDF | **Không** trong PPE phase đầu — pikepdf | MPL |

**Cấm:** nhúng source Ghostscript, MuPDF AGPL free nếu ship closed mà không commercial.

---

## 4. Ma trận capability (runtime)

Mỗi response API prepress kèm:

```json
{
  "engine": "ppe" | "ghostscript" | "pdfium_approx",
  "accuracy": "rip_like" | "approximate" | "ink_device",
  "quality_note": "..."
}
```

UI (đã có hướng SoftProof/Separations badges): hiển thị engine + cảnh báo khi approximate.

Config:

| Env / setting | Ý nghĩa |
|---|---|
| `PRYNX_PRINT_ENGINE=auto\|ppe\|gs` | Mặc định `auto` |
| `PRYNX_ALLOW_GS_FALLBACK=1` | Cho phép fallback (dev/ship chuyển tiếp) |
| `PRYNX_FORCE_GS=1` | Golden so sánh / debug |
| `GHOSTSCRIPT_PATH` | Giữ đến sunset |

---

## 5. Lộ trình theo phase

### Phase 0 — Tách lớp & đo baseline (2–4 tuần)

**Mục tiêu:** Không thay thuật toán; chuẩn bị thay thế an toàn.

| # | Việc | Done khi |
|---|---|---|
| 0.1 | Inventory đầy đủ mọi `GHOSTSCRIPT_PATH` / `_run_gs` / `tiffsep` (bảng §2) | Checklist + test “grep clean” sau facade |
| 0.2 | Tạo `PrintEngineFacade` bọc toàn bộ call GS hiện tại | 1 điểm vào/ra |
| 0.3 | Bộ **golden PDF** xưởng: 30–50 file (DeviceCMYK đơn, RGB, spot, transparency, font, image) | Thư mục `tests/print_engine/golden/pdfs` |
| 0.4 | Script so sánh: GS separations mean/max plate, TAC max%, soft-proof ΔE vs reference | CI optional job |
| 0.5 | Ghi baseline metrics (JSON) | `baseline_gs_*.json` |

**Deliverable:** Facade + baseline; hành vi user **không đổi**.

---

### Phase 1 — MVP raster CMYK + Separations + TAC + Soft-proof (3–6 tháng)

**Mục tiêu:** Path **xem / đo** không cần GS cho PDF “xưởng tem” điển hình.

#### 1.A Device CMYK ink-accurate separations

| Việc | Chi tiết |
|---|---|
| Buffer | `width × height × 4` u8 (C,M,Y,K), 0–255 = 0–100% mực |
| Nguồn | Ưu tiên: render/tách từ content DeviceCMYK; hạn chế RGB→CMYK giả |
| Output | Cùng contract `plates[]` + `alpha_data` zlib+b64 như `separations.py` |
| Spot | Phase 1: detect tên spot (pikepdf scan); plate spot = optional / stub warning |
| So GS | MAE plate < ngưỡng (vd mean abs diff < 15/255 trên vùng solid) với `ink_accurate`/UseFastColor-equivalent |

#### 1.B Soft-proof

| Việc | Chi tiết |
|---|---|
| Pipeline | CMYK buffer → LCMS (FOGRA39 → sRGB) → PNG |
| Intent | perceptual / relative (subset) |
| UI | `engine=ppe`, accuracy note |
| So | ΔE mean vs GS soft-proof trên solid patches < ngưỡng (vd 3–5) |

#### 1.C TAC

| Việc | Chi tiết |
|---|---|
| Công thức | Giữ `compute_tac_percent` hiện tại trên plate PPE |
| Rule | Wire `_check_tac` → facade `ink_accurate=True` **không** qua GS |
| Golden | `17_tac_heavy_cmyk.pdf` must `TAC_EXCEEDED` @ 300 |

#### 1.D Integration

| File | Việc |
|---|---|
| `separations.py` | `extract_separations` → PPE first |
| `softproof.py` | PPE first |
| `preflight_rules/ink.py` | TAC → PPE |
| Tests | `test_icc_and_color_preview.py`, preflight golden TAC |

**Gate Phase 1 (ra “PPE preview”):**

- [ ] ≥ 80% golden sep/TAC/softproof pass ngưỡng  
- [ ] Không GS: Separations + Soft-proof + TAC preflight **chạy được** trên 20 PDF khách tem  
- [ ] UI badge đúng engine  
- [ ] Fallback GS vẫn bật mặc định nếu PPE fail  

**Chưa gỡ** bundle GS khỏi installer.

---

### Phase 2 — Actions thay GS (write path) (4–8 tháng, song song/ nối P1)

**Mục tiêu:** Bớt action `engine: ghostscript`.

| Ưu tiên | Action | Hướng implement | Khó |
|---|---|---|---|
| P1 | `DOWNSCALE_IMAGES` | pikepdf duyệt XObject image + Pillow resample | Thấp |
| P1 | `EMBED_FONTS` | pikepdf / fontTools subset nhúng | Trung |
| P1 | `CONVERT_TO_CMYK` | Raster PPE + tái dựng page (đơn giản) **hoặc** object-level convert từng colorspace | Cao |
| P2 | `SET_BLACK_OVERPRINT` | pikepdf content stream / ExtGState | Trung |
| P2 | `OUTLINE_FONTS` | Text → path (harfbuzz + viết path PDF) | Cao |
| P2 | `FLATTEN_TRANSPARENCY` | Raster cả page PPE + image XObject (mất vector) **MVP**; vector flatten sau | Rất cao |
| P2 | Spot→CMYK | Map alternate CMYK (pikepdf) + fallback raster | Trung |

**Nguyên tắc write:**  
- Ưu tiên **vector/object** (pikepdf) khi an toàn.  
- Flatten/convert nặng: **rasterize page** chấp nhận mất editability (cảnh báo UI).

**Gate Phase 2:**

- [ ] 4/6 action GS có path non-GS trên PDF đơn giản  
- [ ] Action log ghi `engine=ppe|pikepdf|gs`  
- [ ] Test regression action_engine  

---

### Phase 3 — PDF/X + sunset GS bundle (4–8 tháng)

| Việc | Chi tiết |
|---|---|
| PDF/X-4 / X-1a subset | Output intent, metadata, (convert) dựa PPE + pikepdf; so compliance checks hiện có |
| `pdfx_export.py` | Bỏ hard-require GS khi PPE path pass |
| Sticker/imposition GS render | Chuyển 100% pdfium/PPE |
| `build_production.ps1` | **Không** copy `gs\`; không abort thiếu GS |
| Config | `PRYNX_ALLOW_GS_FALLBACK=0` default release |
| Docs khách | “Không cần cài Ghostscript” |

**Gate Phase 3 (gỡ bundle):**

- [ ] Metric §8 đạt  
- [ ] 0 call GS trên smoke suite release  
- [ ] QA `run_release_qa` + manual prepress checklist  
- [ ] Legal: NOTICE không liệt kê Ghostscript như bundled component  

---

### Phase 4 — Nâng chất lượng (liên tục)

- Transparency / blend / soft mask  
- Spot / DeviceN đầy đủ  
- Overprint simulation  
- Performance: tile, GPU optional  
- Parallel page  
- So sánh ΔE với bản in thực (khách)  

---

## 6. Chiến lược kiểm thử

### 6.1 Tầng test

| Tầng | Nội dung |
|---|---|
| Unit Rust | Buffer CMYK, TAC math, ICC roundtrip solid colors |
| Unit Python | Facade routing, capability, fallback |
| Golden vs GS | Cùng PDF, so plate/TAC/softproof (dev machine có GS) |
| Golden no-GS | CI/release: PPE only, fixture cố định |
| Property | TAC monotone, threshold bounds (đã có hướng test_tac_*) |
| Manual xưởng | 10 job thật / phase |

### 6.2 Ngưỡng gợi ý (điều chỉnh sau baseline Phase 0)

| Metric | MVP | Production soft |
|---|---|---|
| Solid DeviceCMYK plate MAE vs GS ink_accurate | < 20/255 | < 10/255 |
| TAC max% abs error vs GS | < 15 điểm % | < 8 |
| Soft-proof ΔE mean (patches) | < 5 | < 3 |
| Crash rate suite | 0 | 0 |

### 6.3 Bộ fixture tối thiểu

1. Solid C/M/Y/K/100% patches  
2. `17_tac_heavy_cmyk` style  
3. RGB photo page  
4. Spot Pantone + process  
5. Text + embedded font  
6. Transparency / shadow (Phase 2+)  
7. Multi-page mixed  

---

## 7. Lịch & nguồn lực (ước lượng)

| Phase | Thời gian (1 dev full-time prepress+Rust) | 2 dev |
|---|---|---|
| 0 Facade + baseline | 2–4 tuần | 1–2 tuần |
| 1 Sep + softproof + TAC | 3–6 tháng | 2–4 tháng |
| 2 Actions | 4–8 tháng | 3–5 tháng |
| 3 PDF/X + unbundle GS | 4–8 tháng | 3–5 tháng |
| **Tổng tới unbundle** | **~12–24 tháng** | **~8–14 tháng** |

**Kỹ năng cần:** Rust/PyO3, PDF internals, ICC/LCMS, prepress domain, golden testing.

**Không** ước “3 tháng thay full GS” trừ khi cắt non-goal và chấp nhận approximate vĩnh viễn.

---

## 8. Metric “đủ để gỡ GS”

Gỡ bundle khi **tất cả** đúng (hoặc exception list có chủ đích):

1. ≥ **95%** job prepress trong log 30 ngày khách chạy **không** cần GS fallback.  
2. Separations + Soft-proof + TAC: PPE default, badge không “approximate” trên DeviceCMYK.  
3. PDF/X: ≥ 1 standard PrynX ship (vd X-4) pass compliance suite nội bộ.  
4. Actions P1 (Convert CMYK, Downscale, Embed) non-GS.  
5. Flatten/Outline: hoặc PPE raster path có warning, hoặc vẫn optional GS **không bundle** (user cài) — quyết định sản phẩm.  
6. `build_production` không copy GS; release QA green.  

---

## 9. Rủi ro & giảm thiểu

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Tin cậy màu sai → hỏng in | Cao | Golden vs GS; badge; fallback dài |
| Scope creep full RIP | Cao | Non-goals; phase gates |
| Nhiễm AGPL (đọc code GS) | Cao | Clean-room policy; không port |
| Chậm / OOM file lớn | Trung | Tile, DPI cap, chunk |
| Đội chỉ 1 người | Cao | Ship GS song song; Phase 1 only trước |
| MPL pikepdf | Thấp | Không modify source pikepdf |

---

## 10. Việc làm ngay (30 ngày đầu) — checklist

```
[ ] 1. Duyệt & freeze bảng §2 (mọi call GS)
[ ] 2. Tạo print_engine/facade.py bọc separations + softproof + tac
[ ] 3. Thu 20–50 PDF golden từ xưởng / fixture
[ ] 4. Script baseline: chạy GS ghi metrics JSON
[ ] 5. Scaffold Rust module prynx_print_engine + PyO3 hello
[ ] 6. Quyết định song song: giữ bundle GS (hoặc Artifex) đến Phase 3
[ ] 7. Không gỡ GS khỏi build_production cho đến Gate §8
```

---

## 11. Quan hệ với license / ship hiện tại

| Giai đoạn | Bundle GS? | Ghi chú |
|---|---|---|
| Phase 0–2 | **Có** (AGPL rủi ro hoặc Artifex) | PPE phát triển song song |
| Phase 3+ | **Không** | Khách zero cài thêm *nếu* PPE đủ |
| Mua Artifex | Tùy chọn | Giảm áp lực thời gian PPE; không thay thế plan dài hạn nếu muốn độc lập |

---

## 12. Định nghĩa xong (Definition of Done toàn chương trình)

- [ ] Không còn `gswin64c` trong installer PrynX  
- [ ] Không còn hard-fail “cần Ghostscript” trên path ship  
- [ ] Separations / Soft-proof / TAC / PDF/X (subset) / actions P1 chạy PPE hoặc pikepdf  
- [ ] THIRD_PARTY_NOTICES không liệt GS bundled  
- [ ] Tài liệu nội bộ + training: engine badge, hạn chế transparency  

---

## 13. Phụ lục A — Thứ tự thay file (gợi ý PR)

1. `print_engine/facade.py` + wire softproof/separations/tac  
2. Rust `separations` + tests golden  
3. Rust `softproof` + LCMS  
4. Switch default `auto` PPE-first  
5. Actions DOWNSCALE / EMBED non-GS  
6. CONVERT_TO_CMYK PPE/pikepdf  
7. PDF/X  
8. Remove GS from `build_production.ps1`  
9. Delete dead GS paths / document optional external GS  

---

## 14. Phụ lục B — Thuật ngữ

| Thuật ngữ | Nghĩa trong plan |
|---|---|
| PPE | PrynX Print Engine (Rust+Python facade) |
| ink_accurate | Đo mực DeviceCMYK, không soft-proof FOGRA nén TAC |
| approximate | RGB→pseudo-CMYK (pdfium path cũ) |
| Gate | Điều kiện ra phase / unbundle |
| Clean-room | Implement từ spec + so output, không copy GS |

---

## 16. Trạng thái thực thi

### 16.1 Sửa giả định kiến trúc sai của bản 1.0

Bản 1.0 (§3.1, §3.5) định dùng **pdfium làm nền raster** cho separations. Điều đó
không khả thi và nếu làm theo sẽ mất công vô ích:

* pdfium chỉ xuất bitmap **BGRA / BGR / Gray**. Không có đầu ra DeviceCMYK.
* pdfium quy `Separation` / `DeviceN` về alternate space **ngay khi vẽ** ⇒ không
  còn kênh spot để tách kẽm.
* Overprint và TAC không biểu diễn được sau khi màu đã bị nén về RGB.

Nói cách khác: bọc pdfium chỉ tái tạo lại đúng đường `approximate` mà
`separations.py` đã có. Nó không thay được `tiffsep`.

**Quyết định thay thế:** PPE **tự parse content stream và tự rasterize trong
không gian mực n kênh**. `tiny-skia` chỉ được dùng ở một vai trò hẹp — trả lời
"pixel này bị hình che bao nhiêu phần trăm" — còn việc phần trăm đó thành mực gì,
chồng hay khoét kênh nào là của `print_engine::ink`. Nhờ ranh giới đó, engine
không bị kéo về mô hình màu RGB của thư viện raster.

Hệ quả tích cực: overprint, spot, `/None`, `/All`, OPM=0 vs OPM=1 trở thành **mô
hình gốc** chứ không phải mô phỏng.

### 16.2 Đã build (Milestone A)

Crate `print_engine/` (rlib, không PyO3, mirror pattern `imposition_core/`), nối
vào `native/` qua `native/src/print_engine_py.rs`. Build chain **không đổi**:
`maturin develop --release --manifest-path native/Cargo.toml`.

| Hạng mục | Trạng thái |
|---|---|
| Ink space n kênh, trộn mực, knockout / overprint / OPM 0-1 | ✅ |
| TAC theo điểm, xuất kẽm `u8` (255 = 100% mực) | ✅ |
| Colorspace: Gray / RGB / CMYK / CalGray / CalRGB / Lab / ICCBased / Indexed / Separation / DeviceN | ✅ |
| Spot giữ kênh riêng; `Separation /Cyan` → kênh process; `/None` không vẽ; `/All` mọi kênh | ✅ |
| PDF Function kiểu 0 / 2 / 3 / 4 (PostScript calculator) | ✅ |
| Đường dẫn: `m l c v y h re`, nonzero / even-odd, clip `W W*` | ✅ |
| Nét: bề rộng theo toạ độ người dùng, hairline, dash, cap / join / miter | ✅ |
| `q Q cm gs`, ExtGState (`ca CA op OP OPM LW ML BM SMask`) | ✅ |
| Form XObject: `/Matrix`, `/BBox` clip, resources kế thừa, chống lồng vô hạn | ✅ |
| `/Rotate`, CropBox lệch gốc, kế thừa thuộc tính qua `/Parent` | ✅ |
| Ảnh nội tuyến `BI…EI`: bóc trước khi tokenize (chống mất nửa trang) | ✅ bóc + báo |
| Text, ảnh XObject, shading, transparency group, soft mask, ICC | ⬜ khai báo `degraded` |

### 16.2b Đã build (Milestone B — ảnh XObject)

| Hạng mục | Trạng thái |
|---|---|
| Chuỗi filter tự làm: Flate / LZW / ASCII85 / ASCIIHex / RunLength | ✅ |
| Predictor PNG (5 loại filter) + TIFF | ✅ |
| `/EarlyChange` của LZW | ✅ |
| BitsPerComponent 1 / 2 / 4 / 8 / 16, hàng bắt đầu ở ranh giới byte | ✅ |
| `/Decode`, `Indexed` (chỉ số ≠ cường độ), Lab, `DeviceN` trong ảnh | ✅ |
| `/ImageMask` stencil tô bằng màu hiện hành | ✅ |
| `/SMask` alpha, lấy mẫu lại khi lệch kích thước | ✅ |
| JPEG qua `jpeg-decoder`, kèm **CMYK/YCCK Adobe APP14 đảo dấu** | ✅ |
| Ảnh tôn trọng clip, overprint, alpha hằng | ✅ |
| JPXDecode / CCITTFaxDecode / JBIG2Decode | ⬜ báo lỗi rõ, không vẽ bừa |

Ba quyết định đáng ghi lại:

1. **PPE tự giải nén, không dùng `lopdf::Stream::decompressed_content`.** lopdf không
   áp predictor. Hầu hết ảnh nén Flate có `/Predictor 15`, nghĩa là sau khi inflate
   dữ liệu vẫn là **hiệu số theo hàng**. Bỏ bước đó thì ảnh ra nhiễu sọc mà vẫn
   "giải nén thành công" — không có lỗi nào nổi lên.
2. **Duyệt theo pixel thiết bị, nghịch đảo CTM để tìm pixel ảnh**, không "vẽ ảnh lên
   trang". Chi phí tỉ lệ với kích thước **hiển thị** chứ không phải kích thước ảnh
   (ảnh in 600 DPI trên khung 100 DPI), và xoay/nghiêng được xử lý miễn phí.
3. **Lấy mẫu nearest neighbour, cố ý cả ở chế độ xem trước.** Lấy trung bình vùng khi
   thu nhỏ sẽ **giảm** đỉnh mực ⇒ TAC bị báo thiếu, đúng chiều sai nguy hiểm mà cả
   engine đang tránh.

`14_progressive_jpeg.pdf` không vẽ được, và đã truy tới cùng: ASCII85 của PPE **đúng**
(có test đối chiếu trên chính dữ liệu đó), nhưng stream chỉ dài **37 byte** — fixture
là stub, không phải JPEG 256×256 thật. Lỗi ở fixture, không ở engine.

Ngăn "sai mà im lặng": mọi thứ chưa vẽ được đều tăng `dropped_objects` /
`unsupported_transparency` và bật cờ `degraded`. Lớp Python phải hạ `accuracy`
theo cờ này, không được kết luận "đạt ngưỡng mực".

#### 16.2c Đã build (Milestone C — quản lý màu ICC)

Little CMS qua crate `lcms2` (MIT). Chọn Little CMS chứ không phải CMM khác vì
Ghostscript cũng dùng nó: dùng chung engine màu khiến phép so golden nói lên chất
lượng của PPE thay vì nói lên khác biệt giữa hai CMM.

| Hạng mục | Trạng thái |
|---|---|
| `DeviceRGB` → CMYK qua ICC, profile nguồn chỉ định được | ✅ |
| `Lab` → CMYK qua ICC (điểm trắng D50) | ✅ |
| `ICCBased` 3 kênh dùng **đúng profile nhúng trong file** | ✅ |
| `ICCBased` 1 kênh qua ICC (file đã khai muốn quản lý màu) | ✅ |
| Rendering intent 0–3, bù điểm đen bật/tắt được | ✅ |
| Soft-proof CMYK → sRGB theo lô | ✅ (chưa wire API) |
| LUT 33³ + nội suy 3 tuyến tính, cache theo nội dung profile | ✅ |

**Bất biến trung tâm của milestone này:** *quy đổi thứ chưa phải mực; không bao giờ
quy đổi thứ đã là mực.*

* `DeviceCMYK` **không bao giờ** đi qua ICC. Giá trị CMYK trong file chính là lượng
  mực; round-trip qua một cặp profile nén vùng đặc từ 400% xuống ~292%, và một file
  vượt giới hạn mực sẽ được báo là đạt.
* `DeviceGray` giữ ánh xạ K thuần, không qua ICC. Nó là không gian **thiết bị**; đưa
  qua ICC thì đen thành rich black 4 màu và chữ nhỏ lệch bản khi in.
* Spot/DeviceN giữ kênh riêng, tint là lượng mực, không quy đổi.
* Chỉ `DeviceRGB` / `Lab` / `ICCBased` mới qua ICC — và khi đó `accuracy` **không**
  còn bị hạ, vì con số đã có cơ sở.

Có test khoá từng điều trên (`tests/render_icc.rs`), gồm một test kiểm `DeviceCMYK`
cho kết quả **giống từng byte** khi bật và tắt ICC.

### 16.2d Bộ fixture golden riêng cho prepress

`scripts/gen_golden_fixtures.py` sinh 20 file vào `print_engine/golden/fixtures/`.
Mỗi file cố ý chỉ chứa **một** biến số và phủ kín trang, nên hiệu số đo được chỉ có
một nguyên nhân duy nhất: `rgb_black`, `rgb_red`, `rgb_mid_gray`, `cmyk_solid_400`,
`cmyk_k_only`, `gray_black`, `spot_solid`, `overprint_black_on_cyan`,
`knockout_black_on_cyan`, và bản ảnh 1×1 tương ứng của bốn màu để so chéo đường ảnh
với đường vector.

Bộ fixture preflight có sẵn trộn ảnh với văn bản, nên khi lệch thì **không biết lệch
ở đâu**. Chính bộ fixture một-biến này mới tìm ra được hai lỗi ở §16.3.

### 16.2e Đã build (Milestone D — chữ)

| Hạng mục | Trạng thái |
|---|---|
| TrueType/OpenType qua `ttf-parser` | ✅ |
| **CFF thô** (`FontFile3 /Type1C`) và **Type1** (`FontFile`) qua `hayro-font` | ✅ |
| Type0 / CID: Identity-H/V, CMap nhúng (`cidrange`/`cidchar`/`codespacerange`), `CIDToGIDMap` | ✅ |
| Type3: glyph là content stream, `/FontMatrix`, resources riêng | ✅ |
| Bảng mã WinAnsi / MacRoman / Standard + `/Differences`, tên `uniXXXX` và `gNN` | ✅ |
| Bề rộng: `/Widths`, `/MissingWidth`, `/DW`+`/W`, và lấy từ `hmtx`/CFF khi thiếu | ✅ |
| `Tc Tw Tz TL Ts Tr Td TD Tm T* Tj TJ ' "` | ✅ |
| `Tr` 4–7: gom glyph thành clip, áp khi gặp `ET` | ✅ |
| Font không nhúng: thay thế **có khai báo**, hoặc không vẽ | ✅ |
| CMap CJK dựng sẵn (UniJIS-UCS2-H…) | ⬜ xấp xỉ identity 2 byte |

Ba chỗ dễ sai đã có test khoá:

1. **`Tr 3` và `Tr 7` không được lên mực.** File scan có OCR mang một lớp chữ vô hình
   phủ kín trang ở chế độ 3. Vẽ nó ra là đổ mực kín trang và mọi số đo mực thành rác.
2. **Ba đường định danh glyph khác nhau** — Type1/CFF tra theo *tên*, TrueType tra
   theo *Unicode* qua `cmap`, Type0 tra theo *CID*. Dùng sai đường cho ra glyph sai mà
   kết quả **vẫn trông như chữ**, nên rất dễ trôi qua mắt người kiểm.
3. **`Td` phải quay về đầu dòng, không cộng dồn vị trí hiện tại.** Sai chỗ này làm mỗi
   dòng dịch dồn theo dòng trước.

Chọn `hayro-font` (Apache-2.0 OR MIT) vì CFF thô và Type1 **không phải** file OpenType
nên bộ đọc TrueType không mở được, mà hai dạng đó rất phổ biến trong PDF — thiếu chúng
là mất phần lớn chữ của file thật.

### 16.2f Đã build (Milestone F — shading / gradient)

| Hạng mục | Trạng thái |
|---|---|
| Kiểu 2 (dọc trục) và kiểu 3 (theo bán kính), gồm `/Extend` và `/Domain` | ✅ |
| Kiểu 1 (theo hàm) — xấp xỉ theo trục x của `/Domain` | ✅ có ghi chú |
| `sh` tô theo **vùng clip**; shading pattern tô theo **đường dẫn** | ✅ |
| Shading pattern (`/PatternType 2`) cho cả tô và vẽ nét, `/Matrix` nối vào CTM trang | ✅ |
| `/BBox` của shading | ✅ |
| Kiểu 4–7 (lưới Gouraud / Coons / tensor) | ⬜ báo lỗi rõ, không vẽ xấp xỉ |
| Tiling pattern (`/PatternType 1`) | ⬜ báo lỗi rõ |

Vì sao shading đáng làm ngay sau chữ: gradient là chỗ **TAC dễ vượt ngưỡng nhất mà
mắt không thấy** — vùng tối của một dải chuyển sang rich black có thể lên 340% mực
trong khi phần còn lại của trang rất nhẹ. Bỏ shading không chỉ làm thiếu mực, nó làm
thiếu **đúng chỗ nguy hiểm nhất**. Trước milestone này mọi trang có gradient đều bật
`ink_unsound` và bị nhường hết cho Ghostscript.

Hai quyết định cài đặt:

1. **Lấy mẫu `t` thành bảng 256 ô rồi quy luôn sang mực.** Hàm màu của gradient
   thường là function kiểu 4 (chương trình PostScript); gọi nó cho từng pixel của một
   vùng A4 @300 DPI là hàng triệu lần chạy interpreter. Quy sang mực ngay lúc dựng
   bảng cũng là chỗ duy nhất `Separation`/`DeviceN` kịp đăng ký kênh spot **trước** khi
   vòng vẽ bắt đầu.
2. **Tên pattern chỉ có hiệu lực khi colorspace hiện hành đúng là `/Pattern`.** Tên
   cũ còn sót trong trạng thái sau khi `cs` đã đổi; dùng lại nó sẽ tô gradient lên
   hình đáng lẽ tô màu phẳng — có test khoá riêng cho việc này.

**Một bug thật do test bắt được:** ngữ nghĩa `OPM = 1` (thành phần bằng 0 không ghi
đè kênh tương ứng) chỉ được áp trong `make_paint`. Đường shading **và đường ảnh** dựng
`InkPaint` trực tiếp cho từng pixel nên bỏ mất, làm gradient/ảnh đen overprint khoét
trắng nền màu — đúng lỗi mà overprint sinh ra để tránh. Đã sửa cả hai đường và khoá
bằng test hồi quy ở mỗi đường.

### 16.2g Đã build (Milestone G — trong suốt: blend / group / soft mask)

| Hạng mục | Trạng thái |
|---|---|
| 12 blend mode **tách kênh** (`Normal`…`Exclusion`) — đúng tuyệt đối kể cả trên kẽm spot | ✅ |
| 4 blend mode **không tách kênh** (`Hue`/`Saturation`/`Color`/`Luminosity`) | ✅ xấp xỉ RGB, không chạm kênh spot, khai riêng |
| Transparency group — group đục `BM /Normal` (đường chính xác, không cần buffer phụ) | ✅ |
| Transparency group — không cách ly, alpha hằng / soft mask | ✅ chính xác |
| Transparency group — cách ly (`/I true`), có blend ở mức group | ✅ |
| Spot chỉ dùng bên trong group vẫn được cấp kẽm ở trang cha | ✅ |
| Soft mask `/S /Luminosity` (`/BC`, `/TR`, nền mặc định đen ngoài `/BBox`) | ✅ |
| Soft mask `/S /Alpha` | ✅ |
| Soft mask nằm trong graphics state, dựng theo CTM lúc `gs`, `q`/`Q` phục hồi đúng | ✅ |
| Knockout group (`/K true`) | ⬜ vẫn vẽ nhưng bật `ink_unsound` |

Vì sao đây là milestone đổi nhiều nhất về **tỉ lệ file dùng được**: trước nó, *bất kỳ*
`/BM` khác `Normal`, *bất kỳ* `/SMask`, và *bất kỳ* `/Group` đều bật
`unsupported_transparency` ⇒ nhường hết cho Ghostscript. Bóng đổ và blend là mặc định
của mọi file Illustrator/InDesign hiện đại, nên trên thực tế PPE gần như không bao giờ
được dùng cho file xưởng thật, dù đỉnh mực của nó đã đúng từ Milestone A.

Bốn quyết định cài đặt đáng ghi lại:

1. **Blend phải bù không gian trừ.** Công thức Table 134 của spec định nghĩa trên giá
   trị **cộng** (0 = tối). Ink space là **trừ** (0 = không mực). Bỏ bước bù làm
   `Multiply` hoá thành `Screen`: bóng đổ biến thành vệt sáng. `BlendMode::blend_ink`
   tự lo phần bù nên caller không có cơ hội quên, và có test chốt bằng **bất đẳng
   thức** (`Multiply` phải nhiều mực hơn `Screen`) chứ không chỉ bằng con số — một
   test bằng số vẫn xanh nếu cả hai công thức cùng sai.
2. **Group không cách ly chỉ cần một phép nội suy, và phép đó là chính xác.** Buffer
   con khởi tạo bằng **chính mực nền**, nên nó chứa `nền·(1−ga) + ga·màu_group`. Thay
   vào công thức composite của spec thì `ga` triệt tiêu, còn lại đúng
   `C = nền·(1−ca) + ca·con`. Nhờ đó overprint và blend của từng phần tử *bên trong*
   group nhìn thấy nền thật — điều mô hình cách ly (nền trắng) không làm được: một chữ
   đen overprint trong group cách ly sẽ mất hết nền màu.
3. **Alpha và soft mask của group KHÔNG được lọt vào trong group.** Spec §11.6.6: trạng
   thái khởi tạo của group thừa hưởng mọi thứ *trừ* alpha, blend và soft mask; ba thứ
   đó áp cho **cả group** ở bước composite. Để chúng lọt vào trong sẽ nhân hai lần tại
   mọi vùng phần tử chồng nhau — hai hình đặc chồng nhau với `ca = 0.5` cho 75% mực
   thay vì 50%. Fixture `group_alpha_overlap` khoá đúng con số đó.
4. **Soft mask luminosity có nền mặc định là ĐEN.** `/BC` mặc định là màu khởi tạo của
   colorspace group, tức đen, tức mặt nạ = 0 ⇒ ngoài `/BBox` **không in gì**. Cài sai
   chiều (nền trắng) làm mực tràn ra cả trang. Fixture `smask_luminosity_bbox_half`
   tồn tại chỉ để chốt việc này.

Soft mask được nhân vào **cùng đường với clip** (`Rasterizer::apply_clip`) thay vì áp ở
tầng mực, để không nhánh vẽ nào (tô, nét, glyph, pattern, ảnh, shading) có thể quên nó.
Một nhánh quên soft mask sẽ đổ mực đúng vào chỗ file muốn che.

### 16.2h Đã build (Milestone H — đóng nốt mọi khoảng trống còn lại)

| Hạng mục | Trạng thái |
|---|---|
| Optional content `/OC` — `/BaseState`, `/OFF`, `/ON`, OCMD (`/P` bốn chính sách), `/VE` | ✅ |
| `/OC` đọc theo cấu hình **in** (`/AS` + `/Usage /Print /PrintState`) | ✅ |
| `/OC` gắn trực tiếp trên XObject (§8.11.4.1) | ✅ |
| Ảnh nội tuyến `BI…ID…EI` — dựng lại thành image XObject tương đương | ✅ |
| Tiling pattern `/PatternType 1`, cả `/PaintType 1` và `2` (uncoloured) | ✅ trần 1024 ô |
| Shading lưới kiểu 4 (Gouraud tự do), 5 (lattice), 6 (Coons), 7 (tensor) | ✅ |
| `CCITTFaxDecode` — nhóm 3 (1D/2D) và nhóm 4, `/BlackIs1`, `/EncodedByteAlign` | ✅ |
| Soft-proof qua PPE — mực → sRGB, một lần quy đổi | ✅ |
| Knockout group, `JPXDecode`, `JBIG2Decode` | ⬜ khai riêng, nhường Ghostscript |

Sau milestone này PPE **không còn khoảng trống nào bật `ink_unsound` trên nội dung
thông dụng**. Ba thứ còn thiếu đều hiếm và đều được khai riêng từng cái.

Năm quyết định đáng ghi lại:

1. **`/OC` đọc cấu hình IN, không đọc cấu hình xem.** Đây là điểm khác biệt giữa một
   renderer xem-trước và một engine đo mực. Một lớp có thể **hiện trên màn hình** nhưng
   khai `/Usage /Print /PrintState /OFF`: watermark "BẢN NHÁP", đường bế hướng dẫn, ghi
   chú kỹ thuật đều dùng cách đó. Đếm mực của chúng là đo mực sẽ không bao giờ lên giấy.
   Ghostscript **không** làm việc này (nó đọc `/D` và bỏ qua `/AS`), nên đây là chỗ PPE
   cố ý khác GS — xem §16.3e.
2. **`/OC` chặn ở tầng *vẽ*, không ở tầng đọc operator.** Mọi thay đổi graphics state
   (`cm`, `gs`, clip, màu) trong khối tắt vẫn phải có hiệu lực, vì nội dung sau `EMC`
   kế thừa chúng. Bỏ qua cả operator sẽ làm phần còn lại của trang lệch chỗ.
3. **Ảnh nội tuyến được *dựng lại* thành image XObject** (đổi khoá viết tắt về tên đầy
   đủ) rồi đi đúng đường của ảnh thường. Nhờ vậy không có nhánh mã thứ hai cho ảnh nội
   tuyến, nên không có chỗ để hai đường lệch ngữ nghĩa overprint hay lấy mẫu. Độ dài
   dữ liệu được **tính trước** từ `/W`, `/H`, `/BPC`, `/CS` khi ảnh không nén, chỉ lùi
   về dò `EI` khi có filter — dò `EI` có thể cắt sớm nếu dữ liệu nhị phân chứa đúng hai
   byte đó giữa hai khoảng trắng.
4. **Bốn kiểu lưới quy về một dạng duy nhất: danh sách tam giác có màu ở ba đỉnh.**
   Kiểu 6 (Coons) được nâng lên tensor patch 4×4 bằng công thức nội suy điểm trong của
   spec, nên kiểu 6 và 7 dùng chung một đường vẽ. Màu ba đỉnh quy sang mực **một lần
   cho mỗi tam giác** rồi nội suy theo toạ độ trọng tâm — gọi ICC theo từng pixel sẽ
   làm một trang mesh mất hàng phút.
5. **CCITT tự viết, không thêm crate.** Toàn bộ lý do PPE tồn tại là gỡ một phụ thuộc
   có ràng buộc bản quyền; thêm một thư viện nữa vào đường đọc ảnh là thêm một dòng
   NOTICE và một giấy phép phải theo dõi. T.4/T.6 là chuẩn công khai và bộ giải mã là
   ~300 dòng.

**Một tối ưu bắt buộc, không phải tuỳ chọn.** Tiling pattern buộc phải thêm khái niệm
**vùng vẽ** (`geom::Region`): trước đó mỗi operator trộn mực trên *cả* buffer, nên chi
phí một trang tỉ lệ `số_operator × diện_tích_trang`. Với vector và chữ đó chỉ là chậm;
với một mẫu gạch chéo bước 4pt trên A4 (hơn 30 000 ô, mỗi ô vài operator) thì là bất
khả thi. Nay `Rasterizer` trả về hộp bao của nét vẽ và tầng mực chỉ trộn trong đó —
mọi đường vẽ của engine đều nhanh lên theo.

**Soft-proof là đường XEM, và nó đối nghịch với đường ĐO ở hai điểm**, cả hai đều có
chủ ý: khử răng cưa **bật** (xem) thay vì tắt (đo), và mực pha **quy về CMYK** (màn
hình không có mực pha) thay vì giữ kẽm riêng. Vì vậy nó là một hàm riêng
(`ppe_softproof` / `facade.softproof`), không phải một cờ của `ppe_separations`: gộp lại
thì sớm muộn sẽ có người kết luận lượng mực trên một ảnh đã làm mượt cạnh và đã mất kẽm
spot. Đổi lại, đường này đi qua **một** lần quy đổi màu thay vì ba như đường
`pdfium+lcms` (RGB → CMYK xấp xỉ → sRGB), nên overprint được mô hình đúng.

## 16.3 Kết quả golden vs Ghostscript

Bộ đo: `scripts/ppe_golden_compare.py` (GS chỉ là **công cụ tham chiếu ở máy
dev**, không đóng gói). Baseline: `print_engine/golden/baseline_gs_2026-07-25.json`.

Chạy trên `backend/tests/preflight_fixtures/pdfs`, 100 DPI, cùng cờ `ink_accurate`
(`-dUseFastColor=true -dGraphicsAlphaBits=1`, không ICC):

| Fixture | GS TAC | PPE TAC | Lệch | MAE (0..255) |
|---|---|---|---|---|
| `17_tac_heavy_cmyk.pdf` | 400.0 | **400.0** | 0.0 | **0.00** |
| `10_overprint.pdf` | 100.0 | **100.0** | 0.0 | **0.00** |

Sau Milestone B: **10 PASS · 0 FAIL · 4 "chưa đủ tính năng" · 4 "không so được
(thiếu ICC)"**.

Bốn file "không so được" đều là ảnh **DeviceRGB**. Con số minh bạch cho thấy vì sao
so sánh đó vô nghĩa: GS ở chế độ `-dUseFastColor=true` **không sinh đen** (RGB đen →
C+M+Y = 300%), PPE dùng UCR (RGB đen → K 100%). Cả hai đều là quy đổi tuỳ tiện
không ICC; không bên nào "đúng". Bộ đo vì thế phân loại riêng thay vì gộp vào "chưa
đủ tính năng" — gộp lại sẽ che mất việc pipeline hình học/lấy mẫu đã đúng và chỉ còn
thiếu quản lý màu.

**Đây là dữ liệu làm đổi thứ tự ưu tiên:** ICC phải làm **trước** text (xem §16.5).

### Sau Milestone C (ICC)

Bộ fixture một-biến, 72 DPI, cả hai bên cùng sRGB.icc → FOGRA39.icc, intent 1:

| Fixture | GS TAC | PPE TAC | Lệch | MAE |
|---|---|---|---|---|
| `rgb_black` | 327.1 | **326.6** | −0.5 | 0.46 |
| `rgb_red` | 172.5 | **172.1** | −0.5 | 0.79 |
| `rgb_mid_gray` | 145.5 | **145.8** | +0.3 | 0.61 |
| `rgb_dark_brown` | 279.2 | **278.6** | −0.7 | 1.08 |
| `cmyk_solid_400` | 400.0 | **400.0** | 0.0 | **0.00** |
| `overprint_black_on_cyan` | 200.0 | **200.0** | 0.0 | **0.00** |
| `knockout_black_on_cyan` | 100.0 | **100.0** | 0.0 | **0.00** |
| `spot_solid` | 100.0 | **100.0** | 0.0 | **0.00** |

**20/20 PASS.** Bộ preflight: 13 PASS, 0 FAIL, 4 chưa đủ tính năng (3 text + 1 fixture
stub), 1 đã sửa (xem dưới).

### Hai lỗi bộ fixture một-biến đã tìm ra

**1. Bộ đo thiếu `-sOutputICCProfile` — và đây cũng là lỗi trong sản phẩm.**

Ban đầu PPE lệch GS tới **30 điểm TAC** trên `rgb_black`, và điều đáng lo hơn: tổng
mực gần khớp nhưng **MAE tới 42/255**, nghĩa là hai bên chia mực giữa CMY và K rất
khác nhau — đúng thứ tách kẽm quan tâm. Loại trừ dần: bù điểm đen chỉ dịch vài điểm,
ép cùng profile RGB nguồn còn làm lệch **tăng**.

Nguyên nhân thật nằm ở kiến trúc màu của Ghostscript: **`-sDefaultCMYKProfile` là
profile *nguồn* để hiểu dữ liệu `DeviceCMYK` trong file, không phải profile để kết
xuất.** Đích là `-sOutputICCProfile`. Không đặt nó thì GS kết xuất ra profile CMYK
mặc định dựng sẵn của nó. Đặt đúng → lệch từ 30 điểm xuống **dưới 1 điểm**, MAE từ
42 xuống **dưới 1.1**.

> **GHI NHẬN — lỗi trong code sản phẩm, chưa sửa.**
> `backend/app/core/separations.py` đặt `-sDefaultCMYKProfile=FOGRA39 -dOverrideICC=true`
> nhưng **không** đặt `-sOutputICCProfile`. Nghĩa là "kẽm FOGRA39" mà app đang quảng
> cáo thực chất được kết xuất ra profile CMYK mặc định của Ghostscript, không phải
> FOGRA39. Cùng vấn đề cần kiểm ở `softproof.py` và đường Convert Colors trong
> `api/routes/preflight.py`. Đây là lỗi độc lập với PPE và tồn tại từ trước.

**2. Ảnh `Indexed` dưới 8 bit bị phá chỉ số bảng màu.**

Mẫu `Indexed` từng bị trải ra thang 0..255 như cường độ. Với ảnh 4 bit, chỉ số 1
thành 17 và trỏ sai ô bảng màu; chỉ số 0 và chỉ số lớn nhất vẫn đúng nên **MAE trung
bình vẫn đẹp (0.79)** và chỉ đỉnh TAC mới lộ (−10.5). Đã sửa (mẫu Indexed giữ nguyên
giá trị thô, `/Decode` dùng khoảng 0..2^bpc−1) và khoá bằng test hồi quy.

Cả hai lỗi này đều **không thể tìm ra** bằng bộ fixture trộn nhiều biến.

Ngưỡng của bộ đo cố tình **bất đối xứng** cho TAC, sửa mâu thuẫn ở §6.2 bản 1.0:

* báo **thiếu** mực ≤ 2 điểm (cứng) — báo thiếu khiến file quá ngưỡng bị coi là
  đạt, hỏng lô in;
* báo **thừa** mực ≤ 10 điểm — chỉ gây cảnh báo oan;
* MAE kẽm vùng solid < 3/255 (không phải 20/255: chế độ đo mực đã tắt AA nên vùng
  đặc phải gần khớp tuyệt đối, dung sai rộng sẽ che bug thật).

### 16.3b Sau Milestone D (chữ) — bộ đo chạy đúng cấu hình sản xuất

Bộ đo trước đây **không** truyền font thay thế, còn facade ở đường chạy thật thì có.
Nghĩa là nó đo một cấu hình khác cấu hình sản phẩm, và mọi trang chữ dùng font không
nhúng hiện ra là "chưa vẽ được" dù thực tế vẫn được vẽ. Đã sửa: `plate_stats` nhận
đối số font thay thế, `ppe_golden_compare.py` truyền đúng `DejaVuSans.ttf` mà facade
dùng (Ghostscript cũng thay font không nhúng bằng bộ URW của nó, nên không thay thì
phép so là so "có vẽ chữ" với "không vẽ chữ").

Kết quả trên bộ preflight, 100 DPI, color-managed:

| Fixture | GS TAC | PPE TAC | Lệch | MAE |
|---|---|---|---|---|
| `03_live_text` (chữ sống, Helvetica + ZapfDingbats) | 100.0 | **100.0** | 0.0 | 0.27 |
| `04_font_not_embedded` | 100.0 | **100.0** | 0.0 | 0.05 |
| `17_tac_heavy_cmyk` | 400.0 | **400.0** | 0.0 | **0.00** |

**17/18 PASS · 0 FAIL · 1 chưa đủ tính năng.** File còn lại là
`14_progressive_jpeg` — fixture stub 37 byte, không phải JPEG thật (§16.2b).

Bộ đo cũng phân biệt `PASS` với `PASS (font thay thế)`: đạt ngưỡng, nhưng nói rõ là
đạt với glyph không phải của file gốc nên con số diện tích phủ là xấp xỉ.

### 16.3c Sau Milestone F (shading)

Thêm 5 fixture gradient vào bộ một-biến (`shading_axial_k`, `shading_axial_k_extend`,
`shading_axial_rich`, `shading_radial_k`, `shading_pattern_half`):

| Fixture | GS TAC | PPE TAC | Lệch | MAE |
|---|---|---|---|---|
| `shading_axial_k` | 100.0 | **99.6** | −0.4 | 0.02 |
| `shading_axial_k_extend` | 100.0 | **100.0** | 0.0 | 0.01 |
| `shading_axial_rich` (gradient sang rich black) | 259.6 | **259.0** | −0.6 | 0.24 |
| `shading_radial_k` | 100.0 | **100.0** | 0.0 | 0.19 |
| `shading_pattern_half` | 49.8 | **49.8** | 0.0 | 0.12 |

**25/25 PASS** trên bộ một-biến.

### 16.3d Sau Milestone G (trong suốt) — và một cờ Ghostscript đã chết

Thêm 11 fixture vào bộ một-biến (3 blend, 1 alpha hằng, 4 group, 3 soft mask):

| Fixture | GS TAC | PPE TAC | Lệch | MAE |
|---|---|---|---|---|
| `blend_multiply_black_on_cyan` | 200.0 | **200.0** | 0.0 | **0.00** |
| `blend_screen_black_on_cyan` | 0.0 | **0.0** | 0.0 | **0.00** |
| `blend_darken_k40_k80` | 80.0 | **80.0** | 0.0 | 0.14 |
| `alpha_half_k` | 50.2 | **50.0** | −0.2 | 0.50 |
| `group_opaque_k` | 100.0 | **100.0** | 0.0 | **0.00** |
| `group_alpha_half_k` | 50.2 | **50.0** | −0.2 | 0.50 |
| `group_alpha_overlap` (hai hình chồng, `ca = 0.5`) | 50.2 | **50.0** | −0.2 | 0.50 |
| `group_isolated_alpha_half_k` | 50.2 | **50.0** | −0.2 | 0.50 |
| `smask_luminosity_half` | 49.8 | **50.0** | +0.2 | 0.50 |
| `smask_luminosity_bbox_half` | 100.0 | **100.0** | 0.0 | **0.00** |
| `smask_alpha_half` | 100.0 | **100.0** | 0.0 | **0.00** |

**36/36 PASS** ở chế độ quản lý màu (MAE lớn nhất trên toàn bộ: 0.94), **27/27 PASS** ở
chế độ đo mực (9 file RGB được phân loại "không so được, thiếu ICC" như trước).

#### Bug thật thứ hai của bộ đo — và cùng lỗi đó trong sản phẩm

Fixture `overprint_black_on_cyan` FAIL ngay khi thêm nhóm trong suốt: GS báo 100% TAC,
PPE báo 200%. Truy ra **hai** nguyên nhân, cả hai đều ở phía Ghostscript:

1. **`-dSimulateOverprint=true` đã bị Ghostscript 10.x loại bỏ.** GS không trả mã lỗi —
   nó in `**** -dSimulateOverprint={true|false} is no longer supported ****` ra stderr
   rồi chạy tiếp với mặc định. Bộ đo chỉ đọc stderr khi `returncode != 0`, nên cờ chết
   này im lặng suốt các milestone trước.
2. **`-dUseFastColor=true` TẮT overprint.** Đường fast color của GS bỏ qua toàn bộ logic
   overprint. Đo được: đen K-only overprint trên nền Cyan cho **100%** với fast color,
   **200%** khi tắt nó.

Cách vá giữ được cả hai yêu cầu (overprint có tính, mà `DeviceCMYK` vẫn không bị nén):
tắt fast color rồi đặt **cùng một** profile CMYK cho nguồn *và* đích, biến
`DeviceCMYK → DeviceCMYK` thành ánh xạ đồng nhất. Đã kiểm: solid vẫn 400.0, rich black
240.0, overprint 200.0.

**Cùng hai lỗi này tồn tại trong `separations.py` của sản phẩm** — nghĩa là mọi kẽm mà
app xuất ở chế độ `ink_accurate` bằng Ghostscript đều **mất overprint**, tức báo *thiếu*
mực. Đó đúng chiều sai nguy hiểm nhất: một file chồng mực 200% được báo là 100% và lọt
qua cổng TAC. Đã sửa cả hai chỗ, và thêm bước đọc stderr tìm `no longer supported` để
một cờ chết trong tương lai không thể im lặng đổi ý nghĩa của kẽm nữa.

Đây là lần thứ hai bộ đo golden phát hiện lỗi trong sản phẩm chứ không phải trong engine
mới (lần đầu: `-sOutputICCProfile`, §16.3). Cả hai lần đều cùng dạng: một cờ Ghostscript
bị hiểu sai, và không có gì kiểm chứng cho tới khi có engine thứ hai để đối chiếu.

### 16.3e Sau Milestone H — và chỗ PPE **cố ý** khác Ghostscript

Thêm 8 fixture (2 tiling, 3 optional content, 2 lưới, 1 CCITT):

| Fixture | GS TAC | PPE TAC | Lệch | MAE |
|---|---|---|---|---|
| `tiling_half_cell` (ô tô nửa) | 100.0 | **100.0** | 0.0 | 0.92 |
| `tiling_uncoloured_cyan` (`/PaintType 2`) | 100.0 | **100.0** | 0.0 | **0.00** |
| `mesh_type4_solid` (Gouraud tự do) | 100.0 | **100.0** | 0.0 | **0.00** |
| `mesh_type6_solid` (Coons patch) | 100.0 | **100.0** | 0.0 | **0.00** |
| `ccitt_group4` (ảnh scan G4 thật) | 100.0 | **100.0** | 0.0 | **0.00** |
| `oc_layer_off` (lớp tắt) | 0.0 | **0.0** | 0.0 | **0.00** |
| `oc_layer_on` (lớp bật) | 100.0 | **100.0** | 0.0 | **0.00** |
| `oc_print_state_off` | 100.0 | **0.0** | −100.0 | 255.0 |

**43/44 PASS · 0 FAIL · 1 khác GS có chủ ý** ở chế độ quản lý màu.

#### `oc_print_state_off`: lệch có chủ ý, và vì sao phải pin bằng số

Lớp trong fixture này *hiện* theo cấu hình xem nhưng khai `/Usage /Print /PrintState
/OFF` và được kích hoạt qua `/AS` với `/Event /Print`. Ghostscript đọc cấu hình mặc
định `/D` và **bỏ qua** `/AS`, nên nó vẫn in lớp đó (100% mực). Acrobat và các RIP
hiện đại thì không in. PPE theo phía RIP vì nó đo mực **sẽ lên giấy**.

Bộ đo không được để đây thành một FAIL vĩnh viễn — một FAIL không bao giờ xanh sẽ dạy
người ta bỏ qua cả bộ đo. Nhưng cũng không được miễn trừ theo tên, vì như vậy sẽ che
mọi hồi quy trên chính fixture đó. Nên `INTENTIONAL_DIVERGENCE` pin **con số lệch mong
đợi** (`−100.0 ± 1.0`): lệch đúng như dự kiến là PASS, lệch khác đi vẫn FAIL.

Engine cũng ghi vết `BDC /OC (lớp khai không in — /PrintState /OFF)` cho từng lớp thuộc
loại này, để báo cáo nói được vì sao nó không đếm phần mực đó. Đây **không** phải cờ
hạ tin cậy: file đã tự khai, engine chỉ tôn trọng khai báo.

#### Ảnh scan: fixture do encoder ngoài sinh

`ccitt_group4` được mã hoá bởi **libtiff** (qua Pillow), không bởi PPE. Đó là điểm mấu
chốt: nếu fixture do chính engine sinh thì một mã sai trong bảng T.4 vẫn khớp với chính
nó và test sẽ xanh trên dữ liệu sai. Bộ test đơn vị của `ccitt.rs` cũng có một blob G4
thật vì đúng lý do đó.

### 16.4 Kiểm thử

| Tầng | Số test | Lệnh |
|---|---|---|
| Unit Rust (mực, màu, ICC, function, hình học, raster, gstate, filter ảnh, font, blend, `/OC`, lưới, CCITT, memory budget) | 326 | `cargo test --manifest-path print_engine/Cargo.toml` |
| Tích hợp Rust — vector (dựng PDF thật → so kẽm) | 32 | cùng lệnh trên |
| Tích hợp Rust — ảnh (hướng, `/Decode`, palette, stencil, SMask, predictor) | 24 | cùng lệnh trên |
| Tích hợp Rust — ICC (bất biến "mực không qua ICC") | 12 | cùng lệnh trên |
| Tích hợp Rust — chữ (font thật, `Tr` 0–7, text clip, font thiếu) | 14 | cùng lệnh trên |
| Tích hợp Rust — shading (`sh`, pattern, `/Extend`, lưới bị báo lỗi) | 17 | cùng lệnh trên |
| Tích hợp Rust — trong suốt (blend, group, soft mask, `q`/`Q`) | 23 | cùng lệnh trên |
| **Tích hợp Rust — optional content (`/OC`, `/AS`, OCMD, `/VE`)** | 17 | cùng lệnh trên |
| **Tích hợp Rust — ảnh nội tuyến** | 11 | cùng lệnh trên |
| **Tích hợp Rust — tiling pattern (lặp ô, uncoloured, trần số ô)** | 14 | cùng lệnh trên |
| **Tích hợp Rust — shading lưới 4/5/6/7** | 15 | cùng lệnh trên |
| **Tích hợp Rust — CCITT (blob G4 do libtiff sinh)** | 6 | cùng lệnh trên |
| Binding Python (contract plate, hai trục cờ, capability, ICC, lỗi, memory budget) | 29 | `pytest backend/tests/test_ppe_native.py` |
| **Facade Python (cổng tin cậy + soft-proof)** | 25 | `pytest backend/tests/test_ppe_facade.py` |
| **Routing cấu hình PPE/GS** | 3 | `pytest backend/tests/test_print_engine_routing.py` |
| Golden vs GS — fixture một biến | 43/44 PASS + 1 lệch có chủ ý | `python scripts/ppe_golden_compare.py print_engine/golden/fixtures --color-managed` |
| Golden vs GS — fixture preflight | 17/18 PASS | `python scripts/ppe_golden_compare.py backend/tests/preflight_fixtures/pdfs --color-managed` |
| Hồi quy backend | 1301 pass | `pytest backend/tests` |
| CI native | build wheel Windows + binding/facade tests | job `ppe-native` trong `.github/workflows/ci.yml` |

Vì sao facade cần bộ test riêng dù đã có test native và test `SeparationEngine`: nó
không render gì nhưng giữ **cổng tin cậy** — quyết định kết quả nào được phép dùng để
kết luận về lượng mực. Một hồi quy ở đó không làm test nào khác đỏ; nó chỉ khiến hệ
thống trả một con số TAC **thấp hơn thực tế** mà vẫn mang nhãn `rip_separations`.
Test đi thẳng vào facade, không qua `SeparationEngine`, vì nhánh fallback Ghostscript
sẽ che mất hành vi của cổng.

Ghi chú công cụ: `scripts/check_encoding.ps1` kiểm mã nguồn còn UTF-8. Tồn tại vì
`Set-Content` của PowerShell 5.1 ghi ANSI và làm mất dấu tiếng Việt mà **vẫn compile
được** — một lỗi im lặng đã xảy ra một lần trong quá trình làm milestone này.


### 16.4a Hardening vận hành sau đánh giá độc lập

Bốn khoảng trống có thể làm PPE “đúng trong test nhưng chưa an toàn khi ship” đã được
đóng:

1. **Ngân sách bộ nhớ dùng chung, mặc định 512 MiB.** Buffer trang, các transparency
   group và kênh spot thêm muộn cùng đặt chỗ trên một bộ đếm atomic. Nếu vượt trần,
   engine trả `MemoryBudgetExceeded` qua Python thay vì để allocator làm sidecar chết
   vì OOM. Có thể chỉnh bằng `PRYNX_PPE_MEMORY_BUDGET_MB`.
2. **Routing có cấu hình thật.** `PRYNX_PRINT_ENGINE=auto|ppe|gs`,
   `PRYNX_ALLOW_GS_FALLBACK` và `PRYNX_FORCE_GS` đã được nối vào
   `SeparationEngine`, có test khoá ba nhánh PPE-only, force-GS và auto không fallback.
3. **UI nói đúng engine và đúng độ tin cậy.** PPE không còn bị gắn nhãn “nhanh”; cả
   `rip_separations` và `rip_separations_approx_geometry` đều hiện là RIP, kèm tên
   `PrynX PPE` hoặc `Ghostscript`. Chỉ đường PDFium RGB→CMYK mới hiện “XẤP XỈ”.
4. **CI build binding thật trên Windows.** Job `ppe-native` build/install wheel rồi
   chạy `test_ppe_native.py` và `test_ppe_facade.py`; lỗi lệch signature PyO3/Python
   không còn bị che bởi `pytest.importorskip`.

Các mục này làm Phase 1 an toàn hơn để chạy thực tế, nhưng **không đổi gate unbundle**:
vẫn cần corpus PDF xưởng, golden soft-proof theo ΔE, và quyết định rõ cho knockout
group, JPX, JBIG2. Các action ghi PDF và PDF/X ở Phase 2–3 vẫn còn dùng Ghostscript.

### 16.5 Việc tiếp theo, theo thứ tự phụ thuộc

Thứ tự đã **đổi so với bản đầu**: ICC lên trước text. Lý do là dữ liệu ở §16.3 —
với nội dung RGB, lượng mực còn phụ thuộc một phép quy đổi tuỳ tiện, nên không có
cách nào kiểm chứng đúng/sai. Làm thêm tính năng khi chưa có thước đo là làm mù.

1. ~~Ảnh XObject~~ — **xong** (Milestone B).
2. ~~ICC qua lcms2~~ — **xong** (Milestone C).
3. ~~Text~~ — **xong** (Milestone D). Đây là mốc quyết định: đến đây PPE mới tách kẽm
   được một file có chữ, và §16.3b cho thấy nó khớp Ghostscript 0.0 điểm TAC trên hai
   fixture chữ.
4. ~~Wire facade~~ — **xong** cho `separations.py`, `preflight_rules/ink.py` và
   `softproof.py` (Milestone E/H).
5. ~~Shading kiểu 1/2/3 + shading pattern~~ — **xong** (Milestone F). Còn lại: lưới
   4–7 và tiling pattern, cả hai đang báo lỗi rõ và nhường Ghostscript.
6. **Transparency group + soft mask + blend mode — còn P0 kiến trúc.** Milestone G
   đã hoàn tất phép trộn trong `InkBuffer` và đường CMYK phổ biến, nhưng corpus xưởng
   chứng minh RGB/Lab transparency phải được composite trong blending color space
   **trước ICC**. Guard hiện bật `ink_unsound` cho tổ hợp này. Knockout group
   (`/K true`) vẫn vẽ nhưng cũng bật `ink_unsound`.
7. ~~Optional content (`/OC`)~~ — **xong** (Milestone H), đọc theo cấu hình **in**.
8. ~~Ảnh nội tuyến, tiling pattern, shading lưới 4–7~~ — **xong** (Milestone H).
9. ~~CCITTFaxDecode~~ — **xong** (Milestone H), tự viết theo T.4/T.6, không thêm crate.
10. ~~Soft-proof qua PPE~~ — **xong** (Milestone H). `softproof.py` chạy PPE trước,
    Ghostscript sau, `pdfium+lcms` cuối.
11. **Còn lại, đều hiếm và đều khai riêng:** knockout group (`/K true`), `JPXDecode`
    (JPEG 2000), `JBIG2Decode`. Ba thứ này vẫn nhường Ghostscript.
12. **Gate unbundle (§8)** — với các khoảng trống trên đã khai rõ, việc còn lại là đo
    trên tập file xưởng thật rồi quyết định có bỏ bundle GS hay không.

### 16.6 Milestone E — wire vào backend

`backend/app/core/print_engine/` (`facade.py` + `__init__.py`) là biên giới duy nhất
giữa backend và engine. `separations.py` chạy **PPE trước, Ghostscript sau**, và
`preflight_rules/ink.py` nhận `ppe` vào `TAC_TRUSTED_ENGINES`.

Ba quyết định đáng ghi lại:

1. **Hai trục cờ tin cậy, không gộp một.** `ink_unsound` (thiếu mực ⇒ loại kết quả,
   nhường GS) tách khỏi `geometry_approximate` (chữ đã lên mực nhưng font thay thế ⇒
   dùng được cho TAC, chỉ hạ nhãn). Gộp lại nghe an toàn hơn nhưng gần như mọi file
   xưởng đều có một nhãn chữ font không nhúng, nên cờ gộp sẽ bật trên hầu hết file và
   PPE không bao giờ được dùng — trong khi đỉnh mực của nó đúng.
2. **Chế độ đo mực VẪN nạp ICC.** Bất biến hẹp hơn "TAC thì đừng ICC": chỉ *dữ liệu
   đã là mực* mới không được round-trip, và engine tự bảo đảm điều đó (có test khoá
   `DeviceCMYK` cho kết quả giống từng byte khi bật/tắt ICC). Trước đó facade bỏ ICC
   cho toàn bộ chế độ đo mực, làm 4/18 fixture bị loại oan.
3. **`_tac_unverifiable` trả `plates = []`.** Khi PPE bị loại *vì màu RGB* ở chế độ
   đo mực, GS cũng không phải thước: nó buộc chạy `-dUseFastColor=true` nên với ảnh
   RGB lệch PPE −9.4 đến +30.6 điểm TAC. Hai con số không thể cùng đúng trên một cổng
   ngưỡng 300%. Không trả plate thì `ink.py` tự phát issue "chưa kiểm được TAC" qua
   đường fail-loud sẵn có, thay vì kết luận sai.


### 16.7 Corpus xưởng sau hardening — blending color space và RGB sidecar

Đã chạy 33 PDF (129 trang, khoảng 723 MiB) qua đúng facade sản phẩm sau khi build
native release mới. Hai thay đổi P0 ban đầu vẫn giữ nguyên:

1. group non-isolated có outer blend khác Normal không còn bị ép sang isolated;
2. hai PDF hỏng xref/trailer được rewrite trong tệp tạm, file gốc không thay đổi.

P0 blending color space đã được triển khai theo phạm vi trực tiếp:

1. `InkBuffer` cấp phát lười một RGB sidecar cho buffer trang gốc khi có ICC và gặp
   DeviceRGB; giấy trắng là backdrop RGB hợp lệ.
2. Alpha, coverage, `/BM` (kể cả mode không tách kênh) của vector, ảnh, shading và
   mesh DeviceRGB được tính trên sidecar; sau khi hoàn tất trang, pixel hợp lệ mới
   được đổi một lần qua ICC sang CMYK.
3. Paint CMYK/Gray/spot, transparency group con và RGB/Lab chưa có blending surface
   tương ứng vẫn bị đánh dấu fail-loud. Nếu RGB chạm một backdrop chỉ còn CMYK, pixel
   được đánh dấu `lossy` thay vì phát TAC nghe có vẻ hợp lệ.

### Kết quả kiểm chứng

| Gate | Kết quả |
|---|---:|
| Facade render | 129/129 |
| Parser error qua facade | 0 |
| Phục hồi tệp tạm | 2 trang |
| Đủ tin cậy TAC | **105/129 (81,4%)** |
| Bị chặn fail-loud | 24 trang |
| Raw golden trang 1 | 14 PASS / 11 FAIL / 6 chưa đủ tính năng |
| Rust test | 328 unit + 190 integration = **518 pass** |
| Python facade/golden tests | **55 pass** |

Ba regression managed mới khóa đúng thứ tự compositing: vector RGB alpha, ảnh RGB
alpha và shading RGB alpha đều khớp với fixture phẳng “trộn RGB trước rồi ICC”.
Case `Hộp 1.1` không còn dùng phép nội suy CMYK sai để kết luận TAC.

24 trang còn bị chặn tập trung ở hai nhóm: RGB/Lab hoặc transparency group chưa có
blending surface tương ứng, và các chuỗi mixed RGB/CMYK khiến sidecar đánh dấu
`lossy`. `banner.pdf` vẫn là blocker sampler: TAC thay đổi theo DPI và soft mask
200 DPI vượt memory budget. 11 raw file còn FAIL fidelity/geometry/ảnh; sidecar
không biến các lệch đó thành PASS giả.

**Quyết định:** tiếp tục PPE-first với fallback; **chưa gỡ Ghostscript**. P0 kế tiếp
là blending surface đầy đủ cho group RGB/Lab và sampler TAC bảo thủ theo footprint,
khóa bằng corpus nhiều DPI và regression mixed RGB/CMYK.

---

## 15. Lịch sử tài liệu

| Ver | Ngày | Thay đổi |
|---|---|---|
| 2.0 | 2026-07-26 | Triển khai RGB sidecar lười cho DeviceRGB trực tiếp trên vector/ảnh/shading/mesh; thêm 5 regression (sidecar + RGB alpha managed); Rust 518 pass, Python 55 pass; corpus facade 105/129 trusted, 24 fail-loud. Gate unbundle vẫn đóng; còn blocker group RGB/Lab và sampler TAC theo DPI. |
| 1.9 | 2026-07-26 | Corpus 33 PDF/129 trang sau hardening: sửa non-isolated outer blend và parser recovery tệp tạm; phát hiện P0 blending color space RGB/Lab trước ICC; thêm fail-loud guard (94/129 trang trusted); xác định blocker sampler TAC theo DPI. Gate unbundle vẫn đóng. |
| 1.0 | 2026-07-25 | Bản đầu — map GS PrynX, phase 0–4, gate unbundle |
| 1.1 | 2026-07-25 | §16: bỏ giả định pdfium-làm-nền-raster; PPE tự rasterize ink-space. Milestone A đã build + golden vs GS (TAC 400% khớp tuyệt đối trên fixture solid CMYK, overprint khớp). Siết ngưỡng TAC thành bất đối xứng. |
| 1.2 | 2026-07-25 | §16.2b: Milestone B — ảnh XObject (filter tự làm + predictor, mọi bit depth, Indexed, ImageMask, SMask, JPEG CMYK Adobe). Bộ đo tách "không so được (thiếu ICC)" khỏi "chưa đủ tính năng". §16.5: đưa ICC lên trước text. |
| 1.3 | 2026-07-25 | §16.2c: Milestone C — ICC qua Little CMS, bất biến "mực không qua ICC". §16.2d: bộ fixture golden một-biến. §16.3: 20/20 PASS, lệch < 1 điểm TAC trên mọi màu. Tìm ra 2 lỗi: bộ đo thiếu `-sOutputICCProfile` (**và lỗi cùng loại trong `separations.py` của sản phẩm**), ảnh Indexed < 8 bit bị phá chỉ số. |
| 1.4 | 2026-07-25 | Milestone D (chữ: TrueType/CFF/Type1/Type0-CID/Type3, `Tr` 0–7 với 3 và 7 không lên mực, text clip, font thay thế có khai báo) + Milestone E (§16.6: wire facade PPE-first vào `separations.py`/`ink.py`, hai trục cờ tin cậy). §16.3b: sửa bộ đo chạy đúng cấu hình sản xuất (truyền font thay thế) → 17/18 PASS, hai fixture chữ khớp GS 0.0 điểm TAC. Thêm 19 test cho cổng tin cậy của facade. |
| 1.5 | 2026-07-25 | §16.2f: Milestone F — shading kiểu 1/2/3 + shading pattern, `sh` theo clip vs pattern theo đường dẫn. §16.3c: thêm 5 fixture gradient, **25/25 PASS**, MAE ≤ 0.24. Tìm ra bug thật: `OPM=1` bị bỏ sót ở đường shading **và** đường ảnh (hai đường dựng `InkPaint` trực tiếp, không qua `make_paint`) — gradient/ảnh đen overprint khoét trắng nền. Đã sửa và khoá test ở cả hai đường. |
| 1.7 | 2026-07-25 | §16.2h: Milestone H — đóng nốt mọi khoảng trống thông dụng: optional content `/OC` (đọc cấu hình **in**, `/AS` + `/PrintState`), ảnh nội tuyến (dựng lại thành image XObject), tiling pattern kiểu 1 (cả uncoloured), shading lưới 4/5/6/7 (Coons nâng lên tensor), `CCITTFaxDecode` tự viết theo T.4/T.6 (không thêm crate), soft-proof qua PPE (mực → sRGB, một lần quy đổi). Thêm `geom::Region`: mọi thao tác vẽ chỉ trộn mực trong hộp bao của nó — bắt buộc cho tiling pattern và làm nhanh toàn engine. §16.3e: thêm 8 fixture, **43/44 PASS** + 1 lệch **có chủ ý** (`oc_print_state_off`: GS bỏ qua `/AS` nên vẫn in lớp khai không-in), lệch đó được pin bằng con số thay vì miễn trừ theo tên. |
| 1.8 | 2026-07-26 | Hardening sau đánh giá: memory budget fail-loud dùng chung cho page/group/spot; cấu hình routing `auto|ppe|gs` + fallback/force; UI badge đúng tên và độ tin cậy; CI Windows build wheel native và chạy binding/facade; thêm test routing và memory regression. Chưa đổi gate unbundle. |
| 1.6 | 2026-07-25 | §16.2g: Milestone G — 16 blend mode trong ink space (bù không gian trừ), transparency group ba đường (đục / không cách ly / cách ly), soft mask `/Luminosity` + `/Alpha` với `/BC` + `/TR`. Blend/group/soft mask **không còn** hạ tin cậy; chỉ knockout group còn bật `ink_unsound`. §16.3d: thêm 11 fixture, **36/36 PASS** quản lý màu (MAE ≤ 0.94). Tìm ra bug sản phẩm thứ hai qua bộ đo: `-dSimulateOverprint` đã bị GS 10.x loại bỏ (im lặng) **và** `-dUseFastColor=true` tắt overprint ⇒ kẽm `ink_accurate` của `separations.py` mất overprint, báo **thiếu** mực. Đã sửa cả bộ đo và sản phẩm, thêm bước đọc stderr tìm cờ chết. |

---

*Hết kế hoạch. Cập nhật file này khi đóng gate từng phase.*
