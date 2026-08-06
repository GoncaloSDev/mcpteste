/**
 * O QUE VAI ABAIXO JUNTO — contagem do efeito de um apagar definitivo.
 *
 * Todas as chaves estrangeiras desta base têm `ON DELETE CASCADE`. Isso quer
 * dizer que um `DELETE FROM clientes WHERE no_cli = 1001` não apaga um cliente:
 * apaga o cliente, os documentos de venda dele, as linhas desses documentos, os
 * movimentos de conta corrente e as comissões que lhes estavam associadas. E fá-
 * -lo em silêncio, porque a cascata é executada pelo Postgres sem passar por
 * nenhuma das camadas deste servidor — os gatilhos de integridade referencial
 * correm com os privilégios do dono da tabela e ignoram tanto as permissões do
 * mcp_escrita como as políticas de RLS.
 *
 * Há casos muito piores do que o do cliente. `taxas_iva` é referida por `artfam`
 * e por `artigos`; `artfam` é referida por `artsubfam` e por `artigos`; `artigos`
 * é referida por `precos_art`, `stocks`, `linhas_doc` e `linhas_compra`. Apagar
 * UMA taxa de IVA arrasta atrás de si uma parte substancial da base de dados.
 *
 * Este ficheiro existe para que isso deixe de ser invisível. Antes de apagar
 * seja o que for, percorre o grafo de chaves estrangeiras a partir da linha
 * visada e conta, tabela a tabela, quantas linhas o Postgres vai levar consigo.
 * A tool devolve essa contagem na resposta.
 *
 * A contagem NÃO impede o apagar — a decisão de o CASCADE existir foi tomada de
 * propósito, e a rede de segurança é outra (só se apaga o que já está arquivado,
 * e só com confirmar=true). O que isto impede é apagar sem saber o que se apagou.
 */

import type { ContextoLeitura } from "../acesso/contexto.js";
import { citarIdentificador } from "../identificadores.js";

/** O que uma tabela dependente perde quando a linha visada for apagada. */
export interface ImpactoTabela {
  tabela: string;
  /** O caminho pelo qual esta tabela depende da linha visada. */
  via: string;
  linhas: number;
  /** Distância em saltos de chave estrangeira até à linha visada. */
  profundidade: number;
}

/**
 * Teto de profundidade da travessia.
 *
 * O grafo desta base é acíclico e raso (o caminho mais longo tem 4 saltos:
 * taxas_iva -> artfam -> artigos -> linhas_doc), portanto este limite nunca
 * dispara. Está cá porque o `visitadas` sozinho não chega: ele impede voltar à
 * MESMA tabela, mas um grafo com um ciclo entre tabelas diferentes ainda podia
 * crescer sem fim. É barato e transforma um enforcamento do servidor numa
 * resposta incompleta.
 */
const PROFUNDIDADE_MAXIMA = 8;

interface FkEntrada {
  tabela_origem: string;
  coluna_origem: string;
  coluna_destino: string;
  accao: string;
  colunas: number;
}

/**
 * Chaves estrangeiras que APONTAM para uma tabela (as filhas, não as pais).
 *
 * O `confdeltype` diz o que acontece à linha filha quando a pai é apagada: 'c' é
 * CASCADE, 'a' é NO ACTION, 'r' é RESTRICT, 'n' é SET NULL, 'd' é SET DEFAULT.
 * Só as 'c' arrastam linhas atrás de si; as outras ou bloqueiam o apagar ou
 * limitam-se a esvaziar a coluna, e em nenhum desses casos há linhas perdidas
 * para contar.
 *
 * O `array_length(conkey, 1)` vem para fora porque a construção do predicado
 * abaixo assume uma coluna só. Nesta base todas as chaves estrangeiras são de uma
 * coluna, mas assumi-lo em silêncio significaria contar mal no dia em que
 * deixasse de ser verdade — por isso o número vem e é verificado.
 */
const SQL_DEPENDENTES = `
  SELECT src.relname   AS tabela_origem,
         att_src.attname AS coluna_origem,
         att_tgt.attname AS coluna_destino,
         con.confdeltype AS accao,
         array_length(con.conkey, 1) AS colunas
    FROM pg_constraint con
    JOIN pg_class src     ON src.oid = con.conrelid
    JOIN pg_class tgt     ON tgt.oid = con.confrelid
    JOIN pg_namespace n   ON n.oid = src.relnamespace
    JOIN pg_attribute att_src ON att_src.attrelid = con.conrelid
                             AND att_src.attnum = con.conkey[1]
    JOIN pg_attribute att_tgt ON att_tgt.attrelid = con.confrelid
                             AND att_tgt.attnum = con.confkey[1]
   WHERE con.contype = 'f'
     AND n.nspname = 'public'
     AND tgt.relname = $1
   ORDER BY src.relname
`;

/**
 * Conta, por tabela, quantas linhas desaparecem se a linha visada for apagada.
 *
 * @param tabela      a tabela da linha a apagar
 * @param condicao    predicado SQL que identifica essa linha (com $1, $2...)
 * @param parametros  os valores desses $n
 *
 * A travessia é feita pela ligação DE LEITURA, com o véu do arquivo levantado. O
 * levantar não é um pormenor: as linhas dependentes podem estar elas próprias
 * arquivadas, e uma linha arquivada é apagada pela cascata exatamente como
 * qualquer outra. Contá-las com o véu em baixo dava um número menor do que a
 * realidade — que é o pior erro possível numa contagem cujo propósito é avisar.
 */
export async function calcularImpactoCascata(
  contexto: ContextoLeitura,
  tabela: string,
  condicao: string,
  parametros: readonly unknown[],
): Promise<ImpactoTabela[]> {
  const impacto: ImpactoTabela[] = [];
  await percorrer(contexto, tabela, condicao, parametros, 1, new Set([tabela]), impacto);
  // Da mais atingida para a menos: numa lista longa, o que interessa ver
  // primeiro é o maior estrago.
  return impacto.sort((a, b) => b.linhas - a.linhas);
}

async function percorrer(
  contexto: ContextoLeitura,
  tabela: string,
  condicao: string,
  parametros: readonly unknown[],
  profundidade: number,
  visitadas: Set<string>,
  acumulador: ImpactoTabela[],
): Promise<void> {
  if (profundidade > PROFUNDIDADE_MAXIMA) {
    return;
  }

  const dependentes = await contexto.executarLeitura<FkEntrada>(SQL_DEPENDENTES, [tabela]);

  for (const fk of dependentes.rows) {
    // Só o CASCADE arrasta linhas. Uma FK RESTRICT faz o Postgres recusar o
    // DELETE, e isso aparece a quem chamou como o erro 23503 de sempre.
    if (fk.accao !== "c") {
      continue;
    }
    // Chave composta: o predicado de uma coluna só que se constrói a seguir não
    // a representaria bem. Contar a menos seria pior do que não contar, por isso
    // salta-se — nesta base não acontece.
    if (fk.colunas !== 1) {
      continue;
    }
    // Uma auto-referência ou um caminho que volte a uma tabela já visitada não
    // acrescenta linhas novas à conta; acrescentaria só recursão.
    if (visitadas.has(fk.tabela_origem)) {
      continue;
    }

    // O predicado da filha, expresso à conta do predicado da pai. Encadeando-se
    // nível a nível, no fim é uma cebola de subqueries que descreve exatamente o
    // conjunto que o Postgres vai apagar — e usa os MESMOS $n, por isso a lista
    // de parâmetros nunca cresce.
    const condicaoFilha =
      `${citarIdentificador(fk.coluna_origem)} IN (` +
      `SELECT ${citarIdentificador(fk.coluna_destino)} FROM ${citarIdentificador(tabela)} ` +
      `WHERE ${condicao})`;

    const contagem = await contexto.executarLeitura<{ n: string }>(
      `SELECT count(*) AS n FROM ${citarIdentificador(fk.tabela_origem)} WHERE ${condicaoFilha}`,
      [...parametros],
      { incluirArquivados: true },
    );

    const linhas = Number(contagem.rows[0]?.n ?? 0);
    if (linhas === 0) {
      // Sem linhas aqui não há nada por baixo: o conjunto só encolhe à medida
      // que se desce. Não contar nem descer poupa uma travessia inteira.
      continue;
    }

    acumulador.push({
      tabela: fk.tabela_origem,
      via: `${fk.tabela_origem}.${fk.coluna_origem} -> ${tabela}.${fk.coluna_destino}`,
      linhas,
      profundidade,
    });

    // O `visitadas` é partilhado por toda a travessia, e é o que impede a mesma
    // tabela de ser contada duas vezes quando há dois caminhos até ela (artigos
    // chega-se por artfam e por artsubfam, por exemplo).
    visitadas.add(fk.tabela_origem);
    await percorrer(
      contexto,
      fk.tabela_origem,
      condicaoFilha,
      parametros,
      profundidade + 1,
      visitadas,
      acumulador,
    );
  }
}

/** Soma das linhas de todas as tabelas dependentes. */
export function totalDeLinhas(impacto: readonly ImpactoTabela[]): number {
  return impacto.reduce((soma, i) => soma + i.linhas, 0);
}
