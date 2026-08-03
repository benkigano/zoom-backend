-- Add a separate attendance format for public Court Study requests.
CREATE TYPE "CourtStudySessionFormat" AS ENUM (
  'ONLINE',
  'IN_PERSON',
  'HYBRID'
);

-- Allow Court Study requests that do not originate from
-- a guest-distribution campaign or interview recording.
ALTER TABLE "CourtStudyRequest"
  ALTER COLUMN "campaignId" DROP NOT NULL,
  ALTER COLUMN "recordingId" DROP NOT NULL,
  ALTER COLUMN "pastorName" DROP NOT NULL,
  ALTER COLUMN "pastorEmail" DROP NOT NULL,
  ALTER COLUMN "churchName" DROP NOT NULL;

-- Add inclusive organizer, host-group, study-material,
-- and attendance-format fields.
ALTER TABLE "CourtStudyRequest"
  ADD COLUMN "organizerName" TEXT,
  ADD COLUMN "organizerEmail" TEXT,
  ADD COLUMN "organizerPhone" TEXT,
  ADD COLUMN "organizerRole" TEXT,
  ADD COLUMN "hostGroupName" TEXT,
  ADD COLUMN "hostGroupType" TEXT,
  ADD COLUMN "hostGroupWebsite" TEXT,
  ADD COLUMN "hostGroupCity" TEXT,
  ADD COLUMN "hostGroupState" TEXT,
  ADD COLUMN "hostGroupZip" TEXT,
  ADD COLUMN "hostGroupCountry" TEXT,
  ADD COLUMN "studyFocusType" "CourtStudyDiscussionType",
  ADD COLUMN "selectedRulesSections" JSONB,
  ADD COLUMN "sessionFormat" "CourtStudySessionFormat";

CREATE INDEX "CourtStudyRequest_organizerEmail_idx"
  ON "CourtStudyRequest"("organizerEmail");
