import pytest
from app.api.routes.imposition import PreviewLayoutRequest, preview_layout
from unittest.mock import patch, MagicMock

from tests.license_helpers import PRO_LICENSE

@pytest.mark.asyncio
async def test_large_sticker_imposer_still_bin_packs():
    # QUYẾT ĐỊNH SẢN PHẨM (b): KHÔNG có ngưỡng page_count. File nhiều mẫu (>100 trang,
    # vd VDP) VẪN dùng bin-pack (solve_auto_fill_mixed) như file ít trang — ưu tiên
    # xếp kín giấy, không fallback per-page. Preview & render hành xử giống nhau.
    req = PreviewLayoutRequest(
        usable_w=1000, usable_h=1000, item_w=100, item_h=100,
        gap_x=10, gap_y=10, strategy='optimal_auto',
        task_mode='sticker_imposer', target_quantity=0, file_id='test_file_1'
    )

    with patch('app.workers.pdf_wrapper.open') as mock_pdf_open, \
         patch('app.database.SessionLocal') as mock_db, \
         patch('app.workers.sticker_imposer_pkg.bin_packing.solve_auto_fill_mixed') as mock_solve_mixed:
        
        mock_page = MagicMock()
        mock_page.trimbox.width = 100.0
        mock_page.trimbox.height = 100.0
        mock_page.rect.width = 100.0
        mock_page.rect.height = 100.0

        mock_doc = MagicMock()
        mock_doc.page_count = 105  # > 100 pages — vẫn bin-pack (không fallback)
        mock_doc.__getitem__.return_value = mock_page
        mock_pdf_open.return_value = mock_doc
        
        mock_solve_mixed.return_value = {"placements": []}

        await preview_layout(req, PRO_LICENSE)
        
        # >100 trang vẫn đi nhánh bin-pack (theo quyết định (b))
        mock_solve_mixed.assert_called_once()

@pytest.mark.asyncio
async def test_normal_sticker_imposer():
    # Test case 2: Normal sticker imposer (< 100 pages)
    req = PreviewLayoutRequest(
        usable_w=1000, usable_h=1000, item_w=100, item_h=100,
        gap_x=10, gap_y=10, strategy='optimal_auto',
        task_mode='sticker_imposer', target_quantity=0, file_id='test_file_2'
    )

    with patch('app.workers.pdf_wrapper.open') as mock_pdf_open, \
         patch('app.database.SessionLocal') as mock_db, \
         patch('app.workers.sticker_imposer_pkg.bin_packing.solve_auto_fill_mixed') as mock_solve_mixed:
        
        mock_page = MagicMock()
        mock_page.trimbox.width = 100.0
        mock_page.trimbox.height = 100.0
        mock_page.rect.width = 100.0
        mock_page.rect.height = 100.0

        mock_doc = MagicMock()
        mock_doc.page_count = 10  # <= 100 pages
        mock_doc.__getitem__.return_value = mock_page
        mock_pdf_open.return_value = mock_doc
        
        mock_solve_mixed.return_value = {"placements": []}

        await preview_layout(req, PRO_LICENSE)
        
        # Should call solve_auto_fill_mixed since it's a multi-page sticker imposer
        mock_solve_mixed.assert_called_once()
