BEGIN;

ALTER TABLE "ChurchContactZoomConnection"
ADD COLUMN "oauthEnvironment" TEXT NOT NULL DEFAULT 'PRODUCTION';

ALTER TABLE "CourtStudyRequest"
ADD COLUMN "zoomOAuthEnvironment" TEXT NOT NULL DEFAULT 'PRODUCTION';

ALTER TABLE "ZoomOAuthInvitation"
ADD COLUMN "oauthEnvironment" TEXT NOT NULL DEFAULT 'PRODUCTION';

DROP INDEX "ChurchContactZoomConnection_churchContactId_key";

DROP INDEX "ChurchContactZoomConnection_organizerEmail_key";

CREATE INDEX "ChurchContactZoomConnection_oauthEnvironment_idx"
ON "ChurchContactZoomConnection"("oauthEnvironment");

CREATE UNIQUE INDEX "ChurchContactZoomConnection_churchContactId_oauthEnvironmen_key"
ON "ChurchContactZoomConnection"("churchContactId", "oauthEnvironment");

CREATE UNIQUE INDEX "ChurchContactZoomConnection_organizerEmail_oauthEnvironment_key"
ON "ChurchContactZoomConnection"("organizerEmail", "oauthEnvironment");

CREATE INDEX "ZoomOAuthInvitation_oauthEnvironment_idx"
ON "ZoomOAuthInvitation"("oauthEnvironment");

COMMIT;
