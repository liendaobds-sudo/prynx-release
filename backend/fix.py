import os

filepath = 'd:/pdfcompare/backend/app/workers/nup_diecut.py'
with open(filepath, 'r', encoding='utf-8') as f:
    code = f.read()

old_code = '''            # Phase 1: Ti m-i mcc dy, tAm dx nh? nht sao cho tem gc + tem xoay 180A KHA"NG giao nhau
            candidates = []
            dy_range = np.arange(-bh + step, bh, step)
            for dy in dy_range:
                # Tem xoay 180A 	 ti (dx, dy) - c n tAm dx nh? nht
                # Binary search: lo = overlap ch_c ch_n, hi = khA'ng overlap ch_c ch_n
                lo = -rw
                hi = bw + gap_px
                # TAm dx nh? nht sao cho khA'ng giao nhau
                safe_dx = hi
                for _ in range(12):
                    mid = (lo + hi) / 2.0
                    shifted = affinity.translate(rot_at_origin, xoff=mid, yoff=dy)
                    if base_at_origin.intersects(shifted):
                        lo = mid  # Vn giao +' tng dx
                    else:
                        safe_dx = mid
                        hi = mid  # KhA'ng giao +' th- gim dx
                if safe_dx < bw + gap_px:  # Ch% gi_ nu thc s overlap-saving
                    candidates.append((safe_dx, dy))'''

new_code = '''            # Phase 1: Ti m-i mcc dy, tAm dx nh? nht sao cho tem gc + tem xoay 180A KHA"NG giao nhau
            try:
                import pdfcompare_native
                base_coords = list(base_at_origin.exterior.coords)
                rot_coords = list(rot_at_origin.exterior.coords)
                nfp_solver = pdfcompare_native.NfpSolver(base_coords, rot_coords)
                candidates = nfp_solver.solve_candidates(bh, bw, rw, gap_px, step)
            except (ImportError, AttributeError) as e:
                logger.warning(f"Rust NFP Solver not available, using Python fallback: {e}")
                candidates = []
                dy_range = np.arange(-bh + step, bh, step)
                for dy in dy_range:
                    lo = -rw
                    hi = bw + gap_px
                    safe_dx = hi
                    for _ in range(12):
                        mid = (lo + hi) / 2.0
                        shifted = affinity.translate(rot_at_origin, xoff=mid, yoff=dy)
                        if base_at_origin.intersects(shifted):
                            lo = mid
                        else:
                            safe_dx = mid
                            hi = mid
                    if safe_dx < bw + gap_px:
                        candidates.append((safe_dx, dy))'''

code = code.replace(old_code, new_code)

old_code_2 = '''                # TA-nh dx_outer: khong cAch ti thiu gi_a 2 cluster li?n ngang
                # Binary search cho dx_step
                lo_dx = 0
                hi_dx = c_w + gap_px
                dx_step = hi_dx
                for _ in range(12):
                    mid = (lo_dx + hi_dx) / 2.0
                    shifted_cluster = affinity.translate(cluster, xoff=mid, yoff=0)
                    if cluster.intersects(shifted_cluster):
                        lo_dx = mid
                    else:
                        dx_step = mid
                        hi_dx = mid
                
                # TA-nh dy_outer: khong cAch ti thiu gi_a 2 cluster li?n d?c
                # Binary search cho dy_step
                lo_dy = 0
                hi_dy = c_h + gap_px
                dy_step = hi_dy
                for _ in range(12):
                    mid = (lo_dy + hi_dy) / 2.0
                    shifted_cluster = affinity.translate(cluster, xoff=0, yoff=mid)
                    if cluster.intersects(shifted_cluster):
                        lo_dy = mid
                    else:
                        dy_step = mid
                        hi_dy = mid'''

new_code_2 = '''                try:
                    dx_step, dy_step = nfp_solver.solve_outer_step(dx, dy, c_w, c_h, gap_px)
                except (NameError, UnboundLocalError):
                    lo_dx = 0
                    hi_dx = c_w + gap_px
                    dx_step = hi_dx
                    for _ in range(12):
                        mid = (lo_dx + hi_dx) / 2.0
                        shifted_cluster = affinity.translate(cluster, xoff=mid, yoff=0)
                        if cluster.intersects(shifted_cluster):
                            lo_dx = mid
                        else:
                            dx_step = mid
                            hi_dx = mid
                    
                    lo_dy = 0
                    hi_dy = c_h + gap_px
                    dy_step = hi_dy
                    for _ in range(12):
                        mid = (lo_dy + hi_dy) / 2.0
                        shifted_cluster = affinity.translate(cluster, xoff=0, yoff=mid)
                        if cluster.intersects(shifted_cluster):
                            lo_dy = mid
                        else:
                            dy_step = mid
                            hi_dy = mid'''

code = code.replace(old_code_2, new_code_2)

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(code)

print("Done")
