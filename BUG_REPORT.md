# CourseMaster Backend — Bug Report

Scope: backend only (Node.js / Express 5 / MongoDB / Mongoose). Every fix below is covered by an automated test in
[`tests/api.test.js`](tests/api.test.js) (`npm test`). See [Testing & regression evidence](#testing--regression-evidence).

## Summary

| ID | Title | Area | Severity | Priority | Status |
|----|-------|------|----------|----------|--------|
| BE-001 | Login compares password to the stored hash in plaintext | Authentication | Critical | P0 | Fixed & verified |
| BE-002 | Invalid/expired JWT is let through (`next()` instead of 401) | Authorization | Critical | P0 | Fixed & verified |
| BE-003 | Anyone can register as admin by sending `role` | Authorization | Critical | P0 | Fixed & verified |
| BE-004 | Enrollment logic inverted — cannot enroll in any course | Business logic | Critical | P0 | Fixed & verified |
| BE-005 | Quiz percentage computed ×10 instead of ×100 | Business logic | High | P1 | Fixed & verified |
| BE-006 | `completeLesson` does not `await` `save()` | Data handling | High | P1 | Fixed & verified |
| BE-007 | Custom CORS header restricts methods to GET, POST | API integration | Low | P3 | Removed (see note) |
| BE-008 | Admin assignments `courseId` filter never applied | Backend / DB | Medium | P2 | Fixed & verified |
| BE-009 | Auth middleware accepts a token without the `Bearer ` scheme | Authentication | Medium | P2 | Fixed & verified |
| BE-010 | Validation error response has no details (`err.errors` undefined on Zod 4) | Data validation | Medium | P2 | Fixed & verified |
| BE-011 | Banned users can still log in | Authorization | High | P1 | Fixed & verified |
| BE-012 | Any student can complete lessons on another's enrollment / unknown lessons | Authorization | High | P1 | Fixed & verified |
| BE-013 | Update endpoints skip schema validation (invalid `status`, `grade`, `price`) | Data validation | Medium | P2 | Fixed & verified |
| BE-014 | Course search builds a regex from raw user input | Stability | Medium | P2 | Fixed & verified |
| BE-015 | Analytics day buckets shift by a day on non-UTC servers | Data handling | Low | P3 | Fixed & verified |
| BE-016 | `.env.example` contains frontend variables, backend config missing | Configuration | Low | P3 | Fixed |
| BE-017 | DB error message leaked to client; duplicate DB connect in controller | Stability | Low | P3 | Fixed |
| BE-018 | Enrolling with no request body crashes on `req.body.batchId` (Express 5) | API integration | Medium | P2 | Fixed & verified |

Severity: Critical = security hole / core feature unusable; High = major feature wrong; Medium = incorrect behaviour with a
workaround; Low = minor. Priority: P0 fix immediately … P3 when convenient.

---

## BE-001 — Login compares password to the stored hash in plaintext
- **File:** `src/services/auth.service.js` (`login`) · **Severity/Priority:** Critical / P0
- **Steps:** `POST /api/auth/login` with `{"email":"admin@coursemaster.com","password":"admin123"}` on a seeded DB.
- **Expected:** 200 + token (password checked with `bcrypt.compare`).
- **Actual:** 400 `Invalid email or password` for every correct password (`password === user.passwordHash`); submitting the
  stored hash itself would have logged in.
- **Fix:** `await bcrypt.compare(password, user.passwordHash)`.
- **Verification:** test *BE-001* — correct password 200, wrong password 400, raw hash 400. ✅

## BE-002 — Invalid/expired JWT is let through
- **File:** `src/middlewares/authMiddleware.js` · **Severity/Priority:** Critical / P0
- **Steps:** `GET /api/auth/me` with `Authorization: Bearer not.a.jwt`.
- **Expected:** 401 `Invalid token`. **Actual:** the `catch` called `next()`; the request continued with `req.user`
  undefined.
- **Fix:** `return res.status(401).json({ message: "Invalid token" })`.
- **Verification:** test *BE-002/BE-009* — garbage token 401 on `/me` and `/enrollments/my`; valid token 200. ✅

## BE-003 — Privilege escalation through `role` in the registration service
- **File:** `src/services/auth.service.js` (`register`) · **Severity/Priority:** Critical / P0
- **Steps:** call the register service with `role: "admin"`; the admin-key check had been removed and `role` was stored as given.
- **Expected:** `student` unless a valid `ADMIN_REGISTRATION_KEY` is supplied.
- **Actual:** requested role honoured with no key.
- **Fix:** `role` is no longer read from the payload; `adminKey` is validated (unconfigured → "Admin registration is not
  configured", wrong → "Invalid admin registration key").
- **Verification:** test *BE-003* — `role:"admin"` → student; wrong key 400; correct key → admin; duplicate email 400. ✅

## BE-004 — Enrollment logic inverted
- **File:** `src/services/enrollment.service.js` · **Severity/Priority:** Critical / P0
- **Steps:** as a student not yet enrolled, `POST /api/enrollments/:courseId`.
- **Expected:** 201 + new enrollment; repeat call returns the existing enrollment.
- **Actual:** `if (!enrollment) throw "Already enrolled…"` — first enrollment always failed, create code unreachable.
- **Fix:** `if (enrollment) return enrollment;`.
- **Verification:** test *BE-004* — first 201, repeat returns same `_id`, `/my` has 1 record, unknown course 400. ✅

## BE-005 — Quiz percentage calculated ×10
- **File:** `src/services/quiz.service.js` · **Severity/Priority:** High / P1
- **Steps:** submit a 3-question quiz with 3 correct answers.
- **Expected:** `percent: 100`. **Actual:** `10` (stored wrongly; stats average wrong).
- **Fix:** `Math.round((score / total) * 100)`; non-array `answers` now rejected with a clear 400.
- **Verification:** test *BE-005* — 3/3→100, 2/3→67, 0/3→0, bad payload 400, un-enrolled 400, stats average 67. ✅

## BE-006 — `completeLesson` does not await `save()`
- **File:** `src/services/enrollment.service.js` · **Severity/Priority:** High / P1
- **Steps:** `PATCH /api/enrollments/:id/complete-lesson`, then immediately `GET /api/enrollments/my`.
- **Expected:** progress persisted before responding. **Actual:** response returned before the write completed; failures
  became unhandled rejections.
- **Fix:** `await enrollment.save()`.
- **Verification:** test *BE-006/BE-012* — progress 50 % visible on the next read; duplicate completion is a no-op. ✅

## BE-007 — Custom `Access-Control-Allow-Methods: GET, POST` header (note: not reproducible as a preflight failure)
- **File:** `app.js` · **Severity/Priority:** Low / P3
- **Finding:** a middleware after `cors()` set `Access-Control-Allow-Methods: GET, POST`. I initially suspected it broke
  PUT/PATCH/DELETE preflights, but testing showed `cors()` answers `OPTIONS` itself (204) before this middleware runs, so
  preflights were already correct. The header was misleading dead configuration.
- **Fix:** middleware removed; `cors()` alone handles CORS.
- **Verification:** test *BE-007* asserts preflight allows PATCH and DELETE (passes before and after — it is a regression
  guard, not a bug reproduction). ✅

## BE-008 — Admin assignment list ignores course filter
- **Files:** `admin.service.js`, `admin.controller.js` · **Severity/Priority:** Medium / P2
- **Steps:** `GET /api/admin/assignments?courseId=<id>`.
- **Expected:** only that course's submissions. **Actual:** controller never forwarded the query, and the service filtered
  on non-existent field `courseId` (schema field is `course`).
- **Fix:** controller passes `req.query`; service filters on `course`.
- **Verification:** test *assignments + BE-008/BE-013* — other course → 0, own course → 1 (with `lessonTitle`), no filter → all. ✅

## BE-009 — `Authorization` header accepted without `Bearer`
- **File:** `authMiddleware.js` · **Severity/Priority:** Medium / P2
- **Steps:** `GET /api/auth/me` with `Authorization: <raw jwt>`. **Expected:** 401. **Actual:** accepted.
- **Fix:** require the `Bearer ` prefix.
- **Verification:** test *BE-002/BE-009* — raw token 401, missing header 401. ✅

## BE-010 — Validation errors return no details
- **File:** `src/middlewares/validate.js` · **Severity/Priority:** Medium / P2
- **Steps:** `POST /api/auth/register` with `{"name":"A","email":"bad","password":"1"}`.
- **Expected:** `errors` array per invalid field. **Actual:** `errors` missing — Zod 4 exposes `.issues`, not `.errors`.
- **Fix:** `err.issues`.
- **Verification:** test *BE-010* — 400, `message: "Validation error"`, 3 issues with `path`. ✅

## BE-011 — Banned users can still log in
- **Files:** `auth.service.js`, `user.service.js` · **Severity/Priority:** High / P1
- **Steps:** admin `PATCH /api/users/:id/ban`, then that user logs in.
- **Expected:** login refused. **Actual:** `isBanned` was stored but never checked.
- **Fix:** login rejects with "Your account has been banned".
- **Verification:** test *BE-011* — banned login 400, after un-ban 200; role change, invalid role 400, self-delete / self-ban /
  self-role-change guards, delete user. ✅
- **Limitation:** tokens issued before the ban stay valid until expiry (30 days); enforcing that needs a DB lookup per request.

## BE-012 — Lesson completion not scoped to owner / course
- **Files:** `enrollment.service.js`, `enrollment.controller.js` · **Severity/Priority:** High / P1
- **Steps:** student B calls `complete-lesson` on student A's `enrollId`, or sends a random `lessonId`.
- **Expected:** 400. **Actual:** another student's progress was modified and arbitrary ids stored (inflating `percent`).
- **Fix:** controller passes `req.user.id`; service checks ownership and lesson membership.
- **Verification:** test *BE-006/BE-012* — other student 400, unknown lesson 400, own lesson 200. ✅

## BE-013 — Update endpoints skip schema validation
- **File:** `admin.service.js` (+ status mapping in `admin.controller.js`) · **Severity/Priority:** Medium / P2
- **Steps:** review with `{"status":"banana"}` / `{"grade":500}`; course update with `{"price":"abc"}`.
- **Expected:** 400. **Actual:** `findByIdAndUpdate` doesn't run validators, so an invalid status was saved and grade was
  unbounded.
- **Fix:** `runValidators: true`; grade must be a number 0–100; validation/cast errors on course update map to 400 (were 404).
- **Verification:** tests *assignments…* and *BE-013 admin course CRUD* — invalid status/grade/price 400, valid 200, missing
  required fields on create 400, unknown id 404, delete twice → 200 then 404. ✅

## BE-014 — Unescaped user input used as a regular expression
- **File:** `course.service.js` · **Severity/Priority:** Medium / P2
- **Steps:** `GET /api/courses?search=(a+)+$` or `?search=(`.
- **Expected:** literal search, no error. **Actual:** invalid patterns errored; crafted patterns can burn DB CPU (ReDoS).
- **Fix:** escape regex metacharacters.
- **Verification:** test *BE-014* — `(` matches only the literal "Bob (Senior)", `.*` and `(a+)+$` match nothing, no errors. ✅

## BE-015 — Analytics date buckets depend on server timezone
- **File:** `admin.service.js` (`getAnalytics`) · **Severity/Priority:** Low / P3
- **Expected:** enrollment counted on its UTC date. **Actual:** local-midnight dates converted with `toISOString()` (UTC)
  shifted every bucket by a day on servers ahead of UTC.
- **Fix:** UTC date methods throughout.
- **Verification:** test *BE-015* — today's bucket has the enrollment; run under both `TZ=UTC` and `TZ=Asia/Dhaka`. ✅

## BE-016 — `.env.example` contained frontend variables
- **Expected:** backend variables. **Actual:** only `VITE_API_BASE_URL`, so a fresh setup fails with "MONGODB_URI … missing".
- **Fix:** restored the backend template. (Configuration only; no automated test.)

## BE-017 — Internal error detail leaked; redundant DB connect
- **Files:** `app.js`, `course.controller.js`. The DB-connection middleware returned `err.message` to clients; `getCourses`
  re-called `connectDB()` although the middleware already guarantees a connection.
- **Fix:** generic client message (detail logged server-side); duplicate call removed.

## BE-018 — Request without a body crashes `req.body` access
- **Files:** `app.js`, `enrollment.controller.js` · **Severity/Priority:** Medium / P2
- **Steps:** `POST /api/enrollments/:courseId` with no body and no JSON content type.
- **Expected:** 201. **Actual:** Express 5 leaves `req.body` undefined, so `req.body.batchId` threw a TypeError → 400
  "Cannot read properties of undefined".
- **Fix:** middleware after `express.json()` defaults `req.body` to `{}`.
- **Verification:** test *BE-004* — body-less enroll returns 201. ✅

---

## Testing & regression evidence

**How to run:** `npm install && npm test` — uses `mongodb-memory-server`, so no database or `.env` is needed.

**Suite:** 15 tests / 100 assertions in `tests/api.test.js` (Node's built-in test runner + supertest).

| Area | Covered |
|------|---------|
| Auth | login (ok / wrong password / hash-as-password), register (role ignored, admin key, duplicate email), `/me`, 401 handling |
| Validation & errors | Zod error details, bad ids (404/400), non-array quiz answers, invalid grade/status/price, missing course fields |
| Authorization | student blocked from admin routes (403), owner-only lesson completion, self-action guards |
| Features (regression) | courses list/pagination/sort/search/detail, enroll, my enrollments, complete lesson, quiz submit + stats, assignment submit + stats + review, admin course CRUD, user ban/role/delete, analytics |

**Before / after results**

| Code under test | Passed | Failed |
|-----------------|--------|--------|
| Original buggy code (`dee9a5f`, tests run in a separate worktree) | 2 | 13 |
| Fixed code (`main`) | 15 | 0 |

The only tests that pass on the buggy code are the regression guards for CORS (BE-007, see note) and course listing. The
suite also passes with `TZ=Asia/Dhaka`.

## Known remaining items
- Tokens issued before a ban remain valid until expiry (BE-011).
- Quiz retakes are intentionally allowed (existing design choice).
- No screenshots/recordings: all bugs are API-level and are evidenced by the requests and tests above.
