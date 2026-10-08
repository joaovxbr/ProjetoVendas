/*
 * utils/erros.js
 * -----------------------------------------------------------------------------
 * Erros da aplicacao. Toda falha esperada (validacao, permissao, conflito...)
 * e representada por uma subclasse de AppError, e o middleware de erros sabe
 * traduzir isso para uma resposta HTTP.
 *
 * O formato da resposta segue o contrato que o front ja consome:
 *   { "erro": "mensagem amigavel", "codigo": "identificador", "detalhes": {...} }
 *
 * "detalhes" e opcional e serve para erros de formulario (campo -> mensagem).
 */
'use strict';

class AppError extends Error {
  constructor(mensagem, { status = 500, codigo = 'erro_interno', detalhes = null } = {}) {
    super(mensagem);
    this.name = new.target.name;
    this.status = status;
    this.codigo = codigo;
    this.detalhes = detalhes;
    // Erros operacionais sao esperados e podem ser mostrados ao cliente.
    // Qualquer coisa fora disso e bug e vira 500 generico.
    this.operacional = true;
    Error.captureStackTrace(this, new.target);
  }

  paraJSON() {
    const corpo = { erro: this.message, codigo: this.codigo };
    if (this.detalhes) corpo.detalhes = this.detalhes;
    return corpo;
  }
}

/** 400 - dados enviados nao fazem sentido. */
class ErroValidacao extends AppError {
  constructor(mensagem = 'Dados invalidos', detalhes = null) {
    super(mensagem, { status: 400, codigo: 'dados_invalidos', detalhes });
  }
}

/** 401 - sem sessao valida. */
class NaoAutenticado extends AppError {
  constructor(mensagem = 'Faca login para continuar') {
    super(mensagem, { status: 401, codigo: 'nao_autenticado' });
  }
}

/** 403 - autenticado, mas sem permissao. */
class SemPermissao extends AppError {
  constructor(mensagem = 'Voce nao tem permissao para esta acao') {
    super(mensagem, { status: 403, codigo: 'sem_permissao' });
  }
}

/** 404 - recurso inexistente. */
class NaoEncontrado extends AppError {
  constructor(mensagem = 'Recurso nao encontrado') {
    super(mensagem, { status: 404, codigo: 'nao_encontrado' });
  }
}

/** 409 - conflito com o estado atual (e-mail ja cadastrado, etc). */
class Conflito extends AppError {
  constructor(mensagem = 'Este recurso ja existe') {
    super(mensagem, { status: 409, codigo: 'conflito' });
  }
}

/** 422 - os dados estao corretos, mas a regra de negocio impede a acao. */
class RegraNegocio extends AppError {
  constructor(mensagem = 'Nao foi possivel concluir a operacao', detalhes = null) {
    super(mensagem, { status: 422, codigo: 'regra_de_negocio', detalhes });
  }
}

/**
 * 409 - nao ha chave suficiente no estoque para atender o pedido.
 *
 * Tem codigo proprio (e nao "regra_de_negocio" generico) porque o front precisa
 * reconhecer esse caso e reagir de um jeito especifico: marcar o produto como
 * esgotado na vitrine, em vez de mostrar um erro qualquer.
 */
class EstoqueInsuficiente extends AppError {
  constructor(mensagem = 'Nao ha estoque suficiente para este produto', detalhes = null) {
    super(mensagem, { status: 409, codigo: 'estoque_insuficiente', detalhes });
  }
}

/** 429 - abuso / excesso de tentativas. */
class LimiteExcedido extends AppError {
  constructor(mensagem = 'Muitas tentativas. Aguarde e tente novamente.') {
    super(mensagem, { status: 429, codigo: 'limite_excedido' });
  }
}

/** 503 - dependencia externa indisponivel. */
class Indisponivel extends AppError {
  constructor(mensagem = 'Servico temporariamente indisponivel') {
    super(mensagem, { status: 503, codigo: 'indisponivel' });
  }
}

module.exports = {
  AppError,
  ErroValidacao,
  NaoAutenticado,
  SemPermissao,
  NaoEncontrado,
  Conflito,
  RegraNegocio,
  EstoqueInsuficiente,
  LimiteExcedido,
  Indisponivel
};
