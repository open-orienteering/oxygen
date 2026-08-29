-- Invite-only operator identities. Email is stored lowercase by the API.

CREATE TABLE "oxygen"."users" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL DEFAULT '',
    "is_admin" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "last_seen_at" TIMESTAMPTZ(6),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_email_key" ON "oxygen"."users"("email");

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON oxygen.users
  FOR EACH ROW EXECUTE FUNCTION oxygen.set_updated_at();
