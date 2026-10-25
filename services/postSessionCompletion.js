// =====================================================
// Court of Compassion
// Shared Post-Session Completion Service
//
// Supports Court Study and Book Study.
// Initial implementation: eligibility inspection only.
// =====================================================

import { prisma } from "../prisma/client.js";

export async function findSessionsAwaitingCompletion({
  now = new Date(),
} = {}) {
  return prisma.courtStudyRequest.findMany({
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
}

// =====================================================
// Complete one eligible Court Study or Book Study.
//
// This function is not called by the dry-run job yet.
// =====================================================

export async function completeEligibleSession({
  requestId,
  now = new Date(),
} = {}) {
  const id = String(requestId || "").trim();

  if (!id) {
    throw new Error(
      "A Court Study request ID is required."
    );
  }

  const result =
    await prisma.courtStudyRequest.updateMany({
      where: {
        id,
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
      data: {
        status: "COMPLETED",
      },
    });

  return {
    requestId: id,
    completed: result.count === 1,
    updatedCount: result.count,
  };
}
