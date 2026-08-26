"""[DIELINE-PROBE 2026-08-26 §F] Probe kích hoạt engine khuôn bế — chặng 2.

Vì sao tồn tại: điều kiện ship của một bản phát hành trước đây chỉ là "engine đã
được mã hoá" (`DIELINE_LOCKED = yes`). Điều đó chứng minh binary đã khoá, KHÔNG
chứng minh có ai mở được nó. Bản `1.0.0-rc.9` ship đúng ở trạng thái đó: token
license hợp lệ nhưng thiếu claim `rk` ⇒ `engine_source()` ném
`Dieline engine is locked: a valid license token is required` ⇒ công cụ khuôn bế
chết hoàn toàn với mọi bộ thông số.

Script này là **chặng 2** của probe và là cổng thật. Nó chạy đúng đường đi thật
trên wheel native ĐÃ STAGED (không phải `.pyd` trong venv dev):

    license token thật  ->  pdfcompare_native.generate_dieline_json(...)
                        ->  authorize_dieline() -> resource_key
                        ->  engine_source() giải mã payload PRYNXENC1 (AAD = app version)
                        ->  Boa parse engine -> dieline.panels

Chuỗi này tự đủ: server không cấp `rk` thì `authorize_dieline` trả
`resource_key = None`, `engine_source()` ném, exit code khác 0 và build dừng.
Không có cách nào nó đạt mà `rk` sai hoặc thiếu, nên chặng 2 không dung thứ gì
(chặng 1 trong `build_production.ps1` mới là chỗ có dung thứ phiên bản).

Hợp đồng vào/ra — quan trọng cho bảo mật (yêu cầu 3.5, Property 4):

- Mọi bí mật vào qua **biến môi trường** `PRYNX_PROBE_*`, KHÔNG qua argv. Trên
  Windows, argv của process khác đọc được bằng WMI; biến môi trường của process
  con thì không. Đây là bài học đã trả giá ở §SEC.3 ngày 2026-07-30 (private key
  từng nằm trong argv). Script từ chối chạy nếu có bất kỳ tham số dòng lệnh nào.
- Thành công: in ĐÚNG MỘT dòng dạng
  `dieline_activation_probe=ok claims=<tên claim đã sắp xếp> panels=<số> rk_len=32`
  — chỉ TÊN claim, số panel, và độ dài khoá sau khi decode (32 là hằng số thiết
  kế công khai). Không token, không license key, không giá trị `rk`, không hash
  license.
- Thất bại: in một dòng `dieline_activation_probe=fail reason=<lý do ngắn>` rồi
  exit khác 0. Lý do chỉ là hằng số/thông điệp lỗi literal của Rust.
- Mọi chẩn đoán đi ra **stdout**, không dùng stderr: PowerShell 5.1 với
  `$ErrorActionPreference = "Stop"` biến stderr của native command thành
  `NativeCommandError`, làm mất exit code thật và che lý do fail.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import pathlib
import sys

OK_PREFIX = "dieline_activation_probe=ok"
FAIL_PREFIX = "dieline_activation_probe=fail"

# Khoá mở engine là AES-256 ⇒ luôn 32 byte sau khi decode (xem native/build.rs).
RESOURCE_KEY_BYTES = 32
# Giới hạn độ dài thông điệp lỗi in ra, tránh dán cả payload lạ vào log build.
MAX_REASON_CHARS = 200

ENV_TOKEN = "PRYNX_PROBE_TOKEN"
ENV_LICENSE_KEY = "PRYNX_PROBE_LICENSE_KEY"
ENV_MACHINE_ID = "PRYNX_PROBE_MACHINE_ID"
ENV_REQUEST_FILE = "PRYNX_PROBE_REQUEST_FILE"
ENV_NATIVE_SITE = "PRYNX_PROBE_NATIVE_SITE"


class ProbeFailure(RuntimeError):
    """Lỗi probe đã rút gọn thành lý do an toàn để in ra."""


def _fail(reason: str) -> ProbeFailure:
    """Chuẩn hoá lý do: một dòng, không quá dài, không ký tự điều khiển."""
    flattened = " ".join(str(reason).split())
    if len(flattened) > MAX_REASON_CHARS:
        flattened = flattened[:MAX_REASON_CHARS] + "..."
    return ProbeFailure(flattened or "unknown")


def _require_env(name: str) -> str:
    """Đọc biến môi trường bắt buộc; chỉ báo TÊN biến, không bao giờ giá trị."""
    value = os.environ.get(name) or ""
    if not value.strip():
        raise _fail(f"missing-env:{name}")
    return value


def decode_base64_tolerant(value: str) -> bytes:
    """Decode base64 theo đúng thứ tự `dieline_license.rs::decode_url` dung thứ.

    Rust thử URL_SAFE_NO_PAD, rồi URL_SAFE, rồi STANDARD cho claim `rk`. Probe
    phải dung thứ y hệt, nếu không sẽ báo fail oan cho một token server hợp lệ.
    """
    text = value.strip()
    if not text:
        raise _fail("empty-base64")
    padded = text + "=" * (-len(text) % 4)
    for decoder in (base64.urlsafe_b64decode, base64.b64decode):
        try:
            return decoder(padded)
        except (binascii.Error, ValueError):
            continue
    raise _fail("malformed-base64")


def read_token_claims(token: str) -> tuple[list[str], int]:
    """Trả về (tên claim đã sắp xếp, độ dài khoá `rk` sau decode).

    CHỈ đọc tên claim và độ dài. Giá trị claim không rời khỏi hàm này.
    Token có dạng `<payload_b64url>.<signature_b64url>` (xem
    `native/src/dieline_license.rs`); probe không verify chữ ký ở đây vì chính
    `authorize_dieline` trong chặng dưới mới là bên có quyền phán quyết.
    """
    payload_segment = token.split(".", 1)[0]
    if not payload_segment:
        raise _fail("malformed-token")
    try:
        claims = json.loads(decode_base64_tolerant(payload_segment).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _fail("malformed-token-payload") from exc
    if not isinstance(claims, dict):
        raise _fail("malformed-token-payload")

    claim_names = sorted(str(name) for name in claims)
    raw_resource_key = claims.get("rk")
    if not isinstance(raw_resource_key, str) or not raw_resource_key:
        # Đây chính là trạng thái của rc.9: token hợp lệ, đủ quyền, nhưng server
        # giữ lại khoá engine. Fail ở đây thay vì để người dùng phát hiện.
        raise _fail("token-missing-rk-claim")
    resource_key_length = len(decode_base64_tolerant(raw_resource_key))
    if resource_key_length != RESOURCE_KEY_BYTES:
        raise _fail(f"rk-length-{resource_key_length}-expected-{RESOURCE_KEY_BYTES}")
    return claim_names, resource_key_length


def load_request_json(path_text: str) -> str:
    """Nạp fixture request và tuần tự hoá y như route backend làm.

    Dùng đúng `native/tests/fixtures/dieline_default_request.json` mà các test
    Rust dùng, nên probe không sinh ra một miền input riêng cần bảo trì.
    """
    path = pathlib.Path(path_text)
    if not path.is_file():
        raise _fail("request-fixture-missing")
    try:
        body = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _fail("request-fixture-unreadable") from exc
    return json.dumps(body, ensure_ascii=False, separators=(",", ":"))


def import_staged_native(site_text: str):
    """Import `pdfcompare_native` và CHỨNG MINH nó là wheel đã staged.

    Không có bước này, probe có thể chạy trên `.pyd` của venv dev (payload
    plaintext `PRYNXRAW1`) và luôn xanh — tức là không kiểm gì cả. Cách so sánh
    theo `resolve()` + `is_relative_to` lấy từ `scripts/run_release_qa.ps1`:
    nó chuẩn hoá cả alias 8.3 của Windows (KHANHP~1).
    """
    site = pathlib.Path(site_text)
    if not site.is_dir():
        raise _fail("staged-native-site-missing")
    try:
        import pdfcompare_native  # type: ignore[import-not-found]
    except ImportError as exc:
        raise _fail("pdfcompare-native-not-importable") from exc
    module_file = getattr(pdfcompare_native, "__file__", None)
    if not module_file:
        raise _fail("pdfcompare-native-has-no-file")
    package_dir = pathlib.Path(module_file).resolve().parent
    if not package_dir.is_relative_to(site.resolve()):
        raise _fail("pdfcompare-native-not-from-staged-wheel")
    return pdfcompare_native


def generate_panels(native, request_json: str, token: str, machine_id: str, license_key: str) -> list:
    """Chạy đúng lời gọi mà route `/api/dieline/generate` chạy."""
    try:
        raw_result = native.generate_dieline_json(request_json, token, machine_id, license_key)
    except RuntimeError as exc:
        # Thông điệp từ Rust là chuỗi literal (vd "Dieline engine is locked: ...")
        # nên in ra an toàn và là thứ ops cần để biết fail ở mắt nào.
        raise _fail(f"native-error:{exc}") from exc
    try:
        result = json.loads(raw_result)
    except (TypeError, ValueError) as exc:
        raise _fail("native-returned-invalid-json") from exc
    dieline = result.get("dieline") if isinstance(result, dict) else None
    panels = dieline.get("panels") if isinstance(dieline, dict) else None
    if not isinstance(panels, list) or not panels:
        raise _fail("engine-returned-no-panels")
    return panels


def assert_line_has_no_secret(line: str, secrets: tuple[str, ...]) -> None:
    """Chốt cuối cho Property 4: dòng trạng thái không được chứa bí mật nào."""
    for secret in secrets:
        if secret and secret in line:
            raise _fail("status-line-would-leak-secret")


def main() -> int:
    if len(sys.argv) > 1:
        # Bí mật KHÔNG bao giờ đi qua argv; từ chối tường minh để không ai lặng
        # lẽ đổi hợp đồng gọi thành `probe.py <token>` trong một lần sửa sau.
        print(f"{FAIL_PREFIX} reason=argv-not-accepted")
        return 2

    token = _require_env(ENV_TOKEN)
    license_key = _require_env(ENV_LICENSE_KEY)
    machine_id = _require_env(ENV_MACHINE_ID)
    request_json = load_request_json(_require_env(ENV_REQUEST_FILE))
    native = import_staged_native(_require_env(ENV_NATIVE_SITE))

    claim_names, resource_key_length = read_token_claims(token)
    panels = generate_panels(native, request_json, token, machine_id, license_key)

    line = "{prefix} claims={claims} panels={panels} rk_len={rk_len}".format(
        prefix=OK_PREFIX,
        claims=",".join(claim_names),
        panels=len(panels),
        rk_len=resource_key_length,
    )
    assert_line_has_no_secret(line, (token, license_key))
    print(line)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ProbeFailure as failure:
        print(f"{FAIL_PREFIX} reason={failure}")
        sys.exit(1)
