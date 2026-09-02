# Báo cáo audit hiệu năng và sức mạnh Nesting theo đường bế — Bình Tem nhãn/CNC

Ngày audit: **2026-08-29**

Audit unit: **W2-U09 / W7-U11 — True-shape nesting Tem bế/CNC**

Baseline Git: `8bc0a219b2ec53cc9cc06adb4b9a7cd11c341dff`, nhánh
`codex/pre-release-audit-2026-08-04`, trên **working tree đang có thay đổi chưa commit**.

Trạng thái: **RE-AUDIT SAU TRIỂN KHAI — ARTIFACT DIRECT-15 ĐẠT CĂN GIỮA; HIỆU NĂNG CHƯA ĐẠT**.

> Cập nhật cuối ngày 2026-08-29: các số `23–25 s / 46 placement` trong baseline audit
> ban đầu đã bị thay thế bởi phép đo artifact production cuối có ốc/vùng cấm và căn giữa.
> Nguồn sự thật hiện tại là §3.1. Probe xoay dùng NFP mất khoảng `122 s` đã bị loại;
> phương án **Direct-15** (tối đa 15 pose hậu kiểm contour trực tiếp) được giữ.

> Snapshot chốt mới: native cô lập build từ source cuối có identity
> `97b3f0e41e7450c7513ae426a2131458ba29abe2e935ec32e25e05cb7636fec4`, SHA-256 `.pyd`
> `110D6DE8761E474D9BAD030DC254183C21ABAE1868FEE4EF2225A981F8D4DA41`. Acceptance production
> trên đúng input đạt cold `23,778 s`, warm `0,101 s`, render `2,707 s`; đây mới là số hiện
> hành. Số `74,736 s` được giữ làm baseline lịch sử trước tối ưu, không còn mô tả source cuối.

## 1. Kết luận điều hành

Lõi mới có nền móng tốt: contract chặt, source pin chống TOCTOU, manifest có provenance,
validator độc lập NFP và baseline bảo đảm phương án công bố không tệ hơn baseline **nội bộ**.
Lô mới đã nối preview vào cùng session/manifest, đưa ốc thành fixed obstacle, thêm warm-start
xoay Direct-15 và căn toàn cụm đúng một lần trước final validator. Artifact cuối chứng minh
bố cục 44 tem đã nằm giữa vùng dùng được với sai lệch tâm dưới `0,074 mm` trên mỗi trục.

Tuy vậy, **không được diễn giải kết quả correctness này thành đạt hiệu năng**: cold path cuối
vẫn mất `23,778 s`, CPU/Wall `0,783`, smart trial vẫn không hoàn tất, kernel vẫn tuần tự và
mỗi orientation vẫn dựng miền bằng toàn bộ blocker ở hot path. Tổng thời gian đã giảm khoảng
`68,2%` so với baseline `74,736 s`, nhưng vẫn trượt KPI cold `<=5 s`.

Kết luận ngắn nhất:

> Engine hiện đã **đúng artifact và đúng căn giữa hơn**, nhưng vẫn **chưa nhanh**. Direct-15
> cứu được một góc xoay 90° mà không quay lại NFP probe 122 giây; bottleneck thật còn nằm ở
> baseline/NFP tuần tự, phân rã lồi lặp và phép difference nhận toàn bộ blocker.

| Trục đánh giá | Điểm audit | Kết luận |
|---|---:|---|
| An toàn contract/validator/provenance | **8/10** | Nền tảng tốt, nên giữ |
| Correctness của artifact Direct-15 | **7/10** | Preview/session, obstacle và căn giữa đã có bằng chứng artifact; duplex/fulfillment còn phải giữ gate |
| Sức mạnh tìm kiếm | **4/10** | Có NFP/free-angle nhưng beam/restart/diversity chưa đúng sức quảng bá |
| Chất lượng bố cục thực đo | **4/10** | Có lợi ở mixed/interlock; thua nặng solver chuyên dụng ở tam giác |
| Tốc độ và khai thác phần cứng | **3/10** | Cold giảm còn 23,778 s nhưng vẫn trượt KPI; CPU/Wall 0,783; NFP quét toàn blocker |
| Sẵn sàng phát hành | **HOLD** | Cờ release đang `false`; phải giữ nguyên tới khi đóng KPI |

Không có finding P0 được gán trong trạng thái hiện tại vì build production đang khóa cả
frontend lẫn backend tại `build_production.ps1:407-408`. Nếu mở rollout, các finding về
CNC duplex, fulfillment, gate S&R và cold performance trở thành **release blocker trực tiếp**.
Preview/session, boong và căn giữa đã có bằng chứng đóng riêng trong §3.1 và §5.

Hướng nâng cấp mạnh nhất không phải bỏ solver cũ để dùng một generic solver cho mọi hình.
Kiến trúc nên là **portfolio solver**:

1. heuristic chuyên dụng circle/triangle/grid/rectangle tiếp tục làm floor;
2. baseline NFP nhanh làm floor cho mixed/contour lạ;
3. cardinal và free-angle smart search tranh thắng;
4. chỉ công bố ứng viên tốt nhất đã qua cùng validator.

Như vậy PrynX vừa giữ tốc độ ở hình chuẩn, vừa có sức mạnh thật ở interlock/mixed shape.

## 2. Phạm vi và đường chạy production đã trace

```text
GridPreview.tsx
  └─ POST /imposition/preview-layout
       └─ build_nesting_preview
            └─ get_or_solve(session)
                 └─ cùng production adapter / Rust solver / manifest

/imposition/nup-start
  └─ process N-Up
       └─ run_nup_engine
            └─ run_true_shape_nesting
                 └─ build_true_shape_nesting_job
                 └─ pin source → resolve contour → packing footprint
                 └─ production adapter → PyO3 → Rust mixed_nesting
                      ├─ baseline
                      ├─ multi-start trials (hiện tuần tự)
                      ├─ NFP/cache/refine/score
                      └─ validator độc lập
                 └─ manifest → vector PDF writer → artifact
```

Các điểm vào chính:

- UI gửi preview: `desktop/src/components/imposition-tools/sections/GridPreview.tsx:1488-1913`.
- Route preview: `backend/app/api/routes/imposition.py:1705-2803`.
- Export rẽ vào lane mới: `backend/app/workers/nup_engine.py:275-291`.
- Entry production: `backend/app/workers/nup_true_shape_nesting.py:248-564`.
- Pipeline pin/geometry/solve/render: `backend/app/core/nesting_production_pipeline.py:323-528`.
- PyO3 nhả GIL và gọi solver: `native/src/mixed_nesting_py.rs:190-291`.
- Baseline + Direct-15 + trial + publication/alignment:
  `imposition_core/src/mixed_nesting/multi_start.rs:167-585`.
- NFP hot path: `imposition_core/src/mixed_nesting/nfp.rs:223-286`.
- Final validator: `imposition_core/src/mixed_nesting/validator.rs:215-613`.

## 3. Số đo trên đúng file `test/test nesting.pdf`

Theo yêu cầu của chủ dự án, audit đã chạy trực tiếp trên:

| Thuộc tính | Giá trị |
|---|---|
| File | `D:\pdfcompare\test\test nesting.pdf` |
| SHA-256 | `efcde4f0a16aca0a5a54ee2d952945afe2eb70dd2073bc9ff59ee87292b257ab` |
| Kích thước | 1.002.883 byte |
| Số mẫu/trang | 13 |
| Tờ | 320 × 430 mm |
| Lề | 5 mm mỗi cạnh |
| Gap | 2 × 2 mm |
| Intent | tự lấp đầy một tờ |
| Production profile | `fast` |
| Ngân sách khai báo | 3.000 ms |
| Máy đo | Windows, 32.528 MB RAM, 16 logical CPU, tier `>=16GB` |

### 3.1 Artifact production cuối — Direct-15

Đây là phép đo được giữ để nghiệm thu hiện trạng. Input và output được khóa bằng identity;
không lấy số từ preview schematic hay từ probe bị loại.

Phương pháp: nạp native source cuối cô lập từ
`D:\pdfcompare\backend\.audit-tmp\native_probe_final_source_env` ở đầu `PYTHONPATH`; mỗi
root upload/results/nesting-data đều tách riêng. Cold được đo với kho session rỗng, warm lặp
lại đúng identity, render được đo riêng từ manifest authoritative. Cùng process gọi lại
`MixedNestingRun.validate_manifest`; preview cold/warm được so từng cell và render phải khớp
`manifestId`, `layoutFingerprint`, `renderBundleHash`.

| Thuộc tính | Giá trị |
|---|---|
| Input SHA-256 | `EFCDE4F0A16ACA0A5A54EE2D952945AFE2EB70DD2073BC9FF59EE87292B257AB` |
| Native build identity | `97b3f0e41e7450c7513ae426a2131458ba29abe2e935ec32e25e05cb7636fec4` |
| Native `.pyd` SHA-256 | `110D6DE8761E474D9BAD030DC254183C21ABAE1868FEE4EF2225A981F8D4DA41` |
| Manifest ID | `cec3e885f6e7045dbb62d1b810ecde0f` |
| Layout fingerprint | `sha256:45382db3482f950ac3301e785eb3ad33f3edd5e91083a252cc76282c4084ebe2` |
| Output SHA-256 | `AF0A18EAF2EFE099EAE7C57D0B418213C05AD519DC170B7DB244A0A189677B80` |
| Số placement | **44 tem** |
| Histogram góc | **43 × 0°**, **1 × 90°** |
| Placement xoay | `trang-10#0004` |
| Candidate công bố | baseline portfolio Direct-15; `trialsRun=0` |
| Source pin | **1 pin / 13 trang**, hash/byte/page metadata khớp input |
| Validator/parity | native revalidation đạt; cold=warm cells; preview=render identity |

Kiểm hình học trên chính contour của artifact:

| Mép/tâm | Sai số tới vùng dùng được |
|---|---:|
| Trái | `0,104674 mm` |
| Phải | `0,169896 mm` |
| Dưới | `4,074998 mm` |
| Trên | `4,221251 mm` |
| Lệch tâm X | **`0,032611 mm`** |
| Lệch tâm Y | **`0,073127 mm`** |

Hai cặp mép gần đối xứng và độ lệch tâm nhỏ hơn `0,074 mm`; vì vậy phản ánh “dồn về mép
dưới” đã được đóng trên artifact Direct-15. Căn giữa được áp sau khi chọn candidate tại
`multi_start.rs:200-260,521-522`, rồi toàn bộ pose được final validator kiểm lại. Solver vẫn
tìm theo bottom-left trong hot path nên thay đổi này không mở rộng không gian tìm kiếm.

### 3.2 Thời gian cold/warm/render của artifact cuối

| Pha | Wall time |
|---|---:|
| Cold solve + dựng session | **`23,778 s`** |
| Native `stats.elapsedMs` trong cold | **`22,358 s`** |
| Warm cùng session/identity | **`0,101 s`** |
| Render artifact từ manifest | **`2,707 s`** |
| CPU/Wall cold | **`0,783`** |

So với artifact baseline `74,736 s`, cold giảm `68,2%`. Các mốc trung gian cùng input là
`72,369 s` sau direct-difference trước pin dedup và `30,940 s` sau pin dedup trên native liền
trước; source cuối còn `23,778 s`. Warm/render đã đạt KPI tương ứng, nhưng cold vẫn **không
đạt** KPI `<=5 s`. Đây là một acceptance run, chưa đủ `N>=10` để gọi là p50/p95.

CPU/Wall `0,783` và code trial tuần tự tiếp tục cho thấy máy 16 luồng chưa được khai thác.
`timeBudgetMs=3000` không phải SLA end-to-end vì baseline/portfolio chạy trước cửa sổ smart
trial; lượt cuối vẫn `terminationReason=deadline`, `trialsRun=0`.

Probe xoay phiên bản đầu gọi lại NFP mất khoảng **122 s** và đã bị loại khỏi code lẫn số đo
nghiệm thu. Direct-15 hiện thử tối đa `3 góc × 5 anchor = 15 pose`, broad-phase bbox rồi
hậu kiểm contour trực tiếp (`baseline.rs:713-727,800-801,862-919`). Kết quả 90° nói trên đến
từ Direct-15; không được dùng lượt probe 122 s để báo tốc độ production.

### 3.3 Chất lượng/tốc độ trên corpus đại diện

| Ca | Solver nền/chuyên dụng | Rust mới | Chênh chất lượng | Chênh tốc độ |
|---|---:|---:|---:|---:|
| Tem tròn autofill | 45 con; p50 0,0109 s | 46 con; 3,089 s | **+2,2%** | khoảng 283× chậm hơn |
| Gang 5 mẫu | 22 con; p50 0,0049 s | 23 con; 1,351 s | **+4,5%** | khoảng 276× chậm hơn |
| Chữ L interlock, Fast | 24 con; p50 0,0097 s | 24 con; 1,839 s | **0%** | khoảng 190× chậm hơn |
| Chữ L interlock, Balanced | 24 con | 27 con; 26,277 s | **+12,5%** | rất chậm nhưng chứng minh giá trị interlock |
| CNC tam giác autofill | 152 con; 0,168–0,278 s | 86 con; 5,922 s | **−43,4%** | khoảng 21–35× chậm hơn |

Finding quan trọng nhất về “sức mạnh” là ca tam giác: generic NFP không được phép thay một
heuristic chuyên dụng đang vừa nhanh hơn vừa xếp dày hơn. Floor hiện tại chỉ là baseline
nội bộ của Rust, không phải phương án tốt nhất đang có trong PrynX.

### 3.4 Profile không có tính đơn điệu chất lượng/thời gian

| Ca | Fast | Balanced | Kết quả chất lượng |
|---|---:|---:|---|
| S20 | 2,367 s | 31,848 s | cùng 20 placement, cùng utilization 0,2369 |
| Constraints | 0,320 s | 5,505 s | không chứng minh lợi ích tương ứng |
| CNC tam giác | 5,922 s | 9,764 s | cùng 86 con |

Balanced có thể đắt hơn 13,5× mà không tốt hơn. Work budget hiện đếm orientation/candidate
gần như đồng giá, trong khi chi phí thật phụ thuộc số mảnh lồi, số blocker, số đỉnh và số
lần refine.

## 4. Những gì engine đang làm tốt

1. **Contract và fail-closed tốt.** Input có giới hạn, protocol/version rõ và lỗi hình học
   được gom có cấu trúc.
2. **Validator độc lập solver.** Pose cuối được kiểm rigid transform, miền góc, biên tờ,
   fixed obstacle, overlap, clearance, quantity và thống kê trước publication.
3. **Baseline guard.** Mỗi run có một floor hợp lệ; candidate invalid không được sửa nhẹ
   rồi công bố.
4. **Tính tất định đã được thiết kế sẵn cho parallel reduce.** Seed dẫn xuất, score
   fixed-point và total order cho phép gộp trial không phụ thuộc thứ tự.
5. **Hình học thực sự mạnh hơn grid.** NFP qua convex decomposition + Minkowski + union,
   hỗ trợ contour lõm, rotation fixed/discrete/ranges/free và refine tọa độ/góc liên tục.
6. **Provenance/artifact chắc.** Source pin, input hash, layout fingerprint, native
   revalidation, render từ manifest và commit sau artifact là kiến trúc đúng.
7. **NFP shape cache đã có.** Cache tránh dựng lại NFP hình học cho các instance cùng shape;
   đây là cải thiện lớn cần giữ khi đổi kiến trúc.
8. **Publication alignment đã fail-safe.** Rust dịch cả cụm đúng một lần theo tờ, final
   validator kiểm lại biên/obstacle/overlap; nếu phép căn chính xác không hợp lệ thì giữ
   candidate cũ thay vì công bố pose hỏng (`multi_start.rs:200-260,521-565`).

## 5. Findings `[CONFIRMED]` và trạng thái re-audit

### NEST-AUD-01 — `[CLOSED]` — Preview dùng cùng solver/session

Route hiện rẽ `true_shape_nesting` vào `build_nesting_preview`, `get_or_solve` tạo session
và export có thể render lại manifest đã ký. Warm artifact cuối còn `0,101 s`, manifest
`cec3e885f6e7045dbb62d1b810ecde0f`. Bằng chứng code:
`imposition.py:1778-1804`, `nesting_preview_capacity.py:184-267`,
`nup_true_shape_nesting.py:499-541`.

### NEST-AUD-02 — P1 — CNC hai mặt bị hạ thành simplex

UI có `cncTwoSided`, `cncFlipEdge`, `cncDuplexMarks`, nhưng
`build_true_shape_nesting_job()` không map các field này và không gán `back_page_index`.
Job thực đo trả:

```text
duplex_mode='simplex'
flip_edge='none'
duplex_registration=False
parts=[(0, None)]
```

Bằng chứng: `nup_true_shape_nesting.py:303-368`, mặc định pipeline tại
`nesting_production_pipeline.py:121-124`, bundle simplex tại
`nesting_imposition_bundle.py:781-788`.

### NEST-AUD-03 — `[CLOSED]` — Boong/ốc đã là fixed obstacle

`build_pont_obstacles` materialize vùng cấm trước solve và pipeline truyền chúng vào contract;
artifact Direct-15 có cấu hình ốc cho 44 placement đã qua validator. Bằng chứng:
`nup_true_shape_nesting.py:281-288,338-378`, `nesting_production_pipeline.py:379-392`.

### NEST-AUD-04 — P1 — Trần cứng 200 tờ phá hợp đồng fulfillment

`MAX_SHEETS_CEILING=200`, trong khi UI/API nhận quantity tới 1.000.000; `unplaced` sau đó
chỉ thành cảnh báo. Một đơn hợp lệ cần hơn 200 tờ có thể hoàn tất artifact nhưng thiếu số
lượng. Bằng chứng: `nup_true_shape_nesting.py:43-53,283-301,394-400`.

### NEST-AUD-05 — P1 — Strategy persisted có thể lách gate gang-only

UI ẩn option khi rời gang nhưng không reset `gridStrategy`; preset/state giữ lại giá trị.
Payload export không gửi `taskMode`, backend chỉ chặn một số spelling của S&R và không chặn
`layoutType='repeat'`. Bằng chứng:

- `trueShapeNestingRollout.ts:51-72`;
- `GridSettingsSection.tsx:517-535`;
- `processHandlers.ts:268-369`;
- `nup_true_shape_nesting.py:75-107`.

Điều này đặc biệt nguy hiểm vì ca tam giác S&R đo được 86 thay vì 152 con.

### NEST-AUD-06 — `[CLOSED]` — Session identity đã khóa cấu hình render/gia công

`job_identity_key()` hiện gồm fixed obstacle, duplex và `_render_spec_key()` canonical hóa
`trim`, `pont`, `cut`, `cut_style`, `artifact_options`. Bằng chứng:
`nesting_preview_session.py:107-197`.

### NEST-AUD-07 — `[CLOSED]` — Production pin cùng PDF đúng một lần trong job

Pipeline hiện dedup theo canonical source path trước khi pin; 13 page binding vẫn riêng nhưng
cùng dùng một locator/snapshot. Acceptance source cuối ghi **1 pin / 13 trang**, content hash,
byte size và metadata page count đều khớp input; reset preview thu hồi sạch pin provisional.
Cold giảm từ `72,369 s` trước dedup xuống `30,940 s` trên native liền trước.

Bằng chứng: `nesting_production_pipeline.py`, `test_nesting_production_pipeline.py` và metrics
`backend/.audit-tmp/production-final-source-acceptance/metrics-autofill-pont.json`.

### NEST-AUD-08 — P1 — Máy mạnh vẫn chạy gần một lõi

Planner có thể báo 15 worker nhưng production gọi thẳng một native `solve`; kernel chạy
`for plan in plan_trials(...)` tuần tự. Không có Rayon/local pool hoặc worker grant trong
chữ ký solver.

Bằng chứng: `mixed_nesting_jobs.py:351-370`,
`nesting_production_orchestrator.py:238-286`, `mixed_nesting_py.rs:219-246`,
`multi_start.rs:20-25,400-501`. Số đo artifact cuối CPU/Wall **0,783** xác nhận production
chưa khai thác máy 16 luồng. Đây vẫn là bottleneck P1, chưa đóng.

### NEST-AUD-09 — P1 — “Fast 3 giây” không phải SLA wall-clock

Production hard-code `profile='fast'` và 3.000 ms cho mọi tier. Baseline chỉ kiểm cancel,
không chịu deadline; deadline được re-arm sau baseline. Tổng thời gian là baseline không
giới hạn + tối đa cửa sổ trial, và một thao tác NFP dài vẫn có thể vượt checkpoint.

Bằng chứng: `nup_true_shape_nesting.py:43-53,338-368`, `baseline.rs:318-410`,
`multi_start.rs:337-398`. Trên artifact cuối, 3 giây thành **23,778 giây cold** và
`trialsRun=0`. Direct-15 không dùng NFP nhưng vẫn nằm trước khi re-arm deadline; vì vậy
không được quảng bá profile Fast là SLA 3 giây.

### NEST-AUD-10 — `[PARTIAL]` P1 — NFP/refine vẫn quét toàn blocker

Cache tránh dựng lại NFP hoàn chỉnh khi cặp shape hit, nhưng mỗi orientation vẫn dịch NFP
cho mọi placed item, gom toàn bộ blocker rồi gọi một phép `difference` trên cả tập. Worktree
hiện đã bỏ `union_many` trung gian và trừ blocker theo batch 8, có checkpoint deadline/cancel
giữa batch. Regression so tập hợp direct-difference với đường union→difference cũ đạt; native
source cuối đã được benchmark production. Thay đổi này chỉ bỏ một phép Boolean — nó không bỏ
vòng lặp blocker, số path clip hoặc chi phí dựng NFP trên cache miss. `SpatialGrid` chỉ nằm ở
validator, không ở search; refine vẫn scan mọi placed ring.

Bằng chứng hiện tại: `nfp.rs:223-289`, `refine.rs:72-84,181-195`,
`validator.rs:443-504`, `mixed_nesting_deadline_in_region.rs`. Direct-15 chỉ tránh gọi NFP
trong probe xoay; phần quét blocker của baseline/smart trial vẫn mở. Cold cuối `23,778 s`
chứng minh finding chỉ đóng một phần.

Một prototype `feasible_region` append-only, giữ nguyên batching Boolean 8 blocker, đã được
A/B rồi **không giữ**. Baseline hiện hành mất khoảng `7,946 s`; hai lượt prototype mất
`12,007 s` và `12,499 s`, chậm hơn lần lượt `51,1%` và `57,3%`, trong khi kết quả vẫn là
`44` placement, `63` attempt và `65` orientation evaluation. Số đo này chỉ bác bỏ biến thể
incremental thuần vừa thử, không đóng `NEST-AUD-10`: chi phí duy trì/preview miền lớn hơn
phần quét blocker tiết kiệm được. Nếu quay lại Lô B6, incremental phải đi cùng spatial
index/locality và regression chứng minh không đổi tập ứng viên.

Verify sau khi hoàn nguyên vẫn giữ đúng `44` placement, `63` attempt và `65` orientation
evaluation. Ba lượt wall-clock tại thời điểm máy đang có tải nền cho `19,042 s`, `17,514 s`
và `14,854 s`; lượt cuối dùng `11,922 s` CPU (`CPU/Wall=0,802`), trong khi mẫu CPU toàn máy
ở mức `32–39%`. Các lượt này xác nhận correctness nhưng **không dùng để đảo kết luận A/B**
vì bị nhiễu tải; đồng thời chúng cho thấy cold baseline hiện rất nhạy với tranh chấp CPU và
vẫn chưa thể coi là nhanh.

### NEST-AUD-11 — P1 — Search semantics yếu hơn tên beam/multi-start

- Solver dừng khi góc đầu tiên có pose: `solver.rs:262-265,406-409`.
- Mỗi instance giữ một `best` rồi commit ngay; không có beam nhiều layout state.
- `beam_width` chỉ giới hạn số đỉnh candidate: `candidates.rs:275-287`.
- `multi_start_restarts` có trong effort/manifest nhưng không có consumer hữu hiệu.
- `edge_midpoint_candidates` có code/test nhưng solver không gọi.

Hệ quả: góc 0° có thiên vị lớn, không có lookahead để hy sinh lựa chọn cục bộ nhằm tăng
yield toàn tờ, và manifest mô tả sức tìm kiếm mạnh hơn implementation thật.

### NEST-AUD-12 — P1 — Angle diversity sụp trên contour nhiều đỉnh

`candidate_angles` nạp edge normals trước MAB/cardinal/low-discrepancy rồi truncate theo
budget 12/32/96. Contour nhiều cạnh có thể lấp hết budget trước phần seed-dependent, khiến
các trial gần trùng nhau. Bằng chứng: `candidates.rs:151-189`.

### NEST-AUD-13 — P1 — Generic solver không có floor từ heuristic tốt nhất PrynX

Baseline guard chỉ so với baseline Rust nội bộ. Ca CNC tam giác chứng minh reachable:
heuristic chuyên dụng 152 con, Rust Fast/Balanced 86 con. Đây là nguyên nhân kiến trúc khiến
việc thay solver chuyên dụng bằng generic solver có thể hồi quy tới 43,4% capacity.

### NEST-AUD-14 — P1 — Work budget không phản ánh chi phí hình học

Orientation/candidate được charge gần như một đơn vị, dù một lần NFP có thể chứa hàng nghìn
convex-pair/segment/blocker operation và refine quét nhiều vòng. Một `RunControl` chung cho
toàn run còn cho trial đầu ăn phần lớn quota. Bằng chứng: `solver.rs:194-254`,
`nfp.rs:243-286`, `refine.rs:181-211,376-398`, `multi_start.rs:239-340`.

### NEST-AUD-15 — P2 — Clearance dị hướng bị nén thành `hypot`

Production định nghĩa gap theo trục tờ `(xMm,yMm)`, final validator kiểm theo trục, nhưng
candidate/NFP đổi thành khoảng vô hướng `hypot(x,y)`. Ví dụ `(2,0,5)` thành 2,062 mm và bỏ
các pose hợp lệ có khoảng Y từ 0,5 đến 2,062 mm.

Bằng chứng: `normalize.rs:349-365,459-465`, `validator.rs:451-475`. An toàn va chạm nhưng
giảm mật độ không cần thiết.

### NEST-AUD-16 — P2 — Progress hiện không phản ánh công việc thật

Native chủ yếu đứng ở 5% rồi nhảy 95%; backend lại nhân `progress` với quantity và ghi `N/M`,
UI diễn giải là số trang/con đã bình. Bằng chứng: `mixed_nesting_py.rs:223-243`,
`nup_true_shape_nesting.py:403-446`, `processHandlers.ts:491-495`.

### NEST-AUD-17 — P2 — Benchmark hiện hữu chưa đo đúng production

`lo0_nesting_baseline.py` chỉ lặp solver cũ; smart solver chạy một lần. Với quantity, harness
ép smart còn một tờ rồi suy số tờ, nên không đo last-sheet composition, fulfillment,
`maxSheets`, cold/warm p50/p95 hay peak RAM per job. Bằng chứng:
`scripts/lo0_nesting_baseline.py:971-1057,1107-1117,1273-1283`.

### NEST-AUD-18 — `[CLOSED]` — Khoá NFP cache giữ đúng offset quanh pivot

Khoá moving hiện lượng tử hoá trong hệ local quanh reference point thay vì bỏ offset theo
bbox-min; obstacle vẫn chuẩn hoá rồi dịch kết quả theo vị trí tờ. Regression dùng cùng outline
với hai pivot khác nhau so cached-vs-fresh đạt, nên không còn alias miền ứng viên.

Bằng chứng: `nfp_cache.rs` và test
`cache_khong_alias_hai_moving_cung_outline_khac_pivot` trong
`mixed_nesting_deadline_in_region.rs`.

### NEST-AUD-19 — P1 — Phân rã lồi lặp lại theo từng cặp shape trên cache miss

`NfpCache` chỉ cache NFP hoàn chỉnh theo cặp. Mỗi pair miss vẫn đi qua `no_fit_polygon`, rồi
chạy `convex_decompose(stationary)` và `convex_decompose(-moving)` trước mọi phép Minkowski.
Với nhiều design, cùng một contour bị triangulate/greedy-merge lại cho nhiều cặp khác nhau;
cache cặp không loại được chi phí này. Artifact 13 design đi qua ít nhất 65/69 orientation.

Bằng chứng: `nfp.rs:134-164`, `nfp_cache.rs:186-195`, baseline autofill tại
`baseline.rs:592-704`; artifact §3.1 ghi `orientationEvaluations=69`. Một prototype cache
decomposition exact-shape đã được test A/B rồi **không giữ**: baseline `7,9461 s` trước và
`7,9486 s` sau, tức không có lợi đo được nhưng tăng RAM. Bằng chứng mới bác giả thuyết đây là
quick-win; chi phí ưu thế nằm ở Minkowski/union/difference. Nếu quay lại cache này phải có
profile chứng minh và budget byte theo hardware grant, không hard-cap máy >=16 GB.

### NEST-AUD-20 — P2 — Cache bị làm nóng lại và validator chấm lặp cùng candidate

Baseline autofill sở hữu một `NfpCache`, mỗi smart trial lại tạo cache riêng; trial đầu phải
làm nóng lại ma trận cặp mà baseline vừa trả giá. Candidate baseline/probe/trial được validate
trước khi tranh điểm, publication alignment validate thêm một lần và final publication lại
validate toàn layout. Các fence correctness là cần thiết, nhưng có thể tái dùng chứng cứ cho
candidate bất biến và chỉ revalidate phần thay đổi sau alignment.

Bằng chứng: `baseline.rs:611-649`, `solver.rs:133-216,445-481`, và các điểm
`validate_layout` tại `multi_start.rs:254,294,365,483,569`. Không được bỏ final validator;
quick-win là chia sẻ cache immutable/decomposition và loại validation thật sự trùng, có test
chứng minh publication fence vẫn giữ nguyên.

## 6. `[EXPECTED]` capability gaps — không gọi là bug

1. Production đang cố ý khóa cardinal qua `_CARDINAL_ROTATION_POLICY`; continuous rotation
   chỉ mở bằng cổng server-owned sau acceptance riêng.
2. Hole được bảo toàn cho CUT/artifact nhưng collision/score hiện coi outer là vật liệu đặc;
   V1 chưa cho nesting vào hole.
3. Reflection bị cấm để không lật artwork; CNC mirror cần một hợp đồng nghiệp vụ riêng.
4. Đây là anytime heuristic, không có chứng chỉ global optimum.
5. Release flag đang `false` ở cả frontend/backend; đây là quyết định HOLD đúng.

## 7. `[SUSPECTED]` / proof gaps còn mở

Không gán severity cho các mục dưới đây trước khi có forward test:

1. Discrete rotation có hơn budget góc: góc duy nhất vừa tờ nằm cuối danh sách có thể không
   bao giờ được thử.
2. NFP cache key có thể alias hai shape cùng hình nhưng khác reference point/pivot; cần so
   cached/uncached manifest.
3. Validator kiểm prefix `partId#` nhưng chưa chứng minh ordinal instance canonical.
4. Hai request giống nhau đồng thời có thể solve kép vì `get_or_solve()` solve ngoài lock;
   cần singleflight test có barrier.
5. Cancel live N-Up đang terminate/kill process; chưa đo pin/artifact rác và cancel p95.
6. Chưa có ETW/flamegraph hoặc peak native allocation cho contour 100–733 đỉnh.
7. Chưa chạy Tauri runtime/installer hoặc in/cắt vật lý artifact có boong thật.

## 8. Kết quả verify trong audit

| Nhóm | Kết quả |
|---|---|
| `imposition_core` Rust source cuối | **334 passed, 0 failed** |
| Native source cuối cô lập + backend session/pipeline/ốc | **295 passed, 0 failed**, 1 warning Pydantic |
| `py_compile` module thay đổi liên quan | **6/6 đạt** |
| Frontend typecheck | **PASS** |
| Frontend rollout/dropdown liên quan | **46 passed, 0 failed** |
| Artifact PDF source cuối | **44 placement**, 43×0° + 1×90°, native revalidation + render visual đạt |
| Benchmark artifact cuối | cold **23,778 s**, warm **0,101 s**, render **2,707 s**, CPU/Wall **0,783** |
| Source pin cleanup | **1 pin / 13 trang**, reset xong không còn snapshot provisional |
| `git diff --check` phạm vi sửa | **PASS** |

Không chạy toàn bộ backend, full frontend, Tauri runtime, build production, installer hay cắt
vật lý trong chốt re-audit này. Test và artifact trên chứng minh đúng phạm vi source cuối;
chúng không chứng minh các finding CNC duplex/fulfillment đã đóng và đặc biệt **không chứng
minh tốc độ đã đạt**.

## 9. Roadmap đề xuất — mỗi lô tối đa 5 file

### Lô A1 — `[ĐÃ TRIỂN KHAI/RE-AUDIT]` Preview và export dùng cùng session/manifest

Hiện `/preview-layout` đã gọi `get_or_solve`; warm cùng identity đo được `0,101 s`. Vẫn cần
giữ vertical route test Tem + CNC và singleflight/cancel để không solve kép khi request chồng.

1. `backend/app/api/routes/imposition.py`
2. `backend/app/core/nesting_preview_session.py`
3. `backend/app/workers/nup_true_shape_nesting.py`
4. `desktop/src/components/imposition-tools/sections/GridPreview.tsx`
5. một file test vertical mới hoặc hiện hữu

### Lô A2 — CNC duplex contract

Map cặp Front/Back, flip edge, duplex registration và xuất Front/Back/Cut đúng thứ tự;
artifact test trên PDF duplex thật. Tối đa 5 file.

### Lô A3 — `[MỘT PHẦN ĐÃ ĐÓNG]` Obstacle đạt; fulfillment còn mở

Ốc/boong đã thành fixed obstacle và artifact 44 placement qua validator. Phần còn lại là bỏ
ceiling 200 vô điều kiện, hoặc preflight báo rõ số lượng thiếu trước render.

### Lô A4 — `[IDENTITY ĐÃ ĐÓNG; GATE/SINGLEFLIGHT CÒN MỞ]`

Identity đã bao toàn `trim/pont/cut/cutStyle/artifactOptions`. Còn phải reset effective
strategy khi rời gang, gửi `taskMode`, chặn mọi spelling S&R và thêm concurrency
singleflight/cooperative cancel.

### Lô B1 — `[ĐÃ TRIỂN KHAI/RE-AUDIT]` Pin một source revision đúng một lần

Một PDF được snapshot/hash/inspect một lần; 13 page binding dùng chung locator. Acceptance
ghi 1 pin/13 trang và cleanup sạch; cold giảm `72,369 s → 30,940 s` ở chốt A/B của lô này.

### Lô B2 — Hardware grant xuyên production

Đưa RAM tier/worker grant từ scheduler vào production request/run context. Máy `>=16GB`
dùng `cores-1`; chỉ `<8GB` và `<16GB` mới giảm. Chưa parallel trong lô plumbing này.

### Lô B3 — Parallel trial tất định

Local Rayon pool theo grant, trial ID/work quota cố định, cache/RAM per worker có budget,
reduce bằng `LayoutScore` total order. Không dùng shared wall-clock để đòi bit-identical.

### Lô B4 — Search semantics thật

Không dừng ở góc đầu tiên, có beam nhiều layout state, hiện thực hoặc xóa
`multi_start_restarts`, nối edge midpoint và quota riêng cho MAB/cardinal/edge/seeded angles.

### Lô B5 — Weighted budget, progress và cache theo byte

Charge convex-pairs/blocker-rings/segment checks/refine rounds; chia quota tối thiểu cho mỗi
trial; progress theo barrier hoàn chỉnh; cache LRU theo byte/RAM grant với hit/miss/eviction.

### Lô B6 — Spatial/incremental NFP

Spatial index cho refine/narrow phase; blocked region tăng dần hoặc contact candidates lười,
không `union_many` toàn blocker ở mỗi góc. Đây là lô tiềm năng 10–100× nhưng có thể đổi layout,
nên phải có golden/benchmark và duyệt riêng.

Không triển khai kiểu “gom mọi đỉnh NFP rồi hậu kiểm lười” đơn giản: prototype harness trên
đúng file audit đã vượt **60 s** trước khi hoàn tất vì `contact vertex × contour validation`
bùng nổ, tệ hơn baseline. Hướng B6 phải là blocked-region **incremental có spatial index**,
không phải bỏ Boolean rồi quét toàn bộ contact.

Prototype append-only thuần cũng đã chậm hơn baseline `51–57%` (§NEST-AUD-10), nên không
triển khai lại nếu chưa có spatial index và A/B mới.

### Lô C1 — Portfolio solver

Đưa circle/triangle/grid/rectangle/legacy nesting vào cùng candidate set với generic NFP;
mọi candidate qua validator chung. Generic solver chỉ được thắng, không được làm giảm floor.

### Lô C2 — Clearance dị hướng và capability nâng cao

Candidate/NFP dùng Minkowski rectangle theo trục; sau khi tốc độ/floor đạt mới cân nhắc
continuous rotation production, hole nesting và CNC reflection theo policy tường minh.

## 10. KPI chặn rollout

### Correctness/artifact

- Preview và export cùng `manifestId`, `layoutFingerprint`, sheet count và từng instance pose.
- CNC duplex luôn có Front/Back/Cut đúng thứ tự và đúng phép lật.
- `unplaced=0` cho job quantity hợp lệ; không artifact `completed` nhưng thiếu.
- Không placement nào giao boong/guide/dấu canh; validator độc lập xác nhận.
- Cancel p95 `<=1 s`; không final manifest, artifact hoặc source pin rác.

### Chất lượng

- Mỗi case canonical **không kém best solver hiện hữu**, không chỉ baseline Rust.
- Tam giác giữ floor **>=152 con** trên đúng fixture đã đo.
- Chữ L phải strict-improve **>24 con** trong profile được công bố.
- Profile Balanced/Tight không được chậm hơn mà cùng hoặc kém quality trên corpus gate.
- Orientation diversity: Jaccard angle-set giữa trial khác seed `<0,8` trên contour 100+ đỉnh.

### Tốc độ/phần cứng trên máy chuẩn 16 logical CPU / 32 GB

- Preview warm p95 `<=2 s`.
- Export `fast` p95 `<=5 s`; `balanced` p95 `<=10 s` trên corpus chuẩn 13 mẫu.
- Speedup `>=3×` ở 4 worker và `>=6×` ở 8 worker trên S20/fixed-work-plan.
- Máy `>=16GB` dùng tối đa `cores-1`; không hard-cap worker/cache vô điều kiện.
- Peak RSS nằm trong hardware grant; đo 1 job và 2 heavy jobs đồng thời.

### Benchmark/provenance

- `N>=10` cold và `N>=10` warm, báo p50/p95/min/max.
- Tách thời gian pin/inspect, normalize, NFP, search, validate và render.
- Ghi CPU model/tier RAM/worker grant/engine build identity/source SHA-256.
- Benchmark quantity phải chạy đúng multi-sheet production, không suy số tờ từ một tờ.

## 11. Kết luận re-audit và chốt tiếp theo

Đề xuất duyệt theo thứ tự:

1. Đóng phần còn lại của **A2, A3 fulfillment và A4 gate/singleflight**.
2. **B2–B3** để lấy thắng lợi tốc độ tiếp theo: luồn hardware grant và parallel trial tất định.
3. **B4–B6** để nâng sức tìm kiếm và đổi kiến trúc NFP có kiểm soát.
4. **C1** để bảo đảm PrynX luôn giữ solver tốt nhất cho từng họ hình.
5. **C2** chỉ mở sau khi mọi KPI floor/tốc độ/artifact đã đạt.

Artifact Direct-15 được giữ vì đạt ba điều: 44 tem hợp lệ, có đúng một pose 90° và cụm nằm
giữa với `|dx| <= 0,032611 mm`, `|dy| <= 0,073127 mm`. NFP rotation probe 122 giây bị loại.

Tuy nhiên, kết luận hiệu năng vẫn là **KHÔNG ĐẠT**: cold `23,778 s`, CPU/Wall `0,783`,
`trialsRun=0`; trial còn tuần tự và mỗi orientation vẫn quét toàn blocker. Source cuối nhanh
hơn baseline `68,2%`, nhưng chưa đủ để mở rollout. Cho tới khi KPI §10 đạt và các blocker còn
lại đóng, cờ release phải tiếp tục `false`. Re-audit này không cập nhật golden và không build
installer.
