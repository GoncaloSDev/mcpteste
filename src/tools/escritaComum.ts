/**
 * Peças partilhadas pelas três tools de escrita.
 *
 * Existe para as tools não repetirem o schema Zod nem a construção dos
 * fragmentos de SQL — mas sobretudo para haver UM sítio onde se vê que todos os
 * valores vão como parâmetros $n e que todos os identificadores passam pelo
 * citarIdentificador(). Espalhado por três ficheiros, isso deixava de ser
 * verificável de relance.
 */

import { z } from "zod";
import { citarIdentificador } from "../identificadores.js";
import type { ValorColuna } from "../seguranca/escrita-camada1-alvo.js";

/**
 * Um valor de coluna.
 *
 * A união é explícita em vez de um z.any() por duas razões. A primeira é que
 * produz um JSON Schema legível, e é por ele que o modelo do outro lado percebe
 * o que pode enviar. A segunda é que recusa objetos e arrays — esta base não tem
 * uma única coluna json, jsonb ou array, portanto qualquer coisa aninhada que
 * chegasse aqui seria um mal-entendido, e é melhor dizê-lo já do que deixar o
 * driver falhar com uma mensagem obscura.
 *
 * O null está incluído de propósito: pôr uma coluna a NULL é uma edição legítima
 * (esta base está cheia de NULLs — 35% dos clientes não têm email registado).
 */
export const esquemaValor = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** Objeto coluna -> valor. */
export const esquemaValores = z.record(z.string(), esquemaValor);

/**
 * Constrói os fragmentos `"coluna" = $n` de um WHERE ou de um SET.
 *
 * @param colunas   nomes já validados contra o catálogo
 * @param valores   objeto de onde tirar os valores
 * @param inicioEm  número do primeiro $n (1 no primeiro fragmento de uma query)
 */
export function construirAtribuicoes(
  colunas: readonly string[],
  valores: Record<string, ValorColuna>,
  inicioEm: number,
): { fragmentos: string[]; parametros: ValorColuna[] } {
  const fragmentos: string[] = [];
  const parametros: ValorColuna[] = [];

  colunas.forEach((coluna, i) => {
    // O nome vem do catálogo (foi validado contra o pg_attribute) e ainda assim
    // é citado: é a mesma lógica do identificadores.ts — a função tem de estar
    // correta por si só, não por causa de quem a chama hoje.
    fragmentos.push(`${citarIdentificador(coluna)} = $${inicioEm + i}`);
    parametros.push(valores[coluna] ?? null);
  });

  return { fragmentos, parametros };
}

/**
 * Descreve a chave primária em texto, para as mensagens de erro e para a
 * resposta. Sem isto, um erro sobre precos_art (chave de três colunas) não dizia
 * a que linha se referia.
 */
export function descreverChave(chave: Record<string, ValorColuna>): string {
  const partes = Object.entries(chave).map(([c, v]) => `${c}=${v === null ? "NULL" : String(v)}`);
  return partes.join(", ");
}
