/**
 * O CONTEXTO DE ACESSO — que ligações uma sessão pode usar.
 *
 * Este ficheiro existe para responder a uma pergunta que antes não se punha:
 * "com que utilizador do Postgres é que ESTA chamada fala?". Enquanto houve um
 * processo por papel, a resposta era uma constante do processo e vivia numa
 * variável de módulo do db.ts. Com um servidor só a servir vários papéis, a
 * resposta passa a depender de quem está do outro lado, e por isso tem de viajar
 * com a chamada em vez de estar pendurada num módulo.
 *
 * O QUE ISTO NÃO MUDA, e é o que interessa não perder de vista: as camadas
 * continuam todas onde estavam. O `executarLeitura` daqui é o `executarSoLeitura`
 * do db.ts com a ligação já presa — a transação READ ONLY, o statement_timeout e
 * o véu do arquivo continuam a ser aplicados lá, no mesmo sítio, pelo mesmo
 * código. O que muda é de onde vem o pool: de um parâmetro, e não de uma variável
 * global. A concentração — toda a leitura por uma função, toda a escrita por
 * outra — fica exatamente igual.
 *
 * A SEPARAÇÃO EM DOIS TIPOS É A DEFESA PRINCIPAL DESTE DESENHO.
 *
 * `ContextoLeitura` não tem `executarEscrita`. Não é que a tenha e recuse usá-la:
 * não existe no tipo. As tools de escrita declaram `ContextoEscrita`, portanto
 * registá-las com o contexto de um papel só-de-leitura não compila — o erro
 * aparece no `npm run typecheck`, não num pedido em produção. É a mesma ideia das
 * camadas independentes: uma verificação que não partilha ponto de falha com as
 * outras, e que aqui nem sequer chega a correr.
 */

import type pg from "pg";

import { executarSoLeitura, type LigacaoLeitura, type OpcoesLeitura } from "../db.js";
import { executarEscrita, type LigacaoEscrita, type OpcoesEscrita } from "../db-escrita.js";
import type { Perfil, PerfilEscrita, PerfilLeitura } from "./perfis.js";

/**
 * Assinatura de uma leitura, já presa a uma ligação.
 *
 * É uma interface com assinatura de chamada genérica (e não um `type` com uma
 * arrow) porque o `<T>` tem de continuar a ser escolhido por quem CHAMA — as
 * tools tipam as linhas que esperam receber, e essa informação perder-se-ia se o
 * genérico fosse resolvido aqui.
 */
export interface ExecutorLeitura {
  <T extends pg.QueryResultRow>(
    sql: string,
    parametros?: unknown[],
    opcoes?: OpcoesLeitura,
  ): Promise<pg.QueryResult<T>>;
}

/** Assinatura de uma escrita, já presa a uma ligação. */
export interface ExecutorEscrita {
  <T extends pg.QueryResultRow>(
    sql: string,
    parametros: unknown[],
    operacao: string,
    alvo: string,
    opcoes?: OpcoesEscrita,
  ): Promise<pg.QueryResult<T>>;
}

/**
 * O que um papel só-de-leitura pode fazer.
 *
 * Todas as tools de leitura — e também os módulos de segurança do caminho de
 * escrita, que consultam o catálogo — pedem este tipo. Um `ContextoEscrita`
 * satisfá-lo por herança, portanto uma tool de leitura serve os dois papéis sem
 * saber que papéis existem.
 */
export interface ContextoLeitura {
  /**
   * O perfil que este contexto serve.
   *
   * Era uma string, e era só para logs. Passou a ser o registo declarativo
   * completo (perfis.ts) porque alguém tem de responder a "que tools é que este
   * papel vê?", e a resposta pertence ao perfil e não a um `if` no servidor.ts.
   * Continua a NÃO decidir permissões: quem as decide é o tipo deste contexto,
   * no momento do registo, e a Camada 0 do Postgres por baixo de tudo.
   */
  readonly perfil: Perfil;
  readonly executarLeitura: ExecutorLeitura;
  /** O timeout em vigor, para as tools o poderem mencionar nas respostas. */
  readonly timeoutMs: number;
}

/**
 * O que um papel com escrita pode fazer.
 *
 * Note-se o que NÃO está aqui: uma ligação de leitura própria. As leituras de
 * todos os perfis saem pela mesma ligação só-de-leitura, incluindo as que
 * acontecem a meio de uma escrita (resolver a tabela, ler o estado de arquivo,
 * contar a cascata). A ligação de escrita serve para a instrução final e para
 * mais nada — é o que já acontecia, e é o que mantém verdadeira a frase "toda a
 * leitura corre como o utilizador menos privilegiado".
 */
export interface ContextoEscrita extends ContextoLeitura {
  /**
   * Estreitado de propósito. Um contexto que escreve traz sempre um perfil que
   * declara a ligação e a lista de tools de escrita — é o que permite ao
   * criarServidor() ler `contexto.perfil.escrita.tools` sem verificação nenhuma
   * depois de o `temEscrita()` ter estreitado o contexto.
   */
  readonly perfil: PerfilEscrita;
  readonly executarEscrita: ExecutorEscrita;
}

/** Um contexto qualquer, de qualquer papel. */
export type ContextoAcesso = ContextoLeitura | ContextoEscrita;

/**
 * Distingue os dois em runtime.
 *
 * Serve para as tools de LEITURA poderem dizer, na resposta, se este servidor
 * aceita escrita — o `list_tables` usa-o para a coluna `escrivel`. Não serve para
 * autorizar seja o que for: quem autoriza é o tipo, no momento do registo.
 */
export function temEscrita(contexto: ContextoAcesso): contexto is ContextoEscrita {
  return "executarEscrita" in contexto;
}

/**
 * A metade de leitura, que os dois contextos partilham.
 *
 * Extraída para as duas fábricas não duplicarem a closure do executor. Não é
 * exportada: um contexto tem de nascer sempre emparelhado com um perfil, e é esse
 * emparelhamento que as duas funções abaixo garantem.
 */
function metadeDeLeitura(ligacao: LigacaoLeitura): Omit<ContextoLeitura, "perfil"> {
  return {
    timeoutMs: ligacao.timeoutMs,
    executarLeitura: <T extends pg.QueryResultRow>(
      sql: string,
      parametros?: unknown[],
      opcoes?: OpcoesLeitura,
    ) => executarSoLeitura<T>(ligacao, sql, parametros, opcoes),
  };
}

/**
 * Constrói o contexto de um perfil só-de-leitura.
 *
 * Exige um `PerfilLeitura` e não um `Perfil` qualquer, e a diferença não é
 * cosmética: assim não é possível construir um contexto sem escrita a partir de
 * um perfil que declara tools de escrita. Esse par seria um servidor a registar
 * caladamente menos tools do que o perfil promete — o pior modo de falha
 * possível, porque não dá erro nenhum.
 */
export function criarContextoLeitura(
  perfil: PerfilLeitura,
  ligacao: LigacaoLeitura,
): ContextoLeitura {
  return { perfil, ...metadeDeLeitura(ligacao) };
}

/**
 * Constrói o contexto de um perfil com escrita.
 *
 * Recebe as DUAS ligações, e a de leitura é a mesma que os outros perfis usam.
 */
export function criarContextoEscrita(
  perfil: PerfilEscrita,
  ligacaoLeitura: LigacaoLeitura,
  ligacaoEscrita: LigacaoEscrita,
): ContextoEscrita {
  return {
    perfil,
    ...metadeDeLeitura(ligacaoLeitura),
    executarEscrita: <T extends pg.QueryResultRow>(
      sql: string,
      parametros: unknown[],
      operacao: string,
      alvo: string,
      opcoes?: OpcoesEscrita,
    ) => executarEscrita<T>(ligacaoEscrita, sql, parametros, operacao, alvo, opcoes),
  };
}
