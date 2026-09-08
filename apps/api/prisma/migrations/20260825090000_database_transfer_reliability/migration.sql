ALTER TABLE "DatabaseTransfer"
  ADD COLUMN "conflictStrategy" TEXT NOT NULL DEFAULT 'fail',
  ADD COLUMN "preflight" JSONB,
  ADD COLUMN "checkpoints" JSONB,
  ADD COLUMN "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "leaseOwner" TEXT,
  ADD COLUMN "heartbeatAt" TIMESTAMP(3);
