const MODE_ENV = "COURT_STUDY_WORKFLOW_MODE";
const TEST_REQUEST_IDS_ENV =
  "COURT_STUDY_WORKFLOW_TEST_REQUEST_IDS";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const WORKFLOW_MODES = new Set([
  "NORMAL",
  "PAUSED",
  "CONTROLLED_TESTING",
]);

const WORKFLOW_ROUTES = [
  {
    method: "GET",
    path: "/court-study/zoom/authorize-organizer/:requestId",
    requestIdSource: "params.requestId",
    lookupCommunityRequest: true,
  },
  {
    method: "GET",
    path: [
      "/court-study/zoom/callback",
      "/court-study/zoom/callback/dev",
    ],
    sharedOAuthCallback: true,
  },
  {
    method: "POST",
    path: "/api/book-study/use-basic-duration",
    requestIdSource: "body.requestId",
  },
  {
    method: "POST",
    path: "/api/court-study-requests/:id/schedule",
    requestIdSource: "params.id",
    lookupCommunityRequest: true,
  },
  {
    method: "POST",
    path: "/api/court-study-requests/:id/create-zoom",
    requestIdSource: "params.id",
    lookupCommunityRequest: true,
  },
  {
    method: "POST",
    path: "/api/court-study-requests/:id/send-invitation",
    requestIdSource: "params.id",
    lookupCommunityRequest: true,
  },
  {
    method: "POST",
    path: "/api/court-study-requests/:id/manual-zoom",
    trackingOnly: true,
  },
  {
    method: "POST",
    path: "/court-study/zoom/test-create-organizer-meeting/:requestId",
    requestIdSource: "params.requestId",
    lookupCommunityRequest: true,
  },
];

function invalidConfiguration() {
  return {
    valid: false,
    mode: "INVALID",
    testRequestIds: [],
  };
}

export function parseCourtStudyWorkflowConfiguration(
  env = process.env
) {
  const rawMode = env?.[MODE_ENV];

  if (typeof rawMode !== "string" || !rawMode.trim()) {
    return invalidConfiguration();
  }

  const mode = rawMode;

  if (!WORKFLOW_MODES.has(mode)) {
    return invalidConfiguration();
  }

  const rawTestRequestIds = env?.[TEST_REQUEST_IDS_ENV];
  const hasTestRequestIds = rawTestRequestIds !== undefined;

  if (mode !== "CONTROLLED_TESTING" && hasTestRequestIds) {
    return invalidConfiguration();
  }

  if (mode !== "CONTROLLED_TESTING") {
    return {
      valid: true,
      mode,
      testRequestIds: [],
    };
  }

  if (!hasTestRequestIds) {
    return invalidConfiguration();
  }

  const testRequestIds = rawTestRequestIds
    .split(",")
    .map((requestId) => requestId.trim());

  if (
    testRequestIds.length === 0 ||
    testRequestIds.length > 100 ||
    testRequestIds.some(
      (requestId) => !REQUEST_ID_PATTERN.test(requestId)
    ) ||
    new Set(testRequestIds).size !== testRequestIds.length
  ) {
    return invalidConfiguration();
  }

  return {
    valid: true,
    mode,
    testRequestIds,
  };
}

export function classifyCourtStudyOAuthCallbackState(state) {
  if (
    !state ||
    typeof state !== "object" ||
    Array.isArray(state)
  ) {
    return { kind: "AMBIGUOUS" };
  }

  const hasOwn = (key) =>
    Object.prototype.hasOwnProperty.call(state, key);
  const hasStudyMarker = [
    "requestId",
    "studyContext",
    "studyAuthorizationSignature",
    "studyRecheck",
  ].some(hasOwn);
  const requestId =
    typeof state.requestId === "string"
      ? state.requestId.trim()
      : "";
  const organizerEmail =
    typeof state.organizerEmail === "string"
      ? state.organizerEmail.trim()
      : "";
  const invitationToken =
    typeof state.invitationToken === "string"
      ? state.invitationToken.trim()
      : "";
  const churchContactId =
    typeof state.churchContactId === "string"
      ? state.churchContactId.trim()
      : "";

  if (hasStudyMarker) {
    if (
      requestId &&
      organizerEmail &&
      invitationToken &&
      !churchContactId &&
      state.reviewerFlow !== true
    ) {
      return {
        kind: "STUDY",
        requestId,
      };
    }

    return { kind: "AMBIGUOUS" };
  }

  if (
    churchContactId &&
    !organizerEmail &&
    !state.reviewerFlow &&
    !state.reauthOnly
  ) {
    return { kind: "UNRELATED" };
  }

  if (
    !requestId &&
    !churchContactId &&
    organizerEmail &&
    invitationToken &&
    (state.reviewerFlow === true ||
      state.reauthOnly === true)
  ) {
    return { kind: "UNRELATED" };
  }

  if (organizerEmail || invitationToken || churchContactId) {
    return { kind: "AMBIGUOUS" };
  }

  return { kind: "UNRELATED" };
}

export function getCourtStudyWorkflowRoute(
  method,
  routePath
) {
  const normalizedMethod = String(method || "").toUpperCase();
  const candidatePaths = Array.isArray(routePath)
    ? routePath
    : [routePath];

  return (
    WORKFLOW_ROUTES.find(
      (route) =>
        route.method === normalizedMethod &&
        candidatePaths.some((path) =>
          Array.isArray(route.path)
            ? route.path.includes(path)
            : route.path === path
        )
    ) || null
  );
}

export function isCommunityHostedStudyRequest(request) {
  return (
    String(request?.meetingFormat || "")
      .trim()
      .toUpperCase() === "COMMUNITY_HOSTED"
  );
}

function evaluateConfiguration(configuration, requestId) {
  if (!configuration?.valid) {
    return {
      allowed: false,
      reason: "CONFIGURATION_INVALID",
      mode: "INVALID",
    };
  }

  if (configuration.mode === "PAUSED") {
    return {
      allowed: false,
      reason: "PAUSED",
      mode: configuration.mode,
    };
  }

  if (configuration.mode === "NORMAL") {
    return {
      allowed: true,
      reason: null,
      mode: configuration.mode,
    };
  }

  const normalizedRequestId =
    typeof requestId === "string" ? requestId : "";

  if (
    !REQUEST_ID_PATTERN.test(normalizedRequestId) ||
    !configuration.testRequestIds.includes(normalizedRequestId)
  ) {
    return {
      allowed: false,
      reason: "REQUEST_NOT_ALLOWLISTED",
      mode: configuration.mode,
    };
  }

  return {
    allowed: true,
    reason: null,
    mode: configuration.mode,
  };
}

export function createCourtStudyWorkflowGate({
  getConfiguration = () =>
    parseCourtStudyWorkflowConfiguration(process.env),
} = {}) {
  let acceptingOperations = true;
  let activeOperationCount = 0;
  const drainWaiters = new Set();

  function reserveOperation() {
    if (!acceptingOperations) {
      return null;
    }

    activeOperationCount += 1;
    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;
      activeOperationCount -= 1;

      if (activeOperationCount === 0) {
        for (const resolve of [...drainWaiters]) {
          resolve({
            drained: true,
            activeOperations: 0,
          });
        }
      }
    };
  }

  function enter(requestId) {
    let configuration;

    try {
      configuration = getConfiguration();
    } catch {
      configuration = invalidConfiguration();
    }

    const decision = evaluateConfiguration(
      configuration,
      requestId
    );

    if (!decision.allowed) {
      return {
        ...decision,
        release() {},
      };
    }

    const release = reserveOperation();

    if (!release) {
      return {
        allowed: false,
        reason: "SHUTTING_DOWN",
        mode: decision.mode,
        release() {},
      };
    }

    return {
      ...decision,
      release,
    };
  }

  async function run(requestId, operation) {
    if (typeof operation !== "function") {
      throw new TypeError("A study operation callback is required.");
    }

    const admission = enter(requestId);

    if (!admission.allowed) {
      return {
        admitted: false,
        reason: admission.reason,
        mode: admission.mode,
      };
    }

    try {
      return {
        admitted: true,
        value: await operation(),
      };
    } finally {
      admission.release();
    }
  }

  async function runTracked(operation) {
    if (typeof operation !== "function") {
      throw new TypeError("A tracked operation callback is required.");
    }

    const release = reserveOperation();

    if (!release) {
      return {
        admitted: false,
        reason: "SHUTTING_DOWN",
      };
    }

    try {
      return {
        admitted: true,
        value: await operation(),
      };
    } finally {
      release();
    }
  }

  function stopAccepting() {
    acceptingOperations = false;
  }

  function waitForDrain(timeoutMs) {
    if (activeOperationCount === 0) {
      return Promise.resolve({
        drained: true,
        activeOperations: 0,
      });
    }

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.resolve({
        drained: false,
        activeOperations: activeOperationCount,
      });
    }

    return new Promise((resolve) => {
      let settled = false;
      let timer;

      const finish = (result) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        drainWaiters.delete(onDrain);
        resolve(result);
      };

      const onDrain = () =>
        finish({
          drained: true,
          activeOperations: 0,
        });

      drainWaiters.add(onDrain);
      timer = setTimeout(
        () =>
          finish({
            drained: false,
            activeOperations: activeOperationCount,
          }),
        timeoutMs
      );
    });
  }

  return {
    enter,
    run,
    runTracked,
    stopAccepting,
    waitForDrain,
    getActiveOperationCount: () => activeOperationCount,
  };
}
