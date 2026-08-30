import { useState } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import { useCapabilities } from "../context/CapabilitiesContext";

export function PermissionsPanel() {
  const { t } = useTranslation("event");
  const { has, loaded } = useCapabilities();
  const canManage = loaded && has("event.manage");
  const utils = trpc.useUtils();
  const groups = trpc.permission.groups.useQuery();
  const grants = trpc.permission.listGrants.useQuery(undefined, {
    enabled: canManage,
  });
  const keyQ = trpc.competition.getKioskKey.useQuery(undefined, {
    enabled: canManage,
  });
  const clubGroups = trpc.permission.clubGroups.useQuery(undefined, {
    enabled: canManage,
  });
  const grant = trpc.permission.grant.useMutation({
    onSuccess: () => {
      setEmail("");
      setClubGroupId("");
      void utils.permission.listGrants.invalidate();
    },
  });
  const revoke = trpc.permission.revoke.useMutation({
    onSuccess: () => void utils.permission.listGrants.invalidate(),
  });
  const regen = trpc.competition.regenerateKioskKey.useMutation({
    onSuccess: () => void utils.competition.getKioskKey.invalidate(),
  });

  const [subjectType, setSubjectType] = useState<"user" | "clubGroup">("user");
  const [email, setEmail] = useState("");
  const [clubGroupId, setClubGroupId] = useState("");
  const [roleId, setRoleId] = useState("");

  if (!canManage) return null;

  const kioskKey = regen.data?.kioskKey ?? keyQ.data?.kioskKey ?? "";
  const nameId = window.location.pathname.split("/").filter(Boolean)[0] ?? "";
  const kioskUrl = kioskKey
    ? `${window.location.origin}/${nameId}/kiosk?k=${encodeURIComponent(kioskKey)}`
    : "";

  return (
    <div data-testid="permissions-panel" className="space-y-4">
      <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider">
        {t("permissionsHeading")}
      </h2>
      <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
        <p className="text-sm text-slate-500">{t("permissionsHelp")}</p>
        <form
          className="flex flex-col sm:flex-row gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!roleId) return;
            if (subjectType === "user") {
              grant.mutate({ userEmail: email, groupId: roleId });
            } else {
              if (!clubGroupId) return;
              grant.mutate({ clubGroupId, groupId: roleId });
            }
          }}
        >
          <div
            className="flex rounded-lg border border-slate-200 overflow-hidden text-sm shrink-0"
            role="group"
          >
            <button
              type="button"
              data-testid="grant-subject-user"
              onClick={() => setSubjectType("user")}
              className={`px-3 py-2 cursor-pointer ${
                subjectType === "user"
                  ? "bg-blue-600 text-white"
                  : "bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {t("grantSubjectUser")}
            </button>
            <button
              type="button"
              data-testid="grant-subject-group"
              onClick={() => setSubjectType("clubGroup")}
              className={`px-3 py-2 cursor-pointer border-l border-slate-200 ${
                subjectType === "clubGroup"
                  ? "bg-blue-600 text-white"
                  : "bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {t("grantSubjectGroup")}
            </button>
          </div>
          {subjectType === "user" ? (
            <input
              data-testid="grant-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("grantEmail")}
              className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm"
            />
          ) : (
            <select
              data-testid="grant-club-group"
              required
              value={clubGroupId}
              onChange={(e) => setClubGroupId(e.target.value)}
              className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
            >
              <option value="">{t("grantClubGroup")}</option>
              {(clubGroups.data ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g.members.length})
                </option>
              ))}
            </select>
          )}
          <select
            data-testid="grant-role"
            required
            value={roleId}
            onChange={(e) => setRoleId(e.target.value)}
            className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
          >
            <option value="">{t("grantRole")}</option>
            {(groups.data ?? []).map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <button
            data-testid="grant-submit"
            type="submit"
            disabled={grant.isPending}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 cursor-pointer"
          >
            {t("grantSubmit")}
          </button>
        </form>
        {subjectType === "clubGroup" &&
          clubGroups.data &&
          clubGroups.data.length === 0 && (
            <p className="text-xs text-slate-500">{t("grantNoClubGroups")}</p>
          )}
        {grant.isError && (
          <p className="text-sm text-red-600">{grant.error.message}</p>
        )}
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="py-1 font-medium">{t("grantColSubject")}</th>
              <th className="py-1 font-medium">{t("grantColRole")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(grants.data ?? []).map((row) => (
              <tr key={row.id} className="border-t border-slate-100">
                <td className="py-2">
                  {row.subjectType === "clubGroup" ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 text-[10px] font-semibold uppercase">
                        {t("grantGroupBadge")}
                      </span>
                      <span>{row.clubGroupName}</span>
                      <span className="text-xs text-slate-400">
                        {t("grantMemberCount", {
                          count: row.clubGroupMemberCount ?? 0,
                        })}
                      </span>
                    </span>
                  ) : (
                    <span className="font-mono text-xs">{row.userEmail}</span>
                  )}
                </td>
                <td className="py-2">{row.groupName}</td>
                <td className="py-2 text-right">
                  <button
                    type="button"
                    data-testid={`revoke-${row.userEmail ?? row.clubGroupName}`}
                    onClick={() => revoke.mutate({ grantId: row.id })}
                    className="text-xs text-red-600 hover:text-red-800 cursor-pointer"
                  >
                    {t("grantRevoke")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider">
        {t("kioskKeyHeading")}
      </h2>
      <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-3">
        <p className="text-sm text-slate-600">{t("kioskKeyHelp")}</p>
        {kioskUrl && (
          <code
            data-testid="kiosk-url"
            className="block text-xs break-all bg-slate-50 p-2 rounded"
          >
            {kioskUrl}
          </code>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="regenerate-kiosk-key"
            onClick={() => regen.mutate()}
            className="px-3 py-1.5 text-sm bg-slate-800 text-white rounded-lg cursor-pointer"
          >
            {t("kioskKeyRegenerate")}
          </button>
          {kioskUrl && (
            <button
              type="button"
              onClick={() => void navigator.clipboard.writeText(kioskUrl)}
              className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg cursor-pointer"
            >
              {t("kioskKeyCopy")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
