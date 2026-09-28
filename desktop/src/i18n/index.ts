import i18n, { type BackendModule } from 'i18next';
import { initReactI18next } from 'react-i18next';

import vi from './locales/vi.json';

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
type TranslationCatalog = Record<string, Record<string, string>>;

// PERF (audit 2026-09-28 §PERF28.05): mọi namespace dùng chung một lần import.
// VI luôn sẵn sàng; changeLanguage chỉ phát languageChanged sau khi EN đã nạp,
// kể cả khi ngôn ngữ được khôi phục bất đồng bộ từ thiết lập Tauri.
let englishCatalogPromise: Promise<TranslationCatalog> | null = null;
let englishLoadFailed = false;

function loadEnglishCatalog(): Promise<TranslationCatalog> {
  if (!englishCatalogPromise) {
    englishCatalogPromise = import('./locales/en.json')
      .then(({ default: catalog }) => {
        if (import.meta.env?.DEV) reportDivergentTranslations(catalog);
        return catalog;
      })
      .catch((error: unknown) => {
        englishLoadFailed = true;
        throw error;
      });
  }
  return englishCatalogPromise;
}

i18n.on('languageChanging', (language: string) => {
  // Giữ promise lỗi đến hết lượt hiện tại để hàng namespace không import lại
  // liên tiếp. Chọn EN lần sau mới thử lại; lựa chọn VI không cần chờ EN.
  if (language?.split('-')[0] === 'en' && englishLoadFailed) {
    englishCatalogPromise = null;
    englishLoadFailed = false;
  }
});

const lazyEnglishBackend: BackendModule = {
  type: 'backend',
  init() { /* Catalog đóng gói cục bộ, không cần cấu hình kết nối. */ },
  read(language, namespace, callback) {
    if (language !== 'en') {
      callback(null, {});
      return;
    }
    void loadEnglishCatalog().then(
      (catalog) => callback(null, catalog[namespace] ?? {}),
      (error: unknown) => callback(
        error instanceof Error ? error : new Error('Không nạp được dữ liệu tiếng Anh.'),
        true,
      ),
    );
  },
};

i18n.use(lazyEnglishBackend).use(initReactI18next).init({
  resources: {
    vi: vi as Record<string, Record<string, string>>,
  },
  partialBundledLanguages: true,
  // Lỗi chunk dùng fallback VI ngay; cờ retry của backend cho phép lượt chọn
  // tiếp theo nạp lại, không dựng chuỗi timer tự thử trong lúc app khởi động.
  maxRetries: 0,
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
  const nsOrder = Object.keys(dict).sort((a, b) =>
    (a === 'catalog' ? -1 : 0) - (b === 'catalog' ? -1 : 0)
  );
  for (const ns of nsOrder) {
    const nsMap = new Map<string, string>();
    VI_TO_KEY_BY_NS.set(ns, nsMap);
    for (const [key, val] of Object.entries(dict[ns])) {
      if (typeof val === 'string' && val) {
        if (!nsMap.has(val)) nsMap.set(val, key);
        const existing = VI_TO_KEY.get(val);
        if (!existing) {
          VI_TO_KEY.set(val, `${ns}:${key}`);
        }
      }
    }
  }
}

function reportDivergentTranslations(enDict: TranslationCatalog): void {
  // PERF (audit 2026-09-28 §PERF28.05): diagnostic DEV không được kéo EN vào
  // startup VI. Khi EN nạp xong, vẫn kiểm mọi va chạm nếu tvDebug được bật.
  try {
    if (localStorage.getItem('tvDebug') !== '1') return;
  } catch {
    return;
  }
  const divergent: string[] = [];
  for (const [ns, entries] of Object.entries(vi)) {
    for (const [key, value] of Object.entries(entries)) {
      const winner = VI_TO_KEY.get(value);
      if (!winner || winner === `${ns}:${key}`) continue;
      const [winnerNs, winnerKey] = winner.split(/:(.*)/);
      const enWinner = enDict[winnerNs]?.[winnerKey];
      const enThis = enDict[ns]?.[key];
      if (enWinner && enThis && enWinner !== enThis) {
        divergent.push(
          `  "${value}": thắng ${winner}→"${enWinner}", bỏ qua ${ns}:${key}→"${enThis}" ` +
          `(cần bản này: tv("${value}", "${ns}"))`,
        );
      }
    }
  }
  if (divergent.length > 0) {
    console.groupCollapsed(`[tv] ${divergent.length} va chạm divergent (chi tiết)`);
    console.warn(divergent.join('\n'));
    console.groupEnd();
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
