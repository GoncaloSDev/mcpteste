/**
 * OS PERFIS DE ACESSO — a lista declarativa de "que papel vê que tools".
 *
 * Até aqui, a resposta a essa pergunta não estava escrita em lado nenhum: era
 * deduzida da presença de uma variável de ambiente. `DATABASE_URL_WRITE` definida
 * dava nove tools, ausente dava quatro, e o papel de quem estava do outro lado
 * decidia-se pelo ENDEREÇO a que se ligava — dois deployments do mesmo binário,
 * um por papel. Funcionava, mas o conhecimento estava espalhado por um `if` no
 * servidor.ts, por um `.env` e por dois recursos do Coolify.
 *
 * Aqui esse conhecimento passa a ser DADOS, num sítio só: cada perfil diz como se
 * chama, que ligações usa e que tools expõe. Acrescentar um papel novo — um
 * `auditor` que leia e arquive mas nunca apague — passa a ser uma entrada nesta
 * lista, e não uma alteração ao servidor, às tools ou à base de dados.
 *
 * PORQUE É QUE A ESCRITA É UM GRUPO E NÃO DUAS PROPRIEDADES SOLTAS
 *
 * A ligação de escrita e a lista de tools de escrita vivem juntas dentro de
 * `escrita`, e não como dois campos opcionais lado a lado. É o que torna
 * IMPOSSÍVEL DE ESCREVER — não "verificado no arranque", impossível — um perfil
 * com tools de escrita e sem ligação por onde as executar, ou uma ligação de
 * escrita pendurada num perfil que não tem tools para lhe tocar. Os dois casos
 * eram erros silenciosos com consequências opostas (o primeiro rebentava na
 * primeira chamada; o segundo dava a um papel só-de-leitura um pool de escrita
 * aberto), e nenhum deles chega agora a compilar.
 *
 * É a mesma ideia do `ContextoLeitura`/`ContextoEscrita` do contexto.ts: uma
 * verificação que não corre, porque o que ela verificaria não se pode exprimir.
 *
 * NOTA: esta lista não é a única fonte de verdade sobre permissões, e não deve
 * passar a ser. Continua a haver a Camada 0 do Postgres (o `mcp_readonly` não tem
 * INSERT em tabela nenhuma, aconteça o que acontecer a este ficheiro) e a
 * whitelist de tabelas do escrita-camada1-alvo.ts. Isto decide o que se REGISTA,
 * não o que a base permite.
 */

/**
 * As quatro tools que só leem.
 *
 * Todos os perfis as têm hoje, mas a lista está aqui e não implícita em código
 * para que um perfil futuro possa ter menos (um papel que só veja o catálogo, por
 * exemplo, com `list_tables` e `describe_table` e mais nada).
 */
export const TOOLS_LEITURA = [
  "list_tables",
  "describe_table",
  "sample_rows",
  "run_query",
] as const;

/**
 * As cinco que escrevem, pela ordem do ciclo de vida de um registo: criar,
 * editar, arquivar, repor, destruir.
 */
export const TOOLS_ESCRITA = [
  "insert_row",
  "update_row",
  "archive_row",
  "restore_row",
  "delete_row",
] as const;

export type ToolLeitura = (typeof TOOLS_LEITURA)[number];
export type ToolEscrita = (typeof TOOLS_ESCRITA)[number];

interface PerfilBase {
  /** Como o papel se chama. É o valor que o MCP_PERFIL (stdio) aceita. */
  readonly nome: string;
  /**
   * Nome da variável de ambiente com a connection string de LEITURA.
   *
   * Guarda-se o nome da variável e não o valor: o valor é lido no arranque, pelo
   * registo, dentro de uma função — pela mesma razão que no db.ts, que em ESM o
   * corpo de um módulo corre antes de o dotenv ter carregado o .env.
   */
  readonly variavelLeitura: string;
  readonly toolsLeitura: readonly ToolLeitura[];
}

/** Um papel que não escreve. Não tem `escrita` — nem vazia, nem nula. */
export interface PerfilLeitura extends PerfilBase {
  readonly escrita?: undefined;
}

/** Um papel que escreve: a ligação e as tools, sempre juntas. */
export interface PerfilEscrita extends PerfilBase {
  readonly escrita: {
    /** Nome da variável de ambiente com a connection string de escrita. */
    readonly variavel: string;
    readonly tools: readonly ToolEscrita[];
  };
}

export type Perfil = PerfilLeitura | PerfilEscrita;

/** Distingue os dois em runtime, para quem tem um `Perfil` na mão. */
export function perfilEscreve(perfil: Perfil): perfil is PerfilEscrita {
  return perfil.escrita !== undefined;
}

/**
 * OS PERFIS.
 *
 * As leituras dos dois saem pela MESMA variável, e isso não é uma economia de
 * configuração — é a decisão de arquitetura que sustenta a frase "toda a leitura
 * corre como o utilizador menos privilegiado". Um admin lê pelo `mcp_readonly`
 * tal como um employee; a ligação de escrita serve a instrução final e mais nada.
 * Ver a nota no ContextoEscrita, no contexto.ts.
 */
export const PERFIS: readonly Perfil[] = [
  {
    nome: "employee",
    variavelLeitura: "DATABASE_URL_READONLY",
    toolsLeitura: TOOLS_LEITURA,
  },
  {
    nome: "admin",
    variavelLeitura: "DATABASE_URL_READONLY",
    toolsLeitura: TOOLS_LEITURA,
    escrita: {
      variavel: "DATABASE_URL_WRITE",
      tools: TOOLS_ESCRITA,
    },
  },
];

/**
 * O perfil de quem não pediu nenhum.
 *
 * É o menos privilegiado, e tem de continuar a ser: a omissão é o que acontece a
 * quem se esqueceu, e esquecer-se deve dar menos poder e nunca mais. É também o
 * que preserva a propriedade antiga — a MESMA build registada duas vezes no
 * claude_desktop_config.json, uma entrada só-leitura e outra com escrita — com a
 * diferença de que agora a entrada com escrita diz `MCP_PERFIL=admin` em vez de o
 * deduzir de ter, ou não, uma password de escrita à mão.
 */
export const PERFIL_OMISSO = "employee";

/** Os nomes conhecidos, para as mensagens de erro os poderem enumerar. */
export function nomesDosPerfis(perfis: readonly Perfil[] = PERFIS): string[] {
  return perfis.map((p) => p.nome);
}

/** Todas as tools de um perfil, na ordem em que são registadas. Só para logs. */
export function toolsDoPerfil(perfil: Perfil): string[] {
  return [...perfil.toolsLeitura, ...(perfil.escrita?.tools ?? [])];
}

/**
 * Que perfil este PROCESSO serve, no modo stdio.
 *
 * Só existe para o stdio e para o desenvolvimento local: no modo HTTP o perfil
 * vem da identidade de quem chama, um por sessão, e não do ambiente do processo.
 *
 * Devolve o perfil e não o seu nome, e isso importa mais do que parece: é o que
 * permite ao ponto de entrada configurar SÓ este perfil e mais nenhum. Um
 * processo lançado como `employee` não chega a abrir a ligação de escrita — nem
 * sequer a lê do ambiente —, e é assim que a isolação por processo que o stdio
 * sempre teve sobrevive a esta mudança. Quem quiser as duas continua a lançar
 * dois processos, que é exatamente o que o claude_desktop_config.json faz.
 *
 * Um nome desconhecido FALHA em vez de cair no perfil de omissão. A alternativa
 * — aceitar `MCP_PERFIL=admn` e servir um employee em silêncio — dava um servidor
 * a funcionar com menos poderes do que quem o arrancou julga ter, e isso
 * descobria-se por uma tool "que desapareceu", não por uma mensagem.
 */
export function perfilPedidoNoAmbiente(perfis: readonly Perfil[] = PERFIS): Perfil {
  const pedido = process.env["MCP_PERFIL"]?.trim();
  const nome = pedido === undefined || pedido === "" ? PERFIL_OMISSO : pedido;

  const perfil = perfis.find((p) => p.nome === nome);
  if (perfil === undefined) {
    throw new Error(
      `MCP_PERFIL='${nome}' não é um perfil conhecido.\n` +
        `Perfis definidos em src/acesso/perfis.ts: ${nomesDosPerfis(perfis).join(", ")}.`,
    );
  }
  return perfil;
}
