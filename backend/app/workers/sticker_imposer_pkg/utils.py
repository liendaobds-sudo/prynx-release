"""
Sticker Imposer — Shared utilities and constants.

Extracted from sticker_imposer.py monolith.
"""
import math
import logging
from typing import List, Dict, Any

logger = logging.getLogger(__name__)

MY_SCRIPT_TOLERANCE = 0.05


def calculate_items_bounding_box(items: List[Dict[str, Any]]) -> Dict[str, float]:
    if not items:
        return {'minX': 0, 'minY': 0, 'maxX': 0, 'maxY': 0, 'width': 0, 'height': 0}
    
    min_x = float('inf')
    min_y = float('inf')
    max_x = float('-inf')
    max_y = float('-inf')
    
    for item in items:
        w = item['width']
        h = item['height']
        min_x = min(min_x, item['x'])
        min_y = min(min_y, item['y'])
        max_x = max(max_x, item['x'] + w)
        max_y = max(max_y, item['y'] + h)
        
    return {
        'minX': min_x,
        'minY': min_y,
        'maxX': max_x,
        'maxY': max_y,
        'width': max_x - min_x,
        'height': max_y - min_y
    }


def normalize_items_to_origin(items: List[Dict[str, Any]]) -> Dict[str, float]:
    """Normalize items to origin (0,0) and return bounding box."""
    if not items:
        return {'minX': 0, 'minY': 0, 'maxX': 0, 'maxY': 0, 'width': 0, 'height': 0}
    bb = calculate_items_bounding_box(items)
    if bb['minX'] > 0.01 or bb['minY'] > 0.01:
        for it in items:
            it['x'] -= bb['minX']
            it['y'] -= bb['minY']
    return bb
