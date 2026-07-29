/**
 * O ARQUIVO (soft delete) do lado do servidor.
 *
 * Este ficheiro é pequeno de propósito, e o que ele NÃO faz é a parte
 * interessante: não filtra nada. O filtro que esconde os registos arquivados não
 * vive aqui nem em nenhuma tool — vive no Postgres, numa política de Row-Level
 * Security aplicada pelo seed do agentsystem-db (ver reporRlsArquivo() lá).
 *
 * A razão é o `run_query`. Sendo ele uma tool que aceita SQL escrito do outro
 * lado, um filtro em TypeScript teria de reescrever a árvore de cada SELECT para
 * acrescentar `AND arquivado_em IS NULL` a todas as tabelas mencionadas —
 * incluindo as de dentro de JOINs, subqueries, CTEs e UNIONs. Um único caso
 * esquecido não dá erro: devolve linhas arquivadas em silêncio. No Postgres não
 * há nada a reescrever e não há casos a esquecer.
 *
 * O que sobra para este lado é só isto: o nome da coluna, o nome do interruptor
 * que abre a exceção, e as regras sobre o que se pode fazer a uma linha conforme
 * ela esteja arquivada ou não.
 */

import { executarSoLeitura } from "../db.js";
import { ErroValidacao } from "../erros.js";
import { citarIdentificador } from "../identificadores.js";

/**
 * A coluna que marca o arquivo. NULL = ativo; preenchido = arquivado.
 *
 * É um timestamp e não um booleano porque "quando" é informação que não custa
 * nada guardar e que se perde para sempre se a coluna for um sim/não. A pergunta
 * "isto foi arquivado antes ou depois de a encomenda ter entrado?" só tem
 * resposta com uma data.
 */
export const COLUNA_ARQUIVO = "arquivado_em";

/**
 * O interruptor que abre a exceção na política de RLS.
 *
 * Uma linha arquivada é invisível — o que inclui ser invisível para o UPDATE que
 * a quer desarquivar e para o DELETE que a quer apagar. Sem uma forma de a ver, o
 * arquivo era uma porta só de ida.
 *
 * O SET LOCAL que liga isto está no db.ts e no db-escrita.ts, e o LOCAL não é
 * negociável: limita o efeito à transação, que morre no COMMIT. Um SET normal
 * duraria a sessão, e a sessão sobrevive à devolução da ligação ao pool — a
 * exceção ficava colada à ligação e a leitura seguinte que calhasse nela via
 * arquivados sem os ter pedido.
 *
 * O prefixo `mcp.` é obrigatório: o Postgres só aceita parâmetros de sessão
 * definidos por extensões se tiverem um prefixo com ponto.
 */
export const GUC_INCLUIR_ARQUIVADOS = "mcp.incluir_arquivados";

/**
 * Estado de arquivo de uma linha, tal como as tools de escrita precisam de o
 * conhecer antes de decidir o que fazer.
 */
export interface EstadoArquivo {
  /** A linha existe mesmo (arquivada ou não). */
  existe: boolean;
  /** Momento do arquivo, ou null se estiver ativa. */
  arquivadoEm: Date | null;
}

/**
 * Lê o estado de arquivo de UMA linha, identificada pela chave primária.
 *
 * É a primeira coisa que as três tools do arquivo fazem, e é o que lhes permite
 * distinguir os três desfechos que de outra forma se confundiriam num só: a
 * linha não existe, a linha existe e está ativa, a linha existe e está arquivada.
 * Sem esta leitura prévia, um UPDATE que não encontra nada dá sempre a mesma
 * resposta ("0 linhas") tenha a linha sido apagada ontem ou esteja apenas
 * escondida pelo arquivo — e essas duas situações pedem conselhos opostos.
 *
 * Corre com o véu levantado, obviamente: procurar uma linha arquivada com o véu
 * em baixo devolvia sempre "não existe".
 *
 * Vai pela ligação DE LEITURA. É a mesma escolha que o resto da Camada 1 da
 * escrita faz: a ligação de escrita serve para a instrução final e para mais
 * nada.
 */
export async function lerEstadoArquivo(
  tabela: string,
  fragmentosChave: readonly string[],
  parametros: readonly unknown[],
): Promise<EstadoArquivo> {
  const resultado = await executarSoLeitura<{ arquivado_em: Date | null }>(
    `SELECT ${citarIdentificador(COLUNA_ARQUIVO)} AS arquivado_em ` +
      `FROM ${citarIdentificador(tabela)} ` +
      `WHERE ${fragmentosChave.join(" AND ")}`,
    [...parametros],
    { incluirArquivados: true },
  );

  const linha = resultado.rows[0];
  if (linha === undefined) {
    return { existe: false, arquivadoEm: null };
  }
  return { existe: true, arquivadoEm: linha.arquivado_em };
}

/** Mensagem única para "esta linha não existe de todo". */
export function erroNaoExiste(tabela: string, chave: string): ErroValidacao {
  return new ErroValidacao(
    `Não existe nenhuma linha em ${tabela} onde ${chave} — nem ativa nem arquivada. ` +
      "Confirma os valores da chave primária com a tool run_query.",
  );
}

/**
 * Recusa mexer na coluna de arquivo por outra via que não as tools próprias.
 *
 * Sem isto, `update_row(clientes, {arquivado_em: null})` desarquivava um registo
 * sem passar pelo restore_row, e `update_row(clientes, {arquivado_em:
 * now})` arquivava um sem passar pelo archive_row. As duas tools próprias
 * deixavam de ser o caminho e passavam a ser uma sugestão — e o pré-requisito de
 * "tem de estar arquivado para poder ser apagado" deixava de significar alguma
 * coisa, porque qualquer update o podia satisfazer.
 *
 * A regra é a mesma da chave primária: há colunas cuja alteração tem
 * consequências que um update genérico não pode explicar a quem o pediu.
 */
export function recusarEscritaDiretaNoArquivo(colunas: readonly string[]): void {
  if (colunas.includes(COLUNA_ARQUIVO)) {
    throw new ErroValidacao(
      `A coluna "${COLUNA_ARQUIVO}" não se altera por insert_row nem por update_row.\n` +
        "Usa as tools próprias: archive_row para arquivar, restore_row para " +
        "repor. São elas que garantem que arquivar é sempre reversível e que apagar " +
        "definitivamente só acontece a quem já passou pelo arquivo.",
    );
  }
}

/** Mensagem única para "esta linha já está arquivada". */
export function erroJaArquivado(tabela: string, chave: string, quando: Date): ErroValidacao {
  return new ErroValidacao(
    `A linha ${tabela} onde ${chave} já estava arquivada em ${quando.toISOString()}. ` +
      "Nada foi alterado. Usa restore_row se a querias repor, ou delete_row " +
      "se a querias mesmo destruir.",
  );
}

/** Mensagem única para "esta linha não está arquivada". */
export function erroNaoArquivado(tabela: string, chave: string): ErroValidacao {
  return new ErroValidacao(
    `A linha ${tabela} onde ${chave} não está arquivada. ` +
      "Só se apaga definitivamente o que já foi arquivado antes — é esse passo que torna " +
      "o apagar uma segunda decisão e não um engano de um só pedido. " +
      "Arquiva-a primeiro com archive_row.",
  );
}
