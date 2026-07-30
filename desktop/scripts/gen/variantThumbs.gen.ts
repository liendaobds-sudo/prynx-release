// ============================================================
// [VARIANT 2026-07-29]
// Sinh ảnh khuôn 2D cho từng biến thể trong catalog:
//     public/images/dieline/variants/<id>.svg
//
// Chạy: npm run gen:variant-thumbs
//
// ── Vì sao là "test" của vitest chứ không phải script node thuần ──
// Engine khuôn bế là TypeScript nhập theo kiểu `./types` (không đuôi tệp), Node
// không tự resolve được; repo lại KHÔNG có tsx/vite-node/esbuild trong
// node_modules. Vitest thì có sẵn và resolve TS y như khi chạy test, nên dùng nó
// làm runner là cách rẻ nhất mà không thêm dependency mới. Tệp này đặt ngoài
// `src/` nên `npm run test` (include: src/**/*.test.ts) KHÔNG chạm tới.
//
// ── Vì sao SVG chứ không PNG ──
// Không cần rasteriser trong Node, nét vector sắc ở mọi cỡ card, và là văn bản
// nên `git diff` đọc được: đổi hình học là thấy diff ngay (yêu cầu đơn định).
//
// ── Giới hạn đã biết ──
// Không render được ảnh hộp 3D ở đây (three.js cần WebGL context). Card trong
// thư viện dùng ảnh hộp sẵn có theo boxType cho phần hình khối, còn tệp SVG này
// là phần thể hiện khác biệt giữa hai biến thể cùng loại.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { BOX_VARIANTS, BoxVariant } from '../../src/lib/dieline/variants';
import { generateDieline } from '../../src/lib/dieline/engine';
import { buildChains, chainToSvgD } from '../../src/lib/dieline/sharedGeometry';
import { BoxParams, DEFAULT_PARAMS, DielineModel } from '../../src/lib/dieline/types';

const OUT_DIR = path.resolve(process.cwd(), 'public/images/dieline/variants');

/** Kích thước khung ảnh (px trong viewBox) — hằng để đầu ra đơn định. */
const THUMB_W = 320;
const THUMB_H = 120;
const PADDING = 6;

/** Màu nét theo chú giải hiện hành của công cụ (CUT đen, CREASE đỏ nét đứt).
 *  BLEED cố ý BỎ: ở cỡ thumbnail nó chỉ làm rối, không giúp nhận diện. */
const STROKE = {
    CUT: { color: '#111827', width: 1.1, dash: '' },
    CREASE: { color: '#dc2626', width: 0.9, dash: ' stroke-dasharray="4,2.5"' },
} as const;

/** Bộ tham số cuối của biến thể — cùng thứ tự với hợp đồng ở Requirement 2.1. */
function paramsOf(v: BoxVariant): BoxParams {
    return { ...DEFAULT_PARAMS, boxType: v.boxType, ...v.preset, ...v.lockedParams };
}

/** Làm tròn cố định để đầu ra không dao động theo dấu phẩy động. */
const r3 = (n: number) => Number(n.toFixed(3));

/**
 * Dựng SVG thumbnail: fit khuôn vào khung THUMB_W×THUMB_H, giữ tỉ lệ, căn giữa.
 * Trục y của khuôn hướng LÊN còn của SVG hướng XUỐNG ⇒ lật y trong transform
 * (cùng quy ước với `exportPDF`).
 */
function buildThumbSvg(model: DielineModel): string {
    const bb = model.boundingBox;
    const scale = Math.min(
        (THUMB_W - PADDING * 2) / bb.width,
        (THUMB_H - PADDING * 2) / bb.height,
    );
    const offsetX = r3((THUMB_W - bb.width * scale) / 2 - bb.minX * scale);
    const offsetY = r3((THUMB_H - bb.height * scale) / 2 + bb.maxY * scale);

    // Nét vẽ mảnh dần khi khuôn bị thu nhỏ nhiều — chia lại cho scale để bề rộng
    // nét trên màn hình giữ nguyên bất kể khuôn to nhỏ.
    const w = (base: number) => r3(base / scale);

    let paths = '';
    for (const chain of buildChains(model.allPaths)) {
        const style = chain.tag === 'CREASE' ? STROKE.CREASE : chain.tag === 'CUT' ? STROKE.CUT : null;
        if (!style) continue;
        paths += `    <path d="${chainToSvgD(chain.segs)}" fill="none" stroke="${style.color}"`
            + ` stroke-width="${w(style.width)}" stroke-linecap="round"${style.dash}/>\n`;
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${THUMB_W} ${THUMB_H}" width="${THUMB_W}" height="${THUMB_H}">
  <rect width="${THUMB_W}" height="${THUMB_H}" fill="#ffffff"/>
  <g transform="translate(${offsetX}, ${offsetY}) scale(${r3(scale)}, ${r3(-scale)})">
${paths}  </g>
</svg>
`;
}

describe('gen: ảnh cho catalog biến thể', () => {
    it(`sinh ${BOX_VARIANTS.length} tệp SVG khuôn 2D (đặt tên theo mã khuôn)`, () => {
        fs.mkdirSync(OUT_DIR, { recursive: true });

        for (const v of BOX_VARIANTS) {
            const svg = buildThumbSvg(generateDieline(paramsOf(v)));

            // Đơn định: chỉ ghi khi nội dung THẬT SỰ đổi ⇒ không làm bẩn mtime,
            // và chạy lại nhiều lần cho ra kết quả y hệt.
            const file = path.join(OUT_DIR, `${v.code}.svg`);
            const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
            if (old !== svg) fs.writeFileSync(file, svg, 'utf8');

            expect(svg).toContain('<path');
            // Không được lọt NaN/Infinity vào tệp — dấu hiệu hình học vỡ
            expect(svg).not.toMatch(/NaN|Infinity/);
        }
    });

    /**
     * Dọn tệp lạ trong thư mục đầu ra: mã khuôn đổi/biến thể bị bỏ thì SVG cũ
     * thành rác và không ai biết. Chỉ xoá `.svg` do chính script này sinh ra —
     * KHÔNG chạm bất cứ định dạng nào khác.
     */
    it('xoá SVG mồ côi của biến thể không còn trong catalog', () => {
        const valid = new Set(BOX_VARIANTS.map(v => `${v.code}.svg`));
        const orphans = fs.readdirSync(OUT_DIR)
            .filter(name => name.toLowerCase().endsWith('.svg') && !valid.has(name));
        for (const name of orphans) fs.rmSync(path.join(OUT_DIR, name));
        if (orphans.length) console.log(`[gen] đã xoá ${orphans.length} SVG mồ côi: ${orphans.join(', ')}`);

        expect(fs.readdirSync(OUT_DIR).filter(n => n.toLowerCase().endsWith('.svg')).sort())
            .toEqual([...valid].sort());
    });

    it('chạy lại lần hai cho ra nội dung y hệt (đơn định)', () => {
        for (const v of BOX_VARIANTS) {
            const a = buildThumbSvg(generateDieline(paramsOf(v)));
            const b = buildThumbSvg(generateDieline(paramsOf(v)));
            expect(a).toBe(b);
        }
    });
});
