ALTER TABLE "Project"
  ADD COLUMN "deletionStartedAt" TIMESTAMP(3),
  ADD COLUMN "deletionError" TEXT;

CREATE INDEX "Project_status_deletionStartedAt_idx"
  ON "Project"("status", "deletionStartedAt");
