ALTER TABLE "Project"
  ADD COLUMN "deletionAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deletionNextAttemptAt" TIMESTAMP(3);

CREATE INDEX "Project_status_deletionNextAttemptAt_idx"
  ON "Project"("status", "deletionNextAttemptAt");
