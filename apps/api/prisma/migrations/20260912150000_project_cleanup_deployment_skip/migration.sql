ALTER TABLE "Project"
  ADD COLUMN "deletionDeploymentSkipAt" TIMESTAMP(3),
  ADD COLUMN "deletionDeploymentSkipById" TEXT,
  ADD COLUMN "deletionDeploymentSkipByName" TEXT,
  ADD COLUMN "deletionDeploymentSkipNote" TEXT;
