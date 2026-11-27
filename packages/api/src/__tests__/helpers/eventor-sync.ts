/** Preview, then apply with the previewed cancel ids: what the event page does. */
export async function applySync(caller: {
  eventor: {
    sync: (i: { dryRun?: boolean; confirmCancelIds?: string[] }) => Promise<{ cancelIds: string[] }>;
  };
}) {
  const preview = await caller.eventor.sync({ dryRun: true });
  return caller.eventor.sync({ confirmCancelIds: preview.cancelIds });
}
