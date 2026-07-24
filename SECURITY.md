# Security policy

## Reporting a vulnerability

Please use GitHub's private vulnerability-reporting feature for this
repository. Do not open a public issue for a vulnerability that could expose
credentials, target data, report artifacts, or arbitrary files.

Include the affected version, a minimal reproduction, likely impact, and any
suggested mitigation. Remove customer data and secrets from the report.

## Operational guidance

Target URLs, authenticated browser state, screenshots, downloaded assets, and
reports may be sensitive.

- Use least-privilege test accounts and short-lived credentials.
- Do not expose secrets to workflows running untrusted fork code.
- Redact or disable screenshots on sensitive pages.
- Keep evidence artifacts in access-controlled storage.
- Review target URLs and asset limits before running untrusted configuration.
- Keep private-network access deny-by-default. A configuration request and an
  exact `--allow-private-origin` runtime grant are both required.
- Never pass private-origin grants or secrets to fork-controlled workflows.

`art50-ci` has no telemetry and does not upload inspected media. It may access
the URLs explicitly configured by the operator. Raw query strings may exist in
memory long enough to make a request, but reports and diagnostics remove URL
credentials, query strings, and fragments.
