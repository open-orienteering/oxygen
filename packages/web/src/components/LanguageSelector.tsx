import { useTranslation } from "react-i18next";

const languages = [
  { code: "en", label: "English", flag: FlagGB },
  { code: "sv", label: "Svenska", flag: FlagSE },
] as const;

export function LanguageSelector() {
  const { i18n } = useTranslation();
  const currentLang = i18n.language;
  const current = languages.find((l) => l.code === currentLang) ?? languages[0];
  const next = languages.find((l) => l.code !== currentLang) ?? languages[1];

  const switchLanguage = () => {
    i18n.changeLanguage(next.code);
    localStorage.setItem("oxygen-lang", next.code);
    document.documentElement.lang = next.code;
  };

  return (
    <button
      onClick={switchLanguage}
      className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors cursor-pointer"
      title={`${current.label} → ${next.label}`}
    >
      <current.flag className="w-5 h-3.5 rounded-[2px] overflow-hidden" />
      <span>{current.label}</span>
    </button>
  );
}

// ─── Flag SVGs ───────────────────────────────────────────────

function FlagGB({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 60 30" className={className}>
      <clipPath id="gb-clip"><rect width="60" height="30" /></clipPath>
      <g clipPath="url(#gb-clip)">
        <rect width="60" height="30" fill="#012169" />
        <path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" strokeWidth="6" />
        <path d="M0,0 L60,30 M60,0 L0,30" stroke="#C8102E" strokeWidth="4" clipPath="url(#gb-diag)" />
        <clipPath id="gb-diag">
          <path d="M30,15 L60,0 L60,30 Z M30,15 L0,30 L0,0 Z" />
        </clipPath>
        <path d="M30,0 V30 M0,15 H60" stroke="#fff" strokeWidth="10" />
        <path d="M30,0 V30 M0,15 H60" stroke="#C8102E" strokeWidth="6" />
      </g>
    </svg>
  );
}

function FlagSE({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 10" className={className}>
      <rect width="16" height="10" fill="#006AA7" />
      <rect x="5" width="2" height="10" fill="#FECC00" />
      <rect y="4" width="16" height="2" fill="#FECC00" />
    </svg>
  );
}
