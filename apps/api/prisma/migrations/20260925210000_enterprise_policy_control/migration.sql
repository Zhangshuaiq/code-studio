CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "verifiedDomains" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "seatLimit" INTEGER NOT NULL DEFAULT 10,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrganizationMember" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrganizationMember_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EnterprisePolicy" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "terminalEnabled" BOOLEAN NOT NULL DEFAULT true,
    "allowedModelEngines" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "allowedConnectorTypes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "allowedGitHosts" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "allowedNetworkHosts" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "minimumClientVersion" TEXT NOT NULL DEFAULT '0.1.0',
    "offlineDays" INTEGER NOT NULL DEFAULT 7,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EnterprisePolicy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");
CREATE UNIQUE INDEX "OrganizationMember_organizationId_userId_key" ON "OrganizationMember"("organizationId", "userId");
CREATE INDEX "OrganizationMember_userId_status_idx" ON "OrganizationMember"("userId", "status");
CREATE UNIQUE INDEX "EnterprisePolicy_organizationId_key" ON "EnterprisePolicy"("organizationId");
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EnterprisePolicy" ADD CONSTRAINT "EnterprisePolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
