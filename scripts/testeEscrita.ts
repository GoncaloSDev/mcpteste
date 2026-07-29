/**
 * Bateria de testes do caminho de ESCRITA, por um cliente MCP real.
 *
 * Irmão do testeCamadas.ts: lança o servidor como processo filho e fala com ele
 * por stdio, exatamente como faria o Claude Desktop. A diferença é que este
 * exige DATABASE_URL_WRITE definida — sem ela as tools de escrita nem sequer são
 * registadas, e o teste sai a dizê-lo em vez de falhar 20 vezes seguidas.
 *
 * O QUE ESTE FICHEIRO PROVA, e que nenhum outro prova:
 *
 *   1. o que é permitido passa               (criar, editar e apagar um cliente)
 *   2. o que é proibido é bloqueado          (tabelas de movimento, SQL, chaves)
 *   3. a base fica COMO ESTAVA no fim        (a verificação final, e a que conta)
 *
 * O ponto 3 é o que torna este teste seguro de correr contra a base de
 * referência: tudo o que ele cria, ele apaga. As respostas do EVAL-QUESTIONS.md
 * continuam a bater certo depois de uma corrida limpa. Se o teste rebentar a
 * meio, pode ficar lá o cliente de teste — o número usado (999999) é propositado
 * para se ver logo qual é.
 *
 * Correr com:  npm run teste:escrita
 */

// Carregado aqui porque o teste PRÓPRIO precisa de saber se a escrita está
// configurada, antes de lançar o servidor. O servidor filho volta a carregá-lo
// por sua conta — herda o ambiente deste processo, mas não depende disso.
import "dotenv/config";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** Nº de cliente de teste. Fora do intervalo do seed, para não colidir. */
const NO_CLI_TESTE = 999999;

interface Resposta {
  texto: string;
  erro: boolean;
}

async function main(): Promise<void> {
  if (!process.env["DATABASE_URL_WRITE"]) {
    console.error(
      "DATABASE_URL_WRITE não está definida — as tools de escrita não são registadas.\n" +
        "Define-a no .env (ver o .env.example) e corre outra vez.",
    );
    process.exit(1);
  }

  const transporte = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    stderr: "pipe",
  });

  const cliente = new Client({ name: "teste-escrita", version: "1.0.0" });
  await cliente.connect(transporte);

  const tools = await cliente.listTools();
  const nomes = tools.tools.map((t) => t.name);
  console.log(`Tools expostas: ${nomes.join(", ")}\n`);

  let passou = 0;
  let falhou = 0;

  const registar = (nome: string, ok: boolean, detalhe: string): void => {
    if (ok) passou += 1;
    else falhou += 1;
    console.log(`[${ok ? "PASSA" : "FALHA"}] ${nome}\n        ${detalhe.slice(0, 240)}\n`);
  };

  const chamar = async (tool: string, args: Record<string, unknown>): Promise<Resposta> => {
    const r = await cliente.callTool({ name: tool, arguments: args });
    const blocos = r.content as Array<{ type: string; text?: string }>;
    return { texto: blocos.map((b) => b.text ?? "").join("\n"), erro: r.isError === true };
  };

  const primeira = (r: Resposta): string => r.texto.split("\n").find((l) => l.trim() !== "") ?? "";

  // --- 0. As três tools estão mesmo registadas -------------------------------
  registar(
    "as 3 tools de escrita estão registadas",
    ["insert_row", "update_row", "delete_row"].every((t) => nomes.includes(t)),
    `tools: ${nomes.join(", ")}`,
  );

  // --- 1. list_tables marca as tabelas escreviveis ---------------------------
  const lista = await chamar("list_tables", {});
  const escreviveis = (lista.texto.match(/"escrivel":\s*true/g) ?? []).length;
  registar(
    "list_tables marca exatamente 12 tabelas como escreviveis",
    !lista.erro && escreviveis === 12 && lista.texto.includes('"modo_escrita": "ligado"'),
    `escrivel=true em ${escreviveis} tabelas (esperado 12)`,
  );

  // --- 2. Limpeza preventiva -------------------------------------------------
  // Se uma corrida anterior rebentou a meio, o cliente de teste pode ter ficado.
  // O erro desta chamada é esperado e ignorado de propósito.
  await chamar("delete_row", {
    tabela: "clientes",
    chave: { no_cli: NO_CLI_TESTE },
    confirmar: true,
  });

  // =========================================================================
  // O QUE É PERMITIDO TEM DE PASSAR
  // =========================================================================
  console.log("--- o que é legítimo passa ---\n");

  const criar = await chamar("insert_row", {
    tabela: "clientes",
    valores: {
      no_cli: NO_CLI_TESTE,
      nome: "CLIENTE DE TESTE — APAGAR",
      tipo: "P",
      localidade: "Águeda",
      email: null,
    },
  });
  registar(
    "insert_row cria uma linha e devolve-a",
    !criar.erro && criar.texto.includes('"linhas_afetadas": 1') && criar.texto.includes("Águeda"),
    primeira(criar),
  );

  const editar = await chamar("update_row", {
    tabela: "clientes",
    chave: { no_cli: NO_CLI_TESTE },
    valores: { email: "teste@exemplo.pt", lim_credito: 1500.5 },
  });
  registar(
    "update_row altera só as colunas indicadas",
    !editar.erro &&
      editar.texto.includes('"linhas_afetadas": 1') &&
      editar.texto.includes("teste@exemplo.pt") &&
      // O nome não foi tocado: prova que o UPDATE é parcial e não substitui a linha.
      editar.texto.includes("CLIENTE DE TESTE"),
    primeira(editar),
  );

  const anular = await chamar("update_row", {
    tabela: "clientes",
    chave: { no_cli: NO_CLI_TESTE },
    valores: { email: null },
  });
  registar(
    "update_row aceita null para pôr uma coluna a NULL",
    !anular.erro && anular.texto.includes('"email": null'),
    primeira(anular),
  );

  // =========================================================================
  // O QUE É PROIBIDO TEM DE SER BLOQUEADO
  // =========================================================================
  console.log("--- o que é perigoso é bloqueado ---\n");

  const movimento = await chamar("insert_row", {
    tabela: "docs_venda",
    valores: { id: 1, cod_doc: "FAT", serie: "A", nr_doc: 1, dt_doc: "2026-01-01", no_cli: 1 },
  });
  registar(
    "insert_row recusa uma tabela de movimento (whitelist)",
    movimento.erro && movimento.texto.includes("não é escrivel"),
    primeira(movimento),
  );

  const stocks = await chamar("update_row", {
    tabela: "stocks",
    chave: { cod_art: "X", cod_arm: "A1" },
    valores: { qtd: 999 },
  });
  registar(
    "update_row recusa stocks (whitelist)",
    stocks.erro && stocks.texto.includes("não é escrivel"),
    primeira(stocks),
  );

  const colunaFalsa = await chamar("update_row", {
    tabela: "clientes",
    chave: { no_cli: NO_CLI_TESTE },
    valores: { coluna_que_nao_existe: 1 },
  });
  registar(
    "update_row recusa uma coluna inexistente antes de chegar ao SQL",
    colunaFalsa.erro && colunaFalsa.texto.includes("não existem em"),
    primeira(colunaFalsa),
  );

  const mudarChave = await chamar("update_row", {
    tabela: "clientes",
    chave: { no_cli: NO_CLI_TESTE },
    valores: { no_cli: 123456 },
  });
  registar(
    "update_row recusa alterar a chave primária",
    mudarChave.erro && mudarChave.texto.includes("chave primária"),
    primeira(mudarChave),
  );

  // A chave é um IDENTIFICADOR, não um filtro. Sem esta recusa, uma chave
  // parcial numa tabela de chave composta abria a porta a um WHERE que apanha
  // muitas linhas — que é a única forma de a guarda de linhas ser desafiada.
  const chaveParcial = await chamar("update_row", {
    tabela: "precos_art",
    chave: { cod_art: "ART001" },
    valores: { preco: 1 },
  });
  registar(
    "update_row recusa uma chave primária incompleta (precos_art tem 3 colunas)",
    chaveParcial.erro && chaveParcial.texto.includes("faltam"),
    primeira(chaveParcial),
  );

  const chaveExtra = await chamar("update_row", {
    tabela: "clientes",
    chave: { no_cli: NO_CLI_TESTE, tipo: "P" },
    valores: { obs: "x" },
  });
  registar(
    "update_row recusa colunas a mais na chave (não é um filtro)",
    chaveExtra.erro && chaveExtra.texto.includes("a mais"),
    primeira(chaveExtra),
  );

  const semConfirmar = await chamar("delete_row", {
    tabela: "clientes",
    chave: { no_cli: NO_CLI_TESTE },
    confirmar: false,
  });
  registar(
    "delete_row exige confirmar=true",
    semConfirmar.erro && semConfirmar.texto.includes("confirmar=true"),
    primeira(semConfirmar),
  );

  const inexistente = await chamar("update_row", {
    tabela: "clientes",
    chave: { no_cli: -12345 },
    valores: { obs: "x" },
  });
  registar(
    "update_row a uma linha inexistente dá erro (0 linhas não é sucesso)",
    inexistente.erro && inexistente.texto.includes("Nenhuma linha corresponde"),
    primeira(inexistente),
  );

  // Injeção pelo nome da tabela: tem de morrer na whitelist, e não num SQL
  // concatenado. A mensagem prova qual das duas coisas aconteceu.
  const injecao = await chamar("insert_row", {
    tabela: 'clientes" ; DROP TABLE artigos; --',
    valores: { no_cli: 1 },
  });
  registar(
    "insert_row resiste a injeção pelo nome da tabela",
    injecao.erro && injecao.texto.includes("não é escrivel"),
    primeira(injecao),
  );

  // A chave estrangeira é a defesa que permitiu abrir os dados mestre à escrita:
  // um cliente com documentos não pode ser apagado, e não é preciso programar
  // nada para isso — o schema já o declara.
  //
  // O cliente é DESCOBERTO e não escrito à mão. A primeira versão deste teste
  // usava no_cli=1 e falhava, porque o seed numera os clientes a partir de 1001;
  // o erro que dava era "nenhuma linha corresponde", ou seja o teste passava a
  // testar outra coisa sem ninguém reparar. Perguntar à base custa uma query e
  // sobrevive a uma mudança nos parâmetros do seed.
  const comHistorico = await chamar("run_query", {
    sql: "SELECT no_cli FROM docs_venda ORDER BY no_cli LIMIT 1",
  });
  const noCliComDocs = /"no_cli":\s*(\d+)/.exec(comHistorico.texto)?.[1];

  if (noCliComDocs === undefined) {
    registar(
      "delete_row é travado por chave estrangeira num cliente com histórico",
      false,
      "não foi possível encontrar um cliente com documentos — a base está povoada?",
    );
  } else {
    const fkPresa = await chamar("delete_row", {
      tabela: "clientes",
      chave: { no_cli: Number(noCliComDocs) },
      confirmar: true,
    });
    registar(
      "delete_row é travado por chave estrangeira num cliente com histórico",
      fkPresa.erro && fkPresa.texto.includes("chave estrangeira"),
      `cliente ${noCliComDocs} — ${primeira(fkPresa)}`,
    );
  }

  const duplicado = await chamar("insert_row", {
    tabela: "clientes",
    valores: { no_cli: NO_CLI_TESTE, nome: "OUTRO" },
  });
  registar(
    "insert_row recusa uma chave primária repetida",
    duplicado.erro && duplicado.texto.includes("Já existe"),
    primeira(duplicado),
  );

  // O run_query continua a ser só-de-leitura: o caminho de escrita não lhe abriu
  // porta nenhuma. É a verificação de que as duas ligações não se cruzam.
  const sqlEscrita = await chamar("run_query", {
    sql: `UPDATE clientes SET nome = 'x' WHERE no_cli = ${NO_CLI_TESTE}`,
  });
  registar(
    "run_query continua a recusar UPDATE (as duas ligações não se cruzam)",
    sqlEscrita.erro && sqlEscrita.texto.includes("UPDATE"),
    primeira(sqlEscrita),
  );

  // =========================================================================
  // LIMPEZA — e a verificação que conta
  // =========================================================================
  console.log("--- limpeza ---\n");

  const apagar = await chamar("delete_row", {
    tabela: "clientes",
    chave: { no_cli: NO_CLI_TESTE },
    confirmar: true,
  });
  registar(
    "delete_row apaga a linha de teste e devolve-a",
    !apagar.erro &&
      apagar.texto.includes('"linhas_afetadas": 1') &&
      apagar.texto.includes("CLIENTE DE TESTE"),
    primeira(apagar),
  );

  const sobrou = await chamar("run_query", {
    sql: `SELECT count(*) AS n FROM clientes WHERE no_cli = ${NO_CLI_TESTE}`,
  });
  registar(
    "a base ficou como estava (o cliente de teste já não existe)",
    !sobrou.erro && /"n":\s*"?0"?/.test(sobrou.texto),
    primeira(sobrou),
  );

  await cliente.close();

  console.log(`\n=== ${passou} passaram, ${falhou} falharam ===`);
  if (falhou > 0) {
    console.log(
      `\nAVISO: com falhas, o cliente de teste ${NO_CLI_TESTE} pode ter ficado na base.\n` +
        `Verifica com: SELECT * FROM clientes WHERE no_cli = ${NO_CLI_TESTE};`,
    );
  }
  process.exit(falhou === 0 ? 0 : 1);
}

main().catch((erro: unknown) => {
  console.error("Erro ao correr os testes:", erro);
  process.exit(1);
});
