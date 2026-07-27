# Instalar noutro computador

Guia completo, do nada até ter o servidor MCP a responder a perguntas. Do
princípio ao fim são uns 15 minutos, a maior parte à espera do Docker.

Este servidor **não funciona sozinho** — é a metade que faz perguntas. A outra
metade é a base de dados, que vive noutro repositório:

| Repositório | O que é |
|---|---|
| [GoncaloSDev/mcpdbteste](https://github.com/GoncaloSDev/mcpdbteste) | A base de dados PostgreSQL em Docker, com o seed |
| [GoncaloSDev/mcpteste](https://github.com/GoncaloSDev/mcpteste) | Este servidor MCP |

A ordem importa: primeiro a base de dados, depois o servidor.

---

## 0. Pré-requisitos

| | Para quê | Verificar com |
|---|---|---|
| **Docker Desktop** | Correr o PostgreSQL e o seed | `docker --version` |
| **Node.js 22+** | Compilar e correr o servidor MCP | `node --version` |
| **Git** | Clonar os dois repositórios | `git --version` |
| Um cliente MCP | Claude Code (`claude`) ou Claude Desktop | `claude --version` |

O Docker tem de estar mesmo **a correr**, não só instalado — no Windows e no
macOS isso significa ter o Docker Desktop aberto.

---

## 1. A base de dados

```bash
git clone https://github.com/GoncaloSDev/mcpdbteste.git
cd mcpdbteste
cp .env.example .env
```

### 1.1 Preencher o `.env`

Abre o `.env` e preenche os quatro `<definir>`. São **duas** passwords, mas cada
uma aparece em dois sítios que têm de bater certo:

```ini
POSTGRES_PASSWORD=<password A>
READONLY_PASSWORD=<password B>

DATABASE_URL_ADMIN=postgresql://admin_dist:<password A>@localhost:5432/distribuidor
DATABASE_URL_READONLY=postgresql://mcp_readonly:<password B>@localhost:5432/distribuidor
```

Para gerar passwords:

```powershell
# PowerShell
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 24 | % {[char]$_})
```
```bash
# macOS / Linux
openssl rand -base64 24 | tr -d '/+='
```

> **Se já tiveres um PostgreSQL a ocupar a porta 5432**, muda o
> `POSTGRES_HOST_PORT` para outra (5433, 5434...) **e muda a porta nas duas
> `DATABASE_URL_*` também**. Esta é a fonte de erro nº 1 deste setup — ver a
> secção de problemas no fim.

### 1.2 Subir e povoar

```bash
docker compose up -d db
docker compose ps          # esperar até dizer (healthy)
docker compose run --rm seed
```

No primeiro arranque, e só no primeiro, o container corre automaticamente o
`docker/initdb/01-init-readonly.sh`, que cria o utilizador `mcp_readonly` com
`SELECT` e mais nada. É esse utilizador que o servidor MCP vai usar.

O seed demora poucos segundos e pode ser corrido as vezes que forem precisas —
larga o schema e recria-o do zero.

### 1.3 Confirmar

```bash
docker compose exec db psql -U mcp_readonly -d distribuidor -c "SELECT count(*) FROM docs_venda;"
```

Deve devolver **14 730**. Se devolver isso, ficaram provadas duas coisas ao mesmo
tempo: a base ficou povoada, e o utilizador de leitura consegue lê-la.

> **Windows + Git Bash:** o MSYS reescreve caminhos absolutos e estraga estes
> comandos. Corre-os no **PowerShell** ou prefixa-os com `MSYS_NO_PATHCONV=1`.

---

## 2. O servidor MCP

```bash
git clone https://github.com/GoncaloSDev/mcpteste.git
cd mcpteste
npm install
cp .env.example .env
```

### 2.1 Preencher o `.env`

Só tem uma variável obrigatória, e é uma **cópia exata** da
`DATABASE_URL_READONLY` do `.env` do `mcpdbteste`:

```ini
DATABASE_URL_READONLY=postgresql://mcp_readonly:<password B>@localhost:5432/distribuidor
```

> Nunca ponhas aqui a `DATABASE_URL_ADMIN`. Este servidor não tem nenhuma razão
> para conseguir escrever, e o utilizador de leitura é a primeira das camadas de
> defesa.
>
> Se mudaste a porta no passo 1.1, **muda-a aqui também**.

### 2.2 Compilar e confirmar

```bash
npm run build
npm start
```

O arranque tem de mostrar isto (no stderr):

```
[mcp] parser do PostgreSQL carregado.
[mcp] ligado a distribuidor (PostgreSQL 18.4)
[mcp] current_user = mcp_readonly          <-- a linha que interessa
[mcp] 4 tools registadas: list_tables, describe_table, sample_rows, run_query.
[mcp] servidor pronto, à escuta em stdio.
```

Aquele `current_user = mcp_readonly` é a confirmação de que não estás, por
engano, ligado com a connection string de admin. Se lá aparecer `admin_dist`,
copiaste a URL errada para o `.env`.

Depois disso o processo fica à espera de mensagens no stdin — é **suposto**
parecer pendurado. `Ctrl+C` para sair.

### 2.3 Correr os testes

```bash
npm run teste       # 19 verificações através de um cliente MCP real
npm run cobertura   # 50 queries legítimas contra a Camada 1
```

O primeiro prova que o que é perigoso é bloqueado; o segundo prova que o que é
legítimo passa. Ambos têm de dar 100%.

> O `npm run cobertura` lê o `EVAL-QUESTIONS.md` do repositório da base de dados,
> que está noutra pasta. Indica-lhe onde está:
>
> ```bash
> CAMINHO_EVALS=../mcpdbteste/EVAL-QUESTIONS.md npm run cobertura
> ```
> ```powershell
> $env:CAMINHO_EVALS="..\mcpdbteste\EVAL-QUESTIONS.md"; npm run cobertura
> ```
>
> É um diagnóstico — o servidor funciona na mesma sem este teste.

---

## 3. Registar num cliente MCP

### Claude Code (o mais rápido)

```bash
claude mcp add distribuidor -e DATABASE_URL_READONLY="postgresql://mcp_readonly:<password B>@localhost:5432/distribuidor" -- node /caminho/absoluto/para/mcpteste/dist/index.js
```

O caminho tem de ser **absoluto**. Confirma com:

```bash
claude mcp list      # deve dizer: distribuidor: ... - √ Connected
```

Por omissão fica no âmbito `local` (só neste projeto). Para o teres em todos os
projetos, acrescenta `-s user`. Para remover: `claude mcp remove distribuidor`.

**O servidor só aparece em sessões novas** — reinicia o Claude Code depois de o
adicionares, e confirma com `/mcp`.

### Claude Desktop

Cria ou edita o ficheiro de configuração:

| Sistema | Caminho |
|---|---|
| Windows | `%AppData%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "distribuidor": {
      "command": "node",
      "args": ["C:\\caminho\\absoluto\\mcpteste\\dist\\index.js"],
      "env": {
        "DATABASE_URL_READONLY": "postgresql://mcp_readonly:<password B>@localhost:5432/distribuidor"
      }
    }
  }
}
```

Três armadilhas, todas responsáveis pela maioria dos "não funciona":

1. **Caminho absoluto, e no Windows com `\\` duplicados.** O `\` é o caractere de
   escape do JSON, portanto `C:\caminho` é JSON inválido.
2. **A variável TEM de ir no bloco `env`.** O Claude Desktop lança o processo sem
   herdar o shell nem o diretório de trabalho, por isso o `.env` do projeto nunca
   é encontrado. É por isso que a configuração repete a connection string.
3. **Tem de estar compilado.** O `args` aponta para `dist/index.js`, não para o
   TypeScript. Sempre que mexeres no código: `npm run build`.

Reinicia o Claude Desktop **a sério** — fechar a janela não chega, tem de sair
pelo ícone na barra de tarefas / menu bar.

Os logs ficam em `%AppData%\Claude\logs\mcp-server-distribuidor.log`
(Windows) ou `~/Library/Logs/Claude/` (macOS).

### Sem cliente nenhum (MCP Inspector)

```bash
npm run inspector
```

Abre uma UI no browser com um token de sessão impresso no terminal. É a forma
mais direta de ver as respostas em cru. Não precisa da variável de ambiente — o
servidor lê o `.env` sozinho.

---

## 4. Experimentar

Numa sessão nova do cliente:

```
Que tabelas existem na base de dados?
Mostra-me a estrutura da tabela docs_venda
Quais são os 5 clientes que mais faturaram em 2025?
Qual a taxa de conversão de orçamentos em encomendas?
```

O [EVAL-QUESTIONS.md](https://github.com/GoncaloSDev/mcpdbteste/blob/main/EVAL-QUESTIONS.md)
do repositório da base de dados tem 50 perguntas com as respostas certas, para
comparares.

---

## 5. Quando não funciona

### `FALHA NO ARRANQUE: A variável de ambiente DATABASE_URL_READONLY não está definida`

Não há `.env`, ou a variável está lá com outro nome. Confirma que copiaste o
`.env.example` para `.env` (e não o contrário).

Se acontecer só quando é lançado pelo Claude Desktop mas funciona com
`npm start`, é a armadilha nº 2 acima: falta a variável no bloco `env` da
configuração.

### `Não foi possível ligar à base de dados` / `ECONNREFUSED`

Por ordem de probabilidade:

1. **O Docker não está a correr.** `docker compose ps` no `mcpdbteste`.
2. **A porta não bate certo.** É o erro mais comum. A porta tem de ser a mesma
   em três sítios: o `POSTGRES_HOST_PORT` do `.env` do `mcpdbteste`, as
   `DATABASE_URL_*` desse mesmo ficheiro, e a `DATABASE_URL_READONLY` do `.env`
   deste projeto. Confirma qual está mesmo a ser usada:
   ```bash
   docker ps --format "{{.Names}} {{.Ports}}"
   ```
3. **Estás a usar `db` em vez de `localhost`.** O host `db` só existe dentro da
   rede do Docker Compose. A partir do teu computador é sempre `localhost`.

### `current_user = admin_dist` no arranque

Copiaste a `DATABASE_URL_ADMIN` em vez da `DATABASE_URL_READONLY`. Troca no
`.env`. (A transação READ ONLY continua a impedir escritas — mas estás a dar ao
servidor muito mais permissões do que ele precisa.)

### `password authentication failed for user "mcp_readonly"`

A `READONLY_PASSWORD` foi mudada no `.env` **depois** de o container ter
arrancado pela primeira vez. O utilizador só é criado no primeiro arranque, com
a password que existia nesse momento. Para recomeçar do zero:

```bash
cd mcpdbteste
docker compose down -v      # o -v apaga o volume
docker compose up -d db
docker compose run --rm seed
```

### `permission denied for table ...`

O utilizador de leitura não tem `SELECT` nessa tabela. Se a base foi recriada sem
`docker compose down -v`, o `ALTER DEFAULT PRIVILEGES` pode não ter sido
aplicado às tabelas novas. A receita é a mesma de cima.

### O cliente não vê as tools

- Compilaste? `npm run build` — o cliente corre `dist/`, não `src/`.
- Reiniciaste o cliente? Servidores MCP só são carregados no arranque da sessão.
- No Claude Code, `claude mcp list` diz `√ Connected`?
- No Claude Desktop, o que dizem os logs em `%AppData%\Claude\logs\`?

### `npm audit` reporta vulnerabilidades

Duas moderadas, ambas a mesma: `@hono/node-server`, dependência transitiva do SDK
do MCP, com um problema no `serve-static`. Esse código só é usado pelo transporte
HTTP; este servidor usa exclusivamente stdio e nunca o carrega. **Não corras
`npm audit fix --force`** — a "correção" desce o SDK uma versão major e parte a
compilação.

---

## Notas sobre o `.env`

O `.env` está no `.gitignore` dos dois repositórios e **nunca** deve ser
commitado. Se por acidente for, a password tem de ser considerada comprometida:
não basta apagar o ficheiro num commit seguinte, porque fica no histórico. A
recuperação é recriar a base com passwords novas (`docker compose down -v`).

Os `.env.example` são os que estão versionados, e não têm passwords nenhumas.
