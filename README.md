# agentsystem-mcp-server

Servidor MCP só-de-leitura sobre a base de dados de referência do distribuidor de
materiais de construção ([agentsystem-db](../agentsystem-db)).

Expõe quatro tools a um cliente MCP (Claude Desktop, Claude Code, MCP Inspector)
e garante, por três camadas independentes, que nenhuma delas consegue escrever.

Opcionalmente — e desligado por omissão — expõe mais três tools que criam, editam
e apagam **uma linha de cada vez** nas tabelas de dados mestre. Ver
[Escrita](#escrita-opcional-desligada-por-omissão).

## Tools

| Tool | O que faz |
|---|---|
| `list_tables` | Tabelas do schema public, com contagem aproximada de linhas, tamanho em disco e se aceitam escrita |
| `describe_table` | Colunas, tipos, nullable, valores por omissão, chave primária e chaves estrangeiras |
| `sample_rows` | Amostra de linhas de uma tabela (1 a 50, por omissão 10) |
| `run_query` | Corre uma query SELECT, com as três camadas de validação |

Só com `DATABASE_URL_WRITE` definida:

| Tool | O que faz |
|---|---|
| `insert_row` | Cria uma linha numa tabela de dados mestre |
| `update_row` | Altera uma linha, identificada pela chave primária completa |
| `delete_row` | Apaga uma linha, identificada pela chave primária completa (exige `confirmar=true`) |

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

## Escrita (opcional, desligada por omissão)

Sem `DATABASE_URL_WRITE` no ambiente, este servidor é exatamente o que sempre
foi: quatro tools, nenhuma capaz de escrever. **Nada muda para quem não a
definir.** É a mesma build — a decisão é de configuração, o que permite registar
o mesmo `dist/index.js` duas vezes no cliente MCP, uma entrada só-leitura e outra
com escrita.

### As tools de escrita não aceitam SQL

Recebem um nome de tabela, um objeto `coluna -> valor` e a chave primária. O SQL
é construído pelo servidor: os nomes vêm do catálogo do Postgres depois de
validados, os valores vão todos como parâmetros `$n`. Toda a classe de ataques
que a Camada 1 existe para apanhar não tem por onde entrar.

### Só nos dados mestre — 12 das 19 tabelas

`clientes`, `artigos`, `fornecedores`, `vendedores`, `precos_art`, `artfam`,
`artsubfam`, `armazens`, `taxas_iva`, `cond_pag`, `escaloes_cli`, `doc_tipos`.

As sete de movimento — `docs_venda`, `linhas_doc`, `compras`, `linhas_compra`,
`cc_clientes`, `stocks`, `comissoes_vend` — estão bloqueadas, e a razão é
específica desta base: **não há um único `CHECK` nem um único trigger.** Os
invariantes de negócio (o total do documento bater com a soma das linhas, o saldo
da conta corrente, a cadeia orçamento→encomenda→guia→fatura, as comissões, o
stock) existem só no código que gerou os dados. Um `INSERT` em `linhas_doc` não
atualiza o total do documento; um `INSERT` em `docs_venda` não gera o movimento
de conta corrente nem mexe no stock. A base aceitava tudo isso em silêncio.

Nos dados mestre não há invariantes a atravessar tabelas, e as chaves
estrangeiras tratam do resto: apagar um cliente que ainda tem documentos é
recusado pelo próprio Postgres.

Escrever documentos exigirá tools ao nível do **agregado** — criar a fatura, as
linhas, o movimento de c/c e a comissão na mesma transação, com os totais
calculados — e não `INSERT`s linha a linha.

### As camadas do caminho de escrita

**Camada 0 — o utilizador da base de dados.** O `mcp_escrita`, com
`INSERT/UPDATE/DELETE` concedido **tabela a tabela**, nunca por
`ALTER DEFAULT PRIVILEGES`: uma tabela criada amanhã nasce sem escrita. Sem DDL,
sem `TRUNCATE`, nunca superutilizador. Os `GRANT` são aplicados pelo seed do
[agentsystem-db](../agentsystem-db), a partir de `seed/src/tabelasEscrita.ts`.

O servidor **recusa-se a arrancar** em modo de escrita se a ligação for de
superutilizador. Colar aqui a `DATABASE_URL_ADMIN` não funciona.

**Camada 1 — o alvo** ([src/seguranca/escrita-camada1-alvo.ts](src/seguranca/escrita-camada1-alvo.ts)).
Whitelist de tabelas (a gémea independente da lista do seed), colunas validadas
contra o `pg_attribute`, e a chave primária tem de vir **exata** — nem uma coluna
a menos (senão o `WHERE` deixava de identificar uma linha só) nem uma a mais (a
chave é um identificador, não um filtro). Alterar a própria chave primária num
`update_row` é recusado.

**Camada 2 — a guarda de linhas** ([src/seguranca/escrita-camada3-linhas.ts](src/seguranca/escrita-camada3-linhas.ts)).
No caminho de leitura, a defesa que não depende de configuração nenhuma é o
`BEGIN TRANSACTION READ ONLY`. No caminho de escrita essa defesa não pode existir
— a transação tem de poder escrever — e é isto que ocupa o lugar dela: **depois**
da instrução correr e **antes** do `COMMIT`, o `rowCount` que o Postgres devolveu
é comparado com 1. Se não bater, há `ROLLBACK` e nada chega a disco. É a única
posição em que a verificação funciona.

**Camada 3 — o timeout.** O mesmo `statement_timeout` das leituras, aplicado do
lado do Postgres.

As ligações de leitura e de escrita são **dois pools distintos**, em dois
ficheiros distintos ([src/db.ts](src/db.ts) e [src/db-escrita.ts](src/db-escrita.ts)),
com duas connection strings. A validação de catálogo das tools de escrita corre
pela ligação **só-de-leitura**: a de escrita é usada para a instrução final e
para mais nada.

### Antes de ligar

Escrever na base faz as **50 respostas do `EVAL-QUESTIONS.md` deixarem de bater
certo**. Para as repor, correr outra vez o seed.

```powershell
npm run teste:escrita   # 20 verificações; cria, edita e apaga um cliente de teste
```

## Pré-requisitos

- Node.js 22+
- O container do [agentsystem-db](../agentsystem-db) a correr e povoado

## Atualizar uma instalação anterior

Se já tinhas este servidor a correr **antes de existirem as tools de escrita**, é
este o caminho. Faz primeiro a parte do
[agentsystem-db](../agentsystem-db#atualizar-uma-instalação-anterior) — sem o role
criado do lado da base, o passo 2 aqui não tem nada a que se ligar.

```powershell
git pull
npm install
npm run build
```

Se parares aqui, **está tudo a funcionar** e o servidor continua só-de-leitura,
com as 4 tools de sempre. Nada do que se segue é obrigatório.

**1. Ligar a escrita** — acrescenta ao `.env` a linha `DATABASE_URL_WRITE` que
puseste no `.env` do `agentsystem-db` (é exatamente a mesma):

```
DATABASE_URL_WRITE=postgresql://mcp_escrita:<password>@localhost:5434/distribuidor
```

**2. Verificar:**

```powershell
npm run teste            # 19/19 — a leitura não regrediu
npm run teste:escrita    # 19/19 — precisa da DATABASE_URL_WRITE
```

O `teste:escrita` cria, edita e apaga um cliente `999999` e confirma no fim que a
base ficou como estava.

**3. Cliente MCP.** O `.env` **não** chega ao Claude Desktop nem ao Claude Code:
eles lançam o processo sem shell e sem diretório de trabalho, portanto o `dotenv`
não encontra ficheiro nenhum. A variável tem de ser repetida na configuração do
cliente — ver as secções 4 e 5.

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

> Nunca coles aqui a `DATABASE_URL_ADMIN`. O caminho de leitura não tem nenhuma
> razão para conseguir escrever — e o de escrita recusa-se a arrancar com uma
> ligação de superutilizador.

Para ligar as tools de escrita, acrescenta também a `DATABASE_URL_WRITE` (é a do
`mcp_escrita`, criada pelo seed do `agentsystem-db`). Sem ela, o servidor arranca
só-de-leitura — que é o comportamento por omissão e o recomendado. Ver
[Escrita](#escrita-opcional-desligada-por-omissão).

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
[mcp] modo só-leitura (DATABASE_URL_WRITE não definida).
[mcp] 4 tools registadas: list_tables, describe_table, sample_rows, run_query.
[mcp] servidor pronto, à escuta em stdio.
```

Aquele `current_user` é a verificação mais barata de que a ligação não está, por
engano, a usar a connection string de admin. Se lá aparecer `admin_dist`, o
`.env` está errado.

Com a escrita ligada, as duas linhas do meio passam a ser quatro:

```
[mcp] current_user = mcp_readonly
[mcp] ESCRITA LIGADA — current_user = mcp_escrita
[mcp] o Postgres concede INSERT a este utilizador em 12 tabelas: armazens, artfam, ...
[mcp] 7 tools registadas: list_tables, describe_table, sample_rows, run_query, insert_row, update_row, delete_row.
```

Se aparecerem 19 tabelas em vez de 12, os `GRANT` do seed ficaram largos de mais
— o servidor avisa e recusa-as à mesma, mas vale a pena voltar a correr o seed.

Aqui não é possível enganar-se com o utilizador: **o servidor recusa-se a
arrancar** se a `DATABASE_URL_WRITE` for de superutilizador, e sai com código 1.

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
npm run teste           # 19 verificações através de um cliente MCP real por stdio
npm run cobertura       # passa as 50 queries do EVAL-QUESTIONS.md pela Camada 1
npm run teste:escrita   # 19 verificações do caminho de escrita
```

O `teste:escrita` só corre com a `DATABASE_URL_WRITE` definida — sem ela as tools
de escrita nem sequer são registadas, e o script sai a dizê-lo em vez de falhar
dezanove vezes seguidas. Cria, edita e apaga um cliente `999999` e a última
verificação é que a base ficou **como estava**: pode correr-se contra a base de
referência sem estragar as respostas do `EVAL-QUESTIONS.md`.

O `cobertura` precisa do `EVAL-QUESTIONS.md`, que vive no **outro** repositório.
Procura-o sozinho em `../agentsystem-db/` e `../mcpdbteste/` (relativos a este
repositório). Se o tiveres noutro sítio, aponta-lho:

```powershell
$env:CAMINHO_EVALS="C:\caminho\para\EVAL-QUESTIONS.md"; npm run cobertura
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

### Ver a Camada 0 da escrita a trabalhar sozinha

Sem passar pelo servidor, só com `psql`. É a forma mais rápida de confirmar que o
lado da base ficou bem configurado — útil sobretudo depois de instalar noutra
máquina, porque não precisa de Node nem de build.

```powershell
cd ..\agentsystem-db
$env:PGPASSWORD = "<a ESCRITA_PASSWORD do .env>"

# 1. Não é superutilizador — tem de responder "off"
docker compose exec -T -e PGPASSWORD=$env:PGPASSWORD db psql -U mcp_escrita -d distribuidor -t -A -c "SELECT current_setting('is_superuser');"

# 2. Dados mestre — tem de FUNCIONAR
docker compose exec -T -e PGPASSWORD=$env:PGPASSWORD db psql -U mcp_escrita -d distribuidor -c "INSERT INTO clientes (no_cli, nome) VALUES (999999, 'teste'); DELETE FROM clientes WHERE no_cli = 999999;"

# 3. Tabela de movimento — tem de ser RECUSADO
docker compose exec -T -e PGPASSWORD=$env:PGPASSWORD db psql -U mcp_escrita -d distribuidor -c "DELETE FROM docs_venda WHERE id = 1;"

# 4. DDL — tem de ser RECUSADO
docker compose exec -T -e PGPASSWORD=$env:PGPASSWORD db psql -U mcp_escrita -d distribuidor -c "CREATE TABLE xpto (id int);"

# 5. TRUNCATE — tem de ser RECUSADO
docker compose exec -T -e PGPASSWORD=$env:PGPASSWORD db psql -U mcp_escrita -d distribuidor -c "TRUNCATE clientes;"
```

Respostas esperadas: `off`, depois `INSERT 0 1` / `DELETE 1`, e a seguir três
recusas — `permission denied for table docs_venda`, `permission denied for schema
public` e `permission denied for table clientes`. A última é a distinção que
interessa: o role tem `DELETE` em `clientes` mas **não** tem `TRUNCATE`.

E a garantia do lado do servidor, que se prova em dois segundos — pôr a
`DATABASE_URL_ADMIN` na `DATABASE_URL_WRITE` e arrancar:

```
[mcp] FALHA NO ARRANQUE: A DATABASE_URL_WRITE liga-se como 'admin_dist', que é SUPERUTILIZADOR.
```

O processo sai com código 1. Um superutilizador ignora as permissões por tabela,
que são a camada 0 de toda a funcionalidade de escrita — por isso não é um aviso.

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
      "args": ["C:\\DEV\\testesmcps\\agentsystem-mcp-server\\dist\\index.js"],
      "env": {
        "DATABASE_URL_READONLY": "postgresql://mcp_readonly:<password>@localhost:5434/distribuidor"
      }
    }
  }
}
```

Para ligar as tools de escrita, acrescenta uma segunda entrada ao bloco `env` —
**e a vírgula no fim da primeira**, senão o JSON fica inválido e o Claude Desktop
não arranca o servidor de todo:

```json
      "env": {
        "DATABASE_URL_READONLY": "postgresql://mcp_readonly:<password>@localhost:5434/distribuidor",
        "DATABASE_URL_WRITE": "postgresql://mcp_escrita:<password>@localhost:5434/distribuidor"
      }
```

> Se preferires ter as duas coisas em simultâneo — uma ligação só-de-leitura para
> o dia-a-dia e outra com escrita para quando precisares —, regista **a mesma
> build duas vezes**, com nomes diferentes e blocos `env` diferentes. É o mesmo
> `dist/index.js`; a única diferença é aquela variável.

Reinicia o Claude Desktop a seguir (fechar a janela não chega — tem de sair pelo
ícone da barra de tarefas).

Três pormenores que dão dores de cabeça:

- **O caminho tem de ser absoluto, e as barras duplicadas.** O `\` é o caractere
  de escape do JSON, portanto `C:\DEV\...` seria inválido.
- **As variáveis de ambiente TÊM de ir no bloco `env`.** O Claude Desktop lança o
  processo sem herdar o shell nem o diretório de trabalho, por isso o `.env` do
  projeto não é encontrado. É por isso que a configuração o repete — e é por isso
  que pôr a `DATABASE_URL_WRITE` só no `.env` não liga a escrita aqui.
- **Tem de estar compilado.** O `args` aponta para `dist/index.js`, não para o
  TypeScript. Se mexeres no código, `npm run build` antes de reiniciar.

No log (`mcp-server-distribuidor.log`) confirma-se pelo número de tools: 4 em
modo só-leitura, 7 com a escrita ligada.

Os logs (o nosso stderr) ficam em `%AppData%\Claude\logs\mcp-server-distribuidor.log`.

## 5. Registar no Claude Code

```powershell
claude mcp add distribuidor --env DATABASE_URL_READONLY="postgresql://mcp_readonly:<password>@localhost:5434/distribuidor" -- node C:\DEV\testesmcps\agentsystem-mcp-server\dist\index.js
```

Com escrita, um segundo `--env`:

```powershell
claude mcp add distribuidor --env DATABASE_URL_READONLY="postgresql://mcp_readonly:<password>@localhost:5434/distribuidor" --env DATABASE_URL_WRITE="postgresql://mcp_escrita:<password>@localhost:5434/distribuidor" -- node C:\DEV\testesmcps\agentsystem-mcp-server\dist\index.js
```

Ou, para o servidor ficar disponível só neste projeto, um `.mcp.json` na raiz com
o mesmo conteúdo do bloco `mcpServers` acima.

## Estrutura

```
src/
  index.ts                    arranque, registo das tools, transporte stdio
  db.ts                       pool de LEITURA + CAMADA 2 (transação READ ONLY)
  db-escrita.ts               pool de ESCRITA + transação com guarda de linhas
  erros.ts                    sanitização das mensagens que saem para o cliente
  identificadores.ts          uso seguro de nomes de tabela dentro de SQL
  seguranca/
    camada1-parser.ts         uma única instrução SELECT, sem nós de escrita
    camada3-limites.ts        LIMIT automático / recusa acima do máximo
    escrita-camada1-alvo.ts   whitelist de tabelas, colunas e chave primária
    escrita-camada3-linhas.ts a guarda: exatamente uma linha, ou ROLLBACK
  tools/
    listTables.ts  describeTable.ts  sampleRows.ts  runQuery.ts
    insertRow.ts   updateRow.ts      deleteRow.ts
    escritaComum.ts           schema Zod e fragmentos de SQL partilhados
    resposta.ts               formatação JSON das respostas
scripts/
  testeCamadas.ts             bateria de testes por cliente MCP real
  testeEscrita.ts             o mesmo para o caminho de escrita (limpa atrás de si)
  coberturaEvals.ts           deteção de falsos positivos da Camada 1
```

As camadas estão em ficheiros separados de propósito: é a forma de a
independência entre elas ser visível na árvore de ficheiros, e não apenas uma
afirmação neste README.

## Configuração opcional

Todas com valores por omissão sensatos; ver o `.env.example`.

| Variável | Omissão | O que faz |
|---|---|---|
| `MCP_TIMEOUT_MS` | 5000 | `statement_timeout` por query (leitura e escrita) |
| `MCP_LIMITE_AUTOMATICO` | 200 | `LIMIT` acrescentado a queries sem um |
| `MCP_LIMITE_MAXIMO` | 500 | `LIMIT` explícito máximo aceite |
| `DATABASE_URL_WRITE` | *(vazia)* | Liga as tools de escrita. Vazia = servidor só-de-leitura |

O limite de linhas por escrita **não** é configurável, de propósito: é sempre 1.
Uma variável de ambiente para o subir só serviria para desligar a defesa.

## Notas

**`npm audit` reporta 2 vulnerabilidades moderadas.** Ambas são a mesma coisa:
`@hono/node-server`, uma dependência transitiva do SDK do MCP, com um problema de
*path traversal* no `serve-static`. Esse código só é usado pelo transporte HTTP;
este servidor usa exclusivamente stdio e nunca o carrega. A correção que o npm
sugere é descer o SDK uma versão major, o que traria problemas reais em troca de
um risco que aqui não existe.

**Funções customizadas no schema.** O schema atual só tem tabelas. Uma função
acrescentada mais tarde seria chamável a coberto de um `SELECT`, e a Camada 1
deixá-la-ia passar — para o parser, `SELECT f()` é uma leitura como outra
qualquer.

O que fecha esta porta está do lado da base de dados, não aqui: o `public` tem
`EXECUTE` **revogado de `PUBLIC`**, ao contrário do que o Postgres faz por
omissão, e as únicas funções concedidas ao `mcp_readonly` são as do `unaccent` e
do `pg_trgm`, de que as queries de deteção de duplicados dependem. Uma função
nova nasce, portanto, **não** chamável por este servidor — tem de haver um
`GRANT` explícito, que é uma decisão visível em vez de um efeito colateral. Ver
`reporPermissoes()` no `seed/src/seed.ts` e o `docker/initdb/01-init-readonly.sh`
do repositório da base de dados.

A revogação é `IN SCHEMA public` e não toca no `pg_catalog` — as tools deste
servidor continuam a chamar `count()`, `pg_size_pretty()` e
`has_table_privilege()` normalmente.

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
