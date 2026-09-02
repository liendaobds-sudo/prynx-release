# Audit hiệu năng nesting Tem bế/CNC — câu hỏi song song và đường preview

Ngày: **2026-08-29**. Đơn vị audit: `W2-U09 / W7-U11`.
Trạng thái: **BÁO CÁO CHỜ DUYỆT** — chưa sửa dòng code nào.

Báo cáo này **không lặp lại** `docs/BAO_CAO_AUDIT_HIEU_NANG_VA_SUC_MANH_NESTING_TEM_CNC_2026-08-29.md`.
Nó trả lời đúng hai câu hỏi của chủ dự án và bổ sung phần mà audit kia chưa soi kỹ:
**đường request preview**.

Câu hỏi được đặt ra:

1. Solver có đang chạy nhiều phương án song song hay chỉ một luồng?
2. Cho nhiều luồng chạy nesting rồi lấy phương án tốt nhất — có phải hướng đúng?

Trả lời ngắn: **(1) chỉ một luồng.** **(2) Không — nếu làm đúng như mô tả thì tăng tốc bằng 0.**
Lý do ở §2, và nó là phát hiện quan trọng nhất của lượt audit này.

---

## 1. Bằng chứng: engine chạy một lõi

### 1.1 Vòng trial tuần tự, không có pool nào

`imposition_core/src/mixed_nesting/multi_start.rs:409`

```rust
for plan in plan_trials(request.seed, effort) {
```

Vòng lặp `for` thuần. Docstring cùng file (`:20-25`) nói rõ ý định:

> "song song hoá là việc của lớp gọi (local Rayon pool theo budget đã tính ở backend)"

**Lớp gọi đó không tồn tại.** Bằng chứng phủ định:

| Kiểm tra | Kết quả |
|---|---|
| `rayon` trong `imposition_core/Cargo.toml` | **không có** (chỉ `serde`, `geo`, `ts-rs`, `clipper2-rust`) |
| `rayon\|par_iter\|thread::scope` trong `imposition_core/**/*.rs` | **0 match** |
| `rayon` trong `native/src/*.rs` | có, nhưng chỉ ở `image_compare.rs`, `combine_image_pdf.rs`, `print_engine_py.rs` — **không** ở `mixed_nesting_py.rs` |
| `plan.workers` được tiêu thụ ở đâu | **không đâu** — `plan_hardware()` tính rồi chỉ dùng làm hệ số ước lượng RAM (`mixed_nesting_service.py:896`) |

### 1.2 Hai comment đang mô tả sai hiện trạng

Đây là bẫy cho người đọc code sau này, cần sửa cùng lô:

- `heavy_job_scheduler.py:69-72`: "mỗi job `mixed-nesting` tạo local pool tới `cpu-1` worker".
  Sai — job dùng 1 lõi.
- `multi_start.rs:20-25`: hàm ý pool đã có ở lớp gọi. Sai — chưa có.

### 1.3 Số đo xác nhận: CPU/Wall = 0,783 trên máy 16 luồng

Nguồn: `backend/.audit-tmp/production-final-source-acceptance/metrics-autofill-pont.json`
(acceptance run đã có sẵn trong repo, đo trên đúng file khách `test/test nesting.pdf`,
SHA-256 `EFCDE4F0…B257AB`, máy 32.528 MB RAM / 16 logical CPU).

| Chỉ số | Giá trị |
|---|---:|
| Cold solve (wall) | **23,778 s** |
| Cold solve (CPU) | 18,625 s |
| **CPU/Wall** | **0,783** |
| Native `stats.elapsedMs` | 22.358 ms |
| Warm cùng identity | 0,101 s |
| Render từ manifest | 2,707 s |

`CPU/Wall = 0,783` nghĩa là trong 23,8 giây đồng hồ, máy 16 luồng dùng **chưa tới một lõi**.
Trần lý thuyết nếu song song hoá hoàn hảo là ~20×, tức 23,8 s → ~1,5 s. **Dư địa là thật và rất lớn.**

---

## 2. Vì sao "nhiều luồng chạy trial rồi lấy tốt nhất" cho tăng tốc bằng 0

Đây là chỗ trực giác dễ sai, nên tôi đưa số trước.

Cùng acceptance run trên:

| Chỉ số tìm kiếm | Giá trị |
|---|---:|
| `search.trialsRun` | **0** |
| `search.trialsRejected` | 0 |
| `search.selectedCandidate.kind` | **`baseline`** |
| `stats.terminationReason` | `deadline` |
| `stats.orientationEvaluations` | 69 |
| `stats.attempts` | 78 |
| `stats.poseRefinements` | 76 |
| `budget.trialCount` | 4 |
| `budget.timeBudgetMs` | 3.000 |

Đọc bảng này cho ba kết luận:

1. **`trialsRun = 0`.** Không một trial nào hoàn tất. Phương án giao cho người dùng là
   **`baseline`** — greedy bottom-left, không phải nesting tối ưu.
2. **`poseRefinements = 76 > 0`.** Bộ đếm này chỉ tăng từ trial
   (`multi_start.rs`: `pose_refinements += trial.pose_refinements`), baseline không nạp vào đó.
   Nghĩa là **một trial ĐÃ chạy thật**, làm 76 lượt refine, rồi bị deadline cắt và
   **bị loại toàn bộ** ở chốt `stop_after_barrier && trial.completed_sweeps == 0`.
3. Vậy 22,36 s chia ra: **~19 s baseline + Direct-15 probe**, **~3 s trial bị ném đi**.

### 2.1 Phép tính cho phương án "4 luồng trial"

Deadline là **đồng hồ tường dùng chung** trong `RunControl`
(`control.rearm_deadline_after_baseline()` nạp lại đúng một mốc cho cả run):

| | Hiện tại | Nếu chạy 4 trial song song |
|---|---|---|
| Trial được cấp | 1 × 3.000 ms | 4 × 3.000 ms (cùng mốc) |
| Sweep hoàn tất mỗi trial | 0 | **0** |
| Trial được công bố | 0 | **0** |
| Phương án giao người dùng | baseline | **baseline** (y nguyên) |
| Wall time | ~23,8 s | **~23,8 s** |
| CPU đốt | 18,6 s | **~28 s** |

Kết quả: **output giống từng byte, thời gian chờ không đổi, CPU đốt thêm ~50%.**

Nguyên nhân gốc: trial không chậm vì thiếu luồng, nó chậm vì **giá một lượt đánh giá quá cao**.

```
22.358 ms / 69 orientation evaluation ≈ 324 ms cho MỘT lượt
```

Một sweep autofill phải chạm ≥44 instance. Sàn tuyệt đối cho một sweep:
`44 × 324 ms ≈ 14 s`. Profile `fast` cho phép tới 12 góc/part, xấu nhất
`44 × 12 × 324 ms ≈ 171 s`. Muốn một trial vừa cửa sổ 3 s cần nhanh hơn
**~50–60×**, không phải 4–16 luồng.

> **Kết luận cho chủ dự án:** hướng "nhiều luồng lấy phương án tốt nhất" là kiến trúc đúng
> về lâu dài, và engine đã được thiết kế sẵn cho nó (seed dẫn xuất theo `(root_seed, trial_id)`,
> `LayoutScore` có thứ tự toàn phần, `reduce_candidates` không phụ thuộc thứ tự gộp).
> Nhưng **làm nó trước** thì không thu được gì. Phải hạ giá một lượt đánh giá trước,
> hoặc song song hoá **bên trong** baseline — chỗ đang đốt 19/22 giây.

---

## 3. Chỗ thật sự đốt thời gian, và chỗ song song hoá được

### 3.1 Giả thuyết dẫn đầu: cold cache fill của NFP theo cặp hình

Số đo đã có trong `docs/BAO_CAO_PERF_NFP_CACHE_2026-08-28.md` §2.1, đo trong Rust `--release`:

| Đỉnh contour | Mảnh lồi | Chi phí **một** NFP |
|---|---:|---:|
| 24 | 7 | 0,44 ms |
| 96 | 32 | 96 ms |
| 127 | 43 | **510 ms** |
| 196 | 64 | **1.715 ms** |

Contour khách sau khi decimate 0,2 mm còn 49–171 đỉnh ⇒ mỗi NFP **0,1–1,7 giây**.

`NfpCache` cache theo **cặp hình đã chuẩn hoá**, nên mỗi cặp chỉ dựng **một lần** — lần đó
đắt, các lần sau chỉ là phép dịch. Với 13 mẫu, số cặp phải dựng ở lượt cold cỡ
`13×14/2 = 91` cặp (bỏ qua nhân theo góc, vì histogram đo được là `43×0° + 1×90°` —
gần như một góc duy nhất).

Phép nhân khớp rất sát:

```
~40–45 cặp phải dựng lần đầu × ~0,5 s ≈ 20–22 s   ≈ đúng 22,36 s đo được
```

**Nếu giả thuyết này đúng**, đây là tin tốt nhất trong cả báo cáo: ~40–90 lượt dựng NFP đó
**độc lập hoàn toàn với nhau**, và việc tính chúng song song **không thể** đổi kết quả —
nó chỉ điền trước một cache mà khoá là hình đã chuẩn hoá. Đúng ràng buộc tất định của dự án.

**Nhưng tôi chưa đo tách bạch.** Phần này là suy luận số học, không phải phép đo. Xem §6.

### 3.2 Vì sao cache decomposition từng không cho lợi ích — và không mâu thuẫn

`NEST-AUD-19` đã A/B cache decomposition: `7,9461 s` → `7,9486 s`, tức **không lợi**.
Điều đó **nhất quán** với §3.1: cache theo cặp đã có sẵn nên mỗi cặp chỉ decompose một lần rồi;
thêm một cache nữa cho cùng việc thì không bỏ được gì. Chi phí ưu thế nằm ở
**Minkowski + union + offset** của lần dựng đầu — mà cache cặp đã bao, và lần đầu đó
**vẫn phải trả, tuần tự, ở giữa vòng sweep**.

Nói cách khác: bài toán không phải "cache thêm", mà là **"trả cái giá lần đầu đó trên 15 lõi
thay vì 1 lõi"**.

### 3.3 Bốn điểm song song hoá được, xếp theo giá trị kỳ vọng

| # | Điểm | Vị trí | Có đổi layout? | Ghi chú |
|---|---|---|---|---|
| **P-1** | Dựng trước ma trận NFP theo cặp hình, song song, trước khi vào sweep | `nfp_cache.rs`, gọi từ `baseline.rs` / `solver.rs` | **Không** — chỉ điền cache | Ứng viên số 1. Cần đo §6 trước |
| **P-2** | Chuỗi `difference` theo batch 8 | `nfp.rs:~285` | **Không** — biến đổi đại số đúng | `A − ∪Bi = ∩k (A − Bk)`; difference song song rồi `intersection` reduce. Cần A/B: giá intersect có thể ăn hết lợi |
| **P-3** | Quét va chạm `placed_rings.iter().any(judge_pair…)` | `baseline.rs:~676` | **Không** | `par_iter().any()`; 44 ring × contour thật, chạy ở mỗi attempt |
| **P-4** | Trial song song + reduce | `multi_start.rs:409` | **Không** (reduce đã tất định) | **Chỉ làm SAU khi trial hoàn tất được ≥1 sweep.** Trước đó lợi ích = 0 (§2) |

Lưu ý ràng buộc khi làm P-1/P-3: `NfpCache` đang là `&mut` dùng riêng theo trial. Muốn song song
phải đổi sang hai pha (thu thập miss → tính song song → nạp) hoặc map đồng thời. **Không** được
biến nó thành cache toàn cục dùng chung giữa các trial — sẽ phá tính độc lập của trial mà
`multi_start` đang dựa vào để tất định.

Thêm: `NFP_CACHE_MAX_MB = 192.0` là trần LRU theo byte. Dựng trước 91 cặp có thể chạm trần và
evict đúng thứ vừa dựng. Phải kiểm trần trước khi triển khai P-1.

---

## 4. Phát hiện mới: đường preview, tách khỏi tốc độ kernel

Phần này audit ngày 2026-08-29 chưa soi. Đây là nơi có **quick-win rẻ nhất** cho đúng
triệu chứng "preview hiển thị quá lâu", và nó **không cần chạm Rust**.

### §PV-1 — P1 — Preview nesting không có admission nào

**Bằng chứng.** Grep `heavy_job_slot|run_scheduled_in_threadpool|scheduled_job|plan_hardware|assert_fits_memory`
trên cả bốn file của chuỗi preview — `nesting_preview_capacity.py`, `nesting_preview_session.py`,
`nesting_production_pipeline.py`, `nesting_production_orchestrator.py` — ra **0 match**.

`preview_layout` là `def` đồng bộ (`imposition.py:1717`), nên FastAPI đẩy vào AnyIO threadpool
(mặc định 40 token). Nhánh nesting (`:1800`) gọi `build_nesting_preview` → `get_or_solve` →
solve native **ngay trong thread đó**.

Hệ quả, đối chiếu với hai đường còn lại:

| Đường | Admission |
|---|---|
| Tool "Bình lồng ghép tự do" | `heavy_job_slot("mixed-nesting")` + `plan_hardware` + `assert_fits_memory` |
| Export tem/CNC (`/impose-start`) | `@scheduled_job("nup")` → whole-machine 1 suất |
| **Preview tem/CNC** | **không có gì** |

Chốt duy nhất là singleflight **theo identity key**. Khoá khác nhau ⇒ solve song song
không giới hạn. Trần phiên trên máy 32 GB là `max(6, 32528//4096) = 7`
(`nesting_preview_session.py:48-62`) ⇒ tới 7 lượt cold solve 24 giây có thể chồng nhau,
mỗi lượt giữ một token AnyIO.

### §PV-2 — P1 — Abort của browser không dừng solver; preview không có đường hủy

**Bằng chứng.** `solve_production_nesting` (`orchestrator.py:243`) và
`solve_production_nesting_job` (`pipeline.py:365`) **đều nhận** `cancel_event`.
Nhưng preview gọi `get_or_solve(job)` **không truyền kwargs** nào
(`nesting_preview_capacity.py`), và `NestingPreviewSessionStore._solve` chỉ chuyển tiếp
`**kwargs` (`nesting_preview_session.py:263-265`). Nên `cancel_event = None`.

Frontend có `AbortController` đầy đủ (`GridPreview.tsx:1042, 1465-1470, 1512-1518`), và
comment tại `:465-468` đã ghi đúng sự thật: *"solver sync không dừng chỉ vì browser abort request"*.

Ghép §PV-1 + §PV-2: mỗi lần người dùng đổi tham số trong lúc chờ, lượt cũ **vẫn chạy tới hết**
và lượt mới chạy thêm. Đây là cơ chế khiến preview **chậm dần theo số lần chỉnh** — khớp
chính xác triệu chứng người dùng báo.

### §PV-3 — P1 — Ô "Mã đơn"/"Vật liệu"/report nằm trong session identity ⇒ gõ chữ là cold solve

> **SỬA PHÂN LOẠI (cùng ngày, sau phản biện của chủ dự án).** Bản đầu của báo cáo này xếp
> §PV-3 vào lô PV-A "không chạm Rust". **Sai.** Mục này **bắt buộc** phải sửa trong Rust và
> bump `MIXED_NESTING_PRODUCTION_SCHEMA_VERSION`. Lý do ở §PV-3.3. Nó đã được chuyển sang
> lô riêng **RS-1** (§7).

#### PV-3.1 Triệu chứng và bằng chứng

`job_identity_key` gồm `_render_spec_key(job)` — canonical hoá
`trim`, `pont`, `cut`, `cut_style`, `artifact_options` (`nesting_preview_session.py:184-208`).
Phía UI, `layoutFetchKey` đưa `rd/rm/rl/rls/roc` (reportDisplay, material, lamination, orderCode)
vào khoá khi strategy là nesting (`GridPreview.tsx:1334-1341`).

Gõ một ký tự vào "Mã đơn" làm miss phiên ⇒ **solve lại từ đầu ~24 giây**.

Debounce nesting đã bị nâng 250 ms → 750 ms (`GridPreview.tsx:466-469`) để giảm đau triệu chứng
này. Đó là băng dán, không phải bản vá.

#### PV-3.2 Ai là chân lý: phân vai chính xác

Rust **là** chân lý — nhưng chân lý về **hình học**, không phải về **định nghĩa khoá cache**.
Phải tách rạch ròi, vì đây là chỗ tôi vừa lẫn:

| Việc | Chủ sở hữu | Bằng chứng |
|---|---|---|
| Tính `inputHash`, `layoutFingerprint` | **Python** | `nesting_production_adapter.py:2219-2244` (`canonical_sha256`) |
| Kiểm **định dạng** hai hash (`sha256:` + 64 hex thường) | Rust | `model.rs:1067-1070` |
| Echo hai hash vào manifest | Rust | `mixed_nesting_py.rs:362-363` |
| **Cưỡng chế** manifest echo == contract | **Rust** | `mixed_nesting_py.rs:468-475` |
| Placement/pose, collision, clearance, biên tờ, obstacle, quantity, stats | **Rust** | `validator.rs`, `validate_layout` |
| Áp căn cụm đúng một lần trước validator cuối | **Rust** | `multi_start.rs:200-260, 521-522` |
| Re-validate manifest đã có mà **không** solve lại | **Rust** | `MixedNestingRun.validate_manifest` |

Nói cách khác: Rust không tự nghĩ ra identity, nhưng **Rust là bên duy nhất được quyền nói
"manifest này thuộc về đúng lệnh này"**. Python đề xuất, Rust phê chuẩn. Bất biến
preview ≡ export đứng được là nhờ chốt ở dòng `mixed_nesting_py.rs:468-475`.

#### PV-3.3 Vì sao không thể tách khoá ở phía Python

`inputHash` hiện **gói cả** `renderBundleHash` (`nesting_production_adapter.py:2219-2226`):

```python
input_hash = canonical_sha256({
    "request": input_identity_request,
    "alignment": alignment,
    "renderBundleHash": render_bundle_hash,      # ← render bundle nằm TRONG input identity
    "solverConfigHash": solver_config_hash,
    "geometryConstraintsHash": geometry_constraints_hash,
})
layout_fingerprint = canonical_sha256({"inputHash": input_hash, ...})
```

Chuỗi phụ thuộc vì vậy là:

```
đổi "Mã đơn" → renderBundleHash đổi → inputHash đổi → layoutFingerprint đổi
             → manifest Rust đã ký KHÔNG còn khớp contract mới
             → mixed_nesting_py.rs:471-472 từ chối
             → buộc phải gọi Rust lại
```

Đây **không phải lỗi**. Đó chính là bất biến mà `NEST-AUD-06` được lập ra để bảo vệ: một
manifest **không bao giờ** được ghép với một render bundle khác. Bỏ `renderBundleHash` khỏi
`inputHash` ở phía Python để "tách khoá" là **tự tay mở lại đúng lỗ đó** — Python sẽ có thể
lặng lẽ ghép layout đúng với gia công sai, và Rust mất khả năng phát hiện.

Muốn tái dùng layout đã solve khi chỉ đổi report, contract phải **tự nó** phân biệt hai tầng —
tức `ProductionContractV1` cần thêm field. Mà struct đó khoá bằng
`deny_unknown_fields` (`model.rs:639-654`), và Python còn `_require_exact_fields` đối xứng
(`nesting_production_adapter.py:2290-2300`). Nên bắt buộc:

1. `model.rs` — tách `layoutIdentityHash` khỏi `renderBundleHash` trong `ProductionContractV1`.
2. `mixed_nesting_py.rs` — cưỡng chế echo **cả hai**, độc lập.
3. `MIXED_NESTING_PRODUCTION_SCHEMA_VERSION`: **2 → 3**, đồng bộ ở
   `mixed_nesting_service.py:34` và `model.rs`.
4. `maturin develop --release`.
5. **Mọi manifest đã lưu đều mất hiệu lực** — `layoutFingerprint` đổi công thức. Cần đường
   dọn kho `mixed_nesting_data`.

Effort thật: **L**, không phải M. Và phải có test parity Rust ⇄ Python cho schema v3 trước
khi nhận.

#### PV-3.4 Phương án rẻ hơn, giữ nguyên contract — cần đo trước

Nếu §6 cho thấy phần **pin + resolve geometry + build render bundle** rẻ so với solve (dự đoán:
đúng, vì `NEST-AUD-07` đã dedup pin còn 1 lần/13 trang), thì có một đường không đổi contract:

- Giữ `job_identity_key` y nguyên cho **phiên đã commit**.
- Thêm một cache tầng dưới, khoá bằng **`engine_request` đã bỏ `productionContract` và `jobId`**
  → giá trị là `placements` mà Rust vừa trả.
- Khi chỉ report đổi: dựng contract mới (hash mới), rồi gọi
  **`MixedNestingRun.validate_manifest`** trên placements cũ + request mới thay vì `solve`.

Đường này dùng đúng entry point re-validate mà Rust **đã có**, nên Rust vẫn là bên phê chuẩn.
Nhưng nó cần một thay đổi nhỏ ở Rust: hiện `validate_manifest` kiểm `manifest.input_hash ==
contract.input_hash`, mà manifest cũ mang hash cũ. Phải có đường "ký lại manifest cho contract
mới sau khi đã re-validate placements". **Vẫn là thay đổi Rust**, nhưng nhỏ hơn nhiều so với
PV-3.3 và **không** bump schema.

Tôi đề nghị so hai đường này ở một chốt riêng, sau khi có số của §6.

### §PV-4 — P2 — Cache layout phía client chỉ có MỘT entry

**Bằng chứng.** `layoutKeyRef` + `layoutCacheRef` là hai ref đơn (`GridPreview.tsx:1218-1220`),
hit tại `:1487-1499`. Bật/tắt qua lại giữa hai cấu hình ⇒ luôn miss ⇒ cold solve mỗi chiều.
Đổi sang LRU 8–16 entry là thay đổi cục bộ trong một file.

### §PV-5 — P2 — Preview là một POST chặn 24 giây, không tiến độ

**Bằng chứng.** Nhánh tem/CNC không có job, không polling, không WS — một POST đồng bộ
(`GridPreview.tsx:1672`). Người dùng thấy spinner suốt 24 giây, không phần trăm, không nút Hủy.

Đối chiếu: tool standalone "Bình lồng ghép tự do" **đã có** job + polling 400 ms
(`lib/mixed-nesting/api.ts:407`, `MixedNestingTool.tsx:179-201`). Hạ tầng tiến độ đã tồn tại,
chỉ chưa nối vào lane này.

Cơ hội kèm theo: vì phương án công bố **hiện là baseline** (§2), có thể **trả baseline ngay khi
xong** rồi cập nhật nếu trial thắng. Người dùng thấy tờ bình sau ~19 s thay vì 24 s, và thấy
tiến độ thật trong lúc chờ.

### §PV-6 — P1 — `_launch_impose_job` chặn event loop, `peek_or_wait` không timeout

**Bằng chứng.** `_launch_impose_job` là hàm **sync** (`imposition.py:890`), được gọi
**trực tiếp** từ ba `async def`: `:1093`, `:1099`, `:1105`. Không `to_thread`, không
`run_in_threadpool`.

Bên trong, `:1051-1057` → `attach_preview_session_reference`
(`nup_true_shape_nesting.py:641, 684`) → `peek_or_wait` → `inflight.completed.wait()`
**không timeout** (`nesting_preview_session.py:299-321`).

Hệ quả: bấm **Bình** khi preview cùng identity đang solve ⇒ **cả event loop sidecar đứng**
tới khi solve xong. Trong lúc đó `/nup-status`, health, và mọi tab khác đều không phản hồi.
Người dùng đọc trạng thái này là "phần mềm treo".

### §PV-7 — P2 — Chuỗi `points` của SVG dựng lại ở mỗi lần render, và `.flat()` nối mọi subpath

**Bằng chứng.** `die_polylines_for_placement` (`nup_artwork.py:1430-1459`) trả **một polyline
cho mỗi lệnh vẽ** — mỗi đoạn `'l'` thành một polyline 2 điểm riêng.

Frontend gộp tất cả vào **một** `<polygon>`:

```tsx
points={c.diePolylinesPx.flat().map((pt) => `${pt[0]},${pt[1]}`).join(" ")}
```

(`GridPreview.tsx:2740-2750`)

Hai vấn đề:

1. **Khối lượng.** Contour 171 đỉnh → ~171 polyline 2 điểm → `.flat()` cho ~342 cặp toạ độ
   (mỗi đỉnh trong bị nhân đôi). × 44 ô = ~15.000 cặp/tờ; CNC hai mặt vẽ **lại chính
   `svgCells`** (`:2261` `const cncBackCells = svgCells;`) ⇒ ~30.000. Và biểu thức này nằm
   **trong thân JSX**, không trong `useMemo` — nên nó chạy lại ở **mọi** re-render, kể cả
   hover hay phóng to, không chỉ khi layout đổi.
2. **Đúng/sai.** Khuôn có lỗ hoặc nhiều vòng kín sẽ bị nối liền thành một polygon ⇒ có đường
   nối lạ và fill sai. Chỉ ảnh hưởng **hiển thị** — file CUT xuất ra dùng contour thật, không
   qua đường này.

Sửa: đưa việc dựng chuỗi vào `svgCells` useMemo, gộp các polyline liền mạch thành ring, bỏ
điểm trùng liên tiếp, và vẽ `<path>` với một subpath mỗi ring + `fill-rule="evenodd"`.

---

## 5. Bảng phát hiện tổng hợp

Cột **Chạm Rust** nghĩa là có phải sửa file `.rs` và `maturin develop --release` lại hay không.
Nó là chỉ báo **rủi ro và chi phí**, không phải chỉ báo "có đi qua Rust hay không": **mọi**
lượt preview và export đều gọi Rust và đều bị Rust phê chuẩn, không có ngoại lệ nào.

| Mã | Nội dung | Mức | Effort | Chạm Rust? | Đổi layout? |
|---|---|---|---|---|---|
| §PV-1 | Preview nesting không có admission | P1 | S | Không | Không |
| §PV-2 | Preview không hủy được; abort client vô hiệu | P1 | S–M | Không — `cancel()`/`CancelToken` đã có sẵn | Không |
| §PV-6 | `_launch_impose_job` sync trên event loop + `peek_or_wait` vô hạn | P1 | S | Không | Không |
| §PV-4 | Cache layout client chỉ 1 entry | P2 | S | Không | Không |
| §PV-5 | Preview không có tiến độ/nút Hủy | P2 | M | Không — `handle.progress()` đã có sẵn | Không |
| §PV-7 | Chuỗi SVG dựng ở mỗi render; `.flat()` nối subpath | P2 | S | Không | Không (chỉ hiển thị) |
| **§PV-3** | Report/mã đơn trong session identity ⇒ cold solve khi gõ | P1 | **L** | **CÓ** — contract + schema v2→v3, hoặc đường re-sign ở §PV-3.4 | Không |
| §P-1 | Dựng trước ma trận NFP song song | P1 | M | **CÓ** | Không |
| §P-2 | Song song hoá chuỗi `difference` | P1 | M | **CÓ** | Không |
| §P-3 | `par_iter` cho quét va chạm | P2 | S | **CÓ** | Không |
| §P-4 | Trial song song | P2 | M | **CÓ** | Không — **nhưng lợi ích = 0 tới khi trial hoàn tất sweep** |
| §DOC-1 | Hai comment mô tả sai hiện trạng pool | P3 | S | **CÓ** (chỉ comment) | Không |

Bốn mục §P-* nằm trong `imposition_core`, tức **chính chân lý hình học**. Vì vậy mỗi mục
đều phải kèm regression chứng minh `placedCount` / `sheetCount` / `layoutFingerprint`
**không đổi** trên file khách — song song hoá mà đổi kết quả là hồi quy, không phải tối ưu.

Ba mục **đã đóng** trong audit trước, không mở lại: `NEST-AUD-01` (preview dùng chung
session), `NEST-AUD-06` (identity phủ render spec), `NEST-AUD-07` (pin một lần).

---

## 6. Việc phải làm TRƯỚC khi sửa: đo tách pha

Tôi từ chối đề xuất triển khai §P-1 mà chưa có số. Giả thuyết ở §3.1 khớp phép nhân, nhưng
lượt audit trước đã có **hai** prototype nghe rất hợp lý mà đo ra chậm hơn:

- `NEST-AUD-10`: prototype `feasible_region` append-only → chậm hơn **51–57%**.
- `NEST-AUD-19`: cache decomposition exact-shape → `7,9461 s` vs `7,9486 s`, không lợi.

Nên chốt đầu tiên là một **probe đo, không sửa** (~1 buổi, không đổi code sản xuất):

1. Đếm `NfpCache` hit / miss, và **tổng thời gian riêng của nhánh miss**.
2. Tổng thời gian riêng của chuỗi `difference` theo batch.
3. Tổng thời gian riêng của `judge_pair` clash scan.
4. Đối chiếu tổng ba khoản với `stats.elapsedMs = 22.358 ms`.

Kết quả quyết thứ tự lô:

- Miss NFP chiếm **>60%** ⇒ làm §P-1 trước, kỳ vọng 23,8 s → **~3–5 s**.
- `difference` chiếm **>40%** ⇒ làm §P-2 trước.
- Cả hai đều dưới 30% ⇒ giả thuyết sai, dừng lại báo cáo trước khi viết code song song.

---

## 7. Thứ tự lô đề xuất

Mỗi lô ≤5 file, verify xong mới sang lô kế (theo `prynx-audit-workflow`).

### Lô PV-A — đường preview, backend (không sửa file `.rs`)

Đây là lô tôi đề nghị làm **trước tiên**: rẻ nhất, rủi ro thấp nhất, không cần rebuild native,
và đánh đúng triệu chứng "preview quá lâu" mà không phụ thuộc kết quả probe §6.

Lô này **không** đổi bất cứ gì mà Rust quyết định. Nó chỉ đổi: **ai** được gọi Rust song song,
lời gọi có **hủy** được không, cùng một layout bị gọi lại **bao nhiêu lần**, và event loop có
đứng trong lúc chờ hay không. Hình học, manifest, `layoutFingerprint` giữ nguyên bit.

1. `backend/app/api/routes/imposition.py` — `preview_layout` nhận admission (§PV-1);
   `_launch_impose_job` đi `run_in_threadpool` (§PV-6).
2. `backend/app/core/nesting_preview_capacity.py` — truyền `cancel_event` xuống `get_or_solve`
   (§PV-2).
3. `backend/app/core/nesting_preview_session.py` — `peek_or_wait` có timeout (§PV-6);
   `_solve` chuyển tiếp `cancel_event`.
4. `backend/app/core/heavy_job_scheduler.py` — thêm kind `nesting-preview`, RAM-gate:
   `<8GB` → 1, `<16GB` → 1, `≥16GB` → 2. **Không** hard-cap máy mạnh (rule #1).
5. `backend/tests/test_nesting_preview_admission.py` — mới.

**§PV-3 đã bị loại khỏi lô này** — xem lô RS-1.

### Lô PV-B — đường preview, frontend

1. `desktop/src/components/imposition-tools/sections/GridPreview.tsx` — LRU cache (§PV-4);
   dựng chuỗi SVG trong `useMemo` + `<path>` theo ring (§PV-7).
2. Test vitest tương ứng.

Debounce nesting **giữ 750 ms** cho tới khi §PV-3 xong. Hạ về 250 ms trước đó chỉ làm tăng
số lượt cold solve.

### Lô NF-0 — probe đo, KHÔNG sửa sản xuất (§6)

Chốt duyệt bắt buộc. Không có số thì không sang NF-1. Probe này cũng đo luôn chi phí
**pin + resolve geometry + build render bundle** để quyết §PV-3 đi đường PV-3.3 hay PV-3.4.

### Lô NF-1 — song song hoá kernel theo kết quả probe

§P-1 hoặc §P-2 trong `imposition_core`. Bắt buộc kèm:

- `cargo test imposition_core` xanh toàn bộ;
- regression trên file khách: `placedCount = 44`, `sheetCount = 1`,
  `layoutFingerprint = sha256:45382db3…4ebe2` **không đổi**;
- A/B wall-clock trên máy rảnh tải, `N ≥ 5`.

### Lô NF-2 — §P-3, §DOC-1

### Lô RS-1 — §PV-3, tách layout identity khỏi render identity

Lô nặng nhất và cần duyệt riêng. Chọn một trong hai đường ở §PV-3.3 / §PV-3.4 dựa trên số
của NF-0. Bắt buộc có test parity Rust ⇄ Python và đường dọn kho manifest cũ nếu bump schema.

### Lô NF-3 — §P-4 (trial song song)

**Chỉ mở khi** đã có bằng chứng một trial hoàn tất ≥1 sweep trong ngân sách. Trước đó
lô này không mang lại gì (§2).

---

## 8. Giới hạn của báo cáo này

- Số cold/warm/render ở §1.3 và §2 lấy từ acceptance run **đã có sẵn** trong repo, không
  phải lượt đo mới của tôi. Đó là `N=1`, không phải p50/p95.
- §3.1 là **suy luận số học**, chưa phải phép đo tách pha. §6 tồn tại chính vì điều này.
- Chưa chạy `pytest`, `vitest`, `cargo test` trong lượt audit này — báo cáo read-only,
  không sửa code nên không có gì để verify.
- Chưa đo trên máy yếu (`<8GB`, `<16GB`). Mọi cap đề xuất ở lô PV-A đã viết theo thang RAM
  của rule #1, nhưng cần đo lại khi triển khai.
- §PV-7 phần "fill sai khi có lỗ" suy từ hợp đồng `die_polylines_for_placement`; tôi chưa
  dựng một khuôn có lỗ để chụp ảnh đối chiếu.
- Bản đầu của báo cáo này xếp §PV-3 vào lô "không chạm Rust". Đó là **sai**, đã sửa ở §PV-3
  và §7 sau phản biện của chủ dự án. Ghi lại ở đây thay vì xoá dấu, để lần sau không ai đọc
  lại kết luận cũ.
- Đường PV-3.4 tôi chưa xác minh xem `MixedNestingRun.validate_manifest` có thể ký lại
  manifest cho contract mới hay chỉ kiểm rồi trả void. Đọc `mixed_nesting_py.rs:427-475` thì
  nó **chỉ kiểm**, nên PV-3.4 vẫn cần thêm entry point. Cần đọc kỹ hơn ở lô RS-1.
