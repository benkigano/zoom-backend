import "dotenv/config";
import express from "express";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import cors from "cors";
import nodemailer from "nodemailer";
import crypto from "crypto";
import { prisma } from "./prisma/client.js";
import escapeHtml from "escape-html";

const ADMIN_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

function createAdminSessionToken() {
  const sessionSecret = process.env.ADMIN_SESSION_SECRET;

  if (!sessionSecret) {
    throw new Error("ADMIN_SESSION_SECRET is not configured");
  }

  const payload = Buffer.from(
    JSON.stringify({
      exp: Date.now() + ADMIN_SESSION_TTL_MS,
      nonce: crypto.randomBytes(16).toString("hex"),
    })
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", sessionSecret)
    .update(payload)
    .digest("hex");

  return `${payload}.${signature}`;
}

function verifyAdminSessionToken(token) {
  const sessionSecret = process.env.ADMIN_SESSION_SECRET;

  if (!sessionSecret || !token) {
    return false;
  }

  try {
    const [payload, providedSignature] = String(token).split(".");

    if (!payload || !providedSignature) {
      return false;
    }

    const expectedSignature = crypto
      .createHmac("sha256", sessionSecret)
      .update(payload)
      .digest("hex");

    const providedBuffer = Buffer.from(providedSignature, "hex");
    const expectedBuffer = Buffer.from(expectedSignature, "hex");

    if (
      providedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
    ) {
      return false;
    }

    const sessionData = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );

    return (
      Number.isFinite(sessionData.exp) &&
      sessionData.exp > Date.now()
    );
  } catch {
    return false;
  }
}

function requireAdminToken(req, res, next) {
  const cookieHeader = String(req.headers.cookie || "");

  const sessionCookie = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("court_admin_session="));

  const sessionToken = sessionCookie
    ? decodeURIComponent(
        sessionCookie.slice("court_admin_session=".length)
      )
    : "";

  // Preferred method: short-lived HttpOnly admin session cookie
  if (sessionToken && verifyAdminSessionToken(sessionToken)) {
    return next();
  }

  // Backward-compatible fallback: existing permanent x-admin-token header
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

async function queryWixCollection(collectionId) {
  const apiKey = process.env.WIX_API_KEY;
  const siteId = process.env.WIX_SITE_ID;

  if (!apiKey || !siteId) {
    throw new Error("WIX_API_KEY or WIX_SITE_ID is not configured");
  }

  const response = await fetch(
    "https://www.wixapis.com/wix-data/v2/items/query",
    {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "wix-site-id": siteId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        dataCollectionId: collectionId,
        query: {
          paging: {
            limit: 1000,
            offset: 0,
          },
        },
        consistentRead: true,
      }),
    }
  );

  const responseText = await response.text();

  let result;
  try {
    result = responseText ? JSON.parse(responseText) : {};
  } catch {
    result = {};
  }

  if (!response.ok) {
    console.error(
      `Wix Data query failed for ${collectionId}:`,
      response.status,
      responseText
    );

    throw new Error(
      `Wix Data query failed for ${collectionId} (${response.status})`
    );
  }

  return (result.dataItems || []).map((item) => ({
    ...(item.data || {}),
    _id: item.data?._id || item.id,
  }));
}

const app = express();

const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => {
    const forwardedFor = req.headers["x-forwarded-for"];
    const forwardedValue = Array.isArray(forwardedFor)
      ? forwardedFor[0]
      : forwardedFor;

    const clientIp =
      String(forwardedValue || "")
        .split(",")[0]
        .trim() || req.ip;

    return ipKeyGenerator(clientIp);
  },
  skip: (req) =>
  req.method === "OPTIONS" ||
  req.path === "/" ||
  req.path === "/health" ||
  req.path === "/api/health",
  message: {
    success: false,
    error: "Too many requests. Please try again later.",
  },
});



const allowedCorsOrigins = [
  "https://courtofcompassion.com",
  "https://www.courtofcompassion.com",
];

app.use(cors({
  origin(origin, callback) {
    // Allow requests with no origin (e.g. server-to-server, curl)
    if (!origin) return callback(null, true);

    // Allow the two exact Court of Compassion hostnames
    if (allowedCorsOrigins.includes(origin)) return callback(null, true);

   // Allow HTTPS Wix Vibe preview hostnames
    try {
      const parsed = new URL(origin);
      const isHttps = parsed.protocol === "https:";
      const hostname = parsed.hostname.toLowerCase();
      const isWixVibe =
  isHttps &&
  (hostname.endsWith(".wix-vibe.com") ||
    hostname.endsWith(".wix-vibe-site.com"));

      if (isWixVibe) return callback(null, true);
    } catch (err) {
      // Invalid origin falls through to rejection
    }

    return callback(new Error("Not allowed by CORS"));
  },

  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],

  allowedHeaders: ["Content-Type", "Authorization", "x-admin-token"],

  credentials: true,
}));

app.use(apiRateLimiter);

function parseDateTimeInTimeZone(value, timeZone) {
  const dateTimeText = String(value || "").trim();
  const zone = String(timeZone || "").trim();

  if (!dateTimeText || !zone) {
    return new Date(NaN);
  }

  // Respect values that already contain UTC or an explicit offset.
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(dateTimeText)) {
    return new Date(dateTimeText);
  }

  const match = dateTimeText.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
  );

  if (!match) {
    return new Date(NaN);
  }

  const desired = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] || 0),
  };

  let formatter;

  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return new Date(NaN);
  }

  const getZonedParts = (date) => {
    const parts = {};

    for (const part of formatter.formatToParts(date)) {
      if (part.type !== "literal") {
        parts[part.type] = Number(part.value);
      }
    }

    return parts;
  };

  const desiredAsUtc = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute,
    desired.second
  );

  let utcMilliseconds = desiredAsUtc;

  // Adjust until the selected timezone renders the requested local time.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rendered = getZonedParts(new Date(utcMilliseconds));

    const renderedAsUtc = Date.UTC(
      rendered.year,
      rendered.month - 1,
      rendered.day,
      rendered.hour,
      rendered.minute,
      rendered.second
    );

    const adjustment = desiredAsUtc - renderedAsUtc;
    utcMilliseconds += adjustment;

    if (adjustment === 0) {
      break;
    }
  }

  const result = new Date(utcMilliseconds);
  const finalParts = getZonedParts(result);

  const matchesRequestedTime =
    finalParts.year === desired.year &&
    finalParts.month === desired.month &&
    finalParts.day === desired.day &&
    finalParts.hour === desired.hour &&
    finalParts.minute === desired.minute &&
    finalParts.second === desired.second;

  return matchesRequestedTime ? result : new Date(NaN);
}

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

async function getCourtStudyHostZoomAccessToken({
  churchContactId = null,
  organizerEmail = null,
} = {}) {
  const normalizedChurchContactId = churchContactId
    ? String(churchContactId).trim()
    : "";

  const normalizedOrganizerEmail = organizerEmail
    ? String(organizerEmail).trim().toLowerCase()
    : "";

  if (!normalizedChurchContactId && !normalizedOrganizerEmail) {
    throw new Error(
      "A church contact ID or organizer email is required"
    );
  }

  if (normalizedChurchContactId && normalizedOrganizerEmail) {
    throw new Error(
      "Use either a church contact ID or organizer email, not both"
    );
  }

  const connectionWhere = normalizedChurchContactId
    ? {
        churchContactId: normalizedChurchContactId,
      }
    : {
        organizerEmail: normalizedOrganizerEmail,
      };

  const connection =
    await prisma.churchContactZoomConnection.findUnique({
      where: connectionWhere,
    });

  if (!connection) {
    throw new Error(
      "This Court Study host has not connected a Zoom account"
    );
  }

  if (connection.status === "REVOKED") {
    throw new Error(
      "This Court Study host's Zoom authorization has been revoked"
    );
  }

  if (connection.status === "DISCONNECTED") {
    throw new Error(
      "This Court Study host's Zoom account is disconnected"
    );
  }

  const refreshThresholdMs = 60 * 1000;

  const tokenExpiresAtMs = new Date(
    connection.tokenExpiresAt
  ).getTime();

  /*
   * Reuse the saved access token while it remains valid for
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

  const clientId = process.env.ZOOM_CONNECT_CLIENT_ID;
  const clientSecret = process.env.ZOOM_CONNECT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "ZOOM_CONNECT_CLIENT_ID or ZOOM_CONNECT_CLIENT_SECRET is not configured"
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
      where: connectionWhere,
      data: {
        status: "REAUTHORIZATION_REQUIRED",
      },
    });

    throw new Error(
      `Court Study host Zoom token refresh failed: ${
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
    where: connectionWhere,
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

/*
 * Backward-compatible wrapper for the existing pastor/church
 * workflow while the remaining Court Study routes are migrated.
 */
async function getChurchContactZoomAccessToken(churchContactId) {
  return getCourtStudyHostZoomAccessToken({
    churchContactId,
  });
}

// ============================================================
// COURT CORRESPONDENT ADMIN — WIX CMS READ ROUTES
// ============================================================

app.get(
  "/api/admin/journalist-applications",
  requireAdminToken,
  async (req, res) => {
    try {
      const applications = await queryWixCollection(
        "journalistapplications"
      );

      return res.status(200).json({
        applications,
      });
    } catch (error) {
      console.error(
        "COURT CORRESPONDENT APPLICATIONS FETCH ERROR:",
        error
      );

      return res.status(502).json({
        success: false,
        error: "Unable to retrieve Court Correspondent applications.",
      });
    }
  }
);

app.get(
  "/api/admin/journalist-profiles",
  requireAdminToken,
  async (req, res) => {
    try {
      const profiles = await queryWixCollection("journalists");

      return res.status(200).json({
        profiles,
      });
    } catch (error) {
      console.error(
        "COURT CORRESPONDENT PROFILES FETCH ERROR:",
        error
      );

      return res.status(502).json({
        success: false,
        error: "Unable to retrieve Court Correspondent profiles.",
      });
    }
  }
);

// Approve a journalist application and create journalist profile if needed
app.post(
  "/api/admin/journalist-applications/:id/approve",
  requireAdminToken,
  async (req, res) => {
    try {
      const applicationId = String(req.params.id || "").trim();

      if (!applicationId) {
        return res.status(400).json({
          success: false,
          error: "Application ID is required",
        });
      }

      const apiKey = process.env.WIX_API_KEY;
      const siteId = process.env.WIX_SITE_ID;

      if (!apiKey || !siteId) {
        console.error("❌ WIX_API_KEY or WIX_SITE_ID is not configured");
        return res.status(500).json({
          success: false,
          error: "Wix configuration is missing",
        });
      }

      // A. Query journalistapplications and find the specific application
      let applications = [];
      try {
        applications = await queryWixCollection(
          "journalistapplications"
        );
      } catch (err) {
        console.error(
          "❌ Failed to query journalistapplications:",
          err
        );
        return res.status(502).json({
          success: false,
          error: "Unable to retrieve applications from Wix",
        });
      }

      // B. Return 404 if application does not exist
      const application = applications.find(
        (app) => app._id === applicationId
      );

      if (!application) {
        return res.status(404).json({
          success: false,
          error: "Application not found",
        });
      }

      // C. Normalize the application's email with trim().toLowerCase()
      const normalizedEmail = (
        application.email || ""
      )
        .trim()
        .toLowerCase();

      // D. If normalized email is empty, return an error and do not approve
      if (!normalizedEmail) {
        return res.status(400).json({
          success: false,
          error:
            "Application email is required before approval",
        });
      }

      // E. Query "journalists"
      let existingProfiles = [];
      try {
        existingProfiles = await queryWixCollection(
          "journalists"
        );
      } catch (err) {
        console.error(
          "❌ Failed to query journalists:",
          err
        );
        return res.status(502).json({
          success: false,
          error: "Unable to retrieve journalist profiles from Wix",
        });
      }

      // F. Check for an existing profile using normalized lowercase email
      const duplicateProfile = existingProfiles.find(
        (profile) =>
          (profile.email || "")
            .trim()
            .toLowerCase() === normalizedEmail
      );

      let createdProfileId = null;

      // G. If no matching profile exists, create the profile FIRST
      if (!duplicateProfile) {
        const fullName = `${
          application.firstName || ""
        } ${application.lastName || ""}`.trim();

        const profileData = {
          fullName,
          email: normalizedEmail,
          bio: application.bio || "",
          hideFromPublicDirectory: true,
        };

        // Only include website if portfolioLink has a value
        if (application.portfolioLink) {
          profileData.website = application.portfolioLink;
        }

        // Only include resumeUrl if resumeLink has a value
        if (application.resumeLink) {
          profileData.resumeUrl = application.resumeLink;
        }

        const insertUrl =
          "https://www.wixapis.com/wix-data/v2/items";

        const insertBody = {
          dataCollectionId: "journalists",
          dataItem: {
            data: profileData,
          },
        };

        try {
          const insertRes = await fetch(insertUrl, {
            method: "POST",
            headers: {
              Authorization: apiKey,
              "wix-site-id": siteId,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(insertBody),
          });

          if (!insertRes.ok) {
            const text = await insertRes.text().catch(() => "");
            console.error(
              "❌ WIX POST journalist profile failed:",
              insertRes.status,
              text
            );

            // If profile creation fails, do NOT mark application Approved
            return res.status(502).json({
              success: false,
              error:
                "Failed to create journalist profile on Wix",
            });
          }

          let insertResponseBody = null;
          try {
            const insertText = await insertRes.text();
            insertResponseBody = insertText
              ? JSON.parse(insertText)
              : null;
          } catch {
            insertResponseBody = null;
          }

          createdProfileId =
            insertResponseBody?.dataItem?.id || null;

          console.log(
            "✅ Created journalist profile for email:",
            normalizedEmail,
            "Profile ID:",
            createdProfileId
          );
        } catch (err) {
          console.error(
            "❌ Error creating journalist profile:",
            err
          );

          // If profile creation fails, do NOT mark application Approved
          return res.status(500).json({
            success: false,
            error: String(err),
          });
        }
      } else {
        // If matching profile exists, do not create another profile
        console.log(
          `ℹ️  Journalist profile already exists for email: ${normalizedEmail}`
        );
      }

      // H. Only after profile exists or was created,
      // PATCH applicationStatus to "Approved"
      const patchUrl = `https://www.wixapis.com/wix-data/v2/items/${encodeURIComponent(
        applicationId
      )}`;

      const patchBody = {
        dataCollectionId: "journalistapplications",
        patch: {
          dataItemId: applicationId,
          fieldModifications: [
            {
              fieldPath: "applicationStatus",
              action: "SET_FIELD",
              setFieldOptions: {
                value: "Approved",
              },
            },
          ],
        },
      };

      const patchRes = await fetch(patchUrl, {
        method: "PATCH",
        headers: {
          Authorization: apiKey,
          "wix-site-id": siteId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(patchBody),
      });

      if (patchRes.status === 404) {
        return res.status(404).json({
          success: false,
          error: "Application not found",
        });
      }

      if (!patchRes.ok) {
        const text = await patchRes.text().catch(() => "");
        console.error(
          "❌ WIX PATCH journalistapplication failed:",
          patchRes.status,
          text
        );

        return res.status(502).json({
          success: false,
          error: "Failed to update application on Wix",
        });
      }

      let patchResponseBody = null;
      try {
        const text = await patchRes.text();
        patchResponseBody = text ? JSON.parse(text) : null;
      } catch {
        patchResponseBody = null;
      }

      return res.status(200).json({
        success: true,
        application: patchResponseBody,
        message: duplicateProfile
          ? "Application approved. Journalist profile already exists."
          : "Application approved. Journalist profile created.",
        profileCreated: !duplicateProfile,
        profileId: createdProfileId,
      });
    } catch (err) {
      console.error(
        "❌ POST /api/admin/journalist-applications/:id/approve error:",
        err
      );
      return res.status(500).json({
        success: false,
        error: String(err),
      });
    }
  }
);

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

    const clientId = process.env.ZOOM_CONNECT_CLIENT_ID;
    const redirectUri = process.env.ZOOM_CONNECT_REDIRECT_URL;

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

// ========================================================
// COURT STUDY ZOOM CONNECT — HOST ACCOUNT CONFIRMATION
// ========================================================

app.get(
  "/court-study/zoom/connect-organizer/:requestId",
  async (req, res) => {
    try {
      const requestId = String(req.params.requestId || "").trim();

      if (!requestId) {
        return res.status(400).send(
          "A Court Study request ID is required."
        );
      }

      const courtStudyRequest =
        await prisma.courtStudyRequest.findUnique({
          where: {
            id: requestId,
          },
        });

      if (!courtStudyRequest) {
        return res.status(404).send(
          "Court Study request not found."
        );
      }

      if (
        String(courtStudyRequest.meetingFormat || "")
          .trim()
          .toUpperCase() !== "COMMUNITY_HOSTED"
      ) {
        return res.status(400).send(
          "This Court Study is not configured for an organizer-hosted Zoom meeting."
        );
      }

      const blockedStatuses = new Set([
        "PENDING",
        "DECLINED",
        "CANCELLED",
      ]);

      if (
        blockedStatuses.has(
          String(courtStudyRequest.status || "")
            .trim()
            .toUpperCase()
        )
      ) {
        return res.status(403).send(
          "This Court Study request is not currently authorized to connect Zoom."
        );
      }

      const continueUrl =
        `/court-study/zoom/authorize-organizer/${encodeURIComponent(
          requestId
        )}`;

      return res.status(200).type("html").send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  >
  <title>Connect Hosting Zoom Account</title>

  <style>
    body {
      margin: 0;
      background: #f6f1e8;
      color: #10295f;
      font-family: Arial, Helvetica, sans-serif;
    }

    .page {
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 32px 18px;
      box-sizing: border-box;
    }

    .card {
      width: 100%;
      max-width: 620px;
      background: #ffffff;
      border-radius: 14px;
      overflow: hidden;
      box-shadow: 0 8px 28px rgba(0,0,0,0.08);
    }

    .header {
      background: #123574;
      color: #ffffff;
      text-align: center;
      padding: 30px 28px;
      border-bottom: 4px solid #d4a900;
    }

    .court {
      color: #f4c430;
      font-size: 13px;
      letter-spacing: 2px;
      font-weight: 700;
      margin-bottom: 12px;
    }

    .header h1 {
      margin: 0;
      font-size: 28px;
    }

    .content {
      padding: 34px;
      font-size: 17px;
      line-height: 1.55;
    }

    .notice {
      background: #fff7d9;
      border-left: 4px solid #c99a00;
      padding: 18px;
      margin: 24px 0;
    }

    .important {
      font-weight: 700;
    }

    .button {
      display: inline-block;
      margin-top: 10px;
      padding: 15px 24px;
      background: #123574;
      color: #ffffff !important;
      text-decoration: none;
      font-weight: 700;
      border-radius: 5px;
    }

    .small {
      color: #667085;
      margin-top: 22px;
      font-size: 14px;
    }

    .footer {
      border-top: 1px solid #e5e7eb;
      text-align: center;
      padding: 20px;
      color: #667085;
      font-size: 13px;
    }
  </style>
</head>

<body>
  <div class="page">
    <div class="card">

      <div class="header">
        <div class="court">
          COURT OF COMPASSION
        </div>

        <h1>
          Connect the Zoom Account That Will Host This Court Study
        </h1>
      </div>

      <div class="content">

        <p>
          Your Court Study request has been approved.
        </p>

        <p>
          The next step is to authorize the Zoom account
          that should host this Court Study session.
        </p>

        <div class="notice">
          <div class="important">
            Important — choose the correct Zoom account.
          </div>

          <p>
            The Zoom account you authorize on the next
            screen will be the account in which the Court
            Study meeting is created.
          </p>

          <p>
            If your church, ministry, organization, company,
            or community uses its own Zoom account, make sure
            you authorize that account rather than a personal
            Zoom account.
          </p>
        </div>

        <p>
          Court of Compassion will automatically create and
          configure the meeting after Zoom authorization is
          completed.
        </p>

        <a
          class="button"
          href="${continueUrl}"
        >
          Continue to Zoom
        </a>

        <div class="small">
          If Zoom is already signed in to the wrong account,
          switch to the correct Zoom account before completing
          authorization.
        </div>

      </div>

      <div class="footer">
        Court of Compassion<br>
        Justice • Truth • Social Relevance
      </div>

    </div>
  </div>
</body>
</html>
      `);
    } catch (error) {
      console.error(
        "COURT STUDY ZOOM HOST ACCOUNT CONFIRMATION ERROR:",
        error
      );

      return res.status(500).send(
        "Unable to prepare Zoom authorization."
      );
    }
  }
);

// ========================================================
// COURT STUDY ZOOM CONNECT — COMMUNITY ORGANIZER OAUTH
// ========================================================

app.get(
  "/court-study/zoom/authorize-organizer/:requestId",
  
  async (req, res) => {
    try {
      const requestId = String(req.params.requestId || "").trim();

      if (!requestId) {
        return res.status(400).json({
          success: false,
          error: "A Court Study request ID is required.",
        });
      }

      const courtStudyRequest =
        await prisma.courtStudyRequest.findUnique({
          where: {
            id: requestId,
          },
        });

      if (!courtStudyRequest) {
        return res.status(404).json({
          success: false,
          error: "Court Study request not found.",
        });
      }

      if (courtStudyRequest.meetingFormat !== "COMMUNITY_HOSTED") {
        return res.status(400).json({
          success: false,
          error:
            "This Court Study request is not a community-hosted session.",
        });
      }

      const blockedStatuses = new Set([
        "PENDING",
        "DECLINED",
        "CANCELLED",
      ]);

      if (blockedStatuses.has(courtStudyRequest.status)) {
        return res.status(403).json({
          success: false,
          error:
            "This Court Study request is not currently authorized to connect a Zoom account.",
        });
      }

      const organizerEmail = String(
        courtStudyRequest.organizerEmail || ""
      )
        .trim()
        .toLowerCase();

      if (!organizerEmail) {
        return res.status(400).json({
          success: false,
          error:
            "This Court Study request does not have an organizer email.",
        });
      }

      const clientId = process.env.ZOOM_CONNECT_CLIENT_ID;
      const redirectUri = process.env.ZOOM_CONNECT_REDIRECT_URL;

      if (!clientId || !redirectUri) {
        return res.status(500).json({
          success: false,
          error: "Zoom OAuth is not fully configured.",
        });
      }

      const invitationToken =
        crypto.randomBytes(32).toString("hex");

      const tokenHash =
        hashZoomOAuthToken(invitationToken);

      await prisma.zoomOAuthInvitation.create({
        data: {
          organizerEmail,
          tokenHash,
          expiresAt: new Date(
            Date.now() + 15 * 60 * 1000
          ),
        },
      });

      const state = Buffer.from(
  JSON.stringify({
    requestId,
    organizerEmail,
    invitationToken,
  }),
  "utf8"
).toString("base64url");

      const authorizationUrl = new URL(
        "https://zoom.us/oauth/authorize"
      );

      authorizationUrl.searchParams.set(
        "response_type",
        "code"
      );

      authorizationUrl.searchParams.set(
        "client_id",
        clientId
      );

      authorizationUrl.searchParams.set(
        "redirect_uri",
        redirectUri
      );

      authorizationUrl.searchParams.set(
        "state",
        state
      );

      return res.redirect(
        authorizationUrl.toString()
      );
    } catch (error) {
      console.error(
        "COURT STUDY ORGANIZER ZOOM CONNECT ERROR:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          "Unable to begin organizer Zoom authorization.",
      });
    }
  }
);

// =====================================================
// COURT STUDY ZOOM CONNECT — OAUTH CALLBACK
// =====================================================
app.get("/court-study/zoom/callback", async (req, res) => {
  try {
    const code = String(req.query.code || "").trim();
    const state = String(req.query.state || "").trim();

    if (!code || !state) {
      return res.status(400).send(
        "Missing Zoom authorization code or state."
      );
    }

    // Decode the state created by the Court Study Connect route.
    let stateData;

    try {
      stateData = JSON.parse(
        Buffer.from(state, "base64url").toString("utf8")
      );
    } catch {
      return res.status(400).send(
        "Invalid Zoom authorization state."
      );
    }

  const requestId = String(
  stateData?.requestId || ""
).trim();

const churchContactId = String(
  stateData?.churchContactId || ""
).trim();

const organizerEmail = String(
  stateData?.organizerEmail || ""
)
  .trim()
  .toLowerCase();

const invitationToken = String(
  stateData?.invitationToken || ""
).trim();

if (
  (!churchContactId && (!requestId || !organizerEmail)) ||
  !invitationToken
) {
  return res.status(400).send(
    "Invalid Zoom connection request."
  );
}  

if (churchContactId && organizerEmail) {
  return res.status(400).send(
    "Invalid Zoom connection request."
  );
} 
    
   // Verify that this is a valid, unused Court Study Zoom invitation.
const tokenHash = hashZoomOAuthToken(invitationToken);

const invitationIdentityWhere = churchContactId
  ? { churchContactId }
  : { organizerEmail };

const invitation =
  await prisma.zoomOAuthInvitation.findFirst({
    where: {
      ...invitationIdentityWhere,
      tokenHash,
    },
  }); 

    if (!invitation) {
      return res.status(400).send(
        "This Zoom connection invitation is invalid."
      );
    }

    if (invitation.usedAt) {
      return res.status(400).send(
        "This Zoom connection invitation has already been used."
      );
    }

    if (invitation.expiresAt <= new Date()) {
      return res.status(400).send(
        "This Zoom connection invitation has expired."
      );
    }

    // IMPORTANT:
    // Court Study Zoom Connect has its own OAuth credentials.
    const clientId = process.env.ZOOM_CONNECT_CLIENT_ID;
    const clientSecret =
      process.env.ZOOM_CONNECT_CLIENT_SECRET;
    const redirectUri =
      process.env.ZOOM_CONNECT_REDIRECT_URL;

    if (!clientId || !clientSecret || !redirectUri) {
      throw new Error(
        "Court Study Zoom Connect OAuth is not fully configured"
      );
    }

    const basicAuthorization = Buffer.from(
      `${clientId}:${clientSecret}`
    ).toString("base64");

    // Exchange Zoom's one-time authorization code for tokens.
    const tokenResponse = await fetch(
      "https://zoom.us/oauth/token",
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicAuthorization}`,
          "Content-Type":
            "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        }),
      }
    );

    const tokenData = await tokenResponse
      .json()
      .catch(() => ({}));

    if (!tokenResponse.ok) {
      throw new Error(
        `Court Study Zoom token exchange failed: ${
          tokenData.reason ||
          tokenData.message ||
          JSON.stringify(tokenData)
        }`
      );
    }

    if (
      !tokenData.access_token ||
      !tokenData.refresh_token
    ) {
      throw new Error(
        "Zoom did not return the required OAuth tokens"
      );
    }

    // Identify the Zoom account that was connected.
    const userResponse = await fetch(
      "https://api.zoom.us/v2/users/me",
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
        },
      }
    );

    const zoomUser = await userResponse
      .json()
      .catch(() => ({}));

    if (!userResponse.ok || !zoomUser.id) {
      throw new Error(
        `Unable to identify connected Zoom user: ${
          zoomUser.message || JSON.stringify(zoomUser)
        }`
      );
    }

    const expiresInSeconds = Number(
      tokenData.expires_in || 3600
    );

    const tokenExpiresAt = new Date(
      Date.now() + expiresInSeconds * 1000
    );

    const now = new Date();

    // Save the connected Zoom account securely.
    
    const zoomConnectionWhere = churchContactId
  ? { churchContactId }
  : { organizerEmail };

const zoomConnectionIdentity = churchContactId
  ? {
      churchContactId,
      organizerEmail: null,
    }
  : {
      churchContactId: null,
      organizerEmail,
    };
    
    await prisma.$transaction([
      prisma.churchContactZoomConnection.upsert({
        where: zoomConnectionWhere,

        create: {
          ...zoomConnectionIdentity,
          zoomUserId: String(zoomUser.id),
          zoomAccountId: zoomUser.account_id
            ? String(zoomUser.account_id)
            : null,
          zoomEmail: zoomUser.email
            ? String(zoomUser.email)
            : null,
          accessTokenEncrypted: encryptZoomToken(
            tokenData.access_token
          ),
          refreshTokenEncrypted: encryptZoomToken(
            tokenData.refresh_token
          ),
          tokenExpiresAt,
          authorizedScopes: tokenData.scope || null,
          status: "CONNECTED",
          connectedAt: now,
          disconnectedAt: null,
        },

        update: {
          zoomUserId: String(zoomUser.id),
          zoomAccountId: zoomUser.account_id
            ? String(zoomUser.account_id)
            : null,
          zoomEmail: zoomUser.email
            ? String(zoomUser.email)
            : null,
          accessTokenEncrypted: encryptZoomToken(
            tokenData.access_token
          ),
          refreshTokenEncrypted: encryptZoomToken(
            tokenData.refresh_token
          ),
          tokenExpiresAt,
          authorizedScopes: tokenData.scope || null,
          status: "CONNECTED",
          connectedAt: now,
          disconnectedAt: null,
        },
      }),

      prisma.zoomOAuthInvitation.update({
        where: {
          id: invitation.id,
        },
        data: {
          usedAt: now,
        },
      }),
    ]);

    if (requestId) {
  const courtStudyRequest =
    await prisma.courtStudyRequest.findUnique({
      where: {
        id: requestId,
      },
    });

  if (
    !courtStudyRequest ||
    courtStudyRequest.meetingFormat !== "COMMUNITY_HOSTED" ||
    String(courtStudyRequest.organizerEmail || "")
      .trim()
      .toLowerCase() !== organizerEmail
  ) {
    throw new Error(
      "Unable to match the connected Zoom account to the Court Study request."
    );
  }

  await prisma.courtStudyRequest.update({
    where: {
      id: requestId,
    },
    data: {
      status: "ZOOM_CONNECTED",
    },
  });

// ==========================================================
// COMMUNITY-HOSTED COURT STUDY:
// automatically schedule and create Zoom after OAuth success
// ==========================================================
if (
  courtStudyRequest.meetingFormat === "COMMUNITY_HOSTED" &&
  requestId
) {
  if (!courtStudyRequest.preferredStart) {
    throw new Error(
      "Cannot automatically schedule this Court Study because preferredStart is missing."
    );
  }

  const requestTimeZone =
    courtStudyRequest.timezone || "America/Los_Angeles";

  const preferredStart =
    new Date(courtStudyRequest.preferredStart);

  if (Number.isNaN(preferredStart.getTime())) {
    throw new Error(
      "Cannot automatically schedule this Court Study because preferredStart is invalid."
    );
  }

  // Match the present Court Study scheduling default: 60 minutes.
  const preferredEnd =
    new Date(preferredStart.getTime() + 60 * 60 * 1000);

  const formatLocalDateTime = (date, timeZone) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(date)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value])
    );

    return (
      `${parts.year}-${parts.month}-${parts.day}` +
      `T${parts.hour}:${parts.minute}`
    );
  };

  const scheduleResult =
    await scheduleCourtStudyInternal({
      requestId,
      scheduledStart: formatLocalDateTime(
        preferredStart,
        requestTimeZone
      ),
      scheduledEnd: formatLocalDateTime(
        preferredEnd,
        requestTimeZone
      ),
      timezone: requestTimeZone,
    });

  if (!scheduleResult.success) {
    throw new Error(
      scheduleResult.responseBody?.error ||
        "Automatic Court Study scheduling failed."
    );
  }

  const zoomResult =
    await createCourtStudyZoomInternal({
      requestId,
    });

  if (!zoomResult.responseBody?.success) {
    throw new Error(
      zoomResult.responseBody?.error ||
        "Automatic organizer Zoom meeting creation failed."
    );
  }

  const invitationResult =
  await sendCourtStudyInvitationInternal({
    requestId,
  });

if (
  !invitationResult.success ||
  !invitationResult.responseBody?.success
) {
  throw new Error(
    invitationResult.responseBody?.error ||
      "Automatic Court Study invitation sending failed."
  );
}
  
  console.log(
    "✅ COMMUNITY-HOSTED COURT STUDY AUTOMATED:",
    {
      requestId,
      organizerEmail,
      scheduled: true,
      zoomCreated: true,
      invitationSent: true,
    }
  );
}
      
}
    
    console.log(
  "✅ COURT STUDY ZOOM CONNECTED:",
  churchContactId || organizerEmail,
  zoomUser.id
);

   const connectedZoomEmail =
  String(zoomUser.email || "").trim() ||
  "Not available";

const safeConnectedZoomEmail =
  connectedZoomEmail
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;"); 

   return res.status(200).type("html").send(`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  />
  <title>Court Study Setup Complete</title>

  <style>
    body {
      margin: 0;
      background: #f7f2e9;
      color: #24324a;
      font-family: Arial, Helvetica, sans-serif;
    }

    .page {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 32px 18px;
      box-sizing: border-box;
    }

    .card {
      width: 100%;
      max-width: 620px;
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 14px;
      overflow: hidden;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.06);
    }

    .header {
      background: #0b2a68;
      color: #ffffff;
      text-align: center;
      padding: 30px 24px;
      border-bottom: 4px solid #d8b24c;
    }

    .brand {
      color: #f2c94c;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 2px;
      margin-bottom: 12px;
    }

    .header h1 {
      margin: 0;
      font-size: 28px;
      line-height: 1.25;
    }

    .content {
      padding: 32px;
      line-height: 1.65;
      font-size: 16px;
    }

    .success {
      width: 54px;
      height: 54px;
      margin: 0 auto 24px auto;
      border-radius: 50%;
      background: #eaf7ed;
      color: #17823b;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 30px;
      font-weight: 700;
    }

    .notice {
      margin: 24px 0;
      padding: 18px;
      background: #fff8df;
      border-left: 4px solid #b38a00;
    }

    .continue {
      font-weight: 700;
      color: #0b2a68;
      font-size: 17px;
    }

    .close {
      margin-top: 28px;
      color: #6b7280;
      font-size: 14px;
    }

    .footer {
      border-top: 1px solid #e5e7eb;
      padding: 20px 32px;
      text-align: center;
      color: #687386;
      font-size: 13px;
    }
  </style>
</head>

<body>
  <div class="page">
    <div class="card">

      <div class="header">
        <div class="brand">COURT OF COMPASSION</div>
        <h1>Zoom Connected Successfully</h1>
      </div>

      <div class="content">
        <div class="success">✓</div>

        <p>
          Your Zoom account has been connected and your
          Court Study meeting has been created successfully.
        </p>

        <p>
  <strong>Hosting Zoom account:</strong>
  ${safeConnectedZoomEmail}
</p>

        <p>
          We have sent your
          <strong>Court Study Session Ready</strong>
          email to you.
        </p>

        <div class="notice">
          That email contains your Court Study material,
          meeting registration information, and instructions
          for inviting participants.
        </div>

        <p class="continue">
          Please check your email to continue.
        </p>

        <p class="close">
          You may now close this page.
        </p>
      </div>

      <div class="footer">
        Court of Compassion<br />
        Justice • Truth • Social Relevance
      </div>

    </div>
  </div>
</body>
</html>
`);
    
  } catch (error) {
    console.error(
      "❌ COURT STUDY ZOOM CALLBACK ERROR:",
      error
    );

    return res.status(500).send(
      `Unable to connect Zoom account: ${String(
        error?.message || error
      )}`
    );
  }
});

// ============================================================
// COURT STUDY ZOOM CONNECT — TEST CREATE MEETING
// ============================================================
app.post(
  "/court-study/zoom/test-create-meeting/:churchContactId",
  requireAdminToken,
  async (req, res) => {
    try {
      const churchContactId = String(
        req.params.churchContactId || ""
      ).trim();

      if (!churchContactId) {
        return res.status(400).json({
          success: false,
          error: "A church contact ID is required.",
        });
      }

      // Gets the pastor's stored Zoom token and refreshes it
      // automatically if necessary.
      const accessToken =
        await getChurchContactZoomAccessToken(churchContactId);

      // Schedule this harmless test meeting 30 minutes from now.
      const testTimeZone = "America/Los_Angeles";
const testStartDate = new Date(Date.now() + 30 * 60 * 1000);

const testTimeParts = Object.fromEntries(
  new Intl.DateTimeFormat("en-US", {
    timeZone: testTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(testStartDate)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value])
);

const startTime =
  `${testTimeParts.year}-${testTimeParts.month}-${testTimeParts.day}` +
  `T${testTimeParts.hour}:${testTimeParts.minute}:${testTimeParts.second}`;

      const zoomResponse = await fetch(
        "https://api.zoom.us/v2/users/me/meetings",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            topic: "Court of Compassion — Zoom Connect Test",
            type: 2,
            start_time: startTime,
            duration: 30,
            timezone: testTimeZone,
            agenda:
              "Temporary test meeting created through Court of Compassion Connect.",
            settings: {
              join_before_host: false,
              waiting_room: true,
            },
          }),
        }
      );

      const zoomMeeting = await zoomResponse
        .json()
        .catch(() => ({}));

      if (!zoomResponse.ok) {
        throw new Error(
          `Zoom create meeting failed: ${
            zoomMeeting.reason ||
            zoomMeeting.message ||
            JSON.stringify(zoomMeeting)
          }`
        );
      }

      console.log(
        "✅ COURT STUDY CONNECT TEST MEETING CREATED:",
        churchContactId,
        zoomMeeting.id,
        zoomMeeting.host_email
      );

      return res.status(201).json({
        success: true,
        message: "Test Zoom meeting created successfully.",
        meeting: {
          id: zoomMeeting.id,
          topic: zoomMeeting.topic,
          startTime: zoomMeeting.start_time,
          timezone: zoomMeeting.timezone,
          duration: zoomMeeting.duration,
          hostEmail: zoomMeeting.host_email,
          joinUrl: zoomMeeting.join_url,
        },
      });
    } catch (error) {
      console.error(
        "❌ COURT STUDY CONNECT TEST MEETING ERROR:",
        error
      );

      return res.status(500).json({
        success: false,
        error: String(error?.message || error),
      });
    }
  }
);

// ============================================================
// COURT STUDY ZOOM CONNECT — COMMUNITY ORGANIZER TEST MEETING
// ============================================================

app.post(
  "/court-study/zoom/test-create-organizer-meeting/:requestId",
  requireAdminToken,
  async (req, res) => {
    try {
      const requestId = String(
        req.params.requestId || ""
      ).trim();

      if (!requestId) {
        return res.status(400).json({
          success: false,
          error: "A Court Study request ID is required.",
        });
      }

      const courtStudyRequest =
        await prisma.courtStudyRequest.findUnique({
          where: {
            id: requestId,
          },
        });

      if (!courtStudyRequest) {
        return res.status(404).json({
          success: false,
          error: "Court Study request not found.",
        });
      }

      if (
        courtStudyRequest.meetingFormat !==
        "COMMUNITY_HOSTED"
      ) {
        return res.status(400).json({
          success: false,
          error:
            "This test route is only for a community-hosted Court Study.",
        });
      }

      if (
        courtStudyRequest.status !==
        "ZOOM_CONNECTED"
      ) {
        return res.status(409).json({
          success: false,
          error:
            "This Court Study request has not reached ZOOM_CONNECTED status.",
        });
      }

      const organizerEmail = String(
        courtStudyRequest.organizerEmail || ""
      )
        .trim()
        .toLowerCase();

      if (!organizerEmail) {
        return res.status(400).json({
          success: false,
          error:
            "This Court Study request does not have an organizer email.",
        });
      }

      const accessToken =
        await getCourtStudyHostZoomAccessToken({
          organizerEmail,
        });

      const testTimeZone =
        courtStudyRequest.timezone ||
        "America/Los_Angeles";

      const testStartDate =
        new Date(Date.now() + 30 * 60 * 1000);

      const testTimeParts = Object.fromEntries(
        new Intl.DateTimeFormat("en-US", {
          timeZone: testTimeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hourCycle: "h23",
        })
          .formatToParts(testStartDate)
          .filter((part) => part.type !== "literal")
          .map((part) => [part.type, part.value])
      );

      const startTime =
        `${testTimeParts.year}-${testTimeParts.month}-${testTimeParts.day}` +
        `T${testTimeParts.hour}:${testTimeParts.minute}:${testTimeParts.second}`;

      const zoomResponse = await fetch(
        "https://api.zoom.us/v2/users/me/meetings",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            topic:
              "Court of Compassion — Community Zoom Connect Test",
            type: 2,
            start_time: startTime,
            duration: 30,
            timezone: testTimeZone,
            agenda:
              "Temporary test meeting created through Court of Compassion Connect Zoom.",
            settings: {
              join_before_host: false,
              waiting_room: true,
            },
          }),
        }
      );

      const zoomMeeting =
        await zoomResponse
          .json()
          .catch(() => ({}));

      if (!zoomResponse.ok) {
        throw new Error(
          `Zoom create meeting failed: ${
            zoomMeeting.reason ||
            zoomMeeting.message ||
            JSON.stringify(zoomMeeting)
          }`
        );
      }

      console.log(
        "✅ COMMUNITY ORGANIZER ZOOM TEST MEETING CREATED:",
        requestId,
        organizerEmail,
        zoomMeeting.id,
        zoomMeeting.host_email
      );

      return res.status(201).json({
        success: true,
        message:
          "Community organizer Zoom test meeting created successfully.",
        requestId,
        organizerEmail,
        meeting: {
          id: zoomMeeting.id,
          topic: zoomMeeting.topic,
          startTime: zoomMeeting.start_time,
          timezone: zoomMeeting.timezone,
          duration: zoomMeeting.duration,
          hostEmail: zoomMeeting.host_email,
          joinUrl: zoomMeeting.join_url,
        },
      });
    } catch (error) {
      console.error(
        "❌ COMMUNITY ORGANIZER ZOOM TEST MEETING ERROR:",
        error
      );

      return res.status(500).json({
        success: false,
        error: String(error?.message || error),
      });
    }
  }
);

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
   html: htmlBody || escapeHtml(String(body)).replace(/\n/g, "<br>"), 
  });

  console.log("✅ DISTRIBUTION EMAIL SENT TO:", to);
}
const safeEmailHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const safeEmailWebUrl = (value) => {
  try {
    const parsedUrl = new URL(String(value));

    if (
      parsedUrl.protocol !== "https:" &&
      parsedUrl.protocol !== "http:"
    ) {
      return "#";
    }

    return parsedUrl
  .toString()
  .replaceAll("&", "&amp;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");
  } catch {
    return "#";
  }
};

function buildJournalistApprovalEmailHtml(bodyText) {
  // Validate input
  if (!bodyText || typeof bodyText !== 'string') {
    throw new Error('Email body must be a non-empty string');
  }

  const trimmedBody = String(bodyText).trim();

  if (trimmedBody.length === 0) {
    throw new Error('Email body cannot be empty');
  }

  // Escape first, then preserve line breaks
  const safeBody = escapeHtml(trimmedBody);

  // Convert lines to paragraphs, preserving blank lines for spacing
  const bodyHtml = safeBody
    .split('\n')
    .map(line => {
      const trimmedLine = line.trim();

      if (trimmedLine === '') {
        return '<div style="height:8px;line-height:8px;">&nbsp;</div>';
      }

      return `<p style="margin:0 0 12px 0;">${trimmedLine}</p>`;
    })
    .join('');

  return `
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f7f2e9;font-family:Arial,Helvetica,sans-serif;color:#172554;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f7f2e9;padding:32px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">

          <!-- BRANDED HEADER -->
          <tr>
            <td align="center" style="background:#0b2a68;padding:24px 32px 22px 32px;text-align:center;">
              <img
                src="https://static.wixstatic.com/media/2ccb97_745227d9536b452b83a82556e6c5a430~mv2.png"
                alt="Court of Compassion Seal"
                width="96"
                height="96"
                style="display:block;width:96px;height:96px;margin:0 auto 14px auto;border-radius:50%;border:2px solid #d8b24c;background:#ffffff;"
              >
              <div style="font-size:12px;letter-spacing:2px;color:#d8b24c;font-weight:700;margin-bottom:8px;">
                COURT OF COMPASSION
              </div>
              <div style="font-size:26px;line-height:34px;color:#ffffff;font-weight:700;">
                Court Correspondent Application Approved
              </div>
            </td>
          </tr>

          <!-- GOLD DIVIDER -->
          <tr>
            <td style="padding:0 32px;">
              <div style="height:4px;background:#d8b24c;"></div>
            </td>
          </tr>

          <!-- EMAIL BODY CONTENT -->
          <tr>
            <td style="padding:28px 32px 12px 32px;font-size:14px;line-height:21px;color:#172554;">
              ${bodyHtml}
            </td>
          </tr>

          <!-- FOOTER DIVIDER -->
          <tr>
            <td style="padding:0 32px;">
              <div style="height:1px;background:#e5e7eb;"></div>
            </td>
          </tr>

          <!-- BRANDED FOOTER -->
          <tr>
            <td style="padding:22px 32px 28px 32px;text-align:center;">
              <div style="border-top:2px solid #d8b24c;padding-top:18px;font-size:13px;font-weight:700;color:#0b2a68;">
                Court of Compassion
              </div>
              <div style="padding-top:5px;font-size:12px;color:#6b7280;">
                Justice • Truth • Social Relevance
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
}

app.use(express.json());

// POST /api/admin/journalist-applications/:id/send-approval-email
// Protected: requireAdminToken
app.post(
  "/api/admin/journalist-applications/:id/send-approval-email",
  requireAdminToken,
  async (req, res) => {
    try {
      const applicationId = String(req.params.id || "").trim();

      if (!applicationId) {
        return res.status(400).json({
          success: false,
          error: "Application ID is required",
        });
      }

      // Only accept subject and body from the frontend — reject any other keys
      const allowedKeys = new Set(["subject", "body"]);
      const extraKeys = Object.keys(req.body || {}).filter(
        (k) => !allowedKeys.has(k)
      );

      if (extraKeys.length > 0) {
        return res.status(400).json({
          success: false,
          error: "Only subject and body are allowed in the request body",
        });
      }

      const subject = String(req.body?.subject || "").trim();
      const body = String(req.body?.body || "").trim();

      if (!subject || !body) {
        return res.status(400).json({
          success: false,
          error: "Subject and body are required",
        });
      }

      // Query Wix journalistapplications
      let applications = [];
      try {
        applications = await queryWixCollection("journalistapplications");
      } catch (err) {
        console.error("❌ Failed to query journalistapplications:", err);
        return res.status(502).json({
          success: false,
          error: "Unable to retrieve applications from Wix",
        });
      }

      const application = applications.find(
        (app) => app._id === applicationId
      );

      if (!application) {
        return res.status(404).json({
          success: false,
          error: "Application not found",
        });
      }

      // Application must already be Approved
      if (String(application.applicationStatus || "").trim() !== "Approved") {
        return res.status(409).json({
          success: false,
          error:
            "Application must be approved before sending the approval email",
        });
      }

      // Recipient comes only from the stored application record
      const recipientEmail = String(application.email || "")
        .trim()
        .toLowerCase();

      if (!recipientEmail) {
        return res.status(400).json({
          success: false,
          error: "Application does not contain an email address",
        });
      }

     const apiKey = process.env.WIX_API_KEY;
const siteId = process.env.WIX_SITE_ID;

if (!apiKey || !siteId) {
  console.error("❌ WIX_API_KEY or WIX_SITE_ID is not configured");

  return res.status(500).json({
    success: false,
    error: "Wix configuration is missing",
  });
}
      
      try {
        // Reuse the existing Court of Compassion email helper
        await sendEmail(
  recipientEmail,
  subject,
  body,
  buildJournalistApprovalEmailHtml(body)
);

       console.log(
  "✅ Approval email sent for journalist application:",
  applicationId,
  "to:",
  recipientEmail
);

const approvalEmailSentAt = new Date().toISOString();

try {
  const patchUrl = `https://www.wixapis.com/wix-data/v2/items/${encodeURIComponent(
    applicationId
  )}`;

  const patchBody = {
    dataCollectionId: "journalistapplications",
    patch: {
      dataItemId: applicationId,
      fieldModifications: [
        {
          fieldPath: "approvalEmailSentAt",
          action: "SET_FIELD",
          setFieldOptions: {
            value: approvalEmailSentAt,
          },
        },
      ],
    },
  };

  const patchRes = await fetch(patchUrl, {
    method: "PATCH",
    headers: {
      Authorization: apiKey,
      "wix-site-id": siteId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patchBody),
  });

  if (!patchRes.ok) {
    const text = await patchRes.text().catch(() => "");

    console.error(
      "❌ WIX PATCH approvalEmailSentAt failed:",
      patchRes.status,
      text
    );

    return res.status(200).json({
      success: true,
      message: "Approval email sent",
      applicationId,
      sentTo: recipientEmail,
      approvalEmailSentAt,
      auditLogged: false,
      warning: "Email was sent, but the sent timestamp could not be saved",
    });
  }

  console.log(
    "✅ approvalEmailSentAt saved to Wix for application:",
    applicationId,
    approvalEmailSentAt
  );

  return res.status(200).json({
    success: true,
    message: "Approval email sent",
    applicationId,
    sentTo: recipientEmail,
    approvalEmailSentAt,
    auditLogged: true,
  });
} catch (patchErr) {
  console.error(
    "❌ WIX PATCH approvalEmailSentAt exception:",
    patchErr
  );

  return res.status(200).json({
    success: true,
    message: "Approval email sent",
    applicationId,
    sentTo: recipientEmail,
    approvalEmailSentAt,
    auditLogged: false,
    warning: "Email was sent, but the sent timestamp could not be saved",
  });
}
        
      } catch (sendErr) {
        // Log full SMTP error server-side only
        console.error(
          "❌ Failed to send approval email for application:",
          applicationId,
          sendErr
        );

        return res.status(500).json({
          success: false,
          error: "Failed to send approval email",
        });
      }
    } catch (err) {
      // Log full error server-side, return sanitized message
      console.error(
        "❌ POST /api/admin/journalist-applications/:id/send-approval-email error:",
        err
      );

      return res.status(500).json({
        success: false,
        error: "Unable to send approval email",
      });
    }
  }
);

app.use((req, res, next) => {
  console.log("➡️", req.method, req.originalUrl);
  next();
});

// Exchange the permanent admin credential for a short-lived admin session token
app.post("/api/admin/session", (req, res) => {
  res.set("Cache-Control", "no-store");

  const providedToken = String(req.body?.token || "");
  const expectedToken = process.env.ADMIN_API_TOKEN;

  if (!expectedToken) {
    console.error("❌ ADMIN_API_TOKEN is not configured");
    return res.status(500).json({
      success: false,
      error: "Admin security token is not configured",
    });
  }

  const providedBuffer = Buffer.from(providedToken);
  const expectedBuffer = Buffer.from(expectedToken);

  const tokenMatches =
    providedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(providedBuffer, expectedBuffer);

  if (!tokenMatches) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized",
    });
  }

  try {
    const sessionToken = createAdminSessionToken();

   res.cookie("court_admin_session", sessionToken, {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  maxAge: ADMIN_SESSION_TTL_MS,
  path: "/",
});

return res.json({
  success: true,
  expiresInSeconds: ADMIN_SESSION_TTL_MS / 1000,
}); 
  } catch (err) {
    console.error("❌ Failed to create admin session:", err);
    return res.status(500).json({
      success: false,
      error: "Unable to create admin session",
    });
  }
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
  podcastUrl,
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
        podcastUrl: podcastUrl ? String(podcastUrl).trim() : null,
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
      thumbnailUrl,
      podcastUrl,
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

    if (thumbnailUrl !== undefined) {
  data.thumbnailUrl = thumbnailUrl
    ? String(thumbnailUrl).trim()
    : null;
}

if (podcastUrl !== undefined) {
  data.podcastUrl = podcastUrl
    ? String(podcastUrl).trim()
    : null;
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

// DELETE one complete recording test package
app.delete(
  "/recordings/:id",
  requireAdminToken,
  async (req, res) => {
    const recordingId = String(req.params.id || "").trim();

    if (!recordingId) {
      return res.status(400).json({
        success: false,
        error: "Recording ID is required",
      });
    }

    try {
      const recording = await prisma.recording.findUnique({
        where: {
          id: recordingId,
        },
        include: {
          courtStudyRequests: {
            select: {
              id: true,
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

      const courtStudyRequestIds =
        recording.courtStudyRequests.map((request) => request.id);

      const result = await prisma.$transaction(async (tx) => {
        let deletedMeetingsCount = 0;

        if (courtStudyRequestIds.length > 0) {
          const deletedMeetings =
            await tx.courtStudyMeeting.deleteMany({
              where: {
                courtStudyRequestId: {
                  in: courtStudyRequestIds,
                },
              },
            });

          deletedMeetingsCount = deletedMeetings.count;
        }

        const deletedRecording = await tx.recording.delete({
          where: {
            id: recordingId,
          },
        });

        return {
          deletedRecording,
          deletedMeetingsCount,
        };
      });

      return res.status(200).json({
        success: true,
        message: "Recording test package deleted successfully",
        deleted: {
          recordingId: result.deletedRecording.id,
          title: result.deletedRecording.title,
          courtStudyMeetings: result.deletedMeetingsCount,
        },
      });
    } catch (err) {
      console.error(
        "❌ DELETE /recordings/:id error:",
        err
      );

      return res.status(500).json({
        success: false,
        error: String(err),
      });
    }
  }
);

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

  const value = String(url || "").trim();

if (!value) return false;

try {
  const parsedUrl = new URL(value);

  if (
    parsedUrl.protocol !== "http:" &&
    parsedUrl.protocol !== "https:"
  ) {
    return false;
  }

  const hostname = parsedUrl.hostname
    .toLowerCase()
    .replace(/\.$/, "");

  if (
    hostname === "example.com" ||
    hostname.endsWith(".example.com")
  ) {
    return false;
  }

  return true;
} catch {
  return false;
}
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

app.post(
  ["/zoom/webhook", "/zoom/s2s-webhook"],
  express.raw({ type: "application/json" }),
  async (req, res) => {
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
      const secret =
  req.path === "/zoom/s2s-webhook"
    ? process.env.ZOOM_S2S_WEBHOOK_SECRET_TOKEN || ""
    : process.env.ZOOM_WEBHOOK_SECRET || "";

      if (!plainToken || !secret) {
       console.log("❌ Missing plainToken or Zoom webhook secret"); 
        return res.status(400).json({ error: "Missing plainToken or secret" });
      }

      const encryptedToken = crypto
        .createHmac("sha256", secret)
        .update(plainToken)
        .digest("hex");

      return res.status(200).json({ plainToken, encryptedToken });
    }

    // Normal events

  if (body?.event === "meeting.ended") {
  const payload = body.payload || {};
  const meeting = payload.object || {};

  const zoomMeetingId = meeting.id ? String(meeting.id) : "";
  const zoomMeetingUuid = meeting.uuid ? String(meeting.uuid) : null;

  const actualSessionStart = meeting.start_time
    ? new Date(meeting.start_time)
    : null;

  const actualSessionEnd = meeting.end_time
    ? new Date(meeting.end_time)
    : null;

  console.log("🛑 ZOOM MEETING ENDED:", {
    meetingId: zoomMeetingId || null,
    meetingUuid: zoomMeetingUuid,
    startTime: meeting.start_time || null,
    endTime: meeting.end_time || null,
  });

  if (!zoomMeetingId) {
    console.warn("⚠️ meeting.ended webhook is missing the meeting ID.");
  } else {
    const courtStudyMeeting =
      await prisma.courtStudyMeeting.findFirst({
        where: {
          zoomMeetingId,
        },
        select: {
          id: true,
          courtStudyRequestId: true,
        },
      });

    if (!courtStudyMeeting) {
      console.log(
        `ℹ️ No CourtStudyMeeting record found for ended Zoom meeting ${zoomMeetingId}.`
      );
    } else {
      await prisma.$transaction(async (tx) => {
        await tx.courtStudyMeeting.update({
          where: {
            id: courtStudyMeeting.id,
          },
          data: {
            zoomMeetingUuid,
            actualSessionStart,
            actualSessionEnd,
          },
        });

        await tx.courtStudyRequest.updateMany({
          where: {
            id: courtStudyMeeting.courtStudyRequestId,
            status: "SESSION_READY",
          },
          data: {
            status: "SESSION_REVIEW_PENDING",
          },
        });
      });

      console.log("✅ COURT STUDY SESSION READY FOR REVIEW:", {
        courtStudyMeetingId: courtStudyMeeting.id,
        courtStudyRequestId: courtStudyMeeting.courtStudyRequestId,
        zoomMeetingId,
        zoomMeetingUuid,
      });
    }
  }
}
    
 if (body?.event === "meeting.registration_created") {
  const payload = body.payload || {};
  const meeting = payload.object || {};
  const registrant = meeting.registrant || {};

  const zoomMeetingId = meeting.id ? String(meeting.id) : "";
  const zoomRegistrantId = registrant.id
    ? String(registrant.id)
    : "";
  const email = String(registrant.email || "")
    .trim()
    .toLowerCase();

  console.log("✅ ZOOM REGISTRATION CREATED:", {
    accountId: payload.account_id || null,
    meetingId: zoomMeetingId || null,
    meetingUuid: meeting.uuid || null,
    registrantId: zoomRegistrantId || null,
    firstName: registrant.first_name || null,
    lastName: registrant.last_name || null,
    email: email || null,
    registrationStatus: registrant.status || null,
    eventTimestamp: body.event_ts || null,
  });

  if (!zoomMeetingId || !zoomRegistrantId || !email) {
    console.warn(
      "⚠️ Registration webhook is missing the meeting ID, registrant ID, or email."
    );
  } else {
    const courtStudyMeeting =
      await prisma.courtStudyMeeting.findFirst({
        where: {
          zoomMeetingId,
        },
        select: {
          id: true,
          title: true,
          courtStudyRequestId: true,
        },
      });

    if (!courtStudyMeeting) {
      console.warn(
        `⚠️ No CourtStudyMeeting record found for Zoom meeting ${zoomMeetingId}.`
      );
    } else {
      const rawTimestamp = Number(body.event_ts);

      const registeredAt = Number.isFinite(rawTimestamp)
        ? new Date(
            rawTimestamp < 1000000000000
              ? rawTimestamp * 1000
              : rawTimestamp
          )
        : new Date();

      const savedRegistrant =
        await prisma.zoomRegistrant.upsert({
          where: {
            zoomMeetingId_zoomRegistrantId: {
              zoomMeetingId,
              zoomRegistrantId,
            },
          },

          update: {
            zoomMeetingUuid: meeting.uuid
              ? String(meeting.uuid)
              : null,
            accountId: payload.account_id
              ? String(payload.account_id)
              : null,
            firstName: registrant.first_name || null,
            lastName: registrant.last_name || null,
            email,
            registrationStatus:
              registrant.status || "approved",
            lastEventType: body.event,
            registeredAt,
            canceledAt: null,
          },

          create: {
            courtStudyMeetingId: courtStudyMeeting.id,
            zoomMeetingId,
            zoomMeetingUuid: meeting.uuid
              ? String(meeting.uuid)
              : null,
            zoomRegistrantId,
            accountId: payload.account_id
              ? String(payload.account_id)
              : null,
            firstName: registrant.first_name || null,
            lastName: registrant.last_name || null,
            email,
            registrationStatus:
              registrant.status || "approved",
            lastEventType: body.event,
            registeredAt,
          },
        });

      console.log("💾 ZOOM REGISTRANT SAVED:", {
        id: savedRegistrant.id,
        courtStudyMeetingId:
          savedRegistrant.courtStudyMeetingId,
        zoomMeetingId: savedRegistrant.zoomMeetingId,
        zoomRegistrantId:
          savedRegistrant.zoomRegistrantId,
        email: savedRegistrant.email,
      });
    }
  }
}
    
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

// List guest distribution campaigns
app.get(
  "/api/guest-distribution-campaigns",
  requireAdminToken,
  async (req, res) => {
    try {
      const recordingId = req.query.recordingId
        ? String(req.query.recordingId)
        : null;

      const campaigns = await prisma.guestDistributionCampaign.findMany({
        where: recordingId ? { recordingId } : undefined,
        include: {
          recording: true,
        },
        orderBy: {
          createdAt: "desc",
        },
      });

      return res.json({
        success: true,
        count: campaigns.length,
        campaigns,
      });
    } catch (err) {
      console.error(
        "❌ GET /api/guest-distribution-campaigns error:",
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

      const backendBaseUrl = String(
  process.env.PUBLIC_BASE_URL || ""
).replace(/\/+$/, "");

if (!backendBaseUrl) {
  throw new Error("PUBLIC_BASE_URL is not configured");
}
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

Please forward this invitation link to the appropriate pastor, priest, or church leader. The church leader should complete and submit the Court Study request directly.

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
  campaign.recording.podcastUrl
    ? `
      <p>
       <a
  href="${campaign.recording.podcastUrl}"
  target="_blank"
  rel="noopener noreferrer"
> 
          Listen to the podcast
        </a>
      </p>
    `
    : ""
}

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

// ============================================================
// Bishop-facing pastor invitation page
// ============================================================
app.get("/guest-distribution/:token/invite", async (req, res) => {
  try {
    const distributionToken = String(req.params.token || "").trim();

    if (!distributionToken) {
      return res.status(400).send("Missing distribution token");
    }

    const campaign = await prisma.guestDistributionCampaign.findUnique({
      where: { distributionToken },
      include: {
        recording: true,
      },
    });

    if (!campaign) {
      return res
        .status(404)
        .send("This Court of Compassion invitation could not be found.");
    }

    if (campaign.status === "CLOSED") {
      return res
        .status(410)
        .send("This Court of Compassion invitation is closed.");
    }

    if (campaign.expiresAt && campaign.expiresAt.getTime() <= Date.now()) {
      return res
        .status(410)
        .send("This Court of Compassion invitation has expired.");
    }

    const escapeHtml = (value) =>
      String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");

    const guestName = escapeHtml(campaign.guestName);
    const organizationName = escapeHtml(campaign.organizationName || "");
    const recordingTitle = escapeHtml(
      campaign.recording?.title || "Court of Compassion Interview"
    );

    const formAction = `/guest-distribution/${encodeURIComponent(
      distributionToken
    )}/invite`;

    return res.status(200).send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Invite Pastors and Church Leaders</title>
  <style>
    * { box-sizing: border-box; }

    body {
      margin: 0;
      padding: 32px 16px;
      background: #061b33;
      color: #ffffff;
      font-family: Arial, Helvetica, sans-serif;
    }

    main {
      width: 100%;
      max-width: 780px;
      margin: 0 auto;
    }

    .card {
      background: #15345a;
      border: 1px solid #d9b84f;
      border-radius: 14px;
      padding: 28px;
    }

    h1, h2 {
      color: #e5c35b;
      margin-top: 0;
    }

    p {
      line-height: 1.55;
    }

    label {
      display: block;
      margin: 18px 0 8px;
      font-weight: 700;
    }

    textarea {
      width: 100%;
      min-height: 150px;
      padding: 12px;
      border: 1px solid #c9d2df;
      border-radius: 7px;
      font: inherit;
      resize: vertical;
    }

    .note {
      font-size: 14px;
      color: #e4e9ef;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 22px;
    }

    button, .button-link {
      display: inline-block;
      border: 0;
      border-radius: 7px;
      padding: 12px 18px;
      background: #e5c35b;
      color: #071a31;
      font-weight: 700;
      text-decoration: none;
      cursor: pointer;
    }

    .secondary {
      background: transparent;
      border: 1px solid #e5c35b;
      color: #ffffff;
    }
  </style>
</head>
<body>
  <main>
    <section class="card">
      <h1>Invite Pastors and Church Leaders</h1>

      <p>
        <strong>${guestName}</strong>
        ${
          organizationName
            ? ` of <strong>${organizationName}</strong>`
            : ""
        }
        may invite pastors, priests, or other church leaders to review:
      </p>

      <h2>${recordingTitle}</h2>

      <p>
        Each recipient will receive a separate Court of Compassion email.
        Recipient addresses will not be disclosed to one another.
      </p>

      <form method="post" action="${formAction}">
        <label for="pastorEmails">
          Pastor or church-leader email addresses
        </label>

        <textarea
          id="pastorEmails"
          name="pastorEmails"
          required
          placeholder="pastor1@example.org&#10;pastor2@example.org"
        ></textarea>

        <p class="note">
          Enter one email address per line. Commas and semicolons are also accepted.
        </p>

        <label for="pastorNames">
          Names, in the same order — optional
        </label>

        <textarea
          id="pastorNames"
          name="pastorNames"
          placeholder="Rev. Jane Smith&#10;Father John Doe"
        ></textarea>

        <p class="note">
          When names are supplied, place one name per line in the same order as the email addresses.
        </p>

        <div class="actions">
          <a
            class="button-link secondary"
            href="/guest-distribution/${encodeURIComponent(distributionToken)}"
          >
            Review Interview Media Page
          </a>

          <button type="submit">
            Send Invitations
          </button>
        </div>
      </form>
    </section>
  </main>
</body>
</html>
    `);
  } catch (err) {
    console.error("❌ GET pastor invitation page error:", err);

    return res
      .status(500)
      .send("The pastor invitation page could not be loaded.");
  }
});


// ============================================================
// Send separate invitations to pastors and church leaders
// ============================================================
app.post(
  "/guest-distribution/:token/invite",
  express.urlencoded({ extended: false }),
  async (req, res) => {
    try {
      const distributionToken = String(req.params.token || "").trim();

      const campaign = await prisma.guestDistributionCampaign.findUnique({
        where: { distributionToken },
        include: {
          recording: true,
        },
      });

      if (!campaign) {
        return res
          .status(404)
          .send("This Court of Compassion invitation could not be found.");
      }

      if (campaign.status === "CLOSED") {
        return res
          .status(410)
          .send("This Court of Compassion invitation is closed.");
      }

      if (campaign.expiresAt && campaign.expiresAt.getTime() <= Date.now()) {
        return res
          .status(410)
          .send("This Court of Compassion invitation has expired.");
      }

      const rawEmails = String(req.body.pastorEmails || "");
      const rawNames = String(req.body.pastorNames || "");

      const pastorEmails = [
        ...new Set(
          rawEmails
            .split(/[\n,;]+/)
            .map((email) => email.trim().toLowerCase())
            .filter(Boolean)
        ),
      ];

      const pastorNames = rawNames
        .split(/\r?\n/)
        .map((name) => name.trim());

      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      const invalidEmails = pastorEmails.filter(
        (email) => !emailPattern.test(email)
      );

      if (pastorEmails.length === 0) {
        return res
          .status(400)
          .send("Please provide at least one pastor email address.");
      }

      if (invalidEmails.length > 0) {
        return res.status(400).send(
          `Please correct these invalid email addresses: ${invalidEmails.join(
            ", "
          )}`
        );
      }

      if (pastorEmails.length > 100) {
        return res
          .status(400)
          .send("A maximum of 100 recipients may be invited at one time.");
      }

      const baseUrl = String(
  process.env.PUBLIC_BASE_URL || ""
).replace(/\/+$/, "");

if (!baseUrl) {
  throw new Error("PUBLIC_BASE_URL is not configured");
}
      const mediaPageUrl =
        `${baseUrl}/guest-distribution/` +
        encodeURIComponent(distributionToken);

      const recordingTitle =
        campaign.recording?.title || "Court of Compassion Interview";

      const organizationText = campaign.organizationName
        ? ` of ${campaign.organizationName}`
        : "";

      const results = [];

      for (let index = 0; index < pastorEmails.length; index += 1) {
        const pastorEmail = pastorEmails[index];
        const pastorName = pastorNames[index] || null;

        const invitation = await prisma.pastorInvitation.create({
          data: {
            campaignId: campaign.id,
            pastorName,
            pastorEmail,
            status: "PENDING",
          },
        });

        const greeting = pastorName
          ? `Dear ${pastorName},`
          : "Dear Pastor or Church Leader,";

        const htmlGreeting = pastorName
  ? `Dear ${escapeHtml(pastorName)},`
  : "Dear Pastor or Church Leader,";
        
        const subject =
          `Court of Compassion Invitation — ${recordingTitle}`;

        const plainTextBody = `${greeting}

${campaign.guestName}${organizationText} has invited you to review a finalized Court of Compassion interview.

Interview:
${recordingTitle}

Open the Interview Media Page:
${mediaPageUrl}

The page includes:
- The finalized interview recording
- The accompanying podcast
- The Court Study request form

After reviewing the interview, you may request a Court Study session for your congregation or church group.

Respectfully,
Court of Compassion`;

        const htmlBody = `
          <p>${htmlGreeting}</p>

          <p>
            <strong>${campaign.guestName}</strong>${organizationText}
            has invited you to review a finalized Court of Compassion interview.
          </p>

          <p>
            <strong>Interview:</strong><br>
            ${recordingTitle}
          </p>

          <p>
            <a href="${mediaPageUrl}">
              Open the Interview Media Page
            </a>
          </p>

          <p>The page includes:</p>

          <ul>
            <li>The finalized interview recording</li>
            <li>The accompanying podcast</li>
            <li>The Court Study request form</li>
          </ul>

          <p>
            After reviewing the interview, you may request a Court Study
            session for your congregation or church group.
          </p>

          <p>
            Respectfully,<br>
            <strong>Court of Compassion</strong>
          </p>
        `;

        try {
          await sendEmail(
            pastorEmail,
            subject,
            plainTextBody,
            htmlBody
          );

          const sentInvitation =
            await prisma.pastorInvitation.update({
              where: { id: invitation.id },
              data: {
                status: "SENT",
                sentAt: new Date(),
                errorMessage: null,
              },
            });

          results.push(sentInvitation);
        } catch (emailErr) {
          console.error(
            `❌ Pastor invitation email failed for ${pastorEmail}:`,
            emailErr
          );

          const failedInvitation =
            await prisma.pastorInvitation.update({
              where: { id: invitation.id },
              data: {
                status: "FAILED",
                errorMessage: String(emailErr),
              },
            });

          results.push(failedInvitation);
        }
      }

      const sentCount = results.filter(
        (item) => item.status === "SENT"
      ).length;

      const failedCount = results.filter(
        (item) => item.status === "FAILED"
      ).length;

      return res.status(200).send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Invitations Processed</title>
  <style>
    body {
      margin: 0;
      padding: 32px 16px;
      background: #061b33;
      color: #ffffff;
      font-family: Arial, Helvetica, sans-serif;
    }

    .card {
      width: 100%;
      max-width: 680px;
      margin: 0 auto;
      padding: 28px;
      background: #15345a;
      border: 1px solid #d9b84f;
      border-radius: 14px;
    }

    h1 { color: #e5c35b; }

    a {
      display: inline-block;
      margin-top: 18px;
      padding: 12px 18px;
      border-radius: 7px;
      background: #e5c35b;
      color: #071a31;
      font-weight: 700;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <section class="card">
    <h1>Pastor Invitations Processed</h1>

    <p><strong>Successfully sent:</strong> ${sentCount}</p>
    <p><strong>Failed:</strong> ${failedCount}</p>

    <a href="/guest-distribution/${encodeURIComponent(
      distributionToken
    )}/invite">
      Invite Additional Pastors
    </a>
  </section>
</body>
</html>
      `);
    } catch (err) {
      console.error("❌ POST pastor invitations error:", err);

      return res
        .status(500)
        .send("The pastor invitations could not be processed.");
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

    const podcastUrl = safeWebUrl(
      campaign.recording.podcastUrl
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
  podcastUrl
    ? `
      <p>
        <a
          class="button"
          href="${podcastUrl}"
          target="_blank"
          rel="noopener noreferrer"
        >
          Listen to the Podcast
        </a>
      </p>
    `
    : ""
}

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

<button
  type="button"
  id="courtStudyToggle"
  aria-expanded="false"
  aria-controls="courtStudyFormContainer"
>
  Request a Court Study Session
</button>

<div id="courtStudyFormContainer" style="display: none;"> 

      <p>
        A pastor, priest, or church leader may request a
        Court Study session centered on this recorded interview.
      </p>

      <p>
        The session may be hosted by the Court, hosted by the
        church leader, conducted in person, or arranged as a
        hybrid meeting.
      </p>

      <p>
  <strong>
    This form should be completed by the pastor, priest, or church leader requesting the Court Study session.
  </strong>
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
     </div>
    </section>
 <p style="margin-top: 24px;">
  <a
    href="/guest-distribution/${encodeURIComponent(distributionToken)}/invite"
    style="
      display: inline-block;
      padding: 12px 18px;
      border: 1px solid #e5c35b;
      border-radius: 7px;
      color: #ffffff;
      text-decoration: none;
      font-weight: 700;
    "
  >
    Invite Additional Pastors or Church Leaders
  </a>
</p>
  
  </main>

<script>
  const courtStudyToggle = document.getElementById("courtStudyToggle");
  const courtStudyFormContainer = document.getElementById(
    "courtStudyFormContainer"
  );

  if (courtStudyToggle && courtStudyFormContainer) {
    courtStudyToggle.addEventListener("click", () => {
      const isOpen =
        courtStudyFormContainer.style.display !== "none";

      courtStudyFormContainer.style.display = isOpen
        ? "none"
        : "block";

      courtStudyToggle.setAttribute(
        "aria-expanded",
        String(!isOpen)
      );

      courtStudyToggle.textContent = isOpen
        ? "Request a Court Study Session"
        : "Hide Court Study Request Form";
    });
  }
</script>

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

   const timezoneText = timezone
  ? String(timezone).trim()
  : "America/Los_Angeles";
      
if (preferredStart) {
  const preferredStartText = String(preferredStart).trim();
 
  const match = preferredStartText.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/
  );

  if (!match) {
    return res.status(400).send(
      "The preferred date and time are invalid."
    );
  }

  const [, year, month, day, hour, minute] = match;

  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezoneText,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });

    const desiredUtc = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      0
    );

    let utcGuess = desiredUtc;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const parts = formatter.formatToParts(new Date(utcGuess));
      const values = Object.fromEntries(
        parts
          .filter((part) => part.type !== "literal")
          .map((part) => [part.type, part.value])
      );

      const displayedAsUtc = Date.UTC(
        Number(values.year),
        Number(values.month) - 1,
        Number(values.day),
        Number(values.hour),
        Number(values.minute),
        Number(values.second)
      );

      utcGuess += desiredUtc - displayedAsUtc;
    }

    parsedPreferredStart = new Date(utcGuess);

    if (Number.isNaN(parsedPreferredStart.getTime())) {
      throw new Error("Invalid converted date");
    }
  } catch {
    return res.status(400).send(
      "The time zone or preferred date and time are invalid."
    );
  }
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
            timezone: timezoneText,
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

           // Send a confirmation receipt to the person who submitted the request.
      // Email failure must not erase or duplicate the successfully created request.
      try {
        const readablePreferredStart = request.preferredStart
          ? new Intl.DateTimeFormat("en-US", {
              timeZone:
                request.timezone || "America/Los_Angeles",
              weekday: "long",
              year: "numeric",
              month: "long",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
              timeZoneName: "short",
            }).format(new Date(request.preferredStart))
          : "Not provided";

        const meetingFormatLabels = {
          COURT_HOSTED: "Court-hosted online session",
          PASTOR_HOSTED: "Pastor-hosted online session",
          COMMUNITY_HOSTED: "Community-hosted online session",
          IN_PERSON: "In-person session",
          HYBRID: "Hybrid session",
        };

        const readableMeetingFormat =
          meetingFormatLabels[request.meetingFormat] ||
          request.meetingFormat ||
          "Not provided";

        const confirmationSubject =
          `Court Study Request Received — ${
            campaign.recording.title ||
            "Court of Compassion Interview Recording"
          }`;

        const confirmationBody = [
          `Dear ${request.pastorName},`,
          "",
          `The Court of Compassion has received the Court Study request you submitted on behalf of ${request.churchName}.`,
          "",
          "Interview recording:",
          campaign.recording.title ||
            "Court of Compassion Interview Recording",
          "",
          "Preferred date and time:",
          readablePreferredStart,
          "",
          "Time zone:",
          request.timezone || "Not provided",
          "",
          "Requested meeting format:",
          readableMeetingFormat,
          "",
          "Estimated attendance:",
          request.estimatedAttendance != null
            ? String(request.estimatedAttendance)
            : "Not provided",
          "",
          "Current status:",
          "PENDING",
          "",
          "Request reference:",
          request.id,
          "",
          "The Court will review your request before approving, declining, or scheduling the session.",
          "",
          "Please retain this request reference for future communication.",
          "",
          "Respectfully,",
          "Court of Compassion",
        ].join("\n");

        await sendEmail(
          request.pastorEmail,
          confirmationSubject,
          confirmationBody
        );

        console.log(
          "✅ COURT STUDY REQUEST CONFIRMATION SENT:",
          request.id,
          request.pastorEmail
        );
      } catch (emailError) {
        console.error(
          "❌ COURT STUDY REQUEST CONFIRMATION EMAIL FAILED:",
          request.id,
          emailError
        );
      } 

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
  request you submitted on behalf of
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

// ======================================================
// Public: submit an inclusive Court Study request
// ======================================================
app.post(
  "/api/court-study-requests",
  express.json(),
  async (req, res) => {
    try {
      const body = req.body || {};

      const cleanText = (value) =>
        typeof value === "string" ? value.trim() : "";

      const organizerName = cleanText(body.organizerName);
      const organizerEmail = cleanText(body.organizerEmail);
      const organizerPhone = cleanText(body.organizerPhone);
      const organizerRole = cleanText(body.organizerRole);

      const hostGroupName = cleanText(body.hostGroupName);
      const hostGroupType = cleanText(body.hostGroupType);
      const rawHostMode = cleanText(body.hostMode);
      const hostGroupWebsite = cleanText(body.hostGroupWebsite);
      const hostGroupCity = cleanText(body.hostGroupCity);
      const hostGroupState = cleanText(body.hostGroupState);
      const hostGroupZip = cleanText(body.hostGroupZip);
      const hostGroupCountry = cleanText(body.hostGroupCountry);
      
      const preferredStartInput = cleanText(body.preferredStart);

let preferredDate = cleanText(body.preferredDate);
let preferredTime = cleanText(body.preferredTime);

if ((!preferredDate || !preferredTime) && preferredStartInput) {
  const preferredStartMatch = preferredStartInput.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/
  );

  if (preferredStartMatch) {
    preferredDate = preferredDate || preferredStartMatch[1];
    preferredTime = preferredTime || preferredStartMatch[2];
  }
}

const timezoneInput = cleanText(body.timezone);

      const rawSessionFormat = cleanText(
        body.meetingFormat ?? body.format
      );

      const normalizedHostMode = rawHostMode
  ? rawHostMode.toUpperCase().replace(/[\s-]+/g, "_")
  : hostGroupType.toLowerCase() === "church"
    ? "PASTOR_HOSTED"
    : "COMMUNITY_HOSTED";

const allowedHostModes = new Set([
  "PASTOR_HOSTED",
  "COMMUNITY_HOSTED",
]);

if (
  normalizedHostMode &&
  !allowedHostModes.has(normalizedHostMode)
) {
  return res.status(400).json({
    success: false,
    error:
      "Host mode must be Pastor Hosted or Community Hosted.",
  });
}
      
      if (
        !organizerName ||
        !organizerEmail ||
        !hostGroupName ||
        !hostGroupType ||
        !preferredDate ||
        !preferredTime ||
        !timezoneInput ||
        !rawSessionFormat
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Organizer name, organizer email, host group, group type, preferred date, preferred time, time zone, and format are required.",
        });
      }

      const timezoneAliases = {
        "PACIFIC TIME": "America/Los_Angeles",
        "MOUNTAIN TIME": "America/Denver",
        "CENTRAL TIME": "America/Chicago",
        "EASTERN TIME": "America/New_York",
        "ALASKA TIME": "America/Anchorage",
        "HAWAII TIME": "Pacific/Honolulu",
      };

      const timezone =
        timezoneAliases[timezoneInput.toUpperCase()] ||
        timezoneInput;

      const preferredStart = parseDateTimeInTimeZone(
        `${preferredDate}T${preferredTime}`,
        timezone
      );

      if (
        !(preferredStart instanceof Date) ||
        Number.isNaN(preferredStart.getTime())
      ) {
        return res.status(400).json({
          success: false,
          error:
            "The preferred date, time, or time zone could not be interpreted.",
        });
      }

      const focusKey = cleanText(body.studyFocusType).toUpperCase();

      const focusMap = {
        RULES_OF_COURT_PROCEDURE: "RULES_OF_PROCEDURE",
        RULES_OF_PROCEDURE: "RULES_OF_PROCEDURE",
        INTERVIEW_RECORDING: "INTERVIEW_RECORDING",
        COMPLETED_INTERVIEW: "INTERVIEW_RECORDING",
      };

      const studyFocusType = focusMap[focusKey];

      if (!studyFocusType) {
        return res.status(400).json({
          success: false,
          error: "A valid Court Study focus is required.",
        });
      }

      let selectedRulesSections = [];

      if (Array.isArray(body.selectedRulesSections)) {
        selectedRulesSections = body.selectedRulesSections;
      } else if (
        typeof body.selectedRulesSections === "string" &&
        body.selectedRulesSections.trim()
      ) {
        try {
          const parsedSections = JSON.parse(
            body.selectedRulesSections
          );

          if (!Array.isArray(parsedSections)) {
            return res.status(400).json({
              success: false,
              error:
                "Selected Rules sections must be supplied as an array.",
            });
          }

          selectedRulesSections = parsedSections;
        } catch {
          return res.status(400).json({
            success: false,
            error:
              "Selected Rules sections contain invalid JSON.",
          });
        }
      }

      if (
        studyFocusType === "RULES_OF_PROCEDURE" &&
        selectedRulesSections.length === 0
      ) {
        return res.status(400).json({
          success: false,
          error:
            "At least one Rules of Court Procedure section must be selected.",
        });
      }

      const formatKey = rawSessionFormat
        .toUpperCase()
        .replace(/[\s-]+/g, "_");

      const sessionFormatMap = {
        ONLINE: "ONLINE",
        IN_PERSON: "IN_PERSON",
        HYBRID: "HYBRID",
      };

      const legacyMeetingFormatMap = {
  ONLINE: normalizedHostMode || "PASTOR_HOSTED",
  IN_PERSON: "IN_PERSON",
  HYBRID: normalizedHostMode || "PASTOR_HOSTED",
};

      const sessionFormat = sessionFormatMap[formatKey];
      const meetingFormat =
        legacyMeetingFormatMap[formatKey];

      console.log("COURT STUDY HOST MODE DEBUG:", {
  hostGroupType,
  rawHostMode,
  normalizedHostMode,
  rawSessionFormat,
  formatKey,
  sessionFormat,
  meetingFormat,
});
      
      if (!sessionFormat || !meetingFormat) {
        return res.status(400).json({
          success: false,
          error:
            "Format must be Online, In Person, or Hybrid.",
        });
      }

      let estimatedAttendance = null;

      if (
        body.estimatedAttendance !== undefined &&
        body.estimatedAttendance !== null &&
        String(body.estimatedAttendance).trim() !== ""
      ) {
        estimatedAttendance = Number.parseInt(
          String(body.estimatedAttendance),
          10
        );

        if (
          !Number.isInteger(estimatedAttendance) ||
          estimatedAttendance < 1
        ) {
          return res.status(400).json({
            success: false,
            error:
              "Expected number of participants must be a positive whole number.",
          });
        }
      }

      const request =
        await prisma.courtStudyRequest.create({
          data: {
            // Legacy fallbacks preserve the existing admin workflow.
            pastorName: organizerName,
            pastorEmail: organizerEmail,
            roleTitle: organizerRole || null,
            churchName: hostGroupName,
            dioceseOrGroup: hostGroupName,
            phone: organizerPhone || null,

            // Inclusive organizer information.
            organizerName,
            organizerEmail,
            organizerPhone: organizerPhone || null,
            organizerRole: organizerRole || null,

            // Host group or community.
            hostGroupName,
            hostGroupType,
            hostGroupWebsite: hostGroupWebsite || null,
            hostGroupCity: hostGroupCity || null,
            hostGroupState: hostGroupState || null,
            hostGroupZip: hostGroupZip || null,
            hostGroupCountry: hostGroupCountry || null,

            // Study material.
            studyFocusType,
            selectedRulesSections,

            // Requested session details.
            preferredStart,
            timezone,
            meetingFormat,
            sessionFormat,
            estimatedAttendance,
            notes: cleanText(body.notes) || null,

            status: "PENDING",
          },
        });

      // Send a receipt confirmation without allowing an email failure
// to undo the successfully saved Court Study request.
let confirmationEmailSent = false;

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

  let readablePreferredStart = "Not specified";

  try {
    if (
      preferredStart instanceof Date &&
      !Number.isNaN(preferredStart.getTime())
    ) {
      readablePreferredStart = preferredStart.toLocaleString("en-US", {
        timeZone: timezone,
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      });
    }
  } catch (dateFormatError) {
    readablePreferredStart =
      preferredStart instanceof Date
        ? preferredStart.toISOString()
        : String(preferredStart || "Not specified");
  }

  const selectedMaterialText =
    Array.isArray(selectedRulesSections) &&
    selectedRulesSections.length > 0
      ? selectedRulesSections
          .map((section, index) => {
            const chapter =
              section?.chapterTitle || section?.chapterId || "";
            const title =
              section?.sectionTitle ||
              section?.videoTitle ||
              section?.sectionId ||
              section?.id ||
              "Selected section";

            return `${index + 1}. ${
              chapter ? `${chapter} — ` : ""
            }${title}`;
          })
          .join("\n")
      : "No specific Rules sections were listed.";

  const readableStudyFocus =
    typeof studyFocusType === "string"
      ? studyFocusType.replaceAll("_", " ")
      : "Court Study";

  const readableFormat =
    sessionFormat || meetingFormat || "Not specified";

  const confirmationText = [
    `Dear ${organizerName},`,
    "",
    "Thank you. We have received your Court Study request.",
    "",
    `Request reference: ${request.id}`,
    `Organizer: ${organizerName}`,
    `Host group or community: ${hostGroupName}`,
    `Group type: ${hostGroupType}`,
    `Study focus: ${readableStudyFocus}`,
    `Preferred session time: ${readablePreferredStart}`,
    `Format: ${readableFormat}`,
    `Estimated attendance: ${
      estimatedAttendance ?? "Not specified"
    }`,
    "",
    "Selected Court Study material:",
    selectedMaterialText,
    "",
    "Your request is now pending administrative review. This confirmation acknowledges receipt of the request; it does not yet mean that the request has been approved or scheduled.",
    "",
    "Court of Compassion",
  ].join("\n");

  const confirmationHtmlBody = confirmationText
  .split("\n")
  .map((line) => {
    const safeLine = String(line || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");

    return safeLine
      ? `<div style="margin:0 0 8px 0;">${safeLine}</div>`
      : `<div style="height:8px;line-height:8px;">&nbsp;</div>`;
  })
  .join("");

const confirmationHtml = `
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f7f2e9;font-family:Arial,Helvetica,sans-serif;color:#172554;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f7f2e9;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">

            <tr>
              <td style="background:#0b2a68;padding:28px 32px;text-align:center;">
               <img
  src="https://static.wixstatic.com/media/2ccb97_745227d9536b452b83a82556e6c5a430~mv2.png"
  alt="Court of Compassion Seal"
  width="96"
  height="96"
  style="display:block;width:96px;height:96px;margin:0 auto 14px auto;border-radius:50%;border:2px solid #d8b24c;background:#ffffff;"
/> 
                <div style="font-size:12px;letter-spacing:2px;color:#d8b24c;font-weight:700;margin-bottom:8px;">
                  COURT OF COMPASSION
                </div>
                <div style="font-size:26px;line-height:34px;color:#ffffff;font-weight:700;">
                  Court Study Request Received
                </div>
              </td>
            </tr>

            <tr>
              <td style="padding:0 32px;">
                <div style="height:4px;background:#d8b24c;"></div>
              </td>
            </tr>

            <tr>
              <td style="padding:28px 32px 12px 32px;">
                <div style="display:inline-block;background:#eef8f0;border:1px solid #b7dfbf;border-radius:999px;padding:7px 12px;font-size:12px;font-weight:700;color:#176534;">
                  PENDING ADMINISTRATIVE REVIEW
                </div>
              </td>
            </tr>

            <tr>
              <td style="padding:12px 32px 28px 32px;font-size:15px;line-height:23px;color:#24324a;">
                ${confirmationHtmlBody}
              </td>
            </tr>

            <tr>
              <td style="padding:0 32px;">
                <div style="border-top:1px solid #e5e7eb;"></div>
              </td>
            </tr>

            <tr>
              <td style="padding:22px 32px 28px 32px;text-align:center;">
                <div style="font-size:13px;font-weight:700;color:#0b2a68;margin-bottom:6px;">
                  Court of Compassion
                </div>
                <div style="font-size:12px;line-height:18px;color:#6b7280;">
                  Justice • Truth • Social Relevance
                </div>
                <div style="font-size:11px;line-height:17px;color:#9ca3af;margin-top:10px;">
                  This is an automated confirmation that your Court Study request was received.
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
  
  await transporter.sendMail({
    from: `"Court of Compassion" <${process.env.GMAIL_USER}>`,
    to: organizerEmail,
    subject: "Court Study Request Received",
    text: confirmationText,
html: confirmationHtml,
replyTo: process.env.GMAIL_USER,
  });

  confirmationEmailSent = true;

  console.log(
    `✅ Court Study confirmation email sent for request ${request.id}`
  );
} catch (emailError) {
  console.error(
    `⚠️ Court Study request ${request.id} was saved, but its confirmation email failed:`,
    emailError
  );
}
      
      return res.status(201).json({
        success: true,
        message:
          "Court Study request submitted successfully.",
        confirmationEmailSent,
        request: {
          id: request.id,
          status: request.status,
        },
      });
    } catch (error) {
      console.error(
        "❌ Public Court Study request submission failed:",
        error
      );

      return res.status(500).json({
        success: false,
        error:
          "Court Study request could not be submitted.",
      });
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
        "AWAITING_MEETING_DETAILS",
        "MEETING_DETAILS_SUBMITTED",
        "MEETING_APPROVED",
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
           courtStudyMeeting: true, 
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

async function sendCommunityHostedZoomApprovalEmail({
  requestId,
  organizerName,
  organizerEmail,
  hostGroupName,
  preferredStart,
  timezone,
}) {
  const safeOrganizerName =
    String(organizerName || "").trim() || "Court Study Organizer";

  const safeOrganizerEmail =
    String(organizerEmail || "").trim();

  const safeHostGroupName =
    String(hostGroupName || "").trim() || "your group or community";

  if (!safeOrganizerEmail) {
    throw new Error(
      "Cannot send Zoom connection email because organizerEmail is missing."
    );
  }

  const connectZoomUrl =
    `https://api.courtofcompassion.com/court-study/zoom/authorize-organizer/` +
    encodeURIComponent(requestId);

  let readableSessionTime = "the approved session time";

  if (preferredStart) {
    try {
      readableSessionTime =
        new Intl.DateTimeFormat("en-US", {
          timeZone:
            String(timezone || "").trim() ||
            "America/Los_Angeles",
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        }).format(new Date(preferredStart));
    } catch (dateError) {
      console.warn(
        "Could not format approved Court Study session time:",
        dateError
      );
    }
  }

  const text = [
    `Dear ${safeOrganizerName},`,
    "",
    "Your Court of Compassion Court Study request has been approved.",
    "",
    `Host group or community: ${safeHostGroupName}`,
    `Approved session: ${readableSessionTime}`,
  "",
"Before you continue, open Zoom in a new browser tab and sign in to the Zoom account you want to use to host this Court Study.",
"",
"Leave that Zoom account signed in, return to this email, and then select Continue to Zoom below. When the Zoom connection is complete, Zoom will automatically return you to Court of Compassion, where your Court Study setup will continue.",
"",
"Important: Keep the Zoom account you want to use signed in while you continue. Do not switch Zoom accounts until Zoom returns you to Court of Compassion. Court of Compassion will then create and configure the Court Study meeting in the Zoom account you connected. You do not need to create the meeting yourself.",
"",
    `Continue to Zoom: ${connectZoomUrl}`,
    "",
    "Court of Compassion",
  ].join("\n");

  const html = `
<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f7f2e9;font-family:Arial,Helvetica,sans-serif;color:#24324a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f7f2e9;padding:32px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden;">
          <tr>
            <td style="background:#0b2a68;padding:28px 32px;text-align:center;">
              <img
                src="https://static.wixstatic.com/media/2ccb97_745227d9536b452b83a82556e6c5a430~mv2.png"
                alt="Court of Compassion Seal"
                width="96"
                height="96"
                style="display:block;width:96px;height:96px;margin:0 auto 14px auto;border-radius:50%;border:2px solid #d8b24c;background:#ffffff;"
              />
              <div style="font-size:12px;letter-spacing:2px;color:#d8b24c;font-weight:700;margin-bottom:8px;">
                COURT OF COMPASSION
              </div>
              <div style="font-size:26px;line-height:34px;color:#ffffff;font-weight:700;">
                Court Study Approved
              </div>
            </td>
          </tr>

          <tr>
            <td style="padding:0 32px;">
              <div style="height:4px;background:#d8b24c;"></div>
            </td>
          </tr>

          <tr>
            <td style="padding:28px 32px;font-size:15px;line-height:23px;color:#24324a;">
              <p>Dear ${safeOrganizerName},</p>

              <p>
                Your Court of Compassion Court Study request has been
                <strong>approved</strong>.
              </p>

              <p>
                <strong>Host Group or Community:</strong> ${safeHostGroupName}<br />
                <strong>Approved Session:</strong> ${readableSessionTime}
              </p>

              <p>
                The next step is to connect the Zoom account that will host
                this Court Study.
              </p>

              <p>
  Before you continue, open Zoom in a new browser tab and sign in to
  the Zoom account you want to use to host this Court Study.
  Leave that Zoom account signed in, return to this email, and then
  click Continue to Zoom below. When the Zoom connection is complete,
  Zoom will automatically return you to Court of Compassion, where
  your Court Study setup will continue.
</p>

              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0;">
                <tr>
                  <td style="background:#0b2a68;border-radius:5px;">
                    <a
                      href="${connectZoomUrl}"
                      style="display:inline-block;padding:13px 22px;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;"
                    >
                     Continue to Zoom 
                    </a>
                  </td>
                </tr>
              </table>

              <p style="font-size:13px;color:#667085;">
  <strong>Important:</strong> Keep the Zoom account you want to use
  signed in while you click Continue to Zoom. Do not switch Zoom accounts
  until Zoom returns you to Court of Compassion. Court of Compassion will
  then create and configure the Court Study meeting in the Zoom account
  you connected. You do not need to create the meeting yourself.
</p>

              <hr style="border:0;border-top:1px solid #e5e7eb;margin:26px 0 18px;" />

              <div style="text-align:center;color:#667085;font-size:12px;line-height:19px;">
                <strong style="color:#0b2a68;">Court of Compassion</strong><br />
                Justice • Truth • Social Relevance
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
    to: safeOrganizerEmail,
    subject: "Court Study Approved — Connect Your Zoom Account",
    text,
    html,
    replyTo: process.env.GMAIL_USER,
  });

  console.log(
    `✅ Court Study Zoom connection email sent for request ${requestId}`
  );
}

// =====================================================
// Admin: update Court Study request status
// =====================================================
app.patch(
  "/api/court-study-requests/:id/status",
  requireAdminToken,
  async (req, res) => {
    try {
      const requestId = String(req.params.id || "").trim();

      const requestedStatus = req.body?.status
        ? String(req.body.status).trim().toUpperCase()
        : "";

      if (!requestId) {
        return res.status(400).json({
          success: false,
          error: "Court Study request ID is required",
        });
      }

      const allowedStatuses = new Set([
  "PENDING",
  "APPROVED",
  "AWAITING_MEETING_DETAILS",
  "MEETING_DETAILS_SUBMITTED",
  "MEETING_APPROVED",
  "DECLINED",
  "SCHEDULED",
  "COMPLETED",
  "CANCELLED",
]);

      if (!allowedStatuses.has(requestedStatus)) {
        return res.status(400).json({
          success: false,
        error:
  "Status must be PENDING, APPROVED, AWAITING_MEETING_DETAILS, MEETING_DETAILS_SUBMITTED, MEETING_APPROVED, DECLINED, SCHEDULED, COMPLETED, or CANCELLED",  
        });
      }

      const existingRequest =
        await prisma.courtStudyRequest.findUnique({
          where: {
            id: requestId,
          },
          include: {
            recording: true,
            campaign: true,
          },
        });

      if (!existingRequest) {
        return res.status(404).json({
          success: false,
          error: "Court Study request not found",
        });
      }

      const updatedRequest =
        await prisma.courtStudyRequest.update({
          where: {
            id: requestId,
          },
          data: {
            status: requestedStatus,
          },
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
        });

      let zoomConnectionEmailSent = false;
let zoomConnectionEmailError = null;

if (
  requestedStatus === "APPROVED" &&
  String(existingRequest.meetingFormat || "")
    .trim()
    .toUpperCase() === "COMMUNITY_HOSTED" &&
  String(existingRequest.status || "")
    .trim()
    .toUpperCase() !== "APPROVED"
) {
  try {
    await sendCommunityHostedZoomApprovalEmail({
      requestId,
      organizerName:
        existingRequest.organizerName ||
        existingRequest.pastorName ||
        "",
      organizerEmail:
        existingRequest.organizerEmail ||
        existingRequest.pastorEmail ||
        "",
      hostGroupName:
        existingRequest.hostGroupName ||
        existingRequest.churchName ||
        "",
      preferredStart: existingRequest.preferredStart,
      timezone: existingRequest.timezone,
    });

    zoomConnectionEmailSent = true;
  } catch (emailError) {
    zoomConnectionEmailError = String(
      emailError?.message || emailError
    );

    console.error(
      "❌ COURT STUDY ZOOM APPROVAL EMAIL FAILED:",
      requestId,
      emailError
    );
  }
}
      
    return res.status(200).json({
  success: true,
  message: `Court Study request status changed to ${requestedStatus}`,
  request: updatedRequest,
  zoomConnectionEmailSent,
  zoomConnectionEmailError,
});  
    } catch (err) {
      console.error(
        "❌ PATCH /api/court-study-requests/:id/status error:",
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
// Admin: schedule an approved Court Study request
// =====================================================
async function scheduleCourtStudyInternal({
  requestId,
  scheduledStart,
  scheduledEnd,
  timezone,
  title,
  description,
}) {
  if (!requestId) {
    return {
      success: false,
      statusCode: 400,
      error: "Court Study request ID is required",
    };
  }

  if (!scheduledStart || !scheduledEnd || !timezone) {
    return {
      success: false,
      statusCode: 400,
      error:
        "scheduledStart, scheduledEnd, and timezone are required",
    };
  }

  const parsedStart = parseDateTimeInTimeZone(
    scheduledStart,
    timezone
  );

  const parsedEnd = parseDateTimeInTimeZone(
    scheduledEnd,
    timezone
  );

  if (Number.isNaN(parsedStart.getTime())) {
    return {
      success: false,
      statusCode: 400,
      error: "scheduledStart is not a valid date and time",
    };
  }

  if (Number.isNaN(parsedEnd.getTime())) {
    return {
      success: false,
      statusCode: 400,
      error: "scheduledEnd is not a valid date and time",
    };
  }

  if (parsedEnd.getTime() <= parsedStart.getTime()) {
    return {
      success: false,
      statusCode: 400,
      error: "scheduledEnd must be later than scheduledStart",
    };
  }

  const courtStudyRequest =
    await prisma.courtStudyRequest.findUnique({
      where: {
        id: requestId,
      },
      include: {
        recording: true,
        campaign: true,
        courtStudyMeeting: true,
      },
    });

  if (!courtStudyRequest) {
    return {
      success: false,
      statusCode: 404,
      error: "Court Study request not found",
    };
  }

  const canScheduleCourtStudy =
    courtStudyRequest.status === "APPROVED" ||
    (
      courtStudyRequest.meetingFormat === "COMMUNITY_HOSTED" &&
      courtStudyRequest.status === "ZOOM_CONNECTED"
    );

  if (!canScheduleCourtStudy) {
    return {
      success: false,
      statusCode: 400,
      error:
        "The Court Study request must be APPROVED, or have Zoom connected for a community-hosted session, before it can be scheduled",
    };
  }

  if (courtStudyRequest.courtStudyMeeting) {
    return {
      success: false,
      statusCode: 409,
      error:
        "A Court Study meeting has already been created for this request",
      meeting: courtStudyRequest.courtStudyMeeting,
    };
  }

  const isRulesStudy =
    courtStudyRequest.studyFocusType === "RULES_OF_PROCEDURE";

  const organizerDisplayName =
    courtStudyRequest.organizerName ||
    courtStudyRequest.pastorName ||
    "Court Study organizer";

  const hostDisplayName =
    courtStudyRequest.hostGroupName ||
    courtStudyRequest.churchName ||
    "host group";

  const studyMaterialTitle = isRulesStudy
    ? "Rules of Court Procedure"
    : courtStudyRequest.recording?.title ||
      "Court of Compassion Interview";

  const meetingTitle =
    title && String(title).trim()
      ? String(title).trim()
      : `Court Study - ${studyMaterialTitle}`;

  const meetingDescription =
    description && String(description).trim()
      ? String(description).trim()
      : isRulesStudy
        ? `Court Study session requested by ${organizerDisplayName} of ${hostDisplayName}, based on the Rules of Court Procedure.`
        : `Court Study session requested by ${organizerDisplayName} of ${hostDisplayName}, based on the recorded interview "${studyMaterialTitle}".`;

  const result = await prisma.$transaction(async (tx) => {
    const meeting = await tx.courtStudyMeeting.create({
      data: {
        courtStudyRequestId: courtStudyRequest.id,
        churchContactId: null,
        timeSlotId: null,

        title: meetingTitle,
        description: meetingDescription,

        discussionType: isRulesStudy
          ? "RULES_OF_PROCEDURE"
          : "INTERVIEW_RECORDING",

        selectedChapter: null,
        selectedSection: null,

        selectedRecordingId: isRulesStudy
          ? null
          : courtStudyRequest.recordingId,

        scheduledStart: parsedStart,
        scheduledEnd: parsedEnd,
        timezone: String(timezone).trim(),

        zoomMeetingId: null,
        zoomRegistrationUrl: null,
        zoomJoinUrl: null,

        status: "SCHEDULED",
      },
    });

    const updatedRequest =
      await tx.courtStudyRequest.update({
        where: {
          id: courtStudyRequest.id,
        },
        data: {
          status: "SCHEDULED",
        },
      });

    return {
      meeting,
      request: updatedRequest,
    };
  });

  return {
    success: true,
    statusCode: 201,
    message: "Court Study session scheduled successfully",
    meeting: result.meeting,
    request: result.request,
  };
}

app.post(
  "/api/court-study-requests/:id/schedule",
  requireAdminToken,
  async (req, res) => {
    try {
      const requestId = String(
        req.params.id || ""
      ).trim();

      const {
        scheduledStart,
        scheduledEnd,
        timezone,
        title,
        description,
      } = req.body || {};

      const result =
        await scheduleCourtStudyInternal({
          requestId,
          scheduledStart,
          scheduledEnd,
          timezone,
          title,
          description,
        });

      const {
        statusCode,
        ...responseBody
      } = result;

      return res
        .status(statusCode)
        .json(responseBody);
    } catch (err) {
      console.error(
        "❌ POST /api/court-study-requests/:id/schedule error:",
        err
      );

      return res.status(500).json({
        success: false,
        error: String(err),
      });
    }
  }
);


// ==========================================================
// Create the Court Study Zoom meeting using the appropriate
// host Zoom account
// ==========================================================
async function createCourtStudyZoomInternal({
  requestId,
}) {
  try {
    requestId = String(requestId || "").trim();

    if (!requestId) {
      return {
        statusCode: 400,
        responseBody: {
          success: false,
          error: "Court Study request ID is required",
        },
      };
    }

    const courtStudyRequest =
      await prisma.courtStudyRequest.findUnique({
        where: {
          id: requestId,
        },
        include: {
          recording: true,
          campaign: true,
          courtStudyMeeting: true,
        },
      });

    if (!courtStudyRequest) {
      return {
        statusCode: 404,
        responseBody: {
          success: false,
          error: "Court Study request not found",
        },
      };
    }

    if (courtStudyRequest.status !== "SCHEDULED") {
      return {
        statusCode: 400,
        responseBody: {
          success: false,
          error:
            "The Court Study request must be SCHEDULED before creating its Zoom meeting",
        },
      };
    }

    const meeting = courtStudyRequest.courtStudyMeeting;

    if (!meeting) {
      return {
        statusCode: 404,
        responseBody: {
          success: false,
          error:
            "No scheduled Court Study meeting was found for this request",
        },
      };
    }

    if (meeting.zoomMeetingId) {
      return {
        statusCode: 409,
        responseBody: {
          success: false,
          error:
            "A Zoom meeting has already been created for this Court Study session",
          meeting,
        },
      };
    }

    const meetingFormat = courtStudyRequest.meetingFormat;

    if (
      meetingFormat !== "COURT_HOSTED" &&
      meetingFormat !== "PASTOR_HOSTED" &&
      meetingFormat !== "COMMUNITY_HOSTED" &&
      meetingFormat !== "HYBRID"
    ) {
      return {
        statusCode: 400,
        responseBody: {
          success: false,
          error:
            meetingFormat === "IN_PERSON"
              ? "This is an in-person Court Study request and does not require a Zoom meeting"
              : "This Court Study hosting mode is not supported for Zoom creation",
        },
      };
    }

    const scheduledStart = new Date(
      meeting.scheduledStart
    );

    const scheduledEnd = new Date(
      meeting.scheduledEnd
    );

    const durationMinutes = Math.max(
      1,
      Math.ceil(
        (scheduledEnd.getTime() -
          scheduledStart.getTime()) /
          60000
      )
    );

    let accessToken;

    if (
      courtStudyRequest.meetingFormat ===
      "COMMUNITY_HOSTED"
    ) {
      accessToken =
        await getCourtStudyHostZoomAccessToken({
          organizerEmail: String(
            courtStudyRequest.organizerEmail || ""
          )
            .trim()
            .toLowerCase(),
        });
    } else {
      accessToken = await getS2SAccessToken();
    }

    const zoomTimeZone =
      meeting.timezone || "America/Los_Angeles";

    const zoomTimeParts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: zoomTimeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(scheduledStart)
        .filter(
          (part) => part.type !== "literal"
        )
        .map((part) => [
          part.type,
          part.value,
        ])
    );

    const zoomStartTime =
      `${zoomTimeParts.year}-${zoomTimeParts.month}-${zoomTimeParts.day}` +
      `T${zoomTimeParts.hour}:${zoomTimeParts.minute}:${zoomTimeParts.second}`;

    const zoomPayload = {
      topic: meeting.title,
      type: 2,
      start_time: zoomStartTime,
      duration: durationMinutes,
      timezone: zoomTimeZone,
      agenda:
        meeting.description ||
        `Court Study session based on the recorded interview "${
          courtStudyRequest.recording?.title ||
          "Court of Compassion Interview"
        }".`,

      settings: {
        join_before_host: false,
        waiting_room: true,
        approval_type: 0,
        meeting_authentication: false,
        mute_upon_entry: true,
        participant_video: true,
        host_video: true,
        auto_recording: "cloud",
      },
    };

    const zoomResponse = await fetch(
      "https://api.zoom.us/v2/users/me/meetings",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type":
            "application/json",
        },
        body: JSON.stringify(zoomPayload),
      }
    );

    const zoomData = await zoomResponse
      .json()
      .catch(() => ({}));

    if (!zoomResponse.ok) {
      console.error(
        "❌ Zoom Court Study meeting creation failed:",
        zoomData
      );

      return {
        statusCode: zoomResponse.status,
        responseBody: {
          success: false,
          error:
            zoomData.message ||
            zoomData.reason ||
            "Zoom could not create the Court Study meeting",
          zoom: zoomData,
        },
      };
    }

    if (!zoomData.id || !zoomData.join_url) {
      return {
        statusCode: 502,
        responseBody: {
          success: false,
          error:
            "Zoom created an incomplete meeting response",
          zoom: zoomData,
        },
      };
    }

    const updatedMeeting =
      await prisma.courtStudyMeeting.update({
        where: {
          id: meeting.id,
        },
        data: {
          zoomMeetingId: String(zoomData.id),
          zoomRegistrationUrl:
            zoomData.registration_url || null,
          zoomJoinUrl: zoomData.join_url,
          zoomPasscode:
            zoomData.password || null,
          scheduledStart: zoomData.start_time
            ? new Date(zoomData.start_time)
            : meeting.scheduledStart,
          status: "SCHEDULED",
        },
      });

    return {
      statusCode: 201,
      responseBody: {
        success: true,
        message:
          "Court Study Zoom meeting created successfully",
        meeting: updatedMeeting,
        zoom: {
          id: String(zoomData.id),
          joinUrl: zoomData.join_url,
          registrationUrl:
            zoomData.registration_url || null,
          startTime:
            zoomData.start_time ||
            scheduledStart.toISOString(),
          duration:
            zoomData.duration ||
            durationMinutes,
          timezone:
            zoomData.timezone ||
            meeting.timezone,
        },
      },
    };
  } catch (err) {
    console.error(
      "❌ createCourtStudyZoomInternal error:",
      err
    );

    return {
      statusCode: 500,
      responseBody: {
        success: false,
        error: String(err),
      },
    };
  }
}


// ==========================================================
// Admin route: manually create the Zoom meeting
// ==========================================================
app.post(
  "/api/court-study-requests/:id/create-zoom",
  requireAdminToken,
  async (req, res) => {
    const result =
      await createCourtStudyZoomInternal({
        requestId: req.params.id,
      });

    const {
      statusCode,
      responseBody,
    } = result;

    return res
      .status(statusCode)
      .json(responseBody);
  }
);
// ==================================================
// Admin: preview the pastor Court Study invitation
// package before sending
// ==================================================
app.get(
  "/api/court-study-requests/:id/invitation-preview",
  requireAdminToken,
  async (req, res) => {
    try {
      const requestId = String(req.params.id || "").trim();

      if (!requestId) {
        return res.status(400).json({
          success: false,
          error: "Court Study request ID is required",
        });
      }

      const courtStudyRequest =
        await prisma.courtStudyRequest.findUnique({
          where: {
            id: requestId,
          },
          include: {
            recording: true,
            courtStudyMeeting: true,
          },
        });

      if (!courtStudyRequest) {
        return res.status(404).json({
          success: false,
          error: "Court Study request not found",
        });
      }

      const meeting = courtStudyRequest.courtStudyMeeting;
      const recording = courtStudyRequest.recording;

      if (!meeting) {
        return res.status(400).json({
          success: false,
          error:
            "This Court Study request does not have a scheduled meeting",
        });
      }

      let selectedRulesSections = [];

try {
  const rawSelectedRulesSections =
    courtStudyRequest.selectedRulesSections;

  if (Array.isArray(rawSelectedRulesSections)) {
    selectedRulesSections = rawSelectedRulesSections;
  } else if (
    typeof rawSelectedRulesSections === "string" &&
    rawSelectedRulesSections.trim()
  ) {
    const parsedSelectedRulesSections =
      JSON.parse(rawSelectedRulesSections);

    selectedRulesSections = Array.isArray(
      parsedSelectedRulesSections
    )
      ? parsedSelectedRulesSections
      : [parsedSelectedRulesSections];
  }
} catch (parseError) {
  console.warn(
    "Could not parse selectedRulesSections for invitation preview:",
    parseError
  );
}

const selectedRulesSection =
  selectedRulesSections.find((section) =>
    String(section?.videoUrl || "").trim()
  ) ||
  selectedRulesSections[0] ||
  null;

const rulesVideoUrl = String(
  selectedRulesSection?.videoUrl || ""
).trim();

const interviewRecordingUrl = String(
  recording?.recordingUrl || ""
).trim();

const isRulesStudy = Boolean(selectedRulesSection);

const recordingUrl = isRulesStudy
  ? rulesVideoUrl
  : interviewRecordingUrl;

const podcastUrl = isRulesStudy
  ? ""
  : String(recording?.podcastUrl || "").trim();

const registrationUrl = String(
  meeting.zoomRegistrationUrl || ""
).trim();

const missingFields = [];

if (!recordingUrl) {
  missingFields.push(
    isRulesStudy
      ? "selectedRulesSection.videoUrl"
      : "recordingUrl"
  );
}

if (!registrationUrl) {
  missingFields.push("zoomRegistrationUrl");
}

if (missingFields.length > 0) {
  return res.status(400).json({
    success: false,
    error:
      "The invitation package is not ready because required links are missing",
    missingFields,
  });
}

const timezone =
  meeting.timezone ||
  courtStudyRequest.timezone ||
  "America/Los_Angeles";

const scheduledStart = new Date(
  meeting.scheduledStart
);

const formattedDateTime =
  new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(scheduledStart);

const timezoneLabel =
  timezone === "America/Los_Angeles"
    ? "Pacific Time"
    : timezone;

const readableSessionTime =
  `${formattedDateTime} (${timezoneLabel})`;

const pastorName =
  courtStudyRequest.organizerName ||
  courtStudyRequest.pastorName;

const pastorEmail =
  courtStudyRequest.organizerEmail ||
  courtStudyRequest.pastorEmail;

const churchName =
  courtStudyRequest.hostGroupName ||
  courtStudyRequest.churchName;

const interviewTitle = isRulesStudy
  ? [
      selectedRulesSection?.chapterTitle,
      selectedRulesSection?.sectionTitle,
    ]
      .filter(Boolean)
      .join(" — ") ||
    meeting.title ||
    "Court Study"
  : recording?.title ||
    meeting.title ||
    "Court of Compassion Interview";

     const memberInvitationText = isRulesStudy
  ? [
      `You are invited to participate in a Court of Compassion Court Study session hosted by ${churchName}.`,
      "",
      `Study Material: ${interviewTitle}`,
      ...(recordingUrl
        ? [
            "",
           "Watch the Selected Court Study Video:", 
            recordingUrl,
          ]
        : []),
      "",
      `Session: ${readableSessionTime}`,
      "",
      "Register for the Zoom Court Study Session:",
      registrationUrl,
      "",
      "Important: Each participant must register separately using the registration link above. Zoom will send each registered participant a personal confirmation email and unique join link.",
    ].join("\n")
  : [
      `You are invited to participate in a Court of Compassion Court Study session hosted by ${churchName}.`,
      "",
      `Interview: ${interviewTitle}`,
      `Session: ${readableSessionTime}`,
      "",
      "Watch the Interview Recording:",
      recordingUrl,
      "",
      ...(podcastUrl
        ? [
            "Listen to the Podcast:",
            podcastUrl,
            "",
          ]
        : []),
      "Register for the Zoom Court Study Session:",
      registrationUrl,
      "",
      "Important: Each participant must register separately using the registration link above. Zoom will send each registered participant a personal confirmation email and unique join link.",
    ].join("\n"); 
      
      return res.status(200).json({
        success: true,
        invitation: {
          courtStudyRequestId: courtStudyRequest.id,
          meetingId: meeting.id,
          pastorName,
          pastorEmail,
          churchName,
          interviewTitle,
          recordingUrl,
          podcastUrl: podcastUrl || null,
          registrationUrl,
          scheduledStart:
            meeting.scheduledStart.toISOString(),
          scheduledEnd:
            meeting.scheduledEnd.toISOString(),
          timezone,
          timezoneLabel,
          readableSessionTime,
          memberInvitationText,
          delivery: {
            invitationSentAt:
              meeting.invitationSentAt,
            invitationSentTo:
              meeting.invitationSentTo,
            invitationSendCount:
              meeting.invitationSendCount,
            invitationLastError:
              meeting.invitationLastError,
            publicInvitationToken:
              meeting.publicInvitationToken,
          },
          warnings: podcastUrl
            ? []
            : ["This recording does not have a podcast URL"],
        },
      });
    } catch (err) {
      console.error(
        "❌ GET /api/court-study-requests/:id/invitation-preview error:",
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
// Public: get Court Study participant invitation by token
// =====================================================
app.get(
  "/api/court-study/public-invitation/:token",
  async (req, res) => {
    try {
      const token = String(req.params.token || "").trim();

      if (!token) {
        return res.status(400).json({
          success: false,
          error: "Invitation token is required",
        });
      }

      const meeting = await prisma.courtStudyMeeting.findUnique({
        where: {
          publicInvitationToken: token,
        },
        include: {
          courtStudyRequest: {
            include: {
              recording: true,
            },
          },
        },
      });

      if (!meeting || !meeting.courtStudyRequest) {
        return res.status(404).json({
          success: false,
          error: "Court Study invitation not found",
        });
      }

      const courtStudyRequest = meeting.courtStudyRequest;
      const recording = courtStudyRequest.recording;

      let selectedRulesSections = [];

      try {
        const rawSelectedRulesSections =
          courtStudyRequest.selectedRulesSections;

        if (Array.isArray(rawSelectedRulesSections)) {
          selectedRulesSections = rawSelectedRulesSections;
        } else if (
          typeof rawSelectedRulesSections === "string" &&
          rawSelectedRulesSections.trim()
        ) {
          const parsedSelectedRulesSections =
            JSON.parse(rawSelectedRulesSections);

          selectedRulesSections = Array.isArray(
            parsedSelectedRulesSections
          )
            ? parsedSelectedRulesSections
            : [parsedSelectedRulesSections];
        }
      } catch (parseError) {
        console.warn(
          "Could not parse selectedRulesSections for public invitation:",
          parseError
        );
      }

      const selectedRulesSection =
        selectedRulesSections.find((section) =>
          String(section?.videoUrl || "").trim()
        ) ||
        selectedRulesSections[0] ||
        null;

      const isRulesStudy = Boolean(selectedRulesSection);

      const recordingUrl = isRulesStudy
        ? String(selectedRulesSection?.videoUrl || "").trim()
        : String(recording?.recordingUrl || "").trim();

      const podcastUrl = isRulesStudy
        ? ""
        : String(recording?.podcastUrl || "").trim();

      const registrationUrl = String(
        meeting.zoomRegistrationUrl || ""
      ).trim();

      const timezone =
        meeting.timezone ||
        courtStudyRequest.timezone ||
        "America/Los_Angeles";

      const scheduledStart = new Date(meeting.scheduledStart);

      const formattedDateTime =
        new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          month: "long",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        }).format(scheduledStart);

      const timezoneLabel =
        timezone === "America/Los_Angeles"
          ? "Pacific Time"
          : timezone;

      const readableSessionTime =
        `${formattedDateTime} (${timezoneLabel})`;

      const hostGroupName = String(
        courtStudyRequest.hostGroupName ||
        courtStudyRequest.churchName ||
        ""
      ).trim();

      const materialTitle = isRulesStudy
        ? [
            selectedRulesSection?.chapterTitle,
            selectedRulesSection?.sectionTitle,
          ]
            .filter(Boolean)
            .join(" — ") ||
          meeting.title ||
          "Court Study"
        : recording?.title ||
          meeting.title ||
          "Court of Compassion Interview";

      const memberInvitationText = isRulesStudy
        ? [
            `You are invited to participate in a Court of Compassion Court Study session hosted by ${hostGroupName}.`,
            "",
            `Study Material: ${materialTitle}`,
            ...(recordingUrl
              ? [
                  "",
                  "Watch the Selected Court Study Video:",
                  recordingUrl,
                ]
              : []),
            "",
            `Session: ${readableSessionTime}`,
            "",
            "Register for the Zoom Court Study Session:",
            registrationUrl,
            "",
            "Important: Each participant must register separately. Zoom will send each registered participant a personal confirmation email and unique join link.",
          ].join("\n")
        : [
            `You are invited to participate in a Court of Compassion Court Study session hosted by ${hostGroupName}.`,
            "",
            `Interview: ${materialTitle}`,
            `Session: ${readableSessionTime}`,
            "",
            "Watch the Interview Recording:",
            recordingUrl,
            "",
            ...(podcastUrl
              ? [
                  "Listen to the Podcast:",
                  podcastUrl,
                  "",
                ]
              : []),
            "Register for the Zoom Court Study Session:",
            registrationUrl,
            "",
            "Important: Each participant must register separately. Zoom will send each registered participant a personal confirmation email and unique join link.",
          ].join("\n");

      return res.status(200).json({
        success: true,
        invitation: {
          hostGroupName,
          materialTitle,
          studyType: isRulesStudy ? "RULES" : "INTERVIEW",
          readableSessionTime,
          recordingUrl,
          podcastUrl: podcastUrl || null,
          registrationUrl,
          memberInvitationText,
        },
      });
    } catch (err) {
      console.error(
        "❌ GET /api/court-study/public-invitation/:token error:",
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
// Public: send branded Court Study participant invitations
// =====================================================
app.post(
  "/api/court-study/public-invitation/:token/send",
  async (req, res) => {
    try {
      const token = String(req.params.token || "").trim();

      if (!token) {
        return res.status(400).json({
          success: false,
          error: "Invitation token is required",
        });
      }

      const rawEmails = Array.isArray(req.body?.emails)
        ? req.body.emails
        : typeof req.body?.emails === "string"
          ? req.body.emails.split(/[\s,;]+/)
          : [];

      const emails = [
        ...new Set(
          rawEmails
            .map((value) => String(value || "").trim().toLowerCase())
            .filter(Boolean)
        ),
      ];

      if (emails.length === 0) {
        return res.status(400).json({
          success: false,
          error: "At least one participant email address is required",
        });
      }

      if (emails.length > 50) {
        return res.status(400).json({
          success: false,
          error: "A maximum of 50 participant email addresses may be sent at one time",
        });
      }

      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      const invalidEmails = emails.filter(
        (email) => !emailPattern.test(email)
      );

      if (invalidEmails.length > 0) {
        return res.status(400).json({
          success: false,
          error: "One or more participant email addresses are invalid",
          invalidEmails,
        });
      }

      const meeting = await prisma.courtStudyMeeting.findUnique({
        where: {
          publicInvitationToken: token,
        },
        include: {
          courtStudyRequest: {
            include: {
              recording: true,
            },
          },
        },
      });

      if (!meeting || !meeting.courtStudyRequest) {
        return res.status(404).json({
          success: false,
          error: "Court Study invitation not found",
        });
      }

      const courtStudyRequest = meeting.courtStudyRequest;
      const recording = courtStudyRequest.recording;

      let selectedRulesSections = [];

      try {
        const rawSelectedRulesSections =
          courtStudyRequest.selectedRulesSections;

        if (Array.isArray(rawSelectedRulesSections)) {
          selectedRulesSections = rawSelectedRulesSections;
        } else if (
          typeof rawSelectedRulesSections === "string" &&
          rawSelectedRulesSections.trim()
        ) {
          const parsedSelectedRulesSections =
            JSON.parse(rawSelectedRulesSections);

          selectedRulesSections = Array.isArray(
            parsedSelectedRulesSections
          )
            ? parsedSelectedRulesSections
            : [parsedSelectedRulesSections];
        }
      } catch (parseError) {
        console.warn(
          "Could not parse selectedRulesSections for participant send:",
          parseError
        );
      }

      const selectedRulesSection =
        selectedRulesSections.find((section) =>
          String(section?.videoUrl || "").trim()
        ) ||
        selectedRulesSections[0] ||
        null;

      const isRulesStudy = Boolean(selectedRulesSection);

      const recordingUrl = isRulesStudy
        ? String(selectedRulesSection?.videoUrl || "").trim()
        : String(recording?.recordingUrl || "").trim();

      const registrationUrl = String(
        meeting.zoomRegistrationUrl || ""
      ).trim();

      if (!registrationUrl) {
        return res.status(400).json({
          success: false,
          error: "The Court Study registration link is unavailable",
        });
      }

      const timezone =
        meeting.timezone ||
        courtStudyRequest.timezone ||
        "America/Los_Angeles";

      const formattedDateTime =
        new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          month: "long",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        }).format(new Date(meeting.scheduledStart));

      const timezoneLabel =
        timezone === "America/Los_Angeles"
          ? "Pacific Time"
          : timezone;

      const readableSessionTime =
        `${formattedDateTime} (${timezoneLabel})`;

      const hostGroupName = String(
        courtStudyRequest.hostGroupName ||
        courtStudyRequest.churchName ||
        "Court of Compassion"
      ).trim();

      const materialTitle = isRulesStudy
        ? [
            selectedRulesSection?.chapterTitle,
            selectedRulesSection?.sectionTitle,
          ]
            .filter(Boolean)
            .join(" — ") ||
          meeting.title ||
          "Court Study"
        : recording?.title ||
          meeting.title ||
          "Court of Compassion Interview";

      const subject =
        `Invitation: Court Study — ${materialTitle}`;

      const plainTextBody = [
        "Dear Court Study Participant,",
        "",
        `You are invited to participate in a Court of Compassion Court Study session hosted by ${hostGroupName}.`,
        "",
        `Court Study Material: ${materialTitle}`,
        `Session: ${readableSessionTime}`,
        "",
        ...(recordingUrl
          ? [
              "Watch Court Study Video:",
              recordingUrl,
              "",
            ]
          : []),
        "Register for Court Study:",
        registrationUrl,
        "",
        "Each participant must register separately. After registration, Zoom will send each registered participant a personal confirmation email and unique join link.",
        "",
        "Court of Compassion",
      ].join("\n");

      const safeHostGroupName =
        safeEmailHtml(hostGroupName);

      const safeMaterialTitle =
        safeEmailHtml(materialTitle);

      const safeSessionTime =
        safeEmailHtml(readableSessionTime);

      const safeRecordingUrl =
        safeEmailWebUrl(recordingUrl);

      const safeRegistrationUrl =
        safeEmailWebUrl(registrationUrl);

      const htmlBody = `
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
                          You Are Invited to a Court Study
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
                          Dear Court Study Participant,
                        </p>

                        <p style="margin:0 0 20px 0;">
                          You are invited to participate in a Court of Compassion
                          Court Study session.
                        </p>

                        <p style="margin:0 0 22px 0;">
                          <strong>Host Group or Community:</strong>
                          ${safeHostGroupName}
                          <br>

                          <strong>Court Study Material:</strong>
                          ${safeMaterialTitle}
                          <br>

                          <strong>Session:</strong>
                          ${safeSessionTime}
                        </p>

                        ${
                          safeRecordingUrl
                            ? `
                              <p style="margin:0 0 12px 0;">
                                <a
                                  href="${safeRecordingUrl}"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style="
                                    display:inline-block;
                                    padding:12px 18px;
                                    background:#0b2a68;
                                    color:#ffffff;
                                    text-decoration:none;
                                    border-radius:4px;
                                    font-weight:bold;
                                  "
                                >
                                  Watch Court Study Video
                                </a>
                              </p>
                            `
                            : ""
                        }

                        <p style="margin:0 0 20px 0;">
                          <a
                            href="${safeRegistrationUrl}"
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
                            Register for Court Study
                          </a>
                        </p>

                        <div style="
                          padding:13px 14px;
                          background:#fff7dd;
                          border-left:4px solid #8a6500;
                        ">
                          Each participant must register separately.
                          After registration, Zoom will send each registered
                          participant a personal confirmation email and unique join link.
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

      let sentCount = 0;
      const failedEmails = [];

      for (const email of emails) {
        try {
          await sendEmail(
            email,
            subject,
            plainTextBody,
            htmlBody
          );

          sentCount += 1;
        } catch (sendErr) {
          console.error(
            "Participant invitation send failed:",
            sendErr
          );

          failedEmails.push(email);
        }
      }

      return res.status(200).json({
        success: failedEmails.length === 0,
        sentCount,
        failedCount: failedEmails.length,
        failedEmails,
      });
    } catch (err) {
      console.error(
        "❌ POST /api/court-study/public-invitation/:token/send error:",
        err
      );

      return res.status(500).json({
        success: false,
        error: String(err),
      });
    }
  }
);

// ================================================
// Admin: view Zoom registrants for a Court Study
// ================================================
app.get(
  "/api/court-study-requests/:id/registrants",
  requireAdminToken,
  async (req, res) => {
    try {
      const requestId = String(req.params.id || "").trim();

      if (!requestId) {
        return res.status(400).json({
          success: false,
          error: "Court Study request ID is required",
        });
      }

      const courtStudyRequest =
        await prisma.courtStudyRequest.findUnique({
          where: {
            id: requestId,
          },
          include: {
            courtStudyMeeting: {
              include: {
                zoomRegistrants: {
                  orderBy: {
                    registeredAt: "desc",
                  },
                },
              },
            },
          },
        });

      if (!courtStudyRequest) {
        return res.status(404).json({
          success: false,
          error: "Court Study request not found",
        });
      }

      const meeting = courtStudyRequest.courtStudyMeeting;

      if (!meeting) {
        return res.status(404).json({
          success: false,
          error:
            "This Court Study request does not have a scheduled meeting",
        });
      }

      const registrants = meeting.zoomRegistrants || [];

      const cancelledCount = registrants.filter(
        (registrant) =>
          Boolean(registrant.canceledAt) ||
          registrant.lastEventType ===
            "meeting.registration_cancelled"
      ).length;

      return res.status(200).json({
        success: true,
        courtStudyRequestId: courtStudyRequest.id,

        meeting: {
          id: meeting.id,
          title: meeting.title,
          zoomMeetingId: meeting.zoomMeetingId,
          scheduledStart:
            meeting.scheduledStart.toISOString(),
          scheduledEnd:
            meeting.scheduledEnd.toISOString(),
          timezone: meeting.timezone,
        },

        summary: {
          total: registrants.length,
          active: registrants.length - cancelledCount,
          cancelled: cancelledCount,
        },

        registrants: registrants.map((registrant) => ({
          id: registrant.id,
          zoomRegistrantId:
            registrant.zoomRegistrantId,
          firstName: registrant.firstName,
          lastName: registrant.lastName,
          email: registrant.email,
          registrationStatus:
            registrant.registrationStatus,
          lastEventType: registrant.lastEventType,
          registeredAt:
            registrant.registeredAt.toISOString(),
          canceledAt: registrant.canceledAt
            ? registrant.canceledAt.toISOString()
            : null,
        })),
      });
    } catch (err) {
      console.error(
        "❌ GET /api/court-study-requests/:id/registrants error:",
        err
      );

      return res.status(500).json({
        success: false,
        error: String(err),
      });
    }
  }
);

// ================================================
// Admin: view actual Zoom attendance for a Court Study
// ================================================
app.get(
  "/api/court-study-requests/:id/attendance",
  requireAdminToken,
  async (req, res) => {
    try {
      const requestId = String(req.params.id || "").trim();

      if (!requestId) {
        return res.status(400).json({
          success: false,
          error: "Court Study request ID is required",
        });
      }

      const courtStudyRequest =
        await prisma.courtStudyRequest.findUnique({
          where: {
            id: requestId,
          },
          include: {
            courtStudyMeeting: true,
          },
        });

      if (!courtStudyRequest) {
        return res.status(404).json({
          success: false,
          error: "Court Study request not found",
        });
      }

      const meeting = courtStudyRequest.courtStudyMeeting;

      if (!meeting) {
        return res.status(404).json({
          success: false,
          error:
            "This Court Study request does not have a Zoom meeting",
        });
      }

      const zoomMeetingId = String(
        meeting.zoomMeetingId || ""
      ).trim();

      const zoomMeetingUuid = String(
        meeting.zoomMeetingUuid || ""
      ).trim();

      if (!zoomMeetingUuid && !zoomMeetingId) {
        return res.status(404).json({
          success: false,
          error:
            "No Zoom meeting ID or meeting UUID is available for this Court Study",
        });
      }

      const accessToken = await getS2SAccessToken();

      const meetingIdentifier = zoomMeetingUuid
        ? encodeURIComponent(
            encodeURIComponent(zoomMeetingUuid)
          )
        : encodeURIComponent(zoomMeetingId);

      const participants = [];
      let nextPageToken = "";

      do {
        const zoomUrl = new URL(
          `https://api.zoom.us/v2/past_meetings/${meetingIdentifier}/participants`
        );

        zoomUrl.searchParams.set("page_size", "300");

        if (nextPageToken) {
          zoomUrl.searchParams.set(
            "next_page_token",
            nextPageToken
          );
        }

        const zoomResponse = await fetch(
          zoomUrl.toString(),
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          }
        );

        const zoomData = await zoomResponse
          .json()
          .catch(() => ({}));

        if (!zoomResponse.ok) {
          console.error(
            "❌ ZOOM PAST MEETING PARTICIPANTS ERROR:",
            zoomData
          );

          return res.status(zoomResponse.status).json({
            success: false,
            error:
              zoomData?.message ||
              "Unable to retrieve Zoom attendance",
          });
        }

        if (Array.isArray(zoomData.participants)) {
          participants.push(...zoomData.participants);
        }

        nextPageToken = String(
          zoomData.next_page_token || ""
        ).trim();
      } while (nextPageToken);

      return res.status(200).json({
        success: true,
        requestId,
        zoomMeetingId: zoomMeetingId || null,
        zoomMeetingUuid: zoomMeetingUuid || null,
        totalAttendanceEntries: participants.length,
        participants: participants.map((participant) => ({
          participantId: participant.id || null,
          userId: participant.user_id || null,
          name: participant.name || null,
          email: participant.user_email || null,
          joinTime: participant.join_time || null,
          leaveTime: participant.leave_time || null,
          durationSeconds:
            participant.duration !== undefined
              ? Number(participant.duration)
              : null,
        })),
      });
    } catch (err) {
      console.error(
        "❌ GET /api/court-study-requests/:id/attendance error:",
        err
      );

      return res.status(500).json({
        success: false,
        error: String(err),
      });
    }
  }
);

// ==================================================
// Admin: send the Court Study invitation package
// to the pastor
// ==================================================
async function sendCourtStudyInvitationInternal({
  requestId,
}) {
  requestId = String(requestId || "").trim();

  if (!requestId) {
  return {
    success: false,
    statusCode: 400,
    responseBody: {
      success: false,
      error: "Court Study request ID is required",
    },
  };
}  

    let meetingId = null;
    let pastorEmailForAudit = null;

    try {
      const courtStudyRequest =
        await prisma.courtStudyRequest.findUnique({
          where: {
            id: requestId,
          },
          include: {
            recording: true,
            courtStudyMeeting: true,
          },
        });

      if (!courtStudyRequest) {
  return {
    success: false,
    statusCode: 404,
    responseBody: {
      success: false,
      error: "Court Study request not found",
    },
  };
}

      const meeting = courtStudyRequest.courtStudyMeeting;
      const recording = courtStudyRequest.recording;

      if (!meeting) {
  return {
    success: false,
    statusCode: 400,
    responseBody: {
      success: false,
      error:
        "This Court Study request does not have a scheduled meeting",
    },
  };
}

      meetingId = meeting.id;

      const pastorName = String(
  courtStudyRequest.organizerName ||
  courtStudyRequest.pastorName ||
  ""
).trim();

const pastorEmail = String(
  courtStudyRequest.organizerEmail ||
  courtStudyRequest.pastorEmail ||
  ""
).trim();

const churchName = String(
  courtStudyRequest.hostGroupName ||
  courtStudyRequest.churchName ||
  ""
).trim();

      pastorEmailForAudit = pastorEmail;

      let selectedRulesSections = [];

try {
  const rawSelectedRulesSections =
    courtStudyRequest.selectedRulesSections;

  if (Array.isArray(rawSelectedRulesSections)) {
    selectedRulesSections = rawSelectedRulesSections;
  } else if (
    typeof rawSelectedRulesSections === "string" &&
    rawSelectedRulesSections.trim()
  ) {
    const parsedSelectedRulesSections =
      JSON.parse(rawSelectedRulesSections);

    selectedRulesSections = Array.isArray(
      parsedSelectedRulesSections
    )
      ? parsedSelectedRulesSections
      : [parsedSelectedRulesSections];
  }
} catch (parseError) {
  console.warn(
    "Could not parse selectedRulesSections for invitation send:",
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
  String(courtStudyRequest.studyFocusType || "")
    .trim()
    .toUpperCase() === "RULES_OF_PROCEDURE" ||
  Boolean(selectedRulesSection);

const rulesVideoUrl = String(
  selectedRulesSection?.videoUrl || ""
).trim();

const interviewRecordingUrl = String(
  recording?.recordingUrl || ""
).trim();

const recordingUrl = isRulesStudy
  ? rulesVideoUrl
  : interviewRecordingUrl;

const podcastUrl = isRulesStudy
  ? ""
  : String(recording?.podcastUrl || "").trim();

      const registrationUrl = String(
        meeting.zoomRegistrationUrl || ""
      ).trim();

      const missingFields = [];

      if (!pastorEmail) {
        missingFields.push("pastorEmail");
      }

      if (!isRulesStudy && !recordingUrl) {
        missingFields.push("recordingUrl");
      }

      if (!registrationUrl) {
        missingFields.push("zoomRegistrationUrl");
      }

      if (missingFields.length > 0) {
  return {
    success: false,
    statusCode: 400,
    responseBody: {
      success: false,
      error:
        "The pastor invitation cannot be sent because required information is missing",
      missingFields,
    },
  };
}

      const timezone =
        meeting.timezone ||
        courtStudyRequest.timezone ||
        "America/Los_Angeles";

      const scheduledStart = new Date(
        meeting.scheduledStart
      );

      const formattedDateTime =
        new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          month: "long",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        }).format(scheduledStart);

      const timezoneLabel =
        timezone === "America/Los_Angeles"
          ? "Pacific Time"
          : timezone;

      const readableSessionTime =
        `${formattedDateTime} ${timezoneLabel}`;

      const interviewTitle = isRulesStudy
  ? [
      selectedRulesSection?.chapterTitle,
      selectedRulesSection?.sectionTitle,
    ]
      .filter(Boolean)
      .join(" — ") ||
    meeting.title ||
    "Rules of Court Procedure"
  : recording?.title ||
    meeting.title ||
    "Court of Compassion Interview";

const memberInvitationText = isRulesStudy
  ? [
      `You are invited to participate in a Court of Compassion Court Study session hosted by ${churchName}.`,
      "",
      `Study Material: ${interviewTitle}`,
      ...(recordingUrl
        ? [
            "",
            "Watch the Selected Court Study Video:",
            recordingUrl,
          ]
        : []),
      "",
      `Session: ${readableSessionTime}`,
      "",
      "Register for the Zoom Court Study Session:",
      registrationUrl,
      "",
      "Important: Each participant must register separately using the registration link above. Zoom will send each registered participant a personal confirmation email and unique join link.",
    ].join("\n")
  : [
      `You are invited to participate in a Court of Compassion Court Study session hosted by ${churchName}.`,
      "",
      `Interview: ${interviewTitle}`,
      `Session: ${readableSessionTime}`,
      "",
      "Watch the Interview Recording:",
      recordingUrl,
      "",
      ...(podcastUrl
        ? [
            "Listen to the Podcast:",
            podcastUrl,
            "",
          ]
        : []),
      "Register for the Zoom Court Study Session:",
      registrationUrl,
      "",
      "Important: Each participant must register separately using the registration link above. Zoom will send each registered participant a personal confirmation email and unique join link.",
    ].join("\n");

      const subject =
        `Court Study Session Ready — ${interviewTitle}`;

      const isCommunityHosted =
  courtStudyRequest.meetingFormat === "COMMUNITY_HOSTED";

       const hostGroupName = String(
        courtStudyRequest.hostGroupName ||
        courtStudyRequest.churchName ||
        ""
      ).trim();
      
      const organizerName = String(
        courtStudyRequest.organizerName ||
        courtStudyRequest.pastorName ||
        ""
      ).trim();
      
      const recipientName = isCommunityHosted
  ? organizerName || "Court Study Organizer"
  : pastorName || "Pastor";

const hostLabel = "Host Group or Community";

const hostDisplayName = isCommunityHosted
  ? hostGroupName
  : churchName;
      
      const plainTextBody = isRulesStudy
  ? [
      `Dear ${recipientName},`,
      "",
      "Your Court of Compassion Court Study session is ready.",
      "",
      `${hostLabel}: ${hostDisplayName}`,
      `Study Material: ${interviewTitle}`,
      `Session: ${readableSessionTime}`,
      "",
      ...(recordingUrl
        ? [
            "Watch the Selected Court Study Video:",
            recordingUrl,
            "",
          ]
        : []),
      "Public Zoom Registration:",
      registrationUrl,
      "",
      isCommunityHosted
  ? "FOR THE ORGANIZER AND PARTICIPANTS:"
  : "FOR THE COURT STUDY ORGANIZER AND PARTICIPANTS:",
      isCommunityHosted
  ? "Each person—including the organizer—must register separately using the public Zoom Registration link above. After registration, Zoom will email that person a unique personal join link."
  : "Each person—including the Court Study organizer—must register separately using the public Zoom Registration link above. After registration, Zoom will email that person a unique personal join link.",
      "",
      isCommunityHosted
  ? "READY-MADE PARTICIPANT INVITATION"
  : "READY-MADE PARTICIPANT INVITATION",
      "---------------------------------",
      "",
      memberInvitationText,
      "",
      "Court of Compassion",
    ].join("\n")
  : [
      `Dear ${recipientName},`,
      "",
      "Your Court of Compassion Court Study session is ready.",
      "",
      `${hostLabel}: ${hostDisplayName}`,
      `Interview: ${interviewTitle}`,
      `Session: ${readableSessionTime}`,
      "",
      "Watch Interview Recording:",
      recordingUrl,
      "",
      ...(podcastUrl
        ? [
            "Listen to Podcast:",
            podcastUrl,
            "",
          ]
        : []),
      "Public Zoom Registration URL:",
      registrationUrl,
      "",
      isCommunityHosted
  ? "FOR THE ORGANIZER AND PARTICIPANTS:"
  : "FOR THE COURT STUDY ORGANIZER AND PARTICIPANTS:",
      isCommunityHosted
  ? "Each person—including the organizer—must register separately using the public Zoom Registration URL above. After registration, Zoom will email that person a unique personal join link."
  : "Each person—including the Court Study organizer—must register separately using the public Zoom Registration URL above. After registration, Zoom will email that person a unique personal join link.",
      "",
      isCommunityHosted
  ? "READY-MADE PARTICIPANT INVITATION"
  : "READY-MADE PARTICIPANT INVITATION",
      "-----------------------------------",
      "",
      memberInvitationText,
      "",
      "Court of Compassion",
    ].join("\n");

       const safeRecordingUrl = safeEmailWebUrl(recordingUrl);
       const safePodcastUrl = safeEmailWebUrl(podcastUrl);
       const safeRegistrationUrl =
       safeEmailWebUrl(registrationUrl); 

      const memberEmailSubject =
  `Invitation: Court Study — ${interviewTitle}`;

      

      const organizerEmail = String(
        courtStudyRequest.organizerEmail ||
        courtStudyRequest.pastorEmail ||
        ""
      ).trim();

      

      
      
      const memberEmailBody = isCommunityHosted
  ? [
      "Dear Court Study Participants,",
      "",
      memberInvitationText,
      "",
      "Regards,",
      organizerName,
      hostGroupName,
    ].join("\n")
  : [
     "Dear Court Study Participants,", 
      "",
      memberInvitationText,
      "",
      "Regards,",
     organizerName,
hostGroupName,
    ].join("\n");

const memberMailtoUrl =
  `mailto:?subject=${encodeURIComponent(memberEmailSubject)}` +
  `&body=${encodeURIComponent(memberEmailBody)}`;

const safeMemberMailtoUrl =
  safeEmailHtml(memberMailtoUrl);
let publicInvitationToken = String(
  meeting.publicInvitationToken || ""
).trim();

if (!publicInvitationToken) {
  publicInvitationToken = crypto.randomBytes(32).toString("hex");

  await prisma.courtStudyMeeting.update({
    where: {
      id: meeting.id,
    },
    data: {
      publicInvitationToken,
    },
  });

  meeting.publicInvitationToken = publicInvitationToken;
}

const participantInviteComposerUrl = publicInvitationToken
  ? `https://www.courtofcompassion.com/court-study-participant-invitation?token=${encodeURIComponent(publicInvitationToken)}`
  : "";

const safeParticipantInviteComposerUrl =
  safeEmailHtml(participantInviteComposerUrl);      
         const htmlBody = `
        <!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8">
            <meta
              name="viewport"
              content="width=device-width, initial-scale=1"
            >
          </head>

          <body
            style="
              margin:0;
              padding:0;
              background:#f7f2e9;
              font-family:Arial,Helvetica,sans-serif;
              color:#172554;
            "
          >
            <table
              role="presentation"
              width="100%"
              cellspacing="0"
              cellpadding="0"
              border="0"
              style="
                width:100%;
                background:#f7f2e9;
                padding:32px 12px;
              "
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

                    <!-- BRANDED HEADER -->
                    <tr>
                      <td
                        align="center"
                        style="
                          background:#0b2a68;
                          padding:24px 32px 22px 32px;
                          text-align:center;
                        "
                      >
                        <img
                          src="https://static.wixstatic.com/media/2ccb97_745227d9536b452b83a82556e6c5a430~mv2.png"
                          alt="Court of Compassion Seal"
                          width="96"
                          height="96"
                          style="
                            display:block;
                            width:96px;
                            height:96px;
                            margin:0 auto 14px auto;
                            border-radius:50%;
                            border:2px solid #d8b24c;
                            background:#ffffff;
                          "
                        >

                        <div
                          style="
                            font-size:12px;
                            letter-spacing:2px;
                            color:#d8b24c;
                            font-weight:700;
                            margin-bottom:8px;
                          "
                        >
                          COURT OF COMPASSION
                        </div>

                        <div
                          style="
                            font-size:26px;
                            line-height:34px;
                            color:#ffffff;
                            font-weight:700;
                          "
                        >
                          Court Study Session Ready
                        </div>
                      </td>
                    </tr>

                    <!-- GOLD DIVIDER -->
                    <tr>
                      <td style="padding:0 32px;">
                        <div
                          style="
                            height:4px;
                            background:#d8b24c;
                          "
                        ></div>
                      </td>
                    </tr>

                    <!-- EMAIL BODY -->
                    <tr>
                      <td
                        style="
                          padding:28px 32px 12px 32px;
                          font-size:14px;
                          line-height:21px;
                          color:#172554;
                        "
                      >

                        <p style="margin:0 0 16px 0;">
                          Dear ${safeEmailHtml(recipientName)},
                        </p>

                        <p style="margin:0 0 18px 0;">
                          Your Court of Compassion Court Study session is ready.
                        </p>

                        <p style="margin:0 0 20px 0;">
                          <strong>${safeEmailHtml(hostLabel)}:</strong>
                          ${safeEmailHtml(hostDisplayName)}
                          <br>

                          <strong>${isRulesStudy ? "Study Material" : "Interview"}:</strong>
                          ${safeEmailHtml(interviewTitle)}
                          <br>

                          <strong>Session:</strong>
                          ${safeEmailHtml(readableSessionTime)}
                        </p>

                        <!-- MEDIA BUTTONS -->
                        <p style="margin:0 0 22px 0;">
                          <a
                            href="${safeRecordingUrl}"
                            target="_blank"
                            rel="noopener noreferrer"
                            style="
                              display:inline-block;
                              padding:11px 17px;
                              margin:4px 8px 4px 0;
                              background:#0b2a68;
                              color:#ffffff;
                              text-decoration:none;
                              border-radius:4px;
                              font-weight:bold;
                            "
                          >
                            ${isRulesStudy
                              ? "Watch Selected Court Study Video"
                              : "Watch Interview Recording"}
                          </a>

                          ${
                            podcastUrl
                              ? `
                                <a
                                  href="${safePodcastUrl}"
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style="
                                    display:inline-block;
                                    padding:11px 17px;
                                    margin:4px 8px 4px 0;
                                    background:#1976D2;
                                    color:#ffffff;
                                    text-decoration:none;
                                    border-radius:4px;
                                    font-weight:bold;
                                  "
                                >
                                  Listen to Podcast
                                </a>
                              `
                              : ""
                          }
                        </p>

                        <!-- REGISTRATION SECTION -->
                        <h3
                          style="
                            margin:0 0 10px 0;
                            color:#0b2a68;
                            font-size:18px;
                            line-height:24px;
                          "
                        >
                          Public Zoom Registration
                        </h3>

                        <p style="margin:0 0 12px 0;">
                          Share this registration link with participants:
                        </p>

                        <p style="margin:0 0 18px 0;">
                          <a
                            href="${safeRegistrationUrl}"
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
                            Register for the Court Study Session
                          </a>
                        </p>

                        <div
                          style="
                            margin:0 0 22px 0;
                            padding:13px 14px;
                            background:#fff7dd;
                            border-left:4px solid #8a6500;
                            color:#172554;
                          "
                        >
                          <strong>
                            ${isCommunityHosted
                              ? "For the organizer and participants:"
                              : "For the Court Study organizer and participants:"}
                          </strong>

                          ${
                            isCommunityHosted
                              ? "Each person—including the organizer—must register separately using the gold Register for the Court Study Session button. After registration, Zoom will email that person a unique personal join link."
                              : "Each person—including the Court Study organizer—must register separately using the gold Register for the Court Study Session button. After registration, Zoom will email that person a unique personal join link."
                          }
                        </div>

                        <!-- PARTICIPANT INVITATION -->
                        <h3
                          style="
                            margin:0 0 10px 0;
                            color:#0b2a68;
                            font-size:18px;
                            line-height:24px;
                          "
                        >
                          Invite Court Study Participants
                        </h3>

                    <p style="margin:0 0 14px 0;">
  Review the Court Study participant invitation, enter the participants’
  email addresses, and send the invitation from the Court Study invitation page.
</p> 

                        ${participantInviteComposerUrl
  ? `
    <p style="margin:0 0 12px 0;">
      <a
        href="${safeParticipantInviteComposerUrl}"
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
        Invite Court Study Participants
      </a>
    </p>
  `
  : ""}

                        

                        

                        <p
                          style="
                            margin:0;
                            font-size:13px;
                            line-height:19px;
                            color:#555555;
                          "
                        >
                          For privacy, participant email addresses are used only to send
the Court Study invitation and are not saved to the Court Study database.
                        </p>

                      </td>
                    </tr>

                    <!-- FOOTER -->
                    <tr>
                      <td style="padding:8px 32px 28px 32px;">
                        <div
                          style="
                            border-top:1px solid #e5e7eb;
                            padding-top:18px;
                            text-align:center;
                          "
                        >
                          <div
                            style="
                              font-size:13px;
                              font-weight:700;
                              color:#0b2a68;
                              margin-bottom:5px;
                            "
                          >
                            Court of Compassion
                          </div>

                          <div
                            style="
                              font-size:12px;
                              line-height:18px;
                              color:#6b7280;
                            "
                          >
                            Justice • Truth • Social Relevance
                          </div>

                          <div
                            style="
                              font-size:11px;
                              line-height:17px;
                              color:#9ca3af;
                              margin-top:10px;
                            "
                          >
                            This is the finalized Court Study session package
                            prepared for the Court Study organizer.
                          </div>
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
        organizerEmail,
        subject,
        plainTextBody,
        htmlBody
      );

      const updatedMeeting =
        await prisma.courtStudyMeeting.update({
          where: {
            id: meeting.id,
          },
          data: {
            invitationSentAt: new Date(),
            invitationSentTo: organizerEmail,
            invitationSendCount: {
              increment: 1,
            },
            invitationLastError: null,
          },
        });

      await prisma.courtStudyRequest.update({
  where: {
    id: requestId,
  },
  data: {
    status: "SESSION_READY",
  },
});

  return {
  success: true,
  statusCode: 200,
  responseBody: {
    success: true,
    message: isCommunityHosted
      ? "Court Study invitation package sent to the organizer"
      : "Court Study invitation package sent to the Court Study organizer",
    sentTo: organizerEmail,
    invitationSentAt:
      updatedMeeting.invitationSentAt,
    invitationSendCount:
      updatedMeeting.invitationSendCount,
  },
}; 
      
    } catch (err) {
      console.error(
        "❌ POST /api/court-study-requests/:id/send-invitation error:",
        err
      );

      if (meetingId) {
        try {
          await prisma.courtStudyMeeting.update({
            where: {
              id: meetingId,
            },
            data: {
              invitationLastError: String(err),
              invitationSentTo:
                pastorEmailForAudit || null,
            },
          });
        } catch (auditErr) {
          console.error(
            "❌ Could not save invitation failure audit:",
            auditErr
          );
        }
      }

     return {
  success: false,
  statusCode: 500,
  responseBody: {
    success: false,
    error: String(err),
  },
}; 
    }
  }

// =====================================================
// Admin route: manually send/resend Court Study invitation
// =====================================================
app.post(
  "/api/court-study-requests/:id/send-invitation",
  requireAdminToken,
  async (req, res) => {
    try {
      const result =
        await sendCourtStudyInvitationInternal({
          requestId: req.params.id,
        });

      return res
        .status(result.statusCode)
        .json(result.responseBody);
    } catch (err) {
      console.error(
        "❌ POST /api/court-study-requests/:id/send-invitation wrapper error:",
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
// Admin: save an externally created Zoom meeting
// for a scheduled Court Study request
// =====================================================
app.post(
  "/api/court-study-requests/:id/manual-zoom",
  requireAdminToken,
  async (req, res) => {
    try {
      const requestId = String(req.params.id || "").trim();

      if (!requestId) {
        return res.status(400).json({
          success: false,
          error: "Court Study request ID is required",
        });
      }

      const {
        zoomMeetingId,
        zoomJoinUrl,
        zoomRegistrationUrl,
      } = req.body || {};

     if (!zoomMeetingId) {
  return res.status(400).json({
    success: false,
    error: "zoomMeetingId is required",
  });
}

if (
  (!zoomJoinUrl || !String(zoomJoinUrl).trim()) &&
  (!zoomRegistrationUrl || !String(zoomRegistrationUrl).trim())
) {
  return res.status(400).json({
    success: false,
    error: "Either zoomJoinUrl or zoomRegistrationUrl is required",
  });
} 

      const normalizedMeetingId = String(zoomMeetingId)
        .trim()
        .replace(/\s+/g, "");

      if (!normalizedMeetingId) {
        return res.status(400).json({
          success: false,
          error: "Zoom meeting ID cannot be empty",
        });
      }

      const validateHttpUrl = (value, fieldName) => {
        try {
          const parsedUrl = new URL(String(value).trim());

          if (
            parsedUrl.protocol !== "https:" &&
            parsedUrl.protocol !== "http:"
          ) {
            throw new Error();
          }

          return parsedUrl.toString();
        } catch {
          throw new Error(
            `${fieldName} must be a valid web address`
          );
        }
      };

      let normalizedJoinUrl = null;

if (zoomJoinUrl && String(zoomJoinUrl).trim()) {
  try {
    normalizedJoinUrl = validateHttpUrl(
      zoomJoinUrl,
      "Zoom join URL"
    );
  } catch (validationError) {
    return res.status(400).json({
      success: false,
      error: validationError.message,
    });
  }
}

      let normalizedRegistrationUrl = null;

      if (
        zoomRegistrationUrl &&
        String(zoomRegistrationUrl).trim()
      ) {
        try {
          normalizedRegistrationUrl = validateHttpUrl(
            zoomRegistrationUrl,
            "Zoom registration URL"
          );
        } catch (validationError) {
          return res.status(400).json({
            success: false,
            error: validationError.message,
          });
        }
      }

      const courtStudyRequest =
        await prisma.courtStudyRequest.findUnique({
          where: {
            id: requestId,
          },
          include: {
            recording: true,
            campaign: true,
            courtStudyMeeting: true,
          },
        });

      if (!courtStudyRequest) {
        return res.status(404).json({
          success: false,
          error: "Court Study request not found",
        });
      }

      if (
  courtStudyRequest.status !== "MEETING_APPROVED" &&
  courtStudyRequest.status !== "SCHEDULED"
) {
  return res.status(400).json({
    success: false,
    error:
      "The Court Study request must be MEETING_APPROVED or SCHEDULED before Zoom details can be saved",
  });
}

      if (
        courtStudyRequest.meetingFormat === "IN_PERSON"
      ) {
        return res.status(400).json({
          success: false,
          error:
            "This is an in-person Court Study request and does not require Zoom details",
        });
      }

      const meeting = courtStudyRequest.courtStudyMeeting;

      if (!meeting) {
        return res.status(404).json({
          success: false,
          error:
            "No scheduled Court Study meeting was found for this request",
        });
      }

      if (meeting.zoomMeetingId || meeting.zoomJoinUrl) {
        return res.status(409).json({
          success: false,
          error:
            "Zoom details have already been saved for this Court Study session",
          meeting,
        });
      }

      const updatedMeeting =
        await prisma.courtStudyMeeting.update({
          where: {
            id: meeting.id,
          },
          data: {
            zoomMeetingId: normalizedMeetingId,
            zoomJoinUrl: normalizedJoinUrl,
            zoomRegistrationUrl:
              normalizedRegistrationUrl,
            status: "SCHEDULED",
          },
        });

      await prisma.courtStudyRequest.update({
  where: {
    id: requestId,
  },
  data: {
    status: "SCHEDULED",
  },
});

      return res.status(200).json({
        success: true,
        message:
          "Externally created Zoom meeting details saved successfully",
        meeting: updatedMeeting,
        hostingMethod:
          courtStudyRequest.meetingFormat,
      });
    } catch (err) {
      console.error(
        "❌ POST /api/court-study-requests/:id/manual-zoom error:",
        err
      );

      return res.status(500).json({
        success: false,
        error: String(err),
      });
    }
  }
);

// ======================================================
// Admin: send pastor-hosted Zoom setup link to the pastor
// ======================================================
app.post(
  "/api/court-study-requests/:id/send-pastor-setup",
  requireAdminToken,
  async (req, res) => {
    try {
      const requestId = String(req.params.id || "").trim();

      if (!requestId) {
        return res.status(400).json({
          success: false,
          error: "Court Study request ID is required",
        });
      }

      const courtStudyRequest =
        await prisma.courtStudyRequest.findUnique({
          where: {
            id: requestId,
          },
          include: {
            recording: true,
            campaign: true,
            courtStudyMeeting: true,
          },
        });

      if (!courtStudyRequest) {
        return res.status(404).json({
          success: false,
          error: "Court Study request not found",
        });
      }

      if (courtStudyRequest.status !== "APPROVED") {
        return res.status(400).json({
          success: false,
          error:
            "The Court Study request must be APPROVED before the pastor setup link can be sent",
        });
      }

      if (courtStudyRequest.meetingFormat !== "PASTOR_HOSTED") {
        return res.status(400).json({
          success: false,
          error:
            "This action is only available for pastor-hosted Court Study requests",
        });
      }

      const pastorEmail = String(
        courtStudyRequest.pastorEmail || ""
      )
        .trim()
        .toLowerCase();

      if (!pastorEmail) {
        return res.status(400).json({
          success: false,
          error: "The pastor email address is missing",
        });
      }

      const publicBaseUrl = String(
        process.env.PUBLIC_BASE_URL || ""
      ).replace(/\/+$/, "");
     const frontendBaseUrl = String(
  process.env.FRONTEND_BASE_URL || publicBaseUrl
).replace(/\/+$/, ""); 
      if (!publicBaseUrl) {
        return res.status(500).json({
          success: false,
          error: "PUBLIC_BASE_URL is not configured",
        });
      }

      const pastorSetupToken = crypto
        .randomBytes(32)
        .toString("hex");

      const pastorSetupTokenExpiresAt = new Date(
        Date.now() + 7 * 24 * 60 * 60 * 1000
      );

      const preferredStart = courtStudyRequest.preferredStart
        ? new Date(courtStudyRequest.preferredStart)
        : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const provisionalEnd = new Date(
        preferredStart.getTime() + 60 * 60 * 1000
      );

      const timezone =
        String(
          courtStudyRequest.timezone ||
            "America/Los_Angeles"
        ).trim() || "America/Los_Angeles";

      const recordingTitle =
        courtStudyRequest.recording?.title ||
        "Court of Compassion Interview";

      const churchName =
        courtStudyRequest.churchName || "your church";

      const meetingTitle = `Court Study — ${recordingTitle}`;

      const meetingDescription =
        `Pastor-hosted Court Study session requested by ` +
        `${courtStudyRequest.pastorName} of ${churchName}.`;

      const updatedMeeting = await prisma.$transaction(
        async (tx) => {
          let meeting = courtStudyRequest.courtStudyMeeting;

          if (!meeting) {
            meeting = await tx.courtStudyMeeting.create({
              data: {
                courtStudyRequestId: courtStudyRequest.id,
                churchContactId: null,
                timeSlotId: null,

                title: meetingTitle,
                description: meetingDescription,
                discussionType: "INTERVIEW_RECORDING",
                selectedChapter: null,
                selectedSection: null,
                selectedRecordingId:
                  courtStudyRequest.recordingId,

                scheduledStart: preferredStart,
                scheduledEnd: provisionalEnd,
                timezone,

                zoomMeetingId: null,
                zoomRegistrationUrl: null,
                zoomJoinUrl: null,
                zoomPasscode: null,

                pastorSetupToken,
                pastorSetupTokenExpiresAt,
                meetingSetupRequestedAt: new Date(),
                meetingDetailsSubmittedAt: null,

                status: "PENDING",
              },
            });
          } else {
            meeting = await tx.courtStudyMeeting.update({
              where: {
                id: meeting.id,
              },
              data: {
                pastorSetupToken,
                pastorSetupTokenExpiresAt,
                meetingSetupRequestedAt: new Date(),
                meetingDetailsSubmittedAt: null,
                status: "PENDING",
              },
            });
          }

          await tx.courtStudyRequest.update({
            where: {
              id: courtStudyRequest.id,
            },
            data: {
              status: "AWAITING_MEETING_DETAILS",
            },
          });

          return meeting;
        }
      );

      const setupUrl =
       `${frontendBaseUrl}/pastor-court-study-setup/`  +
        encodeURIComponent(pastorSetupToken);

      const subject =
        `Court Study Meeting Setup Required — ${recordingTitle}`;

      const textBody = [
        `Dear ${courtStudyRequest.pastorName},`,
        "",
        "Your request for a pastor-hosted Court Study session has been approved.",
        "",
        `Church: ${churchName}`,
        `Interview: ${recordingTitle}`,
        "",
        "Please create the Zoom meeting in your church's Zoom account.",
        "After creating it, use the secure link below to submit the meeting details to the Court of Compassion:",
        "",
        setupUrl,
        "",
        "You will be asked to provide:",
        "- Zoom meeting ID",
        "- Zoom join URL",
        "- Zoom registration URL, when registration is enabled",
        "- Meeting passcode, when applicable",
        "- Confirmed meeting date and time",
        "- Time zone",
        "- Meeting duration or ending time",
        "",
        "This secure link expires in seven days.",
        "",
        "Respectfully,",
        "Court of Compassion",
      ].join("\n");

      const htmlBody = `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #14213d;">
          <h2 style="color: #0b1e5b;">
            Pastor-Hosted Court Study Meeting Setup
          </h2>

          <p>
            Dear ${safeEmailHtml(courtStudyRequest.pastorName)},
          </p>

          <p>
            Your request for a pastor-hosted Court Study session has been approved.
          </p>

          <p>
            <strong>Church:</strong>
            ${safeEmailHtml(churchName)}
            <br>
            <strong>Interview:</strong>
            ${safeEmailHtml(recordingTitle)}
          </p>

          <p>
            Please create the Zoom meeting in your church's Zoom account.
            After creating it, use the secure button below to submit the
            meeting details to the Court of Compassion.
          </p>

          <p style="margin: 24px 0;">
            <a
              href="${safeEmailWebUrl(setupUrl)}"
              style="
                display: inline-block;
                padding: 12px 20px;
                background: #d4af37;
                color: #071b33;
                text-decoration: none;
                font-weight: bold;
                border-radius: 5px;
              "
            >
              Submit Church Zoom Meeting Details
            </a>
          </p>

          <p>You will be asked to provide:</p>

          <ul>
            <li>Zoom meeting ID</li>
            <li>Zoom join URL</li>
            <li>Zoom registration URL, when enabled</li>
            <li>Meeting passcode, when applicable</li>
            <li>Confirmed meeting date and time</li>
            <li>Time zone</li>
            <li>Meeting duration or ending time</li>
          </ul>

          <p>
            This secure link expires in seven days.
          </p>

          <p>
            Respectfully,<br>
            <strong>Court of Compassion</strong>
          </p>
        </div>
      `;

      await sendEmail(
        pastorEmail,
        subject,
        textBody,
        htmlBody
      );

      return res.status(200).json({
        success: true,
        message:
          "Pastor-hosted meeting setup link sent successfully",
        requestStatus: "AWAITING_MEETING_DETAILS",
        pastorEmail,
        setupExpiresAt: pastorSetupTokenExpiresAt,
        meeting: updatedMeeting,
      });
    } catch (err) {
      console.error(
        "❌ POST /api/court-study-requests/:id/send-pastor-setup error:",
        err
      );

      return res.status(500).json({
        success: false,
        error: String(err),
      });
    }
  }
);

// ======================================================
// Public: load pastor-hosted Court Study setup information
// ======================================================
app.get(
  "/api/pastor-court-study-setup/:token",
  async (req, res) => {
    try {
      const pastorSetupToken = String(
        req.params.token || ""
      ).trim();

      if (!pastorSetupToken) {
        return res.status(400).json({
          success: false,
          error: "The pastor setup token is required",
        });
      }

      const meeting =
        await prisma.courtStudyMeeting.findFirst({
          where: {
            pastorSetupToken,
          },
          include: {
            courtStudyRequest: {
              include: {
                recording: true,
                campaign: true,
              },
            },
          },
        });

      if (!meeting || !meeting.courtStudyRequest) {
        return res.status(404).json({
          success: false,
          error:
            "This pastor meeting setup link is invalid",
        });
      }

      if (
        !meeting.pastorSetupTokenExpiresAt ||
        meeting.pastorSetupTokenExpiresAt <
          new Date()
      ) {
        return res.status(410).json({
          success: false,
          error:
            "This pastor meeting setup link has expired",
        });
      }

      const courtStudyRequest =
        meeting.courtStudyRequest;

      if (
        courtStudyRequest.meetingFormat !==
        "PASTOR_HOSTED"
      ) {
        return res.status(400).json({
          success: false,
          error:
            "This request is not a pastor-hosted Court Study session",
        });
      }

      if (
        courtStudyRequest.status ===
        "MEETING_DETAILS_SUBMITTED"
      ) {
        return res.status(409).json({
          success: false,
          error:
            "The Zoom meeting details have already been submitted",
          alreadySubmitted: true,
        });
      }

      return res.status(200).json({
        success: true,
        setup: {
          pastorName:
            courtStudyRequest.pastorName,
          pastorEmail:
            courtStudyRequest.pastorEmail,
          churchName:
            courtStudyRequest.churchName,
          recordingTitle:
            courtStudyRequest.recording?.title ||
            "Court of Compassion Interview",

          scheduledStart:
            meeting.scheduledStart,
          scheduledEnd:
            meeting.scheduledEnd,
          timezone:
            meeting.timezone ||
            courtStudyRequest.timezone ||
            "America/Los_Angeles",

          zoomMeetingId:
            meeting.zoomMeetingId || "",
          zoomJoinUrl:
            meeting.zoomJoinUrl || "",
          zoomRegistrationUrl:
            meeting.zoomRegistrationUrl || "",
          zoomPasscode:
            meeting.zoomPasscode || "",
        },
      });
    } catch (err) {
      console.error(
        "❌ GET /api/pastor-court-study-setup/:token error:",
        err
      );

      return res.status(500).json({
        success: false,
        error: String(err),
      });
    }
  }
);

// ======================================================
// Public: submit pastor-hosted Zoom meeting details
// ======================================================
app.post(
  "/api/pastor-court-study-setup/:token",
  async (req, res) => {
    try {
      const pastorSetupToken = String(
        req.params.token || ""
      ).trim();

      if (!pastorSetupToken) {
        return res.status(400).json({
          success: false,
          error: "The pastor setup token is required",
        });
      }

      const {
        zoomMeetingId,        
        zoomRegistrationUrl,
        zoomPasscode,
        scheduledStart,
        scheduledEnd,
        timezone,
      } = req.body || {};

      const normalizedMeetingId = String(
        zoomMeetingId || ""
      )
        .trim()
        .replace(/\s+/g, "");

      if (!normalizedMeetingId) {
        return res.status(400).json({
          success: false,
          error: "Zoom meeting ID is required",
        });
      }

      const validateHttpUrl = (
        value,
        fieldName
      ) => {
        try {
          const parsedUrl = new URL(
            String(value || "").trim()
          );

          if (
            parsedUrl.protocol !== "https:" &&
            parsedUrl.protocol !== "http:"
          ) {
            throw new Error();
          }

          return parsedUrl.toString();
        } catch {
          throw new Error(
            `${fieldName} must be a valid web address`
          );
        }
      };

      

      let normalizedRegistrationUrl = null;

      if (
        zoomRegistrationUrl &&
        String(zoomRegistrationUrl).trim()
      ) {
        try {
          normalizedRegistrationUrl =
            validateHttpUrl(
              zoomRegistrationUrl,
              "Zoom registration URL"
            );
        } catch (validationError) {
          return res.status(400).json({
            success: false,
            error: validationError.message,
          });
        }
      }

      if (
        !scheduledStart ||
        !scheduledEnd ||
        !timezone
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Confirmed start time, ending time, and time zone are required",
        });
      }

      const parsedStart = parseDateTimeInTimeZone(
  scheduledStart,
  timezone
);

const parsedEnd = parseDateTimeInTimeZone(
  scheduledEnd,
  timezone
);

      if (Number.isNaN(parsedStart.getTime())) {
        return res.status(400).json({
          success: false,
          error:
            "Confirmed start time is not valid",
        });
      }

      if (Number.isNaN(parsedEnd.getTime())) {
        return res.status(400).json({
          success: false,
          error:
            "Confirmed ending time is not valid",
        });
      }

      if (
        parsedEnd.getTime() <=
        parsedStart.getTime()
      ) {
        return res.status(400).json({
          success: false,
          error:
            "The ending time must be later than the start time",
        });
      }

      const meeting =
        await prisma.courtStudyMeeting.findFirst({
          where: {
            pastorSetupToken,
          },
          include: {
            courtStudyRequest: {
              include: {
                recording: true,
              },
            },
          },
        });

      if (!meeting || !meeting.courtStudyRequest) {
        return res.status(404).json({
          success: false,
          error:
            "This pastor meeting setup link is invalid",
        });
      }

      if (
        !meeting.pastorSetupTokenExpiresAt ||
        meeting.pastorSetupTokenExpiresAt <
          new Date()
      ) {
        return res.status(410).json({
          success: false,
          error:
            "This pastor meeting setup link has expired",
        });
      }

      const courtStudyRequest =
        meeting.courtStudyRequest;

      if (
        courtStudyRequest.meetingFormat !==
        "PASTOR_HOSTED"
      ) {
        return res.status(400).json({
          success: false,
          error:
            "This request is not a pastor-hosted Court Study session",
        });
      }

      if (
        courtStudyRequest.status !==
        "AWAITING_MEETING_DETAILS"
      ) {
        return res.status(409).json({
          success: false,
          error:
            "This Court Study request is not currently awaiting meeting details",
        });
      }

      const result = await prisma.$transaction(
        async (tx) => {
          const updatedMeeting =
            await tx.courtStudyMeeting.update({
              where: {
                id: meeting.id,
              },
              data: {
                zoomMeetingId: normalizedMeetingId,
                zoomJoinUrl: null,
                
                zoomRegistrationUrl:
                  normalizedRegistrationUrl,
                zoomPasscode:
                  String(
                    zoomPasscode || ""
                  ).trim() || null,

                scheduledStart: parsedStart,
                scheduledEnd: parsedEnd,
                timezone:
                  String(timezone).trim(),

                meetingDetailsSubmittedAt:
                  new Date(),

                status: "PENDING",
              },
            });

          const updatedRequest =
            await tx.courtStudyRequest.update({
              where: {
                id: courtStudyRequest.id,
              },
              data: {
                status:
                  "MEETING_DETAILS_SUBMITTED",
              },
            });

          return {
            meeting: updatedMeeting,
            request: updatedRequest,
          };
        }
      );

       
    // Notify the person who submitted the meeting details
    // and notify the Court administrator.
    const submitterName = String(
      courtStudyRequest.organizerName ||
        courtStudyRequest.pastorName ||
        "Court Study Organizer"
    ).trim();

    const submitterEmail = String(
      courtStudyRequest.organizerEmail ||
        courtStudyRequest.pastorEmail ||
        ""
    ).trim();

    const submittedTimeZone = String(
      timezone || "America/Los_Angeles"
    ).trim();

    const formatSubmittedDateTime = (value) => {
      try {
        return value.toLocaleString("en-US", {
          timeZone: submittedTimeZone,
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        });
      } catch (formatError) {
        return value.toISOString();
      }
    };

    const readableSubmittedStart =
      formatSubmittedDateTime(parsedStart);

    const readableSubmittedEnd =
      formatSubmittedDateTime(parsedEnd);

    const requestReference = courtStudyRequest.id;

    const adminEmail = String(
      process.env.ADMIN_EMAIL ||
        process.env.GMAIL_USER ||
        ""
    ).trim();

    if (submitterEmail) {
      try {
        const submitterSubject =
          "Court Study meeting details received";

        const submitterBody = [
          `Dear ${submitterName},`,
          "",
          "Your Zoom meeting details have been received by the Court of Compassion.",
          "",
          `Confirmed start: ${readableSubmittedStart}`,
          `Confirmed end: ${readableSubmittedEnd}`,
          `Time zone: ${submittedTimeZone}`,
          `Request reference: ${requestReference}`,
          "",
          "The Court will review the submitted meeting details. You will be contacted after the review has been completed.",
          "",
          "Respectfully,",
          "Court of Compassion",
        ].join("\n");

        await sendEmail(
          submitterEmail,
          submitterSubject,
          submitterBody
        );

        console.log(
          "✅ MEETING DETAILS CONFIRMATION EMAIL SENT:",
          submitterEmail
        );
      } catch (submitterEmailError) {
        console.error(
          "❌ MEETING DETAILS CONFIRMATION EMAIL FAILED:",
          submitterEmail,
          submitterEmailError
        );
      }
    } else {
      console.warn(
        "⚠️ No organizer or pastor email was available for the meeting-details confirmation."
      );
    }

    if (adminEmail) {
      try {
        const adminReviewUrl =
          `https://www.courtofcompassion.com/admin/court-study-requests?requestId=${encodeURIComponent(
            requestReference
          )}`;

        const adminSubject =
          `Action required: Court Study meeting details submitted — ${requestReference}`;

        const adminBody = [
          "Court Study meeting details have been submitted and require administrator review.",
          "",
          `Submitted by: ${submitterName}`,
          `Submitter email: ${submitterEmail || "Not provided"}`,
          `Request reference: ${requestReference}`,
          `Confirmed start: ${readableSubmittedStart}`,
          `Confirmed end: ${readableSubmittedEnd}`,
          `Time zone: ${submittedTimeZone}`,
          "",
          "Next required action: Review the submitted Zoom details and select Approve Meeting Details if everything is correct.",
          "",
          `Open the Court Study admin page: ${adminReviewUrl}`,
          "",
          "Court of Compassion",
        ].join("\n");

        await sendEmail(
          adminEmail,
          adminSubject,
          adminBody
        );

        console.log(
          "✅ ADMIN MEETING DETAILS NOTIFICATION SENT:",
          adminEmail
        );
      } catch (adminEmailError) {
        console.error(
          "❌ ADMIN MEETING DETAILS NOTIFICATION FAILED:",
          adminEmail,
          adminEmailError
        );
      }
    } else {
      console.warn(
        "⚠️ Administrator notification was skipped because ADMIN_EMAIL and GMAIL_USER are missing."
      );
    }

   
      
      return res.status(200).json({
        success: true,
        message:
          "Your Zoom meeting details have been submitted to the Court of Compassion for review",
        requestStatus:
          "MEETING_DETAILS_SUBMITTED",
        meeting: result.meeting,
      });
    } catch (err) {
      console.error(
        "❌ POST /api/pastor-court-study-setup/:token error:",
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
