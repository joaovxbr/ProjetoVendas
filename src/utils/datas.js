/*
 * utils/datas.js
 * -----------------------------------------------------------------------------
 * Datas sempre circulam como string ISO 8601 em UTC (formato nativo do SQLite
 * e do JavaScript). Este modulo concentra a conversao para exibicao no padrao
 * brasileiro e os calculos de expiracao usados por sessoes e licencas.
 */
'use strict';

const dayjs = require('dayjs');

/** Momento atual em ISO 8601 UTC. */
function agoraISO() {
  return new Date().toISOString();
}

/** ISO 8601 UTC de agora + N dias. */
function daquiADias(dias) {
  return new Date(Date.now() + Number(dias) * 24 * 60 * 60 * 1000).toISOString();
}

/** ISO 8601 UTC de agora + N minutos. */
function daquiAMinutos(minutos) {
  return new Date(Date.now() + Number(minutos) * 60 * 1000).toISOString();
}

/**
 * Uma data ISO ja passou?
 *
 * CONVENCAO IMPORTANTE: data ausente ou invalida conta como EXPIRADA. Isso e o
 * correto para sessoes e tokens, onde nao ter data e um erro. Quando a regra de
 * negocio trata a ausencia de data como "sem validade" (cupom sem expiracao,
 * licenca vitalicia), o chamador precisa testar a data antes de chamar aqui:
 *
 *   if (registro.expiraEm && expirou(registro.expiraEm)) { ... }
 */
function expirou(iso) {
  if (!iso) return true;
  const momento = new Date(iso).getTime();
  if (!Number.isFinite(momento)) return true;
  return momento <= Date.now();
}

/** Diferenca em dias inteiros entre duas datas ISO (positivo se "b" for depois). */
function diferencaEmDias(a, b) {
  const inicio = new Date(a).getTime();
  const fim = new Date(b).getTime();
  if (!Number.isFinite(inicio) || !Number.isFinite(fim)) return 0;
  return Math.round((fim - inicio) / (24 * 60 * 60 * 1000));
}

/** "2026-09-30T23:37:08.000Z" -> "30/09/2026 20:37" (horario local). */
function formatarBR(iso, formato = 'DD/MM/YYYY HH:mm') {
  if (!iso) return '';
  const momento = dayjs(iso);
  return momento.isValid() ? momento.format(formato) : '';
}

/** Somente a data: "30/09/2026". */
function formatarDataBR(iso) {
  return formatarBR(iso, 'DD/MM/YYYY');
}

/** Idade aparente em texto curto: "agora", "3 min", "2 h", "5 dias". */
function tempoRelativo(iso) {
  const momento = dayjs(iso);
  if (!momento.isValid()) return '';
  const segundos = Math.max(Math.floor((Date.now() - momento.valueOf()) / 1000), 0);
  if (segundos < 60) return 'agora';
  const minutos = Math.floor(segundos / 60);
  if (minutos < 60) return `${minutos} min`;
  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `${horas} h`;
  const dias = Math.floor(horas / 24);
  if (dias < 30) return dias === 1 ? '1 dia' : `${dias} dias`;
  const meses = Math.floor(dias / 30);
  if (meses < 12) return meses === 1 ? '1 mes' : `${meses} meses`;
  const anos = Math.floor(meses / 12);
  return anos === 1 ? '1 ano' : `${anos} anos`;
}

/** Limite inicial/final de um periodo, usado em relatorios do admin. */
function inicioDoDia(iso = agoraISO()) {
  const d = dayjs(iso);
  return d.startOf('day').toISOString();
}

function inicioDoMes(iso = agoraISO()) {
  return dayjs(iso).startOf('month').toISOString();
}

module.exports = {
  agoraISO,
  daquiADias,
  daquiAMinutos,
  expirou,
  diferencaEmDias,
  formatarBR,
  formatarDataBR,
  tempoRelativo,
  inicioDoDia,
  inicioDoMes,
  dayjs
};
