ALTER TABLE "MonitoringAlertEvent"
  ADD COLUMN "notificationStatus" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "notificationError" TEXT,
  ADD COLUMN "notifiedAt" TIMESTAMP(3);
