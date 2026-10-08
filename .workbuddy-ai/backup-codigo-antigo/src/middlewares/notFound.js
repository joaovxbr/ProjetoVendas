module.exports = (req, res) => {
  res.status(404).json({ erro: `Rota ${req.method} ${req.originalUrl} não existe` });
};
