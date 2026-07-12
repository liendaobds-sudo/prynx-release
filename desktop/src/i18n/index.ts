import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import vi from './locales/vi.json';
import en from './locales/en.json';

export type AppLanguage = 'vi' | 'en';
export const APP_LANGUAGES: AppLanguage[] = ['vi', 'en'];

// vi.json là source-of-truth (đã điền đủ); en.json còn nhiều key rỗng → phải fallback
// về vi. returnEmptyString:false biến chuỗi "" thành "thiếu key" nên i18next dùng bản vi.
//
// Namespace của ta chứa dấu chấm (vd 'preprocess.dataMerge'), mà i18next mặc định
// coi '.' là keySeparator và ':' là nsSeparator. Cấu trúc JSON {ns: {key: val}} khớp
// thẳng vào resources, nên chỉ cần: giữ nsSeparator ':' + TẮT keySeparator để slug key
// (chứa '_') không bị tách. Gọi: t('preprocess.dataMerge:can_danh_so_trang').
const NAMESPACES = Object.keys(vi);

i18n.use(initReactI18next).init({
  resources: {
    vi: vi as Record<string, Record<string, string>>,
    en: en as Record<string, Record<string, string>>,
  },
  lng: 'vi',
  fallbackLng: 'vi',
  ns: NAMESPACES,
  defaultNS: 'shell',
  nsSeparator: ':',
  keySeparator: false,
  returnEmptyString: false,
  interpolation: {
    escapeValue: false, // React tự escape
  },
  react: {
    useSuspense: false,
  },
});

export default i18n;
