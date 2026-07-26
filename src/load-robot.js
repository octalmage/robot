const path = require("path");

function loadRobot() {
  const explicitPath = process.env.ROBOTJS_PATH;

  if (explicitPath) {
    return require(path.resolve(explicitPath));
  }

  try {
    return require("robotjs");
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") {
      throw error;
    }
  }

  return require(path.resolve(__dirname, "..", "..", "robotjs"));
}

module.exports = {
  loadRobot
};
