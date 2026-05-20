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

    const { topic, startTime, duration, agenda, timezone, password, settings } = req.body || {};

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

    const { topic, startTime, duration, agenda, timezone, password, settings } = req.body || {};
    
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


   app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
