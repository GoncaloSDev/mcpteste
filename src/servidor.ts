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
  criarContextoEscrita,
  criarContextoLeitura,
  temEscrita,
  type ContextoAcesso,
} from "./acesso/contexto.js";
import { arrancarBaseDeDados, fecharBaseDeDados } from "./db.js";
import { arrancarEscrita, fecharEscrita } from "./db-escrita.js";
import { log, mensagemDoErro } from "./log.js";
import { TABELAS_ESCRITA } from "./seguranca/escrita-camada1-alvo.js";
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
 * Passo 1 do arranque: dependências externas, antes de tudo o resto.
 *
 * Corre UMA VEZ por processo, em qualquer dos modos. É aqui que se abrem os
 * pools, e é essa a razão de estar separado do criarServidor(): no modo HTTP
 * constrói-se um McpServer por sessão, e seria absurdo abrir um pool de Postgres
 * de cada vez que um cliente faz initialize.
 *
 * Falha com exceção — nunca devolve um servidor "meio vivo".
 */
export async function arrancarDependencias(): Promise<ContextoAcesso> {
  // O libpg-query é WebAssembly, e o módulo WASM tem de ser carregado antes de
  // se poder chamar o parseSync(). É assíncrono, e é a razão de ser feito aqui:
  // fazendo-o uma vez no arranque, a Camada 1 fica a ser uma função SÍNCRONA
  // normal, muito mais simples de ler e de testar do que se cada validação
  // tivesse de ser esperada.
  await loadModule();
  log("parser do PostgreSQL carregado.");

  // Falha aqui se a variável não existir ou a base não responder. É deliberado:
  // um servidor que arranca sem base de dados só dá o erro na primeira tool
  // chamada, e aí aparece a meio de uma conversa em vez de aparecer no arranque.
  const { ligacao: ligacaoLeitura, identidade } = await arrancarBaseDeDados();

  // A verificação mais barata que existe de que não estamos, por engano, a usar
  // a connection string de admin. Se aqui aparecer "admin_dist" em vez de
  // "mcp_readonly", está algo errado no .env — e vê-se de imediato.
  log(`ligado a ${identidade.baseDeDados} (${identidade.versaoPostgres})`);
  log(`current_user = ${identidade.utilizador}`);
  if (identidade.utilizador !== "mcp_readonly") {
    log(
      `AVISO: o utilizador esperado era 'mcp_readonly'. Confirma a DATABASE_URL_READONLY ` +
        `no .env — a transação READ ONLY continua a impedir escritas, mas esta ligação ` +
        `tem mais permissões do que devia.`,
    );
  }

  // --- Modo de escrita, se estiver configurado -------------------------------
  //
  // OPT-IN. Sem DATABASE_URL_WRITE isto devolve null em silêncio e o servidor
  // fica exatamente como sempre foi: quatro tools, nenhuma delas capaz de
  // escrever. É o que permite registar a MESMA build duas vezes no cliente MCP,
  // uma entrada só-leitura e outra com escrita, sem tocar em código.
  //
  // Se a variável existir mas a ligação não servir — ou se for de
  // superutilizador — o arranque FALHA. Um modo de escrita meio ligado seria
  // pior do que nenhum.
  const escrita = await arrancarEscrita();

  if (escrita !== null) {
    log(`ESCRITA LIGADA — current_user = ${escrita.identidade.utilizador}`);
    log(
      `o Postgres concede INSERT a este utilizador em ` +
        `${escrita.identidade.tabelasComEscrita.length} tabelas: ` +
        `${escrita.identidade.tabelasComEscrita.join(", ")}`,
    );

    // Confronto entre as duas listas independentes: a whitelist deste servidor e
    // os privilégios reais do Postgres (que vêm do seed do outro repositório).
    // Não é decorativo — é o sítio onde uma divergência entre os dois lados
    // aparece no arranque, em vez de aparecer numa escrita que passou onde não
    // devia. Só se avisa quando o Postgres é MAIS PERMISSIVO do que a whitelist;
    // o contrário é seguro (a escrita é recusada pelo servidor antes de sair).
    const aMaisNoPostgres = escrita.identidade.tabelasComEscrita.filter(
      (t) => !TABELAS_ESCRITA.has(t),
    );
    if (aMaisNoPostgres.length > 0) {
      log(
        `AVISO: o utilizador de escrita tem INSERT em tabelas fora da whitelist deste servidor ` +
          `(${aMaisNoPostgres.join(", ")}). As tools recusam-nas à mesma, mas os GRANT do seed ` +
          `ficaram largos de mais — corre outra vez o seed do testeai-db.`,
      );
    }
  } else {
    log("modo só-leitura (DATABASE_URL_WRITE não definida).");
  }

  // O CONTEXTO. É aqui que se decide, uma vez, por que ligações é que as tools
  // vão falar — e é este objeto que o criarServidor() recebe em vez do booleano
  // que aqui estava. As duas ligações são passadas ao contexto de escrita; a de
  // leitura é a MESMA nos dois casos, e é de propósito: as consultas ao catálogo
  // e as contagens que acontecem a meio de uma escrita continuam a sair pelo
  // utilizador menos privilegiado, dentro da transação READ ONLY.
  const contexto: ContextoAcesso =
    escrita === null
      ? criarContextoLeitura("leitura", ligacaoLeitura)
      : criarContextoEscrita("escrita", ligacaoLeitura, escrita.ligacao);

  // O resumo das tools é logado AQUI e não dentro do criarServidor(), embora
  // seja lá que elas são de facto registadas. A razão é o modo HTTP: com um
  // McpServer por sessão, um log dentro do criarServidor() repetia estas duas
  // linhas de cada vez que um cliente se ligasse. Isto descreve a CONFIGURAÇÃO
  // do processo, que é decidida aqui e não muda mais.
  if (temEscrita(contexto)) {
    log(
      "9 tools disponíveis: list_tables, describe_table, sample_rows, run_query, " +
        "insert_row, update_row, archive_row, restore_row, delete_row.",
    );
    log(
      "arquivo: archive_row esconde (reversível); delete_row destrói em cascata e exige " +
        "que a linha já esteja arquivada.",
    );
  } else {
    log("4 tools disponíveis: list_tables, describe_table, sample_rows, run_query.");
  }

  return contexto;
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

  // As tools de leitura aceitam um ContextoLeitura, e um ContextoEscrita
  // satisfá-lo por herança — servem os dois casos sem saberem que casos existem.
  registarListTables(server, contexto);
  registarDescribeTable(server, contexto);
  registarSampleRows(server, contexto);
  registarRunQuery(server, contexto);

  // O `temEscrita` estreita o tipo, e é essa estreiteza que os cinco registos
  // abaixo exigem: eles pedem um ContextoEscrita, portanto chamá-los fora deste
  // bloco não compila. A garantia de que um papel só-de-leitura não fica com
  // tools de escrita registadas deixou de depender de alguém se lembrar do `if`
  // — passou a ser verificada pelo compilador.
  if (temEscrita(contexto)) {
    registarInsertRow(server, contexto);
    registarUpdateRow(server, contexto);
    // A ordem de registo não tem significado técnico, mas esta é a ordem do ciclo
    // de vida de um registo — criar, editar, arquivar, repor, destruir — e é a
    // que torna a lista legível para quem a lê de uma ponta à outra.
    registarArchiveRow(server, contexto);
    registarRestoreRow(server, contexto);
    registarDeleteRow(server, contexto);
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
