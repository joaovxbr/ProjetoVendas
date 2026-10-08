/*
 * db/migracoes.js
 * -----------------------------------------------------------------------------
 * Evolucao do schema, versionada e idempotente. Cada migracao roda UMA vez e
 * fica registrada na tabela "migracoes". Para mudar o banco no futuro, basta
 * acrescentar um novo item no fim da lista — nunca edite uma migracao ja
 * publicada, porque ela pode ja ter rodado na maquina de outra pessoa.
 *
 *   npm run db:migrate
 */
'use strict';

const { conectar } = require('./conexao');
const { agoraISO } = require('../utils/datas');
const logger = require('../utils/logger');

const MIGRACOES = [
  {
    id: 1,
    nome: 'estrutura_inicial',
    sql: `
      -- Clientes e administradores -----------------------------------------
      CREATE TABLE usuarios (
        id            TEXT PRIMARY KEY,
        nome          TEXT NOT NULL,
        email         TEXT NOT NULL UNIQUE,
        senha_salt    TEXT NOT NULL,
        senha_hash    TEXT NOT NULL,
        papel         TEXT NOT NULL DEFAULT 'cliente' CHECK (papel IN ('cliente', 'admin')),
        ativo         INTEGER NOT NULL DEFAULT 1,
        criado_em     TEXT NOT NULL,
        atualizado_em TEXT NOT NULL,
        ultimo_login_em TEXT
      );
      CREATE INDEX idx_usuarios_papel ON usuarios(papel);

      -- Sessoes (cookie "sid") ---------------------------------------------
      CREATE TABLE sessoes (
        sid         TEXT PRIMARY KEY,
        usuario_id  TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        criada_em   TEXT NOT NULL,
        expira_em   TEXT NOT NULL,
        persistente INTEGER NOT NULL DEFAULT 1,
        ip          TEXT,
        user_agent  TEXT
      );
      CREATE INDEX idx_sessoes_usuario ON sessoes(usuario_id);
      CREATE INDEX idx_sessoes_expira ON sessoes(expira_em);

      -- Recuperacao de senha ------------------------------------------------
      CREATE TABLE tokens_senha (
        token_hash TEXT PRIMARY KEY,
        usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        criado_em  TEXT NOT NULL,
        expira_em  TEXT NOT NULL,
        usado_em   TEXT
      );
      CREATE INDEX idx_tokens_usuario ON tokens_senha(usuario_id);

      -- Catalogo ------------------------------------------------------------
      CREATE TABLE produtos (
        id            TEXT PRIMARY KEY,
        slug          TEXT NOT NULL UNIQUE,
        nome          TEXT NOT NULL,
        linha         TEXT NOT NULL DEFAULT '',
        nivel         TEXT NOT NULL DEFAULT '',
        categoria     TEXT NOT NULL,
        -- Copia normalizada da categoria (minuscula, sem acentos). Permite
        -- filtrar por "otimizacao" e achar "Otimização" sem perder o acento
        -- na hora de exibir.
        categoria_busca TEXT NOT NULL DEFAULT '',
        descricao     TEXT NOT NULL DEFAULT '',
        recursos      TEXT NOT NULL DEFAULT '[]',
        capa          TEXT NOT NULL DEFAULT '{}',
        imagem        TEXT,
        badge         TEXT,
        plataforma    TEXT NOT NULL DEFAULT 'Windows',
        entrega       TEXT NOT NULL DEFAULT 'Automatica',
        destaque      INTEGER NOT NULL DEFAULT 0,
        ativo         INTEGER NOT NULL DEFAULT 1,
        ordem         INTEGER NOT NULL DEFAULT 0,
        nota_base     REAL NOT NULL DEFAULT 0,
        total_base    INTEGER NOT NULL DEFAULT 0,
        -- Texto de busca ja normalizado (minusculo, sem acentos). Mantido pela
        -- aplicacao para que a busca ignore acentuacao e maiusculas.
        busca         TEXT NOT NULL DEFAULT '',
        criado_em     TEXT NOT NULL,
        atualizado_em TEXT NOT NULL
      );
      CREATE INDEX idx_produtos_categoria ON produtos(categoria_busca, ativo);
      CREATE INDEX idx_produtos_destaque ON produtos(destaque, ativo);
      CREATE INDEX idx_produtos_busca ON produtos(busca);

      CREATE TABLE planos (
        produto_id     TEXT NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
        id             TEXT NOT NULL,
        nome           TEXT NOT NULL,
        preco_centavos INTEGER NOT NULL CHECK (preco_centavos >= 0),
        dias           INTEGER,
        ordem          INTEGER NOT NULL DEFAULT 0,
        ativo          INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (produto_id, id)
      );

      -- Cupons ---------------------------------------------------------------
      CREATE TABLE cupons (
        codigo          TEXT PRIMARY KEY,
        tipo            TEXT NOT NULL CHECK (tipo IN ('percentual', 'fixo')),
        valor           INTEGER NOT NULL CHECK (valor >= 0),
        minimo_centavos INTEGER NOT NULL DEFAULT 0,
        max_usos        INTEGER,
        usos            INTEGER NOT NULL DEFAULT 0,
        expira_em       TEXT,
        ativo           INTEGER NOT NULL DEFAULT 1,
        descricao       TEXT NOT NULL DEFAULT '',
        criado_em       TEXT NOT NULL
      );

      -- Pedidos --------------------------------------------------------------
      CREATE TABLE vendas (
        id                 TEXT PRIMARY KEY,
        numero             TEXT NOT NULL UNIQUE,
        usuario_id         TEXT NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
        status             TEXT NOT NULL DEFAULT 'pago'
                             CHECK (status IN ('pendente', 'pago', 'cancelado', 'reembolsado')),
        subtotal_centavos  INTEGER NOT NULL CHECK (subtotal_centavos >= 0),
        desconto_centavos  INTEGER NOT NULL DEFAULT 0 CHECK (desconto_centavos >= 0),
        total_centavos     INTEGER NOT NULL CHECK (total_centavos >= 0),
        cupom_codigo       TEXT REFERENCES cupons(codigo) ON DELETE SET NULL,
        metodo_pagamento   TEXT NOT NULL,
        provedor_pagamento TEXT NOT NULL DEFAULT 'simulado',
        pagamento_id       TEXT,
        pagamento_status   TEXT NOT NULL DEFAULT 'aprovado',
        pago_em            TEXT,
        criado_em          TEXT NOT NULL,
        atualizado_em      TEXT NOT NULL
      );
      CREATE INDEX idx_vendas_usuario ON vendas(usuario_id, criado_em DESC);
      CREATE INDEX idx_vendas_status ON vendas(status, criado_em DESC);

      CREATE TABLE venda_itens (
        id                TEXT PRIMARY KEY,
        venda_id          TEXT NOT NULL REFERENCES vendas(id) ON DELETE CASCADE,
        produto_id        TEXT NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
        produto_nome      TEXT NOT NULL,
        plano_id          TEXT NOT NULL,
        plano_nome        TEXT NOT NULL,
        preco_centavos    INTEGER NOT NULL CHECK (preco_centavos >= 0),
        quantidade        INTEGER NOT NULL CHECK (quantidade > 0),
        subtotal_centavos INTEGER NOT NULL CHECK (subtotal_centavos >= 0)
      );
      CREATE INDEX idx_itens_venda ON venda_itens(venda_id);
      CREATE INDEX idx_itens_produto ON venda_itens(produto_id);

      -- Licencas entregues ---------------------------------------------------
      CREATE TABLE licencas (
        id            TEXT PRIMARY KEY,
        chave         TEXT NOT NULL UNIQUE,
        venda_id      TEXT NOT NULL REFERENCES vendas(id) ON DELETE CASCADE,
        venda_item_id TEXT NOT NULL REFERENCES venda_itens(id) ON DELETE CASCADE,
        usuario_id    TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        produto_id    TEXT NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
        plano_id      TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'ativa'
                        CHECK (status IN ('ativa', 'resgatada', 'revogada')),
        expira_em     TEXT,
        resgatada_em  TEXT,
        criada_em     TEXT NOT NULL
      );
      CREATE INDEX idx_licencas_usuario ON licencas(usuario_id, criada_em DESC);
      CREATE INDEX idx_licencas_produto ON licencas(produto_id);

      -- Avaliacoes -----------------------------------------------------------
      CREATE TABLE avaliacoes (
        id            TEXT PRIMARY KEY,
        produto_id    TEXT NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
        usuario_id    TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        venda_id      TEXT REFERENCES vendas(id) ON DELETE SET NULL,
        nota          INTEGER NOT NULL CHECK (nota BETWEEN 1 AND 5),
        comentario    TEXT NOT NULL DEFAULT '',
        criado_em     TEXT NOT NULL,
        atualizado_em TEXT NOT NULL,
        UNIQUE (produto_id, usuario_id)
      );
      CREATE INDEX idx_avaliacoes_produto ON avaliacoes(produto_id, criado_em DESC);

      -- Lista de desejos -----------------------------------------------------
      CREATE TABLE favoritos (
        usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        produto_id TEXT NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
        criado_em  TEXT NOT NULL,
        PRIMARY KEY (usuario_id, produto_id)
      );

      -- Trilha de auditoria --------------------------------------------------
      CREATE TABLE auditoria (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ator_id     TEXT,
        acao        TEXT NOT NULL,
        entidade    TEXT,
        entidade_id TEXT,
        dados       TEXT,
        ip          TEXT,
        criado_em   TEXT NOT NULL
      );
      CREATE INDEX idx_auditoria_entidade ON auditoria(entidade, entidade_id);
      CREATE INDEX idx_auditoria_criado ON auditoria(criado_em DESC);
    `
  },
  {
    id: 2,
    nome: 'configuracoes_da_loja',
    sql: `
      -- Pares chave/valor editaveis pelo admin (nome da loja, aviso do topo,
      -- modo manutencao...). Evita criar uma coluna nova para cada ajuste.
      CREATE TABLE configuracoes (
        chave         TEXT PRIMARY KEY,
        valor         TEXT NOT NULL,
        atualizado_em TEXT NOT NULL
      );
    `
  },
  {
    id: 3,
    nome: 'descricao_longa_do_produto',
    sql: `
      -- Descricao completa, exibida no modal de detalhes da vitrine. Separada da
      -- "descricao" curta (que aparece no card e entra na busca) porque esta pode
      -- ser bem maior e com quebras de linha. Vazia por padrao: o modal cai na
      -- descricao curta quando o admin ainda nao escreveu a longa.
      ALTER TABLE produtos ADD COLUMN descricao_longa TEXT NOT NULL DEFAULT '';
    `
  },
  {
    id: 4,
    nome: 'estoque_de_chaves',
    sql: `
      -- Ate aqui a chave da licenca era inventada na hora da compra. Isso nao
      -- permite controlar estoque: nao da para "acabar" o que se cria do nada.
      -- Agora as chaves existem ANTES da venda, num pool (estoque_chaves). Na
      -- compra, o checkout CONSOME as chaves disponiveis; sem chave, a venda e
      -- bloqueada. A licenca entregue ao cliente passa a apontar para a chave
      -- que ja estava no pool.

      CREATE TABLE estoque_chaves (
        id            TEXT PRIMARY KEY,
        produto_id    TEXT NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
        plano_id      TEXT NOT NULL,
        chave         TEXT NOT NULL UNIQUE,
        status        TEXT NOT NULL DEFAULT 'disponivel'
                        CHECK (status IN ('disponivel', 'vendida', 'descartada', 'revogada')),
        venda_id      TEXT REFERENCES vendas(id) ON DELETE SET NULL,
        venda_item_id TEXT REFERENCES venda_itens(id) ON DELETE SET NULL,
        lote          TEXT NOT NULL DEFAULT '',
        criada_em     TEXT NOT NULL,
        vendida_em    TEXT
      );
      -- Consulta mais frequente do sistema: "quantas chaves disponiveis deste
      -- plano?" e "me da as N mais antigas para vender" (FIFO).
      CREATE INDEX idx_estoque_disponivel ON estoque_chaves(produto_id, plano_id, status);
      CREATE INDEX idx_estoque_venda ON estoque_chaves(venda_id);

      -- Livro-caixa do estoque: toda entrada/saida fica registrada. Serve para o
      -- historico do painel e para explicar de onde veio (ou para onde foi) cada
      -- unidade. quantidade e sempre positiva; o "tipo" diz o sinal.
      CREATE TABLE estoque_movimentos (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        produto_id TEXT NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
        plano_id   TEXT NOT NULL,
        tipo       TEXT NOT NULL CHECK (tipo IN ('entrada', 'saida', 'descarte', 'revogacao')),
        quantidade INTEGER NOT NULL CHECK (quantidade > 0),
        motivo     TEXT NOT NULL DEFAULT '',
        ator_id    TEXT REFERENCES usuarios(id) ON DELETE SET NULL,
        criado_em  TEXT NOT NULL
      );
      CREATE INDEX idx_movimentos_plano ON estoque_movimentos(produto_id, plano_id, criado_em DESC);
      CREATE INDEX idx_movimentos_criado ON estoque_movimentos(criado_em DESC);

      -- Ponto de reposicao por plano: quando o disponivel cai ate este numero, o
      -- painel acende o alerta de estoque baixo. 0 = sem alerta configurado.
      ALTER TABLE planos ADD COLUMN estoque_minimo INTEGER NOT NULL DEFAULT 0;
    `
  },
  {
    id: 5,
    nome: 'atividades_e_preferencias_do_cliente',
    sql: `
      -- Historico de atividades do CLIENTE.
      --
      -- Nao confundir com a tabela "auditoria": aquela e a trilha do ADMIN (quem
      -- mudou o que no sistema, para responsabilizar). Esta e a linha do tempo do
      -- proprio cliente ("o que eu fiz na loja"), mostrada no painel /conta. Por
      -- isso o texto ja fica pronto para exibir (titulo/descricao), em vez de
      -- guardar so um codigo de acao.
      CREATE TABLE atividades (
        id            TEXT PRIMARY KEY,
        usuario_id    TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        tipo          TEXT NOT NULL,
        titulo        TEXT NOT NULL,
        descricao     TEXT NOT NULL DEFAULT '',
        referencia_id TEXT,
        ip            TEXT,
        criado_em     TEXT NOT NULL
      );
      -- Consulta da tela: "minhas atividades, mais recentes primeiro".
      CREATE INDEX idx_atividades_usuario ON atividades(usuario_id, criado_em DESC);
      CREATE INDEX idx_atividades_tipo ON atividades(usuario_id, tipo);

      -- Preferencias do cliente. Ficam como colunas na propria "usuarios" porque
      -- sao poucas e 1:1 com a conta; uma tabela separada so somaria um JOIN.
      -- Nascem LIGADAS: o cliente ja entra recebendo os avisos e pode desligar.
      ALTER TABLE usuarios ADD COLUMN pref_aviso_licenca INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE usuarios ADD COLUMN pref_novidades_email INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE usuarios ADD COLUMN pref_resumo_compras INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE usuarios ADD COLUMN pref_tema TEXT NOT NULL DEFAULT 'escuro'
        CHECK (pref_tema IN ('escuro', 'claro'));
    `
  },
  {
    id: 6,
    nome: 'gateways_de_pagamento',
    sql: `
      -- Configuracao dos gateways de pagamento (Mercado Pago, InfinityPay,
      -- Pagar.me, Asaas, Stripe e o simulador interno).
      --
      -- Antes desta versao o provedor era fixo no .env (PAGAMENTO_PROVEDOR) e
      -- nao havia credenciais no sistema. Agora o ADMIN escolhe, em tempo de
      -- execucao, quais gateways estao ligados, em que modo (sandbox/producao)
      -- e quais formas de pagamento cada um aceita.
      --
      -- credenciais guarda um JSON CIFRADO com AES-256-GCM (utils/cripto.js).
      -- Nunca e devolvido em texto puro pela API: o painel recebe so uma versao
      -- mascarada. Texto vazio significa "sem credenciais configuradas".
      CREATE TABLE gateways (
        id            TEXT PRIMARY KEY,
        ativo         INTEGER NOT NULL DEFAULT 0,
        modo          TEXT NOT NULL DEFAULT 'sandbox' CHECK (modo IN ('sandbox', 'producao')),
        -- Formas de pagamento habilitadas NESTE gateway (JSON: ["pix","boleto"]).
        metodos       TEXT NOT NULL DEFAULT '[]',
        -- Credenciais cifradas. '' quando nada foi salvo ainda.
        credenciais   TEXT NOT NULL DEFAULT '',
        -- Desempate quando dois gateways aceitam a mesma forma: maior vence.
        prioridade    INTEGER NOT NULL DEFAULT 0,
        atualizado_em TEXT NOT NULL
      );
      CREATE INDEX idx_gateways_ativo ON gateways(ativo, prioridade DESC);

      -- Registro de cada notificacao recebida dos gateways (webhook). Serve
      -- para duas coisas: idempotencia (nao confirmar o mesmo pagamento duas
      -- vezes) e auditoria ("o gateway avisou que pagou?").
      CREATE TABLE pagamentos_eventos (
        id          TEXT PRIMARY KEY,
        gateway_id  TEXT NOT NULL,
        referencia  TEXT,
        pagamento_id TEXT,
        status      TEXT NOT NULL DEFAULT 'recebido',
        valido      INTEGER NOT NULL DEFAULT 0,
        motivo      TEXT NOT NULL DEFAULT '',
        payload     TEXT,
        ip          TEXT,
        criado_em   TEXT NOT NULL
      );
      CREATE INDEX idx_pag_eventos_ref ON pagamentos_eventos(referencia, criado_em DESC);
      CREATE INDEX idx_pag_eventos_gateway ON pagamentos_eventos(gateway_id, criado_em DESC);
    `
  },
  {
    id: 7,
    nome: 'instrucoes_de_pagamento_do_pedido',
    sql: `
      -- Guarda as instrucoes de pagamento (Pix copia-e-cola, linha digitavel do
      -- boleto, link do gateway) no proprio pedido.
      --
      -- Sem isso, quem fecha o carrinho com boleto perde o codigo para sempre:
      -- a instrucao so existia na resposta do checkout. Com a coluna, o cliente
      -- reabre o pedido em /conta e paga de novo se precisar.
      --
      -- Fica NULL em pedidos ja pagos e nos criados antes desta versao.
      ALTER TABLE vendas ADD COLUMN instrucoes_pagamento TEXT;
    `
  }
];

/** Cria a tabela de controle se ainda nao existir. */
function prepararControle(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migracoes (
      id          INTEGER PRIMARY KEY,
      nome        TEXT NOT NULL,
      aplicada_em TEXT NOT NULL
    );
  `);
}

/**
 * Aplica todas as migracoes pendentes, na ordem.
 * @returns {number} quantas migracoes foram aplicadas nesta chamada
 */
function migrar() {
  const db = conectar();
  prepararControle(db);

  const aplicadas = new Set(db.prepare('SELECT id FROM migracoes').all().map(linha => linha.id));
  const registrar = db.prepare('INSERT INTO migracoes (id, nome, aplicada_em) VALUES (?, ?, ?)');
  let total = 0;

  for (const migracao of MIGRACOES) {
    if (aplicadas.has(migracao.id)) continue;

    // Schema + registro andam juntos: se o SQL falhar, nada fica pela metade.
    db.transaction(() => {
      db.exec(migracao.sql);
      registrar.run(migracao.id, migracao.nome, agoraISO());
    })();

    logger.info('Migracao aplicada', { id: migracao.id, nome: migracao.nome });
    total += 1;
  }

  if (total === 0) logger.debug('Banco ja esta atualizado');
  return total;
}

/** Lista as migracoes conhecidas e se ja rodaram (usado pelo /api/status). */
function situacao() {
  const db = conectar();
  prepararControle(db);
  const aplicadas = new Map(
    db.prepare('SELECT id, aplicada_em FROM migracoes').all().map(linha => [linha.id, linha.aplicada_em])
  );
  return MIGRACOES.map(migracao => ({
    id: migracao.id,
    nome: migracao.nome,
    aplicada: aplicadas.has(migracao.id),
    aplicadaEm: aplicadas.get(migracao.id) || null
  }));
}

module.exports = { MIGRACOES, migrar, situacao };
