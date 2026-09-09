ALTER TABLE "Project"
  ADD COLUMN "importStartedAt" TIMESTAMP(3),
  ADD COLUMN "importFinishedAt" TIMESTAMP(3),
  ADD COLUMN "importLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "importError" TEXT,
  ADD COLUMN "importAttempts" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "Project_status_importLeaseUntil_idx"
  ON "Project"("status", "importLeaseUntil");
