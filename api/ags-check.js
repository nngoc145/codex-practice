module.exports = (req, res) => {
  // Health-check endpoint required by assignment; always return 200 OK
  res.status(200).json({ status: "ok" });
};
