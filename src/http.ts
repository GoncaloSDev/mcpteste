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
 * primeira vista. Os pools — um por connection string, leitura sempre, escrita
 * opt-in — são abertos uma vez pelo arrancarDependencias(), antes de o socket
 * HTTP sequer existir, e ficam no registo de perfis. Nenhum dos dois modos lhes
 * toca por pedido; em qualquer deles os pools são do PROCESSO, não da sessão.
 * O que os pools decidem é outra coisa: como não pertencem à sessão,
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
import { PERFIS } from "./acesso/perfis.js";
import type { Registo } from "./acesso/registo.js";
import { criarAutenticacao, type AmbienteMcp } from "./http/autenticacao.js";
import { erroJsonRpc } from "./http/jsonrpc.js";
import { lerSegredosDoAmbiente, type Identidade } from "./http/token.js";
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
 * Uma sessão viva.
 *
 * Guarda-se o TRANSPORTE e não o McpServer: é o transporte que sabe encaminhar
 * um pedido HTTP para a stream certa, e é ele que o servidor MCP tem do outro
 * lado do connect(). O McpServer fica preso a este por referência e é recolhido
 * com ele.
 *
 * A IDENTIDADE ficou aqui a partir da Fase 3, e é o que impede o `Mcp-Session-Id`
 * de ser uma credencial: cada pedido traz o seu token, e a camada de autenticação
 * confronta-o com esta identidade antes de o pedido chegar ao transporte. Sem
 * isto, quem apanhasse um session-id de admin continuava a sessão dele.
 */
interface Sessao {
  readonly transporte: StreamableHTTPServerTransport;
  readonly identidade: Identidade;
}

/** As sessões vivas, indexadas pelo Mcp-Session-Id que o SDK gerou. */
const sessoes = new Map<string, Sessao>();

/**
 * Abre uma sessão: transporte novo, McpServer novo, ligados um ao outro.
 *
 * Só é chamado no `initialize`. O ID não é escolhido aqui — é o SDK que o gera
 * com o sessionIdGenerator, o devolve no cabeçalho Mcp-Session-Id da resposta ao
 * initialize e o exige em todos os pedidos seguintes.
 */
async function abrirSessao(
  contexto: ContextoAcesso,
  identidade: Identidade,
): Promise<StreamableHTTPServerTransport> {
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
      sessoes.set(id, { transporte, identidade });
      log(
        `sessão aberta: ${id} — ${identidade.sujeito} como '${identidade.papel}' ` +
          `(${sessoes.size} ativa(s)).`,
      );
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

function criarApp(registo: Registo, segredos: readonly string[]): Hono<AmbienteMcp> {
  const app = new Hono<AmbienteMcp>();

  /**
   * Validação do cabeçalho Origin.
   *
   * NÃO é autenticação — essa é a camada a seguir, no http/autenticacao.ts, e
   * esta corre primeiro por ser mais barata: três linhas contra um HMAC.
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

  /**
   * A AUTENTICAÇÃO. Depois da Origin (que é uma verificação de três linhas e
   * dispensa HMAC nenhum) e antes de tudo o resto — em particular antes de o
   * routing de sessões poder olhar para o Mcp-Session-Id.
   *
   * Corre nos TRÊS métodos por estar montada no caminho e não numa rota. Um
   * método novo que alguém acrescente amanhã nasce autenticado, em vez de nascer
   * aberto até alguém reparar.
   */
  app.use(
    CAMINHO_MCP,
    criarAutenticacao({
      segredos,
      contextoDoPapel: (papel) => registo.obter(papel),
      identidadeDaSessao: (id) => sessoes.get(id)?.identidade,
    }),
  );

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
    let transporte =
      idSessao === undefined ? undefined : sessoes.get(idSessao)?.transporte;

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
      // O contexto e a identidade vêm da camada de autenticação, que já os pôs
      // no pedido. É aqui que o papel de quem chama se torna a lista de tools que
      // a sessão vai ter: o criarServidor() regista o que o perfil declara, e um
      // employee fica com um McpServer onde o delete_row não existe.
      transporte = await abrirSessao(c.get("contexto"), c.get("identidade"));
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
  const transporte = sessoes.get(idSessao)?.transporte;
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
  // PRIMEIRO O SEGREDO, antes de se abrir uma única ligação ao Postgres. Falha
  // com exceção se não existir, e é essa a política: com o basic auth do Traefik
  // fora deste domínio — que é a consequência mecânica de o connector só ter um
  // cabeçalho Authorization —, um servidor sem token não é um servidor degradado,
  // é a base de dados aberta a quem souber o URL.
  const segredos = lerSegredosDoAmbiente();
  log(
    `autenticação por token ligada${segredos.length > 1 ? " (a aceitar também o segredo anterior)" : ""}.`,
  );

  // TODOS os perfis, e não um só. É a diferença que a autenticação traz: o papel
  // deixou de ser uma propriedade do processo e passou a vir de quem chama, por
  // sessão. Os perfis que não estiverem configurados neste deployment ficam
  // simplesmente de fora, e um token que os peça leva 403 — é assim que a escrita
  // continua opt-in: sem DATABASE_URL_WRITE, o `admin` não existe aqui.
  //
  // Igual ao stdio no que interessa: um servidor que abre o porto HTTP antes de
  // saber se tem base de dados só dá o erro ao primeiro cliente que se ligar.
  const registo = await arrancarDependencias(PERFIS);
  log(`perfis servidos por este endpoint: ${registo.disponiveis.join(", ")}.`);

  // --- 2. O endpoint ---------------------------------------------------------

  const porta = lerPorta();
  // Loopback por omissão. Continua a não ser segurança a sério — agora há
  // autenticação por token à frente de tudo, mas o valor omisso mantém-se
  // fechado: pôr 0.0.0.0 aqui é o que um deployment faz, e tem de ser um ato
  // deliberado e não o que acontece a quem não leu.
  const anfitriao = process.env["MCP_HTTP_HOST"] ?? "127.0.0.1";

  const app = criarApp(registo, segredos);
  const servidorHttp: ServerType = serve({ fetch: app.fetch, port: porta, hostname: anfitriao }, () => {
    log(`servidor pronto, à escuta em http://${anfitriao}:${porta}${CAMINHO_MCP} (Streamable HTTP).`);
  });

  // --- 3. Encerramento -------------------------------------------------------

  registarEncerramento(async () => {
    // Primeiro as sessões: fechar as streams SSE abertas, senão o close() do
    // servidor HTTP fica à espera delas para sempre.
    for (const sessao of [...sessoes.values()]) {
      await sessao.transporte.close();
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
