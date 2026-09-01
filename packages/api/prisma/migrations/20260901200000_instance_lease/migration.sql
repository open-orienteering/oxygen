-- Cluster-wide singleton lease. One row per named responsibility; the
-- holder renews `expires_at` on a timer and any instance may take the
-- lease over once it lapses. All timestamps come from the database so
-- instance clock skew cannot hand the lease to two holders at once.
CREATE TABLE "oxygen"."instance_lease" (
    "name" VARCHAR(64) NOT NULL,
    "holder_id" VARCHAR(64) NOT NULL,
    "acquired_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "renewed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "instance_lease_pkey" PRIMARY KEY ("name")
);
