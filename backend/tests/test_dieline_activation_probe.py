"""[DIELINE-PROBE 2026-08-26 §F] Chốt cho probe kích hoạt ở cổng phát hành.

Hai property được khoá ở đây:

- **Property 4 — No-Secret-Leak.** Không giá trị token / license key / khoá `rk`
  nào rời khỏi vùng cho phép: không qua argv của process con (argv của process
  khác đọc được bằng WMI trên Windows — bài học §SEC.3 ngày 2026-07-30), không
  qua stdout, không qua file tạm còn sót, không qua env còn sót.
- **Property 2 — Preservation.** Khối `Step 1a-pre` giữ nguyên hành vi khoá bất
  biến theo bản: khoá đã có thì dùng lại (không rotate/ghi đè), nhiều hàng thì
  throw, và probe KHÔNG thêm đường ghi nào vào `release_resource_keys`.

Ngoài ra khoá **dung thứ phiên bản có chủ đích** của chặng 1: khẳng định
`rk_status = 'granted'` phải nằm SAU một điều kiện "trường có tồn tại". Hai chiều
đều là hồi quy: siết thành hard-fail trước khi lô 2 deploy sẽ chặn mọi bản build;
nới chặng 2 sẽ làm cổng mất tác dụng.

Vì sao là test tĩnh: probe đầy đủ cần kho DPAPI phát hành + license TEST + mạng +
một wheel đã khoá, nên chỉ chạy được trên máy phát hành. Từ máy dev mức bằng
chứng cao nhất là **Mức 2**.
"""

from __future__ import annotations

import base64
import importlib.util
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
BUILD_SCRIPT = ROOT / "build_production.ps1"
PROBE_SCRIPT = ROOT / "scripts" / "dieline_activation_probe.py"
STORE_SCRIPT = ROOT / "scripts" / "release_secret_store.ps1"
SETUP_PROBE_SCRIPT = ROOT / "scripts" / "setup_release_probe_license.ps1"
REQUEST_FIXTURE = ROOT / "native" / "tests" / "fixtures" / "dieline_default_request.json"

# Tên biến trong build script mang giá trị bí mật; không được xuất hiện trong bất
# kỳ lời in nào, cũng không được nằm trên dòng gọi process con.
SECRET_BEARING_PS_VARS = (
    "$probeToken",
    "$probeLicenseKey",
    "$probeClaimsJson",
    "$probeVerifyBody",
)


def _build_text() -> str:
    return BUILD_SCRIPT.read_text(encoding="utf-8")


def _probe_text() -> str:
    return PROBE_SCRIPT.read_text(encoding="utf-8")


def _probe_block(build_text: str) -> str:
    """Cắt đúng khối probe trong Step 1a để không khẳng định lan sang chỗ khác."""
    start = build_text.index("[DIELINE-PROBE 2026-08-26 §F] PROBE KICH HOAT THAT")
    end = build_text.index("$script:DIELINE_LOCKED =", start)
    return build_text[start:end]


def _load_probe_module():
    spec = importlib.util.spec_from_file_location("prynx_dieline_activation_probe", PROBE_SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _fake_token(claims: dict) -> str:
    payload = base64.urlsafe_b64encode(
        json.dumps(claims, separators=(",", ":")).encode("utf-8")
    ).decode("ascii").rstrip("=")
    return f"{payload}.{'A' * 86}"


# ─────────────────────────────────────────────────────────────────────────────
#  Property 4 — No-Secret-Leak
# ─────────────────────────────────────────────────────────────────────────────


def test_probe_nhan_bi_mat_qua_env_khong_qua_argv() -> None:
    probe = _probe_text()
    build = _build_text()
    block = _probe_block(build)

    # Probe chỉ đọc bí mật từ môi trường và từ chối mọi tham số dòng lệnh.
    assert 'os.environ.get(name)' in probe
    assert "if len(sys.argv) > 1:" in probe
    assert "argv-not-accepted" in probe
    assert "argparse" not in probe
    assert "sys.argv[1]" not in probe

    # Build truyền bí mật qua env, và dòng gọi process con không mang bí mật nào.
    assert "$env:PRYNX_PROBE_TOKEN = $probeToken" in block
    assert "$env:PRYNX_PROBE_LICENSE_KEY = $probeLicenseKey" in block
    invoke_line = next(
        line for line in block.splitlines() if "& $VENV_PYTHON $probeScriptTemp" in line
    )
    for secret_var in SECRET_BEARING_PS_VARS:
        assert secret_var not in invoke_line


def test_khong_loi_in_nao_mang_gia_tri_bi_mat() -> None:
    build = _build_text()
    block = _probe_block(build)
    probe = _probe_text()

    for line in block.splitlines():
        if "Write-Host" not in line and "Write-Output" not in line:
            continue
        for secret_var in SECRET_BEARING_PS_VARS:
            assert secret_var not in line, f"lời in mang bí mật: {line.strip()}"

    # Dòng trạng thái chỉ mang TÊN claim, số panel và độ dài khoá.
    assert 'prefix=OK_PREFIX' in probe
    assert 'claims=",".join(claim_names)' in probe
    assert "panels=len(panels)" in probe
    assert "rk_len=resource_key_length" in probe
    # Chốt runtime: dòng trạng thái được soi lại trước khi in.
    assert "assert_line_has_no_secret(line, (token, license_key))" in probe
    print_calls = [line.strip() for line in probe.splitlines() if line.strip().startswith("print(")]
    assert print_calls, "probe phải in dòng trạng thái"
    for call in print_calls:
        for forbidden in ("token", "license_key", "raw_resource_key", "claims["):
            assert forbidden not in call, f"print rò bí mật: {call}"


def test_probe_dung_anon_key_cong_khai_khong_nhan_secret_service_role() -> None:
    block = _probe_block(_build_text())

    assert "VITE_SUPABASE_ANON_KEY" in block
    assert "$probeAnonKey -like 'sb_secret_*'" in block
    # Probe không được chạm tới secret service-role của build.
    assert "$releaseSupabaseSecret" not in block
    assert "PRYNX_SUPABASE_SECRET_KEY" not in block
    assert "PRYNX_SUPABASE_SERVICE_KEY" not in block


def test_finally_don_file_tam_va_bien_moi_truong_probe() -> None:
    block = _probe_block(_build_text())

    finally_at = block.index("} finally {")
    tail = block[finally_at:]
    assert "Remove-Item Env:PRYNX_PROBE_*" in tail
    assert "Remove-Item -LiteralPath $probeScriptTemp -Force" in tail
    assert "$secureProbeLicense.Dispose()" in tail
    # Fail-closed: build chết ở probe không được để khoá dieline lại trong shell.
    catch_at = block.index("} catch {")
    assert "Remove-Item Env:PRYNX_DIELINE_KEY_B64" in block[catch_at:finally_at]


def test_build_van_xoa_khoa_dieline_truoc_nuitka_tauri_nsis() -> None:
    build = _build_text()

    dieline_locked_at = build.index("$script:DIELINE_LOCKED =")
    clear_key_at = build.index("Remove-Item Env:PRYNX_DIELINE_KEY_B64", dieline_locked_at)
    nuitka_at = build.index("& $VENV_PYTHON -m nuitka", clear_key_at)
    tauri_at = build.index(
        "& $script:PrynXNodePath $tauriCliPath build --config $tauriConfig",
        clear_key_at,
    )
    assert dieline_locked_at < clear_key_at < nuitka_at < tauri_at


def test_setup_probe_license_khong_echo_gia_tri() -> None:
    setup = SETUP_PROBE_SCRIPT.read_text(encoding="utf-8")
    store = STORE_SCRIPT.read_text(encoding="utf-8")

    assert 'Read-Host "License TEST cho probe" -AsSecureString' in setup
    for line in setup.splitlines():
        if "Write-Host" in line:
            assert "$probeLicense" not in line
    # Kho DPAPI: chỉ SecureString được ghi ra đĩa, không có ConvertFrom-SecureString thô.
    assert "Export-Clixml" in store
    assert "ProbeLicense  = $ProbeLicense" in store


# ─────────────────────────────────────────────────────────────────────────────
#  Dung thứ phiên bản của chặng 1 — không siết, không nới
# ─────────────────────────────────────────────────────────────────────────────


def test_chang_1_kiem_status_valid_va_ten_claim_rk() -> None:
    block = _probe_block(_build_text())

    assert "[string]$probeVerifyResponse.status -cne 'VALID'" in block
    assert "$probeClaimNames -notcontains 'rk'" in block
    # Chỉ đọc TÊN claim, không bao giờ giá trị.
    assert ".PSObject.Properties.Name |" in block


def test_khang_dinh_rk_status_nam_sau_dieu_kien_truong_ton_tai() -> None:
    """Bundle Edge chưa lên lô 2 thì `rk_status` chưa tồn tại — bỏ qua, không fail."""
    block = _probe_block(_build_text())

    guard = "if ($null -ne $probeRkStatus -and [string]$probeRkStatus.Value -cne 'granted')"
    assert guard in block
    # Không được tồn tại khẳng định rk_status vô điều kiện ở bất kỳ dạng nào.
    granted_lines = [line for line in block.splitlines() if "'granted'" in line]
    assert len(granted_lines) == 1
    assert "$null -ne $probeRkStatus" in granted_lines[0]


def test_chang_2_la_cong_that_va_chay_tren_wheel_da_staged() -> None:
    block = _probe_block(_build_text())
    probe = _probe_text()

    assert "$env:PRYNX_PROBE_NATIVE_SITE = $nativeSiteDir" in block
    assert "dieline_activation_probe=ok *" in block
    assert "generate_dieline_json" in probe
    assert "pdfcompare-native-not-from-staged-wheel" in probe
    assert "engine-returned-no-panels" in probe
    assert "token-missing-rk-claim" in probe


def test_probe_dat_sau_cong_capability_va_truoc_khoa_dieline() -> None:
    build = _build_text()

    capability_gate_at = build.index("$script:PpeNativeSha256 = (Get-FileHash")
    probe_at = build.index("[DIELINE-PROBE 2026-08-26 §F] PROBE KICH HOAT THAT")
    dieline_locked_at = build.index("$script:DIELINE_LOCKED =")
    assert capability_gate_at < probe_at < dieline_locked_at


def test_chinh_sach_fail_va_ghi_nhan_manifest() -> None:
    build = _build_text()

    assert (
        "Release build refuses -SkipDielineActivationProbe: the dieline activation probe is mandatory."
        in build
    )
    assert "[switch]$SkipDielineActivationProbe," in build
    assert '$script:DIELINE_ACTIVATION_PROBE = "skipped"' in build
    assert '$script:DIELINE_ACTIVATION_PROBE = "ok"' in build
    assert '{ "pending" } else { "plaintext" }' in build
    assert (
        'if ($Release -and $script:DIELINE_ACTIVATION_PROBE -ne "ok") {' in build
    )
    assert '"DIELINE_ACTIVATION_PROBE = $(if ($script:DIELINE_ACTIVATION_PROBE)' in build
    # Public release từ chối mọi giá trị khác "ok", theo đúng khuôn mẫu DIELINE_LOCKED.
    locked_gate_at = build.index('if ($Release -and $script:DIELINE_LOCKED -ne "yes") {')
    probe_gate_at = build.index('if ($Release -and $script:DIELINE_ACTIVATION_PROBE -ne "ok") {')
    manifest_at = build.index("$manifestLines = @(", probe_gate_at)
    assert locked_gate_at < probe_gate_at < manifest_at


# ─────────────────────────────────────────────────────────────────────────────
#  Property 2 — Preservation: Step 1a-pre không đổi hành vi
# ─────────────────────────────────────────────────────────────────────────────


def test_khoa_bat_bien_theo_ban_giu_nguyen_va_probe_khong_them_duong_ghi() -> None:
    build = _build_text()
    block = _probe_block(build)

    # Dùng lại khoá đã có, không rotate/ghi đè.
    assert "Reusing immutable dieline resource key for version $APP_VERSION." in build
    assert "Existing dieline resource key is malformed; refusing to rotate or overwrite it." in build
    # Nhiều hàng cho cùng bản thì từ chối build.
    assert "if ($existingRows.Count -gt 1) {" in build
    assert "Refusing an ambiguous build." in build
    # Probe không thêm bất kỳ đường đọc/ghi nào vào bảng khoá.
    assert build.count("release_resource_keys") == 2
    assert "release_resource_keys" not in block
    assert "-Method Post" in block  # chỉ một POST duy nhất: license-verify
    assert block.count("-Method Post") == 1
    assert "license-verify" in block


def test_probe_khong_can_khoa_dieline_de_chay() -> None:
    """Probe dùng khoá của SERVER; giải mã thành công tự chứng minh hai khoá bằng nhau."""
    block = _probe_block(_build_text())
    probe = _probe_text()

    assert "PRYNX_DIELINE_KEY_B64" not in probe
    # Trong khối probe, khoá build chỉ xuất hiện ở MỘT dòng lệnh: dọn dẹp fail-closed.
    # Dòng chú thích không tính — nó là chỗ giải thích chính bất biến này.
    key_statements = [
        line
        for line in block.splitlines()
        if "PRYNX_DIELINE_KEY_B64" in line and not line.strip().startswith("#")
    ]
    assert len(key_statements) == 1
    assert "Remove-Item" in key_statements[0]


# ─────────────────────────────────────────────────────────────────────────────
#  Kho license TEST tách riêng — không làm vô hiệu kho Supabase đã cấu hình
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.skipif(os.name != "nt", reason="DPAPI CurrentUser chi co tren Windows")
def test_kho_probe_roundtrip_khong_ghi_plaintext_va_tu_choi_secret(tmp_path: Path) -> None:
    """Kho license TEST round-trip đúng, không ghi plaintext, từ chối `sb_secret_`."""
    probe_license = "PRYNX-TEST-PROBE-0001-ABCD"
    store_path = tmp_path / "release-secrets" / "probe.clixml"
    env = os.environ.copy()
    # Runner có thể là pwsh 7; để Windows PowerShell 5.1 tự dựng module path
    # tương thích, không cho module Security bản Core che bản Desktop inbox.
    env.pop("PSMODULEPATH", None)
    env["PRYNX_TEST_PROBE_LICENSE"] = probe_license
    env["PRYNX_TEST_PROBE_STORE"] = str(store_path)
    env["PRYNX_TEST_SCRIPT"] = str(STORE_SCRIPT)
    command = (
        ". $env:PRYNX_TEST_SCRIPT; "
        "$secure = $null; "
        "try { "
        "$secure = ConvertTo-SecureString $env:PRYNX_TEST_PROBE_LICENSE -AsPlainText -Force; "
        "$saved = Save-PrynXReleaseProbeLicense -ProbeLicense $secure "
        "-StorePath $env:PRYNX_TEST_PROBE_STORE; "
        "$bytes = [System.IO.File]::ReadAllBytes($saved); "
        "foreach ($enc in @([Text.Encoding]::UTF8, [Text.Encoding]::Unicode)) { "
        "if ($enc.GetString($bytes).Contains($env:PRYNX_TEST_PROBE_LICENSE)) { "
        "throw 'Kho probe da ghi lo plaintext.' } }; "
        "$back = Get-PrynXReleaseProbeLicense -StorePath $env:PRYNX_TEST_PROBE_STORE; "
        "if ((ConvertFrom-PrynXSecureString -SecureValue $back) -ne "
        "$env:PRYNX_TEST_PROBE_LICENSE) { throw 'Kho probe khong round-trip dung.' }; "
        "$rejected = $false; "
        "try { $bad = ConvertTo-SecureString 'sb_secret_aaaaaaaaaaaaaaaaaaaaaaaa' "
        "-AsPlainText -Force; "
        "[void](Save-PrynXReleaseProbeLicense -ProbeLicense $bad "
        "-StorePath $env:PRYNX_TEST_PROBE_STORE) } catch { $rejected = $true }; "
        "if (-not $rejected) { throw 'Kho probe nhan sai secret sb_secret_.' } "
        "} finally { if ($secure) { $secure.Dispose() } }"
    )
    completed = subprocess.run(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
        cwd=ROOT, env=env, capture_output=True, text=True, timeout=60, check=False,
    )
    assert completed.returncode == 0, completed.stdout or completed.stderr
    # Kho Supabase hien co khong bi cham toi.
    assert not (store_path.parent / "secrets.clixml").exists()


def test_kho_probe_la_file_rieng_va_khong_doi_schema_kho_cu() -> None:
    store = STORE_SCRIPT.read_text(encoding="utf-8")

    assert 'Join-Path $env:LOCALAPPDATA "PrynX\\ReleaseSecrets\\probe.clixml"' in store
    assert "$script:PrynXReleaseProbeSecretSchema = 1" in store
    assert "$script:PrynXReleaseSecretSchema = 1" in store
    # Payload của kho Supabase cũ giữ nguyên 4 field: thêm field là làm vô hiệu kho
    # đã cấu hình trên máy phát hành (Get-PrynXReleaseSupabaseSecret từ chối nạp).
    legacy_payload_at = store.index("SchemaVersion  = $script:PrynXReleaseSecretSchema")
    legacy_payload_end = store.index("$tempPath = Join-Path", legacy_payload_at)
    legacy_payload = store[legacy_payload_at:legacy_payload_end]
    assert "ProbeLicense" not in legacy_payload
    assert legacy_payload.count("=") == 4
    assert "PRYNX-RELEASE-PROBE-01" in store


# ─────────────────────────────────────────────────────────────────────────────
#  Unit test cho logic thuần của probe (không cần native, không cần mạng)
# ─────────────────────────────────────────────────────────────────────────────


def test_read_token_claims_tra_ten_claim_da_sap_xep_va_do_dai_khoa() -> None:
    module = _load_probe_module()
    resource_key = base64.urlsafe_b64encode(bytes(range(32))).decode("ascii").rstrip("=")
    token = _fake_token({"p": "prynx", "exp": 1, "m": "MACHINE", "k": "abc", "rk": resource_key})

    claim_names, rk_len = module.read_token_claims(token)
    assert claim_names == ["exp", "k", "m", "p", "rk"]
    assert rk_len == 32


def test_read_token_claims_dung_thu_base64_chuan_nhu_rust() -> None:
    """Rust thử URL_SAFE_NO_PAD → URL_SAFE → STANDARD; probe phải dung thứ y hệt."""
    module = _load_probe_module()
    standard_key = base64.b64encode(b"\xfb\xff" + bytes(30)).decode("ascii")
    token = _fake_token({"exp": 1, "rk": standard_key})

    _, rk_len = module.read_token_claims(token)
    assert rk_len == 32


def test_read_token_claims_fail_khi_thieu_rk_hoac_sai_do_dai() -> None:
    module = _load_probe_module()

    with pytest.raises(module.ProbeFailure) as missing:
        module.read_token_claims(_fake_token({"exp": 1, "plan": "pro"}))
    assert "token-missing-rk-claim" in str(missing.value)

    short_key = base64.urlsafe_b64encode(bytes(16)).decode("ascii").rstrip("=")
    with pytest.raises(module.ProbeFailure) as wrong_length:
        module.read_token_claims(_fake_token({"exp": 1, "rk": short_key}))
    assert "rk-length-16-expected-32" in str(wrong_length.value)


def test_status_line_guard_bat_moi_truong_hop_ro_bi_mat() -> None:
    module = _load_probe_module()

    module.assert_line_has_no_secret("dieline_activation_probe=ok claims=exp,rk", ("SECRET-1",))
    with pytest.raises(module.ProbeFailure):
        module.assert_line_has_no_secret("... SECRET-1 ...", ("SECRET-1",))


def test_load_request_json_dung_fixture_cua_test_rust() -> None:
    module = _load_probe_module()

    request_json = module.load_request_json(str(REQUEST_FIXTURE))
    assert json.loads(request_json)["params"]["boxType"] == "rte"
    # Tuần tự hoá compact y như route backend làm.
    assert ", " not in request_json

    with pytest.raises(module.ProbeFailure) as missing:
        module.load_request_json(str(REQUEST_FIXTURE.parent / "khong-ton-tai.json"))
    assert "request-fixture-missing" in str(missing.value)


def test_probe_tu_choi_argv_va_bao_thieu_env_khong_in_gia_tri() -> None:
    """Chạy thật script probe: không argv, không env ⇒ fail sạch, không rò gì."""
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith("PRYNX_PROBE_")
    }

    with_argv = subprocess.run(
        [os.sys.executable, str(PROBE_SCRIPT), "TOKEN-KHONG-DUOC-QUA-ARGV"],
        capture_output=True, text=True, timeout=60, check=False, env=env,
    )
    assert with_argv.returncode != 0
    assert "argv-not-accepted" in with_argv.stdout
    assert "TOKEN-KHONG-DUOC-QUA-ARGV" not in with_argv.stdout

    without_env = subprocess.run(
        [os.sys.executable, str(PROBE_SCRIPT)],
        capture_output=True, text=True, timeout=60, check=False, env=env,
    )
    assert without_env.returncode != 0
    assert "missing-env:PRYNX_PROBE_TOKEN" in without_env.stdout
    # Chẩn đoán đi ra stdout, không stderr: PowerShell 5.1 + ErrorActionPreference
    # Stop biến stderr của native command thành NativeCommandError, che exit code.
    assert without_env.stderr.strip() == ""


# ─────────────────────────────────────────────────────────────────────────────
#  Cú pháp: ba script phải parse được bằng chính PowerShell của máy
# ─────────────────────────────────────────────────────────────────────────────


_PARSE_SNIPPET = (
    "$e=$null; "
    "[System.Management.Automation.Language.Parser]::ParseFile("
    "'@@PATH@@',[ref]$null,[ref]$e) | Out-Null; "
    "if ($e) { $e[0].Extent.StartLineNumber.ToString() + ': ' + $e[0].Message } "
    "else { 'OK' }"
)


@pytest.mark.parametrize(
    "script",
    [
        pytest.param(BUILD_SCRIPT, id="build_production"),
        pytest.param(STORE_SCRIPT, id="release_secret_store"),
        pytest.param(SETUP_PROBE_SCRIPT, id="setup_release_probe_license"),
    ],
)
def test_script_phat_hanh_parse_duoc(script: Path) -> None:
    """Ba script `.ps1` không có BOM ⇒ PowerShell 5.1 đọc theo ANSI.

    Ký tự ngoài ASCII có thể thành dấu nháy thông minh (cp1252 0x91-0x94) và làm
    lệch cú pháp ở một dòng ASCII phía sau. Chỉ chính bộ phân tích cú pháp trả lời
    đúng được — đây là lý do khối probe viết bằng tiếng Việt không dấu.
    """
    powershell = shutil.which("powershell") or shutil.which("pwsh")
    if not powershell:
        pytest.skip("khong co PowerShell tren may nay")

    completed = subprocess.run(
        [powershell, "-NoProfile", "-NonInteractive", "-Command",
         _PARSE_SNIPPET.replace("@@PATH@@", str(script).replace("'", "''"))],
        capture_output=True, text=True, timeout=120, check=False,
    )
    output = (completed.stdout or "").strip()
    assert output == "OK", f"{script.name} khong parse duoc -> {output or completed.stderr[:200]}"
