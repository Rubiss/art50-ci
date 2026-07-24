const reportableProtocols = new Set([
  "http:",
  "https:",
  "ws:",
  "wss:",
  "file:",
]);

export function redactUrlForReport(value: string): string {
  try {
    const parsed = new URL(value);
    if (!reportableProtocols.has(parsed.protocol)) {
      return value;
    }
    parsed.username = "";
    parsed.password = "";
    parsed.search = parsed.search ? "?__redacted__" : "";
    parsed.hash = parsed.hash ? "#__redacted__" : "";
    return parsed.toString();
  } catch {
    return value;
  }
}

export function redactUrlsInText(value: string): string {
  return value.replace(
    /\b(?:https?|wss?|file):\/\/[^\s"'<>]+/giu,
    (matched) => {
    let candidate = matched;
    let trailing = "";
    while (/[),.;\]}]$/u.test(candidate)) {
      trailing = `${candidate.at(-1)}${trailing}`;
      candidate = candidate.slice(0, -1);
    }
      return `${redactUrlForReport(candidate)}${trailing}`;
    },
  );
}

export function sanitizeReportValue<T>(value: T): T {
  if (typeof value === "string") {
    return redactUrlsInText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeReportValue(item)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sanitizeReportValue(item),
      ]),
    ) as T;
  }
  return value;
}
