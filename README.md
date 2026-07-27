# agentsystem-mcp-server

Servidor MCP só-de-leitura sobre a base de dados de referência do distribuidor de
materiais de construção ([agentsystem-db](../agentsystem-db)).

Expõe quatro tools a um cliente MCP (Claude Desktop, Claude Code, MCP Inspector)
e garante, por três camadas independentes, que nenhuma delas consegue escrever.

## Tools

| Tool | O que faz |
|---|---|
| `list_tables` | Tabelas do schema public, com contagem aproximada de linhas e tamanho em disco |
| `describe_table` | Colunas, tipos, nullable, valores por omissão, chave primária e chaves estrangeiras |
| `sample_rows` | Amostra de linhas de uma tabela (1 a 50, por omissão 10) |
| `run_query` | Corre uma query SELECT, com as três camadas de validação |

## As três camadas

A ideia não é ter *mais* verificações — é ter verificações que **não partilham o
mesmo ponto de falha**. Para uma escrita passar, teriam de falhar ao mesmo tempo
coisas que não têm nada a ver umas com as outras.

**Camada 0 — o utilizador da base de dados.** A ligação usa o `mcp_readonly`,
que tem `SELECT` e mais nada. Vive na `DATABASE_URL_READONLY`.

**Camada 1 — o parser** ([src/seguranca/camada1-parser.ts](src/seguranca/camada1-parser.ts)).
Confirma que a query é exatamente uma instrução `SELECT` e que não há nenhum nó
de escrita em toda a árvore, incluindo dentro de CTEs e subqueries. Usa o
**parser real do PostgreSQL** (`libpg-query`, o parser do servidor compilado
para WebAssembly), não um regex — porque comentários, ponto e vírgula e CTEs
contornam qualquer inspeção de texto.

**Camada 2 — a transação** ([src/db.ts](src/db.ts)). Cada query corre dentro de
`BEGIN TRANSACTION READ ONLY`. É redundante face à Camada 0 de propósito: a
Camada 0 é uma defesa de *configuração* (vive num `.env` que pode ser trocado por
engano), esta é uma defesa *do próprio Postgres*, que recusa escritas mesmo com
uma ligação de superutilizador.

**Camada 3 — os limites** ([src/seguranca/camada3-limites.ts](src/seguranca/camada3-limites.ts)).
Queries sem `LIMIT` recebem `LIMIT 200`; um `LIMIT` explícito acima de 500 é
recusado; cada query tem 5 segundos de `statement_timeout` aplicado do lado do
Postgres.

## Pré-requisitos

- Node.js 22+
- O container do [agentsystem-db](../agentsystem-db) a correr e povoado

## 1. Instalar e configurar

```powershell
npm install
Copy-Item .env.example .env
```

Abre o `.env` e preenche a `DATABASE_URL_READONLY`. A password é a
`READONLY_PASSWORD` do `.env` do `agentsystem-db`, e a porta é a
`POSTGRES_HOST_PORT` desse mesmo ficheiro (**5434** na configuração atual, não a
5432 por omissão do Postgres):

```
DATABASE_URL_READONLY=postgresql://mcp_readonly:<password>@localhost:5434/distribuidor
```

> Nunca coles aqui a `DATABASE_URL_ADMIN`. Este servidor não tem nenhuma razão
> para conseguir escrever.

## 2. Compilar e confirmar

```powershell
npm run build
npm start
```

O arranque tem de mostrar, no **stderr**:

```
[mcp] parser do PostgreSQL carregado.
[mcp] ligado a distribuidor (PostgreSQL 18.4)
[mcp] current_user = mcp_readonly          <-- a confirmação que interessa
[mcp] 4 tools registadas: list_tables, describe_table, sample_rows, run_query.
[mcp] servidor pronto, à escuta em stdio.
```

Aquele `current_user` é a verificação mais barata de que a ligação não está, por
engano, a usar a connection string de admin. Se lá aparecer `admin_dist`, o
`.env` está errado.

O servidor fica à espera de mensagens JSON-RPC no stdin — é suposto parecer que
está pendurado. `Ctrl+C` para sair.

## 3. Testar com o MCP Inspector

O Inspector é a ferramenta oficial de debug do protocolo: lança o servidor,
lista as tools e deixa chamá-las à mão, sem ser preciso um cliente MCP completo.

```powershell
npm run inspector
```

(equivale a `npm run build && npx @modelcontextprotocol/inspector node dist/index.js`)

Abre uma UI no browser e imprime no terminal um URL com token de sessão. Lá
dentro: **Connect** → separador **Tools** → **List Tools** → escolhe uma → enche
os argumentos → **Run Tool**.

Não é preciso passar a variável de ambiente ao Inspector: o servidor lê o `.env`
sozinho. O stderr do servidor aparece no painel inferior do Inspector.

### Queries para experimentar no `run_query`

| # | Query | Resultado esperado |
|---|---|---|
| 1 | `SELECT nome, escalao FROM clientes ORDER BY nome LIMIT 5;` | ✅ 5 linhas |
| 2 | `WITH f AS (SELECT no_cli, sum(total) AS t FROM docs_venda WHERE cod_doc='FAT' GROUP BY 1) SELECT c.nome, round(f.t,2) FROM f JOIN clientes c ON c.no_cli=f.no_cli ORDER BY f.t DESC LIMIT 5;` | ✅ CTE + agregação passam |
| 3 | `UPDATE clientes SET nome='x' WHERE no_cli=1;` | ❌ "Esta instrução é do tipo UPDATE" |
| 4 | `WITH apagados AS (DELETE FROM clientes RETURNING *) SELECT * FROM apagados;` | ❌ "operação não permitida (DeleteStmt)" |
| 5 | `SELECT 1; DROP TABLE clientes;` | ❌ "contém 2 instruções" |
| 6 | `SELECT FROM WHERE clientes;` | ❌ "SQL inválido: syntax error" |
| 7 | `SELECT * FROM artigos;` | ✅ 200 linhas, com `LIMIT 200` automático |
| 8 | `SELECT * FROM artigos LIMIT 5000;` | ❌ "excede o máximo permitido de 500" |
| 9 | `SELECT * INTO nova FROM clientes;` | ❌ "operação não permitida (intoClause)" |

O nº 7 é o que confirma a Camada 3: a resposta traz `limite_aplicado` e
`sql_executado` a mostrar exatamente o que foi corrido.

O nº 9 é o mais instrutivo — `SELECT ... INTO` **cria uma tabela**, e a instrução
de topo continua a ser um `SelectStmt`. Só a varredura recursiva o apanha.

### A mesma bateria, automatizada

```powershell
npm run teste       # 19 verificações através de um cliente MCP real por stdio
npm run cobertura   # passa as 50 queries do EVAL-QUESTIONS.md pela Camada 1
```

O `teste` faz o mesmo que se faria a clicar no Inspector, mas de forma
reproduzível. O `cobertura` é o contrapeso: prova que a Camada 1 **não** rejeita
queries legítimas — uma camada de segurança que bloqueia trabalho válido é tão
inútil como uma que não bloqueia nada.

### Ver a Camada 2 a trabalhar sozinha

As camadas 1 e 3 apanham quase tudo antes de a 2 entrar em jogo, portanto ela
quase nunca dispara — e é preciso prová-la à parte. Como **admin**, de propósito:

```powershell
cd ..\agentsystem-db
docker compose exec db psql -U admin_dist -d distribuidor -c "BEGIN TRANSACTION READ ONLY; UPDATE clientes SET nome='x' WHERE no_cli=1;"
```

Responde `ERROR: cannot execute UPDATE in a read-only transaction`. É a
demonstração de que a Camada 2 trava escrita mesmo com a connection string
errada — que é exatamente para isso que ela existe.

## 4. Registar no Claude Desktop

Abre a configuração:

```powershell
code $env:AppData\Claude\claude_desktop_config.json
```

```json
{
  "mcpServers": {
    "distribuidor": {
      "command": "node",
      "args": ["C:\\DEV\\agentsystem-mcp-server\\dist\\index.js"],
      "env": {
        "DATABASE_URL_READONLY": "postgresql://mcp_readonly:<password>@localhost:5434/distribuidor"
      }
    }
  }
}
```

Reinicia o Claude Desktop a seguir (fechar a janela não chega — tem de sair pelo
ícone da barra de tarefas).

Três pormenores que dão dores de cabeça:

- **O caminho tem de ser absoluto, e as barras duplicadas.** O `\` é o caractere
  de escape do JSON, portanto `C:\DEV\...` seria inválido.
- **A variável de ambiente TEM de ir no bloco `env`.** O Claude Desktop lança o
  processo sem herdar o shell nem o diretório de trabalho, por isso o `.env` do
  projeto não é encontrado. É por isso que a configuração o repete.
- **Tem de estar compilado.** O `args` aponta para `dist/index.js`, não para o
  TypeScript. Se mexeres no código, `npm run build` antes de reiniciar.

Os logs (o nosso stderr) ficam em `%AppData%\Claude\logs\mcp-server-distribuidor.log`.

## 5. Registar no Claude Code

```powershell
claude mcp add distribuidor --env DATABASE_URL_READONLY="postgresql://mcp_readonly:<password>@localhost:5434/distribuidor" -- node C:\DEV\agentsystem-mcp-server\dist\index.js
```

Ou, para o servidor ficar disponível só neste projeto, um `.mcp.json` na raiz com
o mesmo conteúdo do bloco `mcpServers` acima.

## Estrutura

```
src/
  index.ts                    arranque, registo das tools, transporte stdio
  db.ts                       pool do pg + CAMADA 2 (transação READ ONLY)
  erros.ts                    sanitização das mensagens que saem para o cliente
  identificadores.ts          uso seguro de nomes de tabela dentro de SQL
  seguranca/
    camada1-parser.ts         uma única instrução SELECT, sem nós de escrita
    camada3-limites.ts        LIMIT automático / recusa acima do máximo
  tools/
    listTables.ts  describeTable.ts  sampleRows.ts  runQuery.ts
    resposta.ts               formatação JSON das respostas
scripts/
  testeCamadas.ts             bateria de testes por cliente MCP real
  coberturaEvals.ts           deteção de falsos positivos da Camada 1
```

As camadas estão em ficheiros separados de propósito: é a forma de a
independência entre elas ser visível na árvore de ficheiros, e não apenas uma
afirmação neste README.

## Configuração opcional

Todas com valores por omissão sensatos; ver o `.env.example`.

| Variável | Omissão | O que faz |
|---|---|---|
| `MCP_TIMEOUT_MS` | 5000 | `statement_timeout` por query |
| `MCP_LIMITE_AUTOMATICO` | 200 | `LIMIT` acrescentado a queries sem um |
| `MCP_LIMITE_MAXIMO` | 500 | `LIMIT` explícito máximo aceite |

## Notas

**`npm audit` reporta 2 vulnerabilidades moderadas.** Ambas são a mesma coisa:
`@hono/node-server`, uma dependência transitiva do SDK do MCP, com um problema de
*path traversal* no `serve-static`. Esse código só é usado pelo transporte HTTP;
este servidor usa exclusivamente stdio e nunca o carrega. A correção que o npm
sugere é descer o SDK uma versão major, o que traria problemas reais em troca de
um risco que aqui não existe.

**Funções customizadas no schema.** O schema atual só tem tabelas. Se um dia
forem adicionadas funções, é preciso confirmar nessa altura que nenhuma tem
`EXECUTE` concedido a `PUBLIC` por omissão nem é `SECURITY DEFINER` com
privilégios de escrita. Uma função dessas seria chamável a coberto de um
`SELECT`, e a Camada 1 deixá-la-ia passar — para o parser, `SELECT f()` é uma
leitura como outra qualquer.

O que a Camada 2 cobre aqui, verificado na prática e não por suposição: uma
função `SECURITY DEFINER` que faça `UPDATE` **é bloqueada** dentro da transação
READ ONLY (`ERROR: cannot execute UPDATE in a read-only transaction`,
`CONTEXT: SQL function ...`). O `SECURITY DEFINER` muda o *utilizador* com que a
função corre, não o estado da transação — e o modo só-leitura é uma propriedade
da transação, que a função não consegue contornar.

Fica na mesma por rever, porque há duas coisas que a Camada 2 não cobre:
funções assim podem **ler** dados a que o `mcp_readonly` não deveria ter acesso,
e efeitos laterais que não passam pelo motor de transações (`dblink`, que abre
uma ligação nova e independente, `COPY TO PROGRAM`, ou linguagens não confiáveis
como `plpython3u`) escapam ao modo só-leitura por completo.
