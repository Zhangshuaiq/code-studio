ALTER TABLE "Project" ADD COLUMN "storageKey" TEXT NOT NULL DEFAULT 'primary';
ALTER TABLE "Project" ADD COLUMN "storagePath" TEXT NOT NULL DEFAULT '';
UPDATE "Project" SET "storagePath" = "id";
