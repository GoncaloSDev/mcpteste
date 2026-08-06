/**
 * Uso seguro de nomes de tabela dentro de SQL.
 *
 * Existe separado porque resolve um problema específico e traiçoeiro: os
 * identificadores (nomes de tabela e coluna) NÃO podem ser passados como
 * parâmetros $1. É o único sítio do projeto onde texto tem mesmo de ser
 * concatenado com SQL, e por isso é o único sítio que precisa deste cuidado.
 */

import type { ContextoLeitura } from "./acesso/contexto.js";
import { ErroValidacao } from "./erros.js";

/**
 * Confirma que a tabela existe no schema public e devolve o nome tal como está
 * no catálogo do Postgres.
 *
 * A ESTRATÉGIA, que é o ponto todo deste ficheiro:
 *
 * Um "SELECT * FROM $1" não funciona — o Postgres trataria $1 como um valor de
 * texto, não como o nome de uma tabela. Alguém teria de concatenar o nome no
 * SQL, e aí um nome como `clientes; DROP TABLE artigos; --` seria injeção.
 *
 * A solução é nunca concatenar o que o utilizador escreveu. O nome recebido é
 * usado apenas como VALOR numa query parametrizada ao catálogo (onde o $1 já
 * funciona, porque aí é mesmo um valor). O que sai dessa query é um nome vindo
 * do próprio Postgres, de uma tabela que sabemos existir. É esse — e só esse —
 * que é concatenado a seguir. O texto do utilizador nunca chega ao SQL final:
 * serviu de chave de pesquisa e ficou por ali.
 *
 * Bónus da escolha do information_schema em vez do pg_catalog: as vistas do
 * information_schema já filtram por privilégios. O mcp_readonly nem sequer
 * CONSEGUE descobrir a existência de uma tabela onde não tenha SELECT.
 */
export async function resolverTabela(
  contexto: ContextoLeitura,
  nomePedido: string,
): Promise<string> {
  const resultado = await contexto.executarLeitura<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = $1`,
    [nomePedido],
  );

  const linha = resultado.rows[0];
  if (linha === undefined) {
    throw new ErroValidacao(
      `A tabela "${nomePedido}" não existe no schema public (ou não tens permissão para a ler). ` +
        "Usa a tool list_tables para veres as tabelas disponíveis.",
    );
  }

  return linha.table_name;
}

/**
 * Envolve um identificador em aspas duplas para poder ser usado em SQL.
 *
 * A duplicação das aspas é a forma de escape do SQL padrão: um `"` dentro de um
 * identificador escreve-se `""`, tal como uma plica dentro de uma string se
 * escreve `''`.
 *
 * Isto é uma segunda linha de defesa, não a primeira. Nesta base de dados
 * nenhuma tabela tem aspas no nome, e o resolverTabela() acima já garante que o
 * nome veio do catálogo. Mas a função tem de estar correta por si só: se um dia
 * for usada com um nome vindo de outro sítio, continua a produzir SQL válido.
 *
 * As aspas duplas trazem também um efeito prático: tornam o nome
 * case-sensitive e literal, portanto uma tabela que se chamasse "select"
 * continuaria a funcionar.
 */
export function citarIdentificador(nome: string): string {
  return `"${nome.replace(/"/g, '""')}"`;
}
