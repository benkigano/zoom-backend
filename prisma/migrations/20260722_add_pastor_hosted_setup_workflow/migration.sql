ALTER TYPE "CourtStudyRequestStatus"
ADD VALUE IF NOT EXISTS 'AWAITING_MEETING_DETAILS';

ALTER TYPE "CourtStudyRequestStatus"
ADD VALUE IF NOT EXISTS 'MEETING_DETAILS_SUBMITTED';

ALTER TABLE "CourtStudyMeeting"
ADD COLUMN "zoomPasscode" TEXT,
ADD COLUMN "pastorSetupToken" TEXT,
ADD COLUMN "pastorSetupTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN "meetingSetupRequestedAt" TIMESTAMP(3),
ADD COLUMN "meetingDetailsSubmittedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "CourtStudyMeeting_pastorSetupToken_key"
ON "CourtStudyMeeting"("pastorSetupToken");
