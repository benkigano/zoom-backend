-- Allow Court Study meetings created from public pastor requests
-- without requiring an existing ChurchContact record.

-- Remove the existing foreign key before changing its delete behavior.
ALTER TABLE "CourtStudyMeeting"
DROP CONSTRAINT "CourtStudyMeeting_churchContactId_fkey";

-- Existing Court Study meetings may now have no saved church contact.
ALTER TABLE "CourtStudyMeeting"
ALTER COLUMN "churchContactId" DROP NOT NULL;

-- Re-create the church-contact relationship using SET NULL.
ALTER TABLE "CourtStudyMeeting"
ADD CONSTRAINT "CourtStudyMeeting_churchContactId_fkey"
FOREIGN KEY ("churchContactId")
REFERENCES "ChurchContact"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;

-- Connect a Court Study meeting directly to its originating request.
ALTER TABLE "CourtStudyMeeting"
ADD COLUMN "courtStudyRequestId" TEXT;

-- Only one meeting may be attached to a particular Court Study request.
CREATE UNIQUE INDEX
"CourtStudyMeeting_courtStudyRequestId_key"
ON "CourtStudyMeeting"("courtStudyRequestId");

-- Explicit index matching the Prisma schema.
CREATE INDEX
"CourtStudyMeeting_courtStudyRequestId_idx"
ON "CourtStudyMeeting"("courtStudyRequestId");

-- Add the request-to-meeting foreign-key relationship.
ALTER TABLE "CourtStudyMeeting"
ADD CONSTRAINT "CourtStudyMeeting_courtStudyRequestId_fkey"
FOREIGN KEY ("courtStudyRequestId")
REFERENCES "CourtStudyRequest"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;
