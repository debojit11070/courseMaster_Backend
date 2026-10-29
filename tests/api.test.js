// API regression tests — run with `npm test`.
// Uses an in-memory MongoDB, so no database or .env is required.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const bcrypt = require("bcrypt");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongod, api, User, Course;
const ctx = {}; // shared fixtures: tokens and ids

const auth = (token) => ({ Authorization: `Bearer ${token}` });

before(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri("coursemaster_test");
  process.env.JWT_SECRET = "test-secret";
  process.env.ADMIN_REGISTRATION_KEY = "test-admin-key";
  process.env.NODE_ENV = "test";

  const app = require("../app");
  User = require("../src/models/User");
  Course = require("../src/models/Course");
  await require("../src/config/db")();
  api = request(app);

  const admin = await User.create({
    name: "Admin",
    email: "admin@test.com",
    passwordHash: await bcrypt.hash("admin123", 10),
    role: "admin",
  });
  ctx.adminId = String(admin._id);

  ctx.course = await Course.create({
    title: "MERN Bootcamp",
    description: "d",
    instructorName: "Bob (Senior)",
    price: 10,
    category: "web",
    syllabus: [
      {
        title: "Module 1",
        lessons: [
          {
            title: "Lesson 1",
            videoUrl: "u",
            quiz: [
              { question: "a", options: ["1", "2"], correctIndex: 0 },
              { question: "b", options: ["1", "2"], correctIndex: 1 },
              { question: "c", options: ["1", "2"], correctIndex: 1 },
            ],
          },
          { title: "Lesson 2", videoUrl: "u" },
        ],
      },
    ],
  });
  ctx.course2 = await Course.create({
    title: "Other",
    description: "d",
    instructorName: "Al",
    price: 5,
  });
  [ctx.l1, ctx.l2] = ctx.course.syllabus[0].lessons.map((l) => l._id);
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

// ---------- Authentication ----------

test("BE-001 login: correct password succeeds, wrong password and raw hash fail", async () => {
  let res = await api.post("/api/auth/login").send({ email: "admin@test.com", password: "admin123" });
  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  ctx.adminToken = res.body.token;

  res = await api.post("/api/auth/login").send({ email: "admin@test.com", password: "wrongpass" });
  assert.equal(res.status, 400);

  const { passwordHash } = await User.findOne({ email: "admin@test.com" });
  res = await api.post("/api/auth/login").send({ email: "admin@test.com", password: passwordHash });
  assert.equal(res.status, 400);
});

test("BE-003 register: role in payload is ignored; admin key is enforced", async () => {
  let res = await api
    .post("/api/auth/register")
    .send({ name: "Eve", email: "eve@test.com", password: "secret1", role: "admin" });
  assert.equal(res.status, 201);
  assert.equal(res.body.user.role, "student");

  res = await api
    .post("/api/auth/register")
    .send({ name: "Mal", email: "mal@test.com", password: "secret1", adminKey: "wrong" });
  assert.equal(res.status, 400);

  res = await api
    .post("/api/auth/register")
    .send({ name: "Ad", email: "ad@test.com", password: "secret1", adminKey: "test-admin-key" });
  assert.equal(res.status, 201);
  assert.equal(res.body.user.role, "admin");

  res = await api.post("/api/auth/register").send({ name: "Eve", email: "eve@test.com", password: "secret1" });
  assert.equal(res.status, 400, "duplicate email rejected");

  for (const n of [1, 2]) {
    res = await api
      .post("/api/auth/register")
      .send({ name: `Student ${n}`, email: `s${n}@test.com`, password: "secret1" });
    ctx[`s${n}`] = res.body.token;
    ctx[`s${n}Id`] = res.body.user.id;
  }
});

test("BE-010 validation errors include field details", async () => {
  const res = await api.post("/api/auth/register").send({ name: "A", email: "bad", password: "1" });
  assert.equal(res.status, 400);
  assert.equal(res.body.message, "Validation error");
  assert.equal(res.body.errors.length, 3);
  assert.ok(res.body.errors[0].path);

  const login = await api.post("/api/auth/login").send({});
  assert.equal(login.status, 400);
});

test("BE-002/BE-009 protected routes: invalid, malformed and missing tokens get 401", async () => {
  assert.equal((await api.get("/api/auth/me").set(auth("not.a.jwt"))).status, 401);
  assert.equal((await api.get("/api/auth/me").set({ Authorization: ctx.s1 })).status, 401);
  assert.equal((await api.get("/api/auth/me")).status, 401);
  assert.equal((await api.get("/api/enrollments/my").set(auth("x.y.z"))).status, 401);

  const ok = await api.get("/api/auth/me").set(auth(ctx.s1));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.email, "s1@test.com");
  assert.equal(ok.body.passwordHash, undefined);
});

test("role-based access: students cannot reach admin routes", async () => {
  assert.equal((await api.get("/api/admin/enrollments").set(auth(ctx.s1))).status, 403);
  assert.equal((await api.get("/api/users").set(auth(ctx.s1))).status, 403);
  assert.equal((await api.get("/api/admin/enrollments").set(auth(ctx.adminToken))).status, 200);
});

test("BE-007 CORS preflight allows PATCH and DELETE", async () => {
  const res = await api
    .options("/api/admin/courses/x")
    .set("Origin", "http://localhost:5173")
    .set("Access-Control-Request-Method", "PATCH");
  const methods = res.headers["access-control-allow-methods"] || "";
  assert.match(methods, /PATCH/);
  assert.match(methods, /DELETE/);
});

// ---------- Courses ----------

test("courses: list, pagination, sort, detail, 404", async () => {
  let res = await api.get("/api/courses?limit=1&page=2&sort=price_asc");
  assert.equal(res.status, 200);
  assert.equal(res.body.courses.length, 1);
  assert.equal(res.body.totalPages, 2);
  assert.equal(res.body.page, 2);
  assert.equal(res.body.courses[0].title, "MERN Bootcamp");

  res = await api.get("/api/courses?page=-5&limit=abc");
  assert.equal(res.status, 200);
  assert.equal(res.body.page, 1);

  res = await api.get(`/api/courses/${ctx.course._id}`);
  assert.equal(res.status, 200);

  res = await api.get(`/api/courses/${new mongoose.Types.ObjectId()}`);
  assert.equal(res.status, 404);
  res = await api.get("/api/nope");
  assert.equal(res.status, 404);
});

test("BE-014 course search treats input literally and never errors", async () => {
  const count = async (s) => (await api.get(`/api/courses?search=${encodeURIComponent(s)}`)).body.total;
  assert.equal(await count("bootcamp"), 1);
  assert.equal(await count("Bob (Senior)"), 1);
  assert.equal(await count("("), 1); // literal paren, matches "Bob (Senior)"
  assert.equal(await count(".*"), 0);
  assert.equal(await count("(a+)+$"), 0);
});

// ---------- Enrollment ----------

test("BE-004 enrollment: first enroll creates, repeat returns existing, unknown course fails", async () => {
  let res = await api.post(`/api/enrollments/${ctx.course._id}`).set(auth(ctx.s1)).send({});
  assert.equal(res.status, 201);
  ctx.enrollId = res.body._id;

  res = await api.post(`/api/enrollments/${ctx.course._id}`).set(auth(ctx.s1)).send({});
  assert.equal(res.status, 201);
  assert.equal(res.body._id, ctx.enrollId);

  res = await api.get("/api/enrollments/my").set(auth(ctx.s1));
  assert.equal(res.body.length, 1);

  res = await api.post(`/api/enrollments/${new mongoose.Types.ObjectId()}`).set(auth(ctx.s1)).send({});
  assert.equal(res.status, 400);

  // BE-018: a request with no body must not crash on req.body.batchId
  res = await api.post(`/api/enrollments/${ctx.course2._id}`).set(auth(ctx.s1));
  assert.equal(res.status, 201);
  await api.get("/api/enrollments/my").set(auth(ctx.s1));
});

test("BE-006/BE-012 complete lesson: persisted, owner-only, lesson must belong to course", async () => {
  const url = `/api/enrollments/${ctx.enrollId}/complete-lesson`;

  let res = await api.patch(url).set(auth(ctx.s2)).send({ lessonId: ctx.l1 });
  assert.equal(res.status, 400, "another student is rejected");

  res = await api.patch(url).set(auth(ctx.s1)).send({ lessonId: new mongoose.Types.ObjectId() });
  assert.equal(res.status, 400, "unknown lesson is rejected");

  res = await api.patch(url).set(auth(ctx.s1)).send({ lessonId: ctx.l1 });
  assert.equal(res.status, 200);
  assert.equal(res.body.progress.percent, 50);

  await api.patch(url).set(auth(ctx.s1)).send({ lessonId: ctx.l1 }); // duplicate is a no-op
  res = await api.get("/api/enrollments/my").set(auth(ctx.s1));
  const mine = res.body.find((e) => e._id === ctx.enrollId);
  assert.equal(mine.progress.completedLessons.length, 1);
  assert.equal(mine.progress.percent, 50, "progress was persisted");
});

// ---------- Quiz ----------

test("BE-005 quiz: percent is 0-100, validation, stats", async () => {
  const submit = (answers, token = ctx.s1) =>
    api.post("/api/quizzes/submit").set(auth(token)).send({ courseId: ctx.course._id, lessonId: ctx.l1, answers });

  let res = await submit([0, 1, 1]);
  assert.equal(res.status, 200);
  assert.equal(res.body.percent, 100);
  assert.equal(res.body.score, 3);

  res = await submit([0, 1, 0]);
  assert.equal(res.body.percent, 67);

  res = await submit([1, 0, 0]);
  assert.equal(res.body.percent, 0);

  assert.equal((await submit("not-an-array")).status, 400);
  assert.equal((await submit([0, 1, 1], ctx.s2)).status, 400, "must be enrolled");

  await submit([0, 1, 0]);
  res = await api.get(`/api/quizzes/stats?courseId=${ctx.course._id}`).set(auth(ctx.s1));
  assert.equal(res.body.totalQuizzes, 1);
  assert.equal(res.body.average, 67, "latest attempt per lesson is used");

  assert.equal((await api.get("/api/quizzes/stats").set(auth(ctx.s1))).status, 400);
});

// ---------- Assignments ----------

test("assignments + BE-008/BE-013: submit, admin filter, review validation", async () => {
  let res = await api
    .post("/api/assignments/submit")
    .set(auth(ctx.s1))
    .send({ courseId: ctx.course._id, lessonId: ctx.l2, answerType: "text", answer: "my answer" });
  assert.equal(res.status, 201);
  const id = res.body._id;

  res = await api
    .post("/api/assignments/submit")
    .set(auth(ctx.s2))
    .send({ courseId: ctx.course._id, lessonId: ctx.l2, answerType: "text", answer: "x" });
  assert.equal(res.status, 400, "must be enrolled");

  res = await api.get(`/api/admin/assignments?courseId=${ctx.course2._id}`).set(auth(ctx.adminToken));
  assert.equal(res.body.length, 0);
  res = await api.get(`/api/admin/assignments?courseId=${ctx.course._id}`).set(auth(ctx.adminToken));
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].lessonTitle, "Lesson 2");
  res = await api.get("/api/admin/assignments").set(auth(ctx.adminToken));
  assert.equal(res.body.length, 1);

  const review = (body) => api.patch(`/api/admin/assignments/${id}/review`).set(auth(ctx.adminToken)).send(body);
  assert.equal((await review({ status: "banana" })).status, 400);
  assert.equal((await review({ grade: 500 })).status, 400);
  assert.equal((await review({ grade: "A+" })).status, 400);
  res = await review({ grade: 90, status: "reviewed", reviewNotes: "Good" });
  assert.equal(res.status, 200);
  assert.equal(res.body.grade, 90);

  res = await api.get(`/api/assignments/stats?courseId=${ctx.course._id}`).set(auth(ctx.s1));
  assert.equal(res.body.average, 90);
  assert.equal(res.body.reviewedCount, 1);
});

// ---------- Admin course CRUD ----------

test("BE-013 admin course CRUD with validation", async () => {
  const admin = auth(ctx.adminToken);

  let res = await api.post("/api/admin/courses").set(admin).send({ title: "x" });
  assert.equal(res.status, 400, "missing required fields");

  res = await api
    .post("/api/admin/courses")
    .set(admin)
    .send({ title: "New", description: "d", instructorName: "i", price: 1 });
  assert.equal(res.status, 201);
  const id = res.body._id;

  assert.equal((await api.patch(`/api/admin/courses/${id}`).set(admin).send({ price: "abc" })).status, 400);
  assert.equal((await api.patch(`/api/admin/courses/${id}`).set(admin).send({ price: -5 })).status, 400, "negative price");
  assert.equal((await api.post("/api/admin/courses").set(admin).send({ title: "Neg", description: "d", instructorName: "i", price: -1 })).status, 400);
  res = await api.patch(`/api/admin/courses/${id}`).set(admin).send({ price: 99 });
  assert.equal(res.status, 200);
  assert.equal(res.body.price, 99);
  assert.equal((await api.patch(`/api/admin/courses/${new mongoose.Types.ObjectId()}`).set(admin).send({ price: 1 })).status, 404);

  assert.equal((await api.delete(`/api/admin/courses/${id}`).set(admin)).status, 200);
  assert.equal((await api.delete(`/api/admin/courses/${id}`).set(admin)).status, 404);
});

// ---------- User management ----------

test("BE-011 user management: ban blocks login, role change, self-action guards, delete", async () => {
  const admin = auth(ctx.adminToken);

  let res = await api.patch(`/api/users/${ctx.s2Id}/ban`).set(admin);
  assert.equal(res.body.isBanned, true);
  // an already-issued token stops working immediately
  res = await api.get("/api/auth/me").set(auth(ctx.s2));
  assert.equal(res.status, 403);
  assert.match(res.body.message, /banned/i);
  res = await api.post("/api/auth/login").send({ email: "s2@test.com", password: "secret1" });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /banned/i);

  await api.patch(`/api/users/${ctx.s2Id}/ban`).set(admin);
  res = await api.post("/api/auth/login").send({ email: "s2@test.com", password: "secret1" });
  assert.equal(res.status, 200);
  assert.equal((await api.get("/api/auth/me").set(auth(ctx.s2))).status, 200, "token works again after un-ban");

  assert.equal((await api.patch(`/api/users/${ctx.s2Id}/role`).set(admin).send({ role: "root" })).status, 400);
  assert.equal((await api.get("/api/users").set(auth(ctx.s2))).status, 403, "student token cannot list users");
  res = await api.patch(`/api/users/${ctx.s2Id}/role`).set(admin).send({ role: "admin" });
  assert.equal(res.body.role, "admin");
  assert.equal((await api.get("/api/users").set(auth(ctx.s2))).status, 200, "promotion applies to the old token");

  assert.equal((await api.delete(`/api/users/${ctx.adminId}`).set(admin)).status, 400);
  assert.equal((await api.patch(`/api/users/${ctx.adminId}/ban`).set(admin)).status, 400);
  assert.equal((await api.patch(`/api/users/${ctx.adminId}/role`).set(admin).send({ role: "student" })).status, 400);

  assert.equal((await api.delete(`/api/users/${ctx.s2Id}`).set(admin)).status, 200);
  assert.equal((await api.get("/api/auth/me").set(auth(ctx.s2))).status, 401, "token of a deleted user is rejected");
  assert.equal((await api.delete(`/api/users/${ctx.s2Id}`).set(admin)).status, 400);
});

// ---------- Analytics ----------

test("BE-015 analytics buckets use UTC dates and count today's enrollment", async () => {
  const res = await api.get("/api/admin/analytics").set(auth(ctx.adminToken));
  assert.equal(res.status, 200);
  assert.equal(res.body.chartData.length, 30);
  const today = res.body.chartData[29];
  assert.equal(today.date, new Date().toISOString().split("T")[0]);
  assert.equal(today.enrollments, 2);
  assert.equal(res.body.stats.totalEnrollments, 2);
  assert.deepEqual(
    res.body.enrollmentsByCourse.map((c) => c.courseName).sort(),
    ["MERN Bootcamp", "Other"]
  );
});
