/**
 * Tool `run_query` — corre SQL arbitrário do utilizador, com as três camadas.
 *
 * É a única tool que aceita SQL escrito de fora, e por isso é a única que precisa
 * das validações todas. Este ficheiro é sobretudo o sítio onde se vê a ORDEM por
 * que as camadas se aplicam; a lógica de cada uma vive no seu próprio ficheiro.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { executarSoLeitura, timeoutEmVigor } from "../db.js";
import { validarSelectUnico } from "../seguranca/camada1-parser.js";
import { aplicarLimite, lerLimitesDoAmbiente } from "../seguranca/camada3-limites.js";
import { respostaErro, respostaOk } from "./resposta.js";

export function registarRunQuery(server: McpServer): void {
  const limites = lerLimitesDoAmbiente();

  server.registerTool(
    "run_query",
    {
      title: "Executar query SQL",
      description:
        "Executa uma query SELECT na base de dados do distribuidor e devolve as linhas. " +
        `Só são aceites instruções SELECT (incluindo WITH ... SELECT). Queries sem LIMIT ` +
        `recebem automaticamente LIMIT ${limites.automatico}; um LIMIT explícito acima de ` +
        `${limites.maximo} é recusado. Cada query tem um limite de tempo de execução.`,
      inputSchema: {
        sql: z
          .string()
          .min(1, "A query não pode estar vazia.")
          .describe(
            "A query SELECT a executar. Uma única instrução, sem ponto e vírgula a separar várias.",
          ),
      },
    },
    async ({ sql }) => {
      try {
        // --- CAMADA 1 -------------------------------------------------------
        // Puramente sintática, decidida sem tocar na base de dados. É a primeira
        // porque é a mais barata: uma query maliciosa nem chega a abrir ligação.
        const { limiteExplicito } = validarSelectUnico(sql);

        // --- CAMADA 3 (parte do LIMIT) --------------------------------------
        // Corre antes da execução porque pode MODIFICAR o SQL (embrulhando-o) ou
        // recusar o pedido por o LIMIT ser demasiado alto.
        const limitada = aplicarLimite(sql, limiteExplicito, limites);

        // Voltar a validar o SQL já embrulhado é barato e prova que o embrulho
        // não produziu nada inesperado. Se um dia alguém mexer na função que
        // embrulha e introduzir um erro, é aqui que rebenta — em vez de ir uma
        // query malformada (ou pior) para a base de dados.
        validarSelectUnico(limitada.sql);

        // --- CAMADA 2 (+ o timeout da Camada 3) -----------------------------
        // A transação READ ONLY e o statement_timeout vivem dentro do
        // executarSoLeitura. Mesmo que as camadas 1 e 3 tivessem falhado as
        // duas, o Postgres continuaria a recusar qualquer escrita aqui.
        const resultado = await executarSoLeitura(limitada.sql);

        return respostaOk({
          linhas: resultado.rowCount,
          limite_aplicado: limitada.nota,
          timeout_ms: timeoutEmVigor(),
          // Devolver o SQL efetivamente executado é uma questão de honestidade:
          // se o servidor alterou a query, quem a escreveu tem de o conseguir
          // ver, para perceber porque é que o resultado tem as linhas que tem.
          sql_executado: limitada.sql,
          colunas: resultado.fields.map((campo) => campo.name),
          dados: resultado.rows,
        });
      } catch (erro) {
        // Apanha as recusas das camadas 1 e 3 (ErroValidacao) e os erros vindos
        // do Postgres, todos pelo mesmo caminho. O respostaErro trata de os
        // sanitizar antes de saírem.
        return respostaErro(erro);
      }
    },
  );
}
