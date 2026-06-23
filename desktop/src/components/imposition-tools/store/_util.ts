// Shared helpers for imposer settings store slices.

export function loadFromLocalStorage<T>(key: string, fallback: T): T {
    try {
        const saved = localStorage.getItem(key);
        return saved ? JSON.parse(saved) : fallback;
    } catch {
        return fallback;
    }
}
