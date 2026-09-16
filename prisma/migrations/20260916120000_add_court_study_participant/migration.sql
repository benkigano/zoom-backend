-- CreateTable
CREATE TABLE "CourtStudyParticipant" (
    "id" TEXT NOT NULL,
    "courtStudyMeetingId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "invitationToken" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'INVITED',
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "registeredAt" TIMESTAMP(3),
    "preSurveyScore" INTEGER,
    "preSurveyStatement" TEXT,
    "preSurveySubmittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourtStudyParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CourtStudyParticipant_invitationToken_key" ON "CourtStudyParticipant"("invitationToken");

-- CreateIndex
CREATE INDEX "CourtStudyParticipant_courtStudyMeetingId_idx" ON "CourtStudyParticipant"("courtStudyMeetingId");

-- CreateIndex
CREATE INDEX "CourtStudyParticipant_email_idx" ON "CourtStudyParticipant"("email");

-- CreateIndex
CREATE INDEX "CourtStudyParticipant_status_idx" ON "CourtStudyParticipant"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CourtStudyParticipant_courtStudyMeetingId_email_key" ON "CourtStudyParticipant"("courtStudyMeetingId", "email");

-- AddForeignKey
ALTER TABLE "CourtStudyParticipant"
ADD CONSTRAINT "CourtStudyParticipant_courtStudyMeetingId_fkey"
FOREIGN KEY ("courtStudyMeetingId")
REFERENCES "CourtStudyMeeting"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
