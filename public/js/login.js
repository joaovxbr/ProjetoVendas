/*
 * login.js
 * Tela de login e cadastro: abas, validação, mostrar senha, força da senha,
 * conta demo, envio para a API e redirecionamento seguro.
 * Depende de window.Api (api.js, carregado antes com defer).
 */
(function () {
  'use strict';

  var Api = window.Api;
  var EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var DEMO = { email: 'demo@loja.com', senha: 'demo123' };

  var TEXTOS = {
    entrar: {
      titulo: 'Bem-vindo <span class="grad">de volta</span>',
      lead: 'Entre para acessar seus pedidos e finalizar suas compras.',
      botao: 'Entrar',
      rota: '/api/auth/login'
    },
    criar: {
      titulo: 'Crie sua <span class="grad">conta</span>',
      lead: 'Leva menos de um minuto. Suas chaves ficam salvas na sua conta.',
      botao: 'Criar conta',
      rota: '/api/auth/registrar'
    }
  };

  var $ = function (id) { return document.getElementById(id); };

  var raiz = document.querySelector('.auth');
  var abas = document.querySelector('.auth-tabs');
  var painel = $('painel-auth');
  var form = $('form-auth');
  var tabEntrar = $('tab-entrar');
  var tabCriar = $('tab-criar');
  var grupoNome = $('grupo-nome');
  var inputNome = $('nome');
  var inputEmail = $('email');
  var inputSenha = $('senha');
  var toggleSenha = $('toggle-senha');
  var lembrar = $('lembrar');
  var btnSubmit = $('btn-submit');
  var btnSubmitTexto = $('btn-submit-texto');
  var btnDemo = $('btn-demo');
  var btnEsqueci = $('btn-esqueci');
  var caixaErro = $('auth-erro');
  var status = $('auth-status');
  var titulo = $('titulo-auth');
  var lead = $('lead-auth');
  var forca = $('forca-senha');
  var forcaTexto = $('forca-texto');
  var dicaCaps = $('dica-caps');

  var modo = 'entrar';
  var enviando = false;

  /* Redirecionamento seguro ------------------------------------------------ */

  // Só aceita caminhos internos: "/algo", nunca "//site.com" nem barras invertidas
  function destinoSeguro(padrao) {
    var next = null;
    try {
      next = new URLSearchParams(window.location.search).get('next');
    } catch (erro) {
      next = null;
    }
    if (typeof next === 'string' && next.charAt(0) === '/' && next.charAt(1) !== '/' &&
        next.indexOf('\\') === -1 && !/[\u0000-\u001F]/.test(next)) {
      return next;
    }
    return padrao || '/';
  }

  // Administrador não precisa digitar /admin: cai direto no painel.
  // O "?next=" explícito sempre vence (é para lá que ele quis voltar).
  function destinoPara(usuario) {
    return destinoSeguro(Api.ehAdmin(usuario) ? '/admin' : '/');
  }

  // Já logado? Vai direto para a loja (admin vai para o painel)
  if (Api) {
    Api.me().then(function (usuario) {
      if (usuario) window.location.replace(destinoPara(usuario));
    });
  }

  /* Abas / modo ------------------------------------------------------------ */

  function definirModo(novo, focar) {
    if (novo !== 'entrar' && novo !== 'criar') return;
    modo = novo;
    var criar = modo === 'criar';

    if (raiz) raiz.setAttribute('data-modo', modo);
    if (abas) abas.setAttribute('data-modo', modo);

    [[tabEntrar, !criar], [tabCriar, criar]].forEach(function (par) {
      if (!par[0]) return;
      par[0].setAttribute('aria-selected', String(par[1]));
      par[0].setAttribute('tabindex', par[1] ? '0' : '-1');
    });
    if (painel) painel.setAttribute('aria-labelledby', criar ? 'tab-criar' : 'tab-entrar');

    if (titulo) titulo.innerHTML = TEXTOS[modo].titulo; // texto fixo, não vem do usuário
    if (lead) lead.textContent = TEXTOS[modo].lead;
    if (btnSubmitTexto) btnSubmitTexto.textContent = TEXTOS[modo].botao;
    if (form) form.setAttribute('action', TEXTOS[modo].rota);

    if (grupoNome) {
      if (criar) grupoNome.removeAttribute('inert');
      else grupoNome.setAttribute('inert', '');
    }
    if (inputNome) inputNome.disabled = !criar;
    if (inputSenha) inputSenha.setAttribute('autocomplete', criar ? 'new-password' : 'current-password');
    if (forca) forca.hidden = !criar || !inputSenha || !inputSenha.value;

    limparErros();
    if (focar) {
      var alvo = criar ? inputNome : inputEmail;
      if (alvo) setTimeout(function () { alvo.focus(); }, criar ? 220 : 0);
    }
  }

  if (tabEntrar) tabEntrar.addEventListener('click', function () { definirModo('entrar', true); });
  if (tabCriar) tabCriar.addEventListener('click', function () { definirModo('criar', true); });

  // Setas do teclado alternam as abas (padrão ARIA de tablist)
  if (abas) {
    abas.addEventListener('keydown', function (evento) {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(evento.key) === -1) return;
      evento.preventDefault();
      var proximo = modo === 'entrar' ? 'criar' : 'entrar';
      if (evento.key === 'Home') proximo = 'entrar';
      if (evento.key === 'End') proximo = 'criar';
      definirModo(proximo, false);
      var aba = proximo === 'criar' ? tabCriar : tabEntrar;
      if (aba) aba.focus();
    });
  }

  /* Erros ------------------------------------------------------------------ */

  function campoDe(input) {
    return input ? input.closest('.field') : null;
  }

  function mostrarErroCampo(input, mensagem) {
    var campo = campoDe(input);
    var erro = input ? $('erro-' + input.id) : null;
    if (!campo || !erro) return;
    campo.classList.add('field--invalid');
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', erro.id);
    erro.textContent = mensagem;
  }

  function limparErroCampo(input) {
    var campo = campoDe(input);
    var erro = input ? $('erro-' + input.id) : null;
    if (campo) campo.classList.remove('field--invalid');
    if (input) {
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
    }
    if (erro) erro.textContent = '';
  }

  function mostrarErroGeral(mensagem) {
    if (caixaErro) caixaErro.textContent = mensagem || '';
    if (mensagem && painel && !Api.reduzMovimento()) {
      painel.classList.remove('is-shake');
      void painel.offsetWidth; // reinicia a animação
      painel.classList.add('is-shake');
    }
  }

  function limparErros() {
    [inputNome, inputEmail, inputSenha].forEach(limparErroCampo);
    mostrarErroGeral('');
  }

  [inputNome, inputEmail, inputSenha].forEach(function (input) {
    if (!input) return;
    input.addEventListener('input', function () {
      limparErroCampo(input);
      if (caixaErro && caixaErro.textContent) mostrarErroGeral('');
    });
  });

  if (painel) {
    painel.addEventListener('animationend', function () { painel.classList.remove('is-shake'); });
  }

  /* Validação -------------------------------------------------------------- */

  function validar() {
    var primeiroInvalido = null;
    var email = inputEmail ? inputEmail.value.trim() : '';
    var senha = inputSenha ? inputSenha.value : '';

    if (modo === 'criar' && inputNome) {
      var nome = inputNome.value.trim();
      if (nome.length < 2) {
        mostrarErroCampo(inputNome, 'Informe seu nome (mínimo de 2 letras).');
        primeiroInvalido = primeiroInvalido || inputNome;
      }
    }

    if (!email) {
      mostrarErroCampo(inputEmail, 'Informe seu e-mail.');
      primeiroInvalido = primeiroInvalido || inputEmail;
    } else if (!EMAIL_VALIDO.test(email)) {
      mostrarErroCampo(inputEmail, 'Esse e-mail não parece válido.');
      primeiroInvalido = primeiroInvalido || inputEmail;
    }

    if (!senha) {
      mostrarErroCampo(inputSenha, 'Informe sua senha.');
      primeiroInvalido = primeiroInvalido || inputSenha;
    } else if (senha.length < 6) {
      mostrarErroCampo(inputSenha, 'A senha precisa ter pelo menos 6 caracteres.');
      primeiroInvalido = primeiroInvalido || inputSenha;
    }

    if (primeiroInvalido) primeiroInvalido.focus();
    return !primeiroInvalido;
  }

  /* Mostrar senha / Caps Lock / força -------------------------------------- */

  if (toggleSenha && inputSenha) {
    toggleSenha.addEventListener('click', function () {
      var mostrar = inputSenha.type === 'password';
      inputSenha.type = mostrar ? 'text' : 'password';
      toggleSenha.setAttribute('aria-pressed', String(mostrar));
      toggleSenha.setAttribute('aria-label', mostrar ? 'Ocultar senha' : 'Mostrar senha');
      // Mantém o cursor no fim do texto
      inputSenha.focus();
      var fim = inputSenha.value.length;
      try { inputSenha.setSelectionRange(fim, fim); } catch (erro) { /* tipo sem seleção */ }
    });
  }

  if (inputSenha && dicaCaps) {
    var checarCaps = function (evento) {
      if (typeof evento.getModifierState !== 'function') return;
      dicaCaps.hidden = !evento.getModifierState('CapsLock');
    };
    inputSenha.addEventListener('keydown', checarCaps);
    inputSenha.addEventListener('keyup', checarCaps);
    inputSenha.addEventListener('blur', function () { dicaCaps.hidden = true; });
  }

  var NIVEIS = ['', 'Fraca', 'Razoável', 'Boa', 'Forte'];

  function nivelSenha(senha) {
    if (!senha) return 0;
    var pontos = 0;
    if (senha.length >= 6) pontos++;
    if (senha.length >= 10) pontos++;
    if (/[a-z]/.test(senha) && /[A-Z]/.test(senha)) pontos++;
    if (/\d/.test(senha) && /[^A-Za-z0-9]/.test(senha)) pontos++;
    return Math.max(1, Math.min(4, pontos));
  }

  if (inputSenha && forca) {
    inputSenha.addEventListener('input', function () {
      if (modo !== 'criar') return;
      var nivel = nivelSenha(inputSenha.value);
      forca.hidden = nivel === 0;
      forca.setAttribute('data-nivel', String(nivel));
      if (forcaTexto) forcaTexto.textContent = NIVEIS[nivel];
    });
  }

  /* Envio ------------------------------------------------------------------ */

  function definirCarregando(ativo) {
    enviando = ativo;
    [btnSubmit, btnDemo].forEach(function (botao) {
      if (botao) botao.disabled = ativo;
    });
    if (btnSubmit) {
      btnSubmit.classList.toggle('is-loading', ativo);
      btnSubmit.setAttribute('aria-busy', String(ativo));
    }
    if (status) status.textContent = ativo ? 'Enviando…' : '';
  }

  function primeiroNome(nome) {
    return String(nome || '').trim().split(/\s+/)[0] || 'cliente';
  }

  async function enviar() {
    if (enviando || !Api) return;
    mostrarErroGeral('');
    if (!validar()) return;

    var corpo = {
      email: inputEmail.value.trim(),
      senha: inputSenha.value,
      lembrar: lembrar ? lembrar.checked : true
    };
    if (modo === 'criar') corpo.nome = inputNome.value.trim();

    definirCarregando(true);
    var resposta = await Api.post(TEXTOS[modo].rota, corpo);

    if (!resposta.ok) {
      definirCarregando(false);
      var mensagem = (resposta.data && resposta.data.erro) || 'Não foi possível continuar. Tente novamente.';
      mostrarErroGeral(mensagem);
      if (resposta.status === 401 && inputSenha) {
        inputSenha.select();
        inputSenha.focus();
      }
      return;
    }

    var usuario = resposta.data && resposta.data.usuario;
    var admin = Api.ehAdmin(usuario);
    if (btnSubmit) {
      btnSubmit.classList.remove('is-loading');
      btnSubmit.classList.add('is-success');
    }
    if (status) status.textContent = admin ? 'Abrindo o painel…' : 'Tudo certo, redirecionando…';
    Api.toast('Olá, ' + primeiroNome(usuario && usuario.nome) + '!', 'success');

    setTimeout(function () {
      window.location.href = destinoPara(usuario);
    }, 600);
  }

  if (form) {
    form.addEventListener('submit', function (evento) {
      evento.preventDefault();
      enviar();
    });
  }

  if (btnDemo) {
    btnDemo.addEventListener('click', function () {
      if (enviando) return;
      definirModo('entrar', false);
      if (inputEmail) inputEmail.value = DEMO.email;
      if (inputSenha) inputSenha.value = DEMO.senha;
      if (lembrar) lembrar.checked = true;
      limparErros();
      enviar();
    });
  }

  /* Recuperação de senha ---------------------------------------------------- */

  /*
   * Dois passos, um só formulário:
   *   1. informa o e-mail  -> POST /api/auth/recuperar-senha
   *   2. informa o código e a nova senha -> POST /api/auth/redefinir-senha
   *
   * A resposta do passo 1 é SEMPRE a mesma, exista ou não a conta (o servidor
   * não revela quais e-mails estão cadastrados). Fora de produção, a resposta
   * traz o link pronto — mostramos num bloco de apoio para o fluxo ser
   * testável sem servidor de e-mail.
   */

  var recuperar = $('recuperar');
  var recFechar = $('rec-fechar');
  var recAviso = $('rec-aviso');
  var recEtapa1 = $('rec-etapa-1');
  var recEtapa2 = $('rec-etapa-2');
  var recEmail = $('rec-email');
  var recToken = $('rec-token');
  var recSenha = $('rec-senha');
  var recEnviar = $('rec-enviar');
  var recRedefinir = $('rec-redefinir');
  var recDev = $('rec-dev');
  var recLead = $('rec-lead');
  var focoAntesRec = null;

  function recAvisar(mensagem, tipo) {
    if (!recAviso) return;
    recAviso.textContent = mensagem || '';
    recAviso.setAttribute('data-tipo', tipo || 'erro');
    recAviso.hidden = !mensagem;
  }

  function recIrParaEtapa(numero) {
    if (recEtapa1) recEtapa1.hidden = numero !== 1;
    if (recEtapa2) recEtapa2.hidden = numero !== 2;
    recAvisar('');
    if (recLead) {
      recLead.textContent = numero === 2
        ? 'Cole o código que você recebeu e escolha uma nova senha.'
        : 'Informe o e-mail da sua conta. Enviaremos um link para você criar uma nova senha.';
    }
    var alvo = numero === 2 ? recToken : recEmail;
    if (alvo) setTimeout(function () { alvo.focus(); }, 60);
  }

  function abrirRecuperar(numero) {
    if (!recuperar) return;
    focoAntesRec = document.activeElement;
    recuperar.hidden = false;
    document.documentElement.classList.add('no-scroll');
    recIrParaEtapa(numero || 1);
    if (recFechar) recFechar.focus();
  }

  function fecharRecuperar() {
    if (!recuperar || recuperar.hidden) return;
    recuperar.hidden = true;
    document.documentElement.classList.remove('no-scroll');
    if (focoAntesRec && document.contains(focoAntesRec)) focoAntesRec.focus({ preventScroll: true });
  }

  function carregandoRec(botao, ativo) {
    if (!botao) return;
    botao.disabled = ativo;
    botao.classList.toggle('is-loading', ativo);
    botao.setAttribute('aria-busy', String(ativo));
  }

  if (recEtapa1) {
    recEtapa1.addEventListener('submit', async function (evento) {
      evento.preventDefault();
      var email = recEmail ? recEmail.value.trim() : '';
      if (!EMAIL_VALIDO.test(email)) {
        recAvisar('Informe um e-mail válido.');
        if (recEmail) recEmail.focus();
        return;
      }

      recAvisar('');
      carregandoRec(recEnviar, true);
      var resposta = await Api.post('/api/auth/recuperar-senha', { email: email });
      carregandoRec(recEnviar, false);

      if (!resposta.ok) {
        recAvisar((resposta.data && resposta.data.erro) || 'Não foi possível solicitar a recuperação agora.');
        return;
      }

      // Resposta genérica de propósito: não confirma se o e-mail existe.
      var dados = resposta.data || {};
      recIrParaEtapa(2);

      if (recDev) {
        if (dados.link || dados.token) {
          var destinoDev = dados.link || ('/login?token=' + dados.token);
          recDev.hidden = false;
          recDev.innerHTML = '<p><strong>Ambiente de desenvolvimento</strong> — o envio por e-mail ainda não está ligado. ' +
            'Use o link abaixo:</p>' +
            '<a href="' + Api.escapar(destinoDev) + '">' + Api.escapar(destinoDev) + '</a>';
          if (dados.token && recToken && !recToken.value) recToken.value = dados.token;
        } else {
          recDev.hidden = true;
        }
      }

      Api.toast('Se este e-mail estiver cadastrado, o link já foi enviado.', 'success');
    });
  }

  if (recEtapa2) {
    recEtapa2.addEventListener('submit', async function (evento) {
      evento.preventDefault();
      var token = recToken ? recToken.value.trim() : '';
      var senha = recSenha ? recSenha.value : '';

      if (!token) { recAvisar('Informe o código recebido.'); if (recToken) recToken.focus(); return; }
      if (senha.length < 6) { recAvisar('A nova senha precisa ter pelo menos 6 caracteres.'); if (recSenha) recSenha.focus(); return; }

      recAvisar('');
      carregandoRec(recRedefinir, true);
      var resposta = await Api.post('/api/auth/redefinir-senha', { token: token, senha: senha });
      carregandoRec(recRedefinir, false);

      if (!resposta.ok) {
        recAvisar((resposta.data && resposta.data.erro) || 'Não foi possível redefinir a senha.');
        return;
      }

      Api.toast('Senha redefinida. Entre com a nova senha.', 'success');
      fecharRecuperar();

      // Já deixa o e-mail preenchido para o próximo login.
      if (inputEmail && recEmail && recEmail.value.trim()) inputEmail.value = recEmail.value.trim();
      if (inputSenha) { inputSenha.value = ''; inputSenha.focus(); }
      definirModo('entrar', false);
    });
  }

  if (btnEsqueci) {
    btnEsqueci.addEventListener('click', function () {
      // Aproveita o e-mail já digitado no formulário de login.
      if (inputEmail && inputEmail.value.trim() && recEmail) {
        recEmail.value = inputEmail.value.trim();
      }
      abrirRecuperar(1);
    });
  }

  if (recFechar) recFechar.addEventListener('click', fecharRecuperar);

  if (recuperar) {
    recuperar.addEventListener('click', function (evento) {
      if (evento.target === recuperar) fecharRecuperar();
    });
  }

  document.addEventListener('keydown', function (evento) {
    if (evento.key === 'Escape' && recuperar && !recuperar.hidden) fecharRecuperar();
  });

  /* Link do e-mail: /login?token=... abre direto no passo 2. */
  try {
    var parametros = new URLSearchParams(window.location.search);
    var tokenDaUrl = parametros.get('token');
    if (tokenDaUrl && recToken) {
      recToken.value = tokenDaUrl;
      abrirRecuperar(2);
    }
  } catch (erro) { /* navegador antigo */ }

  // Abre direto no cadastro com ?modo=criar
  try {
    if (new URLSearchParams(window.location.search).get('modo') === 'criar') definirModo('criar', false);
  } catch (erro) { /* navegador antigo */ }
})();
