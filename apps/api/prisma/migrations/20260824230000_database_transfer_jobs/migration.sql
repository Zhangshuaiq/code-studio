CREATE TABLE "DatabaseTransfer" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'migration',
  "sourceDatasourceId" TEXT NOT NULL,
  "targetDatasourceId" TEXT,
  "requesterId" TEXT NOT NULL,
  "requesterName" TEXT NOT NULL,
  "approverId" TEXT,
  "approverName" TEXT,
  "sourceDatabase" TEXT NOT NULL,
  "targetDatabase" TEXT,
  "tables" TEXT[],
  "status" TEXT NOT NULL DEFAULT 'pending_approval',
  "currentTable" TEXT,
  "totalTables" INTEGER NOT NULL DEFAULT 0,
  "completedTables" INTEGER NOT NULL DEFAULT 0,
  "totalRows" INTEGER NOT NULL DEFAULT 0,
  "migratedRows" INTEGER NOT NULL DEFAULT 0,
  "backupPath" TEXT,
  "error" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "DatabaseTransfer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DatabaseTransfer_sourceDatasourceId_fkey" FOREIGN KEY ("sourceDatasourceId") REFERENCES "Datasource"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "DatabaseTransfer_targetDatasourceId_fkey" FOREIGN KEY ("targetDatasourceId") REFERENCES "Datasource"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "DatabaseTransfer_status_requestedAt_idx" ON "DatabaseTransfer"("status", "requestedAt");
CREATE INDEX "DatabaseTransfer_requesterId_requestedAt_idx" ON "DatabaseTransfer"("requesterId", "requestedAt");
CREATE INDEX "DatabaseTransfer_sourceDatasourceId_requestedAt_idx" ON "DatabaseTransfer"("sourceDatasourceId", "requestedAt");
