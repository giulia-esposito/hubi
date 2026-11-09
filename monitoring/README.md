# Pilot monitoring

A private view of how the Hubi pilot is going, for the Product Owner and leadership. Decided 2026-11-09.

```
Cloud Logging --(scripts/pilot-metrics.ts)--> JSON --(daily check)--> "Hubi pilot monitoring" Sheet --> Apps Script page
```

- **Sheet:** "Hubi pilot monitoring" in the Product Owner's Drive (id `1ozgwETueFtaJsm6AYF2EmsOnXnqUKEgk88GT_qHZNwM`). Tabs: Summary, Daily, Feedback, Not covered, Sources (written by the daily check, never edit by hand), Notes and Access (edited by people).
- **Page:** `monitoring/apps-script/` (Code.gs, Index.html, appsscript.json). It only reads the Sheet. Look: Hubi's (off-white, dark magenta, Barlow Condensed and Figtree).
- **Numbers:** `scripts/pilot-metrics.ts` reads the pilot logs with Application Default Credentials (no keys) and writes `evals-out/monitoring/metrics-latest.json` (git-ignored, because it holds question and answer text).
- **Rating:** `lib/monitoring/health.ts`, tested in `tests/health.test.ts`. The rating is the worst of four parts, over the last 7 days:

| Part | Green | Yellow | Red |
|---|---|---|---|
| Helpful votes (rated from 10 votes) | 75% or more | 60 to 74% | below 60% |
| Questions the knowledge does not cover | up to 20% | up to 35% | above |
| Failed turns | up to 1% | up to 3% | above |
| Slowest 5% of answers | up to 20 s | up to 40 s | above |

  Under 10 questions the page says "too early to rate". These are starting values: review them after two weeks of real use.

## What is not counted

People. Hubi does not record who asks (`HUBI_LOG_ACTOR` is off on purpose), so the page shows conversations (one per page session). A count of people would need a decision from InfoSec and a change to the service's protected settings.

## Set up the page (once)

1. Open the Sheet, then Extensions, Apps Script.
2. Paste `Code.gs` into the default file. Add an HTML file named `Index` and paste `Index.html`. In Project Settings, tick "Show appsscript.json manifest file" and paste `appsscript.json`.
3. Deploy, New deployment, type Web app. Execute as: **Me**. Who has access: **Anyone within Wellhub** (Apps Script cannot list individual people; the page itself checks the list).
4. Put the email of each person who may see it in column A of the **Access** tab. Anyone else sees "No access" and no data.
5. Share the web app link only with those people. The page shows real questions and answers.

After changing Code.gs or Index.html, use Deploy, Manage deployments, edit, New version.

## Keeping it current

- The daily check (scheduled task `hubi-pilot-daily-check`) runs `scripts/pilot-metrics.ts` and writes the tables to the Sheet.
- **Notes** tab: one row per note with Date (YYYY-MM-DD), Type, Note, Owner. Type `Development` shows under Developments, `Risk` under Risks. Type `Health override` with a Note that starts with Green, Yellow or Red sets the rating by hand for 7 days, for a serious wrong answer that numbers cannot rate.

## Confidentiality

The Feedback and Evidence parts contain real questions and answers from the pilot. Keep the Access list short and do not forward the link.
