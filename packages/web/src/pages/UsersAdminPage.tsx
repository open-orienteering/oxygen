import { useMemo, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import { LanguageSelector } from "../components/LanguageSelector";
import { UserChip } from "../components/UserChip";
import { useCurrentUser } from "../context/CurrentUserContext";
import { useTimeAgo } from "../hooks/useTimeAgo";

export function UsersAdminPage() {
  const { t } = useTranslation("auth");
  const { user, authEnabled, isLoading } = useCurrentUser();
  const timeAgo = useTimeAgo();
  const utils = trpc.useUtils();
  const list = trpc.users.list.useQuery(undefined, {
    enabled: Boolean(user?.isAdmin),
  });
  const invite = trpc.users.invite.useMutation({
    onSuccess: () => {
      setEmail("");
      setDisplayName("");
      setIsAdmin(false);
      void utils.users.list.invalidate();
    },
  });
  const update = trpc.users.update.useMutation({
    onSuccess: () => {
      void utils.users.list.invalidate();
      void utils.users.me.invalidate();
    },
  });

  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const rows = list.data ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (row) =>
        row.email.toLowerCase().includes(q) ||
        row.displayName.toLowerCase().includes(q) ||
        row.groups.some((g) => g.name.toLowerCase().includes(q)),
    );
  }, [list.data, query]);

  if (authEnabled && !isLoading && !user?.isAdmin) {
    return <Navigate to="/" replace />;
  }

  return (
    <div
      data-testid="users-admin-page"
      className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4"
    >
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <Link
            to="/"
            className="text-sm text-slate-500 hover:text-slate-700"
          >
            {t("backToSelector")}
          </Link>
          <div className="flex items-center gap-3">
            <UserChip />
            <LanguageSelector />
          </div>
        </div>

        <h1 className="text-2xl font-bold text-slate-900">{t("usersTitle")}</h1>
        <p className="text-sm text-slate-500 mt-1 mb-6">{t("usersIntro")}</p>

        <form
          className="bg-white rounded-2xl shadow-lg border border-slate-200 p-5 mb-6 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            invite.mutate({
              email,
              displayName: displayName.trim() || undefined,
              isAdmin,
            });
          }}
        >
          <h2 className="text-sm font-semibold text-slate-800">{t("inviteHeading")}</h2>
          <p className="text-xs text-slate-500">{t("inviteHint")}</p>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              data-testid="invite-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("inviteEmail")}
              className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <input
              data-testid="invite-name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t("inviteName")}
              className="sm:w-44 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              data-testid="invite-admin"
              type="checkbox"
              checked={isAdmin}
              onChange={(e) => setIsAdmin(e.target.checked)}
            />
            {t("inviteAsAdmin")}
          </label>
          <button
            data-testid="invite-submit"
            type="submit"
            disabled={invite.isPending}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 cursor-pointer"
          >
            {invite.isPending ? t("inviting") : t("inviteSubmit")}
          </button>
          {invite.isError && (
            <p className="text-sm text-red-600">{invite.error.message}</p>
          )}
        </form>

        <div className="bg-white rounded-2xl shadow-lg border border-slate-200 overflow-hidden">
          <div className="p-4 border-b border-slate-100">
            <input
              data-testid="users-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("searchUsers")}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          {list.isLoading && (
            <p className="p-6 text-sm text-slate-500">{t("loadingUsers")}</p>
          )}
          {list.data && filtered.length === 0 && (
            <p className="p-6 text-sm text-slate-500">{t("noUsersMatch")}</p>
          )}
          {list.data && filtered.length > 0 && (
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">{t("colEmail")}</th>
                  <th className="px-4 py-2 font-medium">{t("colName")}</th>
                  <th className="px-4 py-2 font-medium">{t("colRole")}</th>
                  <th className="px-4 py-2 font-medium">{t("colGroups")}</th>
                  <th className="px-4 py-2 font-medium">{t("colLastSeen")}</th>
                  <th className="px-4 py-2 font-medium">{t("colActive")}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr key={row.id} className="border-t border-slate-100">
                    <td className="px-4 py-2 font-mono text-xs text-slate-800">
                      {row.email}
                    </td>
                    <td className="px-4 py-2 text-slate-700">{row.displayName}</td>
                    <td className="px-4 py-2">
                      <label className="inline-flex items-center gap-2">
                        <input
                          type="checkbox"
                          aria-label={t("colAdmin")}
                          checked={row.isAdmin}
                          disabled={update.isPending || row.id === user?.id}
                          onChange={(e) =>
                            update.mutate({ id: row.id, isAdmin: e.target.checked })
                          }
                        />
                        <span
                          className={
                            row.isAdmin
                              ? "text-xs font-medium text-blue-700"
                              : "text-xs text-slate-500"
                          }
                        >
                          {row.isAdmin ? t("roleAdmin") : t("roleMember")}
                        </span>
                      </label>
                    </td>
                    <td className="px-4 py-2 text-slate-600">
                      {row.groups.length === 0
                        ? t("noGroups")
                        : row.groups.map((g) => g.name).join(", ")}
                    </td>
                    <td
                      className="px-4 py-2 text-slate-500 whitespace-nowrap"
                      data-testid="user-last-seen"
                    >
                      {row.lastSeenAt
                        ? timeAgo(row.lastSeenAt)
                        : t("neverSeen")}
                    </td>
                    <td className="px-4 py-2">
                      <input
                        type="checkbox"
                        aria-label={t("colActive")}
                        checked={row.active}
                        disabled={update.isPending || row.id === user?.id}
                        onChange={(e) =>
                          update.mutate({ id: row.id, active: e.target.checked })
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
