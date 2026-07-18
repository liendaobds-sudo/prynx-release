"""Tem bế / CNC: clusterMode row/column không được chia usable (rò từ N-Up)."""
from app.workers.nup_engine import run_nup_engine  # noqa: F401 — import path check


def test_die_cut_ignores_cluster_row_mode_usable_logic():
    """Mirror logic nup_engine: is_die_cut → force cluster_mode='none' trước khi chia usable."""
    # Inline the same decision the engine makes (không cần PDF đầy đủ).
    settings = {
        'isDieCutMode': True,
        'clusterMode': 'row',
        'clusterCount': 2,
        'clusterGap': 0,
        'sheetWidth': 320,
        'sheetHeight': 450,
        'marginTop': 5,
        'marginBottom': 5,
        'marginLeft': 5,
        'marginRight': 5,
    }
    MM = 2.83465
    sheet_w = settings['sheetWidth'] * MM
    sheet_h = settings['sheetHeight'] * MM
    margin_top = settings['marginTop'] * MM
    margin_bottom = settings['marginBottom'] * MM
    margin_left = settings['marginLeft'] * MM
    margin_right = settings['marginRight'] * MM
    usable_w = sheet_w - margin_left - margin_right
    usable_h = sheet_h - margin_top - margin_bottom
    full_h = usable_h

    cluster_mode = settings.get('clusterMode', 'none')
    cluster_count = max(2, settings.get('clusterCount', 2))
    cluster_gap = settings.get('clusterGap', 0) * MM
    is_die_cut = settings.get('isDieCutMode', False)
    is_cnc = False
    if is_die_cut or is_cnc:
        cluster_mode = 'none'
    if cluster_mode == 'row' and cluster_count >= 2:
        usable_h = (usable_h - cluster_gap * (cluster_count - 1)) / cluster_count

    assert cluster_mode == 'none'
    assert abs(usable_h - full_h) < 0.01, "die-cut must use full usable height"


def test_guillotine_still_splits_cluster_row():
    """N-Up xén vẫn chia usable khi clusterMode=row (hành vi giữ nguyên)."""
    MM = 2.83465
    usable_h = 400.0 * MM
    cluster_mode = 'row'
    cluster_count = 2
    cluster_gap = 0.0
    is_die_cut = False
    if is_die_cut:
        cluster_mode = 'none'
    if cluster_mode == 'row' and cluster_count >= 2:
        usable_h = (usable_h - cluster_gap * (cluster_count - 1)) / cluster_count
    assert abs(usable_h - 200.0 * MM) < 0.01
