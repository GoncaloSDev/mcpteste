/**
 * Tool `delete_row` — destrói UMA linha, e com ela tudo o que lhe aponta.
 *
 * ISTO MUDOU. Antes do arquivo, esta tool era o caminho normal para tirar um
 * registo de circulação, e as chaves estrangeiras eram a sua rede de segurança:
 * apagar um cliente com documentos era recusado pelo Postgres. Hoje o caminho
 * normal é o archive_row, e esta tool passou a ser a outra coisa — a destruição
 * mesmo, sem retorno.
 *
 * E a rede de segurança de antes deixou de existir. Todas as chaves estrangeiras
 * desta base passaram a ter ON DELETE CASCADE, o que significa que apagar um
 * cliente já NÃO é recusado: apaga o cliente, os documentos de venda dele, as
 * linhas desses documentos, os movimentos de conta corrente e as comissões
 * correspondentes. Apagar uma taxa de IVA arrasta as famílias, os artigos, os
 * preços, os stocks e as linhas de documento que dependem deles.
 *
 * A cascata é executada pelo Postgres, por gatilhos de integridade referencial
 * que correm com os privilégios do dono das tabelas. Não passam pela whitelist
 * deste servidor, não passam pelas políticas de RLS e não passam pela guarda de
 * linhas da Camada 3. Nenhuma das camadas deste projeto vê essas linhas a
 * desaparecer.
 *
 * O QUE SEGURA ISTO, então, são três coisas deliberadas:
 *
 *   1. A LINHA TEM DE ESTAR ARQUIVADA. Não há atalho: primeiro archive_row,
 *      depois delete_row. Fazem-se duas chamadas separadas, com um estado
 *      reversível pelo meio, e é nesse intervalo que um engano se vê e se
 *      desfaz. Um único pedido mal formado nunca destrói nada.
 *   2. `confirmar` TEM DE SER true.
 *   3. A RESPOSTA CONTA O ESTRAGO. Antes de apagar, o servidor percorre o grafo
 *      de chaves estrangeiras e conta, tabela a tabela, quantas linhas vão
 *      abaixo. Vai tudo na resposta.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ContextoEscrita } from "../acesso/contexto.js";
import { citarIdentificador } from "../identificadores.js";
import { erroNaoArquivado, erroNaoExiste, lerEstadoArquivo } from "../seguranca/arquivo.js";
import { calcularImpactoCascata, totalDeLinhas } from "../seguranca/cascata.js";
import {
  resolverAlvoEscrita,
  validarChavePrimaria,
  type ValorColuna,
} from "../seguranca/escrita-camada1-alvo.js";
import { construirAtribuicoes, descreverChave, esquemaValores } from "./escritaComum.js";
import { respostaErro, respostaOk } from "./resposta.js";

export function registarDeleteRow(server: McpServer, contexto: ContextoEscrita): void {
  server.registerTool(
    "delete_row",
    {
      title: "Apagar linha definitivamente",
      description:
        "Apaga DEFINITIVAMENTE uma linha já arquivada, e com ela TODAS as linhas que lhe " +
        "apontam, em cascata: apagar um cliente apaga os documentos de venda dele, as linhas " +
        "desses documentos, os movimentos de conta corrente e as comissões. NÃO É REVERSÍVEL " +
        "e não há cópia de segurança. A linha tem de ter sido arquivada antes com " +
        "archive_row — não há forma de apagar num só passo. Exige confirmar=true. " +
        "Na esmagadora maioria dos casos o que queres é archive_row, que tira o registo de " +
        "circulação sem destruir nada e se desfaz.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        tabela: z
          .string()
          .min(1, "O nome da tabela não pode estar vazio.")
          .describe("Tabela de dados mestre de onde apagar, por exemplo 'clientes'."),
        chave: esquemaValores.describe(
          "Objeto com a chave primária COMPLETA da linha a apagar, por exemplo " +
            '{"no_cli": 42}. Em chaves compostas têm de vir todas as colunas.',
        ),
        confirmar: z
          .boolean()
          .describe(
            "Tem de ser true para apagar. Com false (ou omitido) nada é apagado e a tool " +
              "devolve uma PRÉ-VISUALIZAÇÃO: quantas linhas de que tabelas iriam abaixo em " +
              "cascata. Chama primeiro assim para veres o estrago antes de o fazeres.",
          )
          .default(false),
      },
    },
    async ({ tabela, chave, confirmar }) => {
      try {
        const alvo = await resolverAlvoEscrita(contexto, tabela);
        const chaveTipada = chave as Record<string, ValorColuna>;
        const colunasChave = validarChavePrimaria(alvo, chaveTipada);

        const condicoes = construirAtribuicoes(colunasChave, chaveTipada, 1);
        const descricaoChave = descreverChave(chaveTipada);

        const estado = await lerEstadoArquivo(
          contexto,
          alvo.tabela,
          condicoes.fragmentos,
          condicoes.parametros,
        );

        if (!estado.existe) {
          throw erroNaoExiste(alvo.tabela, descricaoChave);
        }

        // Contado ANTES do DELETE, porque depois já não há nada para contar. O
        // predicado é o mesmo do WHERE, portanto a contagem descreve exatamente o
        // conjunto que vai desaparecer.
        const impacto = await calcularImpactoCascata(
          contexto,
          alvo.tabela,
          condicoes.fragmentos.join(" AND "),
          condicoes.parametros,
        );
        const arrastadasPrevistas = totalDeLinhas(impacto);

        // --- Pré-visualização -------------------------------------------------
        //
        // Sem confirmar=true não se apaga nada — mas em vez de um "falta
        // confirmar" seco, devolve-se o que a confirmação está a pedir para
        // confirmar. Um pedido de confirmação que não diz o que está em jogo
        // ensina a confirmar sem ler, e neste caso o que está em jogo pode ser
        // metade da base de dados.
        if (confirmar !== true) {
          return respostaOk({
            operacao: "pre_visualizacao",
            apagado: false,
            tabela: alvo.tabela,
            chave: descricaoChave,
            arquivada: estado.arquivadoEm !== null,
            arquivada_desde: estado.arquivadoEm?.toISOString() ?? null,
            linhas_que_seriam_arrastadas: arrastadasPrevistas,
            cascata: impacto,
            nota:
              estado.arquivadoEm === null
                ? "NADA FOI APAGADO. E não poderia ser: esta linha não está arquivada. " +
                  "Arquiva-a primeiro com archive_row — que é, na maioria dos casos, o " +
                  "único passo que querias mesmo dar."
                : `NADA FOI APAGADO. Para apagar mesmo, volta a chamar com confirmar=true — ` +
                  `e sabendo que isso destrói esta linha e mais ${arrastadasPrevistas} ` +
                  "linha(s) noutras tabelas, sem retorno.",
          });
        }

        // O PRÉ-REQUISITO. É o que transforma uma destruição irreversível em duas
        // decisões separadas no tempo, com um estado desfazível entre elas.
        if (estado.arquivadoEm === null) {
          throw erroNaoArquivado(alvo.tabela, descricaoChave);
        }

        const sql =
          `DELETE FROM ${citarIdentificador(alvo.tabela)} ` +
          `WHERE ${condicoes.fragmentos.join(" AND ")} RETURNING *`;

        const resultado = await contexto.executarEscrita(
          sql,
          condicoes.parametros,
          "DELETE",
          `${alvo.tabela} onde ${descricaoChave}`,
          // A linha está arquivada, logo invisível — sem levantar o véu o DELETE
          // não a alcançava.
          { incluirArquivados: true },
        );

        const arrastadas = arrastadasPrevistas;

        return respostaOk({
          operacao: "apagar_definitivo",
          apagado: true,
          tabela: alvo.tabela,
          linhas_afetadas: resultado.rowCount,
          chave: descricaoChave,
          arquivada_desde: estado.arquivadoEm.toISOString(),
          sql_executado: sql,
          reversivel: false,
          linhas_arrastadas_em_cascata: arrastadas,
          cascata: impacto,
          nota:
            arrastadas === 0
              ? "Nada dependia desta linha — só ela foi apagada."
              : `Além desta linha, o Postgres apagou ${arrastadas} linhas noutras tabelas por ` +
                "ON DELETE CASCADE. A lista em 'cascata' diz quais e por que caminho. " +
                "Não há forma de as repor a não ser voltando a correr o seed.",
          // A linha apagada vai na resposta pela mesma razão de sempre: é o único
          // registo que resta dela. Repor as dependentes, essas, já não é possível.
          linha_apagada: resultado.rows[0] ?? null,
        });
      } catch (erro) {
        return respostaErro(erro);
      }
    },
  );
}
