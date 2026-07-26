-- CreateTable
CREATE TABLE "ZoomRegistrant" (
    "id" TEXT NOT NULL,
    "courtStudyMeetingId" TEXT NOT NULL,
    "zoomMeetingId" TEXT NOT NULL,
    "zoomMeetingUuid" TEXT,
    "zoomRegistrantId" TEXT NOT NULL,
    "accountId" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT NOT NULL,
    "registrationStatus" TEXT,
    "lastEventType" TEXT NOT NULL DEFAULT 'meeting.registration_created',
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "canceledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZoomRegistrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ZoomRegistrant_zoomMeetingId_zoomRegistrantId_key"
ON "ZoomRegistrant"("zoomMeetingId", "zoomRegistrantId");

-- CreateIndex
CREATE INDEX "ZoomRegistrant_courtStudyMeetingId_idx"
ON "ZoomRegistrant"("courtStudyMeetingId");

-- CreateIndex
CREATE INDEX "ZoomRegistrant_zoomMeetingId_idx"
ON "ZoomRegistrant"("zoomMeetingId");

-- CreateIndex
CREATE INDEX "ZoomRegistrant_email_idx"
ON "ZoomRegistrant"("email");

-- AddForeignKey
ALTER TABLE "ZoomRegistrant"
ADD CONSTRAINT "ZoomRegistrant_courtStudyMeetingId_fkey"
FOREIGN KEY ("courtStudyMeetingId")
REFERENCES "CourtStudyMeeting"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
