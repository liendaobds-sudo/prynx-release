"""Tạo fixture và tổng hợp corpus shadow render của PrynX Viewer.

Script chỉ đọc các dòng ``PPE_SHADOW {json}`` trong ``PrynX_RenderPerf.log``.
Report không chứa đường dẫn hay nội dung PDF: chỉ có ID corpus, hash, timing,
soundness và mẫu số trang xác định trước trong manifest.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import tempfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MANIFEST = REPO_ROOT / "docs" / "VIEWER_ENGINE_CORPUS_2026-08-10.json"
DEFAULT_GENERATED = REPO_ROOT / ".tmp" / "ppe_viewer_corpus"
REQUIRED_CATEGORIES = {
    "simple_rgb_vector_text",
    "image_scan",
    "cmyk_spot",
    "transparency_ocg",
    "annotation_form",
}
SHADOW_MARKER = "PPE_SHADOW "
DEFAULT_ROLLOUT_GATE = {
    "requiredDpi": 96.0,
    "minReadyPairsPerPage": 1,
    "maxRgbMae": 5.0,
    "maxP95TotalMs": 650,
    "maxUnsupportedAttempts": 0,
    "maxErrorAttempts": 0,
    "requireStableArtifactPair": True,
}


def _pdf(objects: list[bytes], root_id: int = 1) -> bytes:
    """Ghi PDF tối thiểu có xref chuẩn, byte hoàn toàn deterministic."""
    output = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for object_id, body in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(f"{object_id} 0 obj\n".encode("ascii"))
        output.extend(body)
        output.extend(b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(
        (
            f"trailer\n<< /Size {len(objects) + 1} /Root {root_id} 0 R >>\n"
            f"startxref\n{xref}\n%%EOF\n"
        ).encode("ascii")
    )
    return bytes(output)


def _stream(dictionary: bytes, content: bytes) -> bytes:
    return (
        b"<< "
        + dictionary
        + f" /Length {len(content)} >>\nstream\n".encode("ascii")
        + content
        + b"\nendstream"
    )


def generated_fixture_bytes() -> dict[str, bytes]:
    ocg_content = b"q /OC /Layer BDC 0.10 0.60 0.90 rg 20 20 160 160 re f EMC Q"
    ocg = _pdf(
        [
            (
                b"<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [5 0 R] "
                b"/D << /Order [5 0 R] /ON [5 0 R] /OFF [] "
                b"/AS [<< /Event /View /Category [/View] /OCGs [5 0 R] >> "
                b"<< /Event /Print /Category [/Print] /OCGs [5 0 R] >>] >> >> >>"
            ),
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            (
                b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] "
                b"/Resources << /Properties << /Layer 5 0 R >> >> /Contents 4 0 R >>"
            ),
            _stream(b"", ocg_content),
            (
                b"<< /Type /OCG /Name (Viewer Layer) /Usage << "
                b"/View << /ViewState /ON >> /Print << /PrintState /OFF >> >> >>"
            ),
        ]
    )

    appearance = b"0.90 0.20 0.20 rg 0 0 160 60 re f"
    annotation = _pdf(
        [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            (
                b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 120] "
                b"/Resources << >> /Contents 4 0 R /Annots [5 0 R] >>"
            ),
            _stream(b"", b"q Q"),
            (
                b"<< /Type /Annot /Subtype /Widget /Rect [20 20 180 80] /F 4 "
                b"/AP << /N 6 0 R >> >>"
            ),
            _stream(
                b"/Type /XObject /Subtype /Form /BBox [0 0 160 60] /Resources << >>",
                appearance,
            ),
        ]
    )
    return {"ocg_view.pdf": ocg, "annotation_ap.pdf": annotation}


def prepare_generated(directory: Path) -> dict[str, str]:
    directory.mkdir(parents=True, exist_ok=True)
    hashes: dict[str, str] = {}
    for name, data in generated_fixture_bytes().items():
        target = directory / name
        if not target.is_file() or target.read_bytes() != data:
            target.write_bytes(data)
        hashes[name] = hashlib.sha256(data).hexdigest()
    return hashes


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _document_identity_hash(path: Path) -> str:
    stat = path.stat()
    created_ns = getattr(stat, "st_birthtime_ns", stat.st_ctime_ns)
    token = f"{stat.st_size}:{stat.st_mtime_ns}:{created_ns}"
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def _resolve_entry_path(entry: dict[str, Any], generated: Path) -> Path | None:
    if env_name := entry.get("env"):
        raw = os.environ.get(str(env_name), "").strip()
        return Path(raw) if raw else None
    raw = str(entry.get("path", ""))
    if raw.startswith("${GENERATED}/"):
        return generated / raw.removeprefix("${GENERATED}/")
    path = Path(raw)
    return path if path.is_absolute() else REPO_ROOT / path


def load_corpus(manifest_path: Path, generated: Path, allow_missing: bool) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 2:
        raise ValueError("Manifest corpus phải dùng schemaVersion=2")
    if manifest.get("engineModeGate") not in {"current", "hybrid", "ppe-only"}:
        raise ValueError("engineModeGate không hợp lệ")
    _rollout_gate(manifest)
    entries = manifest.get("entries", [])
    categories = {str(entry.get("category")) for entry in entries}
    missing_categories = sorted(REQUIRED_CATEGORIES - categories)
    if missing_categories:
        raise ValueError(f"Manifest thiếu nhóm corpus: {', '.join(missing_categories)}")

    resolved: list[dict[str, Any]] = []
    missing_required: list[str] = []
    for entry in entries:
        path = _resolve_entry_path(entry, generated)
        required = bool(entry.get("required", True))
        if path is None or not path.is_file():
            if required:
                missing_required.append(str(entry.get("id", "unknown")))
            continue
        actual_sha = _sha256_file(path)
        expected_sha = str(entry.get("sha256", "")).lower()
        if expected_sha and actual_sha != expected_sha:
            raise ValueError(f"Hash corpus không khớp cho {entry.get('id')}: {actual_sha}")
        pages = sorted({int(page) for page in entry.get("pages", [1]) if int(page) > 0})
        if not pages:
            raise ValueError(f"Corpus {entry.get('id')} không có trang hợp lệ")
        resolved.append(
            {
                "id": str(entry["id"]),
                "category": str(entry["category"]),
                "contentSha256": actual_sha,
                "documentHash": _document_identity_hash(path),
                "pages": pages,
                "expectedArtifacts": entry.get("expectedArtifactSha256ByPage", {}),
            }
        )
    if missing_required and not allow_missing:
        raise FileNotFoundError(f"Thiếu corpus bắt buộc: {', '.join(missing_required)}")
    return manifest, resolved


def parse_shadow_log(log_path: Path) -> list[dict[str, Any]]:
    observations: list[dict[str, Any]] = []
    for line in log_path.read_text(encoding="utf-8", errors="replace").splitlines():
        marker = line.find(SHADOW_MARKER)
        if marker < 0:
            continue
        try:
            value = json.loads(line[marker + len(SHADOW_MARKER) :])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and isinstance(value.get("documentHash"), str):
            observations.append(value)
    return observations


def _percentile(values: list[int], percentile: float) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    rank = max(0, math.ceil(percentile * len(ordered)) - 1)
    return ordered[min(rank, len(ordered) - 1)]


def _rollout_gate(manifest: dict[str, Any]) -> dict[str, Any]:
    """Đọc và kiểm cấu hình gate; không cho giá trị sai biến thành gate nới lỏng."""
    raw = manifest.get("rolloutGate", {})
    if not isinstance(raw, dict):
        raise ValueError("rolloutGate phải là object")
    gate = {**DEFAULT_ROLLOUT_GATE, **raw}
    numeric_positive = ("requiredDpi", "maxRgbMae", "maxP95TotalMs")
    for key in numeric_positive:
        value = gate.get(key)
        if (
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(float(value))
            or float(value) <= 0
        ):
            raise ValueError(f"rolloutGate.{key} phải là số dương hữu hạn")
    for key in ("minReadyPairsPerPage", "maxUnsupportedAttempts", "maxErrorAttempts"):
        value = gate.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise ValueError(f"rolloutGate.{key} phải là số nguyên không âm")
    if gate["minReadyPairsPerPage"] < 1:
        raise ValueError("rolloutGate.minReadyPairsPerPage phải ít nhất là 1")
    if not isinstance(gate.get("requireStableArtifactPair"), bool):
        raise ValueError("rolloutGate.requireStableArtifactPair phải là boolean")
    return gate


def build_report(
    manifest_path: Path,
    manifest: dict[str, Any],
    entries: list[dict[str, Any]],
    observations: list[dict[str, Any]],
) -> dict[str, Any]:
    by_key: dict[tuple[str, int], list[dict[str, Any]]] = defaultdict(list)
    for value in observations:
        try:
            by_key[(str(value["documentHash"]), int(value["page"]))].append(value)
        except (KeyError, TypeError, ValueError):
            continue

    category_rows: dict[str, list[dict[str, Any]]] = defaultdict(list)
    entry_rows: list[dict[str, Any]] = []
    gate_failures: list[str] = []
    rollout_gate = _rollout_gate(manifest)
    required_dpi = float(rollout_gate["requiredDpi"])
    max_rgb_mae = float(rollout_gate["maxRgbMae"])
    max_p95_total_ms = int(rollout_gate["maxP95TotalMs"])
    min_ready_pairs = int(rollout_gate["minReadyPairsPerPage"])
    for entry in entries:
        page_rows: list[dict[str, Any]] = []
        for page in entry["pages"]:
            all_attempts = by_key.get((entry["documentHash"], page), [])
            attempts = [
                value
                for value in all_attempts
                if isinstance(value.get("dpi"), (int, float))
                and not isinstance(value.get("dpi"), bool)
                and math.isfinite(float(value["dpi"]))
                and abs(float(value["dpi"]) - required_dpi) <= 0.01
            ]
            statuses = Counter(str(value.get("status", "invalid")) for value in attempts)
            ready = [value for value in attempts if value.get("status") == "ready"]
            unsupported_attempts = statuses.get("unsupported", 0)
            error_attempts = sum(
                count for status, count in statuses.items() if status not in {"ready", "unsupported"}
            )
            expected_artifact = str(entry["expectedArtifacts"].get(str(page), ""))
            artifacts = sorted({str(value.get("artifactHash")) for value in ready if value.get("artifactHash")})
            display_artifacts = sorted(
                {str(value.get("displayArtifactHash")) for value in ready if value.get("displayArtifactHash")}
            )
            mae_values = [
                float(value["rgbMae"])
                for value in ready
                if isinstance(value.get("rgbMae"), (int, float))
                and not isinstance(value.get("rgbMae"), bool)
                and math.isfinite(float(value["rgbMae"]))
            ]
            display_times = [
                int(value["displayTotalMs"])
                for value in ready
                if isinstance(value.get("displayTotalMs"), (int, float))
                and not isinstance(value.get("displayTotalMs"), bool)
                and math.isfinite(float(value["displayTotalMs"]))
                and float(value["displayTotalMs"]) >= 0
            ]
            ppe_times = [
                int(value["totalMs"])
                for value in ready
                if isinstance(value.get("totalMs"), (int, float))
                and not isinstance(value.get("totalMs"), bool)
                and math.isfinite(float(value["totalMs"]))
                and float(value["totalMs"]) >= 0
            ]
            missing_artifact_pair = any(
                not isinstance(value.get("artifactHash"), str)
                or not value["artifactHash"]
                or not isinstance(value.get("displayArtifactHash"), str)
                or not value["displayArtifactHash"]
                for value in ready
            )
            p50_mae_milli = _percentile([round(value * 1000) for value in mae_values], 0.50)
            artifact_matches = not expected_artifact or expected_artifact in artifacts
            p50_total_ms = _percentile(ppe_times, 0.50)
            p95_total_ms = _percentile(ppe_times, 0.95)
            p50_display_total_ms = _percentile(display_times, 0.50)
            p95_display_total_ms = _percentile(display_times, 0.95)
            row = {
                "page": page,
                "attempts": len(all_attempts),
                "requiredDpiAttempts": len(attempts),
                "wrongDpiAttempts": len(all_attempts) - len(attempts),
                "readyPairs": len(ready),
                "statuses": dict(sorted(statuses.items())),
                "artifactHashes": artifacts,
                "displayArtifactHashes": display_artifacts,
                "artifactMatchesBaseline": artifact_matches,
                "maxRgbMae": max(mae_values) if mae_values else None,
                "p50RgbMae": None if p50_mae_milli is None else p50_mae_milli / 1000.0,
                "p50TotalMs": p50_total_ms,
                "p95TotalMs": p95_total_ms,
                "p50DisplayTotalMs": p50_display_total_ms,
                "p95DisplayTotalMs": p95_display_total_ms,
                "comparisonSamples": len(mae_values),
            }
            prefix = f"{entry['id']}:p{page}"
            if not all_attempts:
                gate_failures.append(f"missing:{entry['id']}:p{page}")
            else:
                if len(attempts) != len(all_attempts):
                    gate_failures.append(f"wrong-dpi:{prefix}")
                if unsupported_attempts > int(rollout_gate["maxUnsupportedAttempts"]):
                    gate_failures.append(f"unsupported:{prefix}")
                if error_attempts > int(rollout_gate["maxErrorAttempts"]):
                    gate_failures.append(f"error:{prefix}")
                if len(ready) < min_ready_pairs:
                    gate_failures.append(f"insufficient-pairs:{prefix}")
                if missing_artifact_pair:
                    gate_failures.append(f"missing-artifact-pair:{prefix}")
                if len(mae_values) != len(ready):
                    gate_failures.append(f"missing-mae:{prefix}")
                if len(ppe_times) != len(ready) or len(display_times) != len(ready):
                    gate_failures.append(f"missing-timing:{prefix}")
                if (
                    rollout_gate["requireStableArtifactPair"]
                    and ready
                    and not missing_artifact_pair
                    and (len(artifacts) != 1 or len(display_artifacts) != 1)
                ):
                    gate_failures.append(f"unstable-artifact-pair:{prefix}")
                if not artifact_matches:
                    gate_failures.append(f"artifact-drift:{prefix}")
                if mae_values and max(mae_values) > max_rgb_mae:
                    gate_failures.append(f"mae:{prefix}")
                if p95_total_ms is not None and p95_total_ms > max_p95_total_ms:
                    gate_failures.append(f"ppe-p95:{prefix}")
            page_rows.append(row)
        entry_row = {
            "id": entry["id"],
            "category": entry["category"],
            "contentSha256": entry["contentSha256"],
            "expectedPages": len(entry["pages"]),
            "observedPages": sum(1 for row in page_rows if row["attempts"] > 0),
            "pages": page_rows,
        }
        entry_rows.append(entry_row)
        category_rows[entry["category"]].append(entry_row)

    categories = []
    for category in sorted(REQUIRED_CATEGORIES):
        rows = category_rows.get(category, [])
        pages = [page for row in rows for page in row["pages"]]
        ready_times = [
            value
            for page in pages
            for value in ([page["p50TotalMs"]] if page["p50TotalMs"] is not None else [])
        ]
        categories.append(
            {
                "category": category,
                "expectedPages": sum(row["expectedPages"] for row in rows),
                "observedPages": sum(row["observedPages"] for row in rows),
                "p50OfPageP50Ms": _percentile(ready_times, 0.50),
                "p95OfPageP50Ms": _percentile(ready_times, 0.95),
            }
        )

    manifest_hash = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    return {
        "schemaVersion": 2,
        "manifestSha256": manifest_hash,
        "engineModeGate": manifest.get("engineModeGate", "current"),
        "rolloutGate": rollout_gate,
        "maxRgbMae": max_rgb_mae,
        "denominator": {
            "entries": len(entries),
            "pages": sum(len(entry["pages"]) for entry in entries),
        },
        "observationsRead": len(observations),
        "gatePassed": not gate_failures,
        "gateFailures": gate_failures,
        "categories": categories,
        "entries": entry_rows,
    }


def self_test() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        pdf = root / "fixture.pdf"
        pdf.write_bytes(generated_fixture_bytes()["ocg_view.pdf"])
        entry = {
            "id": "fixture",
            "category": "transparency_ocg",
            "contentSha256": _sha256_file(pdf),
            "documentHash": _document_identity_hash(pdf),
            "pages": [1],
            "expectedArtifacts": {},
        }
        manifest_path = root / "manifest.json"
        manifest_path.write_text("{}", encoding="utf-8")
        report = build_report(
            manifest_path,
            {},
            [entry],
            [
                {
                    "documentHash": entry["documentHash"],
                    "page": 1,
                    "dpi": 96.0,
                    "status": "ready",
                    "artifactHash": "abc",
                    "displayArtifactHash": "def",
                    "rgbMae": 1.25,
                    "totalMs": 12,
                    "displayTotalMs": 8,
                }
            ],
        )
        assert report["gatePassed"] is True
        assert report["denominator"]["pages"] == 1
        assert report["entries"][0]["pages"][0]["comparisonSamples"] == 1
        assert _percentile([10, 20, 30, 40], 0.95) == 40

        missing_mae = build_report(
            manifest_path,
            {},
            [entry],
            [
                {
                    "documentHash": entry["documentHash"],
                    "page": 1,
                    "dpi": 96.0,
                    "status": "ready",
                    "artifactHash": "abc",
                    "displayArtifactHash": "def",
                    "displayTotalMs": 8,
                    "totalMs": 12,
                }
            ],
        )
        assert missing_mae["gatePassed"] is False
        assert missing_mae["gateFailures"] == ["missing-mae:fixture:p1"]

        partial_mae = build_report(
            manifest_path,
            {},
            [entry],
            [
                {
                    "documentHash": entry["documentHash"],
                    "page": 1,
                    "dpi": 96.0,
                    "status": "ready",
                    "artifactHash": "abc",
                    "displayArtifactHash": "def",
                    "rgbMae": 1.25,
                    "totalMs": 12,
                    "displayTotalMs": 8,
                },
                {
                    "documentHash": entry["documentHash"],
                    "page": 1,
                    "dpi": 96.0,
                    "status": "ready",
                    "artifactHash": "abc",
                    "displayArtifactHash": "def",
                    "totalMs": 11,
                    "displayTotalMs": 7,
                },
            ],
        )
        assert partial_mae["gatePassed"] is False
        assert partial_mae["gateFailures"] == ["missing-mae:fixture:p1"]

        excessive_mae = build_report(
            manifest_path,
            {"maxRgbMae": 5.0},
            [entry],
            [
                {
                    "documentHash": entry["documentHash"],
                    "page": 1,
                    "dpi": 96.0,
                    "status": "ready",
                    "artifactHash": "abc",
                    "displayArtifactHash": "def",
                    "rgbMae": 5.001,
                    "totalMs": 12,
                    "displayTotalMs": 8,
                }
            ],
        )
        assert excessive_mae["gatePassed"] is False
        assert excessive_mae["gateFailures"] == ["mae:fixture:p1"]

        complete = {
            "documentHash": entry["documentHash"],
            "page": 1,
            "dpi": 96.0,
            "status": "ready",
            "artifactHash": "abc",
            "displayArtifactHash": "def",
            "rgbMae": 1.25,
            "totalMs": 12,
            "displayTotalMs": 8,
        }
        missing_pair_value = {**complete, "artifactHash": None}
        missing_pair = build_report(manifest_path, {}, [entry], [missing_pair_value])
        assert missing_pair["gateFailures"] == ["missing-artifact-pair:fixture:p1"]

        runtime_error = {
            "documentHash": entry["documentHash"],
            "page": 1,
            "dpi": 96.0,
            "status": "error",
        }
        mixed_error = build_report(manifest_path, {}, [entry], [complete, runtime_error])
        assert mixed_error["gateFailures"] == ["error:fixture:p1"]

        slow = build_report(manifest_path, {}, [entry], [{**complete, "totalMs": 651}])
        assert slow["gateFailures"] == ["ppe-p95:fixture:p1"]

        insufficient = build_report(
            manifest_path,
            {"rolloutGate": {"minReadyPairsPerPage": 2}},
            [entry],
            [complete],
        )
        assert insufficient["gateFailures"] == ["insufficient-pairs:fixture:p1"]


def main() -> int:
    parser = argparse.ArgumentParser(description="Tổng hợp corpus PPE Viewer shadow")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--log", type=Path, help="PrynX_RenderPerf.log")
    parser.add_argument("--output", type=Path, help="ghi report JSON")
    parser.add_argument("--generated-dir", type=Path, default=DEFAULT_GENERATED)
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--allow-missing", action="store_true")
    parser.add_argument("--gate", action="store_true", help="trả mã lỗi nếu corpus chưa đạt")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        print("self-test: PASS")
        return 0

    if args.gate and args.allow_missing:
        parser.error("--gate không được dùng cùng --allow-missing vì sẽ làm sai mẫu số")

    generated_hashes = prepare_generated(args.generated_dir)
    if args.prepare_only:
        print(json.dumps(generated_hashes, ensure_ascii=False, indent=2, sort_keys=True))
        return 0
    if args.log is None:
        parser.error("--log là bắt buộc trừ khi dùng --prepare-only/--self-test")

    manifest, entries = load_corpus(args.manifest, args.generated_dir, args.allow_missing)
    observations = parse_shadow_log(args.log)
    report = build_report(args.manifest, manifest, entries, observations)
    serialized = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(serialized, encoding="utf-8")
    else:
        print(serialized, end="")
    return 1 if args.gate and not report["gatePassed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
