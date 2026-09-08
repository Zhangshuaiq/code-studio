CREATE TABLE "JavaTaskApplication" (
  "id" TEXT NOT NULL, "name" TEXT NOT NULL, "baseUrl" TEXT NOT NULL, "encryptedToken" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true, "lastRegisteredAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "JavaTaskApplication_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "JavaTaskApplication_name_key" ON "JavaTaskApplication"("name");
CREATE TABLE "JavaTaskHandler" (
  "id" TEXT NOT NULL, "applicationId" TEXT NOT NULL, "methodName" TEXT NOT NULL, "description" TEXT,
  "parameterSchema" JSONB, "riskLevel" TEXT NOT NULL DEFAULT 'medium', "timeoutSeconds" INTEGER NOT NULL DEFAULT 300,
  "allowConcurrent" BOOLEAN NOT NULL DEFAULT false, "idempotent" BOOLEAN NOT NULL DEFAULT false, "version" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true, "lastRegisteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JavaTaskHandler_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "JavaTaskHandler_applicationId_methodName_key" ON "JavaTaskHandler"("applicationId", "methodName");
CREATE INDEX "JavaTaskHandler_applicationId_enabled_idx" ON "JavaTaskHandler"("applicationId", "enabled");
CREATE TABLE "ScheduledJavaTask" (
  "id" TEXT NOT NULL, "name" TEXT NOT NULL, "applicationId" TEXT NOT NULL, "handlerId" TEXT NOT NULL, "parameters" JSONB NOT NULL,
  "scheduleType" TEXT NOT NULL DEFAULT 'immediate', "cronExpression" TEXT, "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  "executeAt" TIMESTAMP(3), "nextRunAt" TIMESTAMP(3), "status" TEXT NOT NULL DEFAULT 'pending_approval',
  "concurrencyPolicy" TEXT NOT NULL DEFAULT 'forbid', "timeoutSeconds" INTEGER NOT NULL, "maxRetries" INTEGER NOT NULL DEFAULT 0,
  "createdById" TEXT NOT NULL, "createdByName" TEXT NOT NULL, "approvedById" TEXT, "approvedByName" TEXT,
  "approvedAt" TIMESTAMP(3), "expiresAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "ScheduledJavaTask_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ScheduledJavaTask_status_nextRunAt_idx" ON "ScheduledJavaTask"("status", "nextRunAt");
CREATE INDEX "ScheduledJavaTask_createdById_createdAt_idx" ON "ScheduledJavaTask"("createdById", "createdAt");
CREATE TABLE "JavaTaskExecution" (
  "id" TEXT NOT NULL, "taskId" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'queued', "triggerType" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 1, "parametersSnapshot" JSONB NOT NULL, "handlerVersion" TEXT,
  "scheduledAt" TIMESTAMP(3) NOT NULL, "startedAt" TIMESTAMP(3), "finishedAt" TIMESTAMP(3), "heartbeatAt" TIMESTAMP(3),
  "resultSummary" JSONB, "error" TEXT, "traceId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JavaTaskExecution_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "JavaTaskExecution_traceId_key" ON "JavaTaskExecution"("traceId");
CREATE INDEX "JavaTaskExecution_taskId_createdAt_idx" ON "JavaTaskExecution"("taskId", "createdAt");
CREATE INDEX "JavaTaskExecution_status_scheduledAt_idx" ON "JavaTaskExecution"("status", "scheduledAt");
ALTER TABLE "JavaTaskHandler" ADD CONSTRAINT "JavaTaskHandler_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "JavaTaskApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduledJavaTask" ADD CONSTRAINT "ScheduledJavaTask_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "JavaTaskApplication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScheduledJavaTask" ADD CONSTRAINT "ScheduledJavaTask_handlerId_fkey" FOREIGN KEY ("handlerId") REFERENCES "JavaTaskHandler"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JavaTaskExecution" ADD CONSTRAINT "JavaTaskExecution_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ScheduledJavaTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
