// Tratamento central de erros
module.exports = (err, req, res, next) => {
  // Resposta já começou: deixa o Express encerrar a conexão
  if (res.headersSent) return next(err);

  // Corpo JSON malformado (body-parser)
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ erro: 'JSON inválido' });
  }

  // Corpo acima do limite configurado
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ erro: 'Conteúdo da requisição muito grande' });
  }

  // Demais erros do cliente (4xx)
  const status = Number(err.status || err.statusCode);
  if (status >= 400 && status < 500) {
    const erro = status === 404 ? 'Recurso não encontrado' : 'Requisição inválida';
    return res.status(status).json({ erro });
  }

  console.error('[ERRO]', err.stack || err.message);
  res.status(500).json({ erro: 'Erro interno no servidor' });
};
