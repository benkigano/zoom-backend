
import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeMembershipEmail,
} from "../membership/guards.js";

test("normalizes email case and whitespace", () => {
  assert.equal(
    normalizeMembershipEmail(" Applicant@Example.com "),
    "applicant@example.com"
  );
});

test("preserves a valid normalized email", () => {
  assert.equal(
    normalizeMembershipEmail("member@example.com"),
    "member@example.com"
  );
});

test("rejects invalid email addresses", () => {
  for (const value of [
    "",
    "not-an-email",
    "missing@domain",
    "@example.com",
    "member example@example.com",
  ]) {
    assert.equal(normalizeMembershipEmail(value), null);
  }
});

test("rejects email addresses longer than 254 characters", () => {
  const email = "a".repeat(243) + "@example.com";

  assert.equal(normalizeMembershipEmail(email), null);
});

test("rejects missing email input", () => {
  assert.equal(normalizeMembershipEmail(null), null);
  assert.equal(normalizeMembershipEmail(undefined), null);
});
