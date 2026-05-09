# MoneyMind Roadmap

**Last updated:** May 8, 2026
**Status:** Active build plan
**Owner:** Julia Maldonado

---

## Mission

MoneyMind is a judgment-free safe space for college students and young adults to be honest about their finances and build a plan — without shame, without jargon, without dependency.

**Education is the differentiator.** Mint, YNAB, and Rocket Money assume you already know the terms. MoneyMind teaches you while you use it.

---

## Core Principle

Users should understand what MoneyMind is recommending and why — not follow it blindly. Every term, recommendation, and projection must be explainable in plain language at the moment the user encounters it.

This principle drives every design decision in this roadmap.

---

## Table of Contents

1. [Phase A — Educational Foundation + Onboarding Survey](#phase-a--educational-foundation--onboarding-survey)
2. [Phase B — Wealth Builder](#phase-b--wealth-builder)
3. [Phase C — Real User Testing](#phase-c--real-user-testing)
4. [Phase D — Optional Debt Segment](#phase-d--optional-debt-segment)
5. [Out of Scope](#out-of-scope)
6. [Parallel Work](#parallel-work)
7. [How to Use This Document](#how-to-use-this-document)

---

## Phase A — Educational Foundation + Onboarding Survey

**Goal:** Build the patterns everything else will use. Capture minimum viable user context.

**Why this is first:** The educational layer is the differentiator. Building it first means every downstream feature can use it. Building it later means retrofitting tooltips and explanations into already-shipped UI.

### A1. Three reusable education patterns

#### Inline term tooltips
- Every jargon term in the UI gets a small ⓘ icon
- Tap/hover shows 1-2 sentence plain-English definition
- "Learn more" link expands to 2-3 paragraphs
- Built once as a component, reused everywhere
- Glossary lives in a content file (e.g., `lib/glossary.js`) so updates don't require code changes

#### "Why this recommendation?" expandables
- Every recommendation has a collapsed "Why?" link
- Expanded, it shows: the rule applied, the user's data that triggered it, the assumptions, links to learn more
- Static and deterministic — no LLM in the loop
- Replaces the conversational chatbot considered in earlier planning

#### Visible assumptions on every projection
- Every dollar figure that's a projection shows the math
- Example: "$43/month at 7% annual return for 20 years = $26,100" with the formula expandable
- Users learn compounding by seeing the inputs

### A2. Short essential onboarding survey

Required for app to function (~5-7 fields):

- Age
- Life stage (in school / working / both / between things)
- Income source and rough monthly amount
- Housing situation (rent / own / with family)
- Whether they have employer benefits available (401(k), HSA, etc. — yes/no/not sure)
- One primary financial goal (free text or picker)
- Optional: anything they're stressed about (free text — informs tone, not stored as judgment)

**Survey design rules:**
- Each question teaches as it asks (uses the tooltip pattern from A1)
- Skippable but resumable
- Editable from settings forever
- Privacy policy updated to cover new data captured before launch

### Phase A exit criteria

- [ ] User can complete onboarding
- [ ] Every term in the existing app surface has a tooltip
- [ ] "Why?" pattern works on at least one mock recommendation
- [ ] Projections show their assumptions
- [ ] Tests pass
- [ ] Privacy policy reflects new data captured

---

## Phase B — Wealth Builder

**Goal:** Help users see their financial trajectory and where new dollars should go.

Built on Phase A's educational layer — every component uses tooltips, "Why?" expandables, and visible assumptions.

### B1. Savings Ledger
- Auto-populates when a finding is marked resolved
- Tracks source, amount, one-time vs recurring, date
- Source of truth for downstream projections

### B2. Goal Engine + Goal Gap Calculator
- Up to 5 goals using survey data for context
- 7% (long-term) / 4.5% (short-term HYSA) assumptions visible in UI
- Full assumption explanation expandable
- Calculator shows monthly contribution needed vs. current

### B3. Account Priority Router
Standard logic, every step explained:
1. High-interest debt above 8% APR
2. 401(k) employer match (guaranteed return)
3. Emergency fund (3 months expenses in HYSA)
4. Max Roth IRA
5. Back to 401(k) up to annual limit
6. Taxable brokerage

Each priority has an expandable "Why this order?" explanation.

### B4. Wealth Dashboard
- Savings recovered counter
- Goals progress bars
- Prioritized opportunities queue
- Two-scenario projection chart
- Chart uses survey-derived ages (a 19-year-old sees life at 25, 30, 40, 65 — meaningful timeframes for them)

### Deliberately deferred (NOT in Phase B)

| Feature | Why deferred |
|---|---|
| Fund Recommendation Tool (specific fund names) | Naming individual securities raises liability stakes — defer until after C |
| Lump-Sum Redirect | Nice to have, not core to MVP |
| Monthly Wealth Report email | Needs cron infrastructure, can wait |

### Phase B exit criteria

- [ ] User can mark a finding resolved and see it appear in the ledger
- [ ] User can set a goal and see the gap
- [ ] Two-scenario projection chart renders correctly with user's actual data
- [ ] Every term and recommendation has tooltip + "Why?" expandable
- [ ] Tests pass

---

## Phase C — Real User Testing

**Goal:** Validate before building more.

### Plan
- Send to first 1-2 testers
  - One technical user
  - One non-technical user (sister is a strong candidate)
- Gather feedback for at least 2-3 weeks of actual use

### Watch for specifically
- Which terms still confuse people even with tooltips
- Which "Why?" explanations users actually expand vs. ignore
- Which survey fields produced bad recommendations because of bad assumptions
- Whether users come back to the app or only use it once
- What they wish was there

### Critical rule
**Iterate on A and B based on feedback before starting Phase D.** Don't build D in parallel — feedback will change what D should be.

### Phase C exit criteria

- [ ] At least 2 users have used the app for 2+ weeks
- [ ] Feedback documented
- [ ] A/B fixes shipped based on feedback
- [ ] Decision made on whether D is still the right next phase or whether something else surfaced

---

## Phase D — Optional Debt Segment

**Goal:** Help users with significant debt build a plan without shame.

**Mission tie-in:** This is the feature inspired by talking to college students drowning in debt who feel they have no path out. The framing matters as much as the math.

### D1. Debts table + entry UI
- Optional everywhere
- Users who don't enter debts get a fully working app
- Fields: type (student loan, credit card, auto, medical, mortgage, other), balance, APR, minimum payment, optional nickname

### D2. Payoff Strategy Engine
- Avalanche method (highest APR first — mathematically optimal)
- Snowball method (smallest balance first — psychologically motivating)
- Both fully explained inline with tooltips and "Why?" expandables
- User picks based on understanding the tradeoff, not on jargon

### D3. Debt-Aware Budget Recommendation
- Inputs: income, essential spending, debts, goals
- Outputs: monthly allocation with three aggressiveness presets (minimum-only / balanced / aggressive payoff)
- Framed as "one way to allocate this" — never "you should"
- Heavy disclaimer language

### D4. Account Priority Router integration
- Router now has real debt data to work with
- A user with a 22% APR balance gets specific guidance grounded in actual numbers
- Connects Phase B's router to Phase D's debt data cleanly

### D5. Payoff Tracking
- Plaid transactions tagged as debt payments roll up against budgeted amount
- Honest reflection only
- No gamification, no streaks, no shame mechanics

### Phase D exit criteria

- [ ] User can optionally enter debts
- [ ] User can pick avalanche or snowball with full understanding of the tradeoff
- [ ] Budget recommendation produces plausible output for test cases
- [ ] Disclaimer language reviewed and prominent
- [ ] Tests pass

---

## Out of Scope

These were considered and explicitly cut from this roadmap:

| Feature | Why cut |
|---|---|
| Conversational chatbot inside MoneyMind | Replaced by static "Why?" expandables — 80% of the value, 10% of the risk, no hallucination potential |
| MCP server for MoneyMind | Doesn't move user-facing product forward; maybe a future portfolio piece |
| Fund Recommendation Tool (specific fund names) | Liability stakes too high until A–D are stable |
| Monthly wealth report email | Nice to have, requires cron, not core |
| Lump-sum redirect tool | Nice to have, not core |
| Custom budget categories beyond existing 5 | Not on roadmap |
| Expanded invite system | Wait until A–C are proven |

---

## Parallel Work

Things that run alongside the phased roadmap, not blocking it:

- **Plaid attestation correction** — handle whenever Plaid responds; not blocking
- **Audit logging for own database access** — pre-wider-rollout task, do before scaling beyond first 2 testers
- **First beta invites** — timing TBD, probably after Phase B ships

---

## How to Use This Document

### For Julia
- Phase order is intentional. Don't skip ahead.
- If a feature idea isn't in this document, it's scope creep until you explicitly add it.
- Update this file when phases complete. Commit the update.
- Reread this when tempted to start something new mid-phase.

### For Claude Code
- This is the active build plan. Work in phase order (A → B → C → D).
- Don't start Phase B work until Phase A is shipped.
- Don't suggest features outside the roadmap without flagging them as scope creep.
- When in doubt, refer to the Mission and Core Principle at the top of this file.

### When this document changes
Major changes (reordering phases, adding a new phase, cutting a phase) should be:
1. Discussed before committing
2. Reflected in the "Last updated" date at the top
3. Captured in a brief changelog entry below

---

## Changelog

### May 8, 2026 — Initial blueprint
- 4-phase roadmap finalized: Educational Foundation → Wealth Builder → User Testing → Debt Segment
- Conversational chatbot dropped in favor of static "Why?" expandables
- MCP server scoped out (potential future portfolio piece)
- Fund Recommendation Tool deferred until after Phase C
- Educational layer established as core differentiator
