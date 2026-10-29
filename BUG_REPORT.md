# CourseMaster Backend — Bug Report

Scope: backend only (Node.js / Express 5 / MongoDB / Mongoose). Frontend bugs are in the frontend repo's report (`FE-xxx`).

## How to read this report

**Baseline vs. fixed code**

| Ref | Meaning |
|-----|---------|
| `dee9a5f` | **Original code** (with the injected challenges). All "Observed on original" results come from here. |
| `56f7268` | Fix commit (the source fixes). |
| `272ee4a` | Adds `tests/api.test.js`, the `npm test` script and the first version of this report. |
| `main` (latest) | Adds the report rewrite, `tests/repro-probe.js`, the auth-middleware lookup (BE-011) and `price min: 0` (BE-013). All "Observed on fixed" results come from here. |

**Setup used for every reproduction:** an in-memory MongoDB, `JWT_SECRET=s`, `ADMIN_REGISTRATION_KEY=adminkey`, an admin
(`admin@x.com` / `admin123`), a student (`s@x.com` / `secret1`), one course with a 3-question quiz. For a real server, run
`npm run seed` (admin `admin@coursemaster.com` / `admin123`, student `student@coursemaster.com` / `student123`) and use any
HTTP client with `Authorization: Bearer <token from /api/auth/login>`.

**Reproduce it yourself**

```bash
npm install
node tests/repro-probe.js .                                   # fixed code: prints every "Observed on fixed" line
git archive dee9a5f | tar -x -C ../backend-old                # original code
NODE_PATH=$PWD/node_modules node tests/repro-probe.js ../backend-old   # every "Observed on original" line
npm test                                                      # 15 regression tests
```

**Verification statuses**

| Status | Meaning |
|--------|---------|
| **Reproduced + verified** | The probe shows the wrong behaviour on `dee9a5f` and the expected behaviour on `main`, **and** an automated test in `tests/api.test.js` covers the fix and passes. |
| **Verified (partial)** | As above, but part of the original claim could not be reproduced; the note says which part. |
| **Review only** | Confirmed in the source diff; no test or probe demonstrates it. |
| **Not a bug** | Investigated and found not to be a real defect. |

## Summary

| ID | Title | Severity | Priority | Status |
|----|-------|----------|----------|--------|
| BE-001 | Login compares password to the stored hash in plaintext | Critical | P0 | Reproduced + verified |
| BE-002 | Invalid JWT is passed through instead of returning 401 | High | P1 | Reproduced + verified |
| BE-003 | Admin-key registration removed; `role` accepted by the service | High | P1 | Reproduced + verified |
| BE-004 | Enrollment condition inverted — nobody can enroll | Critical | P0 | Reproduced + verified |
| BE-005 | Quiz percentage computed ×10 instead of ×100 | High | P1 | Reproduced + verified |
| BE-006 | `completeLesson` does not `await` `save()` | Medium | P2 | Verified (partial) |
| BE-007 | Custom `Access-Control-Allow-Methods: GET, POST` header | Low | P3 | Not a bug (dead code removed) |
| BE-008 | Admin assignments `courseId` filter ignored | Medium | P2 | Reproduced + verified |
| BE-009 | `Authorization` accepted without the `Bearer ` scheme | Medium | P2 | Reproduced + verified |
| BE-010 | Validation errors have no `errors` details (Zod 4) | Medium | P2 | Reproduced + verified |
| BE-011 | Banned users are never blocked (login and existing tokens) | High | P1 | Verified (partial) |
| BE-012 | Lesson completion not scoped to owner / course | High | P1 | Reproduced + verified |
| BE-013 | Update endpoints skip schema validation; negative price accepted | Medium | P2 | Reproduced + verified |
| BE-014 | Course search builds a regex from raw input | Low | P3 | Verified (partial) |
| BE-015 | Analytics day buckets off by one on non-UTC servers | Low | P3 | Reproduced + verified |
| BE-016 | `.env.example` contains frontend variables | Low | P3 | Review only |
| BE-017 | DB error text leaked; duplicate DB connect | Low | P3 | Review only |
| BE-018 | Request without a body crashes on `req.body.batchId` | Medium | P2 | Reproduced + verified |

Severity: Critical = core flow impossible or credentials bypassed; High = major feature wrong/unsafe; Medium = wrong behaviour with a
workaround; Low = minor. Priority: P0 fix now … P3 when convenient.

---

## BE-001 — Login compares password to the stored hash in plaintext
- **File:** `src/services/auth.service.js:51` · **Severity / Priority:** Critical / P0
- **Steps:** `POST /api/auth/login` `{"email":"admin@x.com","password":"admin123"}`.
  Then repeat with the password set to the user's stored `passwordHash` value.
- **Expected:** correct password → 200 + token; the hash string → 400.
- **Actual:** the code did `password === user.passwordHash`.
- **Observed on original:** correct password → `400 {"message":"Invalid email or password"}`; **the raw hash as password → `200` with an admin token**.
- **Observed on fixed:** correct password → `200`; raw hash → `400`.
- **Fix:** `await bcrypt.compare(password, user.passwordHash)`.
- **Status:** Reproduced + verified — test *BE-001 login…*.

## BE-002 — Invalid JWT is passed through instead of returning 401
- **File:** `src/middlewares/authMiddleware.js:18` · **Severity / Priority:** High / P1
- **Steps:** send `Authorization: Bearer not.a.jwt` to `GET /api/auth/me`, `GET /api/enrollments/my`, `GET /api/admin/enrollments`.
- **Expected:** `401 {"message":"Invalid token"}` on all three.
- **Actual:** the `catch` called `next()` so the handler ran with `req.user` undefined.
- **Observed on original:** `/me` → `404 "Cannot read properties of undefined (reading 'id')"`; `/enrollments/my` → `400` with the same message;
  `/admin/enrollments` → `403 "Admin access only"`.
- **Observed on fixed:** `401 {"message":"Invalid token"}` on all three.
- **Impact note:** no route let an invalid token read data (every protected handler dereferences `req.user`, and admin routes are stopped by
  the admin check), so this was **not** an authentication bypass. The harm is wrong status codes and leaked internal error text; the
  frontend logs the user out only on 401, so an expired token was never recognised. Severity lowered from Critical to High accordingly.
- **Fix:** `return res.status(401).json({ message: "Invalid token" })`.
- **Status:** Reproduced + verified — test *BE-002/BE-009 protected routes…*.

## BE-003 — Admin-key registration removed; `role` accepted by the service
- **File:** `src/services/auth.service.js:8-31` · **Severity / Priority:** High / P1
- **Steps:** `POST /api/auth/register` with (a) `role:"admin"`, (b) `adminKey:"wrong"`, (c) the correct `adminKey` (`adminkey`).
- **Expected:** (a) student, (b) 400 "Invalid admin registration key", (c) admin.
- **Observed on original:** (a) `201`, role **student**; (b) `201` (wrong key silently accepted); (c) `201` but role **student** — admin sign-up was impossible.
- **Observed on fixed:** (a) student; (b) `400 "Invalid admin registration key"`; (c) `201` role **admin**.
- **Correction to an earlier draft:** over HTTP, `role` in the body could **not** escalate privileges, because the Zod register schema strips unknown keys
  before the service runs. The escalation was latent: calling `authService.register({ …, role: "admin" })` directly produced an **admin** on the original code
  (student on fixed). The reproducible, user-visible defect is that the admin key was ignored entirely.
- **Fix:** `role` is no longer read from the input; `adminKey` is validated against `ADMIN_REGISTRATION_KEY` (unset → "Admin registration is not configured").
- **Status:** Reproduced + verified — test *BE-003 register…*.

## BE-004 — Enrollment condition inverted
- **File:** `src/services/enrollment.service.js:13-17` · **Severity / Priority:** Critical / P0
- **Steps:** as a student not yet enrolled, `POST /api/enrollments/:courseId` with body `{}`; call it a second time.
- **Expected:** first call 201 + new enrollment; second call returns the same enrollment.
- **Observed on original:** both calls → `400 {"message":"Already enrolled in this course"}` (`if (!enrollment) throw …`, so creation was unreachable).
- **Observed on fixed:** `201` new enrollment; second call `201` with the same `_id`.
- **Fix:** `if (enrollment) return enrollment;` then create.
- **Status:** Reproduced + verified — test *BE-004 enrollment…*.

## BE-005 — Quiz percentage ×10
- **File:** `src/services/quiz.service.js:34` · **Severity / Priority:** High / P1
- **Steps:** `POST /api/quizzes/submit` with all 3 answers correct (`answers:[0,1,1]`).
- **Expected:** `percent: 100`. **Observed on original:** `percent: 10`. **Observed on fixed:** `percent: 100`.
- **Fix:** `Math.round((score / total) * 100)`; a non-array `answers` now returns 400 "answers must be an array".
- **Status:** Reproduced + verified — test *BE-005 quiz…* (3/3 → 100, 2/3 → 67, 0/3 → 0; stats average).

## BE-006 — `completeLesson` does not await `save()`
- **File:** `src/services/enrollment.service.js:67` · **Severity / Priority:** Medium / P2
- **Steps:** complete a lesson, then immediately read the enrollment straight from the database.
- **Expected:** the stored value equals what the response reported.
- **Observed on original (timing-dependent):** after a completion whose response said `percent: 100`, an immediate read returned `percent: 50` — the write had not finished.
  Not deterministic; it depends on database latency.
- **Observed on fixed:** the write completes before the response.
- **Impact:** a failed save becomes an unhandled promise rejection (the client still receives 200); not demonstrated here.
- **Fix:** `await enrollment.save()`.
- **Status:** Verified (partial) — fix confirmed in source; the race was observed once in the probe but cannot be asserted deterministically, so the
  test (*BE-006/BE-012…*) checks persistence on the next read rather than the race.

## BE-007 — Custom `Access-Control-Allow-Methods: GET, POST` header
- **File:** `app.js` · **Severity / Priority:** Low / P3
- **Steps:** `OPTIONS /api/admin/courses/x` with `Origin` and `Access-Control-Request-Method: PATCH`.
- **Observed on original:** preflight already allowed PATCH and DELETE — `cors()` answers `OPTIONS` itself, before the custom middleware runs.
- **Conclusion:** not a functional bug; the middleware was misleading dead configuration. It was removed.
- **Status:** Not a bug — the test *BE-007 CORS preflight…* passes on both versions and acts as a regression guard only.

## BE-008 — Admin assignments `courseId` filter ignored
- **Files:** `src/controllers/admin.controller.js:46`, `src/services/admin.service.js:45` · **Severity / Priority:** Medium / P2
- **Steps:** with one submission in course A, `GET /api/admin/assignments?courseId=<course B id>`.
- **Expected:** `[]`. **Observed on original:** 1 result (filter ignored: the controller never passed `req.query`, and the service filtered the
  non-existent field `courseId`). **Observed on fixed:** 0; `?courseId=<course A>` → 1.
- **Fix:** controller passes `req.query`; service filters on `course`.
- **Status:** Reproduced + verified — test *assignments + BE-008/BE-013…*.

## BE-009 — `Authorization` accepted without `Bearer `
- **File:** `src/middlewares/authMiddleware.js:7` · **Severity / Priority:** Medium / P2
- **Steps:** `GET /api/auth/me` with `Authorization: <jwt>` (no `Bearer `).
- **Expected:** 401. **Observed on original:** `200` with the user. **Observed on fixed:** `401 {"message":"Not authorized"}`.
- **Fix:** require the `Bearer ` prefix.
- **Frontend link:** this is why the frontend's missing-prefix bug (FE-002) was invisible against the original backend.
- **Status:** Reproduced + verified — test *BE-002/BE-009…*.

## BE-010 — Validation errors have no details
- **File:** `src/middlewares/validate.js:10` · **Severity / Priority:** Medium / P2
- **Steps:** `POST /api/auth/register` `{"name":"A","email":"bad","password":"1"}`.
- **Expected:** `errors` array describing each field. **Observed on original:** `400 {"message":"Validation error"}` only (Zod 4 has `.issues`, not `.errors`).
  **Observed on fixed:** the same plus 3 entries with `path`, `code`, `message`.
- **Fix:** `err.issues`.
- **Status:** Reproduced + verified — test *BE-010 validation errors…*.

## BE-011 — Banned users are never blocked
- **File:** `src/services/auth.service.js:54` · **Severity / Priority:** High / P1
- **Steps:** admin `PATCH /api/users/:id/ban`, then the banned user logs in with the right password.
- **Expected:** login refused ("Your account has been banned").
- **Evidence on original:** `git grep isBanned dee9a5f -- src` shows it only in the model and in the toggle in `user.service.js` — it is never read.
  The end-to-end symptom could not be observed on the original alone, because BE-001 rejects every login (the probe got `400 Invalid email or password`).
- **Second symptom (existing tokens):** a token issued before the ban kept working for its full 30-day life. **Observed on original:** `GET /api/auth/me` with a banned
  user's token → `200` (user shown with `isBanned:true`). The same applied to deleted users and to role changes (a demoted admin kept admin rights in the token).
- **Observed on fixed:** login → `400 "Your account has been banned"`; an existing token → `403 "Your account has been banned"`; after un-ban both work again.
- **Fix:** login rejects banned users, and `authMiddleware` (`src/middlewares/authMiddleware.js`) now looks the user up on every request: a deleted user gets
  `401 Invalid token`, a banned user gets `403`, and `req.user.role` comes from the database rather than the token (so promotions and demotions apply immediately).
  Cost: one indexed `findById` per authenticated request.
- **Frontend note:** a banned user's next API call now returns `403 "Your account has been banned"`; the frontend's interceptor only auto-logs-out on 401.
- **Status:** Verified (partial) — fix and test (*BE-011 user management…*: ban, token rejected, un-ban, promotion, deletion) confirmed; the *login* symptom is only
  demonstrable on the original once BE-001 is fixed. The existing-token symptom is reproduced.

## BE-012 — Lesson completion not scoped to owner / course
- **Files:** `enrollment.service.js:38-46`, `enrollment.controller.js` · **Severity / Priority:** High / P1
- **Steps:** (a) student B calls `PATCH /api/enrollments/<student A's id>/complete-lesson` with a real `lessonId`; (b) student A sends a random `lessonId`.
- **Expected:** 400 in both cases.
- **Observed on original:** (a) `200`, A's progress changed to 50 %; (b) `200`, response `percent: 100` for a lesson that does not exist.
- **Observed on fixed:** (a) `400 "Enrollment not found"`; (b) `400 "Lesson not found in this course"`; nothing stored.
- **Fix:** the controller passes `req.user.id`; the service checks ownership and that the lesson belongs to the course.
- **Status:** Reproduced + verified — test *BE-006/BE-012…*.

## BE-013 — Update endpoints skip schema validation
- **File:** `src/services/admin.service.js:14-17, 80-98` · **Severity / Priority:** Medium / P2
- **Steps:** (a) `PATCH /api/admin/assignments/:id/review` `{"status":"banana"}`; (b) `{"grade":500}`; (c) `PATCH /api/admin/courses/:id` `{"title":""}`; (d) `{"price":"abc"}`; (e) `{"price":-5}` (also on `POST /api/admin/courses`).
- **Expected:** 400 for all five.
- **Observed on original:** (a) `200`, stored `status:"banana"`; (b) `200`, stored `grade:500`; (c) `200`, course title became `""`; (d) `404 "Cast to Number failed…"` (rejected, but with the wrong status); (e) `200`/`201`, a course with price `-5` was stored.
- **Observed on fixed:** (a) `400` (enum), (b) `400 "Grade must be a number between 0 and 100"`, (c) `400 "Path title is required"`, (d) `400`, (e) `400 "price … is less than minimum allowed value (0)"`.
- **Fix:** `runValidators: true` on both updates; grade bounds; validation/cast errors on course update map to 400; `min: 0` on `Course.price` (`src/models/Course.js:36`).
- **Status:** Reproduced + verified — test *BE-013 admin course CRUD…* (invalid price on update and create) and *assignments + BE-008/BE-013…*.

## BE-014 — Course search builds a regex from raw input
- **File:** `src/services/course.service.js:5,24` · **Severity / Priority:** Low / P3
- **Steps:** `GET /api/courses?search=(` and `?search=[`.
- **Expected:** a literal search that returns normally.
- **Observed on original:** `400 {"message":"Regular expression is invalid: missing closing parenthesis"}` (and `missing terminating ]`); `?search=.*` matched every course (total 2).
- **Observed on fixed:** `200` (`(` matches only the literal "Bob (x)"); `.*` → 0.
- **Not verified:** the earlier claim that crafted patterns could exhaust database CPU (ReDoS) was **not** demonstrated and is dropped from the severity.
- **Fix:** escape regex metacharacters.
- **Status:** Verified (partial) — error and wildcard behaviour reproduced and fixed; test *BE-014…*.

## BE-015 — Analytics day buckets off by one on non-UTC servers
- **File:** `src/services/admin.service.js:111-134` · **Severity / Priority:** Low / P3
- **Steps:** run the server on a machine ahead of UTC (this one is Bangladesh Standard Time, UTC+6), create an enrollment, call `GET /api/admin/analytics`.
- **Expected:** the enrollment appears under today's UTC date (the last `chartData` entry).
- **Observed on original:** last bucket `2026-10-28` while today (UTC) was `2026-10-29`, with 0 enrollments in it.
- **Observed on fixed:** last bucket `2026-10-29` with the 2 enrollments.
- **Scope note:** on a UTC server (e.g. Vercel) the original code behaves correctly.
- **Fix:** UTC date methods throughout.
- **Status:** Reproduced + verified — test *BE-015 analytics…* (it uses the machine's timezone, so it only fails on the original when run in a non-UTC zone).

## BE-016 — `.env.example` contained frontend variables
- **File:** `.env.example` · **Severity / Priority:** Low / P3
- **Expected:** backend variables. **Actual (original):** only `VITE_API_BASE_URL`, so a setup following the README has no `MONGODB_URI`/`JWT_SECRET` template.
- **Fix:** restored the backend template.
- **Status:** Review only.

## BE-017 — DB error text leaked; duplicate DB connect
- **Files:** `app.js:45`, `src/controllers/course.controller.js` · **Severity / Priority:** Low / P3
- **Actual (original):** the DB-connection middleware returned `error: err.message` to the client; `getCourses` called `connectDB()` although the middleware already guarantees a connection.
- **Fix:** generic client message (detail logged server-side); duplicate call removed.
- **Status:** Review only (no test simulates a database outage).

## BE-018 — Request without a body crashes on `req.body.batchId`
- **File:** `app.js:34` · **Severity / Priority:** Medium / P2
- **Steps:** `POST /api/enrollments/:courseId` with no body and no `Content-Type`.
- **Expected:** `201`. **Observed on original:** `400 {"message":"Cannot read properties of undefined (reading 'batchId')"}` (Express 5 leaves `req.body` undefined).
  **Observed on fixed:** `201`.
- **Fix:** default `req.body` to `{}` after `express.json()`.
- **Status:** Reproduced + verified — test *BE-004 enrollment…* (body-less enroll).

---

## Test and regression evidence

`npm test` → **15 tests, 110 assertions, all passing** (Node test runner + supertest + in-memory MongoDB; no `.env` needed). Also passes under `TZ=Asia/Dhaka`.
Covered: auth (login, register, `/me`, 401 handling), Zod validation details, role-based access (403), enrollment, complete-lesson ownership,
quiz scoring and stats, assignment submit/review/stats, admin course CRUD with invalid input, user ban/role/delete with self-action guards,
course list/pagination/sort/search/detail/404, analytics.

**Original code:** the same suite gives **2 pass / 13 fail**. Read this number with care: tests share fixtures (login, enroll), so on the original code
several tests fail early because of BE-001 or BE-004 rather than because of the bug in their name. The per-bug before/after evidence is therefore the
**probe output** in each entry (`tests/repro-probe.js`), which seeds users and tokens directly and isolates each bug.

**Not covered by any automated test:** BE-016, BE-017; the race in BE-006 (checked on the next read only); a database outage; a database error inside the auth middleware (it forwards to the error handler).

## Known remaining items
- None of the previously open items remain. The two that were open (negative price, tokens surviving a ban) were fixed in BE-013 and BE-011.
- Quiz retakes are intentionally allowed (existing design choice, not changed).
- No screenshots/recordings: all bugs are API-level, evidenced by the request/response pairs above.
