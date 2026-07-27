/**
 * Tool `describe_table` — colunas, tipos, nullable, chave primária e estrangeiras.
 *
 * Esta base de dados tem nomes de colunas inconsistentes de propósito (o mesmo
 * cliente é `no_cli` numa tabela e `cod_cli` noutra). Sem as chaves
 * estrangeiras, saber por onde ligar duas tabelas seria adivinhação — daí esta
 * tool devolver também as relações, e não só a lista de colunas.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { executarSoLeitura } from "../db.js";
import { resolverTabela } from "../identificadores.js";
import { respostaErro, respostaOk } from "./resposta.js";

interface LinhaColuna {
  coluna: string;
  tipo: string;
  aceita_null: boolean;
  valor_omissao: string | null;
  posicao: number;
}

interface LinhaChave {
  coluna: string;
  tabela_referida: string | null;
  coluna_referida: string | null;
}

/**
 * Aqui não é preciso concatenar o nome da tabela no SQL: o information_schema
 * guarda-o como um VALOR numa coluna, portanto o $1 parametrizado funciona
 * normalmente. É o caso simples — o sample_rows é que tem o problema a sério.
 *
 * format_type() em vez do data_type do information_schema porque o
 * information_schema devolve "character varying" e "numeric" sem os parâmetros;
 * o format_type devolve "character varying(80)" e "numeric(12,2)", que é a
 * informação que realmente interessa para escrever queries.
 */
const SQL_COLUNAS = `
  SELECT a.attname                                        AS coluna,
         format_type(a.atttypid, a.atttypmod)             AS tipo,
         NOT a.attnotnull                                 AS aceita_null,
         pg_get_expr(d.adbin, d.adrelid)                  AS valor_omissao,
         a.attnum                                         AS posicao
    FROM pg_attribute a
    JOIN pg_class c      ON c.oid = a.attrelid
    JOIN pg_namespace n  ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE n.nspname = 'public'
     AND c.relname = $1
     AND a.attnum > 0          -- exclui as colunas de sistema (ctid, xmin, ...)
     AND NOT a.attisdropped    -- exclui colunas removidas, que ficam na tabela
   ORDER BY a.attnum
`;

/**
 * Chaves primárias e estrangeiras a partir do pg_constraint.
 *
 * O unnest(conkey) com WITH ORDINALITY é o que desdobra uma chave composta em
 * várias linhas mantendo a ordem das colunas — o conkey é um array de números de
 * coluna, e numa chave composta a ordem é significativa.
 *
 * contype: 'p' = primary key, 'f' = foreign key.
 */
const SQL_CHAVES = `
  SELECT con.contype                                       AS tipo,
         att.attname                                       AS coluna,
         cref.relname                                      AS tabela_referida,
         attref.attname                                    AS coluna_referida
    FROM pg_constraint con
    JOIN pg_class c     ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
    LEFT JOIN pg_class cref ON cref.oid = con.confrelid
    LEFT JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS kr(attnum, ord)
           ON kr.ord = k.ord
    LEFT JOIN pg_attribute attref
           ON attref.attrelid = con.confrelid AND attref.attnum = kr.attnum
   WHERE n.nspname = 'public'
     AND c.relname = $1
     AND con.contype IN ('p', 'f')
   ORDER BY con.contype, k.ord
`;

export function registarDescribeTable(server: McpServer): void {
  server.registerTool(
    "describe_table",
    {
      title: "Descrever tabela",
      description:
        "Devolve a estrutura de uma tabela: colunas, tipos, se aceitam NULL, valores por " +
        "omissão, chave primária e chaves estrangeiras. Usa esta tool antes de escreveres " +
        "uma query, sobretudo para descobrires por que colunas se ligam as tabelas — nesta " +
        "base os nomes não são consistentes entre tabelas.",
      // O inputSchema é um objeto de campos Zod "em cru", NÃO um z.object({...}).
      // O SDK é que envolve isto num objeto e o converte para JSON Schema. Passar
      // um z.object() aqui compila mas produz um schema errado.
      inputSchema: {
        tabela: z
          .string()
          .min(1, "O nome da tabela não pode estar vazio.")
          .describe("Nome da tabela no schema public, por exemplo 'clientes' ou 'docs_venda'."),
      },
    },
    async ({ tabela }) => {
      try {
        // Confirma que existe e devolve o nome do catálogo. Aqui serve sobretudo
        // para dar um erro claro ("a tabela X não existe, usa o list_tables") em
        // vez de devolver uma lista de colunas vazia sem explicação.
        const nome = await resolverTabela(tabela);

        const [colunas, chaves] = await Promise.all([
          executarSoLeitura<LinhaColuna>(SQL_COLUNAS, [nome]),
          executarSoLeitura<LinhaChave & { tipo: string }>(SQL_CHAVES, [nome]),
        ]);

        const chavePrimaria = chaves.rows.filter((l) => l.tipo === "p").map((l) => l.coluna);

        const chavesEstrangeiras = chaves.rows
          .filter((l) => l.tipo === "f")
          .map((l) => ({
            coluna: l.coluna,
            referencia: `${l.tabela_referida}.${l.coluna_referida}`,
          }));

        return respostaOk({
          tabela: nome,
          total_colunas: colunas.rowCount,
          chave_primaria: chavePrimaria.length > 0 ? chavePrimaria : null,
          chaves_estrangeiras: chavesEstrangeiras.length > 0 ? chavesEstrangeiras : null,
          colunas: colunas.rows,
        });
      } catch (erro) {
        return respostaErro(erro);
      }
    },
  );
}
