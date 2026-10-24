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

async function main() {
  const now = new Date();

  console.log(
    "COURT OF COMPASSION — SESSION COMPLETION DRY RUN"
  );

  console.log("Current UTC time:", now.toISOString());

  const eligibleRequests =
    await prisma.courtStudyRequest.findMany({
      where: {
        status: "SESSION_READY",
        studyFocusType: {
          in: [
            "RULES_OF_PROCEDURE",
            "BOOK_STUDY",
          ],
        },
        courtStudyMeeting: {
          is: {
            scheduledEnd: {
              lte: now,
            },
          },
        },
      },
      select: {
        id: true,
        status: true,
        studyFocusType: true,
        courtStudyMeeting: {
          select: {
            id: true,
            scheduledStart: true,
            scheduledEnd: true,
          },
        },
      },
      orderBy: {
        createdAt: "asc",
      },
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
