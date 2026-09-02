# BÁO CÁO LÔ A4b-1 — NỐI TRỌN CHUỖI VÀ BẰNG CHỨNG CỔNG CHẶNG A

**Ngày:** 2026-08-28
**Chặng:** A — lô thứ tám
**Trạng thái:** **PASS** — bốn điều kiện Cổng Chặng A đã có bằng chứng đo được ở tầng engine + artifact

---

## 1. Mã lô và mục tiêu

Nối mắt xích còn thiếu giữa **thiết lập job** và chuỗi đã có: pin nguồn → resolve contour → dựng bundle → solve một lần → render artifact → commit manifest.

Trước lô này mọi mảnh đều tồn tại và có test riêng, nhưng **không có gì nối chúng**, nên không thể chứng minh bốn điều kiện Cổng Chặng A.

**File (2):**

| File | Loại |
|---|---|
| `backend/app/core/nesting_production_pipeline.py` | **mới** |
| `backend/tests/test_nesting_production_pipeline.py` | **mới**, 14 test |

Không chạm route, UI, adapter, bundle, writer, Rust. Không stage, không commit.

---

## 2. Một vấn đề THIẾT KẾ do chính test phát hiện

Bản đầu của tôi có đúng một hàm `run_production_nesting_job(...)`, và tôi viết test "preview và export cùng manifest" bằng cách gọi nó hai lần. Test **đỏ**: hai `layoutFingerprint` khác nhau.

Không phải test sai. **Thiết kế sai.**

Mỗi lượt `pin_pdf_path` sinh một **locator mới**; locator nằm trong RenderBundle ⇒ `renderBundleHash` khác ⇒ `inputHash` khác ⇒ `layoutFingerprint` khác. Nghĩa là nếu preview và export mỗi bên gọi pipeline riêng thì chúng **không thể** cùng manifest — đúng điều Cổng Chặng A cấm, và là cách một callsite vô tình phá hợp đồng.

**Sửa:** tách session khỏi render.

```
solve_production_nesting_job(job)        -> ProductionNestingSession   # pin + geometry + bundle + solve
render_production_nesting_session(s, ...) -> ProductionRenderResult    # gọi nhiều lần, KHÔNG solve
commit_production_nesting_session(s, ...) -> StoredNestingManifest     # chỉ sau khi artifact đóng
run_production_nesting_job(...)                                        # tiện lợi khi chỉ cần 1 file
```

Preview và export giờ là hai file từ **cùng** một session, nên cùng manifest **tất yếu** — không phải nhờ hash trùng may mắn.

Và tôi khoá luôn sự thật ngược lại bằng một test tên tường minh: `test_goi_pipeline_hai_lan_KHONG_cho_cung_manifest`. Để lần sau không ai "sửa" bằng cách cho preview gọi pipeline riêng.

---

## 3. Một FIXTURE sai làm mọi assert xanh trên hình học sai

Đây là phần đáng ghi nhất của lô.

Lượt đo đầu cho autofill **140 con/tờ**. Tôi không tin con số đó: khuôn 30×30mm trên vùng in 190×140mm thì trần vật lý chỉ khoảng 20. In contour thật ra:

```
outer đỉnh: 4   holes: 0
bbox mm   : x 10.0 -> 20.0   y 10.0 -> 20.0
kích thước: 10.0 x 10.0
```

`extract_page_die_cut_polygon` trả về **cửa sổ 10×10** làm biên khuôn, không phải khuôn 30×30. Nguyên nhân: fixture của tôi vẽ biên ngoài và cửa sổ thành **hai** lệnh `S` riêng, nên bộ dò chọn subpath nhỏ.

Engine, validator và writer đều **đúng** — chúng tính chính xác trên một hình sai. Và **mọi assert của tôi vẫn xanh**: `validation.valid` True, `placedCount > 1` True. Đúng cái bẫy `prynx-dieline` cảnh báo: fixture tự dựng vi phạm rất dễ, và khi đó nó khoá luôn hành vi sai.

**Sửa hai chỗ:**

1. Fixture vẽ **một** path với hai subpath — đúng cách file khuôn thật được vẽ. Đo lại: `bbox 0,0 → 30,30`, kích thước `30 x 30`.
2. Thêm **hai chốt tự kiểm** để lỗi này không lặp lại im lặng:
   - `test_fixture_cho_dung_contour_khuon_30x30` — kiểm chính fixture, không kiểm engine;
   - assert **trần hình học** cho autofill: `placedCount <= (usable_w * usable_h) // (die * die)`.

Sau khi sửa, autofill cho **20 con/tờ** — khớp chính xác tính tay: pitch 32×33 trên 190×140 → 5 cột × 4 hàng.

Bài học lặp lại đúng câu trong skill: **chẩn đoán bằng số đo, không bằng đọc code.** Nếu tôi tin con số 140 thì đã báo "Cổng A đạt" trên một hình học sai.

---

## 4. Bốn điều kiện Cổng Chặng A — bằng chứng đo được

Tất cả trên **native thật** và **writer thật**, artifact ghi ra đĩa.

| # | Điều kiện Cổng A | Chỗ khoá | Kết quả đo |
|---|---|---|---|
| 1 | không overlap / clearance / obstacle / boundary violation | validator native, test đọc lại `validation.valid` | **True** ở mọi ca |
| 2 | đủ quantity | `stats.placedCount` so tổng quantity | **6/6** (1 mẫu), **6/6** (2 mẫu × 3) |
| 3 | preview và export cùng `manifestId`/fingerprint | render hai lần từ cùng session | **bằng nhau**, và content stream **byte-identical** |
| 4 | solver call count = 1 | đếm `MixedNestingRunHandle.solve_production` | **1** cho cả preview + export |

Số đo cụ thể:

| công cụ | intent | yêu cầu | placed | sheets | góc | valid | trang artifact |
|---|---|---:|---:|---:|---|---|---:|
| sticker_imposer | quantity_fulfillment | 6 | **6** | 1 | [0°] | True | 2 |
| sticker_imposer | quantity_fulfillment (2 mẫu × 3) | 6 | **6** | 1 | [0°] | True | 2 |
| sticker_imposer | autofill_single_sheet | auto | **20** | 1 | [0°] | True | 2 |

Thêm hai bất biến đo được:

- **Miền xoay Chặng A là cardinal**: `orientationPolicy.defaultRotation = discrete [0, 90, 180, 270]`, và mọi `pose.rotationDeg` trong manifest thuộc tập đó.
- **Obstacle được tôn trọng trên layout cuối**: khai dải boong `y ∈ [0, 12]` thì mọi `translateYmm ≥ 12`, và `validation.valid` vẫn True.
- **gapX ≠ gapY không bị nén**: `clearance.partToPart = {xMm: 2.0, yMm: 3.0}`; đổi riêng trục X làm `inputHash` đổi.

**Chưa đạt:** ô CNC. Bốn ô Cổng A gồm Tem/CNC × autofill/quantity; lô này chứng minh **hai ô Tem bế**, còn CNC cần `detected_shape` truyền từ bộ dò của job — pipeline đã chặn fail-closed nếu thiếu (`test_cnc_phai_truyen_detected_shape`) nhưng chưa có ca dương. Ghi thành finding A4b-1.

---

## 5. Cách đếm "solve đúng một lần" — và một bẫy patch

Lần đầu tôi đếm bằng cách patch `create_run`. Không có tác dụng: `solve_production_nesting` bind `create_run` làm **default argument** lúc import, nên patch attribute module không đổi được default đã bind.

Đếm đúng tầng: patch `MixedNestingRunHandle.solve_production`. Đây cũng là đại lượng Cổng A nói tới ("solver call count"), không phải số handle được tạo.

---

## 6. Bất biến pipeline đã đóng

1. **Solve một lần** — có test đếm.
2. **Không job lồng** — không gọi `/mixed-nesting/jobs`; chỉ service nội bộ.
3. **Commit sau artifact** — `commit_production_nesting_session` tách riêng, preview dùng `commit=False` và `stored is None`.
4. **Miền xoay server-owned** — pipeline **cố ý không có** tham số `allow_continuous_rotation`, vì `solve_production_nesting` chưa phơi nó ra; nhận tham số rồi không truyền được xuống là tham số bị bỏ qua âm thầm, đúng lỗi đã sửa ở lô A2. Ghi rõ trong docstring.
5. **Không bbox fallback** — footprint đóng gói dùng chính contour bế; mất contour thật là mất lý do dùng nesting theo đường bế.
6. **Dọn pin khi lỗi** — `except BaseException` thu hồi mọi pin provisional để hủy giữa đường không treo TTL.
7. **Fail-closed đầu vào** — thiếu quantity, autofill kèm quantity, `part_id` trùng, duplex ở Tem bế, CNC thiếu `detected_shape`: chặn **trước** khi pin nguồn.

---

## 7. Verify

| Phạm vi | Kết quả |
|---|---|
| `test_nesting_production_pipeline.py` | **14 passed** |
| Bộ verify bắt buộc + writer + rollout + pipeline (12 file) | **458 passed** |
| Toàn bộ `backend/tests` | xem §7.1 |
| `py_compile` 2 file | exit 0 |

---

## 8. Finding

| Mã | Phát hiện | Mức | Thuộc lô |
|---|---|---:|---|
| A4b-1 | Ô **CNC** của Cổng A chưa có ca dương: cần `detected_shape` từ bộ dò của job. Pipeline đã fail-closed khi thiếu, nhưng chưa chứng minh đường CNC chạy được | P1 | A4b-2 |
| A4b-2 | Route và `processHandlers` chưa gọi pipeline. Ba callsite payload còn lệch naming/đơn vị (EXECUTE camelCase+mm, PREVIEW snake_case+point, `preview-layouts-batch`) | P1 | A4b-3 |
| A4b-3 | `extract_page_die_cut_polygon` trả **outer silhouette, holes = 0**. Với packing thì bảo thủ và an toàn, nhưng lớp CUT sẽ **không có cửa sổ** nếu contour đến từ bộ dò này. Writer đã hỗ trợ holes; mắt xích thiếu là resolver | P2 | cần quyết định sản phẩm |
| F3-1 | `build_production.ps1` chưa nung cặp cờ Mixed Nesting | P2 | chủ dự án quyết |
| A2-1 | Nén `gap = max(gap_x, gap_y)` ở CNC gang là bảo thủ, không sai | P3 | chủ dự án duyệt |
| C0-7 | Đã đo: refinement tiêu hết ngân sách, orientation exploration giảm khi profile tăng | P2 | Chặng B |
| C0-6 | Kernel chưa nhận worker/RAM grant | P2 | Chặng B |
| A4a-2 | Wire format `gridStrategy` vẫn chuỗi thuần | P3 | sau Cổng A |

**A4b-3 đáng chú ý:** nó là hệ quả trực tiếp của việc tôi đi đo fixture. Bộ dò trả silhouette không có lỗ, nên nếu đường production lấy contour từ đó thì **dao sẽ không cắt cửa sổ** — ngược với quyết định §7.2 mà lô A1c vừa khoá. Writer đã đúng; chỗ thiếu là resolver phải mang lỗ ra. Cần quyết định sản phẩm: lỗ lấy từ đâu (bộ dò nâng cấp, hay từ khuôn bế do người dùng khai).

---

## 9. Kết luận

**PASS.**

- Chuỗi production đã nối trọn và chạy được trên native thật, artifact ghi ra đĩa đúng.
- Ba trong bốn điều kiện Cổng Chặng A có bằng chứng đo được; điều kiện thứ tư (đủ quantity) đạt ở cả hai ô Tem bế. Ô CNC còn thiếu ca dương.
- Test của tôi phát hiện **một lỗi thiết kế** (preview/export không thể cùng manifest nếu gọi pipeline hai lần) và tôi sửa kiến trúc chứ không sửa test.
- Tôi phát hiện **fixture của mình sai** nhờ không tin một con số vô lý, và thêm hai chốt để lỗi đó không lặp lại.
- Phát sinh một finding thật (A4b-3) về việc bộ dò không trả lỗ — trực tiếp ảnh hưởng quyết định §7.2 đã duyệt.

---

## 10. Lô tiếp theo

**A4b-2 (≤5 file):** đóng ô CNC của Cổng A — truyền `detected_shape` từ bộ dò của job vào pipeline, kèm ca dương cho `cnc_imposer` ở cả hai intent và ca duplex.

**A4b-3 (≤5 file):** nối route + `processHandlers`. Trace ba callsite payload trước khi sửa; nếu vượt 5 file thì tách tiếp và báo.

Trước A4b-3, cần chủ dự án quyết **A4b-3 (finding)**: lỗ khuôn cho lớp CUT lấy từ đâu, vì bộ dò hiện chỉ trả silhouette ngoài.
