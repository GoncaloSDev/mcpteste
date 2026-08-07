/**
 * Bateria de testes do TRANSPORTE HTTP e da sua autenticação.
 *
 * O terceiro irmão do testeCamadas.ts e do testeEscrita.ts, e o que preenche o
 * buraco que eles deixavam: aqueles falam por stdio, e o caminho HTTP — o único
 * que existe em produção — não tinha cobertura nenhuma.
 *
 * O QUE ESTE FICHEIRO PROVA, e que nenhum outro prova:
 *
 *   1. sem token não se entra                    (o endpoint não é público)
 *   2. um token que não seja nosso não entra     (assinatura, audiência, validade)
 *   3. o papel do token decide as tools          (4 para employee, 9 para admin)
 *   4. o Mcp-Session-Id NÃO é uma credencial     (a verificação que decide tudo)
 *
 * O ponto 4 é a razão de ser da fase. Se a autenticação só corresse no
 * initialize, um session-id de admin valia por si — e as outras três seriam
 * decoração.
 *
 * Lança o servidor como processo filho, num porto próprio, e fala com ele por
 * HTTP puro (fetch) em vez de usar o cliente do SDK: o que está em causa são
 * códigos de estado e cabeçalhos, e um cliente MCP esconde-os.
 *
 * Correr com:  npm run teste:http     (precisa da DATABASE_URL_WRITE)
 */

import "dotenv/config";

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

import {
  AUDIENCIA,
  emitirComClaims,
  emitirToken,
  type ClaimsToken,
} from "../src/http/token.js";

/** Porto próprio, para não colidir com um servidor de desenvolvimento a correr. */
const PORTA = 3099;
const BASE = `http://127.0.0.1:${PORTA}/mcp`;

/** Segredos desta corrida. Nascem aqui — não se toca no .env de ninguém. */
const SEGREDO = randomBytes(32).toString("base64url");
const SEGREDO_ANTERIOR = randomBytes(32).toString("base64url");
const SEGREDO_ALHEIO = randomBytes(32).toString("base64url");

let passou = 0;
let falhou = 0;

function registar(nome: string, ok: boolean, detalhe: string): void {
  if (ok) passou += 1;
  else falhou += 1;
  console.log(`[${ok ? "PASSA" : "FALHA"}] ${nome}\n        ${detalhe.slice(0, 200)}\n`);
}

interface Resposta {
  estado: number;
  corpo: string;
  idSessao: string | undefined;
}

async function pedir(
  corpo: unknown,
  token: string | undefined,
  idSessao?: string,
  metodo: "POST" | "GET" | "DELETE" = "POST",
): Promise<Resposta> {
  const cabecalhos: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (token !== undefined) {
    cabecalhos["authorization"] = `Bearer ${token}`;
  }
  if (idSessao !== undefined) {
    cabecalhos["mcp-session-id"] = idSessao;
  }

  const resposta = await fetch(BASE, {
    method: metodo,
    headers: cabecalhos,
    ...(metodo === "POST" ? { body: JSON.stringify(corpo) } : {}),
  });

  return {
    estado: resposta.status,
    corpo: await resposta.text(),
    idSessao: resposta.headers.get("mcp-session-id") ?? undefined,
  };
}

const PEDIDO_INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "teste-http", version: "1.0.0" },
  },
};

/** Abre uma sessão com o token dado e devolve o id. */
async function abrirSessao(token: string): Promise<string | undefined> {
  const r = await pedir(PEDIDO_INITIALIZE, token);
  return r.estado === 200 ? r.idSessao : undefined;
}

/** As tools que uma sessão vê. */
async function listarTools(token: string, idSessao: string): Promise<string[]> {
  const r = await pedir({ jsonrpc: "2.0", id: 2, method: "tools/list" }, token, idSessao);
  return [...r.corpo.matchAll(/"name":"([a-z_]+)"/g)].map((m) => m[1] as string);
}

async function esperarPorArranque(processo: ChildProcess): Promise<void> {
  await new Promise<void>((resolver, rejeitar) => {
    const limite = setTimeout(
      () => rejeitar(new Error("o servidor não arrancou em 20s")),
      20_000,
    );
    processo.stderr?.on("data", (pedaco: Buffer) => {
      const texto = pedaco.toString();
      if (texto.includes("servidor pronto")) {
        clearTimeout(limite);
        resolver();
      }
    });
    processo.on("exit", (codigo) => {
      clearTimeout(limite);
      rejeitar(new Error(`o servidor saiu com código ${codigo} antes de ficar pronto`));
    });
  });
}

async function main(): Promise<void> {
  if (!process.env["DATABASE_URL_WRITE"]) {
    console.error(
      "DATABASE_URL_WRITE não está definida — sem ela o perfil 'admin' não é servido\n" +
        "e metade das verificações desta bateria não teria o que verificar.\n" +
        "Define-a no .env (ver o .env.example) e corre outra vez.",
    );
    process.exit(1);
  }

  // --- Arranque -------------------------------------------------------------
  const servidor = spawn("node", ["dist/http.js"], {
    env: {
      ...process.env,
      MCP_HTTP_PORT: String(PORTA),
      MCP_TOKEN_SEGREDO: SEGREDO,
      MCP_TOKEN_SEGREDO_ANTERIOR: SEGREDO_ANTERIOR,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  try {
    await esperarPorArranque(servidor);

    // --- 1. Sem token ------------------------------------------------------
    const semToken = await pedir(PEDIDO_INITIALIZE, undefined);
    registar(
      "sem token -> 401",
      semToken.estado === 401,
      `HTTP ${semToken.estado} — ${semToken.corpo.slice(0, 120)}`,
    );

    // --- 2. Esquema errado -------------------------------------------------
    const respostaBasic = await fetch(BASE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        // Credenciais no URL viram Basic — que é exatamente o cabeçalho que este
        // desenho teve de abandonar. Tem de ser recusado, e não ignorado.
        authorization: "Basic dXRpbGl6YWRvcjpwYXNzd29yZA==",
      },
      body: JSON.stringify(PEDIDO_INITIALIZE),
    });
    registar(
      "esquema Basic em vez de Bearer -> 401",
      respostaBasic.status === 401,
      `HTTP ${respostaBasic.status}`,
    );

    // --- 3. Assinatura adulterada ------------------------------------------
    const bom = emitirToken(SEGREDO, { sujeito: "ana", papel: "employee" });
    const adulterado = `${bom.slice(0, -4)}${bom.slice(-4) === "AAAA" ? "BBBB" : "AAAA"}`;
    const rAdulterado = await pedir(PEDIDO_INITIALIZE, adulterado);
    registar(
      "assinatura adulterada -> 401",
      rAdulterado.estado === 401,
      `HTTP ${rAdulterado.estado}`,
    );

    // --- 4. Assinado com outro segredo -------------------------------------
    const doAlheio = emitirToken(SEGREDO_ALHEIO, { sujeito: "ana", papel: "employee" });
    const rAlheio = await pedir(PEDIDO_INITIALIZE, doAlheio);
    registar(
      "token assinado com um segredo que não é nosso -> 401",
      rAlheio.estado === 401,
      `HTTP ${rAlheio.estado}`,
    );

    // --- 5. Expirado -------------------------------------------------------
    const expirado = emitirToken(SEGREDO, {
      sujeito: "ana",
      papel: "employee",
      validadeSegundos: -60,
    });
    const rExpirado = await pedir(PEDIDO_INITIALIZE, expirado);
    registar("token expirado -> 401", rExpirado.estado === 401, `HTTP ${rExpirado.estado}`);

    // --- 6. Audiência errada ------------------------------------------------
    //
    // Bem assinado com o NOSSO segredo, e mesmo assim recusado. É o caso de um
    // token legítimo de outro sistema que partilhe o segredo por acidente.
    const agora = Math.floor(Date.now() / 1000);
    const claimsAlheias: ClaimsToken = {
      sub: "ana",
      papel: "employee",
      iat: agora,
      exp: agora + 600,
      aud: "outro-servico",
      jti: "sonda",
    };
    const rAudiencia = await pedir(PEDIDO_INITIALIZE, emitirComClaims(claimsAlheias, SEGREDO));
    registar(
      "audiência errada, mesmo bem assinada -> 401",
      rAudiencia.estado === 401,
      `HTTP ${rAudiencia.estado} (aud correta = ${AUDIENCIA})`,
    );

    // --- 7. Papel sem perfil ------------------------------------------------
    const rPapel = await pedir(
      PEDIDO_INITIALIZE,
      emitirToken(SEGREDO, { sujeito: "ana", papel: "auditor" }),
    );
    registar(
      "papel sem perfil configurado -> 403 (e não 401)",
      rPapel.estado === 403,
      `HTTP ${rPapel.estado} — ${rPapel.corpo.slice(0, 120)}`,
    );

    // --- 8. Rotação do segredo ---------------------------------------------
    const rAnterior = await pedir(
      PEDIDO_INITIALIZE,
      emitirToken(SEGREDO_ANTERIOR, { sujeito: "ana", papel: "employee" }),
    );
    registar(
      "token do segredo ANTERIOR ainda é aceite (rotação sem janela de falha)",
      rAnterior.estado === 200,
      `HTTP ${rAnterior.estado}`,
    );

    // --- 9. Employee vê 4 tools --------------------------------------------
    const tokenEmployee = emitirToken(SEGREDO, { sujeito: "ana", papel: "employee" });
    const sessaoEmployee = await abrirSessao(tokenEmployee);
    const toolsEmployee =
      sessaoEmployee === undefined ? [] : await listarTools(tokenEmployee, sessaoEmployee);
    registar(
      "token de employee -> exatamente as 4 tools de leitura",
      toolsEmployee.length === 4 &&
        !toolsEmployee.includes("delete_row") &&
        !toolsEmployee.includes("insert_row"),
      `${toolsEmployee.length} tools: ${toolsEmployee.join(", ")}`,
    );

    // --- 10. Admin vê 9 ------------------------------------------------------
    const tokenAdmin = emitirToken(SEGREDO, { sujeito: "rui", papel: "admin" });
    const sessaoAdmin = await abrirSessao(tokenAdmin);
    const toolsAdmin =
      sessaoAdmin === undefined ? [] : await listarTools(tokenAdmin, sessaoAdmin);
    registar(
      "token de admin -> as 9 tools",
      toolsAdmin.length === 9 && toolsAdmin.includes("delete_row"),
      `${toolsAdmin.length} tools: ${toolsAdmin.join(", ")}`,
    );

    // --- 11. delete_row não existe para o employee --------------------------
    const rDelete =
      sessaoEmployee === undefined
        ? undefined
        : await pedir(
            {
              jsonrpc: "2.0",
              id: 3,
              method: "tools/call",
              params: { name: "delete_row", arguments: { tabela: "clientes", chave: {} } },
            },
            tokenEmployee,
            sessaoEmployee,
          );
    registar(
      "employee a chamar delete_row -> tool desconhecida",
      rDelete !== undefined && /not found|unknown|desconhecid/i.test(rDelete.corpo),
      rDelete === undefined ? "sem sessão" : rDelete.corpo.slice(0, 150),
    );

    // --- 12. A VERIFICAÇÃO QUE DECIDE A FASE --------------------------------
    //
    // O session-id do employee, com o token do admin. Se isto passasse, o
    // session-id seria uma credencial e toda esta camada seria decoração.
    const rCruzado =
      sessaoEmployee === undefined
        ? undefined
        : await pedir({ jsonrpc: "2.0", id: 4, method: "tools/list" }, tokenAdmin, sessaoEmployee);
    registar(
      "session-id de employee + token de admin -> 403",
      rCruzado !== undefined && rCruzado.estado === 403,
      rCruzado === undefined ? "sem sessão" : `HTTP ${rCruzado.estado} — ${rCruzado.corpo.slice(0, 120)}`,
    );

    // --- 13. O mesmo papel mas outra pessoa ---------------------------------
    //
    // Não basta o papel bater: o sujeito também. Dois employees são duas sessões.
    const tokenOutroEmployee = emitirToken(SEGREDO, { sujeito: "bruno", papel: "employee" });
    const rOutroSujeito =
      sessaoEmployee === undefined
        ? undefined
        : await pedir(
            { jsonrpc: "2.0", id: 5, method: "tools/list" },
            tokenOutroEmployee,
            sessaoEmployee,
          );
    registar(
      "session-id de outro utilizador, mesmo papel -> 403",
      rOutroSujeito !== undefined && rOutroSujeito.estado === 403,
      rOutroSujeito === undefined ? "sem sessão" : `HTTP ${rOutroSujeito.estado}`,
    );

    // --- 14. O GET também autentica ----------------------------------------
    //
    // A sonda da Fase 0 mostrou que o connector da Anthropic nunca abre o GET.
    // Outros clientes MCP abrem — e um método sem autenticação seria uma porta
    // aberta que ninguém estava a olhar.
    const rGet = await pedir(undefined, undefined, sessaoEmployee, "GET");
    registar("GET sem token -> 401", rGet.estado === 401, `HTTP ${rGet.estado}`);

    // --- 15. O DELETE também ------------------------------------------------
    const rDeleteSessao = await pedir(undefined, undefined, sessaoEmployee, "DELETE");
    registar(
      "DELETE sem token -> 401",
      rDeleteSessao.estado === 401,
      `HTTP ${rDeleteSessao.estado}`,
    );

    // --- 16. A leitura corre mesmo, de ponta a ponta ------------------------
    //
    // Depois de tanta recusa, uma que passa: as camadas de leitura continuam a
    // funcionar por este caminho e é o utilizador certo do Postgres a responder.
    const rQuery =
      sessaoAdmin === undefined
        ? undefined
        : await pedir(
            {
              jsonrpc: "2.0",
              id: 6,
              method: "tools/call",
              params: { name: "run_query", arguments: { sql: "SELECT current_user AS quem" } },
            },
            tokenAdmin,
            sessaoAdmin,
          );
    registar(
      "run_query de um admin corre como mcp_readonly (a leitura nunca sai pela escrita)",
      rQuery !== undefined && rQuery.corpo.includes("mcp_readonly"),
      rQuery === undefined ? "sem sessão" : rQuery.corpo.slice(0, 150),
    );
  } finally {
    servidor.kill();
  }

  console.log(`\n=== ${passou} passaram, ${falhou} falharam ===`);
  process.exit(falhou === 0 ? 0 : 1);
}

main().catch((erro) => {
  console.error(erro instanceof Error ? erro.message : String(erro));
  process.exit(1);
});
