/**
 * Ligação à base de dados e CAMADA 2 — cada query corre numa transação READ ONLY.
 *
 * Toda a comunicação com o Postgres passa por aqui: não há nenhuma outra query
 * no projeto fora deste ficheiro. É essa concentração que permite garantir que
 * NENHUMA leitura escapa à transação só-de-leitura e ao statement_timeout — se
 * fosse cada tool a abrir a sua ligação, bastava esquecer-se uma.
 */

import pg from "pg";
import { GUC_INCLUIR_ARQUIVADOS } from "./seguranca/arquivo.js";

const { Pool } = pg;

/**
 * Uma ligação de leitura já aberta: o pool e o timeout que lhe pertence.
 *
 * ISTO ERA UMA VARIÁVEL DE MÓDULO. Deixou de o ser quando o mesmo processo
 * passou a servir vários papéis: com um pool global, a pergunta "com que
 * utilizador do Postgres corre esta query?" tinha uma resposta só por processo, e
 * agora tem de ter uma resposta por chamada. O objeto é passado ao
 * `executarSoLeitura` em vez de ser lido daqui.
 *
 * O que não mudou: continua a haver um pool por connection string, criado uma vez
 * no arranque. Perfis que partilhem a mesma ligação partilham o pool.
 */
export interface LigacaoLeitura {
  readonly pool: pg.Pool;
  /** Timeout por query, em milissegundos. */
  readonly timeoutMs: number;
}

/**
 * Os pools abertos, para o encerramento os poder fechar todos.
 *
 * Continua a ser estado de módulo, mas de natureza diferente do que aqui estava
 * antes: é um registo de CICLO DE VIDA, que só o arranque escreve e só o
 * encerramento lê. Nenhuma tool lhe toca, e nada nele decide por onde uma query
 * sai — que era o problema do pool global.
 */
const poolsAbertos = new Set<pg.Pool>();

/** Informação recolhida no arranque, para o log e para a tool de diagnóstico. */
export interface IdentidadeLigacao {
  utilizador: string;
  baseDeDados: string;
  versaoPostgres: string;
}

/** O que o arranque devolve: a ligação a usar e com quem ficámos ligados. */
export interface LeituraArrancada {
  ligacao: LigacaoLeitura;
  identidade: IdentidadeLigacao;
}

/**
 * Cria o pool, confirma que a ligação funciona e devolve com que utilizador
 * ficámos mesmo ligados.
 *
 * Falha com exceção — nunca devolve um servidor "meio vivo". Um servidor MCP que
 * arranca sem base de dados só descobre o problema na primeira tool chamada, e
 * aí o erro aparece ao utilizador no meio de uma conversa em vez de aparecer no
 * arranque, onde é fácil de ver.
 */
export async function arrancarBaseDeDados(): Promise<LeituraArrancada> {
  // A variável é lida AQUI DENTRO, e não no corpo do módulo, de propósito: em
  // ESM os imports são todos avaliados antes de correr a primeira linha do
  // index.ts. Se isto estivesse no topo do ficheiro, corria antes de o
  // "import dotenv/config" ter carregado o .env, e viria sempre undefined.
  const connectionString = process.env["DATABASE_URL_READONLY"];

  if (connectionString === undefined || connectionString.trim() === "") {
    throw new Error(
      "A variável de ambiente DATABASE_URL_READONLY não está definida.\n" +
        "Copia o .env.example para .env e preenche-a, ou define-a no bloco 'env' da\n" +
        "configuração do cliente MCP (ver o README).",
    );
  }

  const timeoutMs = lerTimeoutDoAmbiente();

  const pool = new Pool({
    connectionString,
    // Um servidor MCP por stdio serve um cliente de cada vez e as chamadas
    // chegam praticamente em série. 4 ligações chegam de sobra e evitam ocupar
    // slots do Postgres sem necessidade.
    max: 4,
    // Fecha ligações paradas há mais de 30s. Sem isto, o servidor ficaria com
    // ligações abertas ao Postgres durante horas de inatividade.
    idleTimeoutMillis: 30_000,
    // Quanto esperar por uma ligação NOVA. Sem este limite, se o container
    // estiver em baixo, a primeira tool ficava pendurada indefinidamente em vez
    // de dar um erro.
    connectionTimeoutMillis: 5_000,
    // Aparece na coluna application_name do pg_stat_activity. Serve para, com a
    // base aberta noutro sítio, se perceber qual das ligações é este servidor.
    application_name: "testeai-mcp-server",
  });

  // NÃO-ÓBVIO e fácil de esquecer: este handler é para erros em ligações que
  // estão PARADAS no pool, não em uso. Se o Postgres reiniciar ou fechar um
  // socket ocioso, o pool emite 'error'. Em Node, um evento 'error' de um
  // EventEmitter sem handler ATIRA e mata o processo — o servidor MCP morria
  // sozinho a meio da noite sem ninguém ter feito nada.
  pool.on("error", (erro) => {
    console.error("[db] erro numa ligação inativa do pool:", erro.message);
  });

  poolsAbertos.add(pool);

  // A verificação de arranque propriamente dita. Se as credenciais estiverem
  // erradas ou o container estiver em baixo, rebenta aqui.
  const resultado = await pool.query<{
    utilizador: string;
    base: string;
    versao: string;
  }>("SELECT current_user AS utilizador, current_database() AS base, version() AS versao");

  const linha = resultado.rows[0];
  if (linha === undefined) {
    throw new Error("A base de dados respondeu, mas sem dados de identificação.");
  }

  return {
    ligacao: { pool, timeoutMs },
    identidade: {
      utilizador: linha.utilizador,
      baseDeDados: linha.base,
      // O version() completo é uma linha enorme com o compilador e a
      // arquitetura. Para o log só interessam as duas primeiras palavras
      // ("PostgreSQL 18.0").
      versaoPostgres: linha.versao.split(" ").slice(0, 2).join(" "),
    },
  };
}

/**
 * CAMADA 2 — executa uma query dentro de uma transação explicitamente READ ONLY.
 *
 * PORQUE É QUE ISTO EXISTE, se o utilizador da base já é só-de-leitura:
 *
 * Porque são defesas de naturezas diferentes, e é isso que as torna
 * independentes. O utilizador read-only é uma defesa de CONFIGURAÇÃO: vive numa
 * connection string, num ficheiro .env que alguém pode trocar, copiar do
 * projeto errado ou preencher com a string de admin por distração. O
 * "BEGIN TRANSACTION READ ONLY" é uma defesa do PRÓPRIO POSTGRES, aplicada do
 * lado do servidor, e recusa qualquer escrita mesmo que a ligação venha com
 * poderes de superutilizador.
 *
 * O teste mental é este: para uma escrita passar, teriam de falhar ao mesmo
 * tempo duas coisas que não têm nada a ver uma com a outra — o .env estar errado
 * E o Postgres ignorar o seu próprio modo read-only. É essa a ideia de camadas
 * independentes: não é ter mais verificações, é ter verificações que não
 * partilham o mesmo ponto de falha.
 *
 * (Podes ver a Camada 2 a trabalhar sozinha, com o utilizador de ADMIN:
 *    psql -U admin_dist -c "BEGIN TRANSACTION READ ONLY; UPDATE clientes SET nome='x';"
 *  responde "ERROR: cannot execute UPDATE in a read-only transaction".)
 */
export interface OpcoesLeitura {
  /**
   * Levantar o véu do arquivo SÓ nesta transação.
   *
   * Por omissão false, e é isso que faz o esquecimento ser seguro: quem não
   * souber que o arquivo existe escreve `executarSoLeitura(sql)` e não vê
   * arquivados, que é o comportamento correto. Ver o arquivo é que exige um ato
   * deliberado.
   */
  incluirArquivados?: boolean;
}

export async function executarSoLeitura<T extends pg.QueryResultRow>(
  ligacao: LigacaoLeitura,
  sql: string,
  parametros: unknown[] = [],
  opcoes: OpcoesLeitura = {},
): Promise<pg.QueryResult<T>> {
  const clientePool = ligacao.pool;

  // pool.connect() tira uma ligação DEDICADA do pool. É obrigatório para uma
  // transação: com pool.query() cada comando podia sair por uma ligação
  // diferente, e o BEGIN ficaria numa ligação enquanto a query saía por outra —
  // a transação não envolveria nada.
  const cliente = await clientePool.connect();

  try {
    await cliente.query("BEGIN TRANSACTION READ ONLY");

    // SET LOCAL, não SET — e a diferença é importante por causa do pool.
    // Um "SET" normal dura o resto da SESSÃO, e a sessão sobrevive à devolução
    // da ligação ao pool: o valor ficava colado à ligação e contaminava todas as
    // chamadas seguintes que calhassem nela. O LOCAL limita o efeito à
    // transação e desaparece sozinho no COMMIT/ROLLBACK.
    //
    // O timeout é aplicado do lado do POSTGRES, não do Node, e é essa a razão de
    // ser desta linha: um timeout no cliente só desistiria de esperar, deixando
    // a query a consumir CPU no servidor até ao fim. O statement_timeout cancela
    // mesmo a execução.
    //
    // O valor vai interpolado porque um comando SET não aceita parâmetros ($1) —
    // não é uma expressão, é uma diretiva. É seguro porque o valor não vem do
    // utilizador e é validado como inteiro em lerTimeoutDoAmbiente().
    await cliente.query(`SET LOCAL statement_timeout = ${ligacao.timeoutMs}`);

    // Abre a exceção da política de RLS, se esta chamada a pediu. O LOCAL é o
    // que a fecha outra vez: morre no COMMIT/ROLLBACK, antes de a ligação voltar
    // ao pool. Um SET normal ficava colado à ligação e a próxima leitura que
    // calhasse nela via arquivados sem os ter pedido — que é exatamente o bug
    // silencioso que esta funcionalidade existe para não ter.
    //
    // O nome do parâmetro é uma constante deste código, nunca vem de fora, e o
    // valor é um literal fixo. Vai interpolado porque um SET não aceita $1.
    if (opcoes.incluirArquivados === true) {
      await cliente.query(`SET LOCAL ${GUC_INCLUIR_ARQUIVADOS} = 'on'`);
    }

    const resultado = await cliente.query<T>(sql, parametros);

    await cliente.query("COMMIT");
    return resultado;
  } catch (erro) {
    // O ROLLBACK pode falhar se a ligação já morreu (o Postgres reiniciou, o
    // socket caiu). Nesse caso o erro do ROLLBACK não interessa a ninguém e não
    // pode tapar o erro original, que é o que explica o que se passou.
    await cliente.query("ROLLBACK").catch(() => undefined);
    throw erro;
  } finally {
    // Sem este release a ligação nunca voltava ao pool. Ao fim de 4 chamadas o
    // pool esgotava-se e o servidor bloqueava para sempre à espera de uma
    // ligação livre. O finally garante que acontece mesmo com exceção.
    cliente.release();
  }
}

/** Fecha os pools de leitura de forma ordeira. Chamado no encerramento. */
export async function fecharBaseDeDados(): Promise<void> {
  const pools = [...poolsAbertos];
  poolsAbertos.clear();
  await Promise.all(pools.map((p) => p.end()));
}

function lerTimeoutDoAmbiente(): number {
  const valor = process.env["MCP_TIMEOUT_MS"];
  if (valor === undefined) {
    return 5000;
  }
  const numero = Number.parseInt(valor, 10);
  // Number.isInteger é o que garante que a interpolação no SET LOCAL acima é
  // segura: qualquer coisa que não seja um inteiro positivo cai no valor omisso.
  if (!Number.isInteger(numero) || numero <= 0) {
    return 5000;
  }
  return numero;
}
