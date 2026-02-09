import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import crypto from "crypto";


const app = express();
app.use(cors());
app.use((req, res, next) => {
  console.log("➡️", req.method, req.originalUrl);
  next();
});
const zoomTokenStore = new Map();

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
      from: process.env.GMAIL_USER,
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
    if (!zoomTokens?.access_token) {
      return res.status(401).json({
        error: "Zoom not connected yet. Visit /zoom/oauth/start to authorize.",
      });
    }

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
        Authorization: `Bearer ${zoomTokens.access_token}`,
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
    if (!zoomTokens?.access_token) {
      return res.status(401).json({
        error: "Zoom not connected yet. Visit /zoom/oauth/start to authorize.",
      });
    }

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
        Authorization: `Bearer ${zoomTokens.access_token}`,
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
        from: process.env.GMAIL_USER,
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

app.post("/send-email", async (req, res) => {
  try {
    const { to, subject, text, replyTo } = req.body || {};

    if (!to || !subject || !text) {
      return res.status(400).json({ error: "Missing to/subject/text" });
    }

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
      from: process.env.GMAIL_USER,
      to,
      subject,
      text,
      replyTo: replyTo || undefined,
    });

    console.log("✅ SEND-EMAIL: sent to", to);
    res.json({ success: true });
  } catch (err) {
    console.log("❌ SEND-EMAIL ERROR:", err);
    res.status(500).json({ success: false, error: String(err) });
  }
});
   

 
/* 🚨 NOTHING after this except listen */
 

// ---- ZOOM OAUTH (OWNER = YOU) ----
let zoomTokens = null; // stored in memory for now

app.get("/zoom/oauth/start", (req, res) => {
  const redirectUri = process.env.ZOOM_REDIRECT_URL;
  const clientId = process.env.ZOOM_CLIENT_ID;

  if (!redirectUri || !clientId) {
    return res.status(500).send("Missing ZOOM_CLIENT_ID or ZOOM_REDIRECT_URL");
  }

  const url =
    `https://zoom.us/oauth/authorize?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;

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

    return res.send("✅ Zoom connected. You can close this tab.");
  } catch (err) {
    console.error(err);
    return res.status(500).send(String(err));
  }
});

app.get("/zoom/status", (req, res) => {
  res.json({ connected: Boolean(zoomTokens) });
});
// ✅ Browser test route (GET)
app.get("/zoom/webhook", (req, res) => {
  console.log("✅ GET /zoom/webhook HIT");
  res.status(200).send("ok");
});


app.post("/zoom/webhook", express.raw({ type: "application/json" }), (req, res) => {
  try {
    const raw = req.body?.toString("utf8") || "";
    const body = raw ? JSON.parse(raw) : {};

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




   app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
