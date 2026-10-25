// =====================================================
// Court of Compassion
// Shared Post-Session Completion Service
//
// Supports Court Study and Book Study.
// Initial implementation: eligibility inspection only.
// =====================================================

import { prisma } from "../prisma/client.js";

import {
  sendEmail,
  safeEmailHtml,
  safeEmailWebUrl,
} from "./emailUtilities.js";

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

export async function sendCourtStudyPostSurveyInvitations({
  requestId,
}) {
  const courtStudyRequest =
    await prisma.courtStudyRequest.findUnique({
      where: {
        id: requestId,
      },
      include: {
        recording: true,
        courtStudyMeeting: {
          include: {
            courtParticipants: {
              where: {
                status: "REGISTERED",
                postSurveyInvitedAt: null,
              },
              orderBy: {
                registeredAt: "asc",
              },
            },
          },
        },
      },
    });

  if (!courtStudyRequest) {
    throw new Error(
      "Court Study request not found for post-session invitations"
    );
  }

  const meeting = courtStudyRequest.courtStudyMeeting;

  if (!meeting) {
    return {
      sentCount: 0,
      failedCount: 0,
      failedEmails: [],
      skippedReason: "NO_COURT_STUDY_MEETING",
    };
  }

  const participants =
    meeting.courtParticipants || [];

  if (participants.length === 0) {
    return {
      sentCount: 0,
      failedCount: 0,
      failedEmails: [],
      skippedReason: "NO_PENDING_REGISTERED_PARTICIPANTS",
    };
  }

  let selectedRulesSections = [];

  try {
    const rawSelectedRulesSections =
      courtStudyRequest.selectedRulesSections;

    if (Array.isArray(rawSelectedRulesSections)) {
      selectedRulesSections =
        rawSelectedRulesSections;
    } else if (
      typeof rawSelectedRulesSections === "string" &&
      rawSelectedRulesSections.trim()
    ) {
      const parsedSelectedRulesSections =
        JSON.parse(rawSelectedRulesSections);

      selectedRulesSections =
        Array.isArray(parsedSelectedRulesSections)
          ? parsedSelectedRulesSections
          : [parsedSelectedRulesSections];
    }
  } catch (parseError) {
    console.warn(
      "Could not parse selectedRulesSections for post-session invitation:",
      parseError
    );
  }

  const selectedRulesSection =
    selectedRulesSections.find((section) =>
      String(section?.videoUrl || "").trim()
    ) ||
    selectedRulesSections[0] ||
    null;

  const isRulesStudy =
    Boolean(selectedRulesSection);

  const materialTitle = isRulesStudy
    ? [
        selectedRulesSection?.chapterTitle,
        selectedRulesSection?.sectionTitle,
      ]
        .filter(Boolean)
        .join(" — ") ||
      meeting.title ||
      "Court Study"
    : courtStudyRequest.recording?.title ||
      meeting.title ||
      "Court of Compassion Interview";

    const isBookStudy =
    String(courtStudyRequest.studyFocusType || "")
      .trim()
      .toUpperCase() === "BOOK_STUDY";

  const hostGroupName = String(
    isBookStudy
      ? courtStudyRequest.organizerName ||
          "Organizer not specified"
      : courtStudyRequest.hostGroupName ||
          courtStudyRequest.churchName ||
          "Court of Compassion"
  ).trim();

  const hostLabel = isBookStudy
    ? "Book Study Organizer"
    : "Host Group or Community";

  const subject =
    `Post-Session Reflection — ${materialTitle}`;

  let sentCount = 0;
  const failedEmails = [];

  for (const participant of participants) {
    const email = String(
      participant.email || ""
    ).trim();

    if (!email) {
      failedEmails.push("(missing email)");
      continue;
    }

    try {
      const participantName =
        [
          participant.firstName,
          participant.lastName,
        ]
          .filter(Boolean)
          .join(" ")
          .trim() ||
        "Court Study Participant";

      const postSurveyUrl =
        `https://courtofcompassion.com/court-study/post-survey` +
        `?token=${encodeURIComponent(
          participant.invitationToken
        )}`;

      const safePostSurveyUrl =
        safeEmailWebUrl(postSurveyUrl);

      const safeParticipantName =
        safeEmailHtml(participantName);

      const safeHostGroupName =
        safeEmailHtml(hostGroupName);

      const safeMaterialTitle =
        safeEmailHtml(materialTitle);

            const text = [
        `Dear ${participantName},`,
        "",
        isBookStudy
          ? "Thank you for participating in this Court of Compassion Book Study."
          : "Thank you for participating in this Court of Compassion Court Study.",
        "",
        `${hostLabel}: ${hostGroupName}`,
        `${isBookStudy ? "Book Study Material" : "Court Study Material"}: ${materialTitle}`,
        "",
        "You are invited to record your post-session reflection.",
        "",
        "Post-Session Reflection:",
        postSurveyUrl,
        "",
        isBookStudy
          ? "This Book Study includes a post-session reflection only."
          : "Your post-session response is kept separate from any pre-session response so that both can be preserved.",
        "",
        "Court of Compassion",
      ].join("\n");

      const html = `
<!doctype html>
<html lang="en">
<body style="
  margin:0;
  padding:0;
  background:#f7f2e9;
  font-family:Arial,Helvetica,sans-serif;
  color:#172554;
">
  <table
    role="presentation"
    width="100%"
    cellspacing="0"
    cellpadding="0"
    border="0"
    style="background:#f7f2e9;padding:32px 12px;"
  >
    <tr>
      <td align="center">
        <table
          role="presentation"
          width="100%"
          cellspacing="0"
          cellpadding="0"
          border="0"
          style="
            max-width:640px;
            background:#ffffff;
            border:1px solid #e5e7eb;
            border-radius:14px;
            overflow:hidden;
          "
        >
          <tr>
            <td
              align="center"
              style="
                background:#0b2a68;
                padding:24px 32px;
                text-align:center;
              "
            >
              <img
                src="https://static.wixstatic.com/media/2ccb97_745227d9536b452b83a82556e6c5a430~mv2.png"
                alt="Court of Compassion Seal"
                width="84"
                height="84"
                style="
                  display:block;
                  margin:0 auto 14px auto;
                  border-radius:50%;
                  border:2px solid #d8b24c;
                  background:#ffffff;
                "
              >

              <div style="
                font-size:12px;
                letter-spacing:2px;
                color:#d8b24c;
                font-weight:700;
                margin-bottom:8px;
              ">
                COURT OF COMPASSION
              </div>

              <div style="
                font-size:26px;
                line-height:34px;
                color:#ffffff;
                font-weight:700;
              ">
                Post-Session Reflection
              </div>
            </td>
          </tr>

          <tr>
            <td style="
              padding:28px 32px;
              font-size:14px;
              line-height:21px;
            ">
              <p style="margin:0 0 18px 0;">
                Dear ${safeParticipantName},
              </p>

              <p style="margin:0 0 20px 0;">
  ${isBookStudy
    ? "Thank you for participating in this Court of Compassion Book Study."
    : "Thank you for participating in this Court of Compassion Court Study."}
</p>

              <p style="margin:0 0 22px 0;">
                <strong>${hostLabel}:</strong>
                ${safeHostGroupName}
                <br>

                <strong>${isBookStudy ? "Book Study Material" : "Court Study Material"}:</strong>
                ${safeMaterialTitle}
              </p>

              <p style="margin:0 0 20px 0;">
                You are invited to record your
                post-session reflection.
              </p>

              <p style="margin:0 0 20px 0;">
                <a
                  href="${safePostSurveyUrl}"
                  target="_blank"
                  rel="noopener noreferrer"
                  style="
                    display:inline-block;
                    padding:12px 18px;
                    background:#8a6500;
                    color:#ffffff;
                    text-decoration:none;
                    border-radius:4px;
                    font-weight:bold;
                  "
                >
                  Complete Post-Session Reflection
                </a>
              </p>

              <div style="
                padding:13px 14px;
                background:#fff7dd;
                border-left:4px solid #8a6500;
              ">
                ${isBookStudy
  ? "This Book Study includes a post-session reflection only."
  : "Your post-session response is kept separate from any pre-session response so that both can be preserved."}
              </div>
            </td>
          </tr>

          <tr>
            <td style="
              padding:8px 32px 28px 32px;
              text-align:center;
            ">
              <div style="
                border-top:2px solid #d8b24c;
                padding-top:18px;
                font-size:13px;
                font-weight:700;
                color:#0b2a68;
              ">
                Court of Compassion
              </div>

              <div style="
                padding-top:5px;
                font-size:12px;
                color:#6b7280;
              ">
                Truth • Compassion • Social Relevance
              </div>

              <div style="
                padding-top:8px;
                font-size:12px;
              ">
                courtofcompassion.com
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
      `;

      await sendEmail(
        email,
        subject,
        text,
        html
      );

      await prisma.courtStudyParticipant.update({
        where: {
          id: participant.id,
        },
        data: {
          postSurveyInvitedAt: new Date(),
        },
      });

      sentCount += 1;
    } catch (sendError) {
      console.error(
        "❌ Court Study post-session invitation failed:",
        email,
        sendError
      );

      failedEmails.push(email);
    }
  }

  return {
    sentCount,
    failedCount: failedEmails.length,
    failedEmails,
    skippedReason: null,
  };
}
