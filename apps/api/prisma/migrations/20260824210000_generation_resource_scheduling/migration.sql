ALTER TABLE "Task"
  ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "resourceWaitCount" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "Task_status_priority_createdAt_idx"
  ON "Task"("status", "priority", "createdAt");
