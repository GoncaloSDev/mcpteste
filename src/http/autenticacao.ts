/**
 * A CAMADA DE AUTENTICAÇÃO DO TRANSPORTE HTTP.
 *
 * Corre em todos os pedidos de /mcp — POST, GET e DELETE — e faz três coisas, por
 * esta ordem:
 *
 *   1. verifica o token e obtém a identidade          -> 401 se falhar
 *   2. traduz o papel num contexto de acesso          -> 403 se o papel não existir
 *   3. confronta a identidade com a da sessão, se houver sessão  -> 403 se divergir
 *
 * O PASSO 3 É O QUE NÃO SE PODE ESQUECER, e é fácil esquecer. O `Mcp-Session-Id`
 * é criado no `initialize` e reutilizado em todos os pedidos seguintes. Se a
 * autenticação só corresse no `initialize`, o session-id passava a ser ele próprio
 * uma credencial de longa duração — e um token de employee podia continuar uma
 * sessão aberta por um admin, com as nove tools já registadas do outro lado. Todo
 * o resto desta camada seria decoração.
 *
 * A sonda da Fase 0 confirmou que isto é exequível: o connector da Anthropic manda
 * o `Authorization: Bearer` em TODOS os pedidos HTTP da sessão — `initialize`,
 * `notifications/initialized`, `tools/list` e cada `tools/call` —, e não só no
 * primeiro. A sessão é uma otimização; a identidade é do pedido.
 *
 * Efeito lateral bom: é exatamente o modelo da spec MCP 2026-07-28, que aboliu as
 * sessões. Quando a migração para o SDK v2 acontecer, a máquina de sessões
 * desaparece e esta camada fica onde está — é por isso que vive num ficheiro
 * próprio e não dentro do http.ts.
 *
 * O QUE ESTA CAMADA NÃO FAZ, e é deliberado: não decide permissões. Ela traduz um
 * token num `ContextoAcesso` e mais nada. Quem decide o que esse contexto pode
 * fazer são os tipos (as tools de escrita exigem `ContextoEscrita`), o registo de
 * perfis, e a Camada 0 do Postgres por baixo de tudo. Se esta camada tivesse um
 * `if (papel === "admin")`, seria mais um sítio onde os papéis existem.
 */

import type { HttpBindings } from "@hono/node-server";
import type { MiddlewareHandler } from "hono";

import type { ContextoAcesso } from "../acesso/contexto.js";
import { log } from "../log.js";
import {
  CODIGO_NAO_AUTENTICADO,
  CODIGO_NAO_AUTORIZADO,
  erroJsonRpc,
} from "./jsonrpc.js";
import { verificarToken, type Identidade } from "./token.js";

/**
 * O ambiente Hono deste servidor.
 *
 * As duas variáveis são postas por esta camada e lidas pelos handlers. Estão no
 * tipo para que um handler que as leia sem a camada montada não compile.
 */
export interface AmbienteMcp {
  Bindings: HttpBindings;
  Variables: {
    identidade: Identidade;
    contexto: ContextoAcesso;
  };
}

export interface OpcoesAutenticacao {
  /** Os segredos aceites: o atual, e o anterior se estiver a haver rotação. */
  readonly segredos: readonly string[];
  /** O contexto de um papel, ou `undefined` se este servidor não o serve. */
  readonly contextoDoPapel: (papel: string) => ContextoAcesso | undefined;
  /** A identidade que abriu uma sessão, ou `undefined` se a sessão não existe. */
  readonly identidadeDaSessao: (idSessao: string) => Identidade | undefined;
}

export function criarAutenticacao(opcoes: OpcoesAutenticacao): MiddlewareHandler<AmbienteMcp> {
  return async (c, next) => {
    // --- 1. O token -----------------------------------------------------------
    const cabecalho = c.req.header("authorization");
    if (cabecalho === undefined || cabecalho.trim() === "") {
      return recusar(c, 401, CODIGO_NAO_AUTENTICADO, "Pedido sem cabeçalho Authorization.");
    }

    // O esquema compara-se sem distinguir maiúsculas, como manda o RFC 7235; o
    // token a seguir é que é sensível a tudo.
    const separador = cabecalho.indexOf(" ");
    const esquema = separador === -1 ? cabecalho : cabecalho.slice(0, separador);
    if (esquema.toLowerCase() !== "bearer") {
      return recusar(
        c,
        401,
        CODIGO_NAO_AUTENTICADO,
        "O cabeçalho Authorization tem de usar o esquema Bearer.",
      );
    }

    const resultado = verificarToken(cabecalho.slice(separador + 1).trim(), opcoes.segredos);
    if (!resultado.ok) {
      // O motivo vai para o log, não para a resposta. Quem chama fica a saber que
      // não entra; dizer-lhe SE o token expirou ou SE a assinatura falhou é dar
      // pistas a quem está a tentar adivinhar, e não ajuda quem tem um token bom.
      log(`autenticação recusada (${resultado.motivo}).`);
      return recusar(c, 401, CODIGO_NAO_AUTENTICADO, "Token inválido ou expirado.");
    }
    const identidade = resultado.identidade;

    // --- 2. O papel -> um contexto -------------------------------------------
    //
    // 403 e não 401: o token é bom, quem chama é quem diz ser. O que falha é a
    // autorização — este servidor não serve este papel. É o caso de um token de
    // `admin` chegar a um deployment arrancado sem DATABASE_URL_WRITE, que é
    // precisamente o que mantém a escrita opt-in.
    const contexto = opcoes.contextoDoPapel(identidade.papel);
    if (contexto === undefined) {
      log(`papel '${identidade.papel}' recusado: não há perfil configurado (sub=${identidade.sujeito}).`);
      return recusar(
        c,
        403,
        CODIGO_NAO_AUTORIZADO,
        `Este servidor não serve o papel '${identidade.papel}'.`,
      );
    }

    // --- 3. A sessão tem de ser da mesma pessoa ------------------------------
    //
    // Só quando a sessão EXISTE. Um id desconhecido não se confronta com nada —
    // esse caso é do handler, que responde 404 para o cliente saber que tem de
    // fazer initialize outra vez.
    const idSessao = c.req.header("mcp-session-id");
    if (idSessao !== undefined) {
      const daSessao = opcoes.identidadeDaSessao(idSessao);
      if (
        daSessao !== undefined &&
        (daSessao.papel !== identidade.papel || daSessao.sujeito !== identidade.sujeito)
      ) {
        log(
          `sessão ${idSessao} recusada: aberta por ${daSessao.sujeito}/${daSessao.papel}, ` +
            `pedido veio de ${identidade.sujeito}/${identidade.papel}.`,
        );
        return recusar(
          c,
          403,
          CODIGO_NAO_AUTORIZADO,
          "Esta sessão pertence a outra identidade.",
        );
      }
    }

    c.set("identidade", identidade);
    c.set("contexto", contexto);
    await next();
    return;
  };
}

/** Uma recusa, no formato de erro que o resto do transporte já usa. */
function recusar(
  c: Parameters<MiddlewareHandler<AmbienteMcp>>[0],
  estado: 401 | 403,
  codigo: number,
  mensagem: string,
) {
  return c.json(erroJsonRpc(codigo, mensagem), estado);
}
