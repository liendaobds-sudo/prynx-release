from app.api.routes.vdp import _path_is_within_root


def test_font_path_scope_uses_path_components_not_prefix_text(tmp_path):
    root = tmp_path / "Fonts"
    sibling = tmp_path / "FontsEvil"
    nested = root / "sub" / "font.ttf"
    sibling_font = sibling / "font.ttf"
    assert _path_is_within_root(str(nested), str(root))
    assert not _path_is_within_root(str(sibling_font), str(root))


def test_font_path_scope_rejects_different_windows_drive():
    assert not _path_is_within_root(r"C:\Windows\Fonts\evil.ttf", r"D:\Windows\Fonts")
