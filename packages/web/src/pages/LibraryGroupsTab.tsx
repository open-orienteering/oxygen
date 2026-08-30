import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { trpc } from "../lib/trpc";
import { useCurrentUser } from "../context/CurrentUserContext";

/**
 * Club user groups: named sets of users that event admins can grant a
 * role to in one go. Membership is resolved live, so edits here apply
 * immediately to every event the group has a role on — which is why
 * mutations are instance-admin only.
 */
export function LibraryGroupsTab() {
  const { t } = useTranslation("library");
  const { user, authEnabled } = useCurrentUser();
  const canEdit = !authEnabled || Boolean(user?.isAdmin);
  const utils = trpc.useUtils();
  const groups = trpc.permission.clubGroups.useQuery();
  const invalidate = () => void utils.permission.clubGroups.invalidate();

  const create = trpc.permission.createClubGroup.useMutation({
    onSuccess: () => {
      setNewName("");
      invalidate();
    },
  });
  const remove = trpc.permission.deleteClubGroup.useMutation({
    onSuccess: () => {
      setPendingDelete(null);
      invalidate();
    },
  });
  const addMember = trpc.permission.addClubGroupMember.useMutation({
    onSuccess: () => {
      setMemberEmail("");
      invalidate();
    },
  });
  const invite = trpc.users.invite.useMutation();
  const removeMember = trpc.permission.removeClubGroupMember.useMutation({
    onSuccess: invalidate,
  });

  const [newName, setNewName] = useState("");
  const [memberEmail, setMemberEmail] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    id: string;
    name: string;
  } | null>(null);

  return (
    <div data-testid="library-groups-tab">
      <p className="text-sm text-slate-600 mb-4">{t("groupsHelp")}</p>

      {canEdit ? (
        <form
          data-testid="group-create-form"
          className="flex gap-2 mb-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newName.trim()) return;
            create.mutate({ name: newName.trim() });
          }}
        >
          <input
            data-testid="group-create-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t("groupName")}
            className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
          />
          <button
            data-testid="group-create-submit"
            type="submit"
            disabled={create.isPending || !newName.trim()}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 cursor-pointer disabled:opacity-50"
          >
            {t("createGroup")}
          </button>
        </form>
      ) : (
        <p className="text-xs text-slate-400 mb-6">{t("groupsReadOnly")}</p>
      )}
      {create.isError && (
        <p className="text-sm text-red-600 mb-4">{create.error.message}</p>
      )}

      {groups.data && groups.data.length === 0 && (
        <p className="text-sm text-slate-500 text-center py-8">
          {t("emptyGroups")}
        </p>
      )}

      <ul className="space-y-3">
        {(groups.data ?? []).map((g) => {
          const expanded = expandedId === g.id;
          return (
            <li
              key={g.id}
              data-testid={`group-card-${g.name}`}
              className="bg-white rounded-xl border border-slate-200 p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  data-testid={`group-expand-${g.name}`}
                  className="text-left font-semibold text-slate-900 cursor-pointer hover:text-blue-700"
                  onClick={() => {
                    setExpandedId(expanded ? null : g.id);
                    setMemberEmail("");
                    addMember.reset();
                    invite.reset();
                  }}
                >
                  {g.name}
                  <span className="ml-2 text-xs font-normal text-slate-500">
                    {t("groupMemberCount", { count: g.members.length })}
                  </span>
                </button>
                {canEdit && (
                  <button
                    type="button"
                    data-testid={`group-delete-${g.name}`}
                    className="px-3 py-1 text-xs text-red-600 border border-red-100 rounded-lg cursor-pointer hover:bg-red-50"
                    onClick={() => setPendingDelete({ id: g.id, name: g.name })}
                  >
                    {t("delete")}
                  </button>
                )}
              </div>

              {expanded && (
                <div className="mt-3 space-y-2">
                  {g.members.length === 0 && (
                    <p className="text-xs text-slate-400">{t("noMembers")}</p>
                  )}
                  <ul className="divide-y divide-slate-100">
                    {g.members.map((m) => (
                      <li
                        key={m.userId}
                        className="flex items-center justify-between py-1.5"
                      >
                        <span className="text-sm text-slate-700">
                          {m.displayName || m.email}
                          {m.displayName && (
                            <span className="ml-2 text-xs text-slate-400 font-mono">
                              {m.email}
                            </span>
                          )}
                        </span>
                        {canEdit && (
                          <button
                            type="button"
                            data-testid={`group-member-remove-${m.email}`}
                            className="text-xs text-red-600 hover:text-red-800 cursor-pointer"
                            onClick={() =>
                              removeMember.mutate({
                                groupId: g.id,
                                userId: m.userId,
                              })
                            }
                          >
                            {t("removeMember")}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                  {canEdit && (
                    <form
                      className="flex gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (!memberEmail.trim()) return;
                        addMember.mutate({
                          groupId: g.id,
                          userEmail: memberEmail.trim(),
                        });
                      }}
                    >
                      <input
                        data-testid="group-member-email"
                        type="email"
                        value={memberEmail}
                        onChange={(e) => {
                          setMemberEmail(e.target.value);
                          addMember.reset();
                          invite.reset();
                        }}
                        placeholder={t("addMemberEmail")}
                        className="flex-1 px-2 py-1.5 border border-slate-200 rounded-lg text-sm bg-white"
                      />
                      <button
                        data-testid="group-member-add"
                        type="submit"
                        disabled={addMember.isPending || !memberEmail.trim()}
                        className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg cursor-pointer hover:bg-slate-50 disabled:opacity-50"
                      >
                        {t("addMember")}
                      </button>
                    </form>
                  )}
                  <p className="text-xs text-slate-500">
                    {t("groups.inviteHint")}{" "}
                    {user?.isAdmin ? (
                      <Link
                        to="/admin/users"
                        className="text-blue-600 hover:text-blue-800"
                      >
                        {t("groups.inviteHintLink")}
                      </Link>
                    ) : (
                      <span>{t("groups.inviteHintLink")}</span>
                    )}
                  </p>
                  {addMember.isError && (
                    <>
                      <p className="text-xs text-red-600">
                        {addMember.error.message}
                      </p>
                      {addMember.error.data?.code === "NOT_FOUND" && canEdit && (
                        <button
                          type="button"
                          data-testid="group-invite-and-add"
                          disabled={invite.isPending || addMember.isPending}
                          className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg cursor-pointer hover:bg-blue-700 disabled:opacity-50"
                          onClick={async () => {
                            const email = memberEmail.trim();
                            if (!email) return;
                            try {
                              await invite.mutateAsync({ email });
                            } catch (err) {
                              if (
                                !(
                                  err &&
                                  typeof err === "object" &&
                                  "data" in err &&
                                  (err as { data?: { code?: string } }).data?.code ===
                                    "CONFLICT"
                                )
                              ) {
                                return;
                              }
                            }
                            addMember.mutate({
                              groupId: g.id,
                              userEmail: email,
                            });
                          }}
                        >
                          {t("groups.inviteAndAdd", { email: memberEmail.trim() })}
                        </button>
                      )}
                      {invite.isError && invite.error.data?.code !== "CONFLICT" && (
                        <p className="text-xs text-red-600">
                          {invite.error.message}
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {pendingDelete && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div
            data-testid="group-delete-confirm"
            className="bg-white rounded-xl p-6 max-w-sm w-full shadow-lg"
          >
            <h2 className="font-semibold text-slate-900 mb-2">
              {t("deleteGroupTitle")}
            </h2>
            <p className="text-sm text-slate-600 mb-4">
              {t("deleteGroupBody", { name: pendingDelete.name })}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="px-3 py-1.5 text-sm border border-slate-200 rounded-lg cursor-pointer"
                onClick={() => setPendingDelete(null)}
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                data-testid="group-delete-confirm-btn"
                className="px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg cursor-pointer"
                onClick={() => remove.mutate({ id: pendingDelete.id })}
              >
                {t("confirmDeleteGroup")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
