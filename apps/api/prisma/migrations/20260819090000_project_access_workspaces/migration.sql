-- 共享项目采用“项目角色 + 每用户独立工作区/会话”。
ALTER TABLE "ProjectMember" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'developer';

ALTER TABLE "Session" ADD COLUMN "userId" TEXT;
ALTER TABLE "Session" ADD COLUMN "workspacePath" TEXT;
ALTER TABLE "Session" ADD COLUMN "workspaceBranch" TEXT;

-- 旧会话均属于项目创建者，并继续使用原项目目录，保证无损升级。
UPDATE "Session" s
SET "userId" = p."userId", "workspacePath" = p."volumePath"
FROM "Project" p
WHERE p."id" = s."projectId";

ALTER TABLE "Session" ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE UNIQUE INDEX "Session_projectId_userId_key" ON "Session"("projectId", "userId");
