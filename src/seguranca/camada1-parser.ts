/**
 * CAMADA 1 — a query é exatamente uma instrução SELECT, sem escrita escondida.
 *
 * Usa o parser REAL do PostgreSQL (libpg-query, o parser do servidor compilado
 * para WebAssembly), não um regex nem um prefixo de string. Fica separado das
 * outras camadas de propósito: é uma defesa puramente sintática, que decide sem
 * tocar na base de dados, e tem de continuar a funcionar mesmo que as camadas 2
 * e 3 tenham um bug.
 */

import { parseSync } from "libpg-query";
import { ErroValidacao } from "../erros.js";

/**
 * Porque é que um regex ou um teste de prefixo NÃO chegam — os quatro truques
 * clássicos para os contornar, e é por isso que aqui está um parser a sério:
 *
 *   1. STACKED QUERIES
 *      SELECT 1; DROP TABLE clientes;
 *      Começa por SELECT, portanto passa em qualquer teste de prefixo.
 *
 *   2. COMENTÁRIOS DE BLOCO ANTES DA INSTRUÇÃO
 *      Um comentário de bloco no início empurra a palavra perigosa para longe
 *      do princípio da string, e o teste de prefixo vê o comentário, não o DROP.
 *
 *   3. COMENTÁRIOS COMO ESPAÇO EM BRANCO
 *      O Postgres aceita um comentário de bloco onde caberia um espaço, mesmo
 *      colado a uma palavra-chave. Um regex de palavras completas falha aqui.
 *
 *   4. ESCRITA DENTRO DE UMA CTE
 *      WITH x AS (DELETE FROM clientes RETURNING *) SELECT * FROM x
 *      A instrução de topo É mesmo um SELECT. Nenhuma inspeção do início da
 *      string apanha isto.
 *
 * O parser do Postgres resolve os quatro de uma vez, porque é literalmente a
 * mesma gramática que o servidor usa: se ele diz que são duas instruções, são
 * duas instruções, e comentários já nem sequer existem na árvore.
 */

/**
 * Tipos de nó que representam escrita, DDL ou alteração de estado da sessão.
 * A verificação é feita sobre os NOMES dos nós da árvore, não sobre o texto da
 * query — é o que torna irrelevantes comentários, espaços e maiúsculas.
 */
const NOS_PROIBIDOS = new Set([
  // Escrita de dados
  "InsertStmt",
  "UpdateStmt",
  "DeleteStmt",
  "MergeStmt",
  // DDL
  "CreateStmt",
  "CreateTableAsStmt",
  "CreateSchemaStmt",
  "CreateFunctionStmt",
  "CreateRoleStmt",
  "CreateExtensionStmt",
  "DropStmt",
  "DropRoleStmt",
  "TruncateStmt",
  "AlterTableStmt",
  "AlterRoleStmt",
  "RenameStmt",
  "IndexStmt",
  "ViewStmt",
  "RuleStmt",
  "CreateTrigStmt",
  // Permissões
  "GrantStmt",
  "GrantRoleStmt",
  // Execução arbitrária e efeitos laterais
  "CopyStmt",
  "CallStmt",
  "DoStmt",
  "ExecuteStmt",
  "PrepareStmt",
  "VacuumStmt",
  // EXPLAIN ANALYZE CORRE mesmo a instrução que está lá dentro. Um
  // "EXPLAIN ANALYZE UPDATE ..." escreve na base de dados apesar da palavra
  // EXPLAIN à frente.
  "ExplainStmt",
  // Controlo de transação e de sessão: deixar passar um destes permitiria
  // desfazer a Camada 2 (por exemplo COMMIT seguido de um BEGIN normal, ou um
  // SET para desligar o statement_timeout).
  "TransactionStmt",
  "VariableSetStmt",
  // Cláusulas que não são instruções, mas têm o mesmo efeito:
  //   SELECT 1 INTO nova_tabela           -> CRIA uma tabela!
  //   SELECT * FROM clientes FOR UPDATE   -> bloqueia linhas para escrita
  // Ambas mantêm SelectStmt como nó de topo, por isso a verificação do tipo da
  // instrução (passo 2) não as apanha. Só a varredura recursiva as apanha.
  //
  // ATENÇÃO a esta assimetria, que só se descobre olhando para a árvore a sério
  // (e que quase me passou ao lado): as duas cláusulas aparecem em formatos
  // DIFERENTES na árvore.
  //
  //   "SELECT 1 INTO nova"          ->  intoClause: { rel: {...} }
  //   "SELECT 1 FROM t FOR UPDATE"  ->  lockingClause: [ { LockingClause: {...} } ]
  //
  // O intoClause é um campo simples em camelCase, com o conteúdo logo lá dentro.
  // O lockingClause é uma lista de nós envolvidos, e por isso a chave
  // "LockingClause" aparece mesmo na árvore. Se aqui só estivesse "IntoClause"
  // em PascalCase, o SELECT ... INTO passava — nunca existe uma chave com esse
  // nome. Por segurança ficam as duas grafias das duas cláusulas: se uma versão
  // futura do Postgres mudar o formato, continuamos cobertos.
  "intoClause",
  "IntoClause",
  "lockingClause",
  "LockingClause",
]);

/**
 * Forma mínima da árvore que este ficheiro precisa de conhecer.
 *
 * O @pgsql/types traz os tipos completos da AST do Postgres, mas são centenas de
 * uniões — e não trazem nada de útil aqui, porque a varredura recursiva é
 * deliberadamente cega aos tipos concretos (ver procurarNoProibido). Declarar só
 * o que se usa deixa claro que este código depende de muito pouco da estrutura.
 */
interface ArvoreBruta {
  stmts?: InstrucaoBruta[];
}

interface InstrucaoBruta {
  stmt?: unknown;
}

/** O que a Camada 1 devolve quando aceita a query. */
export interface ResultadoValidacao {
  /**
   * O LIMIT de topo da query, se existir e for um número literal.
   * `null` significa "sem LIMIT utilizável" — a Camada 3 trata desse caso.
   */
  limiteExplicito: number | null;
}

/**
 * Valida que `sql` é exatamente uma instrução SELECT sem qualquer nó de escrita.
 * Lança `ErroValidacao` com uma mensagem explicativa em qualquer outro caso.
 */
export function validarSelectUnico(sql: string): ResultadoValidacao {
  const arvore = parsearOuRecusar(sql);
  const instrucoes = arvore.stmts ?? [];

  // --- 1. Exatamente uma instrução ------------------------------------------
  // Uma query vazia, ou que só tem comentários, produz zero instruções.
  if (instrucoes.length === 0) {
    throw new ErroValidacao("A query está vazia ou só contém comentários.");
  }
  // É aqui que morrem as stacked queries: "SELECT 1; DROP TABLE clientes;"
  // produz duas instruções e nunca chega a ser executado.
  if (instrucoes.length > 1) {
    throw new ErroValidacao(
      `A query contém ${instrucoes.length} instruções separadas por ponto e vírgula. ` +
        "Só é permitida uma instrução SELECT de cada vez.",
    );
  }

  const primeira = instrucoes[0];
  if (primeira === undefined || primeira.stmt === undefined) {
    throw new ErroValidacao("Não foi possível interpretar a instrução.");
  }
  const noDeTopo = primeira.stmt as Record<string, unknown>;

  // --- 2. A instrução de topo tem de ser um SELECT ---------------------------
  // Um "WITH ... SELECT" também produz SelectStmt (o CTE fica em withClause),
  // por isso passa aqui — como é suposto.
  const tiposDeTopo = Object.keys(noDeTopo);
  if (!("SelectStmt" in noDeTopo)) {
    throw new ErroValidacao(
      `Só são permitidas queries SELECT. Esta instrução é do tipo ${descreverTipo(tiposDeTopo)}.`,
    );
  }

  // --- 3. Varredura recursiva à procura de escrita escondida -----------------
  const proibido = procurarNoProibido(noDeTopo);
  if (proibido !== null) {
    throw new ErroValidacao(
      `A query contém uma operação não permitida (${proibido}), possivelmente dentro de ` +
        "uma CTE ou subquery. Só são permitidas leituras.",
    );
  }

  // --- 4. Ler o LIMIT de topo, para a Camada 3 --------------------------------
  const selectDeTopo = noDeTopo["SelectStmt"] as Record<string, unknown>;
  return { limiteExplicito: lerLimiteDeTopo(selectDeTopo) };
}

/**
 * Corre o parser e converte um erro de sintaxe numa recusa legível.
 *
 * SQL que não parseia é REJEITADO, nunca deixado passar. É a escolha
 * conservadora: se não conseguimos perceber o que a query faz, não a corremos.
 */
function parsearOuRecusar(sql: string): ArvoreBruta {
  try {
    return parseSync(sql) as ArvoreBruta;
  } catch (erro) {
    // A mensagem do parser é a mesma que o Postgres daria ("syntax error at or
    // near ..."), e é segura de mostrar: fala só do texto que o utilizador
    // enviou, nunca da configuração do servidor.
    const detalhe = erro instanceof Error ? erro.message : String(erro);
    throw new ErroValidacao(`SQL inválido: ${detalhe}`);
  }
}

/**
 * Percorre a árvore inteira à procura do primeiro nó proibido e devolve o nome
 * dele, ou `null` se estiver tudo limpo.
 *
 * PORQUE É RECURSIVA — o exemplo que justifica todo este código:
 *
 *   WITH apagados AS (DELETE FROM clientes RETURNING *) SELECT * FROM apagados
 *
 * O nó de topo desta query é um SelectStmt perfeitamente legítimo. A verificação
 * do passo 2 deixa-a passar. O DeleteStmt está enterrado em
 * `SelectStmt.withClause.ctes[0].CommonTableExpr.ctequery.DeleteStmt` — só uma
 * varredura que desça a árvore toda o encontra. E como procuramos por NOME de
 * nó, não interessa a que profundidade está nem por que caminho lá chegámos.
 *
 * A árvore é percorrida como JSON genérico em vez de usar os tipos do
 * @pgsql/types porque isto é precisamente o oposto de código com conhecimento da
 * estrutura: queremos olhar para TODOS os nós, incluindo os que não conhecemos.
 * Um tipo de nó novo numa versão futura do Postgres seria visitado na mesma.
 */
function procurarNoProibido(valor: unknown): string | null {
  if (Array.isArray(valor)) {
    for (const elemento of valor) {
      const encontrado = procurarNoProibido(elemento);
      if (encontrado !== null) {
        return encontrado;
      }
    }
    return null;
  }

  if (typeof valor !== "object" || valor === null) {
    return null;
  }

  for (const [chave, filho] of Object.entries(valor)) {
    if (NOS_PROIBIDOS.has(chave)) {
      return chave;
    }
    const encontrado = procurarNoProibido(filho);
    if (encontrado !== null) {
      return encontrado;
    }
  }
  return null;
}

/**
 * Lê o LIMIT de topo da query, quando for um número literal.
 *
 * Devolve `null` sempre que não houver um limite fiável — e a Camada 3
 * interpreta `null` como "aplica o limite automático". Ser conservador aqui
 * significa, no pior caso, limitar a mais; o contrário deixaria passar uma query
 * sem limite nenhum.
 *
 * Os quatro casos em que devolve `null` não são óbvios e vieram todos de
 * experimentação com o parser:
 */
function lerLimiteDeTopo(selectStmt: Record<string, unknown>): number | null {
  const opcao = selectStmt["limitOption"];

  // (a) Sem cláusula LIMIT nenhuma.
  if (opcao === "LIMIT_OPTION_DEFAULT") {
    return null;
  }

  // (b) "FETCH FIRST 10 ROWS WITH TIES" pode devolver MAIS de 10 linhas — todas
  //     as que empatem na última posição. O número não é um teto de verdade.
  if (opcao === "LIMIT_OPTION_WITH_TIES") {
    return null;
  }

  const limitCount = selectStmt["limitCount"];
  if (typeof limitCount !== "object" || limitCount === null) {
    return null;
  }

  const constante = (limitCount as Record<string, unknown>)["A_Const"];
  // (c) "LIMIT (SELECT 3)" — o limite é uma subquery (nó SubLink), não um
  //     literal. Só saberíamos o valor depois de correr a query.
  if (typeof constante !== "object" || constante === null) {
    return null;
  }

  const campos = constante as Record<string, unknown>;
  // (d) "LIMIT ALL" — é sintaticamente um LIMIT (limitOption = COUNT), mas o
  //     valor é NULL e o significado é "sem limite". Confundir isto com um
  //     limite explícito deixaria passar uma query totalmente sem teto.
  if (campos["isnull"] === true) {
    return null;
  }

  const inteiro = campos["ival"];
  if (typeof inteiro !== "object" || inteiro === null) {
    return null;
  }

  // O parser devolve a árvore em JSON de protobuf, e o protobuf OMITE os campos
  // com valor zero. Por isso "LIMIT 0" chega aqui como `ival: {}` e não como
  // `ival: { ival: 0 }`. Sem este `?? 0`, um LIMIT 0 seria lido como "não tem
  // limite" e a query seria embrulhada em LIMIT 200 — a devolver 200 linhas
  // quando o utilizador pediu zero.
  const valor = (inteiro as Record<string, unknown>)["ival"] ?? 0;
  return typeof valor === "number" ? valor : null;
}

/** Transforma ["UpdateStmt"] numa descrição legível para a mensagem de erro. */
function descreverTipo(tipos: string[]): string {
  const primeiro = tipos[0];
  if (primeiro === undefined) {
    return "desconhecido";
  }
  // "UpdateStmt" -> "UPDATE", "CreateTableAsStmt" -> "CREATETABLEAS"
  return primeiro.replace(/Stmt$/, "").toUpperCase();
}
