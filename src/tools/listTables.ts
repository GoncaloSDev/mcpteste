/**
 * Tool `list_tables` — as tabelas do schema public com contagem aproximada.
 *
 * É a tool de orientação: normalmente é a primeira coisa que um modelo chama,
 * para saber o que existe antes de perguntar seja o que for. Por isso devolve
 * também o tamanho em disco — ajuda a perceber, logo à partida, quais são as
 * tabelas grandes onde convém ter cuidado com o LIMIT.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { executarSoLeitura } from "../db.js";
import { escritaLigada } from "../db-escrita.js";
import { TABELAS_ESCRITA } from "../seguranca/escrita-camada1-alvo.js";
import { respostaErro, respostaOk } from "./resposta.js";

interface LinhaTabela {
  tabela: string;
  linhas_aprox: string | null;
  tamanho: string;
}

/**
 * A contagem vem de pg_class.reltuples, que é uma ESTIMATIVA das estatísticas do
 * planeador de queries — não um COUNT(*).
 *
 * É uma escolha deliberada: um COUNT(*) exato em 19 tabelas obrigaria a
 * percorrer todas as linhas de todas elas, o que numa base com ~15 mil documentos
 * e as suas linhas demoraria segundos de cada vez que alguém quisesse só saber o
 * que existe. O reltuples é lido instantaneamente de uma coluna do catálogo.
 *
 * Dois pormenores que só se descobrem a bater com a cabeça:
 *
 *  - reltuples = -1 significa "esta tabela nunca foi analisada", e NÃO "menos
 *    uma linha". Acontece com tabelas acabadas de povoar, antes de o autovacuum
 *    lhes passar por cima. Sem o CASE, apareceria um -1 no output que só podia
 *    confundir. Fica NULL, e a resposta explica o que isso quer dizer.
 *
 *  - has_table_privilege() filtra as tabelas onde o utilizador não tem SELECT.
 *    O pg_class é legível por toda a gente, ao contrário do information_schema:
 *    sem este filtro, listaríamos tabelas que depois davam erro de permissão ao
 *    serem consultadas.
 *
 * relkind: 'r' = tabela normal, 'p' = tabela particionada. Ficam de fora vistas,
 * índices e sequências, que não são o que "listar tabelas" quer dizer.
 */
const SQL_TABELAS = `
  SELECT c.relname                                        AS tabela,
         CASE WHEN c.reltuples < 0 THEN NULL
              ELSE c.reltuples::bigint
         END                                              AS linhas_aprox,
         pg_size_pretty(pg_total_relation_size(c.oid))     AS tamanho
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p')
     AND has_table_privilege(c.oid, 'SELECT')
   ORDER BY c.relname
`;

export function registarListTables(server: McpServer): void {
  server.registerTool(
    "list_tables",
    {
      title: "Listar tabelas",
      description:
        "Lista as tabelas do schema public da base de dados do distribuidor, com uma " +
        "contagem aproximada de linhas, o tamanho em disco e se a tabela aceita escrita. " +
        "Usa esta tool primeiro, para saber o que existe.",
      // Uma tool sem argumentos declara um schema vazio. Não é o mesmo que
      // omitir o inputSchema: assim o cliente sabe que a tool existe e que não
      // precisa de nada para ser chamada.
      inputSchema: {},
    },
    async () => {
      try {
        const resultado = await executarSoLeitura<LinhaTabela>(SQL_TABELAS);

        // A flag é calculada aqui, em TypeScript, e não na query: a fonte de
        // verdade da whitelist é o escrita-camada1-alvo.ts, e replicá-la no SQL
        // criaria uma segunda lista para manter em sincronia dentro do MESMO
        // repositório — que é exatamente o tipo de duplicação sem valor (a
        // duplicação que interessa é a do lado da base, que é independente).
        const podeEscrever = escritaLigada();
        const tabelas = resultado.rows.map((linha) => ({
          ...linha,
          escrivel: podeEscrever && TABELAS_ESCRITA.has(linha.tabela),
        }));

        return respostaOk({
          total_tabelas: resultado.rowCount,
          modo_escrita: podeEscrever ? "ligado" : "desligado",
          nota:
            "linhas_aprox vem das estatísticas do planeador do Postgres, não de um COUNT(*). " +
            "É rápido mas aproximado. NULL significa que a tabela ainda nunca foi analisada " +
            "pelo autovacuum — não que esteja vazia.",
          nota_escrita: podeEscrever
            ? "escrivel=true indica as tabelas onde insert_row, update_row e delete_row " +
              "funcionam. As de movimento (documentos, linhas, stocks, conta corrente, " +
              "comissões) estão bloqueadas: os totais e saldos delas dependem uns dos outros " +
              "e a base não tem triggers que os mantenham coerentes."
            : "Este servidor está em modo só-leitura — nenhuma tabela aceita escrita.",
          tabelas,
        });
      } catch (erro) {
        return respostaErro(erro);
      }
    },
  );
}
