import { useTranslation } from "react-i18next";

export function ForbiddenPane() {
  const { t } = useTranslation("event");
  return (
    <div
      data-testid="forbidden-pane"
      className="max-w-lg mx-auto mt-16 p-8 bg-white rounded-2xl border border-slate-200 text-center"
    >
      <h2 className="text-lg font-semibold text-slate-900 mb-2">
        {t("forbiddenTitle")}
      </h2>
      <p className="text-sm text-slate-600">{t("forbiddenBody")}</p>
    </div>
  );
}
