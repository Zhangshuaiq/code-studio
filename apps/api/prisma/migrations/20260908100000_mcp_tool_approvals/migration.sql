CREATE TABLE "McpToolApproval" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "requesterName" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "agentRunId" TEXT,
    "toolName" TEXT NOT NULL,
    "riskLevel" TEXT NOT NULL,
    "requiredPermissions" TEXT[] NOT NULL,
    "reviewerIds" TEXT[] NOT NULL,
    "environment" TEXT,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "resourceVersion" TEXT,
    "argumentsHash" TEXT NOT NULL,
    "argumentsSummary" JSONB NOT NULL,
    "impactSummary" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "reviewerId" TEXT,
    "reviewerName" TEXT,
    "decisionReason" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "McpToolApproval_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "McpToolApproval_requesterId_createdAt_idx" ON "McpToolApproval"("requesterId", "createdAt");
CREATE INDEX "McpToolApproval_status_expiresAt_idx" ON "McpToolApproval"("status", "expiresAt");
CREATE INDEX "McpToolApproval_toolName_argumentsHash_requesterId_idx" ON "McpToolApproval"("toolName", "argumentsHash", "requesterId");
CREATE INDEX "McpToolApproval_resourceType_resourceId_idx" ON "McpToolApproval"("resourceType", "resourceId");
CREATE INDEX "McpToolApproval_reviewerIds_idx" ON "McpToolApproval" USING GIN ("reviewerIds");
