/**
 * Mede se a Camada 1 rejeita queries legítimas (falsos positivos).
 *
 * Passa todas as queries do EVAL-QUESTIONS.md do repositório da base de dados
 * pela validação, sem correr nenhuma. É o contrapeso do testeCamadas.ts: aquele
 * prova que o que é mau é bloqueado, este prova que o que é bom passa — e uma
 * camada de segurança que bloqueia trabalho legítimo é tão inútil como uma que
 * não bloqueia nada.
 *
 * Correr com:  npm run cobertura
 */

import { readFileSync } from "node:fs";
import { loadModule } from "libpg-query";

import { validarSelectUnico } from "../src/seguranca/camada1-parser.js";
import { aplicarLimite, lerLimitesDoAmbiente } from "../src/seguranca/camada3-limites.js";

/**
 * O EVAL-QUESTIONS.md vive no repositório da base de dados, que é um projeto
 * separado — daí o caminho ter de vir de fora. O valor por omissão é o do
 * computador onde isto foi escrito; noutro sítio, define a variável:
 *
 *   CAMINHO_EVALS=../mcpdbteste/EVAL-QUESTIONS.md npm run cobertura
 */
const CAMINHO_EVALS =
  process.env["CAMINHO_EVALS"] ?? "c:/DEV/agentsystem-db/EVAL-QUESTIONS.md";

/** Extrai o conteúdo de todos os blocos ```sql ... ``` do markdown. */
function extrairQueries(markdown: string): string[] {
  const blocos: string[] = [];
  const padrao = /```sql\r?\n([\s\S]*?)```/g;

  let encontro = padrao.exec(markdown);
  while (encontro !== null) {
    const sql = encontro[1]?.trim();
    if (sql !== undefined && sql.length > 0) {
      blocos.push(sql);
    }
    encontro = padrao.exec(markdown);
  }
  return blocos;
}

async function main(): Promise<void> {
  await loadModule();

  const markdown = readFileSync(CAMINHO_EVALS, "utf8");
  const queries = extrairQueries(markdown);
  const limites = lerLimitesDoAmbiente();

  console.log(`${queries.length} queries encontradas em EVAL-QUESTIONS.md\n`);

  let aceites = 0;
  const rejeitadas: Array<{ indice: number; motivo: string; sql: string }> = [];
  let comLimiteAutomatico = 0;
  let recusadasPelaCamada3 = 0;

  queries.forEach((sql, indice) => {
    try {
      const { limiteExplicito } = validarSelectUnico(sql);
      aceites += 1;

      // A Camada 1 aceitou. Ver agora o que a Camada 3 faria com ela.
      try {
        const limitada = aplicarLimite(sql, limiteExplicito, limites);
        if (limitada.nota.includes("automaticamente")) {
          comLimiteAutomatico += 1;
        }
      } catch {
        recusadasPelaCamada3 += 1;
      }
    } catch (erro) {
      rejeitadas.push({
        indice: indice + 1,
        motivo: erro instanceof Error ? erro.message : String(erro),
        sql,
      });
    }
  });

  console.log(`CAMADA 1  aceites: ${aceites}/${queries.length}`);
  console.log(`CAMADA 3  ganhariam LIMIT automático: ${comLimiteAutomatico}`);
  console.log(`CAMADA 3  seriam recusadas (LIMIT > ${limites.maximo}): ${recusadasPelaCamada3}`);

  if (rejeitadas.length > 0) {
    console.log(`\n!! ${rejeitadas.length} queries legítimas foram REJEITADAS pela Camada 1:`);
    for (const r of rejeitadas) {
      console.log(`\n  #${r.indice}: ${r.motivo}`);
      console.log(`  ${r.sql.split("\n")[0]}`);
    }
    process.exit(1);
  }

  console.log("\nNenhum falso positivo. A Camada 1 não bloqueia queries legítimas.");
}

main().catch((erro: unknown) => {
  console.error("Erro:", erro);
  process.exit(1);
});
