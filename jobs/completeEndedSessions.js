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
