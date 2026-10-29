// Reproduction probe: replays each bug's reproduction steps against an app copy and prints the raw
// status/body, so the "Actual" behaviour in BUG_REPORT.md can be re-checked.
// It is NOT part of `npm test` (the test glob is tests/**/*.test.js). Uses an in-memory MongoDB.
//
//   Fixed code:     node tests/repro-probe.js .
//   Original code:  git archive dee9a5f | tar -x -C ../backend-old
//                   NODE_PATH=$PWD/node_modules node tests/repro-probe.js ../backend-old
//   (On Windows set MONGOMS_DOWNLOAD_DIR=<repo>/node_modules/.cache/mongodb-memory-server so the
//    cached mongod binary is reused when running from another folder.)
const path = require("path");
const root = path.resolve(process.argv[2] || ".");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");
const bcrypt = require("bcrypt");
const mongoose = require("mongoose");
const out = (k, v) => console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
const short = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`;

(async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri("probe");
  process.env.JWT_SECRET = "s";
  process.env.ADMIN_REGISTRATION_KEY = "adminkey";
  const app = require(path.join(root, "app.js"));
  const User = require(path.join(root, "src/models/User"));
  const Course = require(path.join(root, "src/models/Course"));
  const generateToken = require(path.join(root, "src/utils/generateToken"));
  await require(path.join(root, "src/config/db"))();
  const A = request(app);
  const H = (t) => ({ Authorization: "Bearer " + t });

  const adminHash = await bcrypt.hash("admin123", 10);
  const admin = await User.create({ name: "Admin", email: "admin@x.com", passwordHash: adminHash, role: "admin" });
  const adminTok = generateToken({ id: admin._id, role: "admin" });
  const course = await Course.create({
    title: "C", description: "d", instructorName: "Bob (x)", price: 10,
    syllabus: [{ title: "m", lessons: [{ title: "l1", videoUrl: "u", quiz: [
      { question: "a", options: ["1", "2"], correctIndex: 0 },
      { question: "b", options: ["1", "2"], correctIndex: 1 },
      { question: "c", options: ["1", "2"], correctIndex: 1 }] }, { title: "l2", videoUrl: "u" }] }],
  });
  const course2 = await Course.create({ title: "C2", description: "d", instructorName: "Al", price: 5 });
  const [l1, l2] = course.syllabus[0].lessons.map((l) => l._id);
  const stu = await User.create({ name: "S", email: "s@x.com", passwordHash: await bcrypt.hash("secret1", 10) });
  const stuTok = generateToken({ id: stu._id, role: "student" });
  const stu2 = await User.create({ name: "S2", email: "s2@x.com", passwordHash: await bcrypt.hash("secret1", 10) });
  const stu2Tok = generateToken({ id: stu2._id, role: "student" });

  out("BE-001 login correct pw", short(await A.post("/api/auth/login").send({ email: "admin@x.com", password: "admin123" })));
  out("BE-001 login with raw hash as pw", short(await A.post("/api/auth/login").send({ email: "admin@x.com", password: adminHash })));

  out("BE-002 GET /me bad token", short(await A.get("/api/auth/me").set(H("not.a.jwt"))));
  out("BE-002 GET /enrollments/my bad token", short(await A.get("/api/enrollments/my").set(H("not.a.jwt"))));
  out("BE-002 GET /admin/enrollments bad token", short(await A.get("/api/admin/enrollments").set(H("not.a.jwt"))));
  out("BE-009 GET /me raw token (no Bearer)", short(await A.get("/api/auth/me").set({ Authorization: stuTok })));

  out("BE-003 register role=admin", short(await A.post("/api/auth/register").send({ name: "Eve", email: "eve@x.com", password: "secret1", role: "admin" })));
  out("BE-003 register adminKey=wrong", short(await A.post("/api/auth/register").send({ name: "Mal", email: "mal@x.com", password: "secret1", adminKey: "wrong" })));
  out("BE-003 register adminKey=correct", short(await A.post("/api/auth/register").send({ name: "Ad", email: "ad@x.com", password: "secret1", adminKey: "adminkey" })));
  // service-level (bypasses zod) to show the latent escalation
  try {
    const svc = require(path.join(root, "src/services/auth.service"));
    const r = await svc.register({ name: "Svc", email: "svc@x.com", password: "secret1", role: "admin" });
    out("BE-003 service.register({role:'admin'})", r.user.role);
  } catch (e) { out("BE-003 service.register({role:'admin'})", "error: " + e.message); }

  out("BE-010 validation body", short(await A.post("/api/auth/register").send({ name: "A", email: "bad", password: "1" })));

  out("BE-004 enroll first time", short(await A.post(`/api/enrollments/${course._id}`).set(H(stuTok)).send({})));
  out("BE-004 enroll again", short(await A.post(`/api/enrollments/${course._id}`).set(H(stuTok)).send({})));
  const { Enrollment } = { Enrollment: require(path.join(root, "src/models/Enrollment")) };
  await Enrollment.deleteMany({});
  const enr = await Enrollment.create({ student: stu._id, course: course._id, progress: { completedLessons: [], percent: 0 } });

  out("BE-018 enroll with no body", short(await A.post(`/api/enrollments/${course2._id}`).set(H(stuTok))));
  await Enrollment.deleteOne({ course: course2._id });

  out("BE-012 other student completes my enrollment", short(await A.patch(`/api/enrollments/${enr._id}/complete-lesson`).set(H(stu2Tok)).send({ lessonId: l1 })));
  const bogus = new mongoose.Types.ObjectId();
  out("BE-012 unknown lessonId", short(await A.patch(`/api/enrollments/${enr._id}/complete-lesson`).set(H(stuTok)).send({ lessonId: bogus })));
  const fresh = await Enrollment.findById(enr._id);
  out("BE-012 stored completedLessons/percent", { n: fresh.progress.completedLessons.length, percent: fresh.progress.percent });

  const q = await A.post("/api/quizzes/submit").set(H(stuTok)).send({ courseId: course._id, lessonId: l1, answers: [0, 1, 1] });
  out("BE-005 quiz 3/3", short(q));

  const sub = await A.post("/api/assignments/submit").set(H(stuTok)).send({ courseId: course._id, lessonId: l2, answerType: "text", answer: "hi" });
  const sid = sub.body._id;
  out("BE-008 admin assignments ?courseId=<other course> (expect 0)", (await A.get(`/api/admin/assignments?courseId=${course2._id}`).set(H(adminTok))).body.length);
  out("BE-008 admin assignments ?courseId=<own course> (expect 1)", (await A.get(`/api/admin/assignments?courseId=${course._id}`).set(H(adminTok))).body.length);
  out("BE-013 review status=banana", short(await A.patch(`/api/admin/assignments/${sid}/review`).set(H(adminTok)).send({ status: "banana" })));
  out("BE-013 review grade=500", short(await A.patch(`/api/admin/assignments/${sid}/review`).set(H(adminTok)).send({ grade: 500 })));
  out("BE-013 course price=abc", short(await A.patch(`/api/admin/courses/${course._id}`).set(H(adminTok)).send({ price: "abc" })));
  out("BE-013 course price=-5", short(await A.patch(`/api/admin/courses/${course._id}`).set(H(adminTok)).send({ price: -5 })));
  out("BE-013 course title=''", short(await A.patch(`/api/admin/courses/${course._id}`).set(H(adminTok)).send({ title: "" })));
  const cur = await Course.findById(course._id);
  out("BE-013 course after (title,price)", { title: cur.title, price: cur.price });
  const rev = await mongoose.connection.collection("assignmentsubmissions").findOne({ _id: new mongoose.Types.ObjectId(sid) });
  out("BE-013 stored submission (status,grade)", { status: rev.status, grade: rev.grade });

  out("BE-014 search='('", short(await A.get("/api/courses?search=" + encodeURIComponent("(")).then((r) => ({ status: r.status, body: r.body.message ? r.body : { total: r.body.total } }))));
  out("BE-014 search='[' ", short(await A.get("/api/courses?search=" + encodeURIComponent("[")).then((r) => ({ status: r.status, body: r.body.message ? r.body : { total: r.body.total } }))));
  out("BE-014 search='.*' total", (await A.get("/api/courses?search=" + encodeURIComponent(".*"))).body.total);

  await A.patch(`/api/users/${stu2._id}/ban`).set(H(adminTok));
  out("BE-011 banned user login", short(await A.post("/api/auth/login").send({ email: "s2@x.com", password: "secret1" })));

  const an = await A.get("/api/admin/analytics").set(H(adminTok));
  await Enrollment.create({ student: stu2._id, course: course2._id });
  const an2 = await A.get("/api/admin/analytics").set(H(adminTok));
  const todayUTC = new Date().toISOString().slice(0, 10);
  const days = an2.body.chartData.map((d) => d.date);
  out("BE-015 TZ / today UTC / last bucket / today count", { TZ: process.env.TZ || "(system)", todayUTC, lastBucket: days[days.length - 1], countOnLast: an2.body.chartData.at(-1).enrollments, distinct: new Set(days).size });

  await mongoose.disconnect();
  await mongod.stop();
  process.exit(0);
})().catch((e) => { console.error("PROBE ERROR", e); process.exit(2); });
