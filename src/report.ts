import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AuditFailure,
  AuditReport,
  DisclosureCheckResult,
  ProvenanceAuditResult,
  ProvenanceFailure,
  SurfaceAuditResult,
} from "./audit.js";
import { sanitizeReportValue } from "./redact.js";

export interface WrittenReports {
  jsonPath: string;
  htmlPath: string;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function statusBadge(passed: boolean): string {
  return `<span class="badge ${passed ? "pass" : "fail"}">${
    passed ? "PASS" : "FAIL"
  }</span>`;
}

function renderFailure(failure: AuditFailure): string {
  const details = [
    failure.selector && `<div><strong>Selector:</strong> <code>${escapeHtml(failure.selector)}</code></div>`,
    failure.expected !== undefined &&
      `<div><strong>Expected:</strong> <code>${escapeHtml(failure.expected)}</code></div>`,
    failure.actual !== undefined &&
      `<div><strong>Actual:</strong> <code>${escapeHtml(failure.actual)}</code></div>`,
  ]
    .filter(Boolean)
    .join("");

  return `<li>
    <div><strong>${escapeHtml(failure.code)}</strong> — ${escapeHtml(failure.message)}</div>
    ${details}
  </li>`;
}

function renderCheck(check: DisclosureCheckResult): string {
  return `<tr>
    <td>${statusBadge(check.passed)}</td>
    <td><code>${escapeHtml(check.disclosureId)}</code></td>
    <td><code>${escapeHtml(check.selector)}</code></td>
    <td>${escapeHtml(check.match)} “${escapeHtml(check.expectedText)}”</td>
    <td>${check.actualText === null ? "—" : escapeHtml(check.actualText)}</td>
    <td>${check.inViewport === null ? "—" : check.inViewport ? "yes" : "no"}</td>
    <td>${check.unobstructed === null ? "—" : check.unobstructed ? "yes" : `no${check.coveredBy ? ` · ${escapeHtml(check.coveredBy)}` : ""}`}</td>
    <td>${check.accessible === null ? "—" : check.accessible ? `yes${check.accessibleName ? ` · ${escapeHtml(check.accessibleName)}` : ""}` : "no"}</td>
    <td>${escapeHtml(check.durationMs)} ms</td>
  </tr>`;
}

function renderSurface(
  surface: SurfaceAuditResult,
  reportDirectory: string,
): string {
  const screenshot = surface.screenshotPath
    ? path.relative(reportDirectory, surface.screenshotPath).replaceAll("\\", "/")
    : null;

  return `<section class="surface">
    <div class="surface-heading">
      <div>
        <h2>${escapeHtml(surface.name)}</h2>
        <div class="muted"><code>${escapeHtml(surface.surfaceId)}</code> · ${escapeHtml(surface.kind)}</div>
      </div>
      ${statusBadge(surface.passed)}
    </div>
    <dl>
      <dt>Target</dt><dd><code>${escapeHtml(surface.resolvedTarget)}</code></dd>
      <dt>Final URL</dt><dd>${surface.finalUrl ? `<code>${escapeHtml(surface.finalUrl)}</code>` : "—"}</dd>
      <dt>HTTP</dt><dd>${surface.httpStatus ?? "—"}</dd>
      <dt>Viewport</dt><dd>${escapeHtml(surface.viewport.width)} × ${escapeHtml(surface.viewport.height)}</dd>
      <dt>Page hash</dt><dd>${surface.pageContentSha256 ? `<code>${escapeHtml(surface.pageContentSha256)}</code>` : "—"}</dd>
      <dt>Screenshot hash</dt><dd>${surface.screenshotSha256 ? `<code>${escapeHtml(surface.screenshotSha256)}</code>` : "—"}</dd>
      <dt>Duration</dt><dd>${escapeHtml(surface.durationMs)} ms</dd>
    </dl>
    ${
      surface.firstInteraction
        ? `<div class="checkpoint ${surface.firstInteraction.passed ? "checkpoint-pass" : "checkpoint-fail"}">
            <strong>First-interaction checkpoint:</strong>
            <code>${escapeHtml(surface.firstInteraction.selector)}</code>
            · ${surface.firstInteraction.visible ? "visible" : "not visible"}
            · ${surface.firstInteraction.enabled ? "enabled" : "not enabled"}
            <div class="muted">${escapeHtml(surface.firstInteraction.note)}</div>
          </div>`
        : `<p class="muted">No first-interaction checkpoint was declared; disclosure observations were captured in the initial page state.</p>`
    }
    ${
      screenshot
        ? `<a class="screenshot-link" href="${escapeHtml(encodeURI(screenshot))}">Open screenshot</a>
           <img class="screenshot" src="${escapeHtml(encodeURI(screenshot))}" alt="Screenshot of ${escapeHtml(surface.name)}">`
        : ""
    }
    <h3>Disclosure checks</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Status</th><th>ID</th><th>Selector</th><th>Expected</th><th>Actual</th><th>Viewport</th><th>Unobstructed</th><th>Accessible</th><th>Time</th></tr></thead>
        <tbody>${surface.checks.map(renderCheck).join("") || `<tr><td colspan="9">No checks ran.</td></tr>`}</tbody>
      </table>
    </div>
    ${
      surface.failures.length > 0
        ? `<h3>Failures</h3><ul class="failures">${surface.failures
            .map(renderFailure)
            .join("")}</ul>`
        : ""
    }
  </section>`;
}

function renderProvenanceFailure(failure: ProvenanceFailure): string {
  return `<li>
    <div><strong>${escapeHtml(failure.code)}</strong> — ${escapeHtml(failure.message)}</div>
    <div class="muted">Checkpoint: ${escapeHtml(failure.target)}</div>
  </li>`;
}

function renderProvenanceObservation(
  label: string,
  observation: NonNullable<ProvenanceAuditResult["source"]>,
): string {
  const statuses =
    observation.c2pa.validationStatuses.length > 0
      ? `<ul>${observation.c2pa.validationStatuses
          .map(
            (status) =>
              `<li><code>${escapeHtml(status.code)}</code>${status.success === null ? "" : status.success ? " · success" : " · failure"}${status.explanation ? ` — ${escapeHtml(status.explanation)}` : ""}</li>`,
          )
          .join("")}</ul>`
      : "—";
  const sourceTypes =
    observation.c2pa.digitalSourceTypes.length > 0
      ? observation.c2pa.digitalSourceTypes
          .map((sourceType) => `<code>${escapeHtml(sourceType)}</code>`)
          .join("<br>")
      : "—";

  return `<article class="observation">
    <h3>${escapeHtml(label)}</h3>
    <dl>
      <dt>Target</dt><dd><code>${escapeHtml(observation.resolvedTarget)}</code></dd>
      <dt>MIME / size</dt><dd>${escapeHtml(observation.mimeType)} · ${escapeHtml(observation.bytes)} bytes</dd>
      <dt>SHA-256</dt><dd><code>${escapeHtml(observation.sha256)}</code></dd>
      <dt>Manifest observed</dt><dd>${observation.c2pa.manifestPresent ? "yes" : "no"}</dd>
      <dt>Embedded</dt><dd>${observation.c2pa.embedded === null ? "—" : observation.c2pa.embedded ? "yes" : "no"}</dd>
      <dt>Active label</dt><dd>${observation.c2pa.activeLabel ? `<code>${escapeHtml(observation.c2pa.activeLabel)}</code>` : "—"}</dd>
      <dt>Manifest store labels</dt><dd>${observation.c2pa.manifestLabels.length > 0 ? observation.c2pa.manifestLabels.map((labelValue) => `<code>${escapeHtml(labelValue)}</code>`).join("<br>") : "—"}</dd>
      <dt>Reachable manifest ancestry</dt><dd>${observation.c2pa.manifestAncestryLabels.length > 0 ? observation.c2pa.manifestAncestryLabels.map((labelValue) => `<code>${escapeHtml(labelValue)}</code>`).join("<br>") : "—"}</dd>
      <dt>Validation state</dt><dd>${observation.c2pa.validationState ? escapeHtml(observation.c2pa.validationState) : "—"}</dd>
      <dt>Validation statuses</dt><dd>${statuses}</dd>
      <dt>Digital source types</dt><dd>${sourceTypes}</dd>
      <dt>Inspection error</dt><dd>${observation.c2pa.inspectionError ? escapeHtml(observation.c2pa.inspectionError) : "—"}</dd>
    </dl>
  </article>`;
}

function renderProvenance(result: ProvenanceAuditResult): string {
  return `<section class="surface">
    <div class="surface-heading">
      <div>
        <h2>${escapeHtml(result.name)}</h2>
        <div class="muted"><code>${escapeHtml(result.provenanceId)}</code> · C2PA byte inspection</div>
      </div>
      ${statusBadge(result.passed)}
    </div>
    <p class="muted">These results evaluate only the configured technical expectations. Manifest presence or validity does not establish authenticity or legal compliance.</p>
    <div class="observation-grid">
      ${result.source ? renderProvenanceObservation("Source asset", result.source) : ""}
      ${result.delivered ? renderProvenanceObservation("Delivered asset", result.delivered) : ""}
    </div>
    ${
      result.failures.length > 0
        ? `<h3>Failures</h3><ul class="failures">${result.failures
            .map(renderProvenanceFailure)
            .join("")}</ul>`
        : ""
    }
  </section>`;
}

export function renderHtmlReport(
  report: AuditReport,
  reportDirectory: string,
): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(report.project)} · art50-ci report</title>
  <style>
    :root { color-scheme: light; --ink: #18201d; --muted: #64706b; --line: #dce3df; --paper: #fff; --wash: #f4f7f5; --pass: #087443; --pass-bg: #dff6e9; --fail: #a12820; --fail-bg: #fde7e5; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--wash); color: var(--ink); font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(1180px, calc(100% - 32px)); margin: 32px auto 64px; }
    header, .surface { background: var(--paper); border: 1px solid var(--line); border-radius: 12px; padding: 24px; box-shadow: 0 4px 16px rgb(20 40 30 / 5%); }
    header { margin-bottom: 20px; }
    h1, h2, h3 { margin: 0 0 8px; line-height: 1.25; }
    h1 { font-size: 27px; } h2 { font-size: 21px; } h3 { margin-top: 24px; font-size: 16px; }
    .surface { margin-top: 16px; }
    .surface-heading, .summary { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
    .summary { flex-wrap: wrap; margin-top: 20px; }
    .metric { min-width: 130px; padding: 12px 14px; background: var(--wash); border-radius: 8px; }
    .metric strong { display: block; font-size: 22px; }
    .muted { color: var(--muted); }
    .badge { display: inline-block; border-radius: 999px; padding: 4px 9px; font-size: 12px; font-weight: 800; letter-spacing: .04em; }
    .badge.pass { color: var(--pass); background: var(--pass-bg); }
    .badge.fail { color: var(--fail); background: var(--fail-bg); }
    dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 16px; margin: 20px 0; }
    dt { color: var(--muted); font-weight: 650; } dd { margin: 0; overflow-wrap: anywhere; }
    code { font: .9em/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { border-bottom: 1px solid var(--line); padding: 10px; text-align: left; vertical-align: top; }
    th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .03em; }
    .failures { padding-left: 22px; }
    .failures li { margin: 10px 0; }
    .meaning { margin: 18px 0 0; padding: 12px 14px; border-left: 4px solid #b98300; background: #fff8df; color: #534000; }
    .checkpoint { margin: 18px 0; padding: 12px 14px; border-radius: 8px; background: var(--wash); }
    .checkpoint-pass { border-left: 4px solid var(--pass); }
    .checkpoint-fail { border-left: 4px solid var(--fail); }
    .observation-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr)); gap: 14px; margin-top: 18px; }
    .observation { padding: 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--wash); }
    .observation dl { margin-bottom: 0; }
    .screenshot-link { display: inline-block; margin-bottom: 10px; }
    .screenshot { display: block; max-width: 100%; max-height: 560px; border: 1px solid var(--line); border-radius: 8px; object-fit: contain; object-position: top left; }
    @media (max-width: 620px) { main { width: min(100% - 16px, 1180px); margin-top: 8px; } header, .surface { padding: 16px; } dl { grid-template-columns: 1fr; } dt { margin-top: 5px; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="surface-heading">
        <div>
          <h1>${escapeHtml(report.project)}</h1>
          <div class="muted">${escapeHtml(report.mode)} run · ${escapeHtml(report.runId)}</div>
        </div>
        ${statusBadge(report.passed)}
      </div>
      <div class="summary">
        <div class="metric"><strong>${report.summary.passedSurfaces}/${report.summary.totalSurfaces}</strong>surfaces passed</div>
        <div class="metric"><strong>${report.summary.passedChecks}/${report.summary.totalChecks}</strong>checks passed</div>
        <div class="metric"><strong>${report.summary.passedProvenance}/${report.summary.totalProvenance}</strong>provenance passed</div>
        <div class="metric"><strong>${report.summary.totalFailures}</strong>failures</div>
        <div class="metric"><strong>${report.durationMs} ms</strong>duration</div>
      </div>
      <p class="meaning"><strong>Result boundary:</strong> ${escapeHtml(report.resultMeaning)}</p>
      <p class="muted">Started ${escapeHtml(report.startedAt)} · Generated by ${escapeHtml(report.tool.name)} ${escapeHtml(report.tool.version)}</p>
      <p class="muted">Configuration SHA-256: <code>${escapeHtml(report.configSha256)}</code> · Node ${escapeHtml(report.environment.node)} · ${escapeHtml(report.environment.platform)}/${escapeHtml(report.environment.architecture)}${report.environment.commitSha ? ` · commit <code>${escapeHtml(report.environment.commitSha)}</code>` : ""}</p>
    </header>
    ${report.surfaces.map((surface) => renderSurface(surface, reportDirectory)).join("")}
    ${report.provenance.map(renderProvenance).join("")}
  </main>
</body>
</html>`;
}

export async function writeReports(
  report: AuditReport,
  outputDirectory: string,
): Promise<WrittenReports> {
  await mkdir(outputDirectory, { recursive: true });
  const basename = `${report.mode}-${report.runId}`;
  const jsonPath = path.join(outputDirectory, `${basename}.json`);
  const htmlPath = path.join(outputDirectory, `${basename}.html`);
  const sanitizedReport = sanitizeReportValue(report);

  await Promise.all([
    writeFile(
      jsonPath,
      `${JSON.stringify(sanitizedReport, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      htmlPath,
      renderHtmlReport(sanitizedReport, outputDirectory),
      "utf8",
    ),
  ]);

  return { jsonPath, htmlPath };
}
