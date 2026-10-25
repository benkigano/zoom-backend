// =====================================================
// Court of Compassion
// Shared Email Utilities
//
// Reuses the Gmail SMTP configuration and HTML
// escaping behavior currently used by server.js.
// =====================================================

import nodemailer from "nodemailer";
import escapeHtml from "escape-html";

export async function sendEmail(
  to,
  subject,
  body,
  htmlBody = null
) {
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
    html:
      htmlBody ||
      escapeHtml(String(body)).replace(/\n/g, "<br>"),
  });

  console.log("✅ DISTRIBUTION EMAIL SENT TO:", to);
}

export const safeEmailHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export const safeEmailWebUrl = (value) => {
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
