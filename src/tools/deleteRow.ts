/**
 * Tool `delete_row` — apaga UMA linha, identificada pela chave primária.
 *
 * É a única das três que exige um `confirmar: true` explícito. Não é teatro: um
 * INSERT errado desfaz-se com um DELETE e um UPDATE errado desfaz-se com outro
 * UPDATE — desde que se saiba o valor anterior, e a resposta do update_row
 * devolve-o. Um DELETE não se desfaz com nada. Obrigar a um segundo campo faz do
 * apagar uma decisão em vez de um efeito lateral de uma chamada mal formada.
 *
 * A rede de segurança mais forte, porém, não é esta: são as chaves estrangeiras.
 * Apagar um cliente que ainda tem documentos, ou um artigo que ainda tem stock, é
 * recusado pelo próprio Postgres com um 23503. Foi por isso que as tabelas de
 * dados mestre puderam ser abertas à escrita — a integridade referencial delas
 * está mesmo declarada no schema, ao contrário dos invariantes de negócio das
 * transacionais, que só existem no código do seed.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { executarEscrita } from "../db-escrita.js";
import { citarIdentificador } from "../identificadores.js";
import {
  resolverAlvoEscrita,
  validarChavePrimaria,
  type ValorColuna,
} from "../seguranca/escrita-camada1-alvo.js";
import { ErroValidacao } from "../erros.js";
import { construirAtribuicoes, descreverChave, esquemaValores } from "./escritaComum.js";
import { respostaErro, respostaOk } from "./resposta.js";

export function registarDeleteRow(server: McpServer): void {
  server.registerTool(
    "delete_row",
    {
      title: "Apagar linha",
      description:
        "Apaga UMA linha de uma tabela de dados mestre, identificada pela chave primária " +
        "completa. Exige confirmar=true. Não é possível apagar várias linhas de uma vez. " +
        "Se a linha estiver referida por outras tabelas (um cliente com documentos, um artigo " +
        "com stock), o Postgres recusa e nada é apagado. A operação NÃO É REVERSÍVEL — confirma " +
        "primeiro o que lá está com run_query. Devolve a linha apagada.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        // Repetir a chamada dá erro ("nenhuma linha corresponde"), não apaga
        // mais nada — mas o estado final é o mesmo, e é isso que a dica indica.
        idempotentHint: true,
      },
      inputSchema: {
        tabela: z
          .string()
          .min(1, "O nome da tabela não pode estar vazio.")
          .describe("Tabela de dados mestre de onde apagar, por exemplo 'clientes'."),
        chave: esquemaValores.describe(
          "Objeto com a chave primária COMPLETA da linha a apagar, por exemplo " +
            "{\"no_cli\": 42}. Em chaves compostas têm de vir todas as colunas.",
        ),
        confirmar: z
          .boolean()
          .describe(
            "Tem de ser true. Existe para o apagar ser deliberado — ao contrário de um " +
              "insert ou de um update, um delete não se desfaz.",
          ),
      },
    },
    async ({ tabela, chave, confirmar }) => {
      try {
        // Antes de tudo o resto, e antes de qualquer ida à base de dados.
        if (confirmar !== true) {
          throw new ErroValidacao(
            "delete_row exige confirmar=true. Nada foi apagado. " +
              "Confirma primeiro a linha com run_query e volta a chamar com confirmar=true.",
          );
        }

        const alvo = await resolverAlvoEscrita(tabela);
        const chaveTipada = chave as Record<string, ValorColuna>;
        const colunasChave = validarChavePrimaria(alvo, chaveTipada);

        const condicoes = construirAtribuicoes(colunasChave, chaveTipada, 1);

        const sql =
          `DELETE FROM ${citarIdentificador(alvo.tabela)} ` +
          `WHERE ${condicoes.fragmentos.join(" AND ")} RETURNING *`;

        const descricaoChave = descreverChave(chaveTipada);

        const resultado = await executarEscrita(
          sql,
          condicoes.parametros,
          "DELETE",
          `${alvo.tabela} onde ${descricaoChave}`,
        );

        return respostaOk({
          operacao: "delete",
          tabela: alvo.tabela,
          linhas_afetadas: resultado.rowCount,
          chave: descricaoChave,
          sql_executado: sql,
          // A linha apagada vai na resposta de propósito: é o único registo que
          // resta dela, e é o que permite recriá-la com insert_row se o apagar
          // tiver sido um engano.
          linha_apagada: resultado.rows[0] ?? null,
        });
      } catch (erro) {
        return respostaErro(erro);
      }
    },
  );
}
