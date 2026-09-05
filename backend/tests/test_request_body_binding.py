"""Ca biên và ratchet cho canonical body commitment của request-signing v2."""

import ast
import asyncio
from io import BytesIO
from pathlib import Path

from starlette.datastructures import FormData, Headers, UploadFile
from starlette.requests import Request

from app.core import license_guard as lg


async def _form_commitment(entries: list[tuple[str, str | UploadFile]]) -> str:
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/upload",
            "headers": [],
        }
    )
    request._form = FormData(entries)
    return await lg._form_body_commitment(request)


def _upload(data: bytes, mime: str = "application/pdf") -> UploadFile:
    return UploadFile(
        BytesIO(data),
        filename="artwork.pdf",
        headers=Headers({"content-type": mime}),
    )


def test_form_commitment_binds_duplicate_order_and_file_metadata() -> None:
    """SEC (audit 2026-09-04 §SEC.21): mọi metadata có nghĩa phải đổi proof."""

    async def exercise() -> None:
        duplicate = await _form_commitment(
            [("plate", "cyan"), ("plate", "magenta")]
        )
        assert duplicate == await _form_commitment(
            [("plate", "cyan"), ("plate", "magenta")]
        )
        assert duplicate != await _form_commitment(
            [("plate", "magenta"), ("plate", "cyan")]
        )
        assert duplicate != await _form_commitment([("plate", "cyan")])

        empty = await _form_commitment([("artwork", _upload(b""))])
        assert empty != await _form_commitment([("source", _upload(b""))])
        assert empty != await _form_commitment(
            [("artwork", _upload(b"", "application/octet-stream"))]
        )
        assert empty != await _form_commitment([("artwork", _upload(b"\0"))])

    asyncio.run(exercise())


def test_chunk_commitment_binds_exact_one_mib_boundary() -> None:
    """Một byte sau biên chunk phải tạo leaf mới và commitment khác."""
    one_mib = b"a" * lg._BODY_COMMITMENT_CHUNK_BYTES
    one_mib_plus_one = one_mib + b"b"

    boundary = lg._raw_body_commitment(one_mib)
    boundary_plus_one = lg._raw_body_commitment(one_mib_plus_one)
    assert boundary_plus_one != boundary

    streamed = lg._ChunkCommitment("http-body")
    streamed.update(one_mib_plus_one[:17])
    streamed.update(one_mib_plus_one[17:-1])
    streamed.update(one_mib_plus_one[-1:])
    assert streamed.hexdigest() == boundary_plus_one


def test_raw_request_stream_routes_stay_inside_reviewed_eof_flow() -> None:
    """Route stream mới phải qua review trước khi có side effect trước EOF."""
    routes_root = Path(__file__).parents[1] / "app" / "api" / "routes"
    stream_calls: list[tuple[str, str]] = []
    create_job_calls: dict[str, int] = {}

    for source_path in routes_root.rglob("*.py"):
        tree = ast.parse(source_path.read_text(encoding="utf-8"), source_path)
        function_stack: list[str] = []

        class StreamVisitor(ast.NodeVisitor):
            def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
                function_stack.append(node.name)
                self.generic_visit(node)
                function_stack.pop()

            def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
                function_stack.append(node.name)
                self.generic_visit(node)
                function_stack.pop()

            def visit_Call(self, node: ast.Call) -> None:
                if isinstance(node.func, ast.Attribute) and node.func.attr == "stream":
                    stream_calls.append(
                        (
                            source_path.relative_to(routes_root).as_posix(),
                            function_stack[-1] if function_stack else "<module>",
                        )
                    )
                if source_path.name == "mixed_nesting.py" and function_stack[-1:] == [
                    "create_job"
                ]:
                    if isinstance(node.func, ast.Name) and node.func.id in {
                        "_read_bounded_body",
                        "_parse_create_request",
                    }:
                        create_job_calls[node.func.id] = node.lineno
                    if (
                        isinstance(node.func, ast.Attribute)
                        and isinstance(node.func.value, ast.Name)
                        and node.func.value.id == "mixed_nesting_jobs"
                        and node.func.attr == "submit"
                    ):
                        create_job_calls["submit"] = node.lineno
                self.generic_visit(node)

        StreamVisitor().visit(tree)

    # SEC (audit 2026-09-04 §SEC.21): dependency chỉ so raw commitment tại EOF.
    # Exact-set này buộc mọi route stream mới phải bổ sung test lifecycle riêng.
    assert stream_calls == [("mixed_nesting.py", "_read_bounded_body")]
    assert (
        create_job_calls["_read_bounded_body"]
        < create_job_calls["_parse_create_request"]
        < create_job_calls["submit"]
    )
