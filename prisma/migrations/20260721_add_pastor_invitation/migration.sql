CREATE TABLE "PastorInvitation" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "pastorName" TEXT,
  "pastorEmail" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "sentAt" TIMESTAMP(3),
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PastorInvitation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PastorInvitation_campaignId_idx"
ON "PastorInvitation"("campaignId");

CREATE INDEX "PastorInvitation_pastorEmail_idx"
ON "PastorInvitation"("pastorEmail");

CREATE INDEX "PastorInvitation_status_idx"
ON "PastorInvitation"("status");

ALTER TABLE "PastorInvitation"
ADD CONSTRAINT "PastorInvitation_campaignId_fkey"
FOREIGN KEY ("campaignId")
REFERENCES "GuestDistributionCampaign"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
