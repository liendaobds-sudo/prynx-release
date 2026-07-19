from pathlib import Path

import pikepdf

from app.core.layer_engine import LayerEngine


def _write_pdf(path: Path, *, with_ocg: bool, orphan_ocgs: int = 0) -> None:
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(200, 200))
    if with_ocg:
        layer = pdf.make_indirect(
            pikepdf.Dictionary(Type=pikepdf.Name("/OCG"), Name=pikepdf.String("Artwork"))
        )
        catalog = [layer]
        for index in range(orphan_ocgs):
            catalog.append(
                pdf.make_indirect(
                    pikepdf.Dictionary(
                        Type=pikepdf.Name("/OCG"),
                        Name=pikepdf.String(f"Orphan {index + 1}"),
                    )
                )
            )
        pdf.Root.OCProperties = pikepdf.Dictionary(
            OCGs=pikepdf.Array(catalog),
            D=pikepdf.Dictionary(Order=pikepdf.Array([layer]), ON=pikepdf.Array([layer])),
        )
    pdf.save(path)


def test_original_only_reads_ocg_without_scanning_pages(tmp_path, monkeypatch):
    source = tmp_path / "layered.pdf"
    _write_pdf(source, with_ocg=True)
    engine = LayerEngine()

    def unexpected(*_args, **_kwargs):
        raise AssertionError("original_only must not scan page objects or create virtual layers")

    monkeypatch.setattr(engine, "_enrich_layers_with_objects", unexpected)
    monkeypatch.setattr(engine, "_add_virtual_page_layers", unexpected)

    result = engine.get_layer_tree(str(source), original_only=True)

    assert [layer["name"] for layer in result["layers"]] == ["Artwork"]
    assert all(not layer.get("isVirtual") for layer in result["layers"])


def test_original_only_returns_empty_for_pdf_without_ocg(tmp_path, monkeypatch):
    source = tmp_path / "flat.pdf"
    _write_pdf(source, with_ocg=False)
    engine = LayerEngine()

    def unexpected(*_args, **_kwargs):
        raise AssertionError("original_only must not synthesize page layers")

    monkeypatch.setattr(engine, "_enrich_layers_with_objects", unexpected)
    monkeypatch.setattr(engine, "_add_virtual_page_layers", unexpected)

    result = engine.get_layer_tree(str(source), original_only=True)

    assert result == {"layers": [], "total": 0}

def test_order_tree_excludes_orphan_catalog_ocgs(tmp_path):
    source = tmp_path / "illustrator-style.pdf"
    _write_pdf(source, with_ocg=True, orphan_ocgs=3)

    result = LayerEngine().get_layer_tree(str(source), original_only=True)

    # Illustrator can leave stale OCG objects in /OCGs. /D/Order is the
    # authoritative layer panel structure and contains only the visible layer.
    assert [layer["name"] for layer in result["layers"]] == ["Artwork"]
    assert result["total"] == 1

def test_original_only_honors_base_state_and_explicit_overrides(tmp_path):
    source = tmp_path / "initial-visibility.pdf"
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(200, 200))
    layer_a = pdf.make_indirect(
        pikepdf.Dictionary(Type=pikepdf.Name("/OCG"), Name=pikepdf.String("Hidden by base"))
    )
    layer_b = pdf.make_indirect(
        pikepdf.Dictionary(Type=pikepdf.Name("/OCG"), Name=pikepdf.String("Explicitly on"))
    )
    pdf.Root.OCProperties = pikepdf.Dictionary(
        OCGs=pikepdf.Array([layer_a, layer_b]),
        D=pikepdf.Dictionary(
            BaseState=pikepdf.Name("/OFF"),
            ON=pikepdf.Array([layer_b]),
            Order=pikepdf.Array([layer_a, layer_b]),
        ),
    )
    pdf.save(source)

    result = LayerEngine().get_layer_tree(str(source), original_only=True)

    assert [(layer["name"], layer["visible"]) for layer in result["layers"]] == [
        ("Hidden by base", False),
        ("Explicitly on", True),
    ]


def test_original_only_preserves_names_and_label_groups(tmp_path):
    source = tmp_path / "grouped.pdf"
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(200, 200))
    cut = pdf.make_indirect(
        pikepdf.Dictionary(Type=pikepdf.Name("/OCG"), Name=pikepdf.String("Cut|CUT"))
    )
    art = pdf.make_indirect(
        pikepdf.Dictionary(Type=pikepdf.Name("/OCG"), Name=pikepdf.String("Artwork"))
    )
    pdf.Root.OCProperties = pikepdf.Dictionary(
        OCGs=pikepdf.Array([cut, art]),
        D=pikepdf.Dictionary(
            Order=pikepdf.Array([
                pikepdf.String("Production"),
                pikepdf.Array([cut, art]),
            ]),
        ),
    )
    pdf.save(source)

    result = LayerEngine().get_layer_tree(str(source), original_only=True)

    assert result["total"] == 2
    assert result["layers"][0]["isGroup"] is True
    assert result["layers"][0]["name"] == "Production"
    assert [child["name"] for child in result["layers"][0]["children"]] == [
        "Cut|CUT",
        "Artwork",
    ]