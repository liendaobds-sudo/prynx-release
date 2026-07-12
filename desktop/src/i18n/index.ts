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

// ─── tv(): dịch DATA hằng module-level ──────────────────────────────────────
// TOOL_REGISTRY / TOOL_HELP / mảng option trong types.ts được ĐỊNH NGHĨA ở
// module scope (KHÔNG gọi được hook useTranslation) nhưng lại được RENDER trong
// component (vd {tool.title}). Codemod t('ns:key') không áp dụng ở nơi định nghĩa.
//
// Giải pháp đảo ngược: GIỮ NGUYÊN chuỗi VN trong data, build reverse-map từ chính
// vi.json (chuỗi vi → 'ns:key') rồi tra ngược tại render site: {tv(tool.title)}.
// AN TOÀN: sót render site / chuỗi không có trong map → trả NGUYÊN chuỗi VN, không
// bao giờ vỡ thành key xấu. Map build từ vi.json nên luôn đồng bộ với source-of-truth.
//
// Một chuỗi VN có thể trùng ở nhiều ns; data tool nằm ở 'catalog' nên ưu tiên nó.
const VI_TO_KEY = new Map<string, string>();
{
  const dict = vi as Record<string, Record<string, string>>;
  const nsOrder = Object.keys(dict).sort((a, b) =>
    (a === 'catalog' ? -1 : 0) - (b === 'catalog' ? -1 : 0)
  );
  for (const ns of nsOrder) {
    for (const [key, val] of Object.entries(dict[ns])) {
      if (typeof val === 'string' && val && !VI_TO_KEY.has(val)) {
        VI_TO_KEY.set(val, `${ns}:${key}`);
      }
    }
  }
}

/**
 * Dịch một chuỗi VN gốc (data hằng) sang ngôn ngữ hiện tại. Không tìm thấy → trả
 * nguyên chuỗi. Gọi trong render site đã có useTranslation để re-render khi đổi ngữ.
 */
export function tv(viStr: string | undefined | null): string {
  if (!viStr) return viStr ?? '';
  const keyRef = VI_TO_KEY.get(viStr);
  return keyRef ? i18n.t(keyRef) : viStr;
}

export default i18n;
