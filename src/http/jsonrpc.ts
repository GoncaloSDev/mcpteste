/**
 * O corpo de erro que este servidor devolve antes de o transporte MCP entrar em
 * ação.
 *
 * Vive num ficheiro próprio porque passou a ter dois utilizadores — o http.ts e
 * a camada de autenticação — e a alternativa era um deles importar do outro, o
 * que fecharia um ciclo em runtime (o http.ts monta a autenticação).
 *
 * O `id: null` é obrigatório pela especificação JSON-RPC quando o erro é tal que
 * nem se conseguiu apurar a que pedido dizia respeito. É o caso de todos os erros
 * que passam por aqui: corpo ilegível, sessão desconhecida, token inválido.
 */
export function erroJsonRpc(codigo: number, mensagem: string) {
  return { jsonrpc: "2.0" as const, error: { code: codigo, message: mensagem }, id: null };
}

/**
 * Códigos usados pelas recusas desta camada.
 *
 * Ficam fora da gama reservada do JSON-RPC (-32768 a -32000 são do protocolo) por
 * onde os erros de transporte deste servidor já andavam — ver o -32001 das
 * sessões desconhecidas e o -32003 da Origin recusada no http.ts.
 */
export const CODIGO_NAO_AUTENTICADO = -32004;
export const CODIGO_NAO_AUTORIZADO = -32005;
