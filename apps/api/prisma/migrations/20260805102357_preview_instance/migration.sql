-- CreateTable
CREATE TABLE "PreviewInstance" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'starting',
    "url" TEXT,
    "hostPort" INTEGER,
    "containerPort" INTEGER,
    "logsTail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PreviewInstance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PreviewInstance_sessionId_key" ON "PreviewInstance"("sessionId");

-- AddForeignKey
ALTER TABLE "PreviewInstance" ADD CONSTRAINT "PreviewInstance_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
