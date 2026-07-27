# PPE — TRẠNG THÁI HIỆN TẠI (SSOT)

**Cập nhật:** 2026-07-27
**Nguồn sự thật duy nhất** cho câu hỏi “PPE đang ở đâu, cái gì đã đóng, cái gì chưa”.

> `docs/PRYNX_GS_REPLACEMENT_ENGINE_PLAN.md` là **kế hoạch + changelog**: nó chồng
> lớp theo thời gian và các mục cũ **không** được cập nhật khi trạng thái đổi. Đừng
> đọc con số ở đó để ra quyết định phát hành — đọc file này. Khi hai file lệch nhau,
> file này đúng.
>
> Vì sao tách: audit hai lần trong cùng một ngày đều bắt được người đọc lấy nhầm số
> cũ (§4.6 và §A.6 của hai báo cáo). Một tài liệu vừa là lịch sử vừa là hiện trạng
> thì không thể tin ở cả hai vai.

---

## 1. Kết luận phát hành

| Câu hỏi | Trả lời |
|---|---|
| Gỡ Ghostscript khỏi artifact về mặt **kỹ thuật**? | **ĐẠT** — installer `1.0.0-beta.14` build không bundle GS, payload chỉ còn marker, NOTICE không còn AGPL. |
| Phát hành **công khai** bản no-GS? | **CHƯA** — còn ba chốt vận hành ở §5. |
| Ghostscript còn là fallback? | Chỉ ở bản **có** bundle GS hoặc máy dev. Bản no-GS: `PRYNX_ALLOW_GS_FALLBACK` mặc định `False` và không dò GS hệ thống. |

## 2. Số đo hiện hành

| Hạng mục | Số | Lệnh tái lập |
|---|---|---|
| Rust `print_engine` | **560 pass** | `cargo test --quiet --manifest-path print_engine/Cargo.toml` |
| Backend pytest | **1422 pass** | `cd backend && venv\Scripts\python.exe -m pytest -q` |
| Golden một-biến @100 DPI | **52 PASS, 0 FAIL, 1 khác GS có chủ ý** (53 fixture) | `scripts/ppe_golden_compare.py print_engine/golden/fixtures --dpi 100 --color-managed` |
| Golden một-biến @72 DPI | **50 PASS, 0 FAIL, 1 khác GS có chủ ý** (đo trước khi thêm cặp spot-overprint) | như trên, `--dpi 72` |
| Golden preflight @100 DPI | **17 PASS, 1 fixture JPEG stub chưa đủ tính năng** | `scripts/ppe_golden_compare.py backend/tests/preflight_fixtures/pdfs --dpi 100 --color-managed` |
| Fixture golden trong repo | **53 PDF** (thêm cặp spot-overprint 2026-07-27) | `print_engine/golden/fixtures/` |

Số ở bảng này **phải** được đo lại sau mỗi đợt sửa engine. Nếu không đo lại thì xoá
số đi, đừng để số cũ.

## 3. Sáu gate gỡ bundle GS (§8 của kế hoạch)

| # | Gate | Trạng thái |
|---|---|---|
| 1 | ≥95% job prepress 30 ngày không cần GS | **Đã loại khỏi gate** theo quyết định sản phẩm — thiết bị đo không tính được mẫu số, và không dựng số liệu giả để làm đẹp gate. |
| 2 | Separations + soft-proof + TAC chạy PPE mặc định, badge đúng | **ĐẠT** |
| 3 | ≥1 chuẩn PDF/X qua validator độc lập | **CHƯA** — chỉ có validator nội bộ |
| 4 | Convert CMYK / Downscale / Embed non-GS | **ĐẠT** |
| 5 | Flatten / Outline có quyết định sản phẩm rõ | **ĐẠT ở mức hành vi**: flatten raster PPE có cảnh báo; OUTLINE_FONTS fail-closed, 22/33 file corpus xong bằng pikepdf, phần còn lại **dừng an toàn** thay vì giao bản in sai |
| 6 | Build không copy GS + release QA xanh | **ĐẠT ở mức artifact** — xem §5 về điều kiện của cây làm việc |

## 4. Hành vi engine đã chốt

- **Đường đo** (tách kẽm, TAC): `InkSpace::new()` — mực pha giữ kẽm riêng, dữ liệu DeviceCMYK/Gray/Separation/DeviceN **không** qua ICC.
- **Đường xem** (soft-proof, Overprint Preview): `InkSpace::preview()` — mực pha giữ kênh riêng khi trộn, chỉ gộp về CMYK ở bước xuất ảnh qua bảng tra tint→CMYK. Đây là bản sửa 2026-07-27 §A.1; quy sớm như trước làm overprint của Pantone biến mất khỏi preview.
- **Overprint Preview**: hai ảnh knockout/overprint đều dựng bằng PPE; `simulate_overprint=false` chỉ vô hiệu hoá `/OP`,`/op`,`/OPM` tại ExtGState, không sửa file nguồn. Thiếu tin cậy thì **fail-loud**, không trả overlay rỗng.
- **Ngân sách RAM**: `<8 GB` giảm mạnh, `8–<16 GB` giảm nhẹ, `>=16 GB` không trần nhân tạo; chia theo số slot việc nặng; `PRYNX_PPE_MEMORY_BUDGET_MB` ghi đè.
- **`OUTLINE_FONTS`**: hình học chữ lấy từ PPE (`ppe_text_outlines`), pikepdf ghi PDF. Nguồn PPE **cộng thêm** vào đường fontTools, không thay thế; mỗi path bị kiểm nằm đúng vị trí bút để bắt lệch chỉ số; chốt so-kẽm từng trang giữ nguyên. Action fail-closed: thiếu font gốc, còn text sống, hoặc so kẽm lệch thì dừng và **xoá** output.
- **Ghostscript trên bản no-GS**: marker `binaries/gs/NO_GHOSTSCRIPT.txt` là lời khai của artifact; backend đọc nó, **không** dò GS hệ thống, và mọi lệnh GS bất khả dụng trả thông điệp ở mức sản phẩm thay vì `Ghostscript failed: ...`.

## 5. Ba chốt còn lại trước phát hành công khai

1. Chạy Acrobat Pro Preflight hoặc validator độc lập trên bộ output PDF/X-4 và PDF/X-1a đại diện; lưu report cùng artifact.
2. Kiểm tay đầy đủ UI trên máy sạch không chạy vòng dev (separations, soft-proof, TAC, Overprint Preview gồm ca **mực pha**, OUT FONT, flatten, PDF/X).
3. Gom/duyệt worktree → commit sạch → bật Authenticode/updater signing → build lại → `scripts/verify_installed_artifact.ps1 -ExpectNoGhostscript` để điền `EXE_SHA256`. Manifest cuối phải là `GIT_DIRTY=no`, `CODE_SIGNED=yes`.

## 6. Việc đã biết, chưa làm

| Việc | Vì sao chưa | Ghi ở |
|---|---|---|
| Đo lại corpus 33 PDF cho `OUTLINE_FONTS` sau khi nối PPE | Corpus khách không nằm trong repo; con số "22/33 file" là của bản fontTools và chưa cập nhật | `GS_SUNSET_FIXES` §11.4 |
| Corpus khách 33 PDF không nằm trong repo | Không commit file khách; cần manifest hash ẩn danh | Báo cáo lần 1 §4.7 |
| Telemetry đo tỉ lệ GS thật | Đã loại khỏi gate; nếu làm lại thì phải có mẫu số theo operation | Báo cáo lần 1 §4.2 |

## 7. Lịch sử và bằng chứng

- Kế hoạch + changelog: `PRYNX_GS_REPLACEMENT_ENGINE_PLAN.md`
- Audit lần 1 (sáng 2026-07-27): `BAO_CAO_AUDIT_GS_REPLACEMENT_ENGINE_2026-07-27.md`
- Audit lần 2 (chiều 2026-07-27): `BAO_CAO_AUDIT_GS_REPLACEMENT_ENGINE_2026-07-27_LAN2.md`
- Nhật ký sửa: `GS_SUNSET_FIXES_2026-07-27.md`
- OUT FONT: `BAO_CAO_BO_SUNG_AUDIT_OUT_FONT_2026-07-27.md`, `OUT_FONT_FIXES_2026-07-27.md`
- Chuẩn hình học khuôn bế (không liên quan PPE): `audit-rules.md`
