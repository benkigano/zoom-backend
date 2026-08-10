-- Allow a Court Study Zoom connection to belong either to
-- a pastor/church contact or to a non-church/community organizer.

ALTER TABLE "ChurchContactZoomConnection"
ALTER COLUMN "churchContactId" DROP NOT NULL;

ALTER TABLE "ChurchContactZoomConnection"
ADD COLUMN "organizerEmail" TEXT;

CREATE UNIQUE INDEX "ChurchContactZoomConnection_organizerEmail_key"
ON "ChurchContactZoomConnection"("organizerEmail");


-- Allow a Zoom OAuth invitation to identify either
-- a pastor/church contact or a community organizer.

ALTER TABLE "ZoomOAuthInvitation"
ALTER COLUMN "churchContactId" DROP NOT NULL;

ALTER TABLE "ZoomOAuthInvitation"
ADD COLUMN "organizerEmail" TEXT;

CREATE INDEX "ZoomOAuthInvitation_organizerEmail_idx"
ON "ZoomOAuthInvitation"("organizerEmail");
