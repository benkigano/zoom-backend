import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  MEMBER_PORTAL_PATH,
  createMemberPortalAuthenticationMiddleware,
  createMemberPortalSubscriptionHandler,
} from "../membership/memberPortal.js";

const TEST_NOW = Date.parse("2026-11-19T23:00:00.000Z");
const TEST_SECRET = "test-member-portal-secret-" + "x".repeat(40);
const TEST_AUDIENCE = "court-of-compassion-member-portal-test";
const TEST_ENV = {
  MEMBER_PORTAL_ASSERTION_SECRET: TEST_SECRET,
  MEMBER_PORTAL_ASSERTION_AUDIENCE: TEST_AUDIENCE,
};

function createAssertion(overrides = {}) {
  const nowSeconds = Math.floor(TEST_NOW / 1000);
  const claims = {
    iss: "wix-astro-member-portal",
    aud: TEST_AUDIENCE,
    iat: nowSeconds - 1,
    exp: nowSeconds + 59,
    endpoint: "GET /api/membership/me",
    sub: "wix-member-123",
    email: " Member@Example.com ",
    email_verified: true,
    ...overrides,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", TEST_SECRET)
    .update(payload)
    .digest("hex");

  return `${payload}.${signature}`;
}

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    set(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function createRequest({ token, query = {}, body } = {}) {
  return {
    method: "GET",
    path: MEMBER_PORTAL_PATH,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    query,
    body,
  };
}

function runAuthentication({ token, query, body, env = TEST_ENV } = {}) {
  const req = createRequest({ token, query, body });
  const res = createResponse();
  let nextCalled = false;
  const middleware = createMemberPortalAuthenticationMiddleware({
    env,
    now: () => TEST_NOW,
  });

  middleware(req, res, () => {
    nextCalled = true;
  });

  return { req, res, nextCalled };
}

test("requires a bearer identity assertion", () => {
  const { res, nextCalled } = runAuthentication();

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, {
    success: false,
    error: "Authentication required.",
  });
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(nextCalled, false);
});

test("fails closed when the signing configuration is missing or invalid", () => {
  for (const env of [
    { MEMBER_PORTAL_ASSERTION_AUDIENCE: TEST_AUDIENCE },
    {
      MEMBER_PORTAL_ASSERTION_SECRET: "too-short",
      MEMBER_PORTAL_ASSERTION_AUDIENCE: TEST_AUDIENCE,
    },
  ]) {
    const { res, nextCalled } = runAuthentication({
      token: createAssertion(),
      env,
    });

    assert.equal(res.statusCode, 503);
    assert.equal(nextCalled, false);
    assert.deepEqual(res.body, {
      success: false,
      error: "Membership information is temporarily unavailable.",
    });
  }
});

test("rejects malformed and forged assertion signatures", () => {
  const validToken = createAssertion();
  const [payload, signature] = validToken.split(".");
  const forgedSignature =
    (signature[0] === "0" ? "1" : "0") + signature.slice(1);

  for (const token of [
    `${payload}.not-a-signature`,
    `${payload}.${forgedSignature}`,
    "not-an-assertion",
  ]) {
    const { res, nextCalled } = runAuthentication({ token });
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
  }
});

test("rejects wrong audience, issuer, endpoint, expired, and future-issued assertions", () => {
  const nowSeconds = Math.floor(TEST_NOW / 1000);
  const invalidAssertions = [
    createAssertion({ aud: "another-service" }),
    createAssertion({ iss: "untrusted-issuer" }),
    createAssertion({ endpoint: "GET /api/membership/checkout" }),
    createAssertion({
      iat: nowSeconds - 180,
      exp: nowSeconds - 120,
    }),
    createAssertion({
      iat: nowSeconds + 31,
      exp: nowSeconds + 60,
    }),
  ];

  for (const token of invalidAssertions) {
    const { res, nextCalled } = runAuthentication({ token });
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
  }
});

test("rejects assertions without a verified member email", () => {
  const { res, nextCalled } = runAuthentication({
    token: createAssertion({ email_verified: false }),
  });

  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test("rejects caller-supplied identity parameters rather than using them", () => {
  const { res, nextCalled } = runAuthentication({
    token: createAssertion({ email: "member@example.com" }),
    query: { email: "another-member@example.com", memberId: "another-member" },
  });

  assert.equal(res.statusCode, 400);
  assert.equal(nextCalled, false);
  assert.deepEqual(res.body, {
    success: false,
    error: "Invalid request.",
  });
});

test("returns null when the authenticated member has no subscription", async () => {
  const { req, res, nextCalled } = runAuthentication({
    token: createAssertion(),
  });
  assert.equal(nextCalled, true);

  let query;
  const handler = createMemberPortalSubscriptionHandler({
    subscription: {
      async findUnique(input) {
        query = input;
        return null;
      },
    },
  });

  await handler(req, res);

  assert.deepEqual(query.where, { email: "member@example.com" });
  assert.deepEqual(res.body, { subscription: null });
  assert.equal(res.headers["cache-control"], "no-store");
});

test("returns only approved fields for the authenticated member", async () => {
  const { req, res, nextCalled } = runAuthentication({
    token: createAssertion(),
  });
  assert.equal(nextCalled, true);

  let query;
  const periodEnd = new Date("2027-01-15T00:00:00.000Z");
  const handler = createMemberPortalSubscriptionHandler({
    subscription: {
      async findUnique(input) {
        query = input;
        return {
          id: "database-id",
          email: "member@example.com",
          plan: "BASIC",
          status: "ACTIVE",
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: true,
          stripeCustomerId: "cus_private",
          stripeSubscriptionId: "sub_private",
          stripePriceId: "price_private",
        };
      },
    },
  });

  await handler(req, res);

  assert.deepEqual(query, {
    where: { email: "member@example.com" },
    select: {
      plan: true,
      status: true,
      currentPeriodEnd: true,
      cancelAtPeriodEnd: true,
    },
  });
  assert.deepEqual(res.body, {
    subscription: {
      planCode: "BASIC",
      planName: "Basic Membership",
      status: "ACTIVE",
      currentPeriodEnd: "2027-01-15T00:00:00.000Z",
      cancelAtPeriodEnd: true,
    },
  });
  assert.equal(res.headers["cache-control"], "no-store");
});

test("returns a generic service error when subscription lookup fails", async () => {
  const { req, res, nextCalled } = runAuthentication({
    token: createAssertion(),
  });
  assert.equal(nextCalled, true);

  const handler = createMemberPortalSubscriptionHandler(
    {
      subscription: {
        async findUnique() {
          const error = new Error("sensitive database detail");
          error.code = "DB_UNAVAILABLE";
          throw error;
        },
      },
    },
    () => {}
  );

  await handler(req, res);

  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, {
    success: false,
    error: "Membership information is temporarily unavailable.",
  });
});
