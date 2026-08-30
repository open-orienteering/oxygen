import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../context/CurrentUserContext";

export function AccessDeniedPage() {
  const { t } = useTranslation("auth");
  const { identityEmail } = useCurrentUser();
  const invited = Boolean(identityEmail);

  return (
    <div
      data-testid="access-denied"
      className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-4"
    >
      <div className="w-full max-w-md bg-white rounded-2xl shadow-lg border border-slate-200 p-8 text-center">
        <h1 className="text-xl font-semibold text-slate-900 mb-3">
          {t("accessDeniedTitle")}
        </h1>
        {invited ? (
          <p
            data-testid="access-denied-not-invited"
            className="text-slate-600 text-sm"
          >
            {t("notInvited", { email: identityEmail })}
          </p>
        ) : (
          <p
            data-testid="access-denied-no-identity"
            className="text-slate-600 text-sm"
          >
            {t("noIdentity")}
          </p>
        )}
        <p className="text-slate-500 text-sm mt-4">{t("contactAdmin")}</p>
      </div>
    </div>
  );
}
