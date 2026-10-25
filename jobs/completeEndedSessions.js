// =====================================================
// Court of Compassion
// Automatic Session Completion — Phase 1: Dry Run
//
// READ ONLY:
// - Does not change request statuses
// - Does not send reflection invitations
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

async function main() {
  const now = new Date();

  console.log(
    "COURT OF COMPASSION — SESSION COMPLETION DRY RUN"
  );

  console.log("Current UTC time:", now.toISOString());

    const eligibleRequests =
    await findSessionsAwaitingCompletion({
      now,
    });
  
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

      if (!LIVE_MODE) {
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
      },
    });

  console.log(
    "Pending invitations for completed sessions:",
    pendingInvitations.length
  );
  
  console.log(
    "Dry run complete. No records were modified."
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
