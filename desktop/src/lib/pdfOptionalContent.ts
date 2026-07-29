// [OCG FIX 2026-07-28] Giữ optional content (layer PDF) qua mọi lần ghi lại file bằng pdf-lib.
//
// VÌ SAO CẦN FILE NÀY
// pdf-lib `PDFDocument.create()` + `copyPages()` copy nội dung trang kèm
// `/Resources/Properties` (tức các dict OCG), nhưng KHÔNG copy `/OCProperties` ở
// document catalog. Hậu quả: content stream vẫn còn `/OC /MC0 BDC … EMC` mà không
// còn cấu hình optional content nào để biết layer nào đang tắt → PDFium, Acrobat và
// máy ghi kẽm đều VẼ HẾT. Layer thợ đã ẩn trong Illustrator (ghi chú nội bộ, bản nháp,
// lớp kiểm tra) lọt vào bản in. Đây là lỗi fail-open: sai về đúng cái chiều nguy hiểm.
//
// CÁCH LÀM
// Không thể copy `/OCProperties` sang tài liệu mới bằng cách copy trực tiếp: mỗi lần
// pdf-lib copy là một `PDFObjectCopier` mới, nên OCG copy lần hai sẽ là object KHÁC
// với object mà content stream đang trỏ tới → `/OCGs` liệt kê nhầm object, vẫn lộ.
// Nên: đóng dấu định danh lên từng OCG ở file NGUỒN trước khi copy (dấu đi theo object
// khi được copy), rồi quét file MỚI tìm lại dấu để biết ref nào ứng với OCG nào.
//
// Trạng thái ẩn/hiện được chuẩn hoá về dạng tường minh (`/BaseState /ON` + `/OFF`):
// nguồn có thể khai bằng `/BaseState /OFF`, bằng `/OFF`, hoặc bằng `/Usage` + `/AS`;
// gộp về một dạng giúp ghép nhiều file nguồn có cách khai khác nhau vẫn ra kết quả
// nhất quán, và mọi renderer đọc ra cùng một trạng thái.
//
// `/AS` được giữ lại (đã remap): nó điều khiển lớp "hiện trên màn hình nhưng KHÔNG in"
// — bỏ đi là lớp không-in sẽ được in.
//
// ĐỪNG "SỬA" BỐN CA SAU — ĐÃ ĐO, PDFIUM ĐANG ĐÚNG (2026-07-28)
// Bốn hình dạng file dưới đây khiến nội dung *trông như* đáng lẽ bị ẩn mà vẫn được
// vẽ. Đã dựng file mẫu và mở bằng **Acrobat thật**: Acrobat CŨNG vẽ, y hệt PDFium.
// Nên đây là hành vi đúng, không phải lỗ hổng:
//
//   1. Lớp CHA nằm trong `/OFF`, content gate bởi OCG CON đang ON.
//      `/Order` chỉ quy định cách TRÌNH BÀY trên giao diện; hiển thị quyết định
//      theo từng OCG. Acrobat lan truyền khi người dùng BẤM con mắt lớp cha, nhưng
//      trạng thái đã lưu trong file mới là thứ quyết định lúc mở.
//   2. OCG có trong `/D/OFF` nhưng `/OCProperties/OCGs` không liệt kê nó.
//   3. Trạng thái ẩn chỉ nằm trong `/Configs`, `/D` không khai (`/D` là cấu hình
//      mặc định; `/Configs` chỉ là các cấu hình thay thế).
//   4. `/OFF` chứa dict OCG viết TRỰC TIẾP thay vì tham chiếu gián tiếp — nó không
//      trỏ tới object mà content đang dùng nên không renderer nào khớp được.
//
// Thêm lan truyền cha→con, hay tự suy diễn trạng thái ẩn cho ba ca còn lại, sẽ làm
// PrynX ẩn nội dung mà Acrobat IN RA — sai ngược chiều và cũng chết người. Muốn đổi
// kết luận này thì phải đo lại bằng Acrobat trước, đừng suy luận suông.
// File mẫu dựng lại được bằng `tmp/ocg_probe.py` và `tmp/ocg_probe2.py`.
//
// FILE NÀY CÒN MANG THEO `/OutputIntents`
// Tên file nói "optional content" nhưng nó cũng lo output intent (ICC đích của bản
// in). Cố ý gộp: lượt chuyển này đã chảy qua MỌI đường ghi lại file bằng pdf-lib,
// nên gộp vào đây thì call site mới tự động được bảo vệ. Tách thành hàm riêng thì
// chỗ nào quên gọi là mất output intent trong im lặng — đúng loại lỗi đang dẹp.
// Xem `carryOutputIntents` ở cuối file.

import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFName,
    PDFObject,
    PDFObjectCopier,
    PDFRef,
} from 'pdf-lib';

const K_OCPROPERTIES = PDFName.of('OCProperties');
const K_OCGS = PDFName.of('OCGs');
const K_D = PDFName.of('D');
const K_ON = PDFName.of('ON');
const K_OFF = PDFName.of('OFF');
const K_ORDER = PDFName.of('Order');
const K_LOCKED = PDFName.of('Locked');
const K_BASESTATE = PDFName.of('BaseState');
const K_AS = PDFName.of('AS');
const K_EVENT = PDFName.of('Event');
const K_CATEGORY = PDFName.of('Category');
const K_USAGE = PDFName.of('Usage');
const K_VIEW = PDFName.of('View');
const K_VIEWSTATE = PDFName.of('ViewState');
const K_OC = PDFName.of('OC');
const K_RESOURCES = PDFName.of('Resources');
const K_PROPERTIES = PDFName.of('Properties');
const K_XOBJECT = PDFName.of('XObject');
const K_ANNOTS = PDFName.of('Annots');
const K_TYPE = PDFName.of('Type');
const K_OUTPUTINTENTS = PDFName.of('OutputIntents');
const K_OUTPUTCONDITIONIDENTIFIER = PDFName.of('OutputConditionIdentifier');

/** Dấu tạm đóng lên OCG nguồn để nhận lại sau khi pdf-lib copy. Luôn được xoá ở cuối. */
const K_STAMP = PDFName.of('PrynXOcgStamp');

/** Trần độ sâu khi lần theo Form XObject lồng nhau — chặn file dựng vòng làm treo. */
const MAX_XOBJECT_DEPTH = 12;

/** `PDFName.asString()` trả kèm dấu `/` — bỏ đi để so khoá với giá trị dấu đã lưu. */
function nameToKey(name: PDFName | undefined): string | undefined {
    return name?.asString().replace(/^\//, '');
}

interface StampedOcg {
    stamp: string;
    /** Ẩn theo cấu hình xem mặc định `/D` của file nguồn. */
    hidden: boolean;
    locked: boolean;
}

type OrderNode =
    | { kind: 'ocg'; stamp: string }
    | { kind: 'label'; text: string }
    | { kind: 'group'; items: OrderNode[] };

interface AutoStateNode {
    event: string;
    categories: string[];
    stamps: string[];
}

/** `/OutputIntents` của nguồn đầu tiên có khai, chờ mang sang file đích. */
interface CarriedOutputIntents {
    source: PDFDocument;
    array: PDFArray;
}

/** Ảnh chụp optional content của các file nguồn, chờ dựng lại ở file đích. */
export interface OptionalContentTransfer {
    ocgs: StampedOcg[];
    order: OrderNode[];
    autoStates: AutoStateNode[];
    /** Các dict đã bị đóng dấu, để xoá dấu khi xong. */
    stampedDicts: PDFDict[];
    outputIntents?: CarriedOutputIntents;
    /**
     * Định danh điều kiện in của nguồn khác, KHÁC với nguồn đầu tiên. Không tự
     * chọn hộ người dùng; caller đọc qua `getOutputIntentConflicts` để cảnh báo.
     */
    outputIntentConflicts: string[];
}

/**
 * Đếm toàn cục cho tiền tố dấu. Ghép file nạp nguồn ở nhiều thời điểm khác nhau nên
 * không thể lấy chỉ số theo mảng — hai nguồn cùng tiền tố sẽ tráo layer của nhau.
 */
let stampSequence = 0;

/** Mở một lượt chuyển rỗng, rồi cộng dồn từng nguồn bằng `addOptionalContentSource`. */
export function createOptionalContentTransfer(): OptionalContentTransfer {
    return {
        ocgs: [], order: [], autoStates: [], stampedDicts: [],
        outputIntentConflicts: [],
    };
}

/** Định danh điều kiện in (vd "Coated FOGRA39") để so trùng giữa các nguồn. */
function outputIntentIds(arr: PDFArray): string[] {
    const ids: string[] = [];
    for (let i = 0; i < arr.size(); i += 1) {
        const entry = arr.lookupMaybe(i, PDFDict);
        const raw = entry?.get(K_OUTPUTCONDITIONIDENTIFIER) as
            unknown as { decodeText?: () => string } | undefined;
        const id = raw?.decodeText?.();
        if (id) ids.push(id);
    }
    return ids;
}

/**
 * Ghi nhận `/OutputIntents` của một nguồn.
 *
 * KHÔNG gộp nhiều nguồn: PDF/X chỉ cho phép MỘT output intent cho cả tài liệu, và
 * hai file có điều kiện in khác nhau là xung đột thật của bài in, không phải thứ
 * máy tự hoà giải được. Lấy của nguồn đầu tiên có khai, ghi lại phần khác biệt.
 */
function recordOutputIntents(transfer: OptionalContentTransfer, src: PDFDocument): void {
    let arr: PDFArray | undefined;
    try {
        arr = src.catalog.lookupMaybe(K_OUTPUTINTENTS, PDFArray);
    } catch {
        return; // catalog lạ: bỏ qua, không làm hỏng cả lượt copy
    }
    if (!arr || arr.size() === 0) return;

    if (!transfer.outputIntents) {
        transfer.outputIntents = { source: src, array: arr };
        return;
    }

    const first = outputIntentIds(transfer.outputIntents.array);
    outputIntentIds(arr).forEach((id) => {
        if (first.includes(id)) return;
        if (transfer.outputIntentConflicts.includes(id)) return;
        transfer.outputIntentConflicts.push(id);
    });
}

/**
 * Điều kiện in của các nguồn bị bỏ qua vì khác với nguồn đầu tiên.
 * Rỗng = không xung đột. Caller nên cảnh báo cho thợ khi mảng này không rỗng.
 */
export function getOutputIntentConflicts(
    transfer: OptionalContentTransfer,
): readonly string[] {
    return transfer.outputIntentConflicts;
}

/**
 * Mang `/OutputIntents` sang file đích.
 *
 * VÌ SAO: output intent khai không gian màu ĐÍCH của bản in (vd Coated FOGRA39) kèm
 * profile ICC nhúng. pdf-lib `create()` không copy nó, nên mỗi lần PrynX ghi lại file
 * là mất — file hết đạt PDF/X, soft-proof và RIP mất mốc quy đổi màu. Đo thật
 * 2026-07-28: bake thứ tự trang xong `/OutputIntents` = MẤT HẲN.
 *
 * Dùng copier riêng là an toàn: khác OCG, không có gì trong content stream trỏ tới
 * output intent, nên không có chuyện ref lệch nhau như bug OCG.
 */
function carryOutputIntents(
    transfer: OptionalContentTransfer,
    target: PDFDocument,
): void {
    const carried = transfer.outputIntents;
    if (!carried) return;
    // Đích đã tự khai output intent (vd luồng xuất PDF/X) → tôn trọng, không ghi đè.
    try {
        if (target.catalog.lookupMaybe(K_OUTPUTINTENTS, PDFArray)) return;
    } catch {
        return;
    }
    const copier = PDFObjectCopier.for(carried.source.context, target.context);
    target.catalog.set(K_OUTPUTINTENTS, copier.copy(carried.array));
}

function isEmptyTransfer(t: OptionalContentTransfer): boolean {
    return t.ocgs.length === 0;
}

function refTagsOf(container: PDFDict | undefined, key: PDFName): Set<string> {
    const tags = new Set<string>();
    const arr = container?.lookupMaybe(key, PDFArray);
    if (!arr) return tags;
    for (let i = 0; i < arr.size(); i += 1) {
        const item = arr.get(i);
        if (item instanceof PDFRef) tags.add(item.tag);
    }
    return tags;
}

/**
 * Ẩn theo `/Usage` chỉ tính khi `/AS` có mục Event /View trỏ tới OCG đó — đúng theo
 * spec. Tự suy diễn từ `/Usage` khi không có `/AS` sẽ ẩn nhiều hơn Acrobat.
 */
function usageHiddenTags(doc: PDFDocument, config: PDFDict | undefined): Set<string> {
    const hidden = new Set<string>();
    const asArr = config?.lookupMaybe(K_AS, PDFArray);
    if (!asArr) return hidden;
    for (let i = 0; i < asArr.size(); i += 1) {
        const entry = asArr.lookupMaybe(i, PDFDict);
        if (!entry) continue;
        if (entry.lookupMaybe(K_EVENT, PDFName)?.asString() !== '/View') continue;
        const ocgArr = entry.lookupMaybe(K_OCGS, PDFArray);
        if (!ocgArr) continue;
        for (let j = 0; j < ocgArr.size(); j += 1) {
            const ref = ocgArr.get(j);
            if (!(ref instanceof PDFRef)) continue;
            const state = doc.context
                .lookupMaybe(ref, PDFDict)
                ?.lookupMaybe(K_USAGE, PDFDict)
                ?.lookupMaybe(K_VIEW, PDFDict)
                ?.lookupMaybe(K_VIEWSTATE, PDFName)
                ?.asString();
            if (state === '/OFF') hidden.add(ref.tag);
        }
    }
    return hidden;
}

function readOrder(
    arr: PDFArray | undefined,
    doc: PDFDocument,
    stampByRefTag: Map<string, string>,
): OrderNode[] {
    const nodes: OrderNode[] = [];
    if (!arr) return nodes;
    for (let i = 0; i < arr.size(); i += 1) {
        const raw = arr.get(i);
        if (raw instanceof PDFRef) {
            const stamp = stampByRefTag.get(raw.tag);
            if (stamp) nodes.push({ kind: 'ocg', stamp });
            continue;
        }
        const nested = arr.lookupMaybe(i, PDFArray);
        if (nested) {
            nodes.push({ kind: 'group', items: readOrder(nested, doc, stampByRefTag) });
            continue;
        }
        // Nhãn nhóm dạng chuỗi: giữ nguyên để cây layer trong Acrobat không mất tiêu đề.
        const text = (raw as unknown as { decodeText?: () => string })?.decodeText?.();
        if (typeof text === 'string') nodes.push({ kind: 'label', text });
    }
    return nodes;
}

/**
 * Đóng dấu OCG của MỘT file nguồn và ghi lại trạng thái ẩn/hiện vào lượt chuyển.
 * Gọi TRƯỚC khi `copyPages`/`embedPages` từ nguồn đó.
 */
export function addOptionalContentSource(
    transfer: OptionalContentTransfer,
    src: PDFDocument,
): void {
    // TRƯỚC mọi lần thoát sớm bên dưới: file không có layer vẫn có thể có output
    // intent, bỏ qua ở đây là mất ICC đích của bản in.
    recordOutputIntents(transfer, src);

    let ocProps: PDFDict | undefined;
    try {
        ocProps = src.catalog.lookupMaybe(K_OCPROPERTIES, PDFDict);
    } catch {
        return; // catalog lạ: bỏ qua file này, không làm hỏng cả lượt copy
    }
    if (!ocProps) return;

    const config = ocProps.lookupMaybe(K_D, PDFDict);
    const baseStateOff = config?.lookupMaybe(K_BASESTATE, PDFName)?.asString() === '/OFF';
    const onTags = refTagsOf(config, K_ON);
    const offTags = refTagsOf(config, K_OFF);
    const lockedTags = refTagsOf(config, K_LOCKED);
    const usageOffTags = usageHiddenTags(src, config);

    const ocgsArr = ocProps.lookupMaybe(K_OCGS, PDFArray);
    const stampByRefTag = new Map<string, string>();
    const prefix = `s${stampSequence += 1}`;

    for (let i = 0; ocgsArr && i < ocgsArr.size(); i += 1) {
        const ref = ocgsArr.get(i);
        // OCG phải là object gián tiếp mới tham chiếu lại được sau khi copy.
        if (!(ref instanceof PDFRef)) continue;
        const dict = src.context.lookupMaybe(ref, PDFDict);
        if (!dict) continue;

        // `/OFF` thắng khi file dựng sai (cùng OCG nằm ở cả /ON và /OFF) — an toàn hơn.
        const hidden = offTags.has(ref.tag)
            || usageOffTags.has(ref.tag)
            || (baseStateOff && !onTags.has(ref.tag));

        const stamp = `${prefix}_${i}`;
        dict.set(K_STAMP, PDFName.of(stamp));
        transfer.stampedDicts.push(dict);
        stampByRefTag.set(ref.tag, stamp);
        transfer.ocgs.push({ stamp, hidden, locked: lockedTags.has(ref.tag) });
    }

    if (stampByRefTag.size === 0) return;

    transfer.order.push(
        ...readOrder(config?.lookupMaybe(K_ORDER, PDFArray), src, stampByRefTag),
    );

    // `/AS` giữ mọi Event (View/Print/Export). Bỏ nó là lớp khai "không in" sẽ bị in.
    const asArr = config?.lookupMaybe(K_AS, PDFArray);
    for (let i = 0; asArr && i < asArr.size(); i += 1) {
        const entry = asArr.lookupMaybe(i, PDFDict);
        const event = entry?.lookupMaybe(K_EVENT, PDFName)?.asString();
        if (!entry || !event) continue;
        const stamps: string[] = [];
        const ocgArr = entry.lookupMaybe(K_OCGS, PDFArray);
        for (let j = 0; ocgArr && j < ocgArr.size(); j += 1) {
            const ref = ocgArr.get(j);
            if (!(ref instanceof PDFRef)) continue;
            const stamp = stampByRefTag.get(ref.tag);
            if (stamp) stamps.push(stamp);
        }
        if (stamps.length === 0) continue;
        const categories: string[] = [];
        const catArr = entry.lookupMaybe(K_CATEGORY, PDFArray);
        for (let j = 0; catArr && j < catArr.size(); j += 1) {
            const cat = catArr.lookupMaybe(j, PDFName)?.asString();
            if (cat) categories.push(cat.replace(/^\//, ''));
        }
        transfer.autoStates.push({
            event: event.replace(/^\//, ''), categories, stamps,
        });
    }
}

/**
 * Bước 1: đóng dấu OCG ở các file nguồn và ghi lại trạng thái ẩn/hiện.
 * Gọi TRƯỚC khi `copyPages`.
 */
export function beginOptionalContentTransfer(
    sources: readonly PDFDocument[],
): OptionalContentTransfer {
    const transfer = createOptionalContentTransfer();
    sources.forEach((src) => addOptionalContentSource(transfer, src));
    return transfer;
}

/**
 * Quét file đích tìm lại các dict còn dấu → map dấu sang MỌI ref mang dấu đó.
 *
 * Vì sao là DANH SÁCH ref chứ không phải một ref: nhiều call site gọi `copyPages`
 * một lần cho MỖI trang (vòng lặp bake thứ tự trang, nhân bản trang, tách file).
 * pdf-lib tạo `PDFObjectCopier` mới mỗi lần gọi, nên mỗi lần copy sinh ra một BẢN
 * OCG riêng dù file nguồn chỉ có một. Nếu chỉ đăng ký bản ĐẦU TIÊN thì các bản còn
 * lại thành OCG không có trong `/OCGs` → PDFium bỏ qua trạng thái tắt và VẼ HẾT:
 * bug lộ layer quay lại từ trang thứ hai trở đi. Đo thật 2026-07-28: file 1 layer ẩn
 * bake qua 4 vị trí ra 6 object OCG mà chỉ 2 được đăng ký, 2/4 trang lộ nội dung.
 */
function findStampedRefs(doc: PDFDocument): Map<string, PDFRef[]> {
    const byStamp = new Map<string, PDFRef[]>();
    const seenXObjects = new Set<string>();

    const noteRef = (candidate: PDFObject | undefined) => {
        if (!(candidate instanceof PDFRef)) return;
        const dict = doc.context.lookupMaybe(candidate, PDFDict);
        if (!dict) return;
        const stamp = nameToKey(dict.lookupMaybe(K_STAMP, PDFName));
        if (stamp) {
            const found = byStamp.get(stamp);
            if (!found) byStamp.set(stamp, [candidate]);
            // Cùng một ref gặp lại qua nhiều trang dùng chung /Resources → chỉ ghi một lần.
            else if (!found.some((ref) => ref.tag === candidate.tag)) found.push(candidate);
            return;
        }
        // OCMD: nội dung gate qua OCMD, OCG thật nằm trong `/OCGs` của nó.
        if (dict.lookupMaybe(K_TYPE, PDFName)?.asString() !== '/OCMD') return;
        const inner = dict.get(K_OCGS);
        if (inner instanceof PDFRef) {
            noteRef(inner);
            return;
        }
        const innerArr = dict.lookupMaybe(K_OCGS, PDFArray);
        for (let i = 0; innerArr && i < innerArr.size(); i += 1) noteRef(innerArr.get(i));
    };

    const walkResources = (resources: PDFDict | undefined, depth: number) => {
        if (!resources || depth > MAX_XOBJECT_DEPTH) return;

        const properties = resources.lookupMaybe(K_PROPERTIES, PDFDict);
        properties?.keys().forEach((key) => noteRef(properties.get(key)));

        const xobjects = resources.lookupMaybe(K_XOBJECT, PDFDict);
        xobjects?.keys().forEach((key) => {
            const ref = xobjects.get(key);
            if (ref instanceof PDFRef) {
                if (seenXObjects.has(ref.tag)) return;
                seenXObjects.add(ref.tag);
            }
            const xobj = xobjects.lookupMaybe(key, PDFDict);
            if (!xobj) return;
            noteRef(xobj.get(K_OC));
            // Form XObject có `/Resources` riêng, Illustrator lồng layer khá sâu ở đây.
            walkResources(xobj.lookupMaybe(K_RESOURCES, PDFDict), depth + 1);
        });
    };

    doc.getPages().forEach((page) => {
        const node = page.node;
        noteRef(node.get(K_OC));
        walkResources(node.lookupMaybe(K_RESOURCES, PDFDict), 0);
        const annots = node.lookupMaybe(K_ANNOTS, PDFArray);
        for (let i = 0; annots && i < annots.size(); i += 1) {
            noteRef(annots.lookupMaybe(i, PDFDict)?.get(K_OC));
        }
    });

    return byStamp;
}

function buildOrderArray(
    nodes: OrderNode[],
    doc: PDFDocument,
    refByStamp: Map<string, PDFRef[]>,
): PDFArray {
    const arr = PDFArray.withContext(doc.context);
    nodes.forEach((node) => {
        if (node.kind === 'ocg') {
            // Cây layer chỉ cần MỘT mục cho mỗi layer nguồn, dù nội dung được copy
            // thành nhiều bản. Các bản còn lại vẫn nằm trong /OCGs + /OFF nên vẫn
            // bị tắt đúng, chỉ không hiện trùng tên trong panel layer.
            const ref = refByStamp.get(node.stamp)?.[0];
            if (ref) arr.push(ref);
            return;
        }
        if (node.kind === 'label') {
            arr.push(doc.context.obj(node.text));
            return;
        }
        const nested = buildOrderArray(node.items, doc, refByStamp);
        if (nested.size() > 0) arr.push(nested);
    });
    return arr;
}

/**
 * Bước 2: dựng lại `/OCProperties` + mang `/OutputIntents` sang file đích, rồi xoá
 * hết dấu. Gọi SAU khi đã `copyPages`/`addPage` xong, TRƯỚC khi `save()`.
 *
 * @returns số mục đã đăng ký vào `/OCGs` (0 nghĩa là nguồn vốn không có layer).
 *   Lưu ý: khi trang được copy từng lần một, một layer nguồn có thể sinh nhiều bản
 *   nên số này ≥ số layer của file nguồn.
 */
export function finishOptionalContentTransfer(
    transfer: OptionalContentTransfer,
    target: PDFDocument,
): number {
    try {
        // Chạy TRƯỚC lần thoát sớm dưới: file không có layer vẫn cần output intent.
        carryOutputIntents(transfer, target);

        if (isEmptyTransfer(transfer)) return 0;

        const refByStamp = findStampedRefs(target);
        if (refByStamp.size === 0) return 0;

        const context = target.context;
        const ocgsArr = PDFArray.withContext(context);
        const onArr = PDFArray.withContext(context);
        const offArr = PDFArray.withContext(context);
        const lockedArr = PDFArray.withContext(context);

        transfer.ocgs.forEach((entry) => {
            const refs = refByStamp.get(entry.stamp);
            // OCG không trang nào dùng thì không copy sang — bỏ khỏi catalog là đúng.
            if (!refs || refs.length === 0) return;
            // ĐĂNG KÝ MỌI BẢN, không chỉ bản đầu: bản nào sót ngoài /OCGs là bản đó
            // được vẽ bất chấp trạng thái tắt (xem chú thích ở findStampedRefs).
            refs.forEach((ref) => {
                ocgsArr.push(ref);
                (entry.hidden ? offArr : onArr).push(ref);
                if (entry.locked) lockedArr.push(ref);
            });
        });

        if (ocgsArr.size() === 0) return 0;

        const config = context.obj({}) as PDFDict;
        // Chuẩn hoá về BaseState /ON + liệt kê tường minh: nguồn khai kiểu nào cũng ra
        // một dạng duy nhất, ghép nhiều file nguồn không xung đột.
        config.set(K_BASESTATE, PDFName.of('ON'));
        config.set(K_ON, onArr);
        config.set(K_OFF, offArr);
        if (lockedArr.size() > 0) config.set(K_LOCKED, lockedArr);

        const orderArr = buildOrderArray(transfer.order, target, refByStamp);
        // Không có `/Order` thì Acrobat vẫn hiện layer, nhưng mất cây phân cấp.
        config.set(K_ORDER, orderArr.size() > 0 ? orderArr : ocgsArr);

        const asArr = PDFArray.withContext(context);
        transfer.autoStates.forEach((node) => {
            // Liệt kê mọi bản copy: lớp khai "không in" phải không-in ở TẤT CẢ các trang.
            const stampRefs = node.stamps.flatMap((s) => refByStamp.get(s) ?? []);
            if (stampRefs.length === 0) return;
            const entry = context.obj({}) as PDFDict;
            entry.set(K_EVENT, PDFName.of(node.event));
            const ocgList = PDFArray.withContext(context);
            stampRefs.forEach((r) => ocgList.push(r));
            entry.set(K_OCGS, ocgList);
            if (node.categories.length > 0) {
                const catList = PDFArray.withContext(context);
                node.categories.forEach((c) => catList.push(PDFName.of(c)));
                entry.set(K_CATEGORY, catList);
            }
            asArr.push(entry);
        });
        if (asArr.size() > 0) config.set(K_AS, asArr);

        const ocProps = context.obj({}) as PDFDict;
        ocProps.set(K_OCGS, ocgsArr);
        ocProps.set(K_D, config);
        target.catalog.set(K_OCPROPERTIES, ocProps);

        // Xoá dấu ở file đích (dấu đã theo object copy sang), kể cả các bản trùng.
        refByStamp.forEach((refs) => {
            refs.forEach((ref) => context.lookupMaybe(ref, PDFDict)?.delete(K_STAMP));
        });
        return ocgsArr.size();
    } finally {
        // Dù dựng lại thành công hay không, file nguồn phải sạch dấu.
        transfer.stampedDicts.forEach((dict) => dict.delete(K_STAMP));
        transfer.stampedDicts.length = 0;
    }
}

/**
 * Bọc gọn một lượt ghi lại file: tự đóng dấu, chạy `build`, rồi dựng lại layer.
 * Dùng cho các chỗ chỉ cần "copy trang sang tài liệu mới mà không mất layer".
 */
export async function withOptionalContent<T>(
    sources: readonly PDFDocument[],
    target: PDFDocument,
    build: () => Promise<T>,
): Promise<T> {
    const transfer = beginOptionalContentTransfer(sources);
    try {
        const result = await build();
        finishOptionalContentTransfer(transfer, target);
        return result;
    } catch (err) {
        finishOptionalContentTransfer(transfer, target);
        throw err;
    }
}
