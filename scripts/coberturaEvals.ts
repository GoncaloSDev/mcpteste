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

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModule } from "libpg-query";

import { validarSelectUnico } from "../src/seguranca/camada1-parser.js";
import { aplicarLimite, lerLimitesDoAmbiente } from "../src/seguranca/camada3-limites.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * O EVAL-QUESTIONS.md vive no repositório da base de dados, que é um projeto
 * separado — por isso o caminho tem de ser descoberto, não pode ser deduzido de
 * dentro deste repositório.
 *
 * A procura é relativa a ESTE ficheiro, e não ao diretório de trabalho: assim o
 * comando funciona igual venha de onde vier o `npm run`. Os dois nomes de pasta
 * cobrem os dois clones habituais — o repositório chama-se `mcpdbteste`, mas é
 * frequente ficar em disco com o nome do projeto.
 */
const CANDIDATOS = [
  "../../agentsystem-db/EVAL-QUESTIONS.md",
  "../../mcpdbteste/EVAL-QUESTIONS.md",
];

/**
 * Devolve o caminho do EVAL-QUESTIONS.md, ou explica como o indicar.
 *
 * Um caminho dado à mão que não existe é ERRO, nunca cai nos candidatos: se
 * alguém definiu a variável, quer aquele ficheiro: e correr o teste contra outro
 * sem avisar seria pior do que falhar.
 */
function encontrarEvals(): string {
  const doAmbiente = process.env["CAMINHO_EVALS"];
  if (doAmbiente !== undefined && doAmbiente.trim() !== "") {
    if (!existsSync(doAmbiente)) {
      throw new Error(`CAMINHO_EVALS aponta para "${doAmbiente}", que não existe.`);
    }
    return doAmbiente;
  }

  for (const candidato of CANDIDATOS) {
    const caminho = resolve(__dirname, candidato);
    if (existsSync(caminho)) {
      return caminho;
    }
  }

  throw new Error(
    "Não encontrei o EVAL-QUESTIONS.md do repositório da base de dados.\n" +
      `Procurei em:\n${CANDIDATOS.map((c) => `  ${resolve(__dirname, c)}`).join("\n")}\n` +
      "Indica-o com a variável de ambiente CAMINHO_EVALS, por exemplo:\n" +
      "  CAMINHO_EVALS=../../agentsystem-db/EVAL-QUESTIONS.md npm run cobertura",
  );
}

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

  const caminhoEvals = encontrarEvals();
  const markdown = readFileSync(caminhoEvals, "utf8");
  const queries = extrairQueries(markdown);
  const limites = lerLimitesDoAmbiente();

  console.log(`Guião: ${caminhoEvals}`);
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
