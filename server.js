import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";

const app = express();
app.use(cors());
app.use(express.json());

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
 app.get("/test-email", (req, res) => {
  // ... your existing test-email code ...
});


/* ✅ PASTE THE NEW BLOCK HERE */
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
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

   app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
