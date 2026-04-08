// Public health-check endpoint for assignment validation.
// Must return the exact token payload without authentication.
module.exports = (req, res) => {
  res.status(200).json({ token: "5d1ee185fcb4f00932078374a9c8a98c" });
};
