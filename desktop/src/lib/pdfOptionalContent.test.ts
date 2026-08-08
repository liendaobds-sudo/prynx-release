// [OCG FIX 2026-07-28] Chốt hồi quy: ghi lại file bằng pdf-lib KHÔNG được làm mất layer ẩn.
//
// Bug gốc: `PDFDocument.create()` + `copyPages()` bỏ `/OCProperties` ở catalog trong khi
// content stream vẫn còn `/OC … BDC` → mọi renderer vẽ hết → nội dung thợ đã ẩn trong
// Illustrator lọt vào bản in.
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFString } from 'pdf-lib';

import {
    addOptionalContentSource,
    beginOptionalContentTransfer,
    createOptionalContentTransfer,
    finishOptionalContentTransfer,
    getOutputIntentConflicts,
} from './pdfOptionalContent';

const CONTENT = `
1 1 1 rg 0 0 200 200 re f
/OC /L_Hien BDC
0 0 1 rg 10 10 60 60 re f
EMC
/OC /L_An BDC
1 0 0 rg 100 100 80 80 re f
EMC
`;

interface Fixture {
    doc: PDFDocument;
    hienRef: PDFRef;
    anRef: PDFRef;
}

/** Dựng PDF kiểu Illustrator: 1 layer hiện + 1 layer ẩn qua `/D/OFF`. */
async function makeSource(options: { withAutoState?: boolean } = {}): Promise<Fixture> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);

    const hienRef = doc.context.register(
        doc.context.obj({ Type: 'OCG', Name: PDFString.of('Hinh in') }),
    );
    const anRef = doc.context.register(
        doc.context.obj({ Type: 'OCG', Name: PDFString.of('Ghi chu noi bo') }),
    );

    page.node.set(
        PDFName.of('Contents'),
        doc.context.register(doc.context.stream(CONTENT)),
    );
    page.node.set(
        PDFName.of('Resources'),
        doc.context.obj({ Properties: { L_Hien: hienRef, L_An: anRef } }),
    );

    const baseConfig = {
        BaseState: PDFName.of('ON'),
        ON: [hienRef],
        OFF: [anRef],
        Order: [hienRef, anRef],
    };
    // Lớp "hiện trên màn hình nhưng KHÔNG in" — mất `/AS` là nó bị in ra.
    const config = options.withAutoState
        ? {
            ...baseConfig,
            AS: [{ Event: PDFName.of('Print'), Category: [PDFName.of('Print')], OCGs: [anRef] }],
        }
        : baseConfig;

    doc.catalog.set(
        PDFName.of('OCProperties'),
        doc.context.obj({ OCGs: [hienRef, anRef], D: config }),
    );

    return { doc, hienRef, anRef };
}

function ocProps(doc: PDFDocument): PDFDict | undefined {
    return doc.catalog.lookupMaybe(PDFName.of('OCProperties'), PDFDict);
}

function refsIn(dict: PDFDict | undefined, key: string): PDFRef[] {
    const arr = dict?.lookupMaybe(PDFName.of(key), PDFArray);
    const out: PDFRef[] = [];
    for (let i = 0; arr && i < arr.size(); i += 1) {
        const item = arr.get(i);
        if (item instanceof PDFRef) out.push(item);
    }
    return out;
}

/** Ref mà content stream thực sự trỏ tới — `/OCGs` phải khớp CHÍNH object này. */
function propertyRef(doc: PDFDocument, name: string): PDFRef | undefined {
    const resources = doc.getPage(0).node.lookupMaybe(PDFName.of('Resources'), PDFDict);
    const properties = resources?.lookupMaybe(PDFName.of('Properties'), PDFDict);
    const ref = properties?.get(PDFName.of(name));
    return ref instanceof PDFRef ? ref : undefined;
}

function ocgNames(doc: PDFDocument): string[] {
    const arr = ocProps(doc)?.lookupMaybe(PDFName.of('OCGs'), PDFArray);
    const names: string[] = [];
    for (let i = 0; arr && i < arr.size(); i += 1) {
        const name = arr
            .lookupMaybe(i, PDFDict)
            ?.lookupMaybe(PDFName.of('Name'), PDFString)
            ?.decodeText();
        if (name) names.push(name);
    }
    return names;
}

async function copyInto(src: PDFDocument): Promise<PDFDocument> {
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
    return out;
}

describe('pdfOptionalContent — giữ layer qua pdf-lib copyPages', () => {
    it('tái hiện bug: copyPages trơ làm mất /OCProperties', async () => {
        const { doc } = await makeSource();
        const out = await copyInto(doc);

        expect(ocProps(doc)).toBeDefined();
        expect(ocProps(out)).toBeUndefined();
        // Nhưng marked content vẫn còn → renderer vẽ hết, đây chính là lỗ hổng.
        expect(propertyRef(out, 'L_An')).toBeDefined();
    });

    it('tuỳ chọn giữ OCG rỗng dùng làm Graphtec info và cây layer cha', async () => {
        const doc = await PDFDocument.create();
        const page = doc.addPage([200, 200]);
        const graphRef = doc.context.register(
            doc.context.obj({ Type: 'OCG', Name: PDFString.of('SA info AUDIT') }),
        );
        const layerRef = doc.context.register(
            doc.context.obj({ Type: 'OCG', Name: PDFString.of('Marks_Model_AUDIT') }),
        );
        const groupRef = doc.context.register(
            doc.context.obj({ Type: 'OCG', Name: PDFString.of('MarkLine_AUDIT') }),
        );
        page.node.set(
            PDFName.of('Contents'),
            doc.context.register(doc.context.stream('/OC /MarkGroup BDC 0 0 10 10 re S EMC')),
        );
        // Artifact CNC thật chỉ tham chiếu group chứa nét; Graphtec info và layer cha rỗng.
        page.node.set(PDFName.of('Resources'), doc.context.obj({
            Properties: { MarkGroup: groupRef },
        }));
        doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({
            OCGs: [graphRef, layerRef, groupRef],
            D: {
                BaseState: PDFName.of('ON'),
                ON: [graphRef, layerRef, groupRef],
                Order: [graphRef, layerRef, [groupRef]],
            },
        }));

        const transfer = beginOptionalContentTransfer(
            [doc],
            { preserveUnreferencedOcgs: true },
        );
        const out = await copyInto(doc);
        finishOptionalContentTransfer(transfer, out);

        expect(ocgNames(out)).toEqual([
            'SA info AUDIT',
            'Marks_Model_AUDIT',
            'MarkLine_AUDIT',
        ]);
        const order = ocProps(out)
            ?.lookupMaybe(PDFName.of('D'), PDFDict)
            ?.lookupMaybe(PDFName.of('Order'), PDFArray);
        expect(order?.size()).toBe(3);
        expect(order?.lookupMaybe(2, PDFArray)?.size()).toBe(1);
        expect(refsIn(ocProps(out), 'OCGs').map(ref => ref.tag)).toContain(
            propertyRef(out, 'MarkGroup')?.tag,
        );
    });

    it('chỉ giữ OCG rỗng cùng nhánh /Order với trang được trích', async () => {
        const doc = await PDFDocument.create();
        const refs = ['SA 1', 'Layer 1', 'Group 1', 'SA 2', 'Layer 2', 'Group 2']
            .map(name => doc.context.register(
                doc.context.obj({ Type: 'OCG', Name: PDFString.of(name) }),
            ));
        [refs[2], refs[5]].forEach((groupRef) => {
            const page = doc.addPage([200, 200]);
            page.node.set(
                PDFName.of('Contents'),
                doc.context.register(doc.context.stream('/OC /MarkGroup BDC 0 0 10 10 re S EMC')),
            );
            page.node.set(PDFName.of('Resources'), doc.context.obj({
                Properties: { MarkGroup: groupRef },
            }));
        });
        doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({
            OCGs: refs,
            D: {
                BaseState: PDFName.of('ON'),
                ON: refs,
                Order: [refs[0], refs[1], [refs[2]], refs[3], refs[4], [refs[5]]],
            },
        }));

        const transfer = beginOptionalContentTransfer(
            [doc],
            { preserveUnreferencedOcgs: true },
        );
        const out = await PDFDocument.create();
        const [firstPage] = await out.copyPages(doc, [0]);
        out.addPage(firstPage);
        finishOptionalContentTransfer(transfer, out);

        expect(ocgNames(out)).toEqual(['SA 1', 'Layer 1', 'Group 1']);
    });

    it('giữ được trạng thái ẩn và trỏ đúng object mà content dùng', async () => {
        const { doc } = await makeSource();

        const transfer = beginOptionalContentTransfer([doc]);
        const out = await copyInto(doc);
        const moved = finishOptionalContentTransfer(transfer, out);

        expect(moved).toBe(2);
        const props = ocProps(out);
        expect(props).toBeDefined();
        expect(refsIn(props, 'OCGs')).toHaveLength(2);

        const config = props?.lookupMaybe(PDFName.of('D'), PDFDict);
        const off = refsIn(config, 'OFF');
        const on = refsIn(config, 'ON');
        expect(off).toHaveLength(1);
        expect(on).toHaveLength(1);

        // Điểm cốt tử: ref trong /OFF phải LÀ object mà content stream trỏ tới, không
        // phải một bản copy thứ hai — copy trùng thì file vẫn lộ nội dung ẩn.
        expect(off[0].tag).toBe(propertyRef(out, 'L_An')?.tag);
        expect(on[0].tag).toBe(propertyRef(out, 'L_Hien')?.tag);
        expect(refsIn(props, 'OCGs').map((r) => r.tag).sort()).toEqual(
            [propertyRef(out, 'L_Hien')!.tag, propertyRef(out, 'L_An')!.tag].sort(),
        );
    });

    it('giữ cây /Order và /AS (lớp khai không-in phải không bị in)', async () => {
        const { doc } = await makeSource({ withAutoState: true });

        const transfer = beginOptionalContentTransfer([doc]);
        const out = await copyInto(doc);
        finishOptionalContentTransfer(transfer, out);

        const config = ocProps(out)?.lookupMaybe(PDFName.of('D'), PDFDict);
        expect(refsIn(config, 'Order')).toHaveLength(2);

        const asArr = config?.lookupMaybe(PDFName.of('AS'), PDFArray);
        expect(asArr?.size()).toBe(1);
        const entry = asArr?.lookupMaybe(0, PDFDict);
        expect(entry?.lookupMaybe(PDFName.of('Event'), PDFName)?.asString()).toBe('/Print');
        expect(refsIn(entry, 'OCGs')[0].tag).toBe(propertyRef(out, 'L_An')?.tag);
    });

    it('quy /BaseState /OFF về dạng tường minh', async () => {
        const doc = await PDFDocument.create();
        const page = doc.addPage([200, 200]);
        const aRef = doc.context.register(doc.context.obj({ Type: 'OCG', Name: PDFString.of('A') }));
        const bRef = doc.context.register(doc.context.obj({ Type: 'OCG', Name: PDFString.of('B') }));
        page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(
            '/OC /MA BDC 0 0 1 rg 0 0 10 10 re f EMC /OC /MB BDC 1 0 0 rg 10 10 10 10 re f EMC',
        )));
        page.node.set(PDFName.of('Resources'), doc.context.obj({ Properties: { MA: aRef, MB: bRef } }));
        // BaseState /OFF + chỉ A trong /ON ⇒ B đang ẩn.
        doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({
            OCGs: [aRef, bRef],
            D: { BaseState: PDFName.of('OFF'), ON: [aRef] },
        }));

        const transfer = beginOptionalContentTransfer([doc]);
        const out = await copyInto(doc);
        finishOptionalContentTransfer(transfer, out);

        const config = ocProps(out)?.lookupMaybe(PDFName.of('D'), PDFDict);
        expect(config?.lookupMaybe(PDFName.of('BaseState'), PDFName)?.asString()).toBe('/ON');
        expect(refsIn(config, 'OFF')[0].tag).toBe(propertyRef(out, 'MB')?.tag);
        expect(refsIn(config, 'ON')[0].tag).toBe(propertyRef(out, 'MA')?.tag);
    });

    it('xoá sạch dấu tạm ở cả file nguồn và file đích', async () => {
        const { doc, anRef } = await makeSource();
        const transfer = beginOptionalContentTransfer([doc]);
        const out = await copyInto(doc);
        finishOptionalContentTransfer(transfer, out);

        const stamp = PDFName.of('PrynXOcgStamp');
        expect(doc.context.lookupMaybe(anRef, PDFDict)?.get(stamp)).toBeUndefined();
        const copied = propertyRef(out, 'L_An');
        expect(out.context.lookupMaybe(copied!, PDFDict)?.get(stamp)).toBeUndefined();
    });

    it('ghép 2 nguồn: layer ẩn của từng file vẫn ẩn, không tráo nhau', async () => {
        const a = await makeSource();
        const b = await makeSource();

        const out = await PDFDocument.create();
        const transfer = createOptionalContentTransfer();
        addOptionalContentSource(transfer, a.doc);
        (await out.copyPages(a.doc, a.doc.getPageIndices())).forEach((p) => out.addPage(p));
        addOptionalContentSource(transfer, b.doc);
        (await out.copyPages(b.doc, b.doc.getPageIndices())).forEach((p) => out.addPage(p));
        const moved = finishOptionalContentTransfer(transfer, out);

        expect(moved).toBe(4);
        const config = ocProps(out)?.lookupMaybe(PDFName.of('D'), PDFDict);
        const offTags = refsIn(config, 'OFF').map((r) => r.tag).sort();
        expect(offTags).toHaveLength(2);

        // Mỗi trang phải có đúng OCG ẩn CỦA NÓ trong /OFF — hai nguồn dùng chung tiền tố
        // dấu sẽ làm trang 2 nhận OCG của trang 1 và lộ nội dung.
        const anTags = [0, 1].map((pageIndex) => {
            const resources = out.getPage(pageIndex).node
                .lookupMaybe(PDFName.of('Resources'), PDFDict);
            const props = resources?.lookupMaybe(PDFName.of('Properties'), PDFDict);
            const ref = props?.get(PDFName.of('L_An'));
            return ref instanceof PDFRef ? ref.tag : undefined;
        });
        expect(new Set(anTags).size).toBe(2);
        expect(offTags).toEqual([...anTags].sort());
    });

    it('file không có layer thì không thêm /OCProperties rỗng', async () => {
        const doc = await PDFDocument.create();
        doc.addPage([100, 100]);

        const transfer = beginOptionalContentTransfer([doc]);
        const out = await copyInto(doc);

        expect(finishOptionalContentTransfer(transfer, out)).toBe(0);
        expect(ocProps(out)).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [OCG FIX 2026-07-28 vòng 2] Bake thứ tự trang gọi `copyPages` MỘT LẦN MỖI TRANG
// (applyAcrobatEdits, materializePreviewViewerPdf, savePrintFiles, ShuffleEngine).
// pdf-lib tạo copier mới mỗi lần gọi ⇒ mỗi trang có BẢN OCG riêng. Nếu chỉ đăng ký
// bản đầu thì trang thứ hai trở đi lộ nội dung ẩn. Đo thật trước khi vá: 4 vị trí
// sinh 6 object OCG, chỉ 2 được đăng ký, 2/4 trang bị vẽ lớp ẩn.
// ─────────────────────────────────────────────────────────────────────────────

/** Nguồn nhiều trang DÙNG CHUNG một /Resources, giống file Illustrator thật. */
async function makeMultiPageSource(pageCount: number): Promise<PDFDocument> {
    const doc = await PDFDocument.create();
    const ctx = doc.context;

    const hienRef = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Hinh in') }));
    const anRef = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Ghi chu noi bo') }));
    const contents = ctx.register(ctx.stream(CONTENT));
    const resources = ctx.register(
        ctx.obj({ Properties: { L_Hien: hienRef, L_An: anRef } }),
    );

    for (let i = 0; i < pageCount; i += 1) {
        const page = doc.addPage([200, 200]);
        page.node.set(PDFName.of('Contents'), contents);
        page.node.set(PDFName.of('Resources'), resources);
    }

    doc.catalog.set(
        PDFName.of('OCProperties'),
        ctx.obj({
            OCGs: [hienRef, anRef],
            D: {
                BaseState: PDFName.of('ON'),
                ON: [hienRef],
                OFF: [anRef],
                Order: [hienRef, anRef],
            },
        }),
    );
    return doc;
}

/** Bake theo thứ tự `order` (1-based, cho phép lặp) đúng kiểu call site thật. */
async function bakePerPage(src: PDFDocument, order: number[]): Promise<PDFDocument> {
    const out = await PDFDocument.create();
    const transfer = beginOptionalContentTransfer([src]);
    try {
        for (const pageNo of order) {
            const [copied] = await out.copyPages(src, [pageNo - 1]);
            out.addPage(copied);
        }
    } finally {
        finishOptionalContentTransfer(transfer, out);
    }
    return out;
}

/** Mọi ref OCG mà từng trang thực sự dùng, theo tên trong /Resources/Properties. */
function usedRefsPerPage(doc: PDFDocument, name: string): (PDFRef | undefined)[] {
    return doc.getPages().map((page) => {
        const resources = page.node.lookupMaybe(PDFName.of('Resources'), PDFDict);
        const properties = resources?.lookupMaybe(PDFName.of('Properties'), PDFDict);
        const ref = properties?.get(PDFName.of(name));
        return ref instanceof PDFRef ? ref : undefined;
    });
}

describe('pdfOptionalContent — copyPages gọi từng trang một', () => {
    it('MỌI trang đều có OCG ẩn nằm trong /OCGs và /OFF', async () => {
        const src = await makeMultiPageSource(2);
        const out = await bakePerPage(src, [2, 1, 1]);

        const config = ocProps(out)?.lookupMaybe(PDFName.of('D'), PDFDict);
        const registered = new Set(refsIn(ocProps(out), 'OCGs').map((r) => r.tag));
        const off = new Set(refsIn(config, 'OFF').map((r) => r.tag));

        const used = usedRefsPerPage(out, 'L_An');
        expect(used).toHaveLength(3);
        used.forEach((ref, i) => {
            expect(ref, `trang ${i + 1} phải còn tham chiếu layer ẩn`).toBeDefined();
            // Chốt chính: sót khỏi /OCGs là bị vẽ bất chấp /OFF.
            expect(registered.has(ref!.tag), `trang ${i + 1} chưa đăng ký trong /OCGs`).toBe(true);
            expect(off.has(ref!.tag), `trang ${i + 1} chưa nằm trong /OFF`).toBe(true);
        });
    });

    it('layer HIỆN không bị đẩy sang /OFF', async () => {
        const src = await makeMultiPageSource(2);
        const out = await bakePerPage(src, [1, 2]);

        const config = ocProps(out)?.lookupMaybe(PDFName.of('D'), PDFDict);
        const off = new Set(refsIn(config, 'OFF').map((r) => r.tag));
        const on = new Set(refsIn(config, 'ON').map((r) => r.tag));

        usedRefsPerPage(out, 'L_Hien').forEach((ref, i) => {
            expect(off.has(ref!.tag), `trang ${i + 1} bị tắt oan`).toBe(false);
            expect(on.has(ref!.tag), `trang ${i + 1} thiếu trong /ON`).toBe(true);
        });
    });

    it('cây /Order chỉ một mục mỗi layer dù nội dung copy nhiều bản', async () => {
        const src = await makeMultiPageSource(1);
        const out = await bakePerPage(src, [1, 1, 1, 1]);

        const config = ocProps(out)?.lookupMaybe(PDFName.of('D'), PDFDict);
        // 2 layer nguồn → /Order đúng 2 mục, dù /OCGs có 8 bản.
        expect(refsIn(config, 'Order')).toHaveLength(2);
        expect(refsIn(ocProps(out), 'OCGs').length).toBeGreaterThan(2);
    });

    it('không còn sót dấu tạm trong file đích', async () => {
        const src = await makeMultiPageSource(2);
        const out = await bakePerPage(src, [1, 2, 1]);

        const stamp = PDFName.of('PrynXOcgStamp');
        refsIn(ocProps(out), 'OCGs').forEach((ref) => {
            expect(out.context.lookupMaybe(ref, PDFDict)?.get(stamp)).toBeUndefined();
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [OUTPUT INTENT 2026-07-28] pdf-lib `create()` cũng bỏ `/OutputIntents` → mỗi lần
// PrynX ghi lại file là mất ICC đích của bản in, file hết đạt PDF/X và RIP mất mốc
// quy đổi màu. Đo thật trước khi vá: bake thứ tự trang xong /OutputIntents = MẤT HẲN.
// ─────────────────────────────────────────────────────────────────────────────

/** Gắn /OutputIntents có profile ICC nhúng (stream) vào một tài liệu. */
function attachOutputIntent(doc: PDFDocument, conditionId: string): void {
    const ctx = doc.context;
    // Stream ICC giả nhưng là stream THẬT — để kiểm nó có được copy theo hay không.
    const profile = ctx.register(ctx.stream('ICC-FAKE-PROFILE-BYTES', { N: 4 }));
    doc.catalog.set(
        PDFName.of('OutputIntents'),
        ctx.obj([{
            Type: 'OutputIntent',
            S: 'GTS_PDFX',
            OutputConditionIdentifier: PDFString.of(conditionId),
            DestOutputProfile: profile,
        }]),
    );
}

function outputIntents(doc: PDFDocument): PDFArray | undefined {
    return doc.catalog.lookupMaybe(PDFName.of('OutputIntents'), PDFArray);
}

function firstConditionId(doc: PDFDocument): string | undefined {
    const entry = outputIntents(doc)?.lookupMaybe(0, PDFDict);
    const raw = entry?.get(PDFName.of('OutputConditionIdentifier')) as
        unknown as { decodeText?: () => string } | undefined;
    return raw?.decodeText?.();
}

describe('pdfOptionalContent — mang theo /OutputIntents', () => {
    it('tái hiện bug: copyPages trơ làm mất /OutputIntents', async () => {
        const { doc } = await makeSource();
        attachOutputIntent(doc, 'Coated FOGRA39');

        const out = await copyInto(doc);
        expect(outputIntents(doc)).toBeDefined();
        expect(outputIntents(out)).toBeUndefined();
    });

    it('giữ được qua bake từng trang, kèm profile ICC nhúng', async () => {
        const src = await makeMultiPageSource(2);
        attachOutputIntent(src, 'Coated FOGRA39');

        const out = await bakePerPage(src, [2, 1, 1]);

        expect(outputIntents(out)?.size()).toBe(1);
        expect(firstConditionId(out)).toBe('Coated FOGRA39');
        // Profile ICC phải là stream đi theo, không phải ref treo.
        const entry = outputIntents(out)?.lookupMaybe(0, PDFDict);
        const profileRef = entry?.get(PDFName.of('DestOutputProfile'));
        expect(profileRef).toBeInstanceOf(PDFRef);
        expect(out.context.lookup(profileRef as PDFRef)).toBeDefined();
    });

    it('giữ được cả khi file KHÔNG có layer nào', async () => {
        const plain = await PDFDocument.create();
        plain.addPage([200, 200]);
        attachOutputIntent(plain, 'Uncoated FOGRA29');

        const out = await bakePerPage(plain, [1]);

        expect(outputIntents(out)?.size()).toBe(1);
        expect(firstConditionId(out)).toBe('Uncoated FOGRA29');
    });

    it('không ghi đè output intent mà file đích đã tự khai', async () => {
        const src = await makeMultiPageSource(1);
        attachOutputIntent(src, 'Coated FOGRA39');

        const out = await PDFDocument.create();
        attachOutputIntent(out, 'PrynX Preset');
        const transfer = beginOptionalContentTransfer([src]);
        (await out.copyPages(src, [0])).forEach((p) => out.addPage(p));
        finishOptionalContentTransfer(transfer, out);

        expect(firstConditionId(out)).toBe('PrynX Preset');
    });

    it('hai nguồn khác điều kiện in: lấy nguồn đầu, ghi lại xung đột', async () => {
        const a = await makeMultiPageSource(1);
        attachOutputIntent(a, 'Coated FOGRA39');
        const b = await makeMultiPageSource(1);
        attachOutputIntent(b, 'Uncoated FOGRA29');

        const out = await PDFDocument.create();
        const transfer = createOptionalContentTransfer();
        addOptionalContentSource(transfer, a);
        addOptionalContentSource(transfer, b);
        (await out.copyPages(a, [0])).forEach((p) => out.addPage(p));
        (await out.copyPages(b, [0])).forEach((p) => out.addPage(p));
        finishOptionalContentTransfer(transfer, out);

        expect(firstConditionId(out)).toBe('Coated FOGRA39');
        expect(getOutputIntentConflicts(transfer)).toEqual(['Uncoated FOGRA29']);
    });

    it('hai nguồn CÙNG điều kiện in thì không báo xung đột', async () => {
        const a = await makeMultiPageSource(1);
        attachOutputIntent(a, 'Coated FOGRA39');
        const b = await makeMultiPageSource(1);
        attachOutputIntent(b, 'Coated FOGRA39');

        const out = await PDFDocument.create();
        const transfer = createOptionalContentTransfer();
        addOptionalContentSource(transfer, a);
        addOptionalContentSource(transfer, b);
        (await out.copyPages(a, [0])).forEach((p) => out.addPage(p));
        finishOptionalContentTransfer(transfer, out);

        expect(getOutputIntentConflicts(transfer)).toEqual([]);
    });

    it('file không có output intent thì không tự sinh ra', async () => {
        const src = await makeMultiPageSource(1);
        const out = await bakePerPage(src, [1]);
        expect(outputIntents(out)).toBeUndefined();
    });
});
