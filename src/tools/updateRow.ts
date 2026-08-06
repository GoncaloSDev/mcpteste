/**
 * Tool `update_row` — altera UMA linha, identificada pela chave primária.
 *
 * O WHERE é sempre a chave primária completa e nunca uma condição escrita de
 * fora. É essa restrição que torna o "afeta exatamente uma linha" da Camada 3
 * uma consequência do desenho, e não uma esperança: não existe forma de pedir a
 * esta tool que altere um conjunto de linhas.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ContextoEscrita } from "../acesso/contexto.js";
import { citarIdentificador } from "../identificadores.js";
import {
  resolverAlvoEscrita,
  validarChavePrimaria,
  validarValores,
  type ValorColuna,
} from "../seguranca/escrita-camada1-alvo.js";
import { construirAtribuicoes, descreverChave, esquemaValores } from "./escritaComum.js";
import { respostaErro, respostaOk } from "./resposta.js";

export function registarUpdateRow(server: McpServer, contexto: ContextoEscrita): void {
  server.registerTool(
    "update_row",
    {
      title: "Editar linha",
      description:
        "Altera UMA linha de uma tabela de dados mestre, identificada pela chave primária " +
        "completa. Não é possível atualizar várias linhas de uma vez nem alterar a própria " +
        "chave primária. Só as colunas indicadas em 'valores' são tocadas; as restantes ficam " +
        "como estão. Se nenhuma linha corresponder à chave, nada é alterado e a tool devolve " +
        "erro. Usa describe_table para veres a chave primária da tabela. Devolve a linha já " +
        "alterada.",
      annotations: {
        readOnlyHint: false,
        // Um UPDATE substitui dados que estavam lá — não há como os recuperar.
        destructiveHint: true,
        // Repetir a mesma chamada deixa a linha no mesmo estado.
        idempotentHint: true,
      },
      inputSchema: {
        tabela: z
          .string()
          .min(1, "O nome da tabela não pode estar vazio.")
          .describe("Tabela de dados mestre a alterar, por exemplo 'clientes'."),
        chave: esquemaValores.describe(
          "Objeto com a chave primária COMPLETA da linha a alterar, por exemplo " +
            "{\"no_cli\": 42}. Em chaves compostas têm de vir todas as colunas — a de " +
            "precos_art é (cod_art, escalao, dt_ini).",
        ),
        valores: esquemaValores.describe(
          "Objeto coluna->valor com as alterações. Só estas colunas são tocadas. " +
            "Usa null para pôr uma coluna a NULL.",
        ),
      },
    },
    async ({ tabela, chave, valores }) => {
      try {
        const alvo = await resolverAlvoEscrita(contexto, tabela);

        const chaveTipada = chave as Record<string, ValorColuna>;
        const valoresTipados = valores as Record<string, ValorColuna>;

        // permitirChave = false: mudar a chave primária num UPDATE é recusado.
        // A razão está no escrita-camada1-alvo.ts.
        const colunasSet = validarValores(alvo, valoresTipados, false);
        const colunasChave = validarChavePrimaria(alvo, chaveTipada);

        // O SET vem primeiro na query, portanto fica com os $1..$n; o WHERE
        // continua a numeração a partir daí. Trocar a ordem escreveria os valores
        // nas colunas erradas — daí os offsets serem calculados e não escritos.
        const atribuicoes = construirAtribuicoes(colunasSet, valoresTipados, 1);
        const condicoes = construirAtribuicoes(
          colunasChave,
          chaveTipada,
          atribuicoes.parametros.length + 1,
        );

        const sql =
          `UPDATE ${citarIdentificador(alvo.tabela)} ` +
          `SET ${atribuicoes.fragmentos.join(", ")} ` +
          `WHERE ${condicoes.fragmentos.join(" AND ")} RETURNING *`;

        const descricaoChave = descreverChave(chaveTipada);

        const resultado = await contexto.executarEscrita(
          sql,
          [...atribuicoes.parametros, ...condicoes.parametros],
          "UPDATE",
          `${alvo.tabela} onde ${descricaoChave}`,
        );

        return respostaOk({
          operacao: "update",
          tabela: alvo.tabela,
          linhas_afetadas: resultado.rowCount,
          chave: descricaoChave,
          colunas_alteradas: colunasSet,
          sql_executado: sql,
          linha: resultado.rows[0] ?? null,
        });
      } catch (erro) {
        return respostaErro(erro);
      }
    },
  );
}
