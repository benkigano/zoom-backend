import { createHmac, timingSafeEqual } from "node:crypto";
import {
  getMembershipPlanName,
  isMembershipPlan,
  normalizeMembershipEmail,
} from "./guards.js";

const MEMBER_PORTAL_PATH = "/api/membership/me";
const MEMBER_PORTAL_ENDPOINT = `GET ${MEMBER_PORTAL_PATH}`;
const MEMBER_PORTAL_ISSUER = "wix-astro-member-portal";
const MEMBER_PORTAL_MAX_ASSERTION_LIFETIME_SECONDS = 60;
const MEMBER_PORTAL_CLOCK_SKEW_SECONDS = 30;
const MEMBER_PORTAL_MAX_TOKEN_LENGTH = 4096;

function getMemberPortalAssertionConfig(env = process.env) {
  const secret = env.MEMBER_PORTAL_ASSERTION_SECRET;
  const audience = env.MEMBER_PORTAL_ASSERTION_AUDIENCE;

  if (
    typeof secret !== "string" ||
    Buffer.byteLength(secret, "utf8") < 32 ||
    secret.trim() !== secret ||
    /[\r\n]/.test(secret) ||
    typeof audience !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(audience)
  ) {
    return null;
  }

  return { secret, audience };
}

function verifyMemberPortalAssertion(token, config, now = Date.now()) {
  if (
    !config ||
    typeof token !== "string" ||
    token.length > MEMBER_PORTAL_MAX_TOKEN_LENGTH ||
    !Number.isFinite(now)
  ) {
    return null;
  }

  const parts = token.split(".");
  if (
    parts.length !== 2 ||
    !/^[A-Za-z0-9_-]+$/.test(parts[0]) ||
    !/^[a-f0-9]{64}$/.test(parts[1])
  ) {
    return null;
  }

  const [encodedPayload, providedSignature] = parts;
  const expectedSignature = Buffer.from(
    createHmac("sha256", config.secret)
      .update(encodedPayload)
      .digest("hex"),
    "hex"
  );
  const providedSignatureBuffer = Buffer.from(providedSignature, "hex");

  if (
    providedSignatureBuffer.length !== expectedSignature.length ||
    !timingSafeEqual(providedSignatureBuffer, expectedSignature)
  ) {
    return null;
  }

  let claims;
  try {
    const payloadBuffer = Buffer.from(encodedPayload, "base64url");
    if (payloadBuffer.toString("base64url") !== encodedPayload) {
      return null;
    }
    claims = JSON.parse(payloadBuffer.toString("utf8"));
  } catch {
    return null;
  }

  if (!claims || typeof claims !== "object" || Array.isArray(claims)) {
    return null;
  }

  const nowSeconds = Math.floor(now / 1000);
  const issuedAt = claims.iat;
  const expiresAt = claims.exp;

  if (
    claims.iss !== MEMBER_PORTAL_ISSUER ||
    claims.aud !== config.audience ||
    claims.endpoint !== MEMBER_PORTAL_ENDPOINT ||
    typeof claims.sub !== "string" ||
    !claims.sub.trim() ||
    claims.sub.length > 256 ||
    claims.email_verified !== true ||
    typeof claims.email !== "string" ||
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    issuedAt > nowSeconds + MEMBER_PORTAL_CLOCK_SKEW_SECONDS ||
    issuedAt <
      nowSeconds -
        MEMBER_PORTAL_MAX_ASSERTION_LIFETIME_SECONDS -
        MEMBER_PORTAL_CLOCK_SKEW_SECONDS ||
    expiresAt <= nowSeconds - MEMBER_PORTAL_CLOCK_SKEW_SECONDS ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MEMBER_PORTAL_MAX_ASSERTION_LIFETIME_SECONDS
  ) {
    return null;
  }

  const email = normalizeMembershipEmail(claims.email);
  if (!email) {
    return null;
  }

  return { email };
}

function createMemberPortalAuthenticationMiddleware({
  env = process.env,
  now = () => Date.now(),
} = {}) {
  return (req, res, next) => {
    res.set("Cache-Control", "no-store");

    const config = getMemberPortalAssertionConfig(env);
    if (!config) {
      return res.status(503).json({
        success: false,
        error: "Membership information is temporarily unavailable.",
      });
    }

    if (req.method !== "GET" || req.path !== MEMBER_PORTAL_PATH) {
      return res.status(401).json({
        success: false,
        error: "Authentication required.",
      });
    }

    const hasQueryParameters =
      req.query && Object.keys(req.query).length > 0;
    const hasRequestBody =
      req.body !== undefined &&
      req.body !== null &&
      (typeof req.body !== "object" ||
        Array.isArray(req.body) ||
        Object.keys(req.body).length > 0);

    if (hasQueryParameters || hasRequestBody) {
      return res.status(400).json({
        success: false,
        error: "Invalid request.",
      });
    }

    const authorization = req.headers?.authorization;
    const bearerMatch =
      typeof authorization === "string"
        ? /^Bearer ([^\s]+)$/i.exec(authorization)
        : null;

    if (!bearerMatch) {
      return res.status(401).json({
        success: false,
        error: "Authentication required.",
      });
    }

    const identity = verifyMemberPortalAssertion(
      bearerMatch[1],
      config,
      now()
    );

    if (!identity) {
      return res.status(401).json({
        success: false,
        error: "Authentication required.",
      });
    }

    req.memberPortalIdentity = identity;
    return next();
  };
}

function createMemberPortalSubscriptionHandler(
  prisma,
  logError = console.error
) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");

    const email = req.memberPortalIdentity?.email;
    if (!email) {
      return res.status(401).json({
        success: false,
        error: "Authentication required.",
      });
    }

    try {
      const subscription = await prisma.subscription.findUnique({
        where: { email },
        select: {
          plan: true,
          status: true,
          currentPeriodEnd: true,
          cancelAtPeriodEnd: true,
        },
      });

      if (!subscription) {
        return res.status(200).json({ subscription: null });
      }

      const planCode = isMembershipPlan(subscription.plan)
        ? subscription.plan
        : null;

      return res.status(200).json({
        subscription: {
          planCode,
          planName: planCode ? getMembershipPlanName(planCode) : null,
          status: subscription.status,
          currentPeriodEnd: subscription.currentPeriodEnd
            ? subscription.currentPeriodEnd.toISOString()
            : null,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd === true,
        },
      });
    } catch (error) {
      logError(
        "Member portal subscription lookup failed:",
        typeof error?.code === "string" ? error.code : "UNKNOWN"
      );
      return res.status(503).json({
        success: false,
        error: "Membership information is temporarily unavailable.",
      });
    }
  };
}

export {
  MEMBER_PORTAL_PATH,
  createMemberPortalAuthenticationMiddleware,
  createMemberPortalSubscriptionHandler,
  getMemberPortalAssertionConfig,
  verifyMemberPortalAssertion,
};
