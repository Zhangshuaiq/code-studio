-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "targetId" TEXT,
ADD COLUMN     "targetName" TEXT;

-- CreateTable
CREATE TABLE "DeployTarget" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "encryptedConfig" TEXT NOT NULL,
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeployTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeployTarget_userId_idx" ON "DeployTarget"("userId");

-- AddForeignKey
ALTER TABLE "DeployTarget" ADD CONSTRAINT "DeployTarget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
