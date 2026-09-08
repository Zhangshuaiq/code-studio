CREATE TABLE "MonitoringAlertRule" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "metric" TEXT NOT NULL,
  "operator" TEXT NOT NULL,
  "threshold" DOUBLE PRECISION NOT NULL,
  "windowMinutes" INTEGER NOT NULL DEFAULT 5,
  "environment" TEXT,
  "serviceName" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "cooldownMinutes" INTEGER NOT NULL DEFAULT 15,
  "lastTriggeredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MonitoringAlertRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MonitoringAlertEvent" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "ruleId" TEXT NOT NULL,
  "metric" TEXT NOT NULL,
  "value" DOUBLE PRECISION NOT NULL,
  "threshold" DOUBLE PRECISION NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'firing',
  "message" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MonitoringAlertEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MonitoringAlertRule_projectId_idx" ON "MonitoringAlertRule"("projectId");
CREATE INDEX "MonitoringAlertRule_enabled_idx" ON "MonitoringAlertRule"("enabled");
CREATE INDEX "MonitoringAlertEvent_projectId_createdAt_idx" ON "MonitoringAlertEvent"("projectId", "createdAt");
CREATE INDEX "MonitoringAlertEvent_ruleId_createdAt_idx" ON "MonitoringAlertEvent"("ruleId", "createdAt");
ALTER TABLE "MonitoringAlertRule" ADD CONSTRAINT "MonitoringAlertRule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MonitoringAlertEvent" ADD CONSTRAINT "MonitoringAlertEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MonitoringAlertEvent" ADD CONSTRAINT "MonitoringAlertEvent_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "MonitoringAlertRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
