/**
 * Formatação das respostas devolvidas ao cliente MCP.
 *
 * Fica separado das tools porque as quatro respondem exatamente da mesma
 * maneira, e porque a serialização dos tipos do Postgres para JSON tem uns
 * quantos casos que não são óbvios (datas, numeric, bytea) e que é melhor
 * resolver uma vez só.
 */

import { mensagemSegura } from "../erros.js";

/**
 * Forma das respostas de uma tool MCP. É a estrutura que o SDK espera: uma lista
 * de blocos de conteúdo, cada um com o seu tipo.
 */
export interface RespostaTool {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [chave: string]: unknown;
}

/**
 * Teto do tamanho da resposta, em caracteres.
 *
 * A Camada 3 limita o número de LINHAS, mas não o tamanho delas — 200 linhas com
 * um campo de texto grande cada continuam a ser enormes. Este é o teto que falta
 * do outro lado.
 */
const MAX_CARACTERES = 100_000;

/** Resposta de sucesso: o objeto vai serializado em JSON legível. */
export function respostaOk(dados: unknown): RespostaTool {
  let texto = JSON.stringify(dados, serializarValor, 2);

  if (texto.length > MAX_CARACTERES) {
    texto =
      texto.slice(0, MAX_CARACTERES) +
      `\n\n[...resposta truncada aos ${MAX_CARACTERES} caracteres. ` +
      "Reduz o LIMIT ou seleciona menos colunas.]";
  }

  return { content: [{ type: "text", text: texto }] };
}

/**
 * Resposta de erro.
 *
 * Devolve `isError: true` em vez de atirar a exceção para o SDK, e a diferença
 * importa: com isError o modelo do outro lado RECEBE o texto do erro e pode
 * corrigir a query sozinho; uma exceção rebentava ao nível do protocolo e o
 * modelo só via que a chamada falhou, sem saber porquê.
 *
 * A mensagem passa sempre pelo mensagemSegura() — é lá que se garante que não
 * sai daqui uma connection string nem um stack trace.
 */
export function respostaErro(erro: unknown): RespostaTool {
  return {
    content: [{ type: "text", text: mensagemSegura(erro) }],
    isError: true,
  };
}

/**
 * Ajusta os tipos que o JSON.stringify não sabe representar bem.
 *
 * O que o node-postgres devolve e porquê é preciso mexer:
 *
 * - DATE / TIMESTAMP vêm como objetos Date do JavaScript. O stringify já os
 *   converteria para ISO sozinho, mas fá-lo-ia em UTC, deslocando as datas uma
 *   hora no horário de verão de Lisboa. Aqui são convertidos com a hora local,
 *   que é a que corresponde ao que está na base.
 *
 * - NUMERIC vem como STRING, não como number, e isso é de propósito (do driver,
 *   e é a decisão certa): um numeric(12,2) não cabe sempre num double sem perder
 *   precisão. Deixa-se como string — converter para número aqui seria introduzir
 *   erro de arredondamento em valores monetários.
 *
 * - BIGINT (int8) também vem como string, pela mesma razão.
 *
 * - BYTEA vem como Buffer. Despejar os bytes numa resposta de texto não serve de
 *   nada a ninguém, por isso fica só a indicação do tamanho.
 */
function serializarValor(_chave: string, valor: unknown): unknown {
  if (valor instanceof Date) {
    return formatarDataLocal(valor);
  }
  if (typeof valor === "bigint") {
    return valor.toString();
  }
  if (Buffer.isBuffer(valor)) {
    return `[binário, ${valor.length} bytes]`;
  }
  return valor;
}

/**
 * Formata uma Date com a hora LOCAL em formato ISO.
 *
 * O toISOString() nativo converte para UTC. Como a base corre em Europe/Lisbon,
 * uma data de verão gravada como 2025-07-15 apareceria como 2025-07-14T23:00:00Z
 * — o dia anterior. Para dados de faturação isso é inaceitável.
 */
function formatarDataLocal(data: Date): string {
  const doisDigitos = (n: number): string => String(n).padStart(2, "0");

  const ano = data.getFullYear();
  const mes = doisDigitos(data.getMonth() + 1);
  const dia = doisDigitos(data.getDate());

  const horas = data.getHours();
  const minutos = data.getMinutes();
  const segundos = data.getSeconds();

  // Uma coluna DATE chega cá como meia-noite local. Mostrar "T00:00:00" nesses
  // casos só acrescenta ruído a todas as linhas.
  if (horas === 0 && minutos === 0 && segundos === 0) {
    return `${ano}-${mes}-${dia}`;
  }

  return `${ano}-${mes}-${dia} ${doisDigitos(horas)}:${doisDigitos(minutos)}:${doisDigitos(segundos)}`;
}
