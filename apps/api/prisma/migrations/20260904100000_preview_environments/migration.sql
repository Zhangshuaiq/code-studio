CREATE TABLE "Requirement" (
    "id" TEXT NOT NULL,
    "requirementNo" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "contentMarkdown" TEXT NOT NULL DEFAULT '',
    "documentVersion" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currentStage" TEXT NOT NULL DEFAULT 'design',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "plannedStartAt" TIMESTAMP(3),
    "plannedEndAt" TIMESTAMP(3),
    "ownerId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Requirement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RequirementStage" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "ownerId" TEXT,
    "descriptionMarkdown" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "blockedReason" TEXT,
    "plannedStartAt" TIMESTAMP(3),
    "plannedEndAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RequirementStage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RequirementRevision" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "contentMarkdown" TEXT NOT NULL,
    "changeSummary" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RequirementRevision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RequirementProject" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "serviceKey" TEXT NOT NULL,
    "developerId" TEXT,
    "sessionId" TEXT,
    "branchName" TEXT,
    "changeRequired" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RequirementProject_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RequirementActivity" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RequirementActivity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PreviewSourceSnapshot" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "archivePath" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "downloadedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PreviewSourceSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RequirementRouteEndpoint" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "previewInstanceId" TEXT NOT NULL,
    "serviceKey" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "serviceName" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "endpointUrl" TEXT NOT NULL,
    "publicUrl" TEXT,
    "readyAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RequirementRouteEndpoint_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PreviewInstance" ADD COLUMN "requirementId" TEXT;
ALTER TABLE "PreviewInstance" ADD COLUMN "serviceKey" TEXT;

CREATE UNIQUE INDEX "Requirement_requirementNo_key" ON "Requirement"("requirementNo");
CREATE INDEX "Requirement_teamId_status_updatedAt_idx" ON "Requirement"("teamId", "status", "updatedAt");
CREATE INDEX "Requirement_ownerId_status_idx" ON "Requirement"("ownerId", "status");
CREATE UNIQUE INDEX "RequirementStage_requirementId_type_key" ON "RequirementStage"("requirementId", "type");
CREATE INDEX "RequirementStage_ownerId_status_idx" ON "RequirementStage"("ownerId", "status");
CREATE INDEX "RequirementStage_requirementId_sortOrder_idx" ON "RequirementStage"("requirementId", "sortOrder");
CREATE UNIQUE INDEX "RequirementRevision_requirementId_version_key" ON "RequirementRevision"("requirementId", "version");
CREATE INDEX "RequirementRevision_requirementId_createdAt_idx" ON "RequirementRevision"("requirementId", "createdAt");
CREATE UNIQUE INDEX "RequirementProject_requirementId_projectId_key" ON "RequirementProject"("requirementId", "projectId");
CREATE UNIQUE INDEX "RequirementProject_requirementId_serviceKey_key" ON "RequirementProject"("requirementId", "serviceKey");
CREATE INDEX "RequirementProject_projectId_idx" ON "RequirementProject"("projectId");
CREATE INDEX "RequirementProject_developerId_status_idx" ON "RequirementProject"("developerId", "status");
CREATE INDEX "RequirementProject_sessionId_idx" ON "RequirementProject"("sessionId");
CREATE INDEX "RequirementActivity_requirementId_createdAt_idx" ON "RequirementActivity"("requirementId", "createdAt");
CREATE INDEX "RequirementActivity_actorId_createdAt_idx" ON "RequirementActivity"("actorId", "createdAt");
CREATE INDEX "PreviewInstance_requirementId_idx" ON "PreviewInstance"("requirementId");
CREATE INDEX "PreviewInstance_requirementId_serviceKey_idx" ON "PreviewInstance"("requirementId", "serviceKey");
CREATE UNIQUE INDEX "PreviewSourceSnapshot_tokenHash_key" ON "PreviewSourceSnapshot"("tokenHash");
CREATE INDEX "PreviewSourceSnapshot_sessionId_createdAt_idx" ON "PreviewSourceSnapshot"("sessionId", "createdAt");
CREATE INDEX "PreviewSourceSnapshot_status_expiresAt_idx" ON "PreviewSourceSnapshot"("status", "expiresAt");
CREATE UNIQUE INDEX "RequirementRouteEndpoint_previewInstanceId_key" ON "RequirementRouteEndpoint"("previewInstanceId");
CREATE UNIQUE INDEX "RequirementRouteEndpoint_requirementId_serviceKey_key" ON "RequirementRouteEndpoint"("requirementId", "serviceKey");
CREATE INDEX "RequirementRouteEndpoint_targetId_namespace_idx" ON "RequirementRouteEndpoint"("targetId", "namespace");
CREATE INDEX "RequirementRouteEndpoint_leaseExpiresAt_idx" ON "RequirementRouteEndpoint"("leaseExpiresAt");
CREATE UNIQUE INDEX "PreviewInstance_active_requirement_service_key" ON "PreviewInstance"("requirementId", "serviceKey") WHERE "requirementId" IS NOT NULL AND "serviceKey" IS NOT NULL AND "status" IN ('starting', 'ready');

ALTER TABLE "Requirement" ADD CONSTRAINT "Requirement_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Requirement" ADD CONSTRAINT "Requirement_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Requirement" ADD CONSTRAINT "Requirement_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RequirementStage" ADD CONSTRAINT "RequirementStage_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "Requirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RequirementStage" ADD CONSTRAINT "RequirementStage_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RequirementRevision" ADD CONSTRAINT "RequirementRevision_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "Requirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RequirementRevision" ADD CONSTRAINT "RequirementRevision_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RequirementProject" ADD CONSTRAINT "RequirementProject_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "Requirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RequirementProject" ADD CONSTRAINT "RequirementProject_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RequirementProject" ADD CONSTRAINT "RequirementProject_developerId_fkey" FOREIGN KEY ("developerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RequirementProject" ADD CONSTRAINT "RequirementProject_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RequirementActivity" ADD CONSTRAINT "RequirementActivity_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "Requirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RequirementActivity" ADD CONSTRAINT "RequirementActivity_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PreviewInstance" ADD CONSTRAINT "PreviewInstance_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "Requirement"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PreviewSourceSnapshot" ADD CONSTRAINT "PreviewSourceSnapshot_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RequirementRouteEndpoint" ADD CONSTRAINT "RequirementRouteEndpoint_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "Requirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RequirementRouteEndpoint" ADD CONSTRAINT "RequirementRouteEndpoint_previewInstanceId_fkey" FOREIGN KEY ("previewInstanceId") REFERENCES "PreviewInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
