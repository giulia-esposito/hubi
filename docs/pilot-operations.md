# Pilot operations (decisions and routines), from 2026-11-06

## Access

- Pilot access is the IAP role `roles/iap.httpsResourceAccessor` on the `hubi-pilot` Cloud Run service. On 2026-11-06 the Product Owner's team (17 people from Revenue Excellence and Tools) was added by email, so the policy holds those 17, the Product Owner and Marina Michel. Read the current list with `gcloud iap web get-iam-policy --resource-type=cloud-run --service=hubi-pilot --region=us-central1 --project=wh-revenue-sandbox`.
- Next wave (Sales US, Sales BR, CS UK) is added the same way once the Product Owner shares the list. A Google Group would be easier to manage, but the owner cannot create groups; it is part of the IT request.
- Access is only as reachable as the internal ingress: a tester on a network that cannot reach the service needs the corporate network or VPN. Confirm with one tester per country before announcing.

## Decisions (Product Owner, 2026-11-05 and 2026-11-06)

| Decision | Detail |
|---|---|
| Alerting | Not blocking the pilot. Alert policies wait for the Monitoring Editor role (Jira batch). Until then the pilot is checked by hand and by the weekly report. |
| Log retention | Keep the logs for the pilot. |
| Interface | Web app only for the pilot, as a normal page (no install, because of download restrictions on corporate computers). Google Chat is the final channel and is planned after the pilot (Pub/Sub path, thread store, InfoSec re-score). An HTTP endpoint is not an option. A side-panel browser extension is a possible later option; it would search Hubi's knowledge base only and never read the page. |
| Platform requests | Ask in the GCP Listening space first; open the single Jira only if pointed there. |
| Instructions for testers | A one-page guide or short video, produced only when everything is ready. |
| Front end | Layout is drafted before code: example questions as buttons, a visible "getting ready" state, grouped and collapsed sources with clean titles (metadata only in logs), feedback that is readable and has an optional written part, favicon and page title, and the company's branding. Branding source to be provided. |

## Feedback and the weekly report

- Testers' feedback is logged (`type: feedback`) with the turn's `interactionId`. The tester's identity is not logged (`HUBI_LOG_ACTOR` is off).
- `scripts/feedback-report.ts` reads Cloud Logging with Application Default Credentials (no keys), joins feedback to its question, answer and sources, and writes to `evals-out/feedback/` (git-ignored): a weekly report in Markdown, the rows for the review Sheet, and a list of questions Hubi could not answer (the content gap list for Content).

  ```bash
  node --experimental-strip-types scripts/feedback-report.ts --days 7
  ```

- The review Sheet is "Hubi pilot feedback" in the Product Owner's Drive. Each row has Owner, Status and Notes columns for triage.

## Adding content before the governed sync exists

Approved by the Product Owner on 2026-11-06 as a one-time, labelled bootstrap (it does not change the Drive-is-the-source decision):

1. Content registers each document in the registry (Eligible, with its Content ID).
2. Engineering exports it from Drive using the owner's access, and produces a report of what would change.
3. The Product Owner approves; only then is the bucket updated. Running instances read the corpus at start, so a new revision (or restart) is needed afterwards.
4. Each uploaded file's Drive ID and export date are recorded, so the governed sync can replace the manual copy.

Scope agreed: all playbooks, plus selected PMM decks.

## Known behavior: names that are not in the knowledge (2026-11-06)

A tester asked how to position "extra check-ins". No document mentions that offer, but retrieval matched "check-ins" and Hubi answered about International Check-ins, a different add-on, as if they were the same. Two changes address it (lib/runtime/namedTerms.ts and the "Named things must match" rule in the system prompt): the prompt gets a notice listing wording from the question that the retrieved sources never use, so the model says the knowledge does not cover that item instead of substituting a similarly named one.

Measured with `scripts/eval-named-terms.ts` on the deployed corpus (5 runs per scenario): absent names kept apart in 17 of 20 runs (before: about 1 in 3 for the reported question), present names answered 15 of 15. The existing context-asking eval showed no drop. About 1 run in 6 can still equate the two, so the weekly feedback report should be read for this pattern. A stricter wording kept names apart in 18 of 20 runs but made Hubi say "not covered" instead of asking which segment applies, so it was not adopted.
