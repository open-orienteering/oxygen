-- Per-course visit-order mode. `ordered` (default) requires the control
-- sequence; `free_order` accepts any order (no leg lines / sequence numbers
-- on the map and description sheet). A future `score` value is reserved for
-- rogaining and can be added with ALTER TYPE ... ADD VALUE.
CREATE TYPE "oxygen"."course_order_mode" AS ENUM ('ordered', 'free_order');

ALTER TABLE "oxygen"."courses"
  ADD COLUMN IF NOT EXISTS "order_mode" "oxygen"."course_order_mode" NOT NULL DEFAULT 'ordered';
