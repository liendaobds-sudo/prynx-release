# Prompt audit sâu — Preflight (giao đội ngũ)

> Brief giao lead/QA/color engineer hoặc AI agent.  
> Tập trung: **độ đúng màu**, **CMYK/ICC**, **separations / soft-proof / convert colors**, parity với **Acrobat / RIP**.

---

## Vai trò

Bạn là **senior prepress / color engineer + PDF software auditor**. Nhiệm vụ: **audit sâu tính năng Preflight** của sản phẩm (PrynX / pdfcompare), tập trung **độ đúng màu**, **chuẩn hóa CMYK/ICC**, **separations / soft-proof / convert colors**, và **độ tin cậy so với Acrobat / RIP**.

Không chỉ đọc UI. Phải **đọc code + chạy file thật + ghi bằng chứng**.

---

## Mục tiêu audit

1. Xác định Preflight **đã / chưa** chuẩn hóa màu đúng cho in offset/digital.
2. Giải thích vì sao file **CMYK** có thể trông **xấu** khi bật **Separations / xem trước bản in**.
3. So sánh hành vi với **Adobe Acrobat Pro** (Output Preview, Convert Colors, Soft-proof).
4. Liệt kê **lỗ hổng, rủi ro, false positive/negative**, và **kế hoạch sửa theo ưu tiên P0–P2**.
5. Đề xuất **tiêu chí chấp nhận (acceptance)** và **bộ file regression**.

---

## Phạm vi (in scope)

| Module | Gợi ý path (repo) |
|---|---|
| Preflight engine & rules | `backend/app/core/preflight_engine.py`, `preflight_models.py`, `preflight_rules/` (đặc biệt `colors.py`) |
| API Preflight | `backend/app/api/routes/preflight.py` |
| Separations | `backend/app/core/separations.py` |
| Soft-proof | `backend/app/core/softproof.py` |
| ICC registry | `backend/app/core/icc_profiles.py`, `backend/app/assets/icc/` (`FOGRA39.icc`, `sRGB.icc`) |
| Convert Colors / PDF/X | routes convert-colors, save PDF/X trong `preflight.py` |
| Preserve black | `backend/app/core/preserve_black.py` (nếu có) |
| UI Output Preview / Soft-proof | `desktop/src/components/OutputPreviewTab.tsx`, `SoftProofPanel.tsx`, overlay trong viewer (`LivePageFrame` / `AcrobatViewer`) |
| Config | `GHOSTSCRIPT_PATH`, `ICC_PROFILE_DIR`, `DEFAULT_CMYK_PROFILE` |

**Out of scope (trừ khi chạm màu):** sticker dieline, imposition layout (trừ khi preflight feed vào in).

---

## Bối cảnh kỹ thuật đã biết (điểm xuất phát — phải verify lại)

Các điểm sau **đã từng audit**; đội **không tin mù**, phải **re-verify trên HEAD hiện tại**:

1. **Separations mặc định từng là pseudo-CMYK**: PDF → PDFium RGB → công thức RGB→CMYK đơn giản → 4 plate màu RGB cố định → UI `mix-blend-multiply`. **Không** phải kẽm ICC/RIP.
2. **GS `tiffsep`** chính xác hơn (process + spot); code sau này **ưu tiên GS** + FOGRA39 khi có Ghostscript.
3. **Soft-proof** từng soft-proof như **sRGB source** dù PDF là CMYK; resolve ICC có thể **bỏ lỡ** file bundle `FOGRA39.icc`. Sau này có path **GS + DefaultCMYKProfile + Output sRGB**.
4. **Convert Colors** dùng Ghostscript + ICC (FOGRA39) — gần “chuẩn hóa file” hơn preview.
5. Preflight rules **phát hiện** RGB/Spot ở mức resources/content; chưa chắc đủ OutputIntent / image ICC / Lab.

Audit phải trả lời: **HEAD hiện tại đã fix những điểm trên chưa, còn gap gì so Acrobat.**

---

## Phương pháp bắt buộc

### A. Code review

Với **mỗi** pipeline (detect / convert / separations / soft-proof / overprint):

- Entry API → engine → output → UI composite
- Nguồn màu: DeviceCMYK, ICCBased, Separation, DeviceN, RGB, Gray, Lab
- Có/không đọc **OutputIntent**, profile nhúng, overprint
- Fallback khi **không có Ghostscript** / **không có ICC**
- Metadata trả về: `engine`, `accuracy`, `quality_note`, warning

Ghi: **file + function + hành vi thực tế** (không chỉ comment).

### B. Test file ma trận (tối thiểu)

Chuẩn bị / dùng fixture:

| # | File | Mục đích |
|---|---|---|
| F1 | CMYK thuần DeviceCMYK, solid C100 / M100 / Y100 / K100, patch | Separations % mực |
| F2 | CMYK + FOGRA39 OutputIntent / ICCBased | Soft-proof & convert |
| F3 | RGB photo + RGB black text | Convert + preserve black |
| F4 | Spot Pantone + process | tiffsep spot plates |
| F5 | Overprint text trên nền màu | Overprint preview |
| F6 | Transparency / blend CS DeviceRGB vs DeviceCMYK | Flatten / separations |
| F7 | Rich black (C20 M20 Y20 K100) vs pure K | Black handling |
| F8 | File “đã convert” bằng tool vs Acrobat Convert Colors | So parity |

Với mỗi file ghi: **Acrobat kết quả** vs **app kết quả** (screenshot + engine badge + % C/M/Y/K hover nếu có).

### C. So sánh Acrobat (bắt buộc)

Trên **cùng file, cùng trang**:

1. Acrobat **Output Preview** — Simulation Profile FOGRA39 / ISO Coated v2; bật/tắt từng plate.
2. App **Separations** — GS bật / tắt.
3. Acrobat **Print Production → Convert Colors** (nếu có) vs app Convert Colors.
4. Soft-proof app vs Acrobat soft-proof / Output Preview “Simulate”.

Đánh giá: **ΔE cảm quan** (và đo nếu có công cụ), không chỉ “có vẻ giống”.

### D. Runtime / config

- `GHOSTSCRIPT_PATH` có/không, version GS
- `app/assets/icc/FOGRA39.icc`, `sRGB.icc` có resolve được không (`GET /preflight/icc-profiles`)
- Response separations: `engine`, `accuracy` (`rip_separations` | `approximate`)
- Soft-proof: `engine` (`ghostscript+icc` | `pdfium+lcms`), `accuracy`, `warning`

---

## Checklist audit chi tiết

### 1. Preflight rules (màu)

- [ ] Phát hiện RGB (inline `rg`, named CS, Form XObject, images)
- [ ] Phát hiện Spot / DeviceN (kể cả tên encoded `#XX`)
- [ ] False positive/negative so Acrobat Preflight (nếu có profile tương đương)
- [ ] Severity + auto_fixable có hợp lý không
- [ ] Có check OutputIntent / PDF/X / missing ICC image không

### 2. Convert Colors / chuẩn hóa file

- [ ] RGB→CMYK qua GS có gắn đúng ICC (FOGRA39)
- [ ] Preserve black (RGB 0,0,0 → K only) có hiệu lực
- [ ] Gray→K, Spot→CMYK
- [ ] File sau convert: Acrobat vẫn CMYK? Lab/RGB sót?
- [ ] So patch solid với file convert bằng Acrobat

### 3. Separations / Output Preview

- [ ] Default path: GS hay approximate?
- [ ] CMYK file **không spot**: plate C/M/Y/K có khớp Acrobat (mật độ tương đối)?
- [ ] Composite UI (`mix-blend-multiply`) có **lừa** user về màu cuối?
- [ ] Spot plates tên + coverage
- [ ] Overprint simulation khi tách kẽm
- [ ] DPI, performance, timeout GS
- [ ] Label UI có cảnh báo rõ khi **approximate**?

### 4. Soft-proof

- [ ] Resolve FOGRA39 từ **bundle**, không chỉ OS
- [ ] Pipeline GS: DefaultCMYK + Output sRGB + overprint
- [ ] Fallback LCMS có gắn nhãn approximate
- [ ] Gamut warning có ý nghĩa / false alarm
- [ ] Intent (relative/perceptual/…) có đổi kết quả

### 5. UI / UX tin cậy

- [ ] Badge RIP vs XẤP XỈ
- [ ] User có hiểu separations ≠ proof in tuyệt đối?
- [ ] Soft-proof / separations có đè viewer đúng trang, đúng crop?

### 6. Bảo mật & ổn định

- [ ] GS `-dNOSAFER` vs SAFER + path ICC
- [ ] Path traversal file_id / file_path
- [ ] Temp plate dir cleanup
- [ ] Lỗi GS không silent-fail thành “màu đẹp giả”

---

## Câu hỏi then chốt (bắt buộc trả lời trong báo cáo)

1. Với file **CMYK thuần**, separations mặc định hiện tại có **đủ tin** để khách chốt màu với xưởng không? **Có/Không + vì sao.**
2. Soft-proof hiện tại có **đọc CMYK gốc** hay vẫn qua RGB?
3. Convert Colors và Soft-proof/Separations có **cùng profile ICC** không?
4. Khi **không có Ghostscript**, app có **chặn** hoặc **cảnh báo đủ mạnh** không?
5. Gap lớn nhất so Acrobat (top 5), effort ước lượng.
6. Acceptance criteria đề xuất cho release “preflight color v2”.

---

## Định dạng báo cáo đầu ra

```markdown
# Audit Preflight — Color & Output Preview
- Repo / commit:
- Ngày / người audit:
- Môi trường: OS, GS version, ICC có/không

## Executive summary (½ trang)
## Architecture map (mermaid/pipeline)
## Findings (bảng)
| ID | Severity | Area | Evidence (file:line / screenshot) | Impact | Recommendation |
## Matrix test results (F1–F8)
## Acrobat parity
## Config & dependency risks
## P0 / P1 / P2 plan
## Acceptance criteria
## Appendix: commands, log snippets, screenshots
```

**Severity:** P0 = sai màu / gây in lỗi / lừa user; P1 = lệch Acrobat rõ; P2 = thiếu sót / UX / perf.

---

## Ràng buộc khi propose fix

- Ưu tiên **đúng màu** hơn tốc độ; path nhanh chỉ được gắn nhãn **approximate**.
- Một **ICC registry** dùng chung Convert / Soft-proof / Separations.
- Không claim “chuẩn Acrobat 100%” nếu vẫn composite plate bằng CSS multiply không ink model.
- Mọi path fallback phải **observable** (`engine`, `accuracy`, warning UI).
- Thêm/giữ **regression tests** (bundle FOGRA resolve, GS separations khi có GS, soft-proof trả image + metadata).

---

## Deliverable

1. Báo cáo markdown theo template trên.
2. Danh sách PR cụ thể (file đụng, acceptance từng PR).
3. Bộ fixture tối thiểu (hoặc path fixture) + cách chạy test.
4. Nếu audit bằng AI/agent: **cite path:line**; không bịa hành vi chưa đọc code.

---

## Gợi ý lệnh / điểm vào nhanh

```text
# Profiles
GET /api/preflight/icc-profiles

# Separations (GS)
GET /api/preflight/separations/{file_id}/{page}?dpi=150&use_gs=true&profile_id=fogra39

# Separations (approx)
GET /api/preflight/separations/{file_id}/{page}?dpi=150&use_gs=false

# Soft-proof
POST /api/preflight/softproof
{ "file_id", "page", "profile_id": "fogra39", "intent": "relative", "show_gamut_warning": true, "dpi": 150 }

# Code entry
backend/app/core/separations.py → extract_separations
backend/app/core/softproof.py → render_softproof
backend/app/core/icc_profiles.py → resolve_cmyk_profile_path
backend/app/core/preflight_rules/colors.py
desktop/src/components/OutputPreviewTab.tsx
desktop/src/components/SoftProofPanel.tsx

# Tests gợi ý
backend/tests/test_icc_and_color_preview.py
```

---

## Dòng gợi ý đầu ticket

> Repo: pdfcompare · Ưu tiên audit **color path** (separations / soft-proof / convert / preflight rules) · So sánh bắt buộc với **Acrobat Pro** · Deadline: _[điền]_ · Output: báo cáo MD + PR plan P0–P2.
