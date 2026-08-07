/**
 * Emite um token para falar com o endpoint HTTP à mão.
 *
 * Substitui o ritual que o CLAUDE.md pedia antes de cada sessão remota —
 * "confirma que `tools/list` devolve 4 e nunca 9" — por algo que se pode mesmo
 * correr: emitir um token de cada papel e ver o que cada um recebe.
 *
 * Correr com:
 *   npx tsx scripts/emitirToken.ts                      # employee, 15 min
 *   npx tsx scripts/emitirToken.ts admin
 *   npx tsx scripts/emitirToken.ts admin --sujeito ana --validade 60
 *   npx tsx scripts/emitirToken.ts employee --curl https://mcp.exemplo.pt
 *
 * SEMPRE POR `npx tsx`, e não por `npm run token`, quando houver opções. O npm
 * fica com os argumentos que começam por `--` para si — um `npm run token --
 * admin --curl https://...` chega aqui como `admin https://...`, sem o `--curl`,
 * e o script emite o token e salta caladamente a parte que se lhe pediu. Custou
 * um passo de uma sessão de deployment a descobrir. Sem opções (`npm run token
 * admin`) não há problema nenhum.
 *
 * O token sai no stdout e mais nada, para poder ir direto para uma variável de
 * shell. Tudo o resto vai para o stderr — incluindo os erros, o que quer dizer
 * que um `2>$null` a apanhar o token esconde a razão de ele não ter saído.
 */

import "dotenv/config";

import { emitirToken, lerSegredosDoAmbiente, VALIDADE_OMISSA_S } from "../src/http/token.js";
import { nomesDosPerfis, PERFIL_OMISSO, PERFIS } from "../src/acesso/perfis.js";

function argumento(nome: string): string | undefined {
  const indice = process.argv.indexOf(`--${nome}`);
  if (indice === -1) {
    return undefined;
  }
  return process.argv[indice + 1];
}

const papel = process.argv[2]?.startsWith("--") ? PERFIL_OMISSO : (process.argv[2] ?? PERFIL_OMISSO);

// Avisa, mas NÃO recusa. Emitir um token para um papel que este servidor não
// serve é exatamente como se testa o 403 — e o papel podia existir noutro
// deployment. Quem decide o que existe é o registo, no arranque, não este script.
if (!PERFIS.some((p) => p.nome === papel)) {
  console.error(
    `AVISO: '${papel}' não é um perfil declarado (${nomesDosPerfis().join(", ")}).\n` +
      "       O token é emitido à mesma; o servidor há de responder 403.",
  );
}

const validadeTexto = argumento("validade");
const validadeSegundos =
  validadeTexto === undefined ? VALIDADE_OMISSA_S : Number.parseInt(validadeTexto, 10);
if (!Number.isFinite(validadeSegundos)) {
  console.error(`--validade '${validadeTexto}' não é um número de segundos.`);
  process.exit(1);
}

let segredos: string[];
try {
  segredos = lerSegredosDoAmbiente();
} catch (erro) {
  console.error(erro instanceof Error ? erro.message : String(erro));
  process.exit(1);
}

// Emite-se sempre com o segredo ATUAL. O anterior existe só para verificar, e é
// isso que faz a rotação funcionar num sentido só: o que se emite hoje já é novo.
const segredo = segredos[0] as string;
const sujeito = argumento("sujeito") ?? "sonda-local";
const token = emitirToken(segredo, { sujeito, papel, validadeSegundos });

console.error(
  `papel=${papel}  sujeito=${sujeito}  validade=${validadeSegundos}s` +
    `${validadeSegundos <= 0 ? "  (JÁ EXPIRADO — de propósito)" : ""}`,
);

const base = argumento("curl");
if (base !== undefined) {
  console.error(
    `\ncurl -s -X POST ${base.replace(/\/$/, "")}/mcp \\\n` +
      `  -H "content-type: application/json" \\\n` +
      `  -H "accept: application/json, text/event-stream" \\\n` +
      `  -H "authorization: Bearer ${token}" \\\n` +
      `  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'\n`,
  );
}

console.log(token);
