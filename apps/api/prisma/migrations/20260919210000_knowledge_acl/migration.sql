ALTER TABLE "Team" ADD COLUMN "createdById" TEXT;
ALTER TABLE "Team" ADD COLUMN "knowledgeAccessMode" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "KnowledgeDocument" ADD COLUMN "accessMode" TEXT NOT NULL DEFAULT 'inherit';

ALTER TABLE "Team" ADD CONSTRAINT "Team_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "KnowledgeBaseGrant" (
  "id" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "granteeKind" TEXT NOT NULL,
  "granteeId" TEXT NOT NULL,
  "canView" BOOLEAN NOT NULL DEFAULT false,
  "canEdit" BOOLEAN NOT NULL DEFAULT false,
  "canDelete" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnowledgeBaseGrant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "KnowledgeBaseGrant_teamId_granteeKind_granteeId_key" ON "KnowledgeBaseGrant"("teamId", "granteeKind", "granteeId");
CREATE INDEX "KnowledgeBaseGrant_granteeKind_granteeId_idx" ON "KnowledgeBaseGrant"("granteeKind", "granteeId");
ALTER TABLE "KnowledgeBaseGrant" ADD CONSTRAINT "KnowledgeBaseGrant_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "KnowledgeDocumentGrant" (
  "id" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "granteeKind" TEXT NOT NULL,
  "granteeId" TEXT NOT NULL,
  "canView" BOOLEAN NOT NULL DEFAULT false,
  "canEdit" BOOLEAN NOT NULL DEFAULT false,
  "canDelete" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnowledgeDocumentGrant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "KnowledgeDocumentGrant_documentId_granteeKind_granteeId_key" ON "KnowledgeDocumentGrant"("documentId", "granteeKind", "granteeId");
CREATE INDEX "KnowledgeDocumentGrant_granteeKind_granteeId_idx" ON "KnowledgeDocumentGrant"("granteeKind", "granteeId");
ALTER TABLE "KnowledgeDocumentGrant" ADD CONSTRAINT "KnowledgeDocumentGrant_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "KnowledgePermissionRequest" (
  "id" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "requesterId" TEXT NOT NULL,
  "permission" TEXT NOT NULL,
  "message" VARCHAR(500),
  "status" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "handledAt" TIMESTAMP(3),
  CONSTRAINT "KnowledgePermissionRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "KnowledgePermissionRequest_documentId_requesterId_key" ON "KnowledgePermissionRequest"("documentId", "requesterId");
CREATE INDEX "KnowledgePermissionRequest_status_createdAt_idx" ON "KnowledgePermissionRequest"("status", "createdAt");
ALTER TABLE "KnowledgePermissionRequest" ADD CONSTRAINT "KnowledgePermissionRequest_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgePermissionRequest" ADD CONSTRAINT "KnowledgePermissionRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
