/*
 * gateways/catalogo.js
 * -----------------------------------------------------------------------------
 * O "cardapio" de gateways de pagamento suportados. E DADO, nao codigo de
 * integracao: descreve para o painel (e para o proprio sistema) quais
 * provedores existem, quais formas de pagamento cada um aceita e quais
 * credenciais ele exige.
 *
 * Vantagem de separar isto: a tela de Pagamentos do admin e gerada a partir
 * daqui. Adicionar um gateway novo e acrescentar um item nesta lista + um
 * modulo em src/gateways/ com a mesma interface — nada de mexer no front.
 *
 * Sobre os valores padrao: cada gateway ja nasce com os metodos e o modo
 * sugeridos ("configuracao pre-definida"). O gateway "simulado" nasce ATIVO
 * para a loja funcionar de imediato; os reais nascem prontos, porem desligados
 * ate o admin colar as credenciais (ligar um gateway sem chave nao faria nada).
 */
'use strict';

/* -------------------------------------------------------------------------- */
/* Formas de pagamento                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Catalogo das formas de pagamento que o sistema entende. O "id" e o que
 * trafega na API; o resto e apresentacao.
 */
const METODOS = {
  pix: {
    id: 'pix',
    nome: 'Pix',
    descricao: 'Aprovacao imediata',
    icone: 'raio',
    // Pix confirma na hora; boleto nao.
    imediato: true
  },
  cartao: {
    id: 'cartao',
    nome: 'Cartao de credito',
    descricao: 'Aprovacao imediata',
    icone: 'cartao',
    imediato: true
  },
  boleto: {
    id: 'boleto',
    nome: 'Boleto bancario',
    descricao: 'Liberacao apos a compensacao (1 a 3 dias uteis)',
    icone: 'boleto',
    imediato: false
  }
};

const IDS_METODOS = Object.keys(METODOS);

/* -------------------------------------------------------------------------- */
/* Campos de credencial reutilizados                                          */
/* -------------------------------------------------------------------------- */

/** Fabrica de campo de credencial, para nao repetir a mesma forma 30 vezes. */
function campo(chave, rotulo, { segredo = true, obrigatorio = true, dica = '', exemplo = '' } = {}) {
  return { chave, rotulo, segredo, obrigatorio, dica, exemplo };
}

/* -------------------------------------------------------------------------- */
/* Gateways                                                                   */
/* -------------------------------------------------------------------------- */

const GATEWAYS = [
  {
    id: 'simulado',
    nome: 'Simulador interno',
    descricao: 'Aprova Pix e cartao na hora e deixa o boleto pendente. Nao faz chamada externa — serve para desenvolvimento, demonstracao e testes.',
    site: '',
    docs: '',
    cor: '#5B7CFA',
    // Gateway de mentira: nao pede credencial nenhuma e nasce ligado.
    campos: [],
    metodos: ['pix', 'cartao', 'boleto'],
    padrao: { ativo: true, modo: 'sandbox', metodos: ['pix', 'cartao', 'boleto'] },
    // Nunca entra em modo real: e o proprio simulador.
    somenteSimulacao: true
  },
  {
    id: 'mercadopago',
    nome: 'Mercado Pago',
    descricao: 'Aceita Pix, cartao de credito e boleto. Cobranca via API de Payments e confirmacao por webhook.',
    site: 'https://www.mercadopago.com.br',
    docs: 'https://www.mercadopago.com.br/developers/pt/reference',
    cor: '#00A1E0',
    campos: [
      campo('access_token', 'Access Token', {
        dica: 'Token privado da aplicacao (Comeca com APP_USR- ou TEST-).',
        exemplo: 'APP_USR-1234567890-...'
      }),
      campo('public_key', 'Public Key', {
        segredo: false,
        obrigatorio: false,
        dica: 'Chave publica usada no checkout transparente no navegador.'
      }),
      campo('webhook_secret', 'Segredo do webhook', {
        dica: 'Assinatura secreta configurada em "Suas integracoes > Webhooks".'
      })
    ],
    metodos: ['pix', 'cartao', 'boleto'],
    padrao: { ativo: false, modo: 'sandbox', metodos: ['pix', 'cartao', 'boleto'] },
    integracao: {
      urlSandbox: 'https://api.mercadopago.com',
      urlProducao: 'https://api.mercadopago.com',
      autenticacao: 'bearer',
      campoToken: 'access_token',
      // Mercado Pago confirma por webhook assinado com HMAC-SHA256.
      assinatura: { cabecalho: 'x-signature', cabecalhoId: 'x-request-id', algoritmo: 'sha256', campoSecret: 'webhook_secret' }
    }
  },
  {
    id: 'infinitypay',
    nome: 'InfinityPay',
    descricao: 'Aceita Pix, cartao e boleto. Autenticacao Basic (user/password) na API v2 e confirmacao por webhook.',
    site: 'https://www.infinitypay.com.br',
    docs: 'https://dev.infinitypay.com.br',
    cor: '#7B2FF7',
    campos: [
      campo('api_key', 'API Key (user)', {
        dica: 'Usuario da API fornecido pela InfinityPay no painel da conta.'
      }),
      campo('api_secret', 'API Secret (password)', {
        dica: 'Senha da API. Usada como Basic Auth junto com a API Key.'
      }),
      campo('webhook_secret', 'Segredo do webhook', {
        obrigatorio: false,
        dica: 'Token combinado para validar as notificacoes recebidas.'
      })
    ],
    metodos: ['pix', 'cartao', 'boleto'],
    padrao: { ativo: false, modo: 'sandbox', metodos: ['pix', 'cartao', 'boleto'] },
    integracao: {
      urlSandbox: 'https://api-sandbox.infinitypay.com.br',
      urlProducao: 'https://api.infinitypay.com.br',
      autenticacao: 'basic',
      campoUsuario: 'api_key',
      campoSenha: 'api_secret',
      assinatura: { cabecalho: 'x-infinity-signature', algoritmo: 'sha256', campoSecret: 'webhook_secret' }
    }
  },
  {
    id: 'pagarme',
    nome: 'Pagar.me',
    descricao: 'Aceita Pix, cartao e boleto pela API v5 (orders). Confirmacao por webhook com assinatura.',
    site: 'https://pagar.me',
    docs: 'https://docs.pagar.me/reference',
    cor: '#1A6EFF',
    campos: [
      campo('secret_key', 'Secret Key', { dica: 'Chave secreta da conta (sk_test_ / sk_live_).' }),
      campo('public_key', 'Public Key', { segredo: false, obrigatorio: false, dica: 'Usada no checkout no navegador.' }),
      campo('webhook_secret', 'Segredo do webhook', { dica: 'Chave usada para validar a assinatura dos webhooks.' })
    ],
    metodos: ['pix', 'cartao', 'boleto'],
    padrao: { ativo: false, modo: 'sandbox', metodos: ['pix', 'cartao', 'boleto'] },
    integracao: {
      urlSandbox: 'https://api.pagar.me',
      urlProducao: 'https://api.pagar.me',
      autenticacao: 'basic',
      campoUsuario: 'secret_key',
      campoSenha: '',
      assinatura: { cabecalho: 'x-hub-signature-256', algoritmo: 'sha256', campoSecret: 'webhook_secret' }
    }
  },
  {
    id: 'asaas',
    nome: 'Asaas',
    descricao: 'Aceita Pix, cartao e boleto. Cobranca via API v3 e confirmacao por webhook com token.',
    site: 'https://www.asaas.com',
    docs: 'https://docs.asaas.com',
    cor: '#0B6BCB',
    campos: [
      campo('api_key', 'API Key', { dica: 'Chave de API gerada em "Integracoes > Chave de API".' }),
      campo('webhook_token', 'Token do webhook', { dica: 'Token de autenticacao definido ao criar o webhook.' })
    ],
    metodos: ['pix', 'cartao', 'boleto'],
    padrao: { ativo: false, modo: 'sandbox', metodos: ['pix', 'cartao', 'boleto'] },
    integracao: {
      urlSandbox: 'https://sandbox.asaas.com',
      urlProducao: 'https://api.asaas.com',
      autenticacao: 'header',
      campoToken: 'api_key',
      cabecalhoToken: 'access_token',
      assinatura: { cabecalho: 'asaas-access-token', algoritmo: 'literal', campoSecret: 'webhook_token' }
    }
  },
  {
    id: 'stripe',
    nome: 'Stripe',
    descricao: 'Foco em cartao internacional (Visa, Master, Amex). Cobranca via PaymentIntents e webhook assinado.',
    site: 'https://stripe.com/br',
    docs: 'https://stripe.com/docs/api',
    cor: '#635BFF',
    campos: [
      campo('secret_key', 'Secret Key', { dica: 'Chave secreta da conta (sk_test_ / sk_live_).' }),
      campo('publishable_key', 'Publishable Key', { segredo: false, obrigatorio: false, dica: 'Chave publica do checkout no navegador.' }),
      campo('webhook_secret', 'Signing Secret', { dica: 'Segredo de assinatura do endpoint de webhook (whsec_...).' })
    ],
    // Stripe nao emite boleto no Brasil via PaymentIntents padrao: so cartao.
    metodos: ['cartao'],
    padrao: { ativo: false, modo: 'sandbox', metodos: ['cartao'] },
    integracao: {
      urlSandbox: 'https://api.stripe.com',
      urlProducao: 'https://api.stripe.com',
      autenticacao: 'bearer',
      campoToken: 'secret_key',
      assinatura: { cabecalho: 'stripe-signature', algoritmo: 'stripe', campoSecret: 'webhook_secret' }
    }
  }
];

/** Indice por id, para consulta O(1). */
const POR_ID = Object.fromEntries(GATEWAYS.map(gateway => [gateway.id, gateway]));

/** Ids na ordem em que aparecem (usado no seed e no painel). */
const IDS = GATEWAYS.map(gateway => gateway.id);

/** Um gateway existe? */
function existe(id) {
  return Object.prototype.hasOwnProperty.call(POR_ID, String(id || '').toLowerCase());
}

/** Metadados de um gateway (ou null). */
function buscar(id) {
  return POR_ID[String(id || '').toLowerCase()] || null;
}

/**
 * Valida os metodos informados contra os que o gateway realmente suporta.
 * Devolve sempre uma lista limpa e sem repetidos (nunca lanca).
 */
function filtrarMetodos(id, metodos) {
  const gateway = buscar(id);
  if (!gateway) return [];
  const lista = Array.isArray(metodos) ? metodos : [];
  return gateway.metodos.filter(metodo => lista.map(String).includes(metodo));
}

module.exports = { METODOS, IDS_METODOS, GATEWAYS, IDS, POR_ID, existe, buscar, filtrarMetodos };
