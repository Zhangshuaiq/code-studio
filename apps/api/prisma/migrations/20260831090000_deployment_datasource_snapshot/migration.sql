ALTER TABLE "Deployment"
  ADD COLUMN "datasourceId" TEXT,
  ADD COLUMN "datasourceName" TEXT;

ALTER TABLE "DeploymentRecord"
  ADD COLUMN "datasourceId" TEXT,
  ADD COLUMN "datasourceName" TEXT;

CREATE INDEX "DeploymentRecord_datasourceId_idx" ON "DeploymentRecord"("datasourceId");
