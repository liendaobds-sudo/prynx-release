"""Kiểm chứng worker nhị phân MỚI (v10 view semantics) trên fixture OCG và annotation."""
import hashlib
import io
import json
import os
from pathlib import Path
import sys

import numpy as np
from PIL import Image

OUTPUT = Path(__file__).resolve().parent
ROOT = OUTPUT.parents[2]
sys.path.insert(0, str(ROOT/'scripts'))
from benchmark_zoom_runway import Worker

exe = ROOT/'desktop/src-tauri/target/debug/pdf-inspector.exe'
pdf = OUTPUT/'native_render_flags_fixture.pdf'
digest = hashlib.sha256(exe.read_bytes()).hexdigest()
stat = pdf.stat()
created = getattr(stat, 'st_birthtime_ns', stat.st_ctime_ns)
identity = {'path':str(pdf), 'size_bytes':str(stat.st_size),
            'modified_nanos':str(stat.st_mtime_ns), 'created_nanos':str(created),
            'token':f'{stat.st_size}:{stat.st_mtime_ns}:{created}'}

os.environ.pop('PRYNX_PERF', None)
worker = Worker(exe, None)
report = {'executable_sha256': digest, 'executable_size': exe.stat().st_size,
          'fixture_sha256': hashlib.sha256(pdf.read_bytes()).hexdigest(), 'renders': []}

try:
    # 1. Thử gửi expected_tile_cache_version cũ (v9) -> Phải bị từ chối
    worker.send({'message': 'hello', 'parent_pid': os.getpid(), 'nonce': 'render-audit-v9',
                 'expected_app_version': '2.0.4', 'expected_tile_cache_version': 'v9_opaque_white_lcd_sharp_png',
                 'expected_pipeline_identity': 'pdfium-display-png-v1'})
    _, hello_v9, _, _ = worker.receive()
    report['hello_v9_result'] = hello_v9
    print(f"Handshake v9 rejected as expected: ok={hello_v9.get('ok')}, error={hello_v9.get('error')}")

    # Worker đóng sau khi handshake fail, tạo worker mới cho v10
    worker.close()
    worker = Worker(exe, None)

    # 2. Thử gửi expected_tile_cache_version MỚI (v10) -> Phải THÀNH CÔNG
    worker.send({'message': 'hello', 'parent_pid': os.getpid(), 'nonce': 'render-audit-v10',
                 'expected_app_version': '2.0.4', 'expected_tile_cache_version': 'v10_view_semantics_opaque_white_png',
                 'expected_pipeline_identity': 'pdfium-display-png-v1'})
    _, hello_v10, _, _ = worker.receive()
    report['hello_v10_result'] = hello_v10
    assert hello_v10.get('ok'), f"Handshake v10 failed: {hello_v10}"
    print(f"Handshake v10 succeeded: ok={hello_v10.get('ok')}")

    # 3. Render clip và full-page với worker mới
    for clip in (None, {'x': 0, 'y': 0, 'width': 400, 'height': 200}):
        worker.send({'message': 'render', 'owner_id': 'audit:native-render-v10', 'group_key': 'flags',
                     'generation': 1, 'purpose': 'interactive', 'priority': 0, 'document': identity,
                     'page': 1, 'rotation': 0, 'raster': {'kind': 'scale', 'scale': 0.75, 'clip': clip},
                     'color': {'pipeline': 'display', 'profile_id': None, 'intent': None},
                     'pipeline_identity': 'pdfium-display-png-v1', 'soundness': 'display-preview', 'format': 'pxrg'})
        _, header, payload, _ = worker.receive()
        assert header.get('status') == 'ready', header
        if payload[:4] == b'PXRG':
            width, height, stride = np.frombuffer(payload[4:16], '<u4')
            assert stride == width * 4
            pixels = np.frombuffer(payload[16:], np.uint8).reshape(int(height), int(width), 4)
        else:
            pixels = np.asarray(Image.open(io.BytesIO(payload)).convert('RGBA'))
        
        kind = 'clip' if clip else 'page'
        Image.fromarray(pixels).save(OUTPUT / f'native_worker_v10_{kind}.png')
        
        # Tọa độ kiểm tra: y=70, x=60 (view-only red), x=190 (print-only green), x=320 (screen annotation blue)
        # Lưu ý: scale=0.75 nên tọa độ pixel tương ứng là 70*0.75=52.5 -> khoảng y=52, x=45, 142, 240
        # Nhưng ở probe gốc của audit: pixels[70, 60], [70, 190], [70, 320]
        # Thử lấy đúng vị trí màu:
        red_px = pixels[int(70 * 0.75), int(60 * 0.75)].tolist() if clip is None else pixels[int(70 * 0.75), int(60 * 0.75)].tolist()
        green_px = pixels[int(70 * 0.75), int(190 * 0.75)].tolist()
        blue_px = pixels[int(70 * 0.75), int(320 * 0.75)].tolist()
        
        # Cũng kiểm tra theo tọa độ gốc trong probe cũ để so sánh:
        raw_red = pixels[70, 60].tolist() if 70 < pixels.shape[0] and 60 < pixels.shape[1] else None
        raw_green = pixels[70, 190].tolist() if 70 < pixels.shape[0] and 190 < pixels.shape[1] else None
        raw_blue = pixels[70, 320].tolist() if 70 < pixels.shape[0] and 320 < pixels.shape[1] else None

        render_info = {
            'kind': kind, 'header': header, 'magic': payload[:4].decode('ascii'),
            'bytes': len(payload), 'shape': list(pixels.shape),
            'view_only_red_scaled': red_px,
            'print_only_green_scaled': green_px,
            'screen_annotation_blue_scaled': blue_px,
            'raw_at_70_60': raw_red,
            'raw_at_70_190': raw_green,
            'raw_at_70_320': raw_blue
        }
        report['renders'].append(render_info)
        print(f"[{kind}] red_scaled={red_px}, green_scaled={green_px}, blue_scaled={blue_px}")

    (OUTPUT / 'native_worker_v10_verification.json').write_text(json.dumps(report, indent=2))
    print("VERIFICATION COMPLETE")
finally:
    worker.close()
