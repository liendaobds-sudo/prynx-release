// Init i18n cho môi trường test — component dùng t() sẽ resolve ra chuỗi vi
// (fallbackLng='vi') thay vì trả về nguyên key. Không có dòng này, getByText('...')
// theo chuỗi vi sẽ fail vì render ra 'ns:key'.
import '../i18n';
