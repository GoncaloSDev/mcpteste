/**
 * CAMADA 3 DA ESCRITA — quantas linhas uma operação pode afetar.
 *
 * É a peça mais importante de todo o caminho de escrita, e a razão é esta:
 *
 * No caminho de leitura, a Camada 2 (BEGIN TRANSACTION READ ONLY) é a defesa que
 * não depende de configuração nenhuma — o Postgres recusa a escrita mesmo com
 * uma ligação de superutilizador. No caminho de escrita essa defesa, por
 * definição, não pode existir: a transação TEM de poder escrever. Alguma coisa
 * tem de ocupar o lugar dela.
 *
 * O que ocupa esse lugar é isto. A verificação é feita DEPOIS de a instrução
 * correr e ANTES do COMMIT, com o rowCount que o próprio Postgres devolveu — não
 * com uma estimativa, não com uma inspeção do SQL. Se o número não for
 * exatamente o esperado, é lançado um erro e o `executarEscrita` faz ROLLBACK.
 * Nada chega a disco.
 *
 * O caso que isto apanha e mais nenhuma camada apanharia: um WHERE que, por um
 * bug na construção da query ou por uma chave primária mal identificada, se
 * transforme num "apanha tudo". As permissões não travam isso (o role TEM DELETE
 * na tabela) e a validação de colunas também não (as colunas existem todas). Só
 * a contagem trava.
 *
 * Fica em ficheiro próprio, tal como as camadas de leitura, para a política e o
 * mecanismo estarem separados: aqui decide-se o que é aceitável, no db-escrita.ts
 * executa-se. E assim é testável sem base de dados nenhuma.
 */

import { ErroValidacao } from "../erros.js";

/**
 * Teto absoluto de linhas que uma única chamada pode afetar.
 *
 * É 1 e não é configurável, de propósito. As três tools de escrita identificam
 * sempre a linha pela CHAVE PRIMÁRIA, portanto o resultado correto de qualquer
 * uma delas é exatamente uma linha — nunca zero, nunca duas. Um valor
 * configurável só serviria para alguém o subir num .env e desligar a defesa.
 *
 * Se um dia existirem operações em lote, elas trarão o seu próprio limite
 * declarado por chamada; este continua a ser o omisso.
 */
export const MAX_LINHAS_POR_ESCRITA = 1;

/**
 * Confirma que a operação afetou exatamente o número de linhas esperado.
 * Lança `ErroValidacao` em qualquer outro caso — e quem chama tem de garantir
 * que isso provoca um ROLLBACK.
 *
 * @param afetadas  o rowCount devolvido pelo Postgres
 * @param operacao  "INSERT" / "UPDATE" / "DELETE", só para a mensagem
 * @param alvo      descrição da linha visada, para a mensagem fazer sentido
 */
export function verificarLinhasAfetadas(
  afetadas: number | null,
  operacao: string,
  alvo: string,
): void {
  // O node-postgres devolve rowCount null em comandos que não contam linhas.
  // Aqui nunca deve acontecer (as três tools usam sempre RETURNING), mas se
  // acontecesse não teríamos como validar nada — e não validar é recusar.
  if (afetadas === null) {
    throw new ErroValidacao(
      `O Postgres não indicou quantas linhas o ${operacao} afetou. ` +
        "A operação foi revertida por precaução.",
    );
  }

  // Zero linhas não é um erro do Postgres: o comando correu bem e simplesmente
  // não encontrou nada. Sem esta verificação, um update_row com a chave errada
  // devolvia "sucesso" sem ter alterado coisa nenhuma — que é precisamente o
  // tipo de falha silenciosa que um modelo do outro lado não tem como detetar.
  if (afetadas === 0) {
    throw new ErroValidacao(
      `Nenhuma linha corresponde a ${alvo}. O ${operacao} não alterou nada e foi revertido. ` +
        "Confirma os valores da chave primária com a tool run_query.",
    );
  }

  if (afetadas > MAX_LINHAS_POR_ESCRITA) {
    throw new ErroValidacao(
      `O ${operacao} afetou ${afetadas} linhas quando só podia afetar ${MAX_LINHAS_POR_ESCRITA}. ` +
        "A transação foi REVERTIDA e a base de dados não foi alterada. " +
        "Isto não devia ser possível — as tools de escrita identificam sempre a linha pela " +
        "chave primária — por isso vale a pena reportar como bug do servidor.",
    );
  }
}
