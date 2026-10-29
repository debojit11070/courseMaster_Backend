// middleware to authenticate JWT tokens

const jwt = require("jsonwebtoken");
const User = require("../models/User");

const authMiddleware = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Not authorized" });
  }

  const token = header.split(" ")[1];

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }

  try {
    // re-check the account on every request so bans, deletions and role
    // changes take effect immediately instead of when the token expires
    const user = await User.findById(decoded.id).select("role isBanned");
    if (!user) return res.status(401).json({ message: "Invalid token" });
    if (user.isBanned) {
      return res.status(403).json({ message: "Your account has been banned" });
    }

    req.user = { id: decoded.id, role: user.role }; // role from the database, not the token
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = authMiddleware;
