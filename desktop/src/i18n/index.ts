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
// Map phụ theo namespace: chuỗi VN → key, để tv(str, ns) tự chỉ định ngữ cảnh khi
// một chuỗi trùng ở nhiều ns nhưng cần bản dịch KHÁC nhau (vd 'Có'→'Yes' vs 'There are').
const VI_TO_KEY_BY_NS = new Map<string, Map<string, string>>();
{
  const dict = vi as Record<string, Record<string, string>>;
  const enDict = en as Record<string, Record<string, string>>;
  const nsOrder = Object.keys(dict).sort((a, b) =>
    (a === 'catalog' ? -1 : 0) - (b === 'catalog' ? -1 : 0)
  );
  // Gom va chạm divergent vào 1 chỗ → in GỌN (1 dòng tóm tắt), không spam console
  // mỗi va chạm 1 dòng (che mất log thật). Bật chi tiết: localStorage.tvDebug = '1'.
  const _divergent: string[] = [];
  for (const ns of nsOrder) {
    const nsMap = new Map<string, string>();
    VI_TO_KEY_BY_NS.set(ns, nsMap);
    for (const [key, val] of Object.entries(dict[ns])) {
      if (typeof val === 'string' && val) {
        if (!nsMap.has(val)) nsMap.set(val, key);
        const existing = VI_TO_KEY.get(val);
        if (!existing) {
          VI_TO_KEY.set(val, `${ns}:${key}`);
        } else if (import.meta.env?.DEV) {
          // Va chạm: chuỗi VN đã map ở ns khác. Chỉ ghi nhận nếu bản EN KHÁC nhau
          // (divergent) — đó là "mìn ngủ": tv() match-đầu-tiên sẽ trả sai ngữ cảnh.
          // Trùng nhưng EN giống nhau (Đóng→Close ở 16 ns) thì vô hại, im lặng.
          const [exNs, exKey] = existing.split(/:(.*)/);
          const enWin = enDict[exNs]?.[exKey];
          const enThis = enDict[ns]?.[key];
          if (enWin && enThis && enWin !== enThis) {
            _divergent.push(
              `  "${val}": thắng ${existing}→"${enWin}", bỏ qua ${ns}:${key}→"${enThis}" ` +
              `(cần bản này: tv("${val}", "${ns}"))`
            );
          }
        }
      }
    }
  }
  if (import.meta.env?.DEV && _divergent.length > 0) {
    let _tvDebug = false;
    try { _tvDebug = localStorage.getItem('tvDebug') === '1'; } catch { /* SSR / no storage */ }
    if (_tvDebug) {
      console.groupCollapsed(`[tv] ${_divergent.length} va chạm divergent (chi tiết)`);
      console.warn(_divergent.join('\n'));
      console.groupEnd();
    } else {
      console.info(
        `[tv] ${_divergent.length} chuỗi VN trùng có bản EN khác nhau giữa namespace ` +
        `(vô hại — tv() match-đầu-tiên). Xem chi tiết: localStorage.tvDebug='1' rồi reload.`
      );
    }
  }
}

/**
 * Dịch một chuỗi VN gốc (data hằng) sang ngôn ngữ hiện tại. Không tìm thấy → trả
 * nguyên chuỗi. Gọi trong render site đã có useTranslation để re-render khi đổi ngữ.
 *
 * @param ns  (tùy chọn) Ép tra trong đúng namespace này — dùng khi chuỗi trùng ở
 *            nhiều ns với bản dịch khác nhau (vd tv('Có', 'tabs.outputPreview')→'Yes').
 *            Không truyền → dùng map toàn cục (match-đầu-tiên theo nsOrder).
 */
export function tv(viStr: string | undefined | null, ns?: string): string {
  if (!viStr) return viStr ?? '';
  if (ns) {
    const key = VI_TO_KEY_BY_NS.get(ns)?.get(viStr);
    if (key) return i18n.t(`${ns}:${key}`);
  }
  const keyRef = VI_TO_KEY.get(viStr);
  return keyRef ? i18n.t(keyRef) : viStr;
}

export default i18n;
