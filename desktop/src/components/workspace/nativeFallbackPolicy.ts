// PERF (audit 2026-09-27 §V27.C2): native có thể ready trước bitmap dự phòng.
// Cho đúng bản nền đầu hoàn tất, rồi dừng producer; không đổi target theo wheel.
export interface FrozenFallbackRaster { identity: string; zoom: number }
export function shouldProduceNativeFallback(enabled: boolean, nativePresented: boolean, fallbackReady: boolean): boolean {
    return enabled && (!nativePresented || !fallbackReady);
}
export function pinNativeFallbackRaster(previous: FrozenFallbackRaster | null, identity: string, nativePresented: boolean, requestedZoom: number): FrozenFallbackRaster | null {
    if (!nativePresented) return null;
    if (previous?.identity === identity) return previous;
    return {identity, zoom: requestedZoom};
}
