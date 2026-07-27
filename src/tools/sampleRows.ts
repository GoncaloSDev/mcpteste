/**
 * Tool `sample_rows` — algumas linhas de uma tabela, para se ver a cara dos dados.
 *
 * Existe separada do run_query porque resolve um problema diferente: ver dados
 * reais é o que permite perceber as convenções desta base (como estão escritos os
 * códigos de documento, que formato têm os NIFs, onde há NULLs) antes de se
 * escrever uma query a sério.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { executarSoLeitura } from "../db.js";
import { citarIdentificador, resolverTabela } from "../identificadores.js";
import { respostaErro, respostaOk } from "./resposta.js";

const LINHAS_OMISSAO = 10;
const LINHAS_MAXIMO = 50;

export function registarSampleRows(server: McpServer): void {
  server.registerTool(
    "sample_rows",
    {
      title: "Amostra de linhas",
      description:
        "Devolve as primeiras linhas de uma tabela, para se ver o aspeto real dos dados. " +
        "Útil para perceber as convenções da base (formatos de códigos, onde há NULLs) " +
        "antes de escrever uma query.",
      inputSchema: {
        tabela: z
          .string()
          .min(1, "O nome da tabela não pode estar vazio.")
          .describe("Nome da tabela no schema public, por exemplo 'artigos'."),
        linhas: z
          .number()
          .int("O número de linhas tem de ser um inteiro.")
          .min(1, "Tem de pedir pelo menos 1 linha.")
          .max(LINHAS_MAXIMO, `O máximo são ${LINHAS_MAXIMO} linhas.`)
          .default(LINHAS_OMISSAO)
          .describe(`Quantas linhas devolver (1 a ${LINHAS_MAXIMO}, por omissão ${LINHAS_OMISSAO}).`),
      },
    },
    async ({ tabela, linhas }) => {
      try {
        // Ver o comentário grande em identificadores.ts: o `tabela` que veio do
        // utilizador é usado só como VALOR numa query parametrizada ao catálogo.
        // O que volta é um nome vindo do próprio Postgres, e é esse — já
        // garantidamente existente — que pode ser concatenado no SQL a seguir.
        const nome = await resolverTabela(tabela);
        const nomeCitado = citarIdentificador(nome);

        // O nome da tabela é concatenado (não há alternativa: identificadores não
        // aceitam $1), mas o número de linhas já é um valor normal e vai
        // parametrizado. Regra geral: concatenar só o que for mesmo inevitável.
        //
        // Sem ORDER BY de propósito. Um ORDER BY obrigaria o Postgres a ordenar a
        // tabela inteira antes de devolver 10 linhas; sem ele, para uma amostra,
        // a query pára assim que tiver as linhas que precisa. A ordem não é
        // garantida, mas para "mostra-me como são os dados" isso não importa.
        const resultado = await executarSoLeitura(
          `SELECT * FROM ${nomeCitado} LIMIT $1`,
          [linhas],
        );

        return respostaOk({
          tabela: nome,
          linhas_pedidas: linhas,
          linhas_devolvidas: resultado.rowCount,
          colunas: resultado.fields.map((campo) => campo.name),
          nota: "Amostra sem ordenação definida — não são necessariamente as 'primeiras' linhas.",
          dados: resultado.rows,
        });
      } catch (erro) {
        return respostaErro(erro);
      }
    },
  );
}
