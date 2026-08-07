/**
 * O REGISTO DE PERFIS — pega na lista declarativa do perfis.ts, abre as ligações
 * que ela pede e devolve um contexto pronto por cada papel que ficou configurado.
 *
 * É o único sítio do projeto que sabe o NOME de uma variável de ambiente de
 * ligação. O db.ts e o db-escrita.ts recebem a connection string por parâmetro e
 * não fazem ideia de como ela se chama; os perfis declaram o nome mas nunca o
 * leem. Essa separação é o que torna possível a propriedade seguinte.
 *
 * UM POOL POR LIGAÇÃO, NÃO UM POOL POR PERFIL.
 *
 * As ligações são memorizadas pela própria connection string. Como todos os
 * perfis leem pela `DATABASE_URL_READONLY`, todos partilham um pool de leitura —
 * e um papel novo passa a custar zero ligações ao Postgres. Se um dia um perfil
 * precisar de uma ligação própria (um `auditor` que veja os arquivados, com um
 * role só dele), basta apontá-lo a outra variável e nasce-lhe um pool; os outros
 * continuam a partilhar o que já tinham. É a razão de a chave ser a string e não
 * o nome da variável: duas variáveis com o mesmo valor são a mesma ligação.
 *
 * O QUE ACONTECE A UM PERFIL SEM CONFIGURAÇÃO.
 *
 * Fica INDISPONÍVEL, e isso não é uma falha. É o que mantém a escrita opt-in: um
 * deployment sem `DATABASE_URL_WRITE` continua a arrancar exatamente como sempre
 * arrancou, com o `employee` e mais nada, e quem pedir o `admin` recebe uma
 * mensagem que diz o que falta em vez de um servidor a servir menos do que quem o
 * arrancou julga. Só se NENHUM perfil ficar configurado é que o arranque falha —
 * um servidor sem perfis não tem nada que possa fazer.
 */

import { arrancarBaseDeDados, type LigacaoLeitura } from "../db.js";
import { arrancarEscrita, type LigacaoEscrita } from "../db-escrita.js";
import { log } from "../log.js";
import { TABELAS_ESCRITA } from "../seguranca/escrita-camada1-alvo.js";
import {
  criarContextoEscrita,
  criarContextoLeitura,
  type ContextoAcesso,
} from "./contexto.js";
import { perfilEscreve, toolsDoPerfil, type Perfil } from "./perfis.js";

/** Os contextos que ficaram prontos, indexados pelo nome do perfil. */
export interface Registo {
  /** Os perfis que ficaram configurados, por ordem de declaração. */
  readonly disponiveis: readonly string[];
  /** O contexto de um perfil, ou `undefined` se não estiver configurado. */
  obter(nome: string): ContextoAcesso | undefined;
  /** O mesmo, mas lança com uma mensagem que explica o que falta. */
  exigir(nome: string): ContextoAcesso;
}

/**
 * Abre tudo o que os perfis pedem e devolve o registo.
 *
 * Corre UMA VEZ por processo, no arranque, antes de o transporte existir. É o
 * sucessor do antigo `arrancarBaseDeDados()` + `arrancarEscrita()` chamados à mão
 * pelo servidor.ts.
 */
export async function arrancarRegisto(perfis: readonly Perfil[]): Promise<Registo> {
  // Memórias locais à corrida, e não estado de módulo: quem fecha os pools no
  // encerramento é o db.ts/db-escrita.ts, que já guardam o seu próprio registo de
  // ciclo de vida. Estas duas só existem enquanto esta função corre.
  const ligacoesLeitura = new Map<string, LigacaoLeitura>();
  const ligacoesEscrita = new Map<string, LigacaoEscrita>();

  const contextos = new Map<string, ContextoAcesso>();
  /** Perfil -> variáveis que lhe faltam. Serve as mensagens de erro. */
  const emFalta = new Map<string, string[]>();

  for (const perfil of perfis) {
    const resultado = await construirContexto(perfil, ligacoesLeitura, ligacoesEscrita);

    if ("faltam" in resultado) {
      emFalta.set(perfil.nome, resultado.faltam);
      log(`perfil '${perfil.nome}' não configurado: ${explicarFalta(perfil, resultado.faltam)}`);
      continue;
    }

    contextos.set(perfil.nome, resultado.contexto);
    const tools = toolsDoPerfil(perfil);
    log(`perfil '${perfil.nome}': ${tools.length} tools — ${tools.join(", ")}.`);
  }

  if (contextos.size === 0) {
    throw new Error(mensagemDeRegistoVazio(perfis, emFalta));
  }

  // A nota do arquivo só faz sentido para quem tem as tools que lhe tocam. É
  // logada uma vez, e não por perfil, porque descreve o comportamento das tools e
  // não a configuração de um papel.
  if ([...contextos.values()].some((c) => perfilEscreve(c.perfil))) {
    log(
      "arquivo: archive_row esconde (reversível); delete_row destrói em cascata e exige " +
        "que a linha já esteja arquivada.",
    );
  }

  return {
    disponiveis: [...contextos.keys()],
    obter: (nome) => contextos.get(nome),
    exigir: (nome) => {
      const contexto = contextos.get(nome);
      if (contexto !== undefined) {
        return contexto;
      }
      const perfil = perfis.find((p) => p.nome === nome);
      if (perfil === undefined) {
        throw new Error(
          `Não existe nenhum perfil chamado '${nome}'.\n` +
            `Perfis definidos em src/acesso/perfis.ts: ${perfis.map((p) => p.nome).join(", ")}.`,
        );
      }
      throw new Error(
        `O perfil '${nome}' existe mas não está configurado: ` +
          `${explicarFalta(perfil, emFalta.get(nome) ?? [])}\n` +
          `Perfis disponíveis neste servidor: ${[...contextos.keys()].join(", ")}.`,
      );
    },
  };
}

/**
 * O contexto de um perfil, ou as variáveis que impediram de o construir.
 *
 * As variáveis em falta são recolhidas TODAS antes de se desistir do perfil, para
 * a mensagem poder dizer "faltam estas duas" em vez de mandar quem lê descobrir a
 * segunda depois de ter resolvido a primeira.
 *
 * Os dois ramos são separados porque produzem contextos de TIPOS diferentes, e é
 * essa diferença que o resto do sistema usa para decidir o que se pode registar.
 * O ramo de escrita é o único sítio do projeto onde um `ContextoEscrita` nasce.
 */
async function construirContexto(
  perfil: Perfil,
  ligacoesLeitura: Map<string, LigacaoLeitura>,
  ligacoesEscrita: Map<string, LigacaoEscrita>,
): Promise<{ contexto: ContextoAcesso } | { faltam: string[] }> {
  const csLeitura = lerVariavel(perfil.variavelLeitura);

  if (perfilEscreve(perfil)) {
    const csEscrita = lerVariavel(perfil.escrita.variavel);
    if (csLeitura === undefined || csEscrita === undefined) {
      return {
        faltam: [
          ...(csLeitura === undefined ? [perfil.variavelLeitura] : []),
          ...(csEscrita === undefined ? [perfil.escrita.variavel] : []),
        ],
      };
    }
    // A ordem importa para os logs: os argumentos são avaliados da esquerda para
    // a direita, portanto a ligação de leitura abre (e loga) antes da de escrita.
    return {
      contexto: criarContextoEscrita(
        perfil,
        await obterLigacaoLeitura(ligacoesLeitura, csLeitura),
        await obterLigacaoEscrita(ligacoesEscrita, csEscrita),
      ),
    };
  }

  if (csLeitura === undefined) {
    return { faltam: [perfil.variavelLeitura] };
  }
  return {
    contexto: criarContextoLeitura(perfil, await obterLigacaoLeitura(ligacoesLeitura, csLeitura)),
  };
}

/**
 * Uma variável de ambiente, ou `undefined` se não estiver preenchida.
 *
 * Lida aqui dentro e não no corpo do módulo, pela mesma razão de sempre: em ESM
 * os módulos são avaliados antes da primeira linha do ponto de entrada, e isso é
 * antes de o `import "dotenv/config"` ter carregado o .env.
 *
 * Uma string só com espaços conta como ausente. É deliberado e há um uso real:
 * `$env:DATABASE_URL_WRITE = " "` é a forma documentada de arrancar em
 * só-leitura numa shell onde a variável já está definida (ver o
 * docs/PROMPT-ACESSO-REMOTO.md).
 */
function lerVariavel(nome: string): string | undefined {
  const valor = process.env[nome];
  if (valor === undefined || valor.trim() === "") {
    return undefined;
  }
  return valor;
}

async function obterLigacaoLeitura(
  memoria: Map<string, LigacaoLeitura>,
  connectionString: string,
): Promise<LigacaoLeitura> {
  const jaAberta = memoria.get(connectionString);
  if (jaAberta !== undefined) {
    return jaAberta;
  }

  const { ligacao, identidade } = await arrancarBaseDeDados(connectionString);

  // A verificação mais barata que existe de que não estamos, por engano, a usar
  // a connection string de admin. Se aqui aparecer "admin_dist" em vez de
  // "mcp_readonly", está algo errado no .env — e vê-se de imediato.
  log(`ligado a ${identidade.baseDeDados} (${identidade.versaoPostgres})`);
  log(`current_user = ${identidade.utilizador}`);
  if (identidade.utilizador !== "mcp_readonly") {
    log(
      `AVISO: o utilizador esperado era 'mcp_readonly'. Confirma a DATABASE_URL_READONLY ` +
        `no .env — a transação READ ONLY continua a impedir escritas, mas esta ligação ` +
        `tem mais permissões do que devia.`,
    );
  }

  memoria.set(connectionString, ligacao);
  return ligacao;
}

async function obterLigacaoEscrita(
  memoria: Map<string, LigacaoEscrita>,
  connectionString: string,
): Promise<LigacaoEscrita> {
  const jaAberta = memoria.get(connectionString);
  if (jaAberta !== undefined) {
    return jaAberta;
  }

  // Falha com exceção se a ligação for de superutilizador — a verificação que
  // não é negociável, e que continua a viver no db-escrita.ts, junto do pool que
  // ela protege.
  const { ligacao, identidade } = await arrancarEscrita(connectionString);

  log(`ESCRITA LIGADA — current_user = ${identidade.utilizador}`);
  log(
    `o Postgres concede INSERT a este utilizador em ` +
      `${identidade.tabelasComEscrita.length} tabelas: ` +
      `${identidade.tabelasComEscrita.join(", ")}`,
  );

  // Confronto entre as duas listas independentes: a whitelist deste servidor e
  // os privilégios reais do Postgres (que vêm do seed do outro repositório).
  // Não é decorativo — é o sítio onde uma divergência entre os dois lados
  // aparece no arranque, em vez de aparecer numa escrita que passou onde não
  // devia. Só se avisa quando o Postgres é MAIS PERMISSIVO do que a whitelist;
  // o contrário é seguro (a escrita é recusada pelo servidor antes de sair).
  const aMaisNoPostgres = identidade.tabelasComEscrita.filter((t) => !TABELAS_ESCRITA.has(t));
  if (aMaisNoPostgres.length > 0) {
    log(
      `AVISO: o utilizador de escrita tem INSERT em tabelas fora da whitelist deste servidor ` +
        `(${aMaisNoPostgres.join(", ")}). As tools recusam-nas à mesma, mas os GRANT do seed ` +
        `ficaram largos de mais — corre outra vez o seed do testeai-db.`,
    );
  }

  memoria.set(connectionString, ligacao);
  return ligacao;
}

/**
 * Porque é que um perfil não ficou configurado, numa frase.
 *
 * O caso "só falta a ligação de escrita" merece a nota do opt-in: não é um erro
 * de configuração, é o estado normal e recomendado de um servidor de leitura.
 */
function explicarFalta(perfil: Perfil, faltam: readonly string[]): string {
  if (faltam.length === 0) {
    return "razão desconhecida.";
  }
  const soAEscrita =
    perfilEscreve(perfil) && faltam.length === 1 && faltam[0] === perfil.escrita.variavel;
  const sufixo = soAEscrita ? " (a escrita é opt-in)." : ".";
  return `falta ${faltam.join(" e ")}${sufixo}`;
}

/**
 * A mensagem de um arranque sem um único perfil configurado.
 *
 * As variáveis a preencher são as que FALTARAM mesmo, e não uma lista escrita à
 * mão. A primeira versão desta mensagem mandava sempre preencher a
 * `DATABASE_URL_READONLY`, o que era falso — e enganador — no caso mais provável
 * de todos: arrancar no perfil `admin` numa máquina onde só falta a ligação de
 * escrita.
 */
function mensagemDeRegistoVazio(
  perfis: readonly Perfil[],
  emFalta: ReadonlyMap<string, string[]>,
): string {
  const linhas = perfis.map((p) => `  ${p.nome} — ${explicarFalta(p, emFalta.get(p.nome) ?? [])}`);
  const variaveis = [...new Set([...emFalta.values()].flat())];
  return (
    "Nenhum perfil de acesso pôde ser configurado — o servidor não teria nada que fazer.\n" +
    `${linhas.join("\n")}\n` +
    `Preenche ${variaveis.join(" e ")} no .env (copia o .env.example) ou no bloco 'env' da\n` +
    "configuração do cliente MCP, ou arranca com um perfil que não precise dessas variáveis."
  );
}
