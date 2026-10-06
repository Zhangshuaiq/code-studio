CREATE TABLE "LicenseRedeemCode" (
  "id" TEXT NOT NULL, "codeHash" TEXT NOT NULL, "codePrefix" TEXT NOT NULL, "edition" TEXT NOT NULL,
  "durationDays" INTEGER NOT NULL, "graceDays" INTEGER NOT NULL DEFAULT 7, "maxDevices" INTEGER NOT NULL DEFAULT 3,
  "maxRedemptions" INTEGER NOT NULL DEFAULT 1, "redemptionCount" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3), "disabledAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LicenseRedeemCode_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "LicenseRedemption" (
  "id" TEXT NOT NULL, "codeId" TEXT NOT NULL, "userId" TEXT NOT NULL, "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LicenseRedemption_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LicenseRedeemCode_codeHash_key" ON "LicenseRedeemCode"("codeHash");
CREATE INDEX "LicenseRedeemCode_disabledAt_expiresAt_idx" ON "LicenseRedeemCode"("disabledAt", "expiresAt");
CREATE UNIQUE INDEX "LicenseRedemption_codeId_userId_key" ON "LicenseRedemption"("codeId", "userId");
CREATE INDEX "LicenseRedemption_userId_redeemedAt_idx" ON "LicenseRedemption"("userId", "redeemedAt");
ALTER TABLE "LicenseRedemption" ADD CONSTRAINT "LicenseRedemption_codeId_fkey" FOREIGN KEY ("codeId") REFERENCES "LicenseRedeemCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LicenseRedemption" ADD CONSTRAINT "LicenseRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
