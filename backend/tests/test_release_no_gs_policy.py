"""Chính sách phát hành no-GS phải nằm trong test, không nằm trong trí nhớ.

Audit lần 3 (§3.1, §3.3) tìm ra ba thứ mà không test nào bắt được:

1. `build_production.ps1` mặc định **bundle** Ghostscript, và cả bốn entry phát hành
   (`release_update.ps1`, `PHAT_HANH.bat`, `quanly_phathanh.ps1`, GUI) đều không
   truyền cờ no-GS ⇒ thao tác phát hành chuẩn vẫn sinh installer chứa AGPL.
2. Script xác minh artifact hardcode `PrynX.exe`, trong khi binary thật mang tên
   crate (`pdf-inspector.exe`) ⇒ gate hậu kiểm cài xong rồi ném lỗi.
3. Chốt NOTICE dùng `-SimpleMatch` với pattern `A|B|C` ⇒ dấu `|` thành ký tự thường
   và pattern không bao giờ khớp ⇒ NOTICE còn AGPL vẫn được báo "sạch".

Đây đều là lỗi **script phát hành**, loại mà pytest thường không chạm tới — nên
chúng sống sót qua mọi lần Release QA xanh. Test ở đây đọc chính nội dung script và
khoá các bất biến đó lại.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
BUILD = REPO / "build_production.ps1"
VERIFIER = REPO / "scripts" / "verify_installed_artifact.ps1"
AUDIT = REPO / "scripts" / "gs_dependency_audit.py"
RELEASE_QA = REPO / "scripts" / "run_release_qa.ps1"
RELEASE_UPDATE = REPO / "release_update.ps1"
# Mọi entry mà người phát hành thực sự bấm/chạy.
RELEASE_ENTRIES = [
    REPO / "release_update.ps1",
    REPO / "PHAT_HANH.bat",
    REPO / "quanly_phathanh.ps1",
]


def _read(path: Path) -> str:
    if not path.is_file():
        pytest.skip(f"thiếu {path.name}")
    return path.read_text(encoding="utf-8", errors="replace")


# ─────────────────────────────────────────────────────────────────────────────
#  §3.1 — no-GS là BẤT BIẾN, không có opt-in bật lại
# ─────────────────────────────────────────────────────────────────────────────

def test_build_script_defaults_to_no_ghostscript():
    """`$BUNDLE_GS` khởi tạo `$false`.

    Đảo mặc định là cách đóng §3.1 ở MỘT chỗ: mọi wrapper không truyền gì sẽ tự
    hưởng no-GS. Vá từng wrapper thì wrapper thêm sau này lại hở.
    """
    text = _read(BUILD)
    assert re.search(r'^\s*\$BUNDLE_GS\s*=\s*\$false\s*$', text, re.M), (
        "build_production.ps1 phải khởi tạo $BUNDLE_GS = $false"
    )
    assert not re.search(r'^\s*\$BUNDLE_GS\s*=\s*\$true\s*$', text, re.M), (
        "không được có dòng đặt $BUNDLE_GS = $true ở mức mặc định"
    )


def test_build_has_no_ghostscript_opt_in():
    text = _read(BUILD)
    assert "WithGhostscript" not in text
    assert "PRYNX_BUNDLE_GS" not in text
    assert not re.search(r'\$BUNDLE_GS\s*=\s*\$true', text)


def test_runtime_policy_ignores_all_gs_environment(monkeypatch):
    """Mọi môi trường đều phải khởi tạo cùng một hợp đồng PPE/no-GS."""
    monkeypatch.setenv("GHOSTSCRIPT_PATH", r"C:\Program Files\gs\gswin64c.exe")
    monkeypatch.setenv("PRYNX_PRINT_ENGINE", "gs")
    monkeypatch.setenv("PRYNX_ALLOW_GS_FALLBACK", "true")
    monkeypatch.setenv("PRYNX_FORCE_GS", "true")

    from app.config import Settings

    configured = Settings()
    assert configured.GHOSTSCRIPT_PATH == ""
    assert not hasattr(configured, "PRYNX_PRINT_ENGINE")
    assert not hasattr(configured, "PRYNX_ALLOW_GS_FALLBACK")
    assert not hasattr(configured, "PRYNX_FORCE_GS")


def test_corpus_gate_uses_fixed_no_gs_contract():
    """Cổng corpus không được đọc thuộc tính fallback đã bị xoá khỏi Settings."""
    text = _read(AUDIT)
    assert not re.search(r"settings\s*\.\s*PRYNX_ALLOW_GS_FALLBACK", text), (
        "gs_dependency_audit.py còn đọc thuộc tính Settings đã bị xoá; "
        "cổng phát hành sẽ crash trước khi audit corpus"
    )
    assert "settings.GHOSTSCRIPT_PATH" in text


@pytest.mark.parametrize("entry", RELEASE_ENTRIES, ids=lambda p: p.name)
def test_release_entries_never_turn_bundling_back_on(entry):
    """Wrapper phát hành không được bật lại bundle GS.

    Chúng KHÔNG cần truyền gì cả — mặc định đã là no-GS. Điều phải chặn là một
    wrapper nào đó lặng lẽ bật lại.
    """
    text = _read(entry)
    assert "-WithGhostscript" not in text, f"{entry.name} bật lại bundle Ghostscript"
    assert not re.search(r'PRYNX_BUNDLE_GS\s*=\s*["\']?1', text), (
        f"{entry.name} đặt PRYNX_BUNDLE_GS=1"
    )


# ─────────────────────────────────────────────────────────────────────────────
#  §3.3 — verifier phải chạy được trên artifact thật
# ─────────────────────────────────────────────────────────────────────────────

def test_verifier_reads_main_binary_name_from_config():
    """Tên binary lấy từ `src-tauri/Cargo.toml`, không hardcode productName."""
    text = _read(VERIFIER)
    assert "src-tauri" in text and "Cargo.toml" in text, (
        "verifier phải đọc tên main binary từ cấu hình"
    )
    # Tên thật hiện tại phải nằm trong tập ứng viên (dù là qua Cargo.toml).
    cargo = REPO / "desktop" / "src-tauri" / "Cargo.toml"
    if cargo.is_file():
        m = re.search(r'^\s*name\s*=\s*"([^"]+)"', cargo.read_text(encoding="utf-8"), re.M)
        assert m, "không đọc được [package] name của src-tauri"
        assert m.group(1) == "pdf-inspector", (
            f"tên crate đổi thành {m.group(1)} — cập nhật lại test và verifier cùng lúc"
        )


def test_notice_matcher_is_not_simple_match():
    """`-SimpleMatch` với pattern `A|B|C` không bao giờ khớp.

    Đây là false-negative im lặng: NOTICE còn AGPL vẫn được báo sạch.
    """
    text = _read(VERIFIER)
    for line in text.splitlines():
        if "Ghostscript|Artifex|AGPL" in line:
            assert "-SimpleMatch" not in line, (
                "pattern có dấu | phải dùng regex, không dùng -SimpleMatch: " + line.strip()
            )

            break
    else:
        pytest.fail("không tìm thấy chốt kiểm NOTICE trong verifier")


def test_verifier_checks_the_no_gs_marker():
    """Marker là thứ backend đọc để không mượn GS của máy khách."""
    text = _read(VERIFIER)
    assert "NO_GHOSTSCRIPT.txt" in text

# ─────────────────────────────────────────────────────────────────────────────
#  §3.6 — bộ đo no-GS là release gate thật
# ─────────────────────────────────────────────────────────────────────────────

def test_no_gs_audit_forces_utf8_console():
    text = _read(AUDIT)
    assert 'reconfigure(encoding="utf-8"' in text, (
        "audit phải tự cấu hình UTF-8, không phụ thuộc PYTHONIOENCODING của máy chạy"
    )


def test_no_gs_audit_gate_fails_on_gs_or_error():
    text = _read(AUDIT)
    assert re.search(r'add_argument\(\s*"--gate"', text)
    assert re.search(r'counts\.get\("GS".*counts\.get\("ERROR"', text, re.S)
    assert re.search(r'if\s+args\.gate\s+and\s+blocking', text)
    assert re.search(r'if\s+args\.gate\s+and\s+blocking[\s\S]*?return\s+1', text)


def test_release_qa_runs_no_gs_gate_on_corpus():
    text = _read(RELEASE_QA)
    assert "gs_dependency_audit.py" in text
    assert "--gate" in text
    assert "PRYNX_NO_GS_CORPUS" in text
    assert re.search(r'--limit\s+18', text)


def test_release_qa_covers_typecheck_and_print_engine():
    text = _read(RELEASE_QA)
    assert "npm.cmd run typecheck" in text
    assert r'Push-Location "$ROOT\print_engine"' in text
    assert 'Invoke-Checked "Print engine tests" { cargo test --locked }' in text
    assert (
        'Invoke-Checked "Print engine release compile" '
        '{ cargo check --release --locked }'
    ) in text


def test_release_qa_stages_all_frontend_workspace_sibling_fixtures():
    text = _read(RELEASE_QA)
    assert "native\\tests\\fixtures\\dieline_default_request.json" in text
    assert "imposition_core\\tests\\fixtures\\grid_parity_simple_auto.json" in text


def test_staged_native_qa_uses_a_runtime_specific_no_gs_artifact():
    qa = _read(RELEASE_QA)
    build = _read(BUILD)
    assert "PRYNX_NO_GS_AUDIT_OUT" in qa
    assert "PRYNX_NO_GS_AUDIT_OUT" in build
    assert "release_no_gs_audit-native-$nativeQaId.json" in build


def test_staged_native_qa_canonicalizes_windows_short_path_aliases():
    text = _read(RELEASE_QA)
    assert "pathlib.Path(os.environ['PRYNX_RELEASE_NATIVE_SITE']).resolve()" in text
    assert "package.is_relative_to(site)" in text
    assert "$actualNativePackage.StartsWith(" not in text


def test_release_uses_updater_signature_generated_for_each_version():
    build = _read(BUILD)
    release = _read(RELEASE_UPDATE)
    config = _read(REPO / "desktop" / "src-tauri" / "tauri.release.conf.json")
    assert "src-tauri/tauri.release.conf.json" in build
    assert "TAURI_SIGNING_PRIVATE_KEY" in release
    assert ".sig" in release
    assert '"createUpdaterArtifacts": true' in config


def test_release_does_not_require_windows_authenticode():
    combined = _read(BUILD) + _read(RELEASE_UPDATE)
    markers = ("AuthenticodeThumbprint", "certificateThumbprint", "Get-AuthenticodeSignature")
    for marker in markers:
        assert marker not in combined


def test_public_release_requires_committed_version_and_clean_source():
    release = _read(RELEASE_UPDATE)
    build = _read(BUILD)
    assert "Assert-CommittedReleaseVersion -ExpectedVersion $Version" in release
    assert "status --porcelain=v1 --untracked-files=all" in release
    assert "[System.IO.File]::WriteAllText($confPath" not in release
    assert "[System.IO.File]::WriteAllText($pkgPath" not in release
    assert "[System.IO.File]::WriteAllText($cargoPath" not in release
    assert "$buildArgs = @{ Release = $true }" in release
    assert "Release build refuses inline -Version mutation" in build
    assert "Assert-ReleaseSourceState -CaptureCommit" in build


# ─────────────────────────────────────────────────────────────────────────────
#  Bất biến encoding của script phát hành
# ─────────────────────────────────────────────────────────────────────────────

# Dùng placeholder + `replace` chứ KHÔNG `str.format`: snippet PowerShell đầy `{}`
# nên `format` sẽ hiểu chúng là ô thay thế và ném `KeyError`.
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
        pytest.param(REPO / "build_production.ps1", id="build_production"),
        pytest.param(REPO / "scripts" / "verify_installed_artifact.ps1", id="verify_installed"),
        pytest.param(REPO / "scripts" / "run_release_qa.ps1", id="run_release_qa"),
        pytest.param(REPO / "release_update.ps1", id="release_update"),
        pytest.param(REPO / "quanly_phathanh.ps1", id="quanly_phathanh"),
    ],
)
def test_release_scripts_parse_under_windows_powershell(script):
    """Script phát hành phải PARSE được bằng chính PowerShell của máy.

    Đây là bất biến hẹp nhưng đúng chỗ, thay cho các chốt gián tiếp về encoding.
    Đo được 2026-07-27: `verify_installed_artifact.ps1` khi vừa commit chứa ký tự
    ngoài ASCII mà cp1252 đọc thành **dấu nháy** (`—` = `E2 80 94`, byte `0x94` là
    `"`), nên PowerShell 5.1 báo `Unexpected token` ở một dòng ASCII phía sau và
    gate hậu kiểm **không thể chạy** — trước cả hai bug logic mà audit lần 3 tìm ra.

    Kiểm theo byte thì vừa báo oan vừa bỏ sót: dấu tiếng Việt cũng sinh byte `0x91`
    (`ố` = `E1 BB 91`) mà `quanly_phathanh.ps1` vẫn chạy tốt, vì lỗi chỉ xảy ra khi
    số dấu nháy sinh ra lẻ. Chỉ chính bộ phân tích cú pháp trả lời đúng được.
    """
    import shutil
    import subprocess

    if not script.is_file():
        pytest.skip(f"thiếu {script.name}")
    powershell = shutil.which("powershell") or shutil.which("pwsh")
    if not powershell:
        pytest.skip("không có PowerShell trên máy này")

    proc = subprocess.run(
        [powershell, "-NoProfile", "-NonInteractive", "-Command",
         _PARSE_SNIPPET.replace("@@PATH@@", str(script).replace("'", "''"))],
        capture_output=True, text=True, timeout=120,
    )
    out = (proc.stdout or "").strip()
    assert out == "OK", f"{script.name} không parse được -> {out or proc.stderr.strip()[:200]}"


# ─────────────────────────────────────────────────────────────────────────────
#  NOTICE trong repo — khoá lỗ hổng đã gây hồi quy ngày 2026-07-28
#
#  Chuyện đã xảy ra: có người thêm Real-ESRGAN vào `bundled_components.json` rồi
#  chạy tay `gen_third_party_notices.py` để cập nhật NOTICE, THIẾU cờ
#  `--no-ghostscript`. Vì entry ghostscript vẫn `bundled: true`, việc thiếu cờ
#  lặng lẽ dựng LẠI lời khai "Ghostscript AGPL-3.0 có trong bản phát hành,
#  binaries/gs/" — trong khi build gõ cứng `$BUNDLE_GS=$false`. HEAD sạch, working
#  tree khai sai: đúng loại lỗi không ai thấy.
#
#  Gate cũ chỉ canh (a) build script truyền cờ, (b) verifier soi artifact ĐÃ CÀI.
#  Không gì canh chính file NOTICE trong repo — tức là văn bản mà người đọc repo và
#  bên pháp lý nhìn vào. Ba test dưới đóng chỗ đó.
#
#  Cách sửa gốc: đặt `bundled: false` trong dữ liệu. `load_native` bỏ mọi component
#  `bundled=false` BẤT KỂ cờ dòng lệnh, nên sinh lại NOTICE mà quên cờ vẫn ra đúng.
# ─────────────────────────────────────────────────────────────────────────────

import json  # noqa: E402

NOTICE = REPO / "THIRD_PARTY_NOTICES.md"
COMPONENTS = REPO / "scripts" / "bundled_components.json"


def _native_components() -> list[dict]:
    return json.loads(_read(COMPONENTS))["native_components"]


def test_ghostscript_is_declared_not_bundled():
    """Cờ dữ liệu là chốt DUY NHẤT không phụ thuộc việc caller nhớ truyền cờ."""
    gs = [c for c in _native_components() if c.get("id") == "ghostscript"]
    assert gs, (
        "mất entry ghostscript khỏi bundled_components.json — giữ nó lại với "
        "bundled=false làm mốc lịch sử, đừng xoá"
    )
    assert gs[0].get("bundled") is False, (
        "ghostscript phải khai bundled=false. Đặt lại true là NOTICE sẽ khai "
        "AGPL-3.0 có trong installer ngay lần sinh lại kế tiếp, kể cả khi "
        "build_production.ps1 vẫn không đóng gói GS."
    )


def test_repo_notice_declares_no_strong_copyleft_in_release():
    """Mục 'CÓ trong bản phát hành' không được chứa thành phần copyleft mạnh."""
    text = _read(NOTICE)
    marker = "### Copyleft mạnh — CÓ trong bản phát hành"
    assert marker in text, f"NOTICE mất mục '{marker}' — generator đã đổi khuôn?"

    section = text.split(marker, 1)[1].split("###", 1)[0]
    listed = [
        line.strip()
        for line in section.splitlines()
        if line.strip().startswith("- ")
    ]
    assert not listed, (
        "NOTICE khai có copyleft mạnh trong bản phát hành: "
        f"{listed}. Nếu đúng là đã đóng gói thì phải có quyết định giấy phép; "
        "nếu không thì sinh lại NOTICE (scripts/gen_third_party_notices.py)."
    )


def test_repo_notice_never_mentions_agpl():
    """AGPL ở bất kỳ đâu trong NOTICE nghĩa là ta đang tự khai nghĩa vụ copyleft."""
    hits = [
        f"dòng {i}: {line.strip()}"
        for i, line in enumerate(_read(NOTICE).splitlines(), start=1)
        if "AGPL" in line
    ]
    assert not hits, (
        "NOTICE còn nhắc AGPL:\n  " + "\n  ".join(hits)
        + "\nPrynX không đóng gói thành phần AGPL nào (xem $BUNDLE_GS trong "
        "build_production.ps1). Chạy lại scripts/gen_third_party_notices.py."
    )
