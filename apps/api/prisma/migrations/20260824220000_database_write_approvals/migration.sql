CREATE TABLE "DatabaseApproval" (
  "id" TEXT NOT NULL,
  "datasourceId" TEXT NOT NULL,
  "requesterId" TEXT NOT NULL,
  "requesterName" TEXT NOT NULL,
  "approverId" TEXT,
  "approverName" TEXT,
  "database" TEXT,
  "sql" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "resultSummary" JSONB,
  "error" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  "executedAt" TIMESTAMP(3),
  CONSTRAINT "DatabaseApproval_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DatabaseApproval_datasourceId_fkey" FOREIGN KEY ("datasourceId") REFERENCES "Datasource"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "DatabaseApproval_status_requestedAt_idx" ON "DatabaseApproval"("status", "requestedAt");
CREATE INDEX "DatabaseApproval_datasourceId_requestedAt_idx" ON "DatabaseApproval"("datasourceId", "requestedAt");
CREATE INDEX "DatabaseApproval_requesterId_requestedAt_idx" ON "DatabaseApproval"("requesterId", "requestedAt");
