"""Đọc telemetry Viewer mà không chạy renderer hay thay đổi trạng thái ứng dụng.

Mặc định chọn phiên host PID 11016 của đợt audit 27/09. Dùng --host-pid 0
để chọn phiên host mới nhất. Giới hạn thời gian dùng event_epoch_ms của FE,
không dùng thời điểm lô log FE được ghi muộn xuống đĩa.

Ví dụ (chạy từ gốc repo bằng backend/venv/Scripts/python.exe):
    docs/audit/VIEWER_2026-09-27/analyze_log.py --output-prefix .tmp/viewer-audit/log
    docs/audit/VIEWER_2026-09-27/analyze_log.py --start-ms 1790446064546

Đây là công cụ chẩn đoán, không phải gate 60 fps hoặc benchmark GPU. Không
gán file cho native chỉ vì cùng số trang hoặc cùng trace FE: log native hiện
thiếu document identity trên nhiều sự kiện và revision có thể trùng giữa view.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import sys
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[3]
LINE = re.compile(r"^\[(\d+)\]\s+(.*)$")
FIELD = re.compile(r'(\w+)=("[^"]*"|\([^)]*\)|\S+)')
IDENTITY_FIELDS = (
    "file_path", "filePath", "source_path", "document_path", "documentPath",
    "native_file_path", "path", "document_token", "documentToken", "file_id",
    "document_identity",
)


@dataclass
class Record:
    line: int
    write_ms: int
    event_ms: float
    family: str
    event: str
    data: dict[str, Any]
    raw: str


def finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def decode_scalar(value: str) -> Any:
    if value in ("true", "false"):
        return value == "true"
    try:
        return int(value)
    except ValueError:
        try:
            return float(value)
        except ValueError:
            return value.strip('"')


def parse_line(raw: str, line_number: int) -> Record | None:
    match = LINE.match(raw)
    if not match:
        return None
    write_ms = int(match[1])
    body = match[2]
    if body.startswith(("FE VIEWER_TRACE ", "FE PREVIEW_PERF ")):
        prefix_event = None
        if body.startswith("FE VIEWER_TRACE "):
            encoded = body[len("FE VIEWER_TRACE "):]
        else:
            prefix_event, _, encoded = body[len("FE PREVIEW_PERF "):].partition(" ")
        data = json.loads(encoded)
        if not isinstance(data, dict):
            raise ValueError("Telemetry FE không phải object")
        event_ms = data.get("event_epoch_ms")
        return Record(line_number, write_ms,
                      event_ms if finite_number(event_ms) else write_ms,
                      "frontend", str(prefix_event or data.get("event", "<missing-event>")), data, raw)
    if not (body.startswith("GPU_") or body.startswith("PERF_SESSION ")):
        return None
    event, _, remainder = body.partition(" ")
    data = json.loads(remainder) if remainder.startswith("{") else {
        key: decode_scalar(value) for key, value in FIELD.findall(remainder)
    }
    if not isinstance(data, dict):
        raise ValueError("Sự kiện native không phải object")
    return Record(line_number, write_ms, write_ms, "native", event, data, raw)


def read_snapshot(path: Path, host_pid: int, host_epoch_ms: int | None = None) -> tuple[list[Record], dict[str, Any]]:
    """Hash/đọc một prefix đã chốt kích thước, không đuổi theo log đang append."""
    before = path.stat()
    remaining = before.st_size
    digest = hashlib.sha256()
    records: list[Record] = []
    selected_host: dict[str, Any] | None = None
    host_sessions: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    active = False
    line_number = 0
    bytes_read = 0
    incomplete_tail = False
    with path.open("rb") as source:
        while remaining:
            chunk = source.readline(remaining)
            if not chunk:
                break
            remaining -= len(chunk)
            bytes_read += len(chunk)
            digest.update(chunk)
            line_number += 1
            if not chunk.endswith(b"\n"):
                incomplete_tail = True
                # Dòng cuối chưa ghi xong vẫn nằm trong hash, không thành mẫu đo.
                continue
            raw = chunk.decode("utf-8-sig" if line_number == 1 else "utf-8").rstrip("\r\n")
            try:
                record = parse_line(raw, line_number)
            except (ValueError, json.JSONDecodeError) as error:
                if active:
                    errors.append({"line": line_number, "error": str(error)})
                continue
            if record is None:
                continue
            if record.event == "PERF_SESSION" and record.data.get("role") == "host":
                host = {"line": record.line, "epoch_ms": record.write_ms, **record.data}
                host_sessions.append(host)
                active = (host_pid == 0 or record.data.get("pid") == host_pid) and (
                    host_epoch_ms is None or record.write_ms == host_epoch_ms
                )
                if active:
                    # Nếu PID được tái dùng, chọn đúng phiên khởi động cuối cùng.
                    selected_host = host
                    records = []
                    errors = []
                elif selected_host is not None and "end_line_exclusive" not in selected_host:
                    selected_host["end_line_exclusive"] = record.line
                    selected_host["end_epoch_ms_exclusive"] = record.write_ms
            if active:
                records.append(record)
    after = path.stat()
    if selected_host is None:
        raise ValueError(f"Không tìm thấy host PID {host_pid}; dùng --host-pid 0 để chọn phiên cuối")
    if bytes_read != before.st_size:
        raise ValueError("Log bị rút ngắn khi đọc; không xuất số đo từ snapshot thiếu bytes")
    return records, {
        "path": str(path.resolve()), "sha256": digest.hexdigest(),
        "sha256_scope": "prefix [0, snapshot_bytes), đọc theo stream; không gồm append sau lúc bắt đầu",
        "snapshot_bytes": bytes_read, "snapshot_lines": line_number,
        "size_before": before.st_size, "size_after": after.st_size,
        "mtime_ns_before": before.st_mtime_ns, "mtime_ns_after": after.st_mtime_ns,
        "changed_during_read": before.st_mtime_ns != after.st_mtime_ns or before.st_size != after.st_size,
        "incomplete_last_line_ignored": incomplete_tail,
        "selected_host": selected_host, "host_sessions_seen": host_sessions,
        "selected_session_parse_errors": errors,
    }


def summary(values: Iterable[float]) -> dict[str, Any]:
    ordered = sorted(float(value) for value in values)
    n = len(ordered)
    if not n:
        return {"N": 0, "min_ms": None, "p50_ms": None, "p95_ms": None,
                "max_ms": None, "gt_16_667_ms": 0, "gt_50_ms": 0}
    return {
        "N": n, "min_ms": round(ordered[0], 6),
        "p50_ms": round(ordered[math.ceil(n * .50) - 1], 6),
        "p95_ms": round(ordered[math.ceil(n * .95) - 1], 6),
        "max_ms": round(ordered[-1], 6),
        "gt_16_667_ms": sum(value > 16.667 for value in ordered),
        "gt_50_ms": sum(value > 50 for value in ordered),
    }


class Accumulator:
    def __init__(self) -> None:
        self.events: Counter[str] = Counter()
        self.values: dict[str, list[float]] = defaultdict(list)
        self.rows: list[int] = []
        self.times: list[float] = []
        self.rejected: Counter[str] = Counter()

    def count(self, record: Record) -> None:
        self.events[record.event] += 1
        self.rows.append(record.line)
        self.times.append(record.event_ms)

    def add(self, name: str, value: Any, divisor: float = 1) -> None:
        if finite_number(value) and value >= 0:
            self.values[name].append(value / divisor)
        elif value is not None:
            self.rejected[name] += 1

    def export(self) -> dict[str, Any]:
        return {
            "event_counts": dict(sorted(self.events.items())),
            "timings": {name: summary(values) for name, values in sorted(self.values.items())},
            "rejected_negative_or_nonfinite": dict(self.rejected),
            "first_line": min(self.rows) if self.rows else None,
            "last_line": max(self.rows) if self.rows else None,
            "first_event_epoch_ms": min(self.times) if self.times else None,
            "last_event_epoch_ms": max(self.times) if self.times else None,
        }


def native_metrics(record: Record, target: Accumulator) -> None:
    target.count(record)
    event, data = record.event, record.data
    fields: dict[str, str] = {}
    if event == "GPU_INPUT_PRESENT":
        if data.get("input_revision") != data.get("revision"):
            target.events["INPUT_PRESENT_revision_mismatch_excluded"] += 1
            return
        fields = {"message_to_present_us": "input_message_to_present_ms"}
    elif event == "GPU_SCENE_PRESENT":
        fields = {"request_to_present_us": "present_request_age_ms", "resident_us": "present_resident_cpu_ms"}
    elif event == "GPU_SCENE_REFINE":
        kind = "overview" if data.get("overview") is True else "detail" if data.get("overview") is False else "unknown"
        fields = {key: f"refine_{kind}_{name}_ms" for key, name in (
            ("encode_us", "encode_cpu"), ("clip_us", "clip_cpu"),
            ("material_us", "material_cpu"), ("ready_us", "request_age_until_submitted"),
        )}
    elif event == "GPU_SCENE_COMPILE":
        fields = {"parse_us": "scene_parse_cpu_ms", "compile_us": "scene_compile_cpu_ms",
                  "transport_us": "scene_transport_residual_ms"}
    elif event == "GPU_SCENE_CACHE":
        suffix = "hit" if data.get("hit") is True else "miss"
        fields = {"prepare_us": f"scene_prepare_{suffix}_ms"}
    elif event == "GPU_SCENE_READY":
        target.add("scene_ready_prepare_rounded_ms", data.get("prepare_ms"))
    elif event == "GPU_SHARED_PREPARE":
        fields = {"lut_us": "shared_lut_cpu_ms", "pipelines_us": "shared_pipeline_cpu_ms"}
    elif event == "GPU_SURFACE_ACQUIRE":
        fields = {"wait_us": "surface_acquire_logged_slow_only_ms"}
    elif event == "GPU_DIAG_NATIVE_PRESENT":
        # Không đếm message_to_present lần hai từ dòng diagnostic cùng input.
        fields = {"acquire_us": "surface_acquire_input_present_samples_ms"}
    if event == "GPU_DETAIL_CACHE":
        target.events[f"detail_cache_{data.get('action', 'unknown')}"] += 1
        if finite_number(data.get("evicted")):
            target.events["detail_cache_evicted_frames"] += int(data["evicted"])
    for key, name in fields.items():
        target.add(name, data.get(key), 1000)


def file_like_path(value: Any) -> bool:
    return isinstance(value, str) and bool(
        re.match(r"^(?:[A-Za-z]:[\\/]|\\\\|/|file:)", value)
        or value.lower().endswith(".pdf")
    )


def identity_values(data: dict[str, Any], *, native: bool = False) -> list[str]:
    # `path` trong VIEWER_TRACE thường là hash 8 ký tự, không phải tên file thật.
    # GPU_DIAG_NATIVE_WHEEL lại dùng path=zoom/scroll để chỉ nhánh input.
    return sorted({f"{key}={data[key]}" for key in IDENTITY_FIELDS
                   if data.get(key) not in (None, "")
                   and not (native and key == "path" and not file_like_path(data[key]))})


def revision_context(records: list[Record]) -> dict[str, dict[str, Any]]:
    contexts: dict[str, dict[str, Any]] = {}
    for record in records:
        revision = record.data.get("revision")
        if record.family != "native" or revision is None:
            continue
        context = contexts.setdefault(str(revision), {"pages": set(), "explicit_identities": set(), "evidence_lines": []})
        if record.event in ("GPU_SCENE_COMPILE", "GPU_SCENE_CACHE", "GPU_SCENE_READY"):
            if record.data.get("page") is not None:
                context["pages"].add(record.data["page"])
            context["evidence_lines"].append(record.line)
        context["explicit_identities"].update(identity_values(record.data, native=True))
    for context in contexts.values():
        context["pages"] = sorted(context["pages"], key=str)
        context["explicit_identities"] = sorted(context["explicit_identities"])
        context["scope"] = (
            "revision-only; page mapping ambiguous" if len(context["pages"]) != 1 else
            "revision/page only; document identity unobserved" if not context["explicit_identities"] else
            "revision/page with explicit identity candidates; do not assume uniqueness across views"
        )
    return contexts


def fe_metrics(record: Record, target: Accumulator) -> None:
    target.count(record)
    target.add("event_to_log_write_delay_ms", record.write_ms - record.event_ms)
    status = record.data.get("status")
    if status is not None:
        target.events[f"{record.event}.status={status}"] += 1
    for key, value in record.data.items():
        # Timestamp tuyệt đối/tương đối không phải duration của event.
        if key.endswith("_epoch_ms") or key in ("elapsed_ms", "time_origin_ms", "event_time_ms"):
            continue
        if key.endswith("_ms"):
            target.add(f"{record.event}.{key}", value)
            if status is not None:
                target.add(f"{record.event}.status={status}.{key}", value)
        elif key.endswith("_us"):
            target.add(f"{record.event}.{key[:-3]}_ms", value, 1000)


def evidence_worthy(record: Record, include_frame_details: bool) -> bool:
    if record.family == "native":
        return include_frame_details or record.event != "GPU_DIAG_NATIVE_PRESENT_FRAME"
    name = record.event.lower()
    return any(part in name for part in (
        "bootstrap", "prime", "first-frame", "adopt", "cancel", "stale", "request",
        "ppe-ipc", "native", "long-task", "longtask", "frame-opportunity", "tile-ready",
        "viewer-render-source", "render-coordinator",
    ))


def analyze(records: list[Record], start_ms: int | None, end_ms: int | None) -> tuple[dict[str, Any], list[Record]]:
    contexts = revision_context(records)  # Giữ mapping trước cửa sổ đo pan mới.
    selected = [record for record in records
                if (start_ms is None or record.event_ms >= start_ms)
                and (end_ms is None or record.event_ms <= end_ms)]
    native = Accumulator()
    native_groups: dict[str, Accumulator] = defaultdict(Accumulator)
    fe = Accumulator()
    fe_groups: dict[str, Accumulator] = defaultdict(Accumulator)
    fe_explicit: dict[str, Accumulator] = defaultdict(Accumulator)
    trace_context: dict[str, dict[str, set[Any]]] = defaultdict(lambda: {"pages": set(), "explicit_identities": set()})
    document_paths: dict[str, dict[str, Any]] = {}
    # Liên kết identity->path chỉ khi cùng một event tự mang đủ hai trường.
    for record in records:
        identity = record.data.get("document_identity")
        path = record.data.get("path")
        if record.family == "frontend" and identity and file_like_path(path):
            mapping = document_paths.setdefault(str(identity), {"paths": set(), "evidence_lines": []})
            mapping["paths"].add(path)
            mapping["evidence_lines"].append(record.line)
    for record in selected:
        if record.family == "native":
            native_metrics(record, native)
            revision = record.data.get("revision")
            native_metrics(record, native_groups[str(revision) if revision is not None else "unscoped"])
        else:
            fe_metrics(record, fe)
            trace = str(record.data.get("trace_id", "unobserved"))
            page = record.data.get("page", record.data.get("viewer_page", "unobserved"))
            group_key = f"trace={trace}|page={page}"
            fe_metrics(record, fe_groups[group_key])
            trace_context[trace]["pages"].add(page)
            identities = identity_values(record.data)
            trace_context[trace]["explicit_identities"].update(identities)
            if identities:
                owner = str(record.data.get("owner_id", ""))
                role = "thumbnail" if owner.startswith("thumbnail:") else "viewer" if owner.startswith("viewer:") else "unobserved"
                pipeline = record.data.get("color_pipeline", "unobserved")
                fe_metrics(record, fe_explicit[f"{group_key}|{'|'.join(identities)}|role={role}|pipeline={pipeline}"])
    result = {
        "selection": {"start_ms_inclusive": start_ms, "end_ms_inclusive": end_ms,
                      "time_basis": "FE event_epoch_ms khi có, native thời điểm ghi log; không dùng FE flush làm event time",
                      "selected_records": len(selected)},
        "percentile": "nearest-rank: sorted[ceil(p*N)-1]; ngưỡng strict >16.667 ms và >50 ms",
        "native_session_aggregate_mixed_documents": native.export(),
        "native_revision_context_from_whole_selected_host_session": contexts,
        "native_by_revision_not_assumed_document": {key: value.export() for key, value in sorted(native_groups.items())},
        "frontend_session_aggregate_mixed_documents": fe.export(),
        "frontend_by_trace_page_not_assumed_document": {key: value.export() for key, value in sorted(fe_groups.items())},
        "frontend_explicit_identity_events_only": {key: value.export() for key, value in sorted(fe_explicit.items())},
        "frontend_document_identity_paths_from_explicit_events": {
            identity: {"paths": sorted(value["paths"]), "evidence_lines": value["evidence_lines"]}
            for identity, value in sorted(document_paths.items())
        },
        "frontend_trace_context": {trace: {key: sorted(value, key=str) for key, value in context.items()}
                                   for trace, context in trace_context.items()},
        "caveats": [
            "Native/FE aggregate có thể gồm nhiều tài liệu, VDP và page 1 khác nhau; KHÔNG gọi là benchmark một PDF.",
            "Chỉ map revision->page từ SCENE_COMPILE/CACHE/READY. Không suy native identity từ path hash FE hoặc số trang.",
            "Revision native không có view/document trên nhiều dòng; revision trùng giữa view vẫn là khoảng trống, kể cả page candidate duy nhất.",
            "FE cùng trace_id có thể mở tài liệu khác; groups trace/page không bảo đảm cùng file. Nhóm explicit chỉ gồm event tự mang identity.",
            "INPUT_PRESENT là WndProc->present() trên CPU, không gồm queue OS, GPU completion hoặc scanout; coalesced inputs không có mẫu riêng.",
            "SCENE_REFINE ready_us là tuổi request tới submit hết command buffers, KHÔNG phải ảnh đã nét trên màn hình.",
            "SCENE_PRESENT request_to_present là tuổi request, có thể tiếp tục tăng khi refine sau input cuối; không coi là input latency.",
            "SCENE_PRESENT resident_us bỏ acquire trước nó và bao gồm một phần logging; không phải GPU time.",
            "SURFACE_ACQUIRE chỉ log wait >=8000us trong source hiện tại: phân bố conditional slow-only. Diagnostic acquire cũng chỉ lấy mẫu có input present.",
            "transport_us là residual elapsed-minus-parse-minus-compile; gồm startup/wire encode/decode/read, không phải IPC thuần.",
            "Không tính present intervals/FPS để tránh biến idle hoặc resize thành dropped-frame rate.",
            "Hash là prefix đã chốt byte length lúc bắt đầu; log append tiếp không nằm trong snapshot. Parse errors và tail thiếu newline không thành mẫu.",
        ],
    }
    return result, selected


def self_test() -> None:
    """Test thuần bộ phân tích, không đọc app/log hay chạy workload render."""
    assert summary([])["N"] == 0
    assert summary([1, 2, 3, 4, 5])["p95_ms"] == 5
    assert summary([16.667, 16.668, 50, 50.001])["gt_16_667_ms"] == 3
    assert summary([16.667, 16.668, 50, 50.001])["gt_50_ms"] == 1
    raw = '[2000] FE VIEWER_TRACE {"event":"first-frame-prime-ready","event_epoch_ms":1500,"total_ms":959,"elapsed_ms":90000,"trace_id":"a","path":"abc12345"}'
    fe = parse_line(raw, 10)
    assert fe is not None and fe.event_ms == 1500
    base = parse_line('[1000] GPU_SCENE_READY revision=14 page=1 prepare_ms=12', 1)
    sample = parse_line('[1600] GPU_INPUT_PRESENT revision=14 input_revision=14 message_to_present_us=16668', 11)
    wrong = parse_line('[1601] GPU_INPUT_PRESENT revision=14 input_revision=12 message_to_present_us=90000', 12)
    assert base is not None and sample is not None and wrong is not None
    result, selected = analyze([base, fe, sample, wrong], 1400, 1800)
    assert len(selected) == 3
    assert result["native_revision_context_from_whole_selected_host_session"]["14"]["pages"] == [1]
    timings = result["native_session_aggregate_mixed_documents"]["timings"]
    assert timings["input_message_to_present_ms"]["N"] == 1
    assert timings["input_message_to_present_ms"]["max_ms"] == 16.668
    fe_timings = result["frontend_session_aggregate_mixed_documents"]["timings"]
    assert fe_timings["event_to_log_write_delay_ms"]["max_ms"] == 500
    assert "first-frame-prime-ready.elapsed_ms" not in fe_timings
    assert "identity unobserved" in result["native_revision_context_from_whole_selected_host_session"]["14"]["scope"]
    conflicting = parse_line('[1602] GPU_SCENE_COMPILE revision=14 page=2 parse_us=1', 13)
    assert conflicting is not None
    assert len(revision_context([base, conflicting])["14"]["pages"]) == 2
    wheel = parse_line('[1603] GPU_DIAG_NATIVE_WHEEL {"revision":14,"path":"scroll"}', 14)
    assert wheel is not None and not revision_context([base, wheel])["14"]["explicit_identities"]
    assert identity_values({"path": "zoom"}, native=True) == []
    assert identity_values({"path": "C:\\fixtures\\page.pdf"}, native=True)
    source = parse_line('[1501] FE PREVIEW_PERF viewer-render-source {"path":"C:\\\\fixtures\\\\sample.pdf","document_identity":"123:456:789"}', 15)
    assert source is not None and source.event == "viewer-render-source"
    coordinator = parse_line('[1502] FE PREVIEW_PERF render-coordinator-result {"status":"cancelled","total_ms":23,"document_identity":"123:456:789","owner_id":"viewer:fixture","page":1,"color_pipeline":"accurate","event_epoch_ms":1500,"started_epoch_ms":1200,"time_origin_ms":1000,"event_time_ms":500}', 16)
    assert coordinator is not None and coordinator.event == "render-coordinator-result"
    extra, _ = analyze([source, coordinator], None, None)
    timings = extra["frontend_session_aggregate_mixed_documents"]["timings"]
    assert timings["render-coordinator-result.total_ms"]["max_ms"] == 23
    assert not any(key.endswith(("epoch_ms", "time_origin_ms", "event_time_ms")) for key in timings)
    assert extra["frontend_session_aggregate_mixed_documents"]["event_counts"]["render-coordinator-result.status=cancelled"] == 1
    assert "123:456:789" in extra["frontend_document_identity_paths_from_explicit_events"]
    assert evidence_worthy(source, False) and evidence_worthy(coordinator, False)
    print("analyze_log self-test: PASS (không chạy renderer)")


def main() -> None:
    # Console Windows có thể là cp1252; báo cáo/đường dẫn tiếng Việt vẫn phải in được.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--log", type=Path, default=ROOT / ".tmp/render-diagnostics/PrynX_RenderPerf.log")
    parser.add_argument("--host-pid", type=int, default=11016, help="0 chọn host session mới nhất; mặc định ca audit PID 11016")
    parser.add_argument("--start-ms", type=int)
    parser.add_argument("--end-ms", type=int)
    parser.add_argument("--output-prefix", type=Path, default=Path(__file__).with_name("log-analysis"))
    parser.add_argument("--include-frame-details", action="store_true", help="giữ JSON ma trận resident lớn trong raw evidence")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if args.start_ms is not None and args.end_ms is not None and args.start_ms > args.end_ms:
        parser.error("--start-ms phải <= --end-ms")
    records, provenance = read_snapshot(args.log, args.host_pid)
    start_ms = max(args.start_ms or 0, provenance["selected_host"]["epoch_ms"])
    result, selected = analyze(records, start_ms, args.end_ms)
    result["schema"] = 1
    result["generated_at_utc"] = datetime.now(timezone.utc).isoformat()
    result["input_snapshot"] = provenance
    result["analyzer_sha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    prefix = args.output_prefix.resolve()
    prefix.parent.mkdir(parents=True, exist_ok=True)
    evidence_path = prefix.with_name(prefix.name + ".evidence.log")
    report_path = prefix.with_name(prefix.name + ".json")
    evidence = "".join(f"{record.line}\t{record.raw}\n" for record in selected
                       if evidence_worthy(record, args.include_frame_details))
    evidence_bytes = evidence.encode("utf-8")
    evidence_path.write_bytes(evidence_bytes)
    result["raw_evidence"] = {"path": str(evidence_path), "sha256": hashlib.sha256(evidence_bytes).hexdigest(),
                              "format": "original_line_number TAB original_log_line", "bytes": len(evidence_bytes)}
    report_path.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({"report": str(report_path), "evidence": str(evidence_path),
                      "snapshot_sha256": provenance["sha256"], "selected_records": len(selected),
                      "host_pid": provenance["selected_host"].get("pid"),
                      "start_ms": start_ms, "end_ms": args.end_ms}, ensure_ascii=False))


if __name__ == "__main__":
    main()
