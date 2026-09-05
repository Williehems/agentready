# AgentReady

Point it at a URL. A real cloud browser, driven by a model that can only see what
the accessibility tree exposes, tries to do the one thing the site exists for.
You get back a letter grade, the reasons, and the replay.

Not a Lighthouse score. Not a checklist. An agent either finished or it did not,
and the transcript says which.

```
An AI agent completed "integrate the api" in 1 step. What proves it:
a code example ("import { Resend } from 'resend';") and a route to a key ("api key").
```

```
An AI agent failed to book an appointment. It found the right button and still
could not finish. Primary blocker: dead-end-cta.
```

Both of those are real verdicts from runs shipped in this repository. The second
one is about a site I built and shipped myself, which is the only kind of failing
grade I am willing to publish about a named host. Its eight steps are worth
reading: the agent picked a treatment, chose a date, typed a name and a phone
number, and then pressed "Send booking via WhatsApp", at which point the site
handed the booking to a tab the agent cannot follow. Seven correct moves and no
booking. That is the whole thesis in one run.

## The question

Every site is now read by two audiences. One has eyes. The other has a context
window, no rendered pixels, and a budget of maybe ten steps before it gives up on
you. Analytics measures the first audience exhaustively and the second one not at
all.

So: can an agent sign up, buy, integrate, book, or contact you? That is the whole
product surface. Five actions, one answer each.

## What it does, and what it does not

**Test.** A Solari stealth browser opens the URL. `lib/perceive.ts` reduces the
page to the interactive controls an agent can actually address, by role and
accessible name, plus the trimmed visible text and the code-shaped lines. Groq
picks one move per turn. `lib/agent.ts` executes it and looks again. Up to ten
turns.

**Witness.** Every turn is streamed to the browser as NDJSON while it happens:
what the agent chose, on what, and its own one-line reason for choosing it. The
run is written to disk with its screenshots, and the Solari session id is kept so
the video replay can be fetched later.

**Deferred by design:** Fix (patch suggestions), Certify (a badge), Monitor
(scheduled re-runs). All three are designed and none are built. This is local
first, and there is no database: runs are JSON files under `public/runs/`.

## How the letter is computed

Four checkpoints, each worth points, and nothing else earns any:

| Checkpoint | Points | Earned when |
| --- | --- | --- |
| `understood-offering` | 15 | The page says what it sells in text a machine can read |
| `found-key-info` | 20 | The thing the action needs was reachable: a price, a key, a form |
| `found-cta` | 25 | The control that performs the action was present and operable |
| `completed-action` | 40 | The agent declared done **and** the page showed an end state that agrees |

`A >= 88`, `B >= 72`, `C >= 55`, `D >= 35`, otherwise `F`. A hard blocker caps the
score at 45 no matter what was reached. An explicit give-up caps it at 55.

That last checkpoint is the one that matters and the one that is hard to be honest
about. A model that says "I have completed the signup" has not completed the
signup. So `completed-action` needs the claim **and** independent corroboration
read back off the page, in the page's own words, and the summary quotes what it
found so a reader can disagree with it.

The blockers are named, never inferred by an LLM: `bot-wall`, `captcha`,
`js-gate`, `verification-gate`, `no-structured-price`, `dead-end-cta`,
`form-stall`, `auth-gate`, `nav-error`, `loop`.

## The one design decision worth reading the code for

**A transcript stores evidence, not conclusions.**

`lib/store.ts` recomputes the verdict from the stored transcript on every single
read. It never reads a saved grade. That means fixing the grader retroactively
fixes every run already on disk, and a run's letter is always the current
grader's opinion rather than a fossil.

This was learned the expensive way. `Perception` used to carry `hasCode: true`,
a boolean decided at capture time. When the grader was corrected, the board showed
the same docs.stripe.com audit at C 60 and A 100 simultaneously, because half the
verdict was being recomputed and half had been frozen months earlier. The fix was
to store `code`, the actual code-shaped lines off the page, and move the judgement
to grade time. Widening the regex now re-reads history. One run, `mtn01prs-u59fcq`,
can never be corrected, because the page it saw was never written down.

The same principle caught a subtler bug. The proof of a working integration was
matched against the whole page as one string, so docs.stripe.com's sentence "the
Stripe API Docs demonstrate using curl to interact with the API over HTTP"
supplied the half of the proof worth 40 points. Prose about curl is not a curl
call. Credit now has to land on a line that reads as code.

## Run it

Node 20 or newer. Two keys, both in `.env.local`:

```bash
cp .env.local.example .env.local
```

- `SOLARI_API_KEY` from [getsolari.com](https://getsolari.com). Stealth is a paid
  plan feature. Without it, launches fall back to a plain browser and
  `lib/solari.ts` reports `stealth: false`, which honestly weakens any
  `bot-wall` finding the run produces.
- `GROQ_API_KEY` from [console.groq.com](https://console.groq.com). Free tier is
  enough. Model is `openai/gpt-oss-120b`, set in `lib/groq.ts`.

```bash
npm install
npm run dev
```

Landing page at `/`, the audit console at `/audit`, the board at `/runs`.

```bash
npm run typecheck && npm test
```

404 tests, no network, no keys needed. They cover the grader, the perception
reduction, the agent loop's decision handling, the Solari error mapping, the
spending gate, and every refusal the three API routes can give: a body that is not
JSON, a target that is not ours to touch, an instance with no keys, a stop that
arrived too late, a malformed session id. The suite was run with `globalThis.fetch`
replaced by a throw to prove the no network claim rather than assert it.

Two things are deliberately not covered. A successful run, because it opens a
metered browser on the first line and a test that costs money every time is a test
nobody runs. And the components, which have no tests at all yet.

Without keys the board and the four shipped example runs still render, and
`/audit` returns a plain sentence saying which key is missing rather than
crashing.

## What it costs to run

Measured across the 40 graded runs on disk: 193 Groq calls, 379,928 prompt tokens,
19,961 completion tokens, so about **1,969 prompt tokens per step**. Calls and steps
are one to one, and every ten step run on disk made exactly ten calls. The fifteen
runs of eight steps or more cost a mean of 18,678 prompt tokens each, from 10,644 to
27,535, so Groq's free tier of 200,000 tokens a day is about ten runs at full length.
A measured two step run took 25 seconds end to end including the browser launch,
so a ten step run is a couple of minutes plus any rate limit hold. The agent says
out loud when it is being held by our own free tier, because a throttled agent and
a stalled site look identical in a replay and the difference is whose fault it is.

Cash cost of every test in this repository: nothing beyond the Solari plan.

### The audit endpoint is a spending endpoint

`POST /api/audit` opens a metered browser and spends model tokens, so on a public
URL it is a form that spends someone's balance on a stranger's request. `lib/runs.ts`
holds the gate, and it refuses in three ways, each with a plain sentence rather than
a bare 429:

- **One at a time.** A second request while a run is in flight is refused, because
  the deployment is one process driving one browser. This is not a new limitation,
  it is the existing one said out loud with a number.
- **Sixty seconds per visitor,** keyed on the first hop of `x-forwarded-for`. That
  header is trusted to decide how long one visitor waits and nothing else. Behind no
  proxy there is no header and everyone is one visitor, which is the right answer on
  a laptop.
- **Ten runs a day,** reset on the UTC date. Ten because a full ten step run costs
  about 20,000 prompt tokens and the free allowance is 200,000. Past that the model
  starts refusing mid-run, and the letter it produces then is a fact about our
  billing rather than about the site, which is the one kind of wrong answer this
  product must never give. Raise it with `AUDIT_DAILY_CAP` once someone else is
  paying for the tokens.

## What has been measured

40 graded runs across 12 hosts, 213 page perceptions. 26 of them ran to their own
end, and those are the only letters a site owns: 4 A, 10 C, 11 D, 1 F. The other
14 were stopped by our side or never reached the site at all, and the board marks
those `cut short` or `no verdict` instead of handing out a letter. An F earned
because a browser provider answered 503 is a libel, not a finding.

By action: 22 integrate, 11 signup, 4 contact, 3 book.

Every one of those numbers is counted by running the shipped grader over the stored
transcripts, not by reading the letters saved beside them. The two disagree, which is
the point: the same runs whose saved verdicts say `F` for one host are `no verdict`
under the current grader, and the current grader is the one the board shows.

Four runs ship in `examples/` so a fresh clone has something real to show, and the
one failing example ships its eight screenshots too, under `public/examples/`. The
three older ones do not have their frames committed, and their pages say so rather
than showing broken images.

Sites that failed and why, from real runs: a booking form whose submit opened
WhatsApp in a second tab and told the first tab nothing, so the agent had no way
to know whether the booking existed. A signup behind an email verification gate.
A signup behind a captcha. A contact page behind a bot wall. A page with no price
anywhere in machine readable text.

## Limits, stated plainly

- Ten steps. A checkout that takes twelve is graded as unfinished, because to a
  real agent on a budget it is unfinished.
- The page text handed to the model is trimmed to 2,800 characters, so on long
  pages the model is answering about a prefix.
- The stored code evidence is capped at 1,200 characters. A page whose only call
  sits below more than that much JSON is stored without it. Lines are kept whole
  or dropped, never truncated, because a Stripe CLI invocation does not prove
  itself code until character 230.
- No account is ever actually created on a third party's site. Live verification
  uses `integrate` against documentation, which is read only.
- A run on the hosted instance is not kept. `public/runs/` sits inside the
  deployment bundle and a serverless filesystem is read only outside `/tmp`, so
  both writes in `lib/agent.ts` fail, and they are swallowed on purpose: a run that
  read a site correctly should not be discarded over a failed screenshot. The audit
  streams, grades, and is gone, and its permalink is a 404. `lib/store.ts` asks the
  disk directly rather than checking for a host name, and the board says so out
  loud when the answer is no. On a laptop the runs land and stay.
- A run is a sample. `docs.stripe.com/api/authentication` has been audited seven
  times: both runs that were allowed to finish came back A 100, and the other five
  were aborted by our side and are reported as having no letter. That consistency
  is reassuring and it is also two data points. The root `docs.stripe.com/` is the
  honest counterexample. Nine runs, seven of them finished, and they came back A 100
  once and C 60 six times. Same URL, same grader, 40 points apart, because what the
  agent wandered into within ten steps decided whether a line of code ever entered
  the evidence. A single letter about a large site is a sample of one path through it.

## Stack

Next.js 14 App Router, TypeScript strict, Tailwind.
[`@solarisdk/browser`](https://www.npmjs.com/package/@solarisdk/browser) pinned at
exactly `0.1.1` for the browsers. Groq for the decisions. No database.
