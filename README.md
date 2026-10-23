# PantryPilot — agentic AI against food waste

> Scan a receipt, let a team of AI agents plan safe meals around your allergens and diet, and track the money and CO₂ you save.

**Problem.** Households throw away roughly a third of the food they buy. People forget what's in the fridge and don't know what to cook with it.
**Solution.** PantryPilot tracks what you own, ranks it by spoilage risk, and runs a multi-agent pipeline that turns "about to expire" into a concrete, *safety-checked* meal plan.

## Quick start (no accounts needed)

```bash
npm install                    # Node 22.5+ (uses built-in node:sqlite, no native build)
cp .env.example .env           # everything is optional locally
node --env-file=.env src/index.js   # http://localhost:8080
npm test
```

With no keys it runs on local SQLite and a deterministic offline planner, so demos never break. Each integration below switches on when its keys are present.

## Architecture

```
Browser (vanilla JS, strict CSP, textContent-only rendering)
   │  HTTPS · HttpOnly SameSite=Strict session cookie · CSRF header
   │  "Continue with Google" → Firebase Auth popup → ID token
   ▼
Express API on Cloud Run ── helmet · rate limits · per-user AI quota · zod · audit log · structured logs
   │   /api/auth/google  → Firebase Admin verifies the token (signature, expiry, revocation, verified email)
   │
   ├─ Intake agent      receipt text / photo ──► Gemini Flash-Lite (cheap) ──► zod-validated items
   ├─ Inventory agent   deterministic expiry + CO₂ scoring (no LLM: cheaper, exact)
   ├─ Planner agent     Gemini Flash (Vertex AI) JSON plan, data/instructions separated, safety filters on
   ├─ Safety critic     deterministic allergen/diet + pantry-grounding check, can veto the LLM
   └─ Orchestrator      Inventory → Planner → Critic → (reflective retry) → safe fallback, fully traced
   │
   ├─► Supabase (Postgres)  users, pantry, plans, events, audit, LLM cache, AI usage  (SQLite when unset)
   ├─► Firestore            anonymous agent-run log (optional)
   └─► BigQuery             live-streamed, pseudonymised impact events ──► Looker Studio
```

The key design rule: **the LLM proposes, deterministic code disposes.** Model output is parsed against a schema, grounded in the real pantry, and checked against the user's allergens before anything is shown.

## How it maps to the evaluation criteria

| Criterion | What is implemented |
|---|---|
| **Security** | *Pipelines:* untrusted receipt/pantry text is data, never instructions (delimited JSON, injection filters, schema-validated output, magic-byte image checks, size caps). *Auth:* bcrypt (cost 12), HS256-pinned JWT in an HttpOnly/SameSite=Strict cookie, lockout, no user enumeration, CSRF header, Google sign-in verified server-side (revocation check, verified email, fresh sign-in to delete an account). *Database:* Supabase with row-level security on and no policies (public key reads nothing), service-role key only on the server in Secret Manager, every query scoped by `user_id` (IDOR-tested), Firestore rules deny all browser access. *Safe AI execution:* Gemini safety filters at medium+, **per-user daily AI quota** (`AI_DAILY_LIMIT`, default 50), allergen/diet critic that can veto the model, strict CSP, rate limits, audit log, least-privilege Cloud Run service account. |
| **Efficiency** | Deterministic code wherever an LLM isn't needed; **two model tiers** (Flash-Lite for receipt parsing, Flash for planning); two-tier response cache (memory + database, 1h TTL, cache hits free and not counted against quota); capped context (≤12 items); one bounded retry; timeouts. Settings shows **tokens used, estimated cost, estimated savings from the cache** and the user's quota. |
| **Technology implemented** | Multi-agent orchestration (5 agents) with autonomous decisions: the Inventory agent decides what is urgent, the Planner decides recipes, the Critic decides what is safe to show, and the Orchestrator decides to **re-plan with critic feedback**, **fall back** to a rule-based planner, or **skip the model entirely** when nothing is expiring. Vision intake, grounding verification, graceful degradation, full agent trace in the UI. |
| **Performance** | `/api/health` (liveness) and `/api/ready` (checks the database), in-process p50/p95 latency, memory+DB caching, indexed queries, Cloud Run concurrency 40, graceful SIGTERM, structured JSON logs for Cloud Logging, offline fallback that answers in milliseconds. |
| **Google technology** | **Gemini** via **Vertex AI** (`@google/genai`, no API key on Cloud Run) or the Gemini API; **Firebase Authentication** (Google sign-in); **Firestore** (agent-run log); **BigQuery** (live streaming + batch export + example SQL) with **Looker Studio**; **Cloud Run**, **Secret Manager**, **Cloud Build**, **Cloud Logging**; **Firebase Hosting** rewrite. |

## Keys and where to get them

Copy `.env.example` to `.env`. **Secret** values must never be committed or sent to the browser; `deploy/cloudrun.sh` stores them in Secret Manager.

| Variable | Secret? | Where to get it |
|---|---|---|
| `JWT_SECRET` | **yes** | `openssl rand -hex 32` (required in production) |
| `GEMINI_API_KEY` | **yes** | https://aistudio.google.com/apikey (skip if using Vertex AI) |
| `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` | no | Set `true` + your GCP project id. Enable the Vertex AI API; the service account needs *Vertex AI User* |
| `SUPABASE_URL` | no | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** | Same page, the `service_role` key (bypasses RLS: server only) |
| `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID` | no | Firebase console → Project settings → Your apps → Web app. Enable Authentication → Google and add your domain to Authorized domains |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | **yes** | Only for local runs; on Cloud Run the service account is used automatically |
| `FIRESTORE_AGENT_LOG` | no | `true` after creating Firestore in the Firebase console |
| `BQ_STREAM`, `BQ_DATASET`, `BQ_TABLE`, `BQ_PROJECT_ID` | no | `BQ_STREAM=true` streams events live; the table is created on first use |
| `BQ_SALT` | **yes** | `openssl rand -hex 16`; makes user pseudonyms irreversible |
| `AI_DAILY_LIMIT`, `GEMINI_MODEL`, `GEMINI_PARSE_MODEL`, `PRICE_*` | no | Tuning knobs. Check current Google pricing before trusting the cost estimate |

## Setup

1. **Supabase:** create a project, open the SQL editor, run `supabase/schema.sql` once, then set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
2. **Firebase:** add a Web app, enable the Google provider, fill the four `FIREBASE_*` values. Locally run `gcloud auth application-default login` (or set `FIREBASE_SERVICE_ACCOUNT_JSON`).
3. **Deploy:**
   ```bash
   PROJECT_ID=your-project REGION=asia-south1 SUPABASE_URL=https://xxxx.supabase.co \
   FIREBASE_API_KEY=... FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com FIREBASE_APP_ID=... \
   ./deploy/cloudrun.sh
   ```
   This creates a least-privilege service account, stores secrets in Secret Manager and deploys with Vertex AI and live BigQuery streaming on.
4. **Optional:** `firebase deploy --only hosting,firestore:rules`; `BQ_SALT=... node --env-file=.env deploy/bq_export.js` for a one-off batch load; connect the BigQuery table to Looker Studio (`deploy/bq_queries.sql` has starter queries).

## Honest limitations (say these before the judges ask)

- **Not yet run against live services.** The Supabase, Firebase, Vertex AI and BigQuery code follows the documented APIs and is tested with fakes; `supabase/schema.sql` has not been run on a real project. Expect small fixes on the first real run.
- Rate limiting and metrics are in-process, so with several instances they are per-instance (the AI quota *is* shared, because it lives in the database). Use Memorystore/Redis for shared limits.
- The Supabase impact summary reads up to 5,000 events per user and sums them in the app. Fine for this scale; move it to a SQL view or RPC for heavy users.
- Marking an item used/wasted is atomic on both databases (SQL function on Supabase). Other multi-step writes rely on single statements.
- The cost figure is an estimate from token counts and configurable prices.
- CO₂ numbers are estimates from average emission factors per category, and the UI says so.
- Allergen filtering is keyword-based. It is conservative but not a medical device; keep the "check labels" reminder.
- Shelf-life from receipts is a heuristic/LLM estimate, not a guarantee of safety.
- Google sign-in links to an existing password account with the same verified email.

## Demo script (3 minutes)

1. Sign in with Google (or register), set **vegan + peanut allergy** in Settings.
2. Paste a receipt (`2 Tomatoes 40`, `1 l Milk 60`, `Spinach 30`, `Peanut butter 120`), review, add.
3. **AI Planner → Generate.** Point at: milk/peanut items never reach the planner, the agent trace, the critic banner.
4. Mark items used → **Impact** tab updates; show the event arriving in BigQuery.
5. Settings → tokens, estimated cost, cache savings, your daily AI quota.
6. `npm test`, `curl -I` for the security headers, `curl /api/ready`.
