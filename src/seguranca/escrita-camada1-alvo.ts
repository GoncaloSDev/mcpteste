/**
 * CAMADA 1 DA ESCRITA — que tabela, que colunas, que chave.
 *
 * No caminho de leitura a Camada 1 é um parser: recebe SQL de fora e tem de
 * decidir se aquilo é mesmo só um SELECT. Aqui não há parser nenhum, e é essa a
 * diferença que interessa — as tools de escrita NÃO ACEITAM SQL. Recebem um nome
 * de tabela, um objeto de colunas e uma chave primária, e o SQL é construído
 * inteiramente por este servidor. A classe de ataques que o parser existe para
 * apanhar (stacked queries, escrita escondida em CTEs, comentários a esconder
 * palavras-chave) simplesmente não tem por onde entrar.
 *
 * O que fica por defender é diferente: que a escrita vá parar à tabela certa, a
 * colunas que existem, e a UMA linha identificada sem ambiguidade. É isso que
 * este ficheiro faz, e faz tudo antes de a query ser construída.
 *
 * Tudo o que é lido do catálogo passa pelo `executarSoLeitura` — ou seja, pela
 * ligação só-de-leitura e pela transação READ ONLY. A ligação de escrita só é
 * usada para a instrução final, e para mais nada.
 */

import type { ContextoLeitura } from "../acesso/contexto.js";
import { ErroValidacao } from "../erros.js";
import { recusarEscritaDiretaNoArquivo } from "./arquivo.js";

/**
 * As tabelas onde escrever é permitido: os dados mestre, 12 das 19.
 *
 * ESTA LISTA ESTÁ DUPLICADA, e é de propósito. A gémea vive no outro repositório,
 * em testeai-db/seed/src/tabelasEscrita.ts, onde vira privilégios reais do
 * Postgres. Aqui vira uma recusa antes de existir query. São duas verificações
 * que não partilham ponto de falha: acrescentar uma tabela aqui e esquecer a de
 * lá dá um 42501 do Postgres, e a escrita não acontece. É o mesmo princípio das
 * três camadas de leitura.
 *
 * PORQUE É QUE AS TRANSACIONAIS NÃO ESTÃO AQUI:
 *
 * Esta base não tem um único CHECK nem um único trigger. Os invariantes de
 * negócio — docs_venda.total bater com a soma das linhas, cc_clientes.saldo =
 * valor - valor_liq, a cadeia orçamento→encomenda→guia→fatura, as comissões, o
 * stock — existem SÓ no código que gerou os dados. Um INSERT em linhas_doc não
 * atualiza o total do documento; um INSERT em docs_venda não gera o movimento de
 * conta corrente nem mexe no stock. A base aceitava tudo isso em silêncio.
 *
 * Nos dados mestre não há invariantes a atravessar tabelas, e as chaves
 * estrangeiras tratam do resto: apagar um cliente que ainda tem documentos é
 * recusado pelo próprio Postgres, sem ninguém ter de o programar.
 *
 * Escrever documentos exige tools ao nível do AGREGADO — criar a fatura, as
 * linhas, o movimento de c/c e a comissão na mesma transação, com os totais
 * calculados —, não INSERTs linha a linha. Até essas existirem, isto fica assim.
 */
export const TABELAS_ESCRITA: ReadonlySet<string> = new Set([
  "armazens",
  "artfam",
  "artigos",
  "artsubfam",
  "clientes",
  "cond_pag",
  "doc_tipos",
  "escaloes_cli",
  "fornecedores",
  "precos_art",
  "taxas_iva",
  "vendedores",
]);

/** Valores aceites numa coluna. Esta base não tem colunas json nem array. */
export type ValorColuna = string | number | boolean | null;

interface ColunaCatalogo {
  coluna: string;
  tipo: string;
  aceita_null: boolean;
}

/** Tudo o que se precisa de saber sobre a tabela para construir a escrita. */
export interface AlvoEscrita {
  /** Nome tal como está no catálogo do Postgres. */
  tabela: string;
  /** Colunas existentes, indexadas pelo nome. */
  colunas: Map<string, ColunaCatalogo>;
  /** Colunas da chave primária, pela ordem em que estão definidas. */
  chavePrimaria: string[];
}

/** Colunas da tabela, do pg_attribute (o information_schema não dá o tipo formatado). */
const SQL_COLUNAS = `
  SELECT a.attname                              AS coluna,
         format_type(a.atttypid, a.atttypmod)   AS tipo,
         NOT a.attnotnull                       AS aceita_null
    FROM pg_attribute a
    JOIN pg_class c     ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = $1
     AND c.relkind IN ('r', 'p')
     AND a.attnum > 0
     AND NOT a.attisdropped
   ORDER BY a.attnum
`;

/**
 * Chave primária, pela ordem das colunas.
 * O WITH ORDINALITY sobre o conkey é o que preserva essa ordem — numa chave
 * composta como a de precos_art (cod_art, escalao, dt_ini) a ordem é
 * significativa.
 */
const SQL_CHAVE_PRIMARIA = `
  SELECT att.attname AS coluna
    FROM pg_constraint con
    JOIN pg_class c     ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
   WHERE n.nspname = 'public'
     AND c.relname = $1
     AND con.contype = 'p'
   ORDER BY k.ord
`;

/**
 * Valida a tabela pedida e devolve a informação de catálogo necessária.
 *
 * A ordem das verificações não é arbitrária: a whitelist vem primeiro porque
 * decide sem tocar na base de dados, e porque a mensagem que dá é a mais útil de
 * todas — "esta tabela existe, mas não se escreve nela, e a razão é esta".
 */
export async function resolverAlvoEscrita(
  contexto: ContextoLeitura,
  nomePedido: string,
): Promise<AlvoEscrita> {
  // --- 1. Whitelist, antes de qualquer ida à base de dados -------------------
  // O nome do utilizador é comparado como VALOR, nunca concatenado em SQL.
  if (!TABELAS_ESCRITA.has(nomePedido)) {
    throw new ErroValidacao(
      `A tabela "${nomePedido}" não é escrivel por este servidor.\n` +
        `Só se pode escrever nos dados mestre: ${[...TABELAS_ESCRITA].join(", ")}.\n` +
        "As tabelas de movimento (docs_venda, linhas_doc, compras, linhas_compra, " +
        "cc_clientes, stocks, comissoes_vend) estão bloqueadas de propósito: os totais, " +
        "saldos, comissões e stocks dependem uns dos outros e a base não tem triggers " +
        "que os mantenham coerentes. Escrever lá linha a linha corrompia os dados em silêncio.",
    );
  }

  // --- 2. Catálogo -----------------------------------------------------------
  const [colunas, chave] = await Promise.all([
    contexto.executarLeitura<ColunaCatalogo>(SQL_COLUNAS, [nomePedido]),
    contexto.executarLeitura<{ coluna: string }>(SQL_CHAVE_PRIMARIA, [nomePedido]),
  ]);

  if (colunas.rowCount === 0) {
    // Está na whitelist mas não existe na base: schema mudado, seed por correr,
    // ou a whitelist desatualizada. Nenhum destes é culpa de quem chamou a tool.
    throw new ErroValidacao(
      `A tabela "${nomePedido}" está na lista de tabelas escreviveis mas não existe no ` +
        "schema public. A base de dados pode não estar povoada — corre o seed.",
    );
  }

  // --- 3. Tem de haver chave primária ----------------------------------------
  // Sem PK não há forma de identificar UMA linha, e a garantia de "uma linha por
  // chamada" da Camada 3 deixava de ser sustentável. Nesta base todas as tabelas
  // têm PK, portanto isto nunca dispara — mas é a premissa de que tudo depende e
  // não fica implícita.
  if (chave.rowCount === 0) {
    throw new ErroValidacao(
      `A tabela "${nomePedido}" não tem chave primária, por isso não é possível ` +
        "identificar uma linha sem ambiguidade. Escrita recusada.",
    );
  }

  return {
    tabela: nomePedido,
    colunas: new Map(colunas.rows.map((c) => [c.coluna, c])),
    chavePrimaria: chave.rows.map((r) => r.coluna),
  };
}

/**
 * Valida o objeto de valores a escrever e devolve as colunas por ordem estável.
 *
 * @param permitirChave  se as colunas da chave primária podem aparecer aqui.
 *                       true no INSERT (a chave é fornecida, não há sequências
 *                       nesta base), false no UPDATE (ver abaixo).
 */
export function validarValores(
  alvo: AlvoEscrita,
  valores: Record<string, ValorColuna>,
  permitirChave: boolean,
): string[] {
  const nomes = Object.keys(valores);

  if (nomes.length === 0) {
    throw new ErroValidacao("O objeto 'valores' está vazio — não há nada para escrever.");
  }

  const desconhecidas = nomes.filter((n) => !alvo.colunas.has(n));
  if (desconhecidas.length > 0) {
    throw new ErroValidacao(
      `Estas colunas não existem em "${alvo.tabela}": ${desconhecidas.join(", ")}. ` +
        `Usa a tool describe_table para veres as colunas reais.`,
    );
  }

  // A coluna do arquivo existe em todas as tabelas e é uma coluna normal — sem
  // isto, o insert_row e o update_row escreviam nela como escrevem em qualquer
  // outra, e as tools do arquivo passavam a ser uma sugestão em vez de o caminho.
  // O pré-requisito do delete_row ("tem de estar arquivada") deixava de
  // significar seja o que for, porque um update genérico o satisfazia.
  recusarEscritaDiretaNoArquivo(nomes);

  if (!permitirChave) {
    // PORQUÊ RECUSAR MUDAR A CHAVE PRIMÁRIA NUM UPDATE:
    //
    // Não é uma limitação técnica — é a escolha conservadora. Mudar o no_cli de
    // um cliente altera silenciosamente o significado de todos os documentos e
    // movimentos de conta corrente que lhe apontam (ou é recusado a meio por uma
    // chave estrangeira, deixando a intenção por cumprir). Nenhum dos dois
    // resultados é o que quem pediu a alteração esperava.
    //
    // Quem precisar mesmo de o fazer cria a linha nova e apaga a antiga, e nessa
    // altura as chaves estrangeiras dizem-lhe em voz alta o que está preso.
    const daChave = nomes.filter((n) => alvo.chavePrimaria.includes(n));
    if (daChave.length > 0) {
      throw new ErroValidacao(
        `Não é possível alterar as colunas da chave primária (${daChave.join(", ")}) num ` +
          "update_row. Mudar a chave altera o significado de tudo o que lhe aponta. " +
          "Cria a linha nova com insert_row e apaga a antiga com delete_row.",
      );
    }
  }

  // Ordem estável: as colunas e os parâmetros $n têm de sair sempre na mesma
  // sequência, e depender da ordem de iteração de um objeto seria frágil.
  return nomes.sort();
}

/**
 * Valida a chave primária recebida: tem de trazer exatamente as colunas da PK,
 * nem a mais nem a menos, e nenhuma a NULL.
 *
 * O "nem a menos" é o que garante que o WHERE identifica uma linha só. O "nem a
 * mais" é o que impede alguém de acrescentar condições ao WHERE por esta porta —
 * a chave não é um filtro genérico, é um identificador.
 */
export function validarChavePrimaria(
  alvo: AlvoEscrita,
  chave: Record<string, ValorColuna>,
): string[] {
  const recebidas = Object.keys(chave);
  const esperadas = alvo.chavePrimaria;

  const emFalta = esperadas.filter((c) => !recebidas.includes(c));
  const aMais = recebidas.filter((c) => !esperadas.includes(c));

  if (emFalta.length > 0 || aMais.length > 0) {
    const partes: string[] = [];
    if (emFalta.length > 0) partes.push(`faltam: ${emFalta.join(", ")}`);
    if (aMais.length > 0) partes.push(`a mais: ${aMais.join(", ")}`);
    throw new ErroValidacao(
      `A chave primária de "${alvo.tabela}" é (${esperadas.join(", ")}) e o parâmetro 'chave' ` +
        `tem de trazer exatamente essas colunas — ${partes.join("; ")}. ` +
        "A chave identifica uma linha; não serve de filtro.",
    );
  }

  // Um NULL na chave produziria "WHERE col = NULL", que nunca é verdadeiro e
  // portanto afetaria zero linhas. A Camada 3 apanharia isso, mas o erro que dá
  // ("nenhuma linha corresponde") não explicaria porquê.
  const nulas = esperadas.filter((c) => chave[c] === null);
  if (nulas.length > 0) {
    throw new ErroValidacao(
      `Estas colunas da chave primária vieram a NULL: ${nulas.join(", ")}. ` +
        "Uma chave primária nunca é NULL.",
    );
  }

  // Ordem do catálogo, que numa chave composta é a que faz sentido.
  return [...esperadas];
}
