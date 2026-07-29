# AgentSystem — Documento guia (visão, negócio e plano de implementação)

> **Versão:** 0.4 · **Data:** 17-07-2026 · **Estado:** rascunho para validação
> Nome de código do produto: **AgentSystem** (nome comercial a definir)

**Índice:** 1. Introdução · 2. Objetivo · 3. Mercado alvo · 4. Modelo de negócio · 5. Arquitetura (stack) · 6. Qualidade e avaliação dos agentes · 7. UI/UX · 8. Schema técnico da plataforma SaaS · 9. Planos e pagamentos · 10. Roadmap · 11. Metodologia de desenvolvimento · 12. Riscos · 13. Métricas · 14. Glossário

**Changelog v0.3 → v0.4 (decisões-chave alteradas):**
- **Fonte de dados:** foco exclusivo em **PostgreSQL** no arranque; os dados de muitas micro-empresas vivem em plataformas cloud (Moloni, Vendus, InvoiceXpress) e em Excel — esses conectores passam para o roadmap (Fase 2), sincronizando para um espelho PostgreSQL por tenant;
- **Mercado:** ICP reduzido a **micro-empresas portuguesas (5–10 colaboradores)**; removidas todas as referências a sistemas de gestão assentes em licenças de servidor;
- **Acesso a dados simplificado:** removido o componente instalado na rede local do cliente e o respetivo canal de saída — micro-empresas não têm rede local nem servidores próprios; fica a ligação direta segura a PostgreSQL (o que elimina também o conflito de soberania de dados que a solução de rede anterior levantava);
- **Camada de IA:** removido o proxy LLM externo; abstração multi-fornecedor via **Vercel AI SDK** + **model gateway interno** (metering, retries/failover, limites por tenant) + **registo de modelos data-driven**; Anthropic **Claude Sonnet 5** (principal) + **Claude Haiku 4.5** (tarefas baratas), OpenAI e Google no mesmo padrão, **Claude Opus 4.8** como tier premium futuro;
- **Dataset de referência:** nova **Fase 0** — BD fictícia de distribuidor de materiais de construção em PostgreSQL, construída **antes da aplicação**, com o guião de 50 perguntas de eval escrito em paralelo;
- **Preços:** removido o anchor de referência anterior; posicionamento a definir após pilotos, ajustado ao poder de compra de micro-empresas.

---

## 1. Introdução e descrição sumária

**O problema.** Nas micro e pequenas empresas, a informação crítica está guardada em bases de dados e sistemas de gestão, mas o acesso a ela depende de relatórios pré-construídos, de exportações manuais ou da disponibilidade de quem "sabe mexer no sistema". O resultado: decisões tomadas sem dados, tempo perdido à procura de informação e sistemas subaproveitados.

**A solução.** O **AgentSystem** é uma aplicação profissional destinada a micro e pequenas empresas, que disponibiliza Agentes Assistentes Conversacionais com IA capazes de responder e interagir com base na realidade específica de cada empresa, utilizando a informação existente nas respetivas bases de dados. O objetivo é permitir um acesso rápido, natural e contextualizado aos dados empresariais, transformando a informação armazenada em conhecimento útil para apoiar a tomada de decisão e a execução de tarefas.

**Âmbito faseado.** Na primeira fase, os agentes operam em modo de **consulta (apenas leitura)**: respondem a perguntas, cruzam dados, geram resumos e relatórios. A execução de ações sobre os sistemas (criar registos, lançar documentos) fica reservada para uma fase posterior e será sempre sujeita a **aprovação humana explícita** (human-in-the-loop) — ver secção 10.

**Diferenciação.** Ao contrário dos assistentes genéricos (ChatGPT, Copilot), o AgentSystem conhece os dados, o vocabulário e as regras de cada empresa, e respeita as permissões de cada utilizador. Ao contrário do BI tradicional, não exige dashboards pré-construídos nem competências técnicas. E ao contrário dos relatórios fixos que o software de gestão ou faturação já traz, o AgentSystem responde a **qualquer** pergunta de negócio em linguagem natural, cruza dados entre si, e domina o contexto fiscal e o vocabulário de negócio português com profundidade. **A velocidade de execução é, em si, uma decisão estratégica deste plano.**

## 2. Objetivo

O objetivo da aplicação é disponibilizar às empresas agentes inteligentes especializados por área funcional — Financeira/Contabilidade, Comercial, Recursos Humanos, Produção, Compras e Gestão de Projetos. Cada agente compreende o contexto da sua área e interage com os dados existentes de forma rápida, eficiente, contextualizada e segura, garantindo que cada utilizador acede apenas à informação e às funcionalidades para as quais possui autorização.

Para tal, cada agente apoia-se num **catálogo semântico** dos dados da empresa (descrição de tabelas, campos, métricas e vocabulário próprio) e num conjunto de **ferramentas de consulta controladas**; toda a atividade fica registada para auditoria — pergunta, resposta e consultas executadas. A qualidade das respostas não é uma esperança: é **medida continuamente por uma infraestrutura de avaliação (evals)** que funciona como motor de qualidade do produto (secção 6).

**Âmbito do MVP.** O produto arranca com dois agentes verticais — **Comercial/Vendas** e **Financeiro/Contabilidade** — por serem as áreas com maior dor e com dados mais estruturados. Os restantes agentes entram no roadmap (secção 10).

**Metas mensuráveis (a validar com os design partners):**
- Tempo de resposta a uma pergunta de negócio: **< 10 segundos** (vs. horas/dias pela via tradicional);
- **≥ 90%** de respostas corretas no dataset de avaliação (secção 6), medido em contínuo;
- **≥ 80%** das perguntas de negócio respondidas sem intervenção de TI ou consultores;
- Utilização semanal por **≥ 60%** dos utilizadores licenciados;
- **Zero** acessos fora das permissões definidas (verificado por auditoria).

## 3. Mercado alvo

**ICP (perfil de cliente ideal) — deliberadamente estreito na fase inicial:** micro e pequenas empresas portuguesas de **5–10 colaboradores** cujos dados de gestão estejam acessíveis numa base de dados **PostgreSQL**. Este recorte concentra o esforço num único tipo de fonte de dados, permitindo **provar o motor do produto antes de alargar**. Dominar este nicho antes de crescer é uma decisão estratégica, não uma limitação.

**Fonte de dados e conectores:**
- **Conector de arranque: PostgreSQL** — único suportado na fase inicial (ambiente de desenvolvimento, demonstração e primeiros clientes cujos sistemas exponham uma base PostgreSQL);
- **Realidade do mercado, assumida com honestidade:** os dados de muitas micro-empresas não vivem numa base de dados própria, mas em plataformas cloud de faturação/gestão (Moloni, Vendus, InvoiceXpress) e em folhas de Excel. **Os conectores para essas fontes ficam no roadmap (Fase 2)** e sincronizam os dados para um **espelho PostgreSQL por tenant**, mantendo o motor de consulta, o catálogo e a avaliação **únicos** para todas as fontes;
- A arquitetura de acesso a dados é **plugável** por desenho, para que o alargamento a novas fontes seja incremental.

O mercado geográfico inicial é **Portugal**, com expansão prevista para a União Europeia — o produto nasce preparado para multi-idioma (PT/EN) e conformidade RGPD.

**Personas:**
- **Decisor** (gerente ou dono da empresa) — compra o valor: respostas imediatas, controlo, menor dependência de terceiros. Numa empresa de 5–10 pessoas, é frequentemente também quem configura;
- **Configurador** (o próprio gerente ou o contabilista externo) — liga a fonte de dados, define permissões e valida o catálogo semântico (que é **auto-gerado** pela plataforma — secção 5.3). Como não há TI interno, o onboarding é desenhado para ser **quase self-serve**;
- **Utilizador de campo** (comercial, encarregado de obra, técnico) — usa o telemóvel fora do escritório, frequentemente com cobertura fraca; a experiência móvel e por voz é desenhada para ele (secção 7).

**Posicionamento.** O AgentSystem posiciona-se entre os assistentes de IA genéricos (que não conhecem os dados da empresa), as ferramentas de BI (que exigem dashboards pré-construídos e competências técnicas) e os relatórios fixos do software de gestão/faturação (limitados a perguntas pré-definidas): entrega o valor do BI com a simplicidade de uma conversa, sobre **todas** as fontes de dados da empresa, a um preço acessível a micro-empresas.

## 4. Modelo de negócio

O modelo de negócio é **Software as a Service (SaaS)**, através de subscrição mensal (com desconto na modalidade anual). O licenciamento é definido pelo número de **agentes inteligentes contratados** e pelo número de **utilizadores autorizados**.

A subscrição inclui o acesso à plataforma, às funcionalidades disponibilizadas pelos agentes, às atualizações e ao suporte (com níveis de serviço por plano — secção 9), **não incluindo o consumo dos modelos de IA**.

**Consumo de IA em créditos.** O consumo dos modelos de linguagem é pago em **créditos da plataforma** — uma unidade única, independente do fornecedor. Internamente, a plataforma converte créditos em tokens do modelo utilizado (Anthropic, OpenAI, Google Gemini), com margem de serviço embutida (referência: **20–30%**) e metering central por empresa, agente e utilizador (via **model gateway** interno — secção 5.3). Este modelo evita que o cliente gira contas e preçários de múltiplos fornecedores e protege o negócio da volatilidade dos preços de tokens. Cada plano inclui uma **franquia mensal de créditos**; pacotes adicionais podem ser adquiridos a qualquer momento, com alertas de consumo, recarga automática opcional e limites configuráveis (secção 9).

**Serviços complementares:**
- **Armazenamento e backup** — pacotes dimensionados em GB para persistência de documentos, imagens, áudio e outros conteúdos empresariais, alojados exclusivamente em infraestruturas na União Europeia;
- **Onboarding e configuração** — para micro-empresas, o onboarding é desenhado para ser **quase self-serve** (catálogo auto-gerado, ligação guiada à fonte de dados). Apoio pontual à configuração pode ser prestado por nós ou por contabilistas/parceiros, mas o objetivo estratégico é que deixe de ser um custo de serviços e passe a ser uma **vantagem do produto**.

**Proteção de dados (RGPD).** Toda a infraestrutura da plataforma reside na União Europeia. No fluxo de IA, os dados enviados aos modelos são **minimizados** ao estritamente necessário, com mascaramento opcional de dados pessoais e DPA com lista de subprocessadores. As opções de processamento em região UE de cada fornecedor LLM (Anthropic, OpenAI, Google) são **verificadas factualmente e refletidas no DPA** — o compromisso contratual espelha o que cada fornecedor realmente garante, não intenções. **Nenhum dado do cliente é utilizado para treino de modelos.**

**EU AI Act.** O AgentSystem enquadra-se previsivelmente como sistema de **risco limitado** (analytics empresarial; fora das categorias de alto risco do Anexo III), com deveres de transparência: o utilizador sabe sempre que interage com IA e as respostas citam as fontes. Este enquadramento é documentado para responder a due diligence de clientes maiores.

**Aquisição.** O motion comercial da fase inicial é **founder-led e self-serve**: venda direta aos primeiros design partners e onboarding desenhado para o próprio cliente configurar. Os contabilistas e consultores — os trusted advisors das micro-empresas portuguesas — são um **canal complementar** de distribuição, não um bloqueio. **Os design partners pagam** (secção 10): mensalidade a preço de fundador com carta de compromisso, **sem setup fee alto** — feedback de quem paga é o único que valida o negócio.

## 5. Arquitetura do programa (stack)

Pretende-se uma arquitetura moderna, robusta, fluída e com performance, para utilização com foco no **mobile (fora do escritório)** e no **desktop**.

### 5.1 Princípios
- **Comprar a canalização, construir a diferenciação** — a engenharia própria concentra-se onde vive a propriedade intelectual (catálogo semântico, evals, experiência de produto); infraestrutura indiferenciada usa componentes maduros e auditados;
- Multi-tenant desde o primeiro dia, com isolamento rigoroso por empresa;
- API-first; streaming das respostas dos agentes (tempo real onde importa);
- Cloud na União Europeia; custos de infraestrutura contidos na fase inicial;
- **Uma única linguagem — TypeScript — em todo o produto**, ponta a ponta, sem serviços auxiliares noutras linguagens.

### 5.2 Stack aplicacional
- **Monorepo TypeScript** (pnpm workspaces + Turborepo), com tipos partilhados entre frontend e backend;
- **Frontend:** Next.js/React como **PWA mobile-first** — uma única base de código serve mobile e desktop; a UI de chat assenta no **Vercel AI SDK** (`useChat` com suporte de retoma de streams) e em componentes prontos (AI Elements / assistant-ui) em vez de construção de raiz; empacotamento nativo (Capacitor) com **critério de adoção explícito** definido na secção 7.3;
- **Backend:** Node.js/TypeScript com **Hono + Zod** (ou Fastify) — API leve, validação de schemas, streaming nativo — e **workers BullMQ** dedicados para tarefas assíncronas (sincronização de catálogos, ingestão de documentos, relatórios);
- **Autenticação:** **Better Auth** (self-hosted, soberania UE) — passkeys/WebAuthn, MFA, organizações multi-tenant, SSO/OIDC para o plano Enterprise;
- **Dados da plataforma:** PostgreSQL multi-tenant com **Row-Level Security (RLS)**; ORM **Drizzle** (controlo fino do SQL e do contexto RLS por transação; migrações versionadas); Redis (cache e filas); object storage compatível com S3, na UE, para documentos e backups;
- **Comunicação app ↔ backend:** pedidos **POST com resposta em streaming na mesma ligação HTTP** (padrão streamable HTTP via `fetch`) — o padrão de facto das APIs de LLM — com **retoma aplicacional** de streams interrompidas e **chaves de idempotência** em cada pedido (secção 7.2). WebSocket não é utilizado nesta camada.

### 5.3 Camada de agentes (IA)
- Runtime de agentes em TypeScript (**Vercel AI SDK** e/ou **Claude Agent SDK**), com **abstração multi-fornecedor** (Anthropic, OpenAI, Google Gemini) e seleção de modelo por agente/tarefa;
- **Model gateway interno (TypeScript)** — ponto único de saída para os fornecedores de IA, construído sobre a abstração multi-fornecedor do Vercel AI SDK (`@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`). Um único módulo concentra: **metering** de tokens→créditos por tenant, agente e utilizador (captura os tokens de entrada/saída devolvidos em cada resposta do AI SDK e grava-os em `usage_events`); **rate limiting** por tenant; **retries e failover** entre fornecedores; **registo de custos**. Não há serviço externo a operar — é código do produto, na mesma linguagem;
- **Registo de modelos data-driven** — os modelos suportados vivem em configuração/tabela (fornecedor, `model_id`, preços de entrada/saída, rácio de conversão para créditos, estado ativo), não em código. Adicionar, trocar ou reprecificar um modelo é **configuração, não deploy** — essencial porque os IDs e preços dos modelos mudam com frequência;
- **Modelos (dois por fornecedor, seleção por tarefa):** a Anthropic é a preferência por agora — **Claude Sonnet 5** como modelo principal (text-to-SQL e trabalho agêntico, qualidade quase-Opus a custo Sonnet) e **Claude Haiku 4.5** para tarefas baratas (gerar sinónimos do catálogo, classificar perguntas, títulos de conversas, resumos). OpenAI e Google seguem o mesmo padrão (um modelo principal + uma variante mini/flash), com os nomes exatos confirmados na implementação e mantidos no registo data-driven. **Claude Opus 4.8** fica como tier premium futuro opcional. A seleção do modelo é **por tarefa dentro do agente**, não uma escolha global;
- **Observabilidade de IA: Langfuse** (alinhado com o requisito UE) — tracing por conversa, custos por tenant (redundância com o metering do gateway) e gestão dos datasets de avaliação (secção 6);
- Ferramentas dos agentes expostas segundo o protocolo **MCP (Model Context Protocol)** sobre o transporte **Streamable HTTP**, normalizando a adição de novas ferramentas;
- **Fiabilidade das respostas:** text-to-SQL orientado pelo catálogo semântico + biblioteca de **queries parametrizadas pré-aprovadas** para as perguntas frequentes (mais fiável do que SQL livre); validação de todas as queries geradas (apenas `SELECT`, `LIMIT` e timeout obrigatórios); **citação da origem dos dados** em cada resposta;
- **Catálogo semântico auto-gerado:** a plataforma introspeta o schema PostgreSQL da fonte de dados e usa um LLM para gerar o rascunho do catálogo (tabelas, colunas, métricas, sinónimos); o Configurador **valida e afina** em vez de construir do zero. Esta é a decisão que transforma o onboarding de serviço de consultoria em funcionalidade de produto — e é core IP, construída internamente (com referência ao desenho de camadas semânticas existentes, ex.: Cube, dbt MetricFlow).

### 5.4 Acesso às bases de dados dos clientes
Na fase inicial, o único cenário suportado é o de uma **base de dados PostgreSQL acessível** (na cloud do cliente ou alojada por nós): ligação direta segura — TLS, utilizador de base de dados dedicado e **apenas de leitura**, allowlist de IPs, credenciais cifradas (KMS) e auditoria integral das consultas executadas. **Não há componente instalado na rede do cliente** — micro-empresas não têm rede local nem servidores próprios a que aceder.

**Roadmap (Fase 2).** Para as empresas cujos dados vivem em plataformas cloud de faturação/gestão (Moloni, Vendus, InvoiceXpress) ou em Excel, conectores dedicados sincronizarão esses dados para um **espelho PostgreSQL por tenant**. Assim, o motor de text-to-SQL, o catálogo semântico e os evals permanecem únicos, independentemente da fonte original.

### 5.5 Infraestrutura e operação
- Cloud UE: **Hetzner + Coolify** (experiência PaaS a custo contido) ou Fly.io em região UE; containers Docker; **sem Kubernetes** até a escala o justificar; infraestrutura como código simples;
- Observabilidade: logs estruturados, tracing por conversa (Langfuse), dashboards de custo de IA por tenant;
- CI/CD com ambientes de preview e produção (secção 11); backups automáticos e **testados**, com objetivos explícitos de recuperação (**RPO ≤ 24h, RTO ≤ 4h** na fase piloto, a apertar com a escala);
- **Status page pública** desde a Fase 1 — transparência operacional é argumento de venda para empresas escaldadas com fornecedores opacos.

### 5.6 Segurança
- Autenticação com **passkeys/WebAuthn (biometria) como método primário**, MFA como reforço; SSO/OIDC no plano Enterprise; sessões e tokens de curta duração com renovação transparente (refresh tokens) — segurança sem atrito para o utilizador de campo;
- Encriptação em trânsito (TLS) e em repouso; segredos em cofre (KMS/vault);
- RBAC por agente, fonte de dados e funcionalidade; RLS na base de dados da plataforma;
- **Defesa contra prompt injection via dados:** os resultados das queries são tratados como **dados não-confiáveis** no contexto do modelo (um campo de texto na BD do cliente pode conter instruções maliciosas); mitigações: nenhuma ferramenta de escrita na fase de consulta, respostas ancoradas em citações de queries auditadas, filtros de output;
- **Segurança do dispositivo:** tokens em cookies httpOnly (nunca em localStorage); o service worker da PWA **não guarda em cache persistente** respostas da API com dados empresariais; limpeza integral dos dados locais no logout;
- Trilho de auditoria completo: quem perguntou o quê, que dados foram consultados, que resposta foi dada;
- Rate limiting e proteção contra abuso; testes de segurança antes da disponibilidade geral;
- **Roadmap de conformidade:** agora — políticas de segurança básicas + DPA sólido; com tração — **ISO 27001** (o standard que o mercado europeu reconhece; SOC2 apenas se surgir procura de clientes norte-americanos).

## 6. Qualidade e avaliação dos agentes (evals)

A promessa central do produto — respostas corretas sobre dados reais — não se garante com testes manuais: garante-se com **infraestrutura de avaliação contínua**, tratada como componente central e não como tooling acessório.

- **Dataset de avaliação por agente:** o guião de 50 perguntas da Fase 0 é convertido num dataset automatizado (Langfuse datasets / promptfoo), com pares pergunta→resultado esperado sobre a **BD de referência de materiais de construção** (secção 10, Fase 0);
- **Gate de qualidade em CI:** qualquer alteração a prompts, catálogo semântico, modelo ou lógica de ferramentas corre o dataset completo antes de chegar a produção — uma "melhoria" que degrade a taxa de acerto é bloqueada;
- **Feedback fechado em loop:** cada 👎 de um utilizador real cria automaticamente um caso de avaliação candidato (pergunta + contexto + resposta errada), triado e adicionado ao dataset — o produto melhora com o uso;
- **Métricas de qualidade publicadas internamente:** taxa de acerto por agente e por tipo de pergunta, taxa de "não sei" (que deve existir — um agente que nunca diz "não sei" está a alucinar), latência p50/p95;
- **Datasets por cliente na Fase 1:** cada design partner tem um subconjunto de perguntas críticas do seu negócio validadas no onboarding — funciona como contrato de qualidade e como teste de regressão permanente.

## 7. UI/UX

### 7.1 Princípios
- **Conversação com respostas ricas:** o chat é o centro, mas as respostas não são só texto — tabelas, gráficos, cartões de KPI e exportação para XLSX/PDF;
- **Confiança e transparência:** cada número tem origem consultável ("ver detalhe" mostra as consultas e tabelas usadas); o agente diz claramente quando **não sabe** ou quando o utilizador **não tem permissão**; feedback 👍/👎 em cada resposta, ligado ao loop de evals (secção 6);
- **Mobile-first:** experiência principal pensada para o telemóvel fora do escritório (PWA instalável);
- **Voz como modo de interação principal em mobilidade:** para o utilizador de campo (luvas, sol no ecrã, mãos ocupadas), o ditado por voz não é um extra — é o caminho mais curto para a pergunta. Botão de voz proeminente, transcrição imediata editável;
- **Desktop:** layout de 2–3 colunas — agentes e conversas | conversa ativa | painel de detalhe (dados de origem, artefactos, exportações).

### 7.2 Comportamento em rede móvel (cenário de referência: obra, cobertura fraca)
- **Retoma de streams:** se a ligação cair a meio de uma resposta, o cliente retoma a stream com o ID da mensagem e o servidor devolve o que já foi gerado entretanto (suporte de resume do AI SDK) — a geração não se perde nem recomeça;
- **Persistência local:** histórico de conversas em IndexedDB — a app abre instantaneamente e é consultável mesmo sem rede;
- **Fila de envio com retry:** perguntas feitas sem cobertura ficam em fila e são enviadas automaticamente quando a rede volta, com indicação clara de estado (pendente/enviada);
- **Idempotência:** cada pedido leva uma **chave de idempotência** — um retry automático nunca executa a mesma pergunta duas vezes nem debita créditos a dobrar;
- **Notificações de tarefas longas:** relatórios pesados correm em background; o utilizador é notificado por **web push** quando a resposta está pronta, com **fallback por email** — nunca fica agarrado ao ecrã à espera.

### 7.3 PWA no iOS e critério de adoção de Capacitor
As limitações reais da PWA no iOS são assumidas: instalação escondida no menu de partilha do Safari, web push apenas para PWAs instaladas no ecrã inicial, possibilidade de despejo do storage local. **Critério explícito:** se nos pilotos ≥ 30% dos utilizadores iOS não instalarem a PWA ou perderem dados locais, o empacotamento **Capacitor** (App Store, push nativo, storage garantido) entra imediatamente no plano — a decisão é tomada com dados, não descoberta em produção.

### 7.4 Respostas ricas em ecrã pequeno
Regra de degradação declarada: tabelas largas transformam-se em **cartões** no telemóvel; gráficos são redesenhados para orientação vertical; exportações usam o **share sheet nativo** (partilhar para WhatsApp/email) em vez de "download". Nenhuma resposta pode exigir zoom ou scroll horizontal para ser lida.

### 7.5 Descoberta e onboarding
- Perguntas sugeridas por agente e templates por área funcional (arranque imediato e descoberta de capacidades);
- Tour inicial curto; estados vazios instrutivos; histórico de conversas pesquisável.

### 7.6 Backoffice do cliente (administrador da empresa)
- Gestão de utilizadores, papéis e permissões (por agente e por fonte de dados);
- Configuração de agentes e **validação do catálogo semântico auto-gerado** (fluxo de revisão assistida, não construção manual);
- Dashboard de consumo de créditos (por agente e utilizador) e gestão de pacotes;
- Consulta do trilho de auditoria.

### 7.7 Consola interna da plataforma (a nossa operação)
- Gestão de tenants, planos e subscrições; consumos e margens; saúde dos conectores; ferramentas de suporte.

### 7.8 Qualidade
- Acessibilidade WCAG 2.2 AA; internacionalização PT/EN desde o início; modo claro/escuro; branding ligeiro por cliente (logótipo e cor).

## 8. Schema técnico para a gestão da plataforma SaaS

Modelo de dados core da plataforma (PostgreSQL, com RLS por `tenant_id` em todas as tabelas de tenant; migrações versionadas com **Drizzle**):

**Identidade e acesso**
- `tenants` — empresas clientes (identificação, estado, região de dados);
- `users` — utilizadores por tenant (autenticação via Better Auth: passkeys, MFA);
- `roles` / `permissions` — RBAC: `platform_admin`, `tenant_admin`, `manager`, `member`;
- `api_keys` — chaves de integração por tenant;
- `audit_log` — registo imutável de ações administrativas e de acessos.

**Agentes e dados**
- `agents` — catálogo global de agentes disponíveis (Comercial, Financeiro, …);
- `tenant_agents` — instâncias contratadas e configuradas por empresa (modelo de IA preferido, tom, limites);
- `data_sources` — conectores configurados (tipo de fonte: **PostgreSQL** na fase inicial; estado; credenciais cifradas). Na Fase 2, tipos adicionais para plataformas cloud e Excel;
- `models` — registo **data-driven** dos modelos de IA suportados (fornecedor, `model_id`, preços de entrada/saída, rácio de conversão para créditos, estado ativo) — alimenta o model gateway e a tabela de conversão de créditos (secção 5.3);
- `semantic_catalog` — descrição semântica por fonte: tabelas, colunas, métricas, sinónimos e regras de negócio (com estado de validação: auto-gerado / revisto / aprovado);
- `agent_permissions` — matriz papel × agente × fonte de dados.

**Conversação e auditoria de IA**
- `conversations` / `messages` — histórico por utilizador, pesquisável (com chave de idempotência por mensagem enviada);
- `tool_invocations` — cada ferramenta/query executada: SQL, duração, linhas devolvidas, resultado — trilho completo para auditoria e diagnóstico.

**Qualidade (evals)**
- `eval_cases` — casos de avaliação: pergunta, contexto, resultado esperado, origem (guião, feedback 👎, onboarding do cliente);
- `eval_runs` — execuções do dataset: versão de prompt/catálogo/modelo, taxa de acerto, regressões detetadas.

**Comercial e faturação**
- `plans` — definição dos planos e respetivos limites;
- `subscriptions` — subscrição ativa por tenant (estado, ciclo, renovação);
- `credit_wallets` / `credit_ledger` — saldo de créditos e livro-razão **imutável** de movimentos (franquias, compras, consumos, ofertas);
- `usage_events` — cada chamada a um LLM (alimentado pelo **model gateway interno** / AI SDK): modelo, tokens de entrada/saída, custo real, créditos debitados;
- `invoices` / `payments` — documentos e pagamentos (Stripe; emissão certificada manual na Fase 1, integrada na Fase 2);
- `storage_quotas` — quota e consumo de armazenamento por tenant.

**Regras transversais**
- Retenção de dados configurável por tenant; exportação e apagamento completos (RGPD); soft-delete onde aplicável.

## 9. Planos e pagamentos

### 9.1 Estrutura de planos

| | **Starter** | **Business** | **Enterprise** |
|---|---|---|---|
| Agentes incluídos | 1 | 3 | à medida |
| Utilizadores incluídos | 5 | 20 | à medida |
| Franquia mensal de créditos | S | M | negociada |
| Suporte | email | prioritário | SLA dedicado |
| SSO/OIDC | — | — | ✓ |

**Add-ons:** utilizador adicional, agente adicional, armazenamento por GB, pacotes de créditos.

Os preços serão definidos após os pilotos, **ajustados ao poder de compra de micro-empresas**. Racional: um produto que responde a perguntas de negócio em segundos compete em valor com o tempo perdido em Excel e relatórios manuais, não com ferramentas de produtividade genéricas. O custo de aquisição e onboarding tem de caber no primeiro ano de receita de cada cliente — o que reforça a aposta num **onboarding self-serve** (o custo de configuração tem de ser próximo de zero).

### 9.2 Créditos de IA
- Franquia mensal incluída em cada plano (renova no ciclo; não acumula por defeito);
- Pacotes adicionais compráveis a qualquer momento;
- Alertas de consumo a **80% e 95%**; **recarga automática opcional** com teto mensal definido pelo cliente;
- Limites configuráveis por utilizador e por agente (soft: aviso; hard: bloqueio);
- Tabela de conversão créditos↔modelos publicada e revista periodicamente (a margem de serviço está embutida na conversão; a tabela é alimentada pelo registo de modelos data-driven — secção 5.3).

### 9.3 Aquisição e retenção
- **Design partners pagantes** (Fase −1/0): mensalidade a preço de fundador com carta de compromisso, **sem setup fee alto** — o pagamento é o teste de validação;
- Venda **founder-led e self-serve** como motion principal; contabilistas e consultores como canal complementar;
- Desconto na subscrição anual (referência: ~2 meses);
- Upgrades com proration imediata; downgrades aplicados no ciclo seguinte.

### 9.4 Processamento de pagamentos
- **Stripe Billing:** cartão e débito direto SEPA; gestão de IVA europeu; retries automáticos de cobranças falhadas (dunning);
- **Faturação certificada (Portugal):** as faturas do Stripe **não substituem** faturas certificadas pela AT. **Fase 1: emissão manual** (ex.: Moloni — minutos por mês para 2–3 pilotos). **Fase 2: integração por API** com um emissor certificado (InvoiceXpress, Moloni, Vendus), incluindo SAF-T — nota: aqui estas plataformas são **emissores de faturação certificada das nossas próprias faturas**, distinto dos conectores de dados dos clientes (secção 5.4). Para o metering/billing usage-based da Fase 2, avaliar **Lago** (open-source, europeu) antes de estender o ledger próprio;
- **Incumprimento:** suspensão gradual — aviso → modo só-leitura → bloqueio; reativação imediata após regularização;
- **Cancelamento/offboarding:** exportação completa dos dados do cliente e apagamento certificado (RGPD).

## 10. Roadmap por fases

**Fase −1 — Validação (antes de construir).** 15–20 entrevistas de problema com decisores de micro-empresas do ICP (5–10 colaboradores); objetivo: **3 design partners pagantes** com carta de compromisso. **Prioridade número um: validar que a dor de reporting é real e aguda** — numa empresa de 5–10 pessoas, o gerente muitas vezes "tem o negócio na cabeça", pelo que a dor não é garantida e tem de ser confirmada antes de escrever código.
*Critério de saída:* 3 compromissos assinados e pagos. Se ninguém pagar, o plano volta à prancheta — é o resultado mais barato possível.

**Fase 0 — Dataset de referência + Protótipo.** Duas partes; a primeira vem **antes de qualquer aplicação**:
- **(a) BD de referência:** construir uma **base de dados fictícia de um distribuidor de materiais de construção** em PostgreSQL, por **script de seed versionado** (reprodutível e parametrizável em volume, mais tarde clonável como segundo tenant para testar RLS na Fase 1), **realisticamente "suja"** (nomes de colunas abreviados/inconsistentes, colunas legadas sem uso, NULLs, dados duplicados/mal escritos, texto com acentos) e com **modelo de negócio e fiscalidade portugueses a sério**: artigos com famílias/subfamílias (cimentos, tijolo, ferramentas, ferragens), preços por escalão de cliente, IVA a 6/13/23%, clientes (empreiteiros e particulares) com condições de pagamento e limite de crédito, fornecedores e compras, documentos com tipologia PT (orçamento, encomenda, guia de transporte, fatura, nota de crédito), stock por armazém, vendedores com comissões, conta-corrente com pendentes e vencimentos; **2–3 anos de movimentos com sazonalidade** (a construção abranda no inverno). O **guião de 50 perguntas de eval** (pergunta + SQL esperado + resposta esperada) é escrito **em paralelo** — a BD e o dataset de avaliação são um único entregável, e é isto que arranca a secção 6. Timebox: **1–2 semanas**;
- **(b) Protótipo:** um agente (Comercial) sobre essa BD; text-to-SQL orientado pelo catálogo semântico; chat PWA com streaming (POST + fetch streaming); **harness de evals operacional** em CI com o guião de 50 perguntas; **protótipo do catálogo auto-gerado** (introspeção + LLM) sobre o mesmo schema; sem multi-tenant nem billing.
*Critério de saída:* demo convincente com dados realistas, **≥ 90% de acerto no dataset de evals**, e catálogo auto-gerado a reduzir o onboarding de dias para horas.

**Fase 1 — MVP piloto (design partners).** Multi-tenant com RLS; **ligação direta a PostgreSQL** (sem componente na rede do cliente); 2 agentes (Comercial + Financeiro); backoffice mínimo (utilizadores, permissões, consumo, validação do catálogo); créditos + Stripe com **faturação certificada manual**; auditoria completa; datasets de evals por cliente.
*Critério de saída:* design partners com utilização semanal, feedback positivo, zero incidentes de segurança — e a pagar o preço acordado sem contestação de valor.

**Fase 2 — Disponibilidade geral (GA).** **Conectores para plataformas cloud (Moloni, Vendus, InvoiceXpress) e Excel**, sincronizando para espelho PostgreSQL por tenant; mais agentes (RH, Compras, …); backoffice completo; **faturação certificada integrada por API** (+ avaliação do Lago para billing); onboarding totalmente self-serve (que desbloqueia trial e motion PLG); consola interna de operação; hardening de segurança, preparação ISO 27001 e testes de carga.

**Fase 3 — Ações com aprovação humana.** Execução de ações sobre os sistemas (criar registos, emitir documentos) com fluxos de aprovação explícita, começando por ações de baixo risco.

## 11. Metodologia de desenvolvimento

- **Trunk-based development** com preview deployments por pull request — nada de GitFlow;
- **CI/CD:** build → testes → **evals de agente como gate de qualidade** (o passo distintivo: nenhuma alteração a prompts/catálogo/modelo passa sem correr o dataset — secção 6) → staging → produção;
- **Desenvolvimento AI-assisted como multiplicador:** agentes de código (Claude Code) com especificações escritas, sobre o monorepo TypeScript único — para uma equipa de 1–3 pessoas, é a diferença entre trimestres e meses por fase;
- **Shape Up-lite:** ciclos de 2 semanas com apetite fixo — corta-se scope, não datas; sem cerimónias de Scrum desproporcionadas para a dimensão da equipa;
- **Continuous discovery:** contacto semanal com os design partners; cada funcionalidade nova nasce de uma pergunta real que os agentes falharam ou de uma dor observada — não de um backlog especulativo.

## 12. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| **Micro-empresas não têm base de dados própria** — os dados vivem em plataformas cloud e Excel, e o conector que efetivamente vende só chega na Fase 2 | BD fictícia de referência prova o motor já na Fase 0; conectores cloud/Excel priorizados assim que o motor estiver validado; arquitetura plugável com espelho PostgreSQL por tenant |
| **Dor de reporting menos aguda em empresas de 5–10 pessoas** (o gerente "tem o negócio na cabeça") | Fase −1 valida a dor antes de construir; voz e mobile para o utilizador de campo; perguntas sugeridas para criar hábito; design partners pagantes como filtro de skin in the game |
| Software de gestão/faturação (Moloni, Vendus, …) e assistentes genéricos (ChatGPT) começam a responder sobre dados | Conhecimento profundo dos dados, vocabulário e permissões de cada empresa; contexto fiscal PT; capacidade de cruzar várias fontes que uma ferramenta única não vê; velocidade de execução |
| Respostas erradas / SQL incorreto (alucinação) | **Evals contínuos em CI (secção 6)**; catálogo semântico curado; queries pré-aprovadas para perguntas frequentes; validação de queries (read-only, `LIMIT`, timeout); citação de fontes; feedback 👍/👎 fechado em loop |
| Prompt injection via dados do cliente (instruções maliciosas em campos de texto) | Resultados de queries tratados como dados não-confiáveis; nenhuma ferramenta de escrita na fase de consulta; respostas ancoradas em citações; filtros de output |
| Fuga ou acesso indevido a dados | RLS + RBAC; role de BD só-leitura; ligação direta cifrada e auditada; auditoria integral; mascaramento opcional de PII |
| Conformidade RGPD / EU AI Act no fluxo de IA | Minimização dos dados enviados aos modelos; regiões UE verificadas por fornecedor e refletidas no DPA; sem treino com dados de clientes; enquadramento AI Act documentado |
| Dependência de fornecedores de LLM | Abstração multi-fornecedor com failover via **model gateway interno** como ponto único |
| Volatilidade dos custos de tokens | Margem na conversão para créditos; **registo de modelos data-driven** revisto periodicamente; limites e alertas de consumo |
| Onboarding consultivo que não escala (SaaS disfarçado de serviços) | **Catálogo semântico auto-gerado** + validação assistida; onboarding self-serve progressivo; contabilistas/parceiros absorvem o restante esforço |
| Fraca adoção pelos utilizadores | Design partners pagantes desde o início (skin in the game); voz como interação principal em mobilidade; perguntas sugeridas; acompanhamento das métricas de ativação |
| Limitações da PWA no iOS (instalação, push, storage) | Critério explícito de adoção de Capacitor medido nos pilotos (secção 7.3) |

## 13. Métricas de sucesso

- **Validação (Fase −1):** 3 design partners pagantes; taxa de conversão das entrevistas em compromissos; sinal claro de dor de reporting aguda;
- **Qualidade:** ≥ 90% de acerto no dataset de evals (contínuo); % de respostas com feedback positivo (meta ≥ 85%); taxa de "não sei" saudável (> 0 — um agente que nunca recusa está a alucinar);
- **Ativação:** primeira resposta útil < 1 dia após a ligação da fonte de dados; onboarding do catálogo em horas, não dias;
- **Adoção:** perguntas por utilizador por semana; % de utilizadores ativos semanais (meta ≥ 60%); % de perguntas feitas por voz em mobile (proxy da adoção de campo);
- **Retenção e receita:** churn mensal; NRR — expansão por agentes, utilizadores e créditos;
- **Economia unitária:** margem sobre créditos; custo de IA por tenant; custo de onboarding por cliente vs. receita do primeiro ano; CAC vs. LTV.

## 14. Glossário

- **Agente** — assistente de IA especializado numa área funcional, com ferramentas e permissões próprias;
- **Ferramenta (tool)** — capacidade concreta que um agente pode invocar (ex.: executar uma query aprovada);
- **Conector** — componente que liga a plataforma à fonte de dados do cliente (na fase inicial, ligação direta a PostgreSQL; na Fase 2, conectores para plataformas cloud e Excel, com espelho PostgreSQL por tenant);
- **Catálogo semântico** — descrição das tabelas, colunas, métricas e vocabulário da empresa, que orienta o agente; auto-gerado pela plataforma e validado pelo Configurador;
- **Crédito** — unidade de consumo de IA da plataforma, independente do fornecedor do modelo;
- **Design partner** — cliente piloto pagante que co-constrói o produto com acesso antecipado e preço de fundador;
- **Evals** — avaliação automatizada e contínua da qualidade das respostas dos agentes contra um dataset de casos com resultado esperado;
- **Chave de idempotência** — identificador único por pedido que garante que um reenvio (retry) nunca executa a mesma operação duas vezes;
- **MCP (Model Context Protocol)** — protocolo aberto que normaliza a exposição de ferramentas e dados a modelos de IA;
- **Model gateway** — módulo interno (TypeScript) que centraliza a saída para os fornecedores de IA: metering de tokens→créditos, rate limiting, retries/failover e registo de custos;
- **Passkey (WebAuthn)** — credencial criptográfica ligada ao dispositivo, desbloqueada por biometria — substitui passwords com mais segurança e menos atrito;
- **PWA (Progressive Web App)** — aplicação web instalável que serve mobile e desktop a partir de uma única base de código;
- **RLS (Row-Level Security)** — mecanismo do PostgreSQL que garante o isolamento dos dados por tenant ao nível das linhas;
- **Streamable HTTP** — transporte remoto atual da especificação MCP: pedido HTTP cuja resposta chega em streaming na mesma ligação;
- **Tenant** — cada empresa cliente, com dados isolados na plataforma.
