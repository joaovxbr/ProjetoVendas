/*
 * testes/api.test.js
 * -----------------------------------------------------------------------------
 * Suite de testes da API. Sobe a aplicacao real sobre um banco SQLite em
 * memoria (nada e escrito em disco) e exercita os fluxos completos:
 * catalogo, contas, checkout, cupons, licencas, avaliacoes, favoritos e
 * administracao.
 *
 *   npm test
 */
'use strict';

// Precisa vir ANTES de qualquer require do projeto: a config le o ambiente
// uma unica vez, no momento em que e carregada.
process.env.NODE_ENV = 'test';
process.env.BANCO_ARQUIVO = ':memory:';
process.env.SEGREDO_APP = 'segredo-de-teste';
process.env.LOG_NIVEL = 'silent';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { criarApp } = require('../src/app');
const { conectar, fechar } = require('../src/db/conexao');
const { semear, estoqueNuncaInicializado, garantirEstoqueInicial } = require('../src/db/semear');
const estoqueRepo = require('../src/repositories/estoque.repo');

let servidor;
let base;

/* -------------------------------------------------------------------------- */
/* Infraestrutura de teste                                                    */
/* -------------------------------------------------------------------------- */

before(async () => {
  conectar();
  semear({ silencioso: true });

  servidor = criarApp().listen(0);
  await once(servidor, 'listening');
  base = `http://127.0.0.1:${servidor.address().port}`;
});

after(() => {
  if (servidor) servidor.close();
  fechar();
});

/**
 * Cria um "navegador": guarda o cookie de sessao entre as chamadas.
 * @param {object} [cabecalhosFixos] cabecalhos extras em toda requisicao
 * @returns {(metodo: string, caminho: string, corpo?: object, extras?: object) => Promise<{status:number, corpo:any, headers:Headers}>}
 */
function criarCliente(cabecalhosFixos) {
  let cookie = '';

  return async function requisitar(metodo, caminho, corpo, extras) {
    const opcoes = { method: metodo, headers: { Accept: 'application/json' } };

    if (cookie) opcoes.headers.Cookie = cookie;
    if (corpo !== undefined) {
      opcoes.headers['Content-Type'] = 'application/json';
      opcoes.body = JSON.stringify(corpo);
    }
    Object.assign(opcoes.headers, cabecalhosFixos, extras);

    const resposta = await fetch(base + caminho, opcoes);

    // Guarda o cookie da sessao, como faria um navegador.
    const recebidos = typeof resposta.headers.getSetCookie === 'function'
      ? resposta.headers.getSetCookie()
      : [];
    for (const linha of recebidos) {
      if (linha.startsWith('sid=')) cookie = linha.split(';')[0];
    }

    const texto = await resposta.text();
    let dados = null;
    if (texto) {
      try {
        dados = JSON.parse(texto);
      } catch {
        dados = texto;
      }
    }

    return { status: resposta.status, corpo: dados, headers: resposta.headers };
  };
}

/** Cliente ja autenticado como o cliente de demonstracao. */
async function clienteDemo() {
  const requisitar = criarCliente();
  const resposta = await requisitar('POST', '/api/auth/login', {
    email: 'demo@loja.com',
    senha: 'demo123'
  });
  assert.equal(resposta.status, 200, 'login do cliente demo deveria funcionar');
  return requisitar;
}

/** Cliente ja autenticado como administrador. */
async function clienteAdmin() {
  const requisitar = criarCliente();
  const resposta = await requisitar('POST', '/api/auth/login', {
    email: 'admin@loja.com',
    senha: 'admin123'
  });
  assert.equal(resposta.status, 200, 'login do admin deveria funcionar');
  return requisitar;
}

/** Pega o primeiro produto do catalogo (id + primeiro plano). */
async function primeiroProduto(requisitar) {
  const resposta = await requisitar('GET', '/api/produtos');
  assert.equal(resposta.status, 200);
  const produto = resposta.corpo[0];
  return { produto, plano: produto.planos[0] };
}

/* -------------------------------------------------------------------------- */
/* Diagnostico                                                                */
/* -------------------------------------------------------------------------- */

test('GET /api/status responde com os dados da loja', async () => {
  const requisitar = criarCliente();
  const { status, corpo } = await requisitar('GET', '/api/status');

  assert.equal(status, 200);
  assert.equal(corpo.status, 'ok');
  assert.equal(corpo.loja, 'NEXUS.GG');
  assert.ok(corpo.hora, 'deveria trazer a hora formatada');
});

test('GET /api/saude confirma que o banco responde', async () => {
  const requisitar = criarCliente();
  const { status, corpo } = await requisitar('GET', '/api/saude');

  assert.equal(status, 200);
  assert.equal(corpo.status, 'ok');
  assert.equal(corpo.banco, 'ok');
});

test('rota de API inexistente responde 404 em JSON', async () => {
  const requisitar = criarCliente();
  const { status, corpo } = await requisitar('GET', '/api/nao-existe');

  assert.equal(status, 404);
  assert.ok(corpo.erro);
  assert.equal(corpo.codigo, 'rota_inexistente');
});

/* -------------------------------------------------------------------------- */
/* Catalogo                                                                   */
/* -------------------------------------------------------------------------- */

test('GET /api/produtos devolve um array no formato que o front espera', async () => {
  const requisitar = criarCliente();
  const { status, corpo } = await requisitar('GET', '/api/produtos');

  assert.equal(status, 200);
  assert.ok(Array.isArray(corpo), 'o corpo precisa ser um array');
  assert.equal(corpo.length, 10);

  const produto = corpo[0];
  for (const campo of ['id', 'slug', 'nome', 'categoria', 'recursos', 'capa', 'planos', 'precoMin', 'precoMax', 'avaliacao', 'avaliacoes', 'plataforma', 'entrega']) {
    assert.ok(campo in produto, `produto deveria ter o campo "${campo}"`);
  }

  // Precos em reais (nao em centavos) e planos com "preco".
  assert.equal(typeof produto.precoMin, 'number');
  assert.ok(produto.precoMin > 0 && produto.precoMin < 1000, 'preco deveria estar em reais');
  assert.ok(Array.isArray(produto.planos));
  assert.ok('preco' in produto.planos[0]);
});

test('GET /api/produtos/categorias soma o total de produtos ativos', async () => {
  const requisitar = criarCliente();
  const { status, corpo } = await requisitar('GET', '/api/produtos/categorias');

  assert.equal(status, 200);
  assert.ok(Array.isArray(corpo));

  const soma = corpo.reduce((total, categoria) => total + categoria.total, 0);
  assert.equal(soma, 10);
  assert.ok(corpo.every(categoria => categoria.nome && categoria.total > 0));
});

test('filtro por categoria ignora acentos e maiusculas', async () => {
  const requisitar = criarCliente();

  // "Otimização" e o valor exibido; "otimizacao" tem que achar o mesmo.
  const comAcento = await requisitar('GET', '/api/produtos?categoria=' + encodeURIComponent('Otimização'));
  const semAcento = await requisitar('GET', '/api/produtos?categoria=otimizacao');

  assert.equal(comAcento.status, 200);
  assert.equal(semAcento.status, 200);
  assert.equal(comAcento.corpo.length, 4);
  assert.equal(semAcento.corpo.length, 4);
  assert.ok(comAcento.corpo.every(produto => produto.categoria === 'Otimização'));
});

test('filtro de destaque e ordenacao por preco funcionam', async () => {
  const requisitar = criarCliente();

  const destaques = await requisitar('GET', '/api/produtos?destaque=true');
  assert.equal(destaques.status, 200);
  assert.equal(destaques.corpo.length, 3);
  assert.ok(destaques.corpo.every(produto => produto.destaque === true));

  const porPreco = await requisitar('GET', '/api/produtos?ordem=menor-preco');
  const precos = porPreco.corpo.map(produto => produto.precoMin);
  const ordenados = [...precos].sort((a, b) => a - b);
  assert.deepEqual(precos, ordenados, 'os produtos deveriam vir do mais barato para o mais caro');
});

test('busca por termo encontra produtos pelo nome', async () => {
  const requisitar = criarCliente();
  const { status, corpo } = await requisitar('GET', '/api/produtos?busca=macro');

  assert.equal(status, 200);
  assert.equal(corpo.length, 2);
  assert.ok(corpo.every(produto => /macro/i.test(produto.nome)));
});

test('GET /api/produtos/:id aceita tanto o id quanto o slug', async () => {
  const requisitar = criarCliente();
  const lista = await requisitar('GET', '/api/produtos');
  const produto = lista.corpo[0];

  const porId = await requisitar('GET', `/api/produtos/${produto.id}`);
  const porSlug = await requisitar('GET', `/api/produtos/${produto.slug}`);

  assert.equal(porId.status, 200);
  assert.equal(porSlug.status, 200);
  assert.equal(porId.corpo.id, porSlug.corpo.id);
});

test('produto inexistente responde 404 com mensagem amigavel', async () => {
  const requisitar = criarCliente();
  const { status, corpo } = await requisitar('GET', '/api/produtos/nao-existe-mesmo');

  assert.equal(status, 404);
  assert.equal(typeof corpo.erro, 'string');
});

/* -------------------------------------------------------------------------- */
/* Autenticacao                                                               */
/* -------------------------------------------------------------------------- */

test('login com credenciais invalidas responde 401 sem revelar qual campo errou', async () => {
  const requisitar = criarCliente();

  const senhaErrada = await requisitar('POST', '/api/auth/login', { email: 'demo@loja.com', senha: 'errada' });
  const emailInexistente = await requisitar('POST', '/api/auth/login', { email: 'ninguem@loja.com', senha: 'qualquer' });

  assert.equal(senhaErrada.status, 401);
  assert.equal(emailInexistente.status, 401);
  assert.equal(senhaErrada.corpo.erro, emailInexistente.corpo.erro, 'as mensagens devem ser identicas');
});

test('GET /api/auth/me exige sessao', async () => {
  const requisitar = criarCliente();
  const { status, corpo } = await requisitar('GET', '/api/auth/me');

  assert.equal(status, 401);
  assert.ok(corpo.erro);
});

test('cadastro cria conta, abre sessao e nunca devolve a senha', async () => {
  const requisitar = criarCliente();
  const email = `teste${Date.now()}@exemplo.com`;

  const registro = await requisitar('POST', '/api/auth/registrar', {
    nome: 'Cliente de Teste',
    email,
    senha: 'senhaSegura123'
  });

  assert.equal(registro.status, 201);
  assert.equal(registro.corpo.usuario.email, email);
  assert.equal(registro.corpo.usuario.nome, 'Cliente de Teste');
  assert.equal(registro.corpo.usuario.papel, 'cliente');

  // Nada de hash, salt ou senha no corpo.
  const serializado = JSON.stringify(registro.corpo);
  assert.ok(!serializado.includes('senhaSegura123'), 'a senha nao pode voltar na resposta');
  assert.ok(!serializado.includes('senhaHash'), 'o hash nao pode voltar na resposta');
  assert.ok(!serializado.includes('senhaSalt'), 'o salt nao pode voltar na resposta');

  const eu = await requisitar('GET', '/api/auth/me');
  assert.equal(eu.status, 200);
  assert.equal(eu.corpo.usuario.email, email);
});

test('nao permite cadastrar o mesmo e-mail duas vezes', async () => {
  const requisitar = criarCliente();
  const email = `duplicado${Date.now()}@exemplo.com`;

  const primeiro = await requisitar('POST', '/api/auth/registrar', { nome: 'Primeiro', email, senha: 'senha12345' });
  const segundo = await requisitar('POST', '/api/auth/registrar', { nome: 'Segundo', email, senha: 'senha12345' });

  assert.equal(primeiro.status, 201);
  assert.equal(segundo.status, 409);
});

test('cadastro valida nome, e-mail e senha', async () => {
  const requisitar = criarCliente();

  const semNome = await requisitar('POST', '/api/auth/registrar', { nome: 'A', email: 'a@b.com', senha: 'senha12345' });
  const emailRuim = await requisitar('POST', '/api/auth/registrar', { nome: 'Fulano', email: 'nao-e-email', senha: 'senha12345' });
  const senhaCurta = await requisitar('POST', '/api/auth/registrar', { nome: 'Fulano', email: 'fulano@exemplo.com', senha: '123' });

  assert.equal(semNome.status, 400);
  assert.equal(emailRuim.status, 400);
  assert.equal(senhaCurta.status, 400);
});

test('logout encerra a sessao', async () => {
  const requisitar = await clienteDemo();

  const antes = await requisitar('GET', '/api/auth/me');
  assert.equal(antes.status, 200);

  const saida = await requisitar('POST', '/api/auth/logout');
  assert.equal(saida.status, 204);

  const depois = await requisitar('GET', '/api/auth/me');
  assert.equal(depois.status, 401);
});

test('troca de senha exige a senha atual e invalida as outras sessoes', async () => {
  const requisitar = criarCliente();
  const email = `troca${Date.now()}@exemplo.com`;

  await requisitar('POST', '/api/auth/registrar', { nome: 'Troca Senha', email, senha: 'senhaAntiga1' });

  const errada = await requisitar('PATCH', '/api/auth/senha', { senhaAtual: 'errada', novaSenha: 'senhaNova123' });
  assert.equal(errada.status, 400);

  const certa = await requisitar('PATCH', '/api/auth/senha', { senhaAtual: 'senhaAntiga1', novaSenha: 'senhaNova123' });
  assert.equal(certa.status, 200);

  // A senha antiga nao serve mais; a nova sim.
  const clienteNovo = criarCliente();
  const antiga = await clienteNovo('POST', '/api/auth/login', { email, senha: 'senhaAntiga1' });
  const nova = await clienteNovo('POST', '/api/auth/login', { email, senha: 'senhaNova123' });

  assert.equal(antiga.status, 401);
  assert.equal(nova.status, 200);
});

test('recuperacao de senha devolve mensagem neutra e permite redefinir', async () => {
  const requisitar = criarCliente();
  const email = `recupera${Date.now()}@exemplo.com`;

  await requisitar('POST', '/api/auth/registrar', { nome: 'Recupera', email, senha: 'senhaOriginal1' });
  await requisitar('POST', '/api/auth/logout');

  const inexistente = await requisitar('POST', '/api/auth/recuperar-senha', { email: 'ninguem@exemplo.com' });
  assert.equal(inexistente.status, 200);
  assert.ok(inexistente.corpo.mensagem);

  const pedido = await requisitar('POST', '/api/auth/recuperar-senha', { email });
  assert.equal(pedido.status, 200);
  // Fora de producao o token vem no corpo para o fluxo ser testavel.
  assert.ok(pedido.corpo.token, 'em desenvolvimento o token e devolvido');

  const redefinir = await requisitar('POST', '/api/auth/redefinir-senha', {
    token: pedido.corpo.token,
    senha: 'senhaRedefinida1'
  });
  assert.equal(redefinir.status, 200);

  const login = await requisitar('POST', '/api/auth/login', { email, senha: 'senhaRedefinida1' });
  assert.equal(login.status, 200);

  // Token de uso unico: nao pode ser reaproveitado.
  const reutilizar = await requisitar('POST', '/api/auth/redefinir-senha', {
    token: pedido.corpo.token,
    senha: 'outraSenha123'
  });
  assert.equal(reutilizar.status, 422);
});

/* -------------------------------------------------------------------------- */
/* Checkout                                                                   */
/* -------------------------------------------------------------------------- */

test('checkout exige login', async () => {
  const requisitar = criarCliente();
  const { produto, plano } = await primeiroProduto(requisitar);

  const { status, corpo } = await requisitar('POST', '/api/vendas', {
    itens: [{ produtoId: produto.id, planoId: plano.id, quantidade: 1 }]
  });

  assert.equal(status, 401);
  assert.ok(corpo.erro);
});

test('checkout entrega as chaves no formato que o carrinho espera', async () => {
  const requisitar = await clienteDemo();
  const { produto, plano } = await primeiroProduto(requisitar);

  const { status, corpo } = await requisitar('POST', '/api/vendas', {
    itens: [{ produtoId: produto.id, planoId: plano.id, quantidade: 2 }]
  });

  assert.equal(status, 201);
  assert.ok(corpo.id, 'deveria trazer o id do pedido');
  assert.equal(typeof corpo.total, 'number');
  assert.equal(corpo.status, 'pago');

  const item = corpo.itens[0];
  assert.equal(item.nome, produto.nome);
  assert.equal(item.plano, plano.nome);
  assert.equal(item.quantidade, 2);
  assert.equal(item.chaves.length, 2, 'uma chave por unidade comprada');

  // Formato da chave: ABCD-1234-EF56-7890
  for (const chave of item.chaves) {
    assert.match(chave, /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/);
  }

  // O total tem que ser o preco do plano x quantidade, calculado no servidor.
  const esperado = Math.round(plano.preco * 2 * 100) / 100;
  assert.equal(corpo.total, esperado);
});

test('o servidor ignora precos enviados pelo cliente', async () => {
  const requisitar = await clienteDemo();
  const { produto, plano } = await primeiroProduto(requisitar);

  const { status, corpo } = await requisitar('POST', '/api/vendas', {
    itens: [{ produtoId: produto.id, planoId: plano.id, quantidade: 1, preco: 0.01, subtotal: 0.01 }]
  });

  assert.equal(status, 201);
  assert.equal(corpo.total, plano.preco, 'o preco tem que vir do catalogo, nao do cliente');
});

test('checkout rejeita carrinho vazio, produto inexistente e plano invalido', async () => {
  const requisitar = await clienteDemo();
  const { produto } = await primeiroProduto(requisitar);

  const vazio = await requisitar('POST', '/api/vendas', { itens: [] });
  const produtoRuim = await requisitar('POST', '/api/vendas', {
    itens: [{ produtoId: '00000000-0000-4000-8000-000000000000', planoId: '1d', quantidade: 1 }]
  });
  const planoRuim = await requisitar('POST', '/api/vendas', {
    itens: [{ produtoId: produto.id, planoId: 'plano-que-nao-existe', quantidade: 1 }]
  });

  assert.equal(vazio.status, 400);
  assert.equal(produtoRuim.status, 404);
  assert.equal(planoRuim.status, 400);
});

test('checkout rejeita quantidade fora do limite', async () => {
  const requisitar = await clienteDemo();
  const { produto, plano } = await primeiroProduto(requisitar);

  const zero = await requisitar('POST', '/api/vendas', {
    itens: [{ produtoId: produto.id, planoId: plano.id, quantidade: 0 }]
  });
  const exagerada = await requisitar('POST', '/api/vendas', {
    itens: [{ produtoId: produto.id, planoId: plano.id, quantidade: 999 }]
  });

  assert.equal(zero.status, 400);
  assert.equal(exagerada.status, 400);
});

test('GET /api/vendas lista os pedidos do usuario', async () => {
  const requisitar = await clienteDemo();
  const { status, corpo } = await requisitar('GET', '/api/vendas');

  assert.equal(status, 200);
  assert.equal(typeof corpo.quantidade, 'number');
  assert.equal(typeof corpo.total, 'number');
  assert.ok(Array.isArray(corpo.vendas));
  assert.ok(corpo.vendas.length >= 1);
});

test('um pedido so e visivel para o dono', async () => {
  const dono = await clienteDemo();
  const { produto, plano } = await primeiroProduto(dono);

  const pedido = await dono('POST', '/api/vendas', {
    itens: [{ produtoId: produto.id, planoId: plano.id, quantidade: 1 }]
  });
  assert.equal(pedido.status, 201);

  const outro = criarCliente();
  await outro('POST', '/api/auth/registrar', {
    nome: 'Intruso',
    email: `intruso${Date.now()}@exemplo.com`,
    senha: 'senhaIntruso1'
  });

  const tentativa = await outro('GET', `/api/vendas/${pedido.corpo.id}`);
  assert.equal(tentativa.status, 404, 'nao deve confirmar que o pedido existe');
});

/* -------------------------------------------------------------------------- */
/* Cupons                                                                     */
/* -------------------------------------------------------------------------- */

test('cupom percentual reduz o total', async () => {
  const requisitar = await clienteDemo();
  const { produto, plano } = await primeiroProduto(requisitar);

  const semCupom = await requisitar('POST', '/api/vendas', {
    itens: [{ produtoId: produto.id, planoId: plano.id, quantidade: 1 }]
  });
  const comCupom = await requisitar('POST', '/api/vendas', {
    itens: [{ produtoId: produto.id, planoId: plano.id, quantidade: 1 }],
    cupom: 'BEMVINDO10'
  });

  assert.equal(comCupom.status, 201);
  assert.equal(comCupom.corpo.cupom, 'BEMVINDO10');

  // Desconto percentual e arredondado PARA BAIXO: nunca concede mais desconto
  // do que o percentual exato. 10% de R$ 9,99 = 99,9 centavos -> 99 centavos.
  const subtotalCentavos = Math.round(semCupom.corpo.total * 100);
  const descontoEsperado = Math.floor(subtotalCentavos * 0.1) / 100;

  assert.equal(comCupom.corpo.desconto, descontoEsperado);
  assert.equal(comCupom.corpo.total, Math.round((semCupom.corpo.total - comCupom.corpo.desconto) * 100) / 100);
});

test('cupom com valor minimo e recusado abaixo do minimo', async () => {
  const requisitar = await clienteDemo();
  const { produto, plano } = await primeiroProduto(requisitar);

  // GAMER20 exige pedido acima de R$ 100; o primeiro produto custa menos.
  const { status, corpo } = await requisitar('POST', '/api/vendas', {
    itens: [{ produtoId: produto.id, planoId: plano.id, quantidade: 1 }],
    cupom: 'GAMER20'
  });

  assert.equal(status, 422);
  assert.ok(corpo.erro);
});

test('cupom inexistente responde 404', async () => {
  const requisitar = await clienteDemo();
  const { produto, plano } = await primeiroProduto(requisitar);

  const { status } = await requisitar('POST', '/api/vendas', {
    itens: [{ produtoId: produto.id, planoId: plano.id, quantidade: 1 }],
    cupom: 'NAOEXISTE'
  });

  assert.equal(status, 404);
});

test('POST /api/cupons/validar calcula o desconto sem criar pedido', async () => {
  const requisitar = await clienteDemo();
  const { produto, plano } = await primeiroProduto(requisitar);

  const { status, corpo } = await requisitar('POST', '/api/cupons/validar', {
    codigo: 'BEMVINDO10',
    itens: [{ produtoId: produto.id, planoId: plano.id, quantidade: 1 }]
  });

  assert.equal(status, 200);
  assert.equal(corpo.valido, true);
  assert.ok(corpo.desconto > 0);
  assert.equal(corpo.total, Math.round((corpo.subtotal - corpo.desconto) * 100) / 100);
});

/* -------------------------------------------------------------------------- */
/* Licencas                                                                   */
/* -------------------------------------------------------------------------- */

test('licencas listam as chaves compradas e podem ser resgatadas', async () => {
  const requisitar = await clienteDemo();
  const { produto, plano } = await primeiroProduto(requisitar);

  const pedido = await requisitar('POST', '/api/vendas', {
    itens: [{ produtoId: produto.id, planoId: plano.id, quantidade: 1 }]
  });
  const chave = pedido.corpo.chaves[0];

  const lista = await requisitar('GET', '/api/licencas');
  assert.equal(lista.status, 200);
  assert.ok(lista.corpo.chaves.some(item => item.chave === chave));
  assert.equal(lista.corpo.chaves.find(item => item.chave === chave).status, 'ativa');

  const resgate = await requisitar('POST', '/api/licencas/resgatar', { chave });
  assert.equal(resgate.status, 200);
  assert.equal(resgate.corpo.licenca.status, 'resgatada');

  // Plano de 1 dia: ao ativar, ganha data de expiracao.
  if (plano.dias) {
    assert.ok(resgate.corpo.licenca.expiraEm, 'licenca de plano temporario deveria ter validade');
  }

  // Nao pode ativar a mesma chave duas vezes.
  const denovo = await requisitar('POST', '/api/licencas/resgatar', { chave });
  assert.equal(denovo.status, 422);
});

test('chave de outro usuario nao pode ser resgatada', async () => {
  const dono = await clienteDemo();
  const { produto, plano } = await primeiroProduto(dono);

  const pedido = await dono('POST', '/api/vendas', {
    itens: [{ produtoId: produto.id, planoId: plano.id, quantidade: 1 }]
  });

  const outro = criarCliente();
  await outro('POST', '/api/auth/registrar', {
    nome: 'Outro Cliente',
    email: `outro${Date.now()}@exemplo.com`,
    senha: 'senhaOutro123'
  });

  const { status } = await outro('POST', '/api/licencas/resgatar', { chave: pedido.corpo.chaves[0] });
  assert.equal(status, 403);
});

test('chave em formato invalido e rejeitada', async () => {
  const requisitar = await clienteDemo();
  const { status } = await requisitar('POST', '/api/licencas/resgatar', { chave: 'chave-invalida' });
  assert.equal(status, 400);
});

/* -------------------------------------------------------------------------- */
/* Favoritos                                                                  */
/* -------------------------------------------------------------------------- */

test('favoritos alternam e listam produtos', async () => {
  const requisitar = await clienteDemo();
  const { produto } = await primeiroProduto(requisitar);

  const adicionar = await requisitar('POST', `/api/favoritos/${produto.id}/alternar`);
  assert.equal(adicionar.status, 200);

  const lista = await requisitar('GET', '/api/favoritos');
  assert.equal(lista.status, 200);
  assert.ok(lista.corpo.produtos.some(item => item.id === produto.id));

  const remover = await requisitar('POST', `/api/favoritos/${produto.id}/alternar`);
  assert.equal(remover.corpo.favoritado, false);
});

/* -------------------------------------------------------------------------- */
/* Avaliacoes                                                                 */
/* -------------------------------------------------------------------------- */

test('so quem comprou pode avaliar', async () => {
  const requisitar = criarCliente();
  await requisitar('POST', '/api/auth/registrar', {
    nome: 'Sem Compra',
    email: `semcompra${Date.now()}@exemplo.com`,
    senha: 'senhaSemCompra1'
  });

  const { produto } = await primeiroProduto(requisitar);

  const semComprar = await requisitar('POST', '/api/avaliacoes', {
    produtoId: produto.id,
    nota: 5,
    comentario: 'Avaliacao sem ter comprado'
  });
  assert.equal(semComprar.status, 403);

  // Compra o produto e tenta de novo.
  const plano = produto.planos[0];
  await requisitar('POST', '/api/vendas', {
    itens: [{ produtoId: produto.id, planoId: plano.id, quantidade: 1 }]
  });

  const comCompra = await requisitar('POST', '/api/avaliacoes', {
    produtoId: produto.id,
    nota: 5,
    comentario: 'Produto excelente, recomendo.'
  });
  assert.equal(comCompra.status, 201);
  assert.equal(comCompra.corpo.avaliacao.nota, 5);

  // A segunda avaliacao do mesmo produto atualiza, nao duplica.
  const atualizada = await requisitar('POST', '/api/avaliacoes', {
    produtoId: produto.id,
    nota: 4,
    comentario: 'Ajustando minha nota.'
  });
  assert.equal(atualizada.status, 201);
  assert.equal(atualizada.corpo.avaliacao.nota, 4);
});

test('avaliacao valida a nota e o tamanho do comentario', async () => {
  const requisitar = await clienteDemo();
  const { produto } = await primeiroProduto(requisitar);

  const notaZero = await requisitar('POST', '/api/avaliacoes', { produtoId: produto.id, nota: 0 });
  const notaSeis = await requisitar('POST', '/api/avaliacoes', { produtoId: produto.id, nota: 6 });
  const comentarioGigante = await requisitar('POST', '/api/avaliacoes', {
    produtoId: produto.id,
    nota: 5,
    comentario: 'a'.repeat(5000)
  });

  assert.equal(notaZero.status, 400);
  assert.equal(notaSeis.status, 400);
  assert.equal(comentarioGigante.status, 400);
});

test('GET /api/avaliacoes/produto/:id e publico', async () => {
  const requisitar = criarCliente();
  const { produto } = await primeiroProduto(requisitar);

  const { status, corpo } = await requisitar('GET', `/api/avaliacoes/produto/${produto.id}`);
  assert.equal(status, 200);
  assert.equal(typeof corpo.media, 'number');
  assert.ok(Array.isArray(corpo.itens));
});

/* -------------------------------------------------------------------------- */
/* Conta                                                                      */
/* -------------------------------------------------------------------------- */

test('GET /api/conta resume pedidos, chaves e gasto', async () => {
  const requisitar = await clienteDemo();
  const { status, corpo } = await requisitar('GET', '/api/conta');

  assert.equal(status, 200);
  assert.ok(corpo.usuario);
  assert.ok(corpo.estatisticas);
  assert.equal(typeof corpo.estatisticas.pedidos, 'number');
  assert.equal(typeof corpo.estatisticas.gasto, 'number');
  assert.ok(Array.isArray(corpo.pedidosRecentes));
});

test('PATCH /api/conta atualiza o nome', async () => {
  const requisitar = criarCliente();
  await requisitar('POST', '/api/auth/registrar', {
    nome: 'Nome Antigo',
    email: `perfil${Date.now()}@exemplo.com`,
    senha: 'senhaPerfil123'
  });

  const { status, corpo } = await requisitar('PATCH', '/api/conta', { nome: 'Nome Novo' });
  assert.equal(status, 200);
  assert.equal(corpo.usuario.nome, 'Nome Novo');
});

/* -------------------------------------------------------------------------- */
/* Administracao                                                              */
/* -------------------------------------------------------------------------- */

test('cliente comum nao acessa o painel administrativo', async () => {
  const requisitar = await clienteDemo();
  const { status, corpo } = await requisitar('GET', '/api/admin/painel');

  assert.equal(status, 403);
  assert.ok(corpo.erro);
});

test('admin acessa o painel com os numeros da loja', async () => {
  const requisitar = await clienteAdmin();
  const { status, corpo } = await requisitar('GET', '/api/admin/painel');

  assert.equal(status, 200);
  assert.ok(corpo.financeiro);
  assert.equal(typeof corpo.financeiro.receita, 'number');
  assert.ok(corpo.catalogo.produtos >= 10);
  assert.ok(Array.isArray(corpo.receitaPorDia));
  assert.ok(Array.isArray(corpo.topProdutos));
});

test('admin lista pedidos e usuarios', async () => {
  const requisitar = await clienteAdmin();

  const pedidos = await requisitar('GET', '/api/admin/pedidos');
  assert.equal(pedidos.status, 200);
  assert.ok(Array.isArray(pedidos.corpo.pedidos));
  assert.ok(pedidos.corpo.total >= 1);

  const usuarios = await requisitar('GET', '/api/admin/usuarios');
  assert.equal(usuarios.status, 200);
  assert.ok(usuarios.corpo.usuarios.length >= 4);
});

test('admin cria produto, edita e desativa', async () => {
  const requisitar = await clienteAdmin();
  const slug = `produto-teste-${Date.now()}`;

  const criado = await requisitar('POST', '/api/admin/produtos', {
    nome: 'Produto de Teste',
    slug,
    categoria: 'Testes',
    descricao: 'Criado pela suite de testes.',
    descricaoLonga: 'Uma descrição bem mais completa, escrita para o modal de detalhes do produto.',
    recursos: ['Recurso A', 'Recurso B'],
    capa: { icone: 'escudo' },
    planos: [
      { id: '7d', nome: '7 dias', preco: 19.9, dias: 7 },
      { id: 'vitalicio', nome: 'Vitalício', preco: 99.9, dias: null }
    ]
  });

  assert.equal(criado.status, 201);
  assert.equal(criado.corpo.slug, slug);
  assert.equal(criado.corpo.planos.length, 2);
  assert.equal(criado.corpo.precoMin, 19.9);
  assert.match(criado.corpo.descricaoLonga, /modal de detalhes/);

  const editado = await requisitar('PATCH', `/api/admin/produtos/${criado.corpo.id}`, {
    nome: 'Produto de Teste Editado',
    planos: [{ id: '30d', nome: '30 dias', preco: 39.9, dias: 30 }]
  });

  assert.equal(editado.status, 200);
  assert.equal(editado.corpo.nome, 'Produto de Teste Editado');
  assert.equal(editado.corpo.planos.length, 1);

  const desativado = await requisitar('PATCH', `/api/admin/produtos/${criado.corpo.id}/ativo`, { ativo: false });
  assert.equal(desativado.status, 200);

  // Produto inativo sai da vitrine.
  const vitrine = await criarCliente()('GET', '/api/produtos');
  assert.ok(!vitrine.corpo.some(produto => produto.id === criado.corpo.id));
});

test('admin cria cupom e ele funciona no checkout', async () => {
  const admin = await clienteAdmin();
  const codigo = `TESTE${Date.now().toString().slice(-6)}`;

  const criado = await admin('POST', '/api/admin/cupons', {
    codigo,
    tipo: 'percentual',
    valor: 50,
    descricao: 'Cupom de teste'
  });

  assert.equal(criado.status, 201);
  assert.equal(criado.corpo.codigo, codigo);

  const cliente = await clienteDemo();
  const { produto, plano } = await primeiroProduto(cliente);

  const pedido = await cliente('POST', '/api/vendas', {
    itens: [{ produtoId: produto.id, planoId: plano.id, quantidade: 1 }],
    cupom: codigo
  });

  assert.equal(pedido.status, 201);
  // 50% de R$ 9,99 = 499,5 centavos -> 499 centavos (arredondamento para baixo).
  assert.equal(pedido.corpo.desconto, Math.floor(Math.round(plano.preco * 100) * 0.5) / 100);
});

test('admin confirma pagamento de pedido pendente (boleto) e libera as chaves', async () => {
  const cliente = await clienteDemo();
  const { produto, plano } = await primeiroProduto(cliente);

  // Boleto fica pendente: sem chaves ainda.
  const pedido = await cliente('POST', '/api/vendas', {
    itens: [{ produtoId: produto.id, planoId: plano.id, quantidade: 1 }],
    metodoPagamento: 'boleto'
  });

  assert.equal(pedido.status, 201);
  assert.equal(pedido.corpo.status, 'pendente');
  assert.equal(pedido.corpo.chaves.length, 0, 'boleto nao entrega chave antes da confirmacao');
  assert.ok(pedido.corpo.instrucoesPagamento);

  const admin = await clienteAdmin();
  const confirmacao = await admin('POST', `/api/vendas/${pedido.corpo.id}/confirmar-pagamento`);

  assert.equal(confirmacao.status, 200);
  assert.equal(confirmacao.corpo.pedido.status, 'pago');
  assert.equal(confirmacao.corpo.pedido.chaves.length, 1);
});

test('admin reembolsa pedido e as licencas sao revogadas', async () => {
  const cliente = await clienteDemo();
  const { produto, plano } = await primeiroProduto(cliente);

  const pedido = await cliente('POST', '/api/vendas', {
    itens: [{ produtoId: produto.id, planoId: plano.id, quantidade: 1 }]
  });
  assert.equal(pedido.status, 201);

  const admin = await clienteAdmin();
  const reembolso = await admin('PATCH', `/api/admin/pedidos/${pedido.corpo.id}/status`, {
    status: 'reembolsado',
    motivo: 'teste automatizado'
  });

  assert.equal(reembolso.status, 200);
  assert.equal(reembolso.corpo.pedido.status, 'reembolsado');

  const licencas = await admin('GET', '/api/admin/licencas');
  const revogadas = licencas.corpo.licencas.filter(
    licenca => licenca.vendaId === pedido.corpo.id && licenca.status === 'revogada'
  );
  assert.ok(revogadas.length >= 1, 'as licencas do pedido reembolsado devem estar revogadas');
});

test('admin nao pode rebaixar a si mesmo', async () => {
  const admin = await clienteAdmin();
  const eu = await admin('GET', '/api/auth/me');

  const { status } = await admin('PATCH', `/api/admin/usuarios/${eu.corpo.usuario.id}/papel`, { papel: 'cliente' });
  assert.equal(status, 422);
});

test('admin registra as acoes na auditoria', async () => {
  const requisitar = await clienteAdmin();
  const { status, corpo } = await requisitar('GET', '/api/admin/auditoria');

  assert.equal(status, 200);
  assert.ok(corpo.total > 0);
  assert.ok(Array.isArray(corpo.eventos));
  assert.ok(corpo.eventos.some(evento => evento.acao));
});

test('admin le e salva as configuracoes da loja', async () => {
  const requisitar = await clienteAdmin();

  const antes = await requisitar('GET', '/api/admin/configuracoes');
  assert.equal(antes.status, 200);
  assert.ok('aviso_topo' in antes.corpo.configuracoes);

  const salvou = await requisitar('PATCH', '/api/admin/configuracoes', { aviso_topo: 'Frete gratis hoje!' });
  assert.equal(salvou.status, 200);
  assert.equal(salvou.corpo.configuracoes.aviso_topo, 'Frete gratis hoje!');
});

test('modo manutencao salvo pelo painel vale na hora, sem esperar o cache', async () => {
  const admin = await clienteAdmin();
  const cliente = criarCliente();

  // Aquece o cache do middleware com a loja no ar.
  assert.equal((await cliente('GET', '/api/produtos')).status, 200);

  try {
    const ligou = await admin('PATCH', '/api/admin/configuracoes', {
      modo_manutencao: 'true',
      texto_manutencao: 'Volto ja'
    });
    assert.equal(ligou.status, 200);

    const bloqueado = await cliente('GET', '/api/produtos');
    assert.equal(bloqueado.status, 503);
    assert.equal(bloqueado.corpo.codigo, 'manutencao');
    assert.equal(bloqueado.corpo.erro, 'Volto ja');

    // O admin continua entrando para poder desligar.
    assert.equal((await admin('GET', '/api/admin/configuracoes')).status, 200);
  } finally {
    await admin('PATCH', '/api/admin/configuracoes', { modo_manutencao: 'false' });
  }

  assert.equal((await cliente('GET', '/api/produtos')).status, 200);
});

test('vitrine le os ajustes salvos pelo painel', async () => {
  const admin = await clienteAdmin();
  const cliente = criarCliente();

  const salvou = await admin('PATCH', '/api/admin/configuracoes', {
    aviso_topo: '  Frete   gratis todo o Brasil ',
    destaque_home: 'Promocao de 20%',
    suporte_email: 'Suporte@Nexus.gg',
    suporte_discord: 'https://discord.gg/nexus'
  });
  assert.equal(salvou.status, 200);

  const { status, corpo } = await cliente('GET', '/api/loja/ajustes');
  assert.equal(status, 200);
  assert.equal(corpo.avisoTopo, 'Frete gratis todo o Brasil');
  assert.equal(corpo.destaqueHome, 'Promocao de 20%');
  assert.deepEqual(corpo.suporte, { email: 'suporte@nexus.gg', discord: 'https://discord.gg/nexus' });
  assert.equal(corpo.manutencao.ativo, false);
  // Nada interno vaza pela rota publica.
  assert.deepEqual(Object.keys(corpo).sort(), ['avisoTopo', 'destaqueHome', 'manutencao', 'suporte']);
});

test('ajustes da vitrine continuam no ar durante a manutencao', async () => {
  const admin = await clienteAdmin();
  const cliente = criarCliente();

  try {
    await admin('PATCH', '/api/admin/configuracoes', { modo_manutencao: 'true', texto_manutencao: '' });

    const doCliente = await cliente('GET', '/api/loja/ajustes');
    assert.equal(doCliente.status, 200);
    assert.equal(doCliente.corpo.manutencao.ativo, true);
    assert.equal(doCliente.corpo.manutencao.liberado, false);
    assert.ok(doCliente.corpo.manutencao.texto, 'texto vazio cai no padrao');

    const doAdmin = await admin('GET', '/api/loja/ajustes');
    assert.equal(doAdmin.corpo.manutencao.liberado, true);
  } finally {
    await admin('PATCH', '/api/admin/configuracoes', { modo_manutencao: 'false' });
  }
});

test('painel recusa e-mail, link e tamanho invalidos campo a campo', async () => {
  const admin = await clienteAdmin();

  const invalido = await admin('PATCH', '/api/admin/configuracoes', {
    suporte_email: 'nao-e-email',
    suporte_discord: 'javascript:alert(1)',
    aviso_topo: 'x'.repeat(201)
  });
  assert.equal(invalido.status, 400);
  assert.equal(invalido.corpo.codigo, 'dados_invalidos');
  assert.deepEqual(Object.keys(invalido.corpo.detalhes).sort(), ['aviso_topo', 'suporte_discord', 'suporte_email']);

  // Nada foi salvo pela metade.
  const depois = await admin('GET', '/api/loja/ajustes');
  assert.notEqual(depois.corpo.suporte.discord, 'javascript:alert(1)');
  assert.ok(depois.corpo.avisoTopo.length <= 200);

  const vazio = await admin('PATCH', '/api/admin/configuracoes', { chave_desconhecida: 'x' });
  assert.equal(vazio.status, 400);
});

test('diagnostico so e acessivel para admin e mostra o schema', async () => {
  const cliente = await clienteDemo();
  const negado = await cliente('GET', '/api/admin/diagnostico');
  assert.equal(negado.status, 403);

  const admin = await clienteAdmin();
  const { status, corpo } = await admin('GET', '/api/admin/diagnostico');

  assert.equal(status, 200);
  assert.ok(corpo.banco.migracoes.length >= 2);
  assert.equal(corpo.banco.integridade, 'ok');
  assert.ok(corpo.contadores.produtos >= 10);
});

/* -------------------------------------------------------------------------- */
/* Robustez                                                                   */
/* -------------------------------------------------------------------------- */

test('JSON malformado responde 400 em vez de derrubar o servidor', async () => {
  const resposta = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ isso nao e json }'
  });

  assert.equal(resposta.status, 400);
  const corpo = await resposta.json();
  assert.ok(corpo.erro);
});

test('corpo grande demais responde 413', async () => {
  const requisitar = criarCliente();
  const { status } = await requisitar('POST', '/api/auth/login', {
    email: 'demo@loja.com',
    senha: 'x'.repeat(200000)
  });

  assert.equal(status, 413);
});

test('toda resposta traz o cabecalho X-Request-Id', async () => {
  const requisitar = criarCliente();
  const { headers } = await requisitar('GET', '/api/status');
  assert.ok(headers.get('x-request-id'), 'deveria devolver um id de requisicao');
});

test('cabecalhos de seguranca do helmet estao presentes', async () => {
  const requisitar = criarCliente();
  const { headers } = await requisitar('GET', '/api/status');

  assert.ok(headers.get('content-security-policy'), 'CSP ausente');
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('x-powered-by'), null, 'nao deveria anunciar o Express');
});

test('a pagina inicial continua sendo servida', async () => {
  const resposta = await fetch(base + '/');
  assert.equal(resposta.status, 200);
  const html = await resposta.text();
  assert.ok(html.includes('<!DOCTYPE html') || html.includes('<html'));
});

test('URL bonita /produtos serve a pagina do catalogo', async () => {
  const resposta = await fetch(base + '/produtos');
  assert.equal(resposta.status, 200);
  const html = await resposta.text();
  assert.ok(html.length > 0);
});

/* -------------------------------------------------------------------------- */
/* Painel administrativo                                                      */
/* -------------------------------------------------------------------------- */

test('URL bonita /admin serve o painel administrativo', async () => {
  const resposta = await fetch(base + '/admin');
  assert.equal(resposta.status, 200);

  const html = await resposta.text();
  assert.ok(html.includes('adm-sidebar'), 'deveria conter o layout do painel');
  assert.ok(html.includes('/js/admin.js'), 'deveria carregar o script do painel');
  assert.ok(html.includes('noindex'), 'o painel nao deveria ser indexado');
});

test('detalhe do produto no admin exige administrador', async () => {
  const anonimo = await criarCliente()('GET', '/api/admin/produtos/qualquer-id');
  assert.equal(anonimo.status, 401);

  const comum = await clienteDemo();
  const negado = await comum('GET', '/api/admin/produtos/qualquer-id');
  assert.equal(negado.status, 403);
});

test('admin busca o detalhe de um produto para edicao', async () => {
  const requisitar = await clienteAdmin();

  const lista = await requisitar('GET', '/api/admin/produtos');
  assert.equal(lista.status, 200);
  assert.ok(lista.headers.get('x-total-count'), 'deveria informar o total no cabecalho');
  assert.ok(lista.corpo.length >= 10);

  const alvo = lista.corpo[0];
  const detalhe = await requisitar('GET', `/api/admin/produtos/${alvo.id}`);

  assert.equal(detalhe.status, 200);
  assert.equal(detalhe.corpo.id, alvo.id);
  assert.equal(detalhe.corpo.slug, alvo.slug);
  assert.ok(Array.isArray(detalhe.corpo.planos));
  assert.equal(typeof detalhe.corpo.ativo, 'boolean');
});

test('detalhe de produto inexistente responde 404', async () => {
  const requisitar = await clienteAdmin();
  const { status, corpo } = await requisitar('GET', '/api/admin/produtos/00000000-0000-4000-8000-000000000000');

  assert.equal(status, 404);
  assert.ok(corpo.erro);
});

test('o detalhe publico do produto traz a descricao completa', async () => {
  const anonimo = criarCliente();
  const { produto } = await primeiroProduto(anonimo);

  const detalhe = await anonimo('GET', `/api/produtos/${produto.id}`);
  assert.equal(detalhe.status, 200);
  assert.equal(typeof detalhe.corpo.descricaoLonga, 'string');
  assert.ok(
    detalhe.corpo.descricaoLonga.length > detalhe.corpo.descricao.length,
    'a descricao completa do catalogo deveria ser maior que a curta'
  );
});

test('a auditoria identifica o autor de cada acao', async () => {
  const requisitar = await clienteAdmin();
  const { status, corpo } = await requisitar('GET', '/api/admin/auditoria?limite=20');

  assert.equal(status, 200);
  assert.ok(Array.isArray(corpo.eventos));

  const comAutor = corpo.eventos.filter((evento) => evento.atorId);
  assert.ok(comAutor.length > 0, 'deveria haver eventos com autor');
  assert.ok(comAutor[0].atorNome || comAutor[0].atorEmail, 'o evento deveria trazer o nome ou e-mail do autor');
});

/* -------------------------------------------------------------------------- */
/* Estoque                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Cria um produto isolado (fora do catalogo de exemplo) com um unico plano.
 * Usar um produto novo evita que os testes de estoque interfiram nos demais —
 * eles zeram e reabastecem o proprio estoque.
 */
async function produtoIsolado(admin, { quantidadeEstoque = 0 } = {}) {
  const sufixo = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const criado = await admin('POST', '/api/admin/produtos', {
    nome: `Produto Estoque ${sufixo}`,
    slug: `produto-estoque-${sufixo}`,
    categoria: 'Otimização',
    descricao: 'Produto criado pelos testes automatizados de estoque',
    planos: [{ id: 'padrao', nome: 'Padrão', preco: 19.9, dias: 30 }]
  });
  assert.equal(criado.status, 201, 'deveria criar o produto de teste');

  const produtoId = criado.corpo.id;
  const planoId = criado.corpo.planos[0].id;

  if (quantidadeEstoque > 0) {
    const entrada = await admin('POST', '/api/admin/estoque/gerar', { produtoId, planoId, quantidade: quantidadeEstoque });
    assert.equal(entrada.status, 201, 'deveria abastecer o estoque do produto de teste');
  }

  return { produtoId, planoId };
}

test('cliente comum nao acessa as rotas de estoque', async () => {
  const cliente = await clienteDemo();
  const { status } = await cliente('GET', '/api/admin/estoque');
  assert.equal(status, 403);
});

test('admin le o resumo do estoque com os alertas de reposicao', async () => {
  const admin = await clienteAdmin();
  const { status, corpo } = await admin('GET', '/api/admin/estoque');

  assert.equal(status, 200);
  assert.ok(Array.isArray(corpo.planos));
  assert.ok(corpo.planos.length >= 10, 'todo o catalogo deveria aparecer no resumo');
  assert.equal(typeof corpo.totais.disponivel, 'number');
  assert.ok(corpo.totais.disponivel > 0, 'a carga inicial deveria deixar chaves disponiveis');
  // A carga inicial deixa um plano esgotado e outro abaixo do minimo, para o
  // painel demonstrar os alertas sem precisar vender nada.
  assert.ok(corpo.resumoAlertas.esgotados >= 1, 'deveria haver um plano esgotado de demonstracao');
  assert.ok(corpo.alertas.length >= 1);
  assert.ok(corpo.alertas[0].alerta);
});

test('admin adiciona chaves ao estoque e o disponivel sobe', async () => {
  const admin = await clienteAdmin();
  const { produtoId, planoId } = await produtoIsolado(admin);

  const entrada = await admin('POST', '/api/admin/estoque/gerar', { produtoId, planoId, quantidade: 3 });
  assert.equal(entrada.status, 201);
  assert.equal(entrada.corpo.inseridas, 3);
  assert.equal(entrada.corpo.disponivel, 3);

  const chaves = await admin('GET', `/api/admin/estoque/chaves?produtoId=${produtoId}&planoId=${planoId}&status=disponivel`);
  assert.equal(chaves.status, 200);
  assert.equal(chaves.corpo.chaves.length, 3);
  assert.match(chaves.corpo.chaves[0].chave, /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/);
});

test('entrada de estoque aceita lista colada e ignora chaves repetidas', async () => {
  const admin = await clienteAdmin();
  const { produtoId, planoId } = await produtoIsolado(admin);

  const repetida = 'AAAA-1111-BBBB-2222';
  const entrada = await admin('POST', '/api/admin/estoque/gerar', {
    produtoId,
    planoId,
    chaves: `${repetida}\n${repetida}\nCCCC-3333-DDDD-4444`,
    lote: 'lote-de-teste'
  });

  assert.equal(entrada.status, 201);
  assert.equal(entrada.corpo.inseridas, 2, 'a chave repetida dentro do lote nao entra duas vezes');
  assert.equal(entrada.corpo.disponivel, 2);

  // Reenviar a mesma chave: o UNIQUE do banco impede a duplicacao.
  const denovo = await admin('POST', '/api/admin/estoque/gerar', {
    produtoId,
    planoId,
    chaves: [repetida, 'EEEE-5555-FFFF-6666']
  });
  assert.equal(denovo.corpo.inseridas, 1);
  assert.equal(denovo.corpo.duplicadas, 1);
});

test('entrada de estoque rejeita chave fora do formato', async () => {
  const admin = await clienteAdmin();
  const { produtoId, planoId } = await produtoIsolado(admin);

  const { status, corpo } = await admin('POST', '/api/admin/estoque/gerar', {
    produtoId,
    planoId,
    chaves: ['chave-invalida']
  });

  assert.equal(status, 400);
  assert.ok(corpo.erro);
});

test('admin define o ponto de reposicao e o alerta acende', async () => {
  const admin = await clienteAdmin();
  const { produtoId, planoId } = await produtoIsolado(admin, { quantidadeEstoque: 3 });

  const apertado = await admin('PATCH', '/api/admin/estoque/minimo', { produtoId, planoId, minimo: 10 });
  assert.equal(apertado.status, 200);
  assert.equal(apertado.corpo.estoqueMinimo, 10);
  assert.equal(apertado.corpo.alerta, true, '3 disponiveis com minimo 10 deveria acender o alerta');

  const folgado = await admin('PATCH', '/api/admin/estoque/minimo', { produtoId, planoId, minimo: 1 });
  assert.equal(folgado.corpo.alerta, false);
});

test('admin atualiza a quantidade disponivel com um ajuste', async () => {
  const admin = await clienteAdmin();
  const { produtoId, planoId } = await produtoIsolado(admin, { quantidadeEstoque: 2 });

  const aumentou = await admin('POST', '/api/admin/estoque/ajustar', { produtoId, planoId, alvo: 7 });
  assert.equal(aumentou.status, 200);
  assert.equal(aumentou.corpo.direcao, 'entrada');
  assert.equal(aumentou.corpo.disponivel, 7);

  const reduziu = await admin('POST', '/api/admin/estoque/ajustar', { produtoId, planoId, alvo: 4 });
  assert.equal(reduziu.corpo.direcao, 'descarte');
  assert.equal(reduziu.corpo.disponivel, 4);
});

test('o livro-caixa registra entradas e descartes com o autor', async () => {
  const admin = await clienteAdmin();
  const { produtoId, planoId } = await produtoIsolado(admin, { quantidadeEstoque: 5 });

  const saida = await admin('POST', '/api/admin/estoque/descartar', { produtoId, planoId, quantidade: 2, motivo: 'lote com defeito' });
  assert.equal(saida.status, 200);
  assert.equal(saida.corpo.removidas, 2);
  assert.equal(saida.corpo.disponivel, 3);

  const movimentos = await admin('GET', `/api/admin/estoque/movimentos?produtoId=${produtoId}&planoId=${planoId}`);
  assert.equal(movimentos.status, 200);
  const tipos = movimentos.corpo.movimentos.map((movimento) => movimento.tipo);
  assert.ok(tipos.includes('entrada'));
  assert.ok(tipos.includes('descarte'));

  const entrada = movimentos.corpo.movimentos.find((movimento) => movimento.tipo === 'entrada');
  assert.ok(entrada.atorNome || entrada.atorEmail, 'o movimento deveria registrar quem executou');
});

/** Ids das chaves de um plano, opcionalmente filtradas por status. */
async function idsDasChaves(admin, produtoId, planoId, status = '') {
  const filtro = status ? `&status=${status}` : '';
  const lista = await admin('GET', `/api/admin/estoque/chaves?produtoId=${produtoId}&planoId=${planoId}${filtro}`);
  assert.equal(lista.status, 200);
  return lista.corpo.chaves.map((chave) => chave.id);
}

test('admin remove chaves escolhidas do pool e o disponivel cai', async () => {
  const admin = await clienteAdmin();
  const { produtoId, planoId } = await produtoIsolado(admin, { quantidadeEstoque: 4 });
  const [primeira, segunda] = await idsDasChaves(admin, produtoId, planoId);

  const remocao = await admin('POST', '/api/admin/estoque/chaves/descartar', { produtoId, planoId, ids: [primeira, segunda] });
  assert.equal(remocao.status, 200);
  assert.equal(remocao.corpo.removidas, 2);
  assert.equal(remocao.corpo.ignoradas, 0);
  assert.equal(remocao.corpo.disponivel, 2);

  const descartadas = await idsDasChaves(admin, produtoId, planoId, 'descartada');
  assert.deepEqual([...descartadas].sort(), [primeira, segunda].sort());

  // Remover de novo as mesmas chaves nao tem o que fazer.
  const repetida = await admin('POST', '/api/admin/estoque/chaves/descartar', { produtoId, planoId, ids: [primeira] });
  assert.equal(repetida.status, 422);
});

test('admin exclui de vez chaves disponiveis e descartadas', async () => {
  const admin = await clienteAdmin();
  const { produtoId, planoId } = await produtoIsolado(admin, { quantidadeEstoque: 3 });
  const [descartada, disponivel, restante] = await idsDasChaves(admin, produtoId, planoId);
  await admin('POST', '/api/admin/estoque/chaves/descartar', { produtoId, planoId, ids: [descartada] });

  const exclusao = await admin('POST', '/api/admin/estoque/chaves/excluir', { produtoId, planoId, ids: [descartada, disponivel] });
  assert.equal(exclusao.status, 200);
  assert.equal(exclusao.corpo.excluidas, 2);
  assert.equal(exclusao.corpo.disponivel, 1);

  assert.deepEqual(await idsDasChaves(admin, produtoId, planoId), [restante]);

  const movimentos = await admin('GET', `/api/admin/estoque/movimentos?produtoId=${produtoId}&planoId=${planoId}`);
  assert.ok(
    movimentos.corpo.movimentos.some((m) => m.tipo === 'descarte' && m.motivo === 'Exclusao definitiva' && m.quantidade === 1),
    'a saida da chave disponivel excluida deveria ir para o livro-caixa'
  );
});

test('chaves vendidas nao podem ser excluidas nem removidas', async () => {
  const admin = await clienteAdmin();
  const { produtoId, planoId } = await produtoIsolado(admin, { quantidadeEstoque: 1 });
  const cliente = await clienteDemo();
  const pedido = await cliente('POST', '/api/vendas', { itens: [{ produtoId, planoId, quantidade: 1 }] });
  assert.equal(pedido.status, 201);

  const [vendida] = await idsDasChaves(admin, produtoId, planoId, 'vendida');
  const exclusao = await admin('POST', '/api/admin/estoque/chaves/excluir', { produtoId, planoId, ids: [vendida] });
  assert.equal(exclusao.status, 422);
  const remocao = await admin('POST', '/api/admin/estoque/chaves/descartar', { produtoId, planoId, ids: [vendida] });
  assert.equal(remocao.status, 422);

  assert.deepEqual(await idsDasChaves(admin, produtoId, planoId, 'vendida'), [vendida], 'a chave vendida deveria continuar no historico');
});

test('acoes por chave validam a lista e o plano das chaves', async () => {
  const admin = await clienteAdmin();
  const alvo = await produtoIsolado(admin, { quantidadeEstoque: 1 });
  const outro = await produtoIsolado(admin, { quantidadeEstoque: 1 });
  const [chaveDoOutro] = await idsDasChaves(admin, outro.produtoId, outro.planoId);

  const vazia = await admin('POST', '/api/admin/estoque/chaves/excluir', { ...alvo, ids: [] });
  assert.equal(vazia.status, 400);
  const invalida = await admin('POST', '/api/admin/estoque/chaves/excluir', { ...alvo, ids: ['nao-e-uuid'] });
  assert.equal(invalida.status, 400);

  // Id real, mas de outro plano: nada pode ser apagado.
  const alheia = await admin('POST', '/api/admin/estoque/chaves/excluir', { ...alvo, ids: [chaveDoOutro] });
  assert.equal(alheia.status, 404);
  assert.deepEqual(await idsDasChaves(admin, outro.produtoId, outro.planoId), [chaveDoOutro]);

  const cliente = await clienteDemo();
  const negado = await cliente('POST', '/api/admin/estoque/chaves/excluir', { ...alvo, ids: [chaveDoOutro] });
  assert.equal(negado.status, 403);
});

test('a chave entregue na compra vem do estoque e fica marcada como vendida', async () => {
  const admin = await clienteAdmin();
  const { produtoId, planoId } = await produtoIsolado(admin, { quantidadeEstoque: 2 });

  const cliente = await clienteDemo();
  const pedido = await cliente('POST', '/api/vendas', {
    itens: [{ produtoId, planoId, quantidade: 1 }]
  });

  assert.equal(pedido.status, 201);
  const chave = pedido.corpo.chaves[0];
  assert.match(chave, /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/);

  const vendidas = await admin('GET', `/api/admin/estoque/chaves?produtoId=${produtoId}&planoId=${planoId}&status=vendida`);
  assert.ok(vendidas.corpo.chaves.some((item) => item.chave === chave), 'a chave entregue deveria estar no pool como vendida');

  const resumo = await admin('GET', '/api/admin/estoque');
  const plano = resumo.corpo.planos.find((item) => item.produtoId === produtoId && item.planoId === planoId);
  assert.equal(plano.disponivel, 1, 'o checkout deveria ter consumido uma chave');
  assert.equal(plano.vendida, 1);
});

test('checkout bloqueia a venda quando o estoque acaba', async () => {
  const admin = await clienteAdmin();
  const { produtoId, planoId } = await produtoIsolado(admin, { quantidadeEstoque: 2 });

  const cliente = await clienteDemo();

  // Leva as duas chaves disponiveis.
  const primeira = await cliente('POST', '/api/vendas', { itens: [{ produtoId, planoId, quantidade: 2 }] });
  assert.equal(primeira.status, 201);
  assert.equal(primeira.corpo.chaves.length, 2);

  // Zerou: a proxima tentativa e bloqueada (estoque e a fonte da verdade).
  const bloqueada = await cliente('POST', '/api/vendas', { itens: [{ produtoId, planoId, quantidade: 1 }] });
  assert.equal(bloqueada.status, 409);
  assert.equal(bloqueada.corpo.codigo, 'estoque_insuficiente');

  // E a vitrine passa a marcar o produto como esgotado.
  const vitrine = await cliente('GET', `/api/produtos/${produtoId}`);
  assert.equal(vitrine.status, 200);
  assert.equal(vitrine.corpo.esgotado, true);
  assert.equal(vitrine.corpo.planos[0].esgotado, true);

  // Reabastecer devolve o produto a vitrine.
  await admin('POST', '/api/admin/estoque/gerar', { produtoId, planoId, quantidade: 1 });
  const depois = await cliente('GET', `/api/produtos/${produtoId}`);
  assert.equal(depois.corpo.esgotado, false);
});

test('a vitrine publica expoe a disponibilidade por plano', async () => {
  const anonimo = criarCliente();
  const { produto, plano } = await primeiroProduto(anonimo);

  assert.equal(typeof plano.estoque, 'number');
  assert.equal(typeof plano.esgotado, 'boolean');
  assert.equal(typeof produto.estoqueTotal, 'number');
  assert.equal(typeof produto.esgotado, 'boolean');
});

/* -------------------------------------------------------------------------- */
/* Relatorios                                                                 */
/* -------------------------------------------------------------------------- */

test('relatorios trazem financeiro, serie diaria e comparativo', async () => {
  const admin = await clienteAdmin();
  const { status, corpo } = await admin('GET', '/api/admin/relatorios?periodo=30');

  assert.equal(status, 200);
  assert.ok(corpo.janela.desde && corpo.janela.ate);
  assert.equal(corpo.janela.dias, 30);

  assert.equal(typeof corpo.financeiro.receita, 'number');
  assert.equal(typeof corpo.financeiro.ticketMedio, 'number');
  assert.equal(typeof corpo.financeiro.unidades, 'number');

  assert.ok(Array.isArray(corpo.receitaPorDia));
  assert.ok(corpo.receitaPorDia.length >= 28, 'a serie diaria deveria cobrir o periodo sem buracos');
  assert.ok('receita' in corpo.receitaPorDia[0]);

  assert.equal(typeof corpo.comparativo.variacaoReceita, 'number');
  assert.ok(Array.isArray(corpo.topProdutos));
  assert.ok(Array.isArray(corpo.porMetodo));
  assert.ok(Array.isArray(corpo.porCategoria));
  assert.equal(typeof corpo.clientes.novos, 'number');
  assert.ok(corpo.estoque && typeof corpo.estoque.disponivel === 'number');
});

test('relatorios validam o intervalo de datas', async () => {
  const admin = await clienteAdmin();

  const invalida = await admin('GET', '/api/admin/relatorios?desde=31/07/2026');
  assert.equal(invalida.status, 400);

  const invertida = await admin('GET', '/api/admin/relatorios?desde=2026-07-31&ate=2026-07-01');
  assert.equal(invertida.status, 400);
});

test('admin abre a ficha completa do cliente', async () => {
  const admin = await clienteAdmin();
  const clientes = await admin('GET', '/api/admin/usuarios');
  const alvo = clientes.corpo.usuarios.find((usuario) => usuario.email === 'demo@loja.com');

  assert.ok(alvo, 'a conta demo deveria estar na lista');

  const ficha = await admin('GET', `/api/admin/usuarios/${alvo.id}`);
  assert.equal(ficha.status, 200);
  assert.equal(ficha.corpo.email, 'demo@loja.com');
  assert.ok(Array.isArray(ficha.corpo.pedidos));
  assert.ok(Array.isArray(ficha.corpo.licencas));
  assert.equal(typeof ficha.corpo.resumo.gasto, 'number');
  assert.equal(typeof ficha.corpo.resumo.pedidos, 'number');
});

/* -------------------------------------------------------------------------- */
/* Tempo real (SSE)                                                           */
/* -------------------------------------------------------------------------- */

/** Faz login e devolve o cookie de sessao (o SSE precisa de fetch cru). */
async function cookieDoAdmin() {
  const resposta = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@loja.com', senha: 'admin123' })
  });
  assert.equal(resposta.status, 200);

  const recebidos = typeof resposta.headers.getSetCookie === 'function' ? resposta.headers.getSetCookie() : [];
  const sid = recebidos.find((linha) => linha.startsWith('sid='));
  return sid ? sid.split(';')[0] : '';
}

test('o canal de tempo real entrega o evento de abertura para o admin', async () => {
  const cookie = await cookieDoAdmin();
  assert.ok(cookie, 'deveria obter o cookie de sessao do admin');

  const controlador = new AbortController();
  const resposta = await fetch(base + '/api/admin/eventos', {
    headers: { Cookie: cookie, Accept: 'text/event-stream' },
    signal: controlador.signal
  });

  assert.equal(resposta.status, 200);
  assert.match(resposta.headers.get('content-type') || '', /text\/event-stream/);

  const leitor = resposta.body.getReader();
  const { value } = await leitor.read();
  const texto = new TextDecoder().decode(value);

  assert.match(texto, /event: pronto/);
  controlador.abort();
});

test('o canal de tempo real exige administrador', async () => {
  const resposta = await fetch(base + '/api/admin/eventos', { headers: { Accept: 'text/event-stream' } });
  assert.equal(resposta.status, 401);
  if (resposta.body) await resposta.body.cancel();
});

/* -------------------------------------------------------------------------- */
/* Painel do cliente: historico de atividades e preferencias                  */
/* -------------------------------------------------------------------------- */

test('GET /conta serve a pagina do painel do cliente', async () => {
  const resposta = await fetch(base + '/conta');
  assert.equal(resposta.status, 200);
  assert.match(resposta.headers.get('content-type') || '', /text\/html/);

  const html = await resposta.text();
  assert.match(html, /Minha conta/);
  assert.match(html, /\/js\/conta\.js/);
});

test('o historico de atividades registra o cadastro e vem enriquecido', async () => {
  const requisitar = criarCliente();
  await requisitar('POST', '/api/auth/registrar', {
    nome: 'Historico',
    email: `historico${Date.now()}@exemplo.com`,
    senha: 'senhaHistorico1'
  });

  const { status, corpo } = await requisitar('GET', '/api/conta/atividades');
  assert.equal(status, 200);
  assert.ok(Array.isArray(corpo.atividades));
  assert.ok(corpo.total >= 1);
  assert.ok(corpo.atividades.some(item => item.tipo === 'cadastro'));

  // Cada linha chega pronta para a tela: rotulo, icone e tom vem do servidor.
  const item = corpo.atividades[0];
  assert.ok(item.tipoRotulo, 'deveria trazer o rotulo do tipo');
  assert.ok(item.icone, 'deveria trazer o icone do tipo');
  assert.ok(item.tom, 'deveria trazer o tom do tipo');
  assert.ok(Array.isArray(corpo.tipos) && corpo.tipos.length >= 1);
});

test('mudar o perfil registra uma atividade (e salvar igual nao registra)', async () => {
  const requisitar = criarCliente();
  await requisitar('POST', '/api/auth/registrar', {
    nome: 'Antes',
    email: `perfilatv${Date.now()}@exemplo.com`,
    senha: 'senhaPerfilAtv1'
  });

  const antes = await requisitar('GET', '/api/conta/atividades');
  const totalAntes = antes.corpo.total;

  await requisitar('PATCH', '/api/conta', { nome: 'Depois' });

  const depois = await requisitar('GET', '/api/conta/atividades');
  assert.equal(depois.corpo.total, totalAntes + 1);
  assert.ok(depois.corpo.atividades.some(item => item.tipo === 'perfil_atualizado'));

  // Reenviar o mesmo nome nao muda nada: o historico nao deve crescer.
  await requisitar('PATCH', '/api/conta', { nome: 'Depois' });
  const igual = await requisitar('GET', '/api/conta/atividades');
  assert.equal(igual.corpo.total, totalAntes + 1);
});

test('o historico filtra por tipo e por busca', async () => {
  const requisitar = await clienteDemo();

  const porTipo = await requisitar('GET', '/api/conta/atividades?tipo=login');
  assert.equal(porTipo.status, 200);
  assert.ok(porTipo.corpo.atividades.length >= 1);
  assert.ok(porTipo.corpo.atividades.every(item => item.tipo === 'login'));

  const porBusca = await requisitar('GET', '/api/conta/atividades?busca=Entrada');
  assert.equal(porBusca.status, 200);
  assert.ok(porBusca.corpo.atividades.every(item => /entrada/i.test(item.titulo)));
});

test('o historico de atividades e isolado por usuario', async () => {
  const requisitar = criarCliente();
  await requisitar('POST', '/api/auth/registrar', {
    nome: 'Isolado',
    email: `isolado${Date.now()}@exemplo.com`,
    senha: 'senhaIsolado1'
  });

  const { corpo } = await requisitar('GET', '/api/conta/atividades');
  assert.ok(corpo.atividades.length >= 1);
  // Conta nova so tem as proprias marcas: nunca as de outro cliente.
  assert.ok(corpo.atividades.every(item => item.tipo === 'cadastro' || item.tipo === 'login'));
});

test('o usuario pode limpar o proprio historico', async () => {
  const requisitar = criarCliente();
  await requisitar('POST', '/api/auth/registrar', {
    nome: 'Limpa',
    email: `limpa${Date.now()}@exemplo.com`,
    senha: 'senhaLimpa123'
  });

  const limpeza = await requisitar('DELETE', '/api/conta/atividades');
  assert.equal(limpeza.status, 200);
  assert.ok(limpeza.corpo.removidas >= 1);

  const depois = await requisitar('GET', '/api/conta/atividades');
  assert.equal(depois.corpo.total, 0);
});

test('atividades exigem login', async () => {
  const requisitar = criarCliente();
  const { status } = await requisitar('GET', '/api/conta/atividades');
  assert.equal(status, 401);
});

test('preferencias vem com os padroes e o catalogo de opcoes', async () => {
  const requisitar = await clienteDemo();
  const { status, corpo } = await requisitar('GET', '/api/conta/preferencias');

  assert.equal(status, 200);
  assert.equal(typeof corpo.preferencias.avisoLicenca, 'boolean');
  assert.equal(typeof corpo.preferencias.novidadesEmail, 'boolean');
  assert.equal(typeof corpo.preferencias.resumoCompras, 'boolean');
  assert.ok(['escuro', 'claro'].includes(corpo.preferencias.tema));
  assert.equal(corpo.opcoes.length, 4);
});

test('salvar preferencias persiste e valida o tema', async () => {
  const requisitar = criarCliente();
  await requisitar('POST', '/api/auth/registrar', {
    nome: 'Prefs',
    email: `prefs${Date.now()}@exemplo.com`,
    senha: 'senhaPrefs123'
  });

  const salvo = await requisitar('PATCH', '/api/conta/preferencias', {
    avisoLicenca: false,
    tema: 'claro'
  });
  assert.equal(salvo.status, 200);
  assert.equal(salvo.corpo.preferencias.avisoLicenca, false);
  assert.equal(salvo.corpo.preferencias.tema, 'claro');
  assert.ok(salvo.corpo.alteradas.includes('Aviso de licença expirando'));

  const lido = await requisitar('GET', '/api/conta/preferencias');
  assert.equal(lido.corpo.preferencias.avisoLicenca, false);
  assert.equal(lido.corpo.preferencias.tema, 'claro');

  const invalido = await requisitar('PATCH', '/api/conta/preferencias', { tema: 'arco-iris' });
  assert.equal(invalido.status, 400);
  assert.ok(invalido.corpo.erro);
});

test('o resumo da conta traz atividades e preferencias', async () => {
  const requisitar = await clienteDemo();
  const { status, corpo } = await requisitar('GET', '/api/conta');

  assert.equal(status, 200);
  assert.ok(corpo.atividades && typeof corpo.atividades.total === 'number');
  assert.ok(corpo.preferencias && typeof corpo.preferencias.tema === 'string');
});

test('preferencias exigem login', async () => {
  const requisitar = criarCliente();
  const { status } = await requisitar('GET', '/api/conta/preferencias');
  assert.equal(status, 401);
});

/* -------------------------------------------------------------------------- */
/* Reconhecimento do lado administrativo                                      */
/* -------------------------------------------------------------------------- */

/*
 * O front decide se mostra o atalho para o painel a partir do "papel" que a
 * sessao devolve. Se esse campo sumir ou mudar de valor, o admin volta a ter
 * que digitar /admin na barra de enderecos — por isso o contrato fica testado.
 */

test('o login e o /api/auth/me identificam o cliente', async () => {
  const requisitar = criarCliente();

  const login = await requisitar('POST', '/api/auth/login', { email: 'demo@loja.com', senha: 'demo123' });
  assert.equal(login.status, 200);
  assert.equal(login.corpo.usuario.papel, 'cliente', 'o login deve informar o papel');

  const eu = await requisitar('GET', '/api/auth/me');
  assert.equal(eu.status, 200);
  assert.equal(eu.corpo.usuario.papel, 'cliente', 'o /me deve permitir reconhecer o cliente');
});

test('o login e o /api/auth/me identificam o administrador', async () => {
  const requisitar = criarCliente();

  const login = await requisitar('POST', '/api/auth/login', { email: 'admin@loja.com', senha: 'admin123' });
  assert.equal(login.status, 200);
  assert.equal(login.corpo.usuario.papel, 'admin', 'o login do admin deve devolver papel admin');

  const eu = await requisitar('GET', '/api/auth/me');
  assert.equal(eu.status, 200);
  assert.equal(eu.corpo.usuario.papel, 'admin', 'o /me deve permitir reconhecer o admin');
});

test('a sessao de administrador mantem o papel ao reabrir', async () => {
  const requisitar = await clienteAdmin();
  const eu = await requisitar('GET', '/api/auth/me');

  assert.equal(eu.status, 200);
  assert.equal(eu.corpo.usuario.papel, 'admin');
  assert.ok(eu.corpo.usuario.email, 'o /me deve trazer os dados publicos do usuario');
  assert.ok(!('senhaHash' in eu.corpo.usuario), 'o /me nunca expoe o hash da senha');
});

test('fora de producao os assets nao ficam presos no cache do navegador', async () => {
  const requisitar = criarCliente();

  // Sem isso, editar um .js/.css nao aparece no navegador (HTML novo + JS velho).
  for (const caminho of ['/css/app.css', '/js/ui.js', '/js/conta.js']) {
    const resposta = await requisitar('GET', caminho);
    assert.equal(resposta.status, 200, `${caminho} deveria existir`);
    assert.match(
      String(resposta.headers.get('cache-control')),
      /no-cache/,
      `${caminho} deveria ser sempre revalidado fora de producao`
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Gateways de pagamento                                                      */
/* -------------------------------------------------------------------------- */

/*
 * O simulador interno precisa continuar ligado do inicio ao fim desta secao:
 * e ele que sustenta o checkout enquanto os gateways reais estao sem
 * credenciais. Por isso os testes que ligam um gateway real o desligam no fim.
 */

test('o catalogo de gateways vem completo com metodos pre-definidos', async () => {
  const requisitar = await clienteAdmin();
  const { status, corpo } = await requisitar('GET', '/api/admin/gateways');

  assert.equal(status, 200);
  assert.equal(corpo.gateways.length, 6, 'todos os provedores do catalogo');

  // O catalogo das FORMAS (pix/cartao/boleto) alimenta os seletores da tela.
  assert.deepEqual(corpo.formas.map(f => f.id).sort(), ['boleto', 'cartao', 'pix']);
  for (const forma of corpo.formas) {
    assert.ok(forma.nome, `${forma.id} deveria ter nome`);
    assert.ok(forma.icone, `${forma.id} deveria ter icone`);
    assert.equal(typeof forma.descricao, 'string');
    assert.equal(typeof forma.imediato, 'boolean');
  }

  // Provedores e o que cada um aceita.
  const porId = Object.fromEntries(corpo.provedores.map(p => [p.id, p]));
  assert.deepEqual(porId.mercadopago.suportados.sort(), ['boleto', 'cartao', 'pix']);
  assert.deepEqual(porId.infinitypay.suportados.sort(), ['boleto', 'cartao', 'pix']);
  assert.deepEqual(porId.pagarme.suportados.sort(), ['boleto', 'cartao', 'pix']);
  assert.deepEqual(porId.asaas.suportados.sort(), ['boleto', 'cartao', 'pix']);
  assert.deepEqual(porId.stripe.suportados, ['cartao'], 'Stripe so cobra cartao');

  // Configuracao pre-definida: o simulador nasce ligado, os reais desligados.
  const simulado = corpo.gateways.find(g => g.id === 'simulado');
  assert.equal(simulado.ativo, true);
  assert.equal(simulado.somenteSimulacao, true);
  assert.deepEqual(simulado.metodos.sort(), ['boleto', 'cartao', 'pix']);
  assert.equal(simulado.modoEfetivo, 'demonstracao');

  for (const id of ['mercadopago', 'infinitypay', 'pagarme', 'asaas', 'stripe']) {
    const gateway = corpo.gateways.find(g => g.id === id);
    assert.equal(gateway.ativo, false, `${id} deve nascer desligado`);
    assert.ok(gateway.metodos.length > 0, `${id} deve vir com metodos pre-marcados`);
    assert.equal(gateway.modo, 'sandbox');
    assert.ok(gateway.campos.length > 0, `${id} deve declarar as credenciais que exige`);
  }
});

test('a loja vende de imediato com o simulador, sem configurar nada', async () => {
  const requisitar = criarCliente();
  const { status, corpo } = await requisitar('GET', '/api/pagamentos/metodos');

  assert.equal(status, 200);
  assert.deepEqual(corpo.metodos.map(m => m.id).sort(), ['boleto', 'cartao', 'pix']);
  assert.equal(corpo.padrao, 'pix');

  for (const metodo of corpo.metodos) {
    assert.equal(metodo.gateway.id, 'simulado', `${metodo.id} deveria cair no simulador`);
    assert.equal(metodo.gateway.demonstracao, true, 'o simulador sempre e demonstracao');
  }
});

test('a forma de pagamento padrao e escolhida no painel e vale no checkout', async () => {
  const admin = await clienteAdmin();

  const inicial = await admin('GET', '/api/admin/gateways');
  assert.equal(inicial.status, 200);
  assert.equal(inicial.corpo.metodoPadrao, 'pix', 'nasce no pix (padrao do .env)');

  try {
    const salvo = await admin('PATCH', '/api/admin/gateways/metodo-padrao', { metodo: 'boleto' });
    assert.equal(salvo.status, 200);
    assert.equal(salvo.corpo.metodoPadrao, 'boleto');

    // O painel passa a mostrar a escolha...
    const depois = await admin('GET', '/api/admin/gateways');
    assert.equal(depois.corpo.metodoPadrao, 'boleto');

    // ...a vitrine sugere essa forma no checkout...
    const vitrine = await admin('GET', '/api/pagamentos/metodos');
    assert.equal(vitrine.corpo.padrao, 'boleto');

    // ...e o checkout sem forma informada cai nela (boleto fica pendente).
    const cliente = await clienteDemo();
    const { produto, plano } = await primeiroProduto(cliente);
    const venda = await cliente('POST', '/api/vendas', {
      itens: [{ produtoId: produto.id, planoId: plano.id, quantidade: 1 }]
    });

    assert.equal(venda.status, 201);
    assert.equal(venda.corpo.metodoPagamento, 'boleto', 'usou a forma padrao do painel');
    assert.equal(venda.corpo.status, 'pendente', 'boleto nao entrega chave na hora');
  } finally {
    // Restaura para nao afetar os demais testes.
    const voltou = await admin('PATCH', '/api/admin/gateways/metodo-padrao', { metodo: 'pix' });
    assert.equal(voltou.corpo.metodoPadrao, 'pix');
  }
});

test('forma de pagamento padrao invalida e recusada', async () => {
  const requisitar = await clienteAdmin();
  const { status, corpo } = await requisitar('PATCH', '/api/admin/gateways/metodo-padrao', {
    metodo: 'dinheiro-vivo'
  });

  assert.equal(status, 400);
  assert.ok(corpo.detalhes && corpo.detalhes.metodo, 'deveria dizer o que aceita');
});

test('credenciais de gateway nunca voltam em texto puro', async () => {
  const requisitar = await clienteAdmin();

  const salvar = await requisitar('PATCH', '/api/admin/gateways/mercadopago', {
    credenciais: {
      access_token: 'APP_USR-1234567890-abcdefghij',
      webhook_secret: 'segredo-super-secreto-do-webhook'
    }
  });
  assert.equal(salvar.status, 200);

  const { corpo } = await requisitar('GET', '/api/admin/gateways/mercadopago');
  const credenciais = corpo.gateway.credenciais;

  assert.equal(credenciais.access_token.preenchido, true);
  assert.ok(
    !credenciais.access_token.valor.includes('APP_USR-1234567890'),
    'o token nao pode aparecer inteiro'
  );
  assert.match(credenciais.access_token.valor, /^APP_•+ghij$/, 'deveria vir mascarado');

  assert.equal(credenciais.webhook_secret.preenchido, true);
  assert.ok(
    !credenciais.webhook_secret.valor.includes('super-secreto'),
    'o segredo do webhook nao pode vazar'
  );

  // Com as credenciais completas o gateway passa a operar de verdade.
  assert.equal(corpo.gateway.credenciaisCompletas, true);
  assert.deepEqual(corpo.gateway.faltando, []);
  assert.equal(corpo.gateway.modoEfetivo, 'real');

  // Limpa para nao interferir nos testes seguintes.
  await requisitar('PATCH', '/api/admin/gateways/mercadopago', { limparCredenciais: true });
});

test('chave publica nao e mascarada e campo vazio preserva o segredo', async () => {
  const requisitar = await clienteAdmin();

  await requisitar('PATCH', '/api/admin/gateways/mercadopago', {
    credenciais: { access_token: 'APP_USR-token-original-123456', public_key: 'PUB-abc-123' }
  });

  // Salvar outro campo NAO pode apagar o que ja estava la.
  await requisitar('PATCH', '/api/admin/gateways/mercadopago', {
    credenciais: { webhook_secret: 'so-este-campo-mudou' }
  });

  const { corpo } = await requisitar('GET', '/api/admin/gateways/mercadopago');
  const credenciais = corpo.gateway.credenciais;

  assert.equal(credenciais.access_token.preenchido, true, 'o token nao pode ter sido apagado');
  assert.equal(credenciais.webhook_secret.preenchido, true);
  assert.equal(credenciais.public_key.valor, 'PUB-abc-123', 'chave publica sai inteira (nao e segredo)');

  // `null` e o unico jeito de limpar de proposito.
  await requisitar('PATCH', '/api/admin/gateways/mercadopago', {
    credenciais: { public_key: null }
  });

  const depois = await requisitar('GET', '/api/admin/gateways/mercadopago');
  assert.equal(depois.corpo.gateway.credenciais.public_key.preenchido, false);
  assert.equal(depois.corpo.gateway.credenciais.access_token.preenchido, true, 'so o campo enviado como null sai');

  await requisitar('PATCH', '/api/admin/gateways/mercadopago', { limparCredenciais: true });
});

test('ativar em producao sem credenciais e bloqueado', async () => {
  const requisitar = await clienteAdmin();

  const { status, corpo } = await requisitar('PATCH', '/api/admin/gateways/pagarme', {
    ativo: true,
    modo: 'producao'
  });

  assert.equal(status, 422, 'nao pode aceitar cobranca real sem credencial');
  assert.match(corpo.erro, /producao/i);
  assert.match(corpo.erro, /secret_key/i, 'a mensagem deve dizer qual campo falta');

  // E o gateway continua desligado.
  const { corpo: depois } = await requisitar('GET', '/api/admin/gateways/pagarme');
  assert.equal(depois.gateway.ativo, false);
});

test('ativar um gateway sem forma de pagamento e bloqueado', async () => {
  const requisitar = await clienteAdmin();

  const { status, corpo } = await requisitar('PATCH', '/api/admin/gateways/stripe', {
    ativo: true,
    metodos: []
  });

  assert.equal(status, 422);
  assert.match(corpo.erro, /forma de pagamento/i);

  const { corpo: depois } = await requisitar('GET', '/api/admin/gateways/stripe');
  assert.equal(depois.gateway.ativo, false);
});

test('um gateway real ligado assume a cobranca no lugar do simulador', async () => {
  const admin = await clienteAdmin();

  // So cartao: assim da para conferir que pix continua no simulador.
  const salvar = await admin('PATCH', '/api/admin/gateways/mercadopago', {
    ativo: true,
    modo: 'sandbox',
    metodos: ['cartao'],
    credenciais: { access_token: 'APP_USR-token-de-teste-987654', webhook_secret: 'segredo-do-webhook' }
  });
  assert.equal(salvar.status, 200);

  const publico = criarCliente();
  const { corpo } = await publico('GET', '/api/pagamentos/metodos');
  const porMetodo = Object.fromEntries(corpo.metodos.map(m => [m.id, m.gateway]));

  assert.equal(porMetodo.cartao.id, 'mercadopago', 'o gateway real tem prioridade');
  assert.equal(porMetodo.cartao.demonstracao, false, 'com credenciais completas ele opera de verdade');
  assert.equal(porMetodo.pix.id, 'simulado', 'pix nao foi marcado no gateway real');
  assert.equal(porMetodo.boleto.id, 'simulado');

  // Devolve o cenario original.
  await admin('PATCH', '/api/admin/gateways/mercadopago', { ativo: false, limparCredenciais: true });
});

test('a configuracao de gateways e exclusiva do administrador', async () => {
  const anonimo = criarCliente();
  const semSessao = await anonimo('GET', '/api/admin/gateways');
  assert.equal(semSessao.status, 401);

  const cliente = await clienteDemo();
  const leitura = await cliente('GET', '/api/admin/gateways');
  const escrita = await cliente('PATCH', '/api/admin/gateways/simulado', { ativo: false });
  const padrao = await cliente('PATCH', '/api/admin/gateways/metodo-padrao', { metodo: 'boleto' });

  assert.equal(leitura.status, 403);
  assert.equal(escrita.status, 403, 'cliente comum nao pode desligar um gateway');
  assert.equal(padrao.status, 403, 'cliente comum nao escolhe a forma de pagamento padrao');
});

test('gateway inexistente responde 404', async () => {
  const requisitar = await clienteAdmin();
  const { status } = await requisitar('GET', '/api/admin/gateways/gateway-que-nao-existe');
  assert.equal(status, 404);
});

test('webhook de gateway inexistente responde 404', async () => {
  const requisitar = criarCliente();
  const { status } = await requisitar('POST', '/api/pagamentos/webhook/inventado', { id: '1' });
  assert.equal(status, 404);
});

test('webhook com assinatura invalida e recusado e fica registrado', async () => {
  const requisitar = criarCliente();

  // O simulador nao tem segredo: ele aceita. Entao usamos um gateway real, que
  // exige assinatura — e mandamos uma assinatura inventada.
  const admin = await clienteAdmin();
  await admin('PATCH', '/api/admin/gateways/mercadopago', {
    ativo: true,
    metodos: ['pix'],
    credenciais: { access_token: 'APP_USR-token-de-teste-987654', webhook_secret: 'segredo-do-webhook' }
  });

  const antes = await admin('GET', '/api/admin/gateways/eventos');

  const recusado = await requisitar('POST', '/api/pagamentos/webhook/mercadopago', {
    type: 'payment',
    data: { id: '999999999' }
  });

  // 400 (e nao 200) de proposito: assim o gateway continua reenviando e um
  // ataque de "engolir webhook" nao passa despercebido.
  assert.equal(recusado.status, 400);
  assert.equal(recusado.corpo.codigo, 'webhook_invalido');

  const depois = await admin('GET', '/api/admin/gateways/eventos');
  assert.equal(depois.corpo.total, antes.corpo.total + 1, 'o evento invalido tem que ficar na trilha');

  const evento = depois.corpo.eventos[0];
  assert.equal(evento.gatewayId, 'mercadopago');
  assert.equal(evento.valido, false);

  await admin('PATCH', '/api/admin/gateways/mercadopago', { ativo: false, limparCredenciais: true });
});

test('o simulador confirma um pedido pendente pelo webhook, de forma idempotente', async () => {
  const cliente = await clienteDemo();
  const { produto, plano } = await primeiroProduto(cliente);

  // Boleto no simulador nasce pendente (nao entrega chave na hora).
  const compra = await cliente('POST', '/api/vendas', {
    itens: [{ produtoId: produto.id, planoId: plano.id, quantidade: 1 }],
    metodoPagamento: 'boleto'
  });
  assert.equal(compra.status, 201);
  assert.equal(compra.corpo.status, 'pendente', 'boleto nao pode entregar chave antes de compensar');
  assert.equal(compra.corpo.instrucoesPagamento.linhaDigitavel !== undefined, true, 'deveria trazer a linha digitavel');

  const numero = compra.corpo.numero;
  assert.ok(numero, 'o pedido precisa de um numero para o gateway referenciar');

  const webhook = criarCliente();
  const aviso = await webhook('POST', '/api/pagamentos/webhook/simulado', {
    referencia: numero,
    status: 'aprovado'
  });
  assert.equal(aviso.status, 200);
  assert.equal(aviso.corpo.aplicado, 'confirmado');

  // Repetir o aviso nao pode gerar efeito duplo.
  const repetido = await webhook('POST', '/api/pagamentos/webhook/simulado', {
    referencia: numero,
    status: 'aprovado'
  });
  assert.equal(repetido.status, 200);
  assert.equal(repetido.corpo.aplicado, 'sem_mudanca');

  const pedido = await cliente('GET', '/api/vendas/' + compra.corpo.id);
  assert.equal(pedido.corpo.status, 'pago');
  assert.equal(pedido.corpo.itens[0].chaves.length, 1, 'a chave tem que ter sido emitida');
});

test('o cliente cancela o proprio pedido pendente', async () => {
  const cliente = await clienteDemo();
  const { produto, plano } = await primeiroProduto(cliente);

  const compra = await cliente('POST', '/api/vendas', {
    itens: [{ produtoId: produto.id, planoId: plano.id, quantidade: 1 }],
    metodoPagamento: 'boleto'
  });
  assert.equal(compra.corpo.status, 'pendente');

  const cancelamento = await cliente('POST', '/api/vendas/' + compra.corpo.id + '/cancelar');
  assert.equal(cancelamento.status, 200);

  const pedido = await cliente('GET', '/api/vendas/' + compra.corpo.id);
  assert.equal(pedido.corpo.status, 'cancelado');

  // Cancelar de novo nao faz sentido e precisa ser recusado.
  const denovo = await cliente('POST', '/api/vendas/' + compra.corpo.id + '/cancelar');
  assert.ok(denovo.status >= 400, 'nao pode cancelar duas vezes');
});

test('um pedido pago nao pode ser cancelado pelo cliente', async () => {
  const cliente = await clienteDemo();
  const { produto, plano } = await primeiroProduto(cliente);

  const compra = await cliente('POST', '/api/vendas', {
    itens: [{ produtoId: produto.id, planoId: plano.id, quantidade: 1 }],
    metodoPagamento: 'pix'
  });
  assert.equal(compra.corpo.status, 'pago');

  const tentativa = await cliente('POST', '/api/vendas/' + compra.corpo.id + '/cancelar');
  assert.ok(tentativa.status >= 400, 'chave ja entregue: cancelar liberaria licenca de graca');
});

test('pedido de outro cliente nao pode ser cancelado', async () => {
  const dono = await clienteDemo();
  const { produto, plano } = await primeiroProduto(dono);

  const compra = await dono('POST', '/api/vendas', {
    itens: [{ produtoId: produto.id, planoId: plano.id, quantidade: 1 }],
    metodoPagamento: 'boleto'
  });

  // Outro cliente: e-mail novo, sem relacao com o pedido.
  const intruso = criarCliente();
  await intruso('POST', '/api/auth/registrar', {
    nome: 'Intruso Teste',
    email: `intruso-${Date.now()}@exemplo.com`,
    senha: 'senhaSegura123'
  });

  const tentativa = await intruso('POST', '/api/vendas/' + compra.corpo.id + '/cancelar');
  assert.ok(tentativa.status >= 400, 'nao pode cancelar pedido alheio');

  // E o pedido continua intacto.
  const pedido = await dono('GET', '/api/vendas/' + compra.corpo.id);
  assert.equal(pedido.corpo.status, 'pendente');
});

test('requisicao de escrita com Origin de outro site e barrada', async () => {
  const requisitar = criarCliente();

  // Login valido, mas vindo de outra origem: e o padrao de um CSRF.
  const resposta = await requisitar('POST', '/api/auth/login', {
    email: 'demo@loja.com',
    senha: 'demo123'
  }, { Origin: 'https://site-malicioso.example' });

  assert.equal(resposta.status, 403);
  assert.match(String(resposta.corpo.erro), /origem/i);
});

test('a recuperacao de senha nao revela se o e-mail existe', async () => {
  const requisitar = criarCliente();
  const email = `recupera-${Date.now()}@exemplo.com`;

  await requisitar('POST', '/api/auth/registrar', { nome: 'Recupera', email, senha: 'senhaOriginal1' });

  const existente = await requisitar('POST', '/api/auth/recuperar-senha', { email });
  const inexistente = await requisitar('POST', '/api/auth/recuperar-senha', { email: 'ninguem-mesmo@exemplo.com' });

  assert.equal(existente.status, 200);
  assert.equal(inexistente.status, 200, 'a resposta nao pode diferenciar quem existe');
  assert.equal(existente.corpo.mensagem, inexistente.corpo.mensagem, 'a mensagem tem que ser identica');
});

/* -------------------------------------------------------------------------- */
/* Financeiro: o dinheiro da loja (recebido, a receber, devolvido)            */
/* -------------------------------------------------------------------------- */

/*
 * O financeiro e o irmao do relatorio, com outro foco:
 *   relatorios -> DESEMPENHO (so pedidos pagos: tendencia, top produtos)
 *   financeiro -> CAIXA (todos os status: o que entrou, o que falta e o que voltou)
 *
 * Estes testes ficam antes do bloco de backfill, que apaga o estoque inteiro.
 */

/** Semeia o cenario do caixa: um pago, um pendente (boleto) e um devolvido. */
async function cenarioFinanceiro() {
  const admin = await clienteAdmin();
  const { produto, plano } = await primeiroProduto(admin);

  // Garante chaves no pool: a suite inteira ja consumiu parte do estoque semeado.
  const reposicao = await admin('POST', '/api/admin/estoque/gerar', {
    produtoId: produto.id,
    planoId: plano.id,
    quantidade: 30,
    motivo: 'teste do financeiro'
  });
  assert.equal(reposicao.status, 201, 'o admin deveria repor o estoque');

  const cliente = await clienteDemo();
  const item = [{ produtoId: produto.id, planoId: plano.id, quantidade: 1 }];

  // Pago na hora (o simulador aprova pix/cartao de imediato).
  const pago = await cliente('POST', '/api/vendas', { itens: item, metodoPagamento: 'pix' });
  assert.equal(pago.status, 201);
  assert.equal(pago.corpo.status, 'pago');

  // Pendente: boleto so entrega depois da compensacao.
  const pendente = await cliente('POST', '/api/vendas', { itens: item, metodoPagamento: 'boleto' });
  assert.equal(pendente.status, 201);
  assert.equal(pendente.corpo.status, 'pendente');

  // Devolvido: outro pedido pago, estornado pelo admin.
  const estornado = await cliente('POST', '/api/vendas', { itens: item, metodoPagamento: 'pix' });
  assert.equal(estornado.status, 201);
  const reembolso = await admin('PATCH', `/api/admin/pedidos/${estornado.corpo.id}/status`, {
    status: 'reembolsado',
    motivo: 'teste do financeiro'
  });
  assert.equal(reembolso.status, 200);

  return { admin, cliente, produto, plano, pago: pago.corpo, pendente: pendente.corpo, estornado: estornado.corpo };
}

test('GET /api/admin/financeiro e exclusivo do administrador', async () => {
  const cliente = await clienteDemo();
  const resposta = await cliente('GET', '/api/admin/financeiro');

  assert.equal(resposta.status, 403);
  assert.equal(typeof resposta.corpo.erro, 'string', 'a resposta traz a mensagem amigavel');
  assert.equal(resposta.corpo.codigo, 'sem_permissao');
});

test('GET /api/admin/financeiro resume o caixa do periodo', async () => {
  await cenarioFinanceiro();

  const admin = await clienteAdmin();
  const { status, corpo } = await admin('GET', '/api/admin/financeiro?periodo=30');

  assert.equal(status, 200);

  // A janela vem pronta para a tela (mesmo formato do relatorio).
  assert.ok(corpo.janela.desde && corpo.janela.ate, 'traz a janela do periodo');
  assert.equal(corpo.janela.dias, 30);
  assert.equal(corpo.janela.rotulo, 'Últimos 30 dias', 'o rotulo tem acento');

  // Recebido: so os pedidos pagos que nao foram devolvidos.
  assert.ok(corpo.resumo.recebido.pedidos >= 1, 'deveria haver pedido recebido');
  assert.ok(corpo.resumo.recebido.valor > 0, 'o recebido tem valor');
  assert.equal(
    corpo.resumo.recebido.valor,
    corpo.resumo.recebido.valorCentavos / 100,
    'o valor em reais e o de centavos dividido por 100'
  );

  // A receber: o boleto pendente conta como dinheiro que ainda nao entrou.
  assert.ok(corpo.resumo.aReceber.pedidos >= 1, 'o boleto pendente aparece em "a receber"');
  assert.ok(corpo.resumo.aReceber.valor > 0);

  // Devolvido: o pedido reembolsado e assunto do financeiro.
  assert.ok(corpo.resumo.reembolsado.pedidos >= 1, 'o pedido estornado aparece em "devolvido"');
  assert.ok(corpo.resumo.reembolsado.valor > 0);

  // O ticket medio e a media do recebido, nunca um numero solto.
  assert.equal(
    corpo.resumo.ticketMedioCentavos,
    Math.round(corpo.resumo.recebido.valorCentavos / corpo.resumo.recebido.pedidos),
    'ticket medio = recebido / pedidos recebidos'
  );
  assert.equal(corpo.resumo.ticketMedio, corpo.resumo.ticketMedioCentavos / 100);

  // Comparacao com o periodo anterior de mesmo tamanho.
  assert.equal(typeof corpo.comparativo.recebidoAnteriorCentavos, 'number');
  assert.equal(typeof corpo.comparativo.variacaoRecebido, 'number');

  // Todos os status aparecem, inclusive os zerados (a tela nao quebra).
  assert.deepEqual(Object.keys(corpo.pedidosPorStatus).sort(), ['cancelado', 'pago', 'pendente', 'reembolsado']);
  for (const quantidade of Object.values(corpo.pedidosPorStatus)) {
    assert.equal(typeof quantidade, 'number');
  }

  // Quebra por forma e por provedor, com nome legivel (nao o id cru).
  assert.ok(Array.isArray(corpo.porForma) && corpo.porForma.length >= 1);
  const pix = corpo.porForma.find(f => f.id === 'pix');
  assert.ok(pix, 'deveria haver receita em pix');
  assert.equal(pix.nome, 'Pix', 'a forma vem com o nome legivel');
  assert.ok(pix.participacao > 0 && pix.participacao <= 100, 'a participacao e uma porcentagem');
  assert.ok(pix.valor > 0);

  assert.ok(Array.isArray(corpo.porProvedor) && corpo.porProvedor.length >= 1);
  const simulado = corpo.porProvedor.find(p => p.id === 'simulado');
  assert.ok(simulado, 'o simulador deveria aparecer como provedor');
  assert.equal(simulado.nome, 'Simulador interno', 'o provedor vem com o nome do catalogo');
});

test('GET /api/admin/financeiro/pagamentos lista o extrato paginado', async () => {
  await cenarioFinanceiro();

  const admin = await clienteAdmin();
  const { status, corpo } = await admin('GET', '/api/admin/financeiro/pagamentos?periodo=30&limite=25');

  assert.equal(status, 200);
  assert.ok(corpo.total >= 3, 'os pedidos do cenario estao no extrato (total=' + corpo.total + ')');
  assert.equal(corpo.pagamentos.length, Math.min(corpo.total, 25), 'a primeira pagina respeita o limite');
  assert.equal(corpo.quantidade, corpo.pagamentos.length);

  // O extrato e um extrato: dinheiro que entrou, que falta e que voltou.
  const situacoes = new Set(corpo.pagamentos.map(p => p.status));
  assert.ok(situacoes.has('pago'), 'o extrato mostra o que entrou');
  assert.ok(situacoes.has('pendente'), 'o extrato mostra o que falta entrar');
  assert.ok(situacoes.has('reembolsado'), 'o extrato mostra o que voltou');

  const item = corpo.pagamentos[0];
  assert.ok(item.id && item.numero, 'cada linha traz id e numero do pedido');
  assert.ok(item.cliente && item.cliente.nome && item.cliente.email, 'cada linha traz o cliente');
  assert.equal(item.metodoNome.length > 0, true, 'a forma vem com nome legivel');
  assert.equal(item.provedorNome.length > 0, true, 'o provedor vem com nome legivel');
  assert.equal(typeof item.total, 'number');
  assert.equal(item.total, item.totalCentavos / 100);
  assert.ok(item.criadoEm, 'cada linha traz quando foi criada');

  // Do mais recente para o mais antigo.
  const datas = corpo.pagamentos.map(p => new Date(p.pagoEm || p.criadoEm).getTime());
  const ordenadas = [...datas].sort((a, b) => b - a);
  assert.deepEqual(datas, ordenadas, 'o extrato vem do mais recente para o mais antigo');

  // O primeiro item da lista e o pedido recem-criado do cenario.
  assert.ok(corpo.pagamentos.some(p => p.numero === item.numero));
});

test('o extrato financeiro filtra por situacao e valida o filtro', async () => {
  const admin = await clienteAdmin();

  const pagos = await admin('GET', '/api/admin/financeiro/pagamentos?periodo=30&status=pago');
  assert.equal(pagos.status, 200);
  assert.ok(pagos.corpo.total >= 1);
  assert.ok(pagos.corpo.pagamentos.every(p => p.status === 'pago'), 'o filtro devolve so o que foi pago');

  const pendentes = await admin('GET', '/api/admin/financeiro/pagamentos?periodo=30&status=pendente');
  assert.equal(pendentes.status, 200);
  assert.ok(pendentes.corpo.pagamentos.every(p => p.status === 'pendente'));

  // A situacao desconhecida e recusada antes de chegar ao banco.
  const invalido = await admin('GET', '/api/admin/financeiro/pagamentos?status=inventado');
  assert.equal(invalido.status, 400);
  assert.equal(invalido.corpo.codigo, 'dados_invalidos');
});

test('o extrato financeiro pagina de verdade', async () => {
  const admin = await clienteAdmin();

  const primeira = await admin('GET', '/api/admin/financeiro/pagamentos?periodo=30&limite=2&pagina=1');
  const segunda = await admin('GET', '/api/admin/financeiro/pagamentos?periodo=30&limite=2&pagina=2');

  assert.equal(primeira.status, 200);
  assert.equal(segunda.status, 200);
  assert.equal(primeira.corpo.total, segunda.corpo.total, 'o total e o mesmo em qualquer pagina');
  assert.equal(primeira.corpo.pagamentos.length, 2);

  const idsPrimeira = primeira.corpo.pagamentos.map(p => p.id);
  const idsSegunda = segunda.corpo.pagamentos.map(p => p.id);
  assert.equal(idsPrimeira.some(id => idsSegunda.includes(id)), false, 'as paginas nao repetem pedidos');
});

test('o financeiro recusa uma janela de datas invertida', async () => {
  const admin = await clienteAdmin();

  const invertida = await admin('GET', '/api/admin/financeiro?desde=2026-03-10&ate=2026-03-01');
  assert.equal(invertida.status, 400);
  assert.equal(invertida.corpo.codigo, 'dados_invalidos');

  const dataRuim = await admin('GET', '/api/admin/financeiro?desde=10/03/2026&ate=2026-03-20');
  assert.equal(dataRuim.status, 400);
  assert.equal(dataRuim.corpo.codigo, 'dados_invalidos');
});

test('o financeiro aceita um intervalo de datas explicito', async () => {
  const admin = await clienteAdmin();

  const hoje = new Date();
  const inicio = new Date(hoje.getTime() - 6 * 24 * 60 * 60 * 1000);
  const comoData = (d) => d.toISOString().slice(0, 10);

  const resposta = await admin(
    'GET',
    `/api/admin/financeiro?desde=${comoData(inicio)}&ate=${comoData(hoje)}`
  );

  assert.equal(resposta.status, 200);
  assert.equal(resposta.corpo.janela.dias, 7);
  assert.ok(resposta.corpo.janela.rotulo.includes(' a '), 'o rotulo vira "dd/mm/aaaa a dd/mm/aaaa"');
  assert.ok(resposta.corpo.resumo.recebido.pedidos >= 1, 'os pedidos de hoje caem na janela');
});

/* -------------------------------------------------------------------------- */
/* Home: destaques sempre atualizados e respostas sem cache do navegador      */
/* -------------------------------------------------------------------------- */

/*
 * Estes testes ficam perto do FIM de proposito: eles criam produtos, e o
 * catalogo publico alimenta varios testes anteriores (o checkout compra
 * `corpo[0]`). Criar produto aqui nao atrapalha ninguem.
 */

/** Cria um produto pelo painel e devolve o produto criado (a rota devolve o objeto direto). */
async function criarProduto(admin, nome, extras) {
  const resposta = await admin('POST', '/api/admin/produtos', {
    nome,
    categoria: 'Teste da home',
    descricao: 'Produto criado pelo teste da home.',
    destaque: true,
    ativo: true,
    planos: [{ nome: '30 dias', precoCentavos: 2500, dias: 30, estoque: 5 }],
    ...extras
  });
  assert.equal(resposta.status, 201, `deveria criar o produto "${nome}"`);
  return resposta.corpo;
}

test('a home mostra os destaques mais recentes primeiro', async () => {
  const admin = await clienteAdmin();

  // O nome ordena por ULTIMO no alfabeto de proposito: com a ordenacao antiga
  // (`destaque DESC, ordem ASC, nome ASC`) e a "Ordem na vitrine" jogando todo
  // produto novo para o fim (MAX(ordem)+1), este produto nunca entraria nos 3.
  const novo = await criarProduto(admin, 'Zz Produto Novissimo');

  const home = await admin('GET', '/api/produtos/destaques?limite=3');
  assert.equal(home.status, 200);
  assert.equal(home.corpo.length, 3, 'a home continua mostrando 3 destaques');
  assert.equal(home.corpo[0].id, novo.id, 'o produto recem-criado e o primeiro destaque da home');
  assert.ok(home.corpo.every(produto => produto.destaque === true), 'a home so traz produtos em destaque');
});

test('marcar como destaque basta: nao depende da Ordem na vitrine', async () => {
  const admin = await clienteAdmin();
  const novo = await criarProduto(admin, 'Zz Segundo Novissimo');

  // O produto nasce com ordem = MAX+1 (o fim da vitrine). Mesmo assim aparece.
  const home = await admin('GET', '/api/produtos/destaques');
  assert.equal(home.corpo[0].id, novo.id, 'o mais recente vem primeiro na home');

  // A "Ordem na vitrine" continua mandando no catalogo — sao coisas separadas.
  const catalogo = await admin('GET', '/api/produtos?destaque=true');
  const nomes = catalogo.corpo.map(produto => produto.nome);
  assert.equal(nomes[nomes.length - 1], 'Zz Segundo Novissimo', 'no catalogo ele vai para o fim');
});

test('produto sem destaque ou inativo nao aparece na home', async () => {
  const admin = await clienteAdmin();

  const semDestaque = await criarProduto(admin, 'Zz Sem Destaque', { destaque: false });
  const depois1 = await admin('GET', '/api/produtos/destaques?limite=12');
  assert.equal(
    depois1.corpo.some(produto => produto.id === semDestaque.id),
    false,
    'produto sem destaque fica fora da home'
  );

  const inativo = await criarProduto(admin, 'Zz Inativo', { ativo: false });
  const depois2 = await admin('GET', '/api/produtos/destaques?limite=12');
  assert.equal(
    depois2.corpo.some(produto => produto.id === inativo.id),
    false,
    'produto inativo fica fora da home'
  );
});

test('tirar o destaque faz o produto sair da home', async () => {
  const admin = await clienteAdmin();
  const produto = await criarProduto(admin, 'Zz Destaque Removivel');

  const antes = await admin('GET', '/api/produtos/destaques?limite=12');
  assert.ok(antes.corpo.some(item => item.id === produto.id), 'deveria estar na home');

  const desmarcado = await admin('PATCH', `/api/admin/produtos/${produto.id}`, { destaque: false });
  assert.equal(desmarcado.status, 200);

  const depois = await admin('GET', '/api/produtos/destaques?limite=12');
  assert.equal(depois.corpo.some(item => item.id === produto.id), false, 'deveria ter saido da home');
});

test('a home mostra todos os destaques, nao so os 3 primeiros', async () => {
  const admin = await clienteAdmin();

  // O catalogo semeado ja tem 3 destaques: com mais 4 a home passa de 3 com folga.
  const novos = [];
  for (let i = 1; i <= 4; i += 1) {
    novos.push(await criarProduto(admin, `Zz Destaque Extra ${i}`));
  }

  const home = await admin('GET', '/api/produtos/destaques');
  assert.equal(home.status, 200);
  assert.ok(home.corpo.length > 3, 'a home nao pode cortar em 3 destaques');

  const ids = home.corpo.map(produto => produto.id);
  for (const novo of novos) {
    assert.ok(ids.includes(novo.id), `"${novo.nome}" deveria aparecer na home`);
  }

  // A home traz exatamente os mesmos destaques que o catalogo filtrado.
  const catalogo = await admin('GET', '/api/produtos?destaque=true');
  assert.deepEqual([...ids].sort(), catalogo.corpo.map(produto => produto.id).sort());
});

test('o limite de destaques e opcional e fica dentro do teto', async () => {
  const requisitar = criarCliente();

  const dois = await requisitar('GET', '/api/produtos/destaques?limite=2');
  assert.equal(dois.corpo.length, 2, 'limite explicito continua valendo');

  const zero = await requisitar('GET', '/api/produtos/destaques?limite=0');
  assert.equal(zero.corpo.length, 1, 'limite abaixo de 1 vira 1');

  const enorme = await requisitar('GET', '/api/produtos/destaques?limite=99999');
  assert.equal(enorme.status, 200);
  assert.ok(enorme.corpo.length <= 100, 'limite acima do teto e cortado em 100');
});

test('as respostas da API nao podem vir do cache do navegador', async () => {
  const requisitar = criarCliente();

  // Sem Cache-Control explicito o navegador guarda o JSON por conta propria
  // (cache heuristico) e o produto novo so aparece depois de limpar o cache.
  for (const caminho of ['/api/produtos', '/api/produtos/destaques', '/api/status']) {
    const resposta = await requisitar('GET', caminho);
    assert.equal(resposta.status, 200, `${caminho} deveria responder`);
    assert.equal(resposta.headers.get('cache-control'), 'no-store', `${caminho} nao pode ser cacheado`);
  }
});

test('os estaticos sem hash revalidam sempre (nada de JS preso no navegador)', async () => {
  const requisitar = criarCliente();

  /*
   * A politica decide pelo NOME do arquivo, nao pelo ambiente (ver
   * src/utils/cache.js). Estes arquivos sao servidos direto de `public/`, sem
   * build, e portanto sem hash no nome: ficam em `no-cache` (= revalide antes
   * de usar), que custa um 304 barato e garante que o arquivo alterado chegue
   * na primeira visita seguinte.
   *
   * O `max-age` longo so entra para arquivo COM hash de conteudo, e esse caso
   * e coberto em "o build gera assets com hash e o cache longo so para eles".
   */
  for (const caminho of ['/js/home.js', '/js/api.js', '/js/produtos.js', '/css/home.css', '/index.html']) {
    const resposta = await requisitar('GET', caminho);
    assert.equal(resposta.status, 200, `${caminho} deveria ser servido`);
    assert.equal(resposta.headers.get('cache-control'), 'no-cache', `${caminho} deveria revalidar`);
    assert.equal(
      /max-age/.test(resposta.headers.get('cache-control') || ''),
      false,
      `${caminho} nao tem hash de conteudo, entao nao pode ter max-age`
    );
  }
});

/*
 * O HTML e o arquivo que APONTA para os assets. Se ele tambem fosse cacheado
 * por um ano, um deploy novo nao chegaria a ninguem: o navegador seguiria
 * apontando para os nomes antigos, que continuam no disco.
 */
test('o HTML revalida, mesmo servindo de uma pagina que o build gerou', async () => {
  const requisitar = criarCliente();

  for (const caminho of ['/', '/login', '/produtos', '/admin', '/conta']) {
    const resposta = await requisitar('GET', caminho);
    assert.equal(resposta.status, 200, `${caminho} deveria responder`);
    assert.equal(
      resposta.headers.get('cache-control'),
      'no-cache',
      `${caminho} e o HTML: precisa revalidar para entregar o ponteiro novo`
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Backfill do estoque em bancos que ja existiam                             */
/* -------------------------------------------------------------------------- */

/*
 * Este teste fica no FIM de proposito: ele apaga o estoque inteiro para simular
 * um banco criado antes da tabela de chaves. Rodar isso no meio da suite
 * quebraria os testes de checkout, que dependem de haver chaves no pool.
 */
test('o backfill repoe o estoque de um catalogo que existia antes das chaves', () => {
  // Depois da semeadura normal, o estoque ja existe: nao ha o que repor.
  assert.equal(estoqueNuncaInicializado(), false, 'com chaves no pool nao deve repor');

  // Simula o cenario de upgrade: catalogo cheio, pool vazio, nenhum movimento.
  const banco = conectar();
  banco.prepare('DELETE FROM estoque_chaves').run();
  banco.prepare('DELETE FROM estoque_movimentos').run();

  assert.equal(estoqueNuncaInicializado(), true, 'pool vazio e sem historico deve pedir backfill');

  const resultado = garantirEstoqueInicial();
  assert.ok(resultado.chaves > 0, 'o backfill deveria gerar chaves');
  assert.equal(estoqueRepo.contarChaves({ status: 'disponivel' }), resultado.chaves);

  // Depois do backfill o pool nao esta mais vazio.
  assert.equal(estoqueNuncaInicializado(), false);

  // E o backfill e idempotente: rodar de novo nao duplica chaves.
  const antes = estoqueRepo.contarChaves({});
  garantirEstoqueInicial();
  assert.equal(estoqueRepo.contarChaves({}), antes, 'nao deve duplicar chaves ja existentes');
});

test('o backfill respeita um estoque esvaziado de proposito pelo admin', () => {
  const banco = conectar();
  banco.prepare('DELETE FROM estoque_chaves').run();
  banco.prepare('DELETE FROM estoque_movimentos').run();

  // O admin descarta chaves: existe movimento registrado, entao o pool nao esta
  // "nunca inicializado" — o backfill nao pode repor por cima da decisao dele.
  const produto = banco.prepare('SELECT id FROM produtos LIMIT 1').get();
  const plano = banco.prepare('SELECT id FROM planos WHERE produto_id = ? LIMIT 1').get(produto.id);

  estoqueRepo.registrarMovimento({
    produtoId: produto.id,
    planoId: plano.id,
    tipo: 'descarte',
    quantidade: 1,
    motivo: 'Teste: estoque zerado de proposito',
    atorId: null
  });

  assert.equal(estoqueNuncaInicializado(), false, 'com historico de movimentos nao deve repor');
});
