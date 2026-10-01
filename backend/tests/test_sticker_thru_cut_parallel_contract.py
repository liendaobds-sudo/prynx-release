"""Hợp đồng truyền margin ThruCut qua nhánh xử lý song song."""

from __future__ import annotations

import io

import pikepdf


def _blank_pdf_bytes(page_count: int) -> bytes:
    with pikepdf.Pdf.new() as pdf:
        for _ in range(page_count):
            pdf.add_blank_page(page_size=(72, 72))
        buffer = io.BytesIO()
        pdf.save(buffer)
        return buffer.getvalue()


def test_parallel_thru_cut_preserves_per_side_margins(tmp_path, monkeypatch):
    from app.workers import sticker_engine as engine

    source = tmp_path / "source.pdf"
    source.write_bytes(_blank_pdf_bytes(2))
    output = tmp_path / "output.pdf"
    captured_args: list[dict] = []

    def run(args_list, n_workers, use_pool, spill_dir=None):
        captured_args.extend(args_list)
        return [
            (index, (_blank_pdf_bytes(len(args["page_indices"])), [], [], True))
            for index, args in enumerate(args_list)
        ]

    worker = engine.StickerEngine()
    monkeypatch.setattr(engine, "_cap_sticker_workers", lambda *_args, **_kwargs: 2)
    monkeypatch.setattr(worker, "_run_sticker_chunks", run)

    forwarded = []

    def capture_parallel(_self, **kwargs):
        forwarded.append(kwargs)
        return True, {}

    # Kiểm tra luôn điểm gọi từ process_pdf; lỗi cũ xảy ra trước khi vào
    # _process_parallel nên test trực tiếp hàm đó sẽ không bắt được.
    with monkeypatch.context() as call_patch:
        call_patch.setattr(engine, "_n_pages_should_parallelize", lambda *_args, **_kwargs: True)
        call_patch.setattr(engine.StickerEngine, "_process_parallel", capture_parallel)
        success, _ = engine.StickerEngine().process_pdf(
            input_path=str(source),
            output_path=str(output),
            thrucut_enabled=True,
            thrucut_shape="rounded_rect",
            thrucut_margin_mm=3.0,
            thrucut_margin_top_mm=1.25,
            thrucut_margin_bottom_mm=2.5,
            thrucut_margin_left_mm=3.75,
            thrucut_margin_right_mm=5.0,
            thrucut_radius_mm=4.0,
            thrucut_spot_name="ThruCut",
            thrucut_color=(1.0, 0.0, 0.0, 0.0),
            thrucut_color_hex="#00FFFF",
        )
    assert success
    assert len(forwarded) == 1
    assert {
        key: forwarded[0][key]
        for key in (
            "thrucut_enabled",
            "thrucut_shape",
            "thrucut_margin_top_mm",
            "thrucut_margin_bottom_mm",
            "thrucut_margin_left_mm",
            "thrucut_margin_right_mm",
            "thrucut_radius_mm",
            "thrucut_spot_name",
            "thrucut_color",
            "thrucut_color_hex",
        )
    } == {
        "thrucut_enabled": True,
        "thrucut_shape": "rounded_rect",
        "thrucut_margin_top_mm": 1.25,
        "thrucut_margin_bottom_mm": 2.5,
        "thrucut_margin_left_mm": 3.75,
        "thrucut_margin_right_mm": 5.0,
        "thrucut_radius_mm": 4.0,
        "thrucut_spot_name": "ThruCut",
        "thrucut_color": (1.0, 0.0, 0.0, 0.0),
        "thrucut_color_hex": "#00FFFF",
    }

    success, _ = worker._process_parallel(
        input_path=str(source),
        output_path=str(output),
        cut_mode="original",
        offset_mm=0.0,
        corner_style="preserve",
        cut_color=(0, 1, 0, 0),
        bleed_mm=0.0,
        fill_holes=True,
        remove_white_bg=False,
        bleed_color_type="solid",
        solid_bleed_color=(255, 255, 255),
        draw_cut_contour=True,
        rectangle_mode=False,
        edge_bite_mm=0.0,
        cut_first_page_only=False,
        thrucut_enabled=True,
        thrucut_shape="rounded_rect",
        thrucut_margin_mm=3.0,
        thrucut_margin_top_mm=1.25,
        thrucut_margin_bottom_mm=2.5,
        thrucut_margin_left_mm=3.75,
        thrucut_margin_right_mm=5.0,
        thrucut_radius_mm=4.0,
        thrucut_spot_name="ThruCut",
        thrucut_color=(1.0, 0.0, 0.0, 0.0),
        thrucut_color_hex="#00FFFF",
    )

    assert success
    assert len(captured_args) == 2
    for args in captured_args:
        assert {
            key: args[key]
            for key in (
                "thrucut_enabled",
                "thrucut_shape",
                "thrucut_margin_mm",
                "thrucut_margin_top_mm",
                "thrucut_margin_bottom_mm",
                "thrucut_margin_left_mm",
                "thrucut_margin_right_mm",
                "thrucut_radius_mm",
                "thrucut_spot_name",
                "thrucut_color",
                "thrucut_color_hex",
            )
        } == {
            "thrucut_enabled": True,
            "thrucut_shape": "rounded_rect",
            "thrucut_margin_mm": 3.0,
            "thrucut_margin_top_mm": 1.25,
            "thrucut_margin_bottom_mm": 2.5,
            "thrucut_margin_left_mm": 3.75,
            "thrucut_margin_right_mm": 5.0,
            "thrucut_radius_mm": 4.0,
            "thrucut_spot_name": "ThruCut",
            "thrucut_color": (1.0, 0.0, 0.0, 0.0),
            "thrucut_color_hex": "#00FFFF",
        }

    worker_kwargs = {}

    def fake_process_pdf(_self, **kwargs):
        worker_kwargs.update(kwargs)
        return (b"", [], [], False)

    monkeypatch.setattr(engine.StickerEngine, "process_pdf", fake_process_pdf)
    chunk_index, _ = engine._process_sticker_chunk(captured_args[0])
    assert chunk_index == 0
    assert {
        key: worker_kwargs[key]
        for key in (
            "thrucut_margin_top_mm",
            "thrucut_margin_bottom_mm",
            "thrucut_margin_left_mm",
            "thrucut_margin_right_mm",
        )
    } == {
        "thrucut_margin_top_mm": 1.25,
        "thrucut_margin_bottom_mm": 2.5,
        "thrucut_margin_left_mm": 3.75,
        "thrucut_margin_right_mm": 5.0,
    }

