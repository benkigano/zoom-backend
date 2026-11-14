-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AvailabilityStatus" AS ENUM ('AVAILABLE', 'HELD', 'BOOKED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ZoomMeetingStatus" AS ENUM ('CREATED', 'SCHEDULED', 'COMPLETED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "EmailLogStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "EmailType" AS ENUM ('REQUEST_RECEIVED', 'REQUEST_APPROVED', 'REQUEST_REJECTED', 'ZOOM_DETAILS', 'JOURNALIST_NOTIFICATION', 'ADMIN_NOTIFICATION', 'GENERAL');

-- CreateEnum
CREATE TYPE "ZoomConnectionStatus" AS ENUM ('CONNECTED', 'REAUTHORIZATION_REQUIRED', 'REVOKED', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "CourtStudyMeetingStatus" AS ENUM ('DRAFT', 'PENDING', 'CREATING', 'SCHEDULED', 'COMPLETED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "CourtStudyDiscussionType" AS ENUM ('RULES_OF_PROCEDURE', 'INTERVIEW_RECORDING', 'BOOK_STUDY');

-- CreateEnum
CREATE TYPE "GuestDistributionCampaignStatus" AS ENUM ('DRAFT', 'READY', 'SENT_TO_GUEST', 'ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "CourtStudyRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'ZOOM_CONNECTED', 'AWAITING_MEETING_DETAILS', 'MEETING_DETAILS_SUBMITTED', 'MEETING_APPROVED', 'SESSION_READY', 'SESSION_REVIEW_PENDING', 'DECLINED', 'SCHEDULED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CourtStudyHostMode" AS ENUM ('COURT_HOSTED', 'PASTOR_HOSTED', 'COMMUNITY_HOSTED', 'IN_PERSON', 'HYBRID');

-- CreateEnum
CREATE TYPE "CourtStudySessionFormat" AS ENUM ('ONLINE', 'IN_PERSON', 'HYBRID');

-- CreateEnum
CREATE TYPE "RecordingStatus" AS ENUM ('DRAFT', 'READY', 'SENT', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "DistributionStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "Journalist" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "roleTitle" TEXT,
    "bio" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Journalist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Church" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "denomination" TEXT,
    "diocese" TEXT,
    "country" TEXT DEFAULT 'USA',
    "websiteUrl" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Church_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChurchContact" (
    "id" TEXT NOT NULL,
    "churchId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "roleTitle" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "canReceiveRecordings" BOOLEAN NOT NULL DEFAULT true,
    "canCreateCourtStudyMeetings" BOOLEAN NOT NULL DEFAULT false,
    "courtStudyApproved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChurchContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterviewRequest" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "applicantBio" TEXT,
    "selectedJournalistId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "organizationName" TEXT,
    "approvedAt" TIMESTAMP(3),
    "scheduledAt" TIMESTAMP(3),
    "requestedDateTime" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InterviewRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalistAvailability" (
    "id" TEXT NOT NULL,
    "journalistId" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "status" "AvailabilityStatus" NOT NULL DEFAULT 'AVAILABLE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JournalistAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "stripePriceId" TEXT,
    "plan" TEXT,
    "status" TEXT NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZoomMeeting" (
    "id" TEXT NOT NULL,
    "interviewRequestId" TEXT NOT NULL,
    "journalistId" TEXT,
    "zoomMeetingId" TEXT,
    "joinUrl" TEXT,
    "startUrl" TEXT,
    "topic" TEXT NOT NULL,
    "scheduledStartTime" TIMESTAMP(3),
    "durationMinutes" INTEGER,
    "status" "ZoomMeetingStatus" NOT NULL DEFAULT 'CREATED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZoomMeeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailLog" (
    "id" TEXT NOT NULL,
    "interviewRequestId" TEXT,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyPreview" TEXT,
    "emailType" "EmailType" NOT NULL DEFAULT 'GENERAL',
    "status" "EmailLogStatus" NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recording" (
    "id" TEXT NOT NULL,
    "interviewRequestId" TEXT,
    "zoomMeetingId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "speakerName" TEXT,
    "speakerTitle" TEXT,
    "organizationName" TEXT,
    "recordingUrl" TEXT NOT NULL,
    "recordingPasscode" TEXT,
    "transcriptUrl" TEXT,
    "thumbnailUrl" TEXT,
    "podcastUrl" TEXT,
    "status" "RecordingStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Recording_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DistributionLog" (
    "id" TEXT NOT NULL,
    "recordingId" TEXT NOT NULL,
    "churchId" TEXT,
    "churchContactId" TEXT,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "DistributionStatus" NOT NULL DEFAULT 'PENDING',
    "sentAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DistributionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChurchContactZoomConnection" (
    "id" TEXT NOT NULL,
    "churchContactId" TEXT,
    "organizerEmail" TEXT,
    "oauthEnvironment" TEXT NOT NULL DEFAULT 'PRODUCTION',
    "zoomUserId" TEXT NOT NULL,
    "zoomAccountId" TEXT,
    "zoomEmail" TEXT,
    "accessTokenEncrypted" TEXT NOT NULL,
    "refreshTokenEncrypted" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "authorizedScopes" TEXT,
    "status" "ZoomConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "disconnectedAt" TIMESTAMP(3),

    CONSTRAINT "ChurchContactZoomConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZoomOAuthInvitation" (
    "id" TEXT NOT NULL,
    "churchContactId" TEXT,
    "organizerEmail" TEXT,
    "oauthEnvironment" TEXT NOT NULL DEFAULT 'PRODUCTION',
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ZoomOAuthInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourtStudyTimeSlot" (
    "id" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "capacity" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "bookingDeadline" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourtStudyTimeSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourtStudyMeeting" (
    "id" TEXT NOT NULL,
    "churchContactId" TEXT,
    "courtStudyRequestId" TEXT,
    "timeSlotId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "discussionType" "CourtStudyDiscussionType" NOT NULL,
    "selectedChapter" TEXT,
    "selectedSection" TEXT,
    "selectedRecordingId" TEXT,
    "scheduledStart" TIMESTAMP(3) NOT NULL,
    "scheduledEnd" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "zoomMeetingId" TEXT,
    "zoomRegistrationUrl" TEXT,
    "zoomJoinUrl" TEXT,
    "zoomPasscode" TEXT,
    "zoomMeetingUuid" TEXT,
    "actualSessionStart" TIMESTAMP(3),
    "actualSessionEnd" TIMESTAMP(3),
    "attendanceSyncedAt" TIMESTAMP(3),
    "totalRegistered" INTEGER,
    "totalAttended" INTEGER,
    "sessionCompletedAt" TIMESTAMP(3),
    "pastorSetupToken" TEXT,
    "pastorSetupTokenExpiresAt" TIMESTAMP(3),
    "meetingSetupRequestedAt" TIMESTAMP(3),
    "meetingDetailsSubmittedAt" TIMESTAMP(3),
    "invitationSentAt" TIMESTAMP(3),
    "invitationSentTo" TEXT,
    "invitationSendCount" INTEGER NOT NULL DEFAULT 0,
    "invitationLastError" TEXT,
    "publicInvitationToken" TEXT,
    "status" "CourtStudyMeetingStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourtStudyMeeting_pkey" PRIMARY KEY ("id")
);

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
    "joinUrl" TEXT,
    "lastEventType" TEXT NOT NULL DEFAULT 'meeting.registration_created',
    "lastZoomEventTs" BIGINT,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "canceledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZoomRegistrant_pkey" PRIMARY KEY ("id")
);

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
    "postSurveyScore" INTEGER,
    "postSurveyStatement" TEXT,
    "postSurveyInvitedAt" TIMESTAMP(3),
    "postSurveySubmittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourtStudyParticipant_pkey" PRIMARY KEY ("id")
);

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

-- CreateTable
CREATE TABLE "GuestDistributionCampaign" (
    "id" TEXT NOT NULL,
    "recordingId" TEXT NOT NULL,
    "guestName" TEXT NOT NULL,
    "guestEmail" TEXT NOT NULL,
    "organizationName" TEXT,
    "distributionToken" TEXT NOT NULL,
    "status" "GuestDistributionCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "sentAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuestDistributionCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "CourtStudyRequest" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT,
    "recordingId" TEXT,
    "pastorName" TEXT,
    "pastorEmail" TEXT,
    "roleTitle" TEXT,
    "churchName" TEXT,
    "dioceseOrGroup" TEXT,
    "phone" TEXT,
    "organizerName" TEXT,
    "organizerEmail" TEXT,
    "organizerPhone" TEXT,
    "organizerRole" TEXT,
    "hostGroupName" TEXT,
    "hostGroupType" TEXT,
    "hostGroupWebsite" TEXT,
    "hostGroupCity" TEXT,
    "hostGroupState" TEXT,
    "hostGroupZip" TEXT,
    "hostGroupCountry" TEXT,
    "studyFocusType" "CourtStudyDiscussionType",
    "selectedRulesSections" JSONB,
    "bookExcerptId" TEXT,
    "bookPartNumber" INTEGER,
    "bookPartTitle" TEXT,
    "bookChapterNumber" INTEGER,
    "bookExcerptHtml" TEXT,
    "durationMinutes" INTEGER,
    "preferredStart" TIMESTAMP(3),
    "timezone" TEXT,
    "meetingFormat" "CourtStudyHostMode",
    "sessionFormat" "CourtStudySessionFormat",
    "zoomOAuthEnvironment" TEXT NOT NULL DEFAULT 'PRODUCTION',
    "estimatedAttendance" INTEGER,
    "notes" TEXT,
    "status" "CourtStudyRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourtStudyRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MembershipEnrollment" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'BASIC',
    "status" TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "verificationTokenHash" TEXT,
    "verificationExpiresAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "checkoutAccessTokenHash" TEXT,
    "checkoutAttemptKey" TEXT,
    "checkoutSessionId" TEXT,
    "checkoutExpiresAt" TIMESTAMP(3),
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "MembershipEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Journalist_email_key" ON "Journalist"("email");

-- CreateIndex
CREATE INDEX "ChurchContact_churchId_idx" ON "ChurchContact"("churchId");

-- CreateIndex
CREATE INDEX "ChurchContact_email_idx" ON "ChurchContact"("email");

-- CreateIndex
CREATE INDEX "InterviewRequest_status_idx" ON "InterviewRequest"("status");

-- CreateIndex
CREATE INDEX "InterviewRequest_email_idx" ON "InterviewRequest"("email");

-- CreateIndex
CREATE INDEX "InterviewRequest_selectedJournalistId_idx" ON "InterviewRequest"("selectedJournalistId");

-- CreateIndex
CREATE INDEX "JournalistAvailability_journalistId_idx" ON "JournalistAvailability"("journalistId");

-- CreateIndex
CREATE INDEX "JournalistAvailability_startTime_idx" ON "JournalistAvailability"("startTime");

-- CreateIndex
CREATE INDEX "JournalistAvailability_status_idx" ON "JournalistAvailability"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_email_key" ON "Subscription"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_stripeCustomerId_key" ON "Subscription"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_stripeSubscriptionId_key" ON "Subscription"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "Subscription_status_idx" ON "Subscription"("status");

-- CreateIndex
CREATE INDEX "Subscription_currentPeriodEnd_idx" ON "Subscription"("currentPeriodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "ZoomMeeting_interviewRequestId_key" ON "ZoomMeeting"("interviewRequestId");

-- CreateIndex
CREATE INDEX "ZoomMeeting_journalistId_idx" ON "ZoomMeeting"("journalistId");

-- CreateIndex
CREATE INDEX "ZoomMeeting_zoomMeetingId_idx" ON "ZoomMeeting"("zoomMeetingId");

-- CreateIndex
CREATE INDEX "ZoomMeeting_status_idx" ON "ZoomMeeting"("status");

-- CreateIndex
CREATE INDEX "EmailLog_interviewRequestId_idx" ON "EmailLog"("interviewRequestId");

-- CreateIndex
CREATE INDEX "EmailLog_toEmail_idx" ON "EmailLog"("toEmail");

-- CreateIndex
CREATE INDEX "EmailLog_status_idx" ON "EmailLog"("status");

-- CreateIndex
CREATE INDEX "EmailLog_emailType_idx" ON "EmailLog"("emailType");

-- CreateIndex
CREATE INDEX "Recording_interviewRequestId_idx" ON "Recording"("interviewRequestId");

-- CreateIndex
CREATE INDEX "Recording_zoomMeetingId_idx" ON "Recording"("zoomMeetingId");

-- CreateIndex
CREATE INDEX "Recording_status_idx" ON "Recording"("status");

-- CreateIndex
CREATE INDEX "DistributionLog_recordingId_idx" ON "DistributionLog"("recordingId");

-- CreateIndex
CREATE INDEX "DistributionLog_churchId_idx" ON "DistributionLog"("churchId");

-- CreateIndex
CREATE INDEX "DistributionLog_churchContactId_idx" ON "DistributionLog"("churchContactId");

-- CreateIndex
CREATE INDEX "DistributionLog_status_idx" ON "DistributionLog"("status");

-- CreateIndex
CREATE INDEX "DistributionLog_toEmail_idx" ON "DistributionLog"("toEmail");

-- CreateIndex
CREATE INDEX "ChurchContactZoomConnection_oauthEnvironment_idx" ON "ChurchContactZoomConnection"("oauthEnvironment");

-- CreateIndex
CREATE UNIQUE INDEX "ChurchContactZoomConnection_churchContactId_oauthEnvironmen_key" ON "ChurchContactZoomConnection"("churchContactId", "oauthEnvironment");

-- CreateIndex
CREATE UNIQUE INDEX "ChurchContactZoomConnection_organizerEmail_oauthEnvironment_key" ON "ChurchContactZoomConnection"("organizerEmail", "oauthEnvironment");

-- CreateIndex
CREATE UNIQUE INDEX "ZoomOAuthInvitation_tokenHash_key" ON "ZoomOAuthInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "ZoomOAuthInvitation_churchContactId_idx" ON "ZoomOAuthInvitation"("churchContactId");

-- CreateIndex
CREATE INDEX "ZoomOAuthInvitation_organizerEmail_idx" ON "ZoomOAuthInvitation"("organizerEmail");

-- CreateIndex
CREATE INDEX "ZoomOAuthInvitation_oauthEnvironment_idx" ON "ZoomOAuthInvitation"("oauthEnvironment");

-- CreateIndex
CREATE INDEX "ZoomOAuthInvitation_expiresAt_idx" ON "ZoomOAuthInvitation"("expiresAt");

-- CreateIndex
CREATE INDEX "CourtStudyTimeSlot_startTime_idx" ON "CourtStudyTimeSlot"("startTime");

-- CreateIndex
CREATE INDEX "CourtStudyTimeSlot_isActive_idx" ON "CourtStudyTimeSlot"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "CourtStudyMeeting_courtStudyRequestId_key" ON "CourtStudyMeeting"("courtStudyRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "CourtStudyMeeting_pastorSetupToken_key" ON "CourtStudyMeeting"("pastorSetupToken");

-- CreateIndex
CREATE UNIQUE INDEX "CourtStudyMeeting_publicInvitationToken_key" ON "CourtStudyMeeting"("publicInvitationToken");

-- CreateIndex
CREATE INDEX "CourtStudyMeeting_churchContactId_idx" ON "CourtStudyMeeting"("churchContactId");

-- CreateIndex
CREATE INDEX "CourtStudyMeeting_timeSlotId_idx" ON "CourtStudyMeeting"("timeSlotId");

-- CreateIndex
CREATE INDEX "CourtStudyMeeting_scheduledStart_idx" ON "CourtStudyMeeting"("scheduledStart");

-- CreateIndex
CREATE INDEX "CourtStudyMeeting_status_idx" ON "CourtStudyMeeting"("status");

-- CreateIndex
CREATE INDEX "CourtStudyMeeting_courtStudyRequestId_idx" ON "CourtStudyMeeting"("courtStudyRequestId");

-- CreateIndex
CREATE INDEX "ZoomRegistrant_courtStudyMeetingId_idx" ON "ZoomRegistrant"("courtStudyMeetingId");

-- CreateIndex
CREATE INDEX "ZoomRegistrant_zoomMeetingId_idx" ON "ZoomRegistrant"("zoomMeetingId");

-- CreateIndex
CREATE INDEX "ZoomRegistrant_email_idx" ON "ZoomRegistrant"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ZoomRegistrant_zoomMeetingId_zoomRegistrantId_key" ON "ZoomRegistrant"("zoomMeetingId", "zoomRegistrantId");

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

-- CreateIndex
CREATE INDEX "BookStudyReflectionAnswer_courtStudyParticipantId_idx" ON "BookStudyReflectionAnswer"("courtStudyParticipantId");

-- CreateIndex
CREATE UNIQUE INDEX "BookStudyReflectionAnswer_courtStudyParticipantId_cmsQuesti_key" ON "BookStudyReflectionAnswer"("courtStudyParticipantId", "cmsQuestionId");

-- CreateIndex
CREATE UNIQUE INDEX "GuestDistributionCampaign_distributionToken_key" ON "GuestDistributionCampaign"("distributionToken");

-- CreateIndex
CREATE INDEX "GuestDistributionCampaign_recordingId_idx" ON "GuestDistributionCampaign"("recordingId");

-- CreateIndex
CREATE INDEX "GuestDistributionCampaign_guestEmail_idx" ON "GuestDistributionCampaign"("guestEmail");

-- CreateIndex
CREATE INDEX "GuestDistributionCampaign_status_idx" ON "GuestDistributionCampaign"("status");

-- CreateIndex
CREATE INDEX "GuestDistributionCampaign_expiresAt_idx" ON "GuestDistributionCampaign"("expiresAt");

-- CreateIndex
CREATE INDEX "PastorInvitation_campaignId_idx" ON "PastorInvitation"("campaignId");

-- CreateIndex
CREATE INDEX "PastorInvitation_pastorEmail_idx" ON "PastorInvitation"("pastorEmail");

-- CreateIndex
CREATE INDEX "PastorInvitation_status_idx" ON "PastorInvitation"("status");

-- CreateIndex
CREATE INDEX "CourtStudyRequest_campaignId_idx" ON "CourtStudyRequest"("campaignId");

-- CreateIndex
CREATE INDEX "CourtStudyRequest_recordingId_idx" ON "CourtStudyRequest"("recordingId");

-- CreateIndex
CREATE INDEX "CourtStudyRequest_pastorEmail_idx" ON "CourtStudyRequest"("pastorEmail");

-- CreateIndex
CREATE INDEX "CourtStudyRequest_organizerEmail_idx" ON "CourtStudyRequest"("organizerEmail");

-- CreateIndex
CREATE INDEX "CourtStudyRequest_status_idx" ON "CourtStudyRequest"("status");

-- CreateIndex
CREATE INDEX "CourtStudyRequest_preferredStart_idx" ON "CourtStudyRequest"("preferredStart");

-- CreateIndex
CREATE UNIQUE INDEX "MembershipEnrollment_verificationTokenHash_key" ON "MembershipEnrollment"("verificationTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "MembershipEnrollment_checkoutAccessTokenHash_key" ON "MembershipEnrollment"("checkoutAccessTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "MembershipEnrollment_checkoutAttemptKey_key" ON "MembershipEnrollment"("checkoutAttemptKey");

-- CreateIndex
CREATE UNIQUE INDEX "MembershipEnrollment_checkoutSessionId_key" ON "MembershipEnrollment"("checkoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "MembershipEnrollment_stripeSubscriptionId_key" ON "MembershipEnrollment"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "MembershipEnrollment_email_status_idx" ON "MembershipEnrollment"("email", "status");

-- CreateIndex
CREATE INDEX "MembershipEnrollment_checkoutExpiresAt_idx" ON "MembershipEnrollment"("checkoutExpiresAt");

-- CreateIndex
CREATE INDEX "MembershipEnrollment_createdAt_idx" ON "MembershipEnrollment"("createdAt");

-- AddForeignKey
ALTER TABLE "ChurchContact" ADD CONSTRAINT "ChurchContact_churchId_fkey" FOREIGN KEY ("churchId") REFERENCES "Church"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalistAvailability" ADD CONSTRAINT "JournalistAvailability_journalistId_fkey" FOREIGN KEY ("journalistId") REFERENCES "Journalist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoomMeeting" ADD CONSTRAINT "ZoomMeeting_interviewRequestId_fkey" FOREIGN KEY ("interviewRequestId") REFERENCES "InterviewRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoomMeeting" ADD CONSTRAINT "ZoomMeeting_journalistId_fkey" FOREIGN KEY ("journalistId") REFERENCES "Journalist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_interviewRequestId_fkey" FOREIGN KEY ("interviewRequestId") REFERENCES "InterviewRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DistributionLog" ADD CONSTRAINT "DistributionLog_recordingId_fkey" FOREIGN KEY ("recordingId") REFERENCES "Recording"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DistributionLog" ADD CONSTRAINT "DistributionLog_churchId_fkey" FOREIGN KEY ("churchId") REFERENCES "Church"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DistributionLog" ADD CONSTRAINT "DistributionLog_churchContactId_fkey" FOREIGN KEY ("churchContactId") REFERENCES "ChurchContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChurchContactZoomConnection" ADD CONSTRAINT "ChurchContactZoomConnection_churchContactId_fkey" FOREIGN KEY ("churchContactId") REFERENCES "ChurchContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoomOAuthInvitation" ADD CONSTRAINT "ZoomOAuthInvitation_churchContactId_fkey" FOREIGN KEY ("churchContactId") REFERENCES "ChurchContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourtStudyMeeting" ADD CONSTRAINT "CourtStudyMeeting_churchContactId_fkey" FOREIGN KEY ("churchContactId") REFERENCES "ChurchContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourtStudyMeeting" ADD CONSTRAINT "CourtStudyMeeting_courtStudyRequestId_fkey" FOREIGN KEY ("courtStudyRequestId") REFERENCES "CourtStudyRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourtStudyMeeting" ADD CONSTRAINT "CourtStudyMeeting_timeSlotId_fkey" FOREIGN KEY ("timeSlotId") REFERENCES "CourtStudyTimeSlot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoomRegistrant" ADD CONSTRAINT "ZoomRegistrant_courtStudyMeetingId_fkey" FOREIGN KEY ("courtStudyMeetingId") REFERENCES "CourtStudyMeeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourtStudyParticipant" ADD CONSTRAINT "CourtStudyParticipant_courtStudyMeetingId_fkey" FOREIGN KEY ("courtStudyMeetingId") REFERENCES "CourtStudyMeeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookStudyReflectionAnswer" ADD CONSTRAINT "BookStudyReflectionAnswer_courtStudyParticipantId_fkey" FOREIGN KEY ("courtStudyParticipantId") REFERENCES "CourtStudyParticipant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuestDistributionCampaign" ADD CONSTRAINT "GuestDistributionCampaign_recordingId_fkey" FOREIGN KEY ("recordingId") REFERENCES "Recording"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PastorInvitation" ADD CONSTRAINT "PastorInvitation_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "GuestDistributionCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourtStudyRequest" ADD CONSTRAINT "CourtStudyRequest_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "GuestDistributionCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourtStudyRequest" ADD CONSTRAINT "CourtStudyRequest_recordingId_fkey" FOREIGN KEY ("recordingId") REFERENCES "Recording"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Only one nonterminal enrollment per email and plan.
-- Email normalization and valid status transitions
-- must also be enforced by the application.

CREATE UNIQUE INDEX
    "MembershipEnrollment_one_active_per_email_plan"
ON "MembershipEnrollment"("email", "plan")
WHERE "status" IN (
    'PENDING_VERIFICATION',
    'EMAIL_VERIFIED',
    'CHECKOUT_PENDING',
    'CHECKOUT_RECONCILIATION_PENDING'
);
