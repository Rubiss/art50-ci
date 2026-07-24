# Monitored release-gate launch

`art50-ci` is MIT-licensed open-source software. The CLI, GitHub Action,
configuration schema, examples, and documentation remain free to use without
buying this service.

The founding offer is a **€500 one-time, 30-day monitored release-gate
launch**. The fee is for defined delivery and operational accountability
around one launch, not for a software licence.

## Fit comes first

Start with the public
[Check monitored launch fit](https://github.com/Rubiss/art50-ci/issues/new?template=pilot.yml).
It asks only which kind of release check you are considering and whether you
accept the technical boundary. Do not post product URLs, customer media,
credentials, personal data, repository details, or confidential legal
analysis there.

A maintainer replies with **fit** or **no-fit** before requesting private
access or payment. If the target is unsupported or the requested outcome is
outside the scope below, the response is no-fit. Detailed technical intake
happens privately only after fit is confirmed.

## Included scope

One monitored launch covers:

- one product;
- up to five declared checks in total;
- one GitHub Actions workflow;
- configuration and workflow integration for the agreed checks;
- one reproducible baseline run and evidence package;
- a handoff walkthrough; and
- 30 calendar days of scheduled-run monitoring, starting when the baseline is
  delivered.

For this offer, each configured browser disclosure assertion, optional
first-interaction control, or C2PA provenance item counts as one declared
check. A browser URL can contain more than one check, but the five-check total
still applies.

Before payment, the private scope records the required customer inputs and
access plus a target baseline delivery date. The baseline is delivered when
the maintainer supplies a reproducible workflow run and evidence showing
either:

1. a confirmed pass of the declared technical expectations; or
2. a confirmed product failure, where a reproducible run correctly shows that
   the delivered product does not meet one or more declared expectations.

A confirmed product failure is not a compliance result or a claim that the
implementation passed. It means the release gate is operating as intended and
has produced actionable evidence of the product condition. Configuration,
permission, runner, or execution errors do not complete baseline delivery.

If required customer inputs or access are unavailable by the agreed date, work
pauses. A replacement delivery date must be agreed before work resumes; the
30-day monitoring window does not begin until the reproducible baseline is
delivered.

During the 30-day period, monitoring includes triage of up to **three distinct
failed-run causes**. Triage identifies the likely product, configuration,
delivery, or runner cause and records the next technical action. Repeated runs
with the same diagnosed cause do not become additional distinct causes.
Implementing product fixes is not included.

The private scope selects a customer-controlled daily or weekly scheduled-run
cadence. Monitoring and triage are asynchronous; continuous observation,
on-call incident response, and a response-time service-level agreement are not
included.

## Handoff

The customer receives:

- the agreed `art50-ci` configuration;
- one GitHub Actions workflow;
- an evidence index identifying the delivered baseline and relevant monitored
  runs; and
- a runbook covering how to trigger the gate, read its evidence, respond to a
  failed run, and continue operating it after the monitoring period.

Evidence remains in customer-controlled GitHub Actions artifacts or other
customer-controlled storage unless a different location is explicitly agreed
during private intake.

## Customer responsibilities and access

The customer:

- selects and approves the technical expectations, disclosure wording, target
  surfaces, and provenance requirements;
- determines legal scope and obtains any legal advice it needs;
- confirms it is authorized to provide the targets, assets, and access used;
- provides a technical contact who can approve repository changes and respond
  to product failures;
- maintains its product, GitHub account, runner availability, permissions,
  credentials, and artifact-retention settings; and
- implements product or content changes needed to resolve confirmed product
  failures.

The least-access option that fits the product is chosen during private intake.
Possible arrangements include checking public targets, having the customer
apply a supplied configuration and workflow, granting time-limited
least-privilege repository access, or running a trusted customer-controlled
workflow against a private target with explicit exact-origin grants.
Customers keep secret values in their own secret store; secret values should
not be sent to the maintainer.

## Not included

This implementation does not:

- provide legal advice, determine legal scope, or interpret exceptions;
- certify compliance, perform a regulatory audit, issue a badge, or guarantee
  a legal outcome;
- create, embed, or sign C2PA manifests;
- operate C2PA signing keys, certificate infrastructure, or trust services;
- determine signer trust, certificate-chain trust, content authenticity,
  truth, ownership, or lawfulness;
- redesign disclosures, repair the customer's product, or implement failures
  found by the gate;
- cover additional products, more than five declared checks, or additional
  workflows; or
- provide ongoing managed monitoring beyond the 30-day period.

`art50-ci` reports bounded technical observations against customer-declared
expectations. It does not turn those observations into legal conclusions.
