/*
  Warnings:

  - Added the required column `updatedAt` to the `DeployTarget` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "DeployTarget" ADD COLUMN     "capacityCpu" DOUBLE PRECISION,
ADD COLUMN     "capacityMemoryMb" INTEGER,
ADD COLUMN     "enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "maxPreviewInstances" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "purposes" TEXT[] DEFAULT ARRAY['deploy']::TEXT[],
ADD COLUMN     "scope" TEXT NOT NULL DEFAULT 'personal',
ADD COLUMN     "teamId" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Existing rows receive the migration time; future writes are maintained by Prisma @updatedAt.
ALTER TABLE "DeployTarget" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "branch" TEXT,
ADD COLUMN     "deployedById" TEXT,
ADD COLUMN     "deployedByName" TEXT,
ADD COLUMN     "environment" TEXT NOT NULL DEFAULT 'default';

-- AlterTable
ALTER TABLE "PreviewInstance" ADD COLUMN     "targetId" TEXT,
ADD COLUMN     "targetName" TEXT;

-- AlterTable
ALTER TABLE "SandboxInstance" ADD COLUMN     "cpu" DOUBLE PRECISION NOT NULL DEFAULT 1,
ADD COLUMN     "memoryMb" INTEGER NOT NULL DEFAULT 1024,
ADD COLUMN     "runtimeKind" TEXT NOT NULL DEFAULT 'local-docker',
ADD COLUMN     "targetId" TEXT,
ADD COLUMN     "targetName" TEXT;

-- CreateTable
CREATE TABLE "ProjectRuntimeBinding" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "branchPattern" TEXT NOT NULL DEFAULT '*',
    "config" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectRuntimeBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentRecord" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "targetId" TEXT,
    "targetName" TEXT,
    "environment" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "gitSha" TEXT,
    "status" TEXT NOT NULL,
    "url" TEXT,
    "logsTail" TEXT,
    "deployedById" TEXT NOT NULL,
    "deployedByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeploymentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectRuntimeBinding_projectId_idx" ON "ProjectRuntimeBinding"("projectId");

-- CreateIndex
CREATE INDEX "ProjectRuntimeBinding_targetId_idx" ON "ProjectRuntimeBinding"("targetId");

-- CreateIndex
CREATE INDEX "ProjectRuntimeBinding_purpose_idx" ON "ProjectRuntimeBinding"("purpose");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectRuntimeBinding_projectId_purpose_environment_key" ON "ProjectRuntimeBinding"("projectId", "purpose", "environment");

-- CreateIndex
CREATE INDEX "DeploymentRecord_projectId_createdAt_idx" ON "DeploymentRecord"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "DeploymentRecord_status_idx" ON "DeploymentRecord"("status");

-- CreateIndex
CREATE INDEX "DeploymentRecord_deployedById_idx" ON "DeploymentRecord"("deployedById");

-- CreateIndex
CREATE INDEX "DeployTarget_teamId_idx" ON "DeployTarget"("teamId");

-- CreateIndex
CREATE INDEX "DeployTarget_scope_idx" ON "DeployTarget"("scope");

-- CreateIndex
CREATE INDEX "SandboxInstance_targetId_idx" ON "SandboxInstance"("targetId");

-- AddForeignKey
ALTER TABLE "DeployTarget" ADD CONSTRAINT "DeployTarget_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRuntimeBinding" ADD CONSTRAINT "ProjectRuntimeBinding_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRuntimeBinding" ADD CONSTRAINT "ProjectRuntimeBinding_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "DeployTarget"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentRecord" ADD CONSTRAINT "DeploymentRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentRecord" ADD CONSTRAINT "DeploymentRecord_deployedById_fkey" FOREIGN KEY ("deployedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SandboxInstance" ADD CONSTRAINT "SandboxInstance_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "DeployTarget"("id") ON DELETE SET NULL ON UPDATE CASCADE;
