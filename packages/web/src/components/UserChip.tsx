import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../context/CurrentUserContext";

export function UserChip() {
  const { t } = useTranslation("auth");
  const { user, authEnabled } = useCurrentUser();
  if (!authEnabled || !user) return null;
  const label = user.displayName || user.email;
  return (
    <span
      data-testid="user-chip"
      className="inline-flex items-center max-w-[14rem] truncate rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700"
      title={user.email}
    >
      {label}
      {user.isAdmin ? (
        <span className="ml-1.5 text-[10px] uppercase tracking-wide text-blue-600">
          {t("adminBadge")}
        </span>
      ) : null}
    </span>
  );
}
