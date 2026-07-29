/**
 * Bateria de testes das três camadas, feita através de um cliente MCP REAL.
 *
 * Lança o servidor como processo filho e fala com ele por stdio, exatamente como
 * faria o Claude Desktop ou o MCP Inspector — mesmo protocolo, mesmo transporte,
 * mesmo caminho de código. É a versão reproduzível do que se faria a clicar no
 * Inspector, para se poder correr outra vez depois de cada alteração.
 *
 * Correr com:  npm run teste
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface Caso {
  numero: number;
  descricao: string;
  sql: string;
  /** true = a query deve correr; false = deve ser recusada. */
  deveAceitar: boolean;
  /** Texto que tem de aparecer na resposta, para provar o motivo certo. */
  esperaConter?: string;
}

const CASOS: Caso[] = [
  {
    numero: 1,
    descricao: "SELECT simples com LIMIT explícito",
    sql: "SELECT nome, escalao FROM clientes ORDER BY nome LIMIT 5;",
    deveAceitar: true,
    esperaConter: "LIMIT 5 explícito",
  },
  {
    numero: 2,
    descricao: "CTE + agregação + JOIN (SQL avançado legítimo)",
    sql: `WITH f AS (SELECT no_cli, sum(total) AS t FROM docs_venda WHERE cod_doc='FAT' GROUP BY 1)
          SELECT c.nome, round(f.t, 2) AS faturado
          FROM f JOIN clientes c ON c.no_cli = f.no_cli
          ORDER BY f.t DESC LIMIT 5;`,
    deveAceitar: true,
  },
  {
    numero: 3,
    descricao: "Sem SELECT — um UPDATE directo",
    sql: "UPDATE clientes SET nome = 'x' WHERE no_cli = 1;",
    deveAceitar: false,
    esperaConter: "UPDATE",
  },
  {
    numero: 4,
    descricao: "Escrita escondida numa CTE (o teste a sério da varredura)",
    sql: "WITH apagados AS (DELETE FROM clientes RETURNING *) SELECT * FROM apagados;",
    deveAceitar: false,
    esperaConter: "DeleteStmt",
  },
  {
    numero: 5,
    descricao: "Stacked query",
    sql: "SELECT 1; DROP TABLE clientes;",
    deveAceitar: false,
    esperaConter: "2 instruções",
  },
  {
    numero: 6,
    descricao: "SQL malformado",
    sql: "SELECT FROM WHERE clientes;",
    deveAceitar: false,
    esperaConter: "SQL inválido",
  },
  {
    numero: 7,
    descricao: "Sem LIMIT — deve ganhar o LIMIT 200 automático",
    sql: "SELECT * FROM artigos;",
    deveAceitar: true,
    esperaConter: "LIMIT 200 acrescentado automaticamente",
  },
  {
    numero: 8,
    descricao: "LIMIT explícito acima do máximo",
    sql: "SELECT * FROM artigos LIMIT 5000;",
    deveAceitar: false,
    esperaConter: "excede o máximo",
  },
  {
    numero: 9,
    descricao: "DDL dentro de CTE (rejeitado por sintaxe, não pela varredura)",
    sql: "WITH x AS (DROP TABLE clientes) SELECT 1;",
    deveAceitar: false,
    esperaConter: "SQL inválido",
  },
  {
    numero: 10,
    descricao: "SELECT ... INTO — cria uma tabela mantendo SelectStmt no topo",
    sql: "SELECT * INTO nova_tabela FROM clientes;",
    deveAceitar: false,
    esperaConter: "intoClause",
  },
  {
    numero: 11,
    descricao: "LIMIT ALL — parece ter limite mas não tem",
    sql: "SELECT * FROM artigos LIMIT ALL;",
    deveAceitar: true,
    esperaConter: "LIMIT 200 acrescentado automaticamente",
  },
  {
    numero: 12,
    descricao: "Comentário final — o embrulho não pode partir os parênteses",
    sql: "SELECT cod_art FROM artigos -- ver tudo",
    deveAceitar: true,
    esperaConter: "LIMIT 200 acrescentado automaticamente",
  },
  // O comando SET está bloqueado pelo VariableSetStmt desde sempre. Estes dois
  // casos são o caminho POR BAIXO dele: a mesma capacidade, disponível como
  // função, dentro de um SELECT sintaticamente impecável. O primeiro revelaria
  // os registos arquivados; o segundo desligava o statement_timeout, que é a
  // Camada 3.
  {
    numero: 13,
    descricao: "set_config a revelar arquivados — um SELECT que muda o estado da sessão",
    sql: "SELECT set_config('mcp.incluir_arquivados', 'on', false)",
    deveAceitar: false,
    esperaConter: "set_config",
  },
  {
    numero: 14,
    descricao: "set_config qualificado — o nome vem em duas partes na árvore",
    sql: "SELECT pg_catalog.set_config('statement_timeout', '0', false)",
    deveAceitar: false,
    esperaConter: "set_config",
  },
  {
    numero: 15,
    descricao: "set_config escondido numa subquery — a varredura é recursiva",
    sql: "SELECT nome FROM clientes WHERE nome = (SELECT set_config('mcp.incluir_arquivados','on',false))",
    deveAceitar: false,
    esperaConter: "set_config",
  },
];

async function main(): Promise<void> {
  const transporte = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    // Sem isto o stderr do servidor sairia misturado com o output dos testes.
    stderr: "pipe",
  });

  const cliente = new Client({ name: "teste-camadas", version: "1.0.0" });
  await cliente.connect(transporte);

  const tools = await cliente.listTools();
  console.log(`Tools expostas: ${tools.tools.map((t) => t.name).join(", ")}\n`);

  let passou = 0;
  let falhou = 0;

  for (const caso of CASOS) {
    const resultado = await cliente.callTool({
      name: "run_query",
      arguments: { sql: caso.sql },
    });

    const conteudo = resultado.content as Array<{ type: string; text?: string }>;
    const texto = conteudo.map((c) => c.text ?? "").join("\n");
    const foiAceite = resultado.isError !== true;

    const comportouSeBem = foiAceite === caso.deveAceitar;
    const temOMotivoCerto =
      caso.esperaConter === undefined || texto.includes(caso.esperaConter);
    const ok = comportouSeBem && temOMotivoCerto;

    if (ok) {
      passou += 1;
    } else {
      falhou += 1;
    }

    const marca = ok ? "PASSA" : "FALHA";
    const veredicto = foiAceite ? "aceite" : "recusada";
    console.log(`[${marca}] ${caso.numero}. ${caso.descricao}`);
    console.log(`        esperado: ${caso.deveAceitar ? "aceite" : "recusada"} | obtido: ${veredicto}`);
    console.log(`        ${primeiraLinhaRelevante(texto, caso)}`);
    if (!ok && caso.esperaConter !== undefined && !temOMotivoCerto) {
      console.log(`        !! esperava encontrar "${caso.esperaConter}" na resposta`);
    }
    console.log("");
  }

  // --- Segunda parte: as outras três tools e o timeout ----------------------
  console.log("--- outras tools ---\n");

  const verificacoes: Array<{ nome: string; ok: boolean; detalhe: string }> = [];

  const registar = (nome: string, ok: boolean, detalhe: string): void => {
    verificacoes.push({ nome, ok, detalhe });
    if (ok) {
      passou += 1;
    } else {
      falhou += 1;
    }
    console.log(`[${ok ? "PASSA" : "FALHA"}] ${nome}\n        ${detalhe}`);
  };

  const chamar = async (
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ texto: string; erro: boolean }> => {
    const r = await cliente.callTool({ name: tool, arguments: args });
    const blocos = r.content as Array<{ type: string; text?: string }>;
    return { texto: blocos.map((b) => b.text ?? "").join("\n"), erro: r.isError === true };
  };

  const tabelas = await chamar("list_tables", {});
  const totalTabelas = /"total_tabelas":\s*(\d+)/.exec(tabelas.texto)?.[1];
  registar(
    "list_tables devolve as tabelas do schema public",
    !tabelas.erro && Number(totalTabelas) === 19,
    `total_tabelas = ${totalTabelas} (esperado 19)`,
  );

  const descricao = await chamar("describe_table", { tabela: "clientes" });
  registar(
    "describe_table devolve colunas e chave primária",
    !descricao.erro &&
      descricao.texto.includes('"chave_primaria"') &&
      descricao.texto.includes("no_cli"),
    `chave_primaria presente: ${descricao.texto.includes('"chave_primaria": [')}`,
  );

  const inexistente = await chamar("describe_table", { tabela: "tabela_que_nao_existe" });
  registar(
    "describe_table recusa uma tabela inexistente",
    inexistente.erro,
    inexistente.texto.split("\n")[0]?.slice(0, 120) ?? "",
  );

  // Tentativa de injeção pelo nome da tabela: tem de ser recusada por o nome não
  // existir no catálogo, nunca por ser concatenado no SQL.
  const injecao = await chamar("sample_rows", {
    tabela: 'clientes" ; DROP TABLE artigos; --',
    linhas: 1,
  });
  registar(
    "sample_rows resiste a injeção pelo nome da tabela",
    injecao.erro,
    injecao.texto.split("\n")[0]?.slice(0, 120) ?? "",
  );

  const amostra = await chamar("sample_rows", { tabela: "artigos", linhas: 3 });
  const devolvidas = /"linhas_devolvidas":\s*(\d+)/.exec(amostra.texto)?.[1];
  registar(
    "sample_rows respeita o número de linhas pedido",
    !amostra.erro && devolvidas === "3",
    `linhas_devolvidas = ${devolvidas} (esperado 3)`,
  );

  const demais = await chamar("sample_rows", { tabela: "artigos", linhas: 99 });
  registar(
    "sample_rows recusa mais de 50 linhas (validação Zod)",
    demais.erro,
    demais.texto.split("\n")[0]?.slice(0, 120) ?? "",
  );

  // O statement_timeout está definido para 5s; um pg_sleep(10) tem de ser
  // cancelado PELO POSTGRES, não por um timeout do lado do Node.
  const inicio = Date.now();
  const lento = await chamar("run_query", { sql: "SELECT pg_sleep(10)" });
  const decorrido = Date.now() - inicio;
  registar(
    "statement_timeout cancela uma query lenta do lado do Postgres",
    lento.erro && lento.texto.includes("tempo limite") && decorrido < 9000,
    `cancelada ao fim de ${decorrido}ms — ${lento.texto.split("\n")[0]?.slice(0, 90)}`,
  );

  console.log("");
  await cliente.close();

  console.log(`\n=== ${passou} passaram, ${falhou} falharam ===`);
  process.exit(falhou === 0 ? 0 : 1);
}

/** Extrai a linha mais informativa da resposta, para o relatório não ficar enorme. */
function primeiraLinhaRelevante(texto: string, caso: Caso): string {
  if (!caso.deveAceitar) {
    return texto.split("\n")[0]?.slice(0, 150) ?? "";
  }
  const linhas = texto.split("\n").filter((l) => /"(linhas|limite_aplicado)"/.test(l));
  return linhas.join(" ").replace(/\s+/g, " ").slice(0, 170);
}

main().catch((erro: unknown) => {
  console.error("Erro ao correr os testes:", erro);
  process.exit(1);
});
