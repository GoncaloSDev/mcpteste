/**
 * Tool `restore_row` — devolve ao ativo uma linha arquivada.
 *
 * É o que faz do arquivo uma porta de duas vias, e por isso é a tool que torna o
 * archive_row seguro: sem ela, arquivar seria irreversível na prática e valia
 * tanto como apagar.
 *
 * O PROBLEMA QUE ESTA TOOL TEM DE RESOLVER, e que não é evidente:
 *
 * A linha a repor está arquivada. Uma linha arquivada é invisível — e não é
 * invisível só para as leituras, é invisível para tudo, porque a política de RLS
 * que a esconde aplica-se também ao UPDATE que a quer alcançar. Um
 * `UPDATE clientes SET arquivado_em = NULL WHERE no_cli = 42` corrido pelo
 * mcp_escrita não encontra linha nenhuma: para essa ligação, a linha não existe.
 *
 * Daí o `incluirArquivados: true` lá em baixo. Levanta o véu durante esta
 * transação — e só durante esta —, através de um SET LOCAL que morre no COMMIT.
 * É a única razão pela qual a política tem uma exceção.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ContextoEscrita } from "../acesso/contexto.js";
import { ErroValidacao } from "../erros.js";
import { citarIdentificador } from "../identificadores.js";
import { COLUNA_ARQUIVO, erroNaoExiste, lerEstadoArquivo } from "../seguranca/arquivo.js";
import {
  resolverAlvoEscrita,
  validarChavePrimaria,
  type ValorColuna,
} from "../seguranca/escrita-camada1-alvo.js";
import { construirAtribuicoes, descreverChave, esquemaValores } from "./escritaComum.js";
import { respostaErro, respostaOk } from "./resposta.js";

export function registarRestoreRow(server: McpServer, contexto: ContextoEscrita): void {
  server.registerTool(
    "restore_row",
    {
      title: "Desarquivar linha",
      description:
        "Devolve ao ativo UMA linha que tinha sido arquivada, identificada pela chave " +
        "primária completa. A linha volta a aparecer em todas as consultas. É o inverso " +
        "exato do archive_row e não perde nada pelo caminho — os dados nunca chegaram a sair " +
        "da base. Para descobrir o que está arquivado, usa run_query com " +
        "incluir_arquivados=true e filtra por arquivado_em IS NOT NULL.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      inputSchema: {
        tabela: z
          .string()
          .min(1, "O nome da tabela não pode estar vazio.")
          .describe("Tabela de dados mestre onde repor a linha, por exemplo 'clientes'."),
        chave: esquemaValores.describe(
          "Objeto com a chave primária COMPLETA da linha a desarquivar, por exemplo " +
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

        const estado = await lerEstadoArquivo(
          contexto,
          alvo.tabela,
          condicoes.fragmentos,
          condicoes.parametros,
        );

        if (!estado.existe) {
          throw erroNaoExiste(alvo.tabela, descricaoChave);
        }
        if (estado.arquivadoEm === null) {
          throw new ErroValidacao(
            `A linha ${alvo.tabela} onde ${descricaoChave} não está arquivada — já está ativa. ` +
              "Nada foi alterado.",
          );
        }

        const sql =
          `UPDATE ${citarIdentificador(alvo.tabela)} ` +
          `SET ${citarIdentificador(COLUNA_ARQUIVO)} = NULL ` +
          `WHERE ${condicoes.fragmentos.join(" AND ")} RETURNING *`;

        const resultado = await contexto.executarEscrita(
          sql,
          condicoes.parametros,
          "UPDATE",
          `${alvo.tabela} onde ${descricaoChave}`,
          // Sem isto o UPDATE não vê a linha e a Camada 3 rejeitava com "nenhuma
          // linha corresponde" — a dizer que não existe uma linha que existe.
          { incluirArquivados: true },
        );

        return respostaOk({
          operacao: "desarquivar",
          tabela: alvo.tabela,
          linhas_afetadas: resultado.rowCount,
          chave: descricaoChave,
          arquivada_desde: estado.arquivadoEm.toISOString(),
          sql_executado: sql,
          nota: "A linha voltou ao ativo e é outra vez visível em todas as consultas.",
          linha_reposta: resultado.rows[0] ?? null,
        });
      } catch (erro) {
        return respostaErro(erro);
      }
    },
  );
}
