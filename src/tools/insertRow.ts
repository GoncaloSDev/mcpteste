/**
 * Tool `insert_row` — cria uma linha numa tabela de dados mestre.
 *
 * Não aceita SQL. Recebe o nome da tabela e um objeto coluna->valor, e o INSERT
 * é construído aqui: os nomes vêm do catálogo do Postgres depois de validados, os
 * valores vão todos como parâmetros $n. Não há caminho pelo qual texto de fora
 * chegue à instrução.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { executarEscrita } from "../db-escrita.js";
import { ErroValidacao } from "../erros.js";
import { citarIdentificador } from "../identificadores.js";
import {
  resolverAlvoEscrita,
  validarValores,
  type ValorColuna,
} from "../seguranca/escrita-camada1-alvo.js";
import { esquemaValores } from "./escritaComum.js";
import { respostaErro, respostaOk } from "./resposta.js";

export function registarInsertRow(server: McpServer): void {
  server.registerTool(
    "insert_row",
    {
      title: "Criar linha",
      description:
        "Cria UMA linha numa tabela de dados mestre (clientes, artigos, fornecedores, " +
        "vendedores, precos_art, artfam, artsubfam, armazens, taxas_iva, cond_pag, " +
        "escaloes_cli, doc_tipos). As tabelas de movimento estão bloqueadas. " +
        "A chave primária TEM de vir nos valores — esta base não tem colunas automáticas, " +
        "todas as chaves são naturais. Usa describe_table antes, para saberes as colunas e " +
        "a chave, e run_query para descobrires a próxima chave livre (ex.: SELECT max(no_cli)+1 " +
        "FROM clientes). Devolve a linha criada.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      inputSchema: {
        tabela: z
          .string()
          .min(1, "O nome da tabela não pode estar vazio.")
          .describe("Tabela de dados mestre onde criar a linha, por exemplo 'clientes'."),
        valores: esquemaValores.describe(
          "Objeto coluna->valor com os dados da linha nova, incluindo a chave primária. " +
            "Colunas omitidas ficam com o valor por omissão da tabela (normalmente NULL). " +
            "Usa null explícito para gravar NULL.",
        ),
      },
    },
    async ({ tabela, valores }) => {
      try {
        const alvo = await resolverAlvoEscrita(tabela);

        // permitirChave = true: ao contrário do UPDATE, aqui a chave primária TEM
        // de vir. Não há sequências nem colunas identity nesta base — todas as
        // chaves são naturais e fornecidas de fora.
        const colunas = validarValores(alvo, valores as Record<string, ValorColuna>, true);

        // Se faltar alguma coluna da chave, o Postgres devolve um 23502 (NOT NULL)
        // que o erros.ts já traduz. Mas dizê-lo aqui poupa uma ida à base e dá uma
        // mensagem que aponta ao problema real em vez de à coluna.
        const chaveEmFalta = alvo.chavePrimaria.filter((c) => !colunas.includes(c));
        if (chaveEmFalta.length > 0) {
          // ErroValidacao e não Error: só as mensagens de ErroValidacao passam
          // intactas pelo mensagemSegura(). Um Error normal saía embrulhado num
          // "Erro inesperado:", que é precisamente o que isto não é.
          throw new ErroValidacao(
            `Faltam colunas da chave primária: ${chaveEmFalta.join(", ")}. ` +
              `A chave de "${alvo.tabela}" é (${alvo.chavePrimaria.join(", ")}) e tem de vir ` +
              "sempre nos valores — esta base não tem colunas automáticas.",
          );
        }

        const listaColunas = colunas.map(citarIdentificador).join(", ");
        const marcadores = colunas.map((_, i) => `$${i + 1}`).join(", ");
        const parametros = colunas.map((c) => (valores as Record<string, ValorColuna>)[c] ?? null);

        // O RETURNING * não é cosmético: é ele que faz o Postgres contar as linhas
        // afetadas (a guarda da Camada 3 depende disso) e é ele que permite
        // devolver a linha tal como ficou, com os valores por omissão já aplicados.
        const sql =
          `INSERT INTO ${citarIdentificador(alvo.tabela)} (${listaColunas}) ` +
          `VALUES (${marcadores}) RETURNING *`;

        const resultado = await executarEscrita(
          sql,
          parametros,
          "INSERT",
          `a linha nova em ${alvo.tabela}`,
        );

        return respostaOk({
          operacao: "insert",
          tabela: alvo.tabela,
          linhas_afetadas: resultado.rowCount,
          chave_primaria: alvo.chavePrimaria,
          // Mostrar o SQL executado é a mesma questão de honestidade do run_query:
          // quem chamou a tool tem de conseguir ver o que foi mesmo feito. Os
          // valores não aparecem aqui porque foram parâmetros — vão na linha.
          sql_executado: sql,
          linha: resultado.rows[0] ?? null,
        });
      } catch (erro) {
        return respostaErro(erro);
      }
    },
  );
}
