/**
 * Ligação de ESCRITA e a transação onde as escritas correm.
 *
 * Ficheiro separado do db.ts, e essa separação é a garantia principal de todo
 * este caminho: são dois pools, com duas connection strings, em duas variáveis
 * de módulo distintas. O `executarSoLeitura` do db.ts não tem acesso a este pool
 * e o `executarEscrita` daqui não tem acesso àquele. Não há forma de uma leitura
 * sair por engano pela ligação de escrita — teria de ser alguém a trocar a
 * chamada dentro de um ficheiro de tool, e isso lê-se numa linha.
 *
 * Toda a escrita do projeto passa por aqui, tal como toda a leitura passa pelo
 * db.ts. É essa concentração que permite garantir que nenhuma escapa à guarda de
 * linhas nem ao timeout.
 */

import pg from "pg";
import { ErroValidacao } from "./erros.js";
import { verificarLinhasAfetadas } from "./seguranca/escrita-camada3-linhas.js";

const { Pool } = pg;

/** Null enquanto o modo de escrita não estiver ligado — que é o estado normal. */
let pool: pg.Pool | null = null;

let timeoutMs = 5000;

export interface IdentidadeEscrita {
  utilizador: string;
  baseDeDados: string;
  /** Tabelas onde este utilizador tem mesmo INSERT segundo o Postgres. */
  tabelasComEscrita: string[];
}

/**
 * Liga o modo de escrita, se estiver configurado.
 *
 * Devolve `null` — sem erro, sem aviso — quando a DATABASE_URL_WRITE não existe.
 * A escrita é OPT-IN: um servidor sem essa variável arranca exatamente como
 * sempre arrancou, com as 4 tools de leitura e mais nada. É isso que permite ter
 * a mesma build registada duas vezes no cliente MCP, uma só-leitura e outra com
 * escrita, sem tocar em código.
 *
 * Falha com exceção se a variável existir mas a ligação não servir. Um modo de
 * escrita "meio ligado" é pior do que nenhum.
 */
export async function arrancarEscrita(): Promise<IdentidadeEscrita | null> {
  // Lido aqui dentro, e não no corpo do módulo, pela mesma razão que no db.ts:
  // em ESM os imports são avaliados antes da primeira linha do index.ts, e um
  // process.env lido no topo do ficheiro correria antes de o dotenv carregar.
  const connectionString = process.env["DATABASE_URL_WRITE"];

  if (connectionString === undefined || connectionString.trim() === "") {
    return null;
  }

  timeoutMs = lerTimeoutDoAmbiente();

  pool = new Pool({
    connectionString,
    // Duas chegam: as escritas são raras e chegam em série. Manter este pool
    // pequeno também limita quantas transações de escrita podem existir ao mesmo
    // tempo, o que é uma propriedade desejável e não um efeito lateral.
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Distingue-se do "agentsystem-mcp-server" das leituras no pg_stat_activity.
    // Com a base aberta noutro sítio, vê-se logo qual das ligações pode escrever.
    application_name: "agentsystem-mcp-server[escrita]",
  });

  pool.on("error", (erro) => {
    console.error("[db-escrita] erro numa ligação inativa do pool:", erro.message);
  });

  const cliente = await pool.connect();
  try {
    const identidade = await cliente.query<{
      utilizador: string;
      base: string;
      superutilizador: string;
    }>(
      `SELECT current_user       AS utilizador,
              current_database() AS base,
              current_setting('is_superuser') AS superutilizador`,
    );

    const linha = identidade.rows[0];
    if (linha === undefined) {
      throw new Error("A base de dados respondeu, mas sem dados de identificação.");
    }

    // A VERIFICAÇÃO QUE NÃO É NEGOCIÁVEL.
    //
    // No caminho de leitura, apontar o servidor ao admin_dist por engano é mau
    // mas fica contido: a transação READ ONLY recusa a escrita à mesma. No
    // caminho de escrita não há transação READ ONLY para segurar nada — uma
    // ligação de superutilizador podia fazer DDL, apagar tabelas inteiras e
    // escrever nas transacionais, e nenhuma das outras camadas dá por isso,
    // porque nenhuma delas fala com o Postgres sobre permissões.
    //
    // Por isso não é um aviso: o arranque falha. É preferível o servidor não
    // subir a subir com poderes que ninguém pretendia dar-lhe.
    if (linha.superutilizador === "on") {
      throw new Error(
        `A DATABASE_URL_WRITE liga-se como '${linha.utilizador}', que é SUPERUTILIZADOR.\n` +
          "O modo de escrita recusa-se a arrancar assim: um superutilizador ignora as " +
          "permissões por tabela, que são a camada 0 de toda esta funcionalidade.\n" +
          "Usa o utilizador mcp_escrita (ver o .env.example), nunca o admin_dist.",
      );
    }

    // Que tabelas o Postgres — não a nossa whitelist, o Postgres — considera
    // escreviveis por este utilizador. Serve de confirmação independente no
    // arranque: se aqui aparecerem 19 em vez de 12, os GRANT do seed foram
    // largos de mais e vê-se logo, em vez de se descobrir por acidente.
    const escreviveis = await cliente.query<{ tabela: string }>(
      `SELECT c.relname AS tabela
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND has_table_privilege(c.oid, 'INSERT')
        ORDER BY c.relname`,
    );

    return {
      utilizador: linha.utilizador,
      baseDeDados: linha.base,
      tabelasComEscrita: escreviveis.rows.map((r) => r.tabela),
    };
  } finally {
    cliente.release();
  }
}

/** Se o modo de escrita está ligado. */
export function escritaLigada(): boolean {
  return pool !== null;
}

/**
 * Executa UMA instrução de escrita numa transação com guarda de linhas.
 *
 * A instrução tem de trazer RETURNING: é o RETURNING que faz o Postgres devolver
 * as linhas afetadas, e são elas que a resposta mostra a quem chamou. Sem isso, a
 * tool dizia "feito" sem provar o que ficou lá.
 *
 * A SEQUÊNCIA, e porque é que a ordem importa:
 *
 *   BEGIN
 *   SET LOCAL statement_timeout        (o Postgres cancela, não só o Node)
 *   <a instrução>
 *   verificarLinhasAfetadas(...)       <-- CAMADA 3: lança se não for 1
 *   COMMIT
 *
 * A verificação está DEPOIS da instrução e ANTES do COMMIT de propósito. É a
 * única posição em que funciona: antes da instrução não há rowCount para
 * verificar, e depois do COMMIT já não há nada a fazer. Assim, um UPDATE que
 * apanhe mil linhas é executado — dentro da transação — e nunca chega a disco,
 * porque o throw cai no catch e o catch faz ROLLBACK.
 *
 * @param operacao  "INSERT"/"UPDATE"/"DELETE", só para as mensagens de erro
 * @param alvo      descrição da linha visada, para as mensagens de erro
 */
export async function executarEscrita<T extends pg.QueryResultRow>(
  sql: string,
  parametros: unknown[],
  operacao: string,
  alvo: string,
): Promise<pg.QueryResult<T>> {
  const clientePool = obterPool();
  const cliente = await clientePool.connect();

  try {
    // Sem READ ONLY, pela razão óbvia — e é precisamente por esta transação não
    // poder ser só-de-leitura que a guarda de linhas mais abaixo existe.
    await cliente.query("BEGIN");

    // SET LOCAL e não SET: um SET normal duraria a SESSÃO, e a sessão sobrevive à
    // devolução da ligação ao pool, contaminando as chamadas seguintes.
    // O valor é interpolado porque um SET não aceita parâmetros; é seguro porque
    // vem validado como inteiro do lerTimeoutDoAmbiente().
    await cliente.query(`SET LOCAL statement_timeout = ${timeoutMs}`);

    const resultado = await cliente.query<T>(sql, parametros);

    // --- CAMADA 3 DA ESCRITA ---------------------------------------------
    verificarLinhasAfetadas(resultado.rowCount, operacao, alvo);

    await cliente.query("COMMIT");
    return resultado;
  } catch (erro) {
    // Apanha tanto os erros do Postgres (violação de FK, de unicidade, de NOT
    // NULL) como o throw da guarda de linhas. Nos dois casos o resultado é o
    // mesmo e é o que interessa: a base de dados não é alterada.
    await cliente.query("ROLLBACK").catch(() => undefined);
    throw erro;
  } finally {
    cliente.release();
  }
}

/** Fecha o pool de escrita, se existir. Chamado no encerramento do servidor. */
export async function fecharEscrita(): Promise<void> {
  if (pool !== null) {
    await pool.end();
    pool = null;
  }
}

function obterPool(): pg.Pool {
  if (pool === null) {
    // Só acontece se uma tool de escrita chegar a ser chamada com o modo
    // desligado — e nesse caso ela nem sequer foi registada, portanto seria um
    // bug nosso. A mensagem é para quem estiver a ler os logs, não para o modelo.
    throw new ErroValidacao(
      "O modo de escrita não está ligado neste servidor (DATABASE_URL_WRITE não definida).",
    );
  }
  return pool;
}

/** Igual ao do db.ts, e deliberadamente não partilhado: se um dia a escrita
 * precisar de um timeout diferente do da leitura, muda-se aqui e mais nada. */
function lerTimeoutDoAmbiente(): number {
  const valor = process.env["MCP_TIMEOUT_MS"];
  if (valor === undefined) {
    return 5000;
  }
  const numero = Number.parseInt(valor, 10);
  if (!Number.isInteger(numero) || numero <= 0) {
    return 5000;
  }
  return numero;
}
