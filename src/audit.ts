import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import type {
  Art50Config,
  DisclosureConfig,
  ProvenanceConfig,
  SurfaceConfig,
} from "./config.js";
import {
  DestinationPinStore,
  type GuardedSocksProxy,
  startGuardedSocksProxy,
} from "./guarded-socks-proxy.js";
import {
  createNetworkPolicy,
  NetworkPolicyError,
  resolveAndAuthorize,
  type NetworkPolicy,
} from "./network-policy.js";
import {
  inspectProvenance,
  type ProvenanceInspectionResult,
} from "./provenance.js";
import { redactUrlForReport, redactUrlsInText } from "./redact.js";
import { resolveTarget } from "./target.js";
import { TOOL_NAME, TOOL_VERSION } from "./version.js";

export type FailureCode =
  | "NAVIGATION_FAILED"
  | "HTTP_ERROR"
  | "WAIT_FOR_FAILED"
  | "SELECTOR_INVALID"
  | "SELECTOR_NOT_FOUND"
  | "VISIBILITY_MISMATCH"
  | "TEXT_MISMATCH"
  | "NOT_IN_VIEWPORT"
  | "OBSTRUCTED"
  | "ACCESSIBILITY_MISMATCH"
  | "CONTENT_SELECTOR_NOT_FOUND"
  | "NO_SINGLE_ELEMENT_MATCHED"
  | "NETWORK_POLICY_BLOCKED"
  | "FIRST_INTERACTION_NOT_FOUND"
  | "FIRST_INTERACTION_UNAVAILABLE"
  | "CHECK_FAILED"
  | "SCREENSHOT_FAILED";

export interface AuditFailure {
  code: FailureCode;
  message: string;
  surfaceId: string;
  disclosureId?: string;
  selector?: string;
  expected?: string;
  actual?: string;
}

export interface DisclosureCheckResult {
  disclosureId: string;
  selector: string;
  expectedText: string;
  match: DisclosureConfig["match"];
  expectedVisible: boolean;
  matchedElements: number;
  actualText: string | null;
  actualVisible: boolean | null;
  inViewport: boolean | null;
  unobstructed: boolean | null;
  coveredBy: string | null;
  accessible: boolean | null;
  accessibleName: string | null;
  contentSelector: string | null;
  contentMatched: boolean | null;
  observationPhase: "initial";
  passed: boolean;
  durationMs: number;
  failures: AuditFailure[];
}

export interface FirstInteractionCheckResult {
  selector: string;
  action: "focus" | "click";
  matchedElements: number;
  visible: boolean | null;
  enabled: boolean | null;
  passed: boolean;
  note: string;
}

export interface SurfaceAuditResult {
  surfaceId: string;
  name: string;
  kind: SurfaceConfig["kind"];
  target: string;
  resolvedTarget: string;
  finalUrl: string | null;
  httpStatus: number | null;
  screenshotPath: string | null;
  screenshotSha256: string | null;
  pageContentSha256: string | null;
  viewport: {
    width: number;
    height: number;
  };
  firstInteraction: FirstInteractionCheckResult | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  passed: boolean;
  checks: DisclosureCheckResult[];
  failures: AuditFailure[];
}

export type ProvenanceFailureCode =
  | "PROVENANCE_INSPECTION_FAILED"
  | "PROVENANCE_NETWORK_BLOCKED"
  | "MANIFEST_MISSING"
  | "MANIFEST_NOT_EMBEDDED"
  | "MANIFEST_INVALID"
  | "DIGITAL_SOURCE_TYPE_NOT_OBSERVED"
  | "SOURCE_ACTIVE_MANIFEST_LABEL_MISSING"
  | "SOURCE_MANIFEST_NOT_IN_DELIVERED_CHAIN";

export interface ProvenanceFailure {
  code: ProvenanceFailureCode;
  message: string;
  provenanceId: string;
  target: "source" | "delivered" | "comparison";
}

export interface ProvenanceAuditResult {
  provenanceId: string;
  name: string;
  source: ProvenanceInspectionResult | null;
  delivered: ProvenanceInspectionResult | null;
  requireManifest: boolean;
  requireEmbedded: boolean;
  requireSourceManifestInDeliveredChain: boolean;
  failOnInvalid: boolean;
  expectedDigitalSourceType: string | null;
  activeLabelPreserved: boolean | null;
  passed: boolean;
  failures: ProvenanceFailure[];
}

export interface AuditReport {
  schemaVersion: 2;
  tool: {
    name: string;
    version: string;
  };
  runId: string;
  mode: "audit" | "verify";
  project: string;
  configPath: string | null;
  configSha256: string;
  resultMeaning: string;
  environment: {
    node: string;
    platform: NodeJS.Platform;
    architecture: string;
    commitSha: string | null;
  };
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  passed: boolean;
  summary: {
    totalSurfaces: number;
    passedSurfaces: number;
    failedSurfaces: number;
    totalChecks: number;
    passedChecks: number;
    failedChecks: number;
    totalProvenance: number;
    passedProvenance: number;
    failedProvenance: number;
    totalFailures: number;
  };
  surfaces: SurfaceAuditResult[];
  provenance: ProvenanceAuditResult[];
}

export interface RunAuditOptions {
  baseDirectory: string;
  outputDirectory: string;
  configPath?: string;
  mode?: "audit" | "verify";
  headed?: boolean;
  trustedPrivateOrigins?: string[];
}

interface ElementState {
  text: string;
  visible: boolean;
  inViewport: boolean;
  unobstructed: boolean;
  coveredBy: string | null;
  accessibleName: string;
  accessible: boolean;
  contentMatched: boolean | null;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function timestampForFilename(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function textMatches(actual: string, disclosure: DisclosureConfig): boolean {
  const normalizedActual = normalizedText(actual);
  const normalizedExpected = normalizedText(disclosure.expectedText);
  const candidate = disclosure.caseSensitive
    ? normalizedActual
    : normalizedActual.toLocaleLowerCase();
  const expected = disclosure.caseSensitive
    ? normalizedExpected
    : normalizedExpected.toLocaleLowerCase();

  switch (disclosure.match) {
    case "exact":
      return candidate === expected;
    case "regex":
      return new RegExp(
        disclosure.expectedText,
        disclosure.caseSensitive ? "" : "i",
      ).test(normalizedActual);
    case "contains":
      return candidate.includes(expected);
  }
}

async function readElementState(
  locator: Locator,
  contentSelector: string | undefined,
): Promise<ElementState> {
  const [browserState, visible] = await Promise.all([
    locator.evaluate((element, configuredContentSelector) => {
      const renderedText =
        element instanceof HTMLElement ? element.innerText : element.textContent;
      const labelledBy = (element.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
        .filter(Boolean)
        .join(" ");
      const textCandidates = [
        renderedText,
        element.textContent,
        element.getAttribute("aria-label"),
        labelledBy,
        element.getAttribute("alt"),
        element.getAttribute("title"),
      ];
      const text =
        textCandidates.find(
          (candidate): candidate is string =>
            typeof candidate === "string" && candidate.trim().length > 0,
        )?.trim() ?? "";
      const accessibleNameCandidates = [
        element.getAttribute("aria-label"),
        labelledBy,
        element.getAttribute("alt"),
        element.getAttribute("title"),
        text,
      ];
      const accessibleName =
        accessibleNameCandidates.find(
          (candidate): candidate is string =>
            typeof candidate === "string" && candidate.trim().length > 0,
        )?.trim() ?? "";
      const rect = element.getBoundingClientRect();
      const inViewport =
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth;
      const insetX = Math.min(4, Math.max(0, rect.width / 4));
      const insetY = Math.min(4, Math.max(0, rect.height / 4));
      const candidatePoints: Array<[number, number]> = [
        [rect.left + rect.width / 2, rect.top + rect.height / 2],
        [rect.left + insetX, rect.top + insetY],
        [rect.right - insetX, rect.top + insetY],
        [rect.left + insetX, rect.bottom - insetY],
        [rect.right - insetX, rect.bottom - insetY],
      ];
      const points = candidatePoints.filter(
        ([x, y]) =>
          x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight,
      );
      const coveringElements = points
        .map(([x, y]) => document.elementFromPoint(x, y))
        .filter((candidate): candidate is Element => candidate !== null);
      const unobstructed =
        coveringElements.length > 0 &&
        coveringElements.some(
          (candidate) =>
            candidate === element ||
            element.contains(candidate) ||
            candidate.contains(element),
        );
      const coveringElement = coveringElements.find(
        (candidate) =>
          candidate !== element &&
          !element.contains(candidate) &&
          !candidate.contains(element),
      );
      const describeElement = (
        candidate: Element | undefined,
      ): string | null => {
        if (!candidate) {
          return null;
        }
        const id = candidate.id ? `#${candidate.id}` : "";
        const classes =
          candidate.classList.length > 0
            ? `.${Array.from(candidate.classList).slice(0, 3).join(".")}`
            : "";
        return `${candidate.tagName.toLocaleLowerCase()}${id}${classes}`;
      };
      let contentMatched: boolean | null = null;
      if (configuredContentSelector) {
        try {
          contentMatched =
            document.querySelector(configuredContentSelector) !== null;
        } catch {
          contentMatched = false;
        }
      }
      const hiddenFromAccessibilityTree =
        element.closest('[aria-hidden="true"]') !== null ||
        element.getAttribute("role") === "presentation" ||
        element.getAttribute("role") === "none";

      return {
        text,
        inViewport,
        unobstructed,
        coveredBy: describeElement(coveringElement),
        accessibleName,
        accessible: !hiddenFromAccessibilityTree && accessibleName.length > 0,
        contentMatched,
      };
    }, contentSelector),
    locator.isVisible(),
  ]);

  return { ...browserState, visible };
}

function emptyCheckResult(
  baseResult: Pick<
    DisclosureCheckResult,
    | "disclosureId"
    | "selector"
    | "expectedText"
    | "match"
    | "expectedVisible"
    | "contentSelector"
    | "observationPhase"
  >,
  failure: AuditFailure,
  durationMs: number,
  matchedElements = 0,
): DisclosureCheckResult {
  return {
    ...baseResult,
    matchedElements,
    actualText: null,
    actualVisible: null,
    inViewport: null,
    unobstructed: null,
    coveredBy: null,
    accessible: null,
    accessibleName: null,
    contentMatched: null,
    passed: false,
    durationMs,
    failures: [failure],
  };
}

async function checkDisclosure(
  page: Page,
  surface: SurfaceConfig,
  disclosure: DisclosureConfig,
): Promise<DisclosureCheckResult> {
  const started = performance.now();
  const baseResult = {
    disclosureId: disclosure.id,
    selector: disclosure.selector,
    expectedText: disclosure.expectedText,
    match: disclosure.match,
    expectedVisible: disclosure.visible,
    contentSelector: disclosure.contentSelector ?? null,
    observationPhase: "initial" as const,
  };

  let locator: Locator;
  let count: number;
  try {
    locator = page.locator(disclosure.selector);
    count = await locator.count();
  } catch (error) {
    return emptyCheckResult(
      baseResult,
      {
        code: "SELECTOR_INVALID",
        message: `Could not evaluate selector "${disclosure.selector}": ${
          redactUrlsInText(
            error instanceof Error ? error.message : String(error),
          )
        }`,
        surfaceId: surface.id,
        disclosureId: disclosure.id,
        selector: disclosure.selector,
      },
      Math.round(performance.now() - started),
    );
  }

  if (count === 0) {
    return emptyCheckResult(
      baseResult,
      {
        code: "SELECTOR_NOT_FOUND",
        message: `No element matched selector "${disclosure.selector}".`,
        surfaceId: surface.id,
        disclosureId: disclosure.id,
        selector: disclosure.selector,
        expected: disclosure.expectedText,
      },
      Math.round(performance.now() - started),
    );
  }

  try {
    const states: ElementState[] = [];
    for (let index = 0; index < Math.min(count, 20); index += 1) {
      states.push(
        await readElementState(locator.nth(index), disclosure.contentSelector),
      );
    }

    const accessibleNameMatches = (state: ElementState): boolean =>
      !disclosure.accessibleName ||
      normalizedText(state.accessibleName)
        .toLocaleLowerCase()
        .includes(
          normalizedText(disclosure.accessibleName).toLocaleLowerCase(),
        );
    const extraVisibleConditionsPass = (state: ElementState): boolean =>
      !disclosure.visible ||
      ((!disclosure.inViewport || state.inViewport) &&
        (!disclosure.unobstructed || state.unobstructed) &&
        (!disclosure.accessible ||
          (state.accessible && accessibleNameMatches(state))) &&
        (!disclosure.contentSelector || state.contentMatched === true));
    const passingState = states.find(
      (state) =>
        state.visible === disclosure.visible &&
        textMatches(state.text, disclosure) &&
        extraVisibleConditionsPass(state),
    );

    if (passingState) {
      return {
        ...baseResult,
        matchedElements: count,
        actualText: normalizedText(passingState.text),
        actualVisible: passingState.visible,
        inViewport: passingState.inViewport,
        unobstructed: passingState.unobstructed,
        coveredBy: passingState.coveredBy,
        accessible: passingState.accessible,
        accessibleName: normalizedText(passingState.accessibleName),
        contentMatched: passingState.contentMatched,
        passed: true,
        durationMs: Math.round(performance.now() - started),
        failures: [],
      };
    }

    const representative =
      states.find((state) => state.visible === disclosure.visible) ?? states[0];
    const failures: AuditFailure[] = [];
    const hasExpectedVisibility = states.some(
      (state) => state.visible === disclosure.visible,
    );

    if (!hasExpectedVisibility) {
      failures.push({
        code: "VISIBILITY_MISMATCH",
        message: `Matched elements were expected to be ${
          disclosure.visible ? "visible" : "hidden"
        }, but none were.`,
        surfaceId: surface.id,
        disclosureId: disclosure.id,
        selector: disclosure.selector,
        expected: String(disclosure.visible),
        actual: String(states.some((state) => state.visible)),
      });
    }

    if (!states.some((state) => textMatches(state.text, disclosure))) {
      failures.push({
        code: "TEXT_MISMATCH",
        message: `No matched element had text that ${disclosure.match} matched the expected disclosure.`,
        surfaceId: surface.id,
        disclosureId: disclosure.id,
        selector: disclosure.selector,
        expected: disclosure.expectedText,
        actual: states
          .slice(0, 3)
          .map((state) => normalizedText(state.text))
          .join(" | "),
      });
    }

    if (
      disclosure.visible &&
      disclosure.inViewport &&
      !states.some((state) => state.inViewport)
    ) {
      failures.push({
        code: "NOT_IN_VIEWPORT",
        message:
          "The disclosure was not observable in the initial viewport at the configured checkpoint.",
        surfaceId: surface.id,
        disclosureId: disclosure.id,
        selector: disclosure.selector,
      });
    }

    if (
      disclosure.visible &&
      disclosure.unobstructed &&
      !states.some((state) => state.unobstructed)
    ) {
      failures.push({
        code: "OBSTRUCTED",
        message:
          "No matched disclosure had an unobstructed sampled point in the initial viewport.",
        surfaceId: surface.id,
        disclosureId: disclosure.id,
        selector: disclosure.selector,
        actual: states
          .map((state) => state.coveredBy ?? "unknown")
          .join(" | "),
      });
    }

    if (
      disclosure.visible &&
      disclosure.accessible &&
      !states.some(
        (state) => state.accessible && accessibleNameMatches(state),
      )
    ) {
      const accessibilityFailure: AuditFailure = {
        code: "ACCESSIBILITY_MISMATCH",
        message: disclosure.accessibleName
          ? "No matched disclosure exposed the configured accessible name."
          : "No matched disclosure exposed a non-empty accessible name outside an aria-hidden or presentational subtree.",
        surfaceId: surface.id,
        disclosureId: disclosure.id,
        selector: disclosure.selector,
        actual: states
          .slice(0, 3)
          .map((state) => state.accessibleName)
          .join(" | "),
      };
      if (disclosure.accessibleName) {
        accessibilityFailure.expected = disclosure.accessibleName;
      }
      failures.push(accessibilityFailure);
    }

    if (
      disclosure.visible &&
      disclosure.contentSelector &&
      !states.some((state) => state.contentMatched === true)
    ) {
      failures.push({
        code: "CONTENT_SELECTOR_NOT_FOUND",
        message:
          "The configured content selector was not found, so the label-to-content checkpoint could not be observed.",
        surfaceId: surface.id,
        disclosureId: disclosure.id,
        selector: disclosure.contentSelector,
      });
    }

    if (failures.length === 0) {
      failures.push({
        code: "NO_SINGLE_ELEMENT_MATCHED",
        message:
          "Different matched elements satisfied separate expectations, but no single element satisfied every configured assertion.",
        surfaceId: surface.id,
        disclosureId: disclosure.id,
        selector: disclosure.selector,
      });
    }

    return {
      ...baseResult,
      matchedElements: count,
      actualText: representative ? normalizedText(representative.text) : null,
      actualVisible: representative?.visible ?? null,
      inViewport: representative?.inViewport ?? null,
      unobstructed: representative?.unobstructed ?? null,
      coveredBy: representative?.coveredBy ?? null,
      accessible: representative?.accessible ?? null,
      accessibleName: representative
        ? normalizedText(representative.accessibleName)
        : null,
      contentMatched: representative?.contentMatched ?? null,
      passed: false,
      durationMs: Math.round(performance.now() - started),
      failures,
    };
  } catch (error) {
    return emptyCheckResult(
      baseResult,
      {
        code: "CHECK_FAILED",
        message: `Disclosure check failed: ${
          redactUrlsInText(
            error instanceof Error ? error.message : String(error),
          )
        }`,
        surfaceId: surface.id,
        disclosureId: disclosure.id,
        selector: disclosure.selector,
      },
      Math.round(performance.now() - started),
      count,
    );
  }
}

async function checkFirstInteraction(
  page: Page,
  surface: SurfaceConfig,
): Promise<FirstInteractionCheckResult | null> {
  if (!surface.firstInteraction) {
    return null;
  }

  const base = {
    selector: surface.firstInteraction.selector,
    action: surface.firstInteraction.action,
  };
  let locator: Locator;
  let count = 0;
  try {
    locator = page.locator(surface.firstInteraction.selector);
    count = await locator.count();
  } catch {
    return {
      ...base,
      matchedElements: 0,
      visible: null,
      enabled: null,
      passed: false,
      note: "The configured first-interaction selector was invalid.",
    };
  }

  if (count === 0) {
    return {
      ...base,
      matchedElements: 0,
      visible: null,
      enabled: null,
      passed: false,
      note: "The configured first-interaction control was not found.",
    };
  }

  const first = locator.first();
  const [visible, enabled] = await Promise.all([
    first.isVisible(),
    first.isEnabled(),
  ]);
  return {
    ...base,
    matchedElements: count,
    visible,
    enabled,
    passed: visible && enabled,
    note:
      "Disclosure observations were captured before this configured first-interaction checkpoint; the action itself was not performed.",
  };
}

async function auditSurface(
  browser: Browser,
  config: Art50Config,
  surface: SurfaceConfig,
  options: RunAuditOptions,
  runId: string,
  networkPolicy: NetworkPolicy,
  pins: DestinationPinStore,
  guardedProxy: GuardedSocksProxy,
): Promise<SurfaceAuditResult> {
  const startedAtDate = new Date();
  const started = performance.now();
  const resolvedTarget = resolveTarget(surface.target, options.baseDirectory);
  const failures: AuditFailure[] = [];
  const checks: DisclosureCheckResult[] = [];
  const viewport = surface.viewport ?? config.browser.viewport;
  let finalUrl: string | null = null;
  let httpStatus: number | null = null;
  let screenshotPath: string | null = null;
  let screenshotSha256: string | null = null;
  let pageContentSha256: string | null = null;
  let firstInteraction: FirstInteractionCheckResult | null = null;

  pins.clear();
  const proxyViolationStart = guardedProxy.violations().length;
  const networkFailureKeys = new Set<string>();
  const addNetworkFailure = (destination: string, reason: string): void => {
    const safeDestination = redactUrlForReport(destination);
    const safeReason = redactUrlsInText(reason);
    const key = `${safeDestination}\n${safeReason}`;
    if (networkFailureKeys.has(key)) {
      return;
    }
    networkFailureKeys.add(key);
    failures.push({
      code: "NETWORK_POLICY_BLOCKED",
      message: `Network policy blocked ${safeDestination}: ${safeReason}`,
      surfaceId: surface.id,
    });
  };
  const context = await browser.newContext({
    viewport,
    serviceWorkers: "block",
    acceptDownloads: false,
  });
  const allowedFileRoot = await realpath(options.baseDirectory);

  await context.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    try {
      const parsed = new URL(requestUrl);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        let redirectDepth = 0;
        let redirectedFrom = route.request().redirectedFrom();
        while (redirectedFrom) {
          redirectDepth += 1;
          redirectedFrom = redirectedFrom.redirectedFrom();
        }
        if (redirectDepth > networkPolicy.maxRedirects) {
          throw new NetworkPolicyError(
            "TOO_MANY_REDIRECTS",
            `Redirect depth exceeded ${networkPolicy.maxRedirects}.`,
          );
        }
        pins.authorize(
          await resolveAndAuthorize(requestUrl, "browser", networkPolicy),
        );
        await route.continue();
        return;
      }
      if (parsed.protocol === "file:") {
        const candidate = await realpath(fileURLToPath(parsed));
        if (
          candidate !== allowedFileRoot &&
          !candidate.startsWith(`${allowedFileRoot}${path.sep}`)
        ) {
          throw new Error(
            "File targets and subresources must stay inside the configuration directory.",
          );
        }
        await route.continue();
        return;
      }
      if (
        parsed.protocol === "data:" ||
        parsed.protocol === "blob:" ||
        parsed.protocol === "about:"
      ) {
        await route.continue();
        return;
      }
      throw new Error(`Protocol "${parsed.protocol}" is not allowed.`);
    } catch (error) {
      addNetworkFailure(
        requestUrl,
        error instanceof Error ? error.message : String(error),
      );
      await route.abort("blockedbyclient");
    }
  });
  await context.routeWebSocket(/.*/u, async (socket) => {
    try {
      pins.authorize(
        await resolveAndAuthorize(socket.url(), "browser", networkPolicy),
      );
      socket.connectToServer();
    } catch (error) {
      addNetworkFailure(
        socket.url(),
        error instanceof Error ? error.message : String(error),
      );
      await socket.close({
        code: 1008,
        reason: "Blocked by art50-ci network policy.",
      });
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(config.browser.timeoutMs);
  page.setDefaultNavigationTimeout(config.browser.timeoutMs);

  let navigationSucceeded = false;
  try {
    const response = await page.goto(resolvedTarget, {
      waitUntil: config.browser.waitUntil,
      timeout: config.browser.timeoutMs,
    });
    navigationSucceeded = true;
    finalUrl = page.url();
    httpStatus = response?.status() ?? null;

    if (httpStatus !== null && httpStatus >= 400) {
      failures.push({
        code: "HTTP_ERROR",
        message: `Target returned HTTP ${httpStatus}.`,
        surfaceId: surface.id,
        actual: String(httpStatus),
      });
    }
  } catch (error) {
    failures.push({
      code: "NAVIGATION_FAILED",
      message: `Could not load ${redactUrlForReport(resolvedTarget)}: ${
        redactUrlsInText(
          error instanceof Error ? error.message : String(error),
        )
      }`,
      surfaceId: surface.id,
    });
  }

  if (navigationSucceeded && surface.waitFor) {
    try {
      await page.locator(surface.waitFor).first().waitFor({
        state: "visible",
        timeout: config.browser.timeoutMs,
      });
    } catch (error) {
      failures.push({
        code: "WAIT_FOR_FAILED",
        message: `Timed out waiting for "${surface.waitFor}": ${
          redactUrlsInText(
            error instanceof Error ? error.message : String(error),
          )
        }`,
        surfaceId: surface.id,
        selector: surface.waitFor,
      });
    }
  }

  if (navigationSucceeded) {
    pageContentSha256 = sha256(await page.content());
    for (const disclosure of surface.disclosures) {
      checks.push(await checkDisclosure(page, surface, disclosure));
    }
    firstInteraction = await checkFirstInteraction(page, surface);
    if (firstInteraction && !firstInteraction.passed) {
      failures.push({
        code:
          firstInteraction.matchedElements === 0
            ? "FIRST_INTERACTION_NOT_FOUND"
            : "FIRST_INTERACTION_UNAVAILABLE",
        message: firstInteraction.note,
        surfaceId: surface.id,
        selector: firstInteraction.selector,
      });
    }
  }

  if (config.output.screenshots) {
    const screenshotDirectory = path.join(
      options.outputDirectory,
      "screenshots",
    );
    const filename = `${safeFilename(surface.id)}-${runId}.png`;
    const intendedScreenshotPath = path.join(screenshotDirectory, filename);
    screenshotPath = intendedScreenshotPath;
    try {
      await mkdir(screenshotDirectory, { recursive: true });
      const masks: Locator[] = [];
      for (const selector of config.output.redactSelectors) {
        const mask = page.locator(selector);
        await mask.count();
        masks.push(mask);
      }
      await page.screenshot({
        path: intendedScreenshotPath,
        fullPage: true,
        mask: masks,
        maskColor: "#222222",
      });
      screenshotSha256 = sha256(await readFile(screenshotPath));
    } catch (error) {
      failures.push({
        code: "SCREENSHOT_FAILED",
        message: `Could not capture screenshot: ${
          redactUrlsInText(
            error instanceof Error ? error.message : String(error),
          )
        }`,
        surfaceId: surface.id,
      });
      screenshotPath = null;
      screenshotSha256 = null;
    }
  }

  await context.close();
  for (const violation of guardedProxy
    .violations()
    .slice(proxyViolationStart)) {
    addNetworkFailure(violation.destination, violation.reason);
  }
  pins.clear();
  failures.push(...checks.flatMap((check) => check.failures));
  const finishedAtDate = new Date();

  return {
    surfaceId: surface.id,
    name: surface.name ?? surface.id,
    kind: surface.kind,
    target: redactUrlForReport(surface.target),
    resolvedTarget: redactUrlForReport(resolvedTarget),
    finalUrl: finalUrl ? redactUrlForReport(finalUrl) : null,
    httpStatus,
    screenshotPath,
    screenshotSha256,
    pageContentSha256,
    viewport,
    firstInteraction,
    startedAt: startedAtDate.toISOString(),
    finishedAt: finishedAtDate.toISOString(),
    durationMs: Math.round(performance.now() - started),
    passed: failures.length === 0 && checks.every((check) => check.passed),
    checks,
    failures,
  };
}

function evaluateProvenanceObservation(
  config: ProvenanceConfig,
  observation: ProvenanceInspectionResult,
  target: "source" | "delivered",
): ProvenanceFailure[] {
  const failures: ProvenanceFailure[] = [];
  if (observation.c2pa.inspectionError) {
    failures.push({
      code: "PROVENANCE_INSPECTION_FAILED",
      message: `C2PA inspection could not complete: ${observation.c2pa.inspectionError}`,
      provenanceId: config.id,
      target,
    });
    return failures;
  }
  if (config.requireManifest && !observation.c2pa.manifestPresent) {
    failures.push({
      code: "MANIFEST_MISSING",
      message:
        "The configured C2PA manifest expectation was not observed in the inspected bytes.",
      provenanceId: config.id,
      target,
    });
    return failures;
  }
  if (
    config.requireEmbedded &&
    observation.c2pa.manifestPresent &&
    observation.c2pa.embedded !== true
  ) {
    failures.push({
      code: "MANIFEST_NOT_EMBEDDED",
      message:
        "A manifest was observed, but it was not embedded as configured.",
      provenanceId: config.id,
      target,
    });
  }
  if (
    config.failOnInvalid &&
    (observation.c2pa.validationState === "Invalid" ||
      observation.c2pa.validationStatuses.some(
        (status) => status.success === false,
      ))
  ) {
    failures.push({
      code: "MANIFEST_INVALID",
      message:
        "The C2PA reader reported an invalid state or a failed validation status.",
      provenanceId: config.id,
      target,
    });
  }
  if (
    config.expectedDigitalSourceType &&
    !observation.c2pa.digitalSourceTypes.includes(
      config.expectedDigitalSourceType,
    )
  ) {
    failures.push({
      code: "DIGITAL_SOURCE_TYPE_NOT_OBSERVED",
      message:
        "The configured digital source type was not observed in the active manifest.",
      provenanceId: config.id,
      target,
    });
  }
  return failures;
}

interface ManifestChainObservation {
  manifestPresent: boolean;
  activeLabel: string | null;
  manifestAncestryLabels: readonly string[];
}

export function evaluateSourceManifestInDeliveredChain(
  provenanceId: string,
  source: ManifestChainObservation,
  delivered: ManifestChainObservation | null,
): ProvenanceFailure[] {
  if (!source.activeLabel) {
    return [
      {
        code: "SOURCE_ACTIVE_MANIFEST_LABEL_MISSING",
        message:
          "The source manifest store had no active label, so source-to-delivery chain comparison could not be performed.",
        provenanceId,
        target: "comparison",
      },
    ];
  }

  if (
    delivered &&
    (!delivered.manifestPresent ||
      !delivered.manifestAncestryLabels.includes(source.activeLabel))
  ) {
    return [
      {
        code: "SOURCE_MANIFEST_NOT_IN_DELIVERED_CHAIN",
        message:
          "The source C2PA manifest was not observed in the delivered asset's manifest chain.",
        provenanceId,
        target: "comparison",
      },
    ];
  }

  return [];
}

async function auditProvenance(
  config: ProvenanceConfig,
  options: RunAuditOptions,
  networkPolicy: NetworkPolicy,
): Promise<ProvenanceAuditResult> {
  const failures: ProvenanceFailure[] = [];
  const evidenceDirectory = path.join(options.outputDirectory, "provenance");
  let source: ProvenanceInspectionResult | null = null;
  let delivered: ProvenanceInspectionResult | null = null;

  if (config.source) {
    try {
      source = await inspectProvenance({
        id: `${config.id}-source`,
        target: config.source,
        baseDirectory: options.baseDirectory,
        evidenceDirectory,
        maxBytes: config.maxBytes,
        networkPolicy,
      });
      failures.push(...evaluateProvenanceObservation(config, source, "source"));
    } catch (error) {
      failures.push({
        code:
          error instanceof NetworkPolicyError
            ? "PROVENANCE_NETWORK_BLOCKED"
            : "PROVENANCE_INSPECTION_FAILED",
        message: `Could not inspect source asset: ${
          redactUrlsInText(
            error instanceof Error ? error.message : String(error),
          )
        }`,
        provenanceId: config.id,
        target: "source",
      });
    }
  }

  if (config.delivered) {
    try {
      delivered = await inspectProvenance({
        id: `${config.id}-delivered`,
        target: config.delivered,
        baseDirectory: options.baseDirectory,
        evidenceDirectory,
        maxBytes: config.maxBytes,
        networkPolicy,
      });
      failures.push(
        ...evaluateProvenanceObservation(config, delivered, "delivered"),
      );
    } catch (error) {
      failures.push({
        code:
          error instanceof NetworkPolicyError
            ? "PROVENANCE_NETWORK_BLOCKED"
            : "PROVENANCE_INSPECTION_FAILED",
        message: `Could not inspect delivered asset: ${
          redactUrlsInText(
            error instanceof Error ? error.message : String(error),
          )
        }`,
        provenanceId: config.id,
        target: "delivered",
      });
    }
  }

  if (
    config.requireSourceManifestInDeliveredChain &&
    source?.c2pa.manifestPresent
  ) {
    failures.push(
      ...evaluateSourceManifestInDeliveredChain(
        config.id,
        source.c2pa,
        delivered?.c2pa ?? null,
      ),
    );
  }

  const activeLabelPreserved =
    source?.c2pa.activeLabel && delivered?.c2pa.activeLabel
      ? delivered.c2pa.manifestAncestryLabels.includes(
          source.c2pa.activeLabel,
        )
      : null;

  return {
    provenanceId: config.id,
    name: config.name ?? config.id,
    source,
    delivered,
    requireManifest: config.requireManifest,
    requireEmbedded: config.requireEmbedded,
    requireSourceManifestInDeliveredChain:
      config.requireSourceManifestInDeliveredChain,
    failOnInvalid: config.failOnInvalid,
    expectedDigitalSourceType: config.expectedDigitalSourceType ?? null,
    activeLabelPreserved,
    passed: failures.length === 0,
    failures,
  };
}

export async function runAudit(
  config: Art50Config,
  options: RunAuditOptions,
): Promise<AuditReport> {
  const startedAtDate = new Date();
  const started = performance.now();
  const runId = `${timestampForFilename(startedAtDate)}-${randomUUID().slice(0, 8)}`;
  await mkdir(options.outputDirectory, { recursive: true });
  const configuredTargets = [
    ...config.surfaces.map((surface) =>
      resolveTarget(surface.target, options.baseDirectory),
    ),
    ...config.provenance.flatMap((item) =>
      [item.source, item.delivered]
        .filter((target): target is string => Boolean(target))
        .map((target) => resolveTarget(target, options.baseDirectory)),
    ),
  ];
  const networkPolicy = createNetworkPolicy({
    maxRedirects: config.network.maxRedirects,
    requestedPrivateOrigins: config.network.requestedPrivateOrigins,
    trustedPrivateOrigins: options.trustedPrivateOrigins ?? [],
    configuredTargets,
  });

  const surfaces: SurfaceAuditResult[] = [];
  if (config.surfaces.length > 0) {
    const pins = new DestinationPinStore();
    const guardedProxy = await startGuardedSocksProxy(pins);
    let browser: Browser | null = null;
    try {
      browser = await chromium.launch({
        headless: !options.headed,
        proxy: {
          server: guardedProxy.url,
          bypass: "<-loopback>",
        },
        args: [
          "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
          "--disable-quic",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        ],
      });
      for (const surface of config.surfaces) {
        surfaces.push(
          await auditSurface(
            browser,
            config,
            surface,
            options,
            runId,
            networkPolicy,
            pins,
            guardedProxy,
          ),
        );
      }
    } finally {
      try {
        await browser?.close();
      } finally {
        await guardedProxy.close();
      }
    }
  }
  const provenance: ProvenanceAuditResult[] = [];
  for (const provenanceConfig of config.provenance) {
    provenance.push(
      await auditProvenance(provenanceConfig, options, networkPolicy),
    );
  }

  const finishedAtDate = new Date();
  const checks = surfaces.flatMap((surface) => surface.checks);
  const surfaceFailures = surfaces.flatMap((surface) => surface.failures);
  const provenanceFailures = provenance.flatMap((result) => result.failures);

  return {
    schemaVersion: 2,
    tool: {
      name: TOOL_NAME,
      version: TOOL_VERSION,
    },
    runId,
    mode: options.mode ?? "audit",
    project: config.project.name,
    configPath: options.configPath ?? null,
    configSha256: sha256(JSON.stringify(config)),
    resultMeaning:
      "PASS means only that the configured technical condition was observed at the recorded time. It is not a legal compliance conclusion or certification.",
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      commitSha: process.env.GITHUB_SHA ?? null,
    },
    startedAt: startedAtDate.toISOString(),
    finishedAt: finishedAtDate.toISOString(),
    durationMs: Math.round(performance.now() - started),
    passed:
      surfaces.every((surface) => surface.passed) &&
      provenance.every((result) => result.passed),
    summary: {
      totalSurfaces: surfaces.length,
      passedSurfaces: surfaces.filter((surface) => surface.passed).length,
      failedSurfaces: surfaces.filter((surface) => !surface.passed).length,
      totalChecks: checks.length,
      passedChecks: checks.filter((check) => check.passed).length,
      failedChecks: checks.filter((check) => !check.passed).length,
      totalProvenance: provenance.length,
      passedProvenance: provenance.filter((result) => result.passed).length,
      failedProvenance: provenance.filter((result) => !result.passed).length,
      totalFailures: surfaceFailures.length + provenanceFailures.length,
    },
    surfaces,
    provenance,
  };
}
