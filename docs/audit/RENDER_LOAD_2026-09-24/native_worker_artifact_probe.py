"""Kiểm chứng worker nhị phân đang có, chỉ khởi chạy child headless của probe."""
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
# Không trộn log thử nghiệm với log phiên app của người dùng.
os.environ.pop('PRYNX_PERF', None)
worker = Worker(exe,None)
report = {'executable_sha256':digest, 'executable_size':exe.stat().st_size,
          'fixture_sha256':hashlib.sha256(pdf.read_bytes()).hexdigest(), 'renders':[]}
try:
    worker.send({'message':'hello','parent_pid':os.getpid(),'nonce':'render-audit',
                 'expected_app_version':'2.0.4','expected_tile_cache_version':'v9_opaque_white_lcd_sharp_png',
                 'expected_pipeline_identity':'pdfium-display-png-v1'})
    _, hello, _, _ = worker.receive()
    report['hello'] = hello
    assert hello.get('ok'),hello
    for clip in (None, {'x':0,'y':0,'width':400,'height':200}):
        worker.send({'message':'render','owner_id':'audit:native-render','group_key':'flags',
                     'generation':1,'purpose':'interactive','priority':0,'document':identity,
                     'page':1,'rotation':0,'raster':{'kind':'scale','scale':0.75,'clip':clip},
                     'color':{'pipeline':'display','profile_id':None,'intent':None},
                     'pipeline_identity':'pdfium-display-png-v1','soundness':'display-preview','format':'pxrg'})
        _, header, payload, _ = worker.receive()
        assert header.get('status') == 'ready',header
        if payload[:4] == b'PXRG':
            width, height, stride = np.frombuffer(payload[4:16],'<u4')
            assert stride == width*4
            pixels = np.frombuffer(payload[16:],np.uint8).reshape(int(height),int(width),4)
        else:
            pixels = np.asarray(Image.open(io.BytesIO(payload)).convert('RGBA'))
        kind = 'clip' if clip else 'page'
        Image.fromarray(pixels).save(OUTPUT/f'native_worker_{kind}.png')
        report['renders'].append({'kind':kind,'header':header,'magic':payload[:4].decode('ascii'),
                                  'bytes':len(payload),'shape':list(pixels.shape),
                                  'view_only_red_rgba':pixels[70,60].tolist(),
                                  'print_only_green_rgba':pixels[70,190].tolist(),
                                  'screen_annotation_blue_rgba':pixels[70,320].tolist()})
    assert digest == hashlib.sha256(exe.read_bytes()).hexdigest()
    (OUTPUT/'native_worker_artifact_probe.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report,indent=2))
finally:
    worker.close()
