const Enrollment = require("../models/Enrollment");
const Course = require("../models/Course");

const enrollCourse = async (studentId, courseId, batchId = null) => {
  const course = await Course.findById(courseId);
  if (!course) throw new Error("Course not found");

  // Check if already enrolled
  let enrollment = await Enrollment.findOne({
    student: studentId,
    course: courseId,
  });

  if (enrollment) {
    // Already enrolled, return existing enrollment
    return enrollment;
  }

  // Create new enrollment
  enrollment = await Enrollment.create({
    student: studentId,
    course: courseId,
    batchId,
    progress: { completedLessons: [], percent: 0 },
  });

  return enrollment;
};

const getMyEnrollments = async (studentId) => {
  return Enrollment.find({ student: studentId })
    .populate("course", "title instructorName price category tags")
    .sort({ createdAt: -1 });
};

const completeLesson = async (studentId, enrollId, lessonId) => {
  const enrollment = await Enrollment.findById(enrollId);
  if (!enrollment || String(enrollment.student) !== String(studentId)) {
    throw new Error("Enrollment not found");
  }

  const course = await Course.findById(enrollment.course);
  if (!course) throw new Error("Course not found");

  const lessonExists = course.syllabus.some((mod) => mod.lessons.id(lessonId));
  if (!lessonExists) throw new Error("Lesson not found in this course");

  // avoid duplicates
  const alreadyDone = enrollment.progress.completedLessons
    .map(String)
    .includes(String(lessonId));

  if (!alreadyDone) {
    enrollment.progress.completedLessons.push(lessonId);
  }

  // calculate percent
  const totalLessons = course.syllabus.reduce(
    (sum, mod) => sum + mod.lessons.length,
    0
  );

  const completed = enrollment.progress.completedLessons.length;
  enrollment.progress.percent =
    totalLessons === 0 ? 0 : Math.round((completed / totalLessons) * 100);

  await enrollment.save();
  return enrollment;
};

module.exports = { enrollCourse, getMyEnrollments, completeLesson };
