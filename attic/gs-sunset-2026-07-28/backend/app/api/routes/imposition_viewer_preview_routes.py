# CÁCH LY 2026-07-28 — KHÔNG import file này ở đâu.
#
# Nguyên văn 3 route đã rút khỏi `backend/app/api/routes/imposition.py`. Chúng phục vụ
# lớp preview tạm dựng bằng Ghostscript, mà GS đã bị chặn vô điều kiện ở
# `subprocess_utils._guard_ghostscript` → mọi lần gọi đều ném `ViewerPreviewError`
# → route trả 503 → frontend lùi về PDFium. Tức là code chết.
#
# Giữ nguyên văn để dán lại được nếu cần. Xem `attic/gs-sunset-2026-07-28/README.md`.
#
# Vị trí gốc: ngay TRƯỚC route `@router.post("/quick-color-space")`.
# `imposition.py` vẫn còn sẵn `FileResponse`, `asyncio`, `HTTPException`, `logger`,
# `_validate_file_path` nên dán lại không cần thêm import.

@router.post("/viewer-preview/page")
async def viewer_page_preview(body: dict):
    """Return a disposable fast preview; PDFium still paints the final sharp layer."""
    from app.core.viewer_preview import ViewerPreviewError, render_page_preview

    pdf_path = _validate_file_path(body.get("path"))
    try:
        page = int(body.get("page", 1))
        dpi = int(body.get("dpi", 96))
        result = await asyncio.to_thread(render_page_preview, pdf_path, page, dpi)
        logger.info(
            "[PAGE_TIMING] page=%s dpi=%s cache_hit=%s render_ms=%s",
            page, dpi, result.cache_hit, result.render_ms,
        )
        return FileResponse(
            path=result.path,
            media_type="image/jpeg",
            headers={
                "Cache-Control": "private, max-age=31536000, immutable",
                "X-PrynX-Preview-Cache": "hit" if result.cache_hit else "miss",
                "X-PrynX-Preview-Ms": str(result.render_ms),
            },
        )
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid page preview parameters.")
    except ViewerPreviewError as exc:
        logger.info("Fast page preview unavailable: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc))


@router.post("/viewer-preview/thumbnails")
async def viewer_thumbnail_batch(body: dict):
    """Prepare one visible thumbnail block in a single Ghostscript process."""
    from app.core.viewer_preview import ViewerPreviewError, prepare_thumbnail_batch

    pdf_path = _validate_file_path(body.get("path"))
    try:
        page_count = int(body.get("page_count", 0))
        start_page = int(body.get("start_page", 1))
        batch_size = int(body.get("batch_size", 8))
        result = await asyncio.to_thread(
            prepare_thumbnail_batch, pdf_path, page_count, start_page, batch_size
        )
        logger.info(
            "[THUMB_TIMING] pages=%d-%d (%d) cache_hit=%s render_ms=%d",
            result.start_page, result.end_page,
            result.end_page - result.start_page + 1,
            result.cache_hit, result.render_ms,
        )
        return {
            "cache_key": result.cache_key,
            "pages": result.pages,
            "start_page": result.start_page,
            "end_page": result.end_page,
            "cache_hit": result.cache_hit,
            "render_ms": result.render_ms,
        }
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid thumbnail parameters.")
    except ViewerPreviewError as exc:
        logger.info("Fast thumbnail preview unavailable: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc))


@router.get("/viewer-preview/thumbnail/{cache_key}/{page}")
async def viewer_thumbnail(cache_key: str, page: int):
    """Serve one authenticated thumbnail from the opaque sidecar cache."""
    from app.core.viewer_preview import ViewerPreviewError, thumbnail_path

    try:
        path = thumbnail_path(cache_key, page)
        return FileResponse(
            path=path,
            media_type="image/jpeg",
            headers={"Cache-Control": "private, max-age=31536000, immutable"},
        )
    except ViewerPreviewError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
