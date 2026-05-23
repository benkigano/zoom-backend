CREATE TYPE "RecordingStatus" AS ENUM ('DRAFT', 'READY', 'SENT', 'ARCHIVED');

CREATE TYPE "DistributionStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

CREATE TABLE "Recording" (
  "id" TEXT NOT NULL,
  "interviewRequestId" TEXT,
  "zoomMeetingId" TEXT,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "speakerName" TEXT,
  "speakerTitle" TEXT,
  "organizationName" TEXT,
  "recordingUrl" TEXT NOT NULL,
  "transcriptUrl" TEXT,
  "thumbnailUrl" TEXT,
  "status" "RecordingStatus" NOT NULL DEFAULT 'DRAFT',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Recording_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DistributionLog" (
  "id" TEXT NOT NULL,
  "recordingId" TEXT NOT NULL,
  "churchId" TEXT,
  "churchContactId" TEXT,
  "toEmail" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "status" "DistributionStatus" NOT NULL DEFAULT 'PENDING',
  "sentAt" TIMESTAMP(3),
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DistributionLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Recording_interviewRequestId_idx" ON "Recording"("interviewRequestId");
CREATE INDEX "Recording_zoomMeetingId_idx" ON "Recording"("zoomMeetingId");
CREATE INDEX "Recording_status_idx" ON "Recording"("status");

CREATE INDEX "DistributionLog_recordingId_idx" ON "DistributionLog"("recordingId");
CREATE INDEX "DistributionLog_churchId_idx" ON "DistributionLog"("churchId");
CREATE INDEX "DistributionLog_churchContactId_idx" ON "DistributionLog"("churchContactId");
CREATE INDEX "DistributionLog_status_idx" ON "DistributionLog"("status");
CREATE INDEX "DistributionLog_toEmail_idx" ON "DistributionLog"("toEmail");

ALTER TABLE "DistributionLog"
ADD CONSTRAINT "DistributionLog_recordingId_fkey"
FOREIGN KEY ("recordingId") REFERENCES "Recording"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DistributionLog"
ADD CONSTRAINT "DistributionLog_churchId_fkey"
FOREIGN KEY ("churchId") REFERENCES "Church"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DistributionLog"
ADD CONSTRAINT "DistributionLog_churchContactId_fkey"
FOREIGN KEY ("churchContactId") REFERENCES "ChurchContact"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
