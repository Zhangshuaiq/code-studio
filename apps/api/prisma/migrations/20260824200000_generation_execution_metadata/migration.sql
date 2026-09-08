ALTER TABLE "Task"
  ADD COLUMN "executorKind" TEXT,
  ADD COLUMN "executionNamespace" TEXT,
  ADD COLUMN "executionRef" TEXT,
  ADD COLUMN "failureCode" TEXT,
  ADD COLUMN "startedAt" TIMESTAMP(3);

CREATE INDEX "Task_executorKind_executionNamespace_executionRef_idx"
  ON "Task"("executorKind", "executionNamespace", "executionRef");
CREATE INDEX "Task_failureCode_idx" ON "Task"("failureCode");
