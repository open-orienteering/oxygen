/**
 * Possession rule for a map source (docs/map-storage.md §5): a source row is
 * content-addressed and shared across the instance, so a hash alone must not
 * be enough to make its bytes a club map or an event's map (the club-map
 * download gate, `canDownloadClubMapVersion`, would otherwise be one
 * `addFromSource` away from being bypassed).
 *
 * The caller proves it holds the bytes by having finalised an upload of them
 * itself: a `map_uploads` row with `finalised_hash = fileHash` and
 * `uploaded_by = caller`. Finalise records the hash even when the bytes
 * deduplicated onto an existing source, so re-uploading the same file is
 * always a way in. Upload rows live `UPLOAD_TTL_MS` (24 h), so the proof is
 * "uploaded it in the last day".
 */
import { TRPCError } from "@trpc/server";
import { prisma } from "../db.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { AuthUser } from "../auth.js";

export interface SourceCaller {
  authEnabled: boolean;
  user: AuthUser | null;
}

export async function assertMayConsumeSource(
  ctx: SourceCaller,
  fileHash: string,
  db: Pick<PrismaClient, "mapUpload"> = prisma(),
): Promise<void> {
  if (!ctx.authEnabled) return;
  if (ctx.user?.isAdmin) return;
  if (ctx.user) {
    const own = await db.mapUpload.findFirst({
      where: { finalisedHash: fileHash, uploadedBy: ctx.user.id },
      select: { id: true },
    });
    if (own) return;
  }
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "Upload the file again",
  });
}
