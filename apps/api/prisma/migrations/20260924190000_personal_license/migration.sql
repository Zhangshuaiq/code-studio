CREATE TABLE "LicenseSubscription" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "edition" TEXT NOT NULL DEFAULT 'personal-pro',
  "status" TEXT NOT NULL DEFAULT 'active',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "graceDays" INTEGER NOT NULL DEFAULT 7,
  "maxDevices" INTEGER NOT NULL DEFAULT 3,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LicenseSubscription_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "LicenseDevice" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "name" TEXT,
  "platform" TEXT,
  "appVersion" TEXT,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LicenseDevice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LicenseSubscription_userId_key" ON "LicenseSubscription"("userId");
CREATE INDEX "LicenseSubscription_status_expiresAt_idx" ON "LicenseSubscription"("status", "expiresAt");
CREATE UNIQUE INDEX "LicenseDevice_userId_deviceId_key" ON "LicenseDevice"("userId", "deviceId");
CREATE INDEX "LicenseDevice_userId_revokedAt_idx" ON "LicenseDevice"("userId", "revokedAt");
ALTER TABLE "LicenseSubscription" ADD CONSTRAINT "LicenseSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LicenseDevice" ADD CONSTRAINT "LicenseDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
