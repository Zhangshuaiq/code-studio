CREATE TABLE "PreviewBuildRecord" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "jobName" TEXT NOT NULL,
  "image" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'building',
  "logsTail" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "durationMs" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PreviewBuildRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PreviewBuildRecord_jobName_key" ON "PreviewBuildRecord"("jobName");
CREATE INDEX "PreviewBuildRecord_projectId_createdAt_idx" ON "PreviewBuildRecord"("projectId", "createdAt");
CREATE INDEX "PreviewBuildRecord_status_createdAt_idx" ON "PreviewBuildRecord"("status", "createdAt");
CREATE INDEX "PreviewBuildRecord_sessionId_createdAt_idx" ON "PreviewBuildRecord"("sessionId", "createdAt");
