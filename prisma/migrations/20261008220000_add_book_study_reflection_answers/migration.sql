-- CreateTable
CREATE TABLE "BookStudyReflectionAnswer" (
    "id" TEXT NOT NULL,
    "courtStudyParticipantId" TEXT NOT NULL,
    "cmsQuestionId" TEXT NOT NULL,
    "questionTextSnapshot" TEXT NOT NULL,
    "questionSortOrder" INTEGER NOT NULL,
    "responseText" TEXT,
    "responseScore" INTEGER,
    "scaleLabelSnapshot" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookStudyReflectionAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookStudyReflectionAnswer_courtStudyParticipantId_idx"
ON "BookStudyReflectionAnswer"("courtStudyParticipantId");

-- CreateIndex
CREATE UNIQUE INDEX "BookStudyReflectionAnswer_courtStudyParticipantId_cmsQuesti_key"
ON "BookStudyReflectionAnswer"("courtStudyParticipantId", "cmsQuestionId");

-- AddForeignKey
ALTER TABLE "BookStudyReflectionAnswer"
ADD CONSTRAINT "BookStudyReflectionAnswer_courtStudyParticipantId_fkey"
FOREIGN KEY ("courtStudyParticipantId")
REFERENCES "CourtStudyParticipant"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
