/**
 * CAMADA 3 — limites de execução: teto de linhas devolvidas.
 *
 * Ao contrário das camadas 1 e 2, esta não existe para travar um ataque: existe
 * para travar um acidente. Um "SELECT * FROM linhas_doc" sem LIMIT são dezenas
 * de milhares de linhas a atravessar o protocolo MCP de uma vez. Fica separada
 * porque é a única camada que MODIFICA a query em vez de apenas a julgar.
 *
 * (A outra metade dos limites — o statement_timeout — vive no db.ts, porque tem
 * de ser aplicada dentro da mesma transação que corre a query.)
 */

import { ErroValidacao } from "../erros.js";

/** Nome do alias da subquery. Prefixado para não colidir com nada do utilizador. */
const ALIAS_ENVOLVENTE = "_mcp_limite";

export interface Limites {
  /** LIMIT acrescentado às queries que não trazem um. */
  automatico: number;
  /** LIMIT explícito máximo aceite; acima disto o pedido é recusado. */
  maximo: number;
}

export interface QueryLimitada {
  /** O SQL que vai mesmo ser executado. */
  sql: string;
  /** Explicação do que aconteceu ao limite, para devolver ao cliente. */
  nota: string;
}

/**
 * Aplica a política de limites a uma query já validada pela Camada 1.
 *
 * @param sql             a query original do utilizador
 * @param limiteExplicito o LIMIT de topo lido pela Camada 1, ou null se não houver
 */
export function aplicarLimite(
  sql: string,
  limiteExplicito: number | null,
  limites: Limites,
): QueryLimitada {
  // Caso 0: um LIMIT negativo. Não é uma brecha — o Postgres também o recusa —
  // mas recusá-lo aqui dá a mensagem certa. Deixado passar, chegava lá abaixo
  // como "LIMIT explícito" e voltava com um SQLSTATE que o erros.ts não conhece,
  // ou seja um "Erro da base de dados (2201W)" que não ajuda ninguém.
  //
  // A comparação é `< 0` e não `<= 0` de propósito: LIMIT 0 é válido e devolve
  // zero linhas, que é uma coisa legítima de se pedir (ver só as colunas).
  if (limiteExplicito !== null && limiteExplicito < 0) {
    throw new ErroValidacao(
      `O LIMIT pedido (${limiteExplicito}) é negativo. ` +
        "O LIMIT tem de ser zero ou um número positivo.",
    );
  }

  // Caso 1: o utilizador pediu mais do que o teto. Recusamos em vez de reduzir
  // à socapa — se devolvêssemos 500 linhas a quem pediu 5000, o resultado
  // parecia completo e não era, o que é pior do que um erro.
  if (limiteExplicito !== null && limiteExplicito > limites.maximo) {
    throw new ErroValidacao(
      `O LIMIT pedido (${limiteExplicito}) excede o máximo permitido de ${limites.maximo}. ` +
        "Reduz o LIMIT, ou usa agregações para resumires os dados do lado da base de dados.",
    );
  }

  // Caso 2: já tem um limite aceitável. Corre tal e qual — não lhe tocamos.
  if (limiteExplicito !== null) {
    return {
      sql,
      nota: `LIMIT ${limiteExplicito} explícito, definido na query.`,
    };
  }

  // Caso 3: sem limite utilizável. Embrulhamos.
  return {
    sql: envolverComLimite(sql, limites.automatico),
    nota:
      `LIMIT ${limites.automatico} acrescentado automaticamente (a query não trazia um). ` +
      "Se precisares de mais linhas, define um LIMIT explícito.",
  };
}

/**
 * Embrulha a query numa subquery com LIMIT.
 *
 * PORQUÊ EMBRULHAR, e não reescrever a árvore e regerar o SQL:
 * regerar SQL a partir da árvore (um "deparse") obriga a confiar que a
 * biblioteca reconstrói a query exatamente com o mesmo significado — e uma
 * diferença subtil aqui seria um bug silencioso a alterar os resultados. Um
 * embrulho não toca numa única letra do que o utilizador escreveu: o texto
 * original fica intacto lá dentro, e a única coisa que muda é haver um teto por
 * fora. É mais fácil de auditar e o resultado é sempre previsível.
 *
 * Funciona para qualquer forma de SELECT, incluindo "WITH ... SELECT" e UNION —
 * o Postgres aceita um WITH dentro de uma subquery sem problema.
 */
function envolverComLimite(sql: string, limite: number): string {
  const interior = removerPontoEVirgulaFinal(sql);

  // Os \n antes do ")" NÃO são estética. Se a query do utilizador acabar num
  // comentário de linha ("SELECT * FROM artigos -- ver tudo"), um parêntese
  // colado na mesma linha ficava DENTRO do comentário, e o SQL resultante ficava
  // com os parênteses desequilibrados. A quebra de linha fecha o comentário.
  //
  // Nota sobre nomes de coluna repetidos: um "SELECT a.id, b.id FROM ..." tem
  // duas colunas com o mesmo nome. O Postgres aceita isso numa subquery desde
  // que não sejam referenciadas de forma ambígua — e "SELECT *" não referencia
  // nenhuma pelo nome, por isso o embrulho sobrevive a esse caso.
  return `SELECT * FROM (\n${interior}\n) AS ${ALIAS_ENVOLVENTE}\nLIMIT ${limite}`;
}

/**
 * Tira o ponto e vírgula final (e espaços à volta).
 *
 * É obrigatório antes de embrulhar: "SELECT 1;" dentro de parênteses fica
 * "( SELECT 1; )", que é erro de sintaxe. A Camada 1 já garantiu que só existe
 * uma instrução, portanto qualquer ";" que aqui esteja é o terminador final e
 * pode ser removido sem alterar o significado da query.
 */
function removerPontoEVirgulaFinal(sql: string): string {
  return sql.trimEnd().replace(/;+\s*$/, "");
}

/**
 * Lê os limites do ambiente, com valores por omissão sensatos.
 * Um valor inválido no .env não deve arrancar um servidor com limites estranhos,
 * por isso qualquer coisa que não seja um inteiro positivo cai no valor omisso.
 */
export function lerLimitesDoAmbiente(): Limites {
  return {
    automatico: lerInteiroPositivo(process.env["MCP_LIMITE_AUTOMATICO"], 200),
    maximo: lerInteiroPositivo(process.env["MCP_LIMITE_MAXIMO"], 500),
  };
}

function lerInteiroPositivo(valor: string | undefined, omissao: number): number {
  if (valor === undefined) {
    return omissao;
  }
  const numero = Number.parseInt(valor, 10);
  if (!Number.isInteger(numero) || numero <= 0) {
    return omissao;
  }
  return numero;
}
