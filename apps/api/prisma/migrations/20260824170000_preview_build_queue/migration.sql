ALTER TABLE "PreviewBuildRecord"
  ADD COLUMN "teamId" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "namespace" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "startedAt" DROP NOT NULL,
  ALTER COLUMN "status" SET DEFAULT 'queued';

ALTER TABLE "PreviewBuildRecord"
  ALTER COLUMN "teamId" DROP DEFAULT,
  ALTER COLUMN "namespace" DROP DEFAULT;

CREATE INDEX "PreviewBuildRecord_teamId_status_queuedAt_idx" ON "PreviewBuildRecord"("teamId", "status", "queuedAt");
CREATE INDEX "PreviewBuildRecord_userId_status_queuedAt_idx" ON "PreviewBuildRecord"("userId", "status", "queuedAt");
