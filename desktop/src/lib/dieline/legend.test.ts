// ============================================================
// legend.test.ts
//
// Task 8.2 (tùy chọn) của spec dieline-hardening:
//   • Property 8: Legend bằng đúng tập tag thực có trong file
//     (Validates Requirements 5.1, 5.4, 5.5, 5.6)
//
// Legend là dẫn xuất (derived), không phải hằng số: tập PathTag
// hiển thị trong chú giải phải bằng ĐÚNG (đẳng thức tập hợp hai
// chiều) tập PathTag thực sự xuất hiện trên các PathSegment trong
// model.allPaths.
// ============================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { deriveLegendTags } from './sharedGeometry';
import { arbBoxParams, GeneratorBoxType } from './arbitraries';
import { BoxParams, DielineModel, PathSegment, PathTag } from './types';

import { generateReverseTuckEnd } from './ReverseTuckEnd';
import { generateSnapLockBottom } from './SnapLockBottom';
import { generateGableBox } from './GableBox';
import { generatePaperBag } from './PaperBag';
import { generateCupSleeve } from './CupSleeve';
import { generatePizzaBox } from './PizzaBox';
import { generateEnvelope } from './Envelope';
import { generateMatchboxTray } from './MatchboxTray';

// ─── Dispatch boxType → generator ───────────────────────────
const GENERATORS: Record<GeneratorBoxType, (p: BoxParams) => DielineModel> = {
    rte: generateReverseTuckEnd,
    slb: generateSnapLockBottom,
    gable: generateGableBox,
    paper_bag: generatePaperBag,
    cup_sleeve: generateCupSleeve,
    pizza: generatePizzaBox,
    envelope: generateEnvelope,
    tray: generateMatchboxTray,
};

const ALL_TYPES: GeneratorBoxType[] = [
    'rte', 'slb', 'gable', 'paper_bag', 'cup_sleeve', 'pizza', 'envelope', 'tray',
];

/** Tập tag thực sự xuất hiện trên các PathSegment trong allPaths (nguồn sự thật). */
function actualTagsInPaths(model: DielineModel): Set<PathTag> {
    const tags = new Set<PathTag>();
    for (const seg of model.allPaths) {
        tags.add(seg.tag);
    }
    return tags;
}

/** Đẳng thức tập hợp hai chiều giữa hai Set<PathTag>. */
function setsEqual(a: Set<PathTag>, b: Set<PathTag>): boolean {
    if (a.size !== b.size) return false;
    for (const t of a) {
        if (!b.has(t)) return false;
    }
    for (const t of b) {
        if (!a.has(t)) return false;
    }
    return true;
}

// ============================================================
// Property 8 — Legend bằng đúng tập tag thực có trong file
// Feature: dieline-hardening, Property 8: For any DielineModel, tập
// PathTag do deriveLegendTags(model) trả về (tức tập tag hiển thị
// trong legend) bằng đúng (đẳng thức tập hợp hai chiều) tập các
// PathTag thực sự xuất hiện trên các PathSegment trong model.allPaths.
//
// Validates: Requirements 5.1, 5.4, 5.5, 5.6
// ============================================================
describe('Property 8 — deriveLegendTags = tập tag thực trong allPaths', () => {
    for (const boxType of ALL_TYPES) {
        it(`legend tags set-equal actual tags in allPaths (${boxType})`, () => {
            fc.assert(
                fc.property(arbBoxParams(boxType), (params: BoxParams) => {
                    const model = GENERATORS[boxType](params);

                    const legend = deriveLegendTags(model);
                    const actual = actualTagsInPaths(model);

                    // Chiều 1 (Req 5.1, 5.4): mọi tag trong legend đều thực sự
                    // xuất hiện trên ít nhất một segment trong allPaths.
                    for (const tag of legend) {
                        expect(actual.has(tag)).toBe(true);
                    }

                    // Chiều 2 (Req 5.5, 5.6): mọi tag có trên segment trong
                    // allPaths đều xuất hiện trong legend.
                    for (const tag of actual) {
                        expect(legend.has(tag)).toBe(true);
                    }

                    // Đẳng thức tập hợp hai chiều tổng quát.
                    expect(setsEqual(legend, actual)).toBe(true);
                }),
                { numRuns: 100 },
            );
        });
    }
});

// ============================================================
// Example tập trung — Requirement 5.4 (phương án B cho BLEED)
//
// Một model chỉ chứa CUT + CREASE (không có đoạn BLEED nào) thì
// legend dẫn xuất KHÔNG được chứa BLEED — đúng tinh thần gỡ BLEED
// khỏi chú giải khi không có biên dạng BLEED thực.
// ============================================================
describe('Example — model chỉ có CUT+CREASE thì legend không có BLEED (Req 5.4)', () => {
    function seg(tag: PathTag): PathSegment {
        return {
            tag,
            type: 'line',
            points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
        };
    }

    it('legend chỉ gồm CUT và CREASE, tuyệt đối không có BLEED', () => {
        const model: DielineModel = {
            name: 'test',
            standardCode: 'TEST',
            description: 'chỉ CUT + CREASE',
            panels: [],
            allPaths: [seg('CUT'), seg('CREASE'), seg('CUT'), seg('CREASE')],
            boundingBox: { minX: 0, minY: 0, maxX: 10, maxY: 0, width: 10, height: 0 },
            params: {} as BoxParams,
        };

        const legend = deriveLegendTags(model);

        expect(legend.has('CUT')).toBe(true);
        expect(legend.has('CREASE')).toBe(true);
        expect(legend.has('BLEED')).toBe(false);
        expect(legend.size).toBe(2);
    });

    it('khi có đoạn BLEED thực thì legend hiển thị BLEED (phương án A tương lai)', () => {
        const model: DielineModel = {
            name: 'test',
            standardCode: 'TEST',
            description: 'có BLEED thực',
            panels: [],
            allPaths: [seg('CUT'), seg('CREASE'), seg('BLEED')],
            boundingBox: { minX: 0, minY: 0, maxX: 10, maxY: 0, width: 10, height: 0 },
            params: {} as BoxParams,
        };

        const legend = deriveLegendTags(model);

        expect(setsEqual(legend, new Set<PathTag>(['CUT', 'CREASE', 'BLEED']))).toBe(true);
    });
});
