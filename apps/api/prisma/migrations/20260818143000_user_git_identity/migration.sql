-- Git 仓库地址属于项目；提交身份和推送凭据属于当前用户。
CREATE TABLE "UserGitProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "authorEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UserGitProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GitCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "username" TEXT,
    "authType" TEXT NOT NULL DEFAULT 'token',
    "encryptedToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GitCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserGitProfile_userId_key" ON "UserGitProfile"("userId");
CREATE UNIQUE INDEX "GitCredential_userId_host_key" ON "GitCredential"("userId", "host");
CREATE INDEX "GitCredential_userId_idx" ON "GitCredential"("userId");

ALTER TABLE "UserGitProfile" ADD CONSTRAINT "UserGitProfile_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GitCredential" ADD CONSTRAINT "GitCredential_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 将旧项目级 PAT 尽量迁移给项目创建者，并按远程主机去重。
INSERT INTO "GitCredential" (
  "id", "userId", "host", "username", "authType", "encryptedToken", "createdAt", "updatedAt"
)
SELECT DISTINCT ON (p."userId", legacy."host")
  md5(random()::text || clock_timestamp()::text),
  p."userId",
  legacy."host",
  pr."username",
  'token',
  pr."encryptedToken",
  pr."createdAt",
  CURRENT_TIMESTAMP
FROM "ProjectRemote" pr
JOIN "Project" p ON p."id" = pr."projectId"
CROSS JOIN LATERAL (
  SELECT lower(split_part(regexp_replace(pr."remoteUrl", '^https?://', '', 'i'), '/', 1)) AS "host"
) legacy
WHERE pr."encryptedToken" <> '' AND legacy."host" <> ''
ORDER BY p."userId", legacy."host", pr."updatedAt" DESC
ON CONFLICT ("userId", "host") DO NOTHING;

-- 兼容最早期未被业务使用的 GitConfig；若存在数据，同样迁移为用户凭据。
INSERT INTO "GitCredential" (
  "id", "userId", "host", "authType", "encryptedToken", "createdAt", "updatedAt"
)
SELECT DISTINCT ON (gc."userId", legacy."host")
  md5(random()::text || clock_timestamp()::text),
  gc."userId",
  legacy."host",
  'token',
  gc."encryptedCred",
  gc."createdAt",
  CURRENT_TIMESTAMP
FROM "GitConfig" gc
CROSS JOIN LATERAL (
  SELECT lower(split_part(regexp_replace(gc."remoteUrl", '^https?://', '', 'i'), '/', 1)) AS "host"
) legacy
WHERE gc."encryptedCred" <> '' AND legacy."host" <> ''
ORDER BY gc."userId", legacy."host", gc."createdAt" DESC
ON CONFLICT ("userId", "host") DO NOTHING;

ALTER TABLE "ProjectRemote" DROP COLUMN "username";
ALTER TABLE "ProjectRemote" DROP COLUMN "encryptedToken";
DROP TABLE "GitConfig";
