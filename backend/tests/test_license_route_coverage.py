"""Ratchet bảo mật cho dependency xác thực của toàn bộ HTTP API."""

from collections.abc import Iterator
from typing import Any

from fastapi.routing import APIRoute

from app.core.license_guard import require_license
from app.main import app


def _dependency_calls(dependant: Any) -> set[object]:
    calls: set[object] = set()
    pending = [dependant]
    while pending:
        dependant = pending.pop()
        if dependant.call is not None:
            calls.add(dependant.call)
        pending.extend(dependant.dependencies)
    return calls


def _effective_http_routes() -> Iterator[Any]:
    """FastAPI mới giữ router đã include ở dạng lazy; lấy context thực tế của nó."""
    for route in app.routes:
        if isinstance(route, APIRoute):
            yield route
            continue
        contexts = getattr(route, "effective_route_contexts", None)
        if callable(contexts):
            for context in contexts():
                if isinstance(context.original_route, APIRoute):
                    yield context


def test_every_http_api_route_depends_on_require_license() -> None:
    """SEC (audit 2026-09-04 §SEC.21): route mới phải fail-closed mặc định."""
    api_routes = [route for route in _effective_http_routes() if route.path.startswith("/api")]
    assert api_routes, "Ứng dụng không đăng ký HTTP API nào để kiểm tra"

    unprotected = sorted(
        f"{','.join(sorted(route.methods or set()))} {route.path}"
        for route in api_routes
        if require_license not in _dependency_calls(route.dependant)
    )
    assert not unprotected, (
        "Các HTTP API sau không có require_license trong dependency tree:\n"
        + "\n".join(unprotected)
    )
