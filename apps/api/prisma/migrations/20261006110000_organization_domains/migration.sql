CREATE TABLE "OrganizationDomain" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "domain" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrganizationDomain_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OrganizationDomain_organizationId_domain_key" ON "OrganizationDomain"("organizationId", "domain");
CREATE INDEX "OrganizationDomain_domain_verifiedAt_idx" ON "OrganizationDomain"("domain", "verifiedAt");
CREATE UNIQUE INDEX "OrganizationDomain_verified_domain_key" ON "OrganizationDomain"("domain") WHERE "verifiedAt" IS NOT NULL;
ALTER TABLE "OrganizationDomain" ADD CONSTRAINT "OrganizationDomain_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
