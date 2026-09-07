# Bình tem bế — triển khai A1–A2, 2026-09-07

## Phạm vi đã duyệt

Người dùng duyệt “ok triển khai đi” sau đề xuất A1–A2 trong [báo cáo audit](D:/pdfcompare/docs/BAO_CAO_AUDIT_BINH_TEM_BE_PREVIEW_THUC_THI_HIEU_NANG_2026-09-07.md). Hai mục cùng phụ thuộc raw-layout cache nên triển khai trong một lô backend: sửa canonical, verify, rồi singleflight và verify tiếp.

**Đã triển khai ở mức source + AUTO; artifact chỉ xác nhận phạm vi mô tả dưới đây, chưa Tauri/installer.** Không sửa B–F, không đổi solver/worker/quality, không commit. Giữ nguyên mọi thay đổi có trước hoặc do phiên khác tạo trong workspace.

Đúng 5 file của lô, kể cả tài liệu:

1. backend/app/api/routes/imposition.py
2. backend/tests/test_preview_export_canonical_parity.py
3. backend/tests/test_preview_layout_singleflight.py
4. Nhật ký này.
5. docs/PRYNX_MASTER_AUDIT_MATRIX.md

## A1 — §TEMPERF.C1: một hệ tọa độ cho cache single/batch

Batch dùng canonical_page_space như preview đơn, nhưng khóa vẫn theo file/revision gốc. Canonical được tạo một lần cho batch, dùng cho document chính và từng worker; ExitStack chỉ dọn file sau khi mọi worker đã kết thúc và đóng QPDF handle.

Test thêm dùng hai trang độc lập, khác kích thước, không dùng chung content stream. Phủ Rotate 0/90/180/270, UserUnit=2, MediaBox origin, CropBox và hai thứ tự single→batch/batch→single; kiểm nguồn không đổi, khóa ổn định, không rewrite nguồn đã canonical. Phủ cleanup khi compute, mở worker hoặc mở document chính lỗi.

- Baseline matrix: **12 failed / 4 passed**.
- Sau A1: **34 passed** trong toàn file, 3,88 s.
- Không đổi hình học solver hoặc cập nhật golden.

## A2 — §TEMPERF.1: cùng khóa chỉ có một owner tính

Thêm _get_or_compute_sticker_layout dùng Future theo khóa. Lock chỉ giữ metadata; compute, chờ và deepcopy ngoài lock. Các khóa khác vẫn tính song song. Cache, owner và follower sở hữu dict/list riêng.

- BaseException/InterruptedError/ValueError hoặc deepcopy lỗi đều đánh thức follower, dọn flight và cho phép retry.
- Cùng thread gọi đệ quy cùng khóa bị từ chối ngay; không tự chờ chính mình.
- Không thêm timeout/cap/pool. Route legacy vẫn sync, không tuyên bố HTTP abort dừng compute.
- Khóa dùng float thật truyền solver, không round ba chữ số: gap 1,0001 và 1,0004 không được dùng chung kết quả.
- Chụp SourceFingerprint có sẵn trước canonicalization, kiểm trước/sau compute, cache copy/follower wait và trước response. Nguồn đổi trả 409; batch không nuốt lỗi thành capacity 0 thành công.
- Fingerprint này là metadata (path/size/mtime_ns/device/inode), **không phải content hash** và không chứng minh chống sửa nội dung cố tình giữ nguyên mọi metadata.
- Chỉ raw-layout lane mới cần fingerprint mới; không thêm công cho preview N-up lưới khác.
- Cache nóng/follower không mở thêm document worker khi không cần né ốc. Khi né ốc hoạt động vẫn mở Page canonical riêng, giữ đúng hậu xử lý và đóng tài nguyên. Không cache sức chứa sau ốc.

Test singleflight: **30 passed**, gồm 4 ca lazy-open (không ốc/tắt va chạm/cluster chỉ một root QPDF; ốc hoạt động có hai worker riêng). Kiểm source đổi ngay sau materialize, zero compute, HTTP 409 và không rò temp.

## Đo A/B

PDF thật: test/cac loai hinh - Copy.pdf, mẫu DUMBBELL trang index 13, tờ 320×430 mm, lề 3 mm, gap 2 mm, không ốc. Gọi route bodies thật, cùng model/compute/PDF; baseline route lấy từ Git HEAD trước sửa, nạp dưới module riêng trong RAM. Không viết lại source để đo.

Hai warm-up + 20 mẫu/nhánh, thứ tự before/after đảo xen kẽ; mọi response cùng SHA-256, sức chứa 30. Không HTTP/Tauri; không phải đo toàn preview Auto/True-shape của PDF 17 mẫu. Mỗi lần cold xóa raw-layout cache; warm đã prefill trước timer.

| Máy/cấu hình | Kịch bản | Before median | After median | Số compute |
|---|---|---:|---:|---|
| Mặc định, máy 32 GB/16 logical CPU | Single + batch cold đồng thời | **841,210 ms** | **400,287 ms** | 2→1, đủ 20/20 |
| Mặc định | Single rồi batch cold tuần tự | 371,801 ms | 369,369 ms | 1→1 |
| Mặc định | Single + batch warm đồng thời | 59,537 ms | 59,992 ms | 0→0 |
| Env worker thấp | Cold đồng thời | 827,244 ms | 386,716 ms | 2→1 |
| Env worker thấp | Cold tuần tự | 358,647 ms | 374,522 ms | 1→1 |
| Env worker thấp | Warm đồng thời | 58,651 ms | 61,184 ms | 0→0 |

**Ca trùng cold mặc định giảm 52,4% (khoảng 2,10×).** Không dùng con số này làm speedup toàn tính năng. Warm mặc định xấp xỉ 60 ms, chênh median 0,455 ms; không tuyên bố mọi sample nhanh hơn. Cấu hình env thấp vẫn có tăng median nhỏ ở tuần tự/warm; không che các số này.

Env thấp: STICKER_MAX_WORKERS=2, PRYNX_NUP_WORKERS=2, PRYNX_MAX_HEAVY_JOBS=1 trong process benchmark rồi khôi phục. Đây **không mô phỏng RAM vật lý thấp**; workload preview này không đi heavy slot/pool N-up. Cần máy thật tier thấp để mở rộng bằng chứng.

Lượt đầu N=5 từng thấy warm 60,140→71,404 ms. Đã kiểm chi phí normalize fingerprint (~2 ms/16 lần) rồi loại mở QPDF worker thừa; bảng trên là rerun N=20 sau điều chỉnh, không chọn bỏ kết quả xấu. Không giảm chất lượng/worker để tạo tốc độ.

## Verify cuối và artifact

- Backend 11 file liên quan: **142 passed**, 2 warning thư viện hiện hữu, 16,22 s.
- Trong đó canonical + singleflight: **64 test** (34 + 30).
- npm run typecheck trên Windows: **pass**.
- py_compile 3 file Python: **pass**.
- git diff --check các file tracked của lô: **pass**, chỉ warning LF/CRLF của Git.
- Không full build, native/sidecar rebuild, full backend suite hoặc golden update.
- Hậu kiểm PDF thật với Rotate=90, hai mẫu, chế độ optimal_auto: **4 trang, 13 ô ở preview mẫu đầu, 156/156 điểm dọc cạnh CUT khớp raster 144 DPI** trong bán kính 2 px. Cold preview và preview được batch prime bằng nhau; nguồn không đổi, MediaBox 520×420 pt. Đã soi PNG CUT. Đây không thay thế Tauri frontend hoặc nghiệm thu CNC duplex.

### Khoảng trống phát hiện khi kiểm artifact — không che thành pass

Một probe khác dùng simple_auto có 12 ô preview nhưng writer tạo bố cục khác; chỉ 48/144 điểm mẫu khớp. Đã nạp route baseline HEAD trước sửa và xác nhận cold preview cũ **bằng chính xác** cold preview hiện tại; nup_engine không bị sửa trong lô này. Code full-layout tại nup_engine.py:1081 vẫn truyền strategy='optimal_auto'. Có thể tái hiện từ script artifact cuối nhật ký bằng cách đổi cả request strategy và export gridStrategy sang simple_auto.

Vì vậy đây không phải hồi quy do A1–A2. Giữ là vấn đề/hợp đồng cần truy vết riêng ở S&R simple_auto (bao gồm thiết lập thực từ UI), chưa tự sửa thuật toán hoặc nâng thành kết luận toàn app. Không dùng việc artifact optimal_auto đạt để đóng khoảng trống simple_auto này.

## Kiểm tra tay còn lại

Reload backend/bản dev rồi kiểm với file người dùng:

1. Chọn Bình tem bế thường; đổi trang có Rotate/UserUnit và chờ bảng sức chứa. Preview không đổi hướng sau khi batch xong.
2. Đổi gap nhanh, quay về gap cũ; nguồn đang đổi phải báo chạy lại, không nhận kết quả cũ.
3. Bật/tắt ốc bế; layout raw dùng lại nhưng sức chứa sau né ốc vẫn cập nhật.
4. Nhiều tab/file cùng lúc vẫn độc lập; đợt này chưa sửa việc bảng sức chứa chạy ở tab nền.
5. Bấm Bình trong optimal_auto và kiểm PDF thực. Chưa nghiệm thu Tauri/installer hoặc simple_auto ở mục khoảng trống.

Theo prynx-audit-workflow, cần xác nhận thao tác thật trước khi sang lô mới. Các phần log CUT, tab nền, polygon context, index writer và nạp manifest vẫn chưa triển khai.

## Dữ liệu tái hiện

Các dãy thời gian sau gồm 22 phần tử: hai warm-up đầu và 20 mẫu đo. computeCalls trong summary chỉ gồm 20 mẫu đo. Source fixture và response hash cố định; không lưu một số trung vị đơn lẻ thay raw data.

```json
{
  "baselineHead": "79f05a399cb1669e6fb7cd1b84babfcbc7e3aebc",
  "source": "D:\\pdfcompare\\test\\cac loai hinh - Copy.pdf",
  "sourceSha256": "018d6cd297deacb983c1472c01335f5a5c3df5adb1e3e9f1666aa093cff80730",
  "scope": "real legacy route bodies in one isolated process; interleaved before/after; no HTTP/Tauri; no source rewrite; low_env does not simulate physical RAM",
  "allResultsExact": true,
  "resultSha256": "88cf0290b2b024c24d502c32bfb8ac7de5340f80c561bc045d1869f44d05ef6c",
  "sourceFiles": [
    {
      "path": "backend/app/api/routes/imposition.py",
      "sha256": "E5D4F5B74ACF75867095024D08A19472D9F0B917F99A63282E2B32E4832B5AE4"
    },
    {
      "path": "backend/tests/test_preview_export_canonical_parity.py",
      "sha256": "62953CA07D0213CA6CCF3C47BC98918016485676D3D5B548DE7E47FF66878DCE"
    },
    {
      "path": "backend/tests/test_preview_layout_singleflight.py",
      "sha256": "61CA3BAB81FB9C22040C261FFC094C86D9B3D0F4A521A7B23A43B3DED2C95560"
    }
  ],
  "rows": [
    {
      "tier": "default",
      "scenario": "concurrent_cold",
      "variant": "before",
      "n": 20,
      "medianMs": 841.21,
      "minMs": 769.865,
      "maxMs": 1233.646,
      "computeCalls": [
        2,
        2,
        2,
        2,
        2,
        2,
        2,
        2,
        2,
        2,
        2,
        2,
        2,
        2,
        2,
        2,
        2,
        2,
        2,
        2
      ],
      "wallMsIncludingTwoWarmups": [
        1184.033,
        833.76,
        955.629,
        899.379,
        1233.646,
        870.306,
        841.343,
        820.477,
        818.224,
        860.113,
        871.21,
        922.625,
        894.014,
        769.865,
        802.467,
        804.707,
        881.297,
        822.166,
        838.631,
        832.439,
        793.827,
        841.078
      ]
    },
    {
      "tier": "default",
      "scenario": "concurrent_cold",
      "variant": "after",
      "n": 20,
      "medianMs": 400.287,
      "minMs": 375.466,
      "maxMs": 478.347,
      "computeCalls": [
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1
      ],
      "wallMsIncludingTwoWarmups": [
        386.989,
        405.493,
        478.347,
        400.857,
        405.267,
        412.019,
        399.717,
        397.151,
        375.466,
        407.524,
        391.073,
        412.998,
        443.827,
        388.161,
        377.093,
        390.65,
        401.966,
        414.142,
        381.172,
        390.467,
        427.633,
        386.311
      ]
    },
    {
      "tier": "default",
      "scenario": "sequential_cold",
      "variant": "before",
      "n": 20,
      "medianMs": 371.801,
      "minMs": 356.069,
      "maxMs": 462.768,
      "computeCalls": [
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1
      ],
      "wallMsIncludingTwoWarmups": [
        369.991,
        402.146,
        415.779,
        462.768,
        413.768,
        357.944,
        412.938,
        374.386,
        367.617,
        370.777,
        358.449,
        380.083,
        381.887,
        362.075,
        386.666,
        380.266,
        356.069,
        372.825,
        356.841,
        362.135,
        370.484,
        357.536
      ]
    },
    {
      "tier": "default",
      "scenario": "sequential_cold",
      "variant": "after",
      "n": 20,
      "medianMs": 369.369,
      "minMs": 352.731,
      "maxMs": 416.648,
      "computeCalls": [
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1
      ],
      "wallMsIncludingTwoWarmups": [
        361.77,
        440.244,
        416.648,
        357.613,
        393.144,
        415.177,
        386.999,
        352.731,
        361.004,
        379.679,
        356.667,
        407.984,
        385.128,
        392.691,
        370.229,
        358.462,
        413.543,
        368.509,
        365.516,
        365.283,
        364.681,
        361.444
      ]
    },
    {
      "tier": "default",
      "scenario": "concurrent_warm",
      "variant": "before",
      "n": 20,
      "medianMs": 59.537,
      "minMs": 53.515,
      "maxMs": 84.985,
      "computeCalls": [
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0
      ],
      "wallMsIncludingTwoWarmups": [
        59.26,
        69.6,
        84.985,
        71.055,
        58.935,
        56.212,
        62.209,
        74.301,
        57.289,
        58.777,
        76.889,
        60.488,
        60.139,
        61.646,
        56.37,
        82.389,
        57.98,
        58.766,
        53.515,
        54.117,
        79.206,
        54.392
      ]
    },
    {
      "tier": "default",
      "scenario": "concurrent_warm",
      "variant": "after",
      "n": 20,
      "medianMs": 59.992,
      "minMs": 54.766,
      "maxMs": 89.646,
      "computeCalls": [
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0
      ],
      "wallMsIncludingTwoWarmups": [
        54.148,
        79.918,
        62.515,
        89.646,
        62.058,
        66.149,
        81.572,
        54.766,
        58.596,
        59.155,
        55.428,
        82.342,
        60.217,
        58.36,
        78.964,
        60.845,
        57.486,
        59.768,
        55.514,
        80.348,
        58.283,
        58.469
      ]
    },
    {
      "tier": "low_env",
      "scenario": "concurrent_cold",
      "variant": "before",
      "n": 20,
      "medianMs": 827.244,
      "minMs": 793.263,
      "maxMs": 1016.464,
      "computeCalls": [
        2,
        2,
        2,
        2,
        2,
        2,
        2,
        2,
        2,
        2,
        2,
        2,
        2,
        2,
        2,
        2,
        2,
        2,
        2,
        2
      ],
      "wallMsIncludingTwoWarmups": [
        825.653,
        835.562,
        804.336,
        819.263,
        844.073,
        850.339,
        817.088,
        960.478,
        1016.464,
        846.408,
        812.467,
        798.272,
        793.263,
        825.367,
        851.115,
        829.121,
        824.28,
        801.535,
        833.255,
        838.952,
        834.223,
        825.08
      ]
    },
    {
      "tier": "low_env",
      "scenario": "concurrent_cold",
      "variant": "after",
      "n": 20,
      "medianMs": 386.716,
      "minMs": 370.571,
      "maxMs": 431.691,
      "computeCalls": [
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1
      ],
      "wallMsIncludingTwoWarmups": [
        373.116,
        379.672,
        386.338,
        385.295,
        406.139,
        431.691,
        414.084,
        401.854,
        408.339,
        381.667,
        377.171,
        387.61,
        372.143,
        405.196,
        371.197,
        383.39,
        398.959,
        380.348,
        385.924,
        408.794,
        370.571,
        387.094
      ]
    },
    {
      "tier": "low_env",
      "scenario": "sequential_cold",
      "variant": "before",
      "n": 20,
      "medianMs": 358.647,
      "minMs": 348.206,
      "maxMs": 467.216,
      "computeCalls": [
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1
      ],
      "wallMsIncludingTwoWarmups": [
        393.494,
        363.844,
        359.26,
        381.536,
        362.803,
        356.015,
        404.627,
        393.645,
        467.216,
        348.206,
        358.033,
        413.921,
        354.123,
        354.562,
        352.507,
        352.435,
        357.425,
        356.333,
        392.495,
        389.424,
        352.177,
        367.181
      ]
    },
    {
      "tier": "low_env",
      "scenario": "sequential_cold",
      "variant": "after",
      "n": 20,
      "medianMs": 374.522,
      "minMs": 347.94,
      "maxMs": 456.7,
      "computeCalls": [
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1
      ],
      "wallMsIncludingTwoWarmups": [
        369.833,
        390.134,
        391.362,
        359.943,
        364.129,
        378.619,
        456.7,
        396.283,
        404.132,
        379.106,
        383.38,
        354.651,
        365.005,
        356.06,
        356.541,
        354.284,
        347.94,
        383.23,
        393.21,
        370.425,
        386.812,
        359.596
      ]
    },
    {
      "tier": "low_env",
      "scenario": "concurrent_warm",
      "variant": "before",
      "n": 20,
      "medianMs": 58.651,
      "minMs": 53.19,
      "maxMs": 130.2,
      "computeCalls": [
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0
      ],
      "wallMsIncludingTwoWarmups": [
        59.268,
        78.971,
        55.503,
        54.972,
        58.302,
        58.577,
        130.2,
        61.375,
        60.373,
        54.845,
        62.879,
        79.971,
        58.726,
        56.791,
        75.58,
        53.19,
        54.197,
        58.172,
        60.961,
        81.901,
        70.569,
        54.629
      ]
    },
    {
      "tier": "low_env",
      "scenario": "concurrent_warm",
      "variant": "after",
      "n": 20,
      "medianMs": 61.184,
      "minMs": 54.545,
      "maxMs": 97.222,
      "computeCalls": [
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0
      ],
      "wallMsIncludingTwoWarmups": [
        61.885,
        57.056,
        78.377,
        54.545,
        60.129,
        54.889,
        62.924,
        97.222,
        64.309,
        60.467,
        89.56,
        59.076,
        60.767,
        58.851,
        63.477,
        86.138,
        58.026,
        59.503,
        83.443,
        61.602,
        80.202,
        58.847
      ]
    }
  ]
}
```

<details>
<summary>Script benchmark đã dùng (chạy bằng venv từ thư mục backend)</summary>

```python
import os,sys,json,time,types,subprocess,threading,hashlib,statistics,logging
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from app.api.routes import imposition as after
from app.workers import nup_sticker
from tests.license_helpers import PRO_LICENSE
logging.disable(logging.CRITICAL)
before=types.ModuleType('app.api.routes.imposition_a1a2_baseline')
before.__file__=str(Path('app/api/routes/imposition.py').resolve())
sys.modules[before.__name__]=before
source_code=subprocess.check_output(['git','show','79f05a399cb1669e6fb7cd1b84babfcbc7e3aebc:backend/app/api/routes/imposition.py'],text=True,encoding='utf-8')
exec(compile(source_code,before.__file__,'exec'),before.__dict__)
source=Path('../test/cac loai hinh - Copy.pdf').resolve()
source_sha=hashlib.sha256(source.read_bytes()).hexdigest()
common=dict(path=str(source),usable_w=314*2.83465,usable_h=424*2.83465,item_w=50*2.83465,item_h=80*2.83465,gap_x=2*2.83465,gap_y=2*2.83465,strategy='optimal_auto',sheet_w=320*2.83465,sheet_h=430*2.83465,margin_left=3*2.83465,margin_right=3*2.83465,margin_top=3*2.83465,margin_bottom=3*2.83465,task_mode='step_repeat',layout_type='repeat',grouping_strategy='none',is_die_cut=True,shape_type='DUMBBELL',shape_props={},page_idx=13,bleed=0)
original=nup_sticker.compute_sticker_layout_for_page
calls=0
counter_lock=threading.Lock()
def counted(*args,**kwargs):
    global calls
    with counter_lock:
        calls+=1
    return original(*args,**kwargs)
nup_sticker.compute_sticker_layout_for_page=counted
rows=[]
expected_hash=None
env_names=('STICKER_MAX_WORKERS','PRYNX_NUP_WORKERS','PRYNX_MAX_HEAVY_JOBS')
saved={name:os.environ.get(name) for name in env_names}
try:
    for tier in ('default','low_env'):
        for name in env_names:
            if tier=='low_env':
                os.environ[name]='1' if name=='PRYNX_MAX_HEAVY_JOBS' else '2'
            elif saved[name] is None:
                os.environ.pop(name,None)
            else:
                os.environ[name]=saved[name]
        for iteration in range(22):
            variants=(('before',before),('after',after))
            if iteration%2:
                variants=variants[::-1]
            for scenario in ('concurrent_cold','sequential_cold','concurrent_warm'):
                for variant,module in variants:
                    module._NEST_A_CACHE.clear()
                    singles=module.PreviewLayoutRequest(**common)
                    batch_common={k:v for k,v in common.items() if k in module.PreviewLayoutBatchRequest.model_fields}
                    batches=module.PreviewLayoutBatchRequest(**batch_common,pages=[dict(page_idx=13,shape_type='DUMBBELL',shape_props={},item_w=50*2.83465,item_h=80*2.83465)])
                    def single():
                        return module.preview_layout(singles.model_copy(deep=True),PRO_LICENSE)
                    def batch():
                        return module.preview_layouts_batch(batches.model_copy(deep=True),PRO_LICENSE)
                    if scenario=='concurrent_warm':
                        single()
                    calls=0
                    started=time.perf_counter()
                    if scenario=='sequential_cold':
                        results=[single(),batch()]
                    else:
                        gate=threading.Barrier(2)
                        def invoke(fn):
                            gate.wait(timeout=10)
                            return fn()
                        with ThreadPoolExecutor(max_workers=2) as executor:
                            results=list(executor.map(invoke,(single,batch)))
                    wall=(time.perf_counter()-started)*1000
                    result_hash=hashlib.sha256(json.dumps(results,sort_keys=True,separators=(',',':')).encode()).hexdigest()
                    if expected_hash is None:
                        expected_hash=result_hash
                    assert result_hash==expected_hash,(tier,variant,scenario,'geometry changed')
                    assert results[0]['totalItems']==30 and results[1]['capacities'][13]==30
                    assert not getattr(module,'_NEST_A_INFLIGHT',{})
                    row=dict(tier=tier,iteration=iteration,warmup=iteration<2,scenario=scenario,variant=variant,wallMs=round(wall,3),computeCalls=calls,resultSha256=result_hash)
                    rows.append(row)
            print('LAP '+tier+' '+str(iteration),flush=True)
finally:
    nup_sticker.compute_sticker_layout_for_page=original
    for name,value in saved.items():
        if value is None:
            os.environ.pop(name,None)
        else:
            os.environ[name]=value
assert hashlib.sha256(source.read_bytes()).hexdigest()==source_sha
summary=[]
for tier in ('default','low_env'):
    for scenario in ('concurrent_cold','sequential_cold','concurrent_warm'):
        for variant in ('before','after'):
            values=[r for r in rows if not r['warmup'] and r['tier']==tier and r['scenario']==scenario and r['variant']==variant]
            timing=[r['wallMs'] for r in values]
            summary.append(dict(tier=tier,scenario=scenario,variant=variant,n=len(values),medianMs=round(statistics.median(timing),3),minMs=min(timing),maxMs=max(timing),computeCalls=[r['computeCalls'] for r in values]))
print('RESULT '+json.dumps(dict(source=str(source),sourceSha256=source_sha,sourceUnchanged=True,settings=common,baselineHead='79f05a399cb1669e6fb7cd1b84babfcbc7e3aebc',scope='real legacy route bodies in one isolated process; interleaved before/after; no HTTP/Tauri; no source rewrite; low_env does not simulate physical RAM',allResultsExact=True,summary=summary,records=rows)),flush=True)

```

</details>

<details>
<summary>Script artifact optimal_auto (không phải kiểm Tauri)</summary>

```python
import sys,tempfile,json,logging,hashlib
from pathlib import Path
import numpy as np
import pikepdf
import pypdfium2 as pdfium
from app.api.routes import imposition
from app.workers.nup_engine import run_nup_engine
from app.core.pdfium_lock import pdfium_guard
from tests.license_helpers import PRO_LICENSE
from tests.test_preview_export_canonical_parity import _make_independent_pages
logging.disable(logging.CRITICAL)
root=Path(tempfile.mkdtemp(prefix='prynx_a1a2_artifact_'))
print('ROOT='+str(root),flush=True)
source=_make_independent_pages(root/'source.pdf',90)
source_hash=hashlib.sha256(Path(source).read_bytes()).hexdigest()
common=dict(path=source,usable_w=500.,usable_h=400.,sheet_w=520.,sheet_h=420.,margin_left=10.,margin_right=10.,margin_top=10.,margin_bottom=10.,gap_x=0.,gap_y=0.,strategy='optimal_auto',task_mode='step_repeat',grouping_strategy='none',is_die_cut=True)
pages=[dict(page_idx=0,item_w=80.,item_h=180.,shape_type='RECTANGLE',shape_props={}),dict(page_idx=1,item_w=140.,item_h=90.,shape_type='RECTANGLE',shape_props={})]
single=imposition.PreviewLayoutRequest(**common,layout_type='repeat',**pages[0])
batch=imposition.PreviewLayoutBatchRequest(**common,pages=pages)
imposition._NEST_A_CACHE.clear()
cold=imposition.preview_layout(single,PRO_LICENSE)
imposition._NEST_A_CACHE.clear()
capacities=imposition.preview_layouts_batch(batch,PRO_LICENSE)
preview=imposition.preview_layout(single,PRO_LICENSE)
assert cold==preview
k=2.83465
settings=dict(imposerMode='sticker_imposer',isDieCutMode=True,taskMode='step_repeat',layoutType='repeat',gridStrategy='optimal_auto',forceLegacyGrid=True,groupingStrategy='none',sheetWidth=520/k,sheetHeight=420/k,marginLeft=10/k,marginRight=10/k,marginTop=10/k,marginBottom=10/k,gapX=0.,gapY=0.,bleed=0.,align='center',targetQuantity=0,pontType='none',cutType='default',markType='none',separateCutPage=True,exportUniqueSheets=True,detectedShapesByPage={'0':'RECTANGLE','1':'RECTANGLE'},detectedShapeParamsByPage={})
output=root/'output.pdf'
run_nup_engine(source,str(output),settings)
with pikepdf.Pdf.open(output) as doc:
    page_count=len(doc.pages)
    boxes=[[float(v) for v in page.MediaBox] for page in doc.pages]
scale=2.
with pdfium_guard():
    doc=pdfium.PdfDocument(output)
    page=doc[1]
    bitmap=page.render(scale=scale)
    picture=bitmap.to_pil().convert('RGB')
    pixels=np.array(picture)
    picture.save(root/'cut.png')
    picture.close()
    bitmap.close()
    page.close()
    doc.close()
mask=(pixels[:,:,0]>140)&(pixels[:,:,1]<180)&(pixels[:,:,2]>100)
points=[]
for cell in preview['cells']:
    for polyline in cell.get('diePolylines',[]):
        for a,b in zip(polyline,polyline[1:]):
            points.extend(((a[0]+(b[0]-a[0])*t)*scale,(a[1]+(b[1]-a[1])*t)*scale) for t in (.25,.5,.75))
hits=0
misses=[]
for x,y in points:
    px,py=round(x),round(y)
    found=mask[max(0,py-2):min(mask.shape[0],py+3),max(0,px-2):min(mask.shape[1],px+3)].any()
    hits+=bool(found)
    if not found:misses.append([x,y])
result=dict(root=str(root),sourceUnchanged=hashlib.sha256(Path(source).read_bytes()).hexdigest()==source_hash,pageCount=page_count,mediaBoxes=boxes,previewCells=len(preview['cells']),batchCapacities=capacities['capacities'],sameColdAndBatchPrimedPreview=True,cutSampleCount=len(points),cutSampleHits=hits,misses=misses[:5],cutImage=str(root/'cut.png'),scope='real S&R PDF export, first CUT page raster at144DPI; samples along backend preview edges; not Tauri renderer')
print('RESULT '+json.dumps(result),flush=True)
assert page_count==4 and result['sourceUnchanged'] and len(points)>0 and hits==len(points)

```

</details>
