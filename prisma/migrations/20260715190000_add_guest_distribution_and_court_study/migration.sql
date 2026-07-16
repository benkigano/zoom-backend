-- CreateEnum
CREATE TYPE "GuestDistributionCampaignStatus" AS ENUM (
  'DRAFT',
  'READY',
  'SENT_TO_GUEST',
  'ACTIVE',
  'CLOSED'
);

-- CreateEnum
CREATE TYPE "CourtStudyRequestStatus" AS ENUM (
  'PENDING',
  'APPROVED',
  'DECLINED',
  'SCHEDULED',
  'COMPLETED',
  'CANCELLED'
);

-- CreateEnum
CREATE TYPE "CourtStudyHostMode" AS ENUM (
  'COURT_HOSTED',
  'PASTOR_HOSTED',
  'IN_PERSON',
  'HYBRID'
);

-- CreateTable
CREATE TABLE "GuestDistributionCampaign" (
  "id" TEXT NOT NULL,
  "recordingId" TEXT NOT NULL,
  "guestName" TEXT NOT NULL,
  "guestEmail" TEXT NOT NULL,
  "organizationName" TEXT,
  "distributionToken" TEXT NOT NULL,
  "status" "GuestDistributionCampaignStatus" NOT NULL DEFAULT 'DRAFT',
  "sentAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "GuestDistributionCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourtStudyRequest" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "recordingId" TEXT NOT NULL,
  "pastorName" TEXT NOT NULL,
  "pastorEmail" TEXT NOT NULL,
  "roleTitle" TEXT,
  "churchName" TEXT NOT NULL,
  "dioceseOrGroup" TEXT,
  "phone" TEXT,
  "preferredStart" TIMESTAMP(3),
  "timezone" TEXT,
  "meetingFormat" "CourtStudyHostMode",
  "estimatedAttendance" INTEGER,
  "notes" TEXT,
  "status" "CourtStudyRequestStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CourtStudyRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GuestDistributionCampaign_distributionToken_key"
ON "GuestDistributionCampaign"("distributionToken");

-- CreateIndex
CREATE INDEX "GuestDistributionCampaign_recordingId_idx"
ON "GuestDistributionCampaign"("recordingId");

-- CreateIndex
CREATE INDEX "GuestDistributionCampaign_guestEmail_idx"
ON "GuestDistributionCampaign"("guestEmail");

-- CreateIndex
CREATE INDEX "GuestDistributionCampaign_status_idx"
ON "GuestDistributionCampaign"("status");

-- CreateIndex
CREATE INDEX "GuestDistributionCampaign_expiresAt_idx"
ON "GuestDistributionCampaign"("expiresAt");

-- CreateIndex
CREATE INDEX "CourtStudyRequest_campaignId_idx"
ON "CourtStudyRequest"("campaignId");

-- CreateIndex
CREATE INDEX "CourtStudyRequest_recordingId_idx"
ON "CourtStudyRequest"("recordingId");

-- CreateIndex
CREATE INDEX "CourtStudyRequest_pastorEmail_idx"
ON "CourtStudyRequest"("pastorEmail");

-- CreateIndex
CREATE INDEX "CourtStudyRequest_status_idx"
ON "CourtStudyRequest"("status");

-- CreateIndex
CREATE INDEX "CourtStudyRequest_preferredStart_idx"
ON "CourtStudyRequest"("preferredStart");

-- AddForeignKey
ALTER TABLE "GuestDistributionCampaign"
ADD CONSTRAINT "GuestDistributionCampaign_recordingId_fkey"
FOREIGN KEY ("recordingId")
REFERENCES "Recording"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourtStudyRequest"
ADD CONSTRAINT "CourtStudyRequest_campaignId_fkey"
FOREIGN KEY ("campaignId")
REFERENCES "GuestDistributionCampaign"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourtStudyRequest"
ADD CONSTRAINT "CourtStudyRequest_recordingId_fkey"
FOREIGN KEY ("recordingId")
REFERENCES "Recording"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
