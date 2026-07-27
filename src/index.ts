/**
 * Ponto de entrada — arranca o servidor MCP e liga-o ao transporte stdio.
 *
 * Faz três coisas por esta ordem, e a ordem é obrigatória: carrega a
 * configuração, verifica que as dependências externas (parser e base de dados)
 * estão mesmo a funcionar, e só depois abre o canal MCP. Nada de registar tools
 * antes de saber que há base de dados por trás delas.
 */

// Este import TEM de ser o primeiro de todos. Em ESM os módulos importados são
// avaliados por ordem de declaração, antes de correr qualquer linha deste
// ficheiro — se o dotenv viesse a seguir a um módulo que lê process.env no seu
// corpo, esse módulo lia as variáveis antes de o .env ter sido carregado.
// (O db.ts está escrito para ler o ambiente dentro de uma função, precisamente
// para não depender só desta ordem — mas a ordem certa é a primeira defesa.)
import "dotenv/config";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadModule } from "libpg-query";

import { arrancarBaseDeDados, fecharBaseDeDados } from "./db.js";
import { registarDescribeTable } from "./tools/describeTable.js";
import { registarListTables } from "./tools/listTables.js";
import { registarRunQuery } from "./tools/runQuery.js";
import { registarSampleRows } from "./tools/sampleRows.js";

/**
 * A ARMADILHA Nº 1 DO TRANSPORTE STDIO, e a razão de todo o logging deste
 * projeto ser feito com console.error:
 *
 * No transporte stdio, o cliente MCP fala com o servidor pelos canais padrão do
 * processo: escreve os pedidos JSON-RPC no stdin e LÊ AS RESPOSTAS DO STDOUT.
 * O stdout não é a "consola" — é o cabo por onde passa o protocolo.
 *
 * Um único console.log("a correr...") injeta a linha "a correr..." no meio das
 * mensagens JSON-RPC. O cliente tenta interpretá-la como JSON, falha, e a
 * ligação parte-se — normalmente com um erro que não diz nada sobre a causa.
 *
 * O stderr é ignorado pelo protocolo e é para lá que vai todo o logging. Quando
 * o servidor corre dentro do Claude Desktop, é isso que aparece nos ficheiros de
 * log da aplicação.
 */
function log(mensagem: string): void {
  console.error(`[mcp] ${mensagem}`);
}

async function main(): Promise<void> {
  // --- 1. Dependências externas, antes de tudo o resto -----------------------

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
  const identidade = await arrancarBaseDeDados();

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

  // --- 2. O servidor MCP e as suas tools ------------------------------------

  const server = new McpServer({
    name: "distribuidor-db",
    version: "1.0.0",
  });

  registarListTables(server);
  registarDescribeTable(server);
  registarSampleRows(server);
  registarRunQuery(server);
  log("4 tools registadas: list_tables, describe_table, sample_rows, run_query.");

  // --- 3. Abrir o canal ------------------------------------------------------

  // A partir daqui o stdout pertence ao protocolo. O connect() não termina: fica
  // a servir pedidos até o cliente fechar o stdin.
  const transporte = new StdioServerTransport();
  await server.connect(transporte);
  log("servidor pronto, à escuta em stdio.");
}

/**
 * Encerramento ordeiro.
 *
 * Devolver as ligações ao Postgres em vez de as deixar penduradas até ao
 * timeout do lado do servidor. O SIGINT é o Ctrl+C; o SIGTERM é o que o Claude
 * Desktop envia quando fecha o servidor.
 */
async function encerrar(sinal: string): Promise<void> {
  log(`recebido ${sinal}, a encerrar...`);
  await fecharBaseDeDados();
  process.exit(0);
}

process.on("SIGINT", () => void encerrar("SIGINT"));
process.on("SIGTERM", () => void encerrar("SIGTERM"));

main().catch((erro: unknown) => {
  // Este catch é só para falhas de ARRANQUE — os erros dentro das tools são
  // tratados em cada tool e devolvidos ao cliente. Aqui não há cliente ligado a
  // quem responder, por isso a mensagem vai para o stderr e o processo morre com
  // código diferente de zero, que é o que sinaliza a falha a quem o lançou.
  const mensagem = erro instanceof Error ? erro.message : String(erro);
  console.error(`[mcp] FALHA NO ARRANQUE: ${mensagem}`);
  process.exit(1);
});
