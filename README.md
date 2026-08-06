# testeai-mcp-server

Servidor MCP só-de-leitura sobre a base de dados de referência do distribuidor de
materiais de construção ([testeai-db](../testeai-db)).

Expõe quatro tools a um cliente MCP (Claude Desktop, Claude Code, MCP Inspector)
e garante, por três camadas independentes, que nenhuma delas consegue escrever.

Opcionalmente — e desligado por omissão — expõe mais cinco tools que criam,
editam, arquivam, repõem e apagam **uma linha de cada vez** nas tabelas de dados
mestre. Ver [Escrita](#escrita-opcional-desligada-por-omissão) e
[Arquivo](#arquivo-soft-delete).

## Tools

| Tool | O que faz |
|---|---|
| `list_tables` | Tabelas do schema public, com contagem aproximada de linhas, tamanho em disco e se aceitam escrita |
| `describe_table` | Colunas, tipos, nullable, valores por omissão, chave primária e chaves estrangeiras |
| `sample_rows` | Amostra de linhas de uma tabela (1 a 50, por omissão 10) |
| `run_query` | Corre uma query SELECT, com as três camadas de validação |

O `run_query` e o `sample_rows` aceitam `incluir_arquivados` (por omissão `false`)
— ver [Arquivo](#arquivo-soft-delete).

Só com `DATABASE_URL_WRITE` definida:

| Tool | O que faz |
|---|---|
| `insert_row` | Cria uma linha numa tabela de dados mestre |
| `update_row` | Altera uma linha, identificada pela chave primária completa |
| `archive_row` | **Arquiva** uma linha: deixa de ser vista, mas não é apagada. Reversível |
| `restore_row` | Devolve ao ativo uma linha arquivada |
| `delete_row` | **Destrói** uma linha já arquivada, e tudo o que lhe aponta, em cascata (`confirmar=true`) |

## Arquivo (soft delete)

Todas as 19 tabelas têm uma coluna `arquivado_em` (`timestamptz`, `NULL` = ativo).
Uma linha arquivada **deixa de existir para este servidor**: não aparece no
`run_query`, no `sample_rows`, nas contagens do `list_tables`, nem dentro de
JOINs, subqueries ou CTEs.

O que interessa perceber é **onde é que esse filtro vive**: não vive aqui. Nenhuma
linha deste repositório acrescenta `WHERE arquivado_em IS NULL` a query nenhuma.
Quem esconde as linhas é uma política de **Row-Level Security** do PostgreSQL,
aplicada pelo seed do `testeai-db`.

A razão é o `run_query`, que aceita SQL escrito de fora. Filtrar em TypeScript
obrigaria a reescrever a árvore de cada `SELECT` para lhe acrescentar a condição
em todas as tabelas mencionadas, incluindo as de dentro de subqueries e CTEs. Um
único caso esquecido não dá erro nenhum — devolve linhas arquivadas em silêncio,
que é exatamente o que a funcionalidade existe para impedir. Com o filtro no
planeador do Postgres não há nada a reescrever e não há casos a esquecer.

```
run_query: SELECT count(*) FROM clientes WHERE no_cli = 1001   ->  0 linhas
run_query: ... com incluir_arquivados=true                     ->  1 linha
```

### Arquivar, repor, destruir

```
archive_row  (clientes, {no_cli: 1001})                  reversível, é o caminho normal
restore_row  (clientes, {no_cli: 1001})                  desfaz o anterior, sem perdas
delete_row   (clientes, {no_cli: 1001})                  pré-visualiza; NÃO apaga
delete_row   (clientes, {no_cli: 1001}, confirmar: true) destrói, e leva o resto atrás
```

**Uma linha só pode ser apagada depois de arquivada.** Não há atalho: são duas
chamadas separadas, com um estado reversível pelo meio. É nesse intervalo que um
engano se vê e se desfaz — um único pedido mal formado nunca destrói nada.

`arquivado_em` não se altera por `insert_row` nem por `update_row`. Se se
alterasse, o pré-requisito acima deixava de significar seja o que for, porque
qualquer update genérico o satisfazia.

### O que o `delete_row` faz agora, e porque é que é diferente

Todas as chaves estrangeiras desta base têm `ON DELETE CASCADE`. Apagar um cliente
já **não** é recusado por ter documentos: apaga o cliente, os documentos de venda,
as linhas desses documentos, os movimentos de conta corrente e as comissões. Um
`taxas_iva` arrasta famílias, artigos, preços, stocks e linhas de documento.

Essa cascata é executada pelo Postgres, por gatilhos de integridade referencial
que correm com os privilégios do dono das tabelas — **não passam pela whitelist
deste servidor, nem pelas políticas de RLS, nem pela guarda de linhas da Camada
3**. Nenhuma camada deste projeto vê essas linhas a desaparecer.

Por isso o `delete_row` percorre o grafo de chaves estrangeiras antes de apagar e
conta, tabela a tabela, o que vai levar consigo. Chamado **sem** `confirmar`, não
apaga nada e devolve só essa contagem:

```json
{
  "operacao": "pre_visualizacao",
  "apagado": false,
  "linhas_que_seriam_arrastadas": 654,
  "cascata": [
    { "tabela": "linhas_doc",     "linhas": 512, "via": "linhas_doc.id_doc -> docs_venda.id" },
    { "tabela": "cc_clientes",    "linhas":  74, "via": "cc_clientes.cod_cli -> clientes.no_cli" },
    { "tabela": "docs_venda",     "linhas":  40, "via": "docs_venda.no_cli -> clientes.no_cli" },
    { "tabela": "comissoes_vend", "linhas":  28, "via": "comissoes_vend.id_doc -> docs_venda.id" }
  ]
}
```

### Encontrar o que está arquivado

O `list_tables` traz uma coluna `arquivadas` por tabela, e o `describe_table` traz
`linhas_arquivadas`. Para ver as linhas propriamente ditas:

```
run_query com incluir_arquivados=true:
  SELECT no_cli, nome, arquivado_em FROM clientes WHERE arquivado_em IS NOT NULL
```

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
[testeai-db](../testeai-db), a partir de `seed/src/tabelasEscrita.ts`.

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
- O container do [testeai-db](../testeai-db) a correr e povoado

## Atualizar uma instalação anterior

### Vens de antes do arquivo (soft delete)?

Faz primeiro a parte do `testeai-db` — o arquivo depende de uma coluna nova e
de políticas de RLS que só o seed cria. Sem isso, este servidor arranca e falha à
primeira tool.

```powershell
git pull
npm install
npm run build
```

O `.env` não muda. As tools novas (`archive_row`, `restore_row`) aparecem sozinhas
se já tinhas a `DATABASE_URL_WRITE` definida; sem ela o servidor continua com as 4
de leitura, agora com o parâmetro `incluir_arquivados`.

**O `delete_row` mudou de significado** — deixou de ser o "apagar" do dia-a-dia e
passou a ser destruição definitiva em cascata, só possível depois de
`archive_row`. Ver [Arquivo](#arquivo-soft-delete). Quem tivesse automatismos a
chamá-lo passa a receber um erro explícito, não um apagar silencioso.

```powershell
npm run teste            # 22/22
npm run teste:escrita    # 31/31 — precisa da DATABASE_URL_WRITE
```

### Vens de antes das tools de escrita?

Se já tinhas este servidor a correr **antes de existirem as tools de escrita**, é
este o caminho. Faz primeiro a parte do
[testeai-db](../testeai-db#atualizar-uma-instalação-anterior) — sem o role
criado do lado da base, o passo 2 aqui não tem nada a que se ligar.

```powershell
git pull
npm install
npm run build
```

Se parares aqui, **está tudo a funcionar** e o servidor continua só-de-leitura,
com as 4 tools de sempre. Nada do que se segue é obrigatório.

**1. Ligar a escrita** — acrescenta ao `.env` a linha `DATABASE_URL_WRITE` que
puseste no `.env` do `testeai-db` (é exatamente a mesma):

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
`READONLY_PASSWORD` do `.env` do `testeai-db`, e a porta é a
`POSTGRES_HOST_PORT` desse mesmo ficheiro (**5434** na configuração atual, não a
5432 por omissão do Postgres):

```
DATABASE_URL_READONLY=postgresql://mcp_readonly:<password>@localhost:5434/distribuidor
```

> Nunca coles aqui a `DATABASE_URL_ADMIN`. O caminho de leitura não tem nenhuma
> razão para conseguir escrever — e o de escrita recusa-se a arrancar com uma
> ligação de superutilizador.

Para ligar as tools de escrita, acrescenta também a `DATABASE_URL_WRITE` (é a do
`mcp_escrita`, criada pelo seed do `testeai-db`). Sem ela, o servidor arranca
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
[mcp] 9 tools registadas: list_tables, describe_table, sample_rows, run_query, insert_row, update_row, archive_row, restore_row, delete_row.
[mcp] arquivo: archive_row esconde (reversível); delete_row destrói em cascata e exige que a linha já esteja arquivada.
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
Procura-o sozinho em `../testeai-db/` e `../mcpdbteste/` (relativos a este
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
cd ..\testeai-db
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
cd ..\testeai-db
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
      "args": ["C:\\DEV\\testesmcps\\testeai-mcp-server\\dist\\index.js"],
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
claude mcp add distribuidor --env DATABASE_URL_READONLY="postgresql://mcp_readonly:<password>@localhost:5434/distribuidor" -- node C:\DEV\testesmcps\testeai-mcp-server\dist\index.js
```

Com escrita, um segundo `--env`:

```powershell
claude mcp add distribuidor --env DATABASE_URL_READONLY="postgresql://mcp_readonly:<password>@localhost:5434/distribuidor" --env DATABASE_URL_WRITE="postgresql://mcp_escrita:<password>@localhost:5434/distribuidor" -- node C:\DEV\testesmcps\testeai-mcp-server\dist\index.js
```

Ou, para o servidor ficar disponível só neste projeto, um `.mcp.json` na raiz com
o mesmo conteúdo do bloco `mcpServers` acima.

## Transporte HTTP (Streamable HTTP)

O stdio acima é o modo de desenvolvimento local: um processo por cliente,
lançado pelo próprio cliente. O **Streamable HTTP** é o outro cabo pelo qual o
mesmo servidor pode ser servido — um processo à escuta num porto, vários
clientes ao mesmo tempo — e é o transporte que a secção 5.3 do
`docs/agentsystem-guide.md` exige para as ferramentas dos agentes.

```powershell
npm run build
npm run start:http          # ou: npm run dev:http (sem compilar)
```

```
[mcp] servidor pronto, à escuta em http://127.0.0.1:3000/mcp (Streamable HTTP).
```

Para o apontar o Inspector: `npx @modelcontextprotocol/inspector`, e na UI
escolher o transporte **Streamable HTTP** com o URL `http://127.0.0.1:3000/mcp`
(em vez de deixar o Inspector lançar o processo).

**As tools são exatamente as mesmas**, e não por coincidência: os dois pontos de
entrada — `src/index.ts` e `src/http.ts` — constroem o servidor pela mesma função
`criarServidor()` do `src/servidor.ts`. Uma tool nova aparece nos dois modos sem
ninguém se lembrar disso.

Um endpoint, três métodos, como manda a especificação do transporte:

| Método | Para quê |
|---|---|
| `POST /mcp` | as mensagens JSON-RPC; a resposta vem em SSE na mesma ligação |
| `GET /mcp` | stream SSE avulsa — notificações do servidor e retoma (`Last-Event-ID`) |
| `DELETE /mcp` | encerrar a sessão |

**Sessões com estado.** O `initialize` abre uma sessão e o servidor devolve o
`Mcp-Session-Id` num cabeçalho; todos os pedidos seguintes têm de o trazer. Os
pools de ligação **não** pertencem à sessão — são do processo, abertos uma vez no
arranque — e é isso que torna uma sessão barata: um `McpServer` e as closures das
suas tools, mais nada. O raciocínio completo, incluindo porque não é *stateless*,
está no cabeçalho do `src/http.ts`.

### O que ainda não está aqui

Este modo é, para já, **só o transporte a funcionar localmente**. Por resolver,
por ordem de importância:

- **Sem autenticação e sem TLS.** Quem alcançar o porto chama as tools. Por isso
  o servidor liga-se a `127.0.0.1` por omissão — mudar isso com `MCP_HTTP_HOST`
  expõe a base de dados à rede. O guia trata disto a partir da secção 5.5/5.6;
- **Sem multi-tenant.** Todas as sessões partilham os mesmos dois pools e,
  portanto, a mesma identidade no Postgres (Fase 1 do guia);
- **Sem rate limiting**;
- **Sessões sem expiração.** Um cliente que desapareça sem fazer `DELETE` deixa a
  sessão em memória até o processo reiniciar;
- **Sem `EventStore`.** A retoma por `Last-Event-ID` funciona dentro do processo,
  mas o estado não é partilhado — duas instâncias atrás de um balanceador exigem
  *sticky sessions* ou um armazenamento comum (Redis).

O que **está** feito é a validação do cabeçalho `Origin` (só origens locais, ou
as que a `MCP_HTTP_ORIGENS` listar). Não é autenticação: é a proteção contra *DNS
rebinding* que a especificação do MCP recomenda, e sem ela qualquer página aberta
no browser desta máquina podia correr queries sobre a base de dados. Clientes
nativos, que não enviam `Origin`, passam.

## Estrutura

```
src/
  index.ts                    ponto de entrada STDIO (desenvolvimento local)
  http.ts                     ponto de entrada Streamable HTTP, sobre Hono
  servidor.ts                 arranque, criação do McpServer, encerramento — partilhado
  log.ts                      o log dos dois modos, e porque vai tudo para o stderr
  db.ts                       pool de LEITURA + CAMADA 2 (transação READ ONLY)
  db-escrita.ts               pool de ESCRITA + transação com guarda de linhas
  erros.ts                    sanitização das mensagens que saem para o cliente
  identificadores.ts          uso seguro de nomes de tabela dentro de SQL
  seguranca/
    camada1-parser.ts         uma única instrução SELECT, sem nós de escrita
    camada3-limites.ts        LIMIT automático / recusa acima do máximo
    escrita-camada1-alvo.ts   whitelist de tabelas, colunas e chave primária
    escrita-camada3-linhas.ts a guarda: exatamente uma linha, ou ROLLBACK
    arquivo.ts                o soft delete — e a explicação de porque NÃO filtra
    cascata.ts                conta o que um apagar leva consigo, antes de o levar
  tools/
    listTables.ts  describeTable.ts  sampleRows.ts  runQuery.ts
    insertRow.ts   updateRow.ts      deleteRow.ts
    archiveRow.ts  restoreRow.ts
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
| `MCP_HTTP_PORT` | 3000 | Porto do endpoint MCP (só no modo HTTP) |
| `MCP_HTTP_HOST` | 127.0.0.1 | Interface onde escuta. `0.0.0.0` expõe à rede — ver os avisos acima |
| `MCP_HTTP_ORIGENS` | *(vazia)* | Origens aceites além das locais, separadas por vírgula |

O limite de linhas por escrita **não** é configurável, de propósito: é sempre 1.
Uma variável de ambiente para o subir só serviria para desligar a defesa.

## Notas

**`npm audit` reporta 2 vulnerabilidades moderadas.** Ambas são a mesma coisa:
`@hono/node-server` com um problema de *path traversal* no `serve-static`. Desde
o transporte HTTP que este pacote deixou de ser só uma dependência transitiva do
SDK do MCP e passou a ser usado diretamente — mas o que se usa dele é o `serve`,
não o `serve-static`. Este servidor não serve ficheiros estáticos e nunca importa
o módulo em causa: o único caminho é o `/mcp`, e quem responde nele é o
transporte do SDK. A correção que o npm sugere é descer o SDK uma versão major,
o que traria problemas reais em troca de um risco que aqui não existe.

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
