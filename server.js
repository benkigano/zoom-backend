import "dotenv/config";
import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import crypto from "crypto";
import { prisma } from "./prisma/client.js";
function requireAdminToken(req, res, next) {
  const providedToken = req.headers["x-admin-token"];
  const expectedToken = process.env.ADMIN_API_TOKEN;

  if (!expectedToken) {
    console.error("❌ ADMIN_API_TOKEN is not configured");
    return res.status(500).json({
      success: false,
      error: "Admin security token is not configured",
    });
  }

  if (!providedToken || providedToken !== expectedToken) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized",
    });
  }

  next();
}
const app = express();
function getZoomEncryptionKey() {
  const secret = process.env.ZOOM_TOKEN_ENCRYPTION_KEY;

  if (!secret) {
    throw new Error("ZOOM_TOKEN_ENCRYPTION_KEY is not configured");
  }

  return crypto
    .createHash("sha256")
    .update(secret, "utf8")
    .digest();
}

function encryptZoomToken(token) {
  if (!token) {
    throw new Error("Cannot encrypt an empty Zoom token");
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    getZoomEncryptionKey(),
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(String(token), "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return [
    iv.toString("base64url"),
    authTag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

function decryptZoomToken(encryptedToken) {
  if (!encryptedToken) {
    throw new Error("Cannot decrypt an empty Zoom token");
  }

  const parts = String(encryptedToken).split(".");

  if (parts.length !== 3) {
    throw new Error("Invalid encrypted Zoom token format");
  }

  const [ivValue, authTagValue, encryptedValue] = parts;

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getZoomEncryptionKey(),
    Buffer.from(ivValue, "base64url")
  );

  decipher.setAuthTag(Buffer.from(authTagValue, "base64url"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

function hashZoomOAuthToken(token) {
  return crypto
    .createHash("sha256")
    .update(String(token), "utf8")
    .digest("hex");
}
async function getChurchContactZoomAccessToken(churchContactId) {
  if (!churchContactId) {
    throw new Error("A church contact ID is required");
  }

  const connection =
    await prisma.churchContactZoomConnection.findUnique({
      where: {
        churchContactId: String(churchContactId),
      },
    });

  if (!connection) {
    throw new Error(
      "This church contact has not connected a Zoom account"
    );
  }

  if (connection.status === "REVOKED") {
    throw new Error(
      "This church contact's Zoom authorization has been revoked"
    );
  }

  if (connection.status === "DISCONNECTED") {
    throw new Error(
      "This church contact's Zoom account is disconnected"
    );
  }

  const refreshThresholdMs = 60 * 1000;
  const tokenExpiresAtMs = new Date(
    connection.tokenExpiresAt
  ).getTime();

  /*
   * Reuse the saved access token when it remains valid for
   * more than 60 seconds.
   */
  if (
    Number.isFinite(tokenExpiresAtMs) &&
    Date.now() < tokenExpiresAtMs - refreshThresholdMs
  ) {
    return decryptZoomToken(
      connection.accessTokenEncrypted
    );
  }

  const refreshToken = decryptZoomToken(
    connection.refreshTokenEncrypted
  );

  const clientId = process.env.ZOOM_CLIENT_ID;
  const clientSecret = process.env.ZOOM_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "ZOOM_CLIENT_ID or ZOOM_CLIENT_SECRET is not configured"
    );
  }

  const basicAuthorization = Buffer.from(
    `${clientId}:${clientSecret}`
  ).toString("base64");

  const refreshResponse = await fetch(
    "https://zoom.us/oauth/token",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuthorization}`,
        "Content-Type":
          "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    }
  );

  const refreshedTokens = await refreshResponse
    .json()
    .catch(() => ({}));

  if (!refreshResponse.ok) {
    await prisma.churchContactZoomConnection.update({
      where: {
        churchContactId: String(churchContactId),
      },
      data: {
        status: "REAUTHORIZATION_REQUIRED",
      },
    });

    throw new Error(
      `Pastor Zoom token refresh failed: ${
        refreshedTokens.reason ||
        refreshedTokens.message ||
        JSON.stringify(refreshedTokens)
      }`
    );
  }

  if (
    !refreshedTokens.access_token ||
    !refreshedTokens.refresh_token
  ) {
    throw new Error(
      "Zoom did not return the required refreshed tokens"
    );
  }

  const expiresInSeconds = Number(
    refreshedTokens.expires_in || 3600
  );

  const newExpiration = new Date(
    Date.now() + expiresInSeconds * 1000
  );

  await prisma.churchContactZoomConnection.update({
    where: {
      churchContactId: String(churchContactId),
    },
    data: {
      accessTokenEncrypted: encryptZoomToken(
        refreshedTokens.access_token
      ),
      refreshTokenEncrypted: encryptZoomToken(
        refreshedTokens.refresh_token
      ),
      tokenExpiresAt: newExpiration,
      authorizedScopes:
        refreshedTokens.scope ||
        connection.authorizedScopes,
      status: "CONNECTED",
      disconnectedAt: null,
    },
  });

  return refreshedTokens.access_token;
}
// ============================================================
// COURT STUDY MEETINGS — PASTOR ZOOM OAUTH
// ============================================================

app.get("/court-study/zoom/connect/:churchContactId", async (req, res) => {
  try {
    const churchContactId = String(req.params.churchContactId || "").trim();

    if (!churchContactId) {
      return res.status(400).json({
        success: false,
        error: "A church contact ID is required.",
      });
    }

    const churchContact = await prisma.churchContact.findUnique({
      where: {
        id: churchContactId,
      },
      include: {
        church: true,
      },
    });

    if (!churchContact) {
      return res.status(404).json({
        success: false,
        error: "Church contact not found.",
      });
    }

    if (!churchContact.canCreateCourtStudyMeetings) {
      return res.status(403).json({
        success: false,
        error:
          "This church contact is not authorized to create Court Study Meetings.",
      });
    }

    const clientId = process.env.ZOOM_CLIENT_ID;
    const redirectUri = process.env.ZOOM_REDIRECT_URL;

    if (!clientId || !redirectUri) {
      return res.status(500).json({
        success: false,
        error: "Zoom OAuth is not fully configured.",
      });
    }

    const invitationToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashZoomOAuthToken(invitationToken);

    await prisma.zoomOAuthInvitation.create({
      data: {
        churchContactId,
        tokenHash,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

    const state = Buffer.from(
      JSON.stringify({
        churchContactId,
        invitationToken,
      }),
      "utf8"
    ).toString("base64url");

    const authorizationUrl = new URL("https://zoom.us/oauth/authorize");
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", clientId);
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("state", state);

    return res.redirect(authorizationUrl.toString());
  } catch (error) {
    console.error("COURT STUDY ZOOM CONNECT ERROR:", error);

    return res.status(500).json({
      success: false,
      error: "Unable to begin Zoom authorization.",
    });
  }
});

async function sendEmail(to, subject, body, htmlBody = null) {
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  await transporter.sendMail({
    from: `"Court of Compassion" <${process.env.GMAIL_USER}>`,
    to,
    subject,
    text: body,
    html: htmlBody || String(body).replace(/\n/g, "<br>"),
  });

  console.log("✅ DISTRIBUTION EMAIL SENT TO:", to);
}
app.use(express.json());

app.use(cors());
app.use((req, res, next) => {
  console.log("➡️", req.method, req.originalUrl);
  next();
});


app.use((req, res, next) => {
  if (req.originalUrl === "/zoom/webhook") {
    next(); // skip JSON parser for Zoom
  } else {
    express.json()(req, res, next);
  }
});

app.get("/", (req, res) => {
  res.send("Zoom backend is running");
});
// SAVE interview request to PostgreSQL
app.post("/request", async (req, res) => {
  try {
    const data = req.body || {};

    const name = data.name || data.applicantName;
    const email = data.email || data.applicantEmail;
    const topic = data.topic || data.proposedTopic;
    const applicantBio = data.applicantBio || null;
    const selectedJournalistId = data.selectedJournalistId || null;
    const requestedDateTimeRaw =
  data.requestedDateTime ||
  data.preferredDateTime ||
  data.selectedAvailabilitySlot ||
  data.requestedDate ||
  null;

const requestedDateTime = requestedDateTimeRaw
  ? new Date(requestedDateTimeRaw)
  : null; 

    if (!name || !email || !topic) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: name/email/topic",
      });
    }

    const newRequest = await prisma.interviewRequest.create({
      data: {
        name: String(name),
        email: String(email),
        topic: String(topic),
        applicantBio: applicantBio ? String(applicantBio) : null,
        selectedJournalistId: selectedJournalistId ? String(selectedJournalistId) : null,
        requestedDateTime:
  requestedDateTime && !isNaN(requestedDateTime.getTime())
    ? requestedDateTime
    : null, 
      },
    });

    console.log("✅ New request saved to PostgreSQL:", newRequest.id);

    return res.json({
      success: true,
      request: newRequest,
    });
  } catch (err) {
    console.error("❌ Request save failed:", err);
    return res.status(500).json({
      success: false,
      error: String(err),
    });
  }
});

// GET all requests from PostgreSQL
app.get("/requests", requireAdminToken, async (req, res) => {
  try {
    const requests = await prisma.interviewRequest.findMany({
      orderBy: {
        createdAt: "desc",
      },
    });

    return res.json(requests);
  } catch (err) {
    console.error("❌ Requests fetch failed:", err);
    return res.status(500).json({
      success: false,
      error: String(err),
    });
  }
});
// GET recent email logs from PostgreSQL
app.get("/email-logs", requireAdminToken, async (req, res) => {
  try {
    const logs = await prisma.emailLog.findMany({
      orderBy: {
        createdAt: "desc",
      },
      take: 50,
    });

    return res.json(logs);
  } catch (err) {
    console.error("❌ Email logs fetch failed:", err);
    return res.status(500).json({
      success: false,
      error: String(err),
    });
  }
});
// GET all active journalists from PostgreSQL
app.get("/journalists", requireAdminToken, async (req, res) => {
  try {
    const journalists = await prisma.journalist.findMany({
      where: {
        isActive: true,
      },
      orderBy: {
        name: "asc",
      },
    });

    return res.json(journalists);
  } catch (err) {
    console.error("❌ Journalists fetch failed:", err);
    return res.status(500).json({
      success: false,
      error: String(err),
    });
  }
});
// CREATE journalist availability slot in PostgreSQL
app.post("/journalist-availability", requireAdminToken, async (req, res) => {
  try {
    const { journalistId, startTime, endTime, notes } = req.body || {};

    if (!journalistId || !startTime || !endTime) {
      return res.status(400).json({
        success: false,
        error: "Missing journalistId/startTime/endTime",
      });
    }

    const slot = await prisma.journalistAvailability.create({
      data: {
        journalistId,
        startTime: new Date(startTime),
        endTime: new Date(endTime),
        notes: notes || null,
        status: "AVAILABLE",
      },
    });

    return res.json({
      success: true,
      slot,
    });
  } catch (err) {
    console.error("❌ Journalist availability create failed:", err);
    return res.status(500).json({
      success: false,
      error: String(err),
    });
  }
});

// CREATE recording record after an interview has been completed
app.post("/recordings", requireAdminToken, async (req, res) => {
  try {
    const data = req.body || {};

   const {
  interviewRequestId,
  zoomMeetingId,
  title,
  description,
  speakerName,
  speakerTitle,
  organizationName,
  recordingUrl,
  recordingPasscode,
  transcriptUrl,
  thumbnailUrl,
  status,
} = data;

    if (!title || !recordingUrl) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: title and recordingUrl",
      });
    }

    const recording = await prisma.recording.create({
      data: {
        interviewRequestId: interviewRequestId ? String(interviewRequestId) : null,
        zoomMeetingId: zoomMeetingId ? String(zoomMeetingId) : null,
        title: String(title),
        description: description ? String(description) : null,
        speakerName: speakerName ? String(speakerName) : null,
        speakerTitle: speakerTitle ? String(speakerTitle) : null,
        organizationName: organizationName ? String(organizationName) : null,
        recordingUrl: String(recordingUrl),
        recordingPasscode: recordingPasscode ? String(recordingPasscode).trim() : null,
        transcriptUrl: transcriptUrl ? String(transcriptUrl) : null,
        thumbnailUrl: thumbnailUrl ? String(thumbnailUrl) : null,
        status: status ? String(status) : "DRAFT",
      },
    });

    console.log("✅ Recording saved to PostgreSQL:", recording.id);

    return res.json({
      success: true,
      recording,
    });
  } catch (err) {
    console.error("❌ Recording save failed:", err);
    return res.status(500).json({
      success: false,
      error: String(err),
    });
  }
});

// LIST recordings
app.get("/recordings", requireAdminToken, async (req, res) => {
  try {
    const recordings = await prisma.recording.findMany({
      orderBy: {
        createdAt: "desc",
      },
      include: {
        distributionLogs: {
          orderBy: {
            createdAt: "desc",
          },
          include: {
            church: true,
            churchContact: {
              include: {
                church: true,
              },
            },
          },
        },
      },
    });

    const enrichedRecordings = recordings.map((recording) => ({
      ...recording,
      distributionLogs: (recording.distributionLogs || []).map((log) => ({
        ...log,
        contactName: log.churchContact?.fullName || "Unknown contact",
        contactEmail: log.churchContact?.email || log.toEmail || "Unknown email",
        churchName: log.church?.name || log.churchContact?.church?.name || "Unknown church",
        sentDate: log.sentAt || log.createdAt || null,
        errorMessage: log.errorMessage || null,
      })),
    }));

    return res.json(enrichedRecordings);
  } catch (err) {
    console.error("❌ Recordings fetch failed:", err);
    return res.status(500).json({
      success: false,
      error: String(err),
    });
  }
});

// GET one recording by id
app.get("/recordings/:id", requireAdminToken, async (req, res) => {
  try {
    const id = String(req.params.id);

    const recording = await prisma.recording.findUnique({
      where: {
        id,
      },
      include: {
        distributionLogs: {
          orderBy: {
            createdAt: "desc",
          },
          include: {
            church: true,
            churchContact: {
              include: {
                church: true,
              },
            },
          },
        },
      },
    });

    if (!recording) {
      return res.status(404).json({
        success: false,
        error: "Recording not found",
      });
    }

    const enrichedRecording = {
      ...recording,
      distributionLogs: (recording.distributionLogs || []).map((log) => ({
        ...log,
        contactName: log.churchContact?.fullName || "Unknown contact",
        contactEmail: log.churchContact?.email || log.toEmail || "Unknown email",
        churchName: log.church?.name || log.churchContact?.church?.name || "Unknown church",
        sentDate: log.sentAt || log.createdAt || null,
        errorMessage: log.errorMessage || null,
      })),
    };

    return res.json(enrichedRecording);
  } catch (err) {
    console.error("❌ Recording fetch failed:", err);
    return res.status(500).json({
      success: false,
      error: String(err),
    });
  }
});

   // DISTRIBUTE one recording to selected church contacts

app.put("/recordings/:id", requireAdminToken, async (req, res) => {
  try {
    const id = String(req.params.id);

    const {
      title,
      speakerName,
      organizationName,
      description,
      recordingUrl,
      recordingPasscode,
      transcriptUrl,
      status,
    } = req.body || {};

    const data = {};

    if (title !== undefined) {
      const trimmedTitle = String(title).trim();
      if (!trimmedTitle) {
        return res.status(400).json({
          success: false,
          error: "Title is required",
        });
      }
      data.title = trimmedTitle;
    }

    if (speakerName !== undefined) {
      data.speakerName = String(speakerName).trim();
    }

    if (organizationName !== undefined) {
      data.organizationName = String(organizationName).trim();
    }

    if (description !== undefined) {
      data.description = String(description).trim();
    }

    if (recordingUrl !== undefined) {
      data.recordingUrl = String(recordingUrl).trim();
    }

    if (recordingPasscode !== undefined) {
  data.recordingPasscode = recordingPasscode
    ? String(recordingPasscode).trim()
    : null;
    }
    
    if (transcriptUrl !== undefined) {
      data.transcriptUrl = String(transcriptUrl).trim();
    }

    if (status !== undefined) {
      const normalizedStatus = String(status).trim().toUpperCase();

     if (!["DRAFT", "READY", "SENT", "ARCHIVED"].includes(normalizedStatus)) {
  return res.status(400).json({
    success: false,
    error: "Status must be DRAFT, READY, SENT, or ARCHIVED",
  });
} 

      data.status = normalizedStatus;
    }

    const updatedRecording = await prisma.recording.update({
      where: { id },
      data,
    });

    return res.status(200).json({
      success: true,
      recording: updatedRecording,
    });
  } catch (err) {
    console.error("❌ PUT /recordings/:id error:", err);

    if (err && err.code === "P2025") {
      return res.status(404).json({
        success: false,
        error: "Recording not found",
      });
    }

    return res.status(500).json({
      success: false,
      error: String(err),
    });
  }
});

// ARCHIVE one recording
app.post("/recordings/:id/archive", requireAdminToken, async (req, res) => {
  try {
    const id = String(req.params.id);

    const recording = await prisma.recording.update({
      where: { id },
      data: {
        status: "ARCHIVED",
      },
    });

    return res.json({
      success: true,
      recording,
    });
  } catch (err) {
    console.error("❌ Recording archive failed:", err);
    return res.status(500).json({
      success: false,
      error: String(err),
    });
  }
});

// API compatibility archive route
app.post("/api/recordings/:id/archive", requireAdminToken, async (req, res) => {
  try {
    const id = String(req.params.id);

    const recording = await prisma.recording.update({
      where: { id },
      data: {
        status: "ARCHIVED",
      },
    });

    return res.json({
      success: true,
      recording,
    });
  } catch (err) {
    console.error("❌ Recording archive failed:", err);
    return res.status(500).json({
      success: false,
      error: String(err),
    });
  }
});

app.post("/recordings/:id/distribute", requireAdminToken, async (req, res) => {
  try {
    const recordingId = String(req.params.id);
    const data = req.body || {};
    const recipients = Array.isArray(data.recipients) ? data.recipients : [];

    if (!recipients.length) {
      return res.status(400).json({
        success: false,
        error: "Missing recipients array",
      });
    }

    const recording = await prisma.recording.findUnique({
      where: {
        id: recordingId,
      },
    });

    if (!recording) {
      return res.status(404).json({
        success: false,
        error: "Recording not found",
      });
    }

    const results = [];

    for (const recipient of recipients) {
    let toEmail = "";
    let churchId = null;
    let churchContactId = null;
    let recipientName = "Friend";
    let churchName = "";

  if (typeof recipient === "string") {
    churchContactId = recipient;
  } else if (recipient && typeof recipient === "object") {
    toEmail = recipient.email ? String(recipient.email) : "";
    churchContactId = recipient.churchContactId ? String(recipient.churchContactId) : null;
    recipientName = recipient.name ? String(recipient.name) : "Friend";
  }

  if (churchContactId) {
    const contact = await prisma.churchContact.findUnique({
      where: { id: churchContactId },
      include: { church: true },
    });

    if (contact) {
    toEmail = contact.email || toEmail;
    recipientName = contact.fullName || recipientName;
    churchContactId = contact.id;
    churchId = contact.churchId;
    churchName = contact.church?.name || "";  
    }
  }

  if (!toEmail) {
    results.push({
      success: false,
      email: null,
      error: "Missing recipient email",
    });
    continue;
  }

      const subject =
        data.subject ||
        `Court of Compassion Recording: ${recording.title}`;

   function isValidTranscriptUrl(url) {
  if (!url) return false;

  const value = String(url).trim();

  if (!value) return false;
  if (value.includes("example.com")) return false;
  if (value.includes("about:blank")) return false;

  return value.startsWith("http://") || value.startsWith("https://");
}

  function parseRecordingUrlAndPasscode(value) {
  const raw = String(value || "").trim();

  if (!raw) {
    return {
      recordingUrl: "",
      passcode: "",
    };
  }

  const passcodeMatch = raw.match(/passcode:\s*([^\s]+)/i);

  const passcode = passcodeMatch ? passcodeMatch[1].trim() : "";

  const recordingUrl = raw
    .replace(/passcode:\s*[^\s]+/i, "")
    .trim();

  return {
    recordingUrl,
    passcode,
  };
}

const parsedRecording = parseRecordingUrlAndPasscode(recording.recordingUrl);
const recordingPasscode =
  recording.recordingPasscode || parsedRecording.passcode;
      
const transcriptSection = isValidTranscriptUrl(recording.transcriptUrl)
  ? `Transcript:\n${String(recording.transcriptUrl).trim()}`
  : `Transcript:\nThe transcript may be available inside the Zoom recording page.`;

const body = [
 `Dear ${recipientName || "Friend"},`,
"",
"A Court of Compassion recording is now available for your review and sharing.",
"",
"Recipient:",
recipientName || "Friend",
"",
"Email:",
toEmail,
"",
churchName ? "Church / Parish / Organization:" : "",
churchName ? churchName : "",
churchName ? "" : "",
"Recording:",
  recording.title || "Untitled Recording",
  "",
  "Speaker:",
  recording.speakerName || "Court of Compassion",
  "",
  recording.description ? "Description:" : "",
  recording.description ? recording.description : "",
  recording.description ? "" : "",
  parsedRecording.recordingUrl ? "Recording Link:" : "",
  parsedRecording.recordingUrl ? parsedRecording.recordingUrl : "",
  parsedRecording.recordingUrl ? "" : "",
  recordingPasscode ? "Recording Passcode:" : "",
  recordingPasscode ? recordingPasscode : "",
  recordingPasscode ? "" : "",
  transcriptSection,
  "",
  "Suggested Use:",
  "You may share this recording with your church community, ministry team, or study group as appropriate. It may also be used as a discussion resource for Bible study, parish reflection, or preparation for future Court of Compassion conversations.",
  "",
  "Thank you,",
  "Court of Compassion",
]
  .filter(Boolean)
  .join("\n");

      let distributionLog;

     const escapeHtml = (value) =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const recordingButtonHtml = parsedRecording.recordingUrl
  ? `<p style="margin: 24px 0;"><a href="${escapeHtml(parsedRecording.recordingUrl)}" style="background:#0b2a6f;color:#ffffff;padding:12px 18px;text-decoration:none;border-radius:6px;display:inline-block;font-weight:bold;">Watch Recording</a></p>`
  : "";

const transcriptHtml = isValidTranscriptUrl(recording.transcriptUrl)
  ? `<p><strong>Transcript:</strong><br><a href="${escapeHtml(String(recording.transcriptUrl).trim())}">${escapeHtml(String(recording.transcriptUrl).trim())}</a></p>`
  : `<p><strong>Transcript:</strong><br>The transcript may be available inside the Zoom recording page.</p>`;

const htmlBody = `
  <div style="font-family: Arial, sans-serif; font-size: 15px; line-height: 1.5; color: #111827;">
    <p>Dear ${escapeHtml(recipientName || "Friend")},</p>

    <p>A Court of Compassion recording is now available for your review and sharing.</p>

    <p>
      <strong>Recipient:</strong><br>
      ${escapeHtml(recipientName || "Friend")}<br><br>
      <strong>Email:</strong><br>
      ${escapeHtml(toEmail)}<br><br>
      ${churchName ? `<strong>Church / Parish / Organization:</strong><br>${escapeHtml(churchName)}<br><br>` : ""}
    </p>

    <p>
      <strong>Recording:</strong><br>
      ${escapeHtml(recording.title || "Untitled Recording")}
    </p>

    <p>
      <strong>Speaker:</strong><br>
      ${escapeHtml(recording.speakerName || "Court of Compassion")}
    </p>

    ${recording.description ? `<p><strong>Description:</strong><br>${escapeHtml(recording.description)}</p>` : ""}

    ${recordingButtonHtml}

    ${parsedRecording.recordingUrl ? `<p><strong>Recording Link:</strong><br><a href="${escapeHtml(parsedRecording.recordingUrl)}">${escapeHtml(parsedRecording.recordingUrl)}</a></p>` : ""}

    ${recordingPasscode ? `<p><strong>Recording Passcode:</strong><br>${escapeHtml(recordingPasscode)}</p>` : ""}

    ${transcriptHtml}

    <p>
      <strong>Suggested Use:</strong><br>
      You may share this recording with your church community, ministry team, or study group as appropriate. It may also be used as a discussion resource for Bible study, parish reflection, or preparation for future Court of Compassion conversations.
    </p>

    <p>
      Thank you,<br>
      Court of Compassion
    </p>
  </div>
`; 

      try {
        distributionLog = await prisma.distributionLog.create({
          data: {
            recordingId,
            churchId,
            churchContactId,
            toEmail,
            subject: String(subject),
            status: "PENDING",
          },
        });

        await sendEmail(toEmail, String(subject), body, htmlBody);

        const updatedLog = await prisma.distributionLog.update({
          where: {
            id: distributionLog.id,
          },
          data: {
            status: "SENT",
            sentAt: new Date(),
          },
        });

        results.push({
          success: true,
          email: toEmail,
          distributionLog: updatedLog,
        });
      } catch (sendErr) {
        console.error("❌ Recording distribution failed:", sendErr);

        if (distributionLog) {
          await prisma.distributionLog.update({
            where: {
              id: distributionLog.id,
            },
            data: {
              status: "FAILED",
              errorMessage: String(sendErr),
            },
          });
        }

        results.push({
          success: false,
          email: toEmail,
          error: String(sendErr),
        });
      }
    }

    return res.json({
      success: true,
      recordingId,
      results,
    });
  } catch (err) {
    console.error("❌ Recording distribution route failed:", err);
    return res.status(500).json({
      success: false,
      error: String(err),
    });
  }
});
// GET availability slots for one journalist from PostgreSQL
app.get("/journalist-availability/:journalistId", requireAdminToken, async (req, res) => {
  try {
    const journalistId = String(req.params.journalistId);

    const slots = await prisma.journalistAvailability.findMany({
      where: {
        journalistId,
      },
      orderBy: {
        startTime: "asc",
      },
    });

    return res.json(slots);
  } catch (err) {
    console.error("❌ Journalist availability fetch failed:", err);
    return res.status(500).json({
      success: false,
      error: String(err),
    });
  }
});
// CREATE or UPDATE Zoom meeting details for an interview request
app.post("/zoom-meetings", requireAdminToken, async (req, res) => {
  try {
    const {
      interviewRequestId,
      journalistId,
      zoomMeetingId,
      joinUrl,
      startUrl,
      topic,
      scheduledStartTime,
      durationMinutes,
      status,
    } = req.body || {};

    if (!interviewRequestId || !topic) {
      return res.status(400).json({
        success: false,
        error: "Missing interviewRequestId/topic",
      });
    }

    const zoomMeeting = await prisma.zoomMeeting.upsert({
      where: {
        interviewRequestId,
      },
      update: {
        journalistId: journalistId || null,
        zoomMeetingId: zoomMeetingId || null,
        joinUrl: joinUrl || null,
        startUrl: startUrl || null,
        topic,
        scheduledStartTime: scheduledStartTime
          ? new Date(scheduledStartTime)
          : null,
        durationMinutes: durationMinutes ? Number(durationMinutes) : null,
        status: status || "CREATED",
      },
      create: {
        interviewRequestId,
        journalistId: journalistId || null,
        zoomMeetingId: zoomMeetingId || null,
        joinUrl: joinUrl || null,
        startUrl: startUrl || null,
        topic,
        scheduledStartTime: scheduledStartTime
          ? new Date(scheduledStartTime)
          : null,
        durationMinutes: durationMinutes ? Number(durationMinutes) : null,
        status: status || "CREATED",
      },
    });

    return res.json({
      success: true,
      zoomMeeting,
    });
  } catch (err) {
    console.error("❌ Zoom meeting save failed:", err);
    return res.status(500).json({
      success: false,
      error: String(err),
    });
  }
});

// GET Zoom meeting details for one interview request
app.get("/zoom-meetings/:interviewRequestId", requireAdminToken, async (req, res) => {
  try {
    const interviewRequestId = String(req.params.interviewRequestId);

    const zoomMeeting = await prisma.zoomMeeting.findUnique({
      where: {
        interviewRequestId,
      },
    });

    return res.json(zoomMeeting);
  } catch (err) {
    console.error("❌ Zoom meeting fetch failed:", err);
    return res.status(500).json({
      success: false,
      error: String(err),
    });
  }
});

// SCHEDULE interview by creating Zoom meeting and saving it to PostgreSQL
app.post("/schedule-interview", requireAdminToken, async (req, res) => {
  try {
    const {
      interviewRequestId,
      journalistId,
      startTime,
      duration,
      timezone,
      agenda,
      password,
      settings,
    } = req.body || {};

    if (!interviewRequestId || !startTime || !duration) {
      return res.status(400).json({
        success: false,
        error: "Missing interviewRequestId/startTime/duration",
      });
    }

    const request = await prisma.interviewRequest.findUnique({
      where: {
        id: String(interviewRequestId),
      },
    });

    if (!request) {
      return res.status(404).json({
        success: false,
        error: "Interview request not found",
      });
    }
    function toZoomLocalStartTime(dateValue, timeZone = "America/Los_Angeles") {
  if (!dateValue) return dateValue;

  const date = new Date(dateValue);

  if (Number.isNaN(date.getTime())) {
    return String(dateValue).replace(/\.\d{3}Z$/, "").replace(/Z$/, "");
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const get = (type) => parts.find((part) => part.type === type)?.value;

  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}
    
    const accessToken = await getS2SAccessToken();

    const topic = `Court of Compassion Interview - ${request.name || "Guest"}`;
    const zoomTimezone = timezone ? String(timezone) : "America/Los_Angeles";
    const zoomStartTime = toZoomLocalStartTime(startTime, zoomTimezone);

    const zoomPayload = {
      topic,
      type: 2,
      start_time: zoomStartTime,
      duration: Number(duration),
     timezone: zoomTimezone,
      agenda: agenda ? String(agenda) : undefined,
      password: password ? String(password) : undefined,
      settings: {
        join_before_host: false,
        waiting_room: true,
        approval_type: 2,
        meeting_authentication: false,
        ...((settings && typeof settings === "object") ? settings : {}),
      },
    };

    const zoomRes = await fetch("https://api.zoom.us/v2/users/me/meetings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(zoomPayload),
    });

    const zoomData = await zoomRes.json().catch(() => ({}));

    if (!zoomRes.ok) {
      return res.status(zoomRes.status).json({
        success: false,
        error: zoomData?.message || "Zoom API error creating meeting",
        details: zoomData,
      });
    }

    const zoomMeeting = await prisma.zoomMeeting.upsert({
      where: {
        interviewRequestId: String(interviewRequestId),
      },
      update: {
        journalistId: journalistId ? String(journalistId) : request.selectedJournalistId || null,
        zoomMeetingId: zoomData.id ? String(zoomData.id) : null,
        joinUrl: zoomData.join_url || null,
        startUrl: zoomData.start_url || null,
        topic: zoomData.topic || topic,
        scheduledStartTime: zoomData.start_time
          ? new Date(zoomData.start_time)
          : new Date(startTime),
        durationMinutes: zoomData.duration ? Number(zoomData.duration) : Number(duration),
        status: "SCHEDULED",
      },
      create: {
        interviewRequestId: String(interviewRequestId),
        journalistId: journalistId ? String(journalistId) : request.selectedJournalistId || null,
        zoomMeetingId: zoomData.id ? String(zoomData.id) : null,
        joinUrl: zoomData.join_url || null,
        startUrl: zoomData.start_url || null,
        topic: zoomData.topic || topic,
        scheduledStartTime: zoomData.start_time
          ? new Date(zoomData.start_time)
          : new Date(startTime),
        durationMinutes: zoomData.duration ? Number(zoomData.duration) : Number(duration),
        status: "SCHEDULED",
      },
    });

    const updatedRequest = await prisma.interviewRequest.update({
      where: {
        id: String(interviewRequestId),
      },
      data: {
        status: "scheduled",
        scheduledAt: zoomMeeting.scheduledStartTime,
      },
    });

    function formatDateTimeForEmail(dateValue) {
  if (!dateValue) return "Not provided";

  const date = new Date(dateValue);

  if (Number.isNaN(date.getTime())) {
    return String(dateValue);
  }

  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "long",
  }).format(date);
}

    // Send scheduled interview email to applicant and log it
try {
  const scheduledEmailSubject = "Court of Compassion Interview Scheduled";

  const scheduledEmailBody = [
    `Dear ${request.name || "Guest"},`,
    "",
    "Your Court of Compassion interview has been scheduled.",
    "",
    "Interview Details:",
    `Topic: ${request.topic || zoomMeeting.topic}`,
    `Date/Time: ${formatDateTimeForEmail(zoomMeeting.scheduledStartTime)}`,
    `Duration: ${zoomMeeting.durationMinutes || duration} minutes`,
    "",
    "Zoom Meeting Details:",
    `Join Link: ${zoomMeeting.joinUrl}`,
    zoomMeeting.zoomMeetingId ? `Meeting ID: ${zoomMeeting.zoomMeetingId}` : "",
    "",
    "Please use the join link above at the scheduled time.",
    "",
    "Thank you,",
    "Court of Compassion",
  ]
    .filter(Boolean)
    .join("\n");

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  await transporter.sendMail({
    from: `"Court of Compassion" <${process.env.GMAIL_USER}>`,
    to: request.email,
    subject: scheduledEmailSubject,
    text: scheduledEmailBody,
  });

  await prisma.emailLog.create({
    data: {
      interviewRequestId: String(interviewRequestId),
      toEmail: request.email,
      subject: scheduledEmailSubject,
      bodyPreview: scheduledEmailBody.slice(0, 1000),
      emailType: "ZOOM_DETAILS",
      status: "SENT",
      sentAt: new Date(),
    },
  });

  console.log("✅ SCHEDULED INTERVIEW EMAIL SENT AND LOGGED:", request.email);
} catch (emailErr) {
  console.error("⚠️ Interview scheduled but email failed:", emailErr);

  await prisma.emailLog.create({
    data: {
      interviewRequestId: String(interviewRequestId),
      toEmail: request.email || "unknown",
      subject: "Court of Compassion Interview Scheduled",
      bodyPreview: "Scheduled interview email failed before body could be sent.",
      emailType: "ZOOM_DETAILS",
      status: "FAILED",
      errorMessage: String(emailErr),
    },
  });
}

    console.log("✅ INTERVIEW SCHEDULED AND ZOOM MEETING SAVED:", zoomMeeting.id);

    return res.json({
      success: true,
      request: updatedRequest,
      zoomMeeting,
      raw: zoomData,
    });
  } catch (err) {
    console.error("❌ Schedule interview failed:", err);
    return res.status(500).json({
      success: false,
      error: String(err),
    });
  }
});
// APPROVE interview request in PostgreSQL
app.post("/approve/:id", requireAdminToken, async (req, res) => {
  try {
    const id = String(req.params.id);

    const request = await prisma.interviewRequest.update({
      where: {
        id,
      },
      data: {
        status: "approved",
      },
    });

    console.log("✅ Approved request:", request.id);

    return res.json({
      success: true,
      request,
    });
  } catch (err) {
    console.error("❌ Approve failed:", err);

    return res.status(404).json({
      success: false,
      error: "Request not found or could not be approved",
      details: String(err),
    });
  }
});
app.post("/send-test-email", async (req, res) => {
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
      }
    });

    await transporter.sendMail({
     from: `"Court of Compassion" <${process.env.GMAIL_USER}>`,
     replyTo: process.env.GMAIL_USER,

      to: process.env.GMAIL_USER,
      subject: "Zoom Backend Email Test",
      text: "Your backend email configuration is working."
    });

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Email failed", details: String(error) });
  }
});

const PORT = process.env.PORT || 3000;


   

app.get("/ping", (req, res) => {
  console.log("HIT /ping", new Date().toISOString());
  res.status(200).send("pong");
});
app.get("/health", (req, res) => {
  res.status(200).json({ message: "Backend is available" });
});
// ---- /api compatibility layer (supports Wix calling /api/*) ----
app.get("/api/health", (req, res) => {
  res.status(200).json({ message: "Backend is available" });
});

app.get("/api/zoom/meetings", (req, res) => {
  res.json({ meetings: [] });
});

app.post("/api/zoom/meetings", async (req, res) => {
  try {
const accessToken = await getS2SAccessToken();

 const {
  topic,
  startTime,
  duration,
  agenda,
  timezone,
  password,
  settings,
  interviewRequestId,
  journalistId,
} = req.body || {};   

    if (!topic || !startTime || !duration) {
      return res.status(400).json({
        error: "Missing required fields: topic, startTime, duration",
      });
    }

    const zoomPayload = {
      topic: String(topic),
      type: 2,
      start_time: String(startTime),
      duration: Number(duration),
      timezone: timezone ? String(timezone) : undefined,
      agenda: agenda ? String(agenda) : undefined,
      password: password ? String(password) : undefined,
      settings: {
        join_before_host: false,
        waiting_room: true,
        approval_type: 2,
        meeting_authentication: false,
        ...((settings && typeof settings === "object") ? settings : {}),
      },
    };

    const zoomRes = await fetch("https://api.zoom.us/v2/users/me/meetings", {
      method: "POST",
      headers: {
      Authorization: `Bearer ${accessToken}`,
 
        "Content-Type": "application/json",
      },
      body: JSON.stringify(zoomPayload),
    });

    const zoomData = await zoomRes.json().catch(() => ({}));

    if (!zoomRes.ok) {
      return res.status(zoomRes.status).json({
        error: zoomData?.message || "Zoom API error creating meeting",
        details: zoomData,
      });
    }

    const meeting = {
      id: zoomData.id,
      topic: zoomData.topic,
      startTime: zoomData.start_time,
      duration: zoomData.duration,
      joinUrl: zoomData.join_url,
      password: zoomData.password,
      hostEmail: zoomData.host_email,
      timezone: zoomData.timezone,
    };

    // Save Zoom meeting details to PostgreSQL when linked to an interview request
if (interviewRequestId) {
  try {
    await prisma.zoomMeeting.upsert({
      where: {
        interviewRequestId: String(interviewRequestId),
      },
      update: {
        journalistId: journalistId ? String(journalistId) : null,
        zoomMeetingId: zoomData.id ? String(zoomData.id) : null,
        joinUrl: zoomData.join_url || null,
        startUrl: zoomData.start_url || null,
        topic: zoomData.topic || String(topic),
        scheduledStartTime: zoomData.start_time
          ? new Date(zoomData.start_time)
          : new Date(startTime),
        durationMinutes: zoomData.duration ? Number(zoomData.duration) : Number(duration),
        status: "CREATED",
      },
      create: {
        interviewRequestId: String(interviewRequestId),
        journalistId: journalistId ? String(journalistId) : null,
        zoomMeetingId: zoomData.id ? String(zoomData.id) : null,
        joinUrl: zoomData.join_url || null,
        startUrl: zoomData.start_url || null,
        topic: zoomData.topic || String(topic),
        scheduledStartTime: zoomData.start_time
          ? new Date(zoomData.start_time)
          : new Date(startTime),
        durationMinutes: zoomData.duration ? Number(zoomData.duration) : Number(duration),
        status: "CREATED",
      },
    });

    console.log("✅ API ZOOM MEETING SAVED TO POSTGRESQL");
  } catch (dbErr) {
    console.error("⚠️ API Zoom meeting created but DB save failed:", dbErr);
  }
}

    return res.json({ success: true, meeting, raw: zoomData });
  } catch (err) {
    console.error("❌ create meeting error:", err);
    return res.status(500).json({ error: String(err) });
  }
});

// ---- Wix frontend expected routes ----

// GET meetings (basic response so Wix always receives JSON)
app.get("/zoom/meetings", (req, res) => {
  res.json({ meetings: [] });
});
app.post("/zoom/meetings", async (req, res) => {
  try {
  const accessToken = await getS2SAccessToken();

  const {
  topic,
  startTime,
  duration,
  agenda,
  timezone,
  password,
  settings,
  interviewRequestId,
  journalistId,
} = req.body || {};  
    
    if (!topic || !startTime || !duration) {
      return res.status(400).json({
        error: "Missing required fields: topic, startTime, duration",
      });
    }

    const zoomPayload = {
      topic: String(topic),
      type: 2,
      start_time: String(startTime),
      duration: Number(duration),
      timezone: timezone ? String(timezone) : undefined,
      agenda: agenda ? String(agenda) : undefined,
      password: password ? String(password) : undefined,
      settings: {
        join_before_host: false,
        waiting_room: true,
        approval_type: 2,
        meeting_authentication: false,
        ...((settings && typeof settings === "object") ? settings : {}),
      },
    };
    start_time: "2026-05-06T09:00:00"
timezone: "America/Los_Angeles"
    const zoomRes = await fetch("https://api.zoom.us/v2/users/me/meetings", {
      method: "POST",
      headers: {
      Authorization: `Bearer ${accessToken}`,
 
        "Content-Type": "application/json",
      },
      body: JSON.stringify(zoomPayload),
    });

    const zoomData = await zoomRes.json().catch(() => ({}));

    if (!zoomRes.ok) {
      return res.status(zoomRes.status).json({
        error: zoomData?.message || "Zoom API error creating meeting",
        details: zoomData,
      });
    }

    const meeting = {
      id: zoomData.id,
      topic: zoomData.topic,
      startTime: zoomData.start_time,
      duration: zoomData.duration,
      joinUrl: zoomData.join_url,
      password: zoomData.password,
      hostEmail: zoomData.host_email,
      timezone: zoomData.timezone,
    };
// Save Zoom meeting details to PostgreSQL when linked to an interview request
if (interviewRequestId) {
  try {
    await prisma.zoomMeeting.upsert({
      where: {
        interviewRequestId: String(interviewRequestId),
      },
      update: {
        journalistId: journalistId ? String(journalistId) : null,
        zoomMeetingId: zoomData.id ? String(zoomData.id) : null,
        joinUrl: zoomData.join_url || null,
        startUrl: zoomData.start_url || null,
        topic: zoomData.topic || String(topic),
        scheduledStartTime: zoomData.start_time
          ? new Date(zoomData.start_time)
          : new Date(startTime),
        durationMinutes: zoomData.duration ? Number(zoomData.duration) : Number(duration),
        status: "CREATED",
      },
      create: {
        interviewRequestId: String(interviewRequestId),
        journalistId: journalistId ? String(journalistId) : null,
        zoomMeetingId: zoomData.id ? String(zoomData.id) : null,
        joinUrl: zoomData.join_url || null,
        startUrl: zoomData.start_url || null,
        topic: zoomData.topic || String(topic),
        scheduledStartTime: zoomData.start_time
          ? new Date(zoomData.start_time)
          : new Date(startTime),
        durationMinutes: zoomData.duration ? Number(zoomData.duration) : Number(duration),
        status: "CREATED",
      },
    });

    console.log("✅ ZOOM MEETING SAVED TO POSTGRESQL");
  } catch (dbErr) {
    console.error("⚠️ Zoom meeting created but DB save failed:", dbErr);
  }
}
    return res.json({ success: true, meeting, raw: zoomData });
  } catch (err) {
    console.error("❌ create meeting error:", err);
    return res.status(500).json({ error: String(err) });
  }
});


app.get("/test-email", (req, res) => {
  console.log("HIT /test-email", new Date().toISOString());

  // respond immediately so browser never spins
  res.status(200).send("Sending email... check Render Logs for result.");

  (async () => {
    try {
    const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});
      await transporter.sendMail({
       from: `"Court of Compassion" <${process.env.GMAIL_USER}>`,
       replyTo: process.env.GMAIL_USER,

        to: req.query.to || process.env.GMAIL_USER,
        subject: "Zoom Backend Email Test",
        text: "Your backend email configuration is working.",
      });

      console.log("✅ TEST EMAIL SENT");
    } catch (err) {
      console.log("❌ TEST EMAIL ERROR:", err);
    }
  })();
});
// ✅ ADD THIS BLOCK HERE (above /send-email)

app.get("/send-test-email", async (req, res) => {
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    await transporter.sendMail({
      from: `"Court of Compassion" <${process.env.GMAIL_USER}>`,
      to: process.env.GMAIL_USER,
      subject: "Zoom Backend Test Email",
      text: "Your backend email configuration is working.",
    });

    console.log("✅ TEST EMAIL SENT");
    res.send("Test email sent");
  } catch (err) {
    console.log("❌ TEST EMAIL ERROR:", err);
    res.status(500).send("Error sending test email");
  }
});

// 🔽 EXISTING CODE (DO NOT MOVE)
// ✅ EXISTING CODE (DO NOT MOVE)
app.post("/send-email", async (req, res) => {
  let to = "";
  let subject = "";
  let cleanText = "";
  let interviewRequestId = null;
  let emailType = "GENERAL";

  try {
    const body = req.body || {};

    to = body.to || "";
    subject = body.subject || "";
    const text = body.text || "";
    const replyTo = body.replyTo || undefined;

    // Optional fields for database logging
    interviewRequestId = body.interviewRequestId || null;
    emailType = body.emailType || "GENERAL";

    // 🧹 CLEAN incoming text to remove any existing Meeting Details
    cleanText = text || "";

    if (cleanText) {
      // Remove frontend section
      if (cleanText.includes("Your Meeting Details")) {
        cleanText = cleanText.split("Your Meeting Details")[0].trim();
      }

      // Remove backend section (safety)
      if (cleanText.includes("MEETING DETAILS")) {
        cleanText = cleanText.split("MEETING DETAILS")[0].trim();
      }
    }

    if (!to || !subject || !cleanText) {
      return res.status(400).json({ error: "Missing to/subject/text" });
    }

    // 🔵 STEP 1 — Email transporter
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    // 🔵 STEP 2 — Send email
    console.log("📧 Sending email TO:", to);

    await transporter.sendMail({
      from: `"Court of Compassion" <${process.env.GMAIL_USER}>`,
      to,
      subject,
      text: cleanText,
      replyTo: replyTo || undefined,
    });

    console.log("✅ SEND-EMAIL SUCCESS");

    // 🔵 STEP 3 — Log successful email to PostgreSQL
    try {
      await prisma.emailLog.create({
        data: {
          interviewRequestId,
          toEmail: to,
          subject,
          bodyPreview: cleanText.slice(0, 500),
          emailType,
          status: "SENT",
          sentAt: new Date(),
        },
      });

      console.log("✅ EMAIL LOG SAVED");
    } catch (logErr) {
      // Do not fail the email request just because logging failed
      console.error("⚠️ EMAIL SENT BUT LOGGING FAILED:", logErr);
    }

    // 🔵 STEP 4 — Return to Wix
    res.json({
      success: true,
    });
  } catch (err) {
    console.log("❌ SEND-EMAIL ERROR:", err);

    // 🔴 Try to log failed email attempt to PostgreSQL
    try {
      if (to && subject) {
        await prisma.emailLog.create({
          data: {
            interviewRequestId,
            toEmail: to,
            subject,
            bodyPreview: cleanText ? cleanText.slice(0, 500) : null,
            emailType,
            status: "FAILED",
            errorMessage: String(err),
          },
        });

        console.log("⚠️ FAILED EMAIL LOG SAVED");
      }
    } catch (logErr) {
      console.error("⚠️ FAILED EMAIL LOGGING ALSO FAILED:", logErr);
    }

    res.status(500).json({ success: false, error: String(err) });
  }
});
   

 
/* 🚨 NOTHING after this except listen */
 

// ---- ZOOM OAUTH (OWNER = YOU) ----
let zoomTokens = null; // stored in memory for now
// =========================
// ZOOM S2S OAUTH (ACCOUNT)
// =========================
let zoomS2SToken = null;
let zoomS2STokenExpiresAt = 0; // unix ms

async function getS2SAccessToken() {
  const accountId = process.env.ZOOM_S2S_ACCOUNT_ID;
  const clientId = process.env.ZOOM_S2S_CLIENT_ID;
  const clientSecret = process.env.ZOOM_S2S_CLIENT_SECRET;

  if (!accountId || !clientId || !clientSecret) {
    throw new Error("Missing ZOOM_S2S_ACCOUNT_ID / ZOOM_S2S_CLIENT_ID / ZOOM_S2S_CLIENT_SECRET");
  }

  // If we still have a valid token, reuse it (refresh ~60 seconds early)
  if (zoomS2SToken && Date.now() < (zoomS2STokenExpiresAt - 60_000)) {
    return zoomS2SToken;
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  // IMPORTANT: this request is form-encoded (not JSON)
  const tokenRes = await fetch("https://zoom.us/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "account_credentials",
      account_id: String(accountId),
    }),
  });

  const tokenData = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok) {
    throw new Error(`S2S token failed: ${tokenData?.reason || tokenData?.message || JSON.stringify(tokenData)}`);
  }

  zoomS2SToken = tokenData.access_token;
  const expiresInSec = Number(tokenData.expires_in || 0);
  zoomS2STokenExpiresAt = Date.now() + Math.max(0, expiresInSec) * 1000;

  return zoomS2SToken;
}

const zoomTokenStore = new Map();

// ✅ Refresh Zoom access token when it expires
async function refreshZoomAccessToken() {
  if (!zoomTokens?.refresh_token) {
    throw new Error("No refresh_token saved. Please re-authorize at /zoom/oauth/start");
  }

  const basic = Buffer.from(
    `${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`
  ).toString("base64");

  const refreshRes = await fetch("https://zoom.us/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: String(zoomTokens.refresh_token),
    }),
  });

  const refreshData = await refreshRes.json().catch(() => ({}));

  if (!refreshRes.ok) {
    throw new Error(
      `Refresh failed: ${refreshData?.reason || refreshData?.message || JSON.stringify(refreshData)}`
    );
  }

  // Zoom sometimes returns a new refresh_token — always save what Zoom returns
  zoomTokens = { ...refreshData, obtained_at: Date.now() };

  return zoomTokens.access_token;
}

// ✅ Get a valid token (refreshes automatically if expired)
async function getValidZoomAccessToken() {
  if (!zoomTokens?.access_token) return null;

  const expiresInSec = Number(zoomTokens.expires_in || 0);
  const obtainedAt = Number(zoomTokens.obtained_at || 0);

  // Refresh 60 seconds early to avoid timing issues
  const expiresAt = obtainedAt + Math.max(0, expiresInSec - 60) * 1000;

  if (!obtainedAt || !expiresInSec || Date.now() >= expiresAt) {
    return await refreshZoomAccessToken();
  }

  return zoomTokens.access_token;
}


app.get("/zoom/oauth/start", (req, res) => {
  const redirectUri = process.env.ZOOM_REDIRECT_URL;
  const clientId = process.env.ZOOM_CLIENT_ID;
  console.log("ZOOM_CLIENT_ID used by backend:", process.env.ZOOM_CLIENT_ID);

  if (!redirectUri || !clientId) {
    return res.status(500).send("Missing ZOOM_CLIENT_ID or ZOOM_REDIRECT_URL");
  }
const state = req.query.state ? String(req.query.state) : undefined;

  let url =
    `https://zoom.us/oauth/authorize?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;
if (state) {
  url += `&state=${encodeURIComponent(state)}`;
}
url += `&prompt=consent`;

  return res.redirect(url);
});

app.get("/zoom/oauth/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing code");

    const basic = Buffer.from(
      `${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`
    ).toString("base64");

    const tokenRes = await fetch("https://zoom.us/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: process.env.ZOOM_REDIRECT_URL,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      throw new Error(`Token exchange failed: ${JSON.stringify(tokenData)}`);
    }

    zoomTokens = { ...tokenData, obtained_at: Date.now() };
    const hostKey = String(req.query.state || "default");
    zoomTokenStore.set(hostKey, { ...tokenData, obtained_at: Date.now() });
    console.log("✅ Stored Zoom tokens for hostKey:", hostKey);

    return res.send("✅ Zoom connected. You can close this tab.");
  } catch (err) {
    console.error(err);
    return res.status(500).send(String(err));
  }
});

app.get("/zoom/status", (req, res) => {
  res.json({
    connected: Boolean(zoomTokens?.access_token),
    hasRefreshToken: Boolean(zoomTokens?.refresh_token),
  });
});

// ✅ Browser test route (GET)
app.get("/zoom/webhook", (req, res) => {
  console.log("✅ GET /zoom/webhook HIT");
  res.status(200).send("ok");
});


app.post("/zoom/webhook", express.raw({ type: "application/json" }), (req, res) => {
  try {
   let body = {};

if (Buffer.isBuffer(req.body)) {
  const raw = req.body.toString("utf8");
  body = raw ? JSON.parse(raw) : {};
} else if (typeof req.body === "object" && req.body !== null) {
  body = req.body;
} else if (typeof req.body === "string") {
  body = req.body ? JSON.parse(req.body) : {};
}

    console.log("📩 ZOOM WEBHOOK HIT:", body?.event || "(no event)");

    // Zoom URL validation handshake
    if (body?.event === "endpoint.url_validation") {
      const plainToken = body?.payload?.plainToken;
      const secret = process.env.ZOOM_WEBHOOK_SECRET || "";

      if (!plainToken || !secret) {
        console.log("❌ Missing plainToken or ZOOM_WEBHOOK_SECRET");
        return res.status(400).json({ error: "Missing plainToken or secret" });
      }

      const encryptedToken = crypto
        .createHmac("sha256", secret)
        .update(plainToken)
        .digest("hex");

      return res.status(200).json({ plainToken, encryptedToken });
    }

    // Normal events
    return res.status(200).send("ok");
  } catch (err) {
    console.log("❌ ZOOM WEBHOOK ERROR:", err);
    return res.status(200).send("ok");
  }
});
app.get("/zoom/token-scope", (req, res) => {
  res.json({
    connected: Boolean(zoomTokens),
    scope: zoomTokens?.scope || null,
  });
});


// ✅ Optional: GET handler so you can test in browser

// ✅ Webhook handler (Zoom will POST here)
app.get("/zoom/disconnect", (req, res) => {
  zoomTokens = null;
  zoomTokenStore.clear();
  return res.json({ ok: true, connected: false });
});



// Create request

// ===============================
// Church + Contact Admin Routes
// Needed by /admin/recordings distribution modal
// ===============================

app.get("/churches", requireAdminToken, async (req, res) => {
  try {
    const churches = await prisma.church.findMany({
      orderBy: {
        name: "asc",
      },
      include: {
        contacts: {
          orderBy: {
            fullName: "asc",
          },
        },
      },
    });

    return res.status(200).json(churches);
  } catch (err) {
    console.error("❌ GET /churches error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch churches",
    });
  }
});

app.get("/church-contacts", requireAdminToken, async (req, res) => {
  try {
    const contacts = await prisma.churchContact.findMany({
      where: {
        canReceiveRecordings: true,
      },
      orderBy: {
        fullName: "asc",
      },
      include: {
        church: {
          select: {
            id: true,
            name: true,
            denomination: true,
            diocese: true,
            country: true,
          },
        },
      },
    });

    return res.status(200).json(contacts);
  } catch (err) {
    console.error("❌ GET /church-contacts error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch church contacts",
    });
  }
});

// Admin route: list all church contacts, including archived/inactive contacts
app.get("/church-contacts/all", requireAdminToken, async (req, res) => {
  try {
    const contacts = await prisma.churchContact.findMany({
      orderBy: {
        fullName: "asc",
      },
      include: {
        church: {
          select: {
            id: true,
            name: true,
            denomination: true,
            diocese: true,
            country: true,
          },
        },
      },
    });

    return res.status(200).json(contacts);
  } catch (err) {
    console.error("❌ GET /church-contacts/all error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch all church contacts",
    });
  }
});

// API compatibility route: list all church contacts, including archived/inactive contacts
app.get("/api/church-contacts/all", requireAdminToken, async (req, res) => {
  try {
    const contacts = await prisma.churchContact.findMany({
      orderBy: {
        fullName: "asc",
      },
      include: {
        church: {
          select: {
            id: true,
            name: true,
            denomination: true,
            diocese: true,
            country: true,
          },
        },
      },
    });

    return res.status(200).json(contacts);
  } catch (err) {
    console.error("❌ GET /api/church-contacts/all error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch all church contacts",
    });
  }
});

app.get("/churches/:id/contacts", requireAdminToken, async (req, res) => {
  try {
    const { id } = req.params;

    const contacts = await prisma.churchContact.findMany({
      where: {
        churchId: id,
        canReceiveRecordings: true,
      },
      orderBy: {
        fullName: "asc",
      },
      include: {
        church: {
          select: {
            id: true,
            name: true,
            denomination: true,
            diocese: true,
            country: true,
          },
        },
      },
    });

    return res.status(200).json(contacts);
  } catch (err) {
    console.error("❌ GET /churches/:id/contacts error:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch church contacts for this church",
    });
  }
});

// Admin route: create a church
app.post("/churches", requireAdminToken, async (req, res) => {
  try {
    const {
      name,
      denomination,
      diocese,
      country,
      websiteUrl,
      notes,
    } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({
        success: false,
        error: "Church name is required",
      });
    }

    const church = await prisma.church.create({
      data: {
        name: String(name).trim(),
        denomination: denomination ? String(denomination).trim() : null,
        diocese: diocese ? String(diocese).trim() : null,
        country: country ? String(country).trim() : "USA",
        websiteUrl: websiteUrl ? String(websiteUrl).trim() : null,
        notes: notes ? String(notes).trim() : null,
      },
    });

    return res.status(201).json(church);
  } catch (err) {
    console.error("❌ POST /churches error:", err);
    return res.status(500).json({
      success: false,
      error: String(err),
    });
  }
});

// Admin route: update a church
app.put("/churches/:id", requireAdminToken, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      denomination,
      diocese,
      country,
      websiteUrl,
      notes,
    } = req.body || {};

    const existingChurch = await prisma.church.findUnique({
      where: { id: String(id) },
    });

    if (!existingChurch) {
      return res.status(404).json({
        success: false,
        error: "Church not found",
      });
    }

    if (name !== undefined && !String(name).trim()) {
      return res.status(400).json({
        success: false,
        error: "Church name is required",
      });
    }

    const updateData = {};

    if (name !== undefined) updateData.name = String(name).trim();
    if (denomination !== undefined) updateData.denomination = denomination ? String(denomination).trim() : null;
    if (diocese !== undefined) updateData.diocese = diocese ? String(diocese).trim() : null;
    if (country !== undefined) updateData.country = country ? String(country).trim() : "USA";
    if (websiteUrl !== undefined) updateData.websiteUrl = websiteUrl ? String(websiteUrl).trim() : null;
    if (notes !== undefined) updateData.notes = notes ? String(notes).trim() : null;

    const updatedChurch = await prisma.church.update({
      where: { id: String(id) },
      data: updateData,
    });

    return res.status(200).json(updatedChurch);
  } catch (err) {
    console.error("❌ PUT /churches/:id error:", err);
    return res.status(500).json({
      success: false,
      error: String(err),
    });
  }
});

// Admin route: create a church contact
app.post("/church-contacts", requireAdminToken, async (req, res) => {
  try {
    const {
      churchId,
      fullName,
      email,
      phone,
      roleTitle,
      isPrimary,
      canReceiveRecordings,
    } = req.body || {};

    if (!churchId || !String(churchId).trim()) {
      return res.status(400).json({
        success: false,
        error: "Church ID is required",
      });
    }

    if (!fullName || !String(fullName).trim()) {
      return res.status(400).json({
        success: false,
        error: "Full name is required",
      });
    }

    const church = await prisma.church.findUnique({
      where: { id: String(churchId).trim() },
    });

    if (!church) {
      return res.status(404).json({
        success: false,
        error: "Church not found",
      });
    }

    const contact = await prisma.churchContact.create({
      data: {
        churchId: String(churchId).trim(),
        fullName: String(fullName).trim(),
        email: email ? String(email).trim() : null,
        phone: phone ? String(phone).trim() : null,
        roleTitle: roleTitle ? String(roleTitle).trim() : null,
        isPrimary: Boolean(isPrimary),
        canReceiveRecordings: canReceiveRecordings !== false,
      },
      include: {
        church: true,
      },
    });

    return res.status(201).json(contact);
  } catch (err) {
    console.error("❌ POST /church-contacts error:", err);
    return res.status(500).json({
      success: false,
      error: String(err),
    });
  }
});

// Admin route: update a church contact
app.put("/church-contacts/:id", requireAdminToken, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      churchId,
      fullName,
      email,
      phone,
      roleTitle,
      isPrimary,
      canReceiveRecordings,
    } = req.body || {};

    const existingContact = await prisma.churchContact.findUnique({
      where: { id: String(id) },
    });

    if (!existingContact) {
      return res.status(404).json({
        success: false,
        error: "Contact not found",
      });
    }

    if (fullName !== undefined && !String(fullName).trim()) {
      return res.status(400).json({
        success: false,
        error: "Full name is required",
      });
    }

    if (churchId !== undefined) {
      if (!String(churchId).trim()) {
        return res.status(400).json({
          success: false,
          error: "Church ID is required",
        });
      }

      const church = await prisma.church.findUnique({
        where: { id: String(churchId).trim() },
      });

      if (!church) {
        return res.status(404).json({
          success: false,
          error: "Church not found",
        });
      }
    }

    const updateData = {};

    if (churchId !== undefined) updateData.churchId = String(churchId).trim();
    if (fullName !== undefined) updateData.fullName = String(fullName).trim();
    if (email !== undefined) updateData.email = email ? String(email).trim() : null;
    if (phone !== undefined) updateData.phone = phone ? String(phone).trim() : null;
    if (roleTitle !== undefined) updateData.roleTitle = roleTitle ? String(roleTitle).trim() : null;
    if (isPrimary !== undefined) updateData.isPrimary = Boolean(isPrimary);
    if (canReceiveRecordings !== undefined) updateData.canReceiveRecordings = canReceiveRecordings !== false;

    const updatedContact = await prisma.churchContact.update({
      where: { id: String(id) },
      data: updateData,
      include: {
        church: true,
      },
    });

    return res.status(200).json(updatedContact);
  } catch (err) {
    console.error("❌ PUT /church-contacts/:id error:", err);
    return res.status(500).json({
      success: false,
      error: String(err),
    });
  }
});

   // Admin route: archive a church contact without deleting it
app.post("/church-contacts/:id/archive", requireAdminToken, async (req, res) => {
  try {
    const { id } = req.params;

    const contact = await prisma.churchContact.update({
      where: { id: String(id) },
      data: {
        canReceiveRecordings: false,
      },
      include: {
        church: true,
      },
    });

    return res.status(200).json({
      success: true,
      contact,
    });
  } catch (err) {
    console.error("❌ POST /church-contacts/:id/archive error:", err);
    return res.status(500).json({
      success: false,
      error: String(err),
    });
  }
});

// API compatibility route: archive a church contact without deleting it
app.post("/api/church-contacts/:id/archive", requireAdminToken, async (req, res) => {
  try {
    const { id } = req.params;

    const contact = await prisma.churchContact.update({
      where: { id: String(id) },
      data: {
        canReceiveRecordings: false,
      },
      include: {
        church: true,
      },
    });

    return res.status(200).json({
      success: true,
      contact,
    });
  } catch (err) {
    console.error("❌ POST /api/church-contacts/:id/archive error:", err);
    return res.status(500).json({
      success: false,
      error: String(err),
    });
  }
});

// Admin route: restore an archived church contact
app.post("/church-contacts/:id/restore", requireAdminToken, async (req, res) => {
  try {
    const { id } = req.params;

    const contact = await prisma.churchContact.update({
      where: { id: String(id) },
      data: {
        canReceiveRecordings: true,
      },
      include: {
        church: true,
      },
    });

    return res.status(200).json({
      success: true,
      contact,
    });
  } catch (err) {
    console.error("❌ POST /church-contacts/:id/restore error:", err);
    return res.status(500).json({
      success: false,
      error: String(err),
    });
  }
});

// API compatibility route: restore an archived church contact
app.post("/api/church-contacts/:id/restore", requireAdminToken, async (req, res) => {
  try {
    const { id } = req.params;

    const contact = await prisma.churchContact.update({
      where: { id: String(id) },
      data: {
        canReceiveRecordings: true,
      },
      include: {
        church: true,
      },
    });

    return res.status(200).json({
      success: true,
      contact,
    });
  } catch (err) {
    console.error("❌ POST /api/church-contacts/:id/restore error:", err);
    return res.status(500).json({
      success: false,
      error: String(err),
    });
  }
});

// ============================================================
// Pastor / Church Contact Zoom connection invitation
// This does not alter the existing interview-scheduling routes.
// ============================================================

app.post(
  "/api/church-contacts/:id/zoom-invitation",
  requireAdminToken,
  async (req, res) => {
    try {
      const churchContactId = String(req.params.id || "").trim();

      if (!churchContactId) {
        return res.status(400).json({
          success: false,
          error: "A church contact ID is required",
        });
      }

      const churchContact = await prisma.churchContact.findUnique({
        where: {
          id: churchContactId,
        },
        include: {
          church: true,
        },
      });

      if (!churchContact) {
        return res.status(404).json({
          success: false,
          error: "Church contact not found",
        });
      }

      /*
       * Remove unused invitations previously created for this contact.
       * A new invitation will replace them.
       */
      await prisma.zoomOAuthInvitation.deleteMany({
        where: {
          churchContactId,
          usedAt: null,
        },
      });

      const invitationToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = hashZoomOAuthToken(invitationToken);

      // Invitation remains valid for seven days.
      const expiresAt = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000
      );

      await prisma.zoomOAuthInvitation.create({
        data: {
          churchContactId,
          tokenHash,
          expiresAt,
        },
      });

      const publicBaseUrl = String(
        process.env.PUBLIC_BASE_URL || ""
      ).replace(/\/+$/, "");

      if (!publicBaseUrl) {
        throw new Error("PUBLIC_BASE_URL is not configured");
      }

      const connectionUrl =
        `${publicBaseUrl}/zoom/church-contact/connect` +
        `?token=${encodeURIComponent(invitationToken)}`;

      return res.status(201).json({
        success: true,
        message: "Zoom connection invitation created",
        churchContact: {
          id: churchContact.id,
          fullName: churchContact.fullName,
          email: churchContact.email,
          churchName: churchContact.church?.name || null,
        },
        connectionUrl,
        expiresAt,
      });
    } catch (err) {
      console.error(
        "❌ POST /api/church-contacts/:id/zoom-invitation error:",
        err
      );

      return res.status(500).json({
        success: false,
        error: String(err?.message || err),
      });
    }
  }
);

// =====================================================
// Guest Distribution Campaigns
// Court assigns a finalized recording to the guest leader
// =====================================================
app.post(
  "/api/guest-distribution-campaigns",
  requireAdminToken,
  async (req, res) => {
    try {
      const {
        recordingId,
        guestName,
        guestEmail,
        organizationName,
        expiresInDays = 30,
      } = req.body || {};

      if (!recordingId || !guestName || !guestEmail) {
        return res.status(400).json({
          success: false,
          error:
            "recordingId, guestName, and guestEmail are required",
        });
      }

      const recording = await prisma.recording.findUnique({
        where: {
          id: String(recordingId),
        },
      });

      if (!recording) {
        return res.status(404).json({
          success: false,
          error: "Recording not found",
        });
      }

      if (recording.status !== "READY") {
        return res.status(400).json({
          success: false,
          error:
            "The recording must have READY status before it can be assigned to a guest",
        });
      }

      if (!recording.recordingUrl) {
        return res.status(400).json({
          success: false,
          error:
            "The recording does not yet have a playback URL",
        });
      }

      const requestedDays = Number(expiresInDays);
      const validDays =
        Number.isFinite(requestedDays) && requestedDays > 0
          ? Math.min(Math.floor(requestedDays), 365)
          : 30;

      const expiresAt = new Date(
        Date.now() + validDays * 24 * 60 * 60 * 1000
      );

      const distributionToken = crypto
        .randomBytes(32)
        .toString("hex");

      const campaign =
        await prisma.guestDistributionCampaign.create({
          data: {
            recordingId: String(recordingId),
            guestName: String(guestName).trim(),
            guestEmail: String(guestEmail).trim().toLowerCase(),
            organizationName: organizationName
              ? String(organizationName).trim()
              : null,
            distributionToken,
            status: "DRAFT",
            expiresAt,
          },
          include: {
            recording: true,
          },
        });

      return res.status(201).json({
        success: true,
        campaign,
      });
    } catch (err) {
      console.error(
        "❌ POST /api/guest-distribution-campaigns error:",
        err
      );

      return res.status(500).json({
        success: false,
        error: String(err),
      });
    }
  }
);

// =====================================================
// Send finalized recording invitation to the guest leader
// =====================================================
app.post(
  "/api/guest-distribution-campaigns/:id/send-to-guest",
  requireAdminToken,
  async (req, res) => {
    try {
      const campaignId = String(req.params.id);

      const campaign =
        await prisma.guestDistributionCampaign.findUnique({
          where: {
            id: campaignId,
          },
          include: {
            recording: true,
          },
        });

      if (!campaign) {
        return res.status(404).json({
          success: false,
          error: "Guest distribution campaign not found",
        });
      }

      if (campaign.status === "CLOSED") {
        return res.status(400).json({
          success: false,
          error: "This guest distribution campaign is closed",
        });
      }

      if (
        campaign.expiresAt &&
        campaign.expiresAt.getTime() <= Date.now()
      ) {
        return res.status(400).json({
          success: false,
          error: "This guest distribution campaign has expired",
        });
      }

      if (!campaign.recording) {
        return res.status(404).json({
          success: false,
          error: "The recording connected to this campaign was not found",
        });
      }

      if (campaign.recording.status !== "READY") {
        return res.status(400).json({
          success: false,
          error:
            "The recording must have READY status before it can be sent",
        });
      }

      if (!campaign.recording.recordingUrl) {
        return res.status(400).json({
          success: false,
          error: "The recording does not have a playback URL",
        });
      }

      const backendBaseUrl =
        process.env.BACKEND_PUBLIC_URL ||
        `${req.protocol}://${req.get("host")}`;

      const pastorInvitationUrl =
        `${backendBaseUrl}/guest-distribution/` +
        encodeURIComponent(campaign.distributionToken);

      const recordingTitle =
        campaign.recording.title ||
        "Court of Compassion Interview Recording";

      const organizationLine = campaign.organizationName
        ? `\nOrganization: ${campaign.organizationName}`
        : "";

      const subject =
        `Court of Compassion — Finalized Interview Recording: ` +
        recordingTitle;

      const plainTextBody = `Dear ${campaign.guestName},

The Court of Compassion has finalized your interview recording.

Recording:
${recordingTitle}

Watch the recording:
${campaign.recording.recordingUrl}
${organizationLine}

You may invite pastors, priests, or other church leaders within your diocese or church group to view the recording and request a Court Study session based on the interview.

Pastor invitation and Court Study request link:
${pastorInvitationUrl}

You may forward that invitation link to the appropriate church leaders. The Court does not require your private pastor email list.

The invitation link is unique to this recording and guest distribution campaign.

Respectfully,

Court of Compassion`;

      const htmlBody = `
        <p>Dear ${campaign.guestName},</p>

        <p>
          The Court of Compassion has finalized your interview recording.
        </p>

        <p>
          <strong>Recording:</strong><br>
          ${recordingTitle}
        </p>

        <p>
          <a href="${campaign.recording.recordingUrl}">
            Watch the finalized interview recording
          </a>
        </p>

        ${
          campaign.organizationName
            ? `<p><strong>Organization:</strong> ${campaign.organizationName}</p>`
            : ""
        }

        <p>
          You may invite pastors, priests, or other church leaders within
          your diocese or church group to view the recording and request a
          Court Study session based on the interview.
        </p>

        <p>
          <a href="${pastorInvitationUrl}">
            Open the pastor invitation and Court Study request page
          </a>
        </p>

        <p>
          You may forward that invitation link to the appropriate church
          leaders. The Court does not require your private pastor email list.
        </p>

        <p>
          The invitation link is unique to this recording and guest
          distribution campaign.
        </p>

        <p>
          Respectfully,<br>
          <strong>Court of Compassion</strong>
        </p>
      `;

      await sendEmail(
        campaign.guestEmail,
        subject,
        plainTextBody,
        htmlBody
      );

      const updatedCampaign =
        await prisma.guestDistributionCampaign.update({
          where: {
            id: campaignId,
          },
          data: {
            status: "SENT_TO_GUEST",
            sentAt: new Date(),
          },
          include: {
            recording: true,
          },
        });

      return res.status(200).json({
        success: true,
        message: "Guest recording invitation sent successfully",
        campaign: updatedCampaign,
      });
    } catch (err) {
      console.error(
        "❌ POST /api/guest-distribution-campaigns/:id/send-to-guest error:",
        err
      );

      return res.status(500).json({
        success: false,
        error: String(err),
      });
    }
  }
);

// =====================================================
// Public guest distribution page
// Guest leader forwards this page to pastors or priests
// =====================================================
app.get("/guest-distribution/:token", async (req, res) => {
  try {
    const distributionToken = String(req.params.token || "").trim();

    if (!distributionToken) {
      return res.status(400).send("Missing distribution token");
    }

    const campaign =
      await prisma.guestDistributionCampaign.findUnique({
        where: {
          distributionToken,
        },
        include: {
          recording: true,
        },
      });

    if (!campaign) {
      return res.status(404).send(
        "This Court of Compassion invitation could not be found."
      );
    }

    if (campaign.status === "CLOSED") {
      return res.status(410).send(
        "This Court of Compassion invitation is closed."
      );
    }

    if (
      campaign.expiresAt &&
      campaign.expiresAt.getTime() <= Date.now()
    ) {
      return res.status(410).send(
        "This Court of Compassion invitation has expired."
      );
    }

    if (!campaign.recording) {
      return res.status(404).send(
        "The interview recording connected to this invitation could not be found."
      );
    }

    if (!campaign.recording.recordingUrl) {
      return res.status(404).send(
        "The interview recording is not yet available."
      );
    }

    if (campaign.status === "SENT_TO_GUEST") {
      await prisma.guestDistributionCampaign.update({
        where: {
          id: campaign.id,
        },
        data: {
          status: "ACTIVE",
        },
      });
    }

    const escapeHtml = (value) =>
      String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");

    const safeWebUrl = (value) => {
      try {
        const parsedUrl = new URL(String(value));

        if (
          parsedUrl.protocol !== "https:" &&
          parsedUrl.protocol !== "http:"
        ) {
          return "#";
        }

        return escapeHtml(parsedUrl.toString());
      } catch {
        return "#";
      }
    };

    const recordingTitle = escapeHtml(
      campaign.recording.title ||
        "Court of Compassion Interview Recording"
    );

    const guestName = escapeHtml(campaign.guestName);

    const organizationName = campaign.organizationName
      ? escapeHtml(campaign.organizationName)
      : "";

    const speakerName = campaign.recording.speakerName
      ? escapeHtml(campaign.recording.speakerName)
      : guestName;

    const recordingUrl = safeWebUrl(
      campaign.recording.recordingUrl
    );

    const recordingPasscode =
      campaign.recording.recordingPasscode
        ? escapeHtml(campaign.recording.recordingPasscode)
        : "";

    const formAction =
      `/guest-distribution/` +
      encodeURIComponent(distributionToken) +
      `/court-study-requests`;

    return res.status(200).type("html").send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  >
  <title>${recordingTitle} — Court of Compassion</title>

  <style>
    body {
      margin: 0;
      background: #071b33;
      color: #f7f2e8;
      font-family: Arial, Helvetica, sans-serif;
      line-height: 1.6;
    }

    main {
      width: min(900px, calc(100% - 32px));
      margin: 32px auto;
    }

    .card {
      background: #102b4c;
      border: 1px solid #c8a85a;
      border-radius: 14px;
      padding: 24px;
      margin-bottom: 24px;
    }

    h1, h2 {
      color: #e4c778;
      margin-top: 0;
    }

    a.button,
    button {
      display: inline-block;
      background: #d6b65f;
      color: #071b33;
      border: 0;
      border-radius: 8px;
      padding: 12px 18px;
      font-weight: bold;
      text-decoration: none;
      cursor: pointer;
    }

    label {
      display: block;
      margin-top: 14px;
      font-weight: bold;
    }

    input,
    select,
    textarea {
      box-sizing: border-box;
      width: 100%;
      margin-top: 5px;
      padding: 11px;
      border: 1px solid #b7c3d0;
      border-radius: 7px;
      font: inherit;
    }

    textarea {
      min-height: 110px;
      resize: vertical;
    }

    .note {
      color: #d9e2eb;
      font-size: 0.95rem;
    }
  </style>
</head>

<body>
  <main>
    <section class="card">
      <h1>Court of Compassion Interview</h1>

      <p>
        You have been invited by
        <strong>${guestName}</strong>
        ${
          organizationName
            ? `of <strong>${organizationName}</strong>`
            : ""
        }
        to view this finalized interview recording.
      </p>

      <h2>${recordingTitle}</h2>

      <p>
        <strong>Guest:</strong> ${speakerName}
      </p>

      <p>
        <a
          class="button"
          href="${recordingUrl}"
          target="_blank"
          rel="noopener noreferrer"
        >
          Watch the Interview Recording
        </a>
      </p>

      ${
        recordingPasscode
          ? `
            <p>
              <strong>Recording passcode:</strong>
              ${recordingPasscode}
            </p>
          `
          : ""
      }
    </section>

    <section class="card">
      <h2>Request a Court Study Session</h2>

      <p>
        A pastor, priest, or church leader may request a
        Court Study session centered on this recorded interview.
      </p>

      <p>
        The session may be hosted by the Court, hosted by the
        church leader, conducted in person, or arranged as a
        hybrid meeting.
      </p>

      <form method="post" action="${formAction}">
        <label for="pastorName">Pastor or church leader name</label>
        <input
          id="pastorName"
          name="pastorName"
          type="text"
          required
        >

        <label for="pastorEmail">Email address</label>
        <input
          id="pastorEmail"
          name="pastorEmail"
          type="email"
          required
        >

        <label for="roleTitle">Role or title</label>
        <input
          id="roleTitle"
          name="roleTitle"
          type="text"
          placeholder="Pastor, priest, bishop, ministry leader"
        >

        <label for="churchName">Church name</label>
        <input
          id="churchName"
          name="churchName"
          type="text"
          required
        >

        <label for="dioceseOrGroup">Diocese or church group</label>
        <input
          id="dioceseOrGroup"
          name="dioceseOrGroup"
          type="text"
        >

        <label for="phone">Telephone number</label>
        <input
          id="phone"
          name="phone"
          type="tel"
        >

        <label for="preferredStart">
          Preferred date and time
        </label>
        <input
          id="preferredStart"
          name="preferredStart"
          type="datetime-local"
        >

        <label for="timezone">Time zone</label>
        <input
          id="timezone"
          name="timezone"
          type="text"
          placeholder="America/Los_Angeles"
        >

        <label for="meetingFormat">Preferred meeting format</label>
        <select id="meetingFormat" name="meetingFormat">
          <option value="">Select one</option>
          <option value="COURT_HOSTED">
            Court-hosted online session
          </option>
          <option value="PASTOR_HOSTED">
            Pastor-hosted online session
          </option>
          <option value="IN_PERSON">
            In-person church session
          </option>
          <option value="HYBRID">
            Hybrid session
          </option>
        </select>

        <label for="estimatedAttendance">
          Estimated attendance
        </label>
        <input
          id="estimatedAttendance"
          name="estimatedAttendance"
          type="number"
          min="1"
        >

        <label for="notes">
          Additional information or requested discussion focus
        </label>
        <textarea id="notes" name="notes"></textarea>

        <p class="note">
          Submitting this form is a request. The Court of Compassion
          will review the request before confirming or scheduling a
          Court Study session.
        </p>

        <button type="submit">
          Submit Court Study Request
        </button>
      </form>
    </section>
  </main>
</body>
</html>
    `);
  } catch (err) {
    console.error(
      "❌ GET /guest-distribution/:token error:",
      err
    );

    return res.status(500).send(
      "The Court of Compassion invitation page could not be loaded."
    );
  }
});

// =====================================================
// Submit a Court Study request from the public invitation
// =====================================================
app.post(
  "/guest-distribution/:token/court-study-requests",
  express.urlencoded({ extended: false }),
  async (req, res) => {
    try {
      const distributionToken = String(req.params.token || "").trim();

      if (!distributionToken) {
        return res.status(400).send("Missing distribution token");
      }

      const campaign =
        await prisma.guestDistributionCampaign.findUnique({
          where: {
            distributionToken,
          },
          include: {
            recording: true,
          },
        });

      if (!campaign) {
        return res.status(404).send(
          "This Court of Compassion invitation could not be found."
        );
      }

      if (campaign.status === "CLOSED") {
        return res.status(410).send(
          "This Court of Compassion invitation is closed."
        );
      }

      if (
        campaign.expiresAt &&
        campaign.expiresAt.getTime() <= Date.now()
      ) {
        return res.status(410).send(
          "This Court of Compassion invitation has expired."
        );
      }

      if (!campaign.recording) {
        return res.status(404).send(
          "The recording connected to this invitation could not be found."
        );
      }

      const {
        pastorName,
        pastorEmail,
        roleTitle,
        churchName,
        dioceseOrGroup,
        phone,
        preferredStart,
        timezone,
        meetingFormat,
        estimatedAttendance,
        notes,
      } = req.body || {};

      if (!pastorName || !pastorEmail || !churchName) {
        return res.status(400).send(
          "Pastor name, email address, and church name are required."
        );
      }

      const normalizedEmail = String(pastorEmail)
        .trim()
        .toLowerCase();

      const basicEmailPattern =
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      if (!basicEmailPattern.test(normalizedEmail)) {
        return res.status(400).send(
          "Please enter a valid email address."
        );
      }

      const allowedMeetingFormats = new Set([
        "COURT_HOSTED",
        "PASTOR_HOSTED",
        "IN_PERSON",
        "HYBRID",
      ]);

      const normalizedMeetingFormat =
        meetingFormat &&
        allowedMeetingFormats.has(String(meetingFormat))
          ? String(meetingFormat)
          : null;

      let parsedPreferredStart = null;

      if (preferredStart) {
        const dateValue = new Date(String(preferredStart));

        if (Number.isNaN(dateValue.getTime())) {
          return res.status(400).send(
            "The preferred date and time are invalid."
          );
        }

        parsedPreferredStart = dateValue;
      }

      let parsedEstimatedAttendance = null;

      if (
        estimatedAttendance !== undefined &&
        estimatedAttendance !== null &&
        String(estimatedAttendance).trim() !== ""
      ) {
        const attendanceValue = Number(estimatedAttendance);

        if (
          !Number.isInteger(attendanceValue) ||
          attendanceValue < 1
        ) {
          return res.status(400).send(
            "Estimated attendance must be a whole number greater than zero."
          );
        }

        parsedEstimatedAttendance = attendanceValue;
      }

      const request =
        await prisma.courtStudyRequest.create({
          data: {
            campaignId: campaign.id,
            recordingId: campaign.recordingId,
            pastorName: String(pastorName).trim(),
            pastorEmail: normalizedEmail,
            roleTitle: roleTitle
              ? String(roleTitle).trim()
              : null,
            churchName: String(churchName).trim(),
            dioceseOrGroup: dioceseOrGroup
              ? String(dioceseOrGroup).trim()
              : null,
            phone: phone
              ? String(phone).trim()
              : null,
            preferredStart: parsedPreferredStart,
            timezone: timezone
              ? String(timezone).trim()
              : null,
            meetingFormat: normalizedMeetingFormat,
            estimatedAttendance:
              parsedEstimatedAttendance,
            notes: notes
              ? String(notes).trim()
              : null,
            status: "PENDING",
          },
        });

      const escapeHtml = (value) =>
        String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#039;");

      const safePastorName = escapeHtml(request.pastorName);
      const safeChurchName = escapeHtml(request.churchName);
      const safeRecordingTitle = escapeHtml(
        campaign.recording.title ||
          "Court of Compassion Interview Recording"
      );

      return res.status(201).type("html").send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  >
  <title>Court Study Request Received</title>

  <style>
    body {
      margin: 0;
      background: #071b33;
      color: #f7f2e8;
      font-family: Arial, Helvetica, sans-serif;
      line-height: 1.6;
    }

    main {
      width: min(720px, calc(100% - 32px));
      margin: 48px auto;
    }

    .card {
      background: #102b4c;
      border: 1px solid #c8a85a;
      border-radius: 14px;
      padding: 28px;
    }

    h1 {
      color: #e4c778;
      margin-top: 0;
    }

    .reference {
      background: #071b33;
      border-radius: 8px;
      padding: 12px;
      word-break: break-word;
    }
  </style>
</head>

<body>
  <main>
    <section class="card">
      <h1>Court Study Request Received</h1>

      <p>Dear ${safePastorName},</p>

      <p>
        The Court of Compassion has received the Court Study
        request submitted on behalf of
        <strong>${safeChurchName}</strong>.
      </p>

      <p>
        The request concerns the following interview recording:
      </p>

      <p>
        <strong>${safeRecordingTitle}</strong>
      </p>

      <p>
        The request is currently marked
        <strong>PENDING</strong>. The Court will review it before
        approving, declining, or scheduling the session.
      </p>

      <p class="reference">
        Request reference: ${escapeHtml(request.id)}
      </p>

      <p>
        Please retain this reference for future communication.
      </p>

      <p>
        Respectfully,<br>
        <strong>Court of Compassion</strong>
      </p>
    </section>
  </main>
</body>
</html>
      `);
    } catch (err) {
      console.error(
        "❌ POST /guest-distribution/:token/court-study-requests error:",
        err
      );

      return res.status(500).send(
        "The Court Study request could not be submitted."
      );
    }
  }
);

// =====================================================
// Admin: list Court Study requests
// =====================================================
app.get(
  "/api/court-study-requests",
  requireAdminToken,
  async (req, res) => {
    try {
      const requestedStatus = req.query.status
        ? String(req.query.status).trim().toUpperCase()
        : null;

      const allowedStatuses = new Set([
        "PENDING",
        "APPROVED",
        "DECLINED",
        "SCHEDULED",
        "COMPLETED",
        "CANCELLED",
      ]);

      if (
        requestedStatus &&
        !allowedStatuses.has(requestedStatus)
      ) {
        return res.status(400).json({
          success: false,
          error: "Invalid Court Study request status",
        });
      }

      const requests =
        await prisma.courtStudyRequest.findMany({
          where: requestedStatus
            ? {
                status: requestedStatus,
              }
            : undefined,

          include: {
            recording: {
              select: {
                id: true,
                title: true,
                speakerName: true,
                organizationName: true,
                recordingUrl: true,
                status: true,
              },
            },

            campaign: {
              select: {
                id: true,
                guestName: true,
                guestEmail: true,
                organizationName: true,
                status: true,
                sentAt: true,
                expiresAt: true,
              },
            },
          },

          orderBy: {
            createdAt: "desc",
          },
        });

      return res.status(200).json({
        success: true,
        count: requests.length,
        requests,
      });
    } catch (err) {
      console.error(
        "❌ GET /api/court-study-requests error:",
        err
      );

      return res.status(500).json({
        success: false,
        error: String(err),
      });
    }
  }
);

   app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
