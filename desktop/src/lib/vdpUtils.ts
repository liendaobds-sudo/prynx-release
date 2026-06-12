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
