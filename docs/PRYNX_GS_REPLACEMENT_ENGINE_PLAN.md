# Kế hoạch: Engine thay thế Ghostscript (riêng cho PrynX)

**Mã tài liệu:** `PRYNX-GS-REPL-ENGINE`  
**Phiên bản:** 1.0  
**Ngày:** 2026-07-25  
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

### 16.4 Kiểm thử

| Tầng | Số test | Lệnh |
|---|---|---|
| Unit Rust (mực, màu, ICC, function, hình học, raster, gstate, filter ảnh) | 175 | `cargo test --manifest-path print_engine/Cargo.toml` |
| Tích hợp Rust — vector (dựng PDF thật → so kẽm) | 32 | cùng lệnh trên |
| Tích hợp Rust — ảnh (hướng, `/Decode`, palette, stencil, SMask, predictor) | 23 | cùng lệnh trên |
| Tích hợp Rust — ICC (bất biến "mực không qua ICC") | 12 | cùng lệnh trên |
| Binding Python (contract plate, degraded, capability, ICC, lỗi) | 21 | `pytest backend/tests/test_ppe_native.py` |
| Golden vs GS — fixture một biến | 20/20 PASS | `python scripts/ppe_golden_compare.py print_engine/golden/fixtures --color-managed` |
| Hồi quy backend sau khi rebuild native | 1219 pass | `pytest backend/tests` |

Ghi chú công cụ: `scripts/check_encoding.ps1` kiểm mã nguồn còn UTF-8. Tồn tại vì
`Set-Content` của PowerShell 5.1 ghi ANSI và làm mất dấu tiếng Việt mà **vẫn compile
được** — một lỗi im lặng đã xảy ra một lần trong quá trình làm milestone này.

### 16.5 Việc tiếp theo, theo thứ tự phụ thuộc

Thứ tự đã **đổi so với bản đầu**: ICC lên trước text. Lý do là dữ liệu ở §16.3 —
với nội dung RGB, lượng mực còn phụ thuộc một phép quy đổi tuỳ tiện, nên không có
cách nào kiểm chứng đúng/sai. Làm thêm tính năng khi chưa có thước đo là làm mù.

1. ~~Ảnh XObject~~ — **xong** (Milestone B).
2. ~~ICC qua lcms2~~ — **xong** (Milestone C).
3. **Text** — Type1 / CFF / TrueType / Type0-CID / Type3, glyph → outline. Không cần
   shaping vì PDF đã cho mã glyph. Đây là mốc quyết định: sau nó PPE mới tách kẽm
   được một file xưởng thật (gần như mọi file in đều có chữ).
4. **Shading** kiểu 1–7 (kiểu 2/3 trước, chiếm gần hết file thật).
5. **Transparency group + soft mask + blend mode** trong ink space.
6. **Optional content (`/OC`)** — nội dung đang tắt tuyệt đối không được lên kẽm.
7. **CCITTFaxDecode** — ảnh scan đen trắng, hay gặp ở file khách cũ.
8. Wire `PrintEngineFacade` ở Python, đổi `separations.py` / `softproof.py` /
   `preflight_rules/ink.py` sang PPE-first (Phase 0.2 của plan).

---

## 15. Lịch sử tài liệu

| Ver | Ngày | Thay đổi |
|---|---|---|
| 1.0 | 2026-07-25 | Bản đầu — map GS PrynX, phase 0–4, gate unbundle |
| 1.1 | 2026-07-25 | §16: bỏ giả định pdfium-làm-nền-raster; PPE tự rasterize ink-space. Milestone A đã build + golden vs GS (TAC 400% khớp tuyệt đối trên fixture solid CMYK, overprint khớp). Siết ngưỡng TAC thành bất đối xứng. |
| 1.2 | 2026-07-25 | §16.2b: Milestone B — ảnh XObject (filter tự làm + predictor, mọi bit depth, Indexed, ImageMask, SMask, JPEG CMYK Adobe). Bộ đo tách "không so được (thiếu ICC)" khỏi "chưa đủ tính năng". §16.5: đưa ICC lên trước text. |
| 1.3 | 2026-07-25 | §16.2c: Milestone C — ICC qua Little CMS, bất biến "mực không qua ICC". §16.2d: bộ fixture golden một-biến. §16.3: 20/20 PASS, lệch < 1 điểm TAC trên mọi màu. Tìm ra 2 lỗi: bộ đo thiếu `-sOutputICCProfile` (**và lỗi cùng loại trong `separations.py` của sản phẩm**), ảnh Indexed < 8 bit bị phá chỉ số. |

---

*Hết kế hoạch. Cập nhật file này khi đóng gate từng phase.*
