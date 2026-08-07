/**
 * O servidor MCP — arranque das dependências, construção e encerramento.
 *
 * Este ficheiro não sabe nada sobre transportes. É de propósito: existem dois
 * pontos de entrada — o index.ts (stdio) e o http.ts (Streamable HTTP) — e a
 * única diferença entre eles tem de ser o cabo por onde o protocolo passa. As
 * tools, a ordem de arranque, as verificações à base de dados e o encerramento
 * ordeiro são exatamente os mesmos nos dois, porque são literalmente o mesmo
 * código.
 *
 * A regra que mantém isto assim: se um dia uma tool só existir num dos modos,
 * ela não pertence a este ficheiro — pertence ao ponto de entrada respetivo. Não
 * há, neste momento, nenhuma nesse caso.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadModule } from "libpg-query";

import {
  temEscrita,
  type ContextoAcesso,
  type ContextoEscrita,
  type ContextoLeitura,
} from "./acesso/contexto.js";
import type { Perfil, ToolEscrita, ToolLeitura } from "./acesso/perfis.js";
import { arrancarRegisto, type Registo } from "./acesso/registo.js";
import { fecharBaseDeDados } from "./db.js";
import { fecharEscrita } from "./db-escrita.js";
import { log, mensagemDoErro } from "./log.js";
import { registarArchiveRow } from "./tools/archiveRow.js";
import { registarDeleteRow } from "./tools/deleteRow.js";
import { registarDescribeTable } from "./tools/describeTable.js";
import { registarInsertRow } from "./tools/insertRow.js";
import { registarListTables } from "./tools/listTables.js";
import { registarRestoreRow } from "./tools/restoreRow.js";
import { registarRunQuery } from "./tools/runQuery.js";
import { registarSampleRows } from "./tools/sampleRows.js";
import { registarUpdateRow } from "./tools/updateRow.js";

/**
 * Os registadores das tools, por nome.
 *
 * A tabela é `Record<ToolLeitura, ...>` e não um objeto qualquer, e isso vale a
 * pena: o TypeScript exige que a tabela cubra EXATAMENTE os nomes declarados no
 * perfis.ts. Acrescentar um nome à lista de tools sem escrever o registador — ou
 * escrever um registador para um nome que já não existe — não compila.
 *
 * As duas tabelas estão separadas pela mesma razão que os dois contextos: os
 * valores da segunda exigem um `ContextoEscrita`, portanto o único sítio onde é
 * possível chamá-los é dentro do estreitamento do `temEscrita()`, mais abaixo.
 */
const REGISTADORES_LEITURA: Record<
  ToolLeitura,
  (servidor: McpServer, contexto: ContextoLeitura) => void
> = {
  list_tables: registarListTables,
  describe_table: registarDescribeTable,
  sample_rows: registarSampleRows,
  run_query: registarRunQuery,
};

const REGISTADORES_ESCRITA: Record<
  ToolEscrita,
  (servidor: McpServer, contexto: ContextoEscrita) => void
> = {
  insert_row: registarInsertRow,
  update_row: registarUpdateRow,
  archive_row: registarArchiveRow,
  restore_row: registarRestoreRow,
  delete_row: registarDeleteRow,
};

/**
 * Passo 1 do arranque: dependências externas, antes de tudo o resto.
 *
 * Corre UMA VEZ por processo, em qualquer dos modos. É aqui que se abrem os
 * pools, e é essa a razão de estar separado do criarServidor(): no modo HTTP
 * constrói-se um McpServer por sessão, e seria absurdo abrir um pool de Postgres
 * de cada vez que um cliente faz initialize.
 *
 * Devolve o REGISTO — um contexto por cada perfil que ficou configurado — e não
 * um contexto só. Quem escolhe qual usar é o ponto de entrada: o stdio pelo
 * MCP_PERFIL, um por processo; o HTTP, quando tiver autenticação, pela identidade
 * de quem chama, um por sessão. É a razão de esta função não saber nada sobre
 * papéis: ela abre o que os perfis que lhe derem pedirem, e mais nada.
 *
 * QUE PERFIS CONFIGURAR É DECISÃO DE QUEM CHAMA, e não uma constante deste
 * ficheiro. Um processo stdio lançado como `employee` passa só o `employee`, e
 * assim nem lê do ambiente a connection string de escrita, quanto mais abrir um
 * pool com ela. Preserva-se a isolação por processo que este servidor sempre teve
 * — a credencial de escrita não existe no processo que não escreve —, e continua
 * a ser possível correr dois deployments separados em vez de um só.
 *
 * Falha com exceção — nunca devolve um servidor "meio vivo".
 */
export async function arrancarDependencias(perfis: readonly Perfil[]): Promise<Registo> {
  // O libpg-query é WebAssembly, e o módulo WASM tem de ser carregado antes de
  // se poder chamar o parseSync(). É assíncrono, e é a razão de ser feito aqui:
  // fazendo-o uma vez no arranque, a Camada 1 fica a ser uma função SÍNCRONA
  // normal, muito mais simples de ler e de testar do que se cada validação
  // tivesse de ser esperada.
  await loadModule();
  log("parser do PostgreSQL carregado.");

  // Falha aqui se nenhum perfil ficar configurado ou se a base não responder. É
  // deliberado: um servidor que arranca sem base de dados só dá o erro na
  // primeira tool chamada, e aí aparece a meio de uma conversa em vez de aparecer
  // no arranque.
  //
  // O resumo por perfil é logado lá dentro, e não no criarServidor() onde as
  // tools são de facto registadas. A razão é o modo HTTP: com um McpServer por
  // sessão, um log no criarServidor() repetia-se de cada vez que um cliente se
  // ligasse. Isto descreve a CONFIGURAÇÃO do processo, decidida uma vez.
  return arrancarRegisto(perfis);
}

/**
 * Passo 2 do arranque: um McpServer com as suas tools, pronto a ligar a um
 * transporte.
 *
 * Barato de propósito, e tem de continuar a ser: no modo stdio isto corre uma
 * vez; no modo HTTP corre uma vez POR SESSÃO. Não abre ligações, não lê o
 * ambiente, não faz I/O — só instancia o servidor e pendura closures das tools.
 *
 * Não faz logging. Ver a nota no fim do arrancarDependencias().
 */
export function criarServidor(contexto: ContextoAcesso): McpServer {
  const server = new McpServer({
    name: "distribuidor-db",
    version: "1.0.0",
  });

  // A LISTA DE TOOLS VEM DO PERFIL, não de um `if` escrito aqui. É a diferença
  // que esta fase introduz: "que papel vê que tools" passou a ser um dado, no
  // perfis.ts, e este ficheiro limita-se a executar o que lá está declarado. Um
  // papel novo não obriga a tocar nesta função.
  //
  // As tools de leitura aceitam um ContextoLeitura, e um ContextoEscrita
  // satisfá-lo por herança — servem os dois casos sem saberem que casos existem.
  for (const nome of contexto.perfil.toolsLeitura) {
    REGISTADORES_LEITURA[nome](server, contexto);
  }

  // O `temEscrita` estreita o tipo, e é essa estreiteza que os registadores
  // abaixo exigem: eles pedem um ContextoEscrita, portanto chamá-los fora deste
  // bloco não compila. A garantia de que um papel só-de-leitura não fica com
  // tools de escrita registadas continua a ser do compilador, e não de alguém se
  // lembrar de escrever a condição certa.
  //
  // O estreitamento faz mais do que parece: leva consigo o perfil, que passa a
  // ser um PerfilEscrita. É por isso que o `.escrita.tools` aqui não precisa de
  // verificação nenhuma — um contexto que escreve traz sempre um perfil que
  // declara o que escrever, porque as duas coisas nascem juntas no registo.
  if (temEscrita(contexto)) {
    for (const nome of contexto.perfil.escrita.tools) {
      REGISTADORES_ESCRITA[nome](server, contexto);
    }
  }

  return server;
}

/**
 * Encerramento ordeiro, igual nos dois modos.
 *
 * Devolver as ligações ao Postgres em vez de as deixar penduradas até ao
 * timeout do lado do servidor. O SIGINT é o Ctrl+C; o SIGTERM é o que o Claude
 * Desktop (ou o Docker) envia quando fecha o servidor.
 *
 * O `antesDeFechar` é o que cada transporte tem de arrumar antes de as ligações
 * à base irem abaixo: no stdio não há nada, no HTTP há sessões abertas e um
 * socket à escuta. Corre PRIMEIRO, para que nenhuma tool ainda a meio de uma
 * chamada encontre o pool já fechado.
 */
export function registarEncerramento(antesDeFechar?: () => Promise<void>): void {
  let aEncerrar = false;

  async function encerrar(sinal: string): Promise<void> {
    // Um segundo Ctrl+C durante o encerramento não deve começar tudo outra vez.
    if (aEncerrar) {
      return;
    }
    aEncerrar = true;

    log(`recebido ${sinal}, a encerrar...`);
    try {
      if (antesDeFechar !== undefined) {
        await antesDeFechar();
      }
    } catch (erro) {
      // Uma falha a arrumar o transporte não pode impedir o fecho dos pools —
      // seria trocar um problema pequeno por ligações penduradas no Postgres.
      log(`erro ao arrumar o transporte: ${mensagemDoErro(erro)}`);
    }
    await fecharBaseDeDados();
    await fecharEscrita();
    process.exit(0);
  }

  process.on("SIGINT", () => void encerrar("SIGINT"));
  process.on("SIGTERM", () => void encerrar("SIGTERM"));
}

/**
 * O catch do arranque, igual nos dois modos.
 *
 * É só para falhas de ARRANQUE — os erros dentro das tools são tratados em cada
 * tool e devolvidos ao cliente. Aqui não há cliente ligado a quem responder, por
 * isso a mensagem vai para o stderr e o processo morre com código diferente de
 * zero, que é o que sinaliza a falha a quem o lançou.
 */
export function falharNoArranque(erro: unknown): never {
  console.error(`[mcp] FALHA NO ARRANQUE: ${mensagemDoErro(erro)}`);
  process.exit(1);
}
