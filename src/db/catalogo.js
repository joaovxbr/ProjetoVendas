/*
 * db/catalogo.js
 * -----------------------------------------------------------------------------
 * Catalogo inicial da loja. E a UNICA fonte de verdade dos produtos de
 * exemplo: o semeador le daqui e grava no banco. Depois de semeado, o catalogo
 * vive no banco e pode ser editado pela API de administracao.
 *
 * Cada produto:
 *   slug       identificador legivel e estavel (o id e derivado dele)
 *   linha      nome da familia do produto ("FPS Booster")
 *   nivel      variacao dentro da familia ("Basic", "Pro"...)
 *   categoria  agrupa os produtos na barra lateral
 *   recursos   lista de diferenciais exibida na pagina do produto
 *   capa       icone usado quando o produto nao tem imagem propria
 *   badge      selo opcional no card ("Mais vendido", "Novo"...)
 *   notaBase   media historica de avaliacoes (o banco soma as reais a esta)
 *   destaque   aparece na home
 *   planos     precos em REAIS; o semeador converte para centavos
 *
 * Icones disponiveis: raio | mira | teclado | camadas | vassoura | chip | sinal | escudo
 *
 * ATENCAO: o texto e exibido ao cliente, entao use acentuacao correta. A busca
 * ignora acentos porque o repositorio guarda uma copia normalizada a parte.
 */
'use strict';

/** Monta a lista de planos, ignorando os que nao tiverem preco. */
function planos(dia, semana, mes, vitalicio) {
  return [
    dia != null && { id: '1d', nome: '1 dia', preco: dia, dias: 1 },
    semana != null && { id: '7d', nome: '7 dias', preco: semana, dias: 7 },
    mes != null && { id: '30d', nome: '30 dias', preco: mes, dias: 30 },
    vitalicio != null && { id: 'vitalicio', nome: 'Vitalício', preco: vitalicio, dias: null }
  ].filter(Boolean);
}

const CATALOGO = [
  {
    slug: 'fps-booster-basic',
    nome: 'FPS Booster - Basic',
    linha: 'FPS Booster',
    nivel: 'Basic',
    categoria: 'Otimização',
    descricao: 'Ajustes essenciais de sistema para ganhar quadros e reduzir travadas em poucos cliques.',
    descricaoLonga: 'Ajustes essenciais de sistema para ganhar quadros e reduzir travadas em poucos cliques. O FPS Booster Basic aplica perfis prontos por jogo, encerra processos que consomem recursos em segundo plano e troca o plano de energia do Windows para o modo de alto desempenho. É a forma mais rápida de estabilizar o framerate em máquinas modestas, sem mexer em configurações avançadas nem reinstalar nada.',
    recursos: ['Perfis prontos por jogo', 'Limpeza de processos em segundo plano', 'Plano de energia otimizado'],
    capa: { icone: 'raio' },
    badge: 'Mais vendido',
    notaBase: 5.0,
    totalBase: 1284,
    destaque: true,
    plataforma: 'Windows',
    planos: planos(9.99, 29.99, 59.99, null)
  },
  {
    slug: 'fps-booster-advanced',
    nome: 'FPS Booster - Advanced',
    linha: 'FPS Booster',
    nivel: 'Advanced',
    categoria: 'Otimização',
    descricao: 'Tudo do Basic com ajustes de GPU, timer de sistema e prioridade dinâmica de processos.',
    descricaoLonga: 'Tudo do Basic com ajustes de GPU, timer de sistema e prioridade dinâmica de processos. O Advanced vai além da limpeza: mexe na latência do timer do Windows, prioriza a GPU para o jogo em primeiro plano e traz um monitor de FPS em tempo real para você ver o ganho na hora. Ideal para quem já sabe o que quer e precisa de controle fino sobre o desempenho.',
    recursos: ['Tudo do Basic', 'Ajustes avançados de GPU', 'Monitor de FPS em tempo real'],
    capa: { icone: 'raio' },
    badge: 'Atualizado',
    notaBase: 5.0,
    totalBase: 842,
    destaque: true,
    plataforma: 'Windows',
    planos: planos(14.99, 44.99, 89.99, null)
  },
  {
    slug: 'fps-booster-pro',
    nome: 'FPS Booster - Pro',
    linha: 'FPS Booster',
    nivel: 'Pro',
    categoria: 'Otimização',
    descricao: 'Licença vitalícia com todos os módulos, atualizações para sempre e suporte prioritário.',
    descricaoLonga: 'Licença vitalícia com todos os módulos, atualizações para sempre e suporte prioritário. O Pro libera o conjunto completo de otimizações — CPU, GPU, memória, rede e timer — sem limite de tempo e sem renovação. Você recebe todas as atualizações futuras automaticamente e conta com atendimento prioritário sempre que precisar ajustar um perfil específico.',
    recursos: ['Todos os módulos', 'Atualizações vitalícias', 'Suporte prioritário'],
    capa: { icone: 'raio' },
    badge: 'Vitalício',
    notaBase: 5.0,
    totalBase: 391,
    destaque: true,
    plataforma: 'Windows',
    planos: planos(null, null, null, 249.9)
  },
  {
    slug: 'input-lag-fix',
    nome: 'Input Lag Fix',
    linha: 'Input Lag',
    nivel: 'Fix',
    categoria: 'Otimização',
    descricao: 'Reduz o atraso entre o clique e a ação na tela ajustando mouse, teclado e USB.',
    descricaoLonga: 'Reduz o atraso entre o clique e a ação na tela ajustando mouse, teclado e USB. O Input Lag Fix mede a latência real do seu setup, otimiza a taxa de polling do mouse, ajusta as portas USB para resposta imediata e desativa recursos do sistema que atrasam o input. O resultado aparece no próprio teste integrado, que mostra o antes e o depois em milissegundos.',
    recursos: ['Taxa de polling otimizada', 'Ajustes de USB', 'Teste de latência integrado'],
    capa: { icone: 'mira' },
    badge: null,
    notaBase: 4.9,
    totalBase: 517,
    destaque: false,
    plataforma: 'Windows',
    planos: planos(null, 19.99, 39.99, 119.9)
  },
  {
    slug: 'macro-studio-basic',
    nome: 'Macro Studio - Basic',
    linha: 'Macro Studio',
    nivel: 'Basic',
    categoria: 'Macros',
    descricao: 'Grave e reproduza sequências de teclas com editor visual simples e atalhos personalizados.',
    descricaoLonga: 'Grave e reproduza sequências de teclas com editor visual simples e atalhos personalizados. O Macro Studio Basic deixa você montar até 20 macros arrastando ações na tela, com atrasos configuráveis e atalhos globais que funcionam em qualquer aplicativo. É a porta de entrada para automatizar tarefas repetitivas sem escrever uma linha de código.',
    recursos: ['Editor visual', 'Até 20 macros', 'Atalhos globais'],
    capa: { icone: 'teclado' },
    badge: null,
    notaBase: 4.8,
    totalBase: 266,
    destaque: false,
    plataforma: 'Windows',
    planos: planos(7.99, 24.99, 49.99, null)
  },
  {
    slug: 'macro-studio-pro',
    nome: 'Macro Studio - Pro',
    linha: 'Macro Studio',
    nivel: 'Pro',
    categoria: 'Macros',
    descricao: 'Macros ilimitadas, perfis por aplicativo e sincronização entre computadores.',
    descricaoLonga: 'Macros ilimitadas, perfis por aplicativo e sincronização entre computadores. O Pro remove o limite de macros, cria perfis que trocam sozinhos conforme o aplicativo em foco e sincroniza tudo na nuvem, então a mesma configuração está no seu desktop e no notebook. Inclui ainda gravação de movimentos de mouse e encadeamento de macros em sequência.',
    recursos: ['Macros ilimitadas', 'Perfis por aplicativo', 'Sincronização na nuvem'],
    capa: { icone: 'teclado' },
    badge: 'Novo',
    notaBase: 5.0,
    totalBase: 148,
    destaque: false,
    plataforma: 'Windows',
    planos: planos(null, 39.99, 79.99, 199.9)
  },
  {
    slug: 'crosshair-overlay',
    nome: 'Crosshair Overlay',
    linha: 'Crosshair',
    nivel: 'Overlay',
    categoria: 'Visual',
    descricao: 'Mira personalizável sobre qualquer jogo em janela, com mais de 50 estilos e cores.',
    descricaoLonga: 'Mira personalizável sobre qualquer jogo em janela, com mais de 50 estilos e cores. O Crosshair Overlay desenha uma mira fixa e precisa no centro da tela, sobrepondo jogos que não oferecem essa opção. Escolha entre mais de 50 formatos, ajuste cor, espessura e tamanho, e salve perfis diferentes para cada jogo — tudo sem qualquer impacto no desempenho.',
    recursos: ['50+ estilos de mira', 'Cores e tamanhos livres', 'Perfis por jogo'],
    capa: { icone: 'mira' },
    badge: null,
    notaBase: 4.9,
    totalBase: 733,
    destaque: false,
    plataforma: 'Windows',
    planos: planos(null, 14.99, 29.99, 89.9)
  },
  {
    slug: 'stream-overlay-pack',
    nome: 'Stream Overlay Pack',
    linha: 'Stream',
    nivel: 'Overlay',
    categoria: 'Visual',
    descricao: 'Pacote de overlays, alertas e telas de transição prontos para OBS e Streamlabs.',
    descricaoLonga: 'Pacote de overlays, alertas e telas de transição prontos para OBS e Streamlabs. O Stream Overlay Pack entrega 30 cenas montadas, alertas animados para seguidores e doações, telas de pausa e transições prontas para usar. Os arquivos são editáveis, então você adapta cores e textos à sua identidade sem depender de um designer.',
    recursos: ['30 cenas prontas', 'Alertas animados', 'Arquivos editáveis'],
    capa: { icone: 'camadas' },
    badge: null,
    notaBase: 4.8,
    totalBase: 204,
    destaque: false,
    plataforma: 'Windows',
    planos: planos(null, null, null, 69.9)
  },
  {
    slug: 'system-cleaner',
    nome: 'System Cleaner',
    linha: 'System',
    nivel: 'Cleaner',
    categoria: 'Utilitários',
    descricao: 'Remove arquivos temporários, caches esquecidos e itens que atrasam a inicialização.',
    descricaoLonga: 'Remove arquivos temporários, caches esquecidos e itens que atrasam a inicialização. O System Cleaner varre o disco em busca de lixo acumulado, aponta o que está pesando no boot e permite agendar limpezas automáticas. Além de liberar espaço, ele ajuda a manter o sistema leve — o que se traduz direto em mais estabilidade durante o jogo.',
    recursos: ['Limpeza profunda', 'Gerenciador de inicialização', 'Agendamento automático'],
    capa: { icone: 'vassoura' },
    badge: null,
    notaBase: 4.9,
    totalBase: 452,
    destaque: false,
    plataforma: 'Windows',
    planos: planos(null, 12.99, 24.99, 79.9)
  },
  {
    slug: 'driver-updater',
    nome: 'Driver Updater',
    linha: 'Driver',
    nivel: 'Updater',
    categoria: 'Utilitários',
    descricao: 'Encontra e instala drivers atualizados de vídeo, áudio e rede com ponto de restauração.',
    descricaoLonga: 'Encontra e instala drivers atualizados de vídeo, áudio e rede com ponto de restauração. O Driver Updater compara a versão dos seus drivers com as mais recentes dos fabricantes, baixa apenas de fontes oficiais e cria um ponto de restauração antes de cada instalação. Drivers desatualizados são uma causa comum de quedas de FPS e travamentos — aqui a correção é automática.',
    recursos: ['Verificação automática', 'Ponto de restauração', 'Downloads oficiais'],
    capa: { icone: 'chip' },
    badge: 'Atualizado',
    notaBase: 4.8,
    totalBase: 319,
    destaque: false,
    plataforma: 'Windows',
    planos: planos(null, null, 34.99, 99.9)
  }
];

/* -------------------------------------------------------------------------- */
/* Cupons de exemplo                                                          */
/* -------------------------------------------------------------------------- */

/*
 * Codigos criados junto com o catalogo para a loja ja nascer utilizavel.
 * tipo: 'percentual' (valor de 0 a 100) ou 'fixo' (valor em centavos).
 */
const CUPONS = [
  {
    codigo: 'BEMVINDO10',
    tipo: 'percentual',
    valor: 10,
    minimoCentavos: 0,
    maxUsos: null,
    expiraEm: null,
    descricao: '10% de desconto na primeira compra'
  },
  {
    codigo: 'GAMER20',
    tipo: 'percentual',
    valor: 20,
    minimoCentavos: 10000,
    maxUsos: 100,
    expiraEm: null,
    descricao: '20% em pedidos acima de R$ 100'
  },
  {
    codigo: 'MENOS15',
    tipo: 'fixo',
    valor: 1500,
    minimoCentavos: 8000,
    maxUsos: 50,
    expiraEm: null,
    descricao: 'R$ 15 de desconto em pedidos acima de R$ 80'
  }
];

module.exports = { CATALOGO, CUPONS, planos };
