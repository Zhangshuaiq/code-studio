-- CreateTable
CREATE TABLE "ProjectRemote" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "remoteUrl" TEXT NOT NULL,
    "username" TEXT,
    "encryptedToken" TEXT NOT NULL,
    "branch" TEXT NOT NULL DEFAULT 'main',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectRemote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProjectRemote_projectId_key" ON "ProjectRemote"("projectId");

-- AddForeignKey
ALTER TABLE "ProjectRemote" ADD CONSTRAINT "ProjectRemote_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
