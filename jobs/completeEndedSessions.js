// =====================================================
// Court of Compassion
// Automatic Session Completion and Reflection Invitations
//
// DEFAULT MODE: DRY RUN
// - Inspects eligible sessions and pending invitations.
// - Does not modify records or send emails.
//
// LIVE MODE: Requires explicit environment configuration.
// - Completes eligible Court Study and Book Study sessions.
// - Sends outstanding post-session reflection invitations.
// - Uses PostgreSQL advisory locks for invitation processing.
// =====================================================
import "dotenv/config";
import { prisma } from "../prisma/client.js";

import {
  findSessionsAwaitingCompletion,
  completeEligibleSession,
  sendCourtStudyPostSurveyInvitations,
} from "../services/postSessionCompletion.js";

// =====================================================
// Automatic completion execution mode
//
// Default: DRY RUN
// Live processing requires explicit configuration.
// =====================================================

const LIVE_MODE =
  process.env.COURT_SESSION_AUTO_COMPLETE_MODE ===
  "LIVE";

// =====================================================
// Automatic session completion activation cutoff.
//
// Historical sessions before this date are excluded
// from automatic completion and email delivery.
// This restriction applies to the Cron Job only.
// =====================================================

const AUTO_COMPLETE_AFTER_RAW = String(
  process.env.COURT_SESSION_AUTO_COMPLETE_AFTER || ""
).trim();

const AUTO_COMPLETE_AFTER = AUTO_COMPLETE_AFTER_RAW
  ? new Date(AUTO_COMPLETE_AFTER_RAW)
  : null;

if (
  !AUTO_COMPLETE_AFTER ||
  !Number.isFinite(AUTO_COMPLETE_AFTER.getTime())
) {
  throw new Error(
    "COURT_SESSION_AUTO_COMPLETE_AFTER must be a valid ISO date."
  );
}

// Explicit test mode: complete one selected session only.
// Reflection invitations remain disabled in this mode.
const COMPLETION_TEST_MODE =
  process.env.COURT_SESSION_AUTO_COMPLETE_MODE ===
  "COMPLETION_TEST";

const COMPLETION_TEST_REQUEST_ID = String(
  process.env.COURT_SESSION_TEST_REQUEST_ID || ""
).trim();

async function main() {
  const now = new Date();

  console.log(
    "COURT OF COMPASSION — SESSION COMPLETION DRY RUN"
  );

  console.log("Current UTC time:", now.toISOString());

  const allEligibleRequests =
  await findSessionsAwaitingCompletion({
    now,
  });

const eligibleRequests = allEligibleRequests.filter(
  (request) => {
    const scheduledEnd =
      request.courtStudyMeeting?.scheduledEnd;

    return (
      scheduledEnd &&
      new Date(scheduledEnd).getTime() >=
        AUTO_COMPLETE_AFTER.getTime()
    );
  }
); 
  
  console.log(
    "Eligible requests found:",
    eligibleRequests.length
  );

  for (const request of eligibleRequests) {
    console.log({
      requestId: request.id,
      studyFocusType: request.studyFocusType,
      status: request.status,
      scheduledEnd:
        request.courtStudyMeeting?.scheduledEnd,
    });
  }

if (COMPLETION_TEST_MODE) {
  if (!COMPLETION_TEST_REQUEST_ID) {
    throw new Error(
      "COMPLETION_TEST requires COURT_SESSION_TEST_REQUEST_ID."
    );
  }

  const selectedRequest = eligibleRequests.find(
    request => request.id === COMPLETION_TEST_REQUEST_ID
  );

  if (!selectedRequest) {
    console.log(
      "COMPLETION TEST: Selected request is not eligible.",
      COMPLETION_TEST_REQUEST_ID
    );
  } else {
    const result = await completeEligibleSession({
      requestId: selectedRequest.id,
      now,
    });

    console.log(
      "COMPLETION TEST RESULT:",
      result
    );
  }
} else if (!LIVE_MODE) {
  console.log(
    "DRY RUN: Automatic completion is disabled."
  );   

  } else {
  console.log(
    "LIVE MODE: Processing eligible session completions."
  );

  for (const request of eligibleRequests) {
    try {
      const result = await completeEligibleSession({
        requestId: request.id,
        now,
      });

      console.log(
        "AUTOMATIC SESSION COMPLETION RESULT:",
        result
      );
    } catch (error) {
      console.error(
        "AUTOMATIC SESSION COMPLETION FAILED:",
        request.id,
        error
      );

      process.exitCode = 1;
    }
  }
}
  
  // =====================================================
  // Inspect outstanding post-session invitations.
  // READ ONLY — no emails are sent.
  // =====================================================

  const pendingInvitations =
    await prisma.courtStudyParticipant.findMany({
      where: {
        status: "REGISTERED",
        postSurveyInvitedAt: null,
        courtStudyMeeting: {
          is: {
           scheduledEnd: {
            gte: AUTO_COMPLETE_AFTER,
            lte: now,
          }, 
            courtStudyRequest: {
              is: {
                status: "COMPLETED",
                studyFocusType: {
                  in: [
                    "RULES_OF_PROCEDURE",
                    "BOOK_STUDY",
                  ],
                },
              },
            },
          },
        },
      },

select: {
  id: true,
  courtStudyMeetingId: true,
  courtStudyMeeting: {
    select: {
      courtStudyRequestId: true,
    },
  },
},
});

  console.log(
    "Pending invitations for completed sessions:",
    pendingInvitations.length
  );

    const pendingRequestIds = [
    ...new Set(
      pendingInvitations
        .map(
          participant =>
            participant.courtStudyMeeting
              ?.courtStudyRequestId
        )
        .filter(Boolean)
    ),
  ];

  console.log(
    "Completed sessions awaiting reflection invitations:",
    pendingRequestIds.length
  );

  if (LIVE_MODE) {
    for (const requestId of pendingRequestIds) {
      try {
        const result =
          await sendCourtStudyPostSurveyInvitations({
            requestId,
          });

        console.log(
          "AUTOMATIC REFLECTION INVITATION RESULT:",
          requestId,
          result
        );

        if (
          result?.failedCount > 0 ||
          result?.skippedReason ===
            "INVITATION_PROCESSING_LOCKED"
        ) {
          process.exitCode = 1;
        }
      } catch (error) {
        console.error(
          "AUTOMATIC REFLECTION INVITATION FAILED:",
          requestId,
          error
        );

        process.exitCode = 1;
      }
    }
  }
  
  console.log(
  COMPLETION_TEST_MODE
    ? "Completion-only test finished. Reflection emails were not sent."
    : LIVE_MODE
      ? "Live session completion and invitation processing finished."
      : "Dry run complete. No records were modified."
);  
}

main()
  .catch((error) => {
    console.error(
      "Session completion dry run failed:",
      error
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
