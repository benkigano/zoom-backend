ALTER TYPE "CourtStudyRequestStatus"
ADD VALUE 'SESSION_REVIEW_PENDING';

ALTER TABLE "CourtStudyMeeting"
ADD COLUMN "zoomMeetingUuid" TEXT,
ADD COLUMN "actualSessionStart" TIMESTAMP(3),
ADD COLUMN "actualSessionEnd" TIMESTAMP(3),
ADD COLUMN "attendanceSyncedAt" TIMESTAMP(3),
ADD COLUMN "totalRegistered" INTEGER,
ADD COLUMN "totalAttended" INTEGER,
ADD COLUMN "sessionCompletedAt" TIMESTAMP(3);
