/**
 * Ponto de entrada STDIO — arranca o servidor MCP e liga-o ao transporte stdio.
 *
 * É o modo de DESENVOLVIMENTO LOCAL: é assim que o Claude Desktop e o MCP
 * Inspector lançam este servidor (um processo por cliente, lançado pelo próprio
 * cliente). O modo HTTP vive no http.ts e é o caminho de produção — os dois
 * montam exatamente o mesmo servidor, através do servidor.ts.
 *
 * Faz três coisas por esta ordem, e a ordem é obrigatória: carrega a
 * configuração, verifica que as dependências externas (parser e base de dados)
 * estão mesmo a funcionar, e só depois abre o canal MCP. Nada de registar tools
 * antes de saber que há base de dados por trás delas.
 */

// Este import TEM de ser o primeiro de todos. Em ESM os módulos importados são
// avaliados por ordem de declaração, antes de correr qualquer linha deste
// ficheiro — se o dotenv viesse a seguir a um módulo que lê process.env no seu
// corpo, esse módulo lia as variáveis antes de o .env ter sido carregado.
// (O db.ts está escrito para ler o ambiente dentro de uma função, precisamente
// para não depender só desta ordem — mas a ordem certa é a primeira defesa.)
import "dotenv/config";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { perfilPedidoNoAmbiente } from "./acesso/perfis.js";
import { log } from "./log.js";
import {
  arrancarDependencias,
  criarServidor,
  falharNoArranque,
  registarEncerramento,
} from "./servidor.js";

async function main(): Promise<void> {
  // --- 1. O perfil que este processo serve ----------------------------------
  //
  // Um por processo, escolhido pelo MCP_PERFIL, e resolvido ANTES de se abrir
  // seja o que for. É a forma de o stdio ter papéis sem ter autenticação: quem
  // lança o processo é o cliente MCP, e é ele que diz, no bloco `env` da sua
  // configuração, com que papel o quer. Duas entradas no
  // claude_desktop_config.json a apontar para o MESMO dist/index.js, uma com
  // MCP_PERFIL=employee e outra com MCP_PERFIL=admin, dão dois servidores com
  // tools diferentes sem uma linha de código a mais.
  //
  // Só este perfil é configurado, e é isso que mantém a credencial de escrita
  // fora do processo que não escreve. No modo HTTP isto não serve — lá há vários
  // papéis a falar com o mesmo processo e o perfil vem da identidade de quem
  // chama, por sessão.
  const perfil = perfilPedidoNoAmbiente();

  // --- 2. Dependências externas, antes de tudo o resto -----------------------
  //
  // Falha aqui se o perfil pedido não estiver configurado — pedir `admin` sem
  // DATABASE_URL_WRITE, por exemplo. É deliberado que falhe em vez de servir o
  // perfil de omissão: um servidor com menos tools do que quem o arrancou julga
  // descobre-se por uma tool "que desapareceu", e isso custa muito mais tempo do
  // que uma linha no stderr.
  const registo = await arrancarDependencias([perfil]);
  const contexto = registo.exigir(perfil.nome);
  log(`perfil em uso: ${contexto.perfil.nome}.`);

  // --- 3. O servidor MCP e as suas tools ------------------------------------

  const server = criarServidor(contexto);

  // --- 4. Abrir o canal ------------------------------------------------------

  // A partir daqui o stdout pertence ao protocolo (ver o comentário no log.ts).
  // O connect() não termina: fica a servir pedidos até o cliente fechar o stdin.
  const transporte = new StdioServerTransport();
  await server.connect(transporte);
  log("servidor pronto, à escuta em stdio.");
}

registarEncerramento();

main().catch(falharNoArranque);
