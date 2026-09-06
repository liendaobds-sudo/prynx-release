/** UNIFIED (2026-09-06): receiver theo tab đang xem, không suy từ launch intent. */
const receivers = new Map<string, (files: readonly File[]) => boolean>();

export function registerStickerIncomingSource(tabId: string, receive: (files: readonly File[]) => boolean): () => void {
    receivers.set(tabId, receive);
    return () => { if (receivers.get(tabId) === receive) receivers.delete(tabId); };
}

export function deliverStickerIncomingSource(tabId: string, files: readonly File[]): boolean {
    if (!files.length || files.some(file => !/\.(pdf|png|jpe?g|webp|bmp|tiff?)$/i.test(file.name))) return false;
    return receivers.get(tabId)?.(files) ?? false;
}
