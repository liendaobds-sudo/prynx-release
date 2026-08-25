/** Object thô từ endpoint edit/preflight, giữ nguyên bbox theo hệ tọa độ nguồn. */
export interface CachedPdfObject {
    id: string;
    type: string;
    bbox: number[];
    xref?: number | null;
    drawIndex?: number;
    content?: string | null;
    ocgIds?: number[];
    ocgNames?: string[];
    matrix?: number[] | null;
    color?: number[] | null;
    fontName?: string | null;
    [key: string]: unknown;
}

type PdfObjectPageMap = Record<number, CachedPdfObject[]>;

export class PdfObjectCache {
    private objectsByFile: Record<string, PdfObjectPageMap> = {};
    private listenersByFile: Record<string, Set<() => void>> = {};

    subscribe = (fileKey: string, listener: () => void) => {
        if (!this.listenersByFile[fileKey]) this.listenersByFile[fileKey] = new Set();
        this.listenersByFile[fileKey].add(listener);
        return () => this.listenersByFile[fileKey].delete(listener);
    }

    notify = (fileKey: string) => {
        if (this.listenersByFile[fileKey]) {
            this.listenersByFile[fileKey].forEach(l => l());
        }
    }

    setPageObjects(fileKey: string, pageNum: number, objs: CachedPdfObject[]) {
        if (!this.objectsByFile[fileKey]) this.objectsByFile[fileKey] = {};
        this.objectsByFile[fileKey][pageNum] = objs;
        this.notify(fileKey);
    }

    setAllObjects(fileKey: string, objMap: PdfObjectPageMap) {
        this.objectsByFile[fileKey] = objMap;
        this.notify(fileKey);
    }

    getPageObjects(fileKey: string, pageNum: number) {
        return this.objectsByFile[fileKey]?.[pageNum] || [];
    }

    getAllObjects(fileKey: string) {
        return this.objectsByFile[fileKey] || {};
    }

    clear(fileKey: string) {
        if (this.objectsByFile[fileKey]) {
            delete this.objectsByFile[fileKey];
            this.notify(fileKey);
        }
    }
}

export const globalPdfObjectCache = new PdfObjectCache();
