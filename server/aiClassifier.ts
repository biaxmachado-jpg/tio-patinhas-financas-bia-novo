/**
 * Classificação de extratos/faturas via Claude (Anthropic API).
 *
 * Substitui a antiga abordagem de parsers por banco (regex frágil, sem
 * suporte a Caixa/Santander/BB, perdendo o sinal débito/crédito em vários
 * bancos — ver client/src/lib/bankDetection.ts). Em vez de tentar adivinhar
 * o formato do extrato com expressões regulares, mandamos o documento
 * (PDF nativo, ou texto já extraído para CSV/XLSX/OFX) direto pro modelo,
 * que devolve as transações já estruturadas e já classificadas.
 *
 * A IA também identifica o próprio documento (banco, bandeira, últimos 4
 * dígitos, titular) — isso permite a importação "inteligente" (Importar.tsx)
 * detectar sozinha qual cartão/conta cadastrado corresponde ao arquivo, sem
 * a pessoa precisar escolher antes de subir o PDF (ver db.detectEntityFromDocument).
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

const TransactionSchema = z.object({
  date: z.string().describe("Data da transação no formato YYYY-MM-DD"),
  description: z.string().describe("Descrição da transação, limpa"),
  amount: z.string().describe("Valor absoluto (sempre positivo), com 2 casas decimais, ex: 45.90"),
  type: z.enum(["income", "expense"]).describe(
    "income = entrada de dinheiro (receita, depósito, estorno/crédito); expense = saída (despesa, compra, pagamento)"
  ),
  installments: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe(
      "Número TOTAL de parcelas da compra, lido diretamente da notação impressa na fatura (ex: '03/10' = 10 parcelas ao todo). Se a compra não é parcelada (à vista, crédito/estorno, pagamento, anuidade em parcela única), use 1."
    ),
  currentInstallment: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe(
      "Número da parcela sendo cobrada NESTA fatura, lido da mesma notação (ex: '03/10' = parcela 3). Se não é parcelada, use 1."
    ),
  categoryId: z.number().nullable().describe("id da categoria mais adequada, ou null se não tiver certeza"),
  confidence: z.enum(["high", "medium", "low"]),
});

// Metadados do próprio documento — usados pra descobrir automaticamente a
// qual cartão/conta cadastrado essa fatura/extrato pertence, sem a pessoa
// ter que escolher manualmente antes de subir o arquivo.
const DocumentMetaSchema = z.object({
  documentType: z
    .enum(["creditCardInvoice", "bankStatement", "unknown"])
    .describe("Tipo do documento: fatura de cartão de crédito, extrato de conta bancária, ou não deu pra identificar"),
  issuerBank: z
    .string()
    .nullable()
    .describe('Banco ou emissor impresso no documento, ex: "Itaú", "Bradesco", "Nubank"'),
  cardBrand: z
    .string()
    .nullable()
    .describe('Bandeira do cartão impressa no documento, ex: "Visa", "Mastercard", "Elo" — null se for extrato de conta'),
  cardProductName: z
    .string()
    .nullable()
    .describe('Nome do produto do cartão, ex: "Visa Infinite", "Mastercard Black" — null se não houver ou for extrato de conta'),
  cardLastFourDigits: z
    .string()
    .nullable()
    .describe("Últimos 4 dígitos do número do cartão titular (não de cartões adicionais), ex: \"8631\" — null se não aparecer ou for extrato de conta"),
  accountNumber: z
    .string()
    .nullable()
    .describe("Número da conta bancária (com ou sem dígito), se for extrato de conta — null caso contrário"),
  cardholderName: z.string().nullable().describe("Nome do titular impresso no documento"),
  statementTotal: z
    .number()
    .nullable()
    .describe(
      "Só pra FATURA DE CARTÃO: o valor total IMPRESSO da fatura, exatamente como aparece no documento (ex: 'Total desta fatura', 'Total dos lançamentos atuais', 'O total da sua fatura é', 'Total a pagar'). Use isso só pra conferência — não invente um número, coloque null se genuinamente não houver um total impresso ou se for extrato de conta (use openingBalance/closingBalance nesse caso)."
    ),
  openingBalance: z
    .number()
    .nullable()
    .describe(
      "Só pra EXTRATO DE CONTA BANCÁRIA: o saldo IMPRESSO no início do período do extrato (ex: 'SALDO ANTERIOR', primeiro 'saldo do dia' listado), exatamente como aparece — não calcule, copie o número impresso. null se for fatura de cartão ou não houver saldo inicial impresso."
    ),
  closingBalance: z
    .number()
    .nullable()
    .describe(
      "Só pra EXTRATO DE CONTA BANCÁRIA: o saldo IMPRESSO no final do período do extrato (o último 'saldo do dia' listado, ou o saldo atual/final destacado no topo do documento) — não calcule, copie o número impresso. null se for fatura de cartão ou não houver saldo final impresso."
    ),
});

const ClassificationResultSchema = z.object({
  document: DocumentMetaSchema,
  transactions: z.array(TransactionSchema),
});

export type AIClassifiedTransaction = z.infer<typeof TransactionSchema>;
export type DocumentMeta = z.infer<typeof DocumentMetaSchema>;

export interface CategoryOption {
  id: number;
  name: string;
  type: "income" | "expense";
}

export interface HistoricalExample {
  description: string;
  categoryId: number;
}

function buildInstructions(params: {
  entityType?: "bankAccount" | "creditCard";
  categories: CategoryOption[];
  historicalExamples: HistoricalExample[];
}): string {
  // entityType conhecido (fluxo antigo, quem chama já sabe se é fatura ou
  // extrato porque a pessoa escolheu o cartão/conta antes de subir o
  // arquivo) vs. desconhecido (fluxo novo "Importar" — a própria IA precisa
  // descobrir, a partir do documento, se é fatura de cartão ou extrato).
  const knownType = params.entityType;
  const isCard = knownType === "creditCard";
  const isBank = knownType === "bankAccount";

  const categoryList = params.categories
    .map((c) => `- id ${c.id}: "${c.name}" (${c.type === "income" ? "receita" : "despesa"})`)
    .join("\n");

  const examplesList =
    params.historicalExamples.length > 0
      ? params.historicalExamples
          .slice(0, 80)
          .map((e) => `- "${e.description}" → categoria id ${e.categoryId}`)
          .join("\n")
      : "(sem histórico ainda — use seu melhor julgamento pela descrição)";

  const cardStructureNotes = `

ESTRUTURA DE FATURA DE CARTÃO (se o documento for uma fatura de cartão de crédito — importante: a fatura já vem organizada em seções, use os títulos impressos como sinal forte, não só o valor):
- Faturas de cartão brasileiras normalmente separam as transações em blocos/seções com títulos como "Compras" / "Lançamentos do mês" / "Compras à vista" (compras feitas dentro do próprio ciclo, cobradas em parcela única), "Parcelamentos" / "Compras parceladas" / "Compras a prazo" (compras cobradas em várias faturas) e "Créditos" / "Estornos" / "Pagamentos e créditos" (dinheiro voltando para o cliente: estorno de compra, cashback, contestação). Use esses cabeçalhos de seção para decidir installments/currentInstallment e type — eles costumam estar explicitamente escritos no documento.
- Notação de parcela: quando a descrição traz algo como "03/10", "PARC 02/06", "2 de 12", isso é currentInstallment/installments — extraia os dois números exatamente como aparecem, não invente.
- Estornos/créditos às vezes vêm com um "-" na frente do valor, mas em várias faturas eles só ficam claros pela seção em que estão ou por palavras como "ESTORNO", "CRÉDITO", "CASHBACK", "CANCELAMENTO", "DEVOLUÇÃO" — mesmo sem sinal negativo explícito, classifique como type "income" (é dinheiro voltando).
- ATENÇÃO REDOBRADA ao sinal "-" na frente do valor: é fácil deixar passar, principalmente quando duas transações têm o MESMO estabelecimento repetido (ex: uma compra e o estorno dela, uma logo depois da outra, ou até a mesma pessoa comprando de novo) — nesses casos o "-" é a ÚNICA pista visual de que uma delas é estorno. Releia cada valor da lista com cuidado antes de decidir type; errar esse sinal é o erro mais comum e o que mais distorce o total da fatura (um "-" perdido muda o total em 2x o valor da transação, não 1x).
- Uma compra parcelada é type "expense" mesmo que installments > 1 — parcelamento não é crédito, é despesa dividida em várias faturas.
- Ignore "pagamento efetuado"/"pagamento recebido" no topo da fatura — isso é o pagamento da própria fatura anterior, não uma compra.

DATA DA TRANSAÇÃO — cuidado com o ANO: faturas de cartão mostram a data de cada transação só como "DD/MM" (sem ano), inclusive de compras parceladas feitas há muitos meses (ex: parcela 20 de 21 de uma compra originalmente feita bem antes). Regra pra inferir o ano corretamente: compare o mês da transação (MM) com o mês de emissão/fechamento desta fatura. Se o mês da transação for POSTERIOR ao mês de emissão da fatura (ex: fatura fechando em maio e uma transação "30/09" ou "16/07" — setembro e julho vêm depois de maio no calendário), essa transação é do ANO ANTERIOR ao ano de emissão da fatura, não do mesmo ano — ela não pode estar no futuro em relação à própria fatura. Só use o mesmo ano da fatura quando o mês da transação for igual ou anterior ao mês de emissão.

ARMADILHA CRÍTICA — tabela de parcelas FUTURAS (NÃO extrair como transação):
Praticamente toda fatura de cartão brasileira imprime, além dos lançamentos DESTA fatura, uma tabela separada mostrando as parcelas que AINDA VÃO SER cobradas nas PRÓXIMAS faturas — títulos típicos: "Compras parceladas — próximas faturas", "Parcelamentos futuros", "Parcelas a vencer", seguida de linhas como "Próxima fatura: R$X", "Demais faturas: R$Y", "Total para próximas faturas: R$Z". Essa tabela é só uma PROJEÇÃO informativa — cada compra parcelada listada ali JÁ TEVE sua parcela atual contabilizada na tabela de lançamentos desta fatura (a mesma compra aparece nas duas tabelas, com número de parcela diferente: ex. "03/10" na tabela de lançamentos desta fatura e "04/10" na tabela de próximas faturas — é A MESMA COMPRA, parcelas diferentes). NUNCA extraia linhas dessa tabela de projeção futura como transações — isso duplica valores e infla o total da fatura muito acima do valor real. Só extraia transações da(s) tabela(s) de lançamentos DESTA fatura (geralmente sob título como "Lançamentos: compras e saques", "Lançamentos atuais", "Lançamentos do período").
- Confira seu trabalho: a fatura quase sempre imprime o total dela em algum lugar (ex: "Total desta fatura", "Total dos lançamentos atuais", "O total da sua fatura é", "Total a pagar"). Depois de extrair as transações, some (despesas − créditos/estornos) e confira mentalmente se bate com esse total impresso. Se a sua soma ficar muito maior que o total impresso, você quase certamente incluiu linhas da tabela de parcelas futuras por engano — revise e remova.
- Faturas com mais de um cartão (titular + adicional, ex: "final 1234" e "final 5678" na mesma fatura) têm uma tabela de lançamentos separada para cada cartão — processe todas, mas cada uma delas é lançamento DESTA fatura (não confundir com a tabela de projeção futura, que também pode vir separada por cartão).

ESTRUTURA DE EXTRATO DE CONTA BANCÁRIA (se o documento for um extrato de conta corrente):
- Cada lançamento vem numa linha com data, descrição e valor; o valor positivo (ou impresso em verde) é entrada (type "income"), o valor negativo — com "-" na frente, ou impresso em vermelho — é saída (type "expense"). O SINAL é o que decide o type, NÃO a palavra na descrição.
- ARMADILHA: bancos usam o mesmo PREFIXO de descrição pra transações de tipo oposto. Exemplo real: "COR JSCP ITUB4" e "COR RENDIMENTO PETR4" (juros/dividendos, entrada, positivo) MAS "COR ITAUCOR COMPRA TD" (compra de Tesouro Direto/investimento, SAÍDA, valor negativo, ex: "-74.997,26") — apesar de todas começarem com "COR", uma é receita e a outra é uma despesa grande. NUNCA decida o type pelo prefixo/palavra da descrição sozinho — sempre confira o sinal impresso do valor daquela linha específica. Isso vale pra qualquer descrição parecida (ex: "COMPRA" costuma ser saída mesmo que outras linhas com prefixo parecido sejam entrada).
- Linhas como "SALDO ANTERIOR", "SALDO DO DIA", "SALDO TOTAL DISPONÍVEL DIA", "LIMITE DISPONÍVEL" não são transações — são saldos acumulados, ignore-as na lista de transações (mas veja abaixo, use pra preencher openingBalance/closingBalance).
- ARMADILHA CRÍTICA — seção de lançamentos FUTUROS (NÃO extrair como transação): muitos extratos trazem, depois dos lançamentos normais, uma seção separada tipo "Lançamentos futuros", "Saídas futuras", "Entradas futuras" — são pagamentos/transferências AGENDADOS que AINDA NÃO aconteceram (data no futuro em relação à emissão do extrato), listados só como aviso. NUNCA extraia essas linhas como transação real — elas não fazem parte do saldo do período e vão inflar receita/despesa com dinheiro que ainda nem entrou ou saiu da conta. Só extraia da seção principal de lançamentos já ocorridos (a que tem o histórico de "saldo do dia" junto).
- Confira seu trabalho: some (entradas − saídas) de tudo que você extraiu e compare com a diferença entre closingBalance e openingBalance (ver campo "document" abaixo) — se não bater, você errou o sinal de alguma linha, pulou uma transação, ou incluiu um lançamento futuro por engano.`;

  const documentIdNotes = `

IDENTIFICAÇÃO DO DOCUMENTO (campo "document" — preencha sempre, mesmo no fluxo em que o tipo já é conhecido):
- documentType: "creditCardInvoice" se for fatura de cartão de crédito, "bankStatement" se for extrato de conta bancária, "unknown" só se genuinamente não der pra saber.
- issuerBank: nome do banco/emissor impresso (ex: "Itaú", "Bradesco", "Nubank", "Banco do Brasil").
- cardBrand e cardProductName: bandeira e nome do produto do cartão (ex: "Mastercard" / "Mastercard Black"), lidos do cabeçalho da fatura — null se for extrato de conta.
- cardLastFourDigits: os 4 últimos dígitos do cartão DO TITULAR impressos na fatura (geralmente no formato "XXXX.XXXX.XXXX.1234") — null se não aparecer ou for extrato de conta. NÃO confunda com os "finais" de cartões adicionais listados dentro da fatura.
- accountNumber: número da conta bancária impresso no extrato — null se for fatura de cartão.
- cardholderName: nome do titular impresso no documento.
- statementTotal: SÓ fatura de cartão — o total impresso da fatura (não da tabela de parcelas futuras!) — null se for extrato de conta.
- openingBalance/closingBalance: SÓ extrato de conta — o saldo impresso no início e no fim do período do extrato (copie os números impressos, ex: "SALDO ANTERIOR" e o último "saldo do dia") — null se for fatura de cartão.`;

  const typeInstruction = isCard
    ? `Você vai analisar uma fatura de cartão de crédito e extrair cada transação real encontrada no documento.`
    : isBank
    ? `Você vai analisar um extrato bancário e extrair cada transação real encontrada no documento.`
    : `Você vai analisar um documento financeiro (pode ser fatura de cartão de crédito OU extrato de conta bancária — descubra qual pelo layout e preencha "documentType" de acordo) e extrair cada transação real encontrada.`;

  return `${typeInstruction}

Para CADA transação, retorne:
- date: data no formato YYYY-MM-DD (use o ano correto do extrato, não assuma o ano atual)
- description: a descrição da transação, limpa (sem lixo de formatação, sem repetir a data ou o valor)
- amount: valor ABSOLUTO (sempre positivo), com 2 casas decimais
- type: "income" se é ENTRADA de dinheiro (receita, estorno/crédito na fatura, depósito, transferência recebida) ou "expense" se é SAÍDA (despesa, compra à vista ou parcelada, pagamento, saque, transferência enviada)
- installments: número TOTAL de parcelas da compra, lido da notação impressa (ex: "03/10" → 10). Se não for fatura de cartão, ou a compra for à vista/crédito/pagamento, use 1.
- currentInstallment: número da parcela cobrada NESTA fatura (ex: "03/10" → 3). Se não é parcelada = 1.
- categoryId: o id da categoria mais adequada da lista abaixo, baseado na descrição e no histórico de categorização já feito por esta pessoa. Se não tiver nenhuma certeza razoável, use null — não force uma categoria errada.
- confidence: "high", "medium" ou "low" — sua confiança na categoria escolhida

IGNORE linhas que não são transações reais: saldo anterior, saldo do dia, limite disponível, totais, subtotais de seção, cabeçalhos de tabela.
${cardStructureNotes}
${documentIdNotes}

Categorias disponíveis:
${categoryList}

Histórico de transações já categorizadas por esta pessoa (use como referência de padrão — descrições parecidas ou do mesmo estabelecimento tendem a ir na mesma categoria):
${examplesList}

Retorne TODAS as transações encontradas no documento, na ordem em que aparecem no extrato.`;
}

export async function classifyStatementWithAI(params: {
  // Quando informado (fluxo legado /cartoes/:id/importar e /contas/:id/importar,
  // onde a pessoa já escolheu o cartão/conta antes de subir o arquivo), o
  // prompt é mais específico. Quando omitido (fluxo novo "Importar" — ver
  // Importar.tsx), a própria IA identifica o tipo de documento a partir do
  // conteúdo, e o resultado inclui "document" pra permitir detecção
  // automática do cartão/conta (db.detectEntityFromDocument).
  entityType?: "bankAccount" | "creditCard";
  fileName: string;
  pdfBase64?: string;
  textContent?: string;
  categories: CategoryOption[];
  historicalExamples: HistoricalExample[];
}): Promise<{ document: DocumentMeta; transactions: AIClassifiedTransaction[] }> {
  if (!params.pdfBase64 && !params.textContent) {
    throw new Error("Nenhum conteúdo de arquivo fornecido para classificação");
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY não configurada no servidor. Configure essa variável de ambiente para usar a classificação automática por IA."
    );
  }

  const anthropic = new Anthropic({ apiKey });

  const instructions = buildInstructions(params);

  const contentBlocks: Anthropic.Messages.ContentBlockParam[] = [];

  if (params.pdfBase64) {
    contentBlocks.push({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: params.pdfBase64,
      },
    });
    contentBlocks.push({ type: "text", text: instructions });
  } else {
    contentBlocks.push({
      type: "text",
      text: `${instructions}\n\n--- CONTEÚDO DO ARQUIVO (${params.fileName}) ---\n${params.textContent}`,
    });
  }

  let response: Anthropic.Messages.Message;
  try {
    response = await anthropic.messages.create({
      // Testei Haiku 4.5 e Sonnet 5 contra a mesma fatura de verdade, 3
      // vezes cada, comparando a soma extraída com o total impresso:
      // Haiku errava feio (incluindo a tabela de parcelas futuras) 1 em
      // cada 3 rodadas — diferença de quase R$10 mil numa delas, mesmo com
      // o prompt reforçado. Sonnet 5 tem "extended thinking" ligado por
      // padrão, que consumia o próprio max_tokens antes de escrever a
      // resposta (ou vinha vazia, ou — aumentando o limite — cruzava o teto
      // que obrigaria migrar pra streaming, mudança maior que não ia
      // arriscar sem testar). Desligando o thinking explicitamente (não
      // precisamos dele pra extração estruturada) o Sonnet ficou estável e
      // preciso nas 3 rodadas (diferença de R$9 a R$14, nunca mais que
      // isso) — por isso o modelo, mesmo sendo o mais caro dos dois.
      model: "claude-sonnet-5",
      max_tokens: 16000,
      thinking: { type: "disabled" },
      output_config: {
        format: zodOutputFormat(ClassificationResultSchema),
      },
      messages: [{ role: "user", content: contentBlocks }],
    });
  } catch (error) {
    // Um erro aqui pode ser da própria API da Anthropic (rede, limite de
    // taxa, resposta inesperada de algum proxy no meio do caminho) — sem
    // esse catch, o erro técnico bruto (ex: "Unexpected non-whitespace
    // character after JSON...") vazava direto pra tela da pessoa sem
    // explicação nenhuma.
    console.error("[aiClassifier] Erro ao chamar a API da Anthropic:", error);
    throw new Error(
      "Não consegui falar com o serviço de IA agora (erro de conexão ou resposta inesperada). " +
        "Confirme se há crédito disponível na conta da API e tente novamente em instantes."
    );
  }

  if (response.stop_reason === "refusal") {
    throw new Error("A IA recusou processar este arquivo. Tente importar manualmente.");
  }

  const textBlock = response.content.find(
    (block): block is Anthropic.Messages.TextBlock => block.type === "text"
  );
  if (!textBlock) {
    throw new Error("A IA não retornou nenhum conteúdo utilizável. Tente novamente.");
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(textBlock.text);
  } catch (error) {
    console.error(
      "[aiClassifier] Resposta da IA não é JSON válido. Trecho:",
      textBlock.text.slice(0, 500)
    );
    throw new Error("Resposta da IA não veio em formato válido. Tente novamente.");
  }

  return ClassificationResultSchema.parse(parsedJson);
}
