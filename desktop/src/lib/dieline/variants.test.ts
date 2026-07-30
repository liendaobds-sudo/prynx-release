// ============================================================
// [VARIANT 2026-07-29]
// Test cho thư viện biến thể khuôn bế (`variants.ts`).
//
// Bốn tầng, tương ứng Correctness Properties trong
// .kiro/specs/box-variant-catalog/design.md:
//   Tầng 1 — toàn vẹn catalog        (Property 3, 5)
//   Tầng 2 — sinh được khuôn hợp lệ  (Property 1)
//   Tầng 3 — preset không bị kẹp     (Property 6)
//   Tầng 4 — biến thể cùng loại PHẢI khác hình (Property 4)
//
// Tầng 4 là chốt chống "tách card cho vui": hai card cùng boxType mà cho ra
// hình y hệt nhau thì việc tách chỉ làm thư viện dài thêm vô ích.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
    BOX_VARIANTS,
    BOX_GROUPS,
    CROSS_CUT_GROUPS,
    BoxGroup,
    BoxVariant,
    getVariant,
    getVariantByCode,
    defaultVariantFor,
    isParamLocked,
    isSectionLocked,
    isDeviated,
    countByGroup,
    variantsInGroup,
    variantDielineSvg,
    variantMatchesQuery,
} from './variants';
import { generateDieline } from './engine';
import { validateParams } from './validateParams';
import { BoxParams, DEFAULT_PARAMS } from './types';

/** Bộ tham số cuối cùng của một biến thể: mặc định → preset → lockedParams.
 *  Đúng thứ tự hợp đồng ở Requirement 2.1. */
function paramsOf(v: BoxVariant): BoxParams {
    return {
        ...DEFAULT_PARAMS,
        boxType: v.boxType,
        ...v.preset,
        ...v.lockedParams,
    };
}

/** Ba chỉ số hình học dùng để so hai biến thể cùng boxType. */
function shapeSignature(params: BoxParams) {
    const model = generateDieline(params);
    return {
        cutCount: model.allPaths.filter(p => p.tag === 'CUT').length,
        creaseCount: model.allPaths.filter(p => p.tag === 'CREASE').length,
        panelCount: model.panels.length,
        bbox: `${model.boundingBox.width.toFixed(3)}x${model.boundingBox.height.toFixed(3)}`,
    };
}

// ─── Tầng 1 — Toàn vẹn catalog ───────────────────────────────

describe('variants — tầng 1: toàn vẹn catalog', () => {
    it('có ít nhất một biến thể', () => {
        expect(BOX_VARIANTS.length).toBeGreaterThan(0);
    });

    it('id duy nhất', () => {
        const ids = BOX_VARIANTS.map(v => v.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('mã khuôn duy nhất và đúng tiền tố PRYNX-', () => {
        const codes = BOX_VARIANTS.map(v => v.code);
        expect(new Set(codes).size).toBe(codes.length);
        for (const v of BOX_VARIANTS) {
            expect(v.code).toMatch(/^PRYNX-[A-Z]+-\d{2}$/);
        }
    });

    it('mọi groups là giá trị hợp lệ và không rỗng', () => {
        const valid = new Set<BoxGroup>(BOX_GROUPS.map(g => g.id));
        for (const v of BOX_VARIANTS) {
            expect(v.groups.length).toBeGreaterThan(0);
            for (const g of v.groups) expect(valid.has(g)).toBe(true);
            // Không khai trùng nhóm trong cùng một biến thể
            expect(new Set(v.groups).size).toBe(v.groups.length);
        }
    });

    // Chốt sau phản hồi "xếp lung tung" (2026-07-29): mỗi biến thể phải có ĐÚNG MỘT
    // nhóm họ hộp. Ban đầu hộp đáy gài/đáy dán/hộp treo mang thêm nhóm `nap_cai` vì
    // thân giống RTE ⇒ "Hộp nắp cài" phình lên 7 mục và mất nghĩa.
    it('mỗi biến thể có ĐÚNG MỘT nhóm họ hộp, chồng lấn chỉ ở nhóm cắt ngang', () => {
        const crossCut = new Set<BoxGroup>(CROSS_CUT_GROUPS);
        for (const v of BOX_VARIANTS) {
            const families = v.groups.filter(g => !crossCut.has(g));
            expect(families.length, `${v.code} có ${families.length} nhóm họ hộp: ${families.join(', ')}`).toBe(1);
        }
    });

    it('nhóm cắt ngang phải đi kèm một nhóm họ hộp, không đứng một mình', () => {
        const crossCut = new Set<BoxGroup>(CROSS_CUT_GROUPS);
        for (const v of BOX_VARIANTS) {
            if (v.groups.some(g => crossCut.has(g))) {
                expect(v.groups.some(g => !crossCut.has(g)), `${v.code}`).toBe(true);
            }
        }
    });

    // Tên tệp ảnh đặt theo MÃ KHUÔN (không theo id) — mã khuôn hiện trên card nên
    // người thay ảnh nhìn card là biết đặt tên tệp gì. Đây là HỢP ĐỒNG với họ.
    it('đường dẫn khuôn 2D đặt theo mã khuôn', () => {
        for (const v of BOX_VARIANTS) {
            expect(variantDielineSvg(v)).toBe(`/images/dieline/variants/${v.code}.svg`);
        }
    });

    // Tệp do `npm run gen:variant-thumbs` sinh PHẢI tồn tại thật — nếu không, card
    // rơi về khung giữ chỗ mà không ai biết cho tới lúc mở app.
    it('mọi tệp khuôn 2D SVG đều có mặt trong public/', () => {
        const missing = BOX_VARIANTS
            .map(v => path.resolve(process.cwd(), 'public', variantDielineSvg(v).replace(/^\//, '')))
            .filter(p => !fs.existsSync(p))
            .map(p => path.basename(p));
        expect(missing, 'chạy: npm run gen:variant-thumbs').toEqual([]);
    });

    // Thư mục ảnh thay thủ công không được chứa tệp lệch mã — tệp sai tên sẽ im
    // lặng không hiện, người thay ảnh không hiểu vì sao.
    it('mọi ảnh trong src/assets/dieline/variants đều khớp một mã khuôn có thật', () => {
        const dir = path.resolve(process.cwd(), 'src/assets/dieline/variants');
        if (!fs.existsSync(dir)) return;
        const codes = new Set(BOX_VARIANTS.map(v => v.code.toUpperCase()));
        const stray = fs.readdirSync(dir)
            .filter(name => /\.(png|jpe?g|webp|avif)$/i.test(name))
            .filter(name => !codes.has(name.replace(/\.[^.]+$/, '').toUpperCase()));
        expect(stray, 'tên tệp phải đúng mã khuôn, vd PRYNX-SLB-02.png').toEqual([]);
    });

    it('nhãn, mô tả, alias đều có nội dung; alias viết KHÔNG dấu', () => {
        for (const v of BOX_VARIANTS) {
            expect(v.nameVi.trim().length).toBeGreaterThan(0);
            expect(v.descVi.trim().length).toBeGreaterThan(0);
            expect(v.aliases.length).toBeGreaterThan(0);
            for (const a of v.aliases) {
                // Alias là kho chữ cho tìm kiếm nên phải sẵn ở dạng không dấu
                expect(a).toBe(a.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
                expect(a).not.toMatch(/đ/);
            }
        }
    });

    it('lockedParams không được chứa boxType (boxType là trường riêng)', () => {
        for (const v of BOX_VARIANTS) {
            expect(Object.prototype.hasOwnProperty.call(v.lockedParams, 'boxType')).toBe(false);
            expect(Object.prototype.hasOwnProperty.call(v.preset ?? {}, 'boxType')).toBe(false);
        }
    });

    it('preset và lockedParams không chồng khoá nhau', () => {
        // Chồng khoá = mâu thuẫn ý định: preset là "gợi ý sửa được",
        // lockedParams là "chốt, ẩn khỏi form". Một khoá không thể là cả hai.
        for (const v of BOX_VARIANTS) {
            const presetKeys = Object.keys(v.preset ?? {});
            const lockedKeys = new Set(Object.keys(v.lockedParams));
            for (const k of presetKeys) expect(lockedKeys.has(k)).toBe(false);
        }
    });

    // Property 5: phủ kín loại hộp.
    // `Record<BoxParams['boxType'], true>` là chốt ở TẦNG TYPECHECK: thêm một
    // boxType mới vào union mà quên khai ở đây thì `tsc` đỏ ngay ("missing
    // property"), không cần chờ chạy test. Cách này không phải sửa allow-list ở
    // runtimeValidation.ts (Req 6.4 cấm chạm).
    it('mọi boxType đều được phủ bởi ít nhất một biến thể', () => {
        const ALL_BOX_TYPES: Record<BoxParams['boxType'], true> = {
            rte: true,
            slb: true,
            auto_bottom: true,
            gable: true,
            paper_bag: true,
            cup_sleeve: true,
            pizza: true,
            envelope: true,
            tray: true,
            double_tray: true,
            hanging_window: true,
        };
        const covered = new Set(BOX_VARIANTS.map(v => v.boxType));
        for (const boxType of Object.keys(ALL_BOX_TYPES) as BoxParams['boxType'][]) {
            expect(covered.has(boxType), `boxType '${boxType}' chưa có biến thể nào`).toBe(true);
        }
        // Ngược lại: biến thể không được trỏ boxType lạ
        for (const boxType of covered) {
            expect(Object.prototype.hasOwnProperty.call(ALL_BOX_TYPES, boxType)).toBe(true);
        }
    });

    it('mọi khoá trong lockedParams/preset là khoá thật của BoxParams', () => {
        const known = new Set(Object.keys(DEFAULT_PARAMS));
        for (const v of BOX_VARIANTS) {
            for (const k of [...Object.keys(v.lockedParams), ...Object.keys(v.preset ?? {})]) {
                expect(known.has(k)).toBe(true);
            }
        }
    });
});

// ─── Tầng 1b — Hàm tra cứu ───────────────────────────────────

describe('variants — tra cứu', () => {
    it('getVariant trả đúng mục, undefined khi không có', () => {
        expect(getVariant(BOX_VARIANTS[0].id)?.id).toBe(BOX_VARIANTS[0].id);
        expect(getVariant('khong_ton_tai')).toBeUndefined();
    });

    it('getVariantByCode không phân biệt hoa/thường', () => {
        const v = BOX_VARIANTS[0];
        expect(getVariantByCode(v.code.toLowerCase())?.id).toBe(v.id);
        expect(getVariantByCode('  ' + v.code + ' ')?.id).toBe(v.id);
        expect(getVariantByCode('PRYNX-XX-99')).toBeUndefined();
    });

    it('defaultVariantFor trả mục đầu tiên của boxType', () => {
        for (const v of BOX_VARIANTS) {
            const def = defaultVariantFor(v.boxType);
            expect(def).toBeDefined();
            expect(def!.boxType).toBe(v.boxType);
        }
    });

    // Property 3: chốt và ẩn không thể lệch nhau
    it('isParamLocked khớp CHÍNH XÁC tập khoá của lockedParams', () => {
        const allKeys = Object.keys(DEFAULT_PARAMS) as (keyof BoxParams)[];
        for (const v of BOX_VARIANTS) {
            const locked = new Set(Object.keys(v.lockedParams));
            for (const k of allKeys) {
                expect(isParamLocked(v.id, k)).toBe(locked.has(k));
            }
        }
    });

    it('isParamLocked trả false khi variantId rỗng hoặc rác', () => {
        expect(isParamLocked(null, 'lockTab')).toBe(false);
        expect(isParamLocked('khong_ton_tai', 'lockTab')).toBe(false);
    });

    it('isSectionLocked chỉ đúng khi TẤT CẢ khoá bị chốt', () => {
        const v = BOX_VARIANTS.find(x => Object.keys(x.lockedParams).length > 0)!;
        const lockedKey = Object.keys(v.lockedParams)[0] as keyof BoxParams;
        expect(isSectionLocked(v.id, [lockedKey])).toBe(true);
        expect(isSectionLocked(v.id, [lockedKey, 'L'])).toBe(false);
        expect(isSectionLocked(v.id, [])).toBe(false);
    });

    it('isDeviated: đúng chuẩn thì false, sửa khoá bị chốt thì true', () => {
        const v = BOX_VARIANTS.find(x => Object.keys(x.lockedParams).length > 0)!;
        const base = paramsOf(v);
        expect(isDeviated(v.id, base)).toBe(false);

        const key = Object.keys(v.lockedParams)[0] as keyof BoxParams;
        const current = v.lockedParams[key];
        const flipped = typeof current === 'boolean' ? !current : 'gia_tri_khac';
        expect(isDeviated(v.id, { ...base, [key]: flipped } as BoxParams)).toBe(true);
    });

    it('isDeviated: đổi boxType cũng là lệch', () => {
        const v = BOX_VARIANTS[0];
        const other = BOX_VARIANTS.find(x => x.boxType !== v.boxType);
        if (!other) return; // catalog chỉ có 1 boxType — bỏ qua
        expect(isDeviated(v.id, { ...paramsOf(v), boxType: other.boxType })).toBe(true);
    });

    it('countByGroup khớp việc đếm tay, phủ mọi nhóm đã khai', () => {
        const counts = countByGroup();
        for (const g of BOX_GROUPS) {
            expect(counts[g.id]).toBe(variantsInGroup(g.id).length);
        }
        // Nhóm chồng lấn: tổng các nhóm ≥ số biến thể
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        expect(total).toBeGreaterThanOrEqual(BOX_VARIANTS.length);
    });

    // Property 9: tìm kiếm bỏ dấu đối xứng
    it('variantMatchesQuery: bỏ dấu đối xứng, nhiều từ rời, khớp mã và alias', () => {
        const v = getVariant('hgb_window')!;
        expect(variantMatchesQuery(v, '')).toBe(true);
        expect(variantMatchesQuery(v, 'hộp treo')).toBe(true);
        expect(variantMatchesQuery(v, 'hop treo')).toBe(true);
        expect(variantMatchesQuery(v, 'treo hộp')).toBe(true); // không cần đúng thứ tự
        expect(variantMatchesQuery(v, 'PRYNX-HW-01')).toBe(true);
        expect(variantMatchesQuery(v, 'euro slot')).toBe(true); // alias
        expect(variantMatchesQuery(v, 'cửa sổ')).toBe(true); // tên nhóm
        expect(variantMatchesQuery(v, 'túi giấy')).toBe(false);
    });

    it('mọi biến thể tìm được bằng chính tên của nó, cả có dấu lẫn không dấu', () => {
        for (const v of BOX_VARIANTS) {
            expect(variantMatchesQuery(v, v.nameVi)).toBe(true);
            const noAccent = v.nameVi.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
            expect(variantMatchesQuery(v, noAccent)).toBe(true);
            expect(variantMatchesQuery(v, v.code)).toBe(true);
        }
    });
});

// ─── Tầng 2 — Sinh được khuôn hợp lệ ─────────────────────────

describe('variants — tầng 2: mọi biến thể sinh được khuôn hợp lệ', () => {
    for (const v of BOX_VARIANTS) {
        it(`${v.code} (${v.nameVi}) sinh model hợp lệ`, () => {
            const model = generateDieline(paramsOf(v));

            expect(model.panels.length).toBeGreaterThan(0);
            expect(model.allPaths.length).toBeGreaterThan(0);

            // Không NaN ở bất kỳ toạ độ nào
            for (const path of model.allPaths) {
                for (const p of path.points) {
                    expect(Number.isFinite(p.x)).toBe(true);
                    expect(Number.isFinite(p.y)).toBe(true);
                }
            }

            // boundingBox phải BAO ĐÚNG allPaths (bất biến của prynx-dieline:
            // model vi phạm điều này không tồn tại trong thực tế)
            const bb = model.boundingBox;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const path of model.allPaths) {
                for (const p of path.points) {
                    if (p.x < minX) minX = p.x;
                    if (p.y < minY) minY = p.y;
                    if (p.x > maxX) maxX = p.x;
                    if (p.y > maxY) maxY = p.y;
                }
            }
            expect(bb.minX).toBeLessThanOrEqual(minX + 0.01);
            expect(bb.minY).toBeLessThanOrEqual(minY + 0.01);
            expect(bb.maxX).toBeGreaterThanOrEqual(maxX - 0.01);
            expect(bb.maxY).toBeGreaterThanOrEqual(maxY - 0.01);
            expect(bb.width).toBeCloseTo(bb.maxX - bb.minX, 2);
            expect(bb.height).toBeCloseTo(bb.maxY - bb.minY, 2);
        });
    }

    // Property 2: chốt là chốt — không tầng nào ghi đè lockedParams
    for (const v of BOX_VARIANTS) {
        it(`${v.code}: validateParams KHÔNG ghi đè thuộc tính đã chốt`, () => {
            const out = validateParams(paramsOf(v)).params;
            for (const [k, expected] of Object.entries(v.lockedParams)) {
                expect(out[k as keyof BoxParams]).toBe(expected);
            }
        });
    }
});

// ─── Tầng 3 — Preset không bị kẹp ────────────────────────────

describe('variants — tầng 3: preset hợp lệ, không bị validateParams kẹp', () => {
    for (const v of BOX_VARIANTS) {
        it(`${v.code} không bị kẹp tham số`, () => {
            const result = validateParams(paramsOf(v));
            // Preset bị kẹp = LỖI DỮ LIỆU trong catalog, phải sửa preset chứ
            // không phải chấp nhận ở runtime. Báo kèm cảnh báo để dễ chẩn đoán.
            expect(result.wasClamped, result.warnings.join(' | ')).toBe(false);
        });
    }
});

// ─── Tầng 4 — Biến thể cùng loại PHẢI khác hình ───────────────

describe('variants — tầng 4: biến thể cùng boxType phải khác hình thật', () => {
    const byType = new Map<BoxParams['boxType'], BoxVariant[]>();
    for (const v of BOX_VARIANTS) {
        const list = byType.get(v.boxType) ?? [];
        list.push(v);
        byType.set(v.boxType, list);
    }

    for (const [boxType, list] of byType) {
        if (list.length < 2) continue;
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                const a = list[i], b = list[j];
                it(`${a.code} vs ${b.code} (${boxType}) khác nhau ít nhất một chỉ số hình học`, () => {
                    const sa = shapeSignature(paramsOf(a));
                    const sb = shapeSignature(paramsOf(b));
                    // Tách card mà hình y hệt nhau = card vô nghĩa (Req 1.5)
                    expect(JSON.stringify(sa)).not.toBe(JSON.stringify(sb));
                });
            }
        }
    }
});
