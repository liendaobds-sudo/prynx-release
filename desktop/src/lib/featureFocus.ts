/**
 * Cờ tập trung tính năng — tạm ẩn các mảng phức tạp để tập trung phát triển.
 *
 * HIDE_OFFSET_BOOKLET: tạm ẩn bình offset (catalog/tạp chí), chỉ giữ in nhanh
 * (digital). Đổi thành `false` để bật lại offset đầy đủ — mọi UI/logic offset
 * vẫn còn nguyên trong code, chỉ bị ẩn khỏi giao diện.
 *
 * HIDE_PRODUCT_FIRST: tạm ẩn panel "Đề xuất theo sản phẩm" (ProductFirstPanel)
 * trong tab Bình Sách. Đổi thành `false` để hiện lại — engine ProductAdvisor
 * vẫn còn nguyên, chỉ ẩn nút + panel khỏi giao diện.
 */
export const HIDE_OFFSET_BOOKLET = true;
export const HIDE_PRODUCT_FIRST = true;
