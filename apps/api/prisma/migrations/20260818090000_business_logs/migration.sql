-- CreateTable
CREATE TABLE "SystemSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "BusinessLogSource" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "serviceName" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'json',
    "status" TEXT NOT NULL DEFAULT 'active',
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "lastIngestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessLogSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BusinessLogSource_tokenHash_key" ON "BusinessLogSource"("tokenHash");

-- CreateIndex
CREATE INDEX "BusinessLogSource_projectId_idx" ON "BusinessLogSource"("projectId");

-- CreateIndex
CREATE INDEX "BusinessLogSource_status_idx" ON "BusinessLogSource"("status");

-- AddForeignKey
ALTER TABLE "BusinessLogSource" ADD CONSTRAINT "BusinessLogSource_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the platform default. Runtime bootstrap also upserts this row for existing databases.
INSERT INTO "SystemSetting" ("key", "value", "updatedAt")
VALUES (
  'business_logs.policy',
  '{"retentionDays":30,"defaultQueryRangeMinutes":15,"maxQueryRangeHours":168,"maxResultLines":1000,"queryTimeoutSeconds":15}',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;
