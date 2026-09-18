-- AlterTable
ALTER TABLE "CourtStudyParticipant"
ADD COLUMN "postSurveyScore" INTEGER,
ADD COLUMN "postSurveyStatement" TEXT,
ADD COLUMN "postSurveyInvitedAt" TIMESTAMP(3),
ADD COLUMN "postSurveySubmittedAt" TIMESTAMP(3);
