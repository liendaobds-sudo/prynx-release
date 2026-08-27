/**
 * Shared constants used across the application.
 */

/**
 * Prefixes của riêng kết quả BÌNH BÀI (có đường cắt/bế) — dùng để gate nút
 * "Gửi Máy Bế". Đây là nhận diện capability của artifact bình bài,
 * không được dùng làm provenance/dirty/Recent.
 */
export const IMPOSED_PREFIXES = ['Imposed_'] as const;

/**
 * Check nếu file là kết quả bình bài (có thể trích đường cắt để gửi máy bế).
 */
export function isImposedOutputFile(name: string): boolean {
  return IMPOSED_PREFIXES.some(prefix => name.includes(prefix));
}
