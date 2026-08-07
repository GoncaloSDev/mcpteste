/**
 * O TOKEN QUE CARREGA A IDENTIDADE — emissão e verificação.
 *
 * A pergunta que este ficheiro responde é "quem está do outro lado?", e a razão
 * de ela existir é mecânica: o `mcp_servers` do MCP connector aceita `type`,
 * `url`, `name` e `authorization_token`, e mais nada. Não há campo para cabeçalhos
 * arbitrários. Como as credenciais embutidas no URL viram `Authorization: Basic` e
 * o `authorization_token` vira `Authorization: Bearer`, e o cabeçalho é UM SÓ, um
 * endpoint único com papéis obriga a que a identidade viaje no token — e obriga a
 * tirar o basic auth do Traefik deste domínio. Não é preferência de estilo.
 *
 * PORQUE NÃO É UM JWT, pela terceira vez neste projeto e pela mesma razão de
 * sempre: o formato assinado que aqui interessa cabe em cinquenta linhas de
 * `node:crypto`, e uma biblioteca de JWT traz um espaço de configuração
 * (algoritmos aceites, `alg: none`, `kid`, JWKS) cujo modo de falha clássico é
 * aceitar um token que não devia. Aqui só existe um algoritmo e ele não vem do
 * token. O `alg` confuso não é um risco que se corra — é um campo que não existe.
 *
 * O QUE ISTO NÃO É: um substituto das sessões do chat. Lá, o argumento contra o
 * JWT foi a revogação — um admin despromovido continuaria a falar com o endpoint
 * que tem o `delete_row`. Aqui esse argumento é respondido pela VALIDADE CURTA
 * (~15 min) e pelo facto de o chat reler o papel da base a cada pedido: o token é
 * emitido no momento, para aquele pedido, e não sobrevive à conversa.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Para quem este token serve. Um token de outro sistema não entra aqui. */
export const AUDIENCIA = "mcp-distribuidor";

/** Validade por omissão. Um token vive menos do que um pedido demora a envelhecer. */
export const VALIDADE_OMISSA_S = 15 * 60;

/**
 * Comprimento mínimo do segredo, em caracteres.
 *
 * O plano põe esta verificação do lado do chat; está também aqui porque as duas
 * pontas partilham o mesmo segredo e um segredo curto é igualmente fatal dos dois
 * lados. É a mesma ideia das listas gémeas do projeto: duas verificações que não
 * partilham ponto de falha.
 */
export const SEGREDO_MINIMO = 32;

/** Quem chamou, já verificado. É isto que o resto do servidor vê. */
export interface Identidade {
  /** Id do utilizador, do lado do chat. Serve para o log e para nada mais. */
  readonly sujeito: string;
  /** O nome do perfil pedido. Ainda não se sabe se existe — isso é do registo. */
  readonly papel: string;
}

/** O conteúdo assinado. Nada aqui é segredo — vai em base64, não em cifra. */
export interface ClaimsToken {
  readonly sub: string;
  readonly papel: string;
  readonly iat: number;
  readonly exp: number;
  readonly aud: string;
  readonly jti: string;
}

export type MotivoRecusa =
  | "ausente"
  | "esquema"
  | "malformado"
  | "assinatura"
  | "audiencia"
  | "expirado";

export type ResultadoToken =
  | { readonly ok: true; readonly identidade: Identidade; readonly claims: ClaimsToken }
  | { readonly ok: false; readonly motivo: MotivoRecusa; readonly mensagem: string };

/** A assinatura de uma carga já codificada. Assina-se o TEXTO que viaja. */
function assinar(cargaCodificada: string, segredo: string): string {
  return createHmac("sha256", segredo).update(cargaCodificada).digest("base64url");
}

/**
 * Emite um token a partir de claims já montadas.
 *
 * Exportada para o `scripts/testeHttp.ts` poder fabricar tokens que o
 * `emitirToken()` nunca produziria — audiência errada, `exp` no passado — e
 * confirmar que são recusados. Sem isto, metade das verificações da fase teria de
 * montar base64 à mão, e passaria a testar a montagem em vez da verificação.
 */
export function emitirComClaims(claims: ClaimsToken, segredo: string): string {
  const carga = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${carga}.${assinar(carga, segredo)}`;
}

export interface DadosToken {
  readonly sujeito: string;
  readonly papel: string;
  /** Segundos de validade. Aceita negativo, para se poder emitir um já expirado. */
  readonly validadeSegundos?: number;
}

export function emitirToken(segredo: string, dados: DadosToken, agoraMs = Date.now()): string {
  const agora = Math.floor(agoraMs / 1000);
  return emitirComClaims(
    {
      sub: dados.sujeito,
      papel: dados.papel,
      iat: agora,
      exp: agora + (dados.validadeSegundos ?? VALIDADE_OMISSA_S),
      aud: AUDIENCIA,
      // Identifica esta emissão nos logs. Não há lista de revogados — a defesa
      // contra reutilização é a validade curta, não um registo que alguém teria
      // de manter e partilhar entre instâncias.
      jti: randomBytes(12).toString("base64url"),
    },
    segredo,
  );
}

/**
 * Verifica um token contra um ou mais segredos.
 *
 * A ORDEM DAS VERIFICAÇÕES NÃO É ARBITRÁRIA. A assinatura é confirmada ANTES de
 * as claims serem lidas para alguma coisa. Se fosse ao contrário, o `exp` e a
 * `aud` de um token não assinado — isto é, de um token inventado por quem chama —
 * estariam a decidir o caminho do código antes de alguém ter provado que aquilo
 * veio de nós.
 *
 * Vários segredos servem a ROTAÇÃO: o novo emite e verifica, o anterior só
 * verifica. Sem isso, mudar o segredo obrigava a mudar os dois recursos do
 * Coolify no mesmo instante, e no intervalo todos os pedidos falhavam.
 */
export function verificarToken(
  token: string,
  segredos: readonly string[],
  agoraMs = Date.now(),
): ResultadoToken {
  const partes = token.split(".");
  if (partes.length !== 2 || partes[0] === "" || partes[1] === "") {
    return { ok: false, motivo: "malformado", mensagem: "O token não tem o formato esperado." };
  }
  const [carga, assinaturaRecebida] = partes as [string, string];

  if (!segredos.some((segredo) => assinaturaBate(carga, assinaturaRecebida, segredo))) {
    return { ok: false, motivo: "assinatura", mensagem: "A assinatura do token não confere." };
  }

  // A partir daqui a carga está PROVADA como nossa. Continua a ser validada na
  // forma — um token nosso mas mal montado é um bug nosso, e um bug nosso não
  // pode virar um `undefined` a passear pelo resto do servidor.
  let claims: ClaimsToken;
  try {
    claims = JSON.parse(Buffer.from(carga, "base64url").toString("utf8")) as ClaimsToken;
  } catch {
    return { ok: false, motivo: "malformado", mensagem: "O conteúdo do token não é JSON válido." };
  }

  if (!claimsBemFormadas(claims)) {
    return { ok: false, motivo: "malformado", mensagem: "O token não traz os campos esperados." };
  }

  if (claims.aud !== AUDIENCIA) {
    return { ok: false, motivo: "audiencia", mensagem: "O token não foi emitido para este servidor." };
  }

  if (Math.floor(agoraMs / 1000) >= claims.exp) {
    return { ok: false, motivo: "expirado", mensagem: "O token expirou." };
  }

  return { ok: true, identidade: { sujeito: claims.sub, papel: claims.papel }, claims };
}

/**
 * Compara assinaturas em tempo constante.
 *
 * O `timingSafeEqual` exige buffers do mesmo comprimento e ATIRA se não forem —
 * daí a comparação de comprimentos primeiro. Não abre nada: o comprimento de uma
 * assinatura SHA-256 é público e sempre o mesmo, portanto uma diferença de
 * comprimento só diz que o token está malformado, coisa que já se via.
 */
function assinaturaBate(carga: string, recebida: string, segredo: string): boolean {
  const esperada = Buffer.from(assinar(carga, segredo), "utf8");
  const dada = Buffer.from(recebida, "utf8");
  if (esperada.length !== dada.length) {
    return false;
  }
  return timingSafeEqual(esperada, dada);
}

function claimsBemFormadas(claims: ClaimsToken): boolean {
  return (
    typeof claims === "object" &&
    claims !== null &&
    typeof claims.sub === "string" &&
    claims.sub !== "" &&
    typeof claims.papel === "string" &&
    claims.papel !== "" &&
    typeof claims.aud === "string" &&
    typeof claims.exp === "number" &&
    Number.isFinite(claims.exp)
  );
}

/**
 * Os segredos do ambiente: o que emite primeiro, o anterior a seguir.
 *
 * FALHA COM EXCEÇÃO se não houver segredo, e é essa a política: um endpoint HTTP
 * sem autenticação, num desenho em que o basic auth do Traefik teve de sair do
 * domínio, não é um servidor degradado — é a base de dados exposta a quem souber
 * o URL. Mesma decisão do superutilizador no db-escrita.ts: mais vale não subir.
 */
export function lerSegredosDoAmbiente(): string[] {
  const atual = process.env["MCP_TOKEN_SEGREDO"]?.trim();
  const anterior = process.env["MCP_TOKEN_SEGREDO_ANTERIOR"]?.trim();

  if (atual === undefined || atual === "") {
    throw new Error(
      "A variável de ambiente MCP_TOKEN_SEGREDO não está definida.\n" +
        "O transporte HTTP recusa-se a arrancar sem ela: é o que autentica quem chama, e\n" +
        "sem ela o endpoint fica aberto a quem souber o URL.\n" +
        "Gera um segredo com:  node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64url'))\"",
    );
  }

  if (atual.length < SEGREDO_MINIMO) {
    throw new Error(
      `A MCP_TOKEN_SEGREDO tem ${atual.length} caracteres e o mínimo são ${SEGREDO_MINIMO}.\n` +
        "Um segredo curto é adivinhável por força bruta fora deste servidor, sem deixar\n" +
        "rasto nenhum nos logs — nenhuma das outras camadas dá por isso.",
    );
  }

  // O anterior é opcional e não leva verificação de comprimento: ele já esteve em
  // uso, e recusá-lo agora seria impedir precisamente a rotação que ele existe
  // para permitir.
  return anterior === undefined || anterior === "" ? [atual] : [atual, anterior];
}
