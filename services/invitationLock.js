import pg from "pg";

const { Client } = pg;

// Dedicated advisory-lock namespace for
// Court of Compassion post-session invitations.
const LOCK_NAMESPACE = 671204;

export async function withPostSessionInvitationLock({
  requestId,
  callback,
}) {
  const id = String(requestId || "").trim();

  if (!id) {
    throw new Error(
      "Post-session invitation lock requires a request ID."
    );
  }

  if (typeof callback !== "function") {
    throw new Error(
      "Post-session invitation lock requires a callback."
    );
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  let connected = false;
  let lockAcquired = false;

  try {
    await client.connect();
    connected = true;

    const result = await client.query(
      `SELECT pg_try_advisory_lock(
        $1::integer,
        hashtext($2)
      ) AS acquired`,
      [LOCK_NAMESPACE, id]
    );

    lockAcquired =
      result.rows[0]?.acquired === true;

    if (!lockAcquired) {
      return {
        acquired: false,
        requestId: id,
      };
    }

    const callbackResult = await callback();

    return {
      acquired: true,
      requestId: id,
      result: callbackResult,
    };
  } finally {
    if (connected) {
      try {
        if (lockAcquired) {
          await client.query(
            `SELECT pg_advisory_unlock(
              $1::integer,
              hashtext($2)
            )`,
            [LOCK_NAMESPACE, id]
          );
        }
      } finally {
        await client.end();
      }
    }
  }
}
