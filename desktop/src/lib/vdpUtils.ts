export type VdpSortMethod = 'rows' | 'cols' | 'ushape' | 'clockwise';

export const sortFieldsGeometrically = (fields: any[], method: VdpSortMethod) => {
    const tolerance = 5; // 5mm tolerance for snapping to rows/cols

    // Null-guard: đảm bảo mọi field có .position (fallback từ x/y) để tránh crash
    // khi được gọi với field chỉ mang toạ độ phẳng x/y.
    fields = (fields || []).map(f =>
        f && f.position && typeof f.position.x === 'number'
            ? f
            : { ...f, position: { x: f?.x ?? 0, y: f?.y ?? 0 } }
    );

    if (method === 'ushape') {
        if (fields.length < 3) return [...fields];
        const sortedByX = [...fields].sort((a, b) => a.position.x - b.position.x);
        const columns: any[][] = [];
        let currentColumn = [sortedByX[0]];
        for (let i = 1; i < sortedByX.length; i++) {
            if (Math.abs(sortedByX[i].position.x - currentColumn[0].position.x) <= tolerance) {
                currentColumn.push(sortedByX[i]);
            } else {
                columns.push(currentColumn);
                currentColumn = [sortedByX[i]];
            }
        }
        columns.push(currentColumn);

        for (let j = 0; j < columns.length; j++) {
            columns[j].sort((a, b) => a.position.y - b.position.y);
        }

        if (columns.length < 2) return [...fields];

        const leftColumn = columns[0];
        const rightColumn = columns[columns.length - 1];
        const bottomMostY = Math.max(...fields.map(item => item.position.y));
        const bottomItems = fields.filter(item => Math.abs(item.position.y - bottomMostY) <= tolerance * 2);
        bottomItems.sort((a, b) => a.position.x - b.position.x);

        const finalSortedArray: any[] = [];
        const processedIds = new Set();
        const add = (item: any) => {
            if (!processedIds.has(item.id)) {
                processedIds.add(item.id);
                finalSortedArray.push(item);
            }
        };

        for (let m = 0; m < leftColumn.length; m++) {
            if (!bottomItems.find(b => b.id === leftColumn[m].id)) add(leftColumn[m]);
        }
        for (let n = 0; n < bottomItems.length; n++) add(bottomItems[n]);
        for (let p = rightColumn.length - 1; p >= 0; p--) add(rightColumn[p]);
        for (let i = 0; i < fields.length; i++) add(fields[i]);
        return finalSortedArray;
    }

    if (method === 'clockwise') {
        if (fields.length < 2) return [...fields];
        let minX = fields[0].position.x, maxX = fields[0].position.x;
        let minY = fields[0].position.y, maxY = fields[0].position.y;
        for (let i = 1; i < fields.length; i++) {
            const { x, y } = fields[i].position;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }

        const topRow: any[] = [], rightCol: any[] = [], bottomRow: any[] = [], leftCol: any[] = [], middleItems: any[] = [];
        for (let i = 0; i < fields.length; i++) {
            const item = fields[i];
            const { x, y } = item.position;
            if (Math.abs(y - minY) <= tolerance) topRow.push(item);
            else if (Math.abs(y - maxY) <= tolerance) bottomRow.push(item);
            else if (Math.abs(x - minX) <= tolerance) leftCol.push(item);
            else if (Math.abs(x - maxX) <= tolerance) rightCol.push(item);
            else middleItems.push(item);
        }

        topRow.sort((a, b) => a.position.x - b.position.x);
        rightCol.sort((a, b) => a.position.y - b.position.y);
        bottomRow.sort((a, b) => b.position.x - a.position.x);
        leftCol.sort((a, b) => b.position.y - a.position.y);

        return [...topRow, ...rightCol, ...bottomRow, ...leftCol, ...middleItems];
    }

    const copy = [...fields];
    if (method === 'rows') {
        copy.sort((a, b) => {
            if (Math.abs(a.position.y - b.position.y) > tolerance) return a.position.y - b.position.y;
            return a.position.x - b.position.x;
        });
    } else if (method === 'cols') {
        copy.sort((a, b) => {
            if (Math.abs(a.position.x - b.position.x) > tolerance) return a.position.x - b.position.x;
            return a.position.y - b.position.y;
        });
    }
    return copy;
};

// ─── Multi-up: gộp nhiều slot lên một trang, mỗi slot lấy một record khác nhau ───
//
// Với engine VDP, MỘT trang = MỘT record. Multi-up nhồi N record vào N slot trên
// cùng trang, nên phải namespace MỌI cột theo slot (`Cot_slotN`) để field ở slot
// khác nhau không giẫm dữ liệu của nhau, rồi remap TẤT CẢ tham chiếu cột —
// placeholder trong textContent/rule.result, và cột trong conditions/rules — sang
// khoá slot tương ứng. Nếu chỉ remap tên field (bug cũ) thì điều kiện ẩn/hiện và
// bảng rule (tham chiếu cột gốc) trỏ vào cột không tồn tại trong record trang →
// ConditionError/MISSING trên mọi bản ghi.
export function buildMultiUpJobInput(
    vdpFields: any[],
    csvHeaders: string[],
    sourceData: Record<string, string>[],
): { fields: any[]; data: Record<string, string>[] } {
    const slots: any[] = [];
    const groupMap = new Map<string, any[]>();
    vdpFields.forEach(f => {
        if (f.groupId) {
            if (!groupMap.has(f.groupId)) groupMap.set(f.groupId, []);
            groupMap.get(f.groupId)!.push(f);
        } else {
            slots.push({ ...f, isSlot: true, fields: [f] });
        }
    });
    groupMap.forEach((fieldsInGroup, groupId) => {
        let minX = fieldsInGroup[0].x || fieldsInGroup[0].position?.x;
        let minY = fieldsInGroup[0].y || fieldsInGroup[0].position?.y;
        fieldsInGroup.forEach(f => {
            const fx = f.x || f.position?.x;
            const fy = f.y || f.position?.y;
            if (fx < minX) minX = fx;
            if (fy < minY) minY = fy;
        });
        slots.push({ id: `slot_${groupId}`, name: `Group_${groupId}`, position: { x: minX, y: minY }, isSlot: true, fields: fieldsInGroup });
    });
    slots.forEach(s => { if (!s.position) s.position = { x: s.x, y: s.y }; });
    const sortedSlots = sortFieldsGeometrically(slots, 'rows');
    const numSlots = sortedSlots.length;
    const totalPages = Math.ceil(sourceData.length / numSlots);

    const sourceCols = csvHeaders.length
        ? csvHeaders
        : Array.from(sourceData.reduce((set, r) => {
            Object.keys(r || {}).forEach(k => set.add(k));
            return set;
        }, new Set<string>()));

    // Tập cột cần namespace: cột nguồn + tên field (fallback {name}) + cột trong
    // điều kiện/rule (phòng khi người dùng tham chiếu cột chưa có trong header).
    const refCols = new Set<string>(sourceCols);
    sortedSlots.forEach((sl: any) => sl.fields.forEach((f: any) => {
        if (f.name) refCols.add(f.name);
        (f.conditions || []).forEach((c: any) => { if (c.column) refCols.add(c.column); });
        (f.rules || []).forEach((r: any) => { if (r.column) refCols.add(r.column); });
    }));
    // Remap tên cột DÀI trước NGẮN để không khớp một phần tên cột lồng nhau.
    const refColList = Array.from(refCols).sort((a, b) => b.length - a.length);

    const skey = (col: string, s: number) => `${col}_slot${s}`;
    // Remap token cột trong văn bản: {Cot}, {Cot[..]}, {Cot|func}, {Cot?A:B}.
    // Lookahead giới hạn ký tự ngay sau tên cột (} [ | ?) để không đụng nhánh
    // literal của token điều kiện hay khớp tên cột là tiền tố của cột khác.
    const remapText = (text: string | undefined | null, s: number): string | undefined | null => {
        if (!text) return text;
        let out = text;
        for (const col of refColList) {
            const esc = col.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            out = out.replace(new RegExp(`\\{${esc}(?=[}\\[|?])`, 'g'), `{${skey(col, s)}`);
        }
        return out;
    };

    const multiUpVdpFields: any[] = [];
    for (let s = 0; s < numSlots; s++) {
        sortedSlots[s].fields.forEach((originalField: any) => {
            // Nội dung gốc: textContent, mặc định {name} như engine backend.
            const baseContent = originalField.textContent ?? `{${originalField.name}}`;
            const remapped: any = {
                ...originalField,
                name: `${originalField.name}_slot${s}`,
                textContent: remapText(baseContent, s),
            };
            if (Array.isArray(originalField.conditions)) {
                remapped.conditions = originalField.conditions.map((c: any) => ({
                    ...c, column: skey(c.column, s),
                }));
            }
            if (Array.isArray(originalField.rules)) {
                remapped.rules = originalField.rules.map((r: any) => ({
                    ...r, column: skey(r.column, s), result: remapText(r.result, s),
                }));
            }
            multiUpVdpFields.push(remapped);
        });
    }
    const data: Record<string, string>[] = [];
    for (let p = 0; p < totalPages; p++) {
        const pageRow: Record<string, string> = {};
        for (let s = 0; s < numSlots; s++) {
            const rowIndex = p * numSlots + s;
            const srcRow = sourceData[rowIndex] || {};
            // Copy MỌI cột tham chiếu vào khoá slot (kể cả cột điều kiện/rule),
            // để mọi tham chiếu đã remap ở trên đều tìm thấy giá trị.
            for (const col of refColList) {
                pageRow[skey(col, s)] = srcRow[col] ?? '';
            }
        }
        data.push(pageRow);
    }
    return { fields: multiUpVdpFields, data };
}
