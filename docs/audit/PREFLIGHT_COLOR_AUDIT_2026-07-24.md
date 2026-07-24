# Audit Preflight — Color & Output Preview

- **Repo / commit:** pdfcompare @ `79cb33d`
- **Ngày / người audit:** 2026-07-24 · code audit (Claude, 3 subagent song song theo pipeline)
- **Môi trường:** win32. GS auto-detect qua `_find_ghostscript()` ([config.py:10](../../backend/app/config.py#L10)); ICC bundle **có thật**: `backend/app/assets/icc/FOGRA39.icc` (654 KB) + `sRGB.icc` (560 B).

> **Giới hạn của audit này (đọc trước):** Toàn bộ kết luận dưới đây rút từ **đọc code tĩnh trên HEAD `79cb33d`**, có cite `file:line`. Prompt yêu cầu 4 phương pháp; audit này **hoàn thành A (code review) + D (config)**. **KHÔNG thực hiện B (chạy fixture F1–F8) và C (so Acrobat)** — môi trường này không chạy được Acrobat, không render được file thật qua GS để đo ΔE. Các mục "Matrix test" và "Acrobat parity" bên dưới là **quy trình + lệnh để QA chạy**, không phải kết quả đo. Không bịa số liệu.

---

## Executive summary

Color path của Preflight **đã tiến xa hơn bản audit gốc**: cả ba pipeline (separations / soft-proof / convert) đều có **đường Ghostscript + ICC FOGRA39 thật**, và **ICC registry đã dùng chung** một module (`icc_profiles.py`) — đúng ràng buộc prompt đề ra. Metadata `engine`/`accuracy`/`quality_note` đầy đủ, UI có badge **RIP vs XẤP XỈ** phân biệt minh bạch — tốt hơn phần lớn tool.

Nhưng **các đường fallback vẫn là cạm bẫy màu**, và **preflight rules còn lỗ hổng phát hiện lớn nhất so Acrobat**:

- **Soft-proof fallback (LCMS)** render PDF→RGB rồi coi như sRGB → **mất CMYK gốc** ([softproof.py:253-259](../../backend/app/core/softproof.py#L253)).
- **Separations fallback** dùng công thức RGB→CMYK naive, và **mất toàn bộ spot plate** trong khi UI vẫn liệt kê tên spot ([separations.py:519-565](../../backend/app/core/separations.py#L519)).
- **Preflight rules KHÔNG kiểm OutputIntent / Lab / ICC-page / missing-image-ICC** — false negative nền tảng ([preflight_rules/colors.py](../../backend/app/core/preflight_rules/colors.py)).
- **Rich black không được preserve**; chỉ RGB(0,0,0) thuần ([preserve_black.py:10](../../backend/app/core/preserve_black.py#L10)).
- **Composite UI `mix-blend-multiply`** không mô phỏng chồng mực CMYK — chỉ preview thị giác ([LivePageFrame.tsx:2614](../../desktop/src/components/workspace/LivePageFrame.tsx#L2614)).

**Trả lời câu hỏi cốt lõi #1:** Với file CMYK thuần + **có GS**, separations plate **riêng lẻ** đủ tin để chốt kẽm (tiffsep + ICC + overprint). Nhưng **composite** thì không được dùng để chốt màu, và **khi không có GS** thì tuyệt đối không đủ tin.

---

## Architecture map

```
Preflight color
├── DETECT (preflight_rules/colors.py, images.py)
│   ├─ RGB: named CS + inline rg/RG + Form XObject (đệ quy) + image ICCBased N=3   ✔
│   ├─ Spot/DeviceN: theo tên colorspace                                          ✔ (không decode #XX)
│   └─ OutputIntent / Lab / CalGray / missing-ICC / Pattern / Shading / annot AP  �’ KHÔNG kiểm
│
├── CONVERT COLORS (preflight.py:1276-1397)
│   └─ GS pdfwrite -sColorConversionStrategy=CMYK + FOGRA39 + OverrideICC
│      ├─ preserve_black pre-pass: RGB(0,0,0)→0 g  (chỉ đen thuần)                 ✔ / rich black ✘
│      └─ output KHÔNG verify lại là CMYK; spot sót nếu không chọn spot_to_cmyk
│
├── SEPARATIONS (separations.py)
│   ├─ GS path: tiffsep + FOGRA39 + SimulateOverprint + MaxSpots=32  →  plate thật ✔
│   └─ fallback: PDFium RGB → công thức naive RGB→CMYK, spot_inks=[]              ✘ mất spot
│        └─ UI composite: <img> plate + CSS mix-blend-multiply (sRGB)             ✘ không ink model
│
├── SOFT-PROOF (softproof.py)
│   ├─ GS path: -sDefaultCMYKProfile + Output sRGB + SimulateOverprint            ✔ đọc CMYK gốc
│   │    └─ -dOverrideICC=true → đè cả ICC nhúng (lệch Acrobat)
│   └─ fallback LCMS: PDFium RGB (coi = sRGB) → proof                             ✘ mất CMYK gốc
│        └─ gamut overlay: giả định alarm=black(0), heuristic mong manh
│
└── ICC REGISTRY (icc_profiles.py)  ── dùng chung cho cả 3 pipeline               ✔ bundle-first
```

---

## Findings

| ID | Severity | Area | Evidence | Impact | Recommendation |
|---|---|---|---|---|---|
| C1 | **P0** | Rules | [colors.py:190-202](../../backend/app/core/preflight_rules/colors.py#L190); grep `OutputIntent`/`Lab` = 0 match trong `preflight_rules/` | Không kiểm OutputIntent, Lab, CalGray, ICC-page, missing-image-ICC → false negative nền tảng; file "pass" preflight vẫn có thể sai màu RIP | Thêm rule OutputIntent + Lab/CalGray + missing-ICC-image; mở rộng `_resolve_colorspace` page-path xử lý ICCBased/Lab như image-path |
| C2 | **P0** | Separations | [separations.py:519-565](../../backend/app/core/separations.py#L519) | Fallback mất toàn bộ spot plate (`spot_inks=[]`) trong khi `detected_spots` vẫn liệt kê tên → user thấy tên spot, tưởng đã tách, nhưng không có kênh | Khi approximate: hoặc ẩn `detected_spots`, hoặc cảnh báo rõ "spot KHÔNG tách ở chế độ xấp xỉ" |
| C3 | **P0** | Convert | [preserve_black.py:10,104-108](../../backend/app/core/preserve_black.py#L10) | Rich black (C20M20Y20K100) không preserve; text đen rich → lệch chồng màu khi in offset | Thêm xử lý rich-black → K-only (hoặc option như Acrobat "Preserve Black: CMYK") |
| C4 | **P0** | UI | [LivePageFrame.tsx:2614](../../desktop/src/components/workspace/LivePageFrame.tsx#L2614) | Composite `mix-blend-multiply` sRGB không mô phỏng chồng mực; C+M+Y multiply ≠ màu in; không có nhãn "chỉ preview thị giác" cạnh khung | Thêm nhãn rõ ràng cạnh composite; hoặc dựng composite qua ICC devicelink nếu muốn claim proof |
| C5 | **P1** | Soft-proof | [softproof.py:253-259](../../backend/app/core/softproof.py#L253) | LCMS fallback render PDF→RGB coi = sRGB → mất CMYK gốc; sai bản chất dù có nhãn approximate | Fallback nên cảnh báo mạnh hơn; cân nhắc chặn soft-proof CMYK khi không có GS thay vì proof sai |
| C6 | **P1** | Soft-proof | [softproof.py:219](../../backend/app/core/softproof.py#L219) | `-dOverrideICC=true` đè cả ICC nhúng trong PDF → lệch Acrobat (Acrobat honor profile nhúng) | Chỉ OverrideICC cho color chưa tag; giữ profile nhúng khi có |
| C7 | **P1** | Soft-proof | [softproof.py:279,295-297](../../backend/app/core/softproof.py#L279) | Gamut warning: nguồn luôn PDFium RGB (kể cả khi proof do GS render); giả định alarm-color=black(0) không set tường minh (`setAlarmCodes` vắng) → % gamut dễ false/miss | Set alarm codes rõ ràng; tính gamut từ cùng ảnh pipeline với proof |
| C8 | **P1** | Separations | [separations.py:514-523](../../backend/app/core/separations.py#L514) | Công thức RGB→CMYK naive, không ICC/dot gain; comment "same as Ghostscript's formula" **sai bản chất** | Sửa comment; gắn nhãn approximate rõ; cân nhắc bỏ path này nếu GS luôn có |
| C9 | **P1** | Convert | [preflight.py:1347](../../backend/app/api/routes/preflight.py#L1347) | `icc_profile="auto"` không truyền `-sOutputICCProfile` → kết quả CMYK phụ thuộc default GS, khó tái lập | Luôn ép destination profile mặc định (FOGRA39) khi `auto` |
| C10 | **P1** | Convert | [preflight.py:1377](../../backend/app/api/routes/preflight.py#L1377) | Convert output không mở lại verify là CMYK; spot sót nếu user không chọn `spot_to_cmyk` | Verify colorspace output sau GS; cảnh báo nếu còn RGB/Lab/spot |
| C11 | **P1** | Separations | [separations.py:224-241](../../backend/app/core/separations.py#L224) | GS lỗi → silent fallback approximate, chỉ báo bằng badge nhỏ; user chọn "RIP" mà nhận approximate dễ không nhận ra | Toast/cảnh báo nổi bật khi user chủ động chọn RIP mà fallback |
| C12 | **P2** | Rules | [colors.py:118-153](../../backend/app/core/preflight_rules/colors.py#L118) | Content-stream scan bỏ Pattern/Shading(`sh`)/gradient + annotation `/AP` → RGB trong gradient/annot không bắt | Thêm quét Pattern/Shading + annotation appearance |
| C13 | **P2** | Rules | [colors.py:41-49](../../backend/app/core/preflight_rules/colors.py#L41) | False positive: RGB colorspace khai báo nhưng không dùng vẫn báo lỗi; finding đa lớp không dedup | Báo theo usage; dedup theo trang |
| C14 | **P2** | Rules | ink_manager.py:55,102 | Regex spot không decode `#XX` → tên spot có ký tự đặc biệt/space sai | Decode PDF name `#XX` trước khi so tên |
| C15 | **P2** | Stability | [separations.py:335-458](../../backend/app/core/separations.py#L335) | `job_dir` không bọc `try/finally` → rò temp plate khi lỗi giữa chừng | Bọc `try/finally` quanh job_dir + rmtree |
| C16 | **P2** | Stability | [separations.py:344](../../backend/app/core/separations.py#L344) vs [preflight.py:1488](../../backend/app/api/routes/preflight.py#L1488) | Không nhất quán SAFER: tiffsep `-dNOSAFER` vs overprint `-dSAFER` | Thống nhất chính sách SAFER + whitelist ICC dir |
| C17 | **P2** | Convert | [preflight.py:1333](../../backend/app/api/routes/preflight.py#L1333) | Gray→K thực chất là ColorConversionStrategy=Gray (grayscale), không phải Gray-DeviceGray→K trong file CMYK | Làm rõ nhãn/hành vi; nếu muốn K-only thì convert riêng |
| C18 | **P2** | Convert | [preserve_black.py:24](../../backend/app/core/preserve_black.py#L24) | `_EPS=0.02` quá hẹp: đen gần thuần (0.03–0.04) không preserve | Nới ngưỡng hoặc cấu hình được |

---

## Matrix test results (F1–F8)

> **CHƯA CHẠY.** Đây là quy trình để QA/color engineer thực hiện. Với mỗi file, ghi: engine badge, accuracy, %C/M/Y/K hover (nếu có), screenshot, và so Acrobat.

| # | File | Điều cần verify | Dự đoán từ code (cần xác nhận thực tế) |
|---|---|---|---|
| F1 | CMYK thuần solid C100/M100/Y100/K100 | Separations % mực từng plate | GS path: plate riêng đúng; composite lệch (C4) |
| F2 | CMYK + FOGRA39 OutputIntent/ICCBased | Soft-proof & convert | Preflight **không** đọc OutputIntent (C1); soft-proof GS đè ICC nhúng (C6) |
| F3 | RGB photo + RGB black text | Convert + preserve black | RGB(0,0,0) text → K-only OK; ảnh RGB→CMYK OK; text 0.04 gray **không** preserve (C18) |
| F4 | Spot Pantone + process | tiffsep spot plates | GS: spot plate riêng + coverage OK; **fallback mất spot** (C2) |
| F5 | Overprint text trên nền màu | Overprint preview | GS SimulateOverprint có; verify plate phản ánh overprint |
| F6 | Transparency/blend RGB vs CMYK | Flatten/separations | Cần verify GS flatten; chưa đọc path flatten riêng |
| F7 | Rich black (C20M20Y20K100) vs pure K | Black handling | Rich black **không** preserve (C3) — verify chồng màu |
| F8 | File convert bằng tool vs Acrobat | Parity | Cần đo ΔE — output không verify CMYK (C10) |

**Lệnh chạy:** xem Appendix.

---

## Acrobat parity

> **CHƯA THỰC HIỆN.** Cần Acrobat Pro. Quy trình bắt buộc trên cùng file/trang:

1. Acrobat **Output Preview** (Simulation FOGRA39) bật/tắt từng plate ↔ App Separations (GS on).
2. Acrobat **Convert Colors** ↔ App Convert Colors (F8).
3. Acrobat soft-proof "Simulate" ↔ App soft-proof.

**Top 5 gap dự kiến (từ code, cần xác nhận đo):**

| # | Gap | Evidence | Effort |
|---|---|---|---|
| 1 | Không kiểm OutputIntent/Lab/ICC → Acrobat Preflight bắt, app bỏ sót | C1 | M (2-3 rule mới) |
| 2 | Composite multiply ≠ ink model của Acrobat Output Preview | C4 | L (devicelink) hoặc S (chỉ thêm nhãn) |
| 3 | Rich black không preserve (Acrobat có Preserve Black) | C3 | M |
| 4 | OverrideICC đè profile nhúng (Acrobat honor embedded) | C6 | S |
| 5 | Fallback (no-GS) mất spot + qua RGB (Acrobat luôn ink-accurate) | C2, C5 | S (cảnh báo) / L (thay engine) |

---

## Config & dependency risks

- **ICC bundle OK:** `FOGRA39.icc` (654 KB) + `sRGB.icc` tồn tại; registry bundle-first ([icc_profiles.py:137-143](../../backend/app/core/icc_profiles.py#L137)).
- **GS auto-detect** ([config.py:10-20,78](../../backend/app/config.py#L10)): `GHOSTSCRIPT_PATH` env override, fallback dò. **Khi không có GS → mọi pipeline rơi fallback** (C2/C5/C8) — đây là rủi ro lớn nhất về config.
- **DEFAULT_CMYK_PROFILE = FOGRA39.icc** ([config.py:80](../../backend/app/config.py#L80)) — nhất quán.
- **`-dNOSAFER`** ở tiffsep + convert (đọc ICC ngoài cwd): nới lỏng an toàn có chủ đích; medium-risk. Không nhất quán với overprint dùng `-dSAFER` (C16).

**Trả lời câu hỏi #4** (không có GS, app có chặn/cảnh báo đủ mạnh không?): **Một phần.** Metadata đổi `accuracy=approximate` + badge "XẤP XỈ", nhưng **không có cảnh báo nổi bật** khi user chủ động chọn RIP mà bị fallback (C11), và **không chặn** soft-proof CMYK sai bản chất (C5).

---

## P0 / P1 / P2 plan

### P0 (sai màu / lừa user) — làm trước
- **PR-A:** Thêm preflight rules OutputIntent + Lab/CalGray + missing-image-ICC; mở rộng `_resolve_colorspace` page-path (C1).
- **PR-B:** Fallback separations — ẩn/cảnh báo `detected_spots` khi không tách được plate (C2).
- **PR-C:** Preserve rich black → K trong convert (C3).
- **PR-D:** Nhãn "preview thị giác, không phải màu in" cạnh composite separations (C4) — effort thấp, chặn hiểu nhầm ngay.

### P1 (lệch Acrobat rõ)
- **PR-E:** Soft-proof — OverrideICC chỉ cho color chưa tag (C6); cảnh báo mạnh/chặn khi fallback LCMS cho CMYK (C5).
- **PR-F:** Gamut warning — set alarm codes tường minh + tính từ cùng ảnh proof (C7).
- **PR-G:** Convert — luôn ép destination profile khi `auto` (C9); verify output CMYK + cảnh báo sót (C10); sửa comment sai ở separations (C8).
- **PR-H:** Toast nổi bật khi user chọn RIP mà fallback approximate (C11).

### P2 (thiếu sót / UX / ổn định)
- Pattern/Shading/annotation scan (C12); dedup + báo-theo-usage (C13); decode `#XX` (C14); `try/finally` job_dir (C15); thống nhất SAFER (C16); làm rõ Gray→K (C17); nới `_EPS` (C18).

---

## Acceptance criteria (đề xuất cho release "preflight color v2")

1. **Separations:** với GS, plate C/M/Y/K của file CMYK thuần khớp Acrobat Output Preview về mật độ tương đối (đánh giá cảm quan + đo nếu có); spot plate tên + coverage đúng. Không có GS → **cảnh báo nổi bật**, không chỉ badge.
2. **Soft-proof:** CMYK gốc đọc qua GS + FOGRA39; profile nhúng được honor (không đè vô điều kiện); fallback LCMS **cảnh báo mạnh** hoặc chặn cho CMYK.
3. **Convert:** RGB→CMYK gắn FOGRA39 xác định (không phụ thuộc default GS); rich black preserve; output verify là CMYK, sót RGB/Lab/spot → cảnh báo.
4. **Rules:** phát hiện OutputIntent, Lab, missing-image-ICC, spot (decode `#XX`), gradient/annotation RGB. False positive RGB-không-dùng loại bỏ.
5. **Observability:** mọi path fallback có `engine`/`accuracy`/`warning` + UI badge; không silent-fail thành "màu đẹp giả".
6. **Regression tests:** bundle FOGRA resolve; GS separations khi có GS trả `rip_separations`; soft-proof trả image + metadata đúng 3 trạng thái; convert preserve-black; rule OutputIntent/Lab.

---

## Appendix: commands

```text
# Profiles
GET /api/preflight/icc-profiles

# Separations (GS)
GET /api/preflight/separations/{file_id}/{page}?dpi=150&use_gs=true&profile_id=fogra39
# Separations (approx — verify mất spot + composite)
GET /api/preflight/separations/{file_id}/{page}?dpi=150&use_gs=false

# Soft-proof
POST /api/preflight/softproof
{ "file_id","page","profile_id":"fogra39","intent":"relative","show_gamut_warning":true,"dpi":150 }

# Code entry đã audit
backend/app/core/separations.py        → extract_separations (:203 default path, :519 naive formula, :565 mất spot)
backend/app/core/softproof.py          → render_softproof (:191 GS, :245 LCMS fallback, :269 gamut)
backend/app/core/icc_profiles.py       → resolve_cmyk_profile_path (:167,:183)
backend/app/core/preflight_rules/colors.py, images.py
backend/app/core/preserve_black.py     (:24 _EPS, :104 pre-pass)
backend/app/api/routes/preflight.py    (:1276-1397 convert)
desktop/src/components/OutputPreviewTab.tsx (:560-575 badge)
desktop/src/components/workspace/LivePageFrame.tsx (:2607-2618 composite)

# Test gợi ý
backend/tests/test_icc_and_color_preview.py
```
