/**
 * Ponto de entrada HTTP — o mesmo servidor MCP, servido por Streamable HTTP.
 *
 * É o transporte que a secção 5.3 do guia exige para as ferramentas dos agentes,
 * sobre o Hono que a secção 5.2 escolheu para o backend. O stdio (index.ts) não
 * desaparece: continua a ser o modo de desenvolvimento local, lançado pelo
 * Claude Desktop e pelo Inspector. Os dois montam o MESMO servidor e as MESMAS
 * tools, através do servidor.ts — aqui só muda o cabo.
 *
 * O QUE É O STREAMABLE HTTP, em três linhas: um endpoint só, /mcp, com três
 * métodos. O POST leva as mensagens JSON-RPC do cliente e traz a resposta — em
 * JSON direto ou em SSE na mesma ligação, à escolha do servidor. O GET abre uma
 * stream SSE avulsa, por onde o servidor envia o que quer dizer sem ter sido
 * perguntado (notificações) e por onde o cliente retoma uma stream cortada. O
 * DELETE encerra a sessão.
 *
 * ------------------------------------------------------------------------------
 * DECISÃO: SESSÕES COM ESTADO (Mcp-Session-Id), não stateless.
 * ------------------------------------------------------------------------------
 *
 * O argumento dos pools NÃO é o que decide isto, ao contrário do que parece à
 * primeira vista. Os dois pools — leitura sempre, escrita opt-in — são variáveis
 * de módulo do db.ts e do db-escrita.ts, abertas uma vez pelo
 * arrancarDependencias() antes de o socket HTTP sequer existir. Nenhum dos dois
 * modos lhes toca por pedido; em qualquer deles os pools são do PROCESSO, não da
 * sessão. O que os pools decidem é outra coisa: como não pertencem à sessão,
 * uma sessão em memória custa um McpServer e as closures das suas tools, e mais
 * nada. Guardar sessões é barato precisamente por isso.
 *
 * O que decide são três coisas:
 *
 *   1. Sem sessão, metade do transporte não existe. O GET (stream SSE avulsa,
 *      retoma com Last-Event-ID) e o DELETE (encerrar) identificam-se pelo
 *      Mcp-Session-Id — em modo stateless não há nada que eles possam apontar.
 *      Ficaria um "Streamable HTTP" que é só um POST/resposta.
 *
 *   2. O modo stateless do SDK obriga, na prática, a construir um McpServer e um
 *      transporte NOVOS a cada POST e deitá-los fora no fim — é esse o padrão
 *      recomendado, porque um transporte stateless partilhado não consegue
 *      distinguir os IDs de pedido de clientes concorrentes. Isso é registar 9
 *      tools e compilar os seus schemas Zod em cada chamada, para atirar tudo
 *      fora a seguir.
 *
 *   3. O initialize do MCP é uma negociação de capacidades entre as duas pontas.
 *      Um servidor sem sessão não tem onde guardar o resultado dessa negociação.
 *
 * O QUE ISTO CUSTA, e que fica por resolver nesta etapa: o estado das sessões
 * vive na memória DESTE processo. Duas instâncias atrás de um balanceador não
 * partilham sessões — em produção isso exige sticky sessions ou um EventStore
 * partilhado (Redis), que é conversa da Fase 1 e não desta.
 */

// Primeiro import, pela mesma razão que no index.ts: em ESM os módulos são
// avaliados por ordem de declaração e o .env tem de estar carregado antes de
// qualquer módulo poder ler o process.env.
import "dotenv/config";

import { randomUUID } from "node:crypto";

import { serve, type HttpBindings, type ServerType } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";

import type { ContextoAcesso } from "./acesso/contexto.js";
import { log, mensagemDoErro } from "./log.js";
import {
  arrancarDependencias,
  criarServidor,
  falharNoArranque,
  registarEncerramento,
} from "./servidor.js";

/** O caminho do endpoint MCP. Um só, como manda a especificação do transporte. */
const CAMINHO_MCP = "/mcp";

/**
 * As sessões vivas, indexadas pelo Mcp-Session-Id que o SDK gerou.
 *
 * Guarda-se o TRANSPORTE e não o McpServer: é o transporte que sabe encaminhar
 * um pedido HTTP para a stream certa, e é ele que o servidor MCP tem do outro
 * lado do connect(). O McpServer fica preso a este por referência e é recolhido
 * com ele.
 */
const sessoes = new Map<string, StreamableHTTPServerTransport>();

/**
 * Um erro JSON-RPC para devolver antes de o transporte entrar em ação.
 *
 * O `id: null` é obrigatório pela especificação JSON-RPC quando o erro é tal que
 * nem se conseguiu apurar a que pedido dizia respeito — que é exatamente o caso
 * de todos os erros deste ficheiro (corpo ilegível, sessão desconhecida).
 */
function erroJsonRpc(codigo: number, mensagem: string) {
  return { jsonrpc: "2.0" as const, error: { code: codigo, message: mensagem }, id: null };
}

/**
 * Abre uma sessão: transporte novo, McpServer novo, ligados um ao outro.
 *
 * Só é chamado no `initialize`. O ID não é escolhido aqui — é o SDK que o gera
 * com o sessionIdGenerator, o devolve no cabeçalho Mcp-Session-Id da resposta ao
 * initialize e o exige em todos os pedidos seguintes.
 */
async function abrirSessao(contexto: ContextoAcesso): Promise<StreamableHTTPServerTransport> {
  // A anotação de tipo explícita não é decorativa: os callbacks abaixo referem
  // `transporte` dentro do seu próprio inicializador, e sem ela o TypeScript não
  // consegue inferir o tipo (referência circular). Em execução não há problema
  // nenhum — os callbacks só correm muito depois de a constante estar atribuída.
  const transporte: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    // A presença desta função é o que liga o modo com sessões. Passar `undefined`
    // aqui é o que o SDK entende por stateless — ver a decisão no topo do
    // ficheiro.
    sessionIdGenerator: () => randomUUID(),

    // Só aqui, e não logo a seguir ao construtor, é que o ID existe. Registar a
    // sessão antes disto guardaria uma entrada com a chave `undefined`.
    onsessioninitialized: (id) => {
      sessoes.set(id, transporte);
      log(`sessão aberta: ${id} (${sessoes.size} ativa(s)).`);
    },

    // O cliente pediu DELETE. O transporte já se encarrega de fechar as streams;
    // o que falta é tirá-lo do mapa, senão a sessão ficava aqui para sempre.
    onsessionclosed: (id) => {
      sessoes.delete(id);
      log(`sessão encerrada pelo cliente: ${id} (${sessoes.size} ativa(s)).`);
    },
  });

  // Rede de segurança para os fechos que não passam pelo DELETE — o McpServer a
  // fechar do seu lado, um erro fatal no transporte, o encerramento do processo.
  // Sem isto, essas sessões ficavam no mapa a apontar para transportes mortos.
  transporte.onclose = () => {
    const id = transporte.sessionId;
    if (id !== undefined && sessoes.delete(id)) {
      log(`sessão terminada: ${id} (${sessoes.size} ativa(s)).`);
    }
  };

  const servidor = criarServidor(contexto);
  await servidor.connect(transporte);
  return transporte;
}

/**
 * Entrega o pedido ao transporte.
 *
 * A partir daqui quem escreve na resposta é o SDK, diretamente no
 * ServerResponse do Node — é por isso que o handler devolve RESPONSE_ALREADY_SENT
 * em vez de uma Response do Hono: é a forma de dizer ao adaptador do
 * @hono/node-server "não toques nisto, já foi respondido".
 *
 * Nota sobre o await: num GET (stream SSE avulsa) esta promessa só resolve
 * quando a stream fecha, o que pode ser daqui a muito tempo. É o comportamento
 * correto — a resposta já está a ser escrita, e o handler ficar pendurado não
 * bloqueia mais nenhum pedido.
 */
async function entregarAoTransporte(
  transporte: StreamableHTTPServerTransport,
  bindings: HttpBindings,
  corpoJaLido?: unknown,
): Promise<void> {
  try {
    await transporte.handleRequest(bindings.incoming, bindings.outgoing, corpoJaLido);
  } catch (erro) {
    log(`erro a tratar o pedido: ${mensagemDoErro(erro)}`);
    // Se os cabeçalhos já saíram não há nada a fazer senão cortar a ligação: uma
    // resposta HTTP não se reescreve a meio.
    if (!bindings.outgoing.headersSent) {
      bindings.outgoing.writeHead(500, { "content-type": "application/json" });
      bindings.outgoing.end(JSON.stringify(erroJsonRpc(-32603, "Erro interno do servidor.")));
    } else {
      bindings.outgoing.end();
    }
  }
}

function criarApp(contexto: ContextoAcesso): Hono<{ Bindings: HttpBindings }> {
  const app = new Hono<{ Bindings: HttpBindings }>();

  /**
   * Validação do cabeçalho Origin.
   *
   * NÃO é autenticação — a autenticação está explicitamente fora desta etapa.
   * É a proteção contra DNS rebinding que a especificação do MCP recomenda para
   * servidores locais, e o motivo é concreto: sem ela, qualquer página aberta no
   * browser desta máquina pode fazer POST a http://localhost:3000/mcp e correr
   * queries sobre a base de dados. São quinze linhas e fecham essa porta.
   *
   * Pedidos SEM Origin passam: é o caso dos clientes MCP nativos (Claude
   * Desktop, curl), que não são browsers e não enviam o cabeçalho. O que se está
   * a filtrar são páginas web, e essas enviam-no sempre.
   */
  app.use(CAMINHO_MCP, async (c, next) => {
    const origem = c.req.header("origin");
    if (origem !== undefined && !origemPermitida(origem)) {
      log(`pedido recusado: Origin '${origem}' não permitida.`);
      return c.json(erroJsonRpc(-32003, "Origin não permitida."), 403);
    }
    await next();
  });

  // --- POST: as mensagens do cliente ------------------------------------------
  app.post(CAMINHO_MCP, async (c) => {
    // O corpo é lido AQUI, e não pelo transporte, porque é preciso espreitá-lo
    // para saber se isto é um initialize. Como o stream do pedido só se lê uma
    // vez, o que foi lido segue depois para o handleRequest() como parsedBody —
    // é para isso que esse terceiro parâmetro existe.
    let corpo: unknown;
    try {
      corpo = await c.req.json();
    } catch {
      return c.json(erroJsonRpc(-32700, "O corpo do pedido não é JSON válido."), 400);
    }

    const idSessao = c.req.header("mcp-session-id");
    let transporte = idSessao === undefined ? undefined : sessoes.get(idSessao);

    if (transporte === undefined) {
      // Um ID que não conhecemos. O 404 é o que a especificação manda, e é o que
      // faz o cliente perceber que tem de fazer initialize outra vez em vez de
      // insistir com a sessão que morreu (reinício do servidor, por exemplo).
      if (idSessao !== undefined) {
        return c.json(erroJsonRpc(-32001, `Sessão desconhecida ou já encerrada: ${idSessao}`), 404);
      }
      // Sem ID e sem ser um initialize: não há sessão a que isto possa pertencer.
      if (!isInitializeRequest(corpo)) {
        return c.json(
          erroJsonRpc(
            -32000,
            "Pedido sem Mcp-Session-Id. A primeira mensagem de uma sessão tem de ser um 'initialize'.",
          ),
          400,
        );
      }
      transporte = await abrirSessao(contexto);
    }

    await entregarAoTransporte(transporte, c.env, corpo);
    return RESPONSE_ALREADY_SENT;
  });

  // --- GET: stream SSE avulsa (notificações e retoma) -------------------------
  //
  // Sem corpo para ler, ao contrário do POST — daí não haver aqui c.req.json().
  // É por esta stream que o servidor fala primeiro, e é por ela que um cliente
  // retoma o que perdeu, mandando o Last-Event-ID.
  app.get(CAMINHO_MCP, async (c) => {
    const sessao = sessaoDoPedido(c.req.header("mcp-session-id"));
    if (sessao.transporte === undefined) {
      return c.json(erroJsonRpc(-32001, sessao.mensagem), sessao.estadoHttp);
    }
    await entregarAoTransporte(sessao.transporte, c.env);
    return RESPONSE_ALREADY_SENT;
  });

  // --- DELETE: encerrar a sessão ----------------------------------------------
  //
  // Quem tira a sessão do mapa é o onsessionclosed lá em cima, chamado pelo
  // transporte depois de fechar as streams. Aqui é só encaminhar.
  app.delete(CAMINHO_MCP, async (c) => {
    const sessao = sessaoDoPedido(c.req.header("mcp-session-id"));
    if (sessao.transporte === undefined) {
      return c.json(erroJsonRpc(-32001, sessao.mensagem), sessao.estadoHttp);
    }
    await entregarAoTransporte(sessao.transporte, c.env);
    return RESPONSE_ALREADY_SENT;
  });

  return app;
}

/**
 * O transporte de uma sessão, ou o erro que explica porque não há.
 *
 * O GET e o DELETE precisam exatamente da mesma verificação, com os mesmos dois
 * desfechos: falta o cabeçalho (400, o pedido está mal formado) ou o ID não
 * corresponde a nada (404, a sessão não existe ou já morreu).
 */
type ResultadoSessao =
  | { transporte: StreamableHTTPServerTransport }
  | { transporte: undefined; mensagem: string; estadoHttp: 400 | 404 };

function sessaoDoPedido(idSessao: string | undefined): ResultadoSessao {
  if (idSessao === undefined) {
    return {
      transporte: undefined,
      mensagem: "Pedido sem o cabeçalho Mcp-Session-Id.",
      estadoHttp: 400,
    };
  }
  const transporte = sessoes.get(idSessao);
  if (transporte === undefined) {
    return {
      transporte: undefined,
      mensagem: `Sessão desconhecida ou já encerrada: ${idSessao}`,
      estadoHttp: 404,
    };
  }
  return { transporte };
}

/** Origens aceites além das locais, separadas por vírgula. Vazio por omissão. */
const ORIGENS_EXTRA = (process.env["MCP_HTTP_ORIGENS"] ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter((o) => o !== "");

function origemPermitida(origem: string): boolean {
  if (ORIGENS_EXTRA.includes(origem)) {
    return true;
  }
  // Comparar o HOSTNAME e não a string toda: o Inspector serve-se de
  // http://localhost:6274 e o porto muda de versão para versão. O que interessa
  // é que a origem seja esta máquina.
  try {
    const { hostname } = new URL(origem);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    // Um Origin que nem sequer é um URL não vem de lado nenhum de bom.
    return false;
  }
}

async function main(): Promise<void> {
  // --- 1. Dependências externas, antes de tudo o resto -----------------------
  //
  // Igual ao stdio, e de propósito: um servidor que abre o porto HTTP antes de
  // saber se tem base de dados só dá o erro ao primeiro cliente que se ligar.
  const contexto = await arrancarDependencias();

  // --- 2. O endpoint ---------------------------------------------------------

  const porta = lerPorta();
  // Loopback por omissão. Não é segurança a sério — é o mínimo para que um
  // servidor sem autenticação nenhuma (ver o topo do ficheiro) não fique exposto
  // à rede local por distração. Pôr 0.0.0.0 aqui tem de ser um ato deliberado.
  const anfitriao = process.env["MCP_HTTP_HOST"] ?? "127.0.0.1";

  const app = criarApp(contexto);
  const servidorHttp: ServerType = serve({ fetch: app.fetch, port: porta, hostname: anfitriao }, () => {
    log(`servidor pronto, à escuta em http://${anfitriao}:${porta}${CAMINHO_MCP} (Streamable HTTP).`);
  });

  // --- 3. Encerramento -------------------------------------------------------

  registarEncerramento(async () => {
    // Primeiro as sessões: fechar as streams SSE abertas, senão o close() do
    // servidor HTTP fica à espera delas para sempre.
    for (const transporte of [...sessoes.values()]) {
      await transporte.close();
    }
    sessoes.clear();

    await new Promise<void>((resolver) => {
      servidorHttp.close(() => resolver());
      // As ligações keep-alive paradas não fecham sozinhas com o close(), e o
      // processo ficaria a arrastar-se até ao timeout do cliente.
      if ("closeAllConnections" in servidorHttp) {
        servidorHttp.closeAllConnections();
      }
    });
  });
}

function lerPorta(): number {
  const valor = process.env["MCP_HTTP_PORT"];
  if (valor === undefined) {
    return 3000;
  }
  const numero = Number.parseInt(valor, 10);
  if (!Number.isInteger(numero) || numero < 1 || numero > 65535) {
    log(`MCP_HTTP_PORT='${valor}' não é um porto válido — a usar 3000.`);
    return 3000;
  }
  return numero;
}

main().catch(falharNoArranque);
