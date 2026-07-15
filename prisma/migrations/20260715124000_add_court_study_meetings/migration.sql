-- CreateEnum
CREATE TYPE "ZoomConnectionStatus" AS ENUM (
  'CONNECTED',
  'REAUTHORIZATION_REQUIRED',
  'REVOKED',
  'DISCONNECTED'
);

-- CreateEnum
CREATE TYPE "CourtStudyMeetingStatus" AS ENUM (
  'DRAFT',
  'PENDING',
  'CREATING',
  'SCHEDULED',
  'COMPLETED',
  'CANCELLED',
  'FAILED'
);

-- CreateEnum
CREATE TYPE "CourtStudyDiscussionType" AS ENUM (
  'RULES_OF_PROCEDURE',
  'INTERVIEW_RECORDING'
);

-- AlterTable
ALTER TABLE "ChurchContact"
ADD COLUMN "canCreateCourtStudyMeetings" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "courtStudyApproved" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ChurchContactZoomConnection" (
  "id" TEXT NOT NULL,
  "churchContactId" TEXT NOT NULL,
  "zoomUserId" TEXT NOT NULL,
  "zoomAccountId" TEXT,
  "zoomEmail" TEXT,
  "accessTokenEncrypted" TEXT NOT NULL,
  "refreshTokenEncrypted" TEXT NOT NULL,
  "tokenExpiresAt" TIMESTAMP(3) NOT NULL,
  "authorizedScopes" TEXT,
  "status" "ZoomConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
  "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "disconnectedAt" TIMESTAMP(3),

  CONSTRAINT "ChurchContactZoomConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZoomOAuthInvitation" (
  "id" TEXT NOT NULL,
  "churchContactId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ZoomOAuthInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourtStudyTimeSlot" (
  "id" TEXT NOT NULL,
  "startTime" TIMESTAMP(3) NOT NULL,
  "endTime" TIMESTAMP(3) NOT NULL,
  "timezone" TEXT NOT NULL,
  "capacity" INTEGER,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "bookingDeadline" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CourtStudyTimeSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourtStudyMeeting" (
  "id" TEXT NOT NULL,
  "churchContactId" TEXT NOT NULL,
  "timeSlotId" TEXT,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "discussionType" "CourtStudyDiscussionType" NOT NULL,
  "selectedChapter" TEXT,
  "selectedSection" TEXT,
  "selectedRecordingId" TEXT,
  "scheduledStart" TIMESTAMP(3) NOT NULL,
  "scheduledEnd" TIMESTAMP(3) NOT NULL,
  "timezone" TEXT NOT NULL,
  "zoomMeetingId" TEXT,
  "zoomRegistrationUrl" TEXT,
  "zoomJoinUrl" TEXT,
  "status" "CourtStudyMeetingStatus" NOT NULL DEFAULT 'DRAFT',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CourtStudyMeeting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChurchContactZoomConnection_churchContactId_key"
ON "ChurchContactZoomConnection"("churchContactId");

-- CreateIndex
CREATE UNIQUE INDEX "ZoomOAuthInvitation_tokenHash_key"
ON "ZoomOAuthInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "ZoomOAuthInvitation_churchContactId_idx"
ON "ZoomOAuthInvitation"("churchContactId");

-- CreateIndex
CREATE INDEX "ZoomOAuthInvitation_expiresAt_idx"
ON "ZoomOAuthInvitation"("expiresAt");

-- CreateIndex
CREATE INDEX "CourtStudyTimeSlot_startTime_idx"
ON "CourtStudyTimeSlot"("startTime");

-- CreateIndex
CREATE INDEX "CourtStudyTimeSlot_isActive_idx"
ON "CourtStudyTimeSlot"("isActive");

-- CreateIndex
CREATE INDEX "CourtStudyMeeting_churchContactId_idx"
ON "CourtStudyMeeting"("churchContactId");

-- CreateIndex
CREATE INDEX "CourtStudyMeeting_timeSlotId_idx"
ON "CourtStudyMeeting"("timeSlotId");

-- CreateIndex
CREATE INDEX "CourtStudyMeeting_scheduledStart_idx"
ON "CourtStudyMeeting"("scheduledStart");

-- CreateIndex
CREATE INDEX "CourtStudyMeeting_status_idx"
ON "CourtStudyMeeting"("status");

-- AddForeignKey
ALTER TABLE "ChurchContactZoomConnection"
ADD CONSTRAINT "ChurchContactZoomConnection_churchContactId_fkey"
FOREIGN KEY ("churchContactId")
REFERENCES "ChurchContact"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoomOAuthInvitation"
ADD CONSTRAINT "ZoomOAuthInvitation_churchContactId_fkey"
FOREIGN KEY ("churchContactId")
REFERENCES "ChurchContact"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourtStudyMeeting"
ADD CONSTRAINT "CourtStudyMeeting_churchContactId_fkey"
FOREIGN KEY ("churchContactId")
REFERENCES "ChurchContact"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourtStudyMeeting"
ADD CONSTRAINT "CourtStudyMeeting_timeSlotId_fkey"
FOREIGN KEY ("timeSlotId")
REFERENCES "CourtStudyTimeSlot"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;
