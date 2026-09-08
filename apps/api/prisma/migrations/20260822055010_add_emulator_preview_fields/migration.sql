-- AlterTable
ALTER TABLE "PreviewInstance" ADD COLUMN     "emulatorContainerId" TEXT,
ADD COLUMN     "extra" JSONB,
ADD COLUMN     "webrtcEndpoint" TEXT,
ADD COLUMN     "webrtcTokenEnc" TEXT;
