ALTER TABLE "Deployment" ADD COLUMN "activeRecordId" TEXT;

CREATE INDEX "Deployment_activeRecordId_idx" ON "Deployment"("activeRecordId");
