ALTER TABLE "Project"
  ADD COLUMN "deletionAcknowledgedAt" TIMESTAMP(3),
  ADD COLUMN "deletionAcknowledgedById" TEXT,
  ADD COLUMN "deletionAcknowledgedByName" TEXT,
  ADD COLUMN "deletionAcknowledgementNote" TEXT;
