// "Banco" em memória - reseta toda vez que o servidor reinicia
const crypto = require('crypto');
const { v4: uuid } = require('uuid');

const SESSAO_DURACAO_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

// ---------- Utilitários ----------

// Minúsculas e sem acentos, para comparações tolerantes ("otimizacao" == "Otimização")
function normalizarTexto(valor) {
  return String(valor == null ? '' : valor)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

function normalizarEmail(valor) {
  return typeof valor === 'string' ? valor.trim().toLowerCase() : '';
}

// UUID v4 estável derivado do slug: o id sobrevive a reinícios do servidor,
// então o carrinho salvo no navegador continua válido
function idEstavel(slug) {
  const bytes = crypto.createHash('sha256').update(`loja:produto:${slug}`).digest().subarray(0, 16);
  return uuid({ random: bytes });
}

// ---------- Produtos ----------
// Para trocar o catálogo, edite só esta lista.
// capa.icone: raio | mira | teclado | camadas | vassoura | chip | sinal | escudo
// imagem: caminho opcional (ex.: '/img/produtos/meu-produto.png'); sem imagem, o site gera a capa.

const PLANOS = (dia, semana, mes, vitalicio) => [
  dia != null && { id: '1d', nome: '1 dia', preco: dia },
  semana != null && { id: '7d', nome: '7 dias', preco: semana },
  mes != null && { id: '30d', nome: '30 dias', preco: mes },
  vitalicio != null && { id: 'vitalicio', nome: 'Vitalício', preco: vitalicio }
].filter(Boolean);

const CATALOGO = [
  {
    slug: 'fps-booster-basic',
    nome: 'FPS Booster - Basic',
    linha: 'FPS Booster',
    nivel: 'Basic',
    categoria: 'Otimização',
    descricao: 'Ajustes essenciais de sistema para ganhar quadros e reduzir travadas em poucos cliques.',
    recursos: ['Perfis prontos por jogo', 'Limpeza de processos em segundo plano', 'Plano de energia otimizado'],
    capa: { icone: 'raio' },
    badge: 'Mais vendido',
    avaliacao: 5.0,
    avaliacoes: 1284,
    destaque: true,
    planos: PLANOS(9.99, 29.99, 59.99, null)
  },
  {
    slug: 'fps-booster-advanced',
    nome: 'FPS Booster - Advanced',
    linha: 'FPS Booster',
    nivel: 'Advanced',
    categoria: 'Otimização',
    descricao: 'Tudo do Basic com ajustes de GPU, timer de sistema e prioridade dinâmica de processos.',
    recursos: ['Tudo do Basic', 'Ajustes avançados de GPU', 'Monitor de FPS em tempo real'],
    capa: { icone: 'raio' },
    badge: 'Atualizado',
    avaliacao: 5.0,
    avaliacoes: 842,
    destaque: true,
    planos: PLANOS(14.99, 44.99, 89.99, null)
  },
  {
    slug: 'fps-booster-pro',
    nome: 'FPS Booster - Pro',
    linha: 'FPS Booster',
    nivel: 'Pro',
    categoria: 'Otimização',
    descricao: 'Licença vitalícia com todos os módulos, atualizações para sempre e suporte prioritário.',
    recursos: ['Todos os módulos', 'Atualizações vitalícias', 'Suporte prioritário'],
    capa: { icone: 'raio' },
    badge: 'Vitalício',
    avaliacao: 5.0,
    avaliacoes: 391,
    destaque: true,
    planos: PLANOS(null, null, null, 249.9)
  },
  {
    slug: 'input-lag-fix',
    nome: 'Input Lag Fix',
    linha: 'Input Lag',
    nivel: 'Fix',
    categoria: 'Otimização',
    descricao: 'Reduz o atraso entre o clique e a ação na tela ajustando mouse, teclado e USB.',
    recursos: ['Taxa de polling otimizada', 'Ajustes de USB', 'Teste de latência integrado'],
    capa: { icone: 'mira' },
    badge: null,
    avaliacao: 4.9,
    avaliacoes: 517,
    destaque: false,
    planos: PLANOS(null, 19.99, 39.99, 119.9)
  },
  {
    slug: 'macro-studio-basic',
    nome: 'Macro Studio - Basic',
    linha: 'Macro Studio',
    nivel: 'Basic',
    categoria: 'Macros',
    descricao: 'Grave e reproduza sequências de teclas com editor visual simples e atalhos personalizados.',
    recursos: ['Editor visual', 'Até 20 macros', 'Atalhos globais'],
    capa: { icone: 'teclado' },
    badge: null,
    avaliacao: 4.8,
    avaliacoes: 266,
    destaque: false,
    planos: PLANOS(7.99, 24.99, 49.99, null)
  },
  {
    slug: 'macro-studio-pro',
    nome: 'Macro Studio - Pro',
    linha: 'Macro Studio',
    nivel: 'Pro',
    categoria: 'Macros',
    descricao: 'Macros ilimitadas, perfis por aplicativo e sincronização entre computadores.',
    recursos: ['Macros ilimitadas', 'Perfis por aplicativo', 'Sincronização na nuvem'],
    capa: { icone: 'teclado' },
    badge: 'Novo',
    avaliacao: 5.0,
    avaliacoes: 148,
    destaque: false,
    planos: PLANOS(null, 39.99, 79.99, 199.9)
  },
  {
    slug: 'crosshair-overlay',
    nome: 'Crosshair Overlay',
    linha: 'Crosshair',
    nivel: 'Overlay',
    categoria: 'Visual',
    descricao: 'Mira personalizável sobre qualquer jogo em janela, com mais de 50 estilos e cores.',
    recursos: ['50+ estilos de mira', 'Cores e tamanhos livres', 'Perfis por jogo'],
    capa: { icone: 'mira' },
    badge: null,
    avaliacao: 4.9,
    avaliacoes: 733,
    destaque: false,
    planos: PLANOS(null, 14.99, 29.99, 89.9)
  },
  {
    slug: 'stream-overlay-pack',
    nome: 'Stream Overlay Pack',
    linha: 'Stream',
    nivel: 'Overlay',
    categoria: 'Visual',
    descricao: 'Pacote de overlays, alertas e telas de transição prontos para OBS e Streamlabs.',
    recursos: ['30 cenas prontas', 'Alertas animados', 'Arquivos editáveis'],
    capa: { icone: 'camadas' },
    badge: null,
    avaliacao: 4.8,
    avaliacoes: 204,
    destaque: false,
    planos: PLANOS(null, null, null, 69.9)
  },
  {
    slug: 'system-cleaner',
    nome: 'System Cleaner',
    linha: 'System',
    nivel: 'Cleaner',
    categoria: 'Utilitários',
    descricao: 'Remove arquivos temporários, caches esquecidos e itens que atrasam a inicialização.',
    recursos: ['Limpeza profunda', 'Gerenciador de inicialização', 'Agendamento automático'],
    capa: { icone: 'vassoura' },
    badge: null,
    avaliacao: 4.9,
    avaliacoes: 452,
    destaque: false,
    planos: PLANOS(null, 12.99, 24.99, 79.9)
  },
  {
    slug: 'driver-updater',
    nome: 'Driver Updater',
    linha: 'Driver',
    nivel: 'Updater',
    categoria: 'Utilitários',
    descricao: 'Encontra e instala drivers atualizados de vídeo, áudio e rede com ponto de restauração.',
    recursos: ['Verificação automática', 'Ponto de restauração', 'Downloads oficiais'],
    capa: { icone: 'chip' },
    badge: 'Atualizado',
    avaliacao: 4.8,
    avaliacoes: 319,
    destaque: false,
    planos: PLANOS(null, null, 34.99, 99.9)
  }
];

function montarProduto(dados) {
  const precos = dados.planos.map(p => p.preco);
  return {
    id: idEstavel(dados.slug),
    slug: dados.slug,
    nome: dados.nome,
    linha: dados.linha,
    nivel: dados.nivel,
    categoria: dados.categoria,
    descricao: dados.descricao,
    recursos: dados.recursos || [],
    capa: dados.capa || { icone: 'raio' },
    imagem: dados.imagem || null,
    badge: dados.badge || null,
    avaliacao: dados.avaliacao,
    avaliacoes: dados.avaliacoes,
    plataforma: dados.plataforma || 'Windows',
    entrega: 'Automática',
    destaque: dados.destaque === true,
    planos: dados.planos,
    precoMin: Math.min(...precos),
    precoMax: Math.max(...precos)
  };
}

const produtos = CATALOGO.map(montarProduto);

// Categorias na ordem em que aparecem no catálogo, com a contagem de produtos
function listarCategorias() {
  const mapa = new Map();
  produtos.forEach(p => mapa.set(p.categoria, (mapa.get(p.categoria) || 0) + 1));
  return [...mapa.entries()].map(([nome, total]) => ({ nome, total }));
}

// Chave de licença entregue após a compra: ABCD-1234-EF56-7890
function gerarChave() {
  return crypto.randomBytes(8).toString('hex').toUpperCase().match(/.{4}/g).join('-');
}

// ---------- Usuários e senhas ----------

const usuarios = [];

// scrypt + salt aleatório por usuário
function gerarHashSenha(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(senha), salt, 64).toString('hex');
  return { salt, hash };
}

function verificarSenha(senha, salt, hash) {
  const calculado = crypto.scryptSync(String(senha), salt, 64);
  const esperado = Buffer.from(hash, 'hex');
  // timingSafeEqual exige buffers do mesmo tamanho
  if (calculado.length !== esperado.length) return false;
  return crypto.timingSafeEqual(calculado, esperado);
}

// Hash "de mentira" usado quando o e-mail não existe, para o tempo de resposta
// não revelar quais e-mails estão cadastrados
const HASH_FICTICIO = gerarHashSenha(crypto.randomBytes(16).toString('hex'));

function verificarSenhaFicticia(senha) {
  verificarSenha(senha, HASH_FICTICIO.salt, HASH_FICTICIO.hash);
  return false;
}

function criarUsuario({ nome, email, senha }) {
  const { salt, hash } = gerarHashSenha(senha);
  const usuario = {
    id: uuid(),
    nome,
    email: normalizarEmail(email),
    salt,
    hash,
    criadoEm: new Date().toISOString()
  };
  usuarios.push(usuario);
  return usuario;
}

function buscarUsuarioPorEmail(email) {
  const alvo = normalizarEmail(email);
  if (!alvo) return null;
  return usuarios.find(u => u.email === alvo) || null;
}

function buscarUsuarioPorId(id) {
  return usuarios.find(u => u.id === id) || null;
}

// Só o que pode ir para o front (nunca hash/salt)
function usuarioPublico(usuario) {
  return { id: usuario.id, nome: usuario.nome, email: usuario.email };
}

// Conta demo - apenas para estudo
criarUsuario({ nome: 'Cliente Demo', email: 'demo@loja.com', senha: 'demo123' });

// ---------- Sessões ----------

// sid -> { usuarioId, expira (timestamp em ms) }
const sessoes = new Map();

function criarSessao(usuarioId) {
  const sid = crypto.randomBytes(32).toString('hex');
  sessoes.set(sid, { usuarioId, expira: Date.now() + SESSAO_DURACAO_MS });
  return sid;
}

// Sessão expirada conta como inexistente (e é apagada)
function buscarSessao(sid) {
  const sessao = sessoes.get(sid);
  if (!sessao) return null;
  if (sessao.expira <= Date.now()) {
    sessoes.delete(sid);
    return null;
  }
  return sessao;
}

function removerSessao(sid) {
  sessoes.delete(sid);
}

// Faxina de sessões expiradas a cada hora (unref: não segura o processo aberto)
setInterval(() => {
  const agora = Date.now();
  for (const [sid, sessao] of sessoes) {
    if (sessao.expira <= agora) sessoes.delete(sid);
  }
}, 60 * 60 * 1000).unref();

// ---------- Vendas ----------

const vendas = [];

module.exports = {
  SESSAO_DURACAO_MS,
  produtos,
  usuarios,
  sessoes,
  vendas,
  normalizarTexto,
  normalizarEmail,
  listarCategorias,
  gerarChave,
  verificarSenha,
  verificarSenhaFicticia,
  criarUsuario,
  buscarUsuarioPorEmail,
  buscarUsuarioPorId,
  usuarioPublico,
  criarSessao,
  buscarSessao,
  removerSessao
};
