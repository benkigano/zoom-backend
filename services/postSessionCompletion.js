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
