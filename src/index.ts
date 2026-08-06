/**
 * Ponto de entrada STDIO — arranca o servidor MCP e liga-o ao transporte stdio.
 *
 * É o modo de DESENVOLVIMENTO LOCAL: é assim que o Claude Desktop e o MCP
 * Inspector lançam este servidor (um processo por cliente, lançado pelo próprio
 * cliente). O modo HTTP vive no http.ts e é o caminho de produção — os dois
 * montam exatamente o mesmo servidor, através do servidor.ts.
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

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { log } from "./log.js";
import {
  arrancarDependencias,
  criarServidor,
  falharNoArranque,
  registarEncerramento,
} from "./servidor.js";

async function main(): Promise<void> {
  // --- 1. Dependências externas, antes de tudo o resto -----------------------

  const contexto = await arrancarDependencias();

  // --- 2. O servidor MCP e as suas tools ------------------------------------

  const server = criarServidor(contexto);

  // --- 3. Abrir o canal ------------------------------------------------------

  // A partir daqui o stdout pertence ao protocolo (ver o comentário no log.ts).
  // O connect() não termina: fica a servir pedidos até o cliente fechar o stdin.
  const transporte = new StdioServerTransport();
  await server.connect(transporte);
  log("servidor pronto, à escuta em stdio.");
}

registarEncerramento();

main().catch(falharNoArranque);
