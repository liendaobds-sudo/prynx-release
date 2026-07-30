"""Smoke test tái lập cho probe Rust/PyO3 của spike vector logo."""

from __future__ import annotations

from PIL import Image, ImageDraw

import logo_vectorizer_probe as probe


def main() -> int:
    image = Image.new("RGBA", (600, 600), (255, 255, 255, 255))
    draw = ImageDraw.Draw(image)
    for i in range(60):
        color = ((i * 37) % 255, (i * 71) % 255, (i * 113) % 255, 255)
        draw.ellipse(
            (i * 5, i * 3, 599 - i * 2, 599 - i * 4),
            outline=color,
            width=3,
        )

    rgba = image.tobytes()
    svg = probe.trace_rgba(600, 600, rgba, max_colors=8)
    assert "<svg" in svg[:200] and len(svg) > 100

    cancelled, reports, elapsed_ms, phase = probe.probe_cancel(
        600,
        600,
        rgba,
        max_colors=8,
        cancel_after_reports=1,
    )
    assert cancelled and reports >= 1

    small = image.resize((200, 200))
    progress = probe.probe_progress(200, 200, small.tobytes(), max_colors=4)
    phases = sorted({item[0] for item in progress})
    assert {"Segment", "Compose", "Optimize"} <= set(phases)

    print("RUST PROBE ĐẠT")
    print(f"  SVG: {len(svg.encode('utf-8'))} byte")
    print(f"  Hủy: {cancelled}, {reports} báo cáo, {elapsed_ms:.2f} ms, pha {phase}")
    print(f"  Tiến độ: {len(progress)} báo cáo, pha {phases}")
    print(f"  Năng lực: {dict(probe.probe_info())}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
