ALTER TABLE "CourtStudyMeeting"
ADD COLUMN "invitationSentAt" TIMESTAMP(3),
ADD COLUMN "invitationSentTo" TEXT,
ADD COLUMN "invitationSendCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "invitationLastError" TEXT,
ADD COLUMN "publicInvitationToken" TEXT;

CREATE UNIQUE INDEX "CourtStudyMeeting_publicInvitationToken_key"
ON "CourtStudyMeeting"("publicInvitationToken");
