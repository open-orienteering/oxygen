/**
 * Venue lease UI (pivot Step 4).
 *
 * `LeaseBadge` — shell header pill, visible only while a lease is active:
 * green "venue mode" on the holding node, amber "checked out to X"
 * everywhere else. `VenueLeasePanel` — EventPage section with the operator
 * actions: checkout/checkin on a peered (venue) node, force-takeover on a
 * node that needs control back after a venue box died.
 */

import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";

export function LeaseBadge() {
  const { t } = useTranslation("event");
  const status = trpc.lease.status.useQuery(undefined, {
    refetchInterval: 10_000,
    refetchOnWindowFocus: false,
  });

  const lease = status.data?.lease;
  if (!lease) return null;

  const pending = status.data?.shipping?.pendingPush ?? 0;
  if (lease.heldByThisNode) {
    return (
      <span
        data-testid="lease-badge"
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
          pending > 0
            ? "bg-amber-100 text-amber-800"
            : "bg-emerald-100 text-emerald-800"
        }`}
        title={
          pending > 0
            ? t("leasePending", { count: pending })
            : t("leaseUpToDate")
        }
      >
        <span className="w-1.5 h-1.5 rounded-full bg-current" />
        {t("leaseBadgeVenueMode")}
        {pending > 0 && <span className="font-semibold">({pending})</span>}
      </span>
    );
  }
  return (
    <span
      data-testid="lease-badge"
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800"
      title={t("leaseBadgeCheckedOut", { node: lease.holderNodeId })}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {t("leaseBadgeCheckedOut", { node: lease.holderNodeId })}
    </span>
  );
}

export function VenueLeasePanel({ nameId }: { nameId: string }) {
  const { t } = useTranslation("event");
  const utils = trpc.useUtils();
  const status = trpc.lease.status.useQuery(undefined, {
    refetchInterval: 10_000,
    refetchOnWindowFocus: false,
  });

  const invalidate = () => utils.lease.status.invalidate();
  const checkout = trpc.lease.checkout.useMutation({ onSettled: invalidate });
  const checkin = trpc.lease.checkin.useMutation({ onSettled: invalidate });
  const forceTakeover = trpc.lease.forceTakeover.useMutation({
    onSettled: invalidate,
  });

  const s = status.data;
  if (!s) return null;
  // Invisible in the common single-node case: no lease, no peer.
  if (!s.lease && !s.peerConfigured) return null;

  const err =
    (checkout.error ?? checkin.error ?? forceTakeover.error)?.message ?? null;

  return (
    <div data-testid="lease-panel">
      <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3">
        {t("leaseTitle")}
      </h2>
      <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-3">
        <div className="text-sm text-slate-700">
          {s.lease ? (
            s.lease.heldByThisNode ? (
              <>
                <span className="font-medium text-emerald-700">
                  {t("leaseHeldByThisNode")}
                </span>{" "}
                <span className="text-slate-400">
                  {t("leaseSince", {
                    time: new Date(s.lease.acquiredAt).toLocaleString(),
                  })}
                </span>
              </>
            ) : (
              <span className="font-medium text-amber-700">
                {t("leaseCheckedOutTo", { node: s.lease.holderNodeId })}{" "}
                <span className="text-slate-400 font-normal">
                  {t("leaseSince", {
                    time: new Date(s.lease.acquiredAt).toLocaleString(),
                  })}
                </span>
              </span>
            )
          ) : (
            <span>{t("leaseNoLease")}</span>
          )}
        </div>

        {s.lease?.heldByThisNode && s.shipping && (
          <div className="text-xs text-slate-500">
            {s.shipping.pendingPush > 0
              ? t("leasePending", { count: s.shipping.pendingPush })
              : t("leaseUpToDate")}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {!s.lease && s.peerConfigured && (
            <button
              data-testid="lease-checkout"
              onClick={() => checkout.mutate({ nameId })}
              disabled={checkout.isPending}
              className="px-3 py-1.5 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 cursor-pointer"
            >
              {t("leaseCheckout")}
            </button>
          )}
          {s.lease?.heldByThisNode && (
            <button
              data-testid="lease-checkin"
              onClick={() => checkin.mutate()}
              disabled={checkin.isPending}
              className="px-3 py-1.5 text-sm font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 cursor-pointer"
            >
              {t("leaseCheckin")}
            </button>
          )}
          {s.lease && !s.lease.heldByThisNode && (
            <button
              data-testid="lease-force-takeover"
              onClick={() => {
                if (
                  window.confirm(
                    t("leaseForceConfirm", { node: s.lease!.holderNodeId }),
                  )
                ) {
                  forceTakeover.mutate({ confirm: true });
                }
              }}
              disabled={forceTakeover.isPending}
              className="px-3 py-1.5 text-sm font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 cursor-pointer"
            >
              {t("leaseForceTakeover")}
            </button>
          )}
        </div>

        {err && (
          <div
            data-testid="lease-error"
            className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2"
          >
            {err}
          </div>
        )}
      </div>
    </div>
  );
}
