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
// configurada, antes de lançar o servidor. O servidor filho carrega o .env por
// sua conta, e é bom que carregue: o StdioClientTransport NÃO lhe passa o
// ambiente deste processo — só um punhado de variáveis do sistema (PATH,
// APPDATA, ...), por segurança. Tudo o que o filho precisar de saber deste lado
// tem de ir explicitamente no `env` do transporte, mais abaixo.
import "dotenv/config";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

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
    // O PERFIL É PEDIDO POR NOME, e é isto que este teste passou a exercitar além
    // do que já exercitava: ter a DATABASE_URL_WRITE no .env deixou de bastar
    // para haver tools de escrita. O servidor arranca no perfil de omissão —
    // `employee`, quatro tools — a menos que alguém peça outro, e quem pede é o
    // cliente MCP, no `env` com que lança o processo. Sem esta linha as cinco
    // tools não existem e o teste falha logo na primeira verificação, que é
    // exatamente o que se quer que aconteça a um employee.
    env: { ...getDefaultEnvironment(), MCP_PERFIL: "admin" },
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

  // --- 0. As cinco tools estão mesmo registadas ------------------------------
  registar(
    "as 5 tools de escrita estão registadas",
    ["insert_row", "update_row", "archive_row", "restore_row", "delete_row"].every((t) =>
      nomes.includes(t),
    ),
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
  // Se uma corrida anterior rebentou a meio, o cliente de teste pode ter ficado —
  // e pode ter ficado em qualquer um dos dois estados, ativo ou arquivado. Como
  // apagar exige que esteja arquivado, arquiva-se primeiro (erro ignorado se já
  // estiver) e só depois se apaga. Os erros das duas chamadas são esperados no
  // caso normal, em que não sobrou nada.
  await chamar("archive_row", { tabela: "clientes", chave: { no_cli: NO_CLI_TESTE } });
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
    "delete_row sem confirmar não apaga: devolve pré-visualização",
    !semConfirmar.erro &&
      semConfirmar.texto.includes('"apagado": false') &&
      semConfirmar.texto.includes("NADA FOI APAGADO"),
    primeira(semConfirmar),
  );

  // O pré-requisito que substitui a antiga rede das chaves estrangeiras.
  const naoArquivado = await chamar("delete_row", {
    tabela: "clientes",
    chave: { no_cli: NO_CLI_TESTE },
    confirmar: true,
  });
  registar(
    "delete_row recusa apagar uma linha que não foi arquivada antes",
    naoArquivado.erro && naoArquivado.texto.includes("não está arquivada"),
    primeira(naoArquivado),
  );

  // A coluna do arquivo não é uma coluna como as outras: mexer-lhe por
  // update_row daria a volta ao pré-requisito de cima numa só chamada.
  const arquivoPorUpdate = await chamar("update_row", {
    tabela: "clientes",
    chave: { no_cli: NO_CLI_TESTE },
    valores: { arquivado_em: null },
  });
  registar(
    "update_row recusa escrever na coluna arquivado_em",
    arquivoPorUpdate.erro && arquivoPorUpdate.texto.includes("não se altera por insert_row"),
    primeira(arquivoPorUpdate),
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

  // A CASCATA, medida sem ser disparada.
  //
  // Antes do arquivo, este teste era outro: provava que a chave estrangeira
  // TRAVAVA o apagar de um cliente com documentos. Deixou de ser verdade — todas
  // as chaves estrangeiras desta base passaram a ON DELETE CASCADE, e apagar esse
  // cliente apagaria com ele os documentos, as linhas, os movimentos de conta
  // corrente e as comissões.
  //
  // O que se testa agora é a defesa que substituiu aquela: que a pré-visualização
  // conta o estrago ANTES, e que nada acontece sem confirmação. É por isso que
  // este teste usa um cliente REAL da base — o único sítio onde há uma cascata
  // funda para medir — e o faz pelo caminho que garantidamente não lhe toca.
  //
  // O cliente é DESCOBERTO e não escrito à mão. A primeira versão do teste antigo
  // usava no_cli=1 e falhava, porque o seed numera os clientes a partir de 1001;
  // o erro que dava era "nenhuma linha corresponde", ou seja passava a testar
  // outra coisa sem ninguém reparar.
  const comHistorico = await chamar("run_query", {
    sql: "SELECT no_cli FROM docs_venda ORDER BY no_cli LIMIT 1",
  });
  const noCliComDocs = /"no_cli":\s*(\d+)/.exec(comHistorico.texto)?.[1];

  if (noCliComDocs === undefined) {
    registar(
      "delete_row pré-visualiza a cascata de um cliente com histórico",
      false,
      "não foi possível encontrar um cliente com documentos — a base está povoada?",
    );
  } else {
    // confirmar em falta, de propósito: é o caminho que só lê.
    const previsao = await chamar("delete_row", {
      tabela: "clientes",
      chave: { no_cli: Number(noCliComDocs) },
    });
    const arrastadas = Number(
      /"linhas_que_seriam_arrastadas":\s*(\d+)/.exec(previsao.texto)?.[1] ?? "0",
    );
    registar(
      "delete_row pré-visualiza a cascata de um cliente com histórico",
      !previsao.erro &&
        previsao.texto.includes('"apagado": false') &&
        // Um cliente do seed tem documentos, linhas e movimentos de c/c: a
        // cascata tem de contar bastante mais do que zero.
        arrastadas > 0 &&
        previsao.texto.includes("docs_venda"),
      `cliente ${noCliComDocs} — ${arrastadas} linhas seriam arrastadas`,
    );

    // E continua lá, intacto: a pré-visualização não é um apagar disfarçado.
    const intacto = await chamar("run_query", {
      sql: `SELECT count(*) AS n FROM clientes WHERE no_cli = ${noCliComDocs}`,
    });
    registar(
      "a pré-visualização não tocou no cliente real",
      !intacto.erro && /"n":\s*"?1"?/.test(intacto.texto),
      primeira(intacto),
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
  // O ARQUIVO — esconder, procurar, repor
  // =========================================================================
  console.log("--- arquivo ---\n");

  const arquivar = await chamar("archive_row", {
    tabela: "clientes",
    chave: { no_cli: NO_CLI_TESTE },
  });
  registar(
    "archive_row arquiva a linha e diz que é reversível",
    !arquivar.erro &&
      arquivar.texto.includes('"linhas_afetadas": 1') &&
      arquivar.texto.includes('"reversivel": true'),
    primeira(arquivar),
  );

  // O teste que interessa de todos: a linha continua na base, mas o run_query
  // deixou de a ver. Quem a esconde é a política de RLS do Postgres — nenhuma
  // linha deste projeto filtra coisa nenhuma.
  const invisivel = await chamar("run_query", {
    sql: `SELECT count(*) AS n FROM clientes WHERE no_cli = ${NO_CLI_TESTE}`,
  });
  registar(
    "a linha arquivada desapareceu do run_query",
    !invisivel.erro && /"n":\s*"?0"?/.test(invisivel.texto),
    primeira(invisivel),
  );

  // E não é só na pesquisa direta: dentro de uma subquery também não aparece.
  // É esta a propriedade que um filtro escrito nas tools não conseguiria garantir
  // sem reescrever a árvore de cada select.
  const invisivelSubquery = await chamar("run_query", {
    sql:
      "SELECT count(*) AS n FROM clientes WHERE no_cli IN " +
      `(SELECT no_cli FROM clientes WHERE no_cli = ${NO_CLI_TESTE})`,
  });
  registar(
    "nem dentro de uma subquery a linha arquivada aparece",
    !invisivelSubquery.erro && /"n":\s*"?0"?/.test(invisivelSubquery.texto),
    primeira(invisivelSubquery),
  );

  const comVeuLevantado = await chamar("run_query", {
    sql: `SELECT no_cli, arquivado_em FROM clientes WHERE no_cli = ${NO_CLI_TESTE}`,
    incluir_arquivados: true,
  });
  registar(
    "com incluir_arquivados=true a linha volta a aparecer",
    !comVeuLevantado.erro &&
      comVeuLevantado.texto.includes('"linhas": 1') &&
      comVeuLevantado.texto.includes("INCLUÍDOS"),
    primeira(comVeuLevantado),
  );

  // O véu levantado numa chamada não pode ficar colado à ligação do pool: é o
  // SET LOCAL que garante que morre no COMMIT. Sem isto, a leitura seguinte que
  // calhasse na mesma ligação via arquivados sem os ter pedido.
  const veuVoltouADescer = await chamar("run_query", {
    sql: `SELECT count(*) AS n FROM clientes WHERE no_cli = ${NO_CLI_TESTE}`,
  });
  registar(
    "o véu não fica colado à ligação do pool (SET LOCAL)",
    !veuVoltouADescer.erro && /"n":\s*"?0"?/.test(veuVoltouADescer.texto),
    primeira(veuVoltouADescer),
  );

  const arquivarOutraVez = await chamar("archive_row", {
    tabela: "clientes",
    chave: { no_cli: NO_CLI_TESTE },
  });
  registar(
    "archive_row recusa arquivar o que já está arquivado",
    arquivarOutraVez.erro && arquivarOutraVez.texto.includes("já estava arquivada"),
    primeira(arquivarOutraVez),
  );

  const repor = await chamar("restore_row", {
    tabela: "clientes",
    chave: { no_cli: NO_CLI_TESTE },
  });
  registar(
    "restore_row repõe a linha com os dados intactos",
    !repor.erro &&
      repor.texto.includes('"linhas_afetadas": 1') &&
      repor.texto.includes("CLIENTE DE TESTE"),
    primeira(repor),
  );

  const voltouAoAtivo = await chamar("run_query", {
    sql: `SELECT count(*) AS n FROM clientes WHERE no_cli = ${NO_CLI_TESTE}`,
  });
  registar(
    "a linha reposta volta a ser visível",
    !voltouAoAtivo.erro && /"n":\s*"?1"?/.test(voltouAoAtivo.texto),
    primeira(voltouAoAtivo),
  );

  const reporOutraVez = await chamar("restore_row", {
    tabela: "clientes",
    chave: { no_cli: NO_CLI_TESTE },
  });
  registar(
    "restore_row recusa repor o que não está arquivado",
    reporOutraVez.erro && reporOutraVez.texto.includes("não está arquivada"),
    primeira(reporOutraVez),
  );

  // =========================================================================
  // LIMPEZA — e a verificação que conta
  // =========================================================================
  console.log("--- limpeza ---\n");

  // Dois passos, agora obrigatoriamente: arquivar e só depois apagar.
  await chamar("archive_row", { tabela: "clientes", chave: { no_cli: NO_CLI_TESTE } });

  const apagar = await chamar("delete_row", {
    tabela: "clientes",
    chave: { no_cli: NO_CLI_TESTE },
    confirmar: true,
  });
  registar(
    "delete_row apaga a linha arquivada e devolve-a",
    !apagar.erro &&
      apagar.texto.includes('"linhas_afetadas": 1') &&
      apagar.texto.includes('"apagado": true') &&
      apagar.texto.includes("CLIENTE DE TESTE"),
    primeira(apagar),
  );

  // Com o véu LEVANTADO, e a diferença é toda: sem ele, esta contagem daria zero
  // tanto se a linha tivesse sido apagada como se tivesse ficado apenas
  // arquivada. Seria uma verificação que passava nos dois casos, e um teste que
  // não distingue sucesso de falha não está a verificar nada.
  const sobrou = await chamar("run_query", {
    sql: `SELECT count(*) AS n FROM clientes WHERE no_cli = ${NO_CLI_TESTE}`,
    incluir_arquivados: true,
  });
  registar(
    "a base ficou como estava (nem ativo nem arquivado)",
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
