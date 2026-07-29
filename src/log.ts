/**
 * Logging — uma função, partilhada pelos dois transportes.
 *
 * A ARMADILHA Nº 1 DO TRANSPORTE STDIO, e a razão de todo o logging deste
 * projeto ser feito com console.error:
 *
 * No transporte stdio, o cliente MCP fala com o servidor pelos canais padrão do
 * processo: escreve os pedidos JSON-RPC no stdin e LÊ AS RESPOSTAS DO STDOUT.
 * O stdout não é a "consola" — é o cabo por onde passa o protocolo.
 *
 * Um único console.log("a correr...") injeta a linha "a correr..." no meio das
 * mensagens JSON-RPC. O cliente tenta interpretá-la como JSON, falha, e a
 * ligação parte-se — normalmente com um erro que não diz nada sobre a causa.
 *
 * O stderr é ignorado pelo protocolo e é para lá que vai todo o logging. Quando
 * o servidor corre dentro do Claude Desktop, é isso que aparece nos ficheiros de
 * log da aplicação.
 *
 * NO TRANSPORTE HTTP esta restrição NÃO existe: o protocolo viaja por sockets
 * próprios e o stdout do processo está livre. Mesmo assim o modo HTTP usa esta
 * mesma função, e de propósito — o mesmo prefixo "[mcp]", o mesmo destino, o
 * mesmo formato. Dois estilos de log no mesmo projeto obrigariam quem lê os
 * ficheiros a saber primeiro qual dos modos os produziu, e não há nada a ganhar
 * com isso.
 */
export function log(mensagem: string): void {
  console.error(`[mcp] ${mensagem}`);
}

/** A mensagem de um erro apanhado, seja ele Error ou outra coisa qualquer. */
export function mensagemDoErro(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}
