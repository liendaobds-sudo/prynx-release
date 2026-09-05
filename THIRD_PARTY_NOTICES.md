# Thông báo về phần mềm của bên thứ ba (Third-Party Notices)

PrynX sử dụng các thành phần mã nguồn mở dưới đây. Bản quyền thuộc về các
tác giả tương ứng; mỗi thành phần được phân phối theo giấy phép của nó.

*Sinh tự động ngày 2026-09-05 bằng `scripts/gen_third_party_notices.py`. Đừng sửa tay — sửa nguồn dữ liệu rồi chạy lại script.*

> Đây không phải tư vấn pháp lý. Tài liệu này liệt kê thành phần và giấy
> phép để phục vụ nghĩa vụ ghi công; việc đánh giá tuân thủ là việc riêng.

## 1. Thành phần cần chú ý nghĩa vụ giấy phép

Mục này chỉ tính thành phần **có trong bản phát hành**. Công cụ chỉ dùng
lúc build/test được tách riêng ở cuối mục, vì chúng không phát sinh nghĩa
vụ phân phối.

### Copyleft mạnh — CÓ trong bản phát hành

Không có. Bản đóng gói này không chứa thành phần copyleft mạnh.

### Copyleft mạnh — CHỈ dùng lúc build/test (không phát sinh nghĩa vụ)

- ffmpeg-static 5.3.0 — GPL-3.0-or-later

### Copyleft yếu (MPL / LGPL / EPL / CDDL)

Nghĩa vụ chỉ phát sinh khi **sửa** mã nguồn của chính thư viện đó.
PrynX dùng nguyên bản, không sửa.

- cssparser 0.36.0 — MPL-2.0
- cssparser-macros 0.6.1 — MPL-2.0
- dompurify 3.4.12 — (MPL-2.0 OR Apache-2.0)
- dtoa-short 0.3.5 — MPL-2.0
- hypothesis 6.155.3 — MPL-2.0
- lightningcss 1.32.0 — MPL-2.0
- lightningcss-android-arm64 1.32.0 — MPL-2.0
- lightningcss-darwin-arm64 1.32.0 — MPL-2.0
- lightningcss-darwin-x64 1.32.0 — MPL-2.0
- lightningcss-freebsd-x64 1.32.0 — MPL-2.0
- lightningcss-linux-arm-gnueabihf 1.32.0 — MPL-2.0
- lightningcss-linux-arm64-gnu 1.32.0 — MPL-2.0
- lightningcss-linux-arm64-musl 1.32.0 — MPL-2.0
- lightningcss-linux-x64-gnu 1.32.0 — MPL-2.0
- lightningcss-linux-x64-musl 1.32.0 — MPL-2.0
- lightningcss-win32-arm64-msvc 1.32.0 — MPL-2.0
- lightningcss-win32-x64-msvc 1.32.0 — MPL-2.0
- option-ext 0.2.0 — MPL-2.0
- pikepdf 10.12.0 — MPL-2.0
- psycopg2-binary 2.9.9 — LGPL with exceptions
- r-efi 5.3.0 — MIT OR Apache-2.0 OR LGPL-2.1-or-later
- r-efi 6.0.0 — MIT OR Apache-2.0 OR LGPL-2.1-or-later
- selectors 0.36.1 — MPL-2.0

## 2. Thành phần nhị phân đóng gói trong installer

| Thành phần | Phiên bản | Giấy phép | Cách dùng | Vị trí |
|---|---|---|---|---|
| [Tesseract OCR](https://github.com/tesseract-ocr/tesseract) | 5.x | Apache-2.0 | Nhận dạng chữ trong ảnh (OCR) | `binaries/tesseract/` |
| [Leptonica](http://www.leptonica.org/) | 1.8x | BSD-2-Clause | Xử lý ảnh nền cho OCR | `binaries/tesseract/ (DLL)` |
| [PDFium](https://pdfium.googlesource.com/pdfium/) | bundled build | BSD-3-Clause | Render trang, đọc hình học đối tượng PDF | `pdfium.dll (trong sidecar) + pypdfium2` |
| [DirectML](https://github.com/microsoft/DirectML) | theo onnxruntime-directml | MIT | Tăng tốc GPU cho tách nền và phóng to ảnh AI (DirectX 12) | `onnxruntime/capi/DirectML.dll` |
| [ISNet general-use ONNX model](https://github.com/danielgatis/rembg) | rembg v0.0.0 model artifact | Apache-2.0 | Tách nền offline ở chế độ Nhanh | `app/data/models/isnet-general-use.onnx` |
| [Real-ESRGAN realesr-general-x4v3 model](https://github.com/xinntao/Real-ESRGAN) | x4v3 + x4plus / ONNX conversion | BSD-3-Clause | Phóng to và phục hồi chi tiết ảnh bằng AI | `app/data/models/realesr-general-x4v3.onnx + realesrgan-x4plus.onnx` |

### Tesseract OCR

- Giấy phép: **Apache-2.0**
- Liên kết: Tiến trình riêng, gọi qua dòng lệnh
- Mã nguồn: https://github.com/tesseract-ocr/tesseract
- Ghi chú: Bundle kèm tessdata. Các thư viện đi cùng trong cùng thư mục: Leptonica (BSD-2-Clause), ICU (Unicode-3.0), libpng/zlib/libtiff/libjpeg (giấy phép permissive tương ứng).

### Leptonica

- Giấy phép: **BSD-2-Clause**
- Liên kết: Thư viện động của Tesseract
- Mã nguồn: https://github.com/DanBloomberg/leptonica

### PDFium

- Giấy phép: **BSD-3-Clause**
- Liên kết: Thư viện động
- Mã nguồn: https://pdfium.googlesource.com/pdfium/
- Ghi chú: Có chứa mã của Chromium/Skia (BSD-3-Clause) và một phần Apache-2.0.

### DirectML

- Giấy phép: **MIT**
- Liên kết: Thư viện động của onnxruntime
- Mã nguồn: https://github.com/microsoft/DirectML
- Ghi chú: Chỉ có ở bản Windows; bản CPU không kèm.

### ISNet general-use ONNX model

- Giấy phép: **Apache-2.0**
- Liên kết: Trọng số ONNX nạp cục bộ qua ONNX Runtime
- Mã nguồn: https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx
- Ghi chú: SHA-256: 60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a. BiRefNet-lite/full vẫn tải theo nhu cầu bằng cache atomic có kiểm hash.

### Real-ESRGAN realesr-general-x4v3 model

- Giấy phép: **BSD-3-Clause**
- Liên kết: Trọng số ONNX nạp cục bộ qua ONNX Runtime
- Mã nguồn: https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.3.0
- Ghi chú: Chuyển từ trọng số .pth chính thức bằng backend/scripts/convert_realesrgan_onnx.py. Bản x4v3 là DNI blend realesr-general-x4v3 + realesr-general-wdn-x4v3 ở alpha 0,5 (mặc định denoise_strength của upstream). SHA-256 x4v3: 3ae50bb3a9131697d62ac79f934e57c2ef9cd3b8762993ca0d1fabd8a36a343f; x4plus: c1b85fae35947577b4c4b7d310af54546c6e7971f14a0862a769e83689ddc003.
- Toàn văn giấy phép đi kèm bản phân phối:

```text
BSD 3-Clause License

Copyright (c) 2021, Xintao Wang
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## 3. Thư viện Python

Cột *Phạm vi*: `phát hành` = khai trong `backend/requirements*.txt`;
`build/test` = phụ thuộc gián tiếp hoặc chỉ dùng để chạy test.

| Tên | Phiên bản | Giấy phép | Phạm vi |
|---|---|---|---|
| [aiofiles](https://github.com/Tinche/aiofiles) | 24.1.0 | Apache-2.0 | phát hành |
| [alembic](https://alembic.sqlalchemy.org) | 1.13.0 | MIT | phát hành |
| [amqp](http://github.com/celery/py-amqp) | 5.3.1 | BSD | build/test |
| [annotated-doc](https://github.com/fastapi/annotated-doc) | 0.0.5 | MIT | build/test |
| [annotated-types](https://github.com/annotated-types/annotated-types) | 0.8.0 | MIT | build/test |
| anyio | 4.14.2 | MIT | build/test |
| [billiard](https://github.com/celery/billiard) | 4.2.4 | BSD | build/test |
| [celery](https://docs.celeryq.dev/) | 5.4.0 | BSD-3-Clause | phát hành |
| [certifi](https://github.com/certifi/python-certifi) | 2026.7.22 | MPL-2.0 | build/test |
| cffi | 2.1.0 | MIT-0 | build/test |
| [chardet](https://github.com/chardet/chardet) | 7.4.3 | 0BSD | build/test |
| charset-normalizer | 3.4.9 | MIT | build/test |
| [click](https://github.com/pallets/click/) | 8.4.2 | BSD-3-Clause | build/test |
| [click-didyoumean](https://github.com/click-contrib/click-didyoumean) | 0.3.1 | MIT | build/test |
| [click-plugins](https://github.com/click-contrib/click-plugins) | 1.1.1.2 | New BSD | build/test |
| [click-repl](https://github.com/untitaker/click-repl) | 0.3.0 | MIT | build/test |
| [colorama](https://github.com/tartley/colorama) | 0.4.6 | BSD License | build/test |
| [cryptography](https://github.com/pyca/cryptography) | 50.0.0 | Apache-2.0 OR BSD-3-Clause | build/test |
| [Deprecated](https://github.com/laurent-laporte-pro/deprecated) | 1.3.1 | MIT | build/test |
| detect-installer | 0.1.0 | 0BSD | build/test |
| [dnspython](https://www.dnspython.org) | 2.8.0 | ISC | build/test |
| [email-validator](https://github.com/JoshData/python-email-validator) | 2.3.0 | Unlicense | build/test |
| [et_xmlfile](https://foss.heptapod.net/openpyxl/et_xmlfile) | 2.0.0 | MIT | build/test |
| [fastapi](https://github.com/fastapi/fastapi) | 0.138.1 | MIT | phát hành |
| [fastapi-cli](https://github.com/fastapi/fastapi-cli) | 0.0.32 | MIT | build/test |
| [fastapi-cloud-cli](https://github.com/fastapilabs/fastapi-cloud-cli) | 0.23.0 | MIT | build/test |
| [fastar](https://github.com/DoctorJohn/fastar) | 0.11.0 | MIT | build/test |
| [flatbuffers](https://google.github.io/flatbuffers/) | 25.12.19 | Apache 2.0 | build/test |
| [fonttools](http://github.com/fonttools/fonttools) | 4.60.2 | MIT | phát hành |
| [greenlet](https://greenlet.readthedocs.io) | 3.5.4 | MIT AND PSF-2.0 | build/test |
| [h11](https://github.com/python-hyper/h11) | 0.16.0 | MIT | build/test |
| [httpcore](https://www.encode.io/httpcore/) | 1.0.9 | BSD-3-Clause | build/test |
| [httptools](https://github.com/MagicStack/httptools) | 0.8.0 | MIT | build/test |
| [httpx](https://github.com/encode/httpx) | 0.27.0 | BSD-3-Clause | phát hành |
| [hypothesis](https://hypothesis.works) | 6.155.3 | MPL-2.0 | phát hành |
| [idna](https://github.com/kjd/idna) | 3.18 | BSD-3-Clause | build/test |
| [ImageIO](https://github.com/imageio/imageio) | 2.37.4 | BSD-2-Clause | build/test |
| [iniconfig](https://github.com/pytest-dev/iniconfig) | 2.3.0 | MIT | build/test |
| [Jinja2](https://github.com/pallets/jinja/) | 3.1.6 | BSD License | build/test |
| [kombu](https://kombu.readthedocs.io) | 5.6.2 | BSD-3-Clause | build/test |
| [lazy-loader](https://github.com/scientific-python/lazy-loader) | 0.5 | BSD-3-Clause | build/test |
| [lxml](https://lxml.de/) | 6.1.1 | BSD-3-Clause | build/test |
| [Mako](https://www.makotemplates.org/) | 1.3.12 | MIT | build/test |
| [markdown-it-py](https://github.com/executablebooks/markdown-it-py) | 4.2.0 | MIT License | build/test |
| [MarkupSafe](https://github.com/pallets/markupsafe/) | 3.0.3 | BSD-3-Clause | build/test |
| [maturin](https://github.com/pyo3/maturin) | 1.13.3 | MIT OR Apache-2.0 | phát hành |
| [mdurl](https://github.com/executablebooks/mdurl) | 0.1.2 | MIT License | build/test |
| [mpmath](http://mpmath.org/) | 1.3.0 | BSD | build/test |
| [networkx](https://networkx.org/) | 3.6.1 | BSD-3-Clause | build/test |
| [Nuitka](https://nuitka.net) | 4.1.2 | GNU Affero General Public License v3 | phát hành |
| [numpy](https://numpy.org) | 1.26.4 | BSD License | build/test |
| [onnxruntime-directml](https://onnxruntime.ai) | 1.24.4 | MIT License | phát hành |
| [opencv-python-headless](https://github.com/opencv/opencv-python) | 4.10.0.84 | Apache 2.0 | phát hành |
| [openpyxl](https://openpyxl.readthedocs.io) | 3.1.5 | MIT | phát hành |
| ordered-set | 4.1.0 | MIT License | phát hành |
| [packaging](https://github.com/pypa/packaging) | 26.2 | Apache-2.0 OR BSD-2-Clause | build/test |
| pdfcompare_native | 0.1.0 | CHƯA XÁC ĐỊNH | build/test |
| [pdfminer.six](https://github.com/pdfminer/pdfminer.six) | 20260107 | MIT | build/test |
| [pdfplumber](https://github.com/jsvine/pdfplumber) | 0.11.10 | MIT License | phát hành |
| [pikepdf](https://github.com/pikepdf/pikepdf) | 10.12.0 | MPL-2.0 | phát hành |
| [pillow](https://python-pillow.github.io) | 12.3.0 | MIT-CMU | phát hành |
| [pip](https://pip.pypa.io/) | 26.2 | MIT | build/test |
| pluggy | 1.6.0 | MIT | build/test |
| [prompt_toolkit](https://github.com/prompt-toolkit/python-prompt-toolkit) | 3.0.53 | BSD License | build/test |
| [protobuf](https://developers.google.com/protocol-buffers/) | 7.35.1 | 3-Clause BSD License | build/test |
| [psycopg2-binary](https://psycopg.org/) | 2.9.9 | LGPL with exceptions | phát hành |
| [pycparser](https://github.com/eliben/pycparser) | 3.0 | BSD-3-Clause | build/test |
| [pydantic](https://github.com/pydantic/pydantic) | 2.13.4 | MIT | build/test |
| [pydantic-extra-types](https://github.com/pydantic/pydantic-extra-types) | 2.11.1 | MIT | build/test |
| [pydantic-settings](https://github.com/pydantic/pydantic-settings) | 2.5.0 | MIT | phát hành |
| [pydantic_core](https://github.com/pydantic/pydantic) | 2.46.4 | MIT | build/test |
| [Pygments](https://pygments.org) | 2.20.0 | BSD-2-Clause | build/test |
| [pypdf](https://github.com/py-pdf/pypdf) | 6.14.2 | BSD-3-Clause | phát hành |
| [pypdfium2](https://github.com/pypdfium2-team/pypdfium2) | 5.13.0 | BSD-3-Clause, Apache-2.0, dependency licenses | phát hành |
| [pyserial](https://github.com/pyserial/pyserial) | 3.5 | BSD | phát hành |
| [pytesseract](https://github.com/madmaze/pytesseract) | 0.3.13 | Apache License 2.0 | phát hành |
| [pytest](https://docs.pytest.org/en/latest/) | 9.0.3 | MIT | phát hành |
| [pytest-asyncio](https://github.com/pytest-dev/pytest-asyncio) | 1.4.0 | Apache-2.0 | phát hành |
| [python-barcode](https://github.com/WhyNotHugo/python-barcode) | 0.16.1 | MIT | phát hành |
| [python-dateutil](https://github.com/dateutil/dateutil) | 2.9.0.post0 | Dual License | build/test |
| [python-dotenv](https://github.com/theskumar/python-dotenv) | 1.2.2 | BSD-3-Clause | phát hành |
| [python-multipart](https://github.com/Kludex/python-multipart) | 0.0.31 | Apache-2.0 | phát hành |
| [pywin32](https://github.com/mhammond/pywin32) | 308 | PSF | phát hành |
| [PyYAML](https://pyyaml.org/) | 6.0.3 | MIT | build/test |
| [redis](https://github.com/redis/redis-py) | 5.1.0 | MIT | phát hành |
| [reportlab](https://www.reportlab.com/) | 4.2.0 | BSD License | phát hành |
| [rich](https://github.com/Textualize/rich) | 15.0.0 | MIT | build/test |
| rich-toolkit | 0.20.3 | MIT | build/test |
| rignore | 0.8.0 | MIT | build/test |
| [scikit-image](https://scikit-image.org) | 0.24.0 | BSD License | phát hành |
| [scipy](https://scipy.org/) | 1.12.0 | BSD License | phát hành |
| [segno](https://github.com/heuer/segno/) | 1.6.6 | BSD License | phát hành |
| [sentry-sdk](https://github.com/getsentry/sentry-python) | 2.66.1 | MIT | build/test |
| [setuptools](https://github.com/pypa/setuptools) | 65.5.0 | MIT License | build/test |
| [shapely](https://github.com/shapely/shapely) | 2.0.6 | BSD 3-Clause | phát hành |
| [shellingham](https://github.com/sarugaku/shellingham) | 1.5.4 | ISC License | build/test |
| [six](https://github.com/benjaminp/six) | 1.17.0 | MIT | build/test |
| [sniffio](https://github.com/python-trio/sniffio) | 1.3.1 | MIT OR Apache-2.0 | build/test |
| [sortedcontainers](http://www.grantjenks.com/docs/sortedcontainers/) | 2.4.0 | Apache 2.0 | build/test |
| [SQLAlchemy](https://www.sqlalchemy.org) | 2.0.35 | MIT | phát hành |
| [starlette](https://github.com/Kludex/starlette) | 1.3.1 | BSD-3-Clause | phát hành |
| [sympy](https://sympy.org) | 1.14.0 | BSD | build/test |
| [tifffile](https://www.cgohlke.com) | 2026.3.3 | BSD-3-Clause | build/test |
| [typer](https://github.com/fastapi/typer) | 0.27.0 | MIT | build/test |
| [typing-inspection](https://github.com/pydantic/typing-inspection) | 0.4.2 | MIT | build/test |
| [typing_extensions](https://github.com/python/typing_extensions) | 4.16.0 | PSF-2.0 | build/test |
| [tzdata](https://github.com/python/tzdata) | 2026.3 | Apache-2.0 | build/test |
| [uharfbuzz](https://github.com/trufont/uharfbuzz) | 0.55.0 | Apache License 2.0 | phát hành |
| urllib3 | 2.7.0 | MIT | build/test |
| [uvicorn](https://www.uvicorn.org/) | 0.30.0 | BSD-3-Clause | phát hành |
| [vine](https://github.com/celery/vine) | 5.1.0 | BSD | build/test |
| [watchfiles](https://github.com/samuelcolvin/watchfiles) | 1.2.0 | MIT | build/test |
| [wcwidth](https://github.com/jquast/wcwidth) | 0.8.2 | MIT | build/test |
| [websockets](https://github.com/python-websockets/websockets) | 13.0 | BSD-3-Clause | phát hành |
| [wrapt](https://github.com/GrahamDumpleton/wrapt) | 2.3.0 | BSD-2-Clause | build/test |
| [zstandard](https://github.com/indygreg/python-zstandard) | 0.25.0 | BSD-3-Clause | phát hành |

## 4. Crate Rust

Toàn bộ crate được liên kết vào `pdfcompare_native` và bản Tauri, nên coi
là có trong bản phát hành.

| Tên | Phiên bản | Giấy phép |
|---|---|---|
| [adler2](https://github.com/oyvindln/adler2) | 2.0.1 | 0BSD OR MIT OR Apache-2.0 |
| [aead](https://github.com/RustCrypto/traits) | 0.5.2 | MIT OR Apache-2.0 |
| [aes](https://github.com/RustCrypto/block-ciphers) | 0.8.4 | MIT OR Apache-2.0 |
| [aes](https://github.com/RustCrypto/block-ciphers) | 0.9.1 | MIT OR Apache-2.0 |
| [aes](https://github.com/RustCrypto/block-ciphers) | 0.9.2 | MIT OR Apache-2.0 |
| [aes-gcm](https://github.com/RustCrypto/AEADs) | 0.10.3 | Apache-2.0 OR MIT |
| [ahash](https://github.com/tkaitchuck/ahash) | 0.7.8 | MIT OR Apache-2.0 |
| [aho-corasick](https://github.com/BurntSushi/aho-corasick) | 1.1.4 | Unlicense OR MIT |
| [aliasable](https://github.com/avitex/rust-aliasable) | 0.1.3 | MIT |
| [aligned-vec](https://github.com/sarah-ek/aligned-vec/) | 0.6.4 | MIT |
| [alloc-no-stdlib](https://github.com/dropbox/rust-alloc-no-stdlib) | 2.0.4 | BSD-3-Clause |
| [alloc-stdlib](https://github.com/dropbox/rust-alloc-no-stdlib) | 0.2.2 | BSD-3-Clause |
| [allocator-api2](https://github.com/zakarumych/allocator-api2) | 0.2.21 | MIT OR Apache-2.0 |
| [android_log-sys](https://github.com/rust-mobile/android_log-sys-rs) | 0.3.2 | MIT OR Apache-2.0 |
| [android_logger](https://github.com/rust-mobile/android_logger-rs) | 0.15.1 | MIT OR Apache-2.0 |
| [android_system_properties](https://github.com/nical/android_system_properties) | 0.1.5 | MIT/Apache-2.0 |
| [anyhow](https://github.com/dtolnay/anyhow) | 1.0.103 | MIT OR Apache-2.0 |
| [approx](https://github.com/brendanzab/approx) | 0.5.1 | Apache-2.0 |
| [arbitrary](https://github.com/rust-fuzz/arbitrary/) | 1.4.2 | MIT OR Apache-2.0 |
| [arrayref](https://github.com/droundy/arrayref) | 0.3.9 | BSD-2-Clause |
| [arrayvec](https://github.com/bluss/arrayvec) | 0.7.6 | MIT OR Apache-2.0 |
| [arrayvec](https://github.com/bluss/arrayvec) | 0.7.8 | MIT OR Apache-2.0 |
| [async-broadcast](https://github.com/smol-rs/async-broadcast) | 0.7.2 | MIT OR Apache-2.0 |
| [async-channel](https://github.com/smol-rs/async-channel) | 2.5.0 | Apache-2.0 OR MIT |
| [async-executor](https://github.com/smol-rs/async-executor) | 1.14.0 | Apache-2.0 OR MIT |
| [async-io](https://github.com/smol-rs/async-io) | 2.6.0 | Apache-2.0 OR MIT |
| [async-lock](https://github.com/smol-rs/async-lock) | 3.4.2 | Apache-2.0 OR MIT |
| [async-process](https://github.com/smol-rs/async-process) | 2.5.0 | Apache-2.0 OR MIT |
| [async-recursion](https://github.com/dcchut/async-recursion) | 1.1.1 | MIT OR Apache-2.0 |
| [async-signal](https://github.com/smol-rs/async-signal) | 0.2.14 | Apache-2.0 OR MIT |
| [async-task](https://github.com/smol-rs/async-task) | 4.7.1 | Apache-2.0 OR MIT |
| [async-trait](https://github.com/dtolnay/async-trait) | 0.1.89 | MIT OR Apache-2.0 |
| [atk](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [atk-sys](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [atomic-waker](https://github.com/smol-rs/atomic-waker) | 1.1.2 | Apache-2.0 OR MIT |
| [autocfg](https://github.com/cuviper/autocfg) | 1.5.1 | Apache-2.0 OR MIT |
| [base64](https://github.com/marshallpierce/rust-base64) | 0.21.7 | MIT OR Apache-2.0 |
| [base64](https://github.com/marshallpierce/rust-base64) | 0.22.1 | MIT OR Apache-2.0 |
| [base64ct](https://github.com/RustCrypto/formats) | 1.8.3 | Apache-2.0 OR MIT |
| [bit-set](https://github.com/contain-rs/bit-set) | 0.8.0 | Apache-2.0 OR MIT |
| [bit-vec](https://github.com/contain-rs/bit-vec) | 0.6.3 | MIT/Apache-2.0 |
| [bit-vec](https://github.com/contain-rs/bit-vec) | 0.8.0 | Apache-2.0 OR MIT |
| [bitflags](https://github.com/bitflags/bitflags) | 1.3.2 | MIT/Apache-2.0 |
| [bitflags](https://github.com/bitflags/bitflags) | 2.13.1 | MIT OR Apache-2.0 |
| [bitvec](https://github.com/bitvecto-rs/bitvec) | 1.0.1 | MIT |
| [block-buffer](https://github.com/RustCrypto/utils) | 0.10.4 | MIT OR Apache-2.0 |
| [block-buffer](https://github.com/RustCrypto/utils) | 0.12.1 | MIT OR Apache-2.0 |
| [block-padding](https://github.com/RustCrypto/utils) | 0.4.2 | MIT OR Apache-2.0 |
| [block2](https://github.com/madsmtm/objc2) | 0.6.2 | MIT |
| [blocking](https://github.com/smol-rs/blocking) | 1.6.2 | Apache-2.0 OR MIT |
| [boa_ast](https://github.com/boa-dev/boa) | 0.21.1 | Unlicense OR MIT |
| [boa_engine](https://github.com/boa-dev/boa) | 0.21.1 | Unlicense OR MIT |
| [boa_gc](https://github.com/boa-dev/boa) | 0.21.1 | Unlicense OR MIT |
| [boa_interner](https://github.com/boa-dev/boa) | 0.21.1 | Unlicense OR MIT |
| [boa_macros](https://github.com/boa-dev/boa) | 0.21.1 | Unlicense OR MIT |
| [boa_parser](https://github.com/boa-dev/boa) | 0.21.1 | Unlicense OR MIT |
| [boa_string](https://github.com/boa-dev/boa) | 0.21.1 | Unlicense OR MIT |
| [borsh](https://github.com/near/borsh-rs) | 1.6.1 | MIT OR Apache-2.0 |
| [borsh-derive](https://github.com/near/borsh-rs) | 1.6.1 | Apache-2.0 |
| [brotli](https://github.com/dropbox/rust-brotli) | 8.0.3 | BSD-3-Clause AND MIT |
| [brotli-decompressor](https://github.com/dropbox/rust-brotli-decompressor) | 5.0.1 | BSD-3-Clause/MIT |
| [bs58](https://github.com/Nullus157/bs58-rs) | 0.5.1 | MIT/Apache-2.0 |
| [bumpalo](https://github.com/fitzgen/bumpalo) | 3.20.3 | MIT OR Apache-2.0 |
| [byte-unit](https://github.com/magiclen/byte-unit) | 5.2.0 | MIT |
| [bytecheck](https://github.com/djkoloski/bytecheck) | 0.6.12 | MIT |
| [bytecheck_derive](https://github.com/djkoloski/bytecheck) | 0.6.12 | MIT |
| [bytemuck](https://github.com/Lokathor/bytemuck) | 1.25.0 | Zlib OR Apache-2.0 OR MIT |
| [bytemuck](https://github.com/Lokathor/bytemuck) | 1.25.2 | Zlib OR Apache-2.0 OR MIT |
| [bytemuck_derive](https://github.com/Lokathor/bytemuck) | 1.11.0 | Zlib OR Apache-2.0 OR MIT |
| [byteorder](https://github.com/BurntSushi/byteorder) | 1.5.0 | Unlicense OR MIT |
| [byteorder-lite](https://github.com/image-rs/byteorder-lite) | 0.1.0 | Unlicense OR MIT |
| [bytes](https://github.com/tokio-rs/bytes) | 1.11.1 | MIT |
| [bytes](https://github.com/tokio-rs/bytes) | 1.12.1 | MIT |
| [cairo-rs](https://github.com/gtk-rs/gtk-rs-core) | 0.18.5 | MIT |
| [cairo-sys-rs](https://github.com/gtk-rs/gtk-rs-core) | 0.18.2 | MIT |
| [camino](https://github.com/camino-rs/camino) | 1.2.2 | MIT OR Apache-2.0 |
| [cargo-platform](https://github.com/rust-lang/cargo) | 0.1.9 | MIT OR Apache-2.0 |
| [cargo_metadata](https://github.com/oli-obk/cargo_metadata) | 0.19.2 | MIT |
| [cargo_toml](https://gitlab.com/lib.rs/cargo_toml) | 0.22.3 | Apache-2.0 OR MIT |
| [cbc](https://github.com/RustCrypto/block-modes) | 0.2.1 | MIT OR Apache-2.0 |
| [cc](https://github.com/rust-lang/cc-rs) | 1.2.62 | MIT OR Apache-2.0 |
| [cc](https://github.com/rust-lang/cc-rs) | 1.4.0 | MIT OR Apache-2.0 |
| [cesu8](https://github.com/emk/cesu8-rs) | 1.1.0 | Apache-2.0/MIT |
| [cfb](https://github.com/mdsteele/rust-cfb) | 0.7.3 | MIT |
| [cfg-expr](https://github.com/EmbarkStudios/cfg-expr) | 0.15.8 | MIT OR Apache-2.0 |
| [cfg-if](https://github.com/rust-lang/cfg-if) | 1.0.4 | MIT OR Apache-2.0 |
| [cfg_aliases](https://github.com/katharostech/cfg_aliases) | 0.2.1 | MIT |
| [chacha20](https://github.com/RustCrypto/stream-ciphers) | 0.10.1 | MIT OR Apache-2.0 |
| [chrono](https://github.com/chronotope/chrono) | 0.4.44 | MIT OR Apache-2.0 |
| [chrono](https://github.com/chronotope/chrono) | 0.4.45 | MIT OR Apache-2.0 |
| [cipher](https://github.com/RustCrypto/traits) | 0.4.4 | MIT OR Apache-2.0 |
| [cipher](https://github.com/RustCrypto/traits) | 0.5.2 | MIT OR Apache-2.0 |
| [clipper2-rust](https://github.com/larsbrubaker/clipper2-rust) | 1.1.0 | BSL-1.0 |
| [color_quant](https://github.com/image-rs/color_quant) | 1.1.0 | MIT |
| [combine](https://github.com/Marwes/combine) | 4.6.7 | MIT |
| [concurrent-queue](https://github.com/smol-rs/concurrent-queue) | 2.5.0 | Apache-2.0 OR MIT |
| [console_error_panic_hook](https://github.com/rustwasm/console_error_panic_hook) | 0.1.7 | Apache-2.0/MIT |
| [console_log](https://github.com/iamcodemaker/console_log) | 1.0.0 | MIT/Apache-2.0 |
| [console_log](https://github.com/iamcodemaker/console_log) | 1.1.0 | MIT/Apache-2.0 |
| [const-oid](https://github.com/RustCrypto/formats) | 0.10.2 | Apache-2.0 OR MIT |
| [const-oid](https://github.com/RustCrypto/formats/tree/master/const-oid) | 0.9.6 | Apache-2.0 OR MIT |
| [const-random](https://github.com/tkaitchuck/constrandom) | 0.1.18 | MIT OR Apache-2.0 |
| [const-random-macro](https://github.com/tkaitchuck/constrandom) | 0.1.16 | MIT OR Apache-2.0 |
| [cookie](https://github.com/SergioBenitez/cookie-rs) | 0.18.1 | MIT OR Apache-2.0 |
| [core-foundation](https://github.com/servo/core-foundation-rs) | 0.10.1 | MIT OR Apache-2.0 |
| [core-foundation-sys](https://github.com/servo/core-foundation-rs) | 0.8.7 | MIT OR Apache-2.0 |
| [core-graphics](https://github.com/servo/core-foundation-rs) | 0.25.0 | MIT OR Apache-2.0 |
| [core-graphics-types](https://github.com/servo/core-foundation-rs) | 0.2.0 | MIT OR Apache-2.0 |
| [cow-utils](https://github.com/RReverser/cow-utils-rs) | 0.1.3 | MIT |
| [cpubits](https://github.com/RustCrypto/utils) | 0.1.1 | MIT OR Apache-2.0 |
| [cpufeatures](https://github.com/RustCrypto/utils) | 0.2.17 | MIT OR Apache-2.0 |
| [cpufeatures](https://github.com/RustCrypto/utils) | 0.3.0 | MIT OR Apache-2.0 |
| [crc32fast](https://github.com/srijs/rust-crc32fast) | 1.5.0 | MIT OR Apache-2.0 |
| [crossbeam-channel](https://github.com/crossbeam-rs/crossbeam) | 0.5.15 | MIT OR Apache-2.0 |
| [crossbeam-deque](https://github.com/crossbeam-rs/crossbeam) | 0.8.7 | MIT OR Apache-2.0 |
| [crossbeam-epoch](https://github.com/crossbeam-rs/crossbeam) | 0.9.20 | MIT OR Apache-2.0 |
| [crossbeam-utils](https://github.com/crossbeam-rs/crossbeam) | 0.8.21 | MIT OR Apache-2.0 |
| [crossbeam-utils](https://github.com/crossbeam-rs/crossbeam) | 0.8.22 | MIT OR Apache-2.0 |
| [crunchy](https://github.com/eira-fransham/crunchy) | 0.2.4 | MIT |
| [crypto-common](https://github.com/RustCrypto/traits) | 0.1.7 | MIT OR Apache-2.0 |
| [crypto-common](https://github.com/RustCrypto/traits) | 0.2.2 | MIT OR Apache-2.0 |
| [cssparser](https://github.com/servo/rust-cssparser) | 0.36.0 | MPL-2.0 |
| [cssparser-macros](https://github.com/servo/rust-cssparser) | 0.6.1 | MPL-2.0 |
| [ctor](https://github.com/mmastrac/rust-ctor) | 0.8.0 | Apache-2.0 OR MIT |
| [ctor-proc-macro](https://github.com/mmastrac/rust-ctor) | 0.0.7 | Apache-2.0 OR MIT |
| [ctr](https://github.com/RustCrypto/block-modes) | 0.9.2 | MIT OR Apache-2.0 |
| [curve25519-dalek](https://github.com/dalek-cryptography/curve25519-dalek/tree/main/curve25519-dalek) | 4.1.3 | BSD-3-Clause |
| [curve25519-dalek-derive](https://github.com/dalek-cryptography/curve25519-dalek) | 0.1.1 | MIT/Apache-2.0 |
| [darling](https://github.com/TedDriggs/darling) | 0.23.0 | MIT |
| [darling_core](https://github.com/TedDriggs/darling) | 0.23.0 | MIT |
| [darling_macro](https://github.com/TedDriggs/darling) | 0.23.0 | MIT |
| [dashmap](https://github.com/xacrimon/dashmap) | 6.2.1 | MIT |
| [dbus](https://github.com/diwic/dbus-rs) | 0.9.11 | Apache-2.0/MIT |
| [der](https://github.com/RustCrypto/formats/tree/master/der) | 0.7.10 | Apache-2.0 OR MIT |
| [deranged](https://github.com/jhpratt/deranged) | 0.5.8 | MIT OR Apache-2.0 |
| [derive_arbitrary](https://github.com/rust-fuzz/arbitrary) | 1.4.2 | MIT OR Apache-2.0 |
| [derive_more](https://github.com/JelteF/derive_more) | 2.1.1 | MIT |
| [derive_more-impl](https://github.com/JelteF/derive_more) | 2.1.1 | MIT |
| [digest](https://github.com/RustCrypto/traits) | 0.10.7 | MIT OR Apache-2.0 |
| [digest](https://github.com/RustCrypto/traits) | 0.11.3 | MIT OR Apache-2.0 |
| [dirs](https://github.com/soc/dirs-rs) | 6.0.0 | MIT OR Apache-2.0 |
| [dirs-sys](https://github.com/dirs-dev/dirs-sys-rs) | 0.5.0 | MIT OR Apache-2.0 |
| [dispatch2](https://github.com/madsmtm/objc2) | 0.3.1 | Zlib OR Apache-2.0 OR MIT |
| [displaydoc](https://github.com/yaahc/displaydoc) | 0.2.6 | MIT OR Apache-2.0 |
| [dlopen2](https://github.com/OpenByteDev/dlopen2) | 0.8.2 | MIT |
| [dlopen2_derive](https://github.com/OpenByteDev/dlopen2) | 0.4.3 | MIT |
| [dlv-list](https://github.com/sgodwincs/dlv-list-rs) | 0.5.2 | MIT OR Apache-2.0 |
| [dom_query](https://github.com/niklak/dom_query) | 0.27.0 | MIT |
| [dpi](https://github.com/rust-windowing/winit) | 0.1.2 | Apache-2.0 AND MIT |
| [dtoa](https://github.com/dtolnay/dtoa) | 1.0.11 | MIT OR Apache-2.0 |
| [dtoa-short](https://github.com/upsuper/dtoa-short) | 0.3.5 | MPL-2.0 |
| [dtor](https://github.com/mmastrac/rust-ctor) | 0.3.0 | Apache-2.0 OR MIT |
| [dtor-proc-macro](https://github.com/mmastrac/rust-ctor) | 0.0.6 | Apache-2.0 OR MIT |
| [dunce](https://gitlab.com/kornelski/dunce) | 1.0.5 | CC0-1.0 OR MIT-0 OR Apache-2.0 |
| [dyn-clone](https://github.com/dtolnay/dyn-clone) | 1.0.20 | MIT OR Apache-2.0 |
| [dynify](https://github.com/loichyan/dynify) | 0.1.2 | MIT OR Apache-2.0 |
| [dynify-macros](https://github.com/loichyan/dynify) | 0.1.2 | MIT OR Apache-2.0 |
| [earcutr](https://github.com/frewsxcv/earcutr/) | 0.4.3 | ISC |
| [ecb](https://github.com/magic-akari/ecb) | 0.2.0 | MIT |
| [ed25519](https://github.com/RustCrypto/signatures/tree/master/ed25519) | 2.2.3 | Apache-2.0 OR MIT |
| [ed25519-dalek](https://github.com/dalek-cryptography/curve25519-dalek/tree/main/ed25519-dalek) | 2.2.0 | BSD-3-Clause |
| [either](https://github.com/rayon-rs/either) | 1.16.0 | MIT OR Apache-2.0 |
| [either](https://github.com/rayon-rs/either) | 1.17.0 | MIT OR Apache-2.0 |
| [embed-resource](https://github.com/nabijaczleweli/rust-embed-resource) | 3.0.9 | MIT |
| [embed_plist](https://github.com/nvzqz/embed-plist-rs) | 1.2.2 | MIT OR Apache-2.0 |
| [encoding_rs](https://github.com/hsivonen/encoding_rs) | 0.8.35 | (Apache-2.0 OR MIT) AND BSD-3-Clause |
| [endi](https://github.com/zeenix/endi) | 1.1.1 | MIT |
| [enumflags2](https://github.com/meithecatte/enumflags2) | 0.7.12 | MIT OR Apache-2.0 |
| [enumflags2_derive](https://github.com/meithecatte/enumflags2) | 0.7.12 | MIT OR Apache-2.0 |
| [env_filter](https://github.com/rust-cli/env_logger) | 0.1.4 | MIT OR Apache-2.0 |
| [equator](https://github.com/sarah-ek/equator/) | 0.4.2 | MIT |
| [equator-macro](https://github.com/sarah-ek/equator/) | 0.4.2 | MIT |
| [equivalent](https://github.com/indexmap-rs/equivalent) | 1.0.2 | Apache-2.0 OR MIT |
| [erased-serde](https://github.com/dtolnay/erased-serde) | 0.4.10 | MIT OR Apache-2.0 |
| [errno](https://github.com/lambda-fairy/rust-errno) | 0.3.14 | MIT OR Apache-2.0 |
| [event-listener](https://github.com/smol-rs/event-listener) | 5.4.1 | Apache-2.0 OR MIT |
| [event-listener-strategy](https://github.com/smol-rs/event-listener-strategy) | 0.5.4 | Apache-2.0 OR MIT |
| [fast-float2](https://github.com/Alexhuszagh/fast-float-rust) | 0.2.3 | MIT OR Apache-2.0 |
| [fastrand](https://github.com/smol-rs/fastrand) | 2.4.1 | Apache-2.0 OR MIT |
| [fastrand](https://github.com/smol-rs/fastrand) | 2.5.0 | Apache-2.0 OR MIT |
| [fax](https://github.com/pdf-rs/fax) | 0.2.7 | MIT |
| [fdeflate](https://github.com/image-rs/fdeflate) | 0.3.7 | MIT OR Apache-2.0 |
| [fern](https://github.com/daboross/fern) | 0.7.1 | MIT |
| [fiat-crypto](https://github.com/mit-plv/fiat-crypto) | 0.2.9 | MIT OR Apache-2.0 OR BSD-1-Clause |
| [field-offset](https://github.com/Diggsey/rust-field-offset) | 0.3.6 | MIT OR Apache-2.0 |
| [filetime](https://github.com/alexcrichton/filetime) | 0.2.29 | MIT/Apache-2.0 |
| [find-msvc-tools](https://github.com/rust-lang/cc-rs) | 0.1.9 | MIT OR Apache-2.0 |
| [fixedbitset](https://github.com/petgraph/fixedbitset) | 0.5.7 | MIT OR Apache-2.0 |
| [flate2](https://github.com/rust-lang/flate2-rs) | 1.1.9 | MIT OR Apache-2.0 |
| [flo_curves](https://github.com/Logicalshift/flo_curves) | 0.3.1 | Apache-2.0 |
| [flo_curves](https://github.com/Logicalshift/flo_curves) | 0.8.0 | Apache-2.0 |
| [float_next_after](https://gitlab.com/bronsonbdevost/next_afterf) | 1.0.0 | MIT |
| [fnv](https://github.com/servo/rust-fnv) | 1.0.7 | Apache-2.0 / MIT |
| [foldhash](https://github.com/orlp/foldhash) | 0.1.5 | Zlib |
| [foldhash](https://github.com/orlp/foldhash) | 0.2.0 | Zlib |
| [foreign-types](https://github.com/sfackler/foreign-types) | 0.5.0 | MIT/Apache-2.0 |
| [foreign-types-macros](https://github.com/sfackler/foreign-types) | 0.2.3 | MIT/Apache-2.0 |
| [foreign-types-macros](https://github.com/sfackler/foreign-types) | 0.2.4 | MIT/Apache-2.0 |
| [foreign-types-shared](https://github.com/sfackler/foreign-types) | 0.3.1 | MIT/Apache-2.0 |
| [form_urlencoded](https://github.com/servo/rust-url) | 1.2.2 | MIT OR Apache-2.0 |
| [funty](https://github.com/myrrlyn/funty) | 2.0.0 | MIT |
| [futures-channel](https://github.com/rust-lang/futures-rs) | 0.3.32 | MIT OR Apache-2.0 |
| [futures-channel](https://github.com/rust-lang/futures-rs) | 0.3.33 | MIT OR Apache-2.0 |
| [futures-concurrency](https://github.com/yoshuawuyts/futures-concurrency) | 7.7.1 | MIT OR Apache-2.0 |
| [futures-core](https://github.com/rust-lang/futures-rs) | 0.3.32 | MIT OR Apache-2.0 |
| [futures-core](https://github.com/rust-lang/futures-rs) | 0.3.33 | MIT OR Apache-2.0 |
| [futures-executor](https://github.com/rust-lang/futures-rs) | 0.3.32 | MIT OR Apache-2.0 |
| [futures-io](https://github.com/rust-lang/futures-rs) | 0.3.32 | MIT OR Apache-2.0 |
| [futures-io](https://github.com/rust-lang/futures-rs) | 0.3.33 | MIT OR Apache-2.0 |
| [futures-lite](https://github.com/smol-rs/futures-lite) | 2.6.1 | Apache-2.0 OR MIT |
| [futures-macro](https://github.com/rust-lang/futures-rs) | 0.3.32 | MIT OR Apache-2.0 |
| [futures-sink](https://github.com/rust-lang/futures-rs) | 0.3.32 | MIT OR Apache-2.0 |
| [futures-task](https://github.com/rust-lang/futures-rs) | 0.3.32 | MIT OR Apache-2.0 |
| [futures-task](https://github.com/rust-lang/futures-rs) | 0.3.33 | MIT OR Apache-2.0 |
| [futures-util](https://github.com/rust-lang/futures-rs) | 0.3.32 | MIT OR Apache-2.0 |
| [futures-util](https://github.com/rust-lang/futures-rs) | 0.3.33 | MIT OR Apache-2.0 |
| [gdk](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [gdk-pixbuf](https://github.com/gtk-rs/gtk-rs-core) | 0.18.5 | MIT |
| [gdk-pixbuf-sys](https://github.com/gtk-rs/gtk-rs-core) | 0.18.0 | MIT |
| [gdk-sys](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [gdkwayland-sys](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [gdkx11](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [gdkx11-sys](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [generic-array](https://github.com/fizyk20/generic-array) | 0.14.7 | MIT |
| [geo](https://github.com/georust/geo) | 0.28.0 | MIT OR Apache-2.0 |
| [geo-types](https://github.com/georust/geo) | 0.7.19 | MIT OR Apache-2.0 |
| [geographiclib-rs](https://github.com/georust/geographiclib-rs) | 0.2.7 | MIT |
| [getrandom](https://github.com/rust-random/getrandom) | 0.2.17 | MIT OR Apache-2.0 |
| [getrandom](https://github.com/rust-random/getrandom) | 0.3.4 | MIT OR Apache-2.0 |
| [getrandom](https://github.com/rust-random/getrandom) | 0.4.2 | MIT OR Apache-2.0 |
| [getrandom](https://github.com/rust-random/getrandom) | 0.4.3 | MIT OR Apache-2.0 |
| [ghash](https://github.com/RustCrypto/universal-hashes) | 0.5.1 | Apache-2.0 OR MIT |
| [gif](https://github.com/image-rs/image-gif) | 0.14.2 | MIT OR Apache-2.0 |
| [gio](https://github.com/gtk-rs/gtk-rs-core) | 0.18.4 | MIT |
| [gio-sys](https://github.com/gtk-rs/gtk-rs-core) | 0.18.1 | MIT |
| [glib](https://github.com/gtk-rs/gtk-rs-core) | 0.18.5 | MIT |
| [glib-macros](https://github.com/gtk-rs/gtk-rs-core) | 0.18.5 | MIT |
| [glib-sys](https://github.com/gtk-rs/gtk-rs-core) | 0.18.1 | MIT |
| [glob](https://github.com/rust-lang/glob) | 0.3.3 | MIT OR Apache-2.0 |
| [gobject-sys](https://github.com/gtk-rs/gtk-rs-core) | 0.18.0 | MIT |
| [gtk](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [gtk-sys](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [gtk3-macros](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [half](https://github.com/VoidStarKat/half-rs) | 2.7.1 | MIT OR Apache-2.0 |
| [hash32](https://github.com/japaric/hash32) | 0.3.1 | MIT OR Apache-2.0 |
| [hashbrown](https://github.com/rust-lang/hashbrown) | 0.12.3 | MIT OR Apache-2.0 |
| [hashbrown](https://github.com/rust-lang/hashbrown) | 0.14.5 | MIT OR Apache-2.0 |
| [hashbrown](https://github.com/rust-lang/hashbrown) | 0.15.5 | MIT OR Apache-2.0 |
| [hashbrown](https://github.com/rust-lang/hashbrown) | 0.16.1 | MIT OR Apache-2.0 |
| [hashbrown](https://github.com/rust-lang/hashbrown) | 0.17.1 | MIT OR Apache-2.0 |
| [hayro-font](https://github.com/LaurenzV/hayro) | 0.4.0 | Apache-2.0 OR MIT |
| [heapless](https://github.com/rust-embedded/heapless) | 0.8.0 | MIT OR Apache-2.0 |
| [heck](https://github.com/withoutboats/heck) | 0.4.1 | MIT OR Apache-2.0 |
| [heck](https://github.com/withoutboats/heck) | 0.5.0 | MIT OR Apache-2.0 |
| [hermit-abi](https://github.com/hermit-os/hermit-rs) | 0.5.2 | MIT OR Apache-2.0 |
| [hex](https://github.com/KokaKiwi/rust-hex) | 0.4.3 | MIT OR Apache-2.0 |
| [hmac](https://github.com/RustCrypto/MACs) | 0.12.1 | MIT OR Apache-2.0 |
| [html5ever](https://github.com/servo/html5ever) | 0.38.0 | MIT OR Apache-2.0 |
| [http](https://github.com/hyperium/http) | 1.4.1 | MIT OR Apache-2.0 |
| [http-body](https://github.com/hyperium/http-body) | 1.0.1 | MIT |
| [http-body-util](https://github.com/hyperium/http-body) | 0.1.3 | MIT |
| [http-range](https://github.com/bancek/rust-http-range) | 0.1.5 | MIT |
| [httparse](https://github.com/seanmonstar/httparse) | 1.10.1 | MIT OR Apache-2.0 |
| [hybrid-array](https://github.com/RustCrypto/hybrid-array) | 0.4.13 | MIT OR Apache-2.0 |
| [hybrid-array](https://github.com/RustCrypto/hybrid-array) | 0.4.14 | MIT OR Apache-2.0 |
| [hyper](https://github.com/hyperium/hyper) | 1.10.0 | MIT |
| [hyper-rustls](https://github.com/rustls/hyper-rustls) | 0.27.9 | Apache-2.0 OR ISC OR MIT |
| [hyper-util](https://github.com/hyperium/hyper-util) | 0.1.20 | MIT |
| [iana-time-zone](https://github.com/strawlab/iana-time-zone) | 0.1.65 | MIT OR Apache-2.0 |
| [iana-time-zone-haiku](https://github.com/strawlab/iana-time-zone) | 0.1.2 | MIT OR Apache-2.0 |
| [ico](https://github.com/mdsteele/rust-ico) | 0.5.0 | MIT |
| [icu_collections](https://github.com/unicode-org/icu4x) | 2.0.0 | Unicode-3.0 |
| [icu_collections](https://github.com/unicode-org/icu4x) | 2.2.0 | Unicode-3.0 |
| [icu_locale_core](https://github.com/unicode-org/icu4x) | 2.2.0 | Unicode-3.0 |
| [icu_normalizer](https://github.com/unicode-org/icu4x) | 2.0.1 | Unicode-3.0 |
| [icu_normalizer](https://github.com/unicode-org/icu4x) | 2.2.0 | Unicode-3.0 |
| [icu_normalizer_data](https://github.com/unicode-org/icu4x) | 2.0.0 | Unicode-3.0 |
| [icu_normalizer_data](https://github.com/unicode-org/icu4x) | 2.2.0 | Unicode-3.0 |
| [icu_properties](https://github.com/unicode-org/icu4x) | 2.0.2 | Unicode-3.0 |
| [icu_properties](https://github.com/unicode-org/icu4x) | 2.2.0 | Unicode-3.0 |
| [icu_properties_data](https://github.com/unicode-org/icu4x) | 2.0.1 | Unicode-3.0 |
| [icu_properties_data](https://github.com/unicode-org/icu4x) | 2.2.0 | Unicode-3.0 |
| [icu_provider](https://github.com/unicode-org/icu4x) | 2.2.0 | Unicode-3.0 |
| [id-arena](https://github.com/fitzgen/id-arena) | 2.3.0 | MIT/Apache-2.0 |
| [ident_case](https://github.com/TedDriggs/ident_case) | 1.0.1 | MIT/Apache-2.0 |
| [idna](https://github.com/servo/rust-url/) | 1.1.0 | MIT OR Apache-2.0 |
| [idna_adapter](https://github.com/hsivonen/idna_adapter) | 1.2.2 | Apache-2.0 OR MIT |
| [image](https://github.com/image-rs/image) | 0.25.10 | MIT OR Apache-2.0 |
| [image-webp](https://github.com/image-rs/image-webp) | 0.2.4 | MIT OR Apache-2.0 |
| [indexmap](https://github.com/bluss/indexmap) | 1.9.3 | Apache-2.0 OR MIT |
| [indexmap](https://github.com/indexmap-rs/indexmap) | 2.14.0 | Apache-2.0 OR MIT |
| [infer](https://github.com/bojand/infer) | 0.19.0 | MIT |
| [inout](https://github.com/RustCrypto/utils) | 0.1.4 | MIT OR Apache-2.0 |
| [inout](https://github.com/RustCrypto/utils) | 0.2.2 | MIT OR Apache-2.0 |
| [intrusive-collections](https://github.com/Amanieu/intrusive-rs) | 0.9.7 | Apache-2.0/MIT |
| [ipnet](https://github.com/krisprice/ipnet) | 2.12.0 | MIT OR Apache-2.0 |
| [is-docker](https://github.com/TheLarkInn/is-docker) | 0.2.0 | MIT |
| [is-wsl](https://github.com/TheLarkInn/is-wsl) | 0.4.0 | MIT |
| [itertools](https://github.com/rust-itertools/itertools) | 0.11.0 | MIT OR Apache-2.0 |
| [itertools](https://github.com/rust-itertools/itertools) | 0.14.0 | MIT OR Apache-2.0 |
| [itertools](https://github.com/rust-itertools/itertools) | 0.15.0 | MIT OR Apache-2.0 |
| [itertools](https://github.com/bluss/rust-itertools) | 0.8.2 | MIT/Apache-2.0 |
| [itoa](https://github.com/dtolnay/itoa) | 1.0.18 | MIT OR Apache-2.0 |
| [javascriptcore-rs](https://github.com/tauri-apps/javascriptcore-rs) | 1.1.2 | MIT |
| [javascriptcore-rs-sys](https://github.com/tauri-apps/javascriptcore-rs) | 1.1.1 | MIT |
| [jni](https://github.com/jni-rs/jni-rs) | 0.21.1 | MIT/Apache-2.0 |
| [jni](https://github.com/jni-rs/jni-rs) | 0.22.4 | MIT OR Apache-2.0 |
| [jni-macros](https://github.com/jni-rs/jni-rs) | 0.22.4 | MIT OR Apache-2.0 |
| [jni-sys](https://github.com/jni-rs/jni-sys) | 0.3.1 | MIT OR Apache-2.0 |
| [jni-sys](https://github.com/jni-rs/jni-sys) | 0.4.1 | MIT OR Apache-2.0 |
| [jni-sys-macros](https://github.com/jni-rs/jni-sys) | 0.4.1 | MIT OR Apache-2.0 |
| [jobserver](https://github.com/rust-lang/jobserver-rs) | 0.1.35 | MIT OR Apache-2.0 |
| [jpeg-decoder](https://github.com/image-rs/jpeg-decoder) | 0.3.2 | MIT OR Apache-2.0 |
| [js-sys](https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/js-sys) | 0.3.103 | MIT OR Apache-2.0 |
| [js-sys](https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/js-sys) | 0.3.99 | MIT OR Apache-2.0 |
| [json-patch](https://github.com/idubrov/json-patch) | 3.0.1 | MIT/Apache-2.0 |
| [jsonptr](https://github.com/chanced/jsonptr) | 0.6.3 | MIT OR Apache-2.0 |
| [keyboard-types](https://github.com/pyfisch/keyboard-types) | 0.7.0 | MIT OR Apache-2.0 |
| [lcms2](https://github.com/kornelski/rust-lcms2) | 6.1.1 | MIT |
| [lcms2-sys](https://github.com/kornelski/rust-lcms2-sys) | 4.0.7 | MIT |
| [leb128fmt](https://github.com/bluk/leb128fmt) | 0.1.0 | MIT OR Apache-2.0 |
| libappindicator | 0.9.0 | Apache-2.0 OR MIT |
| libappindicator-sys | 0.9.0 | Apache-2.0 OR MIT |
| [libc](https://github.com/rust-lang/libc) | 0.2.186 | MIT OR Apache-2.0 |
| [libc](https://github.com/rust-lang/libc) | 0.2.189 | MIT OR Apache-2.0 |
| [libdbus-sys](https://github.com/diwic/dbus-rs) | 0.2.7 | Apache-2.0/MIT |
| [libloading](https://github.com/nagisa/rust_libloading/) | 0.7.4 | ISC |
| [libloading](https://github.com/nagisa/rust_libloading/) | 0.9.0 | ISC |
| [libm](https://github.com/rust-lang/compiler-builtins) | 0.2.16 | MIT |
| [libredox](https://gitlab.redox-os.org/redox-os/libredox) | 0.1.17 | MIT |
| [linux-raw-sys](https://github.com/sunfishcode/linux-raw-sys) | 0.12.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [litemap](https://github.com/unicode-org/icu4x) | 0.8.2 | Unicode-3.0 |
| [lock_api](https://github.com/Amanieu/parking_lot) | 0.4.14 | MIT OR Apache-2.0 |
| [log](https://github.com/rust-lang/log) | 0.4.30 | MIT OR Apache-2.0 |
| [log](https://github.com/rust-lang/log) | 0.4.32 | MIT OR Apache-2.0 |
| [log](https://github.com/rust-lang/log) | 0.4.33 | MIT OR Apache-2.0 |
| [lopdf](https://github.com/J-F-Liu/lopdf) | 0.44.0 | MIT |
| [markup5ever](https://github.com/servo/html5ever) | 0.38.0 | MIT OR Apache-2.0 |
| [matrixmultiply](https://github.com/bluss/matrixmultiply/) | 0.3.11 | MIT/Apache-2.0 |
| [maybe-owned](https://github.com/rustonaut/maybe-owned) | 0.3.4 | MIT OR Apache-2.0 |
| [md-5](https://github.com/RustCrypto/hashes) | 0.11.0 | MIT OR Apache-2.0 |
| [memchr](https://github.com/BurntSushi/memchr) | 2.8.1 | Unlicense OR MIT |
| [memchr](https://github.com/BurntSushi/memchr) | 2.8.3 | Unlicense OR MIT |
| [memoffset](https://github.com/Gilnaa/memoffset) | 0.9.1 | MIT |
| [mime](https://github.com/hyperium/mime) | 0.3.17 | MIT OR Apache-2.0 |
| [minisign-verify](https://github.com/jedisct1/rust-minisign-verify) | 0.2.5 | MIT |
| [miniz_oxide](https://github.com/Frommi/miniz_oxide/tree/master/miniz_oxide) | 0.8.9 | MIT OR Zlib OR Apache-2.0 |
| [mio](https://github.com/tokio-rs/mio) | 1.2.0 | MIT |
| [moxcms](https://github.com/awxkee/moxcms) | 0.8.1 | BSD-3-Clause OR Apache-2.0 |
| [muda](https://github.com/tauri-apps/muda) | 0.19.2 | Apache-2.0 OR MIT |
| [ndarray](https://github.com/rust-ndarray/ndarray) | 0.17.2 | MIT OR Apache-2.0 |
| [ndk](https://github.com/rust-mobile/ndk) | 0.9.0 | MIT OR Apache-2.0 |
| [ndk-sys](https://github.com/rust-mobile/ndk) | 0.6.0+11769913 | MIT OR Apache-2.0 |
| [new_debug_unreachable](https://github.com/mbrubeck/rust-debug-unreachable) | 1.0.6 | MIT |
| [nom](https://github.com/rust-bakery/nom) | 8.0.0 | MIT |
| [num-bigint](https://github.com/rust-num/num-bigint) | 0.4.8 | MIT OR Apache-2.0 |
| [num-complex](https://github.com/rust-num/num-complex) | 0.4.6 | MIT OR Apache-2.0 |
| [num-conv](https://github.com/jhpratt/num-conv) | 0.2.2 | MIT OR Apache-2.0 |
| [num-integer](https://github.com/rust-num/num-integer) | 0.1.46 | MIT OR Apache-2.0 |
| [num-traits](https://github.com/rust-num/num-traits) | 0.2.19 | MIT OR Apache-2.0 |
| [num_enum](https://github.com/illicitonion/num_enum) | 0.7.6 | BSD-3-Clause OR MIT OR Apache-2.0 |
| [num_enum_derive](https://github.com/illicitonion/num_enum) | 0.7.6 | BSD-3-Clause OR MIT OR Apache-2.0 |
| [num_threads](https://github.com/jhpratt/num_threads) | 0.1.7 | MIT OR Apache-2.0 |
| [numpy](https://github.com/PyO3/rust-numpy) | 0.29.0 | BSD-2-Clause |
| [objc2](https://github.com/madsmtm/objc2) | 0.6.4 | MIT |
| [objc2-app-kit](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-cloud-kit](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-core-data](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-core-foundation](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-core-graphics](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-core-image](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-core-location](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-core-text](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-encode](https://github.com/madsmtm/objc2) | 4.1.0 | MIT |
| [objc2-exception-helper](https://github.com/madsmtm/objc2) | 0.1.1 | Zlib OR Apache-2.0 OR MIT |
| [objc2-foundation](https://github.com/madsmtm/objc2) | 0.3.2 | MIT |
| [objc2-io-surface](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-osa-kit](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-quartz-core](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-ui-kit](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-user-notifications](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-web-kit](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [once_cell](https://github.com/matklad/once_cell) | 1.21.4 | MIT OR Apache-2.0 |
| [opaque-debug](https://github.com/RustCrypto/utils) | 0.3.1 | MIT OR Apache-2.0 |
| [open](https://github.com/Byron/open-rs) | 5.3.5 | MIT |
| [openssl-probe](https://github.com/rustls/openssl-probe) | 0.2.1 | MIT OR Apache-2.0 |
| [option-ext](https://github.com/soc/option-ext) | 0.2.0 | MPL-2.0 |
| [ordered-multimap](https://github.com/sgodwincs/ordered-multimap-rs) | 0.7.3 | MIT |
| [ordered-stream](https://github.com/danieldg/ordered-stream) | 0.2.0 | MIT OR Apache-2.0 |
| [os_pipe](https://github.com/oconnor663/os_pipe.rs) | 1.2.3 | MIT |
| [osakit](https://github.com/mdevils/rust-osakit) | 0.3.1 | MIT OR Apache-2.0 |
| [ouroboros](https://github.com/joshua-maros/ouroboros) | 0.17.2 | MIT OR Apache-2.0 |
| [ouroboros_macro](https://github.com/joshua-maros/ouroboros) | 0.17.2 | MIT OR Apache-2.0 |
| [pango](https://github.com/gtk-rs/gtk-rs-core) | 0.18.3 | MIT |
| [pango-sys](https://github.com/gtk-rs/gtk-rs-core) | 0.18.0 | MIT |
| [parking](https://github.com/smol-rs/parking) | 2.2.1 | Apache-2.0 OR MIT |
| [parking_lot](https://github.com/Amanieu/parking_lot) | 0.12.5 | MIT OR Apache-2.0 |
| [parking_lot_core](https://github.com/Amanieu/parking_lot) | 0.9.12 | MIT OR Apache-2.0 |
| [paste](https://github.com/dtolnay/paste) | 1.0.15 | MIT OR Apache-2.0 |
| [pathdiff](https://github.com/Manishearth/pathdiff) | 0.2.3 | MIT/Apache-2.0 |
| [pdfium-render](https://github.com/ajrcarey/pdfium-render) | 0.8.37 | MIT OR Apache-2.0 |
| [percent-encoding](https://github.com/servo/rust-url/) | 2.3.2 | MIT OR Apache-2.0 |
| [phf](https://github.com/rust-phf/rust-phf) | 0.13.1 | MIT |
| [phf_codegen](https://github.com/rust-phf/rust-phf) | 0.13.1 | MIT |
| [phf_generator](https://github.com/rust-phf/rust-phf) | 0.13.1 | MIT |
| [phf_macros](https://github.com/rust-phf/rust-phf) | 0.13.1 | MIT |
| [phf_shared](https://github.com/rust-phf/rust-phf) | 0.13.1 | MIT |
| [pin-project](https://github.com/taiki-e/pin-project) | 1.1.13 | Apache-2.0 OR MIT |
| [pin-project-internal](https://github.com/taiki-e/pin-project) | 1.1.13 | Apache-2.0 OR MIT |
| [pin-project-lite](https://github.com/taiki-e/pin-project-lite) | 0.2.17 | Apache-2.0 OR MIT |
| [piper](https://github.com/smol-rs/piper) | 0.2.5 | MIT OR Apache-2.0 |
| [piston-float](https://github.com/pistondevelopers/float) | 1.0.1 | MIT |
| [pkcs8](https://github.com/RustCrypto/formats/tree/master/pkcs8) | 0.10.2 | Apache-2.0 OR MIT |
| [pkg-config](https://github.com/rust-lang/pkg-config-rs) | 0.3.33 | MIT OR Apache-2.0 |
| [plist](https://github.com/ebarnard/rust-plist/) | 1.10.0 | MIT |
| [png](https://github.com/image-rs/image-png) | 0.17.16 | MIT OR Apache-2.0 |
| [png](https://github.com/image-rs/image-png) | 0.18.1 | MIT OR Apache-2.0 |
| [polling](https://github.com/smol-rs/polling) | 3.11.0 | Apache-2.0 OR MIT |
| [polyval](https://github.com/RustCrypto/universal-hashes) | 0.6.2 | Apache-2.0 OR MIT |
| [portable-atomic](https://github.com/taiki-e/portable-atomic) | 1.14.0 | Apache-2.0 OR MIT |
| [portable-atomic-util](https://github.com/taiki-e/portable-atomic-util) | 0.2.7 | Apache-2.0 OR MIT |
| [potential_utf](https://github.com/unicode-org/icu4x) | 0.1.5 | Unicode-3.0 |
| [powerfmt](https://github.com/jhpratt/powerfmt) | 0.2.0 | MIT OR Apache-2.0 |
| [ppv-lite86](https://github.com/cryptocorrosion/cryptocorrosion) | 0.2.21 | MIT OR Apache-2.0 |
| [precomputed-hash](https://github.com/emilio/precomputed-hash) | 0.1.1 | MIT |
| [prettyplease](https://github.com/dtolnay/prettyplease) | 0.2.37 | MIT OR Apache-2.0 |
| [proc-macro-crate](https://github.com/bkchr/proc-macro-crate) | 1.3.1 | MIT OR Apache-2.0 |
| [proc-macro-crate](https://github.com/bkchr/proc-macro-crate) | 2.0.2 | MIT OR Apache-2.0 |
| [proc-macro-crate](https://github.com/bkchr/proc-macro-crate) | 3.5.0 | MIT OR Apache-2.0 |
| [proc-macro-error](https://gitlab.com/CreepySkeleton/proc-macro-error) | 1.0.4 | MIT OR Apache-2.0 |
| [proc-macro-error-attr](https://gitlab.com/CreepySkeleton/proc-macro-error) | 1.0.4 | MIT OR Apache-2.0 |
| [proc-macro2](https://github.com/dtolnay/proc-macro2) | 1.0.106 | MIT OR Apache-2.0 |
| [proc-macro2](https://github.com/dtolnay/proc-macro2) | 1.0.107 | MIT OR Apache-2.0 |
| [ptr_meta](https://github.com/djkoloski/ptr_meta) | 0.1.4 | MIT |
| [ptr_meta_derive](https://github.com/djkoloski/ptr_meta) | 0.1.4 | MIT |
| [pxfm](https://github.com/awxkee/pxfm) | 0.1.29 | BSD-3-Clause OR Apache-2.0 |
| [pxfm](https://github.com/awxkee/pxfm) | 0.1.30 | BSD-3-Clause OR Apache-2.0 |
| [pyo3](https://github.com/pyo3/pyo3) | 0.29.0 | MIT OR Apache-2.0 |
| [pyo3-build-config](https://github.com/pyo3/pyo3) | 0.29.0 | MIT OR Apache-2.0 |
| [pyo3-ffi](https://github.com/pyo3/pyo3) | 0.29.0 | MIT OR Apache-2.0 |
| [pyo3-macros](https://github.com/pyo3/pyo3) | 0.29.0 | MIT OR Apache-2.0 |
| [pyo3-macros-backend](https://github.com/pyo3/pyo3) | 0.29.0 | MIT OR Apache-2.0 |
| [quick-error](http://github.com/tailhook/quick-error) | 2.0.1 | MIT/Apache-2.0 |
| [quick-xml](https://github.com/tafia/quick-xml) | 0.41.0 | MIT |
| [quote](https://github.com/dtolnay/quote) | 1.0.45 | MIT OR Apache-2.0 |
| [quote](https://github.com/dtolnay/quote) | 1.0.47 | MIT OR Apache-2.0 |
| [r-efi](https://github.com/r-efi/r-efi) | 5.3.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later |
| [r-efi](https://github.com/r-efi/r-efi) | 6.0.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later |
| [radium](https://github.com/bitvecto-rs/radium) | 0.7.0 | MIT |
| [rand](https://github.com/rust-random/rand) | 0.10.2 | MIT OR Apache-2.0 |
| [rand](https://github.com/rust-random/rand) | 0.8.6 | MIT OR Apache-2.0 |
| [rand](https://github.com/rust-random/rand) | 0.9.5 | MIT OR Apache-2.0 |
| [rand_chacha](https://github.com/rust-random/rand) | 0.3.1 | MIT OR Apache-2.0 |
| [rand_chacha](https://github.com/rust-random/rand) | 0.9.0 | MIT OR Apache-2.0 |
| [rand_core](https://github.com/rust-random/rand_core) | 0.10.1 | MIT OR Apache-2.0 |
| [rand_core](https://github.com/rust-random/rand) | 0.6.4 | MIT OR Apache-2.0 |
| [rand_core](https://github.com/rust-random/rand) | 0.9.5 | MIT OR Apache-2.0 |
| [rangemap](https://github.com/jeffparsons/rangemap) | 1.7.1 | MIT/Apache-2.0 |
| [raw-window-handle](https://github.com/rust-windowing/raw-window-handle) | 0.6.2 | MIT OR Apache-2.0 OR Zlib |
| [rawpointer](https://github.com/bluss/rawpointer/) | 0.2.1 | MIT/Apache-2.0 |
| [rayon](https://github.com/rayon-rs/rayon) | 1.12.0 | MIT OR Apache-2.0 |
| [rayon-core](https://github.com/rayon-rs/rayon) | 1.13.0 | MIT OR Apache-2.0 |
| [redox_syscall](https://gitlab.redox-os.org/redox-os/syscall) | 0.5.18 | MIT |
| [redox_users](https://gitlab.redox-os.org/redox-os/users) | 0.5.2 | MIT |
| [ref-cast](https://github.com/dtolnay/ref-cast) | 1.0.25 | MIT OR Apache-2.0 |
| [ref-cast-impl](https://github.com/dtolnay/ref-cast) | 1.0.25 | MIT OR Apache-2.0 |
| [regex](https://github.com/rust-lang/regex) | 1.12.3 | MIT OR Apache-2.0 |
| [regex-automata](https://github.com/rust-lang/regex) | 0.4.14 | MIT OR Apache-2.0 |
| [regex-syntax](https://github.com/rust-lang/regex) | 0.8.10 | MIT OR Apache-2.0 |
| [regress](https://github.com/ridiculousfish/regress) | 0.10.5 | MIT OR Apache-2.0 |
| [rend](https://github.com/djkoloski/rend) | 0.4.2 | MIT |
| [reqwest](https://github.com/seanmonstar/reqwest) | 0.13.4 | MIT OR Apache-2.0 |
| [rfd](https://github.com/PolyMeilex/rfd) | 0.16.0 | MIT |
| [ring](https://github.com/briansmith/ring) | 0.17.14 | Apache-2.0 AND ISC |
| [rkyv](https://github.com/rkyv/rkyv) | 0.7.46 | MIT |
| [rkyv_derive](https://github.com/rkyv/rkyv) | 0.7.46 | MIT |
| [robust](https://github.com/georust/robust) | 1.2.0 | MIT OR Apache-2.0 |
| [roots](https://github.com/vorot/roots) | 0.0.6 | BSD-2-Clause |
| [roots](https://github.com/vorot/roots) | 0.0.8 | BSD-2-Clause |
| [rstar](https://github.com/georust/rstar) | 0.12.2 | MIT OR Apache-2.0 |
| [rust-ini](https://github.com/zonyitoo/rust-ini) | 0.21.3 | MIT |
| [rust_decimal](https://github.com/paupino/rust-decimal) | 1.42.0 | MIT |
| [rustc-hash](https://github.com/rust-lang/rustc-hash) | 2.1.2 | Apache-2.0 OR MIT |
| [rustc-hash](https://github.com/rust-lang/rustc-hash) | 2.1.3 | Apache-2.0 OR MIT |
| [rustc_version](https://github.com/djc/rustc-version-rs) | 0.4.1 | MIT OR Apache-2.0 |
| [rustix](https://github.com/bytecodealliance/rustix) | 1.1.4 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [rustls](https://github.com/rustls/rustls) | 0.23.40 | Apache-2.0 OR ISC OR MIT |
| [rustls-native-certs](https://github.com/rustls/rustls-native-certs) | 0.8.3 | Apache-2.0 OR ISC OR MIT |
| [rustls-pki-types](https://github.com/rustls/pki-types) | 1.14.1 | MIT OR Apache-2.0 |
| [rustls-platform-verifier](https://github.com/rustls/rustls-platform-verifier) | 0.7.0 | MIT OR Apache-2.0 |
| [rustls-platform-verifier-android](https://github.com/rustls/rustls-platform-verifier) | 0.1.1 | MIT OR Apache-2.0 |
| [rustls-webpki](https://github.com/rustls/webpki) | 0.103.13 | ISC |
| [rustversion](https://github.com/dtolnay/rustversion) | 1.0.22 | MIT OR Apache-2.0 |
| [rustversion](https://github.com/dtolnay/rustversion) | 1.0.23 | MIT OR Apache-2.0 |
| [ryu-js](https://github.com/boa-dev/ryu-js) | 1.0.3 | Apache-2.0 OR BSL-1.0 |
| [same-file](https://github.com/BurntSushi/same-file) | 1.0.6 | Unlicense/MIT |
| [schannel](https://github.com/steffengy/schannel-rs) | 0.1.29 | MIT |
| [schemars](https://github.com/GREsau/schemars) | 0.8.22 | MIT |
| [schemars](https://github.com/GREsau/schemars) | 0.9.0 | MIT |
| [schemars](https://github.com/GREsau/schemars) | 1.2.1 | MIT |
| [schemars_derive](https://github.com/GREsau/schemars) | 0.8.22 | MIT |
| [scopeguard](https://github.com/bluss/scopeguard) | 1.2.0 | MIT OR Apache-2.0 |
| [seahash](https://gitlab.redox-os.org/redox-os/seahash) | 4.1.0 | MIT |
| [security-framework](https://github.com/kornelski/rust-security-framework) | 3.7.0 | MIT OR Apache-2.0 |
| [security-framework-sys](https://github.com/kornelski/rust-security-framework) | 2.17.0 | MIT OR Apache-2.0 |
| [selectors](https://github.com/servo/stylo) | 0.36.1 | MPL-2.0 |
| [semver](https://github.com/dtolnay/semver) | 1.0.28 | MIT OR Apache-2.0 |
| [serde](https://github.com/serde-rs/serde) | 1.0.228 | MIT OR Apache-2.0 |
| [serde](https://github.com/serde-rs/serde) | 1.0.229 | MIT OR Apache-2.0 |
| [serde-untagged](https://github.com/dtolnay/serde-untagged) | 0.1.9 | MIT OR Apache-2.0 |
| [serde_core](https://github.com/serde-rs/serde) | 1.0.228 | MIT OR Apache-2.0 |
| [serde_core](https://github.com/serde-rs/serde) | 1.0.229 | MIT OR Apache-2.0 |
| [serde_derive](https://github.com/serde-rs/serde) | 1.0.228 | MIT OR Apache-2.0 |
| [serde_derive](https://github.com/serde-rs/serde) | 1.0.229 | MIT OR Apache-2.0 |
| [serde_derive_internals](https://github.com/serde-rs/serde) | 0.29.1 | MIT OR Apache-2.0 |
| [serde_json](https://github.com/serde-rs/json) | 1.0.150 | MIT OR Apache-2.0 |
| [serde_json](https://github.com/serde-rs/json) | 1.0.151 | MIT OR Apache-2.0 |
| [serde_repr](https://github.com/dtolnay/serde-repr) | 0.1.20 | MIT OR Apache-2.0 |
| [serde_spanned](https://github.com/toml-rs/toml) | 0.6.9 | MIT OR Apache-2.0 |
| [serde_spanned](https://github.com/toml-rs/toml) | 1.1.1 | MIT OR Apache-2.0 |
| [serde_with](https://github.com/jonasbb/serde_with/) | 3.20.0 | MIT OR Apache-2.0 |
| [serde_with_macros](https://github.com/jonasbb/serde_with/) | 3.20.0 | MIT OR Apache-2.0 |
| [serialize-to-javascript](https://github.com/chippers/serialize-to-javascript) | 0.1.2 | MIT OR Apache-2.0 |
| [serialize-to-javascript-impl](https://github.com/chippers/serialize-to-javascript) | 0.1.2 | MIT OR Apache-2.0 |
| [servo_arc](https://github.com/servo/stylo) | 0.4.3 | MIT OR Apache-2.0 |
| [sha2](https://github.com/RustCrypto/hashes) | 0.10.9 | MIT OR Apache-2.0 |
| [sha2](https://github.com/RustCrypto/hashes) | 0.11.0 | MIT OR Apache-2.0 |
| [shared_child](https://github.com/oconnor663/shared_child.rs) | 1.1.1 | MIT |
| [shlex](https://github.com/comex/rust-shlex) | 1.3.0 | MIT OR Apache-2.0 |
| [shlex](https://github.com/comex/rust-shlex) | 2.0.1 | MIT OR Apache-2.0 |
| [sigchld](https://github.com/oconnor663/sigchld.rs) | 0.2.4 | MIT |
| [signal-hook](https://github.com/vorner/signal-hook) | 0.3.18 | Apache-2.0/MIT |
| [signal-hook-registry](https://github.com/vorner/signal-hook) | 1.4.8 | MIT OR Apache-2.0 |
| [signature](https://github.com/RustCrypto/traits/tree/master/signature) | 2.2.0 | Apache-2.0 OR MIT |
| [simd-adler32](https://github.com/mcountryman/simd-adler32) | 0.3.10 | MIT |
| [simd-adler32](https://github.com/mcountryman/simd-adler32) | 0.3.9 | MIT |
| [simd_cesu8](https://github.com/seancroach/simd_cesu8) | 1.1.1 | Apache-2.0 OR MIT |
| [simdutf8](https://github.com/rusticstuff/simdutf8) | 0.1.5 | MIT OR Apache-2.0 |
| [siphasher](https://github.com/jedisct1/rust-siphash) | 1.0.3 | MIT/Apache-2.0 |
| [slab](https://github.com/tokio-rs/slab) | 0.4.12 | MIT |
| [small_btree](https://github.com/boa-dev/boa) | 0.1.0 | Unlicense OR MIT |
| [smallvec](https://github.com/servo/rust-smallvec) | 1.15.1 | MIT OR Apache-2.0 |
| [smallvec](https://github.com/servo/rust-smallvec) | 1.15.2 | MIT OR Apache-2.0 |
| [socket2](https://github.com/rust-lang/socket2) | 0.6.3 | MIT OR Apache-2.0 |
| [softbuffer](https://github.com/rust-windowing/softbuffer) | 0.4.8 | MIT OR Apache-2.0 |
| [soup3](https://gitlab.gnome.org/World/Rust/soup3-rs) | 0.5.0 | MIT |
| [soup3-sys](https://gitlab.gnome.org/World/Rust/soup3-rs) | 0.5.0 | MIT |
| [spade](https://github.com/Stoeoef/spade) | 2.15.1 | MIT OR Apache-2.0 |
| [spki](https://github.com/RustCrypto/formats/tree/master/spki) | 0.7.3 | Apache-2.0 OR MIT |
| [stable_deref_trait](https://github.com/storyyeller/stable_deref_trait) | 1.2.1 | MIT OR Apache-2.0 |
| [static_assertions](https://github.com/nvzqz/static-assertions-rs) | 1.1.0 | MIT OR Apache-2.0 |
| [strict-num](https://github.com/RazrFalcon/strict-num) | 0.1.1 | MIT |
| [string_cache](https://github.com/servo/string-cache) | 0.9.0 | MIT OR Apache-2.0 |
| [string_cache_codegen](https://github.com/servo/string-cache) | 0.6.1 | MIT OR Apache-2.0 |
| [stringprep](https://github.com/sfackler/rust-stringprep) | 0.1.5 | MIT/Apache-2.0 |
| [strsim](https://github.com/rapidfuzz/strsim-rs) | 0.11.1 | MIT |
| [subtle](https://github.com/dalek-cryptography/subtle) | 2.6.1 | BSD-3-Clause |
| [swift-rs](https://github.com/Brendonovich/swift-rs) | 1.0.7 | MIT OR Apache-2.0 |
| [syn](https://github.com/dtolnay/syn) | 1.0.109 | MIT OR Apache-2.0 |
| [syn](https://github.com/dtolnay/syn) | 2.0.117 | MIT OR Apache-2.0 |
| [syn](https://github.com/dtolnay/syn) | 2.0.119 | MIT OR Apache-2.0 |
| [syn](https://github.com/dtolnay/syn) | 3.0.3 | MIT OR Apache-2.0 |
| [sync_wrapper](https://github.com/Actyx/sync_wrapper) | 1.0.2 | Apache-2.0 |
| [synstructure](https://github.com/mystor/synstructure) | 0.13.2 | MIT |
| [system-deps](https://github.com/gdesmott/system-deps) | 6.2.2 | MIT OR Apache-2.0 |
| [tag_ptr](https://github.com/boa-dev/boa) | 0.1.0 | Unlicense OR MIT |
| [tao](https://github.com/tauri-apps/tao) | 0.35.3 | Apache-2.0 |
| [tao-macros](https://github.com/tauri-apps/tao) | 0.1.3 | MIT OR Apache-2.0 |
| [tap](https://github.com/myrrlyn/tap) | 1.0.1 | MIT |
| [tar](https://github.com/composefs/tar-rs) | 0.4.46 | MIT OR Apache-2.0 |
| [target-lexicon](https://github.com/bytecodealliance/target-lexicon) | 0.12.16 | Apache-2.0 WITH LLVM-exception |
| [target-lexicon](https://github.com/bytecodealliance/target-lexicon) | 0.13.5 | Apache-2.0 WITH LLVM-exception |
| [tauri](https://github.com/tauri-apps/tauri) | 2.11.2 | Apache-2.0 OR MIT |
| [tauri-build](https://github.com/tauri-apps/tauri) | 2.6.2 | Apache-2.0 OR MIT |
| [tauri-codegen](https://github.com/tauri-apps/tauri) | 2.6.2 | Apache-2.0 OR MIT |
| [tauri-macros](https://github.com/tauri-apps/tauri) | 2.6.2 | Apache-2.0 OR MIT |
| [tauri-plugin](https://github.com/tauri-apps/tauri) | 2.6.2 | Apache-2.0 OR MIT |
| [tauri-plugin-deep-link](https://github.com/tauri-apps/plugins-workspace) | 2.4.9 | Apache-2.0 OR MIT |
| [tauri-plugin-dialog](https://github.com/tauri-apps/plugins-workspace) | 2.7.1 | Apache-2.0 OR MIT |
| [tauri-plugin-fs](https://github.com/tauri-apps/plugins-workspace) | 2.5.1 | Apache-2.0 OR MIT |
| [tauri-plugin-log](https://github.com/tauri-apps/plugins-workspace) | 2.8.0 | Apache-2.0 OR MIT |
| [tauri-plugin-process](https://github.com/tauri-apps/plugins-workspace) | 2.3.1 | Apache-2.0 OR MIT |
| [tauri-plugin-shell](https://github.com/tauri-apps/plugins-workspace) | 2.3.5 | Apache-2.0 OR MIT |
| [tauri-plugin-single-instance](https://github.com/tauri-apps/plugins-workspace) | 2.4.2 | Apache-2.0 OR MIT |
| [tauri-plugin-updater](https://github.com/tauri-apps/plugins-workspace) | 2.10.1 | Apache-2.0 OR MIT |
| [tauri-runtime](https://github.com/tauri-apps/tauri) | 2.11.2 | Apache-2.0 OR MIT |
| [tauri-runtime-wry](https://github.com/tauri-apps/tauri) | 2.11.2 | Apache-2.0 OR MIT |
| [tauri-utils](https://github.com/tauri-apps/tauri) | 2.9.2 | Apache-2.0 OR MIT |
| [tauri-winres](https://github.com/tauri-apps/winres) | 0.3.6 | MIT |
| [tempfile](https://github.com/Stebalien/tempfile) | 3.27.0 | MIT OR Apache-2.0 |
| [tendril](https://github.com/servo/html5ever) | 0.5.0 | MIT OR Apache-2.0 |
| [thin-vec](https://github.com/mozilla/thin-vec) | 0.2.18 | MIT OR Apache-2.0 |
| [thiserror](https://github.com/dtolnay/thiserror) | 1.0.69 | MIT OR Apache-2.0 |
| [thiserror](https://github.com/dtolnay/thiserror) | 2.0.18 | MIT OR Apache-2.0 |
| [thiserror](https://github.com/dtolnay/thiserror) | 2.0.19 | MIT OR Apache-2.0 |
| [thiserror-impl](https://github.com/dtolnay/thiserror) | 1.0.69 | MIT OR Apache-2.0 |
| [thiserror-impl](https://github.com/dtolnay/thiserror) | 2.0.18 | MIT OR Apache-2.0 |
| [thiserror-impl](https://github.com/dtolnay/thiserror) | 2.0.19 | MIT OR Apache-2.0 |
| [tiff](https://github.com/image-rs/image-tiff) | 0.11.3 | MIT |
| [time](https://github.com/time-rs/time) | 0.3.47 | MIT OR Apache-2.0 |
| [time](https://github.com/time-rs/time) | 0.3.54 | MIT OR Apache-2.0 |
| [time-core](https://github.com/time-rs/time) | 0.1.8 | MIT OR Apache-2.0 |
| [time-core](https://github.com/time-rs/time) | 0.1.9 | MIT OR Apache-2.0 |
| [time-macros](https://github.com/time-rs/time) | 0.2.27 | MIT OR Apache-2.0 |
| [time-macros](https://github.com/time-rs/time) | 0.2.32 | MIT OR Apache-2.0 |
| [tiny-keccak](https://github.com/debris/tiny-keccak) | 2.0.2 | CC0-1.0 |
| [tiny-skia](https://github.com/RazrFalcon/tiny-skia) | 0.11.4 | BSD-3-Clause |
| [tiny-skia-path](https://github.com/RazrFalcon/tiny-skia/tree/master/path) | 0.11.4 | BSD-3-Clause |
| [tinystr](https://github.com/unicode-org/icu4x) | 0.8.3 | Unicode-3.0 |
| [tinyvec](https://github.com/Lokathor/tinyvec) | 1.11.0 | Zlib OR Apache-2.0 OR MIT |
| [tinyvec](https://github.com/Lokathor/tinyvec) | 1.12.0 | Zlib OR Apache-2.0 OR MIT |
| [tinyvec_macros](https://github.com/Soveu/tinyvec_macros) | 0.1.1 | MIT OR Apache-2.0 OR Zlib |
| [tokio](https://github.com/tokio-rs/tokio) | 1.52.3 | MIT |
| [tokio-rustls](https://github.com/rustls/tokio-rustls) | 0.26.4 | MIT OR Apache-2.0 |
| [tokio-util](https://github.com/tokio-rs/tokio) | 0.7.18 | MIT |
| [toml](https://github.com/toml-rs/toml) | 0.8.2 | MIT OR Apache-2.0 |
| [toml](https://github.com/toml-rs/toml) | 0.9.12+spec-1.1.0 | MIT OR Apache-2.0 |
| [toml](https://github.com/toml-rs/toml) | 1.1.2+spec-1.1.0 | MIT OR Apache-2.0 |
| [toml_datetime](https://github.com/toml-rs/toml) | 0.6.3 | MIT OR Apache-2.0 |
| [toml_datetime](https://github.com/toml-rs/toml) | 0.7.5+spec-1.1.0 | MIT OR Apache-2.0 |
| [toml_datetime](https://github.com/toml-rs/toml) | 1.1.1+spec-1.1.0 | MIT OR Apache-2.0 |
| [toml_edit](https://github.com/toml-rs/toml) | 0.19.15 | MIT OR Apache-2.0 |
| [toml_edit](https://github.com/toml-rs/toml) | 0.20.2 | MIT OR Apache-2.0 |
| [toml_edit](https://github.com/toml-rs/toml) | 0.25.12+spec-1.1.0 | MIT OR Apache-2.0 |
| [toml_edit](https://github.com/toml-rs/toml) | 0.25.13+spec-1.1.0 | MIT OR Apache-2.0 |
| [toml_parser](https://github.com/toml-rs/toml) | 1.1.2+spec-1.1.0 | MIT OR Apache-2.0 |
| [toml_writer](https://github.com/toml-rs/toml) | 1.1.1+spec-1.1.0 | MIT OR Apache-2.0 |
| [tower](https://github.com/tower-rs/tower) | 0.5.3 | MIT |
| [tower-http](https://github.com/tower-rs/tower-http) | 0.6.11 | MIT |
| [tower-layer](https://github.com/tower-rs/tower) | 0.3.3 | MIT |
| [tower-service](https://github.com/tower-rs/tower) | 0.3.3 | MIT |
| [tracing](https://github.com/tokio-rs/tracing) | 0.1.44 | MIT |
| [tracing-attributes](https://github.com/tokio-rs/tracing) | 0.1.31 | MIT |
| [tracing-core](https://github.com/tokio-rs/tracing) | 0.1.36 | MIT |
| [tray-icon](https://github.com/tauri-apps/tray-icon) | 0.23.1 | MIT OR Apache-2.0 |
| [try-lock](https://github.com/seanmonstar/try-lock) | 0.2.5 | MIT |
| [ttf-parser](https://github.com/harfbuzz/ttf-parser) | 0.25.1 | MIT OR Apache-2.0 |
| [typeid](https://github.com/dtolnay/typeid) | 1.0.3 | MIT OR Apache-2.0 |
| [typenum](https://github.com/paholg/typenum) | 1.20.0 | MIT OR Apache-2.0 |
| [typenum](https://github.com/paholg/typenum) | 1.20.1 | MIT OR Apache-2.0 |
| [uds_windows](https://github.com/haraldh/rust_uds_windows) | 1.2.1 | MIT |
| [unic-char-property](https://github.com/open-i18n/rust-unic/) | 0.9.0 | MIT/Apache-2.0 |
| [unic-char-range](https://github.com/open-i18n/rust-unic/) | 0.9.0 | MIT/Apache-2.0 |
| [unic-common](https://github.com/open-i18n/rust-unic/) | 0.9.0 | MIT/Apache-2.0 |
| [unic-ucd-ident](https://github.com/open-i18n/rust-unic/) | 0.9.0 | MIT/Apache-2.0 |
| [unic-ucd-version](https://github.com/open-i18n/rust-unic/) | 0.9.0 | MIT/Apache-2.0 |
| [unicode-bidi](https://github.com/servo/unicode-bidi) | 0.3.18 | MIT OR Apache-2.0 |
| [unicode-ident](https://github.com/dtolnay/unicode-ident) | 1.0.24 | (MIT OR Apache-2.0) AND Unicode-3.0 |
| [unicode-normalization](https://github.com/unicode-rs/unicode-normalization) | 0.1.25 | MIT OR Apache-2.0 |
| [unicode-properties](https://github.com/unicode-rs/unicode-properties) | 0.1.4 | MIT/Apache-2.0 |
| [unicode-segmentation](https://github.com/unicode-rs/unicode-segmentation) | 1.13.2 | MIT OR Apache-2.0 |
| [unicode-xid](https://github.com/unicode-rs/unicode-xid) | 0.2.6 | MIT OR Apache-2.0 |
| [universal-hash](https://github.com/RustCrypto/traits) | 0.5.1 | MIT OR Apache-2.0 |
| [untrusted](https://github.com/briansmith/untrusted) | 0.9.0 | ISC |
| [url](https://github.com/servo/rust-url) | 2.5.8 | MIT OR Apache-2.0 |
| [urlencoding](https://github.com/kornelski/rust_urlencoding) | 2.1.3 | MIT |
| [urlpattern](https://github.com/denoland/rust-urlpattern) | 0.3.0 | MIT |
| [utf-8](https://github.com/SimonSapin/rust-utf8) | 0.7.6 | MIT OR Apache-2.0 |
| [utf16_iter](https://github.com/hsivonen/utf16_iter) | 1.0.5 | Apache-2.0 OR MIT |
| [utf16string](https://github.com/getsentry/utf16string) | 0.2.0 | MIT OR Apache-2.0 |
| [utf8-width](https://github.com/magiclen/utf8-width) | 0.1.8 | MIT |
| [utf8_iter](https://github.com/hsivonen/utf8_iter) | 1.0.4 | Apache-2.0 OR MIT |
| [uuid](https://github.com/uuid-rs/uuid) | 1.23.1 | Apache-2.0 OR MIT |
| [value-bag](https://github.com/sval-rs/value-bag) | 1.12.0 | Apache-2.0 OR MIT |
| [vecmath](https://github.com/pistondevelopers/vecmath) | 1.0.0 | MIT |
| [version-compare](https://gitlab.com/timvisee/version-compare) | 0.2.1 | MIT |
| [version_check](https://github.com/SergioBenitez/version_check) | 0.9.5 | MIT/Apache-2.0 |
| [visioncortex](https://github.com/visioncortex/visioncortex/) | 0.9.1 | MIT OR Apache-2.0 |
| [vswhom](https://github.com/nabijaczleweli/vswhom.rs) | 0.1.0 | MIT |
| [vswhom-sys](https://github.com/nabijaczleweli/vswhom-sys.rs) | 0.1.3 | MIT |
| [vtracer](https://github.com/visioncortex/vtracer/) | 1.0.0-alpha.2 | MIT OR Apache-2.0 |
| [walkdir](https://github.com/BurntSushi/walkdir) | 2.5.0 | Unlicense/MIT |
| [want](https://github.com/seanmonstar/want) | 0.3.1 | MIT |
| [wasi](https://github.com/bytecodealliance/wasi) | 0.11.1+wasi-snapshot-preview1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [wasip2](https://github.com/bytecodealliance/wasi-rs) | 1.0.3+wasi-0.2.9 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [wasip2](https://github.com/bytecodealliance/wasi-rs) | 1.0.4+wasi-0.2.12 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [wasip3](https://github.com/bytecodealliance/wasi-rs) | 0.4.0+wasi-0.3.0-rc-2026-01-06 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [wasm-bindgen](https://github.com/wasm-bindgen/wasm-bindgen) | 0.2.122 | MIT OR Apache-2.0 |
| [wasm-bindgen](https://github.com/wasm-bindgen/wasm-bindgen) | 0.2.126 | MIT OR Apache-2.0 |
| [wasm-bindgen-futures](https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/futures) | 0.4.72 | MIT OR Apache-2.0 |
| [wasm-bindgen-futures](https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/futures) | 0.4.76 | MIT OR Apache-2.0 |
| [wasm-bindgen-macro](https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/macro) | 0.2.122 | MIT OR Apache-2.0 |
| [wasm-bindgen-macro](https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/macro) | 0.2.126 | MIT OR Apache-2.0 |
| [wasm-bindgen-macro-support](https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/macro-support) | 0.2.122 | MIT OR Apache-2.0 |
| [wasm-bindgen-macro-support](https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/macro-support) | 0.2.126 | MIT OR Apache-2.0 |
| [wasm-bindgen-shared](https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/shared) | 0.2.122 | MIT OR Apache-2.0 |
| [wasm-bindgen-shared](https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/shared) | 0.2.126 | MIT OR Apache-2.0 |
| [wasm-encoder](https://github.com/bytecodealliance/wasm-tools/tree/main/crates/wasm-encoder) | 0.244.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [wasm-metadata](https://github.com/bytecodealliance/wasm-tools/tree/main/crates/wasm-metadata) | 0.244.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [wasm-streams](https://github.com/MattiasBuelens/wasm-streams/) | 0.5.0 | MIT OR Apache-2.0 |
| [wasmparser](https://github.com/bytecodealliance/wasm-tools/tree/main/crates/wasmparser) | 0.244.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [web-sys](https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/web-sys) | 0.3.103 | MIT OR Apache-2.0 |
| [web-sys](https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/web-sys) | 0.3.99 | MIT OR Apache-2.0 |
| [web_atoms](https://github.com/servo/html5ever) | 0.2.4 | MIT OR Apache-2.0 |
| [webkit2gtk](https://github.com/tauri-apps/webkit2gtk-rs) | 2.0.2 | MIT |
| [webkit2gtk-sys](https://github.com/tauri-apps/webkit2gtk-rs) | 2.0.2 | MIT |
| [webpki-root-certs](https://github.com/rustls/webpki-roots) | 1.0.7 | CDLA-Permissive-2.0 |
| [webview2-com](https://github.com/wravery/webview2-rs) | 0.38.2 | MIT |
| [webview2-com-macros](https://github.com/wravery/webview2-rs) | 0.8.1 | MIT |
| [webview2-com-sys](https://github.com/wravery/webview2-rs) | 0.38.2 | MIT |
| [weezl](https://github.com/image-rs/weezl) | 0.1.12 | MIT OR Apache-2.0 |
| [weezl](https://github.com/image-rs/weezl) | 0.2.1 | MIT OR Apache-2.0 |
| [winapi](https://github.com/retep998/winapi-rs) | 0.3.9 | MIT/Apache-2.0 |
| [winapi-i686-pc-windows-gnu](https://github.com/retep998/winapi-rs) | 0.4.0 | MIT/Apache-2.0 |
| [winapi-util](https://github.com/BurntSushi/winapi-util) | 0.1.11 | Unlicense OR MIT |
| [winapi-x86_64-pc-windows-gnu](https://github.com/retep998/winapi-rs) | 0.4.0 | MIT/Apache-2.0 |
| [window-vibrancy](https://github.com/tauri-apps/tauri-plugin-vibrancy) | 0.6.0 | Apache-2.0 OR MIT |
| [windows](https://github.com/microsoft/windows-rs) | 0.61.3 | MIT OR Apache-2.0 |
| [windows-collections](https://github.com/microsoft/windows-rs) | 0.2.0 | MIT OR Apache-2.0 |
| [windows-core](https://github.com/microsoft/windows-rs) | 0.61.2 | MIT OR Apache-2.0 |
| [windows-core](https://github.com/microsoft/windows-rs) | 0.62.2 | MIT OR Apache-2.0 |
| [windows-future](https://github.com/microsoft/windows-rs) | 0.2.1 | MIT OR Apache-2.0 |
| [windows-implement](https://github.com/microsoft/windows-rs) | 0.60.2 | MIT OR Apache-2.0 |
| [windows-interface](https://github.com/microsoft/windows-rs) | 0.59.3 | MIT OR Apache-2.0 |
| [windows-link](https://github.com/microsoft/windows-rs) | 0.1.3 | MIT OR Apache-2.0 |
| [windows-link](https://github.com/microsoft/windows-rs) | 0.2.1 | MIT OR Apache-2.0 |
| [windows-numerics](https://github.com/microsoft/windows-rs) | 0.2.0 | MIT OR Apache-2.0 |
| [windows-registry](https://github.com/microsoft/windows-rs) | 0.5.3 | MIT OR Apache-2.0 |
| [windows-result](https://github.com/microsoft/windows-rs) | 0.3.4 | MIT OR Apache-2.0 |
| [windows-result](https://github.com/microsoft/windows-rs) | 0.4.1 | MIT OR Apache-2.0 |
| [windows-strings](https://github.com/microsoft/windows-rs) | 0.4.2 | MIT OR Apache-2.0 |
| [windows-strings](https://github.com/microsoft/windows-rs) | 0.5.1 | MIT OR Apache-2.0 |
| [windows-sys](https://github.com/microsoft/windows-rs) | 0.45.0 | MIT OR Apache-2.0 |
| [windows-sys](https://github.com/microsoft/windows-rs) | 0.52.0 | MIT OR Apache-2.0 |
| [windows-sys](https://github.com/microsoft/windows-rs) | 0.59.0 | MIT OR Apache-2.0 |
| [windows-sys](https://github.com/microsoft/windows-rs) | 0.60.2 | MIT OR Apache-2.0 |
| [windows-sys](https://github.com/microsoft/windows-rs) | 0.61.2 | MIT OR Apache-2.0 |
| [windows-targets](https://github.com/microsoft/windows-rs) | 0.42.2 | MIT OR Apache-2.0 |
| [windows-targets](https://github.com/microsoft/windows-rs) | 0.52.6 | MIT OR Apache-2.0 |
| [windows-targets](https://github.com/microsoft/windows-rs) | 0.53.5 | MIT OR Apache-2.0 |
| [windows-threading](https://github.com/microsoft/windows-rs) | 0.1.0 | MIT OR Apache-2.0 |
| [windows-version](https://github.com/microsoft/windows-rs) | 0.1.7 | MIT OR Apache-2.0 |
| [windows_aarch64_gnullvm](https://github.com/microsoft/windows-rs) | 0.42.2 | MIT OR Apache-2.0 |
| [windows_aarch64_gnullvm](https://github.com/microsoft/windows-rs) | 0.52.6 | MIT OR Apache-2.0 |
| [windows_aarch64_gnullvm](https://github.com/microsoft/windows-rs) | 0.53.1 | MIT OR Apache-2.0 |
| [windows_aarch64_msvc](https://github.com/microsoft/windows-rs) | 0.42.2 | MIT OR Apache-2.0 |
| [windows_aarch64_msvc](https://github.com/microsoft/windows-rs) | 0.52.6 | MIT OR Apache-2.0 |
| [windows_aarch64_msvc](https://github.com/microsoft/windows-rs) | 0.53.1 | MIT OR Apache-2.0 |
| [windows_i686_gnu](https://github.com/microsoft/windows-rs) | 0.42.2 | MIT OR Apache-2.0 |
| [windows_i686_gnu](https://github.com/microsoft/windows-rs) | 0.52.6 | MIT OR Apache-2.0 |
| [windows_i686_gnu](https://github.com/microsoft/windows-rs) | 0.53.1 | MIT OR Apache-2.0 |
| [windows_i686_gnullvm](https://github.com/microsoft/windows-rs) | 0.52.6 | MIT OR Apache-2.0 |
| [windows_i686_gnullvm](https://github.com/microsoft/windows-rs) | 0.53.1 | MIT OR Apache-2.0 |
| [windows_i686_msvc](https://github.com/microsoft/windows-rs) | 0.42.2 | MIT OR Apache-2.0 |
| [windows_i686_msvc](https://github.com/microsoft/windows-rs) | 0.52.6 | MIT OR Apache-2.0 |
| [windows_i686_msvc](https://github.com/microsoft/windows-rs) | 0.53.1 | MIT OR Apache-2.0 |
| [windows_x86_64_gnu](https://github.com/microsoft/windows-rs) | 0.42.2 | MIT OR Apache-2.0 |
| [windows_x86_64_gnu](https://github.com/microsoft/windows-rs) | 0.52.6 | MIT OR Apache-2.0 |
| [windows_x86_64_gnu](https://github.com/microsoft/windows-rs) | 0.53.1 | MIT OR Apache-2.0 |
| [windows_x86_64_gnullvm](https://github.com/microsoft/windows-rs) | 0.42.2 | MIT OR Apache-2.0 |
| [windows_x86_64_gnullvm](https://github.com/microsoft/windows-rs) | 0.52.6 | MIT OR Apache-2.0 |
| [windows_x86_64_gnullvm](https://github.com/microsoft/windows-rs) | 0.53.1 | MIT OR Apache-2.0 |
| [windows_x86_64_msvc](https://github.com/microsoft/windows-rs) | 0.42.2 | MIT OR Apache-2.0 |
| [windows_x86_64_msvc](https://github.com/microsoft/windows-rs) | 0.52.6 | MIT OR Apache-2.0 |
| [windows_x86_64_msvc](https://github.com/microsoft/windows-rs) | 0.53.1 | MIT OR Apache-2.0 |
| [winnow](https://github.com/winnow-rs/winnow) | 0.5.40 | MIT |
| [winnow](https://github.com/winnow-rs/winnow) | 0.7.15 | MIT |
| [winnow](https://github.com/winnow-rs/winnow) | 1.0.3 | MIT |
| [winnow](https://github.com/winnow-rs/winnow) | 1.0.4 | MIT |
| [winreg](https://github.com/gentoo90/winreg-rs) | 0.55.0 | MIT |
| [wit-bindgen](https://github.com/bytecodealliance/wit-bindgen) | 0.51.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [wit-bindgen](https://github.com/bytecodealliance/wit-bindgen) | 0.57.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [wit-bindgen-core](https://github.com/bytecodealliance/wit-bindgen) | 0.51.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [wit-bindgen-rust](https://github.com/bytecodealliance/wit-bindgen) | 0.51.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [wit-bindgen-rust-macro](https://github.com/bytecodealliance/wit-bindgen) | 0.51.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [wit-component](https://github.com/bytecodealliance/wasm-tools/tree/main/crates/wit-component) | 0.244.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [wit-parser](https://github.com/bytecodealliance/wasm-tools/tree/main/crates/wit-parser) | 0.244.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [write16](https://github.com/hsivonen/write16) | 1.0.0 | Apache-2.0 OR MIT |
| [writeable](https://github.com/unicode-org/icu4x) | 0.6.3 | Unicode-3.0 |
| [wry](https://github.com/tauri-apps/wry) | 0.55.1 | Apache-2.0 OR MIT |
| [wyz](https://github.com/myrrlyn/wyz) | 0.5.1 | MIT |
| [x11](https://github.com/AltF02/x11-rs) | 2.21.0 | MIT |
| [x11-dl](https://github.com/AltF02/x11-rs) | 2.21.0 | MIT |
| [xattr](https://github.com/Stebalien/xattr) | 1.6.1 | MIT OR Apache-2.0 |
| [yoke](https://github.com/unicode-org/icu4x) | 0.8.2 | Unicode-3.0 |
| [yoke](https://github.com/unicode-org/icu4x) | 0.8.3 | Unicode-3.0 |
| [yoke-derive](https://github.com/unicode-org/icu4x) | 0.8.2 | Unicode-3.0 |
| [zbus](https://github.com/z-galaxy/zbus/) | 5.15.0 | MIT |
| [zbus_macros](https://github.com/z-galaxy/zbus/) | 5.15.0 | MIT |
| [zbus_names](https://github.com/z-galaxy/zbus/) | 4.3.2 | MIT |
| [zerocopy](https://github.com/google/zerocopy) | 0.8.49 | BSD-2-Clause OR Apache-2.0 OR MIT |
| [zerocopy](https://github.com/google/zerocopy) | 0.8.55 | BSD-2-Clause OR Apache-2.0 OR MIT |
| [zerocopy-derive](https://github.com/google/zerocopy) | 0.8.49 | BSD-2-Clause OR Apache-2.0 OR MIT |
| [zerocopy-derive](https://github.com/google/zerocopy) | 0.8.55 | BSD-2-Clause OR Apache-2.0 OR MIT |
| [zerofrom](https://github.com/unicode-org/icu4x) | 0.1.8 | Unicode-3.0 |
| [zerofrom-derive](https://github.com/unicode-org/icu4x) | 0.1.7 | Unicode-3.0 |
| [zeroize](https://github.com/RustCrypto/utils) | 1.8.2 | Apache-2.0 OR MIT |
| [zeroize](https://github.com/RustCrypto/utils) | 1.9.0 | Apache-2.0 OR MIT |
| [zerotrie](https://github.com/unicode-org/icu4x) | 0.2.4 | Unicode-3.0 |
| [zerovec](https://github.com/unicode-org/icu4x) | 0.11.6 | Unicode-3.0 |
| [zerovec-derive](https://github.com/unicode-org/icu4x) | 0.11.3 | Unicode-3.0 |
| [zip](https://github.com/zip-rs/zip2) | 4.6.1 | MIT |
| [zmij](https://github.com/dtolnay/zmij) | 1.0.21 | MIT |
| [zmij](https://github.com/dtolnay/zmij) | 1.0.23 | MIT |
| [zune-core](https://github.com/etemesi254/zune-image) | 0.5.1 | MIT OR Apache-2.0 OR Zlib |
| [zune-jpeg](https://github.com/etemesi254/zune-image/tree/dev/crates/zune-jpeg) | 0.5.15 | MIT OR Apache-2.0 OR Zlib |
| [zvariant](https://github.com/z-galaxy/zbus/) | 5.11.0 | MIT |
| [zvariant_derive](https://github.com/z-galaxy/zbus/) | 5.11.0 | MIT |
| [zvariant_utils](https://github.com/z-galaxy/zbus/) | 3.3.1 | MIT |

## 5. Gói npm (giao diện)

Danh sách gồm **toàn bộ** đồ thị phụ thuộc. Liệt kê thừa là an toàn; thiếu
thì không. Cột *Phạm vi* lấy từ cờ `dev` trong `package-lock.json`.

| Tên | Phiên bản | Giấy phép | Phạm vi |
|---|---|---|---|
| @asamuzakjp/css-color | 3.2.0 | MIT | build/test |
| @babel/code-frame | 7.29.7 | MIT | build/test |
| @babel/compat-data | 7.29.7 | MIT | build/test |
| @babel/core | 7.29.7 | MIT | build/test |
| @babel/generator | 7.29.7 | MIT | build/test |
| @babel/helper-compilation-targets | 7.29.7 | MIT | build/test |
| @babel/helper-globals | 7.29.7 | MIT | build/test |
| @babel/helper-module-imports | 7.29.7 | MIT | build/test |
| @babel/helper-module-transforms | 7.29.7 | MIT | build/test |
| @babel/helper-string-parser | 7.29.7 | MIT | build/test |
| @babel/helper-validator-identifier | 7.29.7 | MIT | build/test |
| @babel/helper-validator-option | 7.29.7 | MIT | build/test |
| @babel/helpers | 7.29.7 | MIT | build/test |
| @babel/parser | 7.29.7 | MIT | build/test |
| @babel/runtime | 7.29.7 | MIT | phát hành |
| @babel/template | 7.29.7 | MIT | build/test |
| @babel/traverse | 7.29.7 | MIT | build/test |
| @babel/types | 7.29.7 | MIT | build/test |
| @csstools/color-helpers | 5.1.0 | MIT-0 | build/test |
| @csstools/css-calc | 2.1.4 | MIT | build/test |
| @csstools/css-color-parser | 3.1.0 | MIT | build/test |
| @csstools/css-parser-algorithms | 3.0.5 | MIT | build/test |
| @csstools/css-tokenizer | 3.0.4 | MIT | build/test |
| @derhuerst/http-basic | 8.2.4 | MIT | build/test |
| @dimforge/rapier3d-compat | 0.12.0 | Apache-2.0 | phát hành |
| @emnapi/core | 1.10.0 | MIT | phát hành |
| @emnapi/core | 1.8.1 | MIT | phát hành |
| @emnapi/runtime | 1.10.0 | MIT | phát hành |
| @emnapi/runtime | 1.8.1 | MIT | phát hành |
| @emnapi/wasi-threads | 1.1.0 | MIT | phát hành |
| @emnapi/wasi-threads | 1.2.1 | MIT | phát hành |
| @emnapi/wasi-threads | 1.2.3 | MIT | phát hành |
| @eslint-community/eslint-utils | 4.9.1 | MIT | build/test |
| @eslint-community/regexpp | 4.12.2 | MIT | build/test |
| @eslint/config-array | 0.21.2 | Apache-2.0 | build/test |
| @eslint/config-helpers | 0.4.2 | Apache-2.0 | build/test |
| @eslint/core | 0.17.0 | Apache-2.0 | build/test |
| @eslint/eslintrc | 3.3.5 | MIT | build/test |
| @eslint/js | 9.39.4 | MIT | build/test |
| @eslint/object-schema | 2.1.7 | Apache-2.0 | build/test |
| @eslint/plugin-kit | 0.4.1 | Apache-2.0 | build/test |
| @formkit/auto-animate | 0.9.0 | MIT | phát hành |
| @humanfs/core | 0.19.1 | Apache-2.0 | build/test |
| @humanfs/node | 0.16.7 | Apache-2.0 | build/test |
| @humanwhocodes/module-importer | 1.0.1 | Apache-2.0 | build/test |
| @humanwhocodes/retry | 0.4.3 | Apache-2.0 | build/test |
| @jridgewell/gen-mapping | 0.3.13 | MIT | phát hành |
| @jridgewell/remapping | 2.3.5 | MIT | phát hành |
| @jridgewell/resolve-uri | 3.1.2 | MIT | phát hành |
| @jridgewell/sourcemap-codec | 1.5.5 | MIT | phát hành |
| @jridgewell/trace-mapping | 0.3.31 | MIT | phát hành |
| @mediapipe/tasks-vision | 0.10.17 | Apache-2.0 | phát hành |
| @monogrid/gainmap-js | 3.4.0 | MIT | phát hành |
| @napi-rs/wasm-runtime | 1.1.1 | MIT | phát hành |
| @napi-rs/wasm-runtime | 1.1.5 | MIT | phát hành |
| @oxc-project/types | 0.133.0 | MIT | phát hành |
| @pdf-lib/fontkit | 1.1.1 | MIT | phát hành |
| @pdf-lib/standard-fonts | 1.0.0 | MIT | phát hành |
| @pdf-lib/upng | 1.0.1 | MIT | phát hành |
| @react-three/drei | 10.7.7 | MIT | phát hành |
| @react-three/fiber | 9.6.1 | MIT | phát hành |
| @rolldown/binding-android-arm64 | 1.0.3 | MIT | phát hành |
| @rolldown/binding-darwin-arm64 | 1.0.3 | MIT | phát hành |
| @rolldown/binding-darwin-x64 | 1.0.3 | MIT | phát hành |
| @rolldown/binding-freebsd-x64 | 1.0.3 | MIT | phát hành |
| @rolldown/binding-linux-arm-gnueabihf | 1.0.3 | MIT | phát hành |
| @rolldown/binding-linux-arm64-gnu | 1.0.3 | MIT | phát hành |
| @rolldown/binding-linux-arm64-musl | 1.0.3 | MIT | phát hành |
| @rolldown/binding-linux-ppc64-gnu | 1.0.3 | MIT | phát hành |
| @rolldown/binding-linux-s390x-gnu | 1.0.3 | MIT | phát hành |
| @rolldown/binding-linux-x64-gnu | 1.0.3 | MIT | phát hành |
| @rolldown/binding-linux-x64-musl | 1.0.3 | MIT | phát hành |
| @rolldown/binding-openharmony-arm64 | 1.0.3 | MIT | phát hành |
| @rolldown/binding-wasm32-wasi | 1.0.3 | MIT | phát hành |
| @rolldown/binding-win32-arm64-msvc | 1.0.3 | MIT | phát hành |
| @rolldown/binding-win32-x64-msvc | 1.0.3 | MIT | phát hành |
| @rolldown/pluginutils | 1.0.0-rc.7 | MIT | build/test |
| @rolldown/pluginutils | 1.0.1 | MIT | phát hành |
| @sentry-internal/browser-utils | 10.54.0 | MIT | phát hành |
| @sentry-internal/feedback | 10.54.0 | MIT | phát hành |
| @sentry-internal/replay | 10.54.0 | MIT | phát hành |
| @sentry-internal/replay-canvas | 10.54.0 | MIT | phát hành |
| @sentry/browser | 10.54.0 | MIT | phát hành |
| @sentry/core | 10.54.0 | MIT | phát hành |
| @sentry/react | 10.54.0 | MIT | phát hành |
| @standard-schema/spec | 1.1.0 | MIT | build/test |
| @supabase/auth-js | 2.106.2 | MIT | phát hành |
| @supabase/functions-js | 2.106.2 | MIT | phát hành |
| @supabase/phoenix | 0.4.2 | MIT | phát hành |
| @supabase/postgrest-js | 2.106.2 | MIT | phát hành |
| @supabase/realtime-js | 2.106.2 | MIT | phát hành |
| @supabase/storage-js | 2.106.2 | MIT | phát hành |
| @supabase/supabase-js | 2.106.2 | MIT | phát hành |
| @tailwindcss/node | 4.2.2 | MIT | phát hành |
| @tailwindcss/oxide | 4.2.2 | MIT | phát hành |
| @tailwindcss/oxide-android-arm64 | 4.2.2 | MIT | phát hành |
| @tailwindcss/oxide-darwin-arm64 | 4.2.2 | MIT | phát hành |
| @tailwindcss/oxide-darwin-x64 | 4.2.2 | MIT | phát hành |
| @tailwindcss/oxide-freebsd-x64 | 4.2.2 | MIT | phát hành |
| @tailwindcss/oxide-linux-arm-gnueabihf | 4.2.2 | MIT | phát hành |
| @tailwindcss/oxide-linux-arm64-gnu | 4.2.2 | MIT | phát hành |
| @tailwindcss/oxide-linux-arm64-musl | 4.2.2 | MIT | phát hành |
| @tailwindcss/oxide-linux-x64-gnu | 4.2.2 | MIT | phát hành |
| @tailwindcss/oxide-linux-x64-musl | 4.2.2 | MIT | phát hành |
| @tailwindcss/oxide-wasm32-wasi | 4.2.2 | MIT | phát hành |
| @tailwindcss/oxide-win32-arm64-msvc | 4.2.2 | MIT | phát hành |
| @tailwindcss/oxide-win32-x64-msvc | 4.2.2 | MIT | phát hành |
| @tailwindcss/vite | 4.2.2 | MIT | phát hành |
| @tauri-apps/api | 2.11.0 | Apache-2.0 OR MIT | phát hành |
| @tauri-apps/cli | 2.10.1 | Apache-2.0 OR MIT | build/test |
| @tauri-apps/cli-darwin-arm64 | 2.10.1 | Apache-2.0 OR MIT | build/test |
| @tauri-apps/cli-darwin-x64 | 2.10.1 | Apache-2.0 OR MIT | build/test |
| @tauri-apps/cli-linux-arm-gnueabihf | 2.10.1 | Apache-2.0 OR MIT | build/test |
| @tauri-apps/cli-linux-arm64-gnu | 2.10.1 | Apache-2.0 OR MIT | build/test |
| @tauri-apps/cli-linux-arm64-musl | 2.10.1 | Apache-2.0 OR MIT | build/test |
| @tauri-apps/cli-linux-riscv64-gnu | 2.10.1 | Apache-2.0 OR MIT | build/test |
| @tauri-apps/cli-linux-x64-gnu | 2.10.1 | Apache-2.0 OR MIT | build/test |
| @tauri-apps/cli-linux-x64-musl | 2.10.1 | Apache-2.0 OR MIT | build/test |
| @tauri-apps/cli-win32-arm64-msvc | 2.10.1 | Apache-2.0 OR MIT | build/test |
| @tauri-apps/cli-win32-ia32-msvc | 2.10.1 | Apache-2.0 OR MIT | build/test |
| @tauri-apps/cli-win32-x64-msvc | 2.10.1 | Apache-2.0 OR MIT | build/test |
| @tauri-apps/plugin-deep-link | 2.4.9 | MIT OR Apache-2.0 | phát hành |
| @tauri-apps/plugin-dialog | 2.7.0 | MIT OR Apache-2.0 | phát hành |
| @tauri-apps/plugin-fs | 2.5.0 | MIT OR Apache-2.0 | phát hành |
| @tauri-apps/plugin-process | 2.3.1 | MIT OR Apache-2.0 | phát hành |
| @tauri-apps/plugin-shell | 2.3.5 | MIT OR Apache-2.0 | phát hành |
| @tauri-apps/plugin-updater | 2.10.1 | MIT OR Apache-2.0 | phát hành |
| @testing-library/dom | 10.4.1 | MIT | build/test |
| @testing-library/react | 16.3.2 | MIT | build/test |
| @turf/helpers | 7.3.5 | MIT | phát hành |
| @turf/meta | 7.3.5 | MIT | phát hành |
| @turf/union | 7.3.5 | MIT | phát hành |
| @tweenjs/tween.js | 23.1.3 | MIT | phát hành |
| @tybys/wasm-util | 0.10.1 | MIT | phát hành |
| @tybys/wasm-util | 0.10.2 | MIT | phát hành |
| @types/aria-query | 5.0.4 | MIT | build/test |
| @types/chai | 5.2.3 | MIT | build/test |
| @types/deep-eql | 4.0.2 | MIT | build/test |
| @types/diff | 7.0.2 | MIT | build/test |
| @types/draco3d | 1.4.10 | MIT | phát hành |
| @types/estree | 1.0.8 | MIT | build/test |
| @types/geojson | 7946.0.16 | MIT | phát hành |
| @types/json-schema | 7.0.15 | MIT | build/test |
| @types/node | 10.17.60 | MIT | build/test |
| @types/node | 24.12.0 | MIT | build/test |
| @types/offscreencanvas | 2019.7.3 | MIT | phát hành |
| @types/pako | 2.0.4 | MIT | phát hành |
| @types/papaparse | 5.5.2 | MIT | build/test |
| @types/raf | 3.4.3 | MIT | phát hành |
| @types/react | 19.2.14 | MIT | phát hành |
| @types/react-dom | 19.2.3 | MIT | build/test |
| @types/react-reconciler | 0.28.9 | MIT | phát hành |
| @types/stats.js | 0.17.4 | MIT | phát hành |
| @types/three | 0.184.1 | MIT | phát hành |
| @types/trusted-types | 2.0.7 | MIT | phát hành |
| @types/webxr | 0.5.24 | MIT | phát hành |
| @typescript-eslint/eslint-plugin | 8.57.2 | MIT | build/test |
| @typescript-eslint/parser | 8.57.2 | MIT | build/test |
| @typescript-eslint/project-service | 8.57.2 | MIT | build/test |
| @typescript-eslint/scope-manager | 8.57.2 | MIT | build/test |
| @typescript-eslint/tsconfig-utils | 8.57.2 | MIT | build/test |
| @typescript-eslint/type-utils | 8.57.2 | MIT | build/test |
| @typescript-eslint/types | 8.57.2 | MIT | build/test |
| @typescript-eslint/typescript-estree | 8.57.2 | MIT | build/test |
| @typescript-eslint/utils | 8.57.2 | MIT | build/test |
| @typescript-eslint/visitor-keys | 8.57.2 | MIT | build/test |
| @use-gesture/core | 10.3.1 | MIT | phát hành |
| @use-gesture/react | 10.3.1 | MIT | phát hành |
| @vitejs/plugin-react | 6.0.1 | MIT | build/test |
| @vitest/expect | 4.1.6 | MIT | build/test |
| @vitest/mocker | 4.1.6 | MIT | build/test |
| @vitest/pretty-format | 4.1.6 | MIT | build/test |
| @vitest/runner | 4.1.6 | MIT | build/test |
| @vitest/snapshot | 4.1.6 | MIT | build/test |
| @vitest/spy | 4.1.6 | MIT | build/test |
| @vitest/utils | 4.1.6 | MIT | build/test |
| @webgpu/types | 0.1.70 | BSD-3-Clause | build/test |
| acorn | 8.16.0 | MIT | build/test |
| acorn-jsx | 5.3.2 | MIT | build/test |
| agent-base | 6.0.2 | MIT | build/test |
| agent-base | 7.1.4 | MIT | build/test |
| ajv | 6.14.0 | MIT | build/test |
| ansi-regex | 5.0.1 | MIT | build/test |
| ansi-styles | 4.3.0 | MIT | build/test |
| ansi-styles | 5.2.0 | MIT | build/test |
| argparse | 2.0.1 | Python-2.0 | build/test |
| aria-query | 5.3.0 | Apache-2.0 | build/test |
| assertion-error | 2.0.1 | MIT | build/test |
| asynckit | 0.4.0 | MIT | build/test |
| balanced-match | 4.0.4 | MIT | build/test |
| base64-arraybuffer | 1.0.2 | MIT | phát hành |
| base64-js | 1.5.1 | MIT | phát hành |
| baseline-browser-mapping | 2.10.38 | Apache-2.0 | build/test |
| bidi-js | 1.0.3 | MIT | phát hành |
| bignumber.js | 9.3.1 | MIT | phát hành |
| bl | 4.1.0 | MIT | phát hành |
| brace-expansion | 5.0.8 | MIT | build/test |
| browserslist | 4.28.2 | MIT | build/test |
| buffer | 5.7.1 | MIT | phát hành |
| buffer | 6.0.3 | MIT | phát hành |
| buffer-from | 1.1.2 | MIT | build/test |
| bwip-js | 4.10.1 | MIT | phát hành |
| call-bind-apply-helpers | 1.0.2 | MIT | build/test |
| callsites | 3.1.0 | MIT | build/test |
| camera-controls | 3.1.2 | MIT | phát hành |
| caniuse-lite | 1.0.30001799 | CC-BY-4.0 | build/test |
| canvas | 3.2.3 | MIT | phát hành |
| canvg | 3.0.11 | MIT | phát hành |
| caseless | 0.12.0 | Apache-2.0 | build/test |
| chai | 6.2.2 | MIT | build/test |
| chalk | 4.1.2 | MIT | build/test |
| chownr | 1.1.4 | ISC | phát hành |
| class-variance-authority | 0.7.1 | Apache-2.0 | phát hành |
| clipper-lib | 6.4.2 | BSL | phát hành |
| clsx | 2.1.1 | MIT | phát hành |
| color-convert | 2.0.1 | MIT | build/test |
| color-name | 1.1.4 | MIT | build/test |
| combined-stream | 1.0.8 | MIT | build/test |
| concat-stream | 2.0.0 | MIT | build/test |
| convert-source-map | 2.0.0 | MIT | build/test |
| core-js | 3.49.0 | MIT | phát hành |
| cross-env | 7.0.3 | MIT | phát hành |
| cross-spawn | 7.0.6 | MIT | phát hành |
| css-line-break | 2.1.0 | MIT | phát hành |
| cssesc | 3.0.0 | MIT | phát hành |
| cssstyle | 4.6.0 | MIT | build/test |
| csstype | 3.2.3 | MIT | phát hành |
| data-urls | 5.0.0 | MIT | build/test |
| debug | 4.4.3 | MIT | build/test |
| decimal.js | 10.6.0 | MIT | build/test |
| decompress-response | 6.0.0 | MIT | phát hành |
| deep-extend | 0.6.0 | MIT | phát hành |
| deep-is | 0.1.4 | MIT | build/test |
| delayed-stream | 1.0.0 | MIT | build/test |
| dequal | 2.0.3 | MIT | phát hành |
| detect-gpu | 5.0.70 | MIT | phát hành |
| detect-libc | 2.1.2 | Apache-2.0 | phát hành |
| diff | 8.0.4 | BSD-3-Clause | phát hành |
| dom-accessibility-api | 0.5.16 | MIT | build/test |
| dompurify | 3.4.12 | (MPL-2.0 OR Apache-2.0) | phát hành |
| draco3d | 1.5.7 | Apache-2.0 | phát hành |
| dunder-proto | 1.0.1 | MIT | build/test |
| electron-to-chromium | 1.5.376 | ISC | build/test |
| end-of-stream | 1.4.5 | MIT | phát hành |
| enhanced-resolve | 5.20.1 | MIT | phát hành |
| entities | 6.0.1 | BSD-2-Clause | build/test |
| env-paths | 2.2.1 | MIT | build/test |
| es-define-property | 1.0.1 | MIT | build/test |
| es-errors | 1.3.0 | MIT | build/test |
| es-module-lexer | 2.1.0 | MIT | build/test |
| es-object-atoms | 1.1.2 | MIT | build/test |
| es-set-tostringtag | 2.1.0 | MIT | build/test |
| escalade | 3.2.0 | MIT | build/test |
| escape-string-regexp | 4.0.0 | MIT | build/test |
| eslint | 9.39.4 | MIT | build/test |
| eslint-plugin-react-hooks | 7.0.1 | MIT | build/test |
| eslint-plugin-react-refresh | 0.5.2 | MIT | build/test |
| eslint-scope | 8.4.0 | BSD-2-Clause | build/test |
| eslint-visitor-keys | 3.4.3 | Apache-2.0 | build/test |
| eslint-visitor-keys | 4.2.1 | Apache-2.0 | build/test |
| eslint-visitor-keys | 5.0.1 | Apache-2.0 | build/test |
| espree | 10.4.0 | BSD-2-Clause | build/test |
| esquery | 1.7.0 | BSD-3-Clause | build/test |
| esrecurse | 4.3.0 | BSD-2-Clause | build/test |
| estraverse | 5.3.0 | BSD-2-Clause | build/test |
| estree-walker | 3.0.3 | MIT | build/test |
| esutils | 2.0.3 | BSD-2-Clause | build/test |
| expand-template | 2.0.3 | (MIT OR WTFPL) | phát hành |
| expect-type | 1.3.0 | Apache-2.0 | build/test |
| fast-check | 4.8.0 | MIT | build/test |
| fast-deep-equal | 3.1.3 | MIT | build/test |
| fast-json-stable-stringify | 2.1.0 | MIT | build/test |
| fast-levenshtein | 2.0.6 | MIT | build/test |
| fast-png | 6.4.0 | MIT | phát hành |
| fdir | 6.5.0 | MIT | phát hành |
| fflate | 0.6.10 | MIT | phát hành |
| fflate | 0.8.3 | MIT | phát hành |
| ffmpeg-static | 5.3.0 | GPL-3.0-or-later | build/test |
| file-entry-cache | 8.0.0 | MIT | build/test |
| find-up | 5.0.0 | MIT | build/test |
| flat-cache | 4.0.1 | MIT | build/test |
| flatted | 3.4.2 | ISC | build/test |
| font-family-papandreou | 0.2.0-patch2 | MIT | phát hành |
| form-data | 4.0.6 | MIT | build/test |
| fs-constants | 1.0.0 | MIT | phát hành |
| fsevents | 2.3.2 | MIT | build/test |
| fsevents | 2.3.3 | MIT | phát hành |
| function-bind | 1.1.2 | MIT | build/test |
| gensync | 1.0.0-beta.2 | MIT | build/test |
| get-intrinsic | 1.3.0 | MIT | build/test |
| get-proto | 1.0.1 | MIT | build/test |
| github-from-package | 0.0.0 | MIT | phát hành |
| glob-parent | 6.0.2 | ISC | build/test |
| globals | 14.0.0 | MIT | build/test |
| globals | 17.4.0 | MIT | build/test |
| glsl-noise | 0.0.0 | MIT | phát hành |
| gopd | 1.2.0 | MIT | build/test |
| graceful-fs | 4.2.11 | ISC | phát hành |
| gsap | 3.15.0 | Standard 'no charge' license: https://gsap.com/standard-license. | phát hành |
| has-flag | 4.0.0 | MIT | build/test |
| has-symbols | 1.1.0 | MIT | build/test |
| has-tostringtag | 1.0.2 | MIT | build/test |
| hasown | 2.0.4 | MIT | build/test |
| hermes-estree | 0.25.1 | MIT | build/test |
| hermes-parser | 0.25.1 | MIT | build/test |
| hls.js | 1.6.16 | Apache-2.0 | phát hành |
| html-encoding-sniffer | 4.0.0 | MIT | build/test |
| html-parse-stringify | 3.0.1 | MIT | phát hành |
| html2canvas | 1.4.1 | MIT | phát hành |
| http-proxy-agent | 7.0.2 | MIT | build/test |
| http-response-object | 3.0.2 | MIT | build/test |
| https-proxy-agent | 5.0.1 | MIT | build/test |
| https-proxy-agent | 7.0.6 | MIT | build/test |
| i18next | 26.3.6 | MIT | phát hành |
| iceberg-js | 0.8.1 | MIT | phát hành |
| iconv-lite | 0.6.3 | MIT | build/test |
| ieee754 | 1.2.1 | BSD-3-Clause | phát hành |
| ignore | 5.3.2 | MIT | build/test |
| ignore | 7.0.5 | MIT | build/test |
| immediate | 3.0.6 | MIT | phát hành |
| import-fresh | 3.3.1 | MIT | build/test |
| imurmurhash | 0.1.4 | MIT | build/test |
| inherits | 2.0.4 | ISC | build/test |
| ini | 1.3.8 | ISC | phát hành |
| iobuffer | 5.4.0 | MIT | phát hành |
| is-extglob | 2.1.1 | MIT | build/test |
| is-glob | 4.0.3 | MIT | build/test |
| is-potential-custom-element-name | 1.0.1 | MIT | build/test |
| is-promise | 2.2.2 | MIT | phát hành |
| isexe | 2.0.0 | ISC | phát hành |
| its-fine | 2.0.0 | MIT | phát hành |
| jiti | 2.6.1 | MIT | phát hành |
| js-tokens | 4.0.0 | MIT | phát hành |
| js-yaml | 4.3.0 | MIT | build/test |
| jsdom | 25.0.1 | MIT | build/test |
| jsesc | 3.1.0 | MIT | build/test |
| json-buffer | 3.0.1 | MIT | build/test |
| json-schema-traverse | 0.4.1 | MIT | build/test |
| json-stable-stringify-without-jsonify | 1.0.1 | MIT | build/test |
| json5 | 2.2.3 | MIT | build/test |
| jspdf | 4.2.1 | MIT | phát hành |
| keyv | 4.5.4 | MIT | build/test |
| levn | 0.4.1 | MIT | build/test |
| lie | 3.3.0 | MIT | phát hành |
| lightningcss | 1.32.0 | MPL-2.0 | phát hành |
| lightningcss-android-arm64 | 1.32.0 | MPL-2.0 | phát hành |
| lightningcss-darwin-arm64 | 1.32.0 | MPL-2.0 | phát hành |
| lightningcss-darwin-x64 | 1.32.0 | MPL-2.0 | phát hành |
| lightningcss-freebsd-x64 | 1.32.0 | MPL-2.0 | phát hành |
| lightningcss-linux-arm-gnueabihf | 1.32.0 | MPL-2.0 | phát hành |
| lightningcss-linux-arm64-gnu | 1.32.0 | MPL-2.0 | phát hành |
| lightningcss-linux-arm64-musl | 1.32.0 | MPL-2.0 | phát hành |
| lightningcss-linux-x64-gnu | 1.32.0 | MPL-2.0 | phát hành |
| lightningcss-linux-x64-musl | 1.32.0 | MPL-2.0 | phát hành |
| lightningcss-win32-arm64-msvc | 1.32.0 | MPL-2.0 | phát hành |
| lightningcss-win32-x64-msvc | 1.32.0 | MPL-2.0 | phát hành |
| locate-path | 6.0.0 | MIT | build/test |
| lodash.merge | 4.6.2 | MIT | build/test |
| loose-envify | 1.4.0 | MIT | phát hành |
| lru-cache | 10.4.3 | ISC | build/test |
| lru-cache | 5.1.1 | ISC | build/test |
| lucide-react | 1.14.0 | ISC | phát hành |
| lz-string | 1.5.0 | MIT | build/test |
| maath | 0.10.8 | MIT | phát hành |
| magic-string | 0.30.21 | MIT | phát hành |
| make-cancellable-promise | 1.3.2 | MIT | phát hành |
| make-event-props | 1.6.2 | MIT | phát hành |
| math-intrinsics | 1.1.0 | MIT | build/test |
| merge-refs | 1.3.0 | MIT | phát hành |
| meshline | 3.3.1 | MIT | phát hành |
| meshoptimizer | 1.1.1 | MIT | phát hành |
| mime-db | 1.52.0 | MIT | build/test |
| mime-types | 2.1.35 | MIT | build/test |
| mimic-response | 3.1.0 | MIT | phát hành |
| minimatch | 10.2.5 | BlueOak-1.0.0 | build/test |
| minimist | 1.2.8 | MIT | phát hành |
| mkdirp-classic | 0.5.3 | MIT | phát hành |
| ms | 2.1.3 | MIT | build/test |
| nanoid | 3.3.16 | MIT | phát hành |
| napi-build-utils | 2.0.0 | MIT | phát hành |
| natural-compare | 1.4.0 | MIT | build/test |
| node-abi | 3.92.0 | MIT | phát hành |
| node-addon-api | 7.1.1 | MIT | phát hành |
| node-releases | 2.0.48 | MIT | build/test |
| nwsapi | 2.2.24 | MIT | build/test |
| obug | 2.1.1 | MIT | build/test |
| once | 1.4.0 | ISC | phát hành |
| optionator | 0.9.4 | MIT | build/test |
| p-limit | 3.1.0 | MIT | build/test |
| p-locate | 5.0.0 | MIT | build/test |
| page-flip | 2.0.7 | MIT | phát hành |
| pako | 1.0.11 | (MIT AND Zlib) | phát hành |
| pako | 2.1.0 | (MIT AND Zlib) | phát hành |
| papaparse | 5.5.3 | MIT | phát hành |
| parent-module | 1.0.1 | MIT | build/test |
| parse-cache-control | 1.0.1 | CHƯA XÁC ĐỊNH | build/test |
| parse5 | 7.3.0 | MIT | build/test |
| path-exists | 4.0.0 | MIT | build/test |
| path-key | 3.1.1 | MIT | phát hành |
| path2d | 0.2.2 | MIT | phát hành |
| pathe | 2.0.3 | MIT | build/test |
| pdf-lib | 1.17.1 | MIT | phát hành |
| pdfjs-dist | 4.8.69 | Apache-2.0 | phát hành |
| performance-now | 2.1.0 | MIT | phát hành |
| picocolors | 1.1.1 | ISC | phát hành |
| picomatch | 4.0.4 | MIT | phát hành |
| playwright | 1.61.1 | Apache-2.0 | build/test |
| playwright-core | 1.61.1 | Apache-2.0 | build/test |
| polyclip-ts | 0.16.8 | MIT | phát hành |
| postcss | 8.5.23 | MIT | phát hành |
| potpack | 1.0.2 | ISC | phát hành |
| prebuild-install | 7.1.3 | MIT | phát hành |
| prelude-ls | 1.2.1 | MIT | build/test |
| pretty-format | 27.5.1 | MIT | build/test |
| progress | 2.0.3 | MIT | build/test |
| promise-worker-transferable | 1.0.4 | Apache-2.0 | phát hành |
| pump | 3.0.4 | MIT | phát hành |
| punycode | 2.3.1 | MIT | build/test |
| pure-rand | 8.4.0 | MIT | build/test |
| qr-code-styling | 1.9.2 | MIT | phát hành |
| qrcode-generator | 1.5.2 | MIT | phát hành |
| raf | 3.4.1 | MIT | phát hành |
| rc | 1.2.8 | (BSD-2-Clause OR MIT OR Apache-2.0) | phát hành |
| react | 19.2.4 | MIT | phát hành |
| react-dom | 19.2.4 | MIT | phát hành |
| react-i18next | 17.0.9 | MIT | phát hành |
| react-is | 17.0.2 | MIT | build/test |
| react-pageflip | 2.0.3 | MIT | phát hành |
| react-pdf | 9.2.1 | MIT | phát hành |
| react-use-measure | 2.1.7 | MIT | phát hành |
| react-virtuoso | 4.18.3 | MIT | phát hành |
| readable-stream | 3.6.2 | MIT | build/test |
| regenerator-runtime | 0.13.11 | MIT | phát hành |
| require-from-string | 2.0.2 | MIT | phát hành |
| resolve-from | 4.0.0 | MIT | build/test |
| rgbcolor | 1.0.1 | MIT OR SEE LICENSE IN FEEL-FREE.md | phát hành |
| rolldown | 1.0.3 | MIT | phát hành |
| rrweb-cssom | 0.7.1 | MIT | build/test |
| rrweb-cssom | 0.8.0 | MIT | build/test |
| safe-buffer | 5.2.1 | MIT | build/test |
| safer-buffer | 2.1.2 | MIT | build/test |
| saxes | 6.0.0 | ISC | build/test |
| scheduler | 0.27.0 | MIT | phát hành |
| semver | 6.3.1 | ISC | build/test |
| semver | 7.7.4 | ISC | build/test |
| semver | 7.8.4 | ISC | phát hành |
| shebang-command | 2.0.0 | MIT | phát hành |
| shebang-regex | 3.0.0 | MIT | phát hành |
| siginfo | 2.0.0 | ISC | build/test |
| simple-concat | 1.0.1 | MIT | phát hành |
| simple-get | 4.0.1 | MIT | phát hành |
| sonner | 2.0.7 | MIT | phát hành |
| source-map-js | 1.2.1 | BSD-3-Clause | phát hành |
| specificity | 0.4.1 | MIT | phát hành |
| splaytree-ts | 1.0.2 | BDS-3-Clause | phát hành |
| stackback | 0.0.2 | MIT | build/test |
| stackblur-canvas | 2.7.0 | MIT | phát hành |
| stats-gl | 2.4.2 | MIT | phát hành |
| stats.js | 0.17.0 | MIT | phát hành |
| std-env | 4.1.0 | MIT | build/test |
| string_decoder | 1.3.0 | MIT | build/test |
| strip-json-comments | 2.0.1 | MIT | phát hành |
| strip-json-comments | 3.1.1 | MIT | build/test |
| supports-color | 7.2.0 | MIT | build/test |
| suspend-react | 0.1.3 | MIT | phát hành |
| svg-pathdata | 6.0.3 | MIT | phát hành |
| svg2pdf.js | 2.7.0 | MIT | phát hành |
| svgpath | 2.6.0 | MIT | phát hành |
| symbol-tree | 3.2.4 | MIT | build/test |
| tailwind-merge | 3.5.0 | MIT | phát hành |
| tailwindcss | 4.2.2 | MIT | phát hành |
| tapable | 2.3.2 | MIT | phát hành |
| tar-fs | 2.1.4 | MIT | phát hành |
| tar-stream | 2.2.0 | MIT | phát hành |
| text-segmentation | 1.0.3 | MIT | phát hành |
| three | 0.170.0 | MIT | phát hành |
| three | 0.184.0 | MIT | phát hành |
| three-mesh-bvh | 0.8.3 | MIT | phát hành |
| three-stdlib | 2.36.1 | MIT | phát hành |
| tiny-invariant | 1.3.3 | MIT | phát hành |
| tinybench | 2.9.0 | MIT | build/test |
| tinyexec | 1.1.2 | MIT | build/test |
| tinyglobby | 0.2.17 | MIT | phát hành |
| tinyrainbow | 3.1.0 | MIT | build/test |
| tldts | 6.1.86 | MIT | build/test |
| tldts-core | 6.1.86 | MIT | build/test |
| tough-cookie | 5.1.2 | BSD-3-Clause | build/test |
| tr46 | 5.1.1 | MIT | build/test |
| troika-three-text | 0.52.4 | MIT | phát hành |
| troika-three-utils | 0.52.4 | MIT | phát hành |
| troika-worker-utils | 0.52.0 | MIT | phát hành |
| ts-api-utils | 2.5.0 | MIT | build/test |
| tslib | 1.14.1 | 0BSD | phát hành |
| tslib | 2.8.1 | 0BSD | phát hành |
| tunnel-agent | 0.6.0 | Apache-2.0 | phát hành |
| tunnel-rat | 0.1.2 | MIT | phát hành |
| type-check | 0.4.0 | MIT | build/test |
| typedarray | 0.0.6 | MIT | build/test |
| typescript | 5.9.3 | Apache-2.0 | build/test |
| typescript-eslint | 8.57.2 | MIT | build/test |
| undici-types | 7.16.0 | MIT | build/test |
| update-browserslist-db | 1.2.3 | MIT | build/test |
| uri-js | 4.4.1 | BSD-2-Clause | build/test |
| use-sync-external-store | 1.6.0 | MIT | phát hành |
| util-deprecate | 1.0.2 | MIT | build/test |
| utility-types | 3.11.0 | MIT | phát hành |
| utrie | 1.0.2 | MIT | phát hành |
| vite | 8.0.16 | MIT | phát hành |
| vitest | 4.1.6 | MIT | build/test |
| void-elements | 3.1.0 | MIT | phát hành |
| w3c-xmlserializer | 5.0.0 | MIT | build/test |
| warning | 4.0.3 | MIT | phát hành |
| webgl-constants | 1.1.1 | CHƯA XÁC ĐỊNH | phát hành |
| webgl-sdf-generator | 1.1.1 | MIT | phát hành |
| webidl-conversions | 7.0.0 | BSD-2-Clause | build/test |
| whatwg-encoding | 3.1.1 | MIT | build/test |
| whatwg-mimetype | 4.0.0 | MIT | build/test |
| whatwg-url | 14.2.0 | MIT | build/test |
| which | 2.0.2 | ISC | phát hành |
| why-is-node-running | 2.3.0 | MIT | build/test |
| word-wrap | 1.2.5 | MIT | build/test |
| wrappy | 1.0.2 | ISC | phát hành |
| ws | 8.21.0 | MIT | build/test |
| xml-name-validator | 5.0.0 | Apache-2.0 | build/test |
| xmlchars | 2.2.0 | MIT | build/test |
| yallist | 3.1.1 | ISC | build/test |
| yocto-queue | 0.1.0 | MIT | build/test |
| zod | 4.3.6 | MIT | build/test |
| zod-validation-error | 4.0.2 | MIT | build/test |
| zustand | 4.5.7 | MIT | phát hành |
| zustand | 5.0.12 | MIT | phát hành |

## 6. Thống kê

- Nhị phân đóng gói: 6
- Thư viện Python: 116
- Crate Rust: 799
- Gói npm: 531

| Giấy phép | Số thành phần |
|---|---|
| MIT | 624 |
| MIT OR Apache-2.0 | 383 |
| Apache-2.0 OR MIT | 90 |
| Apache-2.0 | 41 |
| MIT/Apache-2.0 | 34 |
| BSD-3-Clause | 33 |
| ISC | 28 |
| Unicode-3.0 | 24 |
| Zlib OR Apache-2.0 OR MIT | 21 |
| MPL-2.0 | 20 |
| Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | 16 |
| BSD-2-Clause | 16 |
| Unlicense OR MIT | 15 |
| BSD License | 8 |
| Apache-2.0/MIT | 6 |

3 thành phần không khai giấy phép trong metadata — cần tra thủ công trước khi phát hành.

