"""
Layer Engine — Illustrator F7-style OCG Layer Management.

Uses pikepdf for structural edits + pypdfium2 for rendering.
All OCG toggling is done by modifying /D/OFF in a temp copy,
then rendering with pypdfium2 which respects the default OCG visibility state.
"""
import logging
import io
import base64
import os
import uuid
import tempfile
from pathlib import Path
from typing import Optional

import pikepdf
import pypdfium2 as pdfium

logger = logging.getLogger(__name__)


class LayerEngine:
    """Comprehensive OCG Layer Manager for PDF files (pikepdf + pypdfium2 only)."""

    # ─── READ ────────────────────────────────────────────────────

    def get_layer_tree(self, pdf_path: str) -> dict:
        """
        Parse OCG layers from PDF into a hierarchical tree.
        Returns: { layers: [...], total: int }
        
        Each layer: {
            id: int,          # OCG object number (pikepdf objgen[0])
            name: str,
            visible: bool,
            locked: bool,
            depth: int,
            children: [...],
            color: str,       # assigned UI color
        }
        """
        LAYER_COLORS = [
            '#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6',
            '#ec4899', '#06b6d4', '#f97316', '#6366f1', '#14b8a6',
        ]

        doc = pikepdf.Pdf.open(pdf_path)
        layers = []

        try:
            oc_props = doc.Root.get("/OCProperties")
            if not oc_props:
                logger.info("[LAYER DEBUG] No /OCProperties found in PDF")
                doc.close()
                return {"layers": [], "total": 0}

            logger.info(f"[LAYER DEBUG] /OCProperties keys: {list(oc_props.keys())}")

            # Dump all OCGs
            all_ocgs = oc_props.get("/OCGs", [])
            logger.info(f"[LAYER DEBUG] /OCGs count: {len(all_ocgs)}")
            for i, ocg_ref in enumerate(all_ocgs):
                try:
                    resolved = ocg_ref.resolve() if hasattr(ocg_ref, 'resolve') else ocg_ref
                    obj_num = ocg_ref.objgen[0] if hasattr(ocg_ref, 'objgen') else '?'
                    name = str(resolved.get("/Name", "???"))
                    logger.info(f"[LAYER DEBUG]   OCG[{i}]: objnum={obj_num}, name='{name}'")
                except Exception as e:
                    logger.info(f"[LAYER DEBUG]   OCG[{i}]: PARSE ERROR: {e}")

            d_dict = oc_props.get("/D", {})
            logger.info(f"[LAYER DEBUG] /D keys: {list(d_dict.keys()) if hasattr(d_dict, 'keys') else 'N/A'}")

            # Locked layer obj numbers
            locked_ids = set()
            for item in d_dict.get("/Locked", []):
                try:
                    locked_ids.add(item.objgen[0] if hasattr(item, 'objgen') else int(item))
                except Exception:
                    pass

            # OFF layer obj numbers
            off_objnums = set()
            for item in d_dict.get("/OFF", []):
                try:
                    off_objnums.add(item.objgen[0] if hasattr(item, 'objgen') else int(item))
                except Exception:
                    pass

            logger.info(f"[LAYER DEBUG] locked_ids={locked_ids}, off_objnums={off_objnums}")

            # Try hierarchical /D/Order first
            order = d_dict.get("/Order")
            if order and len(order) > 0:
                logger.info(f"[LAYER DEBUG] /D/Order found, length={len(order)}")
                for i, item in enumerate(order):
                    item_type = type(item).__name__
                    try:
                        if hasattr(item, 'objgen'):
                            resolved = item.resolve() if hasattr(item, 'resolve') else item
                            logger.info(f"[LAYER DEBUG]   Order[{i}]: type={item_type}, objnum={item.objgen[0]}, name='{resolved.get('/Name', '?')}'")
                        elif isinstance(item, (list, pikepdf.Array)):
                            logger.info(f"[LAYER DEBUG]   Order[{i}]: type=Array, length={len(item)}")
                        else:
                            logger.info(f"[LAYER DEBUG]   Order[{i}]: type={item_type}, value='{item}'")
                    except Exception as e:
                        logger.info(f"[LAYER DEBUG]   Order[{i}]: type={item_type}, ERROR: {e}")
                layers = self._parse_order_tree(order, locked_ids, off_objnums, LAYER_COLORS, depth=0)
                
                # Supplement: add OCGs not present in /D/Order
                existing_ids = set()
                def _collect_ids(items):
                    for item in items:
                        if item.get('id', 0) > 0:
                            existing_ids.add(item['id'])
                        if item.get('children'):
                            _collect_ids(item['children'])
                _collect_ids(layers)
                
                all_ocgs_flat = oc_props.get("/OCGs", [])
                color_idx = len(existing_ids)
                for ocg_ref in all_ocgs_flat:
                    try:
                        obj_num = ocg_ref.objgen[0] if hasattr(ocg_ref, 'objgen') else None
                        if obj_num and obj_num not in existing_ids:
                            resolved = ocg_ref.resolve() if hasattr(ocg_ref, 'resolve') else ocg_ref
                            name = str(resolved.get("/Name", f"Layer {obj_num}"))
                            layers.append({
                                "id": obj_num,
                                "name": name,
                                "visible": obj_num not in off_objnums,
                                "locked": obj_num in locked_ids,
                                "depth": 0,
                                "children": [],
                                "color": LAYER_COLORS[color_idx % len(LAYER_COLORS)],
                            })
                            logger.info(f"[LAYER DEBUG]   Added missing OCG: objnum={obj_num}, name='{name}'")
                            existing_ids.add(obj_num)
                            color_idx += 1
                    except Exception:
                        pass
            else:
                logger.info("[LAYER DEBUG] No /D/Order, using flat /OCGs list")
                # Flat list from /OCGs
                ocgs = oc_props.get("/OCGs", [])
                for i, ocg_ref in enumerate(ocgs):
                    try:
                        ocg_obj = ocg_ref.resolve() if hasattr(ocg_ref, 'resolve') else ocg_ref
                        obj_num = ocg_ref.objgen[0] if hasattr(ocg_ref, 'objgen') else i
                        name = str(ocg_obj.get("/Name", f"Layer {i}"))

                        layers.append({
                            "id": obj_num,
                            "name": name,
                            "visible": obj_num not in off_objnums,
                            "locked": obj_num in locked_ids,
                            "depth": 0,
                            "children": [],
                            "color": LAYER_COLORS[i % len(LAYER_COLORS)],
                        })
                    except Exception as e:
                        logger.debug(f"Failed to parse OCG #{i}: {e}")

            # We do NOT deduplicate layer names in the UI anymore to avoid confusing the user.
            # The actual PDF has exact duplicate names (like Marks_Model_) and appending #1, #2 
            # in the UI makes the user think the PDF is altered and will fail machine parsing.
            logger.info(f"[LAYER DEBUG] Final layers count: {len(layers)}")
            for l in layers:
                logger.info(f"[LAYER DEBUG]   Layer: id={l['id']}, name='{l['name']}', children={len(l.get('children', []))}")
        except Exception as e:
            logger.warning(f"OCG parsing failed: {e}")

        # Enrich layers with object counts from content streams
        try:
            self._enrich_layers_with_objects(doc, layers)
        except Exception as e:
            logger.debug(f"Object enrichment failed (non-fatal): {e}")

        # Create virtual layers for pages WITHOUT OCG content (print pages)
        try:
            self._add_virtual_page_layers(doc, layers)
        except Exception as e:
            logger.debug(f"Virtual page layers failed (non-fatal): {e}")
        # Post-process: parse pipe-encoded names, rename items, nest groups
        try:
            self._post_process_layer_groups(layers)
        except Exception as e:
            logger.debug(f"Layer group post-processing failed (non-fatal): {e}")

        doc.close()
        return {"layers": layers, "total": len(layers)}

    def _post_process_layer_groups(self, layers):
        """
        Post-process layer tree:
        1. Parse pipe-encoded names: 'MarkLine|MKLINE' → display='MarkLine', itemPrefix='MKLINE'
        2. Rename objects using item prefix
        3. Nest sub-group layers under parent layers (same page)
        """
        # Step 1 & 2: Parse pipe names and rename objects
        pipe_layers = []  # layers with pipe-encoded names (sub-groups)
        for layer in layers:
            name = layer.get('name', '')
            if '|' in name:
                parts = name.split('|', 1)
                display_name = parts[0]
                item_prefix = parts[1]
                layer['name'] = display_name
                layer['_item_prefix'] = item_prefix
                layer['_is_subgroup'] = True
                pipe_layers.append(layer)

                # Rename objects
                for i, obj in enumerate(layer.get('objects', [])):
                    obj['name'] = f'{item_prefix} #{i + 1}'

                # Also rename objects in children (page sub-layers)
                for child in layer.get('children', []):
                    for i, obj in enumerate(child.get('objects', [])):
                        obj['name'] = f'{item_prefix} #{i + 1}'

        if not pipe_layers:
            return

        # Step 3: Nest sub-group layers under parent layers on the same page
        # A sub-group (e.g. MarkLine) should be nested under a parent layer
        # (e.g. Marks_Model_) if they share the same page
        def _get_pages(layer):
            """Get all page numbers referenced by this layer."""
            pages = set()
            if layer.get('pageNum'):
                pages.add(layer['pageNum'])
            for obj in layer.get('objects', []):
                if obj.get('page'):
                    pages.add(obj['page'])
            for child in layer.get('children', []):
                pages.update(_get_pages(child))
            return pages

        for sub in pipe_layers:
            sub_pages = _get_pages(sub)
            if not sub_pages:
                continue

            # Find the best parent: a non-subgroup layer sharing the same page(s)
            best_parent = None
            for layer in layers:
                if layer is sub:
                    continue
                if layer.get('_is_subgroup'):
                    continue
                parent_pages = _get_pages(layer)
                if parent_pages & sub_pages:  # overlapping pages
                    best_parent = layer
                    break

            if best_parent:
                # Move sub-group as child of parent
                if sub in layers:
                    layers.remove(sub)
                # Clean up internal flags
                sub.pop('_is_subgroup', None)
                sub.pop('_item_prefix', None)
                sub['isGroup'] = True
                best_parent.setdefault('children', []).append(sub)
                logger.info(f"[LAYER DEBUG] Nested '{sub['name']}' under '{best_parent['name']}'")

        # Clean up flags from remaining layers
        for layer in layers:
            layer.pop('_is_subgroup', None)
            layer.pop('_item_prefix', None)


    def _enrich_layers_with_objects(self, doc, layers):
        """
        Scan page content streams to find objects tagged with each OCG.
        Creates per-page sub-layers under each OCG layer.
        """
        # Build mapping: OCG obj_num -> layer dict
        layer_map = {}
        def _flatten(items):
            for item in items:
                if item.get('id', 0) > 0:
                    layer_map[item['id']] = item
                    item.setdefault('objects', [])
                    item.setdefault('children', [])
                if item.get('children'):
                    _flatten(item['children'])
        _flatten(layers)

        logger.info(f"[LAYER DEBUG] _enrich: layer_map has {len(layer_map)} layers: {list(layer_map.keys())}")

        if not layer_map:
            return

        # Track per-page objects for each OCG: {ocg_id: {page_num: [objects]}}
        page_objects = {}  # ocg_id -> {page_num -> [objects]}

        # Process each page
        for page_idx, page in enumerate(doc.pages):
            props_map = {}
            resources = page.get("/Resources", {})
            properties = resources.get("/Properties", {})

            for prop_name, prop_ref in properties.items():
                try:
                    prop_obj = prop_ref.resolve() if hasattr(prop_ref, 'resolve') else prop_ref
                    if not isinstance(prop_obj, pikepdf.Dictionary):
                        continue
                    ocg_type = prop_obj.get("/Type")
                    if ocg_type and str(ocg_type) == "/OCG":
                        obj_num = prop_ref.objgen[0] if hasattr(prop_ref, 'objgen') else None
                        if obj_num and obj_num in layer_map:
                            props_map[prop_name] = obj_num
                    ocmd_type = prop_obj.get("/Type")
                    if ocmd_type and str(ocmd_type) == "/OCMD":
                        ocgs_ref = prop_obj.get("/OCGs")
                        if ocgs_ref:
                            if isinstance(ocgs_ref, pikepdf.Array):
                                for ref in ocgs_ref:
                                    on = ref.objgen[0] if hasattr(ref, 'objgen') else None
                                    if on and on in layer_map:
                                        props_map[prop_name] = on
                                        break
                            elif hasattr(ocgs_ref, 'objgen'):
                                on = ocgs_ref.objgen[0]
                                if on in layer_map:
                                    props_map[prop_name] = on
                except Exception:
                    continue

            if not props_map:
                continue

            # Create a temporary layer_map for this page to collect objects
            page_layer_map = {}
            for ocg_id in set(props_map.values()):
                if ocg_id not in page_objects:
                    page_objects[ocg_id] = {}
                page_objects[ocg_id][page_idx + 1] = []
                page_layer_map[ocg_id] = {'objects': page_objects[ocg_id][page_idx + 1]}

            try:
                content_bytes = self._get_page_content(page)
                if not content_bytes:
                    continue
                self._parse_content_for_objects(
                    content_bytes, props_map, page_layer_map, page_idx + 1
                )
            except Exception as e:
                logger.debug(f"Content parse error page {page_idx+1}: {e}")

        # Now create per-page children under each OCG layer
        for ocg_id, pages_data in page_objects.items():
            parent = layer_map[ocg_id]
            parent['objects'] = []
            
            sorted_pages = sorted(pg for pg in pages_data.keys() if pages_data[pg])
            
            # If only 1 page with content, show objects flat on parent (no sub-layer)
            if len(sorted_pages) <= 1:
                if sorted_pages:
                    parent['objects'] = pages_data[sorted_pages[0]]
                logger.info(f"[LAYER DEBUG] _enrich: Layer {ocg_id} '{parent['name']}': 1 page, {len(parent.get('objects', []))} objects flat")
                continue
            
            for pg in sorted_pages:
                objs = pages_data[pg]
                if not objs:
                    continue
                child = {
                    'id': ocg_id * 10000 + pg,  # Synthetic unique ID
                    'name': f'Page {pg}',
                    'visible': True,
                    'locked': False,
                    'isGroup': False,
                    'isPageLayer': True,
                    'parentOcgId': ocg_id,
                    'pageNum': pg,
                    'color': parent.get('color'),
                    'children': [],
                    'objects': objs,
                }
                parent['children'].append(child)
            
            total_objs = sum(len(pages_data[pg]) for pg in sorted_pages)
            logger.info(f"[LAYER DEBUG] _enrich: Layer {ocg_id} '{parent['name']}': {len(sorted_pages)} page-layers, {total_objs} total objects")

    def _add_virtual_page_layers(self, doc, layers):
        """
        For pages with NO OCG content (print artwork pages),
        parse their content stream and create virtual layers with real objects.
        """
        import re

        pages_with_ocg = set()
        def _collect_pages(items):
            for item in items:
                if item.get('isPageLayer') and item.get('pageNum'):
                    pages_with_ocg.add(item['pageNum'])
                for obj in item.get('objects', []):
                    if obj.get('page'):
                        pages_with_ocg.add(obj['page'])
                if item.get('children'):
                    _collect_pages(item['children'])
        _collect_pages(layers)

        total_pages = len(doc.pages)
        print_page_counter = 0

        for page_idx in range(total_pages):
            page_num = page_idx + 1
            if page_num in pages_with_ocg:
                continue

            content_bytes = self._get_page_content(doc.pages[page_idx])
            if not content_bytes or len(content_bytes) < 10:
                continue

            print_page_counter += 1

            # Parse content to find objects (XObjects, paths, text)
            text = content_bytes.decode('latin-1', errors='replace')
            tokens = re.findall(r'/[A-Za-z0-9_.]+|[A-Za-z*\'\"]+|\([^)]*\)|<[^>]*>|[-+]?[0-9]*\.?[0-9]+', text)

            objects = []
            obj_idx = 0
            vertices = 0
            curves = 0
            has_rect = False
            color = None

            for ti, token in enumerate(tokens):
                # XObject placement (artwork copy)
                if token == 'Do' and ti > 0 and tokens[ti-1].startswith('/'):
                    obj_idx += 1
                    xobj_name = tokens[ti-1].lstrip('/')
                    objects.append({
                        'type': 'xobject',
                        'name': f'{xobj_name} #{obj_idx}',
                        'page': page_num,
                        'color': color,
                    })
                    vertices = 0
                    curves = 0
                    has_rect = False

                # Path construction
                elif token == 'm':
                    vertices += 1
                elif token == 'l':
                    vertices += 1
                elif token == 'c':
                    curves += 1
                elif token == 're':
                    has_rect = True

                # Path stroke/fill — flush current path as object
                elif token in ('f', 'F', 'S', 'B', 'b', 's'):
                    obj_idx += 1
                    if has_rect:
                        name = 'Rectangle'
                    elif curves > 0 and vertices <= 2:
                        name = 'Ellipse' if curves == 4 else 'Curve'
                    elif vertices == 2:
                        name = 'Line'
                    elif vertices == 3:
                        name = 'Triangle'
                    elif vertices > 3:
                        name = f'Polygon ({vertices})'
                    else:
                        name = 'Path'
                    objects.append({
                        'type': 'path',
                        'name': f'{name} #{obj_idx}',
                        'page': page_num,
                        'color': color,
                    })
                    vertices = 0
                    curves = 0
                    has_rect = False

                # Color tracking
                elif token in ('rg', 'RG') and ti >= 3:
                    try:
                        r, g, b = float(tokens[ti-3]), float(tokens[ti-2]), float(tokens[ti-1])
                        color = f'rgb({int(r*255)},{int(g*255)},{int(b*255)})'
                    except (ValueError, IndexError):
                        pass

                # Limit objects
                if len(objects) >= 100:
                    break

            virtual_layer = {
                'id': -(page_num),
                'name': f'print_page_{print_page_counter}',
                'visible': True,
                'locked': False,
                'isGroup': False,
                'isVirtual': True,
                'pageNum': page_num,
                'color': None,
                'children': [],
                'objects': objects if objects else [{'type': 'page', 'name': 'Artwork', 'page': page_num, 'color': None}],
            }
            layers.insert(0, virtual_layer)

        if print_page_counter:
            logger.info(f"[LAYER DEBUG] Added {print_page_counter} virtual print_page layers")

    def _get_page_content(self, page):
        """Extract raw content bytes from a page."""
        contents = page.get("/Contents")
        if contents is None:
            return b""
        
        if isinstance(contents, pikepdf.Array):
            parts = []
            for stream_ref in contents:
                try:
                    stream = stream_ref.resolve() if hasattr(stream_ref, 'resolve') else stream_ref
                    parts.append(bytes(stream.read_bytes()))
                except Exception:
                    pass
            return b"\n".join(parts)
        else:
            try:
                stream = contents.resolve() if hasattr(contents, 'resolve') else contents
                return bytes(stream.read_bytes())
            except Exception:
                return b""

    def _parse_content_for_objects(self, content_bytes, props_map, layer_map, page_num):
        """
        Parse content stream: group each BDC…EMC block as a single 'object'.
        Analyze path commands to determine shape type (like Illustrator).
        """
        import re

        text = content_bytes.decode('latin-1', errors='replace')

        # Tokenize
        tokens = re.findall(r'/[A-Za-z0-9_.]+|[A-Za-z*\'\"]+|\([^)]*\)|<[^>]*>|[-+]?[0-9]*\.?[0-9]+', text)

        ocg_stack = []
        current_ocg = None
        # Track operations inside the current BDC..EMC block
        block_ops = []       # list of operator tokens
        block_vertices = 0   # count of m/l moves for polygon detection
        block_curves = 0     # count of curve segments (c operator)
        block_has_rect = False
        block_has_do = False
        block_do_name = None
        block_has_text = False
        block_text_content = None
        block_has_clip = False
        block_color = None   # last color set in block
        block_counter = {}   # ocg_id -> sequential counter
        block_custom_name = None

        def _classify_block():
            """Determine the shape type from accumulated block data."""
            if block_custom_name:
                return 'path', block_custom_name
            if block_has_do:
                return 'xobject', block_do_name or 'Image'
            if block_has_text:
                return 'text', block_text_content or 'Text'
            if block_has_clip:
                return 'clip', 'Clipping Mask'
            if block_has_rect:
                return 'path', 'Rectangle'

            # Analyze path geometry
            if block_vertices > 0 or block_curves > 0:
                if block_curves > 0 and block_vertices <= 2:
                    # Mostly curves: likely circle/ellipse
                    if block_curves == 4:
                        return 'path', 'Ellipse'
                    elif block_curves >= 6:
                        return 'path', 'Complex Curve'
                    else:
                        return 'path', 'Curve'
                elif block_vertices == 2:
                    return 'path', 'Line'
                elif block_vertices == 3:
                    return 'path', 'Triangle'
                elif block_vertices == 4:
                    return 'path', 'Diamond' if block_curves == 0 else 'Quadrilateral'
                elif block_vertices == 5:
                    return 'path', 'Pentagon'
                elif block_vertices == 6:
                    if block_curves == 0:
                        return 'path', 'Hexagon'
                    else:
                        return 'path', 'Star'
                elif block_vertices == 7:
                    return 'path', 'Heptagon'
                elif block_vertices == 8:
                    return 'path', 'Octagon'
                elif block_vertices == 10:
                    return 'path', 'Star (5-pointed)'
                elif block_vertices == 12:
                    return 'path', 'Star (6-pointed)'
                elif block_vertices > 8:
                    if block_curves > 0:
                        return 'path', f'Complex Shape'
                    else:
                        return 'path', f'Polygon ({block_vertices} sides)'

            if any(op in ('S', 'f', 'F', 'B', 'b') for op in block_ops):
                return 'path', 'Path'

            return 'path', 'Path'

        def _flush_block():
            """Save the accumulated block as a single object."""
            nonlocal block_ops, block_vertices, block_curves
            nonlocal block_has_rect, block_has_do, block_do_name
            nonlocal block_has_text, block_text_content, block_has_clip, block_color
            nonlocal block_custom_name

            if not current_ocg or current_ocg not in layer_map:
                return
            if not block_ops:
                return

            obj_type, obj_name = _classify_block()

            # Sequential counter per OCG
            if current_ocg not in block_counter:
                block_counter[current_ocg] = 0
            block_counter[current_ocg] += 1
            idx = block_counter[current_ocg]

            # Color info
            color_str = None
            if block_color:
                color_str = block_color

            final_name = obj_name if block_custom_name else f'{obj_name} #{idx}'

            # Add to layer (limit to 100 per layer)
            if idx <= 100:
                layer_map[current_ocg]['objects'].append({
                    'type': obj_type,
                    'name': final_name,
                    'page': page_num,
                    'color': color_str,
                })

            # Reset block state
            block_ops = []
            block_vertices = 0
            block_curves = 0
            block_has_rect = False
            block_has_do = False
            block_do_name = None
            block_has_text = False
            block_text_content = None
            block_has_clip = False
            block_custom_name = None

        i = 0
        while i < len(tokens):
            token = tokens[i]

            # BDC/BMC: start of marked content block
            if token in ('BDC', 'BMC'):
                matched = False
                for j in range(max(0, i-3), i):
                    prev = tokens[j]
                    if prev.startswith('/NM_'):
                        block_custom_name = prev[4:]
                    elif prev.startswith('/'):
                        for prop_name, ocg_num in props_map.items():
                            prop_str = str(prop_name)
                            if prev == prop_str or prev.lstrip('/') == prop_str.lstrip('/'):
                                # Flush any pending block before starting new one
                                _flush_block()
                                ocg_stack.append(ocg_num)
                                current_ocg = ocg_num
                                matched = True
                                break
                        if matched:
                            break

            # EMC: end of marked content block
            elif token == 'EMC':
                _flush_block()
                if ocg_stack:
                    ocg_stack.pop()
                    current_ocg = ocg_stack[-1] if ocg_stack else None

            # Inside an OCG block: accumulate operations
            elif current_ocg and current_ocg in layer_map:
                block_ops.append(token)

                # Path construction
                if token == 'm':
                    block_vertices += 1
                elif token == 'l':
                    block_vertices += 1
                elif token == 'c':
                    block_curves += 1
                elif token == 're':
                    block_has_rect = True

                # XObject
                elif token == 'Do':
                    block_has_do = True
                    if i > 0 and tokens[i-1].startswith('/'):
                        block_do_name = tokens[i-1].lstrip('/')

                # Text
                elif token in ('Tj', 'TJ', "'", '"'):
                    block_has_text = True
                    if i > 0:
                        prev = tokens[i-1]
                        if prev.startswith('(') and prev.endswith(')'):
                            block_text_content = prev[1:-1][:30]

                # Clipping
                elif token in ('W', 'W*'):
                    block_has_clip = True

                # Color tracking
                elif token in ('rg', 'RG'):
                    # RGB color: 3 numbers before
                    if i >= 3:
                        try:
                            r, g, b = float(tokens[i-3]), float(tokens[i-2]), float(tokens[i-1])
                            block_color = f'rgb({int(r*255)},{int(g*255)},{int(b*255)})'
                        except (ValueError, IndexError):
                            pass
                elif token in ('k', 'K'):
                    # CMYK
                    if i >= 4:
                        try:
                            c_, m_, y_, k_ = float(tokens[i-4]), float(tokens[i-3]), float(tokens[i-2]), float(tokens[i-1])
                            block_color = f'cmyk({int(c_*100)}%,{int(m_*100)}%,{int(y_*100)}%,{int(k_*100)}%)'
                        except (ValueError, IndexError):
                            pass

            i += 1

        # Final flush
        _flush_block()

        # Log summary
        for ocg_id in block_counter:
            logger.info(f"[LAYER DEBUG] _parse: Page {page_num}, OCG {ocg_id}: {block_counter[ocg_id]} objects")

    def _parse_order_tree(self, order_arr, locked_ids, off_objnums, colors, depth=0, counter=None):
        """Recursively parse /D/Order array into nested layer tree."""
        if counter is None:
            counter = [0]

        layers = []
        i = 0
        while i < len(order_arr):
            item = order_arr[i]

            # OCG reference
            if hasattr(item, 'objgen') or (hasattr(item, 'resolve') and not isinstance(item, (str, pikepdf.String, pikepdf.Name))):
                try:
                    resolved = item.resolve() if hasattr(item, 'resolve') else item
                    obj_num = item.objgen[0] if hasattr(item, 'objgen') else counter[0]
                    name = str(resolved.get("/Name", f"Layer {counter[0]}"))

                    layer = {
                        "id": obj_num,
                        "name": name,
                        "visible": obj_num not in off_objnums,
                        "locked": obj_num in locked_ids,
                        "depth": depth,
                        "children": [],
                        "color": colors[counter[0] % len(colors)],
                    }

                    # Check if next item is nested children array
                    if i + 1 < len(order_arr) and isinstance(order_arr[i + 1], (list, pikepdf.Array)):
                        layer["children"] = self._parse_order_tree(
                            order_arr[i + 1], locked_ids, off_objnums, colors, depth + 1, counter
                        )
                        i += 1

                    layers.append(layer)
                    counter[0] += 1
                except Exception as e:
                    logger.debug(f"Failed to parse Order item: {e}")

            # Nested array (group children)
            elif isinstance(item, (list, pikepdf.Array)):
                children = self._parse_order_tree(
                    item, locked_ids, off_objnums, colors, depth + 1, counter
                )
                layers.extend(children)

            # String label (group header)
            elif isinstance(item, (str, pikepdf.String, pikepdf.Name)):
                label = str(item)
                group_layer = {
                    "id": -1 * (counter[0] + 1000),
                    "name": label,
                    "visible": True,
                    "locked": False,
                    "depth": depth,
                    "children": [],
                    "color": colors[counter[0] % len(colors)],
                    "isGroup": True,
                }
                if i + 1 < len(order_arr) and isinstance(order_arr[i + 1], (list, pikepdf.Array)):
                    group_layer["children"] = self._parse_order_tree(
                        order_arr[i + 1], locked_ids, off_objnums, colors, depth + 1, counter
                    )
                    i += 1
                layers.append(group_layer)
                counter[0] += 1

            i += 1

        return layers

    # ─── RENDER ──────────────────────────────────────────────────

    def render_with_visibility(
        self,
        pdf_path: str,
        page: int,
        hidden_layer_ids: list[int],
        dpi: int = 200,
        hidden_object_keys: list[str] = None,
    ) -> str:
        """
        Render a page with specified OCG layers hidden and/or specific objects hidden.
        Returns base64-encoded JPEG image.

        hidden_object_keys: list of 'layerId-objectIndex' strings, e.g. ['4-2', '4-5']
        """
        doc = pikepdf.Pdf.open(pdf_path)

        if page < 1 or page > len(doc.pages):
            doc.close()
            raise ValueError(f"Page {page} out of range (1-{len(doc.pages)})")

        oc_props = doc.Root.get("/OCProperties")
        if oc_props:
            d_dict = oc_props.get("/D")
            if not d_dict:
                d_dict = pikepdf.Dictionary()
                oc_props["/D"] = d_dict

            ocgs = list(oc_props.get("/OCGs", []))

            # Build new /OFF array from hidden_layer_ids (only positive = real OCG IDs)
            new_off = []
            for ocg_ref in ocgs:
                try:
                    obj_num = ocg_ref.objgen[0] if hasattr(ocg_ref, 'objgen') else -1
                    if obj_num in hidden_layer_ids:
                        new_off.append(ocg_ref)
                except Exception:
                    pass

            d_dict["/OFF"] = pikepdf.Array(new_off)
            d_dict["/BaseState"] = pikepdf.Name("/ON")

        # Handle VIRTUAL layer hiding (negative IDs = page number)
        # Virtual layers = pages without OCG. Hiding = blank that page
        for lid in hidden_layer_ids:
            if lid < 0:
                virtual_page_num = -lid  # negative ID maps to page number
                if 1 <= virtual_page_num <= len(doc.pages):
                    target_page = doc.pages[virtual_page_num - 1]
                    # Clear page content to hide it
                    target_page["/Contents"] = doc.make_stream(b"")
                    logger.info(f"[LAYER DEBUG] Blanked virtual page {virtual_page_num}")

        # Handle per-object hiding by stripping specific BDC...EMC blocks
        if hidden_object_keys:
            self._strip_hidden_objects(doc, page, hidden_object_keys)

        # Save to temp file and render
        tmp_fd, tmp_path = tempfile.mkstemp(suffix='.pdf')
        os.close(tmp_fd)
        try:
            doc.save(tmp_path)
            doc.close()

            pdf_render = pdfium.PdfDocument(tmp_path)
            if page < 1 or page > len(pdf_render):
                pdf_render.close()
                raise ValueError(f"Page {page} out of range")

            p = pdf_render[page - 1]
            scale = dpi / 72
            bitmap = p.render(scale=scale)
            img = bitmap.to_pil()
            pdf_render.close()

            buf = io.BytesIO()
            img.save(buf, format='JPEG', quality=92)
            b64 = base64.b64encode(buf.getvalue()).decode('utf-8')

            return f"data:image/jpeg;base64,{b64}"
        finally:
            try:
                os.unlink(tmp_path)
            except OSError as _e:
                logger.debug("Không xoá được temp %s: %s", tmp_path, _e)

    def _strip_hidden_objects(self, doc, page_num: int, hidden_object_keys: list[str]):
        """
        Strip specific BDC...EMC blocks from the content stream of a page.
        hidden_object_keys: ['layerId-objectIndex', ...] where objectIndex is 0-based.
        """
        import re

        # Parse keys: group by page (objects have page info, but we process page_num)
        # Keys format: 'layerId-objectIndex' — we need to find which OCG block index to strip
        if not hidden_object_keys:
            return

        # Build set of (layer_id, object_index_0based) to hide
        hide_set = set()
        for key in hidden_object_keys:
            # Use rsplit to handle negative IDs: e.g. "-1-0" → ("-1", "0")
            parts = key.rsplit('-', 1)
            if len(parts) == 2:
                try:
                    hide_set.add((int(parts[0]), int(parts[1])))
                except ValueError:
                    continue

        if not hide_set:
            return

        # Get page's Properties mapping
        pg = doc.pages[page_num - 1]
        resources = pg.get("/Resources", {})
        properties = resources.get("/Properties", {})

        props_map = {}  # prop_name -> ocg_obj_num
        for prop_name, prop_ref in properties.items():
            try:
                prop_obj = prop_ref.resolve() if hasattr(prop_ref, 'resolve') else prop_ref
                if isinstance(prop_obj, pikepdf.Dictionary):
                    if str(prop_obj.get("/Type", "")) == "/OCG":
                        obj_num = prop_ref.objgen[0] if hasattr(prop_ref, 'objgen') else None
                        if obj_num:
                            props_map[str(prop_name)] = obj_num
            except Exception:
                continue

        if not props_map:
            # Check if there are virtual layer objects to hide (negative layer IDs)
            virtual_hide = {(lid, idx) for lid, idx in hide_set if lid < 0}
            if virtual_hide:
                self._strip_virtual_objects(doc, page_num, virtual_hide)
            return

        # Also handle virtual layer objects alongside OCG objects
        virtual_hide = {(lid, idx) for lid, idx in hide_set if lid < 0}
        if virtual_hide:
            self._strip_virtual_objects(doc, page_num, virtual_hide)

        # Get content bytes
        content_bytes = self._get_page_content(pg)
        if not content_bytes:
            return

        text = content_bytes.decode('latin-1', errors='replace')

        # Find all BDC...EMC block positions and their OCG association
        # Track block counter per OCG to match object indices
        block_counter = {}  # ocg_id -> count
        blocks_to_remove = []  # list of (start_pos, end_pos) to remove

        # Use regex to find BDC and EMC positions
        bdc_pattern = re.compile(r'/OC\s+(/\w+)\s+BDC')
        emc_pattern = re.compile(r'\bEMC\b')

        pos = 0
        while pos < len(text):
            bdc_match = bdc_pattern.search(text, pos)
            if not bdc_match:
                break

            prop_name = bdc_match.group(1)
            bdc_start = bdc_match.start()

            # Find matching EMC
            emc_match = emc_pattern.search(text, bdc_match.end())
            if not emc_match:
                break

            emc_end = emc_match.end()

            # Check if this property maps to a known OCG
            ocg_id = props_map.get(prop_name)
            if ocg_id is not None:
                if ocg_id not in block_counter:
                    block_counter[ocg_id] = 0
                obj_idx = block_counter[ocg_id]
                block_counter[ocg_id] += 1

                if (ocg_id, obj_idx) in hide_set:
                    blocks_to_remove.append((bdc_start, emc_end))

            pos = emc_end

        if not blocks_to_remove:
            return

        # Remove blocks from content (reverse order to preserve positions)
        new_text = text
        for start, end in reversed(blocks_to_remove):
            new_text = new_text[:start] + new_text[end:]

        # Write back modified content
        new_bytes = new_text.encode('latin-1', errors='replace')
        pg["/Contents"] = doc.make_stream(new_bytes)
        logger.info(f"[LAYER DEBUG] Stripped {len(blocks_to_remove)} objects from page {page_num}")

    def _strip_virtual_objects(self, doc, page_num: int, virtual_hide: set):
        """
        Strip specific objects from non-OCG (virtual) pages.
        virtual_hide: set of (layer_id, object_index) where layer_id is negative (-pageNum).
        
        Objects are identified the same way as in _add_virtual_page_layers:
        - XObject `Do` → one object each
        - Path stroke/fill (f/F/S/B/b/s) → one object each
        """
        import re

        # Find which page this applies to: layer_id = -(page_num)
        target_pages = {}  # actual_page_num -> set of object indices to hide
        for lid, idx in virtual_hide:
            pg_num = -lid
            if pg_num not in target_pages:
                target_pages[pg_num] = set()
            target_pages[pg_num].add(idx)

        for pg_num, hide_indices in target_pages.items():
            if pg_num < 1 or pg_num > len(doc.pages):
                continue

            pg = doc.pages[pg_num - 1]
            content_bytes = self._get_page_content(pg)
            if not content_bytes:
                continue

            text = content_bytes.decode('latin-1', errors='replace')

            # Find all q...Q blocks and classify them as objects using the same
            # logic as _add_virtual_page_layers parsing
            # Strategy: find top-level q...Q blocks that contain Do or path ops
            blocks = []  # list of (start, end, obj_index)
            obj_idx = -1  # will be incremented to 0 for first object

            # Parse by finding q/Q pairs at the top nesting level
            depth = 0
            block_start = -1
            has_do = False
            has_path = False
            i = 0
            tokens = re.findall(r'/[A-Za-z0-9_.]+|[A-Za-z*\'\"]+|\([^)]*\)|<[^>]*>|[-+]?[0-9]*\.?[0-9]+', text)
            
            # Also track character positions for each token
            token_positions = []
            search_from = 0
            for t in tokens:
                pos = text.find(t, search_from)
                token_positions.append(pos)
                search_from = pos + len(t)

            for ti, token in enumerate(tokens):
                if token == 'q':
                    if depth == 0:
                        block_start = token_positions[ti]
                        has_do = False
                        has_path = False
                    depth += 1
                elif token == 'Q':
                    depth -= 1
                    if depth == 0 and block_start >= 0:
                        block_end = token_positions[ti] + 1
                        if has_do or has_path:
                            obj_idx += 1
                            if obj_idx in hide_indices:
                                blocks.append((block_start, block_end))
                        block_start = -1
                elif depth >= 1:
                    if token == 'Do':
                        has_do = True
                    elif token in ('f', 'F', 'S', 'B', 'b', 's'):
                        has_path = True

            if not blocks:
                logger.info(f"[LAYER DEBUG] _strip_virtual: page {pg_num}, no blocks matched for indices {hide_indices}")
                continue

            # Remove blocks (reverse order)
            new_text = text
            for start, end in reversed(blocks):
                new_text = new_text[:start] + new_text[end:]

            new_bytes = new_text.encode('latin-1', errors='replace')
            pg["/Contents"] = doc.make_stream(new_bytes)
            logger.info(f"[LAYER DEBUG] _strip_virtual: page {pg_num}, stripped {len(blocks)} virtual objects")

    # ─── RENAME ──────────────────────────────────────────────────

    def rename_layer(self, pdf_path: str, layer_id: int, new_name: str) -> str:
        """Rename an OCG layer. Returns output file path."""
        doc = pikepdf.Pdf.open(pdf_path)

        oc_props = doc.Root.get("/OCProperties")
        if not oc_props:
            doc.close()
            raise ValueError("PDF has no OCG layers")

        ocgs = oc_props.get("/OCGs", [])
        renamed = False

        for ocg_ref in ocgs:
            try:
                obj_num = ocg_ref.objgen[0] if hasattr(ocg_ref, 'objgen') else -1
                if obj_num == layer_id:
                    ocg_obj = ocg_ref.resolve() if hasattr(ocg_ref, 'resolve') else ocg_ref
                    ocg_obj["/Name"] = pikepdf.String(new_name)
                    renamed = True
                    break
            except Exception:
                pass

        if not renamed:
            doc.close()
            raise ValueError(f"Layer ID {layer_id} not found")

        output_path = self._save_output(doc, pdf_path, "renamed")
        doc.close()
        return output_path

    # ─── LOCK/UNLOCK ─────────────────────────────────────────────

    def toggle_lock(self, pdf_path: str, layer_id: int, locked: bool) -> str:
        """Toggle lock state of an OCG layer. Returns output file path."""
        doc = pikepdf.Pdf.open(pdf_path)

        oc_props = doc.Root.get("/OCProperties")
        if not oc_props:
            doc.close()
            raise ValueError("PDF has no OCG layers")

        d_dict = oc_props.get("/D")
        if not d_dict:
            d_dict = pikepdf.Dictionary()
            oc_props["/D"] = d_dict

        locked_arr = list(d_dict.get("/Locked", []))

        # Find OCG reference
        ocgs = oc_props.get("/OCGs", [])
        target_ref = None
        for ocg_ref in ocgs:
            try:
                obj_num = ocg_ref.objgen[0] if hasattr(ocg_ref, 'objgen') else -1
                if obj_num == layer_id:
                    target_ref = ocg_ref
                    break
            except Exception:
                pass

        if target_ref is None:
            doc.close()
            raise ValueError(f"Layer ID {layer_id} not found")

        if locked:
            already = any(
                (hasattr(r, 'objgen') and r.objgen[0] == layer_id) for r in locked_arr
            )
            if not already:
                locked_arr.append(target_ref)
        else:
            locked_arr = [
                r for r in locked_arr
                if not (hasattr(r, 'objgen') and r.objgen[0] == layer_id)
            ]

        d_dict["/Locked"] = pikepdf.Array(locked_arr)

        output_path = self._save_output(doc, pdf_path, "locked")
        doc.close()
        return output_path

    # ─── VISIBILITY ──────────────────────────────────────────────

    def set_visibility(self, pdf_path: str, layer_id: int, visible: bool) -> str:
        """Persist visibility state of an OCG layer into the PDF."""
        doc = pikepdf.Pdf.open(pdf_path)

        oc_props = doc.Root.get("/OCProperties")
        if not oc_props:
            doc.close()
            raise ValueError("PDF has no OCG layers")

        d_dict = oc_props.get("/D")
        if not d_dict:
            d_dict = pikepdf.Dictionary()
            oc_props["/D"] = d_dict

        off_arr = list(d_dict.get("/OFF", []))

        ocgs = oc_props.get("/OCGs", [])
        target_ref = None
        for ocg_ref in ocgs:
            try:
                obj_num = ocg_ref.objgen[0] if hasattr(ocg_ref, 'objgen') else -1
                if obj_num == layer_id:
                    target_ref = ocg_ref
                    break
            except Exception:
                pass

        if target_ref is None:
            doc.close()
            raise ValueError(f"Layer ID {layer_id} not found")

        if not visible:
            already = any(
                (hasattr(r, 'objgen') and r.objgen[0] == layer_id) for r in off_arr
            )
            if not already:
                off_arr.append(target_ref)
        else:
            off_arr = [
                r for r in off_arr
                if not (hasattr(r, 'objgen') and r.objgen[0] == layer_id)
            ]

        d_dict["/OFF"] = pikepdf.Array(off_arr)

        output_path = self._save_output(doc, pdf_path, "visibility")
        doc.close()
        return output_path

    # ─── DELETE ───────────────────────────────────────────────────

    def delete_layer(self, pdf_path: str, layer_id: int) -> str:
        """
        Delete an OCG layer from the PDF structure.
        Removes from /OCGs, /D/Order, /D/OFF, /D/Locked.
        Content streams referencing this OCG become unconditional (always visible).
        """
        doc = pikepdf.Pdf.open(pdf_path)

        oc_props = doc.Root.get("/OCProperties")
        if not oc_props:
            doc.close()
            raise ValueError("PDF has no OCG layers")

        # 1. Remove from /OCGs
        ocgs = list(oc_props.get("/OCGs", []))
        new_ocgs = [
            ref for ref in ocgs
            if not (hasattr(ref, 'objgen') and ref.objgen[0] == layer_id)
        ]
        oc_props["/OCGs"] = pikepdf.Array(new_ocgs)

        # 2. Remove from /D/Order, /D/OFF, /D/Locked
        d_dict = oc_props.get("/D")
        if d_dict:
            order = d_dict.get("/Order")
            if order:
                d_dict["/Order"] = pikepdf.Array(
                    self._remove_from_order(order, layer_id)
                )

            for key in ("/OFF", "/Locked"):
                arr = d_dict.get(key, [])
                new_arr = [
                    r for r in arr
                    if not (hasattr(r, 'objgen') and r.objgen[0] == layer_id)
                ]
                if len(list(arr)) != len(new_arr):
                    d_dict[key] = pikepdf.Array(new_arr)

        # 3. Remove OCMDs referencing this OCG from page resources
        # (Optional Content Membership Dicts)
        for page in doc.pages:
            try:
                self._remove_ocg_from_page(page, layer_id)
            except Exception as e:
                logger.debug(f"OCG cleanup on page failed: {e}")

        output_path = self._save_output(doc, pdf_path, "layer_deleted")
        doc.close()
        return output_path

    def _remove_ocg_from_page(self, page, layer_id):
        """Remove OCG references from page's XObject properties."""
        resources = page.get("/Resources")
        if not resources:
            return
        
        # Check Properties dict for OCG references
        props = resources.get("/Properties")
        if props:
            keys_to_remove = []
            for key, val in props.items():
                try:
                    resolved = val.resolve() if hasattr(val, 'resolve') else val
                    if hasattr(resolved, 'get'):
                        ocg_ref = resolved.get("/OCGs")
                        if ocg_ref and hasattr(ocg_ref, 'objgen') and ocg_ref.objgen[0] == layer_id:
                            keys_to_remove.append(key)
                except Exception:
                    pass
            for key in keys_to_remove:
                del props[key]

    def _remove_from_order(self, order_arr, layer_id):
        """Recursively remove a layer from /D/Order array."""
        result = []
        for item in order_arr:
            if hasattr(item, 'objgen') and item.objgen[0] == layer_id:
                continue
            elif isinstance(item, (list, pikepdf.Array)):
                cleaned = self._remove_from_order(item, layer_id)
                if cleaned:
                    result.append(pikepdf.Array(cleaned))
            else:
                result.append(item)
        return result

    # ─── REORDER ─────────────────────────────────────────────────

    def reorder_layers(self, pdf_path: str, new_order: list[int]) -> str:
        """Reorder OCG layers. Returns output file path."""
        doc = pikepdf.Pdf.open(pdf_path)

        oc_props = doc.Root.get("/OCProperties")
        if not oc_props:
            doc.close()
            raise ValueError("PDF has no OCG layers")

        d_dict = oc_props.get("/D")
        if not d_dict:
            doc.close()
            raise ValueError("No /D dictionary in OCProperties")

        # Map obj_num → reference
        ocgs = list(oc_props.get("/OCGs", []))
        id_to_ref = {}
        for ref in ocgs:
            try:
                obj_num = ref.objgen[0] if hasattr(ref, 'objgen') else -1
                id_to_ref[obj_num] = ref
            except Exception:
                pass

        new_ocgs = []
        new_order_arr = []
        for lid in new_order:
            if lid in id_to_ref:
                new_ocgs.append(id_to_ref[lid])
                new_order_arr.append(id_to_ref[lid])

        # Append remaining
        for ref in ocgs:
            obj_num = ref.objgen[0] if hasattr(ref, 'objgen') else -1
            if obj_num not in new_order:
                new_ocgs.append(ref)
                new_order_arr.append(ref)

        oc_props["/OCGs"] = pikepdf.Array(new_ocgs)
        d_dict["/Order"] = pikepdf.Array(new_order_arr)

        output_path = self._save_output(doc, pdf_path, "reordered")
        doc.close()
        return output_path

    # ─── FLATTEN ─────────────────────────────────────────────────

    def flatten_visible(self, pdf_path: str) -> str:
        """
        Flatten all visible layers — renders each page to raster, removes OCG structure.
        Uses pypdfium2 for rendering (respects current /D/OFF state).
        """
        from app.config import settings

        output_dir = Path(settings.RESULTS_DIR) / "layer_output"
        output_dir.mkdir(parents=True, exist_ok=True)
        stem = Path(pdf_path).stem
        output_name = f"{stem}_flattened_{uuid.uuid4().hex[:6]}.pdf"
        output_path = str(output_dir / output_name)

        gs_path = settings.GHOSTSCRIPT_PATH

        # Use Ghostscript to flatten — it handles OCG correctly
        import subprocess
        gs_args = [
            gs_path, "-dBATCH", "-dNOPAUSE", "-dQUIET",
            "-sDEVICE=pdfwrite",
            f"-sOutputFile={output_path}",
            "-dPDFSETTINGS=/prepress",
            "-dFlattenOCGs",  # Key: flatten all OCG
            str(pdf_path),
        ]

        try:
            proc = subprocess.run(gs_args, capture_output=True, timeout=120)
            if proc.returncode != 0:
                # Fallback: render to raster via pypdfium2 + rebuild PDF
                logger.warning(f"GS flatten failed ({proc.returncode}), using raster fallback")
                return self._flatten_raster_fallback(pdf_path, output_path)
        except FileNotFoundError:
            logger.warning("Ghostscript not found, using raster fallback")
            return self._flatten_raster_fallback(pdf_path, output_path)

        return output_path

    def _flatten_raster_fallback(self, pdf_path: str, output_path: str) -> str:
        """Flatten by rendering each page to raster and rebuilding PDF."""
        from reportlab.lib.pagesizes import letter
        from reportlab.pdfgen import canvas as rl_canvas
        from PIL import Image

        pdf_render = pdfium.PdfDocument(pdf_path)
        pages_data = []

        for i in range(len(pdf_render)):
            p = pdf_render[i]
            # Get page dimensions in points
            w_pt = p.get_width()
            h_pt = p.get_height()
            # Render at 300 DPI
            scale = 300 / 72
            bitmap = p.render(scale=scale)
            img = bitmap.to_pil()
            pages_data.append({"img": img, "w": w_pt, "h": h_pt})

        pdf_render.close()

        # Build PDF from raster images using reportlab
        c = rl_canvas.Canvas(output_path)
        for pd in pages_data:
            c.setPageSize((pd["w"], pd["h"]))
            # Save image to temp
            tmp_img = tempfile.NamedTemporaryFile(suffix='.jpg', delete=False)
            pd["img"].save(tmp_img.name, format='JPEG', quality=95)
            c.drawImage(tmp_img.name, 0, 0, width=pd["w"], height=pd["h"])
            c.showPage()
            try:
                os.unlink(tmp_img.name)
            except Exception:
                pass

        c.save()
        return output_path

    # ─── HELPERS ─────────────────────────────────────────────────

    def _save_output(self, doc: pikepdf.Pdf, original_path: str, suffix: str) -> str:
        """Save modified PDF to output directory."""
        from app.config import settings
        output_dir = Path(settings.RESULTS_DIR) / "layer_output"
        output_dir.mkdir(parents=True, exist_ok=True)
        stem = Path(original_path).stem
        output_name = f"{stem}_{suffix}_{uuid.uuid4().hex[:6]}.pdf"
        output_path = str(output_dir / output_name)
        doc.save(output_path)
        return output_path
