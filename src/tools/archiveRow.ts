/**
 * Tool `archive_row` — arquiva UMA linha, identificada pela chave primária.
 *
 * É o novo "apagar" do dia-a-dia, e a diferença face a um DELETE é toda ela a
 * mesma: isto desfaz-se. A linha continua lá, com os dados todos, e volta ao
 * ativo com um `restore_row`. O que muda é que deixa de ser vista — por este
 * servidor e por qualquer query que passe por ele, incluindo as do run_query.
 *
 * A INVISIBILIDADE NÃO É FEITA AQUI, e vale a pena insistir nisso porque é o que
 * distingue esta implementação de uma que só parecesse funcionar: tudo o que esta
 * tool faz é preencher uma coluna com um timestamp. Quem esconde a linha é uma
 * política de Row-Level Security do Postgres, aplicada a todas as tabelas pelo
 * seed do testeai-db. Não há aqui nenhum filtro a acrescentar a nenhuma query
 * — e é por não haver que não há nenhum sítio onde ele possa faltar.
 *
 * Ao contrário do delete_row, não exige `confirmar`. Não precisa: é reversível, e
 * pedir confirmação para uma ação reversível só ensina a confirmar sem ler.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ContextoEscrita } from "../acesso/contexto.js";
import { citarIdentificador } from "../identificadores.js";
import {
  COLUNA_ARQUIVO,
  erroJaArquivado,
  erroNaoExiste,
  lerEstadoArquivo,
} from "../seguranca/arquivo.js";
import {
  resolverAlvoEscrita,
  validarChavePrimaria,
  type ValorColuna,
} from "../seguranca/escrita-camada1-alvo.js";
import { construirAtribuicoes, descreverChave, esquemaValores } from "./escritaComum.js";
import { respostaErro, respostaOk } from "./resposta.js";

export function registarArchiveRow(server: McpServer, contexto: ContextoEscrita): void {
  server.registerTool(
    "archive_row",
    {
      title: "Arquivar linha",
      description:
        "Arquiva UMA linha de uma tabela de dados mestre, identificada pela chave primária " +
        "completa. A linha deixa de aparecer em qualquer consulta feita por este servidor — " +
        "incluindo dentro de JOINs e subqueries do run_query — mas NÃO é apagada: os dados " +
        "continuam lá e voltam ao ativo com restore_row. É esta a forma normal de tirar um " +
        "registo de circulação. Ao contrário de apagar, não é preciso que nada deixe de lhe " +
        "apontar: os documentos de um cliente arquivado continuam válidos e intactos.",
      annotations: {
        readOnlyHint: false,
        // Não é destrutivo no sentido que interessa a esta dica: nada se perde e
        // o restore_row põe tudo como estava.
        destructiveHint: false,
        // Repetir a chamada dá erro em vez de arquivar duas vezes, mas o estado
        // final é o mesmo.
        idempotentHint: true,
      },
      inputSchema: {
        tabela: z
          .string()
          .min(1, "O nome da tabela não pode estar vazio.")
          .describe("Tabela de dados mestre onde arquivar, por exemplo 'clientes'."),
        chave: esquemaValores.describe(
          "Objeto com a chave primária COMPLETA da linha a arquivar, por exemplo " +
            '{"no_cli": 42}. Em chaves compostas têm de vir todas as colunas.',
        ),
      },
    },
    async ({ tabela, chave }) => {
      try {
        const alvo = await resolverAlvoEscrita(contexto, tabela);
        const chaveTipada = chave as Record<string, ValorColuna>;
        const colunasChave = validarChavePrimaria(alvo, chaveTipada);

        const condicoes = construirAtribuicoes(colunasChave, chaveTipada, 1);
        const descricaoChave = descreverChave(chaveTipada);

        // Ler ANTES de escrever, para poder distinguir "não existe" de "já estava
        // arquivada". Um UPDATE cego devolveria zero linhas nos dois casos, e a
        // Camada 3 diria "nenhuma linha corresponde" — verdade, mas inútil: o
        // conselho certo é diferente conforme o caso.
        const estado = await lerEstadoArquivo(
          contexto,
          alvo.tabela,
          condicoes.fragmentos,
          condicoes.parametros,
        );

        if (!estado.existe) {
          throw erroNaoExiste(alvo.tabela, descricaoChave);
        }
        if (estado.arquivadoEm !== null) {
          throw erroJaArquivado(alvo.tabela, descricaoChave, estado.arquivadoEm);
        }

        // now() e não um timestamp vindo do Node: o relógio que interessa é o do
        // servidor de base de dados, o mesmo que carimba tudo o resto. Duas fontes
        // de tempo numa base só produzem ordenações que não batem certo.
        const sql =
          `UPDATE ${citarIdentificador(alvo.tabela)} ` +
          `SET ${citarIdentificador(COLUNA_ARQUIVO)} = now() ` +
          `WHERE ${condicoes.fragmentos.join(" AND ")} RETURNING *`;

        // PORQUE É QUE ARQUIVAR PRECISA DE LEVANTAR O VÉU, o que parece o
        // contrário do que faria sentido — a linha ainda está ativa quando este
        // UPDATE começa, e portanto é visível.
        //
        // Porque o Postgres não valida só a linha ANTIGA contra a política de
        // RLS: valida também a linha NOVA, e valida-a contra a política de
        // SELECT. Faz sentido visto de fora — o modelo do RLS não deixa alguém
        // transformar uma linha sua numa linha que deixa de poder ver. Mas é
        // exatamente isso que arquivar é: o resultado do UPDATE tem
        // `arquivado_em` preenchido, ou seja falha `arquivado_em IS NULL`, e a
        // instrução morre com um 42501 "new row violates row-level security
        // policy" — um erro de PERMISSÃO a falar de uma linha que nós próprios
        // acabámos de escrever.
        //
        // (Isto custou uma bateria de testes vermelha a descobrir. O
        // WITH CHECK (true) da política, que existe precisamente para deixar
        // passar a linha nova, não chega: ele governa a política de escrita, e
        // quem estava a barrar era a de leitura.)
        const resultado = await contexto.executarEscrita(
          sql,
          condicoes.parametros,
          "UPDATE",
          `${alvo.tabela} onde ${descricaoChave}`,
          { incluirArquivados: true },
        );

        return respostaOk({
          operacao: "arquivar",
          tabela: alvo.tabela,
          linhas_afetadas: resultado.rowCount,
          chave: descricaoChave,
          sql_executado: sql,
          reversivel: true,
          nota:
            "A linha deixou de ser visível para este servidor, mas continua na base de dados " +
            "com todos os dados intactos. Usa restore_row para a repor. Para a destruir mesmo " +
            "(e com ela tudo o que lhe aponta), delete_row.",
          linha_arquivada: resultado.rows[0] ?? null,
        });
      } catch (erro) {
        return respostaErro(erro);
      }
    },
  );
}
