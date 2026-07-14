import { useTranslation } from 'react-i18next';
import { useAppSettingsStore } from '../stores/appSettingsStore';

export function LanguageToggle() {
  const { t } = useTranslation();
  const language = useAppSettingsStore((s) => s.language);
  const setLanguage = useAppSettingsStore((s) => s.setLanguage);

  const next = language === 'vi' ? 'en' : 'vi';

  return (
    <button
      onClick={() => setLanguage(next)}
      className="w-[26px] h-[26px] rounded-md text-slate-500 hover:text-slate-800 hover:bg-black/5 dark:text-zinc-400 dark:hover:text-white dark:hover:bg-white/10 flex items-center justify-center transition-colors border border-transparent hover:border-black/10 dark:hover:border-white/10"
      title={next === 'vi' ? t('misc.languageToggle:chuyen_sang_tieng_viet') : t('misc.languageToggle:chuyen_sang_english')}
    >
      <span className="text-[11px] font-bold tracking-tight leading-none tabular-nums">
        {language === 'vi' ? 'VN' : 'EN'}
      </span>
    </button>
  );
}
