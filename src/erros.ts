/**
 * Tradução de erros para mensagens que podem sair para o cliente MCP.
 *
 * Existe separado porque é a única fronteira por onde erros internos saem do
 * servidor. Concentrar isto num sítio é o que permite garantir — olhando para um
 * ficheiro só — que nunca sai daqui uma connection string, um stack trace ou
 * qualquer detalhe da configuração interna.
 */

/**
 * Erro que representa uma recusa deliberada de uma das camadas de validação.
 * A mensagem destes é escrita por nós e é sempre segura de mostrar — ao
 * contrário dos erros que vêm do driver de Postgres ou do parser.
 */
export class ErroValidacao extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "ErroValidacao";
  }
}

/**
 * Apaga qualquer connection string que apareça num texto.
 *
 * É uma rede de segurança, não a defesa principal: nós nunca metemos a URL nas
 * mensagens. Mas uma biblioteca de terceiros pode incluir a string de ligação no
 * texto de um erro (é comum em erros de ligação), e essa mensagem passaria por
 * aqui a caminho do cliente. Este regex garante que a password nunca sai, mesmo
 * nesse caso que não controlamos.
 */
function apagarConnectionStrings(texto: string): string {
  return texto.replace(/postgres(ql)?:\/\/\S+/gi, "[connection string removida]");
}

/**
 * Códigos SQLSTATE que sabemos explicar melhor do que o Postgres explica.
 * A lista completa está em https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
const EXPLICACOES: Record<string, string> = {
  // A query foi cancelada por ter ultrapassado o statement_timeout da Camada 3.
  "57014": "A query foi cancelada por exceder o tempo limite de execução.",
  // O utilizador mcp_readonly não tem SELECT nesta tabela. Não é um bug: é a
  // primeira camada de defesa (permissões de BD) a fazer o seu trabalho.
  "42501": "Sem permissão para aceder a esse objeto. O servidor liga-se com um utilizador só-de-leitura.",
  // A Camada 2 (BEGIN TRANSACTION READ ONLY) recusou uma escrita.
  "25006": "Tentativa de escrita numa transação só-de-leitura. Este servidor só permite consultas.",
  "42P01": "A tabela ou vista indicada não existe. Usa a tool list_tables para veres o que existe.",
  "42703": "Uma das colunas indicadas não existe. Usa a tool describe_table para veres as colunas.",
  "42601": "Erro de sintaxe no SQL.",
  "42883": "A função indicada não existe com esses tipos de argumentos.",
  "22012": "Divisão por zero. Considera usar nullif(divisor, 0).",
  "53300": "A base de dados tem demasiadas ligações abertas neste momento.",
};

/**
 * Converte qualquer erro apanhado numa mensagem segura para o cliente MCP.
 *
 * Três níveis, do mais específico ao mais genérico:
 *   1. ErroValidacao  — mensagem nossa, passa tal e qual
 *   2. erro do Postgres com SQLSTATE conhecido — explicação nossa + detalhe do PG
 *   3. tudo o resto — mensagem genérica, sem detalhes
 *
 * O `error.stack` nunca é incluído em nenhum dos três: revela caminhos do
 * sistema de ficheiros e a estrutura interna do servidor.
 */
export function mensagemSegura(erro: unknown): string {
  if (erro instanceof ErroValidacao) {
    return erro.message;
  }

  // Os erros do node-postgres trazem o SQLSTATE em `.code`. Não uso
  // `instanceof DatabaseError` porque isso obrigaria a importar o pg aqui só
  // para uma verificação de tipo — basta ver se o campo existe.
  const codigo = extrairCodigo(erro);
  const detalhe = extrairMensagem(erro);

  if (codigo !== null) {
    const explicacao = EXPLICACOES[codigo];
    if (explicacao !== undefined) {
      return apagarConnectionStrings(`${explicacao} (Postgres ${codigo}: ${detalhe})`);
    }
    // Códigos da classe 08 são todos falhas de ligação. Aqui é preciso ter
    // cuidado redobrado: são precisamente os erros onde a connection string
    // costuma aparecer no texto.
    if (codigo.startsWith("08")) {
      return "Falha na ligação à base de dados. Confirma que o container do Postgres está a correr.";
    }
    return apagarConnectionStrings(`Erro da base de dados (${codigo}): ${detalhe}`);
  }

  // Erros de ligação a nível de socket não têm SQLSTATE — vêm com códigos do
  // Node (ECONNREFUSED, ETIMEDOUT). Não devolvo o texto original porque pode
  // conter host e porta.
  if (detalhe.includes("ECONNREFUSED") || detalhe.includes("ETIMEDOUT")) {
    return "Não foi possível ligar à base de dados. Confirma que o container do Postgres está a correr.";
  }

  return apagarConnectionStrings(`Erro inesperado: ${detalhe}`);
}

function extrairCodigo(erro: unknown): string | null {
  if (typeof erro === "object" && erro !== null && "code" in erro) {
    const codigo = (erro as { code: unknown }).code;
    if (typeof codigo === "string") {
      return codigo;
    }
  }
  return null;
}

function extrairMensagem(erro: unknown): string {
  if (erro instanceof Error) {
    return erro.message;
  }
  return String(erro);
}
