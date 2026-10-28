# Registry-driven governance

The Content Registry ("RKC | Revenue Knowledge Center - Content Registry") is the source of truth for what Hubi may answer from. This replaces the earlier hard-coded deny-list (`RKC-000021` as a constant in the code): eligibility is now data, applied by one gate, and a change in the registry changes Hubi's behaviour through a reviewed snapshot diff with no code edit.

## How it works

1. `config/governance/registry-export.csv` holds the governance columns of the registry (Content ID, Region / Country, Content Status, AI Eligibility, Issues / Risks, and the Notes text only for restricted documents). It is the reviewed input. The full "Content Registry" tab exported as CSV works too: the parser finds the header row, ignores the group-header row above it, and ignores every other column.
2. `npm run registry:sync` turns it into `lib/governance/registrySnapshot.ts`, a TypeScript constant compiled into the build. It is code, not a runtime file or network call, so the gate cannot fail open because a file is missing from an image or the sheet is unreachable. `npm run registry:check` (also a unit test, so CI) fails when the snapshot is out of step with the export.
3. `applyGovernance` (`lib/governance/governance.ts`) runs before the retrieval index is built (`buildGovernedIndex` is still the only way the runtime builds an index):

| Document | Outcome |
|---|---|
| In the registry, AI Eligibility `Eligible` and Content Status not Archived/Deprecated | kept |
| `Eligible with Restrictions` | kept; the registry note travels with every chunk, into the prompt (`Registry restriction:` and a one-line instruction to state the caveat when relied on) and into the source list in the UI |
| `Not Eligible`, `Pending Assessment`, blank or unrecognized (`Unassessed`), or Archived/Deprecated | excluded, with the reason recorded |
| Carries an `RKC-` identifier the registry does not list | excluded (fail closed: it has not been assessed) |
| No registry identifier at all (the five PMM playbook and slide files) | kept under the pilot policy, reported as `unregistered` |

4. The result is a `GovernanceReport` (exclusions with reasons, restricted documents, unregistered files, registry-versus-document drift). It is printed by the terminal tool, emitted once per process as a `governance` telemetry event, and the `startup` event carries the snapshot date, entry count and age.

## What it surfaced on the real corpus (snapshot 2026-10-29, 76 registry entries)

- Excluded: `RKC-000021` (Not Eligible), exactly as before, now because the registry says so.
- Restricted: `RKC-000012` (29 chunks): "only released for US and not fully implemented". Before this change the caveat was recorded in the registry but never shown to anyone.
- Unregistered, kept: `06.2025_Pricing_Rev Strategy Playbook`, `PMM _ Slide Library _ US _ DO NOT EDIT`, `PMM _ US Wellhub Golden Pitch`, `Rules of Engagement`, `Sales Tools Playbook - Revenue Team`. They have no Content ID, no governance record and no region metadata, so Hubi cannot tell whether they are AI-eligible. They are the main source of pitch material.
- Drift (reported, not resolved): `RKC-000015` and `RKC-000016` are `United States, Europe` in the registry but `Global` in the document's own metadata, so they currently apply to every region; `RKC-000018` is `Global` in the registry but `Brasil` in the document.
- Registry data quality: `RKC-000071` has no AI Eligibility (treated as Unassessed, excluded if it were ingested); about 160 rows after `RKC-000076` are empty placeholders (ignored).

## Decisions left to Product / Content

1. **Unregistered files.** The pilot policy keeps them (`PILOT_GOVERNANCE_POLICY.unregistered: "allow"`) because excluding them removes the golden pitch and playbooks. The fix is to register them (a Content ID and an AI Eligibility decision per file); then the policy can switch to `"exclude"`, which is one constant.
2. **Precedence on drift.** Applicability still reads the document's own Target Region. Making the registry authoritative would fix `RKC-000015/16` but changes which content applies where, so it needs Content to confirm the registry value is the right one.
3. **Who runs the sync and how often.** Today it is a manual export plus a reviewed commit. Automating it (read the sheet with a service identity on a schedule) is possible later; a manual, reviewed step is the safer default while the registry itself is still being completed. Production promotion should treat the snapshot date as an operational control (the `startup` event reports its age).

## Not done

- No runtime read of the sheet, no automatic sync.
- Only the governance columns are carried. Audience, Client-shareable, Language and the review dates are not used (Client-shareable is "No" on nearly every row and would matter for what Hubi may draft for external use; not wired).
- Titles and personal data in the registry are deliberately not copied into the repository.
